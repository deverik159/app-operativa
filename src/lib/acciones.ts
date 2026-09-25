// ============================================================
// src/lib/acciones.ts
// La COLA DE ACCIONES de validación y reparación: se aplican con señal y,
// sin ella, se quedan en el teléfono y se mandan solas al volver la red.
//
// POR QUÉ (modo sin señal, 24-sep-2026). Erik probó en iPhone: sin señal,
// validar o reparar daba "No se pudo actualizar: TypeError: Load failed" y
// lo hecho en campo se perdía. Y con red parcial (el PATCH llegó pero la
// respuesta no) el reintento veía 0 filas y avisaba en falso "ya la atendió
// otra persona". Ahora cada acción es un registro FIJADO UNA VEZ al tocar el
// botón (id, parche con validator_at / repaired_at del teléfono, estatus que
// el usuario veía, rutas de las fotos) que se guarda en IndexedDB ANTES de
// mandar nada, y mandarlo es repetible:
//   · el UPDATE lleva precondición (el estatus visto y, si aplica, la MISMA
//     reparación): si alguien más ya la movió, NO se pisa;
//   · si da 0 filas se relee la fila: si trae NUESTRA marca (mismo
//     validator_at/repaired_at por instante y mismo correo, o el mismo
//     motivo) el intento anterior sí llegó → hecha; si el estatus es otro →
//     conflicto (se avisa); si sigue igual → la RLS no lo permite;
//   · la reparación sube primero sus fotos a rutas FIJAS (upsert apagado,
//     "ya existe" = subida) y las liga en `evidencias` consultando antes,
//     igual que la cola de reportes (lib/envios.ts), y al final el UPDATE.
//
// Revisión sin señal (24-sep-2026), lo que cambió y por qué:
//   · La ruta de cada foto sale de una HUELLA DE SU CONTENIDO (SHA-256), no
//     de la acción: si el Guardar falla después de ligar fotos (sin permiso,
//     error) y el técnico vuelve a tocarlo con las mismas, caen en la MISMA
//     ruta, ya están ligadas y no se duplican. Ver rutaReparacion.
//   · Antes de subir la primera foto se relee la incidencia: si otra persona
//     ya la movió, no se pega evidencia a una reparación ajena.
//   · La sesión tiene que ser del DUEÑO de la acción y se revisa antes de
//     cada paso largo: en un teléfono compartido, lo de A no sale como B.
//   · Una acción detrás de otra de la misma incidencia que sigue en cola (o
//     con error) espera; el botón ya no la manda en línea (el modal se
//     quedaba hasta ~70 s en "Guardando…"): sale en segundo plano.
//   · Al quedar hecha se marcan leídos los avisos de la campana de esa
//     incidencia, también cuando sale sola de la cola.
//
// Contrato con la vista (frente 4b, modo sin señal): ejecutarAccion,
// accionesPendientes (para superponer lo pendiente en la lista),
// suscribirAcciones, procesarAccionesPendientes y descartarAccion. El aviso
// global (components/EnviosPendientes) procesa esta cola junto con la de
// reportes, con los mismos disparadores.
//
// Reglas que se heredan de lib/envios.ts: nada sale sin sesión real
// (exigirSesion), reintento solo por red, candado por acción entre pestañas
// (Web Locks 'accion-<id>'), y si IndexedDB no está o no cabe, la acción
// sigue en memoria (el aviso lo dice y la recarga automática se retiene).
// Base propia 'gpo-acciones' (lib/idb.ts): almacén 'acciones' y sus
// archivos en 'archivos_acciones' con llave 'a:<acción>:<n>'. Va aparte de
// 'gpo-capturas' para que esa base no suba de versión: revertir en Vercel a
// un build de antes de este módulo no deja sin cola de reportes a nadie
// (ver la cabecera de lib/idb.ts antes de revertir).
// ============================================================
import { sb } from './supabase';
import { BUCKET_EVIDENCIAS, subirMiniatura } from './storage';
import { reportarError } from './reportarError';
import { retenerRecargaAutomatica } from './cargaDiferida';
import { EST_LABEL } from './constants';
import {
  ErrorIdb,
  idbGet,
  idbGetAll,
  idbPut,
  idbTx,
  rangoPrefijo,
  registroDeArchivo,
  registroEnBytes,
  topeEscrituraArchivo,
  type RegistroArchivo,
} from './idb';
import {
  ESPERA_SESION_INTERACTIVA_MS,
  SinRed,
  SinSesion,
  SubidaLenta,
  conCandado,
  dormir,
  esExcepcionDeRed,
  esFallaRedPg,
  exigirSesion,
  instante,
  leerDelTelefono,
  mensajeDe,
  nuevoIdEnvio,
  registrarRiesgoExtra,
  sinSenal,
  subir,
  textoEnCola,
  tope,
} from './envios';
import type { EstatusInc, Incidencia, TipoEvidencia } from '../types/db';

// ------------------------------------------------------------
// Tipos (CONTRATO B)
// ------------------------------------------------------------

export type ClaseAccion =
  | 'validar'
  | 'aprobar_reparacion'
  | 'rechazar_reparacion'
  | 'prevalidar'
  | 'descartar_prevalidacion'
  | 'reparacion';

export type AccionNueva = {
  clase: ClaseAccion;
  record_id: string;
  folio: string | null;
  /** Texto para el aviso, p. ej. "Validar EV00012 · MX_CM_EV_3299". */
  resumen: string;
  /** Precondición: el estatus que el usuario VE. */
  esperado: EstatusInc;
  /**
   * Precondición extra: aprobar/rechazar (la MISMA reparación) y
   * 'reparacion' (no caer sobre otra hecha mientras tanto). undefined = no
   * se exige; null = se exige que siga sin reparación.
   */
  repairedAtVisto?: string | null;
  /**
   * Precondición extra (revisión sin señal, 24-sep-2026): el validator_at
   * que el usuario VE (null = sin validar). La piden validar, prevalidar y
   * descartar: el estatus solo no basta, porque el ciclo por_validar →
   * en_proceso → rechazada → por_validar (el reportante corrigió) regresa al
   * mismo estatus y una validación vieja en cola caía sobre un reporte
   * corregido que nadie vio. undefined = no se exige.
   */
  validatorAtVisto?: string | null;
  /** Fijado UNA vez (validator_at, repaired_at… con la hora del teléfono). */
  patch: Partial<Incidencia>;
  /** Solo 'reparacion': fotos/videos YA preparados (comprimidos). */
  archivos?: File[];
  /** Para nombrar como hoy: RECORD_ID/FOLIO_CARA_AAAA-MM-DD_reparacion_MARCA_N.EXT */
  nombreArchivo?: { folio: string | null; cara: string | null };
};

export type ResultadoAccion =
  | { tipo: 'hecha'; fila: Incidencia | null; aviso?: string }
  | { tipo: 'enCola' }
  | { tipo: 'conflicto'; fila: Incidencia | null; mensaje: string }
  | { tipo: 'sinPermiso'; mensaje: string }
  | { tipo: 'error'; mensaje: string };

export type AccionPendiente = {
  id: string;
  record_id: string;
  clase: ClaseAccion;
  patch: Partial<Incidencia>;
  creado_en: string;
  resumen: string;
  ultimoError: string | null;
  /**
   * El último intento dio un error que no es de red: NO se enviará sola
   * hasta que se descarte (revisión sin señal, 24-sep-2026). La vista no
   * debe superponerla ni prometer "se envía sola".
   */
  conError: boolean;
};

/** Lo que el aviso global pinta de cada acción (además del contrato). */
export type ResumenAccion = AccionPendiente & {
  folio: string | null;
  enviando: boolean;
  /** No quedó en el teléfono: cerrar la app la pierde. */
  soloMemoria: boolean;
  /** Fotos/videos que no cupieron en el teléfono. */
  fueraDelTelefono: number;
  archivos: number;
  /** Fotos/videos ya registrados en la evidencia de la incidencia. */
  ligados: number;
};

// ------------------------------------------------------------
// Registro guardado
// ------------------------------------------------------------

