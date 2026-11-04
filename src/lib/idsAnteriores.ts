// ============================================================
// src/lib/idsAnteriores.ts
// IDs viejos de las máquinas Biobox (tabla `inventario_ids_anteriores`,
// Erik, 3-nov-2026). Desde ese día el ID de cada máquina es su
// vendor_face_id; 15 traían de QTM otro (p. ej. MX_EM_BB_IID_0002 para
// MX_EM_BB_UCL_0007). Aquí se arma el alias para que buscar por el ID viejo
// encuentre la máquina y para enseñar «antes: …» junto al nuevo.
// Sin acceso a la base: la consulta la hace cada vista.
// ============================================================

/** Fila de `inventario_ids_anteriores`. */
export type IdAnterior = { id_anterior: string; vendor_face_id: string };

/** vendor_face_id → sus IDs anteriores, ordenados. */
export type IdsAnteriores = Map<string, string[]>;

export const COLUMNAS_IDS_ANTERIORES = 'id_anterior,vendor_face_id';

export function armarIdsAnteriores(filas: IdAnterior[] | null | undefined): IdsAnteriores {
  const m: IdsAnteriores = new Map();
  for (const f of filas || []) {
    const viejo = (f.id_anterior || '').trim();
    const nuevo = (f.vendor_face_id || '').trim();
    if (!viejo || !nuevo || viejo === nuevo) continue;
    const lista = m.get(nuevo) || [];
    if (!lista.includes(viejo)) lista.push(viejo);
    m.set(nuevo, lista.sort());
  }
  return m;
}

/** IDs anteriores de una cara o máquina (vacío si no tiene). */
export function anterioresDe(ids: IdsAnteriores, vendorFaceId: string | null | undefined): string[] {
  return (vendorFaceId && ids.get(vendorFaceId)) || [];
}

/**
 * Caras cuyo ID anterior contiene el texto buscado, sin importar mayúsculas.
 * Igual que la búsqueda por clave: «iid_0002» encuentra MX_EM_BB_UCL_0007.
 */
export function carasPorIdAnterior(ids: IdsAnteriores, texto: string): string[] {
  const t = texto.trim().toUpperCase();
  if (!t) return [];
  const caras: string[] = [];
  for (const [vfid, viejos] of ids) {
    if (viejos.some((v) => v.toUpperCase().includes(t))) caras.push(vfid);
  }
  return caras;
}
