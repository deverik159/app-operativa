// ============================================================
// src/lib/borradorReparacion.ts
// Borrador de "Registrar reparación" (RepararModal), guardado en el
// teléfono: cada foto o video se guarda EN CUANTO termina de prepararse,
// junto con el diagnóstico y el detalle, y al reabrir la reparación de la
// MISMA incidencia se recupera.
//
// POR QUÉ (revisión sin señal, 24-sep-2026): con el modo sin señal las fotos
// de la reparación ya no se suben al elegirlas (se suben al Guardar, con la
// reparación, por lib/acciones.ts) y quedaron solo en la memoria del modal.
// En iPhone basta abrir la cámara para que iOS recargue la app al volver
// (lib/borrador.ts documenta el mismo caso en el alta); también recargan
// tocar un aviso (sw.js navega) y Atrás en Android (cambia de pestaña). Se
// perdían sin aviso las fotos ya tomadas, también con buena señal. Antes
// (subirRep) ya estaban en Storage y en `evidencias`.
//
// Reglas:
//   · Almacén 'archivos' de lib/idb.ts (base 'gpo-capturas'; la copia 'a:'
//     del motor vive aparte, en 'gpo-acciones'), con prefijo propio que no
//     choca con 'e:' (envíos) ni 'b:' (alta):
//       'r:<correo>:<record_id>:<apertura>:<n>'  un archivo
//       'r:<correo>:<record_id>:<apertura>:_'    sus datos (textos, ciclo)
//     Una "apertura" es un montaje del modal. La que recupera ADOPTA las
//     anteriores de esa incidencia: se juntan todas sus fotos y se borran
//     con ella.
//   · Los datos se escriben ANTES que el primer archivo: un archivo sin
//     datos es basura (se borra al recuperar).
//   · Solo se ofrece si es del mismo ciclo de reparación (el repaired_at de
//     la incidencia no cambió: si otra persona reparó, o la reparación ya
//     entró y la rechazaron, esas fotos ya no son de esta) y tiene menos de
//     48 h, como el borrador del alta.
//   · Se borra al quedar la reparación HECHA (o ya no aplica: conflicto) y
//     al descartarla el usuario (Cancelar → "¿Descartarlas?"). EN COLA no se
//     borra de inmediato: el motor ya guardó su propia copia 'a:', pero en
//     esta pestaña sube los MISMOS File que recibió, y los recuperados de
//     aquí salen de IndexedDB (borrar su registro podría dejarlos ilegibles
//     en Safari antes de subirlos). Se marca "entregado" (ya no se ofrece) y
//     se borra en cuanto la reparación sale de la cola. Si la app se cierra
//     antes, en otra carga solo se ofrece si la reparación YA NO está en la
//     cola y sigue en el mismo ciclo: no llegó (el motor no pudo guardar su
//     copia, p. ej. sin lugar, o se descartó) y estas fotos son lo único que
//     queda. Si sigue en la cola, se deja hasta que venza.
//   · Si IndexedDB falla o no hay lugar, se sigue como antes: la foto vive
//     solo en la memoria del modal (el modal lo dice). Nunca bloquea ni
//     revienta: todo es de mejor esfuerzo y ninguna función rechaza.
// ============================================================
import {
  guardarArchivo,
  idbDelete,
  idbDeletePrefijo,
  idbGet,
  idbPut,
  idbTx,
  leerArchivo,
  rangoPrefijo,
} from './idb';
import { accionesPendientes, suscribirAcciones } from './acciones';
import type { Incidencia } from '../types/db';

/** Un borrador más viejo que esto ya no se ofrece (y se borra). */
export const VIGENCIA_BORRADOR_REPARACION_MS = 48 * 60 * 60 * 1000;

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();

