// ============================================================
// src/lib/envios.ts
// La COLA DE ENVÍOS de reportes de incidencias: idempotente, con reintento
// y guardada en el teléfono.
//
// POR QUÉ (auditoría primer mes, 24-sep-2026). Antes, crearReporte generaba
// el record_id y las rutas de las fotos EN CADA INTENTO. Con mala señal:
//   · si el insert llegaba a la base pero la respuesta se perdía, el
//     usuario veía "No se pudo crear", volvía a tocar Guardar y nacía un
//     DUPLICADO;
//   · si el teléfono se quedaba sin red, el reporte y sus fotos solo vivían
//     en memoria: cerrar la app (o que iOS la recargara al abrir la cámara)
//     lo perdía todo.
//
// Ahora, al tocar Guardar se arma un ENVÍO con todo FIJADO UNA VEZ (ids,
// fecha, estatus, rutas de Storage) y se guarda en IndexedDB ANTES de
// mandar nada. Procesarlo es repetible: cada paso pregunta primero qué ya
// quedó hecho, así un reintento —en esta pestaña, en otra o mañana— retoma
// exactamente donde se quedó sin duplicar nada:
//   1. insertar  → consulta qué record_id ya existen; inserta solo el resto.
//   2. subir     → upsert apagado; "ya existe" cuenta como subido.
//   3. ligar     → consulta qué filas de `evidencias` ya existen.
// Cada avance se persiste (filas insertadas, archivos subidos, archivos
// ligados) para no repetir trabajo.
//
// Reintento con espera creciente SOLO para fallas de red (sin respuesta,
// timeout, gateway caído). Un error definitivo (RLS, CHECK, validación) no
// se reintenta: repetirlo daría lo mismo.
//
// Si IndexedDB no está (Safari privado) o no cabe (video enorme), se sigue
// en memoria con los mismos reintentos: la cola NUNCA bloquea el guardado.
//
// Lecciones del proyecto que aplican aquí:
//   · postgrest-js no lanza: resuelve {data, error, status}; status 0 =
//     sin red. storage-js tampoco: resuelve {data, error}.
//   · Con RLS un insert puede pasar y no devolver filas: se CUENTA.
//   · incidencias.record_id es la PK: reinsertar el mismo id da 23505, que
//     es el último candado contra duplicados si todo lo demás falla.
//   · Nada sale sin sesión real (modo sin señal, 24-sep-2026): al volver la
//     red hay hasta ~60 s en que auth-js no da sesión y todo sale como anon.
//     Ver exigirSesion.
// ============================================================
import { sb } from './supabase';
import { BUCKET_EVIDENCIAS, CACHE_INMUTABLE, subirMiniatura } from './storage';
import { reportarError } from './reportarError';
import { idCorto } from './helpers';
import { duplicadasEnProceso, ErrorConsultaDuplicados, type Duplicada } from './duplicados';
import { retenerRecargaAutomatica } from './cargaDiferida';
import { cerrarBorrador } from './borrador';
import {
  ErrorIdb,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  idbTx,
  leerArchivoGuardado,
  rangoPrefijo,
  registroDeArchivo,
  registroEnBytes,
  topeEscrituraArchivo,
  type AlmacenArchivos,
  type RegistroArchivo,
} from './idb';
import type {
  EstatusInc,
  Incidencia,
  IncidenciaNueva,
  TipoEvidencia,
} from '../types/db';

// ------------------------------------------------------------
// Tipos
// ------------------------------------------------------------

/**
 * Una fila de `incidencias` tal como se va a insertar. Lo que distingue un
 * reintento de un reporte nuevo (id, autor, fecha, estatus) viene fijado
 * desde que se tocó Guardar y NO cambia en los reintentos.
 */
export type FilaEnvio = Partial<IncidenciaNueva> & {
  record_id: string;
  estatus: EstatusInc;
  captured_by: string;
  fecha_reporte: string;
  area_reportante: string | null;
  requiere_prevalidacion: boolean;
};

/** Un archivo del envío. El Blob vive aparte (almacén `archivos`). */
export type ArchivoEnvio = {
  /** Ruta FIJA en Storage: se decide una vez y no cambia al reintentar. */
  path: string;
  /**
   * Llave del Blob en IndexedDB y en memoria: 'e:<envío>:<n>', o la
   * 'b:<sesión>:…' del borrador si ya estaba ahí (ver `enBorrador`).
   */
  clave: string;
  /**
   * El Blob es la copia que el borrador del alta ya había escrito, no una
   * propia (revisión primer mes, 24-sep-2026): no se vuelve a escribir y se
   * borra al cerrar ese borrador, que la cola cierra cuando el envío termina
   * o se descarta (ver el ciclo de vida en lib/borrador.ts).
   */
  enBorrador?: boolean;
  /** Consecutivo del archivo en el envío: va en el nombre (estable). */
  n: number;
  ext: string;
  nombre: string;
  mime: string;
  bytes: number;
  tipo: TipoEvidencia;
};

/** Una partida: sus filas (una por cara) y SUS archivos. */
export type GrupoEnvio = {
  filas: FilaEnvio[];
  archivos: ArchivoEnvio[];
  carasLabel: string;
};

/** Lo ya hecho de un envío. Se persiste tras cada avance. */
export type EstadoEnvio = {
  /** record_id confirmados en la base (insertados por nosotros). */
  insertadas: string[];
  /**
   * Se mandó un insert cuya respuesta nunca llegó (red). Se marca ANTES de
   * mandarlo: si la pestaña muere a medio insert, al retomar se sabe que la
   * fila pudo haber llegado.
   */
  insertSinRespuesta: boolean;
  /** Rutas ya subidas a Storage. */
  subidos: string[];
  /** Rutas cuyo registro en `evidencias` quedó confirmado. */
  ligados: string[];
  /** Rutas cuyo registro en `evidencias` se mandó sin confirmación. */
  ligando: string[];
  /** Rutas abandonadas por un error definitivo (ya se avisó). */
  fallidos: string[];
  /**
   * Lecturas del archivo en el teléfono que fallaron seguidas, por clave
   * (revisión sin señal, 24-sep-2026; ver leerDelTelefono).
   */
  lecturasFallidas?: Record<string, number>;
};

export type Envio = {
  v: 1;
  id: string;
  /** Correo de quien captura: solo SU sesión procesa y ve este envío. */
  email: string;
  creado_en: string;
  actualizado_en: string;
  /** Marca de tiempo fija que va en el nombre de los archivos. */
  marca: number;
  grupos: GrupoEnvio[];
  estado: EstadoEnvio;
  /** Corridas de procesamiento (la interactiva cuenta como la primera). */
  intentos: number;
  ultimoError: string | null;
  /**
   * Borrador del alta del que salió. Mientras el envío exista no se ofrece
   * recuperarlo (duplicaría el reporte) y sus archivos no se borran (el
   * envío los usa); la cola lo cierra cuando el envío queda completo o se
   * descarta (revisión primer mes, 24-sep-2026; ver lib/borrador.ts).
   */
  borrador: { email: string; sesion: string } | null;
  /** Claves de archivos que NO cupieron en el teléfono (solo en memoria). */
  fueraDelTelefono: string[];
};

export type ResultadoEnvio =
  | {
      tipo: 'completo';
      creadas: Incidencia[];
      avisos: string[];
      filasNuevas: number;
    }
  | {
      tipo: 'sinRed';
      /** 'insertar' = la incidencia aún no existe; 'archivos' = ya existe. */
      fase: 'insertar' | 'archivos';
      creadas: Incidencia[];
      avisos: string[];
      filasNuevas: number;
      mensaje: string;
    }
  | { tipo: 'duplicado'; choques: Duplicada<FilaEnvio>[] }
  | { tipo: 'error'; mensaje: string; avisos: string[] }
  | { tipo: 'vacio'; avisos: string[] }
  | { tipo: 'ocupado' }
  | { tipo: 'yaEnviado' };

/** Lo que el aviso global necesita de cada envío pendiente. */
export type ResumenPendiente = {
  id: string;
  creado_en: string;
  sitio: string;
  partidas: number;
  filas: number;
  /** La incidencia ya existe en la base: solo faltan archivos. */
  filasCreadas: boolean;
  archivosPendientes: number;
  ultimoError: string | null;
  enviando: boolean;
  /** No quedó en el teléfono: cerrar la app lo pierde. */
  soloMemoria: boolean;
  /** Archivos que no cupieron en el teléfono. */
  fueraDelTelefono: number;
};

export type ResumenCiclo = {
  terminados: number;
  siguen: number;
  /** Envíos a los que en esta vuelta se les insertaron filas. */
  conFilasNuevas: number;
  mensajes: string[];
};

// ------------------------------------------------------------
// Tiempos
// ------------------------------------------------------------

/** Esperas entre intentos por falla de red: 3 intentos en total. */
const ESPERAS_MS = [1500, 4000];
/** Tope de una consulta chica (existencia de ids o de evidencias). */
const ESPERA_CONSULTA_MS = 12000;
/** Tope de un insert: se aborta y se trata como incierto (se reconcilia). */
const ESPERA_INSERT_MS = 20000;
/** Subida: base + tiempo a ~20 KB/s. Solo evita colgarse para siempre. */
const ESPERA_SUBIDA_BASE_MS = 60000;
const BYTES_POR_MS_MIN = 20;
/** Tope de una escritura de estado en IndexedDB (metadatos). */
const ESPERA_ESTADO_MS = 5000;

