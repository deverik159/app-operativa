// ============================================================
// src/modules/incidencias/KpiView.tsx
// Panel de indicadores: tarjetas de resumen + rankings, todo filtrable.
//
// Es la pestaña "Indicadores" real del HTML. Componente PURO: recibe las
// incidencias y el mapa de SLA ya cargados, y solo calcula y pinta. Quien
// carga los datos es IndicadoresView.
// ============================================================
import { useState, useMemo } from 'react';
import {
  UNIDADES,
  EST_LABEL,
  EST_COLOR,
  NIVEL_COLOR,
} from '../../lib/constants';
import {
  codigoCara,
  horasValidacionReparacion,
  horasEnProceso,
  semanaDe,
  etiquetaSemana,
  fmtHoras as fmtH,
} from '../../lib/helpers';
import { nombreDe } from '../../lib/nombres';
import type { MapaNombres } from '../../lib/nombres';
import KpiDetalleModal from './KpiDetalleModal';
import type { Incidencia, SlaMap } from '../../types/db';

/** Cuántas barras se muestran por ranking. */
const TOP_N = 8;

/**
 * Tope para descartar valores absurdos en el tiempo de reparación:
 * 120 días. Filas viejas migradas traen fechas incoherentes que, sin este
 * corte, arruinan el promedio.
 */
const MAX_HORAS_REPARACION = 24 * 120;

/** Umbrales de color del % de cumplimiento de SLA. */
const SLA_BIEN = 80;
const SLA_REGULAR = 50;

/**
 * Un renglón de ranking. Antes era `[etiqueta, conteo]` y nada más; ahora
 * arrastra las incidencias que lo produjeron, que es lo que permite abrir el
 * detalle sin volver a filtrar (y sin que los dos números se separen).
 */
type Fila = {
  etiqueta: string;
  n: number;
  filas: Incidencia[];
};

/** Lo que se está viendo en el popup de detalle. */
type Detalle = {
  titulo: string;
  items: Incidencia[];
  corte?: 'sitio' | 'incidencia';
  orden?: 'cantidad' | 'tiempo';
};

/**
 * Barras horizontales de un ranking.
 * Está a nivel de módulo (y no dentro del render, como en el HTML) para que
 * React no la recree en cada pintado.
 */
