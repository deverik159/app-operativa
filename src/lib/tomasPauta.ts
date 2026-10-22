// ============================================================
// src/lib/tomasPauta.ts
// La COLA DE TOMAS de Pauta: cada foto o video de la toma se guarda en el
// teléfono ANTES de subir, sube sola en segundo plano y, cuando todo entró,
// la toma se registra sola (fase 1 de comprobaciones, Erik, 22-oct-2026).
//
// POR QUÉ: la foto que se toma con la cámara de la app no llega al carrete
// del iPhone, y la toma la subía directo desde el modal: si la subida
// fallaba, la foto se perdía y había que repetirla frente a la valla. Ahora:
//   · Al elegir la foto se fija UNA vez su ruta en Storage y se guarda con
//     su Blob en una base propia ('gpo-tomas'). El monitorista sigue
//     tomando mientras sube.
//   · Mandar es repetible: la subida va con upsert apagado ("ya existe" =
//     ya quedó, lib/envios.subir) y el INSERT se anota 'ligando' antes de
//     mandarse; si no se supo si entró, el siguiente intento consulta por la
//     ruta antes de repetirlo. pauta_evidencias no tiene llave única (sin
//     migración en esta fase): el candado entre pestañas ('toma-') y esa
//     consulta cierran el duplicado.
//   · "Registrar toma" ya no llama registrar_toma desde el modal: pide el
//     registro al trabajo y la cola lo hace cuando TODO quedó ligado y el
//     servidor tiene el mínimo de la especificación. registrar_toma no
//     cuenta fotos y, si las vigentes ya estaban revisadas, comprueba sola:
//     registrar antes de que suban todas la dejaba comprobada a medias.
//   · Si la toma se comprobó, lo que falta ya no sube (la base lo rechaza):
//     se queda en el teléfono con el aviso, para guardarlo o descartarlo.
//   · Solo se reintenta por RED, y nada sale sin sesión real y del dueño
//     (exigirSesion): al volver la señal hay ~60 s en que todo sale como
//     anónimo y la RLS contesta en silencio.
//
// LO QUE APRENDIÓ LA REVISIÓN DEL DISEÑO (22-oct-2026):
//   · El trabajo de una cara CAMBIA mientras la cola lo manda (el modal le
//     agrega fotos y pide el registro). Toda escritura es get+put en UNA
//     transacción (actualizar), la cola relee el trabajo antes de cada paso
//     y el trabajo solo se borra si, releído en la misma transacción, ya no
//     tiene nada pendiente. Los Blobs se borran por llave exacta.
//   · Quitar una foto no espera al candado: se marca 'quitado' (lápida) y la
//     cola la respeta antes de subir, antes de insertar y después.
//   · Cada trabajo tiene su propio id (UUID); la clave (correo|año|cat|cara)
//     solo sirve para encontrar el trabajo activo de una cara.
//
// En el iPhone la cola avanza mientras la app está abierta (en cualquier
// pantalla); con la app cerrada no sube nada y sigue al volver a abrirla:
// Safari no tiene sincronización en segundo plano.
//
// Contrato con la pantalla (RegistrarTomaModal, PautaView): encolarFotos,
// pedirRegistro, quitarArchivo, quitarPorPath, trabajosDeCara,
// archivoLocal, resumenTomas, tomasRegistradasEnSesion, suscribirTomas.
// Con el aviso global (components/EnviosPendientes): listarTomasAviso,
// procesarTomasPendientes, descartarToma, tomarAvisosTomas y
// tomarLogrosTomas, con los mismos disparadores que las otras colas.
// ============================================================
import { sb } from './supabase';
import { BUCKET_EVIDENCIAS } from './storage';
import { reportarError } from './reportarError';
import { retenerRecargaAutomatica } from './cargaDiferida';
import { diaCdmx } from './fechasCdmx';
import {
  ErrorIdb,
  archivoDeRegistro,
  registroDeArchivo,
  registroEnBytes,
  topeEscrituraArchivo,
  type RegistroArchivo,
} from './idb';
import {
  ESPERA_SESION_INTERACTIVA_MS,
  SinLectura,
  SinRed,
  SinSesion,
  SubidaLenta,
  clasificarStorage,
  conCandado,
  conReintento,
  dormir,
  esFallaRedPg,
  exigirSesion,
  mensajeDe,
  nuevoIdEnvio,
  registrarRiesgoExtra,
  subir,
  textoEnCola,
  tope,
} from './envios';
import { crearBaseTolerante } from './idbTolerante';
import {
  claveTrabajo,
  decidirRegistro,
  esFinal,
  extensionDe,
  faltanFotos,
  fallidos,
  porLimpiar,
  fotosPorSubir,
  listoParaCerrar,
  llaveCara,
  nombreParaCompartir,
  porMandar,
  resumenPorCara,
  rutaFoto,
  soloLimpieza,
  tipoDeArchivo,
  type ArchivoToma,
  type EstadoArchivo,
  type EstadoTomaServidor,
  type Logro,
  type ResumenCara,
  type TrabajoToma,
} from './tomasPautaLogica';

// ------------------------------------------------------------
// Tipos (contrato con la pantalla y el aviso)
// ------------------------------------------------------------

/** La cara que se está tomando (sale de la fila de Pauta). */
export type ContextoToma = {
  anio: number;
  catorcena: number;
  vfid: string;
  site_id: string;
  cara: string | null;
  campana: string | null;
};

export type ArchivoNuevo = { file: File; origen: 'camara' | 'galeria' };

export type ResultadoEncolar =
  | {
      tipo: 'ok';
      /** Id del trabajo. */
      id: string;
      /** Los archivos tal como quedaron en la cola, en el orden recibido (con su trabajo). */
      archivos: (ArchivoToma & { trabajo: string })[];
      /** false = ninguno cupo en el teléfono: si se cierra la app, se pierden. */
      enTelefono: boolean;
      /** Cuántos quedaron solo en la memoria de esta pestaña. */
      fueraDelTelefono: number;
    }
  | { tipo: 'error'; mensaje: string };

export type ResultadoPedirRegistro =
  /** Ya quedó registrada (con buena señal, en un par de segundos). */
  | { tipo: 'registrada'; fotos: number }
  /** Sigue en la cola: se registra sola cuando suban las fotos. */
  | { tipo: 'enCola'; mensaje: string | null }
  | { tipo: 'error'; mensaje: string };

/** Lo que el aviso global pinta de cada trabajo. */
export type ResumenTomaAviso = {
  id: string;
  /** "MX_CM_EV_3325 · cara 01" */
  resumen: string;
  creado_en: string;
  enviando: boolean;
  soloMemoria: boolean;
  fueraDelTelefono: number;
  ultimoError: string | null;
  conError: boolean;
  archivos: number;
  ligados: number;
  registrarPedido: boolean;
  /**
   * Pide que el monitorista lo vea: un error, algo solo en memoria, o un
   * intento que ya falló. Una subida normal con señal no lo prende (así el
   * aviso global no aparece por cada foto).
   */
  atencion: boolean;
};

type ResultadoInterno =
  | { tipo: 'hecha' }
  | { tipo: 'sigue' }
  | { tipo: 'enCola'; cortar: boolean }
  /** `nuevo` = el mensaje cambió respecto a lo último que se avisó (se avisa una vez). */
  | { tipo: 'error'; id: string; mensaje: string; nuevo: boolean; email: string; donde: string }
  | { tipo: 'ocupado' }
  | { tipo: 'yaHecha' };

// ------------------------------------------------------------
// Tiempos y topes
// ------------------------------------------------------------

/** Tope de una escritura de estado en IndexedDB (metadatos). */
const ESPERA_ESTADO_MS = 5000;
/** Tope del INSERT y de la RPC: abortado = incierto, el reintento lo resuelve. */
const ESPERA_ESCRITURA_MS = 20000;
/** Tope de una lectura chica a la base (la toma, el conteo, la ruta). */
const ESPERA_LECTURA_MS = 12000;
/** Lecturas fallidas seguidas de un archivo antes de darlo por perdido. */
const MAX_LECTURAS_FALLIDAS = 3;
/** Vueltas internas de un trabajo en una sola corrida (fotos que siguen llegando). */
const MAX_PASADAS = 60;
/** Cuánto espera "Registrar toma" a que la cola termine antes de cerrar el modal. */
const ESPERA_REGISTRO_MS = 8000;

// ------------------------------------------------------------
// IndexedDB propia: 'gpo-tomas'
// ------------------------------------------------------------

type Almacen = 'trabajos' | 'blobs_tomas';
const base = crearBaseTolerante<Almacen>('gpo-tomas', { trabajos: 'id', blobs_tomas: 'clave' });

const claveBlob = (id: string, fid: string) => `t:${id}:${fid}`;

function esTrabajo(x: unknown): x is TrabajoToma {
  const t = x as TrabajoToma | null;
  return !!t && t.v === 1 && typeof t.id === 'string' && Array.isArray(t.archivos);
}

async function idbTodos(): Promise<TrabajoToma[]> {
  const caja: { v: TrabajoToma[] } = { v: [] };
  await base.tx(['trabajos'], 'readonly', (t) => {
    const r = t.objectStore('trabajos').getAll();
    r.onsuccess = () => {
      caja.v = ((r.result as unknown[]) || []).filter(esTrabajo);
    };
  });
  return caja.v;
}

async function idbUno(id: string): Promise<TrabajoToma | undefined> {
  const caja: { v?: TrabajoToma } = {};
  await base.tx(['trabajos'], 'readonly', (t) => {
    const r = t.objectStore('trabajos').get(id);
    r.onsuccess = () => {
      caja.v = esTrabajo(r.result) ? r.result : undefined;
    };
  });
  return caja.v;
}

/** null = de verdad no está; si IndexedDB falla, lanza. */
async function idbBlob(clave: string): Promise<File | null> {
  const caja: { r?: RegistroArchivo } = {};
  await base.tx(['blobs_tomas'], 'readonly', (t) => {
    const r = t.objectStore('blobs_tomas').get(clave);
    r.onsuccess = () => {
      caja.r = r.result as RegistroArchivo | undefined;
    };
  });
  return caja.r ? archivoDeRegistro(caja.r) : null;
}

// ------------------------------------------------------------
// Estado de la pestaña
// ------------------------------------------------------------

