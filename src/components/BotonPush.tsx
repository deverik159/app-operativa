// ============================================================
// src/components/BotonPush.tsx
// Botón de la barra superior para activar las notificaciones del dispositivo.
//
// Cada estado dice qué hacer, no solo que algo falló. El caso de iPhone es el
// que más lo necesita: ahí el permiso NO se puede pedir desde una pestaña de
// Safari, hay que agregar la app a la pantalla de inicio primero, y sin
// explicarlo el usuario cree que la app está rota.
// ============================================================
import { useState, useEffect, useCallback } from 'react';
import {
  estadoPush,
  activarPush,
  desactivarPush,
  estaInstalada,
} from '../lib/push';
import type { EstadoPush } from '../lib/push';

function BotonPush({ email }: { email: string }) {
  const [estado, setEstado] = useState<EstadoPush | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refrescar = useCallback(async () => {
    setEstado(await estadoPush());
  }, []);

  useEffect(() => {
    refrescar();
  }, [refrescar]);

  // Mientras no se sepa el estado, o si el navegador no lo soporta, no se
  // dibuja nada: un botón muerto solo genera dudas.
  if (estado === null || estado === 'no-soportado') return null;

  const activo = estado === 'activo';

  const activar = async () => {
    setBusy(true);
    setMsg('');
    const err = await activarPush(email);
    setBusy(false);
    if (err) setMsg(err);
    else {
      setMsg('Listo. Este dispositivo ya recibe notificaciones.');
      await refrescar();
    }
  };

  const desactivar = async () => {
    setBusy(true);
    setMsg('');
    const err = await desactivarPush();
    setBusy(false);
    if (err) setMsg(err);
    else {
      setMsg('Este dispositivo ya no recibirá notificaciones.');
      await refrescar();
    }
  };

  const esIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  return (
    <>
      <button
        className="btn ghost sm"
        onClick={() => {
          setMsg('');
          setAbierto(true);
        }}
        title={
          activo
            ? 'Notificaciones activas en este dispositivo'
            : 'Activar notificaciones en este dispositivo'
        }
      >
        {/* Deliberadamente NO es una campana. La campana de al lado son las
            notificaciones que ya tienes; esto otro es un ajuste DEL APARATO:
            si este teléfono o esta computadora recibe avisos cuando la app
            está cerrada. Dos campanas juntas se leían como lo mismo. */}
        {activo ? '📲' : '📵'}
      </button>

      {abierto && (
        <div
          className="overlay"
          style={{ alignItems: 'center' }}
          onClick={(e) => {
            if ((e.target as HTMLElement).className.includes('overlay'))
              setAbierto(false);
          }}
        >
          <div className="modal" style={{ maxWidth: 420 }}>
            <h2 style={{ margin: '0 0 3px' }}>Notificaciones en el celular</h2>
            <p className="phint">
              Para enterarte sin tener que abrir la app.
            </p>

            {msg && (
              <div className={msg.startsWith('Listo') ? 'ok-msg' : 'err'}>
                {msg}
              </div>
            )}

            {estado === 'requiere-instalar' && (
              <>
                <div className="banner" style={{ marginBottom: 14 }}>
                  En iPhone, Safari solo permite notificaciones si la app está
                  instalada. Es un paso de una vez.
                </div>
                <ol
                  style={{
                    fontSize: 13,
                    lineHeight: 1.9,
                    color: 'var(--muted)',
                    paddingLeft: 20,
                    margin: '0 0 14px',
                  }}
                >
                  <li>
                    Toca el botón <b>Compartir</b> de Safari (el cuadrito con la
                    flecha hacia arriba).
                  </li>
                  <li>
                    Elige <b>Agregar a inicio</b>.
                  </li>
                  <li>
                    Abre la app desde el icono nuevo y vuelve a este botón.
                  </li>
                </ol>
              </>
            )}

            {estado === 'bloqueado' && (
              <div className="banner" style={{ marginBottom: 14 }}>
                Las notificaciones están bloqueadas para este sitio. Se
                reactivan desde los ajustes del navegador:{' '}
                {esIOS
                  ? 'Ajustes → Notificaciones → GPO VALLAS.'
                  : 'toca el candado 🔒 junto a la dirección → Notificaciones → Permitir.'}
              </div>
            )}

            {estado === 'sin-permiso' && (
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  lineHeight: 1.7,
                  marginTop: 0,
                }}
              >
                Al activarlas, el celular te avisa cuando te asignen una
                incidencia, te dirijan un área o te escriban en un chat —
                incluso con la app cerrada.
                <br />
                <br />
                Se activan <b>por dispositivo</b>: si usas también la
                computadora, tendrás que activarlas ahí por separado.
                {!estaInstalada() && !esIOS && (
                  <>
                    <br />
                    <br />
                    Tip: puedes instalar la app desde el menú del navegador
                    (“Instalar app”) para que quede con su propio icono.
                  </>
                )}
              </p>
            )}

            {activo && (
              <div className="ok-msg" style={{ marginBottom: 14 }}>
                Este dispositivo ya recibe notificaciones.
              </div>
            )}

            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setAbierto(false)}>
                Cerrar
              </button>
              {estado === 'sin-permiso' && (
                <button className="btn" onClick={activar} disabled={busy}>
                  {busy ? 'Activando…' : '🔔 Activar'}
                </button>
              )}
              {activo && (
                <button
                  className="btn ghost"
                  onClick={desactivar}
                  disabled={busy}
                >
                  {busy ? '…' : 'Desactivar aquí'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default BotonPush;
