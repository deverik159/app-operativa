// ============================================================
// src/modules/comprobaciones/CampanasSupervisor.tsx
// Supervisor · Campañas (= la «Asignación de clientes» del Excel de hoy),
// rediseño de Erik del 23-oct-2026. Una fila por campaña-versión del
// periodo con su analista, meta, avance, fecha límite, plan y cierre.
//
// Qué hay y por qué:
//   · Tarjetas que FILTRAN (como en Pauta): campañas, meta y % comprobado,
//     sin analista, por vencer (≤ 2 días), vencidas, cerradas y retiradas.
//     Las cifras salen de la lista sin el filtro de tarjeta, para que no se
//     pongan en cero al tocar una. Las retiradas no cuentan en las demás
//     (ya no van) y solo se ven con su tarjeta.
//   · Carga por analista (cargaPorAnalista): el renglón de totales del
//     Excel que hoy no deja ver la carga dispareja. La CARGA es de quien
//     lleva la campaña; el CRÉDITO (hoy, comprobados) de quien marcó
//     (vw_comp_diaria). Tocar un chip filtra por esa analista.
//   · En PC una tabla con encabezado fijo, orden por columna, casilla y el
//     selector de analista en la celda; en el teléfono tarjetas. Se pinta
//     UNA de las dos (nunca las dos escondiendo una con CSS: 270 filas
//     dobles en un iPhone).
//   · Selección múltiple con barra fija abajo y acciones en lote
//     (AccionesLoteModal), «Pasar lo pendiente» (ReasignarPendienteModal)
//     y el plan de tomas en lote (PlanTomasModal).
//   · «Sitios» abre el detalle de la campaña (DetalleCampana) a pantalla
//     completa: marcar, cancelar o regresar sitios y agregar columnas FULL
//     (integración, 23-oct-2026).
//   · El modo de solo lectura (permisos.soloLectura) era del coordinador;
//     desde el 23-oct-2026 el coordinador ya no entra y nadie llega así.
// Toda escritura va por las RPC (comprobacionesApi) con el candado del
// esqueleto (correr) y se cuenta con lo que DEVUELVE la base: la RLS niega
// en silencio. Después se relee en silencio (recargar) sin desmontar.
// ============================================================
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  cargaPorAnalista,
  CLAVE_SIN_REGISTRO,
  ETIQUETA_SIN_REGISTRO,
  compararNatural,
  describirPlan,
  hoyCdmx,
  type CampanaFila,
  type Credito,
} from '../../lib/comprobaciones';
import { armazonActivo } from '../../lib/armazon';
import { subirYRegresar } from '../../lib/subirAntes';
import { asignarAnalista, leerDiaria, textoFallaComp, textoFallaEscrituraComp, type VwCampana } from '../../lib/comprobacionesApi';
import { colorTono, fondoTono } from '../../lib/tonos';
import type { PropsPestanaComp } from './tiposComp';
import AccionesLoteModal, { type AccionLote } from './AccionesLoteModal';
import ReasignarPendienteModal from './ReasignarPendienteModal';
import PlanTomasModal from './PlanTomasModal';
import DetalleCampana from './DetalleCampana';
import { sinPorComprobar } from './AvanceComun';
import {
  Barra,
  Casilla,
  PillEstatus,
  PillLimite,
  celda,
  fmtDia,
  fmtN,
  opcionesAnalista,
  sinQuiebre,
  textoLegible,
  tituloCampana,
} from './CampanasPiezas';

/** Filtro de tarjeta. null = ninguno (todas menos las retiradas). */
type FiltroTarjeta = 'sin_analista' | 'por_vencer' | 'vencidas' | 'completas' | 'para_cerrar' | 'cerradas' | 'retiradas' | null;

/** Filtro de analista: todos, sin analista o un correo. */
const TODOS = '__todos__';
const SIN = '__sin__';

/** Filas por tanda («Ver N más»): 100 en el teléfono, 300 en PC. */
const TANDA_TEL = 100;
const TANDA_PC = 300;

type ColK = 'campana' | 'version' | 'arte' | 'vendedor' | 'analista' | 'meta' | 'comprobados' | 'pct' | 'limite' | 'plan' | 'estatus' | 'cierre';

const abierta = (c: VwCampana) => c.estatus === 'abierta';
const viva = (c: VwCampana) => !c.retirada;
const dias = (c: VwCampana) => c.dias_restantes;
// Sin nada que marcar no vence (revisión de pantallas, 23-oct-2026): va en «Para cerrar».
const esPorVencer = (c: VwCampana) => abierta(c) && !c.completa && !sinPorComprobar(c) && dias(c) != null && (dias(c) as number) >= 0 && (dias(c) as number) <= 2;
const esVencida = (c: VwCampana) => abierta(c) && !c.completa && !sinPorComprobar(c) && dias(c) != null && (dias(c) as number) < 0;

function pasaTarjeta(c: VwCampana, f: FiltroTarjeta): boolean {
  if (f === 'retiradas') return !!c.retirada;
  if (c.retirada) return false;
  switch (f) {
    case 'sin_analista':
      return abierta(c) && !c.analista_email;
    case 'por_vencer':
      return esPorVencer(c);
    case 'vencidas':
      return esVencida(c);
    case 'completas':
      return !!c.completa;
    case 'para_cerrar':
      return sinPorComprobar(c);
    case 'cerradas':
      return c.estatus === 'cerrada';
    default:
      return true;
  }
}

