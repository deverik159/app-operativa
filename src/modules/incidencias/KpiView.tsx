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
import { codigoCara } from '../../lib/helpers';
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

/** Un par [etiqueta, conteo] de un ranking. */
type Fila = [string, number];

/**
 * Barras horizontales de un ranking.
 * Está a nivel de módulo (y no dentro del render, como en el HTML) para que
 * React no la recree en cada pintado.
 */
function Bars({ data, color }: { data: Fila[]; color: string }) {
  if (data.length === 0)
    return <div style={{ color: 'var(--muted)', fontSize: 12 }}>Sin datos.</div>;
  // La barra más larga marca la escala; ||1 evita dividir entre cero.
  const max = Math.max(...data.map((d) => d[1]), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {data.map(([k, v]) => (
        <div
          key={k}
          style={{
            display: 'grid',
            gridTemplateColumns: '130px 1fr 34px',
            alignItems: 'center',
            gap: 10,
            fontSize: 13,
          }}
        >
          <span
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={k}
          >
            {k}
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
                width: (v / max) * 100 + '%',
              }}
            />
          </div>
          <span style={{ textAlign: 'right' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

/** Formatea horas: días si pasa de 24, horas si no. */
function fmtH(h: number | null): string {
  if (h == null) return '—';
  return h >= 24 ? `${(h / 24).toFixed(1)} d` : `${Math.round(h)} h`;
}

function KpiView({ items, slaMap }: { items: Incidencia[]; slaMap: SlaMap }) {
  const [fUN, setFUN] = useState('Todas');
  const [fArea, setFArea] = useState('Todas');
  const [fEst, setFEst] = useState('Todos');
  const [fNivel, setFNivel] = useState('Todos');
  const [fCat, setFCat] = useState('Todas');

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

  const f = useMemo(
    () =>
      items.filter((i) => {
        if (fUN !== 'Todas' && i.unidad_negocio !== fUN) return false;
        if (fArea !== 'Todas' && i.area_responsable !== fArea) return false;
        if (fEst !== 'Todos' && i.estatus !== fEst) return false;
        if (fNivel !== 'Todos' && i.nivel !== fNivel) return false;
        if (fCat !== 'Todas' && String(i.catorcena) !== String(fCat))
          return false;
        return true;
      }),
    [items, fUN, fArea, fEst, fNivel, fCat]
  );

  const total = f.length;
  const cerradas = f.filter((i) => i.estatus === 'cerrada').length;
  const noRep = f.filter((i) => i.estatus === 'no_reparado').length;
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

  /** Cuenta por clave y devuelve el top N descendente. */
  const top = (keyFn: (i: Incidencia) => string | null, n = TOP_N): Fila[] => {
    const m: Record<string, number> = {};
    f.forEach((i) => {
      const k = keyFn(i);
      if (k) m[k] = (m[k] || 0) + 1;
    });
    return Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  };

  const porUN = top((i) => i.unidad_negocio);
  const porArea = top((i) => i.area_responsable);
  const topInc = top((i) => i.nombre_incidencia);
  const porTecnico = top((i) => i.repaired_by_email);
  const porMueble = top((i) => i.tipo_mueble);
  const porCara = top((i) => codigoCara(i.clave_medio));

  const colorSla =
    slaPct == null
      ? 'var(--muted)'
      : slaPct >= SLA_BIEN
        ? 'var(--ok)'
        : slaPct >= SLA_REGULAR
          ? 'var(--warn)'
          : 'var(--hi)';

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
      </div>

      <div className="cards">
        <div className="card">
          <div className="n">{total}</div>
          <div className="l">Incidencias</div>
        </div>
        <div className="card">
          <div className="n" style={{ color: EST_COLOR.en_proceso }}>
            {abiertas}
          </div>
          <div className="l">Abiertas</div>
        </div>
        <div className="card">
          <div className="n" style={{ color: EST_COLOR.cerrada }}>
            {cerradas}
          </div>
          <div className="l">Cerradas</div>
        </div>
        <div className="card">
          <div className="n" style={{ color: 'var(--accent)' }}>
            {efect}%
          </div>
          <div className="l">Efectividad</div>
        </div>
        <div className="card">
          <div className="n">{fmtH(tProm)}</div>
          <div className="l">Tiempo prom. reparación</div>
        </div>
        <div className="card">
          <div className="n" style={{ color: colorSla }}>
            {slaPct == null ? '—' : slaPct + '%'}
          </div>
          <div className="l">
            SLA en tiempo{nConSla ? ` (${nConSla})` : ''}
          </div>
        </div>
      </div>

      <div className="row2" style={{ gap: 16 }}>
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Por unidad de negocio
          </div>
          <Bars data={porUN} color="var(--accent2)" />
        </div>
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Carga por área responsable
          </div>
          <Bars data={porArea} color="var(--warn)" />
        </div>
      </div>

      <div className="row2" style={{ gap: 16, marginTop: 16 }}>
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Top incidencias
          </div>
          <Bars data={topInc} color="var(--hi)" />
        </div>
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Quién repara más
          </div>
          <Bars data={porTecnico} color="var(--ok)" />
        </div>
      </div>

      <div className="row2" style={{ gap: 16, marginTop: 16 }}>
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Mueble más afectado
          </div>
          <Bars data={porMueble} color="var(--purple)" />
        </div>
        <div className="card">
          <div className="l" style={{ marginBottom: 12 }}>
            Cara / código más afectado
          </div>
          <Bars data={porCara} color="var(--accent2)" />
        </div>
      </div>

      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 14 }}>
        El % de SLA se calcula sobre incidencias del flujo nuevo (con reloj de
        inicio). “Tiempo prom.” usa reporte→reparado.
      </div>
    </>
  );
}

export default KpiView;
