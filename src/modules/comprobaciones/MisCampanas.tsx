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
// Supervisor y manager (Erik, 23-oct-2026: «lo mismo» que la analista):
// también la tienen, con un selector de analista. Ven la pantalla de cada
// una (o de todas) y pueden marcar por ella: la base deja al Supervisor
// marcar en su unidad (comp_sitios_ajenos).
//
// La lista ya la trae el esqueleto (vw_comp_campanas del periodo); el
// detalle relee la campaña y pide al esqueleto releer la lista en silencio
// (recargar) después de cada marca, sin desmontar nada.
//
// POR REVISAR (fase 3, incremento 2, 26-oct-2026; especificación §6.2): cada
// campaña con tomas que el monitorista ya envió lleva el chip «Por revisar
// (N)» de SOLO LECTURA (la revisión llega en el incremento 3) y hay un filtro
// rápido «Con tomas por revisar». Los números salen de comp_resumen_revision
// (security invoker: cuenta con la RLS de quien pregunta) y no de la vista,
// que no se tocó (M9). Sin la migración 2 no hay chip ni filtro, sin aviso.
// El aviso «Tomas por revisar» abre aquí con ese filtro (`pedido`).
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import Ic from '../../components/Ic';
import { esMedio24h, HORARIO_24H } from '../../lib/comprobaciones';
import { leerResumenRevision, type ResumenRevision, type VwCampana } from '../../lib/comprobacionesApi';
import { colorTono, fondoTono } from '../../lib/tonos';
import { vigilarRender } from '../../lib/vigia';
import { Barra, nf, PildoraLimite, sinPorComprobar, TEXTO_SIN_POR_COMPROBAR, textoAvance, textoEntrega } from './AvanceComun';
import DetalleCampana from './DetalleCampana';
import type { PropsPestanaComp } from './tiposComp';

type Filtro = 'pendientes' | 'completas' | 'todas' | 'por_revisar';

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

/** Lo que pide un aviso: abrir con «Con tomas por revisar» (`n` cambia en cada aviso). */
export type PedidoMisCampanas = { n: number; bandeja: 'por_revisar' } | null;