/** Trabajos que NO se pudieron guardar en el teléfono (sin IndexedDB). */
const memoria = new Map<string, TrabajoToma>();
const soloMemoria = new Set<string>();
/** Los File originales por llave de Blob: preferibles a leerlos de IndexedDB. */
const archivosMem = new Map<string, File>();
/** Llaves de Blob que no cupieron en el teléfono (solo viven en archivosMem). */
const fueraDelTelefono = new Set<string>();
const enCurso = new Map<string, Promise<ResultadoInterno>>();
/** Llegó un "procesa" mientras corría: al terminar, otra corrida. */
const otraVuelta = new Set<string>();
/** …y esa otra corrida debe reintentar también lo rechazado (se pidió el registro). */
const otraVueltaForzada = new Set<string>();
/** Fotos y videos que entraron a una toma desde esta pestaña (ver ligadasHastaAhora). */
let ligadasEnPestana = 0;

/**
 * Cuántos archivos han entrado a una toma desde esta pestaña. El aviso
 * global pide con esto una recarga diferida de la lista cuando entra algo de
 * un trabajo que sigue vivo: así «Ver toma (N)» se corrige solo.
 */
export function ligadasHastaAhora(): number {
  return ligadasEnPestana;
}
/** Descartados: ninguna escritura tardía debe resucitarlos. */
const descartados = new Set<string>();
/** Avisos de errores que salieron por su cuenta; los recoge el aviso global. */
const buzon: { email: string; texto: string }[] = [];
/** Lo que terminó; lo recoge el aviso global para el aviso breve. */
const logros: { email: string; logro: Logro }[] = [];
/**
 * Tomas que la cola registró en esta pestaña: la lista de Pauta las pinta
 * como tomadas aunque su última lectura de la red sea de antes (sin esto la
 * cara volvía a "Pendiente" y se invitaba a repetirla).
 */
const registradas: { email: string; anio: number; catorcena: number; vfid: string; fotos: number; en: number }[] = [];
/**
 * Trabajos cuyo registro el monitorista está viendo en pantalla (pedirRegistro
 * espera el resultado y la lista abre «✓ Toma registrada»): su logro no se
 * repite en el aviso breve (revisión del código, 22-oct-2026).
 */
const confirmadosEnPantalla = new Set<string>();
/** Fotos de la toma al registrarla (las del servidor), para el aviso breve. */
const fotosDeRegistro = new Map<string, number>();
/**
 * Caras cuyo registro el monitorista vio en pantalla (año-catorcena-cara →
 * cuándo): los logros de fotos sueltas de esa cara anteriores a ese momento
 * ya no se muestran; eran dos avisos seguidos de la misma toma.
 */
const carasVistas = new Map<string, number>();

/** Suelta de la memoria de la pestaña lo de un archivo que ya terminó. */
function soltar(id: string, fid: string): void {
  archivosMem.delete(claveBlob(id, fid));
  fueraDelTelefono.delete(claveBlob(id, fid));
}

/**
 * Una llamada a la red con tope propio (storage.remove no acepta
 * abortSignal): si no contesta a tiempo cuenta como sin red y se reintenta en
 * la vuelta siguiente. Sin esto, un fetch colgado atoraba la cara y, dentro
 * de la vuelta del aviso, toda la cola de tomas (verificación, 22-oct-2026).
 */
function conTope<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    dormir(ms).then((): never => {
      throw new SinRed('El servidor no respondió.');
    }),
  ]);
}

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();

const bus: EventTarget | null = typeof EventTarget !== 'undefined' ? new EventTarget() : null;
let canal: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    canal = new BroadcastChannel('gpo-tomas');
    canal.onmessage = () => emitir(true);
  }
} catch {
  canal = null;
}

/** Lo que se perdería al recargar: solo en memoria, archivos fuera o en curso. */
function tomasEnRiesgo(): boolean {
  return soloMemoria.size > 0 || fueraDelTelefono.size > 0 || enCurso.size > 0;
}

// "Actualizar ahora" / "Recargar la app" también preguntan por estas.
registrarRiesgoExtra(tomasEnRiesgo, 'una toma');

/** Retención propia de la recarga automática por chunk viejo (lib/cargaDiferida). */
let soltarRetencion: (() => void) | null = null;
function sincronizarRetencion(): void {
  const riesgo = tomasEnRiesgo();
  if (riesgo && !soltarRetencion) soltarRetencion = retenerRecargaAutomatica();
  else if (!riesgo && soltarRetencion) {
    soltarRetencion();
    soltarRetencion = null;
  }
}

function emitir(desdeOtraPestana = false): void {
  sincronizarRetencion();
  try {
    bus?.dispatchEvent(new Event('cambio'));
  } catch {
    /* sin suscriptores */
  }
  if (!desdeOtraPestana) {
    try {
      canal?.postMessage('cambio');
    } catch {
      /* canal cerrado */
    }
  }
}

/** Se llama cada vez que la cola de tomas cambia (aquí o en otra pestaña). */
export function suscribirTomas(cb: () => void): () => void {
  if (!bus) return () => {};
  const h = () => cb();
  bus.addEventListener('cambio', h);
  return () => bus.removeEventListener('cambio', h);
}

/** Los avisos que quedaron en el buzón para este correo (se entregan una vez). */
export function tomarAvisosTomas(email?: string): string[] {
  const em = norm(email);
  const mios: string[] = [];
  for (let i = 0; i < buzon.length; ) {
    if (!em || buzon[i].email === em) mios.push(buzon.splice(i, 1)[0].texto);
    else i++;
  }
  return mios;
}

/** Lo que terminó para este correo (se entrega una vez), para el aviso breve. */
export function tomarLogrosTomas(email?: string): Logro[] {
  const em = norm(email);
  const mios: Logro[] = [];
  for (let i = 0; i < logros.length; ) {
    if (!em || logros[i].email === em) mios.push(logros.splice(i, 1)[0].logro);
    else i++;
  }
  return mios;
}

/**
 * Los logros que todavía vale la pena mostrar: se sueltan los de una cara
 * cuyo registro el monitorista ya vio en pantalla (fotos sueltas de antes y
 * el propio registro), para no darle dos avisos seguidos de lo mismo.
 */
export function logrosPorMostrar(lista: Logro[]): Logro[] {
  return lista.filter((l) => {
    if (!l.llave) return true;
    const vista = carasVistas.get(l.llave);
    return vista === undefined || (l.en ?? 0) > vista;
  });
}

/** La ventana de la toma vio que la cola la registró (banner «✓ La toma quedó registrada»). */
export function marcarRegistroVisto(anio: number, catorcena: number, vfid: string): void {
  carasVistas.set(llaveCara(anio, catorcena, vfid), Date.now());
}

/**
 * Las tomas que la cola registró en esta pestaña para este correo. `en` es
 * cuándo (reloj del teléfono, ms): la lista suelta la marca con la primera
 * carga que empezó después.
 */
export function tomasRegistradasEnSesion(
  email: string
): { anio: number; catorcena: number; vfid: string; fotos: number; en: number }[] {
  const em = norm(email);
  return registradas
    .filter((r) => r.email === em)
    .map(({ anio, catorcena, vfid, fotos, en }) => ({ anio, catorcena, vfid, fotos, en }));
}

/**
 * La lista ya se cargó después del registro: la marca de sesión sobra. Sin
 * esto, si después el analista la regresaba, la fila seguía diciendo
 * «Tomada · actualizando…» hasta recargar la app.
 */
export function olvidarRegistrada(email: string, anio: number, catorcena: number, vfid: string): void {
  const em = norm(email);
  for (let i = registradas.length - 1; i >= 0; i--) {
    const r = registradas[i];
    if (r.email === em && r.anio === anio && r.catorcena === catorcena && r.vfid === vfid) registradas.splice(i, 1);
  }
}

const conPunto = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : s.trim() + '.');

// ------------------------------------------------------------
// Leer y escribir trabajos
// ------------------------------------------------------------

/** El trabajo fresco: el de memoria si es solo de memoria; si no, el del teléfono. */
async function leer(id: string): Promise<TrabajoToma | null> {
  if (descartados.has(id)) return null;
  if (soloMemoria.has(id)) return memoria.get(id) ?? null;
  try {
    return (await idbUno(id)) ?? null;
  } catch (err) {
    throw new SinLectura('No se pudo leer la toma guardada en el teléfono: ' + mensajeDe(err));
  }
}

/** Todos los trabajos de este correo (teléfono + memoria), del más viejo al más nuevo. */
async function listarTodos(email: string): Promise<TrabajoToma[]> {
  const porId = new Map<string, TrabajoToma>();
  try {
    (await idbTodos()).forEach((t) => porId.set(t.id, t));
  } catch {
    /* sin IndexedDB: solo lo de memoria */
  }
  memoria.forEach((t, id) => porId.set(id, t));
  const em = norm(email);
  return [...porId.values()]
    .filter((t) => norm(t.email) === em && !descartados.has(t.id))
    .sort((x, y) => x.creado_en.localeCompare(y.creado_en));
}

type Cambio = TrabajoToma | 'borrar' | null;

/**
 * Un trabajo que vive en memoria pudo dejar una copia vieja en el teléfono
 * (pasó a memoria a medias). Cada cambio se copia también ahí, de mejor
 * esfuerzo y en orden por trabajo: si iOS recarga la app, la copia dice lo
 * último y, p. ej., una foto quitada no vuelve a subir (verificación,
 * 22-oct-2026). Sin IndexedDB, simplemente falla en silencio.
 */
/**
 * A lo más una copia en vuelo y una pendiente por trabajo: con IndexedDB
 * colgada, una cadena de N copias de 5 s cada una se volvía larguísima. La
 * pendiente se reemplaza por la última (y junta las llaves de Blob a borrar).
 */
const espejoPendiente = new Map<string, { copia: TrabajoToma | null; claves: Set<string> }>();
const espejoCorriendo = new Set<string>();
function espejar(id: string, cambio: TrabajoToma | 'borrar', claves: string[]): void {
  const copia = cambio === 'borrar' ? null : (JSON.parse(JSON.stringify(cambio)) as TrabajoToma);
  const previa = espejoPendiente.get(id);
  espejoPendiente.set(id, { copia, claves: new Set([...(previa?.claves ?? []), ...claves]) });
  if (!espejoCorriendo.has(id)) void correrEspejo(id);
}
async function correrEspejo(id: string): Promise<void> {
  espejoCorriendo.add(id);
  try {
    for (let p = espejoPendiente.get(id); p; p = espejoPendiente.get(id)) {
      espejoPendiente.delete(id);
      // Descartado mientras esperaba: una copia ya no debe resucitarlo (el
      // borrado de descartarToma va en una transacción posterior).
      const copia = descartados.has(id) ? null : p.copia;
      const claves = p.claves;
      await base
        .tx(
          ['trabajos', 'blobs_tomas'],
          'readwrite',
          (x) => {
            if (copia) x.objectStore('trabajos').put(copia);
            else x.objectStore('trabajos').delete(id);
            claves.forEach((k) => x.objectStore('blobs_tomas').delete(k));
          },
          ESPERA_ESTADO_MS
        )
        .catch(() => undefined);
    }
  } finally {
    espejoCorriendo.delete(id);
  }
}

