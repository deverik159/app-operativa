// ============================================================
// src/lib/duplicados.ts
// LA regla de duplicidad de incidencias, en un solo lugar.
//
// ══ REGLA (Erik, 29-ago-2026) ══
// Misma unidad + mismo medio + misma incidencia + MISMA CARA, y la
// existente sigue 'en_proceso' → no se captura otra. La cara es la que
// acota: dos vallas distintas con grafiti son dos trabajos distintos.
//
// Solo bloquea contra 'en_proceso', literal a como se pidió: una que siga
// 'por_validar' no bloquea — ese duplicado lo caza el validador, que ve la
// foto en la tarjeta.
//
// Nació dentro de IncidenciasView y el flujo de Biobox (revisión con
// anomalía → levantar incidencia) se la brincaba: la misma máquina generaba
// la misma incidencia en proceso una y otra vez sin aviso (Erik,
// 30-ago-2026). Cuando una conducta tiene que ser idéntica en dos lugares,
// no se copia — se centraliza.
//
// Es verificación de mejor esfuerzo del lado del cliente: si dos personas
// capturan lo mismo en el mismo segundo, pasan las dos. Para esta operación
// es suficiente; un candado duro necesitaría un índice único parcial en la
// base y rompería el flujo del validador al aprobar.
// ============================================================
import { sb } from './supabase';
import { detalleMaquina } from './estadoMaquina';

/** Lo mínimo que la regla necesita comparar de cada fila por crear. */
export type FilaDuplicable = {
  clave_medio?: string | null;
  nombre_incidencia?: string | null;
  unidad_negocio?: string | null;
  medio?: string | null;
};

export type Duplicada<T> = { fila: T; folio: string | null };

/**
 * Busca cuáles de las filas por crear YA tienen una incidencia igual en
 * 'en_proceso'. Devuelve los choques con su folio; vacío = todo libre.
 */
export async function duplicadasEnProceso<T extends FilaDuplicable>(
  filas: T[]
): Promise<Duplicada<T>[]> {
  const caras = [
    ...new Set(filas.map((f) => f.clave_medio).filter(Boolean)),
  ] as string[];
  const nombres = [
    ...new Set(filas.map((f) => f.nombre_incidencia).filter(Boolean)),
  ] as string[];
  if (!caras.length || !nombres.length) return [];

  const { data } = await sb
    .from('incidencias')
    .select('folio,nombre_incidencia,clave_medio,unidad_negocio,medio')
    .eq('estatus', 'en_proceso')
    .in('clave_medio', caras)
    .in('nombre_incidencia', nombres);
  type Abierta = FilaDuplicable & { folio: string | null };
  const abiertas = (data as Abierta[] | null) || [];

  return filas
    .map((f) => {
      const d = abiertas.find(
        (x) =>
          x.clave_medio === f.clave_medio &&
          x.nombre_incidencia === f.nombre_incidencia &&
          x.unidad_negocio === f.unidad_negocio &&
          (x.medio || '') === (f.medio || '')
      );
      return d ? { fila: f, folio: d.folio } : null;
    })
    .filter(Boolean) as Duplicada<T>[];
}

/**
 * La MISMA regla, pero para un sitio/máquina y a través de la RPC
 * `estado_maquina` (security definer).
 *
 * POR QUÉ NO BASTA duplicadasEnProceso() AQUÍ: esa consulta `incidencias`
 * directo, y la RLS le enseña al operador de campo solo lo de SU área. La
 * incidencia de Digital que lleva semanas en proceso en esta máquina era
 * INVISIBLE para la consulta del monitorista → la regla nunca bloqueaba y
 * cada revisión volvía a levantarla (Erik, 30-ago-2026). La RPC ve todo lo
 * abierto del sitio — es la misma fuente del panel "abiertas" que el propio
 * revisor tiene enfrente.
 *
 * La cara (clave_medio) es única por cara física, así que dentro de un
 * sitio basta cara + incidencia: unidad y medio ya vienen dados por la
 * máquina.
 */
export async function duplicadasEnProcesoDeSitio(
  siteId: string,
  porCrear: { clave_medio: string | null; nombre_incidencia: string | null }[]
): Promise<{ nombre_incidencia: string | null; folio: string | null }[]> {
  if (!porCrear.length) return [];
  const { filas } = await detalleMaquina(siteId);
  return porCrear
    .map((f) => {
      const d = filas.find(
        (x) =>
          x.estatus === 'en_proceso' &&
          x.clave_medio === f.clave_medio &&
          x.nombre_incidencia === f.nombre_incidencia
      );
      return d
        ? { nombre_incidencia: f.nombre_incidencia, folio: d.folio }
        : null;
    })
    .filter(Boolean) as { nombre_incidencia: string | null; folio: string | null }[];
}
