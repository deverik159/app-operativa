// ============================================================
// src/modules/incidencias/AsignarAreaModal.tsx
// Dirige la incidencia al área que REALMENTE la va a reparar.
//
// NO es una reasignación. La diferencia importa:
//
//   Reasignación (ReasignModal)  → cambia `area_responsable`, deja rastro en
//     la tabla `reasignaciones` y necesita aprobación del validador. Sirve
//     cuando el catálogo se equivocó de área.
//
//   Asignar área (este modal)    → escribe `assigned_area` y ya. Sirve cuando
//     el catálogo acertó al clasificar, pero por el diagnóstico la repara
//     otra área. `area_responsable` no se toca, así que los KPIs siguen
//     midiendo qué área ORIGINA la carga.
//
// La RLS ya soporta esto sin cambios: inc_sel_reparacion e inc_upd_reparacion
// aceptan `assigned_area IN mis_departamentos()`, así que el técnico del área
// destino ve y edita la incidencia en cuanto se guarda.
//
// Escribir requiere la política inc_upd_validador (o inc_upd_manager). Por eso
// el botón solo se le ofrece al validador y al manager.
// ============================================================
import { useState } from 'react';
import { sb } from '../../lib/supabase';
import type { Incidencia } from '../../types/db';

type Props = {
  inc: Incidencia;
  /** Áreas elegibles: AREAS_RESP más las que ya existen en los datos. */
  areas: string[];
  onClose: () => void;
  onDone: (recordId: string, patch: Partial<Incidencia>) => void;
};

function AsignarAreaModal({ inc, areas, onClose, onDone }: Props) {
  const [sel, setSel] = useState(inc.assigned_area || '');
  const [busy, setBusy] = useState(false);

  const areaCatalogo = inc.area_responsable || '—';
  const yaRedirigida = !!inc.assigned_area;
  // Elegir el área del catálogo equivale a quitar la redirección.
  const vuelveAlCatalogo = sel === inc.area_responsable;

  const guardar = async () => {
    if (!sel) {
      alert('Elige el área que va a reparar.');
      return;
    }
    setBusy(true);
    // null (no cadena vacía) para que la RLS y los filtros la traten como
    // "sin redirigir" y mande `area_responsable`.
    const patch: Partial<Incidencia> = {
      assigned_area: vuelveAlCatalogo ? null : sel,
    };
    const { error } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id);
    setBusy(false);
    if (error) {
      alert('No se pudo asignar el área: ' + error.message);
      return;
    }
    onDone(inc.record_id, patch);
  };

  const quitar = async () => {
    setBusy(true);
    const patch: Partial<Incidencia> = { assigned_area: null };
    const { error } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id);
    setBusy(false);
    if (error) {
      alert('No se pudo quitar la asignación: ' + error.message);
      return;
    }
    onDone(inc.record_id, patch);
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onClose();
      }}
    >
      <div className="modal">
        <h2 style={{ margin: '0 0 3px' }}>Asignar área de reparación</h2>
        <p className="phint">
          {inc.folio} · {inc.nombre_incidencia}
        </p>

        <div className="banner" style={{ marginBottom: 14 }}>
          El catálogo clasificó esta incidencia como <b>{areaCatalogo}</b>.
          <br />
          Si por el diagnóstico la repara otra área, indícala aquí. El área del
          catálogo no cambia — se sigue usando para los indicadores.
        </div>

        {yaRedirigida && (
          <div
            style={{
              background: 'var(--panel2)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '10px 12px',
              marginBottom: 12,
              fontSize: 13,
            }}
          >
            Hoy la repara:{' '}
            <b style={{ color: 'var(--accent)' }}>{inc.assigned_area}</b>
          </div>
        )}

        <div className="field">
          <label>Área que va a reparar</label>
          <select value={sel} onChange={(e) => setSel(e.target.value)}>
            <option value="">— Selecciona —</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {a}
                {a === inc.area_responsable ? ' (la del catálogo)' : ''}
              </option>
            ))}
          </select>
        </div>

        {vuelveAlCatalogo && sel && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
            Al elegir el área del catálogo se quita la redirección.
          </div>
        )}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          {yaRedirigida && (
            <button className="btn ghost" onClick={quitar} disabled={busy}>
              Quitar redirección
            </button>
          )}
          <button className="btn" onClick={guardar} disabled={busy}>
            {busy ? 'Guardando…' : 'Asignar área'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AsignarAreaModal;
