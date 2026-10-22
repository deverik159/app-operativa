// ============================================================
// src/lib/analistaPauta.ts
// Cola del analista de Pauta (Erik, 20 y 22-oct-2026).
//
// Cada toma que registra el monitorista le llega al analista. La ve en
// carpetas campaña → versión; cada foto se llama con el vendor_face_id (en
// Ecovallas ya trae la cara) y un número: MX_CM_EV_EVA_01_3325_1.jpg. En Vía
// Verde y Biobox se llamará con el sitio cuando entren a Pauta.
//
// Sin dependencias de React ni de Supabase: lo prueban tests/analistaPauta.
// ============================================================
import { paraArchivo } from './indicadoresPauta';

/** Lo que estos cálculos leen de una fila de vw_pauta_ruta. */
export type FilaAnalista = {
  vendor_face_id: string;
  site_id: string;
  cara: string | null;
  campana: string | null;
  version: string | null;
  estatus?: string | null;
  fecha_fijacion?: string | null;
  ruta_clave: string | null;
  secuencia?: number | null;
  avance: string;
  fecha_toma: string | null;
  toma_por: string | null;
  fecha_comprobacion: string | null;
  rechazo_motivo?: string | null;
};

/** Una foto vigente de la toma, con su revisión. */
export type FotoRevision = {
  evidencia_id: number;
  vendor_face_id: string;
  url: string;
  tipo: string | null;
  creado_en: string;
  /** Número dentro de su cara (orden en que se subió): el archivo es <vfid>_<n>. */
  n: number;
  estado: 'pendiente' | 'correcta' | 'editada';
  editada_url: string | null;
};

export type Bandeja = 'por_revisar' | 'comprobadas' | 'regresadas';

export const SIN_CAMPANA_A = '(sin campaña)';
export const SIN_VERSION = '(sin versión)';

/**
 * Una fila por cara: la vista trae una por versión de la pauta. Manda la de
 * estatus NUEVO y, entre iguales, la de fijación más reciente (igual que la
 * base al elegir la versión).
 */
export function unaPorCara<T extends FilaAnalista>(filas: T[]): T[] {
  const m = new Map<string, T>();
  const peso = (f: T) => (f.estatus === 'NUEVO' ? 1 : 0);
  for (const f of filas) {
    const ya = m.get(f.vendor_face_id);
    if (
      !ya ||
      peso(f) > peso(ya) ||
      (peso(f) === peso(ya) && (f.fecha_fijacion || '') > (ya.fecha_fijacion || ''))
    )
      m.set(f.vendor_face_id, f);
  }
  return [...m.values()];
}

/** ¿En qué bandeja del analista cae la cara? null = en ninguna (pendiente de tomar). */
export function bandejaDe(f: FilaAnalista): Bandeja | null {
  if (f.fecha_toma && !f.fecha_comprobacion) return 'por_revisar';
  if (f.fecha_comprobacion) return 'comprobadas';
  if (f.rechazo_motivo) return 'regresadas';
  return null;
}

export type GrupoVersion<T> = { version: string; caras: T[] };
export type GrupoCampana<T> = { campana: string; versiones: GrupoVersion<T>[]; total: number };

/**
 * Carpetas campaña → versión de las caras de una bandeja. Campañas en orden
 * alfabético; versiones igual, con la que no trae versión al final; caras
 * por ruta, secuencia y vendor_face_id (el orden del recorrido).
 */
