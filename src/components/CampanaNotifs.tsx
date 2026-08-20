// ============================================================
// src/components/CampanaNotifs.tsx
// La campana 🔔 de la barra superior con su panel desplegable.
// Solo presentación: el estado vive en useNotificaciones().
// ============================================================
import { useState } from 'react';
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

  return (
    <div style={{ position: 'relative' }}>
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
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '42px',
            width: 320,
            maxHeight: 400,
            overflow: 'auto',
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            zIndex: 40,
            boxShadow: '0 8px 24px rgba(0,0,0,.5)',
          }}
        >
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