// ------------------------------------------------------------
// Estado de la pestaña
// ------------------------------------------------------------

/**
 * Envíos que esta pestaña trae en la mano: los que procesa ahora y los que
 * NO se pudieron guardar en el teléfono (para esos, esto es lo único).
 * Para el resto, IndexedDB es la verdad: otra pestaña pudo avanzarlos.
 */
const memoria = new Map<string, Envio>();
/** Los File originales por clave: preferibles a leerlos de IndexedDB. */
const archivosMem = new Map<string, File>();
/** Ids de envíos que NO quedaron en IndexedDB. */
const soloMemoria = new Set<string>();
/** Ids de envíos guardados SIN alguno de sus archivos (ese vive solo aquí). */
const conArchivosFuera = new Set<string>();
/** Procesamientos en curso en esta pestaña (uno por envío a la vez). */
const enCurso = new Map<string, Promise<ResultadoEnvio>>();
/** Envíos del Guardar que el usuario está esperando (el aviso no los pinta). */
const interactivos = new Set<string>();
/** Descartados: ninguna escritura tardía debe resucitarlos. */
const descartados = new Set<string>();

// Aviso de cambios: EventTarget en la pestaña y BroadcastChannel entre
// pestañas, así el aviso global se actualiza sin sondear.
const bus: EventTarget | null = typeof EventTarget !== 'undefined' ? new EventTarget() : null;
let canal: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    canal = new BroadcastChannel('gpo-envios');
    canal.onmessage = () => emitir(true);
  }
} catch {
  canal = null;
}

/**
 * Retención de la recarga automática por chunk viejo (lib/cargaDiferida).
 * Mientras haya envíos EN RIESGO (ver hayEnviosEnRiesgo) la app no se
 * recarga sola al fallar un módulo diferido: el error va al aviso y el
 * usuario decide. Se toma una sola retención y se suelta al quedar libre
 * (integración primer mes, 24-sep-2026: lo pidió el frente de carga
 * diferida). Todo cambio de esos conjuntos pasa por emitir(), así que
 * basta con sincronizar ahí.
 */
let soltarRetencion: (() => void) | null = null;
function sincronizarRetencion(): void {
  // Solo lo de ESTA cola: las acciones (lib/acciones.ts) toman su propia
  // retención; si esta contara las suyas, se quedaría tomada hasta el
  // siguiente cambio de envíos (modo sin señal, 24-sep-2026).
  const enRiesgo = enviosPropiosEnRiesgo();
  if (enRiesgo && !soltarRetencion) soltarRetencion = retenerRecargaAutomatica();
  else if (!enRiesgo && soltarRetencion) {
    soltarRetencion();
    soltarRetencion = null;
  }
}

function emitir(desdeOtraPestana = false): void {
  sincronizarRetencion();
  try {
    bus?.dispatchEvent(new Event('cambio'));
  } catch {
    /* sin suscriptores no pasa nada */
  }
  if (!desdeOtraPestana) {
    try {
      canal?.postMessage('cambio');
    } catch {
      /* canal cerrado */
    }
  }
}

/** Se llama cada vez que la cola cambia (aquí o en otra pestaña). */
export function suscribirEnvios(cb: () => void): () => void {
  if (!bus) return () => {};
  const h = () => cb();
  bus.addEventListener('cambio', h);
  return () => bus.removeEventListener('cambio', h);
}

/**
 * Correo de la sesión que el armazón (App) tiene abierta. NuevaInc lo usa
 * de respaldo para su borrador: sin red y con el token vencido,
 * sb.auth.getSession() puede no dar sesión, y justo ese es el caso que el
 * borrador protege.
 */
let emailRegistrado = '';
export function registrarEmailActivo(email: string): void {
  emailRegistrado = (email || '').trim().toLowerCase();
}
export function emailActivo(): string {
  return emailRegistrado;
}

// ------------------------------------------------------------
// Ayudantes puros
// ------------------------------------------------------------

/** Id del envío: UUID completo (no el corto de las filas). */
export function nuevoIdEnvio(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x: number) => x.toString(16).padStart(2, '0')).join('');
}

/** Llave del Blob de un archivo del envío. */
export function claveArchivoEnvio(idEnvio: string, n: number): string {
  return `e:${idEnvio}:${n}`;
}

/**
 * Ruta de Storage de un archivo. MISMA FORMA que antes —carpeta del primer
 * record_id del grupo, y sitio, cara y fecha en el nombre para
 * identificarlo en Storage sin abrir la app— pero con `marca` y `n`
 * ESTABLES en vez de Date.now() en cada intento: así el reintento sube al
 * mismo lugar y "ya existe" significa "ya quedó".
 */
export function rutaArchivo(
  g: { filas: { record_id: string; clave_sitio?: string | null; fecha_reporte: string }[]; carasLabel: string },
  marca: number,
  n: number,
  ext: string
): string {
  const id0 = g.filas[0]?.record_id || 'reporte';
  const sitio = g.filas[0]?.clave_sitio || 'reporte';
  const fecha = (g.filas[0]?.fecha_reporte || new Date().toISOString()).slice(0, 10);
  const caraArchivo = (g.carasLabel || 'cara').replace(/[^\w-]/g, '_');
  return `${id0}/${sitio}_${caraArchivo}_${fecha}_reporte_${marca}_${n}.${ext}`.replace(
    /[^\w/.\-]/g,
    '_'
  );
}

function filasDe(e: Envio): FilaEnvio[] {
  return e.grupos.flatMap((g) => g.filas);
}

function faltantes(e: Envio): FilaEnvio[] {
  const ya = new Set(e.estado.insertadas);
  return filasDe(e).filter((f) => !ya.has(f.record_id));
}

function archivosPendientes(e: Envio): ArchivoEnvio[] {
  const fin = new Set([...e.estado.ligados, ...e.estado.fallidos]);
  return e.grupos.flatMap((g) => g.archivos).filter((a) => !fin.has(a.path));
}

// Los auxiliares de red de aquí para abajo se exportan para la cola de
// acciones (lib/acciones.ts; modo sin señal, 24-sep-2026): misma
// clasificación de errores y mismos topes en las dos colas.

export function dormir(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function sinSenal(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * AbortSignal con tope. AbortSignal.timeout no existe en Safari < 16: ahí
 * se arma a mano. Un abort de postgrest-js regresa status 0 → cuenta como
 * falla de red, y como todo es idempotente, abortar es seguro.
 */
export function tope(ms: number): AbortSignal {
  const AS = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof AS.timeout === 'function') return AS.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/**
 * Instante de un timestamp tal como lo devuelve la base. Se compara por
 * instante y no por texto: la base responde '+00:00' donde mandamos 'Z'.
 * Tolerante a microsegundos y a columnas sin zona (se toman como UTC, que
 * es lo que se mandó).
 */
export function instante(s: string | null | undefined): number {
  if (!s) return NaN;
  let t = String(s).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  if (!/[zZ]$|[+-]\d{2}(:?\d{2})?$/.test(t)) t += 'Z';
  return Date.parse(t);
}

// ------------------------------------------------------------
// Clasificación de errores
// ------------------------------------------------------------

/** Falla de transporte: se reintenta con espera. */
export class SinRed extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'SinRed';
  }
}

/**
 * No hay sesión real todavía (modo sin señal, 24-sep-2026). Al volver la
 * red, auth-js tarda hasta ~60 s en renovar un token vencido (enfriamiento
 * tras la última renovación fallida) y mientras tanto las peticiones salen
 * como anon: un insert da 401 (ya era transitorio), pero una subida a
 * Storage da 400/403 y se marcaba como fallo DEFINITIVO — la foto se
 * abandonaba. Es una falla de red más: se espera y se reintenta.
 */
export class SinSesion extends SinRed {
  constructor(mensaje = 'Sin sesión todavía: se reintenta al renovarse.') {
    super(mensaje);
    this.name = 'SinSesion';
  }
}

/**
 * La sesión abierta es de OTRA cuenta (revisión sin señal, 24-sep-2026).
 * Teléfono compartido: A sale con algo enviándose y B entra antes de que
 * termine. Sin esta guardia, lo que seguía en la vuelta de A salía con la
 * sesión de B; si la RLS no dejaba a B, la acción de A se quitaba de la cola
 * como "sin permiso" y se perdía. Es SinSesion (y por lo tanto SinRed): se
 * queda en la cola, la vuelta se corta y sale cuando A vuelva a entrar.
 */
export class OtraCuenta extends SinSesion {
  constructor() {
    super('La sesión abierta es de otra cuenta; se envía al volver a entrar con la tuya.');
    this.name = 'OtraCuenta';
  }
}

/**
 * No se pudo LEER un archivo guardado en el teléfono: IndexedDB falló, no es
 * que falte (revisión sin señal, 24-sep-2026; ver leerDelTelefono). Se trata
 * como falla de red: sigue en la cola y se reintenta en la siguiente vuelta.
 */
export class SinLectura extends SinRed {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'SinLectura';
  }
}

/**
 * La subida no terminó dentro de su tope (revisión sin señal, 24-sep-2026).
 * storage-js no se puede abortar: la subida sigue sola en segundo plano, así
 * que NO se reintenta en la misma vuelta (conReintento, y reintentar en
 * lib/acciones.ts): solo sumaba esperas de ~35 min por video con señal débil
 * y retenía todo lo que venía detrás. La siguiente vuelta se engancha a la
 * misma subida (ver subir), no lanza otra.
 */
