// ============================================================
// src/lib/origenInc.ts
// ¿De dónde viene la incidencia? (Erik, 17-nov-2026)
//
// Un técnico de Op. Bio Box o de TI no distinguía en «Mis pendientes» lo que
// reportó la gente de la operación en campo de lo que reportó un usuario
// final desde la app Biobox. Dos orígenes:
//   · 'app'   → area_reportante = 'App Biobox' (la crea la bandeja de
//               reportes de la app).
//   · 'campo' → todo lo demás: Operaciones, Monitoreo, MKT… (personal de
//               GPO Vallas).
// Sin supabase: se prueba en tests/origenInc.test.mjs.
// ============================================================
export type Origen = 'campo' | 'app';

export const AREA_APP_BIOBOX = 'App Biobox';

export const ORIGEN_LABEL: Record<Origen, string> = {
  campo: 'Operación / campo',
  app: 'Usuario App Biobox',
};

export function origenInc(i: { area_reportante?: string | null }): Origen {
  return (i.area_reportante || '').trim() === AREA_APP_BIOBOX ? 'app' : 'campo';
}

/** Cuántas hay de cada origen (para los botones del filtro). */
export function contarOrigen(lista: readonly { area_reportante?: string | null }[]): Record<Origen, number> {
  const n: Record<Origen, number> = { campo: 0, app: 0 };
  for (const i of lista) n[origenInc(i)]++;
  return n;
}