/**
 * Lee el trabajo, le aplica `fn` y lo escribe en UNA transacción (atómico
 * aunque escriban dos pestañas). `fn` es síncrona: null = no cambiar,
 * 'borrar' = quitar el trabajo y los Blobs de sus archivos. `blobs` se
 * escriben y `borrarBlobs` se borran en la misma transacción. Devuelve el
 * trabajo como quedó (null si se borró, undefined si no existía).
 */
async function actualizar(
  id: string,
  fn: (t: TrabajoToma) => Cambio,
  op: { blobs?: RegistroArchivo[]; borrarBlobs?: string[]; topeMs?: number } = {}
): Promise<TrabajoToma | null | undefined> {
  if (descartados.has(id)) return undefined;
  if (soloMemoria.has(id)) {
    const cur = memoria.get(id);
    if (!cur) return undefined;
    const r = fn(JSON.parse(JSON.stringify(cur)) as TrabajoToma);
    if (r === 'borrar') {
      memoria.delete(id);
      soloMemoria.delete(id);
      cur.archivos.forEach((a) => soltar(id, a.fid));
      // Pudo quedar una copia vieja en el teléfono (el trabajo pasó a memoria
      // a medias): que no resucite en esta pestaña ni en la siguiente.
      descartados.add(id);
      espejar(
        id,
        'borrar',
        cur.archivos.map((a) => claveBlob(id, a.fid))
      );
      emitir();
      return null;
    }
    if (r) {
      r.actualizado_en = new Date().toISOString();
      memoria.set(id, r);
      espejar(id, r, op.borrarBlobs ?? []);
      emitir();
      return r;
    }
    return cur;
  }
  const caja: { v?: TrabajoToma | null; borrados?: ArchivoToma[] } = {};
  await base.tx(
    ['trabajos', 'blobs_tomas'],
    'readwrite',
    (t) => {
      const st = t.objectStore('trabajos');
      const bs = t.objectStore('blobs_tomas');
      const req = st.get(id);
      req.onsuccess = () => {
        const cur = esTrabajo(req.result) ? (req.result as TrabajoToma) : undefined;
        if (!cur) {
          caja.v = undefined;
          return;
        }
        const r = fn(cur);
        if (r === 'borrar') {
          st.delete(id);
          cur.archivos.forEach((a) => bs.delete(claveBlob(id, a.fid)));
          caja.v = null;
          caja.borrados = cur.archivos;
          return;
        }
        if (r) {
          r.actualizado_en = new Date().toISOString();
          st.put(r);
          op.blobs?.forEach((b) => bs.put(b));
          caja.v = r;
        } else caja.v = cur;
        op.borrarBlobs?.forEach((k) => bs.delete(k));
      };
    },
    op.topeMs ?? ESPERA_ESTADO_MS
  );
  caja.borrados?.forEach((a) => soltar(id, a.fid));
  emitir();
  return caja.v;
}

/** Cambia un archivo del trabajo (atómico). */
function conArchivo(id: string, fid: string, cambio: (a: ArchivoToma) => void, op?: { borrarBlob?: boolean }) {
  return actualizar(
    id,
    (t) => {
      const a = t.archivos.find((x) => x.fid === fid);
      if (!a) return null;
      cambio(a);
      return t;
    },
    op?.borrarBlob ? { borrarBlobs: [claveBlob(id, fid)] } : {}
  );
}

/**
 * Anota el último error. Uno de red ("Sin señal…") NO pisa un error
 * definitivo vigente (toma comprobada, faltan fotos, foto rechazada): si no,
 * con la señal yendo y viniendo el mismo aviso volvía a salir como nuevo y
 * la fila de Pauta prendía y apagaba el rojo (revisión, 22-oct-2026).
 */
async function anotar(id: string, error: string | null, conError: boolean): Promise<void> {
  try {
    await actualizar(id, (t) => {
      if (!conError && t.conError) return null;
      t.ultimoError = error ? error.slice(0, 300) : null;
      t.conError = conError;
      return t;
    });
  } catch {
    /* el aviso no debe tumbar la cola */
  }
}

/** Lo que pedía atención ya se resolvió. */
async function limpiarError(id: string): Promise<void> {
  try {
    await actualizar(id, (t) => {
      if (!t.conError && !t.ultimoError && !t.avisado) return null;
      t.conError = false;
      t.ultimoError = null;
      // Si vuelve a pasar más adelante, se vuelve a avisar.
      t.avisado = null;
      return t;
    });
  } catch {
    /* nada */
  }
}

// ------------------------------------------------------------
// Encolar (lo que llama el modal)
// ------------------------------------------------------------

/** El trabajo activo de una cara, si hay. */
async function trabajoActivo(email: string, ctx: ContextoToma): Promise<TrabajoToma | null> {
  const clave = claveTrabajo(email, ctx.anio, ctx.catorcena, ctx.vfid);
  const todos = await listarTodos(email);
  // Si hay más de uno (uno solo de memoria y otro en el teléfono), el más nuevo.
  return todos.filter((t) => t.clave === clave).pop() ?? null;
}

/**
 * "Buscar o crear" el trabajo de una cara, de uno en uno por cara en la
 * pestaña: dos toques casi juntos (dos "Registrar", foto y registro) no
 * deben crear dos trabajos de la misma cara.
 */
const porCara = new Map<string, Promise<unknown>>();
function obtenerTrabajo(email: string, ctx: ContextoToma): Promise<TrabajoToma> {
  const clave = claveTrabajo(email, ctx.anio, ctx.catorcena, ctx.vfid);
  const previo = porCara.get(clave) ?? Promise.resolve();
  const p = previo.then(async () => {
    const t = await trabajoActivo(email, ctx);
    if (t) return t;
    const nuevo = trabajoNuevo(email, ctx);
    await crear(nuevo);
    return nuevo;
  });
  const cola = p.catch(() => undefined);
  porCara.set(clave, cola);
  void cola.then(() => {
    if (porCara.get(clave) === cola) porCara.delete(clave);
  });
  return p;
}

function trabajoNuevo(email: string, ctx: ContextoToma): TrabajoToma {
  const ahora = new Date().toISOString();
  return {
    v: 1,
    id: nuevoIdEnvio(),
    clave: claveTrabajo(email, ctx.anio, ctx.catorcena, ctx.vfid),
    email: norm(email),
    anio: ctx.anio,
    catorcena: ctx.catorcena,
    vfid: ctx.vfid,
    site_id: ctx.site_id,
    cara: ctx.cara,
    campana: ctx.campana,
    minimo: 0,
    registrar: false,
    registrarPedidoEn: null,
    registrada: false,
    archivos: [],
    ultimoError: null,
    conError: false,
    creado_en: ahora,
    actualizado_en: ahora,
  };
}

/** Crea el trabajo en el teléfono; si no hay IndexedDB, en memoria. */
async function crear(t: TrabajoToma): Promise<void> {
  try {
    await base.tx(['trabajos'], 'readwrite', (x) => {
      x.objectStore('trabajos').put(t);
    }, ESPERA_ESTADO_MS);
  } catch (err) {
    soloMemoria.add(t.id);
    memoria.set(t.id, t);
    reportarError('tomas.idb', err, { motivo: err instanceof ErrorIdb ? err.motivo : 'otro' });
  }
  emitir();
}

/**
 * Agrega UN archivo al trabajo con su Blob en la misma transacción. Si no
 * cabe como Blob se intenta en bytes (Safari viejo); si tampoco, queda solo
 * el registro y el archivo vive en la memoria de esta pestaña ('fuera').
 */
async function agregarArchivo(id: string, a: ArchivoToma, f: File): Promise<'telefono' | 'memoria' | 'sinTrabajo'> {
  const k = claveBlob(id, a.fid);
  const agregar = (t: TrabajoToma): Cambio => {
    if (t.archivos.some((x) => x.fid === a.fid)) return null;
    t.archivos.push(a);
    // Una foto nueva es información nueva: el error anterior (p. ej. "faltan
    // fotos") se vuelve a evaluar en la siguiente corrida. Salvo el de una
    // foto que el servidor rechazó: ése sigue en pie hasta que suba o se quite.
    if (!fallidos(t)) {
      t.conError = false;
      t.ultimoError = null;
    }
    return t;
  };
  if (soloMemoria.has(id)) {
    if ((await actualizar(id, agregar)) === undefined) return 'sinTrabajo';
    archivosMem.set(k, f);
    fueraDelTelefono.add(k);
    return 'memoria';
  }
  /** true = quedó; false = no cupo; 'sinTrabajo' = la cola lo cerró mientras tanto. */
  const intentar = async (r: RegistroArchivo | null): Promise<boolean | 'sinTrabajo'> => {
    try {
      const res = await actualizar(id, agregar, { blobs: r ? [r] : [], topeMs: topeEscrituraArchivo(f.size) });
      return res === undefined || res === null ? 'sinTrabajo' : true;
    } catch (err) {
      // Base ausente o colgada: otro intento solo retrasaría el botón.
      if (err instanceof ErrorIdb && (err.motivo === 'no-disponible' || err.motivo === 'tope')) throw err;
      return false;
    }
  };
  try {
    let r = await intentar(registroDeArchivo(k, f));
    if (r === 'sinTrabajo') return r;
    if (r) {
      archivosMem.set(k, f);
      return 'telefono';
    }
    const enBytes = await registroEnBytes(k, f);
    if (enBytes) {
      r = await intentar(enBytes);
      if (r === 'sinTrabajo') return r;
      if (r) {
        archivosMem.set(k, f);
        return 'telefono';
      }
    }
    // Sin Blob: el registro sí, para que la cola sepa del archivo.
    r = await intentar(null);
    if (r === 'sinTrabajo') return r;
    if (r) {
      archivosMem.set(k, f);
      fueraDelTelefono.add(k);
      reportarError('tomas.idb', new Error('archivo solo en memoria'), { bytes: f.size });
      return 'memoria';
    }
  } catch {
    /* sin IndexedDB: abajo */
  }
  // Ni el registro entró: el trabajo pasa a memoria con lo que tenga.
  let t: TrabajoToma | undefined;
  try {
    t = (await idbUno(id).catch(() => undefined)) ?? memoria.get(id);
  } catch {
    t = memoria.get(id);
  }
  if (!t) return 'sinTrabajo';
  const r = agregar(JSON.parse(JSON.stringify(t)) as TrabajoToma);
  memoria.set(id, r && r !== 'borrar' ? r : t);
  soloMemoria.add(id);
  archivosMem.set(k, f);
  fueraDelTelefono.add(k);
  reportarError('tomas.idb', new Error('toma solo en memoria'), { bytes: f.size });
  emitir();
  return 'memoria';
}