export class SubidaLenta extends SinRed {
  constructor() {
    super('La subida no terminó a tiempo');
    this.name = 'SubidaLenta';
  }
}

/**
 * Texto de "Último intento" para lo que se quedó en cola por una falla de
 * red (las dos colas). `se` = 'solo' (reporte) o 'sola' (acción). Primero la
 * falta de red y después la sesión (revisión sin señal, 24-sep-2026): tras
 * más de una hora sin señal el token vence, exigirSesion no puede renovarlo
 * y lanza SinSesion; el aviso decía "Esperando a que se renueve tu sesión"
 * y la gente creía que era un problema de su cuenta y no de la señal.
 */
export function textoEnCola(err: unknown, se: 'solo' | 'sola'): string {
  if (err instanceof OtraCuenta)
    return `Hay otra cuenta abierta en este teléfono: se envía ${se} cuando vuelvas a entrar con la tuya.`;
  if (err instanceof SinLectura)
    return `No se pudo leer una foto o video guardado en el teléfono; se reintenta ${se}.`;
  if (sinSenal()) return 'Sin señal: el teléfono está sin conexión.';
  if (err instanceof SinSesion) return `Esperando a que se renueve tu sesión; se envía ${se}.`;
  if (err instanceof SubidaLenta)
    return `La señal va muy lenta: la subida sigue en segundo plano y se retoma ${se}.`;
  return 'Sin señal: el servidor no respondió.';
}

/**
 * Tope de la guardia de sesión en la cola; en el Guardar que el usuario
 * espera, menos: con red lenta y token vencido la renovación suele tardar
 * 1–2 s, y sin red no vale la pena esperar más para mandarlo a la cola.
 */
const ESPERA_SESION_MS = 8000;
export const ESPERA_SESION_INTERACTIVA_MS = 5000;

/**
 * GUARDIA DE SESIÓN: resuelve si hay sesión real (un access token vigente
 * para mandar con la petición); si no, lanza SinSesion. Primero
 * getSession(); si no da sesión, un refreshSession(). Todo con UN tope
 * total: con el token vencido y sin red, auth-js reintenta la renovación
 * ~25 s, y quien espera un Guardar no debe esperar eso — mejor a la cola.
 *
 * `correo` = el dueño de lo que se va a mandar (revisión sin señal,
 * 24-sep-2026): si la sesión es de OTRA cuenta, lanza OtraCuenta. Las colas
 * la llaman antes de cada paso largo (cada archivo, el UPDATE), porque la
 * sesión puede cambiar a media vuelta. Si la sesión no trae correo no se
 * compara (no hay con qué).
 */
export async function exigirSesion(topeMs = ESPERA_SESION_MS, correo?: string): Promise<void> {
  const limite = Date.now() + topeMs;
  const conTope = <T>(p: Promise<T>): Promise<T | null> =>
    Promise.race([p, dormir(Math.max(0, limite - Date.now())).then(() => null)]);
  const dueno = (correo || '').trim().toLowerCase();
  const sirve = (s: { user?: { email?: string | null } | null } | null | undefined): boolean => {
    if (!s) return false;
    const de = (s.user?.email || '').trim().toLowerCase();
    if (dueno && de && de !== dueno) throw new OtraCuenta();
    return true;
  };
  try {
    const r = await conTope(sb.auth.getSession());
    if (sirve(r?.data?.session)) return;
    if (Date.now() < limite) {
      const r2 = await conTope(sb.auth.refreshSession());
      if (sirve(r2?.data?.session)) return;
    }
  } catch (err) {
    if (err instanceof OtraCuenta) throw err;
    /* auth-js no debería lanzar; si lo hace, es "sin sesión" */
  }
  throw new SinSesion();
}

/** Mensajes de fetch sin red en Chrome, Safari, Firefox y WebViews. */
const RE_RED =
  /failed to fetch|load failed|networkerror|network request failed|network connection was lost|internet connection appears to be offline|timed? ?out|timeout|aborterror|operation was aborted|fetcherror|err_network|err_internet_disconnected/i;

/**
 * HTTP que significan "no llegó / no se procesó, vuelve a intentar": sin
 * respuesta (0), sesión por renovar (401: supabase-js la renueva sola al
 * volver la red), timeouts y gateways caídos.
 */
const STATUS_TRANSITORIOS = new Set([0, 401, 408, 425, 429, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * Códigos de Postgres transitorios: statement timeout, serialización,
 * deadlock y sin conexiones libres (con 300 usuarios pueden aparecer). En
 * todos la sentencia NO se aplicó, así que reintentar es seguro.
 */
const CODIGOS_PG_TRANSITORIOS = new Set(['57014', '40001', '40P01', '53300', '53400', '08000', '08003', '08006']);

/**
 * ¿La respuesta de postgrest-js es falla de red? Con un status HTTP real
 * manda el status (el texto de un error definitivo podría contener
 * "timeout" y no por eso reintentarse para siempre).
 */
export function esFallaRedPg(error: { message?: string; code?: string } | null, status: number): boolean {
  if (!error) return false;
  if (!status || STATUS_TRANSITORIOS.has(status)) return true;
  return !!error.code && CODIGOS_PG_TRANSITORIOS.has(error.code);
}

/** ¿Una excepción lanzada es falla de red? (fetch lanza TypeError). */
export function esExcepcionDeRed(err: unknown): boolean {
  if (err instanceof SinRed || err instanceof TypeError) return true;
  const e = err as { name?: string; message?: string } | null;
  return /abort|timeout/i.test(e?.name || '') || RE_RED.test(e?.message || '');
}

export function mensajeDe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  const e = err as { message?: unknown } | null;
  return e && typeof e.message === 'string' ? e.message : String(err ?? 'error desconocido');
}

/**
 * Error de storage-js al subir. Forma real (storage-js 2.112):
 *   · sin red: StorageUnknownError (fetch tronó), sin `status`;
 *   · con respuesta: StorageApiError con `status` (HTTP) y `statusCode`
 *     (el del cuerpo, texto). "Ya existe" llega como status 400 o 409 con
 *     statusCode '409', error 'Duplicate' y mensaje "The resource already
 *     exists"; versiones nuevas mandan code 'ResourceAlreadyExists'.
 */
export function clasificarStorage(err: unknown): 'existe' | 'red' | 'definitivo' {
  const e = (err || {}) as {
    name?: string;
    status?: number;
    statusCode?: string | number;
    message?: string;
    code?: string;
    error?: string;
  };
  const sc = String(e.statusCode ?? '');
  const msg = e.message || '';
  if (
    e.status === 409 ||
    sc === '409' ||
    /already exists/i.test(msg) ||
    /^(duplicate|resourcealreadyexists)$/i.test(e.code || e.error || '')
  )
    return 'existe';
  // Sin respuesta HTTP: fetch no llegó al servidor.
  if (e.name === 'StorageUnknownError' || e.status === undefined || e.status === 0) return 'red';
  if (STATUS_TRANSITORIOS.has(e.status) || e.status === 500 || ['502', '503', '504'].includes(sc))
    return 'red';
  // Token vencido en Storage: se renueva al volver la red.
  if (/jwt expired|exp.*claim/i.test(msg)) return 'red';
  return 'definitivo';
}

/**
 * Repite `fn` mientras falle por RED: 3 intentos, esperas de ~1.5 s y ~4 s.
 * Un error definitivo sale al primer intento. Si el navegador ya sabe que
 * no hay red, no se espera en vano.
 */
export async function conReintento<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      // Sin sesión no se insiste en segundos: auth-js no renueva antes de
      // su enfriamiento (~60 s) y cada intento saldría otra vez como anon.
      // Una subida lenta tampoco: sigue en segundo plano (ver SubidaLenta).
      if (err instanceof SinSesion || err instanceof SubidaLenta || !esExcepcionDeRed(err)) throw err;
      const sr = err instanceof SinRed ? err : new SinRed(mensajeDe(err));
      if (i >= ESPERAS_MS.length || sinSenal()) throw sr;
      await dormir(ESPERAS_MS[i]);
    }
  }
}

// ------------------------------------------------------------
// Persistencia
// ------------------------------------------------------------

/**
 * Guarda el avance. Nunca detiene el envío: si IndexedDB falla, se sigue
 * con lo que hay en memoria (el reintento de esta pestaña no lo necesita;
 * solo un reintento tras cerrar la app).
 */
async function persistir(e: Envio): Promise<void> {
  e.actualizado_en = new Date().toISOString();
  if (descartados.has(e.id)) return;
  if (!soloMemoria.has(e.id)) {
    try {
      await idbPut('envios', e, ESPERA_ESTADO_MS);
    } catch {
      /* se sigue en memoria */
    }
  }
  emitir();
}

/**
 * Guarda un envío recién armado ANTES de mandar nada. Es la diferencia
 * entre "sin señal se pierde" y "sin señal se envía después".
 *
 * El registro y sus archivos van en UNA transacción (todo o nada): un
 * registro sin sus fotos, tras recargar, crearía incidencias sin evidencia.
 * Si no cabe todo (cuota, un video enorme) se intenta sin videos, luego
 * con las fotos en bytes (Safari viejo no clonaba File), y al final solo el
 * registro; lo que no cupo queda anotado en `fueraDelTelefono` y vive solo
 * en memoria. Si ni el registro cabe, el envío es solo de memoria.
 *
 * `interactivo`: el usuario está esperando este envío en su pantalla; el
 * aviso global no lo pinta mientras tanto.
 *
 * Los archivos que ya estaban en el borrador del alta (`enBorrador`) no se
 * vuelven a escribir (revisión primer mes, 24-sep-2026): la doble copia
 * llenaba el teléfono justo en el Guardar, y un video que sí había cabido
 * en el borrador quedaba "fuera del teléfono" para el envío.
 */
