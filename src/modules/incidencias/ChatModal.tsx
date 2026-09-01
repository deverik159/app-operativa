// ============================================================
// src/modules/incidencias/ChatModal.tsx
// Chat por incidencia sobre la tabla `mensajes`, con Realtime de Supabase.
// Al recibir un mensaje ajeno marca leídas sus notificaciones, para que el
// globito del botón 💬 se apague solo mientras el chat está abierto.
// ============================================================
import { useState, useEffect, useRef } from 'react';
import { sb } from '../../lib/supabase';
import { caraLabel } from '../../lib/helpers';
import {
  validarAdjunto,
  subirAdjunto,
  MAX_VIDEO_SEG,
} from '../../lib/adjuntosChat';
import { comprimirImagen } from '../../lib/comprimirImagen';
import type { Incidencia, Mensaje, ChatAdjunto } from '../../types/db';
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

  /** Adjuntos del hilo, agrupados por mensaje. */
  const [adjuntos, setAdjuntos] = useState<Record<number, ChatAdjunto[]>>({});
  /** Archivo elegido y aún no enviado. */
  const [pendiente, setPendiente] = useState<File | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [errAdj, setErrAdj] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const cargarAdjuntos = async () => {
    const { data } = await sb
      .from('chat_adjuntos')
      .select('*')
      .eq('record_id', inc.record_id)
      .order('creado_en');
    const m: Record<number, ChatAdjunto[]> = {};
    ((data as ChatAdjunto[]) || []).forEach((a) => {
      (m[a.mensaje_id] ||= []).push(a);
    });
    setAdjuntos(m);
  };

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
      await cargarAdjuntos();
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
            // Realtime solo trae el mensaje. Sus adjuntos se insertan justo
            // después, en otra tabla, así que se vuelven a leer con un
            // respiro para no llegar antes que el INSERT del otro lado.
            setTimeout(cargarAdjuntos, 600);
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

  /**
   * Baja al final SOLO si el usuario ya estaba (casi) al final: los adjuntos
   * llegan ~600 ms después del mensaje y sus imágenes cargan asíncronas — el
   * contenido crecía por debajo del scroll y la foto del último mensaje
   * quedaba oculta bajo el pliegue, como si "no hubiera llegado nada". Pero
   * si el usuario subió a leer el historial, no hay que jalarlo.
   */
  const pegarAbajo = () => {
    const box = boxRef.current;
    if (!box) return;
    const cerca = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    if (cerca) box.scrollTop = box.scrollHeight;
  };
  useEffect(pegarAbajo, [adjuntos]);

  /** Valida el archivo elegido ANTES de dejar enviarlo. */
  const elegirArchivo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const original = e.target.files?.[0];
    e.target.value = '';
    if (!original) return;
    setErrAdj('');
    // Comprimir ANTES de validar: las fotos de un iPhone reciente pasan de
    // 5 MB con frecuencia y el límite las rechazaba sin ofrecer salida.
    // Comprimida (~1600px JPEG) una foto normal queda muy por debajo del
    // tope, que ahora solo frena lo genuinamente incomprimible.
    const f = original.type.startsWith('image/')
      ? await comprimirImagen(original)
      : original;
    const problema = await validarAdjunto(f);
    if (problema) {
      setErrAdj(problema);
      return;
    }
    setPendiente(f);
  };

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = texto.trim();
    // Se puede mandar solo un archivo, sin texto.
    if (!t && !pendiente) return;

    const archivo = pendiente;
    // Se limpia de inmediato para que se sienta ágil; si falla, se restaura.
    setTexto('');
    setPendiente(null);
    setErrAdj('');
    if (archivo) setSubiendo(true);

    try {
      // ORDEN IMPORTANTE: primero sube el archivo, luego crea el mensaje.
      // Al revés, un fallo de subida dejaría un mensaje vacío colgado en el
      // hilo sin forma de saber que le faltaba algo.
      const subido = archivo
        ? await subirAdjunto(archivo, inc.record_id)
        : null;

      const { data, error } = await sb
        .from('mensajes')
        .insert({
          record_id: inc.record_id,
          autor_email: email,
          autor_nombre: nombre,
          texto: t || (subido?.tipo === 'video' ? '🎬 Video' : '📷 Foto'),
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      const msg = data as Mensaje;
      add(msg);

      if (subido) {
        const { error: eAdj } = await sb.from('chat_adjuntos').insert({
          record_id: inc.record_id,
          mensaje_id: msg.id,
          tipo: subido.tipo,
          url: subido.url,
          path: subido.path,
          nombre: subido.nombre,
          bytes: subido.bytes,
          subido_por: email,
        });
        // El mensaje ya existe: no se aborta, pero se avisa. Callarlo dejaría
        // al usuario creyendo que mandó una foto que nadie va a ver.
        if (eAdj) setErrAdj('El mensaje se envió, pero el archivo no quedó ligado: ' + eAdj.message);
        else await cargarAdjuntos();
      }
    } catch (ex) {
      const m = ex instanceof Error ? ex.message : String(ex);
      setErrAdj('No se pudo enviar: ' + m);
      setTexto(t);
      if (archivo) setPendiente(archivo);
    } finally {
      setSubiendo(false);
    }
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onClose();
      }}
    >
      {/* La altura vive en .modal-chat (index.css): necesita el fallback
          vh→dvh por declaración doble, que un style inline no puede dar. */}
      <div
        className="modal modal-chat"
        style={{ display: 'flex', flexDirection: 'column' }}
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
            /* 100 y no 220: el modal tiene max-height (80dvh) y este mínimo
               es lo único que puede ceder. Con 220, en horizontal o con el
               teclado abierto la suma de hijos superaba el tope y el campo
               de escribir quedaba fuera de pantalla, sin scroll que llegara
               a él. El flex:1 lo hace crecer cuando sí hay espacio. */
            minHeight: 100,
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

                    {(adjuntos[m.id] || []).map((a) =>
                      a.purgado_en ? (
                        // El archivo ya se borró. Se dice explícitamente en
                        // vez de dejar un hueco: quien lee el hilo meses
                        // después debe entender que ahí HUBO algo, y por qué
                        // ya no está.
                        <div
                          key={a.id}
                          style={{
                            marginTop: 6,
                            fontSize: 11,
                            opacity: 0.65,
                            fontStyle: 'italic',
                          }}
                        >
                          📎 {a.tipo === 'video' ? 'Video' : 'Foto'} eliminado
                          al cerrar la incidencia
                        </div>
                      ) : a.tipo === 'video' ? (
                        <video
                          key={a.id}
                          src={a.url}
                          controls
                          playsInline
                          preload="metadata"
                          onLoadedMetadata={pegarAbajo}
                          style={{
                            marginTop: 6,
                            width: '100%',
                            maxHeight: 240,
                            borderRadius: 8,
                            background: '#000',
                          }}
                        />
                      ) : (
                        <a
                          key={a.id}
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            src={a.url}
                            alt={a.nombre || 'foto'}
                            loading="lazy"
                            onLoad={pegarAbajo}
                            style={{
                              marginTop: 6,
                              width: '100%',
                              maxHeight: 240,
                              objectFit: 'cover',
                              borderRadius: 8,
                              display: 'block',
                            }}
                          />
                        </a>
                      )
                    )}

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
          <>
            {errAdj && (
              <div
                className="err"
                style={{ marginBottom: 8 }}
                onClick={() => setErrAdj('')}
              >
                {errAdj}
              </div>
            )}

            {pendiente && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 8,
                  padding: '7px 10px',
                  background: 'var(--panel2)',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  fontSize: 12,
                }}
              >
                <span>
                  {pendiente.type.startsWith('video') ? '🎬' : '📷'}
                </span>
                <span
                  style={{
                    flex: 1,
                    /* Sin minWidth:0 el flex no encoge por debajo del nombre
                       completo del archivo (nowrap): un IMG_2026...HDR.jpg
                       empujaba el MB y la ✕ de Quitar fuera del modal. */
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {pendiente.name}
                </span>
                <span style={{ color: 'var(--muted)' }}>
                  {(pendiente.size / 1024 / 1024).toFixed(1)} MB
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setPendiente(null)}
                  title="Quitar"
                >
                  ✕
                </button>
              </div>
            )}

            {/* flexWrap + flex-basis chico en el input: sin eso, el
                min-content del campo (~200px) + 📎 + "Enviar" sumaban más
                que el ancho del modal en 360px y el botón de enviar quedaba
                cortado fuera de pantalla, peor aún durante "Subiendo…". */}
            <form onSubmit={enviar} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                ref={fileRef}
                type="file"
                accept="image/*,video/*"
                onChange={elegirArchivo}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                className="btn ghost"
                onClick={() => fileRef.current?.click()}
                disabled={subiendo}
                style={{ flexShrink: 0 }}
                title={`Foto o video de máximo ${MAX_VIDEO_SEG} s`}
              >
                📎
              </button>
              <input
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                placeholder={pendiente ? 'Comentario (opcional)…' : 'Escribe un mensaje…'}
                disabled={subiendo}
                style={{ flex: '1 1 140px', minWidth: 0, width: 'auto' }}
              />
              <button className="btn" type="submit" disabled={subiendo}>
                {subiendo && <span className="spinner" />}
                {subiendo ? 'Subiendo…' : 'Enviar'}
              </button>
            </form>

            <p className="phint" style={{ marginTop: 6, fontSize: 11 }}>
              Los archivos del chat se borran al cerrar la incidencia. Para
              evidencia que deba conservarse, usa 📎 Evidencia.
            </p>
          </>
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