export function carpetasAnalista<T extends FilaAnalista>(filas: T[], bandeja: Bandeja): GrupoCampana<T>[] {
  const m = new Map<string, Map<string, T[]>>();
  for (const f of unaPorCara(filas)) {
    if (bandejaDe(f) !== bandeja) continue;
    const c = (f.campana || '').trim() || SIN_CAMPANA_A;
    const v = (f.version || '').trim() || SIN_VERSION;
    const vs = m.get(c) || new Map<string, T[]>();
    vs.set(v, [...(vs.get(v) || []), f]);
    m.set(c, vs);
  }
  const ordenVersion = (a: string, b: string) =>
    a === SIN_VERSION ? 1 : b === SIN_VERSION ? -1 : a.localeCompare(b, 'es', { numeric: true });
  const ordenCara = (a: T, b: T) =>
    (a.ruta_clave || '').localeCompare(b.ruta_clave || '', 'es', { numeric: true }) ||
    (a.secuencia ?? Infinity) - (b.secuencia ?? Infinity) ||
    a.vendor_face_id.localeCompare(b.vendor_face_id);
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'es'))
    .map(([campana, vs]) => {
      const versiones = [...vs.entries()]
        .sort((a, b) => ordenVersion(a[0], b[0]))
        .map(([version, cs]) => ({ version, caras: cs.slice().sort(ordenCara) }));
      return { campana, versiones, total: versiones.reduce((n, v) => n + v.caras.length, 0) };
    });
}

/** Numera las fotos de cada cara en el orden en que se subieron (1, 2, 3…). */
export function numerar<T extends Omit<FotoRevision, 'n'>>(fotos: T[]): (T & { n: number })[] {
  const cuenta = new Map<string, number>();
  return fotos
    .slice()
    .sort((a, b) => a.vendor_face_id.localeCompare(b.vendor_face_id) || a.creado_en.localeCompare(b.creado_en) || a.evidencia_id - b.evidencia_id)
    .map((f) => {
      const n = (cuenta.get(f.vendor_face_id) || 0) + 1;
      cuenta.set(f.vendor_face_id, n);
      return { ...f, n };
    });
}

/** Extensión del archivo: la de la liga si es creíble; si no, por tipo. */
export function extension(url: string, tipo: string | null): string {
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(url || '');
  if (m) return m[1].toLowerCase();
  return tipo === 'video' ? 'mp4' : 'jpg';
}

/** La liga que vale: la editada si existe. */
export function urlVigente(f: Pick<FotoRevision, 'estado' | 'editada_url' | 'url'>): string {
  return f.estado === 'editada' && f.editada_url ? f.editada_url : f.url;
}

/** "MX_CM_EV_EVA_01_3325_1.jpg" (la extensión, de la foto vigente). */
export function nombreFoto(f: FotoRevision): string {
  return `${f.vendor_face_id}_${f.n}.${extension(urlVigente(f), f.tipo)}`;
}

/** Nombre de carpeta seguro para un ZIP (sin acentos ni diagonales). */
export function carpeta(s: string | null | undefined, vacio: string): string {
  const t = (s || '').trim();
  return paraArchivo(t || vacio);
}

/** Ruta de cada foto dentro del ZIP: Campana/Version/archivo, sin repetir. */
export function rutasZip(campana: string, version: string, fotos: FotoRevision[]): { ruta: string; foto: FotoRevision }[] {
  const base = `${carpeta(campana === SIN_CAMPANA_A ? '' : campana, 'sin-campana')}/${carpeta(version === SIN_VERSION ? '' : version, 'sin-version')}/`;
  const usadas = new Set<string>();
  return fotos.map((foto) => {
    let ruta = base + nombreFoto(foto);
    for (let k = 2; usadas.has(ruta); k++) ruta = base + nombreFoto(foto).replace(/(\.[^.]+)$/, `_${k}$1`);
    usadas.add(ruta);
    return { ruta, foto };
  });
}

/** Conteo de las fotos de una cara o carpeta. */
export function resumenFotos(fotos: Pick<FotoRevision, 'estado'>[]) {
  const r = { total: fotos.length, pendientes: 0, correctas: 0, editadas: 0 };
  for (const f of fotos) {
    if (f.estado === 'pendiente') r.pendientes++;
    else if (f.estado === 'correcta') r.correctas++;
    else r.editadas++;
  }
  return r;
}
