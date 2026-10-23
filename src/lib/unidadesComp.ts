// ============================================================
// src/lib/unidadesComp.ts
// Unidades de Comprobaciones, sin dependencias (23-oct-2026).
//
// POR QUÉ. helpers.ts va en el chunk principal (lo importa App) y necesita
// la lista para unidadesComprobaciones(). Si la tomaba de comprobaciones.ts,
// rollup metía ese núcleo entero (~10 kB) en index-*.js aunque solo lo usen
// las pestañas diferidas. comprobaciones.ts la reexporta: el resto del
// módulo sigue importándola de ahí.
// ============================================================

export type UnidadComp = 'Ecovallas' | 'Biobox' | 'Vía Verde';

export const UNIDADES_COMP: readonly UnidadComp[] = ['Ecovallas', 'Biobox', 'Vía Verde'];
