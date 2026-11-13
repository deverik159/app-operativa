// ============================================================
// src/modules/usuarios/ActividadView.tsx
// Pestaña Actividad (13-nov-2026, Erik): quién usa la app y quién no.
// El manager la ve dentro de Usuarios y con todas las personas; el
// coordinador la ve como su propio módulo y solo con la gente de su unidad
// y su área (eso lo decide la base en `actividad_equipo`, no esta vista).
// Lógica pura en src/lib/actividad.ts.
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bell, BellOff, Copy, LogIn, MessageCircle, RefreshCw } from 'lucide-react';
import { sb } from '../../lib/supabase';
import {
  ESTADO_INFO,
  actividadPorModulo,
  areasDe,
  diaCdmx,
  estadoActividad,
  fechaCorta,
  iniciales,
  mensajeRecordatorio,
  nombreDe,
  ordenarActividad,
  telefonoWhatsapp,
  textoRol,
  textoUltimaVez,
  tiraDias,
  type EstadoActividad,
  type FilaActividad,
} from '../../lib/actividad';
import { ROLE_LABEL } from '../../lib/constants';
import Ic from '../../components/Ic';
import CerrarModal from '../../components/CerrarModal';

const etiquetaRol = (rol: string) => (ROLE_LABEL as Record<string, string>)[rol] || rol;

const ESTADOS: EstadoActividad[] = ['hoy', 'reciente', 'inactivo', 'nunca'];

/** Hasta este día el calendario de 30 días todavía no está completo. */
const FIN_ARRANQUE = '2026-12-13';

const color = (e: EstadoActividad) => `var(--st-${ESTADO_INFO[e].tono})`;
const fondo = (e: EstadoActividad) => `var(--st-${ESTADO_INFO[e].tono}-fondo)`;

type Props = {
  /** El coordinador la abre sola: lleva su propio título. */
  conTitulo?: boolean;
};

