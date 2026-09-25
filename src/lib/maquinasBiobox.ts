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
  // Colores como variables CSS para que el número se lea en los dos temas
  // (tema claro/oscuro, 24-sep-2026): #f59e0b y #f97316 sobre blanco no llegan
  // a 3:1. Van escritos y no con colorTono()/NARANJA porque este archivo no
  // importa nada en tiempo de ejecución: la prueba lo transpila solo y lo
  // carga desde un data: URL. El respaldo del naranja es el oscuro de hoy.
  const ambar = 'var(--st-ambar)';
  const naranja = 'var(--st-naranja, #f97316)';
  return [
    { id: 'total', titulo: 'Máquinas', color: 'var(--txt)', filas: base },
    { id: 'nunca', titulo: 'Nunca revisadas', color: 'var(--bad)',
      filas: base.filter((u) => u.dias_sin_revision == null) },
    { id: 'vencidas', titulo: '+' + DIAS_REVISION + ' días', color: ambar,
      filas: base.filter((u) => u.dias_sin_revision != null && u.dias_sin_revision >= DIAS_REVISION) },
    { id: 'anomalias', titulo: 'Con anomalías', color: naranja,
      filas: base.filter((u) => (u.puntos_anomalia || 0) > 0) },
    { id: 'incidencias', titulo: 'Con incidencias abiertas', color: naranja,
      filas: base.filter((u) => (estado[u.site_id]?.abiertas || 0) > 0) },
    { id: 'fuera', titulo: 'Fuera de línea', color: 'var(--bad)',
      filas: base.filter(fueraDeLinea) },
    { id: 'coordenadas', titulo: 'Sin coordenadas', color: 'var(--muted)',
      filas: base.filter((u) => !u.navegable) },
  ];
}