function aleatorio(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Esta carga de la app. Los File de un borrador "entregado" en OTRA carga ya
 * no los usa el motor (el de esa pestaña murió con ella; el de ésta lee su
 * copia 'a:'): se puede ofrecer o dejar vencer (ver recuperarReparacion).
 */
const CARGA = aleatorio();

/** Sufijo del registro de datos de una apertura. */
const DATOS = '_';

type DatosBorrador = {
  clave: string;
  tipo: 'borrador-reparacion';
  email: string;
  record_id: string;
  /** repaired_at de la incidencia al abrir: otro valor = otro ciclo. */
  ciclo: string | null;
  guardado_en: number;
  diag: string;
  detalle: string;
  /** La reparación ya se entregó a la cola: no se ofrece; se borra después. */
  entregado?: { en: number; carga: string } | null;
};

/** Una apertura del modal. La crea abrirReparacion; la usa solo el modal. */
export type SesionReparacion = {
  email: string;
  recordId: string;
  /** 'r:<correo>:<record_id>:' */
  base: string;
  /** base + '<apertura>:' */
  prefijo: string;
  ciclo: string | null;
  /** Entregada o descartada: ninguna escritura tardía la resucita. */
  cerrada: boolean;
  /** Prefijos de aperturas anteriores adoptadas al recuperar. */
  adoptadas: Set<string>;
  /** Una operación a la vez (una foto que se copia y el Guardar). */
  cadena: Promise<unknown>;
  /** La clave de cada File guardado (para quitarlo con su ×). */
  claves: WeakMap<File, string>;
  textos: { diag: string; detalle: string };
  /** Ya se escribió su registro de datos. */
  conDatos: boolean;
};

export type Recuperado = {
  archivos: File[];
  /** Los textos de la apertura más reciente que los traía; null = ninguna. */
  textos: { diag: string; detalle: string } | null;
  /** Estaban guardados pero no se pudieron leer (se quedan para otra vez). */
  ilegibles: number;
};

function mismoCiclo(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
}

function vencido(d: DatosBorrador): boolean {
  return !d.guardado_en || Date.now() - d.guardado_en > VIGENCIA_BORRADOR_REPARACION_MS;
}

let consecutivo = 0;
function nuevaClave(s: SesionReparacion): string {
  // Tiempo + consecutivo: las claves salen ordenadas (IndexedDB las lista
  // en orden) y las fotos se recuperan en el orden en que se tomaron.
  return s.prefijo + Date.now().toString(36) + (consecutivo++ % 1679616).toString(36).padStart(4, '0');
}

/** Encola `trabajo` detrás de lo pendiente de la apertura; nunca rechaza. */
function enCola<T>(s: SesionReparacion, trabajo: () => Promise<T>, respaldo: T): Promise<T> {
  const p = s.cadena.then(trabajo).catch(() => respaldo);
  s.cadena = p;
  return p;
}

/** Las claves (no los Blobs) del almacén 'archivos' que empiezan con `prefijo`. */
async function clavesDe(prefijo: string): Promise<string[]> {
  const caja: { v: string[] } = { v: [] };
  await idbTx(['archivos'], 'readonly', (tx) => {
    const r = tx.objectStore('archivos').getAllKeys(rangoPrefijo(prefijo));
    r.onsuccess = () => {
      caja.v = ((r.result as IDBValidKey[]) || []).map(String);
    };
  });
  return caja.v;
}

/** Agrupa claves por apertura: prefijo de apertura → sus claves. */
function porApertura(base: string, claves: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const k of claves) {
    const i = k.indexOf(':', base.length);
    if (i <= base.length) continue;
    const pre = k.slice(0, i + 1);
    const l = m.get(pre);
    if (l) l.push(k);
    else m.set(pre, [k]);
  }
  return m;
}

function borrarApertura(prefijo: string): Promise<void> {
  return idbDeletePrefijo('archivos', prefijo).catch(() => {});
}

/** Escribe (o refresca) el registro de datos de la apertura. Lanza si falla. */
async function escribirDatos(s: SesionReparacion): Promise<void> {
  const d: DatosBorrador = {
    clave: s.prefijo + DATOS,
    tipo: 'borrador-reparacion',
    email: s.email,
    record_id: s.recordId,
    ciclo: s.ciclo,
    guardado_en: Date.now(),
    diag: s.textos.diag,
    detalle: s.textos.detalle,
    entregado: null,
  };
  await idbPut('archivos', d);
  s.conDatos = true;
}

// ------------------------------------------------------------
// Borrado diferido de lo entregado a la cola
// ------------------------------------------------------------

/** prefijo de apertura → de qué reparación es. Solo en esta pestaña. */
const diferidos = new Map<string, { email: string; recordId: string }>();
let quitarSuscripcion: (() => void) | null = null;
let relojDiferidos: ReturnType<typeof setTimeout> | undefined;

async function revisarDiferidos(): Promise<void> {
  for (const [prefijo, d] of [...diferidos]) {
    let sigue = true;
    try {
      sigue = (await accionesPendientes(d.email)).some(
        (p) => p.record_id === d.recordId && p.clase === 'reparacion'
      );
    } catch {
      continue;
    }
    if (sigue) continue;
    diferidos.delete(prefijo);
    await borrarApertura(prefijo);
  }
  if (!diferidos.size && quitarSuscripcion) {
    quitarSuscripcion();
    quitarSuscripcion = null;
  }
}

