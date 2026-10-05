// ============================================================
// src/lib/visitas.ts
// La COLA DE VISITAS de Mis rutas: "Marcar visita" (foto obligatoria, GPS si
// se pudo, hora del teléfono y nota) se guarda en el teléfono y se manda sola
// al volver la señal (rutas, 5-oct-2026).
//
// POR QUÉ: el monitorista recorre su ruta con mala señal (muchos en iPhone).
// Si marcar la visita dependiera de la red, en la mitad de las paradas no se
// podría y lo hecho en campo se perdería. Mismo esquema probado de la cola de
// acciones (lib/acciones.ts) y la de reportes (lib/envios.ts):
//   · Cada visita se FIJA una vez al tocar Guardar: cliente_id (UUID, la llave
//     idempotente de ruta_visitas), hora de la visita (la del toque), GPS, y
//     la ruta de cada foto en Storage:
//       evidencias/rutas/<site_id>/<cliente_id>_<n>.<ext>
//     Se guarda en IndexedDB ANTES de mandar nada.
//   · Mandarla es repetible: las fotos suben con upsert apagado ("ya existe"
//     = ya quedó) y el INSERT lleva cliente_id: si un intento llegó y se
//     perdió la respuesta, el siguiente recibe 23505 = ya entró.
//   · Solo se reintenta por RED. Nada sale sin sesión REAL y del DUEÑO
//     (exigirSesion): al volver la señal hay ~60 s en que todo sale como
//     anónimo y la RLS contesta en silencio.
//   · Un error definitivo (sin permiso, ruta borrada) se queda a la vista en
//     el aviso global hasta que se descarte.
//
// Base propia 'gpo-visitas' con apertura tolerante (sin número de versión;
// si falta un almacén se reabre con versión+1). NUNCA va en 'gpo-capturas':
// esa base no sube de versión (ver la cabecera de lib/idb.ts). Almacenes:
//   visitas          → un registro por visita en cola (llave `id` = cliente_id).
//   archivos_visitas → sus fotos, llave 'v:<id>:<n>' (en la MISMA base: el
//                      registro y sus fotos se escriben y borran juntos).
//
// Contrato con la vista: marcarVisita, visitasPendientes, suscribirVisitas.
// Con el aviso global (components/EnviosPendientes): listarVisitasAviso,
// procesarVisitasPendientes, descartarVisita y tomarAvisosVisitas, con los
// mismos disparadores que las otras dos colas.
// ============================================================
import { sb } from './supabase';
import { BUCKET_EVIDENCIAS, subirMiniatura } from './storage';
import { reportarError } from './reportarError';
import { retenerRecargaAutomatica } from './cargaDiferida';
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
  conCandado,
  conReintento,
  esFallaRedPg,
  exigirSesion,
  mensajeDe,
  nuevoIdEnvio,
  registrarRiesgoExtra,
  subir,
  textoEnCola,
  tope,
} from './envios';
import { anotarVisitaEnCopiaLocal } from './datosLocales';

// ------------------------------------------------------------
// Tipos (contrato con la vista y el aviso)
// ------------------------------------------------------------

export type VisitaNueva = {
  ruta_id: number | null;
  site_id: string;
  /** Texto para el aviso, p. ej. "Ruta 3 · parada 5 · MX_CM_EV_3299". */
  resumen: string;
  /** ISO fijado al tocar "Marcar visita" (hora del teléfono). */
  visitado_en: string;
  lat: number | null;
  lng: number | null;
  precision_m: number | null;
  nota: string | null;
  /** Fotos ya preparadas (comprimidas por SubirArchivos). Al menos una. */
  fotos: File[];
};

/** Lo que la vista superpone en la lista: la parada con ⏳ o con error. */
export type VisitaPendiente = {
  id: string;
  ruta_id: number | null;
  site_id: string;
  visitado_en: string;
  resumen: string;
  ultimoError: string | null;
  /** El último intento dio un error que no es de red: no saldrá sola. */
  conError: boolean;
  enviando: boolean;
};

/** Lo que el aviso global pinta de cada visita. */
export type ResumenVisita = VisitaPendiente & {
  creado_en: string;
  /** No quedó en el teléfono: cerrar la app la pierde. */
  soloMemoria: boolean;
  /** Fotos que no cupieron en el teléfono. */
  fueraDelTelefono: number;
  fotos: number;
  subidas: number;
};

export type ResultadoMarcar =
  | { tipo: 'guardada'; enTelefono: boolean }
  | { tipo: 'error'; mensaje: string };

// ------------------------------------------------------------
// Registro guardado
// ------------------------------------------------------------

