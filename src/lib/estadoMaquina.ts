// ============================================================
// src/lib/estadoMaquina.ts
// Lo que trae abierto una máquina. Habla con las dos RPC de
// `estado_maquina.sql`.
//
// POR QUÉ NO SE CONSULTA `incidencias` DIRECTO: porque la RLS de esa tabla
// le enseña al operador solo lo de SU área —o todo, si nadie le puso
// departamento—. Las dos respuestas están mal para esta pantalla: la primera
// le esconde la falla de Digital que lleva once semanas en su máquina, y la
// segunda le abre todas las unidades.
//
// Las RPC son `security definer` y devuelven exactamente lo que hace falta
// para ir a preguntar: qué es, en qué estatus, qué área la repara, cuánto
// lleva y con qué observación se reportó. Ni diagnósticos, ni causas raíz, ni
// quién capturó.
// Ver el encabezado de estado_maquina.sql.
// ============================================================
import { sb } from './supabase';

/** Una incidencia abierta de la máquina, como la ve el operador. */
export type IncidenciaAbierta = {
  record_id: string;
  folio: string | null;
  nombre_incidencia: string | null;
  nivel: string | null;
  estatus: string;
  area: string | null;
  clave_medio: string | null;
  fecha_reporte: string | null;
  horas_en_estatus: number | null;
  /** true = le toca a su área. Solo alimenta el conteo del encabezado. */
  es_de_mi_area: boolean;
  /** Lo que escribió quien la reportó. Es lo que la vuelve reconocible. */
  observaciones: string | null;
};

/** Resumen por sitio, para el distintivo de la lista. */
export type ResumenMaquina = {
  site_id: string;
  abiertas: number;
  en_proceso: number;
  por_validar: number;
  horas_peor: number | null;
  areas: string | null;
  hay_critica: boolean;
};

/** site_id → resumen. Los sitios sin nada abierto NO aparecen. */
export type MapaResumen = Record<string, ResumenMaquina>;

/**
 * Umbral en horas a partir del cual algo detenido se pinta en rojo.
 *
 * 72 h es el mismo número que usan los indicadores. Se repite aquí como
 * constante con nombre y no suelto en el JSX: cuando alguien decida que son
 * 48, hay un solo lugar donde cambiarlo.
 */
export const HORAS_ALARMA = 72;

/**
 * Resumen de muchas máquinas de un jalón.
 *
 * La lista de Biobox trae doscientas: pedirlas una por una serían doscientos
 * viajes y el distintivo tardaría más en aparecer que la lista completa.
 *
 * NUNCA LANZA. Si la RPC falla —porque todavía no se corrió el SQL, por
 * ejemplo— devuelve un mapa vacío y la lista se pinta igual, sin
 * distintivos. Una lista de máquinas sin adornos sigue sirviendo; una
 * pantalla en blanco por un catálogo que no cargó, no.
 */
export async function resumenMaquinas(siteIds: string[]): Promise<MapaResumen> {
  if (!siteIds.length) return {};
  const { data, error } = await sb.rpc('estado_maquinas', {
    p_site_ids: siteIds,
  });
  if (error) return {};
  const mapa: MapaResumen = {};
  ((data as ResumenMaquina[]) || []).forEach((r) => {
    mapa[r.site_id] = r;
  });
  return mapa;
}

/**
 * Detalle de una máquina.
 *
 * Devuelve `{ filas, error }` en vez de lanzar, porque el panel que lo usa
 * vive ARRIBA DEL CHECKLIST: si esto tronara, se llevaría la revisión
 * completa por delante. Mejor un aviso de que el panel no cargó, con el
 * checklist funcionando debajo.
 */
export async function detalleMaquina(
  siteId: string
): Promise<{ filas: IncidenciaAbierta[]; error: string }> {
  const { data, error } = await sb.rpc('estado_maquina', {
    p_site_id: siteId,
  });
  if (error) return { filas: [], error: error.message };
  return { filas: (data as IncidenciaAbierta[]) || [], error: '' };
}
