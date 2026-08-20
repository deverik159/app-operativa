// ============================================================
// src/modules/incidencias/ChatModal.tsx
// Chat por incidencia sobre la tabla `mensajes`, con Realtime de Supabase.
// Al recibir un mensaje ajeno marca leídas sus notificaciones, para que el
// globito del botón 💬 se apague solo mientras el chat está abierto.
// ============================================================
import { useState, useEffect, useRef } from 'react';
import { sb } from '../../lib/supabase';
import { caraLabel } from '../../lib/helpers';
import type { Incidencia, Mensaje } from '../../types/db';
import type { RealtimeChannel } from '@supabase/supabase-js';

type Props = {
  inc: Incidencia;
  email: string;
  nombre: string;
  onClose: () => void;
};

function ChatModal({ inc, email, nombre, onClose }: Props) {
  const [msgs, setMsgs] = useState<Mensaje[]>([]);
  const [texto, setTexto] = useState('');
  const [loading, setLoading] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  // Realtime y el INSERT propio pueden entregar el mismo mensaje: se
  // deduplica por id para no pintarlo dos veces.
  const add = (m: Mensaje) =>
    setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));

  useEffect(() => {
    let ch: RealtimeChannel | undefined;
    (async () => {
      const { data } = await sb
        .from('mensajes')
        .select('*')
        .eq('record_id', inc.record_id)
        .order('creado_en');
      setMsgs((data as Mensaje[]) || []);
      setLoading(false);

      ch = sb
        .channel('chat-' + inc.record_id)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'mensajes',
            filter: 'record_id=eq.' + inc.record_id,
          },
          (p) => {
            const m = p.new as Mensaje;
            add(m);
            // Si el mensaje es de alguien más y yo tengo el chat abierto,
            // ya lo estoy viendo: se marca leído.
            if ((m.autor_email || '').toLowerCase() !== (email || '').toLowerCase()) {
              sb.from('notificaciones')
                .update({ leida: true })
                .eq('evento', 'chat')
                .eq('record_id', inc.record_id)
                .eq('leida', false)
                .then(() => {});
            }
          }
        )
        .subscribe();
    })();

    return () => {
      if (ch) sb.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll al final en cada mensaje nuevo.
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [msgs, loading]);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = texto.trim();
    if (!t) return;
    // Se limpia de inmediato para que se sienta ágil; si falla, se restaura.
    setTexto('');
    const { data, error } = await sb
      .from('mensajes')
      .insert({
        record_id: inc.record_id,
        autor_email: email,
        autor_nombre: nombre,
        texto: t,
      })
      .select()
      .single();
    if (error) {
      alert('No se pudo enviar: ' + error.message);
      setTexto(t);
      return;
    }
    if (data) add(data as Mensaje);
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onClose();
      }}
    >
      <div
        className="modal"
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '80vh' }}
      >
        <h2 style={{ margin: '0 0 3px' }}>Chat de la incidencia</h2>
        <p className="phint" style={{ marginBottom: 10 }}>
          {inc.folio} · {inc.nombre_incidencia}
          {inc.clave_medio ? ` · cara ${caraLabel(inc.clave_medio)}` : ''}
        </p>

        <div
          ref={boxRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            background: 'var(--panel2)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: 12,
            minHeight: 220,
            marginBottom: 10,
          }}
        >
          {loading ? (
            <div className="loading">Cargando…</div>
          ) : msgs.length === 0 ? (
            <div
              style={{
                color: 'var(--muted)',
                fontSize: 13,
                textAlign: 'center',
                padding: 20,
              }}
            >
              Sin mensajes. Escribe el primero.
            </div>
          ) : (
            msgs.map((m) => {
              const mio =
                (m.autor_email || '').toLowerCase() === email.toLowerCase();
              return (
                <div
                  key={m.id}
                  style={{
                    display: 'flex',
                    justifyContent: mio ? 'flex-end' : 'flex-start',
                    marginBottom: 8,
                  }}
                >
                  <div
                    style={{
                      maxWidth: '78%',
                      background: mio ? 'var(--accent)' : 'var(--panel)',
                      color: mio ? '#151515' : 'var(--txt)',
                      border: '1px solid var(--line)',
                      borderRadius: 12,
                      padding: '7px 11px',
                    }}
                  >
                    {!mio && (
                      <div
                        style={{ fontSize: 11, fontWeight: 700, marginBottom: 2 }}
                      >
                        {m.autor_nombre || m.autor_email}
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: 14,
                        lineHeight: 1.4,
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {m.texto}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        opacity: 0.7,
                        marginTop: 3,
                        textAlign: 'right',
                      }}
                    >
                      {new Date(m.creado_en).toLocaleString()}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {inc.estatus === 'cerrada' ? (
          <div className="banner">
            🔒 Incidencia cerrada — el chat es de solo lectura.
          </div>
        ) : (
          <form onSubmit={enviar} style={{ display: 'flex', gap: 8 }}>
            <input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Escribe un mensaje…"
            />
            <button className="btn" type="submit">
              Enviar
            </button>
          </form>
        )}

        <div className="modal-actions" style={{ marginTop: 10 }}>
          <button className="btn ghost" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

export default ChatModal;