type ArchivoVisita = {
  /** 'v:<id>:<n>' */
  clave: string;
  /** Ruta FIJA en Storage: rutas/<site_id>/<id>_<n>.<ext> */
  path: string;
  n: number;
  nombre: string;
  bytes: number;
};

type Visita = {
  v: 1;
  /** = cliente_id en ruta_visitas. */
  id: string;
  /** Solo la sesión de este correo la procesa y la ve. */
  email: string;
  creado_en: string;
  actualizado_en: string;
  ruta_id: number | null;
  site_id: string;
  resumen: string;
  visitado_en: string;
  lat: number | null;
  lng: number | null;
  precision_m: number | null;
  nota: string | null;
  archivos: ArchivoVisita[];
  estado: {
    /** Rutas ya subidas a Storage. */
    subidos: string[];
    /** Rutas abandonadas (no estaban en el teléfono o error definitivo). */
    fallidos: string[];
    /** Lecturas del teléfono que fallaron seguidas, por clave. */
    lecturasFallidas?: Record<string, number>;
  };
  intentos: number;
  ultimoError: string | null;
  conError: boolean;
  /** Claves de fotos que NO cupieron en el teléfono (solo en memoria). */
  fueraDelTelefono: string[];
};

type ResultadoInterno =
  | { tipo: 'hecha'; aviso?: string }
  | { tipo: 'enCola' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'ocupado' }
  | { tipo: 'yaHecha' };

// ------------------------------------------------------------
// Tiempos
// ------------------------------------------------------------

/** Tope de una escritura de estado en IndexedDB (metadatos). */
const ESPERA_ESTADO_MS = 5000;
/** Tope del INSERT en ruta_visitas: abortado = incierto, el reintento lo resuelve. */
const ESPERA_INSERT_MS = 20000;
/** Lecturas fallidas seguidas de una foto antes de abandonarla (como envios.ts). */
const MAX_LECTURAS_FALLIDAS = 3;

// ------------------------------------------------------------
// IndexedDB propia: 'gpo-visitas' (apertura tolerante, como lib/idbDatos.ts)
// ------------------------------------------------------------

type AlmacenVisitas = 'visitas' | 'archivos_visitas';
const NOMBRE_BD = 'gpo-visitas';
const LLAVES: Record<AlmacenVisitas, string> = { visitas: 'id', archivos_visitas: 'clave' };
const ALMACENES = Object.keys(LLAVES) as AlmacenVisitas[];
const ESPERA_APERTURA_MS = 3000;
const ESPERA_TX_MS = 15000;
const MAX_REAPERTURAS = 3;
const REARME_COLGADA_MS = 30000;

let conexion: Promise<IDBDatabase | null> | null = null;
let aperturaColgada = false;
let colgadaDesde = 0;

// Al volver a primer plano se rearma una apertura colgada (iOS que congeló la
// PWA): mismo motivo que en lib/idb.ts.
try {
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') colgadaDesde = 0;
    });
} catch {
  /* sin documento (pruebas) */
}

function faltantes(db: IDBDatabase): AlmacenVisitas[] {
  return ALMACENES.filter((a) => !db.objectStoreNames.contains(a));
}

/**
 * Abre la base una vez por pestaña. null = no hay IndexedDB, falló o no
 * contestó a tiempo (entonces la visita vive en memoria y el aviso lo dice).
 * Sin número de versión: nunca hay VersionError entre builds.
 */
function abrir(): Promise<IDBDatabase | null> {
  if (conexion) return conexion;
  if (aperturaColgada) {
    const edad = Date.now() - colgadaDesde;
    if (edad >= 0 && edad < REARME_COLGADA_MS) return Promise.resolve(null);
    aperturaColgada = false;
  }
  const p = new Promise<IDBDatabase | null>((res) => {
    let listo = false;
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const fin = (db: IDBDatabase | null) => {
      if (listo) {
        // Llegó tarde: si abrió y no hay otra, se adopta; si no, se cierra.
        aperturaColgada = false;
        if (db && !conexion) {
          conexion = Promise.resolve(db);
          return;
        }
        try {
          db?.close();
        } catch {
          /* nada */
        }
        return;
      }
      listo = true;
      if (reloj !== undefined) clearTimeout(reloj);
      res(db);
    };
    const intentar = (version: number | undefined, vuelta: number): void => {
      let req: IDBOpenDBRequest;
      try {
        req = version === undefined ? indexedDB.open(NOMBRE_BD) : indexedDB.open(NOMBRE_BD, version);
      } catch {
        return fin(null);
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        faltantes(db).forEach((a) => db.createObjectStore(a, { keyPath: LLAVES[a] }));
      };
      req.onsuccess = () => {
        const db = req.result;
        if (faltantes(db).length && vuelta < MAX_REAPERTURAS) {
          const v = db.version;
          try {
            db.close();
          } catch {
            /* nada */
          }
          return intentar(v + 1, vuelta + 1);
        }
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            /* nada */
          }
          conexion = null;
        };
        db.onclose = () => {
          conexion = null;
        };
        fin(db);
      };
      req.onerror = (ev) => {
        if (req.error?.name === 'VersionError' && vuelta < MAX_REAPERTURAS) {
          ev.preventDefault?.();
          return intentar(undefined, vuelta + 1);
        }
        fin(null);
      };
    };
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return fin(null);
      reloj = setTimeout(() => {
        aperturaColgada = true;
        colgadaDesde = Date.now();
        fin(null);
      }, ESPERA_APERTURA_MS);
      intentar(undefined, 0);
    } catch {
      fin(null);
    }
  });
  conexion = p;
  p.then((db) => {
    if (!db && conexion === p) conexion = null;
  });
  return p;
}