function programarRevision(): void {
  clearTimeout(relojDiferidos);
  relojDiferidos = setTimeout(() => void revisarDiferidos(), 500);
}

function diferir(prefijos: string[], email: string, recordId: string): void {
  prefijos.forEach((p) => diferidos.set(p, { email, recordId }));
  if (!quitarSuscripcion) quitarSuscripcion = suscribirAcciones(programarRevision);
  // La reparación pudo salir de la cola antes de suscribirse.
  programarRevision();
}

// ------------------------------------------------------------
// Operaciones (las usa RepararModal)
// ------------------------------------------------------------

/** Una apertura nueva del modal. null sin correo o sin incidencia. */
export function abrirReparacion(
  email: string,
  inc: Pick<Incidencia, 'record_id' | 'repaired_at' | 'diagnostico' | 'detalle_reparacion'>
): SesionReparacion | null {
  const em = norm(email);
  if (!em || !inc.record_id) return null;
  const base = `r:${em}:${inc.record_id}:`;
  return {
    email: em,
    recordId: inc.record_id,
    base,
    prefijo: `${base}${aleatorio()}:`,
    ciclo: inc.repaired_at ?? null,
    cerrada: false,
    adoptadas: new Set(),
    cadena: Promise.resolve(),
    claves: new WeakMap(),
    textos: { diag: inc.diagnostico || '', detalle: inc.detalle_reparacion || '' },
    conDatos: false,
  };
}

/**
 * Lo que quedó de aperturas anteriores de ESTA reparación (misma
 * incidencia, mismo correo, mismo ciclo, menos de 48 h y no entregado). La
 * apertura las adopta: sus fotos se quitan con su × y se borran con ella.
 * De paso borra lo vencido o ya entregado de las demás incidencias de este
 * correo. null = nada que ofrecer.
 */
export function recuperarReparacion(s: SesionReparacion): Promise<Recuperado | null> {
  return enCola(
    s,
    async () => {
      const grupos = porApertura(s.base, await clavesDe(s.base));
      const archivos: File[] = [];
      let ilegibles = 0;
      let textos: Recuperado['textos'] = null;
      let masReciente = -1;
      for (const [pre, claves] of grupos) {
        if (pre === s.prefijo) continue;
        const d = await idbGet<DatosBorrador>('archivos', pre + DATOS).catch(() => undefined);
        if (!d || d.tipo !== 'borrador-reparacion' || vencido(d) || !mismoCiclo(d.ciclo, s.ciclo)) {
          await borrarApertura(pre);
          continue;
        }
        if (d.entregado) {
          // De esta carga: lo borra la vigilancia de la cola (ver diferir).
          if (d.entregado.carga === CARGA) continue;
          // De otra carga y la reparación sigue en la cola: el motor tiene
          // lo suyo; se deja (se borra por vigencia) y no se ofrece.
          if (await reparacionEnCola(s)) continue;
          // De otra carga y ya NO está en la cola, con el mismo ciclo (si
          // hubiera llegado, el repaired_at sería otro): la app se cerró
          // antes de que el motor pudiera guardarla (p. ej. sin lugar para
          // su copia) o se descartó. Estas fotos son lo único que queda: se
          // ofrecen otra vez.
        }
        s.adoptadas.add(pre);
        if ((d.diag || d.detalle) && d.guardado_en > masReciente) {
          masReciente = d.guardado_en;
          textos = { diag: d.diag || '', detalle: d.detalle || '' };
        }
        for (const k of claves.sort()) {
          if (k === pre + DATOS) continue;
          // null = no se pudo leer (IndexedDB caído o Blob ilegible): NO se
          // borra; se cuenta y queda para la siguiente apertura.
          const f = await leerArchivo(k);
          if (!f) {
            ilegibles++;
            continue;
          }
          s.claves.set(f, k);
          archivos.push(f);
        }
      }
      void limpiarOtras(s);
      if (!archivos.length && !textos && !ilegibles) return null;
      return { archivos, textos, ilegibles };
    },
    null
  );
}

/** ¿La cola del teléfono todavía tiene una reparación de esta incidencia? */
async function reparacionEnCola(s: SesionReparacion): Promise<boolean> {
  try {
    return (await accionesPendientes(s.email)).some(
      (p) => p.record_id === s.recordId && p.clase === 'reparacion'
    );
  } catch {
    // Sin poder saberlo, no se ofrece: mejor no duplicar.
    return true;
  }
}

/**
 * Borra de las demás incidencias de este correo lo vencido y lo que no
 * tiene datos. Lo entregado de otra carga se deja: si su reparación no
 * llegó, al reabrirla se ofrece (ver recuperarReparacion); si no, vence.
 */
