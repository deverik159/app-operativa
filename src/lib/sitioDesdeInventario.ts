// ============================================================
// src/lib/sitioDesdeInventario.ts
// Al importar la pauta, la clave de sitio de cada cara sale del inventario
// (QTM), no del archivo.
//
// QTM rige para saber a qué sitio pertenece una cara (Erik, 20-oct-2026).
// La pauta 16-2026 traía MX_CM_EV_0001 para la cara MX_CM_EV_MUR_0001, que en
// QTM es del sitio MX_CM_MUR_0001; "Sincronizar rutas" crea las paradas por
// site_id, así que ese error dejaba una parada fantasma sin coordenadas.
//
// - Cara que está en el inventario: se usa su sitio; si difiere del archivo,
//   se reporta como corregida.
// - Cara que no está en el inventario: se deja el sitio del archivo y se
//   cuenta aparte.
// ============================================================

/** Una corrección hecha a una cara: el sitio del archivo y el de QTM. */
export type SitioCorregido = { vendor_face_id: string; archivo: string | null; inventario: string };

export type ResultadoSitios<T> = {
  filas: T[];
  /** Una por cara (no por fila), en orden de aparición. */
  corregidas: SitioCorregido[];
  /** Caras que no están en el inventario, sin repetir. */
  sinInventario: string[];
};

/**
 * Pone en cada fila el site_id que dice el inventario para su cara.
 * `sitioPorCara` es vendor_face_id → site_id, leído de `inventario`.
 * No modifica las filas recibidas.
 */
export function sitiosDesdeInventario<
  T extends { site_id: string | null; vendor_face_id: string | null },
>(filas: T[], sitioPorCara: Map<string, string>): ResultadoSitios<T> {
  const corregidas = new Map<string, SitioCorregido>();
  const sinInventario = new Set<string>();

  const nuevas = filas.map((f) => {
    const cara = f.vendor_face_id;
    if (!cara) return f;
    const sitio = sitioPorCara.get(cara);
    if (!sitio) {
      sinInventario.add(cara);
      return f;
    }
    if (sitio === f.site_id) return f;
    if (!corregidas.has(cara)) {
      corregidas.set(cara, { vendor_face_id: cara, archivo: f.site_id, inventario: sitio });
    }
    return { ...f, site_id: sitio };
  });

  return { filas: nuevas, corregidas: [...corregidas.values()], sinInventario: [...sinInventario] };
}

/** Caras distintas de las filas, para consultar el inventario por lotes. */
export function carasDe(filas: { vendor_face_id: string | null }[]): string[] {
  return [...new Set(filas.map((f) => f.vendor_face_id).filter((c): c is string => !!c))];
}