/** Una transacción con tope; resuelve al completar (oncomplete), no antes. */
async function tx<T>(
  almacenes: AlmacenVisitas[],
  modo: IDBTransactionMode,
  trabajo: (t: IDBTransaction) => T,
  topeMs = ESPERA_TX_MS
): Promise<T> {
  const deConexion = abrir();
  const db = await deConexion;
  if (!db) throw new ErrorIdb('IndexedDB no disponible', 'no-disponible');
  const olvidar = () => {
    if (conexion === deConexion) conexion = null;
  };
  return new Promise<T>((res, rej) => {
    let listo = false;
    let t: IDBTransaction;
    let salida: T;
    const reloj = setTimeout(() => {
      if (listo) return;
      listo = true;
      try {
        t.abort();
      } catch {
        /* ya terminó */
      }
      olvidar();
      try {
        db.close();
      } catch {
        /* nada */
      }
      rej(new ErrorIdb('IndexedDB no respondió a tiempo', 'tope'));
    }, topeMs);
    try {
      t = db.transaction(almacenes, modo);
      t.oncomplete = () => {
        if (listo) return;
        listo = true;
        clearTimeout(reloj);
        res(salida);
      };
      const falla = () => {
        if (listo) return;
        listo = true;
        clearTimeout(reloj);
        const e = t.error;
        const cuota = /quota/i.test(e?.name || '') || /quota/i.test(e?.message || '');
        rej(new ErrorIdb(e?.message || 'transacción abortada', cuota ? 'cuota' : 'otro'));
      };
      t.onerror = falla;
      t.onabort = falla;
      salida = trabajo(t);
    } catch (e) {
      olvidar();
      if (listo) return;
      listo = true;
      clearTimeout(reloj);
      rej(new ErrorIdb(mensajeDe(e), 'otro'));
    }
  });
}

async function idbTodas(): Promise<Visita[]> {
  const caja: { v: Visita[] } = { v: [] };
  await tx(['visitas'], 'readonly', (t) => {
    const r = t.objectStore('visitas').getAll();
    r.onsuccess = () => {
      caja.v = (r.result as Visita[]) || [];
    };
  });
  return caja.v;
}

async function idbUna(id: string): Promise<Visita | undefined> {
  const caja: { v?: Visita } = {};
  await tx(['visitas'], 'readonly', (t) => {
    const r = t.objectStore('visitas').get(id);
    r.onsuccess = () => {
      caja.v = r.result as Visita | undefined;
    };
  });
  return caja.v;
}

/** null = la foto de verdad no está; si IndexedDB falla, lanza. */
async function idbFoto(clave: string): Promise<File | null> {
  const caja: { r?: RegistroArchivo } = {};
  await tx(['archivos_visitas'], 'readonly', (t) => {
    const r = t.objectStore('archivos_visitas').get(clave);
    r.onsuccess = () => {
      caja.r = r.result as RegistroArchivo | undefined;
    };
  });
  return caja.r ? archivoDeRegistro(caja.r) : null;
}

function rangoPrefijo(prefijo: string): IDBKeyRange {
  return IDBKeyRange.bound(prefijo, prefijo + '￿');
}

// ------------------------------------------------------------
// Estado de la pestaña
// ------------------------------------------------------------