export async function guardarEnvioNuevo(
  e: Envio,
  archivos: Map<string, File>,
  op: { interactivo: boolean }
): Promise<{ enTelefono: boolean; fueraDelTelefono: number }> {
  archivos.forEach((f, k) => archivosMem.set(k, f));
  memoria.set(e.id, e);
  if (op.interactivo) interactivos.add(e.id);

  const todos = e.grupos.flatMap((g) => g.archivos);
  // Solo los que no tienen copia en el teléfono todavía.
  const propios = todos.filter((a) => !a.enBorrador);
  const intentar = async (registros: RegistroArchivo[]): Promise<boolean> => {
    const guardados = new Set(registros.map((r) => r.clave));
    e.fueraDelTelefono = propios.filter((a) => !guardados.has(a.clave)).map((a) => a.clave);
    const bytes = registros.reduce((s, r) => s + r.bytes, 0);
    try {
      await idbTx(
        ['envios', 'archivos'],
        'readwrite',
        (tx) => {
          const alm = tx.objectStore('archivos');
          registros.forEach((r) => alm.put(r));
          tx.objectStore('envios').put(e);
        },
        topeEscrituraArchivo(bytes)
      );
      return true;
    } catch (err) {
      // Base ausente o colgada: otro intento solo retrasaría el guardado
      // (cada uno espera su tope). Se corta aquí y se sigue en memoria.
      if (err instanceof ErrorIdb && (err.motivo === 'no-disponible' || err.motivo === 'tope'))
        throw err;
      return false;
    }
  };

  const deFile = (a: ArchivoEnvio): File | undefined => archivos.get(a.clave);
  try {
    // 1) Todo.
    const completos = propios
      .map((a) => {
        const f = deFile(a);
        return f ? registroDeArchivo(a.clave, f) : null;
      })
      .filter(Boolean) as RegistroArchivo[];
    if (await intentar(completos)) return listo(true);
    // 2) Sin videos (lo que casi siempre llena el espacio).
    const fotos = propios.filter((a) => a.tipo === 'foto');
    const fotosBlob = fotos
      .map((a) => {
        const f = deFile(a);
        return f ? registroDeArchivo(a.clave, f) : null;
      })
      .filter(Boolean) as RegistroArchivo[];
    if (fotosBlob.length && (await intentar(fotosBlob))) return listo(true);
    // 3) Fotos como bytes (Safari que no deja guardar el File tal cual).
    const fotosBytes = (
      await Promise.all(
        fotos.map((a) => {
          const f = deFile(a);
          return f ? registroEnBytes(a.clave, f) : Promise.resolve(null);
        })
      )
    ).filter(Boolean) as RegistroArchivo[];
    if (fotosBytes.length && (await intentar(fotosBytes))) return listo(true);
    // 4) Solo el registro: al menos la incidencia sobrevive a un cierre.
    if (await intentar([])) return listo(true);
  } catch {
    /* IndexedDB no disponible: cae a memoria */
  }
  return listo(false);

  function listo(enTelefono: boolean) {
    if (!enTelefono) {
      soloMemoria.add(e.id);
      e.fueraDelTelefono = todos.map((a) => a.clave);
      reportarError('envios.idb', new Error('envío solo en memoria'), {
        archivos: todos.length,
        bytes: todos.reduce((s, a) => s + a.bytes, 0),
      });
    } else {
      soloMemoria.delete(e.id);
      if (e.fueraDelTelefono.length) conArchivosFuera.add(e.id);
    }
    emitir();
    return { enTelefono, fueraDelTelefono: e.fueraDelTelefono.length };
  }
}

/** Todos los envíos de este correo (teléfono + memoria), del más viejo al más nuevo. */
export async function listarEnvios(email: string): Promise<Envio[]> {
  const porId = new Map<string, Envio>();
  try {
    (await idbGetAll<Envio>('envios')).forEach((e) => porId.set(e.id, e));
  } catch {
    /* sin IndexedDB: solo lo de memoria */
  }
  // Lo de memoria es más fresco que lo guardado.
  memoria.forEach((e, id) => porId.set(id, e));
  const em = (email || '').trim().toLowerCase();
  return [...porId.values()]
    .filter((e) => e.v === 1 && (e.email || '').toLowerCase() === em && !descartados.has(e.id))
    .sort((a, b) => a.creado_en.localeCompare(b.creado_en));
}

function resumir(e: Envio): ResumenPendiente {
  const filas = filasDe(e);
  return {
    id: e.id,
    creado_en: e.creado_en,
    sitio: filas[0]?.clave_sitio || '—',
    partidas: e.grupos.length,
    filas: filas.length,
    filasCreadas: filas.length > 0 && faltantes(e).length === 0,
    archivosPendientes: archivosPendientes(e).length,
    ultimoError: e.ultimoError,
    enviando: enCurso.has(e.id),
    soloMemoria: soloMemoria.has(e.id),
    fueraDelTelefono: e.fueraDelTelefono?.length || 0,
  };
}

/** Lo que el aviso global pinta: pendientes de este correo, sin los que el usuario está esperando. */
export async function listarPendientes(email: string): Promise<ResumenPendiente[]> {
  return (await listarEnvios(email)).filter((e) => !interactivos.has(e.id)).map(resumir);
}

/**
 * ¿Hay algo que se perdería al recargar la pestaña? (envíos que no
 * cupieron en el teléfono o que se están mandando ahora). Para quien
 * ofrezca recargar —p. ej. "Hay una versión nueva · Actualizar ahora"— y
 * quiera avisar antes.
 */
export function hayEnviosEnRiesgo(): boolean {
  return enviosPropiosEnRiesgo() || riesgosExtraActivos().length > 0;
}

/** Solo los envíos de ESTA cola (para su propia retención de recarga). */
function enviosPropiosEnRiesgo(): boolean {
  return soloMemoria.size > 0 || conArchivosFuera.size > 0 || enCurso.size > 0;
}

/**
 * Otras colas que también se pierden al recargar (modo sin señal,
 * 24-sep-2026): lib/acciones.ts registra aquí las suyas al cargar. Va por
 * registro y no por import para no crear una importación circular (acciones
 * importa este módulo). `que` = cómo se nombra en el aviso.
 */
const riesgosExtra: { hay: () => boolean; que: string }[] = [];
export function registrarRiesgoExtra(hay: () => boolean, que: string): () => void {
  const r = { hay, que };
  riesgosExtra.push(r);
  return () => {
    const i = riesgosExtra.indexOf(r);
    if (i >= 0) riesgosExtra.splice(i, 1);
  };
}
function riesgosExtraActivos(): string[] {
  return riesgosExtra
    .filter((r) => {
      try {
        return r.hay();
      } catch {
        return false;
      }
    })
    .map((r) => r.que);
}

/**
 * Para los botones que recargan la app a pedido del usuario ("Actualizar
 * ahora", "Recargar la app"): si hay envíos (o acciones) en riesgo,
 * pregunta antes. true = se puede recargar (integración primer mes,
 * 24-sep-2026).
 */
export function confirmarRecargaConEnvios(): boolean {
  const partes = [...(enviosPropiosEnRiesgo() ? ['un reporte'] : []), ...riesgosExtraActivos()];
  if (!partes.length) return true;
  return confirm(
    `Hay ${partes.join(' y ')} enviándose o que no cupo en el teléfono. Si recargas ahora, ` +
      'se puede perder.\n\n¿Recargar de todos modos?'
  );
}

/** ¿Hay un envío en cola que salió de este borrador? (entonces ya no se ofrece). */
export async function hayEnvioDeBorrador(sesion: string): Promise<boolean> {
  const hay = (e: Envio) => e.borrador?.sesion === sesion;
  for (const e of memoria.values()) if (hay(e)) return true;
  try {
    return (await idbGetAll<Envio>('envios')).some(hay);
  } catch {
    return false;
  }
}

/**
 * Saca un envío de la cola con todos sus archivos (terminado o descartado).
 * Los que son del borrador (`enBorrador`) se quedan en el teléfono: se van
 * al cerrar ese borrador (cerrarBorradorDe). `e` = el envío, si quien llama
 * lo tiene (para soltar de memoria también esos archivos).
 */
export async function quitarEnvio(id: string, e?: Envio | null): Promise<void> {
  const env = e ?? memoria.get(id);
  // Un envío solo de memoria no dejó nada en IndexedDB: no se espera a la
  // base (revisión primer mes, 24-sep-2026). Donde indexedDB.open no
  // contesta, esperarla aquí sumaba segundos a cada Guardar con buena red.
  const soloMem = soloMemoria.has(id);
  memoria.delete(id);
  soloMemoria.delete(id);
  conArchivosFuera.delete(id);
  const prefijo = `e:${id}:`;
  [...archivosMem.keys()].forEach((k) => {
    if (k.startsWith(prefijo)) archivosMem.delete(k);
  });
  env?.grupos.forEach((g) => g.archivos.forEach((a) => archivosMem.delete(a.clave)));
  // Una sola transacción: no quedan Blobs huérfanos de un registro borrado.
  const borrado = idbTx(['envios', 'archivos'], 'readwrite', (tx) => {
    tx.objectStore('envios').delete(id);
    tx.objectStore('archivos').delete(rangoPrefijo(prefijo));
  }).catch(() => {
    /* sin IndexedDB no había nada guardado */
  });
  // Solo de memoria: se borra igual por si una escritura que se dio por
  // fallida sí alcanzó a quedar, pero sin esperarla.
  if (!soloMem) await borrado;
  emitir();
}

