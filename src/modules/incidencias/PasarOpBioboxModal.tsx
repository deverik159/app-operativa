// ============================================================
// src/modules/incidencias/PasarOpBioboxModal.tsx
// «Pasar a Op. Bio Box» (Erik, 30-oct-2026): Digital o TI no pudieron
// reparar a distancia una falla de una máquina Biobox y se la pasan directo
// a Op. Bio Box, sin validador. Solo cambia el área y avisa al técnico de la
// ruta de esa máquina; luego sigue el flujo normal (repara, el validador
// aprueba, se cierra).
//
// Todo lo hace la base (inc_pasar_a_op_biobox, migración
// 20261030224358_pasar_a_op_biobox): revisa quién llama, deja el motivo en
// el chat, mueve el área y avisa. Necesita señal: no se encola.
// ============================================================
import { useState } from 'react';
import { sb } from '../../lib/supabase';
import { haySenal, haySesionReal } from '../../lib/datosLocales';
import { areaEfectiva } from '../../lib/helpers';
import { vigilarRender } from '../../lib/vigia';
import type { Incidencia } from '../../types/db';
import CerrarModal from '../../components/CerrarModal';

const SIN_SENAL = 'Necesitas señal para esto.';

type Props = {
  inc: Incidencia;
  onClose: () => void;
  onDone: (recordId: string, patch: Partial<Incidencia>) => void;
};

function PasarOpBioboxModal({ inc, onClose, onDone }: Props) {
  vigilarRender('PasarOpBioboxModal');
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const area = areaEfectiva(inc);

  const pasar = async () => {
    const m = motivo.trim();
    if (!m) {
      setErr('Escribe por qué no se pudo reparar a distancia.');
      return;
    }
    if (!haySenal()) {
      setErr(SIN_SENAL);
      return;
    }
    setBusy(true);
    setErr('');
    if (!(await haySesionReal())) {
      setBusy(false);
      setErr(SIN_SENAL);
      return;
    }
    const { error } = await sb.rpc('inc_pasar_a_op_biobox', { p_record_id: inc.record_id, p_motivo: m });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    onDone(inc.record_id, { area_responsable: 'Op. Bio Box', assigned_area: null, reasignada_de: area || null });
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay' && !busy) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pasar-opbb-titulo" style={{ maxWidth: 520 }}>
        <CerrarModal onClick={onClose} disabled={busy} />
        <h2 id="pasar-opbb-titulo" style={{ margin: '0 0 3px' }}>Pasar a Op. Bio Box</h2>
        <p className="phint">
          {inc.folio} · {inc.nombre_incidencia} · {inc.clave_sitio || '(sin clave)'} · Área actual: <b>{area || '—'}</b>
        </p>
        <div className="banner" style={{ marginBottom: 12 }}>
          Para cuando no se puede reparar a distancia. Pasa directo, sin validador: le llega al técnico de la
          ruta de esta máquina y él la repara y la cierra como siempre.
        </div>
        <div className="field">
          <label htmlFor="pasar-opbb-motivo">¿Por qué no se pudo a distancia? (obligatorio)</label>
          <textarea
            id="pasar-opbb-motivo"
            rows={3}
            maxLength={300}
            value={motivo}
            onChange={(e) => {
              setMotivo(e.target.value);
              setErr('');
            }}
            style={{ width: '100%', fontSize: 16 }}
            disabled={busy}
          />
        </div>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="modal-actions pie-fijo" style={{ marginTop: 12 }}>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancelar</button>
          <button className="btn" onClick={() => void pasar()} disabled={busy || !motivo.trim()}>
            {busy ? 'Pasando…' : 'Pasar a Op. Bio Box'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PasarOpBioboxModal;
