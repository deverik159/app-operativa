// ============================================================
// src/components/CampanaNotifs.tsx
// La campana 🔔 de la barra superior con su panel desplegable.
// Solo presentación: el estado vive en useNotificaciones().
// ============================================================
import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useClickFuera } from '../lib/useClickFuera';
import type { Notificacion } from '../types/db';

type Props = {
  notifs: Notificacion[];
  noLeidas: number;
  /** Error de la última consulta. Se muestra en vez de "sin notificaciones". */
  error?: string;
  onMarcarTodas: () => void;
  /** Clic en una notificación: el padre la marca leída y navega. */
  onIr: (n: Notificacion) => void;
};

function CampanaNotifs({
  notifs,
  noLeidas,
  error,
  onMarcarTodas,
  onIr,
}: Props) {
  const [abierto, setAbierto] = useState(false);

  // ── Dos pestañas: Incidencias y Mensajes (pliego petitorio, ago-2026) ──
  // El problema real: 50 mensajes de un chat entierran el aviso de una
  // incidencia nueva. Se parte por `evento`: 'chat' a su pestaña, TODO lo
  // demás a Incidencias — así un evento nuevo que se invente mañana cae en
  // Incidencias en vez de desaparecer, que es el lado seguro del default.
  const [pestana, setPestana] = useState<'incidencias' | 'chat'>('incidencias');
  const deChat = notifs.filter((n) => n.evento === 'chat');
  const deIncidencias = notifs.filter((n) => n.evento !== 'chat');
  const noLeidasChat = deChat.filter((n) => !n.leida).length;
  const noLeidasInc = deIncidencias.filter((n) => !n.leida).length;
  const visibles = pestana === 'chat' ? deChat : deIncidencias;

  // ══ POR QUÉ EL PANEL VA EN UN PORTAL (bug de iPhone, ago-2026) ══
  //
  // El panel vivía dentro de la barra superior, que es `position:sticky`, y
  // en celular el CSS lo volvía `position:fixed`. En Chrome eso funciona; en
  // Safari de iOS un fixed ADENTRO de un sticky es un bug conocido: el panel
  // se PINTA donde debe, pero su área táctil queda donde estaría sin el
  // fixed — sobre todo con la página ya scrolleada. Resultado: pestañas
  // visibles que no responden al tacto. Se comprobó que en Chromium con
  // touch emulado sí funcionaban, lo que acotó el problema a Safari.
  //
  // El portal monta el panel directamente en <body>: sin ancestro sticky,
  // el fixed es fixed de verdad y el área táctil coincide con lo pintado.
  //
  // Consecuencias que el portal arrastra, ya resueltas:
  //   · el panel deja de ser hijo DOM del botón → useClickFuera recibe DOS
  //     refs (botón y panel), si no, tocar el panel lo cerraría.
  //   · deja de heredar el contexto de apilamiento de la barra → su z-index
  //     ahora compite con el menú inferior (900) y debe ganarle: 950 en CSS.
  const caja = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const cerrar = useCallback(() => setAbierto(false), []);
  useClickFuera([caja, panel], abierto, cerrar);

  return (
    <div style={{ position: 'relative' }} ref={caja}>
      <button
        className="btn ghost sm"
        onClick={() => setAbierto((v) => !v)}
        title="Notificaciones"
        style={{ position: 'relative' }}
      >
        🔔
        {noLeidas > 0 && (
          <span
            className="badge-pulse"
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              background: 'var(--accent)',
              color: '#151515',
              borderRadius: 20,
              fontSize: 10,
              fontWeight: 800,
              padding: '0 5px',
            }}
          >
            {noLeidas}
          </span>
        )}
      </button>

      {abierto &&
        createPortal(
        // El tamaño y la posición viven en CSS (.panel-flotante) porque en
        // celular cambian por completo: dejan de colgar del botón y pasan a
        // ser una hoja del ancho de la pantalla. Con estilos en línea no se
        // podía aplicar la media query.
        <div className="panel-flotante" ref={panel}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 12px',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <b style={{ fontSize: 13 }}>Notificaciones</b>
            {noLeidas > 0 && (
              <button className="btn ghost sm" onClick={onMarcarTodas}>
                Marcar todas
              </button>
            )}
          </div>

          {/* Cada pestaña trae SU contador de no leídas: es lo que evita que
              el chat entierre a las incidencias — aunque estés parado en
              Mensajes, el numerito de Incidencias te avisa. */}
          <div
            style={{
              display: 'flex',
              borderBottom: '1px solid var(--line)',
            }}
          >
            {(
              [
                ['incidencias', 'Incidencias', noLeidasInc],
                ['chat', 'Mensajes', noLeidasChat],
              ] as const
            ).map(([k, t, n]) => (
              <button
                key={k}
                onClick={() => setPestana(k)}
                style={{
                  flex: 1,
                  background: 'none',
                  border: 'none',
                  // El subrayado activo es un box-shadow interno y NO un
                  // borderBottom: mezclar `border` (atajo) con `borderBottom`
                  // (propiedad suelta) en estilos de React está documentado
                  // como fuente de actualizaciones impredecibles entre
                  // renders — justo lo que un toggle no puede permitirse.
                  boxShadow:
                    pestana === k
                      ? 'inset 0 -2px 0 var(--accent)'
                      : 'none',
                  color: pestana === k ? 'var(--txt)' : 'var(--muted)',
                  font: 'inherit',
                  fontSize: 13,
                  fontWeight: pestana === k ? 700 : 400,
                  /* 12px de padding ≈ 42px de alto: estas pestañas son la
                     navegación del panel y con 9px quedaban en ~34px,
                     debajo del mínimo táctil del resto de la app. */
                  padding: '12px 0',
                  cursor: 'pointer',
                }}
              >
                {t}
                {n > 0 && (
                  <span
                    style={{
                      marginLeft: 6,
                      background: 'var(--accent)',
                      color: '#151515',
                      borderRadius: 20,
                      fontSize: 10,
                      fontWeight: 800,
                      padding: '0 5px',
                    }}
                  >
                    {n}
                  </span>
                )}
              </button>
            ))}
          </div>

          {error ? (
            // Distinguir "falló la consulta" de "no hay nada": si no, un
            // bloqueo de RLS se ve igual que una bandeja tranquila.
            <div className="err" style={{ margin: 12 }}>
              {error}
            </div>
          ) : visibles.length === 0 ? (
            <div
              style={{
                padding: 20,
                color: 'var(--muted)',
                fontSize: 13,
                textAlign: 'center',
              }}
            >
              {pestana === 'chat'
                ? 'Sin mensajes de chat.'
                : 'Sin avisos de incidencias.'}
            </div>
          ) : (
            visibles.map((n) => (
              <div
                key={n.id}
                onClick={() => {
                  onIr(n);
                  setAbierto(false);
                }}
                style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--line)',
                  cursor: 'pointer',
                  // Las no leídas se resaltan con un fondo cálido.
                  background: n.leida ? 'transparent' : '#241b17',
                }}
              >
                <div style={{ fontSize: 13, lineHeight: 1.4 }}>{n.mensaje}</div>
                <div
                  style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}
                >
                  {n.unidad_negocio} · {new Date(n.creado_en).toLocaleString()}
                </div>
              </div>
            ))
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

export default CampanaNotifs;
