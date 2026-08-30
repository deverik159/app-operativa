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
import { cargarNombres } from '../../lib/nombres';
import type { MapaNombres } from '../../lib/nombres';
import KpiView from './KpiView';
import type { Incidencia, SlaArea, SlaMap } from '../../types/db';

/** Tope de filas: el límite duro de Supabase es 1000. */
const LIMITE_INCIDENCIAS = 1000;

function IndicadoresView() {
  const [items, setItems] = useState<Incidencia[]>([]);
  const [slaMap, setSlaMap] = useState<SlaMap>({});
  const [nombres, setNombres] = useState<MapaNombres>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const [{ data, error }, { data: slas }, mapaNombres] = await Promise.all([
        sb
          .from('incidencias')
          .select('*')
          .order('fecha_reporte', { ascending: false })
          .limit(LIMITE_INCIDENCIAS),
        sb.from('sla_areas').select('area,sla_horas'),
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
      setLoading(false);
    })();
  }, []);

  if (loading) return <div className="loading">Cargando indicadores…</div>;

  return (
    <>
      {err && <div className="err">{err}</div>}
      <KpiView items={items} slaMap={slaMap} nombres={nombres} />
    </>
  );
}

export default IndicadoresView;
