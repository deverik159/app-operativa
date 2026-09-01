// ============================================================
// src/modules/biobox/HistorialModal.tsx
// La hoja de vida propiamente dicha: todo lo que se le ha revisado a una
// máquina, de lo más reciente a lo más viejo.
//
// Se lee el `punto_texto` guardado en cada respuesta, NO el texto actual del
// catálogo. Es a propósito: si un punto se reescribió el mes pasado, una
// revisión de hace un año tiene que seguir diciendo lo que se contestó
// entonces. Ver la nota 2 de revisiones_schema.sql.
// ============================================================
import { useState, useEffect } from 'react';
import { sb } from '../../lib/supabase';
import type { Revision, RevisionRespuesta, RevisionEvidencia } from '../../types/db';

type Props = {
  siteId: string;
  titulo: string;
  onClose: () => void;
};

const COLOR_ESTADO: Record<string, string> = {
  operando: 'var(--ok)',
  con_falla: '#f59e0b',
  fuera_de_linea: 'var(--bad)',
};

const LABEL_ESTADO: Record<string, string> = {
  operando: 'Operando',
  con_falla: 'Con falla',
  fuera_de_linea: 'Fuera de línea',
};

function HistorialModal({ siteId, titulo, onClose }: Props) {
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');
  const [revs, setRevs] = useState<Revision[]>([]);
  const [respuestas, setRespuestas] = useState<RevisionRespuesta[]>([]);
  const [evidencias, setEvidencias] = useState<RevisionEvidencia[]>([]);
  const [abierta, setAbierta] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await sb
        .from('revisiones')
        .select('*')
        .eq('site_id', siteId)
        .order('revisado_en', { ascending: false })
        .limit(40);
      if (error) {
        setErr('No se pudo cargar el historial: ' + error.message);
        setCargando(false);
        return;
      }
      const lista = (data as Revision[]) || [];
      setRevs(lista);
      // La más reciente se abre sola: es la que casi siempre se busca.
      if (lista.length) setAbierta(lista[0].id);
      setCargando(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  // El detalle se carga por revisión, no todo de golpe: una máquina con dos
  // años de historia son cientos de respuestas que nadie va a leer.
  useEffect(() => {
    if (abierta == null) return;
    if (respuestas.some((r) => r.revision_id === abierta)) return;
    (async () => {
      const [rs, ev] = await Promise.all([
        sb
          .from('revision_respuestas')
          .select('*')
          .eq('revision_id', abierta)
          .order('orden'),
        sb.from('revision_evidencias').select('*').eq('revision_id', abierta),
      ]);
      if (rs.data) setRespuestas((p) => [...p, ...(rs.data as RevisionRespuesta[])]);
      if (ev.data) setEvidencias((p) => [...p, ...(ev.data as RevisionEvidencia[])]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierta]);

  const fecha = (s: string | null) =>
    s
      ? new Date(s).toLocaleString('es-MX', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : '—';

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onClose();
      }}
    >
      <div className="modal" style={{ maxWidth: 720 }}>
        <h2 style={{ margin: '0 0 3px' }}>Hoja de vida</h2>
        <p className="phint">{titulo}</p>

        {err && <div className="err">{err}</div>}

        {cargando ? (
          <div style={{ padding: '18px 0', fontSize: 13, color: 'var(--muted)' }}>
            Cargando…
          </div>
        ) : revs.length === 0 ? (
          <div className="banner" style={{ marginTop: 12 }}>
            Esta máquina no tiene revisiones registradas todavía.
          </div>
        ) : (
          // lista-scroll: en celular se libera el tope de 60vh (scroll
          // anidado que en iOS se traba) y scrollea la página.
          <div
            className="lista-scroll"
            style={{
              maxHeight: '60vh',
              overflowY: 'auto',
              border: '1px solid var(--line)',
              borderRadius: 10,
              marginTop: 12,
            }}
          >
            {revs.map((r) => {
              const abierto = abierta === r.id;
              const rs = respuestas.filter((x) => x.revision_id === r.id);
              const anomalias = rs.filter((x) => x.valor === 'anomalia');
              const evs = evidencias.filter((x) => x.revision_id === r.id);
              return (
                <div key={r.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <div
                    onClick={() => setAbierta(abierto ? null : r.id)}
                    style={{ padding: '10px 11px', cursor: 'pointer' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 10,
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0 }}>
                        {fecha(r.revisado_en)}
                      </span>
                      <span
                        className="tag"
                        style={{
                          flexShrink: 0,
                          color: COLOR_ESTADO[r.estado_maquina || ''] || 'var(--muted)',
                          borderColor:
                            COLOR_ESTADO[r.estado_maquina || ''] || 'var(--line)',
                        }}
                      >
                        {LABEL_ESTADO[r.estado_maquina || ''] || '—'}
                      </span>
                    </div>
                    <div
                      style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}
                    >
                      {r.revisado_por?.split('@')[0] || '—'} · {r.puntos_ok} bien ·{' '}
                      {r.puntos_anomalia} anomalía(s) · {r.puntos_na} N/A
                      {r.lat != null && ' · con ubicación'}
                    </div>
                  </div>

                  {abierto && (
                    <div
                      style={{
                        padding: '0 11px 11px',
                        background: 'var(--panel2)',
                      }}
                    >
                      {r.observaciones && (
                        <div
                          style={{
                            fontSize: 12,
                            padding: '8px 0',
                            borderTop: '1px solid var(--line)',
                          }}
                        >
                          <b>Observaciones:</b> {r.observaciones}
                        </div>
                      )}

                      {anomalias.length === 0 ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--ok)',
                            padding: '8px 0',
                          }}
                        >
                          Sin anomalías en esta visita.
                        </div>
                      ) : (
                        anomalias.map((a) => (
                          <div
                            key={a.id}
                            style={{
                              fontSize: 12,
                              padding: '7px 0',
                              borderTop: '1px solid var(--line)',
                            }}
                          >
                            <span style={{ color: 'var(--bad)' }}>⚠</span>{' '}
                            {a.punto_texto}
                            {a.nota && (
                              <span style={{ color: 'var(--muted)' }}>
                                {' '}
                                — {a.nota}
                              </span>
                            )}
                            {a.incidencia_record_id && (
                              <span
                                className="tag"
                                style={{ marginLeft: 6, fontSize: 10 }}
                              >
                                incidencia {a.incidencia_record_id}
                              </span>
                            )}
                          </div>
                        ))
                      )}

                      {evs.length > 0 && (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill,minmax(78px,1fr))',
                            gap: 7,
                            marginTop: 9,
                          }}
                        >
                          {evs.map((ev) => (
                            <a
                              key={ev.id}
                              href={ev.url}
                              target="_blank"
                              rel="noreferrer"
                              title={ev.referencia || ''}
                            >
                              {ev.tipo === 'video' ? (
                                <span
                                  className="tag"
                                  style={{
                                    display: 'flex',
                                    height: 78,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: 20,
                                  }}
                                >
                                  🎥
                                </span>
                              ) : (
                                <img
                                  src={ev.url}
                                  alt={ev.referencia || 'Evidencia'}
                                  style={{
                                    width: '100%',
                                    height: 78,
                                    objectFit: 'cover',
                                    borderRadius: 8,
                                    border: '1px solid var(--line)',
                                    display: 'block',
                                  }}
                                />
                              )}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button className="btn ghost" onClick={onClose} style={{ width: '100%' }}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

export default HistorialModal;