/** Visitas en proceso ahora y las que NO se pudieron guardar en el teléfono. */
const memoria = new Map<string, Visita>();
/** Los File originales por clave: preferibles a leerlos de IndexedDB. */
const archivosMem = new Map<string, File>();
const soloMemoria = new Set<string>();
const conArchivosFuera = new Set<string>();
const enCurso = new Map<string, Promise<ResultadoInterno>>();
/** Primer intento recién guardado: la parada ya enseña ⏳, el aviso global no la pinta aún. */
const ocultas = new Set<string>();
/** Descartadas: ninguna escritura tardía debe resucitarlas. */
const descartadas = new Set<string>();
/** Avisos de visitas que se mandaron por su cuenta; los recoge el aviso global. */
const buzon: { email: string; texto: string }[] = [];
/**
 * Visitas que YA entraron en esta pestaña: la vista las cuenta como hechas
 * aunque su última lectura de la red sea de antes (o no haya red para
 * releer). Sin esto la parada pasaba de ⏳ a "pendiente" hasta recargar.
 */
const enviadas: { email: string; site_id: string; ruta_id: number | null; visitado_en: string }[] = [];

/** Las visitas de este correo que ya entraron en esta pestaña. */
export function visitasEnviadasEnSesion(
  email: string
): { site_id: string; ruta_id: number | null; visitado_en: string }[] {
  const em = (email || '').trim().toLowerCase();
  return enviadas
    .filter((x) => x.email === em)
    .map(({ site_id, ruta_id, visitado_en }) => ({ site_id, ruta_id, visitado_en }));
}

const bus: EventTarget | null = typeof EventTarget !== 'undefined' ? new EventTarget() : null;
let canal: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    canal = new BroadcastChannel('gpo-visitas');
    canal.onmessage = () => emitir(true);
  }
} catch {
  canal = null;
}

/** Lo que se perdería al recargar: solo en memoria, fotos fuera o en curso. */
function visitasEnRiesgo(): boolean {
  return soloMemoria.size > 0 || conArchivosFuera.size > 0 || enCurso.size > 0;
}

// "Actualizar ahora" / "Recargar la app" también preguntan por estas.
registrarRiesgoExtra(visitasEnRiesgo, 'una visita');

/** Retención propia de la recarga automática por chunk viejo (lib/cargaDiferida). */
let soltarRetencion: (() => void) | null = null;
function sincronizarRetencion(): void {
  const riesgo = visitasEnRiesgo();
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

/** Se llama cada vez que la cola de visitas cambia (aquí o en otra pestaña). */
export function suscribirVisitas(cb: () => void): () => void {
  if (!bus) return () => {};
  const h = () => cb();
  bus.addEventListener('cambio', h);
  return () => bus.removeEventListener('cambio', h);
}

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();

/** Los avisos que quedaron en el buzón para este correo (se entregan una vez). */
export function tomarAvisosVisitas(email?: string): string[] {
  const em = norm(email);
  const mios: string[] = [];
  for (let i = 0; i < buzon.length; ) {
    if (!em || buzon[i].email === em) mios.push(buzon.splice(i, 1)[0].texto);
    else i++;
  }
  return mios;
}

const conPunto = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : s.trim() + '.');

// ------------------------------------------------------------
// Armar y guardar
// ------------------------------------------------------------

/** La ruta de Storage de una foto: rutas/<site_id>/<cliente_id>_<n>.<ext> */
function rutaFoto(siteId: string, id: string, n: number, f: File): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(f.name || '');
  const ext = (m ? m[1] : (f.type || '').split('/')[1] || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const sitio = (siteId || 'sitio').replace(/[^\w.\-]/g, '_');
  return `rutas/${sitio}/${id}_${n}.${ext}`;
}

function armar(email: string, vn: VisitaNueva, archivos: Map<string, File>): Visita {
  const id = nuevoIdEnvio();
  const ahora = new Date().toISOString();
  const lista: ArchivoVisita[] = vn.fotos.map((f, i) => {
    const n = i + 1;
    const clave = `v:${id}:${n}`;
    archivos.set(clave, f);
    return { clave, path: rutaFoto(vn.site_id, id, n, f), n, nombre: f.name || `foto ${n}`, bytes: f.size };
  });
  return {
    v: 1,
    id,
    email,
    creado_en: ahora,
    actualizado_en: ahora,
    ruta_id: vn.ruta_id,
    site_id: vn.site_id,
    resumen: vn.resumen || `Visita a ${vn.site_id}`,
    visitado_en: vn.visitado_en || ahora,
    lat: Number.isFinite(vn.lat as number) ? vn.lat : null,
    lng: Number.isFinite(vn.lng as number) ? vn.lng : null,
    precision_m: Number.isFinite(vn.precision_m as number) ? vn.precision_m : null,
    nota: (vn.nota || '').trim() || null,
    archivos: lista,
    estado: { subidos: [], fallidos: [] },
    intentos: 0,
    ultimoError: null,
    conError: false,
    fueraDelTelefono: [],
  };
}