/**
 * Las fotos o videos recién elegidos en la toma: se guardan en el teléfono
 * (en el orden recibido) y la cola los empieza a subir. El modal ya no
 * espera la subida.
 */
export async function encolarFotos(
  email: string,
  ctx: ContextoToma,
  nuevos: ArchivoNuevo[],
  referencia: string | null
): Promise<ResultadoEncolar> {
  const em = norm(email);
  if (!em) return { tipo: 'error', mensaje: 'Sin sesión: vuelve a entrar a la app.' };
  if (!ctx.vfid || !Number.isFinite(ctx.anio) || !Number.isFinite(ctx.catorcena))
    return { tipo: 'error', mensaje: 'Falta la cara o la catorcena de la toma.' };
  if (!nuevos.length) return { tipo: 'error', mensaje: 'No hay archivos que guardar.' };

  const t = await obtenerTrabajo(em, ctx);
  let id = t.id;
  const dia = diaCdmx(new Date());
  const marcaMs = Date.now();
  const idCorto = id.replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'toma';
  let n = t.archivos.reduce((m, a) => Math.max(m, a.n), 0);
  const ahora = new Date().toISOString();
  const salida: (ArchivoToma & { trabajo: string })[] = [];
  let fuera = 0;
  for (const { file, origen } of nuevos) {
    n++;
    const tipo = tipoDeArchivo(file.type, file.name);
    const ext = extensionDe(file.name, file.type, tipo);
    const a: ArchivoToma = {
      fid: `${n}-${nuevoIdEnvio().replace(/[^a-z0-9]/gi, '').slice(0, 6)}`,
      n,
      path: rutaFoto({ anio: ctx.anio, catorcena: ctx.catorcena, vfid: ctx.vfid, dia, marcaMs, idCorto, n, ext }),
      nombre: nombreParaCompartir(ctx.vfid, `${idCorto}-${n}`, ext),
      mime: file.type || (tipo === 'video' ? 'video/mp4' : 'image/jpeg'),
      tipo,
      bytes: file.size,
      referencia: (referencia || '').trim() || null,
      encolado_en: ahora,
      origen,
      estado: 'local',
    };
    let donde = await agregarArchivo(id, a, file);
    if (donde === 'sinTrabajo') {
      // La cola cerró el trabajo (todo había subido) justo entre la lectura y
      // esta foto: va a un trabajo nuevo. Su ruta sigue siendo única (lleva
      // la marca y el número de esta tanda).
      const nuevo = trabajoNuevo(em, ctx);
      await crear(nuevo);
      id = nuevo.id;
      a.fid = `${n}-${nuevoIdEnvio().replace(/[^a-z0-9]/gi, '').slice(0, 6)}`;
      donde = await agregarArchivo(id, a, file);
    }
    if (donde !== 'telefono') fuera++;
    salida.push({ ...a, trabajo: id });
  }
  emitir();
  // Primer intento en segundo plano; si no termina, sale con los demás
  // disparadores del aviso global (red, sesión, primer plano, cada 2 min).
  void procesar(id);
  return { tipo: 'ok', id, archivos: salida, enTelefono: fuera < nuevos.length, fueraDelTelefono: fuera };
}

/**
 * "Registrar toma": se pide al trabajo de la cara (o a uno nuevo, vacío, si
 * todas las fotos ya habían subido) y la cola lo hace en cuanto todo entró.
 * Es el ÚNICO camino a registrar_toma: dos caminos sin candado común
 * mandaban dos "Toma por revisar" a cada analista. Espera unos segundos: con
 * señal, la toma queda registrada antes de cerrar el modal.
 */
export async function pedirRegistro(
  email: string,
  ctx: ContextoToma,
  minimo: number,
  op: {
    /**
     * La ventana NO mostraba un regreso (fila.rechazo_motivo vacío). La base
     * guarda motivo y fecha del rechazo juntos y registrar_toma los limpia
     * juntos: entonces la base de "regresada" es "sin rechazo" y se fija aquí,
     * sin ir a la red. Si mostraba uno, la fija la cola leyendo el servidor.
     * Antes se leía aquí con red y, con una barra, la ventana se quedaba
     * 20-40 s en «Registrando…» (verificación, 22-oct-2026).
     */
    sinRechazo?: boolean;
    /** ¿Sigue a la vista la ventana? Si no, el aviso breve sí lo dice. */
    enPantalla?: () => boolean;
  } = {}
): Promise<ResultadoPedirRegistro> {
  const em = norm(email);
  if (!em) return { tipo: 'error', mensaje: 'Sin sesión: vuelve a entrar a la app.' };
  const inicio = Date.now();
  const ahora = new Date(inicio).toISOString();
  let id = '';
  // El trabajo pudo cerrarse (todo había subido) entre buscarlo y anotarle
  // el registro: entonces se busca o crea otra vez.
  for (let intento = 0; intento < 3 && !id; intento++) {
    const t = await obtenerTrabajo(em, ctx);
    try {
      const r = await actualizar(t.id, (x) => {
        x.registrar = true;
        x.registrarPedidoEn = ahora;
        // "Regresada" se mide contra lo que dice el servidor, nunca contra
        // el reloj del teléfono.
        if (op.sinRechazo) x.rechazoBase = null;
        else delete x.rechazoBase;
        x.minimo = Math.max(0, minimo || 0);
        // Una foto rechazada sigue en pie: su rojo no se apaga por pedir.
        if (!fallidos(x)) {
          x.conError = false;
          x.ultimoError = null;
        }
        return x;
      });
      if (r) id = t.id;
    } catch (err) {
      return { tipo: 'error', mensaje: 'No se pudo guardar el registro en el teléfono: ' + mensajeDe(err) };
    }
  }
  if (!id) return { tipo: 'error', mensaje: 'No se pudo guardar el registro en el teléfono; intenta de nuevo.' };
  // Si ya corre (subiendo fotos), esa corrida relee el trabajo y registra al
  // terminar; si no, se lanza una. En los dos casos se reintenta también lo
  // que el servidor rechazó (lo pidió el monitorista).
  const yaCorria = enCurso.get(id);
  if (yaCorria) {
    otraVuelta.add(id);
    otraVueltaForzada.add(id);
    // La corrida en curso no fija la base hasta su registro: que se fije ya,
    // en paralelo y dentro de la misma espera (sin bloquear la ventana).
    if (!op.sinRechazo)
      void leer(id)
        .then((t) => (t && t.rechazoBase === undefined ? fijarBase(t) : null))
        .catch(() => undefined);
  }
  // Mientras se espera, el registro lo ve el monitorista en pantalla: su
  // logro no se repite en el aviso breve.
  confirmadosEnPantalla.add(id);
  const corrida = yaCorria ?? procesar(id, true);
  const resta = () => Math.max(0, ESPERA_REGISTRO_MS - (Date.now() - inicio));
  /**
   * El último error que dio una corrida esperada: la siguiente puede cerrar
   * el trabajo (p. ej. tras "regresada") y con él se iría el error. Si al
   * final quedó registrada, eso manda.
   */
  let errorCorrida: string | null = null;
  const anotarCorrida = (r: ResultadoInterno) => {
    if (r.tipo === 'error') errorCorrida = r.mensaje;
  };
  await Promise.race([corrida.then(anotarCorrida), dormir(resta())]);
  // Si ya corría, al terminar arrancó la vuelta forzada (la que reintenta lo
  // rechazado y registra): también se espera, dentro del mismo tiempo. Si no,
  // se contestaba con el error de la foto rechazada un instante antes de que
  // la toma quedara registrada.
  for (let siguiente = enCurso.get(id); yaCorria && siguiente && resta() > 0; siguiente = enCurso.get(id))
    await Promise.race([siguiente.then(anotarCorrida), dormir(resta())]);
  // ¿Quedó? El trabajo se borra al terminar: se busca en lo registrado desde ahora.
  const hecho = registradas.find(
    (r) => r.en >= inicio && r.email === em && r.anio === ctx.anio && r.catorcena === ctx.catorcena && r.vfid === ctx.vfid
  );
  let fresco: TrabajoToma | null = null;
  try {
    fresco = await leer(id);
  } catch {
    fresco = null;
  }
  const visible = op.enPantalla ? op.enPantalla() : true;
  const registrada = (fotos: number): ResultadoPedirRegistro => {
    if (visible) carasVistas.set(llaveCara(ctx.anio, ctx.catorcena, ctx.vfid), Date.now());
    else {
      // La ventana ya no está (cambió de módulo): que el aviso breve lo diga.
      confirmadosEnPantalla.delete(id);
      if (!fresco)
        logros.push({
          email: em,
          logro: {
            site_id: ctx.site_id,
            cara: ctx.cara,
            registrada: true,
            fotos,
            llave: llaveCara(ctx.anio, ctx.catorcena, ctx.vfid),
            en: Date.now(),
          },
        });
      emitir();
    }
    return { tipo: 'registrada', fotos };
  };
  if (hecho && (!fresco || fresco.registrada)) return registrada(hecho.fotos);
  if (fresco?.registrada)
    return registrada(fresco.archivos.filter((a) => a.tipo === 'foto' && a.estado === 'ligado').length);
  // No quedó a la vista: si termina después, que el aviso breve sí lo diga.
  confirmadosEnPantalla.delete(id);
  if (fresco?.conError && fresco.ultimoError) return { tipo: 'error', mensaje: fresco.ultimoError };
  if (!fresco && errorCorrida) return { tipo: 'error', mensaje: errorCorrida };
  return { tipo: 'enCola', mensaje: fresco?.ultimoError ?? null };
}

/**
 * Quitar un archivo de la cola SIN esperar el candado: se marca 'quitado'
 * (lápida) y la cola lo respeta. Si ya había llegado a Storage, se marca
 * `limpiar` y la limpieza (fila y objeto) la hace la COLA, bajo su candado y
 * con reintento: hacerla aquí chocaba con un INSERT en vuelo y, sin señal,
 * se intentaba una sola vez (revisión del código, 22-oct-2026).
 */
