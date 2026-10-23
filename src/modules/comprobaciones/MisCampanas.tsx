// ============================================================
// src/modules/comprobaciones/MisCampanas.tsx
// Analista · Mis campañas (Erik, 23-oct-2026). Pensado primero para iPhone.
//
// Solo las campañas que la persona lleva HOY (analista_email === email):
// Victor es Supervisor Y analista, y al Supervisor la base le da toda la
// unidad, así que aquí se filtra. Arriba, tarjetas (campañas, sitios
// pendientes, vencen pronto, vencidas); luego Pendientes / Completas / Todas
// y el buscador; cada campaña es una tarjeta .inc con su avance, la fecha
// límite con semáforo, la especificación y sus etiquetas. Al tocarla se abre
// el detalle a pantalla completa (DetalleCampana) para marcar sitios.
//
// La lista ya la trae el esqueleto (vw_comp_campanas del periodo); el
// detalle relee la campaña y pide al esqueleto releer la lista en silencio
// (recargar) después de cada marca, sin desmontar nada.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import Ic from '../../components/Ic';
import { esMedio24h, HORARIO_24H } from '../../lib/comprobaciones';
import type { VwCampana } from '../../lib/comprobacionesApi';
import { colorTono } from '../../lib/tonos';
import { vigilarRender } from '../../lib/vigia';
import { Barra, nf, PildoraLimite, sinPorComprobar, TEXTO_SIN_POR_COMPROBAR, textoAvance, textoEntrega } from './AvanceComun';
import DetalleCampana from './DetalleCampana';
import type { PropsPestanaComp } from './tiposComp';

type Filtro = 'pendientes' | 'completas' | 'todas';

/** Tarjetas que se pintan de inicio («Ver más» de 60 en 60). */
const PAGINA = 60;

/**
 * Pendiente = abierta, no retirada, sin llegar a la meta y con algo que
 * marcar. Sin sitios por comprobar (todo cancelado, meta 0) ya no es suya:
 * no cuenta como pendiente ni vencida (revisión de pantallas, 23-oct-2026).
 */
const esPendiente = (c: VwCampana) => c.estatus === 'abierta' && !c.retirada && !c.completa && !sinPorComprobar(c);
const esCompleta = (c: VwCampana) => !c.retirada && (c.estatus === 'cerrada' || !!c.completa);

/** Primero lo que vence antes; sin fecha al final; luego lo más atrasado. */
function ordenar(a: VwCampana, b: VwCampana): number {
  const pa = esPendiente(a) ? 0 : 1;
  const pb = esPendiente(b) ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const da = a.dias_restantes ?? Number.POSITIVE_INFINITY;
  const db = b.dias_restantes ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  const ka = a.pct ?? 0;
  const kb = b.pct ?? 0;
  if (ka !== kb) return ka - kb;
  return a.campana.localeCompare(b.campana) || a.version.localeCompare(b.version) || a.id - b.id;
}

