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
import { CLAVE_SIN_MAQUINA } from './constants';

export type Origen = 'campo' | 'app';

export const AREA_APP_BIOBOX = 'App Biobox';

export const ORIGEN_LABEL: Record<Origen, string> = {
  campo: 'Operación / campo',
  app: 'Usuario App Biobox',
};

export function origenInc(i: { area_reportante?: string | null }): Origen {
  return (i.area_reportante || '').trim() === AREA_APP_BIOBOX ? 'app' : 'campo';
}

/**
 * Reportada sin máquina (clave de sitio SIN-MAQUINA): quien la repara elige
 * la máquina (Erik, 17-nov-2026: filtro aparte en Mis pendientes). Al
 * elegirla deja de contar.
 */
export function esSinMaquina(i: { clave_sitio?: string | null }): boolean {
  return (i.clave_sitio || '').trim() === CLAVE_SIN_MAQUINA;
}

type ParaContar = { area_reportante?: string | null; clave_sitio?: string | null };

/** Cuántas hay de cada origen y sin máquina (para los botones del filtro). */
export function contarOrigen(
  lista: readonly ParaContar[]
): Record<Origen, number> & { sinMaquina: number } {
  const n = { campo: 0, app: 0, sinMaquina: 0 };
  for (const i of lista) {
    n[origenInc(i)]++;
    if (esSinMaquina(i)) n.sinMaquina++;
  }
  return n;
}