export async function quitarArchivo(id: string, fid: string): Promise<'ok' | 'no-estaba'> {
  let estaba = false;
  const r = await actualizar(
    id,
    (t) => {
      const a = t.archivos.find((x) => x.fid === fid);
      if (!a || a.estado === 'quitado') return null;
      estaba = true;
      const eraFallido = a.estado === 'fallido';
      if (a.estado === 'subido' || a.estado === 'ligando' || a.estado === 'ligado' || (eraFallido && a.arriba))
        a.limpiar = true;
      a.estado = 'quitado';
      // Era la foto que el servidor rechazó y ya no queda otra: el rojo sobra.
      if (eraFallido && !fallidos(t)) {
        t.conError = false;
        t.ultimoError = null;
      }
      return t;
    },
    { borrarBlobs: [claveBlob(id, fid)] }
  );
  soltar(id, fid);
  if (r === undefined || !estaba) return 'no-estaba';
  void procesar(id);
  return 'ok';
}

/**
 * El modal borra una evidencia que ya estaba en el servidor (él mismo borra
 * la fila y el objeto): si esa ruta sigue en un trabajo (p. ej. 'ligando'),
 * se marca quitada antes, para que la cola no la vuelva a insertar. true =
 * de verdad quedó la lápida (si el trabajo se cerró en medio, false).
 */
export async function quitarPorPath(email: string, path: string): Promise<boolean> {
  let estaba = false;
  try {
    for (const t of await listarTodos(email)) {
      const a = t.archivos.find((x) => x.path === path && x.estado !== 'quitado');
      if (a) {
        await actualizar(
          t.id,
          (y) => {
            const x = y.archivos.find((z) => z.fid === a.fid);
            if (!x || x.estado === 'quitado') return null;
            estaba = true;
            const eraFallido = x.estado === 'fallido';
            x.estado = 'quitado';
            if (eraFallido && !fallidos(y)) {
              y.conError = false;
              y.ultimoError = null;
            }
            return y;
          },
          { borrarBlobs: [claveBlob(t.id, a.fid)] }
        );
        soltar(t.id, a.fid);
      }
    }
  } catch {
    /* de mejor esfuerzo */
  }
  return estaba;
}

/**
 * El borrado del modal falló por la red: que la cola borre la fila y el
 * archivo de esa ruta (ya con lápida) con reintento. Solo para eso: si la
 * base lo rechazó (toma ya comprobada) no se llama y la foto sigue a la
 * vista (verificación, 22-oct-2026). true = quedó en manos de la cola.
 */
export async function limpiarDespuesPorPath(email: string, path: string): Promise<boolean> {
  let marcado = false;
  try {
    for (const t of await listarTodos(email)) {
      if (!t.archivos.some((x) => x.path === path && x.estado === 'quitado')) continue;
      await actualizar(t.id, (y) => {
        const x = y.archivos.find((z) => z.path === path && z.estado === 'quitado');
        if (!x) return null;
        x.limpiar = true;
        marcado = true;
        return y;
      });
    }
  } catch {
    /* de mejor esfuerzo */
  }
  return marcado;
}

// ------------------------------------------------------------
// Lo que lee la pantalla
// ------------------------------------------------------------

/** Los trabajos de una cara (para el modal), del más viejo al más nuevo. */
export async function trabajosDeCara(email: string, anio: number, catorcena: number, vfid: string): Promise<TrabajoToma[]> {
  const clave = claveTrabajo(email, anio, catorcena, vfid);
  return (await listarTodos(email)).filter((t) => t.clave === clave);
}

/** El File de un archivo en cola (para la miniatura): memoria o teléfono; null si no está. */
export async function archivoLocal(id: string, fid: string): Promise<File | null> {
  const k = claveBlob(id, fid);
  const mem = archivosMem.get(k);
  if (mem) return mem;
  // Un trabajo que pasó a memoria pudo dejar sus primeras fotos en el
  // teléfono: se buscan ahí (solo las que nunca cupieron no están).
  if (fueraDelTelefono.has(k)) return null;
  try {
    return await idbBlob(k);
  } catch {
    return null;
  }
}

/** ¿La cola está mandando este trabajo ahora mismo? */
export function estaEnviando(id: string): boolean {
  return enCurso.has(id);
}

/** ¿Este trabajo tiene archivos que solo viven en la memoria de esta pestaña? */
export function enRiesgoTrabajo(t: TrabajoToma): number {
  if (soloMemoria.has(t.id)) return t.archivos.filter((a) => !esFinal(a.estado)).length;
  return t.archivos.filter((a) => !esFinal(a.estado) && fueraDelTelefono.has(claveBlob(t.id, a.fid))).length;
}

/** Resumen por cara (año-catorcena-cara) para la lista de Pauta. */
export async function resumenTomas(email: string): Promise<Map<string, ResumenCara & { enviando: boolean }>> {
  const todos = await listarTodos(email);
  const m = resumenPorCara(todos);
  const salida = new Map<string, ResumenCara & { enviando: boolean }>();
  m.forEach((r, k) => {
    const enviando = todos.some((t) => llaveCara(t.anio, t.catorcena, t.vfid) === k && enCurso.has(t.id));
    salida.set(k, { ...r, enviando });
  });
  return salida;
}

/** Lo que pinta el aviso global (todos; `atencion` decide cuáles se ven). */
export async function listarTomasAviso(email: string): Promise<ResumenTomaAviso[]> {
  return (await listarTodos(email)).map((t) => {
    const enviando = enCurso.has(t.id);
    const fuera = enRiesgoTrabajo(t);
    const sm = soloMemoria.has(t.id);
    return {
      id: t.id,
      resumen: `${t.site_id}${t.cara ? ` · cara ${t.cara}` : ''}`,
      creado_en: t.creado_en,
      enviando,
      soloMemoria: sm,
      fueraDelTelefono: fuera,
      ultimoError: t.ultimoError,
      conError: !!t.conError,
      archivos: t.archivos.filter((a) => a.estado !== 'quitado').length,
      ligados: t.archivos.filter((a) => a.estado === 'ligado').length,
      registrarPedido: t.registrar && !t.registrada,
      // No depende de `enviando`: mientras reintenta, el renglón dice
      // «enviando…» y el aviso no se quita y se pone (revisión, 22-oct-2026).
      // Lo que solo espera limpiar el servidor lo termina la cola sola.
      atencion: !soloLimpieza(t) && (!!t.conError || sm || fuera > 0 || !!t.ultimoError),
    };
  });
}

// ------------------------------------------------------------
// Pasos de la cola
// ------------------------------------------------------------

/** La toma de la cara en la base (sin fila = nunca se tocó). */
async function leerToma(t: TrabajoToma): Promise<EstadoTomaServidor> {
  await exigirSesion(undefined, t.email);
  const r = await sb
    .from('pauta_monitoreo')
    .select('fecha_toma,fecha_comprobacion,fecha_rechazo,rechazo_motivo')
    .eq('anio', t.anio)
    .eq('catorcena', t.catorcena)
    .eq('vendor_face_id', t.vfid)
    .limit(1)
    .abortSignal(tope(ESPERA_LECTURA_MS));
  if (r.error) {
    if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
    throw new Error(r.error.message);
  }
  const fila = (r.data as EstadoTomaServidor[] | null)?.[0];
  return fila ?? { fecha_toma: null, fecha_comprobacion: null, fecha_rechazo: null };
}

/** ¿Ya hay fila de esta ruta? (para un INSERT que no se supo si entró) */
async function hayFila(t: TrabajoToma, path: string): Promise<boolean> {
  await exigirSesion(undefined, t.email);
  const r = await sb
    .from('pauta_evidencias')
    .select('id')
    .eq('anio', t.anio)
    .eq('catorcena', t.catorcena)
    .eq('vendor_face_id', t.vfid)
    .eq('path', path)
    .limit(1)
    .abortSignal(tope(ESPERA_LECTURA_MS));
  if (r.error) {
    if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
    throw new Error(r.error.message);
  }
  return !!(r.data && r.data.length);
}

/** Fotos vigentes (sin video) de la cara en la base, por ruta distinta. */
async function contarFotosServidor(t: TrabajoToma): Promise<number> {
  await exigirSesion(undefined, t.email);
  const r = await sb
    .from('pauta_evidencias')
    .select('path,tipo')
    .eq('anio', t.anio)
    .eq('catorcena', t.catorcena)
    .eq('vendor_face_id', t.vfid)
    .is('regresada_en', null)
    .abortSignal(tope(ESPERA_LECTURA_MS));
  if (r.error) {
    if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
    throw new Error(r.error.message);
  }
  const rutas = new Set(
    ((r.data as { path: string | null; tipo: string | null }[]) || [])
      .filter((x) => x.tipo !== 'video')
      .map((x) => x.path || '')
  );
  rutas.delete('');
  return rutas.size;
}

/**
 * El File de un archivo: el original en memoria o el del teléfono. null = de
 * verdad no está. Si IndexedDB FALLA se lanza SinLectura (sigue en cola)
 * hasta MAX_LECTURAS_FALLIDAS seguidas; misma regla que lib/visitas.ts.
 * También se prueba que los bytes se dejen leer: un Blob ilegible fallaría
 * dentro de la subida como "sin red" y atoraría la cola para siempre.
 */
async function archivoDe(t: TrabajoToma, a: ArchivoToma): Promise<File | null> {
  const k = claveBlob(t.id, a.fid);
  // La prueba de lectura con tope: un Blob que no contesta atoraba la cara y
  // toda la vuelta de tomas (verificación, 22-oct-2026).
  const legible = async (f: File) => {
    await conTope(f.slice(0, 1).arrayBuffer(), ESPERA_LECTURA_MS);
    if (a.lecturasFallidas) await conArchivo(t.id, a.fid, (x) => void delete x.lecturasFallidas);
    return f;
  };
  const enTelefono = !fueraDelTelefono.has(k);
  const mem = archivosMem.get(k) ?? null;
  try {
    if (mem) {
      try {
        return await legible(mem);
      } catch (err) {
        // El File original ya no se deja leer, pero la copia del teléfono
        // puede estar bien: se prueba antes de contar el fallo (si no, se
        // perdía un video que sí estaba guardado).
        if (!enTelefono) throw err;
        archivosMem.delete(k);
        const copia = await idbBlob(k);
        if (!copia) throw err;
        return await legible(copia);
      }
    }
    if (!enTelefono) return null;
    const f = await idbBlob(k);
    if (!f) return null;
    return await legible(f);
  } catch (err) {
    const n = (a.lecturasFallidas || 0) + 1;
    if (n >= MAX_LECTURAS_FALLIDAS) {
      reportarError('tomas.lecturaLocal', err, { intentos: n });
      return null;
    }
    await conArchivo(t.id, a.fid, (x) => {
      x.lecturasFallidas = n;
    }).catch(() => undefined);
    throw new SinLectura('No se pudo leer una foto guardada en el teléfono: ' + mensajeDe(err));
  }
}

