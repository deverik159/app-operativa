// ============================================================
// src/modules/incidencias/EditModal.tsx
// Edición de los campos "de captura" de una incidencia.
// Quién puede abrirlo lo decide IncCard: el validador mientras esté activa,
// o el reportante sobre lo suyo en por_validar/rechazada (y la RLS
// inc_upd_reportante lo vuelve a exigir del lado de la base).
// ============================================================
import { useState } from 'react';
import { sb } from '../../lib/supabase';
import { NIVEL_COLOR, TIPOS, AREAS_RESP } from '../../lib/constants';
import type { Incidencia } from '../../types/db';

/** Campos editables. Es exactamente lo que se manda en el UPDATE. */
type CamposEditables = {
  nombre_incidencia: string;
  nivel: string;
  origen: string;
  tipo: string;
  area_responsable: string;
  observaciones: string;
  campania: string;
};

type EditModalProps = {
  inc: Incidencia;
  onClose: () => void;
  /** Avisa al padre para que refleje el cambio sin recargar todo. */
  onDone: (recordId: string, patch: Partial<Incidencia>) => void;
};

function EditModal({ inc, onClose, onDone }: EditModalProps) {
  const [f, setF] = useState<CamposEditables>({
    nombre_incidencia: inc.nombre_incidencia || '',
    nivel: inc.nivel || 'Medio',
    origen: inc.origen || 'Externo',
    tipo: inc.tipo || '',
    area_responsable: inc.area_responsable || '',
    observaciones: inc.observaciones || '',
    campania: inc.campania || '',
  });
  const [busy, setBusy] = useState(false);

  const u = <K extends keyof CamposEditables>(k: K, v: CamposEditables[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  const guardar = async () => {
    if (!f.nombre_incidencia.trim()) {
      alert('La incidencia no puede quedar vacía.');
      return;
    }
    setBusy(true);
    const { error } = await sb
      .from('incidencias')
      .update(f)
      .eq('record_id', inc.record_id);
    setBusy(false);
    if (error) {
      alert('No se pudo guardar: ' + error.message);
      return;
    }
    onDone(inc.record_id, f);
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onClose();
      }}
    >
      <div className="modal">
        <h2 style={{ margin: '0 0 3px' }}>Editar incidencia</h2>
        <p className="phint">
          {inc.folio} · {inc.clave_sitio}
        </p>

        <div className="field">
          <label>Incidencia</label>
          <input
            value={f.nombre_incidencia}
            onChange={(e) => u('nombre_incidencia', e.target.value)}
          />
        </div>

        <div className="field">
          <label>Observaciones</label>
          <textarea
            rows={2}
            value={f.observaciones}
            onChange={(e) => u('observaciones', e.target.value)}
          />
        </div>

        <div className="row2">
          <div className="field">
            <label>Nivel</label>
            <select value={f.nivel} onChange={(e) => u('nivel', e.target.value)}>
              {Object.keys(NIVEL_COLOR).map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Origen</label>
            <select value={f.origen} onChange={(e) => u('origen', e.target.value)}>
              <option>Externo</option>
              <option>Interno</option>
            </select>
          </div>
        </div>

        <div className="row2">
          <div className="field">
            <label>Tipo</label>
            <select value={f.tipo} onChange={(e) => u('tipo', e.target.value)}>
              <option value="">—</option>
              {TIPOS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Área responsable</label>
            <select
              value={f.area_responsable}
              onChange={(e) => u('area_responsable', e.target.value)}
            >
              <option value="">—</option>
              {AREAS_RESP.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label>Campaña</label>
          <input
            value={f.campania}
            onChange={(e) => u('campania', e.target.value)}
          />
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" onClick={guardar} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default EditModal;
