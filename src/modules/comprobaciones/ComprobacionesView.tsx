// ============================================================
// src/modules/comprobaciones/ComprobacionesView.tsx
// Comprobaciones, fase 2: el esqueleto del módulo (Erik, 23-oct-2026).
//
// Rediseño de Erik: «la idea no es que Victor suba el Excel lleno y la app
// lo procese, sino que Victor desde la app construya ese Excel». Aquí solo
// vive lo común; cada pestaña es su archivo y recibe las props de
// tiposComp.ts:
//   · Supervisor (o manager): Armar · Campañas · Formato · Avance · Excel,
//     y además «Mis campañas» si también es analista (Victor lo es).
//   · Coordinador: Campañas y Avance en solo lectura (P3).
//   · Analista: Mis campañas.
// Los permisos van POR UNIDAD (rol y unidad de la misma fila de
// usuario_roles); la base vuelve a validar todo en cada RPC.
//
// Unidad: solo las de la persona. Periodo: catorcena en Ecovallas Digital,
// mes en Biobox y Vía Verde (como comp_periodos). Quien arma ve además los
// periodos cercanos que todavía no existen: la primera carga los crea.
// ============================================================

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { unidadesComprobaciones } from '../../lib/helpers';
import { ETIQUETA_UNIDAD_COMP, UNIDADES_COMP, type UnidadComp } from '../../lib/comprobaciones';
import {
  leerCampanas,
  leerCatorcenas,
  leerEquipo,
  leerPeriodos,
  nombresPorCorreo,
  opcionesPeriodo,
  periodoPorOmision,
  textoFallaComp,
  type CatorcenaCal,
  type MiembroEquipo,
  type PeriodoComp,
  type PeriodoSel,
  type VwCampana,
} from '../../lib/comprobacionesApi';
import { subirYLuego } from '../../lib/subirAntes';
import { fijarModuloEnPantalla, lazyConReintento } from '../../lib/cargaDiferida';
import ErrorBoundary from '../../components/ErrorBoundary';
import { vigilarRender } from '../../lib/vigia';
import {
  ETIQUETA_VISTA,
  type ContextoComp,
  type PermisosComp,
  type PropsPestanaComp,
  type VistaComp,
} from './tiposComp';
import MisCampanas from './MisCampanas';

// Las pestañas del Supervisor van en su propio chunk (integración,
// 23-oct-2026): con todo junto el módulo pesaba 280 kB y la analista en
// iPhone solo usa «Mis campañas» y el detalle. Armar (lector de bitácoras y
// fflate) es lo más pesado y solo lo abre el Supervisor en la computadora.
const ArmarPeriodo = lazyConReintento(() => import('./ArmarPeriodo'), 'ArmarPeriodo');
const CampanasSupervisor = lazyConReintento(() => import('./CampanasSupervisor'), 'CampanasSupervisor');
const FormatoGeneral = lazyConReintento(() => import('./FormatoGeneral'), 'FormatoGeneral');
const AvanceComprobaciones = lazyConReintento(() => import('./AvanceComprobaciones'), 'AvanceComprobaciones');
const DescargarExcel = lazyConReintento(() => import('./DescargarExcel'), 'DescargarExcel');

/**
 * El lazy de cada pestaña diferida (revisión de pantallas, 23-oct-2026).
 * lazyConReintento solo recarga sola la app tras un despliegue si el módulo
 * que falló es el que está «en pantalla», y App solo fija ahí el de
 * ComprobacionesView: sin esto, un chunk viejo de Campañas o Avance caía
 * directo en el aviso de error en vez de recargar una vez.
 */
const DIFERIDO_DE_VISTA: Partial<Record<VistaComp, ComponentType<any>>> = {
  armar: ArmarPeriodo,
  campanas: CampanasSupervisor,
  formato: FormatoGeneral,
  avance: AvanceComprobaciones,
  excel: DescargarExcel,
};