/** Guarda el avance; si IndexedDB falla se sigue con lo de memoria. */
async function persistir(v: Visita): Promise<void> {
  v.actualizado_en = new Date().toISOString();
  if (descartadas.has(v.id)) return;
  if (!soloMemoria.has(v.id)) {
    try {
      await tx(['visitas'], 'readwrite', (t) => {
        t.objectStore('visitas').put(v);
      }, ESPERA_ESTADO_MS);
    } catch {
      /* se sigue en memoria */
    }
  }
  emitir();
}

async function anotar(v: Visita, error: string, conError: boolean): Promise<void> {
  v.ultimoError = error.slice(0, 300);
  v.conError = conError;
  await persistir(v);
}

/**
 * Guarda una visita recién armada ANTES de mandar nada: registro y fotos en
 * UNA transacción. Si no cabe, como la cola de acciones: fotos en bytes →
 * solo el registro → solo memoria. Lo que no cupo queda anotado.
 */
async function guardarNueva(v: Visita, archivos: Map<string, File>): Promise<boolean> {
  archivos.forEach((f, k) => archivosMem.set(k, f));
  memoria.set(v.id, v);

  const intentar = async (registros: RegistroArchivo[]): Promise<boolean> => {
    const guardados = new Set(registros.map((r) => r.clave));
    v.fueraDelTelefono = v.archivos.filter((x) => !guardados.has(x.clave)).map((x) => x.clave);
    const bytes = registros.reduce((s, r) => s + r.bytes, 0);
    try {
      await tx(
        ['visitas', 'archivos_visitas'],
        'readwrite',
        (t) => {
          const alm = t.objectStore('archivos_visitas');
          registros.forEach((r) => alm.put(r));
          t.objectStore('visitas').put(v);
        },
        topeEscrituraArchivo(bytes)
      );
      return true;
    } catch (err) {
      // Base ausente o colgada: otro intento solo retrasaría el botón.
      if (err instanceof ErrorIdb && (err.motivo === 'no-disponible' || err.motivo === 'tope')) throw err;
      return false;
    }
  };
  const comoBlob = () =>
    v.archivos
      .map((x) => {
        const f = archivos.get(x.clave);
        return f ? registroDeArchivo(x.clave, f) : null;
      })
      .filter(Boolean) as RegistroArchivo[];

  let enTelefono = false;
  try {
    if (await intentar(comoBlob())) enTelefono = true;
    else {
      const enBytes = (
        await Promise.all(
          v.archivos.map((x) => {
            const f = archivos.get(x.clave);
            return f ? registroEnBytes(x.clave, f) : Promise.resolve(null);
          })
        )
      ).filter(Boolean) as RegistroArchivo[];
      if (enBytes.length && (await intentar(enBytes))) enTelefono = true;
      else if (await intentar([])) enTelefono = true;
    }
  } catch {
    /* IndexedDB no disponible: cae a memoria */
  }

  if (!enTelefono) {
    soloMemoria.add(v.id);
    v.fueraDelTelefono = v.archivos.map((x) => x.clave);
    reportarError('visitas.idb', new Error('visita solo en memoria'), { fotos: v.archivos.length });
  } else {
    soloMemoria.delete(v.id);
    if (v.fueraDelTelefono.length) conArchivosFuera.add(v.id);
  }
  emitir();
  return enTelefono;
}

/** Todas las visitas de este correo (teléfono + memoria), de la más vieja a la más nueva. */
async function listarTodas(email: string): Promise<Visita[]> {
  const porId = new Map<string, Visita>();
  try {
    (await idbTodas()).forEach((v) => porId.set(v.id, v));
  } catch {
    /* sin IndexedDB: solo lo de memoria */
  }
  memoria.forEach((v, id) => porId.set(id, v));
  const em = norm(email);
  return [...porId.values()]
    .filter((v) => v && v.v === 1 && norm(v.email) === em && !descartadas.has(v.id))
    .sort((x, y) => x.creado_en.localeCompare(y.creado_en));
}

function aPendiente(v: Visita): VisitaPendiente {
  return {
    id: v.id,
    ruta_id: v.ruta_id,
    site_id: v.site_id,
    visitado_en: v.visitado_en,
    resumen: v.resumen,
    ultimoError: v.ultimoError,
    conError: !!v.conError,
    enviando: enCurso.has(v.id),
  };
}

