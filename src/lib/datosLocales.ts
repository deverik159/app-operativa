// ============================================================
// src/lib/datosLocales.ts
// COPIAS EN EL TELÉFONO de lo que la app consulta para capturar, validar y
// reparar: inventario (de las unidades del usuario), catálogo de
// incidencias, árbol Digital, nombres de pantallas, catorcenas y la ventana
// de pauta QTM; más la última lista de incidencias de cada usuario.
//
// POR QUÉ (modo sin señal, 24-sep-2026): en campo, sin señal, el alta se
// quedaba en "Buscando…" ~7 s y luego en nada (0 medios, Guardar
// deshabilitado), y RepararModal no tenía árbol Digital. La cola ya guardaba
// lo capturado; faltaba de dónde sacar el sitio, las caras y los catálogos.
// Todo esto cabe de sobra en IndexedDB (~2-4 MB) y casi no cambia
// (inventario se sincroniza con QTM de noche; los catálogos, por SQL).
//
// Reglas:
//   · Las LECTURAS nunca lanzan: sin copia, o con IndexedDB caído, dan [] o
//     null. La tabla leída se queda en memoria: buscar entre ~5000 caras es
//     instantáneo.
//   · Una copia se REEMPLAZA solo con una descarga COMPLETA (la cuenta
//     exacta del servidor coincide con lo bajado y no cambió entre páginas),
//     sin errores y con sesión REAL antes y después. Al volver la red hay
//     hasta ~60 s en que auth-js aún no renueva el token: las consultas salen
//     como anónimas y la RLS contesta 200 con [] SIN error. Esa respuesta
//     jamás debe borrar la copia.
//   · Una descarga con 0 filas no reemplaza una copia con filas (ver
//     vaciaEsCreible).
//   · Sin red, o sin sesión real, la sincronización no hace nada.
//   · Base propia 'gpo-datos' (lib/idbDatos.ts): la de la cola no se toca.
// ============================================================
import { sb } from './supabase';
import { reportarError } from './reportarError';
import { SLA_VALIDACION_DEFAULT } from './constants';
import { ErrorDatos, datosDelete, datosGet, datosPut, datosTx } from './idbDatos';
import type {
  ArbolDigital,
  CatalogoIncidencia,
  Incidencia,
  InventarioItem,
  SlaMap,
} from '../types/db';

// ------------------------------------------------------------
// Tipos
// ------------------------------------------------------------

/**
 * Fila de `arbol_digital` con las 10 columnas que usa RepararModal. Mismos
 * tipos que ArbolDigital (types/db.ts): el modal la usa tal cual.
 */
export type ArbolDigitalLocal = Pick<
  ArbolDigital,
  | 'id'
  | 'incidencia'
  | 'categoria_principal'
  | 'incidencia_srd'
  | 'causa_raiz'
  | 'diagnostico'
  | 'solucion'
  | 'sla_min'
  | 'sla'
  | 'sla_fuera'
>;

export type CatorcenaLocal = {
  numero: number;
  fecha_inicio: string;
  fecha_fin: string;
  cat_texto: string | null;
};

export type PautaLocal = {
  vendor_face_id: string;
  campaign: string | null;
  fecha_inicio: string | null;
  fecha_fin: string | null;
};

export type SitioLocal = { site_id: string; direccion: string | null };

export type SitioCercano = SitioLocal & { latitud: number; longitud: number };

/** La última lista de incidencias que vio un usuario, para abrir sin señal. */
export type ListaLocal = {
  guardado: string;
  items: Incidencia[];
  fotos: {
    reporte: Record<string, string>;
    reparacion: Record<string, string>;
    reasign: Record<string, string>;
  };
  slaMap: SlaMap;
  slaValidacion: { reporte: number; reparacion: number };
};

type NombrePantalla = { vendor_face_id: string; nombre: string };

/** Qué se guarda de cada tabla. */
type Filas = {
  inventario: InventarioItem;
  catalogo_incidencias: CatalogoIncidencia;
  arbol_digital: ArbolDigitalLocal;
  nombres_pantallas: NombrePantalla;
  catorcenas: CatorcenaLocal;
  qtm_pautas: PautaLocal;
};

export type TablaLocal = keyof Filas;

/** Registro del almacén `meta` (uno por tabla). */
type MetaTabla = {
  tabla: TablaLocal;
  /** ISO de la última descarga COMPLETA. */
  guardado: string;
  /** Solo inventario: unidades que cubre, en minúsculas; null = todas. */
  unidades: string[] | null;
  n: number;
  /** Columnas que se pidieron: si el código pide otras, la copia se vuelve a bajar. */
  columnas?: string;
  /** Solo qtm_pautas: la ventana de fechas que se bajó. */
  ventana?: Ventana | null;
};

/** Registro del almacén `tablas` (uno por tabla, con TODAS sus filas). */
type RegistroTabla = { tabla: TablaLocal; filas: unknown[] };

type Ventana = { desde: string; hasta: string };

// ------------------------------------------------------------
// Constantes
// ------------------------------------------------------------

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

/** Filas por página: el tope por omisión de PostgREST en Supabase. */
const PAGINA = 1000;
/** Tope de seguridad: 30 000 filas. Más que eso es un filtro roto, no datos. */
const MAX_PAGINAS = 30;
/** Tope por página (1000 caras ≈ 80 KB comprimidos: sobra en 2G). */
const TOPE_PAGINA_MS = 30000;
/** Reintentos de una página que falla por red. */
const ESPERAS_PAGINA_MS = [1500, 4000];
/** Tope para preguntar por la sesión (getSession espera a auth-js). */
const TOPE_SESION_MS = 3000;
/** Tope por omisión de redOLocal. */
const TOPE_RED_MS = 4000;
/**
 * Tope TOTAL de redOLocal cuando la copia no trae nada (revisión sin señal,
 * 24-sep-2026): sin copia, cortar a los 4 s dejaba vacío lo que con 3G/2G
 * lenta sí llegaba a los 5-7 s. Ahí conviene esperar a la red.
 */
const TOPE_RED_SIN_COPIA_MS = 20000;
/** Pausa antes del único reintento de redOLocal (sin copia, falla de red pasajera). */
const ESPERA_REINTENTO_RED_MS = 1000;

/** Una copia se refresca si tiene más de esto. */
const VIGENCIA_MS = 12 * HORA;
/** La pauta cambia con cada catorcena y con la rotación digital. */
const VIGENCIA_PAUTAS_MS = 6 * HORA;
/** Vuelta de fondo aunque no haya eventos. */
const CADA_MS = 6 * HORA;
/** Entre dos vueltas que sí llegaron al servidor (los eventos se repiten mucho). */
const ESPACIO_VUELTAS_MS = 60 * 1000;
/** Entre dos intentos que no pudieron (sin red o sin sesión): son baratos. */
const ESPACIO_INTENTOS_MS = 5 * 1000;
/** Pausa de una tabla tras un error definitivo (RLS, columna que no existe…). */
const PAUSA_DEFINITIVO_MS = HORA;
/** Pausa tras una descarga incompleta (la tabla cambió mientras se bajaba). */
const PAUSA_INCOMPLETA_MS = 15 * 60 * 1000;
/** Pausa tras una descarga vacía que no se creyó. */
const PAUSA_VACIA_MS = HORA;

