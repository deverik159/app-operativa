import type { UbicacionRevision } from '../types/db';
import type { MapaResumen } from './estadoMaquina';

// La vista existente aporta rutas y ubicación; el estado se lee de inventario.
export type MaquinaBiobox = Pick<UbicacionRevision,
  'ubicacion_id' | 'ruta_id' | 'ruta_numero' | 'ruta_nombre' | 'ruta_color' |
  'unidad_negocio' | 'site_id' | 'secuencia' | 'vendor_face_id' |
  'site_legacy_id' | 'direccion' | 'municipio' | 'tipo_mueble' | 'medio' |
  'latitud' | 'longitud' | 'navegable'
> & { face_status: string | null };

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
    { id: 'incidencias', titulo: 'Con incidencias abiertas', color: '#f97316',
      filas: base.filter((u) => (estado[u.site_id]?.abiertas || 0) > 0) },
    { id: 'fuera', titulo: 'Fuera de línea', color: 'var(--bad)',
      filas: base.filter(fueraDeLinea) },
    { id: 'coordenadas', titulo: 'Sin coordenadas', color: 'var(--muted)',
      filas: base.filter((u) => !u.navegable) },
  ];
}