/** Las visitas de este correo que aún no entran a la base (para el ⏳ de cada parada). */
export async function visitasPendientes(email: string): Promise<VisitaPendiente[]> {
  return (await listarTodas(email)).map(aPendiente);
}

/** Lo que pinta el aviso global (sin la que se acaba de guardar y aún va en su primer intento). */
export async function listarVisitasAviso(email: string): Promise<ResumenVisita[]> {
  return (await listarTodas(email))
    .filter((v) => !ocultas.has(v.id))
    .map((v) => ({
      ...aPendiente(v),
      creado_en: v.creado_en,
      soloMemoria: soloMemoria.has(v.id),
      fueraDelTelefono: v.fueraDelTelefono?.length || 0,
      fotos: v.archivos.length,
      subidas: v.estado.subidos.length,
    }));
}

/** Saca una visita de la cola con sus fotos (entró, o se descartó). */
async function quitar(id: string): Promise<void> {
  const soloMem = soloMemoria.has(id);
  memoria.delete(id);
  soloMemoria.delete(id);
  conArchivosFuera.delete(id);
  ocultas.delete(id);
  const prefijo = `v:${id}:`;
  [...archivosMem.keys()].forEach((k) => {
    if (k.startsWith(prefijo)) archivosMem.delete(k);
  });
  const borrado = tx(['visitas', 'archivos_visitas'], 'readwrite', (t) => {
    t.objectStore('visitas').delete(id);
    t.objectStore('archivos_visitas').delete(rangoPrefijo(prefijo));
  }).catch(() => {
    /* sin IndexedDB no había nada guardado */
  });
  if (!soloMem) await borrado;
  emitir();
}

/**
 * El usuario descarta una visita desde el aviso: NO se registrará. Si se
 * está mandando (aquí o en otra pestaña) no se toca: 'ocupado'.
 */
export async function descartarVisita(id: string): Promise<'ok' | 'ocupado'> {
  if (enCurso.has(id)) return 'ocupado';
  return conCandado<'ok' | 'ocupado'>(
    id,
    async () => {
      descartadas.add(id);
      await quitar(id);
      return 'ok' as const;
    },
    'ocupado' as const,
    'visita-'
  );
}

/** La versión más fresca, ya DENTRO del candado (otra pestaña pudo terminarla). */
async function versionFresca(v0: Visita): Promise<Visita | null> {
  if (descartadas.has(v0.id)) return null;
  const mem = memoria.get(v0.id);
  if (mem) return mem;
  if (soloMemoria.has(v0.id)) return v0;
  try {
    return (await idbUna(v0.id)) ?? null;
  } catch {
    return v0;
  }
}

// ------------------------------------------------------------
// Pasos
// ------------------------------------------------------------

/**
 * La foto de la cola: la original en memoria o la del teléfono. null = de
 * verdad no está (no cupo, se borró). Si IndexedDB FALLA se lanza SinLectura
 * (sigue en cola) hasta MAX_LECTURAS_FALLIDAS seguidas; misma regla que
 * leerDelTelefono en lib/envios.ts.
 */
async function fotoDe(v: Visita, x: ArchivoVisita): Promise<File | null> {
  const mem = archivosMem.get(x.clave);
  if (mem) return mem;
  if (v.fueraDelTelefono?.includes(x.clave)) return null;
  try {
    const f = await idbFoto(x.clave);
    if (v.estado.lecturasFallidas?.[x.clave]) delete v.estado.lecturasFallidas[x.clave];
    return f;
  } catch (err) {
    const n = (v.estado.lecturasFallidas?.[x.clave] || 0) + 1;
    if (n >= MAX_LECTURAS_FALLIDAS) {
      reportarError('visitas.lecturaLocal', err, { clave: x.clave, intentos: n });
      return null;
    }
    v.estado.lecturasFallidas = { ...(v.estado.lecturasFallidas || {}), [x.clave]: n };
    await persistir(v);
    throw new SinLectura('No se pudo leer una foto guardada en el teléfono: ' + mensajeDe(err));
  }
}

/** Las palabras de campo para los errores definitivos del INSERT. */
function mensajeInsert(e: { message: string; code?: string }): string {
  if (e.code === '42501')
    return 'ya no tienes esta ruta asignada (o tu rol no permite marcar visitas). Pide al coordinador que te la asigne';
  if (e.code === '23503') return 'la ruta ya no existe (la quitaron mientras tanto)';
  return e.message;
}

/**
 * El INSERT idempotente: cliente_id es único, así que 23505 = un intento
 * anterior ya entró. La RLS se cumple con usuario_email = el del dueño (la
 * sesión ya se revisó con exigirSesion). Sin .select(): la fila de vuelta no
 * hace falta y así no depende de la política de lectura.
 */