function Bars({
  data,
  color,
  onAbrir,
}: {
  data: Fila[];
  color: string;
  /** Clic en un renglón. Sin esto la barra se pinta igual pero no responde. */
  onAbrir?: (f: Fila) => void;
}) {
  if (data.length === 0)
    return <div style={{ color: 'var(--muted)', fontSize: 12 }}>Sin datos.</div>;
  // La barra más larga marca la escala; ||1 evita dividir entre cero.
  const max = Math.max(...data.map((d) => d.n), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {data.map((f) => (
        <button
          key={f.etiqueta}
          onClick={onAbrir ? () => onAbrir(f) : undefined}
          title={onAbrir ? `Ver las ${f.n} de ${f.etiqueta}` : f.etiqueta}
          style={{
            display: 'grid',
            /* Proporcional y no '130px 1fr 34px': en un teléfono la columna
               fija dejaba la etiqueta en ~17 caracteres ("Mantenimiento e
               In…") y el title con el texto completo no existe en táctil.
               El minmax(0,…) mantiene funcionando el ellipsis. */
            gridTemplateColumns: 'minmax(0, clamp(110px, 38%, 150px)) 1fr auto',
            alignItems: 'center',
            gap: 10,
            fontSize: 13,
            background: 'none',
            border: 'none',
            color: 'inherit',
            font: 'inherit',
            padding: 0,
            textAlign: 'left',
            cursor: onAbrir ? 'pointer' : 'default',
          }}
        >
          <span
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {f.etiqueta}
          </span>
          <div
            style={{
              background: 'var(--panel2)',
              borderRadius: 8,
              height: 15,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                borderRadius: 8,
                background: color,
                width: (f.n / max) * 100 + '%',
              }}
            />
          </div>
          <span style={{ textAlign: 'right' }}>{f.n}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Tarjeta de indicador. Si recibe `onAbrir` se vuelve un botón.
 *
 * Las que NO se pueden abrir son las de promedio y porcentaje: detrás de
 * "82% de SLA" no hay un conjunto de incidencias, hay una división. Abrir
 * "las 82%" no significa nada, y un popup que muestra otra cosa de la que
 * dice el número es peor que no tener popup.
 */
function Card({
  n,
  l,
  color,
  onAbrir,
}: {
  n: React.ReactNode;
  l: React.ReactNode;
  color?: string;
  onAbrir?: () => void;
}) {
  const contenido = (
    <>
      <div className="n" style={color ? { color } : undefined}>
        {n}
      </div>
      <div className="l">
        {l}
        {onAbrir && (
          <span style={{ opacity: 0.55 }}> · ver</span>
        )}
      </div>
    </>
  );
  if (!onAbrir) return <div className="card">{contenido}</div>;
  return (
    <button
      className="card"
      onClick={onAbrir}
      style={{
        // `.card` ya trae fondo, borde y padding; lo que hay que apagar es lo
        // que el navegador le pone a un <button> y que `.card` no cubre.
        cursor: 'pointer',
        font: 'inherit',
        color: 'inherit',
        textAlign: 'left',
        width: '100%',
      }}
    >
      {contenido}
    </button>
  );
}

function KpiView({
  items,
  slaMap,
  nombres,
}: {
  items: Incidencia[];
  slaMap: SlaMap;
  /** correo → nombre, para no enseñar correos en los rankings. */
  nombres: MapaNombres;
}) {
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [fUN, setFUN] = useState('Todas');
  const [fArea, setFArea] = useState('Todas');
  const [fEst, setFEst] = useState('Todos');
  const [fNivel, setFNivel] = useState('Todos');
  const [fCat, setFCat] = useState('Todas');
  const [fSem, setFSem] = useState('Todas');

  // Las áreas y catorcenas salen de los DATOS, no de una constante: así
  // aparecen también las áreas que no están en AREAS_RESP (Urban, Imprenta…).
  const cats = useMemo(
    () =>
      [...new Set(items.map((i) => i.catorcena).filter((x) => x != null))].sort(
        (a, b) => (a as number) - (b as number)
      ) as number[],
    [items]
  );
  const areas = useMemo(
    () =>
      [
        ...new Set(items.map((i) => i.area_responsable).filter(Boolean)),
      ].sort() as string[],
    [items]
  );

  /**
   * Las semanas que existen en los datos, de la más reciente hacia atrás.
   *
   * Se calculan de `fecha_reporte` con la misma fórmula del trigger, y NO se
   * leen de la columna `semana`: esa columna es texto, viene null en las
   * filas migradas y el trigger solo la rellena al insertar. Calcularla aquí
   * da el mismo número para todas las filas, incluidas las viejas.
   */
  const semanas = useMemo(
    () =>
      [
        ...new Set(
          items.map((i) => semanaDe(i.fecha_reporte)).filter((x) => x != null)
        ),
      ].sort((a, b) => (b as number) - (a as number)) as number[],
    [items]
  );

  const f = useMemo(
    () =>
      items.filter((i) => {
        if (fUN !== 'Todas' && i.unidad_negocio !== fUN) return false;
        if (fArea !== 'Todas' && i.area_responsable !== fArea) return false;
        if (fEst !== 'Todos' && i.estatus !== fEst) return false;
        if (fNivel !== 'Todos' && i.nivel !== fNivel) return false;
        if (fCat !== 'Todas' && String(i.catorcena) !== String(fCat))
          return false;
        if (fSem !== 'Todas' && String(semanaDe(i.fecha_reporte)) !== fSem)
          return false;
        return true;
      }),
    [items, fUN, fArea, fEst, fNivel, fCat, fSem]
  );

  const total = f.length;
  const cerradas = f.filter((i) => i.estatus === 'cerrada').length;
  const noRep = f.filter((i) => i.estatus === 'no_reparado').length;
  // Rechazos de reparación: SUMA de veces, no incidencias — una misma
  // incidencia rechazada dos veces cuenta 2. El contador lo lleva el
  // trigger inc_cuenta_rechazo (ver rechazos_reparacion.sql) y arranca
  // desde que ese script se corrió: lo anterior no es reconstruible.
  const rechazosRep = f.reduce(
    (a, i) => a + (i.rechazos_reparacion || 0),
    0
  );
  const conRechazo = f.filter((i) => (i.rechazos_reparacion || 0) > 0);
  const abiertas = f.filter(
    (i) => !['cerrada', 'no_reparado'].includes(i.estatus)
  ).length;
  // Efectividad = cerradas sobre las ya resueltas de un modo u otro.
  const efect = Math.round((cerradas / (cerradas + noRep || 1)) * 100);

  // Tiempo promedio de reparación: reporte → reparado.
  const tProm = useMemo(() => {
    const tiempos = f
      .filter((i) => i.repaired_at && i.fecha_reporte)
      .map(
        (i) =>
          (new Date(i.repaired_at as string).getTime() -
            new Date(i.fecha_reporte as string).getTime()) /
          3600000
      )
      .filter((h) => h >= 0 && h < MAX_HORAS_REPARACION);
    if (!tiempos.length) return null;
    return tiempos.reduce((a, b) => a + b, 0) / tiempos.length;
  }, [f]);

  /**
   * Validación → reparación. Es el tiempo del que responde el ÁREA: mide de
   * que le llegó el trabajo a que lo entregó.
   *
   * Es distinto de "Tiempo prom. reparación", que va de reporte a reparado y
   * por tanto incluye lo que la incidencia estuvo esperando al validador. Los
   * dos juntos dicen dónde se va el tiempo: si el de arriba es mucho mayor
   * que éste, el cuello no está en el área — está antes.
   */
  const tArea = useMemo(() => {
    const tiempos = f
      .map(horasValidacionReparacion)
      .filter((h): h is number => h != null && h < MAX_HORAS_REPARACION);
    if (!tiempos.length) return null;
    return tiempos.reduce((a, b) => a + b, 0) / tiempos.length;
  }, [f]);

  /**
   * Cuánto llevan atoradas las que están en proceso, y cuál es la peor.
   *
   * Va aparte de los otros dos tiempos porque mide algo distinto: aquéllos
   * miran lo YA resuelto, éste mira lo que sigue pendiente ahora mismo. Un
   * área puede tener un promedio de reparación excelente y al mismo tiempo
   * tres incidencias abandonadas hace un mes — el promedio de lo cerrado no
   * las ve, porque nunca se cerraron.
   */
  const { tEnProceso, peorEnProceso, nEnProceso } = useMemo(() => {
    const horas = f
      .map(horasEnProceso)
      .filter((h): h is number => h != null);
    if (!horas.length)
      return { tEnProceso: null, peorEnProceso: null, nEnProceso: 0 };
    return {
      tEnProceso: horas.reduce((a, b) => a + b, 0) / horas.length,
      peorEnProceso: Math.max(...horas),
      nEnProceso: horas.length,
    };
  }, [f]);

  // Cumplimiento de SLA. Solo cuenta lo que tiene reloj de inicio Y un SLA
  // definido para su área: el resto no es medible y contarlo mentiría.
  const { slaPct, nConSla } = useMemo(() => {
    const conSla = f.filter(
      (i) =>
        i.sla_reparacion_inicio &&
        slaMap[(i.area_responsable || '').toLowerCase()]
    );
    let enTiempo = 0;
    conSla.forEach((i) => {
      const hrs = slaMap[(i.area_responsable || '').toLowerCase()];
      // Si aún no se repara, el reloj corre hasta ahora.
      const fin = i.repaired_at ? new Date(i.repaired_at) : new Date();
      const trans =
        (fin.getTime() -
          new Date(i.sla_reparacion_inicio as string).getTime()) /
        3600000;
      if (trans <= hrs) enTiempo++;
    });
    return {
      slaPct: conSla.length
        ? Math.round((enTiempo / conSla.length) * 100)
        : null,
      nConSla: conSla.length,
    };
  }, [f, slaMap]);

  /**
   * Agrupa por clave y devuelve el top N descendente, CON las filas de cada
   * grupo. Guardarlas cuesta memoria pero es lo que hace que el popup enseñe
   * exactamente las mismas incidencias que contó la barra: si el detalle
   * volviera a filtrar por su cuenta, tarde o temprano los dos números se
   * separan y no hay forma de saber cuál está mal.
   */
  const top = (keyFn: (i: Incidencia) => string | null, n = TOP_N): Fila[] => {
    const m = new Map<string, Incidencia[]>();
    f.forEach((i) => {
      const k = keyFn(i);
      if (!k) return;
      const prev = m.get(k);
      if (prev) prev.push(i);
      else m.set(k, [i]);
    });
    return [...m.entries()]
      .map(([etiqueta, filas]) => ({ etiqueta, n: filas.length, filas }))
      .sort((a, b) => b.n - a.n)
      .slice(0, n);
  };

  const porUN = top((i) => i.unidad_negocio);
  const porArea = top((i) => i.area_responsable);
  const topInc = top((i) => i.nombre_incidencia);
  const porMueble = top((i) => i.tipo_mueble);
  // Solo se pinta si hay datos: en las unidades que no capturan lado, una
  // tarjeta con "Sin datos" es ruido permanente.
  const porLado = top((i) => i.lado);
  const porCara = top((i) => codigoCara(i.clave_medio));

  // Quién repara más. La agrupación sigue siendo por CORREO —es la identidad
  // real y dos personas pueden llamarse igual—; el nombre se pone solo al
  // pintar la etiqueta. Agrupar por nombre fusionaría a dos homónimos en una
  // sola barra.
  const porTecnico = useMemo(
    () =>
      top((i) => i.repaired_by_email).map((x) => ({
        ...x,
        etiqueta: nombreDe(nombres, x.etiqueta),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [f, nombres]
  );

  /** Contexto de los filtros puestos, para que el popup diga sobre qué es. */
  const contexto = [
    fUN !== 'Todas' ? fUN : '',
    fArea !== 'Todas' ? fArea : '',
    fEst !== 'Todos' ? EST_LABEL[fEst] || fEst : '',
    fNivel !== 'Todos' ? `Nivel ${fNivel}` : '',
    fCat !== 'Todas' ? `Cat-${fCat}` : '',
    fSem !== 'Todas' ? etiquetaSemana(Number(fSem)) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const colorSla =
    slaPct == null
      ? 'var(--muted)'
      : slaPct >= SLA_BIEN
        ? 'var(--ok)'
        : slaPct >= SLA_REGULAR
          ? 'var(--warn)'
          : 'var(--hi)';

  const abrir = (
    titulo: string,
    lista: Incidencia[],
    corte: 'sitio' | 'incidencia' = 'sitio',
    orden: 'cantidad' | 'tiempo' = 'cantidad'
  ) => setDetalle({ titulo, items: lista, corte, orden });

  /** Las que siguen detenidas, de la más atorada a la menos. */
  const abrirEnProceso = (titulo: string) =>
    abrir(
      titulo,
      f.filter((i) => horasEnProceso(i) != null),
      'sitio',
      'tiempo'
    );

  return (
    <>
      <h2 className="page">Indicadores</h2>
      <p className="phint">
        Panel en vivo desde tus incidencias. Filtra y explora la operación.
      </p>

      <div className="toolbar">
        <select value={fUN} onChange={(e) => setFUN(e.target.value)}>
          <option>Todas</option>
          {UNIDADES.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
        <select value={fArea} onChange={(e) => setFArea(e.target.value)}>
          <option>Todas</option>
          {areas.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select value={fEst} onChange={(e) => setFEst(e.target.value)}>
          <option value="Todos">Todos</option>
          {Object.entries(EST_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={fNivel} onChange={(e) => setFNivel(e.target.value)}>
          <option value="Todos">Nivel: todos</option>
          {Object.keys(NIVEL_COLOR).map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <select value={fCat} onChange={(e) => setFCat(e.target.value)}>
          <option value="Todas">Catorcena: todas</option>
          {cats.map((c) => (
            <option key={c} value={c}>
              Cat-{c}
            </option>
          ))}
        </select>
        {/* Semana de lunes a domingo. La etiqueta trae el rango de fechas
            porque "Sem 27" a secas no le dice nada a nadie en una junta. */}
        <select value={fSem} onChange={(e) => setFSem(e.target.value)}>
          <option value="Todas">Semana: todas</option>
          {semanas.map((n) => (
            <option key={n} value={n}>
              {etiquetaSemana(n)}
            </option>
          ))}
        </select>
      </div>

      <div className="cards">
        <Card
          n={total}
          l="Incidencias"
          onAbrir={() => abrir('Todas las incidencias del filtro', f)}
        />
        <Card
          n={abiertas}
          l="Abiertas"
          color={EST_COLOR.en_proceso}
          onAbrir={() =>
            abrir(
              'Abiertas',
              f.filter((i) => !['cerrada', 'no_reparado'].includes(i.estatus))
            )
          }
        />
        <Card
          n={cerradas}
          l="Cerradas"
          color={EST_COLOR.cerrada}
          onAbrir={() =>
            abrir(
              'Cerradas',
              f.filter((i) => i.estatus === 'cerrada')
            )
          }
        />
        {/* Efectividad sí se puede abrir, pero enseñando el DENOMINADOR: las
            resueltas de un modo u otro. Es el conjunto sobre el que se
            calculó el porcentaje. */}
        <Card
          n={efect + '%'}
          l="Efectividad"
          color="var(--accent)"
          onAbrir={() =>
            abrir(
              'Efectividad — cerradas contra no reparadas',
              f.filter((i) => ['cerrada', 'no_reparado'].includes(i.estatus))
            )
          }
        />
        <Card
          n={rechazosRep}
          l={`Rechazos de reparación${
            conRechazo.length ? ` (${conRechazo.length} inc.)` : ''
          }`}
          color={rechazosRep > 0 ? 'var(--hi)' : undefined}
          onAbrir={
            conRechazo.length
              ? () =>
                  abrir(
                    'Con reparación rechazada por el validador',
                    conRechazo
                  )
              : undefined
          }
        />
        <Card
          n={fmtH(tProm)}
          l="Tiempo prom. reparación"
          onAbrir={() =>
            abrir(
              'Con tiempo de reparación medible',
              f.filter((i) => i.repaired_at && i.fecha_reporte)
            )
          }
        />
        <Card
          n={fmtH(tEnProceso)}
          l={`En proceso ahora${nEnProceso ? ` (${nEnProceso})` : ''}`}
          // Se colorea con SU propio valor, no con el peor: antes las dos
          // tarjetas se ponían rojas por la misma condición y el promedio
          // parecía malo aunque estuviera bien, solo porque había una atorada.
          color={tEnProceso != null && tEnProceso > 72 ? 'var(--hi)' : undefined}
          onAbrir={
            nEnProceso
              ? () => abrirEnProceso('En proceso — cuánto llevan detenidas')
              : undefined
          }
        />
        {/* SUBIDA DESDE ABAJO: estaba en una tarjeta suelta al fondo, sin
            poder abrirse. Es el número más accionable del panel —hay algo
            detenido 80 días— y estaba enterrado bajo seis rankings. */}
        <Card
          n={fmtH(peorEnProceso)}
          l="Peor en proceso"
          color={
            peorEnProceso != null && peorEnProceso > 72 ? 'var(--hi)' : undefined
          }
          onAbrir={
            peorEnProceso != null
              ? () => abrirEnProceso('Lo que lleva más tiempo detenido')
              : undefined
          }
        />
        <Card
          n={fmtH(tArea)}
          l="Validación → reparación"
          onAbrir={() =>
            abrir(
              'Con tiempo de validación a reparación medible',
              f.filter((i) => horasValidacionReparacion(i) != null)
            )
          }
        />
        <Card
          n={slaPct == null ? '—' : slaPct + '%'}
          l={`SLA en tiempo${nConSla ? ` (${nConSla})` : ''}`}
          color={colorSla}
          onAbrir={
            nConSla
              ? () =>
                  abrir(
                    'Medibles contra SLA',
                    f.filter(
                      (i) =>
                        i.sla_reparacion_inicio &&
                        slaMap[(i.area_responsable || '').toLowerCase()]
                    )
                  )
              : undefined
          }
        />
      </div>

      <div className="row2" style={{ gap: 16 }}>
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Por unidad de negocio
          </div>
          <Bars
            data={porUN}
            color="var(--accent2)"
            onAbrir={(x) => abrir(`Unidad: ${x.etiqueta}`, x.filas)}
          />
        </div>
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Carga por área responsable
          </div>
          <Bars
            data={porArea}
            color="var(--warn)"
            onAbrir={(x) =>
              // Abre en el corte POR INCIDENCIA: la pregunta al hacer clic
              // en un área es "qué me está llegando", no "de qué sitio".
              abrir(`Área: ${x.etiqueta}`, x.filas, 'incidencia')
            }
          />
        </div>
      </div>

      <div className="row2" style={{ gap: 16, marginTop: 16 }}>
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Top incidencias
          </div>
          <Bars
            data={topInc}
            color="var(--hi)"
            onAbrir={(x) => abrir(x.etiqueta, x.filas)}
          />
        </div>
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Quién repara más
          </div>
          <Bars
            data={porTecnico}
            color="var(--ok)"
            onAbrir={(x) => abrir(`Reparadas por ${x.etiqueta}`, x.filas)}
          />
        </div>
      </div>

      {/* Lado, mueble y cara van en el MISMO row2. Con dos columnas, el
          tercero cae solo en la siguiente línea a media anchura, que es
          preferible a dejar una tarjeta huérfana en su propia fila. */}
      <div className="row2" style={{ gap: 16, marginTop: 16 }}>
        {porLado.length > 0 && (
          <div className="card">
            <div className="l" style={{ marginBottom: 12 }}>
              Lado de la cara
            </div>
            <Bars
              data={porLado}
              color="var(--purple)"
              onAbrir={(x) => abrir(`Lado ${x.etiqueta}`, x.filas)}
            />
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10 }}>
              Solo cuenta lo capturado desde que existe el dato. Lo de antes de
              ago-2026 no trae lado y no aparece aquí.
            </div>
          </div>
        )}
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Mueble más afectado
          </div>
          <Bars
            data={porMueble}
            color="var(--purple)"
            onAbrir={(x) => abrir(`Mueble: ${x.etiqueta}`, x.filas)}
          />
        </div>
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Cara / código más afectado
          </div>
          <Bars
            data={porCara}
            color="var(--accent2)"
            onAbrir={(x) => abrir(`Cara ${x.etiqueta}`, x.filas)}
          />
        </div>
      </div>

      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 14 }}>
        Las semanas van de lunes a domingo, con la misma numeración que la
        columna “Sem” de cada incidencia. Toca cualquier número o barra para
        ver qué hay detrás. “Tiempo prom.
        reparación” va de reporte a reparado, así que incluye la espera al
        validador; “Validación → reparación” mide solo lo que tardó el área. El
        % de SLA se calcula sobre incidencias del flujo nuevo (con reloj de
        inicio).
      </div>

      {detalle && (
        <KpiDetalleModal
          titulo={detalle.titulo}
          subtitulo={contexto}
          items={detalle.items}
          corteInicial={detalle.corte}
          orden={detalle.orden}
          onClose={() => setDetalle(null)}
        />
      )}
    </>
  );
}

export default KpiView;