async function limpiarOtras(s: SesionReparacion): Promise<void> {
  try {
    const base = `r:${s.email}:`;
    const claves = await clavesDe(base);
    // Agrupa por incidencia + apertura: 'r:<correo>:<rid>:<apertura>:'.
    const grupos = new Map<string, true>();
    for (const k of claves) {
      if (k.startsWith(s.base)) continue;
      const i = k.indexOf(':', base.length);
      const j = i < 0 ? -1 : k.indexOf(':', i + 1);
      if (j < 0) continue;
      grupos.set(k.slice(0, j + 1), true);
    }
    for (const pre of grupos.keys()) {
      if (diferidos.has(pre)) continue;
      const d = await idbGet<DatosBorrador>('archivos', pre + DATOS).catch(() => undefined);
      if (!d || vencido(d)) await borrarApertura(pre);
    }
  } catch {
    /* de mejor esfuerzo */
  }
}

/**
 * Guarda UNA foto o video recién preparado. true = quedó en el teléfono;
 * false = solo en memoria (sin lugar, sin IndexedDB o apertura cerrada).
 */
export function guardarFotoReparacion(s: SesionReparacion, f: File): Promise<boolean> {
  return enCola(
    s,
    async () => {
      if (s.cerrada) return false;
      // Los datos primero (y con la hora de ahora): un archivo sin datos no
      // se recupera.
      await escribirDatos(s);
      const k = nuevaClave(s);
      const ok = await guardarArchivo(k, f);
      if (s.cerrada) {
        // Se entregó o descartó mientras se copiaba: el File en memoria es
        // el que viajó; esta copia sobra.
        if (ok) await idbDelete('archivos', k).catch(() => {});
        return false;
      }
      if (ok) s.claves.set(f, k);
      return ok;
    },
    false
  );
}

/** Quita del teléfono una foto que el usuario quitó con su ×. */
export function quitarFotoReparacion(s: SesionReparacion, f: File): Promise<void> {
  return enCola(
    s,
    async () => {
      const k = s.claves.get(f);
      if (!k) return;
      s.claves.delete(f);
      await idbDelete('archivos', k);
    },
    undefined
  );
}

/** Guarda diagnóstico y detalle (el modal lo llama con una pausa, no por tecla). */
export function guardarTextosReparacion(
  s: SesionReparacion,
  diag: string,
  detalle: string
): Promise<void> {
  s.textos = { diag, detalle };
  return enCola(
    s,
    async () => {
      if (s.cerrada) return;
      await escribirDatos(s);
    },
    undefined
  );
}

/** El usuario descartó la captura: se borra todo (lo suyo y lo adoptado). */
export function descartarReparacion(s: SesionReparacion): Promise<void> {
  s.cerrada = true;
  return enCola(
    s,
    async () => {
      for (const pre of [s.prefijo, ...s.adoptadas]) await borrarApertura(pre);
    },
    undefined
  );
}

/**
 * La reparación salió del modal:
 *   'terminada' → aplicada (o ya no aplica: conflicto). El motor ya no usa
 *                 los File: se borra todo.
 *   'enCola'    → quedó en la cola del teléfono. Se marca entregado (ya no
 *                 se ofrece) y se borra cuando salga de la cola (ver arriba).
 * El cierre es INMEDIATO, antes de cualquier await: una foto que terminaba
 * de copiarse o los textos de la pausa ya no escriben.
 */
export function entregarReparacion(s: SesionReparacion, fin: 'terminada' | 'enCola'): Promise<void> {
  s.cerrada = true;
  return enCola(
    s,
    async () => {
      const prefijos = [s.prefijo, ...s.adoptadas];
      if (fin === 'terminada') {
        for (const pre of prefijos) await borrarApertura(pre);
        return;
      }
      const conDatos: string[] = [];
      for (const pre of prefijos) {
        const d = await idbGet<DatosBorrador>('archivos', pre + DATOS).catch(() => undefined);
        if (!d) {
          // Nunca llegó a escribir datos: lo que hubiera es basura.
          await borrarApertura(pre);
          continue;
        }
        try {
          await idbPut('archivos', { ...d, entregado: { en: Date.now(), carga: CARGA } });
        } catch {
          /* sin marca: si se reabre esta reparación se ofrecería; la
             vigilancia de abajo igual lo borra al salir de la cola */
        }
        conDatos.push(pre);
      }
      if (conDatos.length) diferir(conDatos, s.email, s.recordId);
    },
    undefined
  );
}
