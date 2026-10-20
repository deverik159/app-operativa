// ============================================================
// src/lib/analistaPauta.ts
// Nombres y carpetas de las fotos que el coordinador manda al analista
// (Erik, 20-oct-2026).
//
// El analista recibe las fotos comprobadas de una campaña en carpetas
// campaña → versión. En Ecovallas cada foto se llama con el vendor_face_id
// (ya trae la cara) y un número: MX_CM_EV_EVA_01_3325_1.jpg. En Vía Verde y
// Biobox se llamará con el sitio cuando entren a Pauta.
//
// Sin dependencias de React ni de Supabase: lo prueban tests/analistaPauta.
// ============================================================
import { paraArchivo } from './indicadoresPauta';

/** Lo que estos cálculos leen de una fila de `pauta_envio_fotos`. */
export type FotoEnvio = {
  id: number;
  envio_id: number;
  campana: string;
  version: string | null;
  vendor_face_id: string;
  site_id: string | null;
  tipo: string | null;
  original_url: string;
  n: number;
  estado: 'pendiente' | 'correcta' | 'editada';
  editada_url: string | null;
};

export const SIN_VERSION = '(sin versión)';

/** Extensión del archivo: la de la liga si es creíble; si no, por tipo. */
export function extension(url: string, tipo: string | null): string {
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(url || '');
  if (m) return m[1].toLowerCase();
  return tipo === 'video' ? 'mp4' : 'jpg';
}

/** La liga que vale: la editada si existe. */
export function urlVigente(f: Pick<FotoEnvio, 'estado' | 'editada_url' | 'original_url'>): string {
  return f.estado === 'editada' && f.editada_url ? f.editada_url : f.original_url;
}

/** "MX_CM_EV_EVA_01_3325_1.jpg" (la extensión, de la foto vigente). */
export function nombreFoto(f: FotoEnvio): string {
  return `${f.vendor_face_id}_${f.n}.${extension(urlVigente(f), f.tipo)}`;
}

/** Nombre de carpeta seguro para un ZIP (sin acentos ni diagonales). */
export function carpeta(s: string | null | undefined, vacio: string): string {
  const t = (s || '').trim();
  return t ? paraArchivo(t) : paraArchivo(vacio);
}

export type GrupoVersion = { version: string; fotos: FotoEnvio[] };
export type GrupoCampanaAnalista = { campana: string; versiones: GrupoVersion[] };

/**
 * Carpetas campaña → versión, como las ve el analista. Versiones en orden
 * alfabético (la que no trae versión, al final); fotos por cara y número.
 */
export function carpetasAnalista(fotos: FotoEnvio[]): GrupoCampanaAnalista[] {
  const m = new Map<string, Map<string, FotoEnvio[]>>();
  for (const f of fotos) {
    const c = f.campana;
    const v = (f.version || '').trim() || SIN_VERSION;
    const vs = m.get(c) || new Map<string, FotoEnvio[]>();
    vs.set(v, [...(vs.get(v) || []), f]);
    m.set(c, vs);
  }
  const ordenVersion = (a: string, b: string) =>
    a === SIN_VERSION ? 1 : b === SIN_VERSION ? -1 : a.localeCompare(b, 'es', { numeric: true });
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'es'))
    .map(([campana, vs]) => ({
      campana,
      versiones: [...vs.entries()]
        .sort((a, b) => ordenVersion(a[0], b[0]))
        .map(([version, fs]) => ({
          version,
          fotos: fs
            .slice()
            .sort((a, b) => a.vendor_face_id.localeCompare(b.vendor_face_id) || a.n - b.n),
        })),
    }));
}

/**
 * Ruta de cada foto dentro del ZIP: Campana/Version/archivo. Si dos fotos
 * cayeran en el mismo nombre (no debería: n es único por cara y campaña),
 * se les agrega un sufijo para no pisarse.
 */
export function rutasZip(grupos: GrupoCampanaAnalista[]): { ruta: string; foto: FotoEnvio }[] {
  const usadas = new Set<string>();
  const out: { ruta: string; foto: FotoEnvio }[] = [];
  for (const g of grupos)
    for (const v of g.versiones)
      for (const f of v.fotos) {
        const base = `${carpeta(g.campana, 'sin-campana')}/${carpeta(v.version === SIN_VERSION ? '' : v.version, 'sin-version')}/`;
        let ruta = base + nombreFoto(f);
        for (let k = 2; usadas.has(ruta); k++) ruta = base + nombreFoto(f).replace(/(\.[^.]+)$/, `_${k}$1`);
        usadas.add(ruta);
        out.push({ ruta, foto: f });
      }
  return out;
}

/** Conteo de un envío: pendientes, correctas y editadas. */
export function resumenEnvio(fotos: Pick<FotoEnvio, 'estado'>[]) {
  const r = { total: fotos.length, pendientes: 0, correctas: 0, editadas: 0 };
  for (const f of fotos) {
    if (f.estado === 'pendiente') r.pendientes++;
    else if (f.estado === 'correcta') r.correctas++;
    else r.editadas++;
  }
  return r;
}
