// ============================================================
// src/lib/misTomasApi.ts
// La lectura de la lista del monitorista (Mis rutas › Comprobaciones, fase 3).
//
// Salió de comprobacionesApi.ts en la revisión del 26-oct-2026
// (regresiones-1): Mis rutas la importaba de ahí y cualquiera que abría Mis
// rutas bajaba el API completo del Supervisor (Campañas, Armar, Excel…), y
// el Supervisor y la analista bajaban la lógica de la lista del monitorista.
// Aquí solo va la RPC con su tope y la clasificación de fallas compartida
// (fallasComp.ts). Nunca lanza.
// ============================================================

import { sb } from './supabase';
import { tope } from './envios';
import { clasificarErrorComp, codigoFallaComp, type ResultadoComp } from './fallasComp';
import { leerMisTomas, type RespMisTomas } from './misTomasComp';

/** Tope de la lectura (el mismo TOPE_LECTURA_COMP_MS de comprobacionesApi). */
const TOPE_MIS_TOMAS_MS = 20000;

/** comp_mis_tomas acepta de 0 a 45 días (si no, CP002). */
export const MAX_DIAS_MIS_TOMAS = 45;

function falla(error: unknown, status?: number | null): ResultadoComp<never> {
  const c = clasificarErrorComp(error, status);
  return { ok: false, ...c, codigo: codigoFallaComp(error, status, c.sinRed) };
}

/**
 * comp_mis_tomas(p_desde, p_hasta): las tomas del monitorista (las suyas,
 * las devueltas que él tomó y las vencidas de hasta 31 días). Antes de
 * leer, la base refresca la ruta de SUS tomas sin fotos (A4). Quien no es
 * monitorista recibe {tomas: []} (no es error). Una respuesta que no se
 * entiende es falla 'otro' y no se guarda en el teléfono.
 */
export async function leerMisTomasComp(desde: string, hasta: string): Promise<ResultadoComp<RespMisTomas>> {
  let r: { data: unknown; error: unknown; status: number };
  try {
    r = (await sb
      .rpc('comp_mis_tomas', { p_desde: desde, p_hasta: hasta })
      .abortSignal(tope(TOPE_MIS_TOMAS_MS))) as unknown as { data: unknown; error: unknown; status: number };
  } catch (e) {
    return falla(e);
  }
  if (r.error || r.status === 0) return falla(r.error, r.status);
  const d = leerMisTomas(r.data);
  if (!d)
    return {
      ok: false,
      error: 'La base contestó algo que esta versión de la app no entiende. Actualiza la app.',
      sinRed: false,
      codigo: 'otro',
    };
  return { ok: true, data: d };
}