async function insertar(v: Visita): Promise<'ok' | { definitivo: string }> {
  const fotos = v.estado.subidos.map((path) => ({
    path,
    url: sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data.publicUrl,
  }));
  const r = await sb
    .from('ruta_visitas')
    .insert({
      cliente_id: v.id,
      ruta_id: v.ruta_id,
      site_id: v.site_id,
      usuario_email: v.email,
      visitado_en: v.visitado_en,
      lat: v.lat,
      lng: v.lng,
      precision_m: v.precision_m,
      fotos,
      nota: v.nota,
    })
    .abortSignal(tope(ESPERA_INSERT_MS));
  if (!r.error) return 'ok';
  if (r.error.code === '23505') return 'ok';
  if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
  // Un "sin permiso" con la sesión perdida a medio camino salió como anónimo:
  // si ya no hay sesión del dueño, exigirSesion lanza y sigue en cola.
  if (r.error.code === '42501') await exigirSesion(ESPERA_SESION_INTERACTIVA_MS, v.email);
  reportarError('visitas.insert', r.error, { code: r.error.code }, v.id);
  return { definitivo: mensajeInsert(r.error) };
}

/**
 * Manda una visita: (1) sube cada foto a su ruta fija, (2) el INSERT con las
 * rutas subidas. Cada avance se persiste. La foto es obligatoria: si no subió
 * NINGUNA, no se registra la visita (se queda con su error para descartarla).
 */
async function ejecutar(v0: Visita): Promise<ResultadoInterno> {
  const v = await versionFresca(v0);
  if (!v) return { tipo: 'yaHecha' };
  memoria.set(v.id, v);
  v.intentos++;
  const avisos: string[] = [];
  try {
    await exigirSesion(undefined, v.email);
    for (const x of v.archivos) {
      if (v.estado.subidos.includes(x.path) || v.estado.fallidos.includes(x.path)) continue;
      const f = await fotoDe(v, x);
      if (!f) {
        reportarError('visitas.fotoPerdida', new Error('foto no encontrada'), { path: x.path, bytes: x.bytes }, x.path);
        avisos.push(`«${x.nombre}» ya no estaba en el teléfono (no cupo o se borró).`);
        v.estado.fallidos.push(x.path);
        await persistir(v);
        continue;
      }
      // Cada paso largo, con la sesión del dueño.
      await exigirSesion(undefined, v.email);
      const res = await conReintento(() => subir(x, f, v.email));
      if (res !== 'ok') {
        reportarError('visitas.subida', res.definitivo, { path: x.path, bytes: f.size }, x.path);
        avisos.push(conPunto(`No se pudo subir «${x.nombre}»: ${mensajeDe(res.definitivo)}`));
        v.estado.fallidos.push(x.path);
        await persistir(v);
        continue;
      }
      v.estado.subidos.push(x.path);
      await persistir(v);
      // Miniatura de mejor esfuerzo (tope propio de 8 s).
      await subirMiniatura(x.path, f);
    }
    if (!v.estado.subidos.length) {
      const mensaje =
        'No se pudo subir ninguna foto de la visita. ' +
        (avisos.length ? avisos.join(' ') + ' ' : '') +
        'Descártala y vuelve a marcar la visita.';
      await anotar(v, mensaje, true);
      return { tipo: 'error', mensaje };
    }
    await exigirSesion(undefined, v.email);
    const r = await conReintento(() => insertar(v));
    if (r !== 'ok') {
      const mensaje = conPunto(r.definitivo.charAt(0).toUpperCase() + r.definitivo.slice(1));
      await anotar(v, mensaje, true);
      return { tipo: 'error', mensaje };
    }
    enviadas.push({ email: norm(v.email), site_id: v.site_id, ruta_id: v.ruta_id, visitado_en: v.visitado_en });
    await quitar(v.id);
    // Que la parada siga viéndose visitada aunque la señal se vaya otra vez.
    void anotarVisitaEnCopiaLocal(v.email, { site_id: v.site_id, ruta_id: v.ruta_id, visitado_en: v.visitado_en });
    return avisos.length ? { tipo: 'hecha', aviso: avisos.join(' ') } : { tipo: 'hecha' };
  } catch (err) {
    if (err instanceof SinRed) {
      await anotar(v, textoEnCola(err, 'sola'), false);
      return { tipo: 'enCola' };
    }
    reportarError('visitas.ejecutar', err, undefined, v.id);
    await anotar(v, 'Falló por un error de la app; se reintenta sola.', false);
    return { tipo: 'enCola' };
  } finally {
    if (!soloMemoria.has(v.id)) memoria.delete(v.id);
  }
}

