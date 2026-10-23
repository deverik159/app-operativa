// ============================================================
// src/modules/comprobaciones/FormatoGeneral.tsx
// Supervisor · Formato: el «Formato general de comprobaciones» armado en
// la app (Erik, 23-oct-2026). Hoy es un Excel con un renglón por día ×
// sitio × campaña × versión que se copia a mano; aquí los renglones son las
// tomas que generó el plan (vw_comp_tomas) y Victor los revisa y corrige:
//   · agrupados por día y, dentro del día, por sitio (en el orden de la
//     ruta), con filtros de campaña, día, monitorista y ruta;
//   · editar una toma (fecha dentro de la vigencia o confirmando que va
//     fuera, horario, observaciones, monitorista, turno) o varias a la vez;
//   · agregar tomas a sitios (fechas sueltas) y quitar o regresar tomas.
//
// LECTURA. Vía Verde pasa de 5,000 renglones y Ecovallas Digital puede
// llegar a 12,000 en un plan diario: no se baja el periodo entero al
// teléfono. Sin campaña ni monitorista elegidos se lee UN día; con campaña
// (o un monitorista) se lee todo su periodo y el día se filtra aquí.
// Siempre paginado (leerTomas) y con las quitadas, para poder regresarlas.
//
// HORARIO. Ecovallas Digital y Biobox son 24 HORAS (Erik, 23-oct-2026):
// se enseña con horarioParaMostrar, igual que en el Excel. Vía Verde lleva
// el horario del día (franjas).
//
// ESCRITURAS solo por las RPC (comp_editar_tomas, comp_agregar_tomas,
// comp_quitar_tomas), una a la vez (ctx.correr), enseñando los conteos que
// devuelven. Después se relee en silencio: la lista no se desmonta.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarPlus, ChevronLeft, ChevronRight, Pencil, Plus, Undo2, X } from 'lucide-react';
import Ic from '../../components/Ic';
import { colorTono, fondoTono } from '../../lib/tonos';
import {
  compararNatural,
  diasEntre,
  esMedio24h,
  ETIQUETA_UNIDAD_COMP,
  HORARIO_24H,
  horarioParaMostrar,
  hoyCdmx,
  llaveComp,
  type UnidadComp,
} from '../../lib/comprobaciones';
import {
  leerMonitoristas,
  leerTomas,
  quitarTomas,
  textoFallaComp,
  textoFallaEscrituraComp,
  type MonitoristaComp,
  type VwToma,
} from '../../lib/comprobacionesApi';
import { subirYLuego } from '../../lib/subirAntes';
import { vigilarRender } from '../../lib/vigia';
import type { PropsPestanaComp } from './tiposComp';
import FormatoEditarModal from './FormatoEditarModal';
import FormatoAgregarModal from './FormatoAgregarModal';
import {
  dentroDe,
  estatusPantalla,
  fechaCorta,
  nombreCampana,
  nTomas,
  sePuedeEditar,
  sePuedeRegresar,
  ventanasDeToma,
} from './FormatoComun';

const TODAS = 'todas';
const TODOS = 'todos';
const SIN = '__sin';
/** Sitios que se pintan por tanda («Mostrar más»): miles de filas traban el iPhone. */
const PASO = 80;

type VerEstado = 'activas' | 'quitadas' | 'todas';
type Modal =
  | { tipo: 'editar'; ids: number[] }
  | { tipo: 'agregar'; campanaId: number | null; sitioIds: number[]; dias: string[] }
  | null;

type GrupoSitio = { clave: string; sitio: string; ruta: number | null; tomas: VwToma[] };
type GrupoDia = { dia: string; sitios: GrupoSitio[]; n: number; totalSitios: number };

/** Lo que se le pide a la base (cambia = se vuelve a leer). */
type Alcance = { periodoId: number; unidad: UnidadComp; campanaId: number | null; dia: string; mon: string | null };