/** La base rechazó la foto porque la toma ya está comprobada (trigger P0001). */
class TomaComprobada extends Error {
  constructor() {
    super('La toma ya está comprobada: lo que faltaba ya no entra.');
    this.name = 'TomaComprobada';
  }
}

/** Mensaje de campo para la toma comprobada mientras la cola subía. */
function textoComprobada(t: TrabajoToma): string {
  const resto = t.archivos.filter((a) => !esFinal(a.estado));
  const fotos = resto.filter((a) => a.tipo === 'foto').length;
  const videos = resto.length - fotos;
  const que =
    resto.length === 1
      ? fotos
        ? 'esta foto ya no entra'
        : 'este video ya no entra'
      : `${fotos && videos ? `estos ${resto.length} archivos` : fotos ? `estas ${fotos} fotos` : `estos ${videos} videos`} ya no entran`;
  return (
    `El analista ya comprobó esta toma: ${que}. ` +
    'Si quieres conservar lo que tomaste con la cámara de la app, ábrela y toca «Guardar en Fotos»; luego descártalo.'
  );
}

/**
 * INSERT de la evidencia, sin .select() (no depende de la política de
 * lectura). 23505 = ya entró (por si un día se agrega la llave única).
 */
async function insertar(t: TrabajoToma, a: ArchivoToma): Promise<'ok' | { definitivo: string }> {
  const url = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(a.path).data.publicUrl;
  const r = await sb
    .from('pauta_evidencias')
    .insert({
      anio: t.anio,
      catorcena: t.catorcena,
      vendor_face_id: t.vfid,
      tipo: a.tipo,
      url,
      path: a.path,
      referencia: a.referencia,
      subido_por: t.email,
    })
    .abortSignal(tope(ESPERA_ESCRITURA_MS));
  if (!r.error) return 'ok';
  if (r.error.code === '23505') return 'ok';
  if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
  if (r.error.code === 'P0001' && /comprobada/i.test(r.error.message || '')) throw new TomaComprobada();
  // Un "sin permiso" con la sesión perdida a medio camino salió como anónimo:
  // si ya no hay sesión del dueño, exigirSesion lanza y sigue en cola.
  if (r.error.code === '42501') await exigirSesion(ESPERA_SESION_INTERACTIVA_MS, t.email);
  reportarError('tomas.insert', r.error, { code: r.error.code }, a.path);
  return { definitivo: r.error.message };
}

/**
 * Cambia el estado de un archivo SIN pisar la lápida: si el monitorista lo
 * quitó mientras tanto, se queda 'quitado'. Devuelve el archivo como quedó.
 */
async function moverA(
  id: string,
  fid: string,
  estado: EstadoArchivo,
  op?: { borrarBlob?: boolean }
): Promise<ArchivoToma | null> {
  const r = await conArchivo(id, fid, (x) => {
    if (x.estado === 'quitado') return;
    x.estado = estado;
    if (estado === 'subido') x.arriba = true;
    if (estado === 'ligado') {
      x.ligado_en = new Date().toISOString();
      ligadasEnPestana++;
    }
  }, op);
  return r?.archivos.find((x) => x.fid === fid) ?? null;
}

/** Quitado después de llegar a Storage: que la cola limpie el servidor. */
function marcarLimpiar(id: string, fid: string) {
  return conArchivo(id, fid, (x) => {
    if (x.estado === 'quitado') x.limpiar = true;
  });
}

/**
 * Limpia del servidor un archivo quitado: borra su fila (si la RLS deja; con
 * la toma comprobada no) y, solo si ya no queda fila, el objeto. Nunca borra
 * un objeto que una fila sigue usando. La red lanza SinRed (se reintenta en
 * la siguiente vuelta); lo demás se da por terminado.
 */
async function limpiarQuitado(t: TrabajoToma, a: ArchivoToma): Promise<void> {
  await exigirSesion(undefined, t.email);
  // Con un token a medio renovar la RLS contesta [] sin error: el DELETE no
  // borraría nada y la consulta diría "ya no hay fila". La foto quitada se
  // quedaría en la toma con la marca ya apagada (verificación, 22-oct-2026).
  await sesionValidaEnServidor(t.email);
  // 'objeto' (se descartó): lo que ya entró a la toma se queda; solo se
  // borra el archivo si no tiene fila.
  if (a.limpiar !== 'objeto') {
    const del = await sb
      .from('pauta_evidencias')
      .delete()
      .eq('anio', t.anio)
      .eq('catorcena', t.catorcena)
      .eq('vendor_face_id', t.vfid)
      .eq('path', a.path)
      .select('id')
      .abortSignal(tope(ESPERA_LECTURA_MS));
    if (del.error && esFallaRedPg(del.error, del.status)) throw new SinRed(del.error.message);
  }
  if (await hayFila(t, a.path)) {
    // La fila se queda: se descartó algo que ya había entrado, o la RLS no
    // dejó borrarla (la toma ya está comprobada). Su objeto también.
    if (a.limpiar !== 'objeto')
      reportarError('tomas.limpiar', new Error('fila que no se pudo borrar'), undefined, a.path);
  } else {
    const r = await conTope(sb.storage.from(BUCKET_EVIDENCIAS).remove([a.path]), ESPERA_LECTURA_MS);
    if (r.error && clasificarStorage(r.error) === 'red') throw new SinRed(mensajeDe(r.error));
  }
  await conArchivo(t.id, a.fid, (x) => {
    delete x.limpiar;
  });
}

/**
 * Un archivo, de su estado actual hasta 'ligado' (o quitado/perdido/fallido).
 *   · Una toma comprobada ya no acepta fotos: no se sube (sin huérfanos) y,
 *     si ya había subido, el objeto se queda (descartar lo limpia).
 *   · Antes de CADA intento de INSERT se pregunta si la fila ya está:
 *     pauta_evidencias no tiene llave única en path y repetir a ciegas tras
 *     una respuesta perdida duplicaba la foto (revisión, 22-oct-2026).
 *   · Ningún cambio de estado pisa una lápida ('quitado').
 *   · Un rechazo definitivo del servidor deja el archivo 'fallido' con su
 *     Blob (se reintenta en la siguiente vuelta) y lo salta en esta.
 */
async function mandarArchivo(
  t: TrabajoToma,
  a0: ArchivoToma,
  toma: { v: EstadoTomaServidor },
  saltar: Set<string>
): Promise<void> {
  const id = t.id;
  let a = a0;
  const venia = a0.estado;
  // Un 'fallido' que ya estaba en Storage (rebotó el INSERT) solo falta
  // ligarlo: no se vuelve a subir ni necesita el Blob.
  const desdeCero = a.estado === 'local' || (a.estado === 'fallido' && !a.arriba);
  // Ya había llegado a Storage (o el INSERT quedó incierto): ¿ya entró?
  if (!desdeCero && (await hayFila(t, a.path))) {
    const y = await moverA(id, a.fid, 'ligado', { borrarBlob: true });
    soltar(id, a.fid);
    if (y?.estado === 'quitado') await marcarLimpiar(id, a.fid);
    return;
  }
  if (desdeCero) {
    if (toma.v.fecha_comprobacion) throw new TomaComprobada();
    const f = await archivoDe(t, a);
    if (!f) {
      reportarError('tomas.archivoPerdido', new Error('archivo no encontrado'), { bytes: a.bytes }, a.path);
      await moverA(id, a.fid, 'perdido');
      soltar(id, a.fid);
      return;
    }
    await exigirSesion(undefined, t.email);
    const res = await conReintento(() => subir(a, f, t.email));
    if (res !== 'ok') {
      reportarError('tomas.subida', res.definitivo, { bytes: f.size }, a.path);
      await moverA(id, a.fid, 'fallido');
      saltar.add(a.fid);
      await anotar(id, conPunto(`No se pudo subir la foto ${a.n}: ${mensajeDe(res.definitivo)}`), true);
      return;
    }
    const y = await moverA(id, a.fid, 'subido');
    if (!y || y.estado === 'quitado') {
      await marcarLimpiar(id, a.fid);
      return;
    }
    a = y;
  }
  // Ligar: la toma pudo comprobarse mientras subía.
  toma.v = await leerToma(t);
  if (toma.v.fecha_comprobacion) throw new TomaComprobada();
  const y2 = await moverA(id, a.fid, 'ligando');
  if (!y2 || y2.estado === 'quitado') {
    await marcarLimpiar(id, a.fid);
    return;
  }
  await exigirSesion(undefined, t.email);
  const r = await conReintento(async () => {
    if (await hayFila(t, a.path)) return 'ok' as const;
    // La hora del ÚLTIMO INSERT mandado: lo que salió después de que llegó
    // la carga de la lista seguro no viene en su cuenta (ver PautaView).
    await conArchivo(id, a.fid, (x) => {
      x.insert_en = new Date().toISOString();
    }).catch(() => undefined);
    return insertar(t, a);
  });
  if (r !== 'ok') {
    await moverA(id, a.fid, 'fallido');
    saltar.add(a.fid);
    await anotar(id, conPunto(`La foto ${a.n} no se pudo registrar: ${r.definitivo}`), true);
    return;
  }
  const y3 = await moverA(id, a.fid, 'ligado', { borrarBlob: true });
  soltar(id, a.fid);
  // Si la quitaron mientras se insertaba, la cola limpia la fila y el objeto.
  if (y3?.estado === 'quitado') await marcarLimpiar(id, a.fid);
  // Una foto que había fallado ya entró: si no queda otra, se apaga el error.
  if (venia === 'fallido') {
    const fresco = await leer(id).catch(() => null);
    if (fresco && !fallidos(fresco)) await limpiarError(id);
  }
}

/**
 * El registro, cuando todo el trabajo quedó en un estado final. Antes se
 * espera a que otro trabajo de la misma cara (raro: uno quedó en memoria y
 * otro en el teléfono) termine sus archivos.
 */
/** Caras registrándose ahora en esta pestaña (ver registrarSiToca). */
const registrando = new Set<string>();

