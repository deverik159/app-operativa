// ============================================================
// src/modules/equipos/EquiposView.tsx
// Equipos (Erik, 15-oct-2026): dónde está cada equipo de Digital y su
// historial de cambios.
//
// Los cambios los captura el técnico al reparar (RepararModal, cuando la
// solución cambia un equipo con serie) y viven en incidencias.cambio_equipo.
// Aquí solo se leen: por pantalla, qué equipo de cada tipo está hoy y la
// lista de cambios con cuánto duró cada equipo; y un buscador por No. de
// serie o inventario para saber dónde anda uno.
//
// Lo ven técnicos de Digital, coordinador, manager y consulta. La RLS de
// incidencias decide qué cambios le llegan a cada quien.
// ============================================================
import { Cpu, History, MapPin, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { sb } from '../../lib/supabase';
import { caraLabel } from '../../lib/helpers';
import { nombreSitio } from '../../lib/claveSitio';
import { EST_LABEL } from '../../lib/constants';
import {
  coincideBusqueda,
  esCambioEquipo,
  historiaPorPantalla,
  type RegistroEquipo,
} from '../../lib/equipos';
import Ic from '../../components/Ic';

/** Tope de lectura: de sobra para años de cambios de equipo. */
const TOPE = 2000;

const COLUMNAS =
  'record_id,folio,unidad_negocio,clave_sitio,clave_medio,nombre_biobox,direccion,repaired_by_email,estatus,cambio_equipo';

/** '2026-10-15' → '15 oct 2026'. */
function fechaCorta(dia: string): string {
  const d = new Date(dia + 'T12:00:00');
  return Number.isNaN(d.getTime())
    ? dia
    : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** 45 → '45 días'; 400 → '1 año 1 mes'. Aproximado: es para leerse rápido. */
function duracion(dias: number): string {
  if (dias < 60) return `${dias} día${dias === 1 ? '' : 's'}`;
  const meses = Math.round(dias / 30.4);
  if (meses < 12) return `${meses} meses`;
  const anios = Math.floor(meses / 12);
  const resto = meses % 12;
  return `${anios} año${anios === 1 ? '' : 's'}${resto ? ` ${resto} mes${resto === 1 ? '' : 'es'}` : ''}`;
}

function EquiposView({ recargarSignal = 0 }: { recargarSignal?: number }) {
  const [registros, setRegistros] = useState<RegistroEquipo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setError('');
    (async () => {
      const { data, error: err } = await sb
        .from('incidencias')
        .select(COLUMNAS)
        .not('cambio_equipo', 'is', null)
        .order('repaired_at', { ascending: false })
        .limit(TOPE);
      if (!vivo) return;
      setCargando(false);
      if (err) {
        setError(
          /fetch|network|load failed/i.test(err.message)
            ? 'Sin señal: el historial de equipos necesita conexión.'
            : 'No se pudo leer el historial de equipos: ' + err.message
        );
        return;
      }
      const filas = ((data || []) as Record<string, unknown>[])
        .filter((f) => esCambioEquipo(f.cambio_equipo))
        .map((f) => ({ ...(f as unknown as RegistroEquipo), cambio: f.cambio_equipo as RegistroEquipo['cambio'] }));
      setRegistros(filas);
    })();
    return () => {
      vivo = false;
    };
  }, [recargarSignal]);

  const visibles = useMemo(() => registros.filter((r) => coincideBusqueda(r, q)), [registros, q]);
  const pantallas = useMemo(() => historiaPorPantalla(visibles), [visibles]);

  return (
    <>
      <h2 className="page">Equipos</h2>
      <p className="phint">
        Dónde está cada equipo de Digital y su historial de cambios. Se llena
        cuando el técnico repara cambiando un equipo con número de serie.
      </p>

      <div className="toolbar">
        <input
          className="search"
          placeholder="Buscar por No. de serie, inventario, pantalla o folio…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {error && <div className="err">{error}</div>}
      {cargando ? (
        <div className="loading">Cargando equipos…</div>
      ) : !error && registros.length === 0 ? (
        <div className="empty">
          Todavía no hay cambios de equipo registrados. Aparecen aquí cuando un
          técnico de Digital repara con una solución de cambio de equipo.
        </div>
      ) : !error && pantallas.length === 0 ? (
        <div className="empty">Nada coincide con “{q}”.</div>
      ) : (
        <>
          <p className="phint" style={{ marginTop: -4 }}>
            {visibles.length} cambio{visibles.length === 1 ? '' : 's'} en {pantallas.length}{' '}
            pantalla{pantallas.length === 1 ? '' : 's'}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {pantallas.map((p) => (
              <div key={p.clave} className="card">
                <div style={{ fontWeight: 700, fontSize: 15 }}>
                  {nombreSitio(p.clave_sitio, p.nombre)}
                  {p.clave !== p.clave_sitio && (
                    <span style={{ color: 'var(--muted)', fontWeight: 500 }}>
                      {' '}
                      · cara {caraLabel(p.clave)}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  <Ic i={MapPin} />
                  {[p.unidad_negocio, p.direccion].filter(Boolean).join(' · ') || p.clave}
                </div>

                {/* Lo que está hoy: el que entró en el último cambio de cada tipo. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
                  {p.vigentes.map((v) => (
                    <span key={v.tipo} className="tag" title={`Desde el ${fechaCorta(v.desde)}`}>
                      <Ic i={Cpu} />
                      {v.tipo}: <b>{v.serie}</b>
                      {v.inventario ? ` · inv. ${v.inventario}` : ''}
                    </span>
                  ))}
                </div>

                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
                  <Ic i={History} />
                  Historial
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {p.cambios.map((c) => (
                    <div
                      key={c.record_id}
                      style={{
                        borderTop: '1px solid var(--line)',
                        padding: '8px 0',
                        fontSize: 13,
                      }}
                    >
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' }}>
                        <b>{fechaCorta(c.cambio.fecha)}</b>
                        <span>· {c.cambio.tipo}</span>
                        <span style={{ color: 'var(--muted)' }}>
                          · {c.folio || c.record_id}
                          {c.repaired_by_email ? ` · ${c.repaired_by_email.split('@')[0]}` : ''}
                        </span>
                        {c.estatus !== 'cerrada' && (
                          <span className="pill" style={{ background: 'var(--panel2)', color: 'var(--muted)' }}>
                            {c.estatus === 'reparado'
                              ? 'Reparación por aprobar'
                              : c.estatus === 'en_proceso'
                                ? 'Reparación rechazada'
                                : EST_LABEL[c.estatus] || c.estatus}
                          </span>
                        )}
                      </div>
                      <div style={{ marginTop: 3 }}>
                        Sale <b>{c.cambio.sale.serie}</b>
                        {c.cambio.sale.inventario ? ` (inv. ${c.cambio.sale.inventario})` : ''}
                        {c.diasQueDuro != null && (
                          <span style={{ color: 'var(--muted)' }}>
                            {' '}
                            — duró {duracion(c.diasQueDuro)}, desde el {fechaCorta(c.saleDesde!)}
                          </span>
                        )}
                      </div>
                      <div>
                        Entra <b>{c.cambio.entra.serie}</b>
                        {c.cambio.entra.inventario ? ` (inv. ${c.cambio.entra.inventario})` : ''}
                      </div>
                      {(c.cambio.sale.obs || c.cambio.entra.obs) && (
                        <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>
                          {c.cambio.sale.obs && <>Sale: {c.cambio.sale.obs}. </>}
                          {c.cambio.entra.obs && <>Entra: {c.cambio.entra.obs}.</>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {registros.length >= TOPE && (
            <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 10 }}>
              <Ic i={Search} />Se muestran los {TOPE} cambios más recientes.
            </div>
          )}
        </>
      )}
    </>
  );
}

export default EquiposView;