/**
 * Cierra el borrador del alta del que salió el envío (revisión primer mes,
 * 24-sep-2026). Antes nadie lo cerraba si el envío terminaba desde la cola
 * —la app murió a medio Guardar y al reabrir la cola lo mandó—, y dentro de
 * sus 48 h se ofrecía "Recuperar": un reporte duplicado. Ver el ciclo de
 * vida completo en lib/borrador.ts.
 */
function cerrarBorradorDe(e: Envio): void {
  if (e.borrador) void cerrarBorrador(e.borrador.email, e.borrador.sesion);
}

/**
 * El envío terminó (completo, o vacío porque todo ya estaba en proceso):
 * fuera de la cola y, con él, su borrador. En ese orden: mientras el envío
 * siga guardado, el borrador no suelta sus archivos.
 */
async function terminarEnvio(e: Envio): Promise<void> {
  await quitarEnvio(e.id, e);
  cerrarBorradorDe(e);
}

/**
 * Un envío que NO quedó en el teléfono y cuyas filas ya están en la base
 * cierra su borrador en ese momento: si la pestaña muere, del envío no
 * queda rastro y al reabrir se ofrecería recuperar un reporte que ya entró.
 * Sus archivos siguen en memoria mientras la pestaña viva. Uno guardado no
 * lo necesita: mientras exista, su borrador no se ofrece.
 */
function cerrarBorradorSiYaEntro(e: Envio): void {
  if (soloMemoria.has(e.id) && e.estado.insertadas.length) cerrarBorradorDe(e);
}

/**
 * El usuario descarta un envío desde el aviso. Si se está procesando (aquí
 * o en otra pestaña) no se toca: borrarlo a medio paso lo dejaría a medias.
 * Su borrador se cierra con él (revisión primer mes, 24-sep-2026): el aviso
 * promete "se borra de este teléfono", y si la incidencia ya existía
 * (solo faltaban fotos), recuperarlo la duplicaría.
 */
export async function descartarEnvio(id: string): Promise<'ok' | 'ocupado'> {
  if (enCurso.has(id)) return 'ocupado';
  const r = await conCandado<'ok' | 'ocupado'>(
    id,
    async () => {
      const e =
        memoria.get(id) ?? (await idbGet<Envio>('envios', id).catch(() => undefined)) ?? null;
      descartados.add(id);
      await quitarEnvio(id, e);
      if (e) cerrarBorradorDe(e);
      return 'ok' as const;
    },
    'ocupado' as const
  );
  return r;
}

// ------------------------------------------------------------
// Concurrencia
// ------------------------------------------------------------

/**
 * Corre `fn` con el candado del envío entre pestañas (Web Locks). Si otra
 * pestaña lo tiene, NO se espera: se contesta `ocupado` y se intenta en la
 * siguiente vuelta. Sin Web Locks (Safari < 15.4) se corre sin candado: el
 * Map `enCurso` cubre la pestaña y la idempotencia cubre el resto.
 * `prefijo` separa los candados de cada cola ('accion-' en lib/acciones.ts).
 */
export async function conCandado<T>(
  id: string,
  fn: () => Promise<T>,
  ocupado: T,
  prefijo = 'envio-'
): Promise<T> {
  const locks =
    typeof navigator !== 'undefined'
      ? (navigator as unknown as { locks?: LockManager }).locks
      : undefined;
  if (!locks || typeof locks.request !== 'function') return fn();
  let corrio = false;
  try {
    return await locks.request(prefijo + id, { ifAvailable: true }, async (lock) => {
      if (!lock) return ocupado;
      corrio = true;
      return fn();
    });
  } catch (err) {
    // Si truena el candado mismo (contexto sin permiso), se corre sin él;
    // si tronó `fn`, el error es de `fn` y no se repite.
    if (corrio) throw err;
    return fn();
  }
}

/**
 * Procesa un envío: inserta lo que falte, sube y liga sus archivos.
 * `interactivo` = el usuario tocó Guardar y está esperando: los avisos van
 * en alert() como siempre, y un duplicado aborta todo. En diferido (desde
 * la cola) los avisos se juntan para el aviso global y los duplicados se
 * quitan del envío.
 * Se intenta SIEMPRE, aunque el navegador diga que no hay red (revisión
 * primer mes, 24-sep-2026): en algunos Android navigator.onLine se queda en
 * false en falso y el reporte ya ni se intentaba. Sin red de verdad cuesta
 * un fetch que falla al instante, y conReintento no espera.
 */
export function procesarEnvio(e: Envio, op: { interactivo: boolean }): Promise<ResultadoEnvio> {
  const previo = enCurso.get(e.id);
  if (previo) return op.interactivo ? previo : Promise.resolve({ tipo: 'ocupado' });
  const p = conCandado<ResultadoEnvio>(e.id, () => ejecutar(e, op), { tipo: 'ocupado' })
    .catch((err): ResultadoEnvio => {
      // ejecutar() no debería lanzar; si pasa, nada se pierde: sigue en cola.
      reportarError('envios.procesar', err);
      return { tipo: 'error', mensaje: mensajeDe(err), avisos: [] };
    })
    .finally(() => {
      enCurso.delete(e.id);
      if (op.interactivo) interactivos.delete(e.id);
      emitir();
    });
  enCurso.set(e.id, p);
  emitir();
  return p;
}

/**
 * La vuelta en curso de cada correo. Una por CORREO y no una por pestaña
 * (revisión sin señal, 24-sep-2026): si A salió con su vuelta a medias y B
 * entra, B no recibe la promesa de A (ni sus avisos) ni espera a que
 * termine; la de A se corta sola en su siguiente paso (exigirSesion con su
 * correo → OtraCuenta) y lo que falte queda en la cola de A.
 */
const vueltas = new Map<string, Promise<ResumenCiclo>>();

/**
 * Procesa la cola de este correo, del más viejo al más nuevo. Una vuelta a
 * la vez por correo (ver `vueltas`). Si uno se queda sin red, los demás no
 * se intentan en esta vuelta: tardarían lo mismo en fallar.
 *
 * Ya no sale de inmediato cuando navigator.onLine dice false (revisión
 * primer mes, 24-sep-2026): donde eso es falso, el evento 'online' nunca
 * llega y el reporte solo salía con "Reintentar ahora", mientras el aviso
 * prometía que se enviaría solo. Sin red de verdad, el primer envío falla
 * al instante y corta la vuelta: es un intento barato por disparador.
 */
export function procesarPendientes(email: string): Promise<ResumenCiclo> {
  const em = (email || '').trim().toLowerCase();
  const enCursoDe = vueltas.get(em);
  if (enCursoDe) return enCursoDe;
  const vuelta: Promise<ResumenCiclo> = (async () => {
    const res: ResumenCiclo = { terminados: 0, siguen: 0, conFilasNuevas: 0, mensajes: [] };
    const lista = await listarEnvios(email);
    if (!lista.length) return res;
    let cortar = false;
    for (const e of lista) {
      if (cortar || interactivos.has(e.id)) {
        res.siguen++;
        continue;
      }
      const r = await procesarEnvio(e, { interactivo: false });
      switch (r.tipo) {
        case 'completo':
        case 'vacio':
        case 'yaEnviado':
          res.terminados++;
          break;
        case 'sinRed':
          res.siguen++;
          cortar = true;
          break;
        default:
          res.siguen++;
      }
      if ('avisos' in r) res.mensajes.push(...r.avisos);
      if ((r.tipo === 'completo' || r.tipo === 'sinRed') && r.filasNuevas > 0) res.conFilasNuevas++;
    }
    return res;
  })().finally(() => {
    if (vueltas.get(em) === vuelta) vueltas.delete(em);
  });
  vueltas.set(em, vuelta);
  return vuelta;
}

// ------------------------------------------------------------
// El procesamiento
// ------------------------------------------------------------

/**
 * La versión más fresca de un envío, ya DENTRO del candado: la que se
 * listó pudo avanzar en otra pestaña mientras tanto. null = ya no existe
 * (lo terminó o descartó otra pestaña).
 */
async function versionFresca(e0: Envio): Promise<Envio | null> {
  if (descartados.has(e0.id)) return null;
  const mem = memoria.get(e0.id);
  if (mem) return mem;
  if (soloMemoria.has(e0.id)) return e0;
  try {
    const guardado = await idbGet<Envio>('envios', e0.id);
    return guardado ?? null;
  } catch {
    return e0;
  }
}