/** Un archivo de la reparación. El Blob vive aparte (almacén `archivos`). */
type ArchivoAccion = {
  /** 'a:<acción>:<n>' */
  clave: string;
  /** Ruta FIJA en Storage: se decide una vez y no cambia al reintentar. */
  path: string;
  n: number;
  nombre: string;
  bytes: number;
  tipo: TipoEvidencia;
};

type Accion = {
  v: 1;
  id: string;
  /** Solo la sesión de este correo la procesa y la ve. */
  email: string;
  creado_en: string;
  actualizado_en: string;
  clase: ClaseAccion;
  record_id: string;
  folio: string | null;
  resumen: string;
  esperado: EstatusInc;
  /**
   * Se exige la misma reparación. Va aparte de `repairedAtVisto` porque
   * "no se exige" (undefined) y "sin reparación" (null) no deben
   * confundirse al guardar y releer.
   */
  exigeReparacion: boolean;
  repairedAtVisto: string | null;
  /** Se exige el mismo validator_at que se vio (ver AccionNueva.validatorAtVisto). */
  exigeValidacion?: boolean;
  validatorAtVisto?: string | null;
  patch: Partial<Incidencia>;
  archivos: ArchivoAccion[];
  estado: {
    /** Rutas ya subidas a Storage. */
    subidos: string[];
    /** Rutas cuyo registro en `evidencias` quedó confirmado. */
    ligados: string[];
    /** Rutas cuyo registro se mandó sin confirmación (se consulta antes). */
    ligando: string[];
    /** Rutas abandonadas (no estaban en el teléfono o error definitivo). */
    fallidos: string[];
    /** Lecturas del teléfono que fallaron seguidas, por clave (ver leerDelTelefono). */
    lecturasFallidas?: Record<string, number>;
  };
  intentos: number;
  ultimoError: string | null;
  conError: boolean;
  /** Claves de archivos que NO cupieron en el teléfono (solo en memoria). */
  fueraDelTelefono: string[];
};

/** Lo que devuelve un procesamiento (lo público más dos casos internos). */
type ResultadoInterno =
  | ResultadoAccion
  | { tipo: 'ocupado' }
  | { tipo: 'yaHecha' };

// ------------------------------------------------------------
// Tiempos (mismos que lib/envios.ts; el Guardar que se espera, más corto)
// ------------------------------------------------------------

/** Esperas entre intentos por falla de red: 3 intentos en la cola. */
const ESPERAS_MS = [1500, 4000];
/** En el botón que el usuario espera: 2 intentos y a la cola. */
const ESPERAS_INTERACTIVO_MS = [1500];
/** Tope de una consulta chica (releer la fila, existencia de evidencias). */
const ESPERA_CONSULTA_MS = 12000;
/** Tope de un UPDATE/INSERT: se aborta y se trata como incierto (se relee). */
const ESPERA_ESCRITURA_MS = 20000;
const ESPERA_ESCRITURA_INTERACTIVA_MS = 10000;
/** Tope de una escritura de estado en IndexedDB (metadatos). */
const ESPERA_ESTADO_MS = 5000;

const SIN_PERMISO = 'No se guardó: tu rol o tu área no permiten este cambio en esta incidencia.';
const SIN_CLASIFICACION =
  'La reparación se guardó, pero Supabase no devolvió la clasificación técnica de Digital. ' +
  'Recarga y revisa esta incidencia antes de continuar.';

// ------------------------------------------------------------
// Estado de la pestaña
// ------------------------------------------------------------

/** Acciones en proceso ahora y las que NO se pudieron guardar en el teléfono. */
const memoria = new Map<string, Accion>();
/** Los File originales por clave: preferibles a leerlos de IndexedDB. */
const archivosMem = new Map<string, File>();
const soloMemoria = new Set<string>();
const conArchivosFuera = new Set<string>();
const enCurso = new Map<string, Promise<ResultadoInterno>>();
/** Las que el usuario está esperando en su pantalla (el aviso no las pinta). */
const interactivos = new Set<string>();
/** Descartadas: ninguna escritura tardía debe resucitarlas. */
const descartadas = new Set<string>();
/**
 * Avisos de acciones que se procesaron por su cuenta (p. ej. una previa de
 * la misma incidencia antes de la que se acaba de tocar). El aviso global
 * los recoge con tomarAvisosAcciones(). Llevan su correo (revisión sin
 * señal, 24-sep-2026): en un teléfono compartido, B no debe ver los de A.
 */
const buzon: { email: string; texto: string }[] = [];

const bus: EventTarget | null = typeof EventTarget !== 'undefined' ? new EventTarget() : null;
let canal: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    canal = new BroadcastChannel('gpo-acciones');
    canal.onmessage = () => emitir(true);
  }
} catch {
  canal = null;
}

/** Lo que se perdería al recargar: solo en memoria, archivos fuera o en curso. */
function accionesEnRiesgo(): boolean {
  return soloMemoria.size > 0 || conArchivosFuera.size > 0 || enCurso.size > 0;
}

// "Actualizar ahora" / "Recargar la app" también preguntan por estas
// (confirmarRecargaConEnvios en lib/envios.ts).
registrarRiesgoExtra(accionesEnRiesgo, 'una validación o reparación');

/** Retención propia de la recarga automática por chunk viejo (lib/cargaDiferida). */
let soltarRetencion: (() => void) | null = null;
function sincronizarRetencion(): void {
  const riesgo = accionesEnRiesgo();
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

/** Se llama cada vez que la cola de acciones cambia (aquí o en otra pestaña). */
export function suscribirAcciones(cb: () => void): () => void {
  if (!bus) return () => {};
  const h = () => cb();
  bus.addEventListener('cambio', h);
  return () => bus.removeEventListener('cambio', h);
}

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();

/**
 * Los avisos que quedaron en el buzón para este correo (se entregan una
 * vez). Sin correo, todos (solo para pruebas).
 */
export function tomarAvisosAcciones(email?: string): string[] {
  const em = norm(email);
  const mios: string[] = [];
  for (let i = 0; i < buzon.length; ) {
    if (!em || buzon[i].email === em) mios.push(buzon.splice(i, 1)[0].texto);
    else i++;
  }
  return mios;
}

// ------------------------------------------------------------
// Ayudantes
// ------------------------------------------------------------

/** ¿Mismo instante? (la base responde '+00:00' donde se mandó 'Z'). null = null. */
function mismoInstante(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return instante(a) === instante(b);
}

const ETIQUETA: Record<ClaseAccion, string> = {
  validar: 'La validación',
  aprobar_reparacion: 'La aprobación de la reparación',
  rechazar_reparacion: 'El rechazo de la reparación',
  prevalidar: 'La prevalidación',
  descartar_prevalidacion: 'El descarte',
  reparacion: 'La reparación',
};

const refDe = (a: { folio: string | null; record_id: string }) => a.folio || a.record_id;

/** Los mensajes de Postgres/Storage no traen punto final: se les pone para encadenarlos. */
const conPunto = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : s.trim() + '.');

/** "No se pudo…" → "no se pudo…" para ir después de dos puntos (no toca siglas). */
const trasDosPuntos = (s: string) =>
  /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;

/**
 * Repite `fn` mientras falle por RED (como conReintento de lib/envios.ts,
 * con esperas propias). Sin sesión no se insiste: el enfriamiento de
 * auth-js dura ~60 s y reintentar en segundos solo gasta batería. Una subida
 * lenta tampoco: sigue en segundo plano (ver SubidaLenta en lib/envios.ts).
 */
async function reintentar<T>(fn: () => Promise<T>, esperas: number[]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SinSesion || err instanceof SubidaLenta || !esExcepcionDeRed(err)) throw err;
      const sr = err instanceof SinRed ? err : new SinRed(mensajeDe(err));
      if (i >= esperas.length || sinSenal()) throw sr;
      await dormir(esperas[i]);
    }
  }
}

/**
 * El parche con lo que cada clase TIENE que llevar. Lo que ya viene fijado
 * (validator_at, repaired_at…) se respeta; si faltara, se fija aquí, UNA
 * vez: de eso depende reconocer al releer que un intento sí llegó.
 */
