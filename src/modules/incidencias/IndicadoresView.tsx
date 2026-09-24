// ============================================================
// src/modules/incidencias/IndicadoresView.tsx
// Carga los datos de la pestaña "Indicadores" y los pasa a KpiView.
//
// La separación es a propósito: aquí vive el acceso a datos (y por tanto los
// estados de carga y error), y KpiView queda como componente puro de cálculo
// y presentación, fácil de revisar sin pensar en Supabase.
//
// PERIODO (auditoría primer mes, 24-sep-2026): antes se cargaban las 1000
// incidencias más recientes con '*' y ahí se cortaba EN SILENCIO: en cuanto
// la base pasara de 1000, los indicadores dejaban de ser "de la operación"
// y nadie lo notaba. Ahora se elige un periodo (por omisión 90 días), se
// filtra en el servidor por fecha de reporte, se pagina hasta traerlo
// COMPLETO y solo con las columnas que los indicadores leen.
// ============================================================
import { useState, useEffect, useRef } from 'react';
import { sb } from '../../lib/supabase';
import { slaHoras } from '../../lib/helpers';
import { SLA_VALIDACION_DEFAULT } from '../../lib/constants';
import { cargarNombres } from '../../lib/nombres';
import type { MapaNombres } from '../../lib/nombres';
import KpiView from './KpiView';
import type { Incidencia, SlaArea, SlaMap, SlaValidacion } from '../../types/db';

/** Filas por página: el tope duro de PostgREST es 1000 por consulta. */
const PAGINA = 1000;

/**
 * Tope de seguridad: 30 páginas (30,000 incidencias). Si se alcanza, se
 * AVISA en pantalla y se sugiere un periodo más corto; nunca se corta
 * callado.
 */
const TOPE_PAGINAS = 30;

/**
 * Columnas que leen los indicadores. Se proyecta en vez de '*' porque con
 * periodos largos son miles de filas por celular, y '*' arrastra textos
 * largos (observaciones, diagnóstico, detalle…) que ningún indicador usa.
 *
 * OJO: una columna que falte aquí NO truena: llega undefined y el indicador
 * sale en 0 o vacío EN SILENCIO. La lista sale de revisar TODO lo que leen
 * KpiView.tsx, KpiDetalleModal.tsx y los helpers que llaman (semanaDe,
 * horasEnProceso, horasValidacionReparacion, areaEfectiva, caraIncidencia).
 * Si KpiView o KpiDetalleModal empiezan a leer otra columna, AGRÉGALA AQUÍ.
 *
 * KpiDetalleModal no abre tarjetas completas: solo lista folio, estatus,
 * sitio, cara y tiempos de las MISMAS filas que contó el número, así que no
 * hace falta traer '*' bajo demanda.
 */
const COLUMNAS_KPI = [
  // identidad (llave de React en el detalle, folio visible)
  'record_id',
  'folio',
  // flujo y filtros del panel
  'estatus',
  'fecha_reporte', // periodo, semanaDe, tiempo de reparación, detalle
  'unidad_negocio',
  'area_responsable',
  'assigned_area', // areaEfectiva → clasificación Digital
  'area_reportante',
  'nivel',
  'catorcena',
  // rankings
  'nombre_incidencia',
  'incidencia_srd',
  'tipo_mueble',
  'tipo_medio',
  'medio',
  'lado', // ranking por lado y caraIncidencia
  'repaired_by_email',
  'rechazos_reparacion',
  // tiempos y SLA (horasEnProceso, horasValidacionReparacion, % de SLA)
  'repaired_at',
  'validator_at',
  'sla_reparacion_inicio',
  // detalle por sitio (KpiDetalleModal)
  'clave_sitio',
  'clave_medio', // caraIncidencia
  'direccion',
  'municipio',
].join(',');

/** Lista de estatus terminales, en la sintaxis de `.not('estatus','in',…)`. */
const TERMINALES_LISTA = '(cerrada,no_reparado)';

type Periodo = '30d' | '90d' | '12m' | 'todo';