/** ¿La fila que ya existe en la base con nuestro id es NUESTRA? */
function esNuestra(
  f: FilaEnvio,
  x: {
    captured_by: string | null;
    fecha_reporte: string | null;
    clave_medio: string | null;
    nombre_incidencia: string | null;
  },
  huboInsertIncierto: boolean
): boolean {
  const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();
  if (norm(x.captured_by) !== norm(f.captured_by)) return false;
  if (instante(x.fecha_reporte) === instante(f.fecha_reporte)) return true;
  // Respaldo: si la fecha no cuadra (formato inesperado de la columna)
  // pero autor, cara e incidencia sí, y este envío ya mandó un insert sin
  // respuesta, es nuestra. Un id aleatorio que choque justo con una fila
  // del mismo autor, misma cara y misma falla no va a pasar; en cambio,
  // equivocarse aquí duplicaría el reporte.
  return (
    huboInsertIncierto &&
    (x.clave_medio || '') === (f.clave_medio || '') &&
    (x.nombre_incidencia || '') === (f.nombre_incidencia || '')
  );
}

/**
 * Cambia el record_id de una fila por choque con una fila AJENA. Solo es
 * seguro mientras ningún archivo del envío se haya subido (las rutas usan
 * el primer id del grupo) — y siempre es el caso: todas las filas se
 * insertan antes de subir el primer archivo. Eso incluye el caso "no se ha
 * insertado ninguna" y también el de un grupo con filas ya insertadas.
 */
function regenerarId(e: Envio, f: FilaEnvio): boolean {
  if (e.estado.subidos.length || e.estado.ligando.length) return false;
  const usados = new Set(filasDe(e).map((x) => x.record_id));
  let nuevo = idCorto();
  while (usados.has(nuevo)) nuevo = idCorto();
  const viejo = f.record_id;
  f.record_id = nuevo;
  const g = e.grupos.find((x) => x.filas.includes(f));
  if (g && g.filas[0] === f) {
    g.archivos.forEach((a) => {
      a.path = rutaArchivo(g, e.marca, a.n, a.ext);
    });
  }
  // Cualquier insert previo llevaba el id que choca → falló entero (un
  // insert de varias filas es atómico): ya no hay nada incierto.
  e.estado.insertSinRespuesta = false;
  reportarError('envios.choqueId', new Error('record_id repetido'), { viejo, nuevo }, viejo);
  return true;
}

/**
 * Pregunta a la base cuáles de nuestros ids pendientes YA existen. Las
 * nuestras se marcan insertadas (el insert llegó y la respuesta se perdió);
 * las ajenas son choque de id y se regenera el id.
 */
async function reconciliar(e: Envio): Promise<void> {
  const falt = faltantes(e);
  if (!falt.length) return;
  const r = await sb
    .from('incidencias')
    .select('record_id,captured_by,fecha_reporte,clave_medio,nombre_incidencia')
    .in(
      'record_id',
      falt.map((f) => f.record_id)
    )
    .retry(false)
    .abortSignal(tope(ESPERA_CONSULTA_MS));
  if (r.error) {
    if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
    // Una consulta que no sale no debe impedir el insert: si hubiera choque
    // o fila nuestra, el insert lo dirá con 23505.
    reportarError('envios.reconciliar', r.error);
    return;
  }
  type Existente = {
    record_id: string;
    captured_by: string | null;
    fecha_reporte: string | null;
    clave_medio: string | null;
    nombre_incidencia: string | null;
  };
  let cambio = false;
  for (const x of (r.data as Existente[] | null) || []) {
    const f = falt.find((y) => y.record_id === x.record_id);
    if (!f) continue;
    if (esNuestra(f, x, e.estado.insertSinRespuesta)) {
      e.estado.insertadas.push(f.record_id);
    } else {
      regenerarId(e, f);
    }
    cambio = true;
  }
  if (cambio) await persistir(e);
}

/**
 * Diferido: quita del envío las filas que ya están en proceso (la regla de
 * duplicidad) y el grupo entero si se queda sin filas. Se avisa cuál y con
 * qué folio. El resto se envía.
 */
function omitirDuplicadas(e: Envio, choques: Duplicada<FilaEnvio>[], avisos: string[]): void {
  const quitar = new Set(choques.map((c) => c.fila.record_id));
  choques.forEach((c) =>
    avisos.push(
      `Se omitió «${c.fila.nombre_incidencia || 'incidencia'}» (cara ${c.fila.clave_medio || '—'}) ` +
        `de ${c.fila.clave_sitio || 'el reporte'}: ya estaba en proceso con folio ${c.folio || '—'}.`
    )
  );
  const quedan: GrupoEnvio[] = [];
  for (const g of e.grupos) {
    g.filas = g.filas.filter((f) => !quitar.has(f.record_id));
    if (g.filas.length) {
      quedan.push(g);
    } else {
      // Sus archivos ya no tienen a quién ligarse: fuera del teléfono. Los
      // del borrador se van con él (cerrarBorradorDe).
      g.archivos.forEach((a) => {
        archivosMem.delete(a.clave);
        if (!a.enBorrador) idbDelete('archivos', a.clave).catch(() => {});
      });
    }
  }
  e.grupos = quedan;
}

type ResInsert =
  | { tipo: 'ok' }
  | { tipo: 'duplicado'; choques: Duplicada<FilaEnvio>[] }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'vacio' };

/**
 * Un intento del paso "insertar". Lanza SinRed si la red falla (el
 * llamador reintenta y este intento vuelve a empezar por reconciliar: el
 * insert anterior pudo haber llegado).
 */
async function intentoInsertar(
  e: Envio,
  op: { interactivo: boolean },
  avisar: (m: string) => void,
  avisos: string[],
  porId: Map<string, Incidencia>
): Promise<ResInsert> {
  await reconciliar(e);
  let dupRevisada = false;
  // Varias vueltas solo por choques de id (regenerar y volver a mandar).
  for (let v = 0; v < 4; v++) {
    if (!faltantes(e).length) return { tipo: 'ok' };

    // ══ REGLA DE DUPLICIDAD ══ (duplicados.ts) ANTES del primer insert.
    // Si alguna fila de este envío ya está en la base, la regla ya corrió
    // cuando se insertó; volver a correrla la haría chocar consigo misma
    // (una fila de Digital fuera de horario nace 'en_proceso').
    if (!e.estado.insertadas.length && !dupRevisada) {
      dupRevisada = true;
      // Con tope, como todos los pasos del envío (revisión primer mes,
      // 24-sep-2026): era el único sin él, y una conexión que abre pero no
      // transmite colgaba la vuelta entera de la cola ("Reintentar" y
      // "Descartar" deshabilitados). Si la consulta no sale por red, es
      // SinRed —se reintenta— y no un "sin choques" que brincaba la regla.
      let choques: Duplicada<FilaEnvio>[] = [];
      try {
        choques = await duplicadasEnProceso(filasDe(e), {
          signal: tope(ESPERA_CONSULTA_MS),
          lanzarSiFalla: true,
        });
      } catch (err) {
        // Una excepción cualquiera la clasifica conReintento, como siempre.
        if (!(err instanceof ErrorConsultaDuplicados)) throw err;
        if (esFallaRedPg(err, err.status)) throw new SinRed(err.message);
        // Definitiva (p. ej. RLS): como siempre, la regla es de mejor
        // esfuerzo y no frena el alta. Queda registrado.
        reportarError('envios.duplicados', err);
      }
      if (choques.length) {
        if (op.interactivo) return { tipo: 'duplicado', choques };
        omitirDuplicadas(e, choques, avisos);
        await persistir(e);
        if (!filasDe(e).length) return { tipo: 'vacio' };
        continue;
      }
    }

    const falt = faltantes(e);
    const habiaIncierto = e.estado.insertSinRespuesta;
    e.estado.insertSinRespuesta = true;
    await persistir(e);
    const r = await sb
      .from('incidencias')
      .insert(falt)
      .select()
      .abortSignal(tope(ESPERA_INSERT_MS));

    if (!r.error) {
      // Un insert de varias filas es atómico: sin error, entraron TODAS,
      // aunque la RLS no deje leer de vuelta alguna.
      e.estado.insertSinRespuesta = false;
      e.estado.insertadas.push(...falt.map((f) => f.record_id));
      const devueltas = (r.data as Incidencia[] | null) ?? [];
      devueltas.forEach((x) => porId.set(x.record_id, x));
      await persistir(e);
      // No basta con que no haya `error`. Si la RLS deja INSERTAR pero no
      // deja LEER de vuelta, PostgREST responde 200 con un arreglo vacío —
      // y `[]` es truthy, así que hay que CONTAR.
      if (devueltas.length !== falt.length) {
        avisar(
          `Se guardaron ${devueltas.length} de ${falt.length} reportes. ` +
            'Refresca con ↻ y verifica en Incidencias antes de volver a capturar, ' +
            'para no duplicar.'
        );
      }
      return { tipo: 'ok' };
    }

    if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);

    if (r.error.code === '23505') {
      // Llave duplicada: o nuestro insert anterior SÍ llegó (carrera entre
      // pestañas, o respuesta perdida), o el id chocó con una fila ajena.
      // Se resuelve preguntando, no como fallo.
      await reconciliar(e);
      if (!faltantes(e).length) continue;
      if (habiaIncierto) {
        // No la vemos (RLS) pero un insert nuestro sin respuesta pudo
        // crearla: se toma como nuestra. Queda registrado por si acaso.
        reportarError('envios.23505', r.error, {
          ids: faltantes(e).map((f) => f.record_id),
        });
        e.estado.insertadas.push(...faltantes(e).map((f) => f.record_id));
        e.estado.insertSinRespuesta = false;
        await persistir(e);
        continue;
      }
      // Choque con una fila ajena que no vemos: se regenera el id culpable
      // (el mensaje de Postgres lo nombra) o, si no se sabe, todos.
      const culpable = /\(record_id\)=\(([^)]+)\)/.exec(r.error.details || '')?.[1];
      const aCambiar = faltantes(e).filter((f) => !culpable || f.record_id === culpable);
      const cambiados = aCambiar.filter((f) => regenerarId(e, f)).length;
      if (!cambiados) return { tipo: 'error', mensaje: r.error.message };
      await persistir(e);
      continue;
    }

    // Definitivo (RLS, CHECK, columna...): la misma carga falla igual, así
    // que ningún intento anterior pudo haber entrado.
    e.estado.insertSinRespuesta = false;
    await persistir(e);
    return { tipo: 'error', mensaje: r.error.message };
  }
  return {
    tipo: 'error',
    mensaje: 'No se pudo asignar un identificador único al reporte. Intenta de nuevo.',
  };
}