function normalizarPatch(
  clase: ClaseAccion,
  p: Partial<Incidencia>,
  email: string,
  ahora: string
): Partial<Incidencia> {
  const x: Partial<Incidencia> = { ...p };
  switch (clase) {
    case 'validar':
      x.estatus = 'en_proceso';
      x.validator_approved = true;
      x.validator_email = x.validator_email || email;
      x.validator_at = x.validator_at || ahora;
      break;
    case 'aprobar_reparacion':
      x.estatus = 'cerrada';
      break;
    case 'rechazar_reparacion':
      x.estatus = 'en_proceso';
      break;
    case 'prevalidar':
      x.prevalidada = true;
      break;
    case 'descartar_prevalidacion':
      x.estatus = 'rechazada';
      x.prevalidada = false;
      break;
    case 'reparacion':
      x.estatus = 'reparado';
      x.repaired_by_email = x.repaired_by_email || email;
      x.repaired_at = x.repaired_at || ahora;
      break;
  }
  return x;
}

/** Hasta este tamaño la huella lee el archivo entero (las fotos ya comprimidas pesan < 1 MB). */
const HUELLA_COMPLETA_MAX = 8 * 1024 * 1024;
/** Arriba de eso (videos), el primer MB más el tamaño: leer 40 MB en un iPhone no vale la pena. */
const HUELLA_TROZO = 1024 * 1024;

/**
 * Huella del CONTENIDO de un archivo (SHA-256 del tamaño y los bytes; 16
 * hex) para nombrarlo en Storage (revisión sin señal, 24-sep-2026). null si
 * no hay crypto.subtle (fuera de HTTPS) o la lectura falla: entonces se
 * nombra con la marca de la acción, como antes.
 */
