import type { UbicacionRevision } from '../types/db';
import type { MapaResumen } from './estadoMaquina';

// La vista existente aporta rutas y ubicación; el estado se lee de inventario.
export type MaquinaBiobox = UbicacionRevision & { face_status: string | null };

export const DIAS_REVISION = 30;

export function pendienteRevision(maquina: MaquinaBiobox): boolean {
  return maquina.dias_sin_revision == null || maquina.dias_sin_revision >= DIAS_REVISION;
}

export function fueraDeLinea(maquina: Pick<MaquinaBiobox, 'face_status'>): boolean {
  return (maquina.face_status || '').trim().toLowerCase() === 'out of service';
}

/** Un sitio puede estar en los segmentos Digital e Impreso de una ruta. */
export function maquinasUnicas(filas: MaquinaBiobox[]): MaquinaBiobox[] {
  const sitios = new Map<string, MaquinaBiobox>();
  for (const fila of filas) {
    if (!sitios.has(fila.site_id)) sitios.set(fila.site_id, fila);
  }
  return [...sitios.values()];
}

/** Los números y el detalle comparten exactamente las mismas máquinas. */
export function indicadoresMaquinas(filas: MaquinaBiobox[], estado: MapaResumen) {
  const base = maquinasUnicas(filas);
  return [
    { id: 'total', titulo: 'Máquinas', color: 'var(--txt)', filas: base },
    { id: 'nunca', titulo: 'Nunca revisadas', color: 'var(--bad)',
      filas: base.filter((u) => u.dias_sin_revision == null) },
    { id: 'vencidas', titulo: '+' + DIAS_REVISION + ' días', color: '#f59e0b',
      filas: base.filter((u) => u.dias_sin_revision != null && u.dias_sin_revision >= DIAS_REVISION) },
    { id: 'anomalias', titulo: 'Con anomalías', color: '#f97316',
      filas: base.filter((u) => (u.puntos_anomalia || 0) > 0) },
    { id: 'incidencias', titulo: 'Con incidencias abiertas', color: '#f97316',
      filas: base.filter((u) => (estado[u.site_id]?.abiertas || 0) > 0) },
    { id: 'fuera', titulo: 'Fuera de línea', color: 'var(--bad)',
      filas: base.filter(fueraDeLinea) },
    { id: 'coordenadas', titulo: 'Sin coordenadas', color: 'var(--muted)',
      filas: base.filter((u) => !u.navegable) },
  ];
}