async function registrarSiToca(t: TrabajoToma): Promise<'nada' | 'registrada' | { error: string }> {
  if (!t.registrar || t.registrada) return 'nada';
  if (porMandar(t).length) return 'nada';
  const otros = (await listarTodos(t.email)).filter((x) => x.clave === t.clave && x.id !== t.id);
  if (otros.some((x) => porMandar(x).length)) return 'nada';
  // Una sola llamada a registrar_toma por cara a la vez: en la pestaña (Set)
  // y entre pestañas (candado por CARA, no por trabajo: dos trabajos de la
  // misma cara también chocan). registrar_toma lee la toma sin bloqueo y dos
  // llamadas juntas mandaban dos "Toma por revisar" a cada analista. Si está
  // ocupado, la siguiente corrida verá la toma ya registrada ('hecho').
  if (registrando.has(t.clave)) return 'nada';
  registrando.add(t.clave);
  try {
    return await conCandado<'nada' | 'registrada' | { error: string }>(
      t.clave,
      () => registrarAhora(t),
      'nada',
      'toma-registro-'
    );
  } finally {
    registrando.delete(t.clave);
  }
}

/**
 * ¿La sesión es real para el SERVIDOR? (getUser valida el token allá). Solo
 * se pregunta antes de decir "faltan fotos": con un token a medio renovar la
 * RLS contesta [] sin error y "faltan" sería falso.
 */
async function sesionValidaEnServidor(email: string): Promise<void> {
  let r: Awaited<ReturnType<typeof sb.auth.getUser>>;
  try {
    r = await Promise.race([
      sb.auth.getUser(),
      dormir(ESPERA_LECTURA_MS).then(() => {
        throw new SinRed('El servidor no respondió.');
      }),
    ]);
  } catch (err) {
    throw err instanceof SinRed ? err : new SinRed(mensajeDe(err));
  }
  const de = norm(r?.data?.user?.email);
  if (r?.error || !de || de !== norm(email)) throw new SinSesion();
}

/**
 * La base de "regresada": la fecha_rechazo del servidor en la primera
 * lectura después del pedido (un rechazo anterior es justo lo que esta toma
 * repone). Se lee con la sesión VALIDADA: una lectura anónima no trae la
 * fila y una reposición normal salía como «regresada». Y se fija al empezar
 * la corrida, no hasta que suben las fotos, para que un regreso entre el
 * pedido y la subida sí se note (verificación, 22-oct-2026). null = el
 * trabajo ya no está.
 */
async function fijarBase(t: TrabajoToma): Promise<{ t: TrabajoToma; toma: EstadoTomaServidor } | null> {
  await sesionValidaEnServidor(t.email);
  const toma = await leerToma(t);
  const base = toma.fecha_rechazo ?? null;
  const r = await actualizar(t.id, (x) => {
    if (x.rechazoBase !== undefined || !x.registrar || x.registrada) return null;
    x.rechazoBase = base;
    return x;
  });
  return r ? { t: r, toma } : null;
}

async function registrarAhora(t0: TrabajoToma): Promise<'nada' | 'registrada' | { error: string }> {
  let t = t0;
  let toma = await leerToma(t);
  if (t.rechazoBase === undefined) {
    const f = await fijarBase(t);
    if (!f) return 'nada';
    t = f.t;
    toma = f.toma;
  }
  let fotos = toma.fecha_toma ? 0 : await contarFotosServidor(t);
  let d = decidirRegistro(t, toma, fotos);
  // "Faltan fotos" o "el servidor ve menos de las que ya subí": antes de
  // creerlo, ¿la sesión es real para el servidor? (con un token a medio
  // renovar la RLS contesta [] sin error). Si lo es, se vuelve a contar (el
  // primer conteo pudo salir anónimo) y ese conteo es la verdad (p. ej. el
  // analista rechazó una foto entretanto): no se espera para siempre.
  if (d.tipo === 'sinSesion' || d.tipo === 'faltan') {
    await sesionValidaEnServidor(t.email);
    fotos = await contarFotosServidor(t);
    const faltan = faltanFotos(t.minimo, fotos, 0);
    d = faltan > 0 ? { tipo: 'faltan', n: faltan } : { tipo: 'registrar' };
  }
  const marcar = async () => {
    await actualizar(t.id, (x) => {
      x.registrada = true;
      x.conError = false;
      x.ultimoError = null;
      return x;
    });
    const n = t.archivos.filter((a) => a.tipo === 'foto' && a.estado === 'ligado').length;
    const total = Math.max(n, fotos);
    fotosDeRegistro.set(t.id, total);
    registradas.push({
      email: norm(t.email),
      anio: t.anio,
      catorcena: t.catorcena,
      vfid: t.vfid,
      fotos: total,
      en: Date.now(),
    });
  };
  switch (d.tipo) {
    case 'noPedido':
    case 'esperar':
      return 'nada';
    case 'hecho':
      await marcar();
      return 'registrada';
    case 'regresada':
      await actualizar(t.id, (x) => {
        x.registrar = false;
        return x;
      });
      // Con el motivo: la lista del teléfono pudo no traerlo aún (por eso
      // la ventana no lo mostraba) y no hay que hacerlo adivinar.
      return {
        error:
          `El analista regresó la toma${toma.rechazo_motivo ? `: “${toma.rechazo_motivo.trim()}”` : ''}. ` +
          'Revisa lo que pide y vuelve a registrarla.',
      };
    case 'perdidas':
      return {
        error:
          `${d.n === 1 ? 'Una foto no estaba' : `${d.n} fotos no estaban`} en el teléfono: ` +
          'abre la toma, quítala(s) y vuelve a tomarla(s).',
      };
    case 'faltan':
      return { error: `Faltan ${d.n} ${d.n === 1 ? 'foto' : 'fotos'} para registrar la toma: ábrela y complétala.` };
    case 'registrar': {
      await exigirSesion(undefined, t.email);
      // Justo antes del RPC: ¿llegó una foto mientras se decidía? Entonces
      // primero ella (si las vigentes ya estaban revisadas, registrar_toma
      // comprobaría la toma sin esa foto).
      const fresco = await leer(t.id);
      if (!fresco || porMandar(fresco).length || !fresco.registrar || fresco.registrada) return 'nada';
      const r = await conReintento(async () => {
        const x = await sb
          .rpc('registrar_toma', { p_catorcena: t.catorcena, p_vendor_face_id: t.vfid, p_anio: t.anio })
          .abortSignal(tope(ESPERA_ESCRITURA_MS));
        if (!x.error) return 'ok' as const;
        if (esFallaRedPg(x.error, x.status)) throw new SinRed(x.error.message);
        if (/sesi[oó]n no v[aá]lida/i.test(x.error.message || '')) throw new SinSesion();
        return { definitivo: x.error.message };
      });
      if (r !== 'ok') {
        reportarError('tomas.registrar', new Error(r.definitivo), undefined, t.vfid);
        return { error: conPunto('No se pudo registrar la toma: ' + r.definitivo) };
      }
      await marcar();
      return 'registrada';
    }
  }
}

/**
 * Manda un trabajo: limpia lo quitado que llegó al servidor, sube sus
 * archivos en orden (fotos primero), luego el registro si se pidió, y lo
 * cierra si ya no queda nada. Relee el trabajo en cada pasada: las fotos que
 * el modal agrega mientras tanto salen en esta misma corrida.
 */
async function ejecutar(id: string, forzar: boolean): Promise<ResultadoInterno> {
  let t = await leer(id);
  if (!t) return { tipo: 'yaHecha' };
  // "Nuevo" se mide contra lo último que SE AVISÓ, no contra el último error
  // anotado: si no, con cada foto nueva o con la señal yendo y viniendo, el
  // mismo error volvía al buzón (verificación, 22-oct-2026).
  const avisadoPrevio = t.avisado ?? null;
  const error = (tt: TrabajoToma, mensaje: string): ResultadoInterno => ({
    tipo: 'error',
    id,
    mensaje,
    nuevo: mensaje.slice(0, 300) !== avisadoPrevio,
    email: norm(tt.email),
    donde: `${tt.site_id}${tt.cara ? ` · cara ${tt.cara}` : ''}`,
  });
  /**
   * Archivos que no se intentan en ESTA corrida: los que el servidor rechazó
   * aquí y, salvo que se fuerce (vuelta del aviso, "Registrar toma"), los que
   * ya venían rechazados: una corrida por cada foto nueva los volvía a subir
   * completos cada vez.
   */
  const saltar = new Set<string>(forzar ? [] : t.archivos.filter((a) => a.estado === 'fallido').map((a) => a.fid));
  const pendientes = (x: TrabajoToma) => porMandar(x).filter((a) => !saltar.has(a.fid));
  try {
    await exigirSesion(undefined, t.email);
    const toma = { v: await leerToma(t) };
    if (t.registrar && !t.registrada && t.rechazoBase === undefined) {
      try {
        const f = await fijarBase(t);
        if (!f) return { tipo: 'yaHecha' };
        toma.v = f.toma;
      } catch (err) {
        // Sin sesión validada aún: las fotos sí pueden ir subiendo; la base
        // se fija antes del registro (registrarAhora).
        if (!(err instanceof SinRed)) throw err;
      }
    }
    for (let pasada = 0; pasada < MAX_PASADAS; pasada++) {
      t = await leer(id);
      if (!t) return { tipo: 'yaHecha' };
      const limpiar = porLimpiar(t)[0];
      if (limpiar) {
        await limpiarQuitado(t, limpiar);
        continue;
      }
      const siguiente = pendientes(t)[0];
      if (siguiente) {
        await mandarArchivo(t, siguiente, toma, saltar);
        continue;
      }
      const reg = await registrarSiToca(t);
      if (typeof reg === 'object') {
        await anotar(id, reg.error, true);
        return error(t, reg.error);
      }
      // Lo que se pinta en el aviso breve, ya con el registro de esta pasada.
      if (reg === 'registrada') {
        t = await leer(id);
        if (!t) return { tipo: 'yaHecha' };
      }
      // Cierre atómico: solo si, releído en la misma transacción, ya no queda nada.
      const antes = t;
      const r = await actualizar(id, (x) => (listoParaCerrar(x) ? 'borrar' : null));
      if (r === undefined) return { tipo: 'yaHecha' };
      if (r === null) {
        const ligadas = antes.archivos.filter((a) => a.tipo === 'foto' && a.estado === 'ligado').length;
        const fotos = antes.registrada ? Math.max(ligadas, fotosDeRegistro.get(id) ?? 0) : ligadas;
        fotosDeRegistro.delete(id);
        // Lo que el monitorista vio registrarse en pantalla no se repite.
        const enPantalla = confirmadosEnPantalla.delete(id);
        if ((antes.registrada || fotos > 0) && !enPantalla)
          logros.push({
            email: norm(antes.email),
            logro: {
              site_id: antes.site_id,
              cara: antes.cara,
              registrada: antes.registrada,
              fotos,
              llave: llaveCara(antes.anio, antes.catorcena, antes.vfid),
              en: Date.now(),
            },
          });
        // Lo que ya no estaba en el teléfono y no subió: se avisa una vez.
        const textoPerdidos = perdidosTexto(antes);
        emitir();
        if (textoPerdidos) return error(antes, textoPerdidos);
        return { tipo: 'hecha' };
      }
      // Llegó una foto nueva (o algo por limpiar) entre la lectura y el cierre: otra pasada.
      if (pendientes(r).length || porLimpiar(r).length) continue;
      // Se pidió el registro justo ahora: otra pasada para hacerlo.
      if (r.registrar && !r.registrada && !(antes.registrar && !antes.registrada)) continue;
      // Nada más por ahora (un archivo rechazado, o el registro espera a otro
      // trabajo de la cara). Lo que pide atención se avisa.
      if (r.conError && r.ultimoError) return error(r, r.ultimoError);
      return { tipo: 'sigue' };
    }
    return { tipo: 'sigue' };
  } catch (err) {
    if (err instanceof TomaComprobada) {
      const fresco = (await leer(id).catch(() => null)) ?? t;
      if (!fresco) return { tipo: 'yaHecha' };
      const mensaje = textoComprobada(fresco);
      await anotar(id, mensaje, true);
      return error(fresco, mensaje);
    }
    if (err instanceof SinRed) {
      await anotar(id, textoEnCola(err, 'sola'), false);
      // Una subida lenta (un video) no detiene a las demás tomas.
      return { tipo: 'enCola', cortar: !(err instanceof SubidaLenta) };
    }
    reportarError('tomas.ejecutar', err, undefined, id);
    await anotar(id, 'Falló por un error de la app; se reintenta sola.', false);
    return { tipo: 'enCola', cortar: false };
  }
}