type FilaRol = { rol: string; unidad_negocio: string | null; medio?: string | null };

type Props = {
  /** Correo de la sesión. */
  email: string;
  /** Filas de usuario_roles de la persona (rolesDetalle de App). */
  roles: FilaRol[];
  /** Sube con ↻ y con cada aviso: relee en silencio. */
  recargarSignal?: number;
  /**
   * Pestaña (y unidad) que pide un aviso: comp_asignada → «Mis campañas» de
   * la unidad del aviso (App.tsx, 23-oct-2026). `n` cambia en cada aviso.
   */
  vistaPedida?: { vista: VistaComp; n: number; unidad?: string | null } | null;
};

/** Cuánto se queda a la vista el aviso de «✓ hecho». */
const AVISO_MS = 4500;
const CLAVE_UNIDAD = 'comp-unidad';

// ---- ≤ 780 px: el mismo corte del armazón móvil (lib/armazon.ts) -------
const MQ = '(max-width: 780px)';
function suscribirTelefono(cb: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const m = window.matchMedia(MQ);
  m.addEventListener?.('change', cb);
  return () => m.removeEventListener?.('change', cb);
}
const esTelefono = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(MQ).matches;

function leerUnidadGuardada(): string | null {
  try {
    return localStorage.getItem(CLAVE_UNIDAD);
  } catch {
    return null;
  }
}
function guardarUnidad(u: string): void {
  try {
    localStorage.setItem(CLAVE_UNIDAD, u);
  } catch {
    /* modo privado: no pasa nada */
  }
}

/** Permisos en la unidad, con la misma regla de fila que comp_mis_unidades. */
function permisosEn(roles: FilaRol[], u: UnidadComp): PermisosComp {
  const gestiona = unidadesComprobaciones(roles, ['supervisor']).has(u);
  const leeTodo = unidadesComprobaciones(roles, ['supervisor', 'coordinador']).has(u);
  // El manager pasa por todo, pero no es analista: «Mis campañas» es de
  // quien tiene la fila de analista en la unidad.
  const esAnalista = unidadesComprobaciones(
    roles.filter((r) => r.rol !== 'manager'),
    ['analista']
  ).has(u);
  return { gestiona, leeTodo, soloLectura: leeTodo && !gestiona, esAnalista };
}

function vistasDe(p: PermisosComp): VistaComp[] {
  const v: VistaComp[] = p.gestiona
    ? ['armar', 'campanas', 'formato', 'avance', 'excel']
    : p.leeTodo
      ? ['campanas', 'avance']
      : [];
  if (p.esAnalista) v.push('mis');
  return v;
}