/**
 * Ventana de qtm_pautas. NuevaInc pide la pauta que se traslapa con la
 * catorcena ANTERIOR (empieza hasta 27 días atrás), la actual y la
 * siguiente (acaba hasta 28 días adelante). Atrás se toman 28 días para que
 * la copia devuelva lo mismo que la consulta en línea; adelante 45 para que
 * siga sirviendo tras ~2 semanas sin señal.
 */
const PAUTA_ATRAS_DIAS = 28;
const PAUTA_ADELANTE_DIAS = 45;

const COLUMNAS: Record<TablaLocal, string> = {
  // Las 13 de InventarioItem: las de las caras (NuevaInc, EditModal) y las
  // del buscador y "cerca de mí".
  inventario:
    'vendor_face_id,site_id,site_legacy_id,cara,categoria,unidad_negocio,tipo_medio,tipo_mueble,latitud,longitud,direccion,municipio,estado',
  // '*' como NuevaInc y CorreccionModal: tipo_medio puede no existir.
  catalogo_incidencias: '*',
  arbol_digital:
    'id,incidencia,categoria_principal,incidencia_srd,causa_raiz,diagnostico,solucion,sla_min,sla,sla_fuera',
  nombres_pantallas: 'vendor_face_id,nombre',
  catorcenas: 'numero,fecha_inicio,fecha_fin,cat_texto',
  qtm_pautas: 'vendor_face_id,campaign,fecha_inicio,fecha_fin',
};

/**
 * Orden estable para paginar: sin él, Postgres puede repetir o saltarse
 * filas entre páginas. En qtm_pautas no hay llave conocida: se ordena por
 * TODAS las columnas pedidas, así dos filas empatadas son idénticas y da
 * igual cuál llegue.
 */
const ORDEN: Record<TablaLocal, string[]> = {
  inventario: ['vendor_face_id', 'site_id', 'cara'],
  catalogo_incidencias: ['id'],
  arbol_digital: ['id'],
  nombres_pantallas: ['vendor_face_id'],
  catorcenas: ['numero', 'fecha_inicio'],
  qtm_pautas: ['vendor_face_id', 'fecha_inicio', 'fecha_fin', 'campaign'],
};

/** Orden de descarga: lo chico e imprescindible primero. */
const SECUENCIA: TablaLocal[] = [
  'catalogo_incidencias',
  'arbol_digital',
  'inventario',
  'nombres_pantallas',
  'catorcenas',
  'qtm_pautas',
];

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------

