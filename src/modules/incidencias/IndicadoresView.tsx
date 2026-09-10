// ============================================================
// src/modules/incidencias/IndicadoresView.tsx
// Carga los datos de la pestaña "Indicadores" y los pasa a KpiView.
//
// La separación es a propósito: aquí vive el acceso a datos (y por tanto los
// estados de carga y error), y KpiView queda como componente puro de cálculo
// y presentación, fácil de revisar sin pensar en Supabase.
// ============================================================
import { useState, useEffect } from 'react';
import { sb } from '../../lib/supabase';
import { slaHoras } from '../../lib/helpers';
import { SLA_VALIDACION_DEFAULT } from '../../lib/constants';
import { cargarNombres } from '../../lib/nombres';
import type { MapaNombres } from '../../lib/nombres';
import KpiView from './KpiView';
import type { Incidencia, SlaArea, SlaMap, SlaValidacion } from '../../types/db';

/** Tope de filas: el límite duro de Supabase es 1000. */
const LIMITE_INCIDENCIAS = 1000;
type SlaConfiguracion = { reporte: number; reparacion: number };

function IndicadoresView({
  puedeConfigurarSla = false,
}: {
  puedeConfigurarSla?: boolean;
}) {
  const [items, setItems] = useState<Incidencia[]>([]);
  const [slaMap, setSlaMap] = useState<SlaMap>({});
  const [nombres, setNombres] = useState<MapaNombres>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [slaValidacion, setSlaValidacion] = useState<SlaConfiguracion>({
    ...SLA_VALIDACION_DEFAULT,
  });
  const [slaEdicion, setSlaEdicion] = useState<SlaConfiguracion>({
    ...SLA_VALIDACION_DEFAULT,
  });
  const [guardandoSla, setGuardandoSla] = useState(false);
  const [errSla, setErrSla] = useState('');

  useEffect(() => {
    (async () => {
      const [{ data, error }, { data: slas }, { data: validaciones }, mapaNombres] = await Promise.all([
        sb
          .from('incidencias')
          .select('*')
          .order('fecha_reporte', { ascending: false })
          .limit(LIMITE_INCIDENCIAS),
        sb.from('sla_areas').select('area,sla_horas'),
        sb.from('sla_validacion').select('etapa,minutos'),
        // Nunca falla: si la RLS corta las tablas de personas, vuelve vacío y
        // los rankings caen al usuario del correo.
        cargarNombres(),
      ]);
      setNombres(mapaNombres);
      if (error) setErr('incidencias: ' + error.message);
      setItems((data as Incidencia[]) || []);

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
      setLoading(false);
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

  if (loading) return <div className="loading">Cargando indicadores…</div>;

  return (
    <>
      {err && <div className="err">{err}</div>}
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
      <KpiView items={items} slaMap={slaMap} nombres={nombres} />
    </>
  );
}

export default IndicadoresView;