export default function FormatoGeneral(props: PropsPestanaComp) {
  vigilarRender('FormatoGeneral');
  const { unidad, periodo, campanas, permisos, nombreDe, correr, ocupado, avisar, recargar, telefono, recargando } = props;
  const puede = permisos.gestiona;
  const es24 = esMedio24h(unidad);

  const dias = useMemo(() => diasEntre(periodo.inicio, periodo.fin), [periodo.inicio, periodo.fin]);
  const hoy = hoyCdmx();
  const diaOmision = useMemo(() => (dias.includes(hoy) ? hoy : dias[0] ?? ''), [dias, hoy]);

  // ---- Filtros ---------------------------------------------------------
  const [campanaSel, setCampanaSel] = useState<string>(TODAS);
  const [diaSel, setDiaSel] = useState<string>(diaOmision);
  const [monSel, setMonSel] = useState(''); // '' = todos · SIN · correo
  const [rutaSel, setRutaSel] = useState(''); // '' = todas · SIN · número
  const [verEstado, setVerEstado] = useState<VerEstado>('activas');
  const [buscar, setBuscar] = useState('');
  const [limite, setLimite] = useState(PASO);
  const [sel, setSel] = useState<Set<number>>(() => new Set());
  const [modal, setModal] = useState<Modal>(null);
  const [errAccion, setErrAccion] = useState('');

  // Otro periodo u otra unidad: todo de cero.
  useEffect(() => {
    setCampanaSel(TODAS);
    setDiaSel(diaOmision);
    setMonSel('');
    setRutaSel('');
    setBuscar('');
    setSel(new Set());
    setLimite(PASO);
    setModal(null);
    setErrAccion('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodo.id, unidad]);

  const porId = useMemo(() => new Map(campanas.map((c) => [c.id, c] as const)), [campanas]);
  const campanaDe = useCallback((id: number) => porId.get(id), [porId]);
  const campanaId = campanaSel === TODAS ? null : Number(campanaSel);
  const monEspecifico = monSel !== '' && monSel !== SIN;
  // «Todos los días» solo con algo que acote (una campaña o un monitorista).
  const permiteTodos = campanaId != null || monEspecifico;
  const diaEf = diaSel === TODOS && !permiteTodos ? diaOmision : diaSel || diaOmision;

  // Con campaña: todo su periodo y el día se filtra aquí (cambiar de día es
  // instantáneo). Con monitorista sin campaña: su periodo. Si no, un día.
  const alcance: Alcance = {
    periodoId: periodo.id,
    unidad,
    campanaId,
    dia: permiteTodos ? TODOS : diaEf,
    mon: campanaId == null && monEspecifico ? monSel : null,
  };
  const claveAlcance = JSON.stringify(alcance);
  const alcanceRef = useRef(alcance);
  alcanceRef.current = alcance;

  // ---- Renglones (vw_comp_tomas) ---------------------------------------
  const [tomas, setTomas] = useState<VwToma[]>([]);
  const [tomasDe, setTomasDe] = useState('');
  const [cargandoT, setCargandoT] = useState(false);
  const [recargandoT, setRecargandoT] = useState(false);
  const [errT, setErrT] = useState('');
  const pide = useRef(0);

  const cargar = useCallback(async (silencioso: boolean) => {
    const a = alcanceRef.current;
    const k = JSON.stringify(a);
    const n = ++pide.current;
    if (silencioso) setRecargandoT(true);
    else {
      setCargandoT(true);
      setTomas([]);
      setTomasDe('');
    }
    const unDia = a.dia !== TODOS && a.dia !== '';
    const r = await leerTomas({
      periodoId: a.periodoId,
      unidad: a.unidad,
      campanaIds: a.campanaId != null ? [a.campanaId] : undefined,
      desde: unDia ? a.dia : undefined,
      hasta: unDia ? a.dia : undefined,
      monitoristaEmail: a.mon,
      incluirQuitadas: true,
    });
    if (n !== pide.current) return;
    setCargandoT(false);
    setRecargandoT(false);
    if (!r.ok) {
      // En recarga silenciosa se queda lo de antes: mejor viejo que vacío.
      setErrT('No se pudieron leer los renglones: ' + textoFallaComp(r));
      return;
    }
    setErrT('');
    setTomas(r.data);
    setTomasDe(k);
  }, []);

  useEffect(() => {
    cargar(false);
    setSel(new Set());
    setLimite(PASO);
  }, [claveAlcance, cargar]);

  // Cuando el esqueleto termina de releer las campañas (↻, un aviso o
  // después de una escritura con recargar()), se releen los renglones en
  // silencio, sin desmontar la lista ni los modales.
  const recargandoAntes = useRef(recargando);
  useEffect(() => {
    if (recargandoAntes.current && !recargando) cargar(true);
    recargandoAntes.current = recargando;
  }, [recargando, cargar]);

  // ---- Monitoristas de la unidad (comp_monitoristas) --------------------
  const [monitoristas, setMonitoristas] = useState<MonitoristaComp[]>([]);
  const [errMon, setErrMon] = useState('');
  useEffect(() => {
    let vivo = true;
    setMonitoristas([]);
    setErrMon('');
    leerMonitoristas(unidad).then((r) => {
      if (!vivo) return;
      if (r.ok) setMonitoristas(r.data);
      else setErrMon('No se pudo leer la lista de monitoristas: ' + textoFallaComp(r));
    });
    return () => {
      vivo = false;
    };
  }, [unidad]);
  const nombreMon = useMemo(
    () => new Map(monitoristas.map((m) => [m.email.trim().toLowerCase(), m.nombre] as const)),
    [monitoristas]
  );
  const nombreMonDe = useCallback(
    (e: string | null | undefined) => {
      const k = (e || '').trim().toLowerCase();
      return k ? nombreMon.get(k) || nombreDe(k) : '';
    },
    [nombreMon, nombreDe]
  );

  // ---- Filtrar y agrupar ------------------------------------------------
  const listos = tomasDe === claveAlcance;
  const llaveBuscar = llaveComp(buscar);
  /** Todo menos el filtro de estado (para contar activas y quitadas). */
  const sinEstado = useMemo(() => {
    if (!listos) return [];
    return tomas.filter((t) => {
      if (diaEf !== TODOS && t.fecha.slice(0, 10) !== diaEf) return false;
      const m = (t.monitorista_email || '').toLowerCase();
      if (monSel === SIN ? !!m : monSel && m !== monSel) return false;
      if (rutaSel === SIN ? t.ruta_numero != null : rutaSel && String(t.ruta_numero) !== rutaSel) return false;
      if (
        llaveBuscar &&
        !llaveComp(t.sitio_clave).includes(llaveBuscar) &&
        !llaveComp(t.sitio_original).includes(llaveBuscar) &&
        !llaveComp(t.campana).includes(llaveBuscar)
      )
        return false;
      return true;
    });
  }, [listos, tomas, diaEf, monSel, rutaSel, llaveBuscar]);
  const nQuitadas = sinEstado.filter((t) => t.estado === 'cancelada').length;
  const nActivas = sinEstado.length - nQuitadas;
  const filtradas = useMemo(
    () =>
      verEstado === 'todas'
        ? sinEstado
        : sinEstado.filter((t) => (verEstado === 'quitadas') === (t.estado === 'cancelada')),
    [sinEstado, verEstado]
  );

  const grupos = useMemo<GrupoDia[]>(() => {
    const porDia = new Map<string, Map<string, GrupoSitio>>();
    for (const t of filtradas) {
      const d = t.fecha.slice(0, 10);
      let m = porDia.get(d);
      if (!m) porDia.set(d, (m = new Map()));
      let g = m.get(t.sitio_clave);
      if (!g) m.set(t.sitio_clave, (g = { clave: `${d}|${t.sitio_clave}`, sitio: t.sitio_clave, ruta: null, tomas: [] }));
      g.tomas.push(t);
      if (g.ruta == null && t.ruta_numero != null) g.ruta = t.ruta_numero;
    }
    return [...porDia.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([dia, m]) => {
        // Dentro del día, en el orden de la ruta (como recorre el monitorista).
        const sitios = [...m.values()].sort(
          (a, b) =>
            (a.ruta == null ? 1 : 0) - (b.ruta == null ? 1 : 0) ||
            (a.ruta ?? 0) - (b.ruta ?? 0) ||
            compararNatural(a.sitio, b.sitio)
        );
        for (const s of sitios)
          s.tomas.sort((x, y) => nombreCampana(x).localeCompare(nombreCampana(y), 'es') || x.id - y.id);
        return { dia, sitios, n: sitios.reduce((a, s) => a + s.tomas.length, 0), totalSitios: sitios.length };
      });
  }, [filtradas]);
  const totalSitios = grupos.reduce((a, g) => a + g.sitios.length, 0);

  // Solo los primeros `limite` sitios se pintan.
  const gruposVisibles = useMemo(() => {
    const out: GrupoDia[] = [];
    let quedan = limite;
    for (const g of grupos) {
      if (quedan <= 0) break;
      const s = g.sitios.slice(0, quedan);
      quedan -= s.length;
      out.push({ ...g, sitios: s });
    }
    return out;
  }, [grupos, limite]);

  // Opciones de los filtros: las rutas y las personas que hay en lo leído.
  const rutas = useMemo(() => {
    const s = new Set<number>();
    let sinRuta = false;
    for (const t of tomas) {
      if (t.ruta_numero == null) sinRuta = true;
      else s.add(t.ruta_numero);
    }
    return { lista: [...s].sort((a, b) => a - b), sinRuta };
  }, [tomas]);
  const opcionesMon = useMemo(() => {
    const m = new Map<string, string>(monitoristas.map((x) => [x.email.trim().toLowerCase(), x.nombre]));
    for (const t of tomas) {
      const e = (t.monitorista_email || '').toLowerCase();
      if (e && !m.has(e)) m.set(e, nombreDe(e));
    }
    if (monEspecifico && !m.has(monSel)) m.set(monSel, nombreDe(monSel));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
  }, [monitoristas, tomas, nombreDe, monEspecifico, monSel]);
  const opcionesCampana = useMemo(
    () => [...campanas].sort((a, b) => nombreCampana(a).localeCompare(nombreCampana(b), 'es')),
    [campanas]
  );
  const abiertas = useMemo(() => campanas.filter((c) => c.estatus === 'abierta' && !c.retirada), [campanas]);
  const tomasDelPeriodo = campanas.reduce((a, c) => a + (c.tomas_total || 0), 0);

  // ---- Selección y acciones ----------------------------------------------
  const elegidas = useMemo(() => tomas.filter((t) => sel.has(t.id)), [tomas, sel]);
  const editables = elegidas.filter(sePuedeEditar);
  const regresables = elegidas.filter(sePuedeRegresar);
  const seleccionables = puede ? filtradas.filter((t) => sePuedeEditar(t) || sePuedeRegresar(t)) : [];
  const bloqueado = ocupado != null;

  const alternar = (id: number) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const quitarORegresar = async (lista: VwToma[], quitar: boolean) => {
    if (!lista.length) return;
    setErrAccion('');
    const r = await correr(quitar ? `Quitando ${nTomas(lista.length)}…` : `Regresando ${nTomas(lista.length)}…`, () =>
      quitarTomas(
        lista.map((t) => t.id),
        quitar
      )
    );
    if (r === undefined) {
      setErrAccion('Hay otra acción guardando. Espera a que termine y vuelve a intentar.');
      return;
    }
    if (!r.ok) {
      setErrAccion(textoFallaEscrituraComp(r));
      if (r.sinRed) recargar();
      return;
    }
    const d = r.data;
    if (d.cambiadas === 0) {
      setErrAccion(
        quitar
          ? 'No se quitó ninguna: ya no estaban pendientes o su campaña está cerrada. Recarga para ver cómo están.'
          : 'No se regresó ninguna: su sitio ya no está en el plan, su campaña está cerrada o ya estaban regresadas.'
      );
    } else {
      const partes = [`✓ ${nTomas(d.cambiadas)} ${quitar ? (d.cambiadas === 1 ? 'quitada' : 'quitadas') : d.cambiadas === 1 ? 'regresada' : 'regresadas'}`];
      if (d.sin_cambio > 0) partes.push(`${d.sin_cambio} sin cambio`);
      avisar(partes.join(' · '));
      setSel(new Set());
    }
    recargar();
  };

  const listo = (texto: string) => {
    setModal(null);
    setSel(new Set());
    avisar(texto);
    recargar();
  };

  const cambiarFiltro = (fn: () => void) =>
    subirYLuego(() => {
      fn();
      setLimite(PASO);
    }, 'comp-formato-filtro');

  const iDia = dias.indexOf(diaEf);
  const moverDia = (paso: number) => {
    const d = dias[iDia + paso];
    if (d) cambiarFiltro(() => setDiaSel(d));
  };

  // ---- Render ---------------------------------------------------------------
  // En el teléfono NO va la tira de píldoras (revisión 2, uso-6): es una
  // fila sin salto con scroll oculto y el select de campaña tomaba el ancho
  // de su opción más larga (719 px), dejando Día, Monitorista, Ruta y Buscar
  // fuera de la pantalla. Ahí cada filtro va en su renglón (.toolbar del
  // teléfono: select a lo ancho) y con letra de 16 px para que iOS no haga zoom.
  const letraTel = telefono ? { fontSize: 16 } : undefined;
  const filtros = (
    <div className={telefono ? 'toolbar' : 'toolbar filtros-pildora'}>
      <select
        aria-label="Campaña"
        className={campanaId != null ? 'on' : ''}
        value={campanaSel}
        style={telefono ? { maxWidth: '100%', minWidth: 0, fontSize: 16 } : { maxWidth: 320 }}
        onChange={(e) => {
          const v = e.target.value;
          cambiarFiltro(() => {
            setCampanaSel(v);
            // Al elegir una campaña se ve todo su periodo; al quitarla, un día.
            if (v !== TODAS) setDiaSel(TODOS);
            else if (diaSel === TODOS && !monEspecifico) setDiaSel(diaOmision);
          });
        }}
      >
        <option value={TODAS}>Todas las campañas</option>
        {opcionesCampana.map((c) => (
          <option key={c.id} value={String(c.id)}>
            {nombreCampana(c)}
            {c.retirada ? ' · retirada' : c.estatus === 'cerrada' ? ' · cerrada' : ''} ({c.tomas_total})
          </option>
        ))}
      </select>
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flex: telefono ? '1 1 100%' : '0 0 auto' }}>
        <button
          type="button"
          className="btn ghost sm"
          style={telefono ? { minWidth: 44, minHeight: 44 } : undefined}
          aria-label="Día anterior"
          disabled={diaEf === TODOS || iDia <= 0}
          onClick={() => moverDia(-1)}
        >
          <Ic i={ChevronLeft} />
        </button>
        <select
          aria-label="Día"
          className={diaEf !== diaOmision ? 'on' : ''}
          value={diaEf}
          style={telefono ? { flex: '1 1 auto', width: '100%', minWidth: 0, fontSize: 16 } : undefined}
          onChange={(e) => {
            const v = e.target.value;
            cambiarFiltro(() => setDiaSel(v));
          }}
        >
          {permiteTodos && <option value={TODOS}>Todos los días</option>}
          {dias.map((d) => (
            <option key={d} value={d}>
              {fechaCorta(d)}
              {d === hoy ? ' · hoy' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn ghost sm"
          style={telefono ? { minWidth: 44, minHeight: 44 } : undefined}
          aria-label="Día siguiente"
          disabled={diaEf === TODOS || iDia < 0 || iDia >= dias.length - 1}
          onClick={() => moverDia(1)}
        >
          <Ic i={ChevronRight} />
        </button>
      </span>
      <select
        aria-label="Monitorista"
        className={monSel ? 'on' : ''}
        value={monSel}
        style={letraTel}
        onChange={(e) => {
          const v = e.target.value;
          cambiarFiltro(() => {
            setMonSel(v);
            const especifico = v !== '' && v !== SIN;
            if (especifico && campanaId == null) setDiaSel(TODOS);
            else if (!especifico && campanaId == null && diaSel === TODOS) setDiaSel(diaOmision);
          });
        }}
      >
        <option value="">Todos los monitoristas</option>
        <option value={SIN}>Sin monitorista</option>
        {opcionesMon.map(([e, n]) => (
          <option key={e} value={e}>
            {n}
          </option>
        ))}
      </select>
      {(rutas.lista.length > 0 || rutaSel) && (
        <select
          aria-label="Ruta"
          className={rutaSel ? 'on' : ''}
          value={rutaSel}
          style={letraTel}
          onChange={(e) => {
            const v = e.target.value;
            cambiarFiltro(() => setRutaSel(v));
          }}
        >
          <option value="">Todas las rutas</option>
          {rutas.lista.map((n) => (
            <option key={n} value={String(n)}>
              Ruta {n}
            </option>
          ))}
          {(rutas.sinRuta || rutaSel === SIN) && <option value={SIN}>Sin ruta</option>}
        </select>
      )}
      <input
        type="search"
        aria-label="Buscar sitio o campaña"
        placeholder="Buscar sitio o campaña"
        value={buscar}
        onChange={(e) => {
          setBuscar(e.target.value);
          setLimite(PASO);
        }}
        style={{
          flex: telefono ? '1 1 100%' : '0 1 220px',
          width: 'auto',
          height: telefono ? 44 : 34,
          borderRadius: telefono ? 22 : 17,
          padding: '0 13px',
          fontSize: telefono ? 16 : undefined,
        }}
      />
    </div>
  );

  const barraEstado = (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
      <div className="rt-chips" role="group" aria-label="Qué renglones" style={{ marginBottom: 0 }}>
        {(
          [
            ['activas', `Activas (${nActivas})`],
            ['quitadas', `Quitadas (${nQuitadas})`],
            ['todas', 'Todas'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            className={'rt-chip' + (verEstado === k ? ' on' : '')}
            aria-pressed={verEstado === k}
            onClick={() => cambiarFiltro(() => setVerEstado(k))}
          >
            {l}
          </button>
        ))}
      </div>
      <span style={{ flex: 1 }} />
      {puede && seleccionables.length > 0 && (
        <button
          type="button"
          className="btn ghost sm"
          disabled={bloqueado}
          onClick={() => setSel(new Set(seleccionables.map((t) => t.id)))}
        >
          Elegir {seleccionables.length === 1 ? 'la visible' : `las ${seleccionables.length} visibles`}
        </button>
      )}
      {puede && (
        <button
          type="button"
          className="btn sm"
          disabled={bloqueado || !abiertas.length}
          title={abiertas.length ? undefined : 'No hay campañas abiertas en este periodo'}
          onClick={() =>
            setModal({
              tipo: 'agregar',
              campanaId: campanaId != null && abiertas.some((c) => c.id === campanaId) ? campanaId : null,
              sitioIds: [],
              dias: diaEf !== TODOS ? [diaEf] : [],
            })
          }
        >
          <Ic i={Plus} />
          Agregar tomas
        </button>
      )}
    </div>
  );

  const resumen = listos && (
    <p className="phint" role="status" style={{ marginBottom: 10 }}>
      {nTomas(filtradas.length)} en {totalSitios} sitio{totalSitios === 1 ? '' : 's'}
      {diaEf !== TODOS ? ` · ${fechaCorta(diaEf)}` : ''}
      {es24 ? ` · Horario: ${HORARIO_24H} (${ETIQUETA_UNIDAD_COMP[unidad]} no lleva franjas)` : ''}
      {recargandoT && (
        <>
          {' '}
          <span className="spinner" />
        </>
      )}
    </p>
  );

  let cuerpo: JSX.Element;
  if (!listos && (cargandoT || !errT)) {
    cuerpo = (
      <div className="phint">
        <span className="spinner" />
        Leyendo los renglones…
      </div>
    );
  } else if (!listos) {
    cuerpo = (
      <div className="empty">
        No se pudieron leer los renglones.{' '}
        <button type="button" className="btn ghost sm" onClick={() => cargar(false)}>
          Reintentar
        </button>
      </div>
    );
  } else if (!tomas.length) {
    cuerpo = (
      <div className="empty">
        {tomasDelPeriodo === 0
          ? `Todavía no hay renglones en ${periodo.etiqueta}: elige el plan de tomas de las campañas en la pestaña Campañas.`
          : campanaId != null
            ? 'Esta campaña no tiene renglones. Elige su plan de tomas en Campañas o agrégalas a mano.'
            : diaEf !== TODOS
              ? `Nada que tomar el ${fechaCorta(diaEf)}.`
              : 'Sin renglones.'}
      </div>
    );
  } else if (!filtradas.length) {
    cuerpo = <div className="empty">Ningún renglón con estos filtros.</div>;
  } else {
    cuerpo = (
      <div style={{ opacity: recargandoT ? 0.65 : 1, transition: 'opacity .15s' }}>
        {gruposVisibles.map((gd) => (
          <section key={gd.dia} style={{ marginBottom: 14 }}>
            {(diaEf === TODOS || grupos.length > 1) && (
              <h3 style={{ fontSize: 14, margin: '4px 0 8px' }}>
                {fechaCorta(gd.dia)}{' '}
                <span style={{ color: 'var(--muted)', fontWeight: 500 }}>
                  · {nTomas(gd.n)} en {gd.totalSitios} sitio{gd.totalSitios === 1 ? '' : 's'}
                </span>
              </h3>
            )}
            <div style={{ display: 'grid', gap: 8 }}>
              {gd.sitios.map((gs) => (
                <div key={gs.clave} className="inc">
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 8,
                      alignItems: 'baseline',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div className="titulo" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                      {gs.sitio}
                    </div>
                    <div className="meta">
                      {gs.ruta != null ? `Ruta ${gs.ruta}` : 'Sin ruta'} · {nTomas(gs.tomas.length)}
                    </div>
                  </div>
                  <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                    {gs.tomas.map((t) => (
                      <FilaToma
                        key={t.id}
                        t={t}
                        puede={puede}
                        bloqueado={bloqueado}
                        elegida={sel.has(t.id)}
                        fueraVig={!dentroDe(t.fecha, ventanasDeToma(t, campanaDe(t.campana_id), periodo))}
                        nombreMon={nombreMonDe(t.monitorista_email)}
                        onElegir={() => alternar(t.id)}
                        onEditar={() => setModal({ tipo: 'editar', ids: [t.id] })}
                        onOtraFecha={() =>
                          setModal({ tipo: 'agregar', campanaId: t.campana_id, sitioIds: [t.sitio_id], dias: [] })
                        }
                        onQuitar={() => quitarORegresar([t], true)}
                        onRegresar={() => quitarORegresar([t], false)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
        {totalSitios > limite && (
          <div style={{ textAlign: 'center', margin: '10px 0' }}>
            <button type="button" className="btn ghost" onClick={() => setLimite((l) => l + PASO)}>
              Mostrar más ({totalSitios - limite} sitios más)
            </button>
          </div>
        )}
      </div>
    );
  }

  const conBarra = puede && (elegidas.length > 0 || !!errAccion);

  return (
    <>
      {filtros}
      {errMon && <div className="err">{errMon}</div>}
      {errT && listos && <div className="err">{errT}</div>}
      {errAccion && !conBarra && <div className="err">{errAccion}</div>}
      {barraEstado}
      {resumen}
      {cuerpo}

      {conBarra && (
        <div
          role="region"
          aria-label="Acciones con las tomas elegidas"
          style={{
            position: 'sticky',
            bottom: 0,
            zIndex: 5,
            marginTop: 12,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            padding: '10px 12px',
            paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0px))',
            boxShadow: '0 -4px 14px var(--sombra)',
          }}
        >
          {errAccion && (
            <div className="err" style={{ marginBottom: elegidas.length ? 8 : 0, display: 'flex', gap: 8 }}>
              <span style={{ flex: 1 }}>{errAccion}</span>
              <button type="button" className="btn-icono" aria-label="Cerrar aviso" onClick={() => setErrAccion('')}>
                <Ic i={X} />
              </button>
            </div>
          )}
          {elegidas.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <b style={{ fontSize: 13, marginRight: 'auto' }}>
                {elegidas.length} elegida{elegidas.length === 1 ? '' : 's'}
              </b>
              {editables.length > 0 && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={bloqueado}
                  onClick={() => setModal({ tipo: 'editar', ids: editables.map((t) => t.id) })}
                >
                  <Ic i={Pencil} />
                  Editar ({editables.length})
                </button>
              )}
              {editables.length > 0 && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={bloqueado}
                  onClick={() => quitarORegresar(editables, true)}
                >
                  <Ic i={X} />
                  Quitar ({editables.length})
                </button>
              )}
              {regresables.length > 0 && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={bloqueado}
                  onClick={() => quitarORegresar(regresables, false)}
                >
                  <Ic i={Undo2} />
                  Regresar ({regresables.length})
                </button>
              )}
              <button type="button" className="btn ghost sm" disabled={bloqueado} onClick={() => setSel(new Set())}>
                Ninguna
              </button>
            </div>
          )}
        </div>
      )}

      {modal?.tipo === 'editar' &&
        (() => {
          const lista = tomas.filter((t) => modal.ids.includes(t.id) && sePuedeEditar(t));
          if (!lista.length) return null;
          return (
            <FormatoEditarModal
              tomas={lista}
              unidad={unidad}
              periodo={periodo}
              campanaDe={campanaDe}
              monitoristas={monitoristas}
              nombreDe={nombreMonDe}
              correr={correr}
              onCerrar={() => setModal(null)}
              onListo={listo}
              onSinRespuesta={recargar}
            />
          );
        })()}
      {modal?.tipo === 'agregar' && (
        <FormatoAgregarModal
          campanas={abiertas}
          campanaInicial={modal.campanaId}
          sitiosIniciales={modal.sitioIds}
          diasIniciales={modal.dias}
          periodo={periodo}
          correr={correr}
          telefono={telefono}
          onCerrar={() => setModal(null)}
          onListo={listo}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------
// Un renglón (una toma) dentro de su sitio
// ------------------------------------------------------------

function FilaToma({
  t,
  puede,
  bloqueado,
  elegida,
  fueraVig,
  nombreMon,
  onElegir,
  onEditar,
  onOtraFecha,
  onQuitar,
  onRegresar,
}: {
  t: VwToma;
  puede: boolean;
  bloqueado: boolean;
  elegida: boolean;
  fueraVig: boolean;
  nombreMon: string;
  onElegir: () => void;
  onEditar: () => void;
  onOtraFecha: () => void;
  onQuitar: () => void;
  onRegresar: () => void;
}) {
  const editable = puede && sePuedeEditar(t);
  const regresable = puede && sePuedeRegresar(t);
  const agregable = puede && t.campana_estatus === 'abierta' && !t.campana_retirada && t.sitio_estado !== 'cancelado' && !t.sitio_fuera_de_carga;
  const est = estatusPantalla(t);
  const horario = horarioParaMostrar(t.medio, t.horario_texto);
  const quitada = t.estado === 'cancelada';
  const sub = [
    horario ?? 'Sin horario',
    nombreMon || 'Sin monitorista',
    t.turno ? t.turno.charAt(0).toUpperCase() + t.turno.slice(1) : null,
    t.comprobacion && t.comprobacion !== 'FOTO' ? t.comprobacion : null,
  ].filter(Boolean);
  return (
    <div
      className={'rt-fila' + (elegida ? ' elegida' : '')}
      style={{ cursor: 'default', opacity: quitada ? 0.7 : 1, alignItems: 'flex-start' }}
    >
      {(editable || regresable) && (
        // Área táctil de 44 px alrededor de la casilla (revisión 2, uso-6:
        // la casilla sola medía 13 × 13 en el iPhone).
        <label
          style={{
            minWidth: 44,
            minHeight: 44,
            margin: '-10px -6px -10px -10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            aria-label={`Elegir ${t.sitio_clave} · ${nombreCampana(t)}`}
            style={{ width: 20, height: 20, margin: 0, flexShrink: 0 }}
            checked={elegida}
            onChange={onElegir}
          />
        </label>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="rt-fila-tit" style={{ textDecoration: quitada ? 'line-through' : undefined }}>
          {nombreCampana(t)}
        </div>
        <div className="rt-fila-sub">{sub.join(' · ')}</div>
        {(t.observaciones || t.notas) && (
          <div className="rt-fila-sub" style={{ color: 'var(--txt)', marginTop: 2 }}>
            {t.observaciones}
            {t.observaciones && t.notas ? ' · ' : ''}
            {t.notas && <i>Nota: {t.notas}</i>}
          </div>
        )}
        {(est || fueraVig || t.origen === 'app' || t.tipo_venta === 'BONUS' || !t.en_inventario) && (
          <div className="rt-fila-tags">
            {est && (
              <span className="pill" style={{ background: fondoTono(est.tono), color: colorTono(est.tono) }}>
                {est.texto}
              </span>
            )}
            {fueraVig && !quitada && (
              <span className="pill" style={{ background: fondoTono('ambar'), color: colorTono('ambar') }}>
                Fuera de vigencia
              </span>
            )}
            {t.tipo_venta === 'BONUS' && <span className="tag">BONUS</span>}
            {t.origen === 'app' && <span className="tag">Editada a mano</span>}
            {!t.en_inventario && <span className="tag">No está en inventario</span>}
          </div>
        )}
      </div>
      {puede && (editable || regresable || agregable) && (
        <div className="rt-fila-acc">
          {editable && (
            <button
              type="button"
              className="btn-icono"
              aria-label="Editar toma"
              title="Editar"
              disabled={bloqueado}
              onClick={onEditar}
            >
              <Pencil size={17} aria-hidden="true" />
            </button>
          )}
          {agregable && (
            <button
              type="button"
              className="btn-icono"
              aria-label="Agregar otra fecha a este sitio"
              title="Otra fecha para este sitio"
              disabled={bloqueado}
              onClick={onOtraFecha}
            >
              <CalendarPlus size={17} aria-hidden="true" />
            </button>
          )}
          {editable && (
            <button
              type="button"
              className="btn-icono"
              aria-label="Quitar toma"
              title="Quitar (se puede regresar)"
              disabled={bloqueado}
              onClick={onQuitar}
            >
              <X size={17} aria-hidden="true" />
            </button>
          )}
          {regresable && (
            <button
              type="button"
              className="btn-icono"
              aria-label="Regresar toma"
              title="Regresar"
              disabled={bloqueado}
              onClick={onRegresar}
            >
              <Undo2 size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
