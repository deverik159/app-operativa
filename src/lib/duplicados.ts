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
import { CLAVE_SIN_MAQUINA, ELEMENTOS_SIN_CARA } from './constants';
import { elementoDeIncidencia } from './catalogo';

/** Lo mínimo que la regla necesita comparar de cada fila por crear. */
export type FilaDuplicable = {
  clave_medio?: string | null;
  /** Para las del Adicional o la Puerta, que se comparan por sitio (ver abajo). */
  clave_sitio?: string | null;
  lado?: string | null;
  nombre_incidencia?: string | null;
  unidad_negocio?: string | null;
  medio?: string | null;
};

/**
 * ¿Es del Adicional o de la Puerta? (Erik, 6-oct-2026). El sitio tiene uno
 * solo, así que para ellas la regla compara MISMO SITIO + misma incidencia
 * (+ unidad y medio) en vez de misma cara. Se compara contra TODA la
 * abierta del sitio con ese nombre, traiga cara o no: en un sitio de una
 * cara se guardan con ella (todos los Biobox), en uno de varias sin ella, y
 * las que levanta la revisión de Biobox siempre con ella.
 *
 * "Sin máquina" (MKT) queda fuera: su clave de sitio es la misma para
 * todas, y como cualquier otra sin máquina no se compara.
 */
function esDeElemento(f: FilaDuplicable): boolean {
  return (
    !!f.clave_sitio &&
    f.clave_sitio !== CLAVE_SIN_MAQUINA &&
    (ELEMENTOS_SIN_CARA as readonly string[]).includes(f.lado || '')
  );
}

export type Duplicada<T> = { fila: T; folio: string | null };

/**
 * La consulta de la regla no salió. Solo se lanza con `lanzarSiFalla`:
 * quien llama distingue por `status` una falla de red (reintentar) de una
 * definitiva.
 */
export class ErrorConsultaDuplicados extends Error {
  status: number;
  code?: string;
  constructor(mensaje: string, status: number, code?: string) {
    super(mensaje);
    this.name = 'ErrorConsultaDuplicados';
    this.status = status;
    this.code = code;
  }
}

/**
 * Busca cuáles de las filas por crear YA tienen una incidencia igual en
 * 'en_proceso'. Devuelve los choques con su folio; vacío = todo libre.
 *
 * `op` es opcional (revisión primer mes, 24-sep-2026: lo pidió la cola de
 * envíos, cuyo único paso sin tope era este). Sin él, todo igual que
 * siempre: sin tope y, si la consulta falla, se contesta "sin choques".
 *   · signal       → tope de espera (AbortSignal) para la consulta.
 *   · lanzarSiFalla → si la consulta falla se lanza ErrorConsultaDuplicados
 *                     en vez de contestar "sin choques", y postgrest no
 *                     reintenta por su cuenta: quien llama maneja la falla
 *                     y sus reintentos.
 */
export async function duplicadasEnProceso<T extends FilaDuplicable>(
  filas: T[],
  op?: { signal?: AbortSignal; lanzarSiFalla?: boolean }
): Promise<Duplicada<T>[]> {
  const caras = [
    ...new Set(
      filas.filter((f) => !esDeElemento(f)).map((f) => f.clave_medio).filter(Boolean)
    ),
  ] as string[];
  const sitios = [
    ...new Set(filas.filter(esDeElemento).map((f) => f.clave_sitio)),
  ] as string[];
  const nombres = [
    ...new Set(filas.map((f) => f.nombre_incidencia).filter(Boolean)),
  ] as string[];
  if ((!caras.length && !sitios.length) || !nombres.length) return [];

  const columnas = 'folio,nombre_incidencia,clave_medio,clave_sitio,lado,unidad_negocio,medio';
  let porCara = caras.length
    ? sb
        .from('incidencias')
        .select(columnas)
        .eq('estatus', 'en_proceso')
        .in('clave_medio', caras)
        .in('nombre_incidencia', nombres)
    : null;
  let porSitio = sitios.length
    ? sb
        .from('incidencias')
        .select(columnas)
        .eq('estatus', 'en_proceso')
        .in('clave_sitio', sitios)
        .in('nombre_incidencia', nombres)
    : null;
  if (op?.signal) {
    porCara = porCara && porCara.abortSignal(op.signal);
    porSitio = porSitio && porSitio.abortSignal(op.signal);
  }
  if (op?.lanzarSiFalla) {
    porCara = porCara && porCara.retry(false);
    porSitio = porSitio && porSitio.retry(false);
  }
  const respuestas = await Promise.all([porCara, porSitio]);
  type Abierta = FilaDuplicable & { folio: string | null };
  const abiertas: Abierta[] = [];
  for (const r of respuestas) {
    if (!r) continue;
    if (r.error && op?.lanzarSiFalla)
      throw new ErrorConsultaDuplicados(r.error.message, r.status, r.error.code);
    abiertas.push(...((r.data as Abierta[] | null) || []));
  }

  return filas
    .map((f) => {
      const d = esDeElemento(f)
        ? abiertas.find(
            (x) =>
              x.clave_sitio === f.clave_sitio &&
              x.nombre_incidencia === f.nombre_incidencia &&
              x.unidad_negocio === f.unidad_negocio &&
              // El medio separa, p. ej., el "Adicional dañado" de Digital
              // del de Mantenimiento en un sitio mixto; si alguna no lo
              // trae, no se usa para descartar.
              (!x.medio || !f.medio || x.medio === f.medio)
          )
        : f.clave_medio
          ? abiertas.find(
              (x) =>
                x.clave_medio === f.clave_medio &&
                x.nombre_incidencia === f.nombre_incidencia &&
                x.unidad_negocio === f.unidad_negocio &&
                (x.medio || '') === (f.medio || '')
            )
          : undefined;
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
 * máquina. Las del Adicional o la Puerta (ver esDeElemento) bastan con la
 * incidencia: puede haberlas sin cara.
 */
export async function duplicadasEnProcesoDeSitio(
  siteId: string,
  porCrear: { clave_medio: string | null; nombre_incidencia: string | null }[]
): Promise<{ nombre_incidencia: string | null; folio: string | null }[]> {
  if (!porCrear.length) return [];
  const { filas } = await detalleMaquina(siteId);
  return porCrear
    .map((f) => {
      const sinCara = !!elementoDeIncidencia(f.nombre_incidencia);
      const d = filas.find(
        (x) =>
          x.estatus === 'en_proceso' &&
          (sinCara || x.clave_medio === f.clave_medio) &&
          x.nombre_incidencia === f.nombre_incidencia
      );
      return d
        ? { nombre_incidencia: f.nombre_incidencia, folio: d.folio }
        : null;
    })
    .filter(Boolean) as { nombre_incidencia: string | null; folio: string | null }[];
}