/** Lecturas fallidas seguidas de un mismo archivo antes de abandonarlo. */
const MAX_LECTURAS_FALLIDAS = 3;

/**
 * El File de un archivo guardado en el teléfono, para las dos colas
 * (revisión sin señal, 24-sep-2026). null = de verdad no está (no cupo, se
 * borró): quien llama lo abandona. Si IndexedDB FALLA (Safari pierde la
 * conexión al volver de otra app, o se agota el tope) lanza SinLectura y la
 * acción o el envío siguen en cola: antes esa falla pasajera se tomaba como
 * "ya no estaba", la foto se abandonaba para siempre y al terminar se
 * borraba el Blob que sí existía. Tras MAX_LECTURAS_FALLIDAS fallas
 * SEGUIDAS (anotadas en el estado) se abandona, para que un Blob ilegible
 * no atore la cola para siempre.
 */
export async function leerDelTelefono(
  clave: string,
  duenio: { fueraDelTelefono?: string[]; estado: { lecturasFallidas?: Record<string, number> } },
  guardar: () => Promise<void>,
  almacen: AlmacenArchivos = 'archivos'
): Promise<File | null> {
  // No cupo al guardarse: no hay nada que leer.
  if (duenio.fueraDelTelefono?.includes(clave)) return null;
  const est = duenio.estado;
  try {
    const f = await leerArchivoGuardado(clave, almacen);
    if (est.lecturasFallidas?.[clave]) delete est.lecturasFallidas[clave];
    return f;
  } catch (err) {
    const n = (est.lecturasFallidas?.[clave] || 0) + 1;
    if (n >= MAX_LECTURAS_FALLIDAS) {
      reportarError('colas.lecturaLocal', err, { clave, intentos: n });
      return null;
    }
    est.lecturasFallidas = { ...(est.lecturasFallidas || {}), [clave]: n };
    await guardar();
    throw new SinLectura('No se pudo leer un archivo guardado en el teléfono: ' + mensajeDe(err));
  }
}

/** El File de un archivo del envío: el original en memoria o el del teléfono. */
async function archivoDe(e: Envio, a: ArchivoEnvio): Promise<File | null> {
  return archivosMem.get(a.clave) ?? (await leerDelTelefono(a.clave, e, () => persistir(e)));
}

type RespuestaSubida = { error: unknown };

/**
 * Subidas en vuelo, por ruta (revisión sin señal, 24-sep-2026). storage-js
 * no se puede abortar: cuando ganaba el tope, la subida seguía sola y el
 * reintento lanzaba OTRA del mismo archivo en paralelo (hasta 3 por vuelta
 * con un video y señal débil). Ahora el reintento se engancha a la misma.
 * `desde` = cuándo se lanzó: una que lleva más del doble de su tope sin
 * contestar se da por colgada y se lanza otra (ver subir).
 */
const subidasEnVuelo = new Map<string, { p: Promise<RespuestaSubida>; desde: number }>();
/**
 * Rutas que ya quedaron arriba en esta pestaña aunque nadie esperara la
 * respuesta (la subida siguió tras el tope): no se vuelve a mandar el
 * archivo entero solo para oír "ya existe".
 */
const yaArriba = new Set<string>();

/**
 * Sube un archivo. 'ok' incluye "ya existía" (un intento anterior sí llegó).
 * Solo usa la ruta: la cola de acciones también lo usa (lib/acciones.ts).
 * `correo` = dueño del envío o la acción (ver exigirSesion).
 */
export async function subir(
  a: { path: string },
  f: File,
  correo?: string
): Promise<'ok' | { definitivo: unknown }> {
  if (yaArriba.has(a.path)) return 'ok';
  // storage-js no acepta AbortSignal: el tope es una carrera. Si gana el
  // reloj, la subida sigue sola en segundo plano; si termina, cuenta como
  // subida (yaArriba) o el siguiente intento recibe "ya existe".
  const espera = ESPERA_SUBIDA_BASE_MS + Math.ceil(f.size / BYTES_POR_MS_MIN);
  let enVuelo = subidasEnVuelo.get(a.path)?.p;
  // Colgada (verificación de la revisión sin señal, 24-sep-2026): en iOS un
  // fetch puede no resolver NI fallar tras un cambio de red o al volver de
  // segundo plano. Engancharse para siempre a esa promesa dejaba la ruta sin
  // subir hasta recargar la app (y atoraba la cola detrás). Pasado el doble
  // de su tope se lanza otra; una subida lenta de verdad casi nunca llega ahí.
  const colgada = (subidasEnVuelo.get(a.path)?.desde ?? Infinity) < Date.now() - 2 * espera;
  if (!enVuelo || colgada) {
    const p: Promise<RespuestaSubida> = sb.storage
      .from(BUCKET_EVIDENCIAS)
      .upload(a.path, f, { upsert: false, cacheControl: CACHE_INMUTABLE })
      .then(
        (r) => ({ error: r.error }),
        (err: unknown) => ({ error: err })
      );
    subidasEnVuelo.set(a.path, { p, desde: Date.now() });
    void p.then((r) => {
      if (subidasEnVuelo.get(a.path)?.p === p) subidasEnVuelo.delete(a.path);
      if (!r.error || clasificarStorage(r.error) === 'existe') yaArriba.add(a.path);
    });
    enVuelo = p;
  }
  const r = await Promise.race([enVuelo, dormir(espera).then(() => null)]);
  if (r === null) throw new SubidaLenta();
  if (!r.error) return 'ok';
  const c = clasificarStorage(r.error);
  if (c === 'existe') return 'ok';
  if (c === 'red') throw new SinRed(mensajeDe(r.error));
  // Un 400/403 de Storage con la sesión perdida a medio envío no es
  // definitivo: salió como anon (modo sin señal, 24-sep-2026). Si ya no hay
  // sesión (o es de otra cuenta), lanza SinSesion y se reintenta; si la hay,
  // sí es definitivo.
  await exigirSesion(ESPERA_SESION_INTERACTIVA_MS, correo);
  return { definitivo: r.error };
}

/**
 * Registra el archivo en `evidencias` para cada cara de SU grupo. Si ya
 * hubo un intento sin confirmar (o el envío viene de la cola, donde otra
 * corrida pudo dejarlo a medias), primero consulta qué filas ya existen y
 * solo inserta las que faltan. En el primer intento de un Guardar no se
 * consulta: la ruta es nueva y solo este envío la conoce, así que no puede
 * haber nada (una consulta menos por foto con 300 usuarios).
 */
async function ligar(
  e: Envio,
  g: GrupoEnvio,
  a: ArchivoEnvio,
  verificar: boolean
): Promise<'ok' | { definitivo: string }> {
  const ids = g.filas.map((f) => f.record_id);
  let faltan = ids;
  if (verificar || e.estado.ligando.includes(a.path)) {
    const r = await sb
      .from('evidencias')
      .select('record_id')
      .eq('path', a.path)
      .in('record_id', ids)
      .retry(false)
      .abortSignal(tope(ESPERA_CONSULTA_MS));
    if (r.error) {
      if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
      // Si no se puede consultar, se inserta: una evidencia repetida en la
      // galería es mejor que una foto sin ligar.
    } else {
      const ya = new Set(((r.data as { record_id: string }[] | null) || []).map((x) => x.record_id));
      faltan = ids.filter((id) => !ya.has(id));
    }
  }
  if (!faltan.length) return 'ok';
  if (!e.estado.ligando.includes(a.path)) {
    // Se anota ANTES de mandar: si la respuesta se pierde, el siguiente
    // intento sabe que tiene que consultar.
    e.estado.ligando.push(a.path);
    await persistir(e);
  }
  const url = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(a.path).data.publicUrl;
  // `referencia` guarda la cara: es lo que se lee en la galería.
  const evrows = faltan.map((rid) => ({
    record_id: rid,
    etapa: 'reporte',
    tipo: a.tipo,
    url,
    path: a.path,
    subido_por: e.email,
    referencia: g.carasLabel || null,
  }));
  const r = await sb.from('evidencias').insert(evrows).abortSignal(tope(ESPERA_INSERT_MS));
  if (!r.error) return 'ok';
  if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
  return { definitivo: r.error.message };
}

/**
 * Pasos "subir" y "ligar", archivo por archivo, como antes: cada grupo sube
 * SUS archivos y los liga SOLO a sus caras. Un error definitivo en un
 * archivo se avisa y se sigue con el resto (las incidencias ya existen).
 * Lanza SinRed si la red se cae: lo hecho queda persistido.
 * Antes de cada subida y de cada registro se vuelve a revisar que la sesión
 * siga siendo del dueño del envío (revisión sin señal, 24-sep-2026): una
 * subida larga da tiempo a que otra cuenta entre en el mismo teléfono.
 */
