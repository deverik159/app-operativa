// ============================================================
// src/components/CampanaNotifs.tsx
// La campana 🔔 de la barra superior con su panel desplegable.
// Solo presentación: el estado vive en useNotificaciones().
// ============================================================
import { useState, useRef, useCallback } from 'react';
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

  // El ref envuelve al botón Y al panel: ver la nota en useClickFuera sobre
  // por qué el botón no puede quedar fuera.
  const caja = useRef<HTMLDivElement>(null);
  const cerrar = useCallback(() => setAbierto(false), []);
  useClickFuera(caja, abierto, cerrar);

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

      {abierto && (
        // El tamaño y la posición viven en CSS (.panel-flotante) porque en
        // celular cambian por completo: dejan de colgar del botón y pasan a
        // ser una hoja del ancho de la pantalla. Con estilos en línea no se
        // podía aplicar la media query.
        <div className="panel-flotante">
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

          {error ? (
            // Distinguir "falló la consulta" de "no hay nada": si no, un
            // bloqueo de RLS se ve igual que una bandeja tranquila.
            <div className="err" style={{ margin: 12 }}>
              {error}
            </div>
          ) : notifs.length === 0 ? (
            <div
              style={{
                padding: 20,
                color: 'var(--muted)',
                fontSize: 13,
                textAlign: 'center',
              }}
            >
              Sin notificaciones.
            </div>
          ) : (
            notifs.map((n) => (
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
        </div>
      )}
    </div>
  );
}

export default CampanaNotifs;