export default function ActividadView({ conTitulo }: Props) {
  const [filas, setFilas] = useState<FilaActividad[] | null>(null);
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(false);
  const [estado, setEstado] = useState<EstadoActividad | ''>('');
  const [area, setArea] = useState('');
  const [busca, setBusca] = useState('');
  const [abierta, setAbierta] = useState<FilaActividad | null>(null);

  const cargar = async () => {
    setCargando(true);
    setError('');
    const { data, error: e } = await sb.rpc('actividad_equipo', { p_dias: 30 });
    setCargando(false);
    if (e) {
      setError('No se pudo traer la actividad: ' + e.message);
      return;
    }
    setFilas((data as FilaActividad[]) || []);
  };

  useEffect(() => {
    void cargar();
  }, []);

  const ahora = useMemo(() => new Date(), [filas]);
  const ordenadas = useMemo(() => ordenarActividad(filas || [], ahora), [filas, ahora]);
  const conteo = useMemo(() => {
    const c: Record<EstadoActividad, number> = { hoy: 0, reciente: 0, inactivo: 0, nunca: 0 };
    for (const f of ordenadas) c[estadoActividad(f, ahora)]++;
    return c;
  }, [ordenadas, ahora]);
  const areas = useMemo(() => [...new Set(ordenadas.flatMap(areasDe))].sort((a, b) => a.localeCompare(b, 'es')), [ordenadas]);

  const q = busca.trim().toLowerCase();
  const visibles = ordenadas.filter(
    (f) =>
      (!estado || estadoActividad(f, ahora) === estado) &&
      (!area || areasDe(f).includes(area)) &&
      (!q || nombreDe(f).toLowerCase().includes(q) || f.email.includes(q))
  );

  return (
    <>
      {conTitulo && (
        <>
          <h2 className="page">Actividad del equipo</h2>
          <p className="phint">Quién de tu unidad y tu área usa la app, y quién todavía no.</p>
        </>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 9, margin: '4px 0 12px' }}>
        {ESTADOS.map((e) => (
          <button
            key={e}
            type="button"
            className="card"
            aria-pressed={estado === e}
            onClick={() => setEstado(estado === e ? '' : e)}
            style={{
              minWidth: 0,
              textAlign: 'left',
              cursor: 'pointer',
              font: 'inherit',
              color: 'inherit',
              borderColor: estado === e ? color(e) : undefined,
            }}
          >
            <div className="n" style={{ color: color(e) }}>
              {filas ? conteo[e] : '–'}
            </div>
            <div className="l">{ESTADO_INFO[e].titulo}</div>
          </button>
        ))}
      </div>

      <div className="toolbar">
        <input
          className="search"
          aria-label="Buscar persona"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por nombre o correo"
        />
      </div>
      <div className="toolbar filtros-pildora">
        <select aria-label="Área" className={area ? 'on' : ''} value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">Todas las áreas</option>
          {areas.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button type="button" className="btn ghost sm" onClick={() => void cargar()} disabled={cargando}>
          <Ic i={RefreshCw} />
          {cargando ? 'Cargando…' : 'Actualizar'}
        </button>
      </div>

      {error && <div className="err">{error}</div>}
      {!filas && !error && <div className="loading">Cargando actividad…</div>}

      {filas && (
        <div className="card" style={{ padding: '4px 14px', marginTop: 10 }}>
          {!visibles.length && <p className="phint" style={{ margin: '12px 0' }}>Nadie con ese filtro.</p>}
          {visibles.map((f, i) => {
            const e = estadoActividad(f, ahora);
            return (
              <button
                key={f.email}
                type="button"
                onClick={() => setAbierta(f)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '10px 0',
                  border: 0,
                  borderTop: i ? '1px solid var(--line)' : 0,
                  background: 'none',
                  font: 'inherit',
                  color: 'inherit',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span
                  aria-label={ESTADO_INFO[e].titulo}
                  style={{ width: 9, height: 9, borderRadius: '50%', background: color(e), flexShrink: 0 }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {nombreDe(f)}
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {textoUltimaVez(f, ahora)} · {areasDe(f).join(', ') || 'Sin área'}
                  </span>
                </span>
                <TiraDias dias={f.dias_uso} n={14} ahora={ahora} />
              </button>
            );
          })}
        </div>
      )}
      {filas && (
        <p className="phint" style={{ marginTop: 8 }}>
          Los cuadritos son los últimos 14 días: verde = ese día la usó. Se registran desde el 13-nov-2026; la
          última vez y el «nunca entró» sí vienen completos.
        </p>
      )}

      {abierta && <PerfilActividad fila={abierta} ahora={ahora} onCerrar={() => setAbierta(null)} />}
    </>
  );
}

function TiraDias({ dias, n, ahora, grande }: { dias: string[] | null; n: number; ahora: Date; grande?: boolean }) {
  const tira = tiraDias(dias, n, ahora);
  return (
    <span
      aria-label={`Usó la app ${tira.filter(Boolean).length} de los últimos ${n} días`}
      style={
        grande
          ? { display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 4, maxWidth: 260 }
          : { display: 'flex', gap: 2, flexShrink: 0 }
      }
    >
      {tira.map((u, i) => (
        <span
          key={i}
          style={{
            width: grande ? undefined : 5,
            height: grande ? 18 : 14,
            borderRadius: 2,
            background: u ? 'var(--st-verde)' : 'var(--fill)',
          }}
        />
      ))}
    </span>
  );
}

function PerfilActividad({ fila: f, ahora, onCerrar }: { fila: FilaActividad; ahora: Date; onCerrar: () => void }) {
  const [copiado, setCopiado] = useState(false);
  const e = estadoActividad(f, ahora);
  const modulos = actividadPorModulo(f);
  const max = Math.max(1, ...modulos.map((m) => m.n));
  const tel = telefonoWhatsapp(f.telefono);
  const mensaje = mensajeRecordatorio(f, window.location.origin);
  const usados = tiraDias(f.dias_uso, 30, ahora).filter(Boolean).length;

  useEffect(() => {
    const tecla = (ev: KeyboardEvent) => ev.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [onCerrar]);

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(mensaje);
      setCopiado(true);
    } catch {
      setCopiado(false);
    }
  };

  return (
    <div className="overlay" onClick={(ev) => ev.target === ev.currentTarget && onCerrar()}>
      <div className="modal" role="dialog" aria-label={`Actividad de ${nombreDe(f)}`} style={{ maxWidth: 440, margin: 'auto 0' }}>
        <CerrarModal onClick={onCerrar} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, paddingRight: 44 }}>
          <span
            style={{
              width: 42,
              height: 42,
              borderRadius: '50%',
              background: fondo(e),
              color: color(e),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {iniciales(f)}
          </span>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>{nombreDe(f)}</h2>
            {(f.roles || []).map((r) => (
              <div key={textoRol(r)} style={{ fontSize: 12, color: 'var(--muted)' }}>
                {textoRol(r, etiquetaRol)}
              </div>
            ))}
          </div>
        </div>

        <div className="banner" style={{ background: fondo(e), color: color(e), borderColor: `var(--st-${ESTADO_INFO[e].tono}-borde)` }}>
          {ESTADO_INFO[e].titulo} · {textoUltimaVez(f, ahora)}
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '14px 0 6px' }}>
          Últimos 30 días · {usados} {usados === 1 ? 'día' : 'días'} con uso
          {diaCdmx(ahora) < FIN_ARRANQUE && ' (se registran desde el 13-nov-2026)'}
        </div>
        <TiraDias dias={f.dias_uso} n={30} ahora={ahora} grande />

        <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '16px 0 6px' }}>Qué hizo en la app (30 días)</div>
        {!modulos.length && <div style={{ fontSize: 13 }}>Nada registrado en este periodo.</div>}
        {modulos.map((m) => (
          <div key={m.modulo} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 6 }}>
            <span style={{ width: 130, flexShrink: 0, color: 'var(--muted)' }}>{m.modulo}</span>
            <span style={{ flex: 1, height: 7, borderRadius: 4, background: 'var(--fill)' }}>
              <span style={{ display: 'block', height: '100%', width: `${(m.n / max) * 100}%`, borderRadius: 4, background: 'var(--st-verde)' }} />
            </span>
            <span style={{ width: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{m.n}</span>
          </div>
        ))}

        <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '16px 0 6px' }}>Cuenta</div>
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          <div>
            <Ic i={LogIn} />
            {f.tiene_cuenta
              ? `Entra con ${f.entra_con === 'google' ? 'Google' : 'correo'} · alta ${fechaCorta(f.alta)}`
              : 'Sin cuenta: con contraseña no puede entrar; con Google se crea al primer ingreso'}
          </div>
          <div>
            <Ic i={f.push ? Bell : BellOff} />
            Notificaciones:{' '}
            <span style={{ color: f.push ? 'var(--st-verde)' : 'var(--st-rojo)' }}>{f.push ? 'activadas' : 'no activadas'}</span>
          </div>
          <div>
            <Ic i={AlertTriangle} />
            Errores en su teléfono (30 días): {f.errores}
          </div>
        </div>

        <div className="modal-actions" style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {tel && (
            <a
              className="btn"
              href={`https://wa.me/${tel}?text=${encodeURIComponent(mensaje)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Ic i={MessageCircle} />
              Mandar recordatorio
            </a>
          )}
          <button type="button" className={tel ? 'btn ghost' : 'btn'} onClick={() => void copiar()}>
            <Ic i={Copy} />
            {copiado ? 'Mensaje copiado' : 'Copiar mensaje'}
          </button>
        </div>
        {!tel && <p className="phint" style={{ marginTop: 6 }}>No tiene celular registrado: copia el mensaje y mándalo por otro medio.</p>}
      </div>
    </div>
  );
}