async function pasoArchivos(
  e: Envio,
  avisar: (m: string) => void,
  verificar: boolean,
  topeSesion: number | undefined
): Promise<void> {
  for (const g of e.grupos) {
    for (const a of g.archivos) {
      if (e.estado.ligados.includes(a.path) || e.estado.fallidos.includes(a.path)) continue;

      if (!e.estado.subidos.includes(a.path)) {
        const f = await archivoDe(e, a);
        if (!f) {
          // Solo pasa al retomar tras cerrar la app: el archivo no cupo en
          // el teléfono, el navegador borró los datos del sitio o no se pudo
          // leer tres veces seguidas (leerDelTelefono).
          reportarError('envios.archivoPerdido', new Error('archivo no encontrado'), { path: a.path, bytes: a.bytes }, a.path);
          avisar(
            `La incidencia se creó, pero el archivo «${a.nombre}» ya no estaba en el teléfono ` +
              '(no cupo, se borró o no se pudo leer). Súbelo desde la tarjeta con 📎 Evidencia.'
          );
          e.estado.fallidos.push(a.path);
          await persistir(e);
          continue;
        }
        await exigirSesion(topeSesion, e.email);
        const res = await conReintento(() => subir(a, f, e.email));
        if (res !== 'ok') {
          const up = res.definitivo as { message?: string };
          // Las incidencias ya existen: se avisa pero no se aborta el resto.
          // Y queda registrado: con mala señal esto pasa en campo y, sin
          // telemetría, nadie sabía cuántos reportes quedaban sin foto.
          reportarError('crearReporte.subida', up, { path: a.path, tipo: a.tipo, bytes: f.size }, a.path);
          avisar('Se creó, pero falló subir evidencia: ' + (up?.message || mensajeDe(up)));
          e.estado.fallidos.push(a.path);
          await persistir(e);
          continue;
        }
        // La miniatura es la que pintan las tarjetas (de mejor esfuerzo).
        if (a.tipo === 'foto') await subirMiniatura(a.path, f);
        e.estado.subidos.push(a.path);
        await persistir(e);
      }

      await exigirSesion(topeSesion, e.email);
      const lg = await conReintento(() => ligar(e, g, a, verificar));
      if (lg !== 'ok') {
        reportarError('crearReporte.ligar', new Error(lg.definitivo), { path: a.path }, a.path);
        avisar('La incidencia se creó, pero no se pudo registrar una evidencia: ' + lg.definitivo);
        e.estado.fallidos.push(a.path);
        await persistir(e);
        continue;
      }
      e.estado.ligados.push(a.path);
      await persistir(e);
    }
  }
}

/**
 * Las incidencias creadas para quien llama (su tarjeta necesita el folio):
 * lo que devolvió el insert y, para las que se insertaron en un intento
 * anterior sin respuesta, una lectura por record_id. Si la base no deja
 * leer nada, las filas locales: más vale enseñar lo que se mandó que dejar
 * la pantalla en blanco.
 */
async function construirCreadas(
  e: Envio,
  porId: Map<string, Incidencia>,
  consultar: boolean
): Promise<Incidencia[]> {
  const ya = new Set(e.estado.insertadas);
  const filas = filasDe(e).filter((f) => ya.has(f.record_id));
  const faltan = filas.filter((f) => !porId.has(f.record_id));
  if (consultar && faltan.length && !sinSenal()) {
    const r = await sb
      .from('incidencias')
      .select('*')
      .in(
        'record_id',
        faltan.map((f) => f.record_id)
      )
      .retry(false)
      .abortSignal(tope(ESPERA_CONSULTA_MS));
    if (!r.error) ((r.data as Incidencia[] | null) || []).forEach((x) => porId.set(x.record_id, x));
  }
  const leidas = filas.map((f) => porId.get(f.record_id)).filter(Boolean) as Incidencia[];
  return leidas.length ? leidas : (filas as unknown as Incidencia[]);
}

/** Anota por qué sigue en cola. */
async function anotar(e: Envio, error: string): Promise<void> {
  e.ultimoError = error.slice(0, 300);
  await persistir(e);
}

async function ejecutar(e0: Envio, op: { interactivo: boolean }): Promise<ResultadoEnvio> {
  const e = await versionFresca(e0);
  if (!e) return { tipo: 'yaEnviado' };
  memoria.set(e.id, e);

  const avisos: string[] = [];
  const avisar = (m: string) => {
    if (op.interactivo) alert(m);
    else avisos.push(m);
  };
  const porId = new Map<string, Incidencia>();
  const errorPrevio = e.ultimoError;
  const insertadasAntes = e.estado.insertadas.length;
  const nuevas = () => e.estado.insertadas.length - insertadasAntes;
  // Solo el Guardar que acaba de armar el envío es "primera vez": todo lo
  // que sale de la cola pudo quedar a medias y se verifica.
  const verificar = !op.interactivo || e.intentos > 0;
  e.intentos++;

  const pendiente = async (mensaje: string, deRed = true, err?: unknown): Promise<ResultadoEnvio> => {
    // Texto propio para "Último intento" del aviso (revisión primer mes,
    // 24-sep-2026): el mensaje crudo de fetch ("TypeError: Failed to
    // fetch", "signal timed out") sale en inglés y no le dice nada a quien
    // está en campo. El crudo sigue en el resultado, para quien depure.
    await anotar(e, !deRed ? 'Falló por un error de la app; se reintenta solo.' : textoEnCola(err, 'solo'));
    cerrarBorradorSiYaEntro(e);
    const fase = faltantes(e).length ? 'insertar' : 'archivos';
    return {
      tipo: 'sinRed',
      fase,
      creadas: fase === 'archivos' ? await construirCreadas(e, porId, false) : [],
      avisos,
      filasNuevas: nuevas(),
      mensaje,
    };
  };

  try {
    // ── 0. SESIÓN REAL ── (modo sin señal, 24-sep-2026) Sin ella todo sale
    // como anon: una subida a Storage daría 400/403 y la foto se abandonaba
    // como fallo definitivo. Sin sesión es SinRed: sigue en cola. Y la
    // sesión tiene que ser del dueño del envío (revisión sin señal,
    // 24-sep-2026): con otra cuenta abierta, espera a su dueño.
    const topeSesion = op.interactivo ? ESPERA_SESION_INTERACTIVA_MS : undefined;
    await exigirSesion(topeSesion, e.email);

    // ── 1. INSERTAR ──
    if (faltantes(e).length) {
      const r = await conReintento(() => intentoInsertar(e, op, avisar, avisos, porId));
      if (r.tipo === 'duplicado') {
        await quitarEnvio(e.id);
        return r;
      }
      if (r.tipo === 'vacio') {
        await terminarEnvio(e);
        avisos.push('Todo el reporte ya estaba en proceso: no se envió nada nuevo.');
        return { tipo: 'vacio', avisos };
      }
      if (r.tipo === 'error') {
        if (op.interactivo) {
          // El modal sigue abierto para corregir: este envío ya no sirve
          // (el siguiente Guardar arma otro).
          await quitarEnvio(e.id);
        } else {
          // En la cola se queda a la vista con su error: el usuario decide
          // si lo descarta. Se avisa una vez, no en cada vuelta.
          const nuevo = errorPrevio !== r.mensaje.slice(0, 300);
          await anotar(e, r.mensaje);
          if (nuevo) {
            const sitio = filasDe(e)[0]?.clave_sitio || 'un sitio';
            avisos.push(`No se pudo enviar el reporte de ${sitio}: ${r.mensaje}`);
          }
        }
        return { tipo: 'error', mensaje: r.mensaje, avisos };
      }
    }

    // ── 2 y 3. SUBIR Y LIGAR ──
    cerrarBorradorSiYaEntro(e);
    await pasoArchivos(e, avisar, verificar, topeSesion);

    const creadas = op.interactivo ? await construirCreadas(e, porId, true) : [];
    // Completo: se cierra también su borrador, sea esta la pestaña del
    // Guardar u otra que lo retomó de la cola (revisión primer mes,
    // 24-sep-2026). Los 'duplicado' y 'error' interactivos de arriba NO lo
    // cierran: el modal sigue abierto y el borrador todavía sirve.
    await terminarEnvio(e);
    return { tipo: 'completo', creadas, avisos, filasNuevas: nuevas() };
  } catch (err) {
    if (err instanceof SinRed) return await pendiente(err.message, true, err);
    // Error inesperado (de código, no de la base). Si nada llegó a la base
    // y el usuario está esperando, se aborta como un error normal; si algo
    // pudo llegar, se deja en cola: reconciliar lo resuelve sin duplicar.
    reportarError('envios.ejecutar', err);
    if (op.interactivo && !e.estado.insertadas.length && !e.estado.insertSinRespuesta) {
      await quitarEnvio(e.id);
      return { tipo: 'error', mensaje: mensajeDe(err), avisos };
    }
    return await pendiente(mensajeDe(err), false);
  } finally {
    // Terminado ya salió; pendiente con copia en el teléfono: la verdad es
    // IndexedDB (otra pestaña puede avanzarlo). Solo-memoria se conserva.
    if (!soloMemoria.has(e.id)) memoria.delete(e.id);
  }
}
