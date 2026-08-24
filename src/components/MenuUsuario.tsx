// ============================================================
// src/components/MenuUsuario.tsx
// El avatar de la barra superior, ahora con menú desplegable.
//
// POR QUÉ EXISTE: en celular la barra se amontonaba, así que el bloque con
// el nombre y el rol (`.who .info`) se oculta por CSS desde hace tiempo. El
// efecto secundario era que en el teléfono NO había forma de saber con qué
// rol estabas entrando — y en esta app el rol cambia por completo lo que
// ves, así que no saberlo es desorientador.
//
// Tocar el avatar despliega esa información. En escritorio el bloque de la
// derecha se sigue viendo igual; el menú solo agrega el detalle (correo,
// todos los roles) y la salida.
// ============================================================
import { useState, useRef, useCallback } from 'react';
import { useClickFuera } from '../lib/useClickFuera';
import { ROLE_LABEL, ROLE_ICON } from '../lib/constants';

type Props = {
  nombre: string;
  email: string;
  iniciales: string;
  /** Rol principal (el de mayor prioridad). */
  role: string;
  /** Todos los roles del usuario. */
  misRoles: string[];
  /** Departamentos, si los tiene acotados. */
  misDep: string[];
  onSalir: () => void;
};

function MenuUsuario({
  nombre,
  email,
  iniciales,
  role,
  misRoles,
  misDep,
  onSalir,
}: Props) {
  const [abierto, setAbierto] = useState(false);
  const caja = useRef<HTMLDivElement>(null);
  const cerrar = useCallback(() => setAbierto(false), []);
  useClickFuera(caja, abierto, cerrar);

  return (
    <div style={{ position: 'relative' }} ref={caja}>
      <button
        className="avatar"
        onClick={() => setAbierto((v) => !v)}
        title={`${nombre} · ${ROLE_LABEL[role] || role}`}
        aria-haspopup="menu"
        aria-expanded={abierto}
        style={{ border: 'none', cursor: 'pointer' }}
      >
        {iniciales}
      </button>

      {abierto && (
        <div role="menu" className="panel-flotante angosto">
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{nombre}</div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                marginTop: 2,
                wordBreak: 'break-all',
              }}
            >
              {email}
            </div>
          </div>

          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
            <div
              style={{
                fontSize: 10,
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '.5px',
                marginBottom: 6,
              }}
            >
              {misRoles.length > 1 ? 'Tus roles' : 'Tu rol'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(misRoles.length ? misRoles : [role]).map((r) => (
                <span
                  key={r}
                  className="pill"
                  // El rol principal va resaltado: es el que decide qué
                  // muestra "Mi bandeja" y qué botones aparecen en cada
                  // tarjeta. Con dos roles, saber cuál manda importa.
                  style={
                    r === role
                      ? { background: '#241b17', color: 'var(--accent)' }
                      : undefined
                  }
                >
                  {ROLE_ICON[r] || '•'} {ROLE_LABEL[r] || r}
                </span>
              ))}
            </div>
            {misRoles.length > 1 && (
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 7 }}>
                El resaltado es el que manda en «Mi bandeja».
              </div>
            )}
          </div>

          {misDep.length > 0 && (
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '.5px',
                  marginBottom: 6,
                }}
              >
                {misDep.length > 1 ? 'Tus áreas' : 'Tu área'}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {misDep.map((d) => (
                  <span key={d} className="pill">
                    {d}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div style={{ padding: 10 }}>
            <button
              className="btn ghost sm"
              style={{ width: '100%' }}
              onClick={() => {
                cerrar();
                onSalir();
              }}
            >
              Salir
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default MenuUsuario;