export default function CampanasSupervisor(props: PropsPestanaComp) {
  const { periodo, campanas, cargando, recargando, permisos, equipo, nombreDe, unidad, telefono, correr, ocupado, avisar, recargar } =
    props;
  const gestiona = permisos.gestiona;
  const trabajando = !!ocupado;

  // ---- Filtros ----------------------------------------------------------
  const [busca, setBusca] = useState('');
  const [fAnalista, setFAnalista] = useState<string>(TODOS);
  const [fTarjeta, setFTarjeta] = useState<FiltroTarjeta>(null);
  const [orden, setOrden] = useState<{ k: ColK; asc: boolean } | null>(null);
  const [limite, setLimite] = useState(telefono ? TANDA_TEL : TANDA_PC);
  const [sel, setSel] = useState<Set<number>>(() => new Set());
  const [modal, setModal] = useState<null | { t: 'acciones'; inicial?: AccionLote } | { t: 'pasar'; de?: string | null } | { t: 'plan' }>(null);
  const [err, setErr] = useState('');
  // Detalle abierto: el id manda (así se refresca con la lista) y la copia
  // lo sostiene si la campaña sale de la lista mientras está abierto.
  const [detalle, setDetalle] = useState<VwCampana | null>(null);

  // La selección y los filtros de persona son del periodo y la unidad: al
  // cambiar se limpian (el orden se queda, es preferencia de la vista).
  useEffect(() => {
    setSel(new Set());
    setFAnalista(TODOS);
    setFTarjeta(null);
    setLimite(telefono ? TANDA_TEL : TANDA_PC);
    setErr('');
    setModal(null);
    setDetalle(null);
    // Los créditos son del periodo y la unidad: si la lectura nueva falla, no
    // se cruzan los de antes con las campañas nuevas (23-oct-2026).
    setCreditos([]);
    setErrCred('');
    // telefono a propósito fuera: girar el teléfono no debe borrar lo elegido.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodo.id, unidad]);

  // Si una campaña se borró (retirar sin trabajo) o ya no está, sale de la selección.
  useEffect(() => {
    setSel((s) => {
      if (!s.size) return s;
      const ids = new Set(campanas.map((c) => c.id));
      let cambio = false;
      const n = new Set<number>();
      for (const id of s) {
        if (ids.has(id)) n.add(id);
        else cambio = true;
      }
      return cambio ? n : s;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campanas.length ? campanas : 0]);

  // ---- Crédito por persona (vw_comp_diaria) -----------------------------
  const listaCampanas = campanas.length ? campanas : 0;
  const [creditos, setCreditos] = useState<Credito[]>([]);
  const [errCred, setErrCred] = useState('');
  useEffect(() => {
    let vivo = true;
    leerDiaria({ periodoId: periodo.id, unidad }).then((r) => {
      if (!vivo) return;
      if (!r.ok) {
        setErrCred('No se pudo leer lo comprobado por persona: ' + textoFallaComp(r));
        return;
      }
      setErrCred('');
      setCreditos(r.data.map((d) => ({ comprobado_por: d.comprobado_por, dia: d.dia, sitios: d.sitios })));
    });
    return () => {
      vivo = false;
    };
    // Se relee con cada lista nueva de campañas (después de marcar o
    // reasignar). Mientras carga, el esqueleto manda un [] nuevo en cada
    // render: con 0 como llave no se repite la lectura por eso.
  }, [periodo.id, unidad, listaCampanas]);

  const hoy = hoyCdmx();
  const carga = useMemo(() => cargaPorAnalista(campanas as CampanaFila[], creditos, hoy), [campanas, creditos, hoy]);

  // ---- Lista filtrada -----------------------------------------------------
  const nombreAnalista = (e: string | null) => (e ? nombreDe(e) : '');
  const base = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return campanas.filter((c) => {
      if (fAnalista === SIN ? !!c.analista_email : fAnalista !== TODOS && c.analista_email !== fAnalista) return false;
      if (!q) return true;
      return [c.campana, c.version, c.cliente, c.vendedor, c.administrador, c.quantum, nombreAnalista(c.analista_email), c.analista_email]
        .some((x) => (x || '').toLowerCase().includes(q));
    });
    // nombreDe cambia con el equipo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campanas, busca, fAnalista, nombreDe]);

  const stats = useMemo(() => {
    const vivas = base.filter(viva);
    const meta = vivas.reduce((a, c) => a + (c.meta || 0), 0);
    const comp = vivas.reduce((a, c) => a + (c.comprobados || 0), 0);
    return {
      campanas: vivas.length,
      meta,
      comp,
      pct: meta > 0 ? Math.round((1000 * comp) / meta) / 10 : null,
      completas: vivas.filter((c) => !!c.completa).length,
      paraCerrar: vivas.filter(sinPorComprobar).length,
      sinAnalista: vivas.filter((c) => abierta(c) && !c.analista_email).length,
      porVencer: vivas.filter(esPorVencer).length,
      vencidas: vivas.filter(esVencida).length,
      cerradas: vivas.filter((c) => c.estatus === 'cerrada').length,
      retiradas: base.length - vivas.length,
    };
  }, [base]);

  const filtradas = useMemo(() => {
    const l = base.filter((c) => pasaTarjeta(c, fTarjeta));
    const valor = (c: VwCampana, k: ColK): string | number | null => {
      switch (k) {
        case 'campana':
          return c.campana || null;
        case 'version':
          return c.version || null;
        case 'arte':
          return c.arte;
        case 'vendedor':
          return c.vendedor || c.administrador || null;
        case 'analista':
          return c.analista_email ? nombreDe(c.analista_email) : null;
        case 'meta':
          return c.meta;
        case 'comprobados':
          return c.comprobados;
        case 'pct':
          return c.pct;
        case 'limite':
          return c.fecha_limite_efectiva;
        case 'plan':
          return c.plan_tomas ? describirPlan(c.plan_tomas) : null;
        case 'estatus':
          return c.retirada ? 3 : c.estatus === 'cerrada' ? 2 : c.completa ? 1 : 0;
        case 'cierre':
          return c.cerrada_en;
      }
    };
    const cmp = (a: VwCampana, b: VwCampana): number => {
      if (!orden) return compararNatural(a.campana, b.campana) || compararNatural(a.version, b.version) || a.id - b.id;
      const x = valor(a, orden.k);
      const y = valor(b, orden.k);
      // Los vacíos siempre al final, suba o baje el orden.
      if (x == null && y == null) return a.id - b.id;
      if (x == null) return 1;
      if (y == null) return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : compararNatural(String(x), String(y));
      return (orden.asc ? r : -r) || a.id - b.id;
    };
    return l.sort(cmp);
  }, [base, fTarjeta, orden, nombreDe]);

  const visibles = filtradas.slice(0, limite);
  const elegidas = useMemo(() => campanas.filter((c) => sel.has(c.id)), [campanas, sel]);
  /** El plan en lote ya se aplicó: la selección se limpia al cerrar su ventana. */
  const planAplicado = useRef(false);
  // Elegidas que el filtro de ahora esconde: se avisa en la barra y en
  // Acciones para que el lote no se lleve campañas que no se ven.
  const elegidasOcultas = useMemo(() => {
    if (!elegidas.length) return 0;
    const vis = new Set(filtradas.map((c) => c.id));
    return elegidas.filter((c) => !vis.has(c.id)).length;
  }, [elegidas, filtradas]);
  const todasFiltradasElegidas = filtradas.length > 0 && filtradas.every((c) => sel.has(c.id));
  const algunaFiltradaElegida = filtradas.some((c) => sel.has(c.id));

  // «Aplicar sugeridos»: abiertas sin analista cuyo sugerido (REPITE) sí es analista de la unidad.
  const asignables = useMemo(() => new Set(equipo.filter((m) => m.asignable).map((m) => m.email)), [equipo]);
  const sugeridas = useMemo(
    () =>
      campanas.filter(
        (c) => viva(c) && abierta(c) && !c.analista_email && !!c.sugerido_email && asignables.has(c.sugerido_email.toLowerCase())
      ),
    [campanas, asignables]
  );

  // ---- Acciones ---------------------------------------------------------
  const toggle = (id: number) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleTodas = () =>
    setSel((s) => {
      const n = new Set(s);
      if (todasFiltradasElegidas) for (const c of filtradas) n.delete(c.id);
      else for (const c of filtradas) n.add(c.id);
      return n;
    });

  /** Asignar UNA campaña desde su selector (celda o tarjeta). */
  async function asignarUna(c: VwCampana, email: string) {
    const a = email || null;
    if ((c.analista_email || null) === a) return;
    setErr('');
    const r = await correr(a ? 'Asignando…' : 'Quitando analista…', () => asignarAnalista([c.id], a));
    if (!r) {
      setErr('Hay otra acción guardando. Espera a que termine.');
      return;
    }
    if (!r.ok) {
      setErr(`${tituloCampana(c)}: ${textoFallaEscrituraComp(r)}`);
      if (r.sinRed) recargar();
      return;
    }
    if (r.data.cerradas_omitidas) setErr(`${tituloCampana(c)} está cerrada: reábrela para cambiar la analista.`);
    else if (r.data.asignadas) avisar(a ? `✓ ${tituloCampana(c)} → ${nombreDe(a)}` : `✓ ${tituloCampana(c)} quedó sin analista`);
    recargar();
  }

  /** Asigna en un lote por persona las sugeridas (la última analista de la campaña REPITE). */
  async function aplicarSugeridos() {
    const grupos = new Map<string, number[]>();
    for (const c of sugeridas) {
      const e = (c.sugerido_email as string).toLowerCase();
      const l = grupos.get(e);
      if (l) l.push(c.id);
      else grupos.set(e, [c.id]);
    }
    const resumen = [...grupos.entries()].map(([e, ids]) => `${nombreDe(e)}: ${ids.length}`).join(', ');
    if (!window.confirm(`¿Asignar ${sugeridas.length} campañas a la analista sugerida?\n${resumen}`)) return;
    setErr('');
    let total = 0;
    const r = await correr('Asignando sugeridas…', async () => {
      for (const [e, ids] of grupos) {
        const x = await asignarAnalista(ids, e);
        if (!x.ok) return x;
        total += x.data.asignadas;
      }
      return null;
    });
    if (r === undefined) {
      setErr('Hay otra acción guardando. Espera a que termine.');
      return;
    }
    recargar();
    if (r && !r.ok) {
      setErr(textoFallaEscrituraComp(r) + (total ? ` Ya quedaron ${fmtN(total)} asignadas.` : ''));
      return;
    }
    avisar(`✓ ${fmtN(total)} asignadas a su analista sugerida`);
  }

  const detalleVivo = detalle ? campanas.find((c) => c.id === detalle.id) ?? detalle : null;
  const botonSitios = (c: VwCampana, ancho: boolean) => (
    <button
      type="button"
      className="btn ghost sm"
      onClick={(e) => {
        e.stopPropagation();
        setDetalle(c);
      }}
      style={{ fontSize: 12, width: ancho ? '100%' : undefined, minHeight: ancho ? 44 : undefined }}
      title="Ver sus sitios y marcar lo comprobado"
    >
      Sitios ({fmtN(c.sitios_total)})
    </button>
  );

  // Después de una acción en lote que sale bien, la selección se limpia
  // (revisión de pantallas, 23-oct-2026): seguía viva y el lote siguiente
  // se llevaba también las de antes, aunque ya no se vieran con el filtro.
  const hecho = (texto: string) => {
    setModal(null);
    setSel(new Set());
    avisar(texto);
    recargar();
  };

  // ---- Tarjetas ---------------------------------------------------------
  const tarjetas: { k: FiltroTarjeta; l: string; n: string; c?: string; sub?: string }[] = [
    { k: null, l: 'Campañas', n: fmtN(stats.campanas) },
    // La tarjeta filtra las COMPLETAS: el número es ese y el % va abajo
    // (antes decía «Comprobadas 62 %» y al tocarla salían 5; 23-oct-2026).
    {
      k: 'completas',
      l: 'Completas',
      n: fmtN(stats.completas),
      c: colorTono('verde'),
      sub: `${stats.pct == null ? '—' : `${stats.pct} %`} comprobado · ${fmtN(stats.comp)} de ${fmtN(stats.meta)}`,
    },
    { k: 'sin_analista', l: 'Sin analista', n: fmtN(stats.sinAnalista), c: stats.sinAnalista ? 'var(--warn)' : undefined },
    { k: 'por_vencer', l: 'Por vencer', n: fmtN(stats.porVencer), c: stats.porVencer ? colorTono('ambar') : undefined },
    { k: 'vencidas', l: 'Vencidas', n: fmtN(stats.vencidas), c: stats.vencidas ? colorTono('rojo') : undefined },
    // Abiertas sin nada que marcar (todo cancelado o meta mayor que los
    // sitios): solo falta cerrarlas. Sale solo si hay alguna.
    ...(stats.paraCerrar > 0 || fTarjeta === 'para_cerrar'
      ? [{ k: 'para_cerrar' as const, l: 'Para cerrar', n: fmtN(stats.paraCerrar), c: colorTono('ambar'), sub: 'sin sitios por comprobar' }]
      : []),
    { k: 'cerradas', l: 'Cerradas', n: fmtN(stats.cerradas), c: colorTono('verde') },
    { k: 'retiradas', l: 'Retiradas', n: fmtN(stats.retiradas), c: 'var(--muted)' },
  ];

  const opcionesFiltro = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of equipo) if (e.asignable) m.set(e.email, e.nombre || e.email);
    for (const c of campanas) if (c.analista_email) m.set(c.analista_email, nombreDe(c.analista_email));
    return [...m.entries()].sort((a, b) => compararNatural(a[1], b[1]));
  }, [equipo, campanas, nombreDe]);

  // ---- Piezas de fila ------------------------------------------------------
  const selectorAnalista = (c: VwCampana, ancho: boolean) => {
    if (!gestiona) {
      return <span style={c.analista_email ? undefined : { color: 'var(--warn)', fontWeight: 700 }}>{c.analista_email ? nombreDe(c.analista_email) : 'Sin analista'}</span>;
    }
    const ops = opcionesAnalista(equipo, c.analista_email, nombreDe);
    const cerrada = c.estatus === 'cerrada';
    const sug = !c.analista_email && c.sugerido_email && asignables.has(c.sugerido_email.toLowerCase()) ? c.sugerido_email.toLowerCase() : null;
    return (
      <div style={{ display: 'grid', gap: 4 }} onClick={(e) => e.stopPropagation()}>
        <select
          aria-label={`Analista de ${tituloCampana(c)}`}
          value={c.analista_email ?? ''}
          disabled={trabajando || cerrada}
          title={cerrada ? 'Cerrada: reábrela para cambiar la analista' : undefined}
          onChange={(e) => asignarUna(c, e.target.value)}
          style={{
            width: ancho ? '100%' : 'auto',
            minWidth: ancho ? undefined : 150,
            padding: ancho ? undefined : '6px 8px',
            fontSize: ancho ? undefined : 12,
            borderColor: c.analista_email ? undefined : 'var(--warn)',
          }}
        >
          <option value="">{c.analista_email ? '— Quitar analista —' : '＋ Asignar a…'}</option>
          {ops.map((o) => (
            <option key={o.email} value={o.email}>
              {o.nombre}
            </option>
          ))}
        </select>
        {sug && (
          <button
            type="button"
            className="btn ghost sm"
            disabled={trabajando}
            onClick={() => asignarUna(c, sug)}
            style={{ justifySelf: 'start', fontSize: 12 }}
            title="La que llevó esta campaña el periodo anterior"
          >
            Sugerida: {nombreDe(sug)} ✓
          </button>
        )}
      </div>
    );
  };

  const etiquetas = (c: VwCampana) => (
    <>
      {c.arte && <span className="tag">{c.arte}</span>}
      {c.es_full && (
        <span className="tag" style={{ color: colorTono('morado') }}>
          FULL{c.full_minutos ? ` ${c.full_minutos} min` : ''}
        </span>
      )}
      {c.entrega_tipo === 'lista_sin_enviar' && <span className="tag">Tener lista, no enviar</span>}
      {c.entrega_tipo === 'no_se_comprueba' && <span className="tag">No se comprueba</span>}
      {(c.banderas || []).map((b) => (
        <span key={b} className="tag">
          {b}
        </span>
      ))}
      {c.sin_inventario > 0 && (
        <span className="tag" style={{ color: colorTono('rojo') }} title="Claves que no están en el inventario">
          {fmtN(c.sin_inventario)} sin inventario
        </span>
      )}
    </>
  );

  const textoCierre = (c: VwCampana) =>
    c.estatus === 'cerrada'
      ? `${fmtDia(c.cerrada_en)}${c.cerrada_por ? ' · ' + nombreDe(c.cerrada_por) : ''}`
      : c.retirada
        ? `retirada ${fmtDia(c.retirada_en)}`
        : '';

  // ---- Barra fija de selección ------------------------------------------
  // Teléfono sin armazón: el menú inferior es fijo (z 900, ~88 px), así que la
  // barra va encima; con el armazón el menú no tapa .main y va a ras.
  const abajo = telefono && !armazonActivo() ? 'calc(88px + env(safe-area-inset-bottom, 0px))' : '0px';

  // ---- Encabezado de la tabla ---------------------------------------------
  const COLS: { k: ColK; t: string; num?: boolean }[] = [
    { k: 'campana', t: 'Campaña' },
    { k: 'version', t: 'Versión' },
    { k: 'arte', t: 'Arte' },
    { k: 'vendedor', t: 'Vendedor / Admin.' },
    { k: 'analista', t: 'Analista' },
    { k: 'meta', t: 'Meta', num: true },
    { k: 'comprobados', t: 'Comprob.', num: true },
    { k: 'pct', t: '%' },
    { k: 'limite', t: 'Fecha límite' },
    { k: 'plan', t: 'Plan de tomas' },
    { k: 'estatus', t: 'Estatus' },
    { k: 'cierre', t: 'Cierre' },
  ];
  const clickOrden = (k: ColK) =>
    setOrden((o) => (o?.k === k ? (o.asc ? { k, asc: false } : null) : { k, asc: k !== 'meta' && k !== 'comprobados' && k !== 'pct' ? true : false }));

  const th: CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    background: 'var(--panel2)',
    textAlign: 'left',
    padding: '9px 10px',
    borderBottom: '1px solid var(--line)',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '.04em',
    color: 'var(--muted)',
    whiteSpace: 'nowrap',
  };

  // ---- Render -------------------------------------------------------------
  if (cargando && !campanas.length) {
    return (
      <div className="phint">
        <span className="spinner" />
        Leyendo campañas…
      </div>
    );
  }
  if (!campanas.length) {
    return (
      <div className="empty">
        {periodo.etiqueta} no tiene campañas todavía.{gestiona ? ' Cárgalas en la pestaña Armar.' : ''}
      </div>
    );
  }

  return (
    <div>
      {permisos.soloLectura && <div className="banner">Solo lectura: lo que reparte y cierra el Supervisor.</div>}

      {/* Tarjetas que filtran. */}
      <div className={'cards' + (recargando ? ' recargando' : '')}>
        {tarjetas.map((t) => {
          const activa = t.k !== null && fTarjeta === t.k;
          return (
            <button
              type="button"
              key={t.l}
              className="card"
              aria-pressed={activa}
              onClick={() => {
                if (t.k === null && fTarjeta === null) return;
                subirYRegresar(() => setFTarjeta(t.k === null || activa ? null : t.k));
              }}
              style={{
                cursor: 'pointer',
                textAlign: 'left',
                font: 'inherit',
                width: '100%',
                color: 'var(--txt)',
                borderColor: activa ? 'var(--accent)' : 'var(--line)',
                background: activa ? 'var(--activo-fondo)' : 'var(--panel)',
              }}
            >
              <div className="n" style={{ color: t.c }}>
                {t.n}
              </div>
              <div className="l">
                {t.l}
                {activa ? ' ✕' : ''}
              </div>
              {t.sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{t.sub}</div>}
            </button>
          );
        })}
      </div>

      {/* Carga por analista: toca para filtrar. */}
      {carga.length > 0 && (
        <div className={recargando ? 'recargando' : undefined} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
            Carga por analista — toca para filtrar
            {errCred ? '' : ` · hoy = lo que marcó cada quien el ${fmtDia(hoy)}`}
          </div>
          <div className="chips" style={{ marginTop: 0 }}>
            {carga.map((k) => {
              const clave = k.email === null ? SIN : k.email;
              const sinRegistro = k.email === CLAVE_SIN_REGISTRO;
              const on = !sinRegistro && fAnalista === clave;
              const nombre = k.email === null ? 'Sin analista' : sinRegistro ? ETIQUETA_SIN_REGISTRO : nombreDe(k.email);
              const partes =
                k.campanas > 0
                  ? [`${fmtN(k.abiertas)} abiertas`, `${fmtN(k.pendientes)} pend.`, k.pct == null ? null : `${k.pct} %`]
                  : [];
              if (k.email !== null && (k.comprobados || k.hoy)) partes.push(`hoy ${fmtN(k.hoy)}`);
              return (
                <button
                  type="button"
                  key={clave || 'sin-registro'}
                  className="pill"
                  disabled={sinRegistro}
                  aria-pressed={on}
                  onClick={() => subirYRegresar(() => setFAnalista(on ? TODOS : clave))}
                  style={{
                    cursor: sinRegistro ? 'default' : 'pointer',
                    border: 'none',
                    font: 'inherit',
                    fontSize: 12,
                    fontWeight: 700,
                    padding: '8px 12px',
                    minHeight: 36,
                    background: on ? 'var(--accent)' : k.email === null ? fondoTono('ambar') : 'var(--tag-fondo)',
                    color: on ? 'var(--sobre-acento)' : k.email === null ? colorTono('ambar') : 'var(--muted)',
                    whiteSpace: 'normal',
                    textAlign: 'left',
                    overflowWrap: 'anywhere',
                    maxWidth: '100%',
                  }}
                >
                  {nombre}
                  {partes.filter(Boolean).length ? ' · ' + partes.filter(Boolean).join(' · ') : ''}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {errCred && <div className="err">{errCred}</div>}

      {/* Filtros y botones de la unidad. */}
      {/* El buscador en su propia fila (como Pauta): dentro de la tira de
          píldoras del teléfono se encogía a 24 px (integración, 23-oct-2026). */}
      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Buscar campaña, versión, cliente, vendedor…"
          aria-label="Buscar campaña"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
      </div>
      <div className="toolbar filtros-pildora">
        <select
          aria-label="Analista"
          className={fAnalista !== TODOS ? 'on' : undefined}
          value={fAnalista}
          onChange={(e) => {
            const v = e.target.value;
            subirYRegresar(() => setFAnalista(v));
          }}
        >
          <option value={TODOS}>Todas las analistas</option>
          <option value={SIN}>Sin analista</option>
          {opcionesFiltro.map(([e, n]) => (
            <option key={e} value={e}>
              {n}
            </option>
          ))}
        </select>
        {gestiona && (
          <button type="button" className="btn ghost sm" disabled={trabajando} onClick={() => setModal({ t: 'pasar', de: fAnalista !== TODOS && fAnalista !== SIN ? fAnalista : null })}>
            Pasar pendiente…
          </button>
        )}
        {gestiona && sugeridas.length > 0 && (
          <button type="button" className="btn ghost sm" disabled={trabajando} onClick={aplicarSugeridos}>
            Aplicar sugeridas ({fmtN(sugeridas.length)})
          </button>
        )}
        {gestiona && telefono && filtradas.length > 0 && (
          <button type="button" className="btn ghost sm" disabled={trabajando} onClick={toggleTodas}>
            {todasFiltradasElegidas ? 'Quitar selección' : `Elegir las ${fmtN(filtradas.length)}`}
          </button>
        )}
      </div>

      {err && (
        <div className="err" role="alert" onClick={() => setErr('')}>
          {err}
        </div>
      )}

      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
        {fmtN(filtradas.length)} campaña{filtradas.length === 1 ? '' : 's'}
        {fTarjeta || fAnalista !== TODOS || busca ? ' con este filtro' : ''}
        {stats.retiradas > 0 && fTarjeta !== 'retiradas' ? ` · ${fmtN(stats.retiradas)} retiradas aparte` : ''}
      </div>

      {filtradas.length === 0 ? (
        <div className="empty">Ninguna campaña con este filtro.</div>
      ) : telefono ? (
        // ---- Teléfono: tarjetas ----
        <div className={'inc-list' + (recargando ? ' recargando' : '')}>
          {visibles.map((c) => {
            const elegida = sel.has(c.id);
            return (
              <div
                key={c.id}
                className="inc"
                style={{
                  borderColor: elegida ? 'var(--accent)' : undefined,
                  background: elegida ? 'var(--activo-fondo)' : undefined,
                  opacity: c.retirada ? 0.75 : undefined,
                }}
              >
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  {gestiona && (
                    <div style={{ paddingTop: 8, paddingLeft: 6 }}>
                      <Casilla checked={elegida} onChange={() => toggle(c.id)} etiqueta={`Elegir ${tituloCampana(c)}`} disabled={trabajando} />
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="folio">
                      {c.cliente || c.vendedor || c.medio}
                      {c.medio && unidad === 'Vía Verde' ? ` · ${c.medio}` : ''}
                    </div>
                    <div className="titulo" style={{ overflowWrap: 'anywhere' }}>
                      {tituloCampana(c)}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0 8px' }}>
                      <PillEstatus c={c} />
                      {!c.retirada && <PillLimite c={c} />}
                      {etiquetas(c)}
                    </div>
                    <div className="meta">
                      Meta {fmtN(c.meta)} · {fmtN(c.comprobados)} comprobados
                      {c.pendientes ? ` · faltan ${fmtN(c.pendientes)}` : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}>
                      <div style={{ flex: 1 }}>
                        <Barra pct={c.pct} />
                      </div>
                      <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{c.pct == null ? 'sin meta' : `${c.pct} %`}</span>
                    </div>
                    <div className="meta">
                      Plan: {c.plan_tomas ? describirPlan(c.plan_tomas) : 'sin plan'}
                      {c.tomas_total ? ` · ${fmtN(c.tomas_total)} tomas` : ''}
                    </div>
                    {textoCierre(c) && (
                      <div className="meta">
                        {c.estatus === 'cerrada' ? 'Cerrada ' : ''}
                        {textoCierre(c)}
                        {c.cierre_motivo ? ` · «${c.cierre_motivo}»` : ''}
                      </div>
                    )}
                    {c.especificacion && <div className="obs">{c.especificacion}</div>}
                    <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                      {selectorAnalista(c, true)}
                      {botonSitios(c, true)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        // ---- PC: tabla con encabezado fijo ----
        <div
          className={recargando ? 'recargando' : undefined}
          style={{ overflowX: 'auto', maxHeight: '75vh', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--panel)' }}
        >
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1500, fontSize: 12 }}>
            <thead>
              <tr>
                {gestiona && (
                  <th style={{ ...th, width: 44, textAlign: 'center' }}>
                    <Casilla
                      checked={todasFiltradasElegidas}
                      indeterminada={algunaFiltradaElegida}
                      onChange={toggleTodas}
                      etiqueta={todasFiltradasElegidas ? 'Quitar la selección' : `Elegir las ${filtradas.length} filtradas`}
                      disabled={trabajando}
                    />
                  </th>
                )}
                {COLS.map((col) => {
                  const activa = orden?.k === col.k;
                  return (
                    <th
                      key={col.k}
                      style={{ ...th, color: activa ? 'var(--txt)' : 'var(--muted)', userSelect: 'none', textAlign: col.num ? 'right' : 'left' }}
                      aria-sort={activa ? (orden!.asc ? 'ascending' : 'descending') : 'none'}
                    >
                      {/* Un botón dentro del th: así se ordena también con el
                          teclado (revisión de pantallas, 23-oct-2026). */}
                      <button
                        type="button"
                        onClick={() => clickOrden(col.k)}
                        title={`Ordenar por ${col.t}`}
                        style={{
                          font: 'inherit',
                          color: 'inherit',
                          textTransform: 'inherit',
                          letterSpacing: 'inherit',
                          textAlign: 'inherit',
                          whiteSpace: 'nowrap',
                          cursor: 'pointer',
                          padding: 0,
                          margin: 0,
                          border: 'none',
                          background: 'none',
                          width: '100%',
                        }}
                      >
                        {col.t}
                        {activa ? <span> {orden!.asc ? '▲' : '▼'}</span> : <span style={{ opacity: 0.35 }}> ⇅</span>}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibles.map((c) => {
                const elegida = sel.has(c.id);
                return (
                  <tr
                    key={c.id}
                    // Supervisor: tocar la fila la elige. Coordinador: abre el detalle.
                    onClick={gestiona ? (!trabajando ? () => toggle(c.id) : undefined) : () => setDetalle(c)}
                    style={{
                      cursor: 'pointer',
                      background: elegida ? 'var(--activo-fondo)' : undefined,
                      opacity: c.retirada ? 0.7 : undefined,
                    }}
                  >
                    {gestiona && (
                      <td style={{ ...celda, textAlign: 'center' }}>
                        <Casilla checked={elegida} onChange={() => toggle(c.id)} etiqueta={`Elegir ${tituloCampana(c)}`} disabled={trabajando} />
                      </td>
                    )}
                    <td style={{ ...celda, ...textoLegible, minWidth: 200 }}>
                      <b>{c.campana}</b>
                      {(c.cliente || c.es_full || c.banderas?.length || c.entrega_tipo !== 'enviar' || c.sin_inventario > 0) && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3, color: 'var(--muted)' }}>
                          {c.cliente && <span>{c.cliente}</span>}
                          {c.es_full && <span className="tag" style={{ color: colorTono('morado') }}>FULL{c.full_minutos ? ` ${c.full_minutos} min` : ''}</span>}
                          {c.entrega_tipo === 'lista_sin_enviar' && <span className="tag">Tener lista, no enviar</span>}
                          {c.entrega_tipo === 'no_se_comprueba' && <span className="tag">No se comprueba</span>}
                          {(c.banderas || []).map((b) => (
                            <span key={b} className="tag">
                              {b}
                            </span>
                          ))}
                          {c.sin_inventario > 0 && (
                            <span className="tag" style={{ color: colorTono('rojo') }}>
                              {fmtN(c.sin_inventario)} sin inventario
                            </span>
                          )}
                        </div>
                      )}
                      {c.especificacion && <div style={{ color: 'var(--obs-txt)', marginTop: 3 }}>{c.especificacion}</div>}
                      <div style={{ marginTop: 6 }}>{botonSitios(c, false)}</div>
                    </td>
                    <td style={{ ...celda, ...sinQuiebre }}>{c.version || '—'}</td>
                    <td style={celda}>{c.arte ? <span className="tag">{c.arte}</span> : '—'}</td>
                    <td style={{ ...celda, ...textoLegible, minWidth: 120 }}>
                      {c.vendedor || '—'}
                      {c.administrador && <div style={{ color: 'var(--muted)' }}>{c.administrador}</div>}
                    </td>
                    <td style={celda}>{selectorAnalista(c, false)}</td>
                    <td style={{ ...celda, textAlign: 'right' }} title={c.meta_fuente === 'app' ? 'Meta puesta a mano' : c.meta_fuente === 'full' ? 'Meta FULL (regla de minutos)' : 'Sitios activos'}>
                      {fmtN(c.meta)}
                      {c.meta_fuente !== 'sitios' && <span style={{ color: 'var(--muted)' }}> *</span>}
                    </td>
                    <td style={{ ...celda, textAlign: 'right' }}>{fmtN(c.comprobados)}</td>
                    <td style={{ ...celda, minWidth: 120 }}>
                      <Barra pct={c.pct} />
                      <div style={{ color: 'var(--muted)', marginTop: 3, ...sinQuiebre }}>{c.pct == null ? 'sin meta' : `${c.pct} %`}</div>
                    </td>
                    <td style={{ ...celda, ...sinQuiebre }}>{c.retirada ? '—' : <PillLimite c={c} />}</td>
                    <td style={{ ...celda, ...textoLegible, minWidth: 130 }}>
                      {c.plan_tomas ? describirPlan(c.plan_tomas) : <span style={{ color: 'var(--muted)' }}>Sin plan</span>}
                      {c.tomas_total > 0 && <div style={{ color: 'var(--muted)' }}>{fmtN(c.tomas_total)} tomas</div>}
                    </td>
                    <td style={celda}>
                      <PillEstatus c={c} />
                    </td>
                    <td style={{ ...celda, ...textoLegible, minWidth: 110 }}>
                      {textoCierre(c) || '—'}
                      {c.cierre_motivo && <div style={{ color: 'var(--muted)' }}>«{c.cierre_motivo}»</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtradas.length > visibles.length && (
        <div style={{ textAlign: 'center', margin: '14px 0' }}>
          <button type="button" className="btn ghost" onClick={() => setLimite((n) => n + (telefono ? TANDA_TEL : TANDA_PC))}>
            Ver {fmtN(Math.min(filtradas.length - visibles.length, telefono ? TANDA_TEL : TANDA_PC))} más (faltan {fmtN(filtradas.length - visibles.length)})
          </button>
        </div>
      )}

      {/* Barra fija con lo elegido. */}
      {gestiona && sel.size > 0 && (
        <div
          role="region"
          aria-label="Campañas elegidas"
          style={{
            position: 'sticky',
            bottom: abajo,
            zIndex: 5,
            marginTop: 14,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
            padding: '10px 12px',
            background: 'var(--panel)',
            border: '1px solid var(--accent)',
            borderRadius: 12,
            boxShadow: '0 6px 18px var(--sombra)',
          }}
        >
          <b style={{ fontSize: 13, flex: telefono ? '1 1 100%' : '1 1 auto' }}>
            {fmtN(sel.size)} elegida{sel.size === 1 ? '' : 's'}
            {elegidasOcultas > 0 && (
              <span style={{ color: 'var(--warn)', fontWeight: 600 }}>
                {' '}
                · {fmtN(elegidasOcultas)} no se {elegidasOcultas === 1 ? 've' : 'ven'} con este filtro
              </span>
            )}
          </b>
          <button type="button" className="btn ghost sm" disabled={trabajando} onClick={() => setSel(new Set())}>
            Limpiar
          </button>
          <button type="button" className="btn ghost sm" disabled={trabajando} onClick={() => setModal({ t: 'plan' })}>
            Plan de tomas…
          </button>
          <button type="button" className="btn sm" disabled={trabajando} onClick={() => setModal({ t: 'acciones' })}>
            {trabajando && <span className="spinner" />}
            Acciones…
          </button>
        </div>
      )}

      {modal?.t === 'acciones' && elegidas.length > 0 && (
        <AccionesLoteModal
          {...props}
          elegidas={elegidas}
          ocultas={elegidasOcultas}
          inicial={modal.inicial}
          onCerrar={() => setModal(null)}
          onHecho={hecho}
        />
      )}
      {modal?.t === 'pasar' && (
        <ReasignarPendienteModal {...props} deInicial={modal.de} onCerrar={() => setModal(null)} onHecho={hecho} />
      )}
      {modal?.t === 'plan' && elegidas.length > 0 && (
        <PlanTomasModal
          {...props}
          elegidas={elegidas}
          // Plan aplicado: la selección ya cumplió (23-oct-2026), pero se
          // limpia al CERRAR. Limpiarla en onAplicado desmontaba el modal en
          // el mismo instante y Victor nunca veía el resultado (borradas,
          // comprobados omitidos, campañas sin tomas). Revisión 2, uso-1.
          onCerrar={() => {
            setModal(null);
            if (planAplicado.current) {
              planAplicado.current = false;
              setSel(new Set());
            }
          }}
          onAplicado={() => {
            planAplicado.current = true;
          }}
        />
      )}
      {detalleVivo && <DetalleCampana {...props} campana={detalleVivo} onCerrar={() => setDetalle(null)} />}
    </div>
  );
}