/** ¿El navegador cree que hay red? (navigator.onLine miente a favor, nunca en contra). */
export function haySenal(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

const TOPE = Symbol('tope');

/**
 * Espera `p` con tope. Hace falta además del AbortSignal: supabase-js espera
 * auth.getSession() ANTES de cada fetch (hasta ~25 s con el token vencido y
 * sin red) y esa espera no la corta la señal.
 */
function conTope<T>(p: PromiseLike<T>, ms: number, alVencer?: () => void): Promise<T | typeof TOPE> {
  return new Promise((res, rej) => {
    let listo = false;
    const reloj = setTimeout(() => {
      if (listo) return;
      listo = true;
      try {
        alVencer?.();
      } catch {
        /* nada */
      }
      res(TOPE);
    }, ms);
    Promise.resolve(p).then(
      (v) => {
        if (listo) return;
        listo = true;
        clearTimeout(reloj);
        res(v);
      },
      (e) => {
        if (listo) return;
        listo = true;
        clearTimeout(reloj);
        rej(e);
      }
    );
  });
}

function dormir(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function isoDia(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Fecha comparable como texto. Las columnas son `date` ('AAAA-MM-DD') o
 * timestamp; un date cuenta como su medianoche, igual que en Postgres.
 */
function claveFecha(s: string | null | undefined): string {
  if (!s) return '';
  let t = String(s).trim().replace(' ', 'T');
  if (t.length === 10) t += 'T00:00:00';
  return t.slice(0, 19);
}

/** Unidad comparable: sin mayúsculas ni espacios de más (como el ilike). */
function normUnidad(u: string | null | undefined): string {
  return (u || '').trim().toLowerCase();
}

/** Coordenada como número: pueden llegar como texto. null si no es número. */
function aNumero(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function escaparRegex(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * El patrón de NuevaInc ('%' + texto con espacios→'%' + '%') como RegExp,
 * con la semántica de ilike: '%' = cualquier cosa, '_' = un carácter,
 * '\' escapa, sin mayúsculas. null si no hay nada que buscar.
 */
export function patronComoIlike(texto: string): RegExp | null {
  const q = (texto || '').trim();
  if (!q) return null;
  const patron = '%' + q.replace(/\s+/g, '%') + '%';
  let re = '';
  let previoComodin = false;
  for (let i = 0; i < patron.length; i++) {
    const c = patron[i];
    if (c === '%') {
      // Varios '%' seguidos valen uno (y evitan retroceso de más).
      if (!previoComodin) re += '.*';
      previoComodin = true;
      continue;
    }
    previoComodin = false;
    if (c === '\\' && i + 1 < patron.length) re += escaparRegex(patron[++i]);
    else if (c === '_') re += '.';
    else re += escaparRegex(c);
  }
  try {
    return new RegExp('^' + re + '$', 'is');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Avisos de error (sin inundar)
// ------------------------------------------------------------

/** Una vez por clave y por sesión de navegador; reportarError tiene su tope. */
const reportados = new Set<string>();
function reportarUnaVez(clave: string, e: unknown, extra?: Record<string, unknown>): void {
  if (reportados.has(clave)) return;
  reportados.add(clave);
  try {
    reportarError('datosLocales', e, extra, clave);
  } catch {
    /* nunca debe causar otro error */
  }
}

// ------------------------------------------------------------
// Memoria de la pestaña
// ------------------------------------------------------------

const memFilas = new Map<TablaLocal, unknown[]>();
const memMeta = new Map<TablaLocal, MetaTabla>();
const leyendo = new Map<TablaLocal, Promise<unknown[] | null>>();
/** Sube cada vez que la copia en memoria cambia o se invalida. */
const generacion = new Map<TablaLocal, number>();
const memListas = new Map<string, ListaLocal>();

function subirGeneracion(t: TablaLocal): void {
  generacion.set(t, (generacion.get(t) || 0) + 1);
}

function olvidarTabla(t: TablaLocal): void {
  memFilas.delete(t);
  memMeta.delete(t);
  subirGeneracion(t);
}

// Otra pestaña guardó una copia nueva: se olvida la de memoria y la
// siguiente lectura trae la nueva del teléfono.
let canal: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    canal = new BroadcastChannel('gpo-datos');
    canal.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { tabla?: TablaLocal; lista?: string } | null;
      if (m?.tabla && m.tabla in COLUMNAS) olvidarTabla(m.tabla);
      if (typeof m?.lista === 'string') memListas.delete(m.lista);
    };
  }
} catch {
  canal = null;
}

function avisarPestanas(m: { tabla?: TablaLocal; lista?: string }): void {
  try {
    canal?.postMessage(m);
  } catch {
    /* canal cerrado */
  }
}

async function leerFilasTelefono(t: TablaLocal): Promise<unknown[] | null> {
  try {
    const r = await datosGet<RegistroTabla>('tablas', t);
    return r && Array.isArray(r.filas) ? r.filas : null;
  } catch {
    return null;
  }
}

/**
 * Las filas de una tabla: de memoria o del teléfono (una sola lectura aunque
 * pidan varios a la vez). [] si no hay copia. No lanza. OJO: es el arreglo
 * de memoria; lo que sale hacia fuera se copia.
 */
async function filasDe<K extends TablaLocal>(t: K): Promise<Filas[K][]> {
  const m = memFilas.get(t);
  if (m) return m as Filas[K][];
  const g = generacion.get(t) || 0;
  let p = leyendo.get(t);
  if (!p) {
    const nueva = leerFilasTelefono(t);
    p = nueva;
    leyendo.set(t, nueva);
    nueva.then(() => {
      if (leyendo.get(t) === nueva) leyendo.delete(t);
    });
  }
  const f = await p;
  // Si mientras tanto llegó una copia nueva (o se invalidó), no se pisa.
  if (f && (generacion.get(t) || 0) === g && !memFilas.has(t)) memFilas.set(t, f);
  return (memFilas.get(t) || f || []) as Filas[K][];
}

async function leerMeta(t: TablaLocal): Promise<MetaTabla | null> {
  const m = memMeta.get(t);
  if (m) return m;
  try {
    const r = await datosGet<MetaTabla>('meta', t);
    if (r && typeof r.guardado === 'string') {
      if (!memMeta.has(t)) memMeta.set(t, r);
      return memMeta.get(t) || r;
    }
  } catch {
    /* sin base: sin copia */
  }
  return null;
}

// ------------------------------------------------------------
// Derivados de inventario (se arman una vez por copia)
// ------------------------------------------------------------

type SitioIdx = { site_id: string; lc: string; direccion: string | null };

type IndiceInventario = {
  /** Por unidad: un sitio por site_id (el de su primera cara). */
  sitiosPorUnidad: Map<string, SitioIdx[]>;
  /** Por unidad: todas sus caras, en el orden de la copia. */
  carasPorUnidad: Map<string, InventarioItem[]>;
  porSitio: Map<string, InventarioItem[]>;
  porSitioLc: Map<string, InventarioItem[]>;
};

const derivados = new WeakMap<object, unknown>();

function indiceInventario(filas: InventarioItem[]): IndiceInventario {
  const hecho = derivados.get(filas) as IndiceInventario | undefined;
  if (hecho) return hecho;
  const idx: IndiceInventario = {
    sitiosPorUnidad: new Map(),
    carasPorUnidad: new Map(),
    porSitio: new Map(),
    porSitioLc: new Map(),
  };
  const vistos = new Map<string, Set<string>>();
  for (const r of filas) {
    const u = normUnidad(r.unidad_negocio);
    let caras = idx.carasPorUnidad.get(u);
    if (!caras) idx.carasPorUnidad.set(u, (caras = []));
    caras.push(r);
    if (!r.site_id) continue;
    let enSitio = idx.porSitio.get(r.site_id);
    if (!enSitio) idx.porSitio.set(r.site_id, (enSitio = []));
    enSitio.push(r);
    const lc = r.site_id.toLowerCase();
    let enSitioLc = idx.porSitioLc.get(lc);
    if (!enSitioLc) idx.porSitioLc.set(lc, (enSitioLc = []));
    enSitioLc.push(r);
    let v = vistos.get(u);
    if (!v) vistos.set(u, (v = new Set()));
    if (v.has(r.site_id)) continue;
    v.add(r.site_id);
    let sitios = idx.sitiosPorUnidad.get(u);
    if (!sitios) idx.sitiosPorUnidad.set(u, (sitios = []));
    sitios.push({ site_id: r.site_id, lc, direccion: r.direccion ?? null });
  }
  derivados.set(filas, idx);
  return idx;
}

// ------------------------------------------------------------
// Lecturas (nunca lanzan)
// ------------------------------------------------------------

/**
 * ISO de la última descarga completa de una tabla, o null si no hay copia.
 * Para enseñar "copia de hace X h" o "sin copia en el teléfono".
 */
export async function fechaCopia(tabla: TablaLocal): Promise<string | null> {
  try {
    return (await leerMeta(tabla))?.guardado ?? null;
  } catch {
    return null;
  }
}

/**
 * Buscador de clave de sitio sin red: misma semántica que el ilike de
 * NuevaInc (fragmentos separados por espacios, en orden, sin mayúsculas,
 * dentro del site_id de esa unidad). Un resultado por site_id, con la
 * dirección de su primera cara. Sin el `.limit(80)` por caras de la
 * consulta en línea: un sitio con 40 caras ya no se come el tope.
 */
export async function buscarSitiosLocal(unidad: string, texto: string, max = 12): Promise<SitioLocal[]> {
  try {
    const re = patronComoIlike(texto);
    if (!re) return [];
    const sitios = indiceInventario(await filasDe('inventario')).sitiosPorUnidad.get(normUnidad(unidad)) || [];
    const salida: SitioLocal[] = [];
    for (const s of sitios) {
      if (salida.length >= max) break;
      if (re.test(s.lc)) salida.push({ site_id: s.site_id, direccion: s.direccion });
    }
    return salida;
  } catch {
    return [];
  }
}

/**
 * "Sitios cerca de mí" sin red: caras de la unidad dentro de la caja
 * ±delta grados, sin coordenadas nulas ni 0, un resultado por site_id con
 * las coordenadas de su primera cara (como NuevaInc). Sin orden: quien
 * llama calcula la distancia y ordena. Sin el `.limit(600)` al azar de la
 * consulta en línea, que en zonas densas dejaba fuera a los más cercanos.
 */
export async function sitiosCercaLocal(
  unidad: string,
  lat: number,
  lng: number,
  deltaGrados: number
): Promise<SitioCercano[]> {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(deltaGrados)) return [];
    const caras = indiceInventario(await filasDe('inventario')).carasPorUnidad.get(normUnidad(unidad)) || [];
    const vistos = new Set<string>();
    const salida: SitioCercano[] = [];
    for (const r of caras) {
      if (!r.site_id || vistos.has(r.site_id)) continue;
      const la = aNumero(r.latitud);
      const lo = aNumero(r.longitud);
      if (!la || !lo) continue;
      if (la < lat - deltaGrados || la > lat + deltaGrados) continue;
      if (lo < lng - deltaGrados || lo > lng + deltaGrados) continue;
      vistos.add(r.site_id);
      salida.push({ site_id: r.site_id, direccion: r.direccion ?? null, latitud: la, longitud: lo });
    }
    return salida;
  } catch {
    return [];
  }
}

function carasDeIndice(idx: IndiceInventario, siteId: string): InventarioItem[] {
  return idx.porSitio.get(siteId) || idx.porSitioLc.get(siteId.toLowerCase()) || [];
}

/** El sitio (clave y dirección de su primera cara), o null si no está en la copia. */
export async function sitioLocal(siteId: string): Promise<SitioLocal | null> {
  try {
    if (!siteId) return null;
    const r = carasDeIndice(indiceInventario(await filasDe('inventario')), siteId)[0];
    return r && r.site_id ? { site_id: r.site_id, direccion: r.direccion ?? null } : null;
  } catch {
    return null;
  }
}

/** Todas las caras del sitio (de cualquier unidad, como la consulta en línea). */
export async function carasDeSitioLocal(siteId: string): Promise<InventarioItem[]> {
  try {
    if (!siteId) return [];
    return carasDeIndice(indiceInventario(await filasDe('inventario')), siteId).map((r) => ({ ...r }));
  } catch {
    return [];
  }
}

/**
 * Catálogo de incidencias de una unidad, sin mayúsculas (igualdad, como el
 * `.ilike('unidad_negocio', unidad)` sin comodín). `prefijo: true` compara
 * por prefijo: con unidad '' trae todas las que tienen unidad, que es lo
 * que hace el `.ilike(unidad || '%')` de Corrección y Reasignar cuando la
 * incidencia no trae unidad; por eso ellos llaman con `prefijo: !unidad`.
 * Con prefijo y unidad, 'Biobox' traería también 'Biobox Perú'.
 */
export async function catalogoLocal(unidad: string, op?: { prefijo?: boolean }): Promise<CatalogoIncidencia[]> {
  try {
    const u = normUnidad(unidad);
    const prefijo = !!op?.prefijo;
    return (await filasDe('catalogo_incidencias'))
      .filter((c) => {
        if (c.unidad_negocio === null || c.unidad_negocio === undefined) return false;
        const cu = normUnidad(c.unidad_negocio);
        return prefijo ? cu.startsWith(u) : cu === u;
      })
      .map((c) => ({ ...c }));
  } catch {
    return [];
  }
}

/** El árbol Digital completo (no tiene unidad). */
export async function arbolDigitalLocal(): Promise<ArbolDigitalLocal[]> {
  try {
    return (await filasDe('arbol_digital')).map((a) => ({ ...a }));
  } catch {
    return [];
  }
}

function compararTexto(a: string | null, b: string | null): number {
  if (a === b) return 0;
  // Postgres, orden ascendente: los null al final.
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, 'es');
}

/**
 * Las ramas del árbol de UNA incidencia, como la consulta de RepararModal:
 * `.eq('incidencia', nombre)` ordenadas por incidencia_srd, causa_raiz y
 * solucion.
 */
export async function arbolDeIncidenciaLocal(incidencia: string): Promise<ArbolDigitalLocal[]> {
  try {
    return (await arbolDigitalLocal())
      .filter((a) => a.incidencia === incidencia)
      .sort(
        (x, y) =>
          compararTexto(x.incidencia_srd, y.incidencia_srd) ||
          compararTexto(x.causa_raiz, y.causa_raiz) ||
          compararTexto(x.solucion, y.solucion)
      );
  } catch {
    return [];
  }
}

/** Nombre amigable de cada pantalla pedida que lo tenga. */
export async function nombresPantallaLocal(ids: string[]): Promise<Record<string, string>> {
  try {
    const filas = await filasDe('nombres_pantallas');
    let mapa = derivados.get(filas) as Map<string, string> | undefined;
    if (!mapa) {
      mapa = new Map(filas.map((n) => [n.vendor_face_id, n.nombre] as [string, string]));
      derivados.set(filas, mapa);
    }
    const salida: Record<string, string> = {};
    for (const id of ids || []) {
      const n = mapa.get(id);
      if (n) salida[id] = n;
    }
    return salida;
  } catch {
    return {};
  }
}

/** El calendario de catorcenas completo, por número. */
export async function catorcenasLocal(): Promise<CatorcenaLocal[]> {
  try {
    return (await filasDe('catorcenas'))
      .map((c) => ({ ...c }))
      .sort((a, b) => a.numero - b.numero || compararTexto(a.fecha_inicio, b.fecha_inicio));
  } catch {
    return [];
  }
}

/**
 * La ventana de NuevaInc sin red: las `n` catorcenas cuyo fin cae desde hace
 * 14 días (la anterior, la actual y la siguiente), con el corte en UTC igual
 * que la consulta en línea.
 */
export async function ventanaCatorcenasLocal(n = 3): Promise<CatorcenaLocal[]> {
  const desde = claveFecha(isoDia(Date.now() - 14 * DIA));
  return (await catorcenasLocal()).filter((c) => claveFecha(c.fecha_fin) >= desde).slice(0, n);
}

/**
 * Pauta QTM de esas caras que se traslapa con [inicio, fin], como la
 * consulta de NuevaInc (`fecha_inicio <= fin` y `fecha_fin >= inicio`).
 */
export async function pautasLocal(ids: string[], inicio: string, fin: string): Promise<PautaLocal[]> {
  try {
    const caras = new Set(ids || []);
    if (!caras.size || !inicio || !fin) return [];
    const ini = claveFecha(inicio);
    const hasta = claveFecha(fin);
    return (await filasDe('qtm_pautas'))
      .filter(
        (p) =>
          caras.has(p.vendor_face_id) &&
          !!p.fecha_inicio &&
          !!p.fecha_fin &&
          claveFecha(p.fecha_inicio) <= hasta &&
          claveFecha(p.fecha_fin) >= ini
      )
      .map((p) => ({ ...p }));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------
// Lista de incidencias por usuario
// ------------------------------------------------------------

function llaveEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

function topeEscritura(filas: number): number {
  // 15 s base + 1.5 s por cada mil filas: generoso, solo evita colgarse.
  return 15000 + Math.ceil(filas / 1000) * 1500;
}

/**
 * Guarda la lista que el usuario acaba de ver. No lanza. OJO quien llama:
 * guardar SOLO datos que llegaron con sesión real (ver haySesionReal); una
 * lista pedida como anónima viene vacía y borraría la buena.
 *
 * `guardado` opcional (U3, revisión sin señal, 24-sep-2026): IncidenciasView
 * reescribe la copia con lo ya aplicado encima aunque la lista en pantalla
 * venga de la copia; manda la fecha de ESA lista para que una copia vieja con
 * una fila corregida no se haga pasar por recién bajada. Sin ella, la de ahora.
 */
export async function guardarListaLocal(
  email: string,
  lista: Omit<ListaLocal, 'guardado'> & { guardado?: string }
): Promise<void> {
  const k = llaveEmail(email);
  if (!k || !lista || !Array.isArray(lista.items)) return;
  const valor: ListaLocal = {
    guardado: lista.guardado || new Date().toISOString(),
    items: lista.items,
    fotos: lista.fotos,
    slaMap: lista.slaMap,
    slaValidacion: lista.slaValidacion,
  };
  // En memoria de una vez: aunque el teléfono no la guarde, esta pestaña sí
  // la tiene para cuando se vaya la señal.
  memListas.set(k, valor);
  try {
    await datosPut('listas', { email: k, ...valor }, topeEscritura(lista.items.length));
    avisarPestanas({ lista: k });
  } catch (e) {
    // Sin espacio: la transacción abortó y la lista anterior sigue guardada.
    if (!(e instanceof ErrorDatos && e.motivo === 'no-disponible'))
      reportarUnaVez('lista:guardar', e, {
        filas: lista.items.length,
        motivo: e instanceof ErrorDatos ? e.motivo : 'otro',
      });
  }
}

/** La última lista guardada de ese usuario, o null. No lanza. */
export async function leerListaLocal(email: string): Promise<ListaLocal | null> {
  const k = llaveEmail(email);
  if (!k) return null;
  const m = memListas.get(k);
  if (m) return m;
  try {
    const r = await datosGet<ListaLocal & { email?: string }>('listas', k);
    if (!r || !Array.isArray(r.items)) return null;
    // Tolerante a registros de una versión anterior con campos de menos.
    const lista: ListaLocal = {
      guardado: typeof r.guardado === 'string' ? r.guardado : '',
      items: r.items,
      fotos: {
        reporte: r.fotos?.reporte || {},
        reparacion: r.fotos?.reparacion || {},
        reasign: r.fotos?.reasign || {},
      },
      slaMap: r.slaMap || {},
      slaValidacion: {
        reporte: Number(r.slaValidacion?.reporte) || SLA_VALIDACION_DEFAULT.reporte,
        reparacion: Number(r.slaValidacion?.reparacion) || SLA_VALIDACION_DEFAULT.reparacion,
      },
    };
    if (!memListas.has(k)) memListas.set(k, lista);
    return memListas.get(k) || lista;
  } catch {
    return null;
  }
}

/**
 * Borra la lista guardada de ese usuario (Salir en un teléfono compartido).
 * No lanza. Las copias de catálogos e inventario no son de nadie y se quedan.
 */
export async function borrarListaLocal(email: string): Promise<void> {
  const k = llaveEmail(email);
  if (!k) return;
  memListas.delete(k);
  try {
    await datosDelete('listas', k);
    avisarPestanas({ lista: k });
  } catch {
    /* sin base: no había nada */
  }
}

// ------------------------------------------------------------
// Sesión y red
// ------------------------------------------------------------

/**
 * ¿Hay sesión REAL ahora? (getSession con tope). Sin ella, lo que se pida
 * sale con la llave anónima: la RLS contesta 200 con [] (lecturas) y
 * Storage 400/403 (subidas). Con `email`, además exige que la sesión sea de
 * ese usuario (teléfono compartido). No lanza.
 */
export async function haySesionReal(email?: string, topeMs = TOPE_SESION_MS): Promise<boolean> {
  try {
    const r = await conTope(sb.auth.getSession(), topeMs);
    if (r === TOPE) return false;
    const s = r.data?.session;
    if (!s || !s.access_token) return false;
    if (email && llaveEmail(s.user?.email || '') !== llaveEmail(email)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Por qué una lectura se quedó sin la red, para decirlo en pantalla
 * (revisión sin señal, 24-sep-2026): sin señal hay que moverse a donde haya;
 * con una red que no contestó a tiempo, basta reintentar. Antes todo decía
 * "sin señal", también con 3G lenta.
 */
export function motivoSinRed(): 'Sin señal' | 'La red tardó demasiado' {
  return haySenal() ? 'La red tardó demasiado' : 'Sin señal';
}

type RespuestaRed<T> = { data: T | null; error: unknown; status?: number };

/** ¿La respuesta no sirve? Error, sin datos, o status 0/5xx. */
function noSirve<T>(r: RespuestaRed<T>): boolean {
  return (
    !!r.error ||
    r.data === null ||
    r.data === undefined ||
    (typeof r.status === 'number' && (r.status === 0 || r.status >= 500))
  );
}

/** Promesa que se cumple con TOPE si el teléfono avisa que perdió la red. */
function alPerderSenal(): { p: Promise<typeof TOPE>; quitar: () => void } {
  let quitar = () => {};
  const p = new Promise<typeof TOPE>((res) => {
    try {
      const h = () => res(TOPE);
      window.addEventListener('offline', h);
      quitar = () => window.removeEventListener('offline', h);
    } catch {
      /* sin ventana (pruebas): solo cuenta el tope */
    }
  });
  return { p, quitar };
}

/**
 * Lee de la red con tope y, si no se puede, de la copia local.
 *   · sin señal (haySenal() false) → local de inmediato;
 *   · error, status 0/5xx, excepción o tope → local;
 *   · respuesta válida → red. Salvo que NO hubiera sesión real: entonces la
 *     consulta salió como anónima y un [] no es verdad → local (si la local
 *     viene vacía y la red trajo filas, se toman las de la red: la RLS
 *     esconde filas, nunca las inventa).
 * El tope va en DOS FASES (revisión sin señal, 24-sep-2026): el corto
 * (`topeMs`, 4 s) solo manda si la copia trae algo o si no hay señal. Si la
 * copia está vacía (primer uso con esta versión, iOS la borró, o aún se
 * baja) se le sigue esperando a la red hasta `topeSinCopiaMs` en total (20 s;
 * 0 = no se espera más), y una falla de red pasajera se reintenta una vez:
 * cortar ahí no dejaba nada que enseñar, y con 3G/2G lenta la red sí llegaba.
 * Si en la espera el teléfono avisa que perdió la red, se corta.
 * "Vacía" = [] o null (el respaldo de "no hay copia" de algunas pantallas).
 * Quien llama pone `.retry(false).abortSignal(senal)` en su consulta (si no,
 * postgrest-js reintenta ~7 s por su cuenta). La sesión se pregunta al
 * mismo tiempo que sale la consulta: fetchWithAuth hace lo mismo antes de
 * mandarla, así que las dos ven la misma.
 */
export async function redOLocal<T>(
  red: (senal: AbortSignal) => PromiseLike<RespuestaRed<T>>,
  local: () => Promise<T>,
  op?: { topeMs?: number; topeSinCopiaMs?: number }
): Promise<{ datos: T; origen: 'red' | 'local' }> {
  if (!haySenal()) return { datos: await local(), origen: 'local' };
  const ms = op?.topeMs ?? TOPE_RED_MS;
  const limite = Date.now() + Math.max(ms, op?.topeSinCopiaMs ?? TOPE_RED_SIN_COPIA_MS);
  const control = new AbortController();
  const sesion = haySesionReal(undefined, limite - Date.now() + 1000);
  // Se envuelve UNA vez: el builder de postgrest-js manda la consulta en
  // cada `.then`, y la espera en dos fases lo mira dos veces.
  const pedir = (): Promise<RespuestaRed<T>> => {
    try {
      return Promise.resolve(red(control.signal));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const esperar = async (p: Promise<RespuestaRed<T>>, tope: number, conCorte: boolean) => {
    const corte = conCorte ? alPerderSenal() : null;
    try {
      return await conTope(corte ? Promise.race([p, corte.p]) : p, Math.max(0, tope));
    } catch {
      return null; // excepción = transporte
    } finally {
      corte?.quitar();
    }
  };
  // ¿La copia trae algo? Se pregunta solo si la red no alcanzó.
  let copia: boolean | undefined;
  const sinCopia = async (): Promise<boolean> => {
    if (copia === undefined) {
      try {
        const loc = await local();
        copia = Array.isArray(loc) ? loc.length > 0 : loc !== null && loc !== undefined;
      } catch {
        copia = false;
      }
    }
    return !copia;
  };
  /** Sin copia, con señal y con tiempo: se le sigue dando chance a la red. */
  const seguir = async () => (await sinCopia()) && haySenal() && Date.now() < limite;

  let p = pedir();
  let r: RespuestaRed<T> | typeof TOPE | null = await esperar(p, ms, false);
  if (r === TOPE && (await seguir())) r = await esperar(p, limite - Date.now(), true);
  // Un solo reintento ante una falla de TRANSPORTE (sin respuesta o 5xx; un
  // 4xx no cambia al repetirlo) sin copia: es lo que antes hacía
  // postgrest-js ante un 'Load failed' o un 503.
  const pasajera = r === null || (r !== TOPE && noSirve(r) && (!r.status || r.status >= 500));
  if (pasajera && limite - Date.now() > ESPERA_REINTENTO_RED_MS + 1000 && (await seguir())) {
    await dormir(ESPERA_REINTENTO_RED_MS);
    if (haySenal()) {
      p = pedir();
      r = await esperar(p, limite - Date.now(), true);
    }
  }
  if (r === TOPE) control.abort();
  if (r === null || r === TOPE || noSirve(r)) return { datos: await local(), origen: 'local' };
  const deRed = r.data as T;
  const conSesion = await conTope(sesion, 500);
  if (conSesion === true) return { datos: deRed, origen: 'red' };
  let deLocal: T;
  try {
    deLocal = await local();
  } catch {
    return { datos: deRed, origen: 'red' };
  }
  if (Array.isArray(deLocal) && deLocal.length === 0 && Array.isArray(deRed) && deRed.length > 0)
    return { datos: deRed, origen: 'red' };
  return { datos: deLocal, origen: 'local' };
}

// ------------------------------------------------------------
// Descarga
// ------------------------------------------------------------

/** Para quién se baja: correo y unidades (minúsculas para comparar, tal cual para filtrar). */
type Alcance = { email: string; unidades: string[] | null; nombres: string[] | null };

type ResultadoPagina =
  | { tipo: 'ok'; datos: unknown[]; cuenta: number | null }
  | { tipo: 'red' | 'definitivo'; detalle: string };

type ResultadoDescarga =
  | { tipo: 'ok'; filas: unknown[] }
  | { tipo: 'red' | 'definitivo' | 'incompleta'; detalle: string };

/** HTTP que significan "no llegó o no se procesó": mismo criterio que envios.ts. */
const STATUS_TRANSITORIOS = new Set([0, 401, 408, 425, 429, 502, 503, 504, 520, 521, 522, 523, 524]);
const CODIGOS_PG_TRANSITORIOS = new Set(['57014', '40001', '40P01', '53300', '53400', '08000', '08003', '08006']);

function esFallaRed(error: { code?: string } | null, status: number | undefined): boolean {
  if (!status || STATUS_TRANSITORIOS.has(status) || status >= 500) return true;
  return !!error?.code && CODIGOS_PG_TRANSITORIOS.has(error.code);
}

/** Nombres de unidad que se pueden mandar tal cual dentro de un or=(…) de PostgREST. */
const UNIDAD_SEGURA = /^[\p{L}\p{N} .-]+$/u;

function ventanaPautas(): Ventana {
  const ahora = Date.now();
  return {
    desde: isoDia(ahora - PAUTA_ATRAS_DIAS * DIA),
    hasta: isoDia(ahora + PAUTA_ADELANTE_DIAS * DIA),
  };
}

function consultaPagina(t: TablaLocal, al: Alcance, v: Ventana | null, desde: number, senal: AbortSignal) {
  let q = sb.from(t).select(COLUMNAS[t], { count: 'exact' });
  if (t === 'inventario' && al.nombres) {
    // Sin mayúsculas, como las lecturas: la unidad puede venir escrita
    // distinto en inventario que en usuario_roles.
    q = al.nombres.every((n) => UNIDAD_SEGURA.test(n))
      ? q.or(al.nombres.map((n) => `unidad_negocio.ilike."${n}"`).join(','))
      : q.in('unidad_negocio', al.nombres);
  }
  if (t === 'qtm_pautas' && v) q = q.gte('fecha_fin', v.desde).lte('fecha_inicio', v.hasta);
  for (const c of ORDEN[t]) q = q.order(c, { ascending: true });
  return q
    .range(desde, desde + PAGINA - 1)
    .retry(false)
    .abortSignal(senal);
}

async function pagina(t: TablaLocal, al: Alcance, v: Ventana | null, desde: number): Promise<ResultadoPagina> {
  const control = new AbortController();
  try {
    const r = await conTope(consultaPagina(t, al, v, desde, control.signal), TOPE_PAGINA_MS + 5000, () =>
      control.abort()
    );
    if (r === TOPE) return { tipo: 'red', detalle: 'tope de espera' };
    const { data, error, status, count } = r;
    if (error)
      return {
        tipo: esFallaRed(error, status) ? 'red' : 'definitivo',
        detalle: `${status} ${error.code || ''} ${error.message || ''}`.trim(),
      };
    if (!Array.isArray(data)) return { tipo: 'definitivo', detalle: 'respuesta sin filas' };
    return { tipo: 'ok', datos: data, cuenta: typeof count === 'number' ? count : null };
  } catch (e) {
    // postgrest-js no suele lanzar; si algo truena aquí, es transporte.
    return { tipo: 'red', detalle: (e as { message?: string } | null)?.message || String(e) };
  }
}

async function paginaConReintento(
  t: TablaLocal,
  al: Alcance,
  v: Ventana | null,
  desde: number
): Promise<ResultadoPagina> {
  for (let i = 0; ; i++) {
    const r = await pagina(t, al, v, desde);
    if (r.tipo !== 'red' || i >= ESPERAS_PAGINA_MS.length || !haySenal()) return r;
    await dormir(ESPERAS_PAGINA_MS[i]);
  }
}

/**
 * Baja la tabla COMPLETA, de mil en mil. Completa = la cuenta exacta que da
 * el servidor es la misma en todas las páginas y coincide con lo bajado. Si
 * la tabla cambió a medio camino (la sincronización nocturna de QTM) o la
 * sesión se cayó y una página salió como anónima (cuenta 0), NO es completa.
 */
async function descargar(t: TablaLocal, al: Alcance, v: Ventana | null): Promise<ResultadoDescarga> {
  const filas: unknown[] = [];
  let cuenta: number | null | undefined;
  for (let n = 0; n < MAX_PAGINAS; n++) {
    const r = await paginaConReintento(t, al, v, filas.length);
    if (r.tipo !== 'ok') return r;
    if (cuenta === undefined) cuenta = r.cuenta;
    else if (r.cuenta !== cuenta)
      return { tipo: 'incompleta', detalle: `la cuenta cambió a medio camino (${cuenta} → ${r.cuenta})` };
    for (const d of r.datos) filas.push(d);
    if (cuenta !== null) {
      if (filas.length > cuenta) return { tipo: 'incompleta', detalle: `llegaron de más (${filas.length}/${cuenta})` };
      if (filas.length === cuenta) return { tipo: 'ok', filas };
      if (!r.datos.length) return { tipo: 'incompleta', detalle: `página vacía (${filas.length}/${cuenta})` };
    } else if (r.datos.length < PAGINA) {
      // Sin cuenta (algún proxy quitó Content-Range): se termina en la
      // primera página corta.
      return { tipo: 'ok', filas };
    }
  }
  return { tipo: 'incompleta', detalle: `pasó el tope de ${MAX_PAGINAS} páginas` };
}

/** Deja cada fila como la leen las funciones de arriba. */
function normalizar(t: TablaLocal, filas: unknown[]): unknown[] {
  if (t === 'inventario')
    return (filas as InventarioItem[]).map((r) => ({
      ...r,
      latitud: aNumero(r.latitud),
      longitud: aNumero(r.longitud),
    }));
  if (t === 'catorcenas')
    return (filas as CatorcenaLocal[]).map((c) => ({ ...c, numero: Number(c.numero) }));
  return filas;
}

function cubreUnidad(unidades: string[] | null, unidad: string | null | undefined): boolean {
  return unidades === null || unidades.includes(normUnidad(unidad));
}

/**
 * ¿Una descarga COMPLETA con 0 filas puede ser la verdad? El criterio:
 *   · inventario, catalogo_incidencias, arbol_digital, catorcenas: nunca
 *     están vacías en la operación; un 0 es RLS o sesión anónima. No se
 *     guarda: la copia que hubiera se queda (y si no había, sigue sin haber;
 *     se vuelve a intentar en una hora).
 *   · nombres_pantallas: solo si no había copia con filas.
 *   · qtm_pautas: si no había copia, o si ninguna fila de la copia sigue
 *     vigente para la ventana nueva (ya vencieron todas): una ventana sin
 *     pauta es posible y la copia vieja ya no le sirve a nadie.
 */
function vaciaEsCreible(t: TablaLocal, previas: unknown[], v: Ventana | null): boolean {
  if (t === 'nombres_pantallas') return previas.length === 0;
  if (t === 'qtm_pautas') {
    if (!previas.length) return true;
    const desde = claveFecha(v?.desde);
    return !(previas as PautaLocal[]).some((p) => !!p.fecha_fin && claveFecha(p.fecha_fin) >= desde);
  }
  return false;
}

/** Reemplaza la copia de una tabla (filas y meta en UNA transacción). */
async function guardarCopia(t: TablaLocal, filas: unknown[], meta: MetaTabla): Promise<void> {
  let enTelefono = false;
  try {
    await datosTx(
      ['meta', 'tablas'],
      'readwrite',
      (tx) => {
        tx.objectStore('tablas').put({ tabla: t, filas } as RegistroTabla);
        tx.objectStore('meta').put(meta);
      },
      topeEscritura(filas.length)
    );
    enTelefono = true;
  } catch (e) {
    // Cuota u otro: la transacción abortó entera, así que la copia anterior
    // sigue completa en el teléfono. La nueva vive en memoria de la pestaña.
    if (!(e instanceof ErrorDatos && e.motivo === 'no-disponible'))
      reportarUnaVez('guardar:' + t, e, {
        tabla: t,
        filas: filas.length,
        motivo: e instanceof ErrorDatos ? e.motivo : 'otro',
      });
  }
  subirGeneracion(t);
  memFilas.set(t, filas);
  memMeta.set(t, meta);
  if (enTelefono) avisarPestanas({ tabla: t });
}

/** Tablas en pausa tras un fallo (hasta ese instante). */
const pausas = new Map<TablaLocal, number>();

type ResultadoTabla = 'ok' | 'red' | 'sin-sesion' | 'definitivo' | 'incompleta' | 'vacia';

async function refrescarTabla(t: TablaLocal, al: Alcance): Promise<ResultadoTabla> {
  if (!(await haySesionReal(al.email))) return 'sin-sesion';
  const v = t === 'qtm_pautas' ? ventanaPautas() : null;
  const r = await descargar(t, al, v);
  if (r.tipo !== 'ok') {
    if (r.tipo === 'definitivo') {
      pausas.set(t, Date.now() + PAUSA_DEFINITIVO_MS);
      reportarUnaVez('definitivo:' + t, new Error('No se pudo copiar ' + t + ': ' + r.detalle), { tabla: t });
    } else if (r.tipo === 'incompleta') {
      pausas.set(t, Date.now() + PAUSA_INCOMPLETA_MS);
      reportarUnaVez('incompleta:' + t, new Error('Copia incompleta de ' + t + ': ' + r.detalle), { tabla: t });
    }
    return r.tipo;
  }
  // DESPUÉS: si la sesión se cayó mientras se bajaba, alguna página pudo
  // salir como anónima. No se arriesga.
  if (!(await haySesionReal(al.email))) return 'sin-sesion';
  const filas = normalizar(t, r.filas);
  if (!filas.length) {
    const previas = await filasDe(t);
    if (!vaciaEsCreible(t, previas, v)) {
      pausas.set(t, Date.now() + PAUSA_VACIA_MS);
      const relevantes =
        t === 'inventario'
          ? (previas as InventarioItem[]).filter((p) => cubreUnidad(al.unidades, p.unidad_negocio)).length
          : previas.length;
      if (relevantes)
        reportarUnaVez('vacia:' + t, new Error('La copia de ' + t + ' llegó vacía; se conserva la anterior'), {
          tabla: t,
          anteriores: relevantes,
        });
      return 'vacia';
    }
  }
  await guardarCopia(t, filas, {
    tabla: t,
    guardado: new Date().toISOString(),
    unidades: t === 'inventario' ? al.unidades : null,
    n: filas.length,
    columnas: COLUMNAS[t],
    ventana: v,
  });
  return 'ok';
}

function cubre(copia: string[] | null | undefined, pedido: string[] | null): boolean {
  if (copia === null) return true; // la copia es de todas las unidades
  if (!Array.isArray(copia)) return false;
  if (pedido === null) return false;
  const s = new Set(copia);
  return pedido.every((u) => s.has(u));
}

function incluyeEcovallas(unidades: string[] | null): boolean {
  return unidades === null || unidades.includes('ecovallas');
}

async function tocaRefrescar(t: TablaLocal, al: Alcance): Promise<boolean> {
  // La pauta QTM solo la usa el alta de Ecovallas.
  if (t === 'qtm_pautas' && !incluyeEcovallas(al.unidades)) return false;
  if (t === 'inventario' && al.unidades !== null && al.unidades.length === 0) return false;
  const pausa = pausas.get(t);
  if (pausa && Date.now() < pausa) return false;
  const m = await leerMeta(t);
  if (!m) return true;
  if (m.columnas !== COLUMNAS[t]) return true;
  if (t === 'inventario' && !cubre(m.unidades, al.unidades)) return true;
  const edad = Date.now() - Date.parse(m.guardado);
  // Reloj movido hacia atrás o fecha rota: se vuelve a bajar.
  if (!Number.isFinite(edad) || edad < 0) return true;
  return edad > (t === 'qtm_pautas' ? VIGENCIA_PAUTAS_MS : VIGENCIA_MS);
}

// ------------------------------------------------------------
// Sincronización
// ------------------------------------------------------------

type Sinc = { id: number; al: Alcance; clave: string };

let sinc: Sinc | null = null;
let idSinc = 0;
let detenerActual: (() => void) | null = null;
let enVuelta: Promise<void> | null = null;
let repetir = false;
/** Última vuelta que llegó al servidor (con red y sesión). */
let ultimaConRed = 0;
/** Último intento, llegara o no. */
let ultimoIntento = 0;
/** Configuración (correo + unidades) de la última vuelta que llegó al servidor. */
let claveUltimaVuelta = '';
/**
 * La última vuelta que llegó al servidor se cortó a medias (sin red, sin
 * sesión, o se detuvo). ultimaConRed se marca al EMPEZAR, así que sin esto
 * el 'online' o el TOKEN_REFRESHED de cuando regresa la señal se descartaban
 * un minuto y la copia se quedaba incompleta horas (revisión sin señal,
 * 24-sep-2026).
 */
let ultimaCortada = false;

/**
 * Una sola vuelta entre pestañas (Web Locks); sin Web Locks, sin candado.
 * false = otra pestaña la tiene (no se espera).
 */
async function conCandado(fn: () => Promise<void>): Promise<boolean> {
  const locks =
    typeof navigator !== 'undefined'
      ? (navigator as unknown as { locks?: LockManager }).locks
      : undefined;
  if (!locks || typeof locks.request !== 'function') {
    await fn();
    return true;
  }
  let corrio = false;
  let libre = true;
  try {
    await locks.request('gpo-datos-sinc', { ifAvailable: true }, async (lock) => {
      if (!lock) {
        libre = false;
        return;
      }
      corrio = true;
      await fn();
    });
  } catch (err) {
    if (corrio) throw err;
    await fn();
  }
  return libre;
}

/**
 * Otra pestaña estaba bajando: su copia le llega a esta por el canal, pero
 * pudo ser para otras unidades. Se revisa otra vez en un rato.
 */
let relojOcupado: ReturnType<typeof setTimeout> | null = null;
function reintentarLuego(): void {
  if (relojOcupado !== null) return;
  relojOcupado = setTimeout(() => {
    relojOcupado = null;
    pedirVuelta('red');
  }, 30 * 1000);
}

async function vuelta(s: Sinc): Promise<void> {
  ultimoIntento = Date.now();
  if (!haySenal()) return;
  // Sigue vigente mientras la configuración sea la misma (un detener y
  // volver a iniciar igual —React en desarrollo— no corta la vuelta).
  const vigente = () => sinc !== null && sinc.clave === s.clave;
  const libre = await conCandado(async () => {
    if (!vigente()) return;
    if (!(await haySesionReal(s.al.email))) return;
    ultimaConRed = Date.now();
    claveUltimaVuelta = s.clave;
    // Cortada hasta que la vuelta llegue al final (si algo lanza, también).
    ultimaCortada = true;
    for (const t of SECUENCIA) {
      if (!vigente() || !haySenal()) return;
      if (!(await tocaRefrescar(t, s.al))) continue;
      const r = await refrescarTabla(t, s.al);
      // Sin red o sin sesión, las demás darían lo mismo: a la siguiente.
      if (r === 'red' || r === 'sin-sesion') return;
    }
    ultimaCortada = false;
  });
  if (!libre && vigente()) reintentarLuego();
}

/**
 * Quién pide la vuelta:
 *   llamada → iniciarSincronizacion (con configuración nueva no espera);
 *   red     → volvió la red ('online');
 *   sesion  → auth-js renovó o recuperó la sesión (fin de la ventana sin
 *             sesión al volver la red);
 *   vista   → la app volvió a primer plano;
 *   reloj   → la vuelta de cada 6 h.
 */
type MotivoVuelta = 'llamada' | 'red' | 'sesion' | 'vista' | 'reloj';

/**
 * Pide una vuelta. Espaciada: si la última llegó al servidor hace menos de
 * un minuto, no (auth-js emite SIGNED_IN en cada regreso a primer plano, y
 * iOS dispara visibilitychange a cada rato). Los intentos que NO llegaron
 * (sin red o sin sesión) son baratos; solo se espacian 5 s los de primer
 * plano y reloj. La red o la sesión que regresan siempre pasan: si la última
 * vuelta se cortó, 'red' y 'sesion' no esperan el minuto ('vista' y 'reloj'
 * sí). OJO: auth-js también emite SIGNED_IN (→ 'sesion') en cada regreso a
 * primer plano, así que tras un corte el primer plano sí reintenta, una
 * vuelta a la vez; con la copia completa se vuelve al minuto.
 */
function pedirVuelta(motivo: MotivoVuelta): void {
  const s = sinc;
  if (!s) return;
  const nueva = motivo === 'llamada' && s.clave !== claveUltimaVuelta;
  if (enVuelta) {
    if (nueva) repetir = true;
    return;
  }
  if (!nueva) {
    const ahora = Date.now();
    const desdeRed = ahora - ultimaConRed;
    const desdeIntento = ahora - ultimoIntento;
    const regresoTrasCorte = ultimaCortada && (motivo === 'red' || motivo === 'sesion');
    if (!regresoTrasCorte && desdeRed >= 0 && desdeRed < ESPACIO_VUELTAS_MS) return;
    if ((motivo === 'vista' || motivo === 'reloj') && desdeIntento >= 0 && desdeIntento < ESPACIO_INTENTOS_MS)
      return;
  }
  const p = vuelta(s)
    .catch((e) => reportarUnaVez('vuelta', e))
    .finally(() => {
      if (enVuelta === p) enVuelta = null;
      if (repetir) {
        repetir = false;
        pedirVuelta('llamada');
      }
    });
  enVuelta = p;
}

/**
 * Safari puede borrar IndexedDB de un sitio que no se abre en días. Pedir
 * almacenamiento persistente (Safari 17+, Chrome) protege las copias y la
 * cola. Solo en la app instalada: Firefox de escritorio lo pregunta con un
 * aviso que confundiría.
 */
let persistenciaPedida = false;
function pedirPersistencia(): void {
  if (persistenciaPedida) return;
  persistenciaPedida = true;
  try {
    const st = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!st || typeof st.persist !== 'function' || typeof st.persisted !== 'function') return;
    const instalada =
      (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches) ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (!instalada) return;
    st.persisted()
      .then((ya) => (ya ? true : st.persist()))
      .catch(() => {});
  } catch {
    /* sin API: no pasa nada */
  }
}

/**
 * Carga a memoria, sin prisa, lo que el alta y la reparación buscan
 * primero: así la primera búsqueda sin señal no espera a IndexedDB.
 */
let precalentado = false;
function precalentar(): void {
  if (precalentado) return;
  precalentado = true;
  setTimeout(() => {
    filasDe('inventario').catch(() => {});
    filasDe('catalogo_incidencias').catch(() => {});
    filasDe('arbol_digital').catch(() => {});
  }, 3000);
}

/**
 * Mantiene las copias al día para ese usuario. `unidades` null = todas.
 * Baja lo que haga falta al llamar, al volver la red ('online'), al volver
 * a primer plano, al renovarse la sesión y cada 6 h; cada tabla solo si su
 * copia tiene más de 12 h (qtm_pautas, 6 h) o no cubre las unidades. Sin
 * red, o sin sesión real, no hace nada. Una sola sincronización a la vez:
 * llamar otra vez reemplaza la anterior. Devuelve la función para detenerla.
 */
export function iniciarSincronizacion(op: { email: string; unidades: string[] | null }): () => void {
  detenerActual?.();
  const email = llaveEmail(op?.email || '');
  if (!email) return () => {};
  const nombres =
    op.unidades === null || op.unidades === undefined
      ? null
      : [...new Set(op.unidades.map((u) => (u || '').trim()).filter(Boolean))];
  const unidades = nombres === null ? null : [...new Set(nombres.map(normUnidad))].sort();
  const id = ++idSinc;
  const clave = email + '|' + (unidades === null ? '*' : unidades.join(','));
  sinc = { id, al: { email, unidades, nombres }, clave };

  const alVolverRed = () => pedirVuelta('red');
  const alCambiarVista = () => {
    if (document.visibilityState === 'visible') pedirVuelta('vista');
  };
  let reloj: ReturnType<typeof setInterval> | null = null;
  let sub: { unsubscribe: () => void } | null = null;
  try {
    window.addEventListener('online', alVolverRed);
    document.addEventListener('visibilitychange', alCambiarVista);
    reloj = setInterval(() => pedirVuelta('reloj'), CADA_MS);
    // Al renovarse el token (fin de la ventana sin sesión al volver la red).
    // Diferido: dentro del aviso de auth-js no se debe llamar a getSession.
    sub = sb.auth.onAuthStateChange((evento) => {
      if (evento === 'TOKEN_REFRESHED' || evento === 'SIGNED_IN') setTimeout(() => pedirVuelta('sesion'), 0);
    }).data.subscription;
  } catch {
    /* sin ventana (pruebas): queda la vuelta de ahora */
  }
  pedirPersistencia();
  precalentar();
  pedirVuelta('llamada');

  let detenida = false;
  const detener = () => {
    if (detenida) return;
    detenida = true;
    try {
      window.removeEventListener('online', alVolverRed);
      document.removeEventListener('visibilitychange', alCambiarVista);
    } catch {
      /* nada */
    }
    if (reloj !== null) clearInterval(reloj);
    try {
      sub?.unsubscribe();
    } catch {
      /* nada */
    }
    if (sinc?.id === id) {
      sinc = null;
      if (relojOcupado !== null) clearTimeout(relojOcupado);
      relojOcupado = null;
    }
    if (detenerActual === detener) detenerActual = null;
  };
  detenerActual = detener;
  return detener;
}
