// ============================================================
// src/modules/incidencias/ReasignModal.tsx
// Reasignación de área responsable. Dos modos en un mismo modal:
//   'solicitar' — el área actual pide moverla a otra (deja la incidencia
//                 con reasignacion_pendiente=true).
//   'aprobar'   — el validador revisa la solicitud abierta y la resuelve.
// ============================================================
import { useState, useEffect } from 'react';
import { sb } from '../../lib/supabase';
import { AREAS_RESP } from '../../lib/constants';
import { BUCKET_EVIDENCIAS } from '../../lib/storage';
import SubirArchivos from '../../components/SubirArchivos';
import type { Incidencia, Reasignacion } from '../../types/db';

export type ModoReasign = 'solicitar' | 'aprobar';

type Props = {
  inc: Incidencia;
  mode: ModoReasign;
  email: string;
  onClose: () => void;
  onDone: (recordId: string, patch: Partial<Incidencia>) => void;
};

function ReasignModal({ inc, mode, email, onClose, onDone }: Props) {
  const [busy, setBusy] = useState(false);

  // --- modo solicitar ---
  const [areaDestino, setAreaDestino] = useState(
    AREAS_RESP.find((a) => a !== inc.area_responsable) || AREAS_RESP[0]
  );
  const [motivo, setMotivo] = useState('');
  const [file, setFile] = useState<File | null>(null);

  // --- modo aprobar ---
  const [req, setReq] = useState<Reasignacion | null>(null);
  const [loading, setLoading] = useState(mode === 'aprobar');
  const [comentario, setComentario] = useState('');

  useEffect(() => {
    if (mode !== 'aprobar') return;
    (async () => {
      // La más reciente que siga abierta. Puede no haber ninguna si otro
      // validador ya la resolvió mientras este usuario tenía la lista vieja.
      const { data } = await sb
        .from('reasignaciones')
        .select('*')
        .eq('record_id', inc.record_id)
        .eq('estado', 'Solicitada')
        .order('fecha_solicitud', { ascending: false })
        .limit(1);
      setReq(((data as Reasignacion[]) || [])[0] || null);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const solicitar = async () => {
    if (!motivo.trim()) {
      alert('Escribe el motivo de la reasignación.');
      return;
    }
    setBusy(true);

    // La evidencia es opcional: si la subida falla, se sigue sin ella en vez
    // de bloquear la solicitud.
    let evidenciaUrl: string | null = null;
    if (file) {
      const path = `${inc.record_id}/reasignacion_${Date.now()}_${file.name.replace(
        /[^\w.\-]/g,
        '_'
      )}`;
      const { error: upErr } = await sb.storage
        .from(BUCKET_EVIDENCIAS)
        .upload(path, file);
      if (!upErr) {
        evidenciaUrl = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path)
          .data.publicUrl;
      }
    }

    const rid = crypto.randomUUID().slice(0, 8);
    const { error } = await sb.from('reasignaciones').insert({
      reassign_id: rid,
      record_id: inc.record_id,
      folio: inc.folio,
      unidad_negocio: inc.unidad_negocio,
      area_origen: inc.area_responsable,
      area_destino: areaDestino,
      motivo,
      evidencia: evidenciaUrl,
      solicitado_por: email,
      fecha_solicitud: new Date().toISOString(),
      estado: 'Solicitada',
    });
    if (error) {
      setBusy(false);
      alert('No se pudo solicitar: ' + error.message);
      return;
    }

    const { error: e2 } = await sb
      .from('incidencias')
      .update({ reasignacion_pendiente: true })
      .eq('record_id', inc.record_id);
    setBusy(false);
    if (e2) {
      // La solicitud SÍ quedó registrada; solo falló marcar la incidencia.
      alert('Se registró, pero no se marcó pendiente: ' + e2.message);
      return;
    }
    onDone(inc.record_id, { reasignacion_pendiente: true });
  };

  const resolver = async (aprobar: boolean) => {
    if (!req) return;
    if (!aprobar && !comentario.trim()) {
      alert('Escribe el motivo del rechazo.');
      return;
    }
    setBusy(true);

    const { error } = await sb
      .from('reasignaciones')
      .update({
        estado: aprobar ? 'Aprobada' : 'Rechazada',
        resuelta_por: email,
        fecha_resolucion: new Date().toISOString(),
        comentario: comentario || null,
      })
      .eq('reassign_id', req.reassign_id);
    if (error) {
      setBusy(false);
      alert('No se pudo resolver: ' + error.message);
      return;
    }

    // Aprobar mueve el área; rechazar solo quita la bandera.
    const patch: Partial<Incidencia> = aprobar
      ? { area_responsable: req.area_destino, reasignacion_pendiente: false }
      : { reasignacion_pendiente: false };

    const { error: e2 } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id);
    setBusy(false);
    if (e2) {
      alert('Se resolvió, pero no se actualizó la incidencia: ' + e2.message);
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
        <h2 style={{ margin: '0 0 3px' }}>
          {mode === 'aprobar' ? 'Revisar reasignación' : 'Solicitar reasignación'}
        </h2>
        <p className="phint">
          {inc.folio} · {inc.nombre_incidencia} · Área actual:{' '}
          <b>{inc.area_responsable || '—'}</b>
        </p>

        {mode === 'solicitar' ? (
          <>
            <div className="field">
              <label>Reasignar al área</label>
              <select
                value={areaDestino}
                onChange={(e) => setAreaDestino(e.target.value)}
              >
                {AREAS_RESP.filter((a) => a !== inc.area_responsable).map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Motivo</label>
              <textarea
                rows={3}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Por qué debe ir a otra área…"
              />
            </div>
            <div className="field">
              <label>Evidencia (opcional)</label>
              <SubirArchivos
                accept="image/*"
                multiple={false}
                archivos={file ? [file] : []}
                onFiles={(f) => setFile(f[0] || null)}
                onQuitar={() => setFile(null)}
              />
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>
                Cancelar
              </button>
              <button className="btn" onClick={solicitar} disabled={busy}>
                {busy ? 'Enviando…' : 'Solicitar reasignación'}
              </button>
            </div>
          </>
        ) : loading ? (
          <div className="loading">Cargando…</div>
        ) : !req ? (
          <div className="empty">No hay una solicitud pendiente.</div>
        ) : (
          <>
            <div
              style={{
                background: 'var(--panel2)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '11px 12px',
                marginBottom: 12,
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              <div>
                <b>{req.area_origen || '—'}</b> →{' '}
                <b style={{ color: '#a78bfa' }}>{req.area_destino}</b>
              </div>
              <div style={{ color: 'var(--muted)' }}>
                Solicita: {req.solicitado_por}
              </div>
              <div style={{ marginTop: 6 }}>Motivo: “{req.motivo || '—'}”</div>
              {req.evidencia && (
                <a
                  href={req.evidencia}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-block', marginTop: 8 }}
                >
                  <img
                    src={req.evidencia}
                    alt="Evidencia de la reasignación"
                    style={{
                      width: 120,
                      borderRadius: 8,
                      border: '1px solid var(--line)',
                    }}
                  />
                </a>
              )}
            </div>
            <div className="field">
              <label>Comentario (obligatorio si rechazas)</label>
              <input
                value={comentario}
                onChange={(e) => setComentario(e.target.value)}
              />
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>
                Cerrar
              </button>
              <button
                className="btn hi"
                onClick={() => resolver(false)}
                disabled={busy}
              >
                ✕ Rechazar
              </button>
              <button
                className="btn ok"
                onClick={() => resolver(true)}
                disabled={busy}
              >
                ✓ Aprobar y reasignar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default ReasignModal;