/**
 * Una corrida por trabajo a la vez en la pestaña, con candado entre pestañas.
 * `forzar` = también reintenta lo que el servidor rechazó (ver ejecutar).
 */
function procesar(id: string, forzar = false): Promise<ResultadoInterno> {
  const previo = enCurso.get(id);
  if (previo) {
    otraVuelta.add(id);
    return Promise.resolve({ tipo: 'ocupado' });
  }
  const p = conCandado<ResultadoInterno>(id, () => ejecutar(id, forzar), { tipo: 'ocupado' }, 'toma-')
    .catch((err): ResultadoInterno => {
      reportarError('tomas.procesar', err);
      return { tipo: 'enCola', cortar: false };
    })
    .then(async (r) => {
      // Un error definitivo NUEVO se avisa una vez (venga de la vuelta del
      // aviso global o del primer intento al encolar), y se anota que ya se
      // avisó (si el trabajo ya se cerró, no hay dónde y no hace falta).
      if (r.tipo === 'error' && r.nuevo) {
        buzon.push({ email: r.email, texto: `Toma de ${r.donde}: ${conPunto(r.mensaje)}` });
        await actualizar(r.id, (x) => {
          x.avisado = r.mensaje.slice(0, 300);
          return x;
        }).catch(() => undefined);
        emitir();
      }
      return r;
    })
    .finally(() => {
      enCurso.delete(id);
      emitir();
      // Llegó otro "procesa" mientras corría (una foto nueva, el registro):
      // otra corrida, ya fuera del candado anterior.
      if (otraVuelta.delete(id)) void procesar(id, otraVueltaForzada.delete(id));
    });
  enCurso.set(id, p);
  emitir();
  return p;
}

// ------------------------------------------------------------
// API del aviso global
// ------------------------------------------------------------

/**
 * El usuario descarta un trabajo desde el aviso: lo que no subió se borra
 * del teléfono y lo que subió sin fila se limpia del servidor. Lo que ya
 * entró a la toma se queda. Si se está mandando, 'ocupado'.
 *
 * Lo que el monitorista QUITÓ después de subir y la cola aún no limpia (sin
 * señal) no se suelta: el trabajo se queda solo con esa limpieza, ya sin
 * pedir atención, y la cola la termina sola. Antes se borraba el trabajo y la
 * foto quitada se quedaba en la toma (verificación, 22-oct-2026).
 */
export async function descartarToma(id: string): Promise<'ok' | 'ocupado'> {
  if (enCurso.has(id)) return 'ocupado';
  /** Quedó solo la limpieza: la cola la intenta ya, fuera del candado de aquí. */
  let relanzar = false;
  const r = await conCandado<'ok' | 'ocupado'>(
    id,
    async () => {
      const t = await leer(id).catch(() => null);
      // Lo que ya está en Storage sin saberse si entró ('subido', 'ligando',
      // 'fallido' arriba) queda como limpieza 'objeto': la cola borra el
      // archivo solo si no tiene fila, con reintento. Antes se intentaba una
      // sola vez y, sin señal, quedaban archivos sueltos en Storage.
      const arriba = (a: ArchivoToma) =>
        a.estado === 'subido' || a.estado === 'ligando' || (a.estado === 'fallido' && !!a.arriba);
      const quedan = t ? new Set(t.archivos.filter((a) => arriba(a) || (a.estado === 'quitado' && a.limpiar)).map((a) => a.fid)) : new Set<string>();
      if (t && quedan.size) {
        const r = await actualizar(
          id,
          (x) => {
            x.archivos = x.archivos
              .filter((a) => quedan.has(a.fid))
              .map((a) => (arriba(a) ? { ...a, estado: 'quitado' as const, limpiar: 'objeto' as const } : a));
            x.registrar = false;
            x.conError = false;
            x.ultimoError = null;
            return x;
          },
          { borrarBlobs: [...t.archivos.map((a) => claveBlob(id, a.fid))] }
        ).catch(() => undefined);
        t.archivos.forEach((a) => soltar(id, a.fid));
        if (r) {
          relanzar = true;
          return 'ok' as const;
        }
      }
      descartados.add(id);
      t?.archivos.forEach((a) => soltar(id, a.fid));
      memoria.delete(id);
      const soloMem = soloMemoria.delete(id);
      // Una copia al teléfono ya en vuelo (ver espejar) va antes que este
      // borrado; las pendientes ven `descartados` y ya no escriben.
      const borrado = base
        .tx(['trabajos', 'blobs_tomas'], 'readwrite', (x) => {
          x.objectStore('trabajos').delete(id);
          t?.archivos.forEach((a) => x.objectStore('blobs_tomas').delete(claveBlob(id, a.fid)));
        })
        .catch(() => {
          /* sin IndexedDB no había nada guardado */
        });
      if (!soloMem) await borrado;
      emitir();
      return 'ok' as const;
    },
    'ocupado' as const,
    'toma-'
  );
  if (relanzar) void procesar(id, true);
  return r;
}

/** El aviso de lo que ya no estaba en el teléfono al cerrar ('' = nada). */
function perdidosTexto(t: TrabajoToma): string {
  const perdidos = t.archivos.filter((a) => a.estado === 'perdido');
  if (!perdidos.length) return '';
  const fotos = perdidos.filter((a) => a.tipo === 'foto').length;
  const videos = perdidos.length - fotos;
  if (perdidos.length === 1)
    return fotos
      ? 'Una foto ya no estaba en el teléfono y no se subió: vuelve a tomarla.'
      : 'Un video ya no estaba en el teléfono y no se subió: vuelve a grabarlo.';
  const que =
    fotos && videos
      ? `${fotos === 1 ? 'Una foto' : `${fotos} fotos`} y ${videos === 1 ? 'un video' : `${videos} videos`}`
      : fotos
        ? `${fotos} fotos`
        : `${videos} videos`;
  return `${que} ya no estaban en el teléfono y no se subieron: vuelve a ${videos && !fotos ? 'grabarlos' : fotos && !videos ? 'tomarlas' : 'tomarlos'}.`;
}

type ResumenVuelta = { terminadas: number; siguen: number; mensajes: string[]; registradas: number };

/** La vuelta en curso de cada correo (una por correo, como las otras colas). */
const vueltas = new Map<string, Promise<ResumenVuelta>>();

/**
 * Procesa los trabajos de este correo, del más viejo al más nuevo. Al
 * primer "sin red" los demás no se intentan (tardarían lo mismo en fallar);
 * una subida lenta no corta la vuelta. Un error definitivo se reintenta en
 * cada vuelta (por si era del servidor) y su aviso sale una sola vez.
 */
export function procesarTomasPendientes(email: string): Promise<ResumenVuelta> {
  const em = norm(email);
  const enCursoDe = vueltas.get(em);
  if (enCursoDe) return enCursoDe;
  const vuelta: Promise<ResumenVuelta> = (async () => {
    const res: ResumenVuelta = { terminadas: 0, siguen: 0, mensajes: [], registradas: 0 };
    const antes = registradas.length;
    const lista = await listarTodos(em);
    let cortar = false;
    for (const t of lista) {
      if (cortar || enCurso.has(t.id)) {
        res.siguen++;
        continue;
      }
      // La vuelta del aviso (cada 2 min, "Reintentar ahora") sí reintenta lo
      // que el servidor rechazó.
      const r = await procesar(t.id, true);
      if (r.tipo === 'hecha' || r.tipo === 'yaHecha') res.terminadas++;
      else {
        res.siguen++;
        if (r.tipo === 'enCola' && r.cortar) cortar = true;
      }
    }
    // Los errores nuevos ya los dejó procesar() en el buzón (una vez).
    res.mensajes.push(...tomarAvisosTomas(em));
    res.registradas = registradas.slice(antes).filter((r) => r.email === em).length;
    return res;
  })().finally(() => {
    if (vueltas.get(em) === vuelta) vueltas.delete(em);
  });
  vueltas.set(em, vuelta);
  return vuelta;
}

/** ¿Hay trabajos de este correo en la cola? (para salir de la app) */
export async function hayTomasPendientes(email: string): Promise<number> {
  try {
    return (await listarTodos(email)).length;
  } catch {
    return 0;
  }
}

/** Fotos de una cara que siguen en el teléfono (para el contador del modal). */
export function fotosEnCola(trabajos: TrabajoToma[]): number {
  return trabajos.reduce((s, t) => s + fotosPorSubir(t), 0);
}
