// ============================================================
// src/lib/visitaMaquina.ts
// Lo PURO de la visita rápida a máquinas Biobox (29-oct-2026): cuántos días
// lleva cada máquina sin que nadie pase, su semáforo y si la visita se marcó
// lejos de la máquina. Sin red ni React: lo prueba
// tests/visitaMaquina.test.mjs.
//
// «Visitada» cuenta lo último entre una visita rápida y una revisión
// completa (el checklist también es estar en la máquina), sea del técnico
// que sea: la visita es de la máquina, no de la ruta.
//
// Los días se cuentan por día de CDMX (lib/fechasCdmx): una visita a las
// 19:00 es de hoy aunque en UTC ya sea mañana.
// ============================================================
import { diaCdmx } from './fechasCdmx';
import { metros, type Punto } from './haversine';

/**
 * Semáforo de días sin visita. Erik aún no dice cada cuánto debe visitarse
 * una máquina (29-oct-2026): verde hasta 7 días, ámbar hasta 14, rojo más.
 */
export const DIAS_VISITA_VERDE = 7;
export const DIAS_VISITA_AMBAR = 14;

/**
 * Más lejos que esto de la máquina, la visita se marca «lejos» (no se
 * bloquea: sin señal se perdería). 150 m da margen al GPS del iPhone dentro
 * de una tienda y a coordenadas de QTM un poco corridas.
 */
export const LEJOS_M = 150;

export type Semaforo = 'verde' | 'ambar' | 'rojo';

/** Lo más reciente entre dos marcas ISO (cualquiera puede faltar). */
export function ultimoContacto(...marcas: (string | null | undefined)[]): string | null {
  let mejor: string | null = null;
  let t = -Infinity;
  for (const m of marcas) {
    if (!m) continue;
    const n = Date.parse(m);
    if (Number.isFinite(n) && n > t) {
      t = n;
      mejor = m;
    }
  }
  return mejor;
}

const msDia = (dia: string) => Date.UTC(+dia.slice(0, 4), +dia.slice(5, 7) - 1, +dia.slice(8, 10));

/** Días de calendario de CDMX desde la marca hasta `ahora`; null = nunca. */
export function diasDesde(iso: string | null | undefined, ahora: Date = new Date()): number | null {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  const d = Math.round((msDia(diaCdmx(ahora)) - msDia(diaCdmx(iso))) / 86400000);
  // Un reloj de teléfono adelantado no da días negativos.
  return Math.max(0, d);
}

export function semaforoVisita(dias: number | null): Semaforo {
  if (dias == null || dias > DIAS_VISITA_AMBAR) return 'rojo';
  return dias > DIAS_VISITA_VERDE ? 'ambar' : 'verde';
}

/** «Visitada hoy», «Visitada hace 3 días», «Nunca visitada». */
export function textoDiasVisita(dias: number | null): string {
  if (dias == null) return 'Nunca visitada';
  if (dias === 0) return 'Visitada hoy';
  if (dias === 1) return 'Visitada ayer';
  return `Visitada hace ${dias} días`;
}

/** Metros entre el teléfono y la máquina; null si falta alguna coordenada. */
export function distanciaAMaquina(
  gps: Punto | null,
  maquina: { latitud: number | string | null; longitud: number | string | null }
): number | null {
  if (!gps) return null;
  const lat = Number(maquina.latitud);
  const lng = Number(maquina.longitud);
  if (maquina.latitud == null || maquina.longitud == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return metros(gps, { lat, lng });
}

export function estaLejos(distancia: number | null): boolean {
  return distancia != null && distancia > LEJOS_M;
}