export default function MisCampanas(props: PropsPestanaComp) {
  vigilarRender('MisCampanas');
  const { campanas, email, cargando, periodo, permisos, unidad } = props;

  const mias = useMemo(() => campanas.filter((c) => (c.analista_email || '').toLowerCase() === email), [campanas, email]);

  const t = useMemo(() => {
    let vivas = 0;
    let pendientesSitios = 0;
    let pendientesCamp = 0;
    let pronto = 0;
    let vencidas = 0;
    let hoy = 0;
    for (const c of mias) {
      if (c.retirada) continue;
      vivas++;
      hoy += c.comprobados_hoy || 0;
      if (!esPendiente(c)) continue;
      pendientesCamp++;
      pendientesSitios += c.pendientes || 0;
      if (c.dias_restantes != null && c.dias_restantes < 0) vencidas++;
      else if (c.dias_restantes != null && c.dias_restantes <= 2) pronto++;
    }
    return { vivas, pendientesSitios, pendientesCamp, pronto, vencidas, hoy };
  }, [mias]);

  const [filtroSel, setFiltro] = useState<Filtro | null>(null);
  const filtro: Filtro = filtroSel ?? (t.pendientesCamp > 0 || !mias.length ? 'pendientes' : 'todas');
  const [busca, setBusca] = useState('');
  const [limite, setLimite] = useState(PAGINA);
  const [abiertaId, setAbiertaId] = useState<number | null>(null);
  // Copia de la campaña abierta: si la reasignan mientras está abierta, el
  // detalle no se cae (se queda en lectura con lo último que se vio).
  const [abiertaCopia, setAbiertaCopia] = useState<VwCampana | null>(null);
  // Al cambiar de periodo o de unidad se cierra el detalle (como en
  // Campañas): si no, se quedaba la campaña de antes con los días de marca
  // del periodo nuevo (revisión de pantallas, 23-oct-2026).
  useEffect(() => {
    setAbiertaId(null);
    setAbiertaCopia(null);
  }, [periodo.id, unidad]);

  const visibles = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return mias
      .filter((c) => (filtro === 'pendientes' ? esPendiente(c) : filtro === 'completas' ? esCompleta(c) : true))
      .filter(
        (c) =>
          !q ||
          [c.campana, c.version, c.cliente, c.vendedor, c.administrador, c.quantum].some((x) => (x || '').toLowerCase().includes(q))
      )
      .sort(ordenar);
  }, [mias, filtro, busca]);

  const conteo: Record<Filtro, number> = {
    pendientes: mias.filter(esPendiente).length,
    completas: mias.filter(esCompleta).length,
    todas: mias.length,
  };

  const abierta = abiertaId == null ? null : mias.find((c) => c.id === abiertaId) ?? campanas.find((c) => c.id === abiertaId) ?? abiertaCopia;

  if (!permisos.esAnalista)
    return <div className="empty">«Mis campañas» es para quien tiene el rol de analista en esta unidad.</div>;

  if (cargando && !campanas.length)
    return (
      <div className="phint">
        <span className="spinner" />
        Leyendo tus campañas…
      </div>
    );

  const es24 = esMedio24h(unidad);

  return (
    <div>
      <div className="cards">
        {[
          { l: 'Mis campañas', n: t.vivas, sub: `${nf(t.pendientesCamp)} por terminar` },
          { l: 'Sitios pendientes', n: t.pendientesSitios, c: 'var(--warn)' },
          { l: 'Vencen pronto', n: t.pronto, c: t.pronto ? 'var(--warn)' : undefined, sub: '2 días o menos' },
          { l: 'Vencidas', n: t.vencidas, c: t.vencidas ? colorTono('rojo') : undefined },
          { l: 'Comprobados hoy', n: t.hoy, c: colorTono('verde') },
        ].map((x) => (
          <div key={x.l} className="card">
            <div className="n" style={{ color: x.c }}>
              {nf(x.n)}
            </div>
            <div className="l">
              {x.l}
              {x.sub ? <span style={{ color: 'var(--muted)', fontWeight: 400, textTransform: 'none' }}> · {x.sub}</span> : null}
            </div>
          </div>
        ))}
      </div>

      <div className="rt-chips rt-segmento" role="group" aria-label="Qué campañas ver" style={{ marginBottom: 10 }}>
        {(
          [
            ['pendientes', 'Pendientes'],
            ['completas', 'Completas'],
            ['todas', 'Todas'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            className={'rt-chip' + (filtro === k ? ' on' : '')}
            aria-pressed={filtro === k}
            onClick={() => {
              setFiltro(k);
              setLimite(PAGINA);
            }}
          >
            {l} ({nf(conteo[k])})
          </button>
        ))}
      </div>
      {mias.length > 4 && (
        <div className="toolbar">
          <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 0 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }}>
              <Ic i={Search} />
            </span>
            <input
              className="search"
              type="search"
              placeholder="Buscar campaña, versión o cliente"
              aria-label="Buscar campaña, versión o cliente"
              value={busca}
              onChange={(e) => {
                setBusca(e.target.value);
                setLimite(PAGINA);
              }}
              style={{ paddingLeft: 32, fontSize: 16 }}
            />
          </div>
        </div>
      )}

      {mias.length === 0 ? (
        <div className="empty">
          No tienes campañas asignadas en {periodo.etiqueta}. Cuando el Supervisor te asigne, aparecen aquí.
        </div>
      ) : visibles.length === 0 ? (
        <div className="empty">
          {busca
            ? 'Ninguna campaña coincide con la búsqueda.'
            : filtro === 'pendientes'
              ? '¡No tienes campañas pendientes en este periodo!'
              : 'No hay campañas aquí.'}
        </div>
      ) : (
        <div className="inc-list">
          {visibles.slice(0, limite).map((c) => {
            const entrega = textoEntrega(c.entrega_tipo);
            const titulo = c.version ? `${c.campana} · ${c.version}` : c.campana;
            return (
              <div
                key={c.id}
                className="inc"
                role="button"
                tabIndex={0}
                aria-label={`Abrir ${titulo}`}
                onClick={() => {
                  setAbiertaId(c.id);
                  setAbiertaCopia(c);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setAbiertaId(c.id);
                    setAbiertaCopia(c);
                  }
                }}
                style={{ cursor: 'pointer', opacity: c.retirada ? 0.7 : 1 }}
              >
                <div className="folio">
                  {c.unidad_etiqueta}
                  {c.unidad === 'Vía Verde' ? ` · ${c.medio}` : ''} · {periodo.etiqueta}
                </div>
                <div className="titulo" style={{ overflowWrap: 'anywhere' }}>
                  {titulo}
                </div>
                {c.cliente && (
                  <div style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere', marginBottom: 4 }}>{c.cliente}</div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0 4px' }}>
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <Barra pct={c.pct} />
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                    {textoAvance(c.comprobados, c.meta, c.pct)}
                  </span>
                </div>
                <div className="rt-fila-tags" style={{ marginTop: 6 }}>
                  <PildoraLimite c={c} />
                  {c.pendientes > 0 && esPendiente(c) && (
                    <span className="tag">
                      {nf(c.pendientes)} {c.pendientes === 1 ? 'pendiente' : 'pendientes'}
                    </span>
                  )}
                  {c.es_full && <span className="tag">FULL{c.full_minutos ? ` ${c.full_minutos} min` : ''}</span>}
                  {c.arte && <span className="tag">{c.arte}</span>}
                  {c.tipo_venta && c.tipo_venta !== 'VENTA' && <span className="tag">{c.tipo_venta}</span>}
                  {entrega && (
                    <span className="tag" style={{ color: 'var(--warn)' }}>
                      {entrega}
                    </span>
                  )}
                  {es24 && <span className="tag">{HORARIO_24H}</span>}
                  {sinPorComprobar(c) && (
                    <span className="tag" style={{ color: 'var(--warn)' }} title={TEXTO_SIN_POR_COMPROBAR}>
                      Pídele al Supervisor que la cierre
                    </span>
                  )}
                  {c.retirada && (
                    <span className="tag" style={{ color: 'var(--warn)' }}>
                      retirada
                    </span>
                  )}
                </div>
                {c.especificacion && (
                  <div
                    className="obs"
                    style={{
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {c.especificacion}
                  </div>
                )}
              </div>
            );
          })}
          {visibles.length > limite && (
            <button type="button" className="btn ghost" onClick={() => setLimite((n) => n + PAGINA)}>
              Ver {nf(Math.min(PAGINA, visibles.length - limite))} más (faltan {nf(visibles.length - limite)})
            </button>
          )}
        </div>
      )}

      {abierta && (
        <DetalleCampana
          {...props}
          campana={abierta}
          onCerrar={() => {
            setAbiertaId(null);
            setAbiertaCopia(null);
          }}
        />
      )}
    </div>
  );
}