async function huella(f: Blob): Promise<string | null> {
  try {
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
    if (!subtle) return null;
    const trozo = f.size > HUELLA_COMPLETA_MAX ? f.slice(0, HUELLA_TROZO) : f;
    const datos = await new Blob([`${f.size}:`, trozo]).arrayBuffer();
    const h = new Uint8Array(await subtle.digest('SHA-256', datos));
    return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Ruta de Storage de un archivo de la reparación. MISMA FORMA que
 * RepararModal (el folio abre el nombre: el archivo se comparte por su URL),
 * pero el final ya no es Date.now() en cada intento sino un `sello` FIJO.
 *
 * El sello es la huella del contenido (revisión sin señal, 24-sep-2026). Con
 * `marca` y `n` de la acción, el reintento de la MISMA acción caía en el
 * mismo lugar, pero no el de otra: si el Guardar daba "sin permiso" o un
 * error después de ligar fotos, la acción salía de la cola, el modal seguía
 * abierto con los mismos archivos y el siguiente Guardar armaba otra acción
 * con otra marca: subía y ligaba las mismas fotos otra vez. Con la huella,
 * la misma foto cae en la misma ruta en cualquier reintento o acción:
 * pasoReparacion la encuentra ya ligada y no la vuelve a subir ni a
 * registrar. La fecha también sale del archivo (su lastModified, que la
 * compresión conserva) y no del Guardar: un reintento a las 18:00 de México
 * (medianoche UTC) ya no cambia el nombre. Sin huella (navegador sin
 * crypto.subtle), el sello es marca_n, como antes.
 */
function rutaReparacion(
  recordId: string,
  nombre: { folio: string | null; cara: string | null },
  fecha: string,
  sello: string,
  f: File,
  tipo: TipoEvidencia
): string {
  const folio = (nombre.folio || '').trim();
  const cara = (nombre.cara || '').trim() || 'sitio';
  const m = /\.([a-z0-9]{1,8})$/i.exec(f.name || '');
  const ext = (m ? m[1] : tipo === 'video' ? 'mp4' : 'jpg').toLowerCase();
  const archivo = `${folio ? folio + '_' : ''}${cara}_${fecha}_reparacion_${sello}.${ext}`.replace(
    /[^\w.\-]/g,
    '_'
  );
  return `${recordId}/${archivo}`;
}

/** AAAA-MM-DD del archivo (su lastModified); si no trae, la del respaldo. */
function fechaDeArchivo(f: File, respaldo: string): string {
  const t = f.lastModified;
  if (!t || !Number.isFinite(t)) return respaldo;
  const d = new Date(t);
  return isNaN(d.getTime()) ? respaldo : d.toISOString().slice(0, 10);
}

async function armarAccion(email: string, an: AccionNueva, archivos: Map<string, File>): Promise<Accion> {
  const id = nuevoIdEnvio();
  const ahora = new Date().toISOString();
  const marca = Date.now();
  const patch = normalizarPatch(an.clase, an.patch || {}, email, ahora);
  const fecha = (patch.repaired_at || ahora).slice(0, 10);
  const nombre = an.nombreArchivo ?? { folio: an.folio, cara: null };
  const lista: ArchivoAccion[] = [];
  if (an.clase === 'reparacion') {
    const vistas = new Set<string>();
    for (const f of an.archivos || []) {
      const h = await huella(f);
      // La misma foto elegida dos veces se sube y se registra una vez.
      if (h && vistas.has(h)) continue;
      if (h) vistas.add(h);
      const n = lista.length + 1;
      const tipo: TipoEvidencia = (f.type || '').startsWith('video') ? 'video' : 'foto';
      const clave = `a:${id}:${n}`;
      archivos.set(clave, f);
      lista.push({
        clave,
        path: rutaReparacion(an.record_id, nombre, fechaDeArchivo(f, fecha), h ?? `${marca}_${n}`, f, tipo),
        n,
        nombre: f.name || `archivo ${n}`,
        bytes: f.size,
        tipo,
      });
    }
  }
  return {
    v: 1,
    id,
    email,
    creado_en: ahora,
    actualizado_en: ahora,
    clase: an.clase,
    record_id: an.record_id,
    folio: an.folio ?? null,
    resumen: an.resumen || `${ETIQUETA[an.clase]} de ${an.folio || an.record_id}`,
    esperado: an.esperado,
    exigeReparacion: an.repairedAtVisto !== undefined,
    repairedAtVisto: an.repairedAtVisto ?? null,
    exigeValidacion: an.validatorAtVisto !== undefined,
    validatorAtVisto: an.validatorAtVisto ?? null,
    patch,
    archivos: lista,
    estado: { subidos: [], ligados: [], ligando: [], fallidos: [] },
    intentos: 0,
    ultimoError: null,
    conError: false,
    fueraDelTelefono: [],
  };
}

// ------------------------------------------------------------
// Persistencia
// ------------------------------------------------------------

/** Guarda el avance; si IndexedDB falla se sigue con lo de memoria. */
async function persistir(a: Accion): Promise<void> {
  a.actualizado_en = new Date().toISOString();
  if (descartadas.has(a.id)) return;
  if (!soloMemoria.has(a.id)) {
    try {
      await idbPut('acciones', a, ESPERA_ESTADO_MS);
    } catch {
      /* se sigue en memoria */
    }
  }
  emitir();
}

async function anotar(a: Accion, error: string, conError: boolean): Promise<void> {
  a.ultimoError = error.slice(0, 300);
  a.conError = conError;
  await persistir(a);
}

/**
 * Guarda una acción recién armada ANTES de mandar nada. Registro y
 * archivos en UNA transacción; si no cabe todo, la misma escalera que la
 * cola de reportes (guardarEnvioNuevo): sin videos → fotos como bytes →
 * solo el registro → solo memoria. Lo que no cupo queda anotado.
 */
async function guardarNueva(a: Accion, archivos: Map<string, File>): Promise<void> {
  archivos.forEach((f, k) => archivosMem.set(k, f));
  memoria.set(a.id, a);

  const intentar = async (registros: RegistroArchivo[]): Promise<boolean> => {
    const guardados = new Set(registros.map((r) => r.clave));
    a.fueraDelTelefono = a.archivos.filter((x) => !guardados.has(x.clave)).map((x) => x.clave);
    const bytes = registros.reduce((s, r) => s + r.bytes, 0);
    try {
      await idbTx(
        ['acciones', 'archivos_acciones'],
        'readwrite',
        (tx) => {
          const alm = tx.objectStore('archivos_acciones');
          registros.forEach((r) => alm.put(r));
          tx.objectStore('acciones').put(a);
        },
        topeEscrituraArchivo(bytes)
      );
      return true;
    } catch (err) {
      // Base ausente o colgada: otro intento solo retrasaría el botón.
      if (err instanceof ErrorIdb && (err.motivo === 'no-disponible' || err.motivo === 'tope'))
        throw err;
      return false;
    }
  };
  const deFile = (x: ArchivoAccion) => archivos.get(x.clave);
  const comoBlob = (xs: ArchivoAccion[]) =>
    xs
      .map((x) => {
        const f = deFile(x);
        return f ? registroDeArchivo(x.clave, f) : null;
      })
      .filter(Boolean) as RegistroArchivo[];

  let enTelefono = false;
  try {
    if (await intentar(comoBlob(a.archivos))) enTelefono = true;
    else {
      const fotos = a.archivos.filter((x) => x.tipo === 'foto');
      const fotosBlob = comoBlob(fotos);
      if (fotosBlob.length && fotos.length < a.archivos.length && (await intentar(fotosBlob)))
        enTelefono = true;
      else {
        const fotosBytes = (
          await Promise.all(
            fotos.map((x) => {
              const f = deFile(x);
              return f ? registroEnBytes(x.clave, f) : Promise.resolve(null);
            })
          )
        ).filter(Boolean) as RegistroArchivo[];
        if (fotosBytes.length && (await intentar(fotosBytes))) enTelefono = true;
        else if (await intentar([])) enTelefono = true;
      }
    }
  } catch {
    /* IndexedDB no disponible: cae a memoria */
  }

  if (!enTelefono) {
    soloMemoria.add(a.id);
    a.fueraDelTelefono = a.archivos.map((x) => x.clave);
    reportarError('acciones.idb', new Error('acción solo en memoria'), {
      clase: a.clase,
      archivos: a.archivos.length,
    });
  } else {
    soloMemoria.delete(a.id);
    if (a.fueraDelTelefono.length) conArchivosFuera.add(a.id);
  }
  emitir();
}

/** Todas las acciones de este correo (teléfono + memoria), de la más vieja a la más nueva. */
async function listarTodas(email: string): Promise<Accion[]> {
  const porId = new Map<string, Accion>();
  try {
    (await idbGetAll<Accion>('acciones')).forEach((a) => porId.set(a.id, a));
  } catch {
    /* sin IndexedDB: solo lo de memoria */
  }
  memoria.forEach((a, id) => porId.set(id, a));
  const em = norm(email);
  return [...porId.values()]
    .filter((a) => a && a.v === 1 && norm(a.email) === em && !descartadas.has(a.id))
    .sort((x, y) => x.creado_en.localeCompare(y.creado_en));
}

/**
 * Las acciones de este correo que aún no se aplican, en orden de creación
 * (incluye la que el usuario esté esperando): para superponer sus parches
 * en la lista mientras tanto, así un ↻ no "regresa" la tarjeta.
 */
export async function accionesPendientes(email: string): Promise<AccionPendiente[]> {
  return (await listarTodas(email)).map((a) => ({
    id: a.id,
    record_id: a.record_id,
    clase: a.clase,
    patch: a.patch,
    creado_en: a.creado_en,
    resumen: a.resumen,
    ultimoError: a.ultimoError,
    conError: !!a.conError,
  }));
}

/** Lo que pinta el aviso global: sin las que el usuario está esperando. */
export async function listarAccionesAviso(email: string): Promise<ResumenAccion[]> {
  return (await listarTodas(email))
    .filter((a) => !interactivos.has(a.id))
    .map((a) => ({
      id: a.id,
      record_id: a.record_id,
      clase: a.clase,
      patch: a.patch,
      creado_en: a.creado_en,
      resumen: a.resumen,
      ultimoError: a.ultimoError,
      folio: a.folio,
      enviando: enCurso.has(a.id),
      soloMemoria: soloMemoria.has(a.id),
      fueraDelTelefono: a.fueraDelTelefono?.length || 0,
      archivos: a.archivos.length,
      ligados: a.estado.ligados.length,
      conError: !!a.conError,
    }));
}

/** Saca una acción de la cola con sus archivos (aplicada, en conflicto o descartada). */
async function quitarAccion(id: string): Promise<void> {
  const soloMem = soloMemoria.has(id);
  memoria.delete(id);
  soloMemoria.delete(id);
  conArchivosFuera.delete(id);
  const prefijo = `a:${id}:`;
  [...archivosMem.keys()].forEach((k) => {
    if (k.startsWith(prefijo)) archivosMem.delete(k);
  });
  // Una sola transacción: no quedan Blobs huérfanos de un registro borrado.
  const borrado = idbTx(['acciones', 'archivos_acciones'], 'readwrite', (tx) => {
    tx.objectStore('acciones').delete(id);
    tx.objectStore('archivos_acciones').delete(rangoPrefijo(prefijo));
  }).catch(() => {
    /* sin IndexedDB no había nada guardado */
  });
  if (!soloMem) await borrado;
  emitir();
}

/**
 * El usuario descarta una acción desde el aviso: NO se aplicará. Si se
 * está mandando (aquí o en otra pestaña) no se toca: 'ocupado'.
 */
export async function descartarAccion(id: string): Promise<'ok' | 'ocupado'> {
  if (enCurso.has(id)) return 'ocupado';
  return conCandado<'ok' | 'ocupado'>(
    id,
    async () => {
      descartadas.add(id);
      await quitarAccion(id);
      return 'ok' as const;
    },
    'ocupado' as const,
    'accion-'
  );
}

/**
 * La versión más fresca de una acción, ya DENTRO del candado: otra pestaña
 * pudo avanzarla o terminarla. null = ya no existe.
 */
async function versionFresca(a0: Accion): Promise<Accion | null> {
  if (descartadas.has(a0.id)) return null;
  const mem = memoria.get(a0.id);
  if (mem) return mem;
  if (soloMemoria.has(a0.id)) return a0;
  try {
    return (await idbGet<Accion>('acciones', a0.id)) ?? null;
  } catch {
    return a0;
  }
}

// ------------------------------------------------------------
// Lecturas y reconciliación
// ------------------------------------------------------------

/** La fila como está en la base; null si no se ve (RLS). */
async function releer(recordId: string): Promise<Incidencia | null> {
  const r = await sb
    .from('incidencias')
    .select('*')
    .eq('record_id', recordId)
    .limit(1)
    .retry(false)
    .abortSignal(tope(ESPERA_CONSULTA_MS));
  if (r.error) {
    if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
    throw new Error('No se pudo releer la incidencia: ' + r.error.message);
  }
  return ((r.data as Incidencia[] | null) || [])[0] ?? null;
}

/**
 * ¿La fila ya trae el resultado de ESTA acción? (un intento anterior sí llegó)
 *
 * Validar, reparar y prevalidar se reconocen por su marca SIN exigir el
 * estatus destino (revisión sin señal, 24-sep-2026): si el intento llegó,
 * se perdió la respuesta y alguien más movió la incidencia antes del
 * reintento (el técnico ya reparó lo validado, el validador ya aprobó o
 * rechazó la reparación), el aviso decía en falso "no se aplicó: ya la
 * atendió otra persona" y el técnico repetía un trabajo que sí quedó. La
 * marca (validator_at / repaired_at al instante, con su correo) solo pudo
 * ponerla esta acción, y un rechazo no limpia repaired_at.
 */
function yaAplicada(a: Accion, x: Incidencia): boolean {
  const mismaRep = !a.exigeReparacion || mismoInstante(x.repaired_at, a.repairedAtVisto);
  const mismoMotivo = (x.motivo_rechazo_reparacion || '') === (a.patch.motivo_rechazo_reparacion || '');
  switch (a.clase) {
    case 'validar':
      return (
        mismoInstante(x.validator_at, a.patch.validator_at) &&
        norm(x.validator_email) === norm(a.patch.validator_email)
      );
    case 'aprobar_reparacion':
      // No hay columna de quién cerró: cerrada con la MISMA reparación es el
      // mismo resultado, la haya cerrado este intento u otro validador.
      return x.estatus === 'cerrada' && mismaRep;
    case 'rechazar_reparacion':
      // El trigger inc_cuenta_rechazo contó una sola vez: la precondición
      // (reparado + misma reparación) ya no deja que se repita.
      return x.estatus === 'en_proceso' && mismoMotivo && mismaRep;
    case 'prevalidar':
      // Prevalidada es prevalidada, aunque el estatus ya haya avanzado
      // (la reparación pudo registrarse detrás).
      return x.prevalidada === true;
    case 'descartar_prevalidacion':
      return x.estatus === 'rechazada' && mismoMotivo;
    case 'reparacion':
      return (
        mismoInstante(x.repaired_at, a.patch.repaired_at) &&
        norm(x.repaired_by_email) === norm(a.patch.repaired_by_email)
      );
  }
}

/** Por qué no aplica (otra persona la movió); null = no es conflicto. */
function conflictoDe(a: Accion, x: Incidencia): { mensaje: string; corto: string } | null {
  if (x.estatus !== a.esperado) {
    const est = EST_LABEL[x.estatus] || x.estatus;
    return {
      mensaje: `Esta incidencia ya la atendió otra persona: ahora está en "${est}".`,
      corto: `ya la había atendido otra persona (ahora está en «${est}»).`,
    };
  }
  if (a.exigeReparacion && !mismoInstante(x.repaired_at, a.repairedAtVisto)) {
    return a.clase === 'reparacion'
      ? {
          mensaje:
            'Otra persona registró una reparación de esta incidencia mientras tanto. ' +
            'Revisa la incidencia antes de volver a registrarla.',
          corto: 'otra persona registró una reparación mientras tanto.',
        }
      : {
          mensaje:
            'Esta reparación cambió mientras la revisabas (la rechazaron y el técnico la ' +
            'volvió a reparar). Revisa la reparación nueva antes de decidir.',
          corto: 'la reparación cambió mientras tanto (la rechazaron y la volvieron a reparar).',
        };
  }
  // Mismo estatus, pero ya es OTRA vuelta del ciclo (revisión sin señal,
  // 24-sep-2026): alguien la validó, se descartó y el reportante la corrigió
  // (EditModal la regresa a 'por_validar'). Sin esta rama, el 0 filas con el
  // mismo estatus caía en "sin permiso".
  if (a.exigeValidacion && !mismoInstante(x.validator_at, a.validatorAtVisto))
    return {
      mensaje:
        'Esta incidencia se volvió a validar o se corrigió mientras tanto. ' +
        'Revisa la versión nueva antes de continuar.',
      corto: 'se volvió a validar o se corrigió mientras tanto.',
    };
  if (a.clase === 'prevalidar' && !x.requiere_prevalidacion)
    return {
      mensaje: 'Esta incidencia ya no requiere prevalidación.',
      corto: 'ya no requiere prevalidación.',
    };
  if (a.clase === 'descartar_prevalidacion' && x.prevalidada)
    return {
      mensaje: 'Esta incidencia ya la prevalidó otra persona.',
      corto: 'ya la había prevalidado otra persona.',
    };
  return null;
}

type ResultadoConCorto = ResultadoAccion & { corto?: string };

const RES_SIN_PERMISO: ResultadoConCorto = {
  tipo: 'sinPermiso',
  mensaje: SIN_PERMISO,
  corto: 'tu rol o tu área no permiten ese cambio.',
};

/** Con la fila releída: ¿ya estaba (hecha) o la movió alguien (conflicto)? null = ninguna. */
function juzgar(a: Accion, x: Incidencia | null): ResultadoConCorto | null {
  if (!x) return null;
  if (yaAplicada(a, x)) return { tipo: 'hecha', fila: x };
  const k = conflictoDe(a, x);
  if (k) return { tipo: 'conflicto', fila: x, mensaje: k.mensaje, corto: k.corto };
  return null;
}

/**
 * El UPDATE dio 0 filas: se relee para saber si ya estaba, si la movieron o
 * si es la RLS.
 *
 * Antes de concluir "sin permiso" se vuelve a exigir la sesión (revisión sin
 * señal, 24-sep-2026): si el token venció a media reparación y la
 * renovación falló, el UPDATE y la relectura salieron como anon (0 filas,
 * fila invisible) y la acción se quitaba de la cola como "tu rol no lo
 * permite". Sin sesión, exigirSesion lanza SinSesion y sigue en cola; con
 * sesión (quizá recién renovada) se repite UNA vez el UPDATE, que es
 * idempotente por su precondición.
 */
async function explicar(a: Accion, c: Ctx, repetido: boolean): Promise<ResultadoConCorto> {
  const x = await releer(a.record_id);
  const d = juzgar(a, x);
  if (d) return d;
  await exigirSesion(c.topeSesion, a.email);
  if (!repetido) return await intentoUpdate(a, c, true);
  return RES_SIN_PERMISO;
}

// ------------------------------------------------------------
// Pasos
// ------------------------------------------------------------

type Ctx = {
  interactivo: boolean;
  esperas: number[];
  topeEscritura: number;
  /** Tope de exigirSesion en los pasos intermedios (undefined = el de la cola). */
  topeSesion: number | undefined;
  alProgreso?: (texto: string) => void;
  /** Se llama justo antes de mandar algo que puede llegar a la base. */
  seMando: () => void;
};

/**
 * Los errores definitivos más comunes, en palabras de campo (revisión sin
 * señal, 24-sep-2026): el mensaje crudo de Postgres llegaba al usuario tal
 * cual, en inglés. El crudo queda en errores_cliente.
 */
function mensajeUpdate(e: { message: string; code?: string }): string {
  if (e.code === '42501') return 'tu rol o tu área no permiten este cambio en esta incidencia';
  if (e.code === '23503') return 'la clasificación elegida ya no existe en el catálogo; recarga y vuelve a elegirla';
  return e.message;
}

/** El UPDATE condicionado de la acción. */
async function intentoUpdate(a: Accion, c: Ctx, repetido = false): Promise<ResultadoConCorto> {
  let q = sb
    .from('incidencias')
    .update(a.patch)
    .eq('record_id', a.record_id)
    .eq('estatus', a.esperado);
  // La MISMA reparación que se vio (aprobar/rechazar) o que no haya caído
  // otra encima mientras la de este teléfono esperaba señal (reparación).
  if (a.exigeReparacion)
    q = a.repairedAtVisto === null ? q.is('repaired_at', null) : q.eq('repaired_at', a.repairedAtVisto);
  // La MISMA vuelta del ciclo que se vio (ver AccionNueva.validatorAtVisto).
  if (a.exigeValidacion)
    q = a.validatorAtVisto == null ? q.is('validator_at', null) : q.eq('validator_at', a.validatorAtVisto);
  if (a.clase === 'prevalidar') q = q.eq('requiere_prevalidacion', true).eq('prevalidada', false);
  if (a.clase === 'descartar_prevalidacion') q = q.eq('prevalidada', false);
  c.seMando();
  const r = await q.select('*').abortSignal(tope(c.topeEscritura));
  if (r.error) {
    if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
    reportarError('acciones.update', r.error, { clase: a.clase, code: r.error.code }, a.record_id);
    return { tipo: 'error', mensaje: mensajeUpdate(r.error) };
  }
  // La RLS no lanza: 0 filas también es "no te toca" o "ya la movieron". Se CUENTA.
  const filas = (r.data as Incidencia[] | null) ?? [];
  if (filas.length) return { tipo: 'hecha', fila: filas[0] };
  return await explicar(a, c, repetido);
}

/**
 * Registra el archivo en `evidencias`. Si ya hubo un intento sin confirmar
 * (o viene de la cola), primero consulta si ya existe: no se duplica. En el
 * primer intento del botón no se consulta: la ruta es nueva y solo esta
 * acción la conoce (igual que lib/envios.ts).
 */
async function ligar(
  a: Accion,
  x: ArchivoAccion,
  verificar: boolean,
  c: Ctx
): Promise<'ok' | { definitivo: string }> {
  if (verificar || a.estado.ligando.includes(x.path)) {
    const r = await sb
      .from('evidencias')
      .select('id')
      .eq('path', x.path)
      .eq('record_id', a.record_id)
      .limit(1)
      .retry(false)
      .abortSignal(tope(ESPERA_CONSULTA_MS));
    if (r.error) {
      if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
      // Si no se puede consultar, se inserta: una evidencia repetida es
      // mejor que una foto sin ligar.
    } else if (((r.data as unknown[] | null) || []).length) return 'ok';
  }
  if (!a.estado.ligando.includes(x.path)) {
    // Se anota ANTES de mandar: si la respuesta se pierde, el siguiente
    // intento sabe que tiene que consultar.
    a.estado.ligando.push(x.path);
    await persistir(a);
  }
  const url = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(x.path).data.publicUrl;
  c.seMando();
  const r = await sb
    .from('evidencias')
    .insert({
      record_id: a.record_id,
      etapa: 'reparacion',
      tipo: x.tipo,
      url,
      path: x.path,
      subido_por: a.email,
    })
    .abortSignal(tope(c.topeEscritura));
  if (!r.error) return 'ok';
  if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
  return { definitivo: r.error.message };
}

/** ¿La incidencia ya tiene alguna evidencia de reparación en la base? */
async function hayEvidenciaReparacion(recordId: string): Promise<boolean> {
  const r = await sb
    .from('evidencias')
    .select('id')
    .eq('record_id', recordId)
    .eq('etapa', 'reparacion')
    .limit(1)
    .retry(false)
    .abortSignal(tope(ESPERA_CONSULTA_MS));
  if (r.error) {
    if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
    return false;
  }
  return ((r.data as unknown[] | null) || []).length > 0;
}

/**
 * Las rutas de esta reparación que YA están en `evidencias` de la
 * incidencia (revisión sin señal, 24-sep-2026): con la ruta por huella, son
 * las mismas fotos de un Guardar anterior que sí alcanzó a ligarlas.
 */
async function rutasYaLigadas(a: Accion): Promise<Set<string>> {
  const r = await sb
    .from('evidencias')
    .select('path')
    .eq('record_id', a.record_id)
    .in(
      'path',
      a.archivos.map((x) => x.path)
    )
    .retry(false)
    .abortSignal(tope(ESPERA_CONSULTA_MS));
  if (r.error) {
    if (esFallaRedPg(r.error, r.status)) throw new SinRed(r.error.message);
    // Si no se puede consultar se sigue como si nada: ligar() vuelve a
    // preguntar en los reintentos.
    return new Set();
  }
  return new Set(((r.data as { path: string }[] | null) || []).map((x) => x.path));
}

/**
 * Reparación: (1) subir cada archivo a su ruta fija, (2) ligarlo en
 * `evidencias`, (3) el UPDATE a 'reparado'. En ese orden, como hoy: la
 * incidencia no pasa a validación sin su evidencia. Cada avance se persiste.
 *
 * Antes de la primera foto (revisión sin señal, 24-sep-2026) se relee la
 * incidencia y se pregunta qué fotos ya están ligadas, las dos cosas a la
 * vez: si otra persona ya la reparó o la movió, la reparación sale como
 * conflicto SIN subir nada (antes se subían y ligaban las fotos y el
 * conflicto llegaba hasta el UPDATE, así que la evidencia de este técnico
 * quedaba mezclada con la reparación ajena), y las fotos que un Guardar
 * anterior ya ligó no se vuelven a subir.
 */
async function pasoReparacion(a: Accion, c: Ctx): Promise<ResultadoConCorto> {
  const avisos: string[] = [];
  const verificar = !c.interactivo || a.intentos > 1;
  const total = a.archivos.length;
  const sinAvance = !a.estado.subidos.length && !a.estado.ligados.length && !a.estado.ligando.length;
  if (total > 0 && sinAvance) {
    c.alProgreso?.('Revisando la incidencia…');
    const revisar = () => reintentar(() => Promise.all([releer(a.record_id), rutasYaLigadas(a)]), c.esperas);
    let [fila, arriba] = await revisar();
    if (!fila) {
      // No se ve: la RLS no la deja tocar… o la lectura salió como anon
      // porque el token venció justo ahí (M2; verificación de la revisión
      // sin señal, 24-sep-2026). Con la sesión del dueño (si no, sale en
      // cola) se pregunta UNA vez más antes de concluir "sin permiso": antes
      // la acción se quitaba de la cola aunque la sesión ya se hubiera
      // renovado. Las rutas ya ligadas también se vuelven a pedir: como
      // anon, esa consulta también sale vacía.
      await exigirSesion(c.topeSesion, a.email);
      [fila, arriba] = await revisar();
      if (!fila) return RES_SIN_PERMISO;
    }
    const d = juzgar(a, fila);
    if (d) return d;
    if (arriba.size) {
      a.archivos.forEach((x) => {
        if (!arriba.has(x.path)) return;
        if (!a.estado.subidos.includes(x.path)) a.estado.subidos.push(x.path);
        if (!a.estado.ligados.includes(x.path)) a.estado.ligados.push(x.path);
      });
      await persistir(a);
    }
  }
  for (let i = 0; i < total; i++) {
    const x = a.archivos[i];
    if (a.estado.ligados.includes(x.path) || a.estado.fallidos.includes(x.path)) continue;
    c.alProgreso?.(total > 1 ? `Subiendo ${i + 1} de ${total}…` : 'Subiendo la evidencia…');

    if (!a.estado.subidos.includes(x.path)) {
      const f =
        archivosMem.get(x.clave) ??
        (await leerDelTelefono(x.clave, a, () => persistir(a), 'archivos_acciones'));
      if (!f) {
        // Solo pasa al retomar tras cerrar la app: no cupo en el teléfono, el
        // navegador borró los datos del sitio o no se pudo leer tres veces.
        reportarError('acciones.archivoPerdido', new Error('archivo no encontrado'), { path: x.path, bytes: x.bytes }, x.path);
        avisos.push(`«${x.nombre}» ya no estaba en el teléfono (no cupo, se borró o no se pudo leer).`);
        a.estado.fallidos.push(x.path);
        await persistir(a);
        continue;
      }
      // Cada paso largo, con la sesión del dueño (ver exigirSesion).
      await exigirSesion(c.topeSesion, a.email);
      c.seMando();
      const res = await reintentar(() => subir(x, f, a.email), c.esperas);
      if (res !== 'ok') {
        reportarError('acciones.subida', res.definitivo, { path: x.path, tipo: x.tipo, bytes: f.size }, x.path);
        avisos.push(conPunto(`No se pudo subir «${x.nombre}»: ${mensajeDe(res.definitivo)}`));
        a.estado.fallidos.push(x.path);
        await persistir(a);
        continue;
      }
      // Se anota ANTES de la miniatura: con un video el cuadro tarda hasta
      // 8 s, y si en ese rato se cierra la app, al retomar la cola no debe
      // volver a subir el video entero por 4G.
      a.estado.subidos.push(x.path);
      await persistir(a);
      // La miniatura es la que pintan las tarjetas (de mejor esfuerzo). De
      // un video, un cuadro suyo: sin él, la tarjeta salía vacía.
      await subirMiniatura(x.path, f);
    }

    await exigirSesion(c.topeSesion, a.email);
    const lg = await reintentar(() => ligar(a, x, verificar, c), c.esperas);
    if (lg !== 'ok') {
      reportarError('acciones.ligar', new Error(lg.definitivo), { path: x.path }, x.path);
      avisos.push(conPunto(`«${x.nombre}» se subió pero no se pudo registrar: ${lg.definitivo}`));
      a.estado.fallidos.push(x.path);
      await persistir(a);
      continue;
    }
    a.estado.ligados.push(x.path);
    await persistir(a);
  }

  // Sin ninguna foto propia ligada, la reparación solo sigue si la
  // incidencia ya tenía evidencia de reparación (el modal la contó).
  if (total > 0 && !a.estado.ligados.length && !(await hayEvidenciaReparacion(a.record_id))) {
    return {
      tipo: 'error',
      mensaje:
        'No se pudo subir ninguna foto o video de la reparación. ' +
        (avisos.length ? avisos.join(' ') + ' ' : '') +
        // En el botón la acción ya no queda en la cola: se vuelve a tocar
        // Guardar. Desde la cola sí sigue ahí hasta que se descarte.
        (c.interactivo
          ? 'Vuelve a intentarlo.'
          : 'Descarta esta acción y vuelve a registrar la reparación.'),
    };
  }

  c.alProgreso?.('Guardando la reparación…');
  // Tras subidas que pudieron tardar minutos: la sesión sigue siendo del
  // dueño y sigue vigente (si no, el UPDATE saldría como anon).
  await exigirSesion(c.topeSesion, a.email);
  const r = await reintentar(() => intentoUpdate(a, c), c.esperas);
  if (r.tipo === 'hecha') {
    // Digital: el eco debe traer la clasificación técnica que se mandó
    // (mismo aviso que IncidenciasView.guardarReparacion).
    const srd = a.patch.incidencia_srd;
    if (
      srd &&
      a.patch.arbol_digital_id != null &&
      (r.fila?.incidencia_srd !== srd || String(r.fila?.arbol_digital_id) !== String(a.patch.arbol_digital_id))
    )
      avisos.push(SIN_CLASIFICACION);
    return avisos.length ? { ...r, aviso: avisos.join(' ') } : r;
  }
  // Lo ya ligado se queda en la evidencia aunque el UPDATE no pase. Se dice,
  // y un nuevo Guardar con las mismas fotos ya no las duplica (ver
  // rutaReparacion).
  if (a.estado.ligados.length && (r.tipo === 'conflicto' || r.tipo === 'sinPermiso' || r.tipo === 'error')) {
    const nota = ' Las fotos que subiste sí quedaron en su evidencia.';
    return { ...r, mensaje: conPunto(r.mensaje) + nota, corto: r.corto ? conPunto(r.corto) + nota : undefined };
  }
  return r;
}

// ------------------------------------------------------------
// El procesamiento
// ------------------------------------------------------------

/**
 * La acción quedó hecha: los avisos de la campana de esa incidencia ya
 * están atendidos (revisión sin señal, 24-sep-2026). La vista los marca al
 * tocar el botón (useNotificaciones.marcarDeRegistro), pero sin red ese
 * UPDATE falla y no se reintenta, y cuando la acción salía sola de la cola
 * nadie los volvía a marcar: al volver la señal la campana traía otra vez
 * los "por validar" de lo ya validado. Mismo filtro que marcarDeRegistro
 * (la RLS lo acota a los del usuario), pero solo los avisos anteriores al
 * toque: uno que llegó después (p. ej. la reparación que se registró
 * mientras la validación esperaba señal) es nuevo y se queda. De mejor
 * esfuerzo: no espera ni lanza.
 */
function marcarAvisosAtendidos(a: Accion): void {
  try {
    void sb
      .from('notificaciones')
      .update({ leida: true })
      .eq('record_id', a.record_id)
      .neq('evento', 'chat')
      .eq('leida', false)
      .lte('creado_en', a.creado_en)
      .abortSignal(tope(ESPERA_CONSULTA_MS))
      .then(
        () => {},
        () => {}
      );
  } catch {
    /* la campana se corrige sola en su siguiente carga */
  }
}

async function ejecutar(
  a0: Accion,
  op: { interactivo: boolean; alProgreso?: (texto: string) => void }
): Promise<ResultadoInterno> {
  const a = await versionFresca(a0);
  if (!a) return { tipo: 'yaHecha' };
  memoria.set(a.id, a);
  a.intentos++;
  let mandado = false;
  const topeSesion = op.interactivo ? ESPERA_SESION_INTERACTIVA_MS : undefined;
  const c: Ctx = {
    interactivo: op.interactivo,
    esperas: op.interactivo ? ESPERAS_INTERACTIVO_MS : ESPERAS_MS,
    topeEscritura: op.interactivo ? ESPERA_ESCRITURA_INTERACTIVA_MS : ESPERA_ESCRITURA_MS,
    topeSesion,
    alProgreso: op.alProgreso,
    seMando: () => {
      mandado = true;
    },
  };
  try {
    // Sin sesión real todo sale como anon: la lectura de 0 filas se leería
    // como "sin permiso" y la subida daría 400/403. Es SinRed: sigue en cola.
    // Y tiene que ser la sesión del DUEÑO (revisión sin señal, 24-sep-2026):
    // con otra cuenta abierta en el teléfono, espera a que él vuelva.
    await exigirSesion(topeSesion, a.email);
    const r = a.clase === 'reparacion' ? await pasoReparacion(a, c) : await reintentar(() => intentoUpdate(a, c), c.esperas);
    switch (r.tipo) {
      case 'hecha':
        marcarAvisosAtendidos(a);
        await quitarAccion(a.id);
        break;
      case 'conflicto':
      case 'sinPermiso':
        // Aplicada, o ya no aplica: fuera de la cola (el aviso lo dice).
        await quitarAccion(a.id);
        break;
      case 'error':
        // En el botón, el usuario ve el error y decide (no se queda en la
        // cola: repetirlo daría lo mismo). Desde la cola se queda a la
        // vista con su error hasta que lo descarte; se reintenta en cada
        // vuelta por si el problema era del servidor.
        if (op.interactivo) await quitarAccion(a.id);
        else await anotar(a, r.mensaje, true);
        break;
    }
    return r;
  } catch (err) {
    if (err instanceof SinRed) {
      // Sin señal primero y luego la sesión (textoEnCola): sin red y con el
      // token vencido, SinSesion decía "renueva tu sesión" y era la señal.
      await anotar(a, textoEnCola(err, 'sola'), false);
      return { tipo: 'enCola' };
    }
    // Error inesperado (de código, no de la base). Si nada salió y el
    // usuario está esperando, es un error normal; si algo pudo llegar, se
    // queda en cola: la relectura lo resuelve sin duplicar.
    reportarError('acciones.ejecutar', err, { clase: a.clase }, a.record_id);
    if (op.interactivo && !mandado) {
      await quitarAccion(a.id);
      return { tipo: 'error', mensaje: mensajeDe(err) };
    }
    await anotar(a, 'Falló por un error de la app; se reintenta sola.', false);
    return { tipo: 'enCola' };
  } finally {
    if (!soloMemoria.has(a.id)) memoria.delete(a.id);
  }
}

/** Un procesamiento por acción a la vez en la pestaña, con candado entre pestañas. */
function procesar(
  a: Accion,
  op: { interactivo: boolean; alProgreso?: (texto: string) => void }
): Promise<ResultadoInterno> {
  const previo = enCurso.get(a.id);
  if (previo) return op.interactivo ? previo : Promise.resolve({ tipo: 'ocupado' });
  const p = conCandado<ResultadoInterno>(a.id, () => ejecutar(a, op), { tipo: 'ocupado' }, 'accion-')
    .catch((err): ResultadoInterno => {
      // ejecutar() no debería lanzar; si pasa, nada se pierde: sigue en cola.
      reportarError('acciones.procesar', err);
      return { tipo: 'enCola' };
    })
    .finally(() => {
      enCurso.delete(a.id);
      if (op.interactivo) interactivos.delete(a.id);
      emitir();
    });
  enCurso.set(a.id, p);
  emitir();
  return p;
}

/** Texto del aviso para un resultado que llegó desde la cola (no del botón). */
function avisoDiferido(a: Accion, r: ResultadoInterno): string | null {
  const quien = `${ETIQUETA[a.clase]} de ${refDe(a)}`;
  const corto = (r as ResultadoConCorto).corto;
  switch (r.tipo) {
    case 'hecha':
      return r.aviso ? `${refDe(a)}: ${r.aviso}` : null;
    case 'conflicto':
    case 'sinPermiso':
      return `${quien} no se aplicó: ${corto || r.mensaje}`;
    case 'error':
      return `${quien} no se pudo enviar: ${conPunto(r.mensaje)} Si ya no hace falta, descártala en «Ver detalle».`;
    default:
      return null;
  }
}

/** Sin el `corto` interno. */
function publico(r: ResultadoConCorto): ResultadoAccion {
  if ('corto' in r) {
    const { corto: _c, ...resto } = r;
    return resto as ResultadoAccion;
  }
  return r;
}

/**
 * El botón (validar, aprobar, rechazar, prevalidar, descartar, guardar
 * reparación). Guarda la acción en el teléfono ANTES de mandar y la procesa
 * enseguida. Resultado:
 *   hecha      → aplicada en el servidor (fila releída o eco).
 *   enCola     → sin red (o sin sesión todavía): quedó en el teléfono y se
 *                manda sola; el aviso global la muestra.
 *   conflicto  → otra persona ya la movió: NO se aplicó (fila = como está).
 *   sinPermiso → la RLS no deja.
 *   error      → error definitivo; ya no queda en la cola. El mensaje dice
 *                qué no se guardó (revisión sin señal, 24-sep-2026: antes
 *                llegaba el texto crudo de Postgres, en inglés).
 * Si hay acciones anteriores de la MISMA incidencia en la cola, esta sale
 * DETRÁS de ellas (el orden importa: prevalidar antes de reparar) y en
 * segundo plano: devuelve enCola de inmediato (revisión sin señal,
 * 24-sep-2026). Antes las anteriores se mandaban aquí mismo con los tiempos
 * de la cola y, con la conexión colgada, el modal se quedaba ~70 s en
 * "Guardando en el teléfono…" sin poder cancelar.
 */
export async function ejecutarAccion(
  email: string,
  an: AccionNueva,
  op?: { alProgreso?: (texto: string) => void }
): Promise<ResultadoAccion> {
  const em = norm(email);
  if (!em) return { tipo: 'error', mensaje: 'Sin sesión: vuelve a entrar a la app.' };
  const archivos = new Map<string, File>();
  if (an.clase === 'reparacion' && an.archivos?.length) op?.alProgreso?.('Guardando en el teléfono…');
  const a = await armarAccion(em, an, archivos);
  interactivos.add(a.id);
  await guardarNueva(a, archivos);

  const previas = (await listarTodas(em)).filter(
    (x) => x.record_id === a.record_id && x.id !== a.id && x.creado_en <= a.creado_en
  );
  if (previas.length) {
    // Una anterior con error no sale sola: se dice qué hacer (M3).
    await anotar(
      a,
      previas.some((p) => p.conError)
        ? 'Espera a la acción anterior de esta incidencia: tiene un error; si ya no hace falta, descártala en «Ver detalle».'
        : 'Espera a que se envíe la acción anterior de esta incidencia.',
      false
    );
    interactivos.delete(a.id);
    // Ya no la procesa este botón: fuera de `memoria`, o esa copia pisaría
    // a la de IndexedDB en listarTodas y versionFresca (y un descarte desde
    // otra pestaña no se vería aquí). Solo se queda la que no cupo.
    if (!soloMemoria.has(a.id)) memoria.delete(a.id);
    emitir();
    void enOrden(em, [...previas, a]);
    return { tipo: 'enCola' };
  }

  const r = await procesar(a, { interactivo: true, alProgreso: op?.alProgreso });
  if (r.tipo === 'ocupado' || r.tipo === 'yaHecha') return { tipo: 'enCola' };
  if (r.tipo === 'error')
    return { tipo: 'error', mensaje: `${ETIQUETA[a.clase]} no se guardó: ${conPunto(trasDosPuntos(r.mensaje))}` };
  return publico(r);
}

/**
 * Las acciones de UNA incidencia, en orden y en segundo plano (la que se
 * acaba de tocar va al final). Se detiene en la primera que no termina (sin
 * red, ocupada en otra pestaña o con error): las de detrás esperan. Si una
 * ya la está mandando la vuelta de la cola en esta pestaña, se espera a esa
 * en vez de saltársela. Los avisos van al buzón (los recoge el aviso global).
 */
async function enOrden(email: string, lista: Accion[]): Promise<void> {
  try {
    for (const p of lista) {
      const enMarcha = enCurso.get(p.id);
      const errorPrevio = p.ultimoError;
      const r = enMarcha ? await enMarcha : await procesar(p, { interactivo: false });
      // Lo que ya mandaba la vuelta lo avisa la vuelta; un error que se
      // repite se avisa una sola vez (como en la vuelta).
      const repetido = r.tipo === 'error' && errorPrevio === r.mensaje.slice(0, 300);
      if (!enMarcha && !repetido) {
        const aviso = avisoDiferido(p, r);
        if (aviso) buzon.push({ email, texto: aviso });
      }
      if (r.tipo === 'enCola' || r.tipo === 'ocupado' || r.tipo === 'error') break;
    }
  } catch (err) {
    reportarError('acciones.enOrden', err);
  }
  emitir();
}

/** ¿Una reparación con fotos o videos todavía por subir o registrar? */
function conArchivosPendientes(a: Accion): boolean {
  return (
    a.clase === 'reparacion' &&
    a.archivos.some((x) => !a.estado.ligados.includes(x.path) && !a.estado.fallidos.includes(x.path))
  );
}

type ResumenVuelta = { terminadas: number; siguen: number; mensajes: string[] };

/**
 * La vuelta en curso de cada correo: una por CORREO y no una por pestaña
 * (revisión sin señal, 24-sep-2026). En un teléfono compartido, si A salió
 * con su vuelta a medias y B entra, B no recibe la promesa de A (ni los
 * avisos de sus acciones) ni espera a que termine; la de A se corta sola en
 * su siguiente paso (exigirSesion con su correo → OtraCuenta) y lo que
 * falte se queda en la cola de A.
 */
const vueltas = new Map<string, Promise<ResumenVuelta>>();

/**
 * Procesa la cola de acciones de este correo, de la más vieja a la más
 * nueva. Una vuelta a la vez por correo; al primer "sin red" las demás no se
 * intentan (tardarían lo mismo en fallar y el orden se respeta).
 * terminadas = aplicadas o que ya no aplican (conflicto, sin permiso);
 * mensajes = lo que el aviso debe decir una vez.
 *
 * Revisión sin señal (24-sep-2026):
 *   · Una acción que se queda (error, ocupada en otra pestaña, sin red)
 *     DETIENE a las de detrás de su misma incidencia: antes, con la
 *     validación en error, la reparación de detrás corría igual y ligaba
 *     fotos a una incidencia que ni estaba en proceso.
 *   · Primero las que no tienen archivos por subir y al final las
 *     reparaciones con fotos o videos (respetando el orden dentro de cada
 *     incidencia): un video con señal débil ya no retiene las validaciones
 *     que vienen detrás.
 */
export function procesarAccionesPendientes(email: string): Promise<ResumenVuelta> {
  const em = norm(email);
  const enCursoDe = vueltas.get(em);
  if (enCursoDe) return enCursoDe;
  const vuelta: Promise<ResumenVuelta> = (async () => {
    const res: ResumenVuelta = { terminadas: 0, siguen: 0, mensajes: [] };
    const lista = await listarTodas(em);
    const primero: Accion[] = [];
    const despues: Accion[] = [];
    const tardan = new Set<string>();
    for (const a of lista) {
      if (tardan.has(a.record_id) || conArchivosPendientes(a)) {
        tardan.add(a.record_id);
        despues.push(a);
      } else primero.push(a);
    }
    const detenidas = new Set<string>();
    let cortar = false;
    for (const a of [...primero, ...despues]) {
      if (cortar || interactivos.has(a.id) || detenidas.has(a.record_id)) {
        detenidas.add(a.record_id);
        res.siguen++;
        continue;
      }
      const errorPrevio = a.ultimoError;
      const r = await procesar(a, { interactivo: false });
      switch (r.tipo) {
        case 'hecha':
        case 'yaHecha':
        case 'conflicto':
        case 'sinPermiso':
          res.terminadas++;
          break;
        case 'enCola':
          res.siguen++;
          cortar = true;
          break;
        default:
          res.siguen++;
      }
      if (r.tipo === 'enCola' || r.tipo === 'ocupado' || r.tipo === 'error') detenidas.add(a.record_id);
      // Un error que se repite en cada vuelta se avisa una sola vez.
      if (r.tipo === 'error' && errorPrevio === r.mensaje.slice(0, 300)) continue;
      const aviso = avisoDiferido(a, r);
      if (aviso) res.mensajes.push(aviso);
    }
    res.mensajes.unshift(...tomarAvisosAcciones(em));
    return res;
  })().finally(() => {
    if (vueltas.get(em) === vuelta) vueltas.delete(em);
  });
  vueltas.set(em, vuelta);
  return vuelta;
}