export default function MisCampanas(props: PropsPestanaComp & { pedido?: PedidoMisCampanas; onPedidoAplicado?: () => void }) {
  vigilarRender('MisCampanas');
  const { campanas, email, cargando, periodo, permisos, unidad, equipo, nombreDe, pedido, onPedidoAplicado, ...resto } = props;
  // El detalle recibe las mismas props de la pestaña (sin `pedido`).
  const propsDetalle: PropsPestanaComp = { campanas, email, cargando, periodo, permisos, unidad, equipo, nombreDe, ...resto };

  // ---- Por revisar (comp_resumen_revision) ----
  // Se relee al cambiar de periodo y cada vez que la lista se relee (la
  // misma `campanas` mientras no cambie). Un error deja el último resumen.
  const [resumen, setResumen] = useState<Map<number, ResumenRevision> | null>(null);
  useEffect(() => {
    let vivo = true;
    void leerResumenRevision(periodo.id).then((r) => {
      if (!vivo) return;
      if (r.ok) setResumen((prev) => (prev && JSON.stringify([...prev]) === JSON.stringify([...r.data]) ? prev : r.data));
      else if (r.codigo === 'falta_migracion') setResumen(null);
    });
    return () => {
      vivo = false;
    };
  }, [periodo.id, campanas]);
  const porRevisarDe = (c: VwCampana) => resumen?.get(c.id)?.por_revisar ?? 0;

  // De quién se ven las campañas: la analista, las suyas; quien gestiona,
  // las de la analista que elija o las de todas ('*').
  const TODAS = '*';
  const [deSel, setDe] = useState<string | null>(null);
  const de = deSel ?? (permisos.esAnalista ? email : TODAS);
  const analistas = useMemo(
    () =>
      equipo
        .filter((m) => m.asignable && m.email !== email)
        .map((m) => ({ email: m.email, nombre: m.nombre || nombreDe(m.email) })),
    [equipo, email, nombreDe]
  );
  const propias = de === email;
  const mias = useMemo(
    () =>
      campanas.filter((c) => {
        const a = (c.analista_email || '').toLowerCase();
        return de === TODAS ? a !== '' : a === de;
      }),
    [campanas, de]
  );

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
  // El aviso «Tomas por revisar» abre con ese filtro, UNA vez: al aplicarlo
  // se avisa al padre para que lo borre (al volver a montar ya no está).
  useEffect(() => {
    if (pedido?.bandeja !== 'por_revisar') return;
    setFiltro('por_revisar');
    onPedidoAplicado?.();
    // Solo cuando llega un pedido nuevo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pedido?.n, pedido?.bandeja]);
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
      .filter((c) =>
        filtro === 'pendientes'
          ? esPendiente(c)
          : filtro === 'completas'
            ? esCompleta(c)
            : filtro === 'por_revisar'
              ? porRevisarDe(c) > 0
              : true
      )
      .filter(
        (c) =>
          !q ||
          [c.campana, c.version, c.cliente, c.vendedor, c.administrador, c.quantum].some((x) => (x || '').toLowerCase().includes(q))
      )
      .sort(ordenar);
    // porRevisarDe lee `resumen`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mias, filtro, busca, resumen]);

  const conteo: Record<Filtro, number> = {
    pendientes: mias.filter(esPendiente).length,
    completas: mias.filter(esCompleta).length,
    todas: mias.length,
    por_revisar: mias.filter((c) => porRevisarDe(c) > 0).length,
  };
  /** Tomas por revisar en las campañas que se ven (para el chip del filtro). */
  const tomasPorRevisar = mias.reduce((s, c) => s + porRevisarDe(c), 0);

  const abierta = abiertaId == null ? null : mias.find((c) => c.id === abiertaId) ?? campanas.find((c) => c.id === abiertaId) ?? abiertaCopia;

  if (!permisos.esAnalista && !permisos.gestiona)
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
      {permisos.gestiona && (
        <div className="toolbar filtros-pildora">
          <select
            aria-label="De qué analista"
            value={de}
            onChange={(e) => {
              setDe(e.target.value);
              setAbiertaId(null);
              setAbiertaCopia(null);
              setLimite(PAGINA);
            }}
          >
            {permisos.esAnalista && <option value={email}>Las mías</option>}
            <option value={TODAS}>Todas las analistas</option>
            {analistas.map((a) => (
              <option key={a.email} value={a.email}>
                {a.nombre}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="cards">
        {[
          { l: propias ? 'Mis campañas' : 'Campañas', n: t.vivas, sub: `${nf(t.pendientesCamp)} por terminar` },
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
        {/* Filtro rápido (fase 3): solo si hay algo por revisar o ya está elegido. */}
        {resumen && (conteo.por_revisar > 0 || filtro === 'por_revisar') && (
          <button
            type="button"
            className={'rt-chip' + (filtro === 'por_revisar' ? ' on' : '')}
            aria-pressed={filtro === 'por_revisar'}
            onClick={() => {
              setFiltro(filtro === 'por_revisar' ? 'pendientes' : 'por_revisar');
              setLimite(PAGINA);
            }}
            style={{ color: filtro === 'por_revisar' ? undefined : colorTono('ambar') }}
          >
            Con tomas por revisar ({nf(conteo.por_revisar)}
            {tomasPorRevisar > conteo.por_revisar ? ` · ${nf(tomasPorRevisar)} tomas` : ''})
          </button>
        )}
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
          {propias
            ? `No tienes campañas asignadas en ${periodo.etiqueta}. Cuando el Supervisor te asigne, aparecen aquí.`
            : de === TODAS
              ? `Todavía no hay campañas con analista en ${periodo.etiqueta}. Asígnalas en Campañas.`
              : `${nombreDe(de)} no tiene campañas en ${periodo.etiqueta}.`}
        </div>
      ) : visibles.length === 0 ? (
        <div className="empty">
          {busca
            ? 'Ninguna campaña coincide con la búsqueda.'
            : filtro === 'pendientes'
              ? propias
                ? '¡No tienes campañas pendientes en este periodo!'
                : 'No hay campañas pendientes aquí.'
              : filtro === 'por_revisar'
                ? 'No hay tomas por revisar en estas campañas.'
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
                {de === TODAS && (
                  <div style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere', marginBottom: 4 }}>
                    Analista: {nombreDe(c.analista_email)}
                  </div>
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
                  {/* Al abrir la campaña, «Fotos» lleva a la revisión (incremento 3). */}
                  {porRevisarDe(c) > 0 && (
                    <span
                      className="tag"
                      style={{ color: colorTono('ambar'), background: fondoTono('ambar'), fontWeight: 700 }}
                      title="Tomas que el monitorista ya envió y esperan revisión"
                    >
                      Por revisar ({nf(porRevisarDe(c))})
                    </span>
                  )}
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
          {...propsDetalle}
          campana={abierta}
          // Con tomas por revisar se abre en «Fotos» (incremento 3, 29-oct-2026).
          abrirEn={porRevisarDe(abierta) > 0 ? 'fotos' : undefined}
          onCerrar={() => {
            setAbiertaId(null);
            setAbiertaCopia(null);
          }}
        />
      )}
    </div>
  );
}
