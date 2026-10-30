// ============================================================
// src/modules/incidencias/ApoyoModal.tsx
// «¿Te apoyó algún técnico?» — sale al tocar «Guardar reparación» en una
// incidencia de Op. Bio Box de Biobox (Erik, 29-oct-2026; ver
// lib/apoyoReparacion.ts). Es opcional y se elige UNO:
//   · «No, guardar así» → guarda sin apoyo;
//   · «Guardar»         → guarda con el elegido (apagado hasta elegir);
//   · ✕ / Cancelar      → regresa a Reparar sin guardar nada.
// Sin red ni copia en el teléfono no hay lista: lo dice y deja guardar sin
// apoyo, para que la reparación nunca se atore por esto.
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import CerrarModal from '../../components/CerrarModal';
import {
  cargarTecnicosApoyo,
  filtrarTecnicos,
  type TecnicoApoyo,
} from '../../lib/apoyoReparacion';

type Props = {
  email: string;
  /** El que ya tenía la incidencia (una reparación anterior que se rechazó). */
  inicial?: string | null;
  onCancelar: () => void;
  /** null = nadie lo apoyó. */
  onElegir: (apoyo: string | null) => void;
};

function ApoyoModal({ email, inicial, onCancelar, onElegir }: Props) {
  const [tecnicos, setTecnicos] = useState<TecnicoApoyo[] | null>(null);
  const [cargando, setCargando] = useState(true);
  const [deCopia, setDeCopia] = useState(false);
  const [texto, setTexto] = useState('');
  const [elegido, setElegido] = useState<string>((inicial || '').trim().toLowerCase());

  useEffect(() => {
    let vivo = true;
    cargarTecnicosApoyo(email)
      .then((r) => {
        if (!vivo) return;
        setTecnicos(r ? r.tecnicos : null);
        setDeCopia(r?.origen === 'local');
      })
      .catch(() => vivo && setTecnicos(null))
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
    };
  }, [email]);

  // El de la reparación anterior solo cuenta si sigue en la lista.
  const valido = !!elegido && !!tecnicos?.some((t) => t.email === elegido);
  const visibles = useMemo(() => filtrarTecnicos(tecnicos || [], texto), [tecnicos, texto]);
  const nombreElegido = tecnicos?.find((t) => t.email === elegido)?.nombre;

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onCancelar();
      }}
    >
      <div className="modal">
        <CerrarModal onClick={onCancelar} />
        <h2 style={{ margin: '0 0 3px' }}>¿Te apoyó algún técnico?</h2>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>
          Opcional. Si otro técnico de Op. Bio Box te ayudó en esta reparación, elígelo: se le avisa y cuenta en
          Indicadores.
        </div>

        {cargando ? (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            <span className="spinner" /> Cargando técnicos…
          </div>
        ) : !tecnicos ? (
          <div className="banner" style={{ marginBottom: 0 }}>
            Sin señal y sin una lista guardada en el teléfono: puedes guardar la reparación sin apoyo.
          </div>
        ) : tecnicos.length === 0 ? (
          <div className="banner" style={{ marginBottom: 0 }}>
            No hay otros técnicos de Op. Bio Box para elegir.
          </div>
        ) : (
          <div className="field" style={{ marginBottom: 0 }}>
            <input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Buscar por nombre…"
              aria-label="Buscar técnico"
            />
            {deCopia && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                Sin señal: lista guardada en el teléfono.
              </div>
            )}
            <div
              role="radiogroup"
              aria-label="Técnico que apoyó"
              style={{
                border: '1px solid var(--line)',
                borderRadius: 9,
                marginTop: 6,
                maxHeight: 260,
                overflow: 'auto',
              }}
            >
              {visibles.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 10px' }}>Sin resultados</div>
              )}
              {visibles.map((t) => {
                const on = t.email === elegido;
                return (
                  <button
                    key={t.email}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className="btn ghost"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      textAlign: 'left',
                      borderRadius: 0,
                      border: 'none',
                      background: on ? 'var(--activo-fondo)' : undefined,
                      fontWeight: on ? 700 : 400,
                    }}
                    onClick={() => setElegido(on ? '' : t.email)}
                  >
                    <span aria-hidden="true" style={{ width: 16, flex: 'none' }}>
                      {on ? '●' : '○'}
                    </span>
                    <span>
                      {t.nombre}
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>
                        {t.email.split('@')[0]}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="modal-actions pie-fijo">
          <button className="btn ghost" onClick={() => onElegir(null)} disabled={cargando}>
            No, guardar así
          </button>
          <button
            className="btn warn"
            onClick={() => valido && onElegir(elegido)}
            disabled={cargando || !valido}
            title={nombreElegido ? `Guardar con el apoyo de ${nombreElegido}` : 'Elige a un técnico'}
          >
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

export default ApoyoModal;