export default function ComprobacionesView({ email, roles, recargarSignal, vistaPedida }: Props) {
  vigilarRender('ComprobacionesView');
  const correo = (email || '').trim().toLowerCase();
  const telefono = useSyncExternalStore(suscribirTelefono, esTelefono, () => false);

  // ---- Unidad --------------------------------------------------------
  const firmaRoles = JSON.stringify(roles.map((r) => [r.rol, r.unidad_negocio, r.medio ?? null]));
  const unidades = useMemo(() => {
    const s = unidadesComprobaciones(roles);
    return UNIDADES_COMP.filter((u) => s.has(u));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firmaRoles]);
  const [unidadSel, setUnidadSel] = useState<string | null>(() => leerUnidadGuardada());
  // Sin unidad guardada se abre donde la persona GESTIONA, luego donde lee
  // todo y al final la primera (revisión 2, regresiones-1): Victor es
  // supervisor en una unidad y analista en otra, y abría en «Mis campañas»
  // vacía de la primera de la lista.
  const unidadPorOmision = useMemo<UnidadComp | null>(
    () =>
      unidades.find((u) => permisosEn(roles, u).gestiona) ??
      unidades.find((u) => permisosEn(roles, u).leeTodo) ??
      unidades[0] ??
      null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unidades, firmaRoles]
  );
  const unidad: UnidadComp | null = unidades.includes(unidadSel as UnidadComp)
    ? (unidadSel as UnidadComp)
    : unidadPorOmision;

  const permisos = useMemo<PermisosComp>(
    () => (unidad ? permisosEn(roles, unidad) : { gestiona: false, leeTodo: false, soloLectura: false, esAnalista: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [firmaRoles, unidad]
  );
  const vistas = useMemo(() => vistasDe(permisos), [permisos]);
  /** Armar ya se abrió alguna vez: desde ahí se queda montado (uso-2). */
  const [armarVisto, setArmarVisto] = useState(false);
  const [vistaSel, setVistaSel] = useState<VistaComp>('campanas');
  const vista: VistaComp | null = vistas.includes(vistaSel)
    ? vistaSel
    : vistas.includes('campanas')
      ? 'campanas'
      : vistas[0] ?? null;
  useEffect(() => {
    if (vista === 'armar') setArmarVisto(true);
  }, [vista]);
  // Otra unidad es otro Armar (su estado va con la llave unidad + periodo):
  // no se monta escondido hasta que se abra ahí.
  useEffect(() => {
    setArmarVisto(vistaSel === 'armar');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unidad]);

  // ---- Candado de una escritura a la vez -------------------------------
  const [ocupado, setOcupado] = useState<string | null>(null);
  const ocupadoRef = useRef<string | null>(null);
  const correr = useCallback(async <T,>(etiqueta: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (ocupadoRef.current) return undefined;
    ocupadoRef.current = etiqueta;
    setOcupado(etiqueta);
    try {
      return await fn();
    } finally {
      ocupadoRef.current = null;
      setOcupado(null);
    }
  }, []);

  // ---- Aviso breve ------------------------------------------------------
  const [aviso, setAviso] = useState('');
  const avisoT = useRef<number | undefined>(undefined);
  const avisar = useCallback((texto: string) => {
    setAviso(texto);
    window.clearTimeout(avisoT.current);
    avisoT.current = window.setTimeout(() => setAviso(''), AVISO_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(avisoT.current), []);

  // ---- Periodos ---------------------------------------------------------
  const [periodos, setPeriodos] = useState<PeriodoComp[]>([]);
  const [periodosDe, setPeriodosDe] = useState<UnidadComp | null>(null);
  const [catorcenas, setCatorcenas] = useState<CatorcenaCal[]>([]);
  const [errPeriodos, setErrPeriodos] = useState('');
  // El calendario lleva su propio error (revisión de pantallas, 23-oct-2026):
  // compartía errPeriodos y una lectura de periodos que acertaba después lo
  // borraba; además ↻ no lo volvía a pedir.
  const [errCalendario, setErrCalendario] = useState('');
  const [intentoCal, setIntentoCal] = useState(0);
  const pidePeriodos = useRef(0);

  const cargarPeriodos = useCallback(async (u: UnidadComp) => {
    const n = ++pidePeriodos.current;
    const r = await leerPeriodos(u);
    if (n !== pidePeriodos.current) return;
    if (!r.ok) {
      setErrPeriodos('No se pudieron leer los periodos: ' + textoFallaComp(r));
      return;
    }
    setErrPeriodos('');
    setPeriodos(r.data);
    setPeriodosDe(u);
  }, []);

  useEffect(() => {
    if (unidad) cargarPeriodos(unidad);
  }, [unidad, cargarPeriodos]);

  // El calendario solo hace falta para ARMAR una catorcena que no existe.
  const necesitaCalendario = unidad === 'Ecovallas' && permisos.gestiona;
  useEffect(() => {
    if (!necesitaCalendario || catorcenas.length) {
      setErrCalendario('');
      return;
    }
    let vivo = true;
    leerCatorcenas().then((r) => {
      if (!vivo) return;
      if (r.ok) {
        setCatorcenas(r.data);
        setErrCalendario('');
      } else
        setErrCalendario(
          'No se pudo leer el calendario de catorcenas (sin él no aparece la catorcena por armar): ' +
            textoFallaComp(r)
        );
    });
    return () => {
      vivo = false;
    };
    // ↻ (recargarSignal) y «Reintentar» lo vuelven a pedir mientras falte.
  }, [necesitaCalendario, catorcenas.length, recargarSignal, intentoCal]);

  const opciones = useMemo<PeriodoSel[]>(
    () =>
      unidad && periodosDe === unidad
        ? opcionesPeriodo({ unidad, armados: periodos, catorcenas, conPorArmar: permisos.gestiona })
        : [],
    [unidad, periodosDe, periodos, catorcenas, permisos.gestiona]
  );
  const [claveSel, setClaveSel] = useState<string | null>(null);

  useEffect(() => {
    if (!vistaPedida) return;
    // La unidad del aviso, si es de la persona; la vista se valida al pintar
    // (si no la tiene en esa unidad, cae en la de siempre).
    const u = vistaPedida.unidad as UnidadComp | null | undefined;
    if (u && u !== unidad && unidades.includes(u) && !ocupadoRef.current) {
      guardarUnidad(u);
      setUnidadSel(u);
      setClaveSel(null);
    }
    if (!ocupadoRef.current) setVistaSel(vistaPedida.vista);
    // Solo cuando llega un aviso nuevo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vistaPedida?.n]);

  // Por omisión, un periodo YA armado (el que contiene hoy o el más
  // reciente); si no hay ninguno, el actual por armar.
  const armados = opciones.filter((p) => p.id != null);
  const periodo: PeriodoSel | null =
    opciones.find((p) => p.clave === claveSel) ?? periodoPorOmision(armados.length ? armados : opciones);

  // El periodo que se ve se FIJA en cuanto se resuelve (revisión de
  // pantallas, 23-oct-2026): con claveSel en null salía de periodoPorOmision
  // en cada render y, si a media mañana se armaba la catorcena nueva, la
  // siguiente recarga silenciosa saltaba a ella y desmontaba el detalle, los
  // modales y la selección. La clave no lleva el id, así que el paso de
  // «por armar» a armado sigue funcionando.
  const clavePeriodo = periodo?.clave ?? null;
  useEffect(() => {
    if (claveSel == null && clavePeriodo != null) setClaveSel(clavePeriodo);
  }, [claveSel, clavePeriodo]);

  // ---- Campañas del periodo ---------------------------------------------
  const [campanas, setCampanas] = useState<VwCampana[]>([]);
  const [campanasDe, setCampanasDe] = useState<number | null>(null);
  const [cargando, setCargando] = useState(false);
  const [recargando, setRecargando] = useState(false);
  const [errCampanas, setErrCampanas] = useState('');
  const pideCampanas = useRef(0);
  const periodoId = periodo?.id ?? null;

  const cargarCampanas = useCallback(
    async (pid: number | null, u: UnidadComp | null, silencioso: boolean) => {
      const n = ++pideCampanas.current;
      if (pid == null || !u) {
        setCampanas([]);
        setCampanasDe(null);
        setCargando(false);
        setRecargando(false);
        setErrCampanas('');
        return;
      }
      if (silencioso) setRecargando(true);
      else {
        setCargando(true);
        setCampanas([]);
        setCampanasDe(null);
      }
      const r = await leerCampanas({ periodoId: pid, unidad: u });
      if (n !== pideCampanas.current) return;
      setCargando(false);
      setRecargando(false);
      if (!r.ok) {
        // En recarga silenciosa la lista anterior se queda: mejor vieja que vacía.
        setErrCampanas('No se pudieron leer las campañas: ' + textoFallaComp(r));
        return;
      }
      setErrCampanas('');
      setCampanas(r.data);
      setCampanasDe(pid);
    },
    []
  );

  useEffect(() => {
    cargarCampanas(periodoId, unidad, false);
  }, [periodoId, unidad, cargarCampanas]);

  // ↻ y avisos: en silencio, sin desmontar pestañas ni modales.
  const primerSignal = useRef(true);
  useEffect(() => {
    if (primerSignal.current) {
      primerSignal.current = false;
      return;
    }
    if (unidad) cargarPeriodos(unidad);
    cargarCampanas(periodoId, unidad, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recargarSignal]);

  const recargar = useCallback(
    (op?: { periodos?: boolean }) => {
      if (op?.periodos && unidad) cargarPeriodos(unidad);
      cargarCampanas(periodoId, unidad, true);
    },
    [unidad, periodoId, cargarPeriodos, cargarCampanas]
  );

  // ---- Equipo de la unidad (solo quien lee toda la unidad) ---------------
  const [equipo, setEquipo] = useState<MiembroEquipo[]>([]);
  const [errEquipo, setErrEquipo] = useState('');
  /** De qué unidad es el equipo que está en pantalla (null = ninguno). */
  const equipoDe = useRef<UnidadComp | null>(null);
  useEffect(() => {
    if (!unidad || !permisos.leeTodo) {
      equipoDe.current = null;
      setEquipo([]);
      setErrEquipo('');
      return;
    }
    // En una recarga de la MISMA unidad el equipo anterior se queda
    // (revisión de pantallas, 23-oct-2026): vaciarlo dejaba sin opciones los
    // selectores de analista con una elección viva, los nombres pasaban a
    // correos y, si la lectura fallaba sin señal, se quedaba vacío.
    const misma = equipoDe.current === unidad;
    if (!misma) {
      equipoDe.current = null;
      setEquipo([]);
      setErrEquipo('');
    }
    let vivo = true;
    leerEquipo(unidad).then((r) => {
      if (!vivo) return;
      if (r.ok) {
        equipoDe.current = unidad;
        setEquipo(r.data);
        setErrEquipo('');
      } else
        setErrEquipo(
          (misma
            ? 'No se pudo actualizar el equipo de la unidad (se queda la lista anterior): '
            : 'No se pudo leer el equipo de la unidad (los nombres salen como correo): ') + textoFallaComp(r)
        );
    });
    return () => {
      vivo = false;
    };
  }, [unidad, permisos.leeTodo, recargarSignal]);

  const nombres = useMemo(() => nombresPorCorreo(equipo), [equipo]);
  const nombreDe = useCallback(
    (e: string | null | undefined) => {
      const k = (e || '').trim().toLowerCase();
      if (!k) return '';
      if (k === correo) return nombres.get(k) || 'Tú';
      // Sin el equipo (la analista no puede leer comp_equipo) se enseña solo
      // lo de antes de la @: el correo completo rompía el renglón de 375 px
      // (revisión de pantallas, 23-oct-2026).
      return nombres.get(k) || k.split('@')[0] || k;
    },
    [nombres, correo]
  );

  // ---- Pestaña diferida «en pantalla» (ver DIFERIDO_DE_VISTA) ------------
  useEffect(() => {
    const m = vista ? DIFERIDO_DE_VISTA[vista] ?? null : null;
    if (!m) return;
    // En un microtask: si este montaje cae en el mismo commit que el cambio
    // de pestaña de App, el efecto de App (que fija ComprobacionesView) corre
    // DESPUÉS del de este hijo y lo pisaría.
    let vivo = true;
    queueMicrotask(() => {
      if (vivo) fijarModuloEnPantalla(m);
    });
    return () => {
      vivo = false;
      fijarModuloEnPantalla(null);
    };
  }, [vista]);

  // ---- Render -----------------------------------------------------------
  if (!unidad)
    return (
      <>
        <h2 className="page">Comprobaciones</h2>
        <div className="empty">No tienes una unidad de Comprobaciones (Ecovallas Digital, Biobox o Vía Verde).</div>
      </>
    );

  const bloqueado = ocupado != null;
  const ctx: ContextoComp = {
    unidad,
    email: correo,
    permisos,
    equipo,
    nombreDe,
    recargar,
    correr,
    ocupado,
    avisar,
    telefono,
  };

  const pestanas = vistas.length > 1 && (
    <div className="toolbar">
      <div className="rt-chips rt-segmento" role="group" aria-label="Vista">
        {vistas.map((v) => (
          <button
            key={v}
            type="button"
            className={'rt-chip' + (vista === v ? ' on' : '')}
            aria-pressed={vista === v}
            disabled={bloqueado && vista !== v}
            onClick={() => v !== vista && subirYLuego(() => setVistaSel(v), 'comp-vista')}
          >
            {ETIQUETA_VISTA[v]}
          </button>
        ))}
      </div>
    </div>
  );

  const selectorUnidad = unidades.length > 1 && (
    <div className="toolbar">
      <div className="rt-chips rt-segmento" role="group" aria-label="Unidad">
        {unidades.map((u) => (
          <button
            key={u}
            type="button"
            className={'rt-chip' + (unidad === u ? ' on' : '')}
            aria-pressed={unidad === u}
            disabled={bloqueado && unidad !== u}
            onClick={() => {
              if (u === unidad) return;
              guardarUnidad(u);
              subirYLuego(() => {
                setUnidadSel(u);
                setClaveSel(null);
              }, 'comp-unidad');
            }}
          >
            {ETIQUETA_UNIDAD_COMP[u]}
          </button>
        ))}
      </div>
    </div>
  );

  const selectorPeriodo = (
    <div className="toolbar filtros-pildora">
      <select
        aria-label={unidad === 'Ecovallas' ? 'Catorcena' : 'Mes'}
        value={periodo?.clave ?? ''}
        disabled={bloqueado || !opciones.length}
        onChange={(e) => {
          const v = e.target.value;
          subirYLuego(() => setClaveSel(v), 'comp-periodo');
        }}
      >
        {!opciones.length && <option value="">{periodosDe === unidad ? 'Sin periodos' : 'Leyendo periodos…'}</option>}
        {opciones.map((p) => (
          <option key={p.clave} value={p.clave}>
            {p.etiqueta}
            {p.id == null ? ' · por armar' : ''}
          </option>
        ))}
      </select>
    </div>
  );

  const listaLista = periodoId != null && campanasDe === periodoId;
  // Sin la primera lista (sin señal) la pestaña se quedaba con «Leyendo…»
  // girando para siempre bajo la caja roja y sin a qué tocar (revisión 2,
  // uso-5): el error lleva su «Reintentar» y la pestaña no se monta.
  const sinLista = !listaLista && !cargando && !!errCampanas && periodoId != null;
  const errores = [errPeriodos, sinLista ? '' : errCampanas, errEquipo].filter(Boolean);
  const avisoCalendario = errCalendario && (
    <div className="err" role="alert">
      {errCalendario}{' '}
      <button type="button" className="btn ghost sm" onClick={() => setIntentoCal((n) => n + 1)}>
        Reintentar
      </button>
    </div>
  );
  let contenido: JSX.Element | null = null;
  if (!vista) {
    contenido = <div className="empty">No tienes permiso para Comprobaciones en {ETIQUETA_UNIDAD_COMP[unidad]}.</div>;
  } else if (!periodo) {
    contenido =
      periodosDe === unidad ? (
        <div className="empty">
          Todavía no hay periodos con campañas en {ETIQUETA_UNIDAD_COMP[unidad]}.
          {permisos.gestiona ? '' : ' Cuando el Supervisor arme el periodo, aquí aparecen.'}
        </div>
      ) : (
        <div className="phint">
          <span className="spinner" />
          Leyendo periodos…
        </div>
      );
  } else if (vista === 'armar') {
    // Armar se pinta aparte (abajo) y se queda montado al cambiar de pestaña.
    contenido = null;
  } else if (periodo.id == null) {
    contenido = (
      <div className="empty">
        {periodo.etiqueta} todavía no tiene campañas cargadas.
        {permisos.gestiona ? ' Ármalo en la pestaña Armar.' : ''}
      </div>
    );
  } else if (sinLista) {
    contenido = (
      <div className="err" role="alert">
        {errCampanas}{' '}
        <button type="button" className="btn ghost sm" onClick={() => cargarCampanas(periodoId, unidad, false)}>
          Reintentar
        </button>
      </div>
    );
  } else {
    const p: PropsPestanaComp = {
      ...ctx,
      periodo: { ...periodo, id: periodo.id },
      campanas: listaLista ? campanas : [],
      cargando: cargando || !listaLista,
      recargando,
    };
    contenido =
      vista === 'campanas' ? (
        <CampanasSupervisor {...p} />
      ) : vista === 'formato' ? (
        <FormatoGeneral {...p} />
      ) : vista === 'avance' ? (
        <AvanceComprobaciones {...p} />
      ) : vista === 'excel' ? (
        <DescargarExcel {...p} />
      ) : (
        <MisCampanas {...p} />
      );
  }

  return (
    <>
      <h2 className="page">
        Comprobaciones
        {(recargando || ocupado) && (
          <span role="status" style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 10 }}>
            <span className="spinner" />
            {ocupado || 'Actualizando…'}
          </span>
        )}
      </h2>
      <p className="phint">
        {permisos.gestiona
          ? 'Arma las campañas del periodo, repártelas y descarga los Excel de siempre.'
          : permisos.soloLectura
            ? 'Campañas y avance del equipo, solo para consultar.'
            : 'Tus campañas: marca lo que ya comprobaste.'}
      </p>
      {selectorUnidad}
      {pestanas}
      {selectorPeriodo}
      {errores.map((e) => (
        <div key={e} className="err">
          {e}
        </div>
      ))}
      {avisoCalendario}
      {/* Su propio ErrorBoundary (revisión de pantallas, 23-oct-2026): si el
          chunk de una pestaña no llega, se cae solo esa pestaña con su aviso
          («Recargar la app»); los selectores de unidad y periodo siguen. */}
      <ErrorBoundary
        modulo={'comprobaciones:' + (vista ?? '')}
        resetKey={`${vista}|${unidad}|${periodo?.clave ?? ''}|${recargarSignal ?? 0}`}
      >
      <Suspense
        fallback={
          <div className="phint">
            <span className="spinner" />
            Abriendo {vista ? ETIQUETA_VISTA[vista] : 'la pestaña'}…
          </div>
        }
      >
        {contenido}
      </Suspense>
      </ErrorBoundary>
      {/* Armar se queda montado una vez abierto (revisión 2, uso-2): al ir a
          Campañas y volver se perdían las bitácoras ya leídas (67-103 MB),
          la previa y los planes sugeridos por confirmar. Se esconde con
          hidden; su estado vive en ArmarInterno (key = unidad + periodo). */}
      {periodo && unidad && vistas.includes('armar') && (armarVisto || vista === 'armar') && (
        <div hidden={vista !== 'armar'}>
          <ErrorBoundary modulo="comprobaciones:armar" resetKey={`${unidad}|${periodo.clave}|${recargarSignal ?? 0}`}>
            <Suspense
              fallback={
                <div className="phint">
                  <span className="spinner" />
                  Abriendo {ETIQUETA_VISTA.armar}…
                </div>
              }
            >
              <ArmarPeriodo
                {...ctx}
                periodo={periodo}
                campanas={listaLista ? campanas : []}
                cargando={cargando}
                recargando={recargando}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
      {aviso &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="aviso-breve" role="status" aria-live="polite" onClick={() => setAviso('')}>
            {aviso}
          </div>,
          document.body
        )}
    </>
  );
}
