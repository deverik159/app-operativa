// ============================================================
// src/lib/historialIncApi.ts
// Lectura del historial de incidencias (ver lib/historialInc.ts).
// ============================================================
import { sb } from './supabase';
import type { EventoHistorial } from './historialInc';

const LOTE = 150;

/**
 * El historial de estas incidencias, por record_id. null si falló (mala
 * señal): quien llama conserva lo que ya tenía.
 */
export async function traerHistorial(
  ids: readonly string[]
): Promise<Record<string, EventoHistorial[]> | null> {
  const mapa: Record<string, EventoHistorial[]> = {};
  const unicos = [...new Set(ids.filter(Boolean))];
  for (let k = 0; k < unicos.length; k += LOTE) {
    const lote = unicos.slice(k, k + LOTE);
    const { data, error } = await sb
      .from('incidencias_historial')
      .select('record_id,evento,estatus_antes,estatus_nuevo,por_email,en,detalle,reconstruido')
      .in('record_id', lote)
      .order('en', { ascending: true })
      .retry(false);
    if (error) return null;
    lote.forEach((rid) => (mapa[rid] = []));
    ((data as EventoHistorial[] | null) || []).forEach((e) => {
      (mapa[e.record_id] ||= []).push(e);
    });
  }
  return mapa;
}