const PERIODOS: { valor: Periodo; etiqueta: string }[] = [
  { valor: '30d', etiqueta: 'Últimos 30 días' },
  { valor: '90d', etiqueta: 'Últimos 90 días' },
  { valor: '12m', etiqueta: 'Últimos 12 meses' },
  { valor: 'todo', etiqueta: 'Todo' },
];

/**
 * Inicio del periodo, a las 00:00 en la hora LOCAL del teléfono (la de
 * quien lee el panel), contando hoy como uno de los días: "últimos 30 días"
 * = hoy y los 29 anteriores. null = todo el historial.
 */
function inicioPeriodo(p: Periodo): Date | null {
  if (p === 'todo') return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (p === '12m') {
    d.setFullYear(d.getFullYear() - 1);
    d.setDate(d.getDate() + 1);
  } else d.setDate(d.getDate() - (p === '30d' ? 29 : 89));
  return d;
}

/** dd/mm/aaaa en hora local (la misma en que se calculó el periodo). */
function fechaCorta(d: Date): string {
  return d.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Columnas con las que se consulta. Si alguna de COLUMNAS_KPI no existe en
 * la base (p. ej. un SQL de columna nueva sin correr), PostgREST responde
 * 42703 y TODA la carga fallaría: en ese caso se cae a '*' por el resto de
 * la sesión, con aviso en consola. Mejor indicadores pesados que ninguno.
 */
let columnasKpi = COLUMNAS_KPI;

type SlaConfiguracion = { reporte: number; reparacion: number };

/**
 * Todas las incidencias reportadas desde `desdeIso` (o todas), paginadas de
 * 1000 en 1000 hasta una página incompleta. Orden estable (fecha + record_id)
 * para que el paginado por offset no repita ni salte filas entre páginas.
 */
async function cargarPeriodo(
  desdeIso: string | null,
  vigente: () => boolean
): Promise<{ filas: Incidencia[]; error: string | null; topado: boolean }> {
  let filas: Incidencia[] = [];
  for (let n = 0; n < TOPE_PAGINAS; n++) {
    const desde = n * PAGINA;
    let consulta = sb.from('incidencias').select(columnasKpi);
    if (desdeIso) consulta = consulta.gte('fecha_reporte', desdeIso);
    const { data, error } = await consulta
      .order('fecha_reporte', { ascending: false })
      .order('record_id', { ascending: true })
      .range(desde, desde + PAGINA - 1);
    if (error) {
      if (error.code === '42703' && columnasKpi !== '*') {
        console.warn(
          '[indicadores] Falta una columna de COLUMNAS_KPI en la base (' +
            error.message +
            '); se cargan todas las columnas.'
        );
        columnasKpi = '*';
        return cargarPeriodo(desdeIso, vigente);
      }
      return { filas, error: error.message, topado: false };
    }
    const lote = (data as unknown as Incidencia[] | null) || [];
    filas = filas.concat(lote);
    // Otra carga (otro periodo) ya lo superó: no tiene caso seguir.
    if (lote.length < PAGINA || !vigente())
      return { filas, error: null, topado: false };
  }
  return { filas, error: null, topado: true };
}

/**
 * Abiertas reportadas ANTES del periodo (o sin fecha). No entran en los
 * indicadores —el periodo es "reportadas en el periodo", igual que el filtro
 * de catorcena—, pero se cuentan aparte para que no se pierdan de vista: un
 * en_proceso de hace cinco meses es justo lo que más urge ver. Conteo sin
 * filas (head): cuesta lo mismo sean 3 o 3,000. null = no aplica o falló.
 */
async function contarAbiertasAntes(desdeIso: string | null): Promise<number | null> {
  if (!desdeIso) return null;
  const { count, error } = await sb
    .from('incidencias')
    .select('record_id', { count: 'exact', head: true })
    .not('estatus', 'in', TERMINALES_LISTA)
    // Entre comillas: la fecha ISO trae ':' y '.', reservados en `or`.
    .or(`fecha_reporte.lt."${desdeIso}",fecha_reporte.is.null`);
  if (error) return null;
  return count ?? null;
}

function IndicadoresView({
  puedeConfigurarSla = false,
  recargarSignal,
}: {
  puedeConfigurarSla?: boolean;
  /**
   * Contador del botón ↻ de la barra: al subir, vuelve a bajar el periodo
   * COMPLETO (hasta 30 páginas). OJO: si el contador también sube con cada
   * aviso nuevo, esa descarga se paga en cada aviso mientras se esté aquí
   * (revisión primer mes, 24-sep-2026).
   */
  recargarSignal?: number;
}) {
  const [items, setItems] = useState<Incidencia[]>([]);
  const [slaMap, setSlaMap] = useState<SlaMap>({});
  const [nombres, setNombres] = useState<MapaNombres>({});
  /**
   * Solo la PRIMERA carga pone "Cargando indicadores…". Al cambiar de
   * periodo se recarga EN SU LUGAR: el return temprano desmontaba KpiView y
   * le borraba los filtros que el usuario ya tenía puestos.
   */
  const [loading, setLoading] = useState(true);
  const [cargandoConfig, setCargandoConfig] = useState(true);
  const [recargando, setRecargando] = useState(false);
  const [err, setErr] = useState('');
  const [periodo, setPeriodo] = useState<Periodo>('90d');
  /**
   * Lo que de verdad está cargado (puede no ser el periodo elegido si la
   * recarga falló): el resumen describe ESTO, no el selector.
   */
  const [cargado, setCargado] = useState<{
    desde: Date | null;
    topado: boolean;
    abiertasAntes: number | null;
  } | null>(null);
  /**
   * Reintentos del MISMO periodo (revisión primer mes, 24-sep-2026). Si la
   * carga fallaba, el selector se quedaba en el periodo nuevo con los datos
   * viejos y no había cómo volver a pedirlo: elegir la misma opción de un
   * <select> no dispara onChange y el ↻ de la barra no llegaba hasta aquí.
   * Había que irse a otro periodo y regresar (dos descargas) o salir de la
   * pestaña y perder los filtros de KpiView. Sube con «Reintentar».
   *
   * NO se arregla regresando el selector al periodo cargado: eso volvería a
   * disparar el efecto y bajaría otra vez el periodo viejo.
   */
  const [intento, setIntento] = useState(0);
  /** Carreras: si se cambia de periodo rápido, gana la carga más nueva. */
  const cargaSeq = useRef(0);
  /** ¿Ya hay datos buenos en pantalla? (para el texto del error). */
  const hayDatos = useRef(false);
  const [slaValidacion, setSlaValidacion] = useState<SlaConfiguracion>({
    ...SLA_VALIDACION_DEFAULT,
  });
  const [slaEdicion, setSlaEdicion] = useState<SlaConfiguracion>({
    ...SLA_VALIDACION_DEFAULT,
  });
  const [guardandoSla, setGuardandoSla] = useState(false);
  const [errSla, setErrSla] = useState('');

  // Incidencias del periodo. Corre al montar, en cada cambio de periodo, con
  // «Reintentar» (intento) y con el ↻ de la barra (recargarSignal). Las dos
  // últimas van como dependencias y no como un efecto aparte: React compara
  // cada una contra su valor del render anterior, así que al montar se carga
  // UNA vez aunque recargarSignal ya venga en 5 (revisión primer mes,
  // 24-sep-2026).
  useEffect(() => {
    const miCarga = ++cargaSeq.current;
    const vigente = () => miCarga === cargaSeq.current;
    const inicio = inicioPeriodo(periodo);
    const desdeIso = inicio ? inicio.toISOString() : null;
    setRecargando(true);
    (async () => {
      const [res, abiertasAntes] = await Promise.all([
        cargarPeriodo(desdeIso, vigente),
        contarAbiertasAntes(desdeIso),
      ]);
      if (!vigente()) return;
      setLoading(false);
      setRecargando(false);
      // Con error (mala señal) se CONSERVA lo que ya estaba: un panel a
      // medias se leería como completo. El resumen sigue describiendo los
      // datos viejos, que son los que se ven.
      if (res.error) {
        setErr(
          'incidencias: ' +
            res.error +
            (hayDatos.current ? ' — se siguen mostrando los datos anteriores.' : '')
        );
        return;
      }
      hayDatos.current = true;
      setErr('');
      setItems(res.filas);
      setCargado({ desde: inicio, topado: res.topado, abiertasAntes });
    })();
  }, [periodo, intento, recargarSignal]);

  // Configuración que no depende del periodo: una sola vez.
  useEffect(() => {
    (async () => {
      const [{ data: slas }, { data: validaciones }, mapaNombres] = await Promise.all([
        sb.from('sla_areas').select('area,sla_horas'),
        sb.from('sla_validacion').select('etapa,minutos'),
        // Nunca falla: si la RLS corta las tablas de personas, vuelve vacío y
        // los rankings caen al usuario del correo.
        cargarNombres(),
      ]);
      setNombres(mapaNombres);

      // Horas de SLA por área, en minúsculas: así se cruza con
      // area_responsable sin importar cómo esté capitalizado.
      const m: SlaMap = {};
      ((slas as SlaArea[]) || []).forEach((r) => {
        if (r.area) {
          const h = slaHoras(r.sla_horas);
          if (h) m[r.area.trim().toLowerCase()] = h;
        }
      });
      setSlaMap(m);

      const siguiente: SlaConfiguracion = { ...SLA_VALIDACION_DEFAULT };
      ((validaciones as SlaValidacion[]) || []).forEach((sla) => {
        if (
          (sla.etapa === 'reporte' || sla.etapa === 'reparacion') &&
          Number.isFinite(Number(sla.minutos)) &&
          Number(sla.minutos) > 0
        ) {
          siguiente[sla.etapa] = Number(sla.minutos);
        }
      });
      setSlaValidacion(siguiente);
      setSlaEdicion(siguiente);
      setCargandoConfig(false);
    })();
  }, []);

  const guardarSlaValidacion = async () => {
    const reporte = Number(slaEdicion.reporte);
    const reparacion = Number(slaEdicion.reparacion);
    if (
      !Number.isInteger(reporte) ||
      !Number.isInteger(reparacion) ||
      reporte < 1 ||
      reparacion < 1 ||
      reporte > 1440 ||
      reparacion > 1440
    ) {
      setErrSla('Indica minutos enteros entre 1 y 1,440 para ambos SLA.');
      return;
    }

    setGuardandoSla(true);
    setErrSla('');
    const { error } = await sb.from('sla_validacion').upsert(
      [
        { etapa: 'reporte', minutos: reporte, actualizado_en: new Date().toISOString() },
        { etapa: 'reparacion', minutos: reparacion, actualizado_en: new Date().toISOString() },
      ],
      { onConflict: 'etapa' }
    );
    setGuardandoSla(false);
    if (error) {
      setErrSla('No se pudo guardar el SLA: ' + error.message);
      return;
    }
    const siguiente = { reporte, reparacion };
    setSlaValidacion(siguiente);
    setSlaEdicion(siguiente);
  };

  // Solo antes de la PRIMERA carga completa (datos + SLA por área, para no
  // pintar un % de SLA sin su configuración). Después, nunca más: ver loading.
  if (loading || cargandoConfig)
    return <div className="loading">Cargando indicadores…</div>;

  /**
   * Selector de periodo y resumen de lo cargado. Va DENTRO de KpiView (por
   * la prop `encabezado`), debajo del título y arriba de sus filtros: es el
   * primer corte de los datos y así se lee.
   */
  const nAntes = cargado?.abiertasAntes ?? 0;
  const encabezado = (
    <div style={{ marginBottom: 14 }}>
      <div className="toolbar" style={{ marginBottom: 6, alignItems: 'center' }}>
        <select
          aria-label="Periodo"
          value={periodo}
          onChange={(e) => setPeriodo(e.target.value as Periodo)}
        >
          {PERIODOS.map((p) => (
            <option key={p.valor} value={p.valor}>
              {p.etiqueta}
            </option>
          ))}
        </select>
        {recargando && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            <span className="spinner" />
            Actualizando…
          </span>
        )}
      </div>
      {/* Sin ninguna carga buena (falló la primera) no se afirma nada: "0
          incidencias en todo el historial" se leería como dato. */}
      {cargado && (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {`${items.length.toLocaleString('es-MX')} ${
            items.length === 1 ? 'incidencia reportada' : 'incidencias reportadas'
          } ${
            cargado.desde
              ? `desde el ${fechaCorta(cargado.desde)}`
              : 'en todo el historial'
          }.`}
          {nAntes > 0 && (
            <>
              {' Además hay '}
              <b style={{ color: 'var(--warn)' }}>
                {nAntes.toLocaleString('es-MX')}{' '}
                {nAntes === 1 ? 'abierta' : 'abiertas'}
              </b>
              {nAntes === 1
                ? ' reportada antes de este periodo: no entra en estos indicadores (elige «Todo» para incluirla).'
                : ' reportadas antes de este periodo: no entran en estos indicadores (elige «Todo» para incluirlas).'}
            </>
          )}
        </div>
      )}
      {cargado?.topado && (
        <div
          className="banner"
          style={{
            marginTop: 8,
            marginBottom: 0,
            borderColor: 'var(--warn)',
            color: 'var(--warn)',
          }}
        >
          ⚠️ Se alcanzó el tope de {(TOPE_PAGINAS * PAGINA).toLocaleString('es-MX')}{' '}
          incidencias: los indicadores cubren solo las más recientes del
          periodo. Elige un periodo más corto para verlo completo.
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* `err` solo lo pone la carga del periodo (el SLA usa errSla): el botón
          vuelve a pedir el MISMO periodo, también si falló la primera carga. */}
      {err && (
        <div className="err">
          {err}{' '}
          <button
            type="button"
            className="btn sm"
            disabled={recargando}
            onClick={() => setIntento((n) => n + 1)}
          >
            {recargando ? 'Reintentando…' : 'Reintentar'}
          </button>
        </div>
      )}
      {puedeConfigurarSla && (
        <section className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 5px' }}>SLA de validación</h3>
          <p className="phint" style={{ marginTop: 0 }}>
            Minutos hábiles de lunes a viernes, 9:30–18:30 CDMX, para validar un reporte nuevo y aprobar o rechazar una reparación.
          </p>
          <div className="row2">
            <div className="field">
              <label htmlFor="sla-validar-reporte">Validar reporte (minutos)</label>
              <input
                id="sla-validar-reporte"
                type="number"
                min="1"
                max="1440"
                step="1"
                value={slaEdicion.reporte}
                onChange={(e) =>
                  setSlaEdicion((actual) => ({
                    ...actual,
                    reporte: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="field">
              <label htmlFor="sla-validar-reparacion">Validar reparación (minutos)</label>
              <input
                id="sla-validar-reparacion"
                type="number"
                min="1"
                max="1440"
                step="1"
                value={slaEdicion.reparacion}
                onChange={(e) =>
                  setSlaEdicion((actual) => ({
                    ...actual,
                    reparacion: Number(e.target.value),
                  }))
                }
              />
            </div>
          </div>
          {errSla && <div className="err" style={{ marginBottom: 10 }}>{errSla}</div>}
          <button className="btn sm" onClick={guardarSlaValidacion} disabled={guardandoSla}>
            {guardandoSla ? 'Guardando…' : 'Guardar SLA de validación'}
          </button>
          <span style={{ marginLeft: 10, color: 'var(--muted)', fontSize: 12 }}>
            Actuales: reporte {slaValidacion.reporte} min · reparación {slaValidacion.reparacion} min
          </span>
        </section>
      )}
      <KpiView
        items={items}
        slaMap={slaMap}
        nombres={nombres}
        encabezado={encabezado}
      />
    </>
  );
}

export default IndicadoresView;