/** Un procesamiento por visita a la vez en la pestaña, con candado entre pestañas. */
function procesar(v: Visita): Promise<ResultadoInterno> {
  const previo = enCurso.get(v.id);
  if (previo) return Promise.resolve({ tipo: 'ocupado' });
  const p = conCandado<ResultadoInterno>(v.id, () => ejecutar(v), { tipo: 'ocupado' }, 'visita-')
    .catch((err): ResultadoInterno => {
      reportarError('visitas.procesar', err);
      return { tipo: 'enCola' };
    })
    .finally(() => {
      enCurso.delete(v.id);
      ocultas.delete(v.id);
      emitir();
    });
  enCurso.set(v.id, p);
  emitir();
  return p;
}

/** Texto del aviso para un resultado que llegó desde la cola. */
function avisoDiferido(v: Visita, r: ResultadoInterno): string | null {
  switch (r.tipo) {
    case 'hecha':
      return r.aviso ? `Visita a ${v.site_id}: ${r.aviso}` : null;
    case 'error':
      return `La visita a ${v.site_id} no se pudo registrar: ${conPunto(r.mensaje)} Si ya no hace falta, descártala en «Ver detalle».`;
    default:
      return null;
  }
}

// ------------------------------------------------------------
// API
// ------------------------------------------------------------

/**
 * "Guardar visita": la guarda en el teléfono y la manda en segundo plano
 * (el modal se cierra de inmediato; la parada enseña ⏳ hasta que entra).
 * Así el monitorista sigue su ruta sin esperar a la señal. Devuelve
 * 'guardada' (enTelefono = false: solo en memoria, no hay que cerrar la app)
 * o 'error' si no se pudo ni armar.
 */
export async function marcarVisita(email: string, vn: VisitaNueva): Promise<ResultadoMarcar> {
  const em = norm(email);
  if (!em) return { tipo: 'error', mensaje: 'Sin sesión: vuelve a entrar a la app.' };
  if (!vn.site_id) return { tipo: 'error', mensaje: 'Falta el sitio de la visita.' };
  if (!vn.fotos?.length) return { tipo: 'error', mensaje: 'La foto es obligatoria: toma al menos una.' };
  const archivos = new Map<string, File>();
  const v = armar(em, vn, archivos);
  ocultas.add(v.id);
  const enTelefono = await guardarNueva(v, archivos);
  // Primer intento en segundo plano: si no termina, sale con los demás
  // disparadores del aviso global (red, sesión, primer plano, cada 2 min).
  void procesar(v).then((r) => {
    const aviso = avisoDiferido(v, r);
    if (aviso) {
      buzon.push({ email: em, texto: aviso });
      emitir();
    }
  });
  return { tipo: 'guardada', enTelefono };
}

type ResumenVuelta = { terminadas: number; siguen: number; mensajes: string[] };

/** La vuelta en curso de cada correo (una por correo, como las otras colas). */
const vueltas = new Map<string, Promise<ResumenVuelta>>();

/**
 * Procesa la cola de visitas de este correo, de la más vieja a la más nueva.
 * Al primer "sin red" las demás no se intentan (tardarían lo mismo en
 * fallar). Una con error definitivo se reintenta en cada vuelta (por si era
 * del servidor) y su aviso sale una sola vez.
 */
export function procesarVisitasPendientes(email: string): Promise<ResumenVuelta> {
  const em = norm(email);
  const enCursoDe = vueltas.get(em);
  if (enCursoDe) return enCursoDe;
  const vuelta: Promise<ResumenVuelta> = (async () => {
    const res: ResumenVuelta = { terminadas: 0, siguen: 0, mensajes: [] };
    const lista = await listarTodas(em);
    let cortar = false;
    for (const v of lista) {
      if (cortar || enCurso.has(v.id)) {
        res.siguen++;
        continue;
      }
      const errorPrevio = v.ultimoError;
      const r = await procesar(v);
      if (r.tipo === 'hecha' || r.tipo === 'yaHecha') res.terminadas++;
      else {
        res.siguen++;
        if (r.tipo === 'enCola') cortar = true;
      }
      if (r.tipo === 'error' && errorPrevio === r.mensaje.slice(0, 300)) continue;
      const aviso = avisoDiferido(v, r);
      if (aviso) res.mensajes.push(aviso);
    }
    res.mensajes.unshift(...tomarAvisosVisitas(em));
    return res;
  })().finally(() => {
    if (vueltas.get(em) === vuelta) vueltas.delete(em);
  });
  vueltas.set(em, vuelta);
  return vuelta;
}
