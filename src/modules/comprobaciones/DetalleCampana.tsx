// ============================================================
// src/modules/comprobaciones/DetalleCampana.tsx
// Detalle de UNA campaña-versión a pantalla completa (Erik, 23-oct-2026):
// un renglón por sitio (comp_sitios) para marcar lo comprobado. Pensado
// primero para iPhone: el renglón entero se toca para elegirlo (≥ 44 px), el
// ✓ de la derecha marca uno con un solo toque y el pie fijo lleva el día y
// los botones del lote.
//
// Qué se puede hacer (cada cosa por su RPC, enseñando lo que contesta):
//   · Marcar comprobado uno o en lote (comp_marcar_sitios) con el día: hoy o
//     hasta 7 días atrás, nunca antes del periodo (P4; diasParaMarcar).
//   · Quitar la marca: solo quien marcó o el Supervisor (la base lo exige y
//     rechaza el lote entero si va uno ajeno, así que aquí solo se mandan los
//     propios y se avisa cuántos se dejaron).
//   · Cancelar sitio con motivo («no se comprueba») y regresarlo.
//   · FULL de Vía Verde: agregar columnas (comp_agregar_sitios; la base solo
//     se lo deja a la analista si la campaña es FULL y de Vía Verde).
//
// Candado de UNA escritura a la vez: ctx.correr (el del esqueleto). Mientras
// corre no se cierra la ventana ni se cambia de pestaña. Sin red, el texto
// dice que no se sabe si se guardó (textoFallaEscrituraComp) y se relee.
// La RLS niega en silencio: después de cada escritura se vuelven a leer los
// sitios y la campaña, nunca se da por hecho lo que no contestó la base.
//
// Lo usan «Mis campañas» y, si quiere, la pestaña Campañas del Supervisor
// (en lectura para el Coordinador: lo decide `permisos`).
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CirclePlus, Pencil, RotateCcw, Search, Undo2, X } from 'lucide-react';
import Ic from '../../components/Ic';
import {
  compararNatural,
  diasParaMarcar,
  esMedio24h,
  HORARIO_24H,
  horarioParaMostrar,
  hoyCdmx,
} from '../../lib/comprobaciones';
import {
  agregarSitios,
  cancelarSitios,
  editarCampanas,
  leerCampana,
  leerSitios,
  marcarSitios,
  restaurarSitios,
  textoFallaComp,
  textoFallaEscrituraComp,
  type CambiosCampana,
  type PeriodoCargado,
  type SitioComp,
  type TomasReaplicadas,
  type VwCampana,
} from '../../lib/comprobacionesApi';
import { colorTono, fondoTono, type Tono } from '../../lib/tonos';
import {
  Barra,
  fechaCorta,
  nf,
  PildoraLimite,
  sinPorComprobar,
  TEXTO_SIN_POR_COMPROBAR,
  textoAvance,
  textoEntrega,
  vigenciaTexto,
} from './AvanceComun';
import type { ContextoComp } from './tiposComp';

type Props = ContextoComp & {
  periodo: PeriodoCargado;
  /** La fila de la lista; aquí se relee sola después de cada escritura. */
  campana: VwCampana;
  onCerrar: () => void;
};

type Filtro = 'pendientes' | 'comprobados' | 'cancelados' | 'todos';
type Panel = null | 'cancelar' | 'agregar' | 'datos';

/** Datos de la campaña que el Supervisor captura aquí (revisión 2, punta-a-punta-4). */
type BorradorDatos = { cliente: string; vendedor: string; administrador: string; arte: '' | 'NUEVO' | 'REPITE'; especificacion: string };
const datosDe = (c: VwCampana): BorradorDatos => ({
  cliente: c.cliente || '',
  vendedor: c.vendedor || '',
  administrador: c.administrador || '',
  arte: c.arte || '',
  especificacion: c.especificacion || '',
});

/** Renglones que se pintan de inicio (Vía Verde FULL puede pasar de 200 columnas). */
const LIMITE = 150;

/** Desde cuántos sitios se confirma un marcado en lote (23-oct-2026). */
const LOTE_CONFIRMAR = 10;

/** Motivos de cancelación frecuentes (se pueden escribir otros). */
const MOTIVOS = ['Pantalla apagada', 'Sitio de baja', 'Reubicación', 'No se ve el arte', 'Obra o bloqueo'];

/** «448, 512 POR_0008» → ['448', '512', 'POR_0008']. */
export function partirClavesTexto(t: string): string[] {
  return [...new Set(t.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
}

/** Lo que pasó con las tomas del plan después de cancelar, regresar o agregar (si pasó algo). */
function textoTomas(r: TomasReaplicadas): string {
  const p: string[] = [];
  if (r.tomas_nuevas) p.push(`${nf(r.tomas_nuevas)} tomas nuevas en el formato`);
  if (r.tomas_borradas) p.push(`${nf(r.tomas_borradas)} tomas quitadas del formato`);
  if (r.tomas_canceladas) p.push(`${nf(r.tomas_canceladas)} tomas editadas a mano quedaron sin efecto`);
  if (r.tomas_regresadas) p.push(`${nf(r.tomas_regresadas)} tomas regresaron`);
  return p.length ? ' ' + p.join(' · ') + '.' : '';
}

const tonoEstado: Record<SitioComp['estado'], Tono> = { pendiente: 'gris', comprobado: 'verde', cancelado: 'ambar' };
const textoEstado: Record<SitioComp['estado'], string> = {
  pendiente: 'Pendiente',
  comprobado: 'Comprobado',
  cancelado: 'Cancelado',
};

export default function DetalleCampana(props: Props) {
  const { periodo, onCerrar, email, permisos, nombreDe, correr, ocupado, recargar, telefono } = props;

  // Al abrir, el foco va al título: VoiceOver y el teclado empiezan dentro
  // de la ventana y no detrás (revisión de pantallas, 23-oct-2026).
  const titRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titRef.current?.focus();
  }, []);

  // ---- Campaña y sitios (se releen después de cada escritura) -----------
  const [camp, setCamp] = useState<VwCampana>(props.campana);
  // Si la lista del esqueleto trae una versión más nueva, se toma.
  useEffect(() => {
    if (props.campana.id === camp.id && props.campana.actualizado_en >= camp.actualizado_en) setCamp(props.campana);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.campana]);

  const [sitios, setSitios] = useState<SitioComp[]>([]);
  const [leido, setLeido] = useState(false);
  const [leyendo, setLeyendo] = useState(false);
  const [errLeer, setErrLeer] = useState('');
  const pide = useRef(0);

  /** Relee; devuelve los sitios leídos (null si falló o llegó otra lectura después). */
  const releer = async (conCampana: boolean): Promise<SitioComp[] | null> => {
    const n = ++pide.current;
    setLeyendo(true);
    const [s, c] = await Promise.all([
      leerSitios({ campanaIds: [camp.id] }),
      conCampana ? leerCampana(camp.id) : Promise.resolve(null),
    ]);
    if (n !== pide.current) return null;
    setLeyendo(false);
    if (!s.ok) {
      setErrLeer('No se pudieron leer los sitios: ' + textoFallaComp(s));
      return null;
    }
    setErrLeer('');
    setSitios(s.data);
    setLeido(true);
    if (c && c.ok && c.data) setCamp(c.data);
    return s.data;
  };

  useEffect(() => {
    releer(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camp.id]);

  /** Después de escribir: relee aquí y, en silencio, la lista del esqueleto. */
  const despues = async () => {
    const r = await releer(true);
    recargar();
    return r;
  };

  // ---- Permisos de ESTA campaña (la base vuelve a validar todo) ----------
  const esMia = permisos.esAnalista && (camp.analista_email || '').toLowerCase() === email;
  const abierta = camp.estatus === 'abierta';
  const puedeEscribir = abierta && (permisos.gestiona || esMia);
  const puedeAgregar = puedeEscribir && !camp.retirada && camp.es_full && camp.unidad === 'Vía Verde';
  const motivoLectura = !abierta
    ? 'Esta campaña ya está cerrada: solo se puede consultar.'
    : !puedeEscribir
      ? permisos.soloLectura
        ? 'Solo para consultar.'
        : 'Solo la analista de la campaña o el Supervisor marcan aquí.'
      : camp.retirada
        ? 'Esta campaña se retiró (ya no viene en la carga): sus pendientes no se marcan. Lo ya comprobado se queda.'
        : '';

  const marcable = (s: SitioComp) => s.estado === 'pendiente' && !s.fuera_de_carga && !camp.retirada;
  const desmarcable = (s: SitioComp) =>
    s.estado === 'comprobado' && s.comprobado_via === 'marca' && (permisos.gestiona || (s.comprobado_por || '').toLowerCase() === email);
  const accionable = (s: SitioComp) =>
    puedeEscribir && (s.estado === 'pendiente' || s.estado === 'cancelado' || desmarcable(s));

  // ---- Día de la marca (P4) ---------------------------------------------
  // El periodo sale de la FILA (vw_comp_campanas lo trae), no de las props:
  // si el esqueleto cambia de periodo con el detalle abierto, los días de
  // marca y el encabezado siguen siendo los de esta campaña (revisión de
  // pantallas, 23-oct-2026).
  const inicioPeriodo = camp.periodo_inicio || periodo.inicio;
  const etiquetaPeriodo = camp.periodo_etiqueta || periodo.etiqueta;
  const hoy = hoyCdmx();
  const dias = useMemo(() => diasParaMarcar(hoy, inicioPeriodo), [hoy, inicioPeriodo]);
  const [dia, setDia] = useState<string>('');
  const diaSel = dias.includes(dia) ? dia : dias[0] ?? '';
  const etiquetaDiaMarca = (d: string, i: number) => (i === 0 ? `Hoy (${fechaCorta(d)})` : i === 1 ? `Ayer (${fechaCorta(d)})` : fechaCorta(d));
  /** null = «hoy» del servidor: si el teléfono cambió de día, manda la base. */
  const diaParaEnviar = () => (diaSel && diaSel !== dias[0] ? diaSel : null);

  // ---- Filtro, búsqueda y selección ---------------------------------------
  const cuenta = useMemo(() => {
    const c = { pendientes: 0, comprobados: 0, cancelados: 0, todos: sitios.length };
    for (const s of sitios) {
      if (s.estado === 'pendiente') c.pendientes++;
      else if (s.estado === 'comprobado') c.comprobados++;
      else c.cancelados++;
    }
    return c;
  }, [sitios]);
  const [filtroSel, setFiltro] = useState<Filtro | null>(null);
  // De entrada: Pendientes si hay; si no, Todos.
  const filtro: Filtro = filtroSel ?? (leido && cuenta.pendientes === 0 ? 'todos' : 'pendientes');
  const [busca, setBusca] = useState('');
  const [limite, setLimite] = useState(LIMITE);
  const [sel, setSel] = useState<Set<number>>(new Set());

  const visibles = useMemo(() => {
    const q = busca.trim().toUpperCase();
    return sitios
      .filter((s) =>
        filtro === 'todos'
          ? true
          : filtro === 'pendientes'
            ? s.estado === 'pendiente'
            : filtro === 'comprobados'
              ? s.estado === 'comprobado'
              : s.estado === 'cancelado'
      )
      .filter(
        (s) =>
          !q ||
          s.sitio_clave.toUpperCase().includes(q) ||
          (s.sitio_original || '').toUpperCase().includes(q) ||
          (s.espacio_vv || '').toUpperCase().includes(q) ||
          (s.site_id || '').toUpperCase().includes(q)
      )
      .sort((a, b) => compararNatural(a.sitio_clave, b.sitio_clave));
  }, [sitios, filtro, busca]);

  // La selección solo guarda lo que sigue existiendo y se puede tocar.
  const porId = useMemo(() => new Map(sitios.map((s) => [s.id, s])), [sitios]);
  const elegidos = useMemo(
    () => [...sel].map((id) => porId.get(id)).filter((s): s is SitioComp => !!s && accionable(s)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel, porId, puedeEscribir, permisos.gestiona, email]
  );
  const selMarcar = elegidos.filter(marcable);
  const selQuitar = elegidos.filter(desmarcable);
  const selCancelar = elegidos.filter((s) => s.estado === 'pendiente');
  const selRestaurar = elegidos.filter((s) => s.estado === 'cancelado');
  const visiblesMarcables = visibles.filter(marcable);
  const visiblesDesmarcables = visibles.filter(desmarcable);

  const alternar = (s: SitioComp) => {
    if (!accionable(s) || ocupado) return;
    setHecho('');
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(s.id)) n.delete(s.id);
      else n.add(s.id);
      return n;
    });
  };

  // ---- Escrituras --------------------------------------------------------
  const [err, setErr] = useState('');
  const [hecho, setHecho] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [motivo, setMotivo] = useState('');
  const [claves, setClaves] = useState('');
  const panelCancelarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 'start' y no 'nearest' (revisión 2, uso-4): con 'nearest' el panel no
    // se movía si ya «cabía», aunque el pie fijo le tapara el motivo y los
    // botones en el iPhone.
    if (panel === 'cancelar') panelCancelarRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [panel]);

  /**
   * Lo último que se marcó desde aquí, para «Deshacer» (revisión de
   * pantallas, 23-oct-2026): marcar en lote son dos toques y, para corregir,
   * había que quitar las marcas una por una.
   * Guarda SOLO los sitios que cambió esta marca (revisión 2, contrato-6 y
   * uso-3): comp_marcar_sitios devuelve conteos y no ids, y los que llegaron
   * como «sin cambio» (ya marcados desde otro equipo o por otra persona) no
   * se deben desmarcar. Se queda hasta la siguiente escritura, aunque se
   * toque un renglón (uso-9).
   */
  const [ultimoMarcado, setUltimoMarcado] = useState<number[]>([]);
  /** Sube con cada escritura: una marca que termina tarde no revive su «Deshacer». */
  const escrituraN = useRef(0);
  const olvidarUltimo = () => {
    escrituraN.current++;
    setUltimoMarcado([]);
  };

  const marcar = async (lista: SitioComp[], enLote = false) => {
    const ids = lista.filter(marcable).map((s) => s.id);
    if (!ids.length) return;
    if (!diaSel) {
      setErr('El periodo todavía no empieza: no se puede marcar.');
      return;
    }
    // Un lote grande se confirma: en el iPhone «Elegir todos» y «Marcar» son
    // dos toques seguidos.
    if (
      enLote &&
      ids.length > LOTE_CONFIRMAR &&
      !window.confirm(`¿Marcar ${ids.length} sitios como comprobados el ${fechaCorta(diaSel)}?`)
    )
      return;
    setErr('');
    setHecho('');
    olvidarUltimo();
    const miEscritura = escrituraN.current;
    const dEnvio = diaParaEnviar();
    const r = await correr(ids.length === 1 ? 'Marcando…' : `Marcando ${ids.length}…`, () => marcarSitios(ids, true, dEnvio));
    if (!r) return;
    if (!r.ok) {
      setErr(textoFallaEscrituraComp(r));
      if (r.sinRed) despues();
      return;
    }
    // Al momento: la base marca todo el lote o nada (si uno no se puede,
    // lanza y no cambia ninguno), así que los pendientes del lote ya están.
    const diaOk = r.data.dia || diaSel;
    const ahora = new Date().toISOString();
    const set = new Set(ids);
    setSitios((prev) =>
      prev.map((s) =>
        set.has(s.id) && s.estado === 'pendiente'
          ? { ...s, estado: 'comprobado', comprobado_dia: diaOk, comprobado_en: ahora, comprobado_por: email, comprobado_via: 'marca' }
          : s
      )
    );
    setSel((prev) => new Set([...prev].filter((id) => !set.has(id))));
    const c = r.data.cambiados;
    const sinCambio = r.data.sin_cambio;
    setHecho(
      `✓ ${nf(c)} ${c === 1 ? 'sitio marcado' : 'sitios marcados'} como comprobado${c === 1 ? '' : 's'} el ${fechaCorta(diaOk)}.` +
        (sinCambio ? ` ${nf(sinCambio)} ya estaban marcados o cambiaron antes.` : '')
    );
    const frescos = await despues();
    // Otra escritura empezó mientras se releía: su «Deshacer» ya no vale.
    if (!c || escrituraN.current !== miEscritura) return;
    if (!sinCambio) {
      setUltimoMarcado(ids);
      return;
    }
    // Hubo «sin cambio»: los de ESTA marca comparten el mismo comprobado_en
    // (now() de la transacción) y es el más reciente de los propios. Si no
    // cuadra con lo que contestó la base, no se ofrece Deshacer.
    if (!frescos) return;
    const set2 = new Set(ids);
    const propios = frescos.filter(
      (s) =>
        set2.has(s.id) &&
        s.estado === 'comprobado' &&
        s.comprobado_via === 'marca' &&
        (s.comprobado_por || '').toLowerCase() === email &&
        !!s.comprobado_en
    );
    const ultimo = propios.reduce((m, s) => ((s.comprobado_en as string) > m ? (s.comprobado_en as string) : m), '');
    const deEsta = propios.filter((s) => s.comprobado_en === ultimo).map((s) => s.id);
    if (deEsta.length === c) setUltimoMarcado(deEsta);
  };

  /** Quita la marca de lo último que se marcó aquí y dice lo que contestó la base. */
  const deshacer = async () => {
    // Solo lo que sigue marcado por esta persona: si alguien ya lo cambió,
    // no se toca (y la base no rechaza el lote por un sitio ajeno).
    const ids = ultimoMarcado.filter((id) => {
      const s = porId.get(id);
      return !s || (s.estado === 'comprobado' && s.comprobado_via === 'marca' && (s.comprobado_por || '').toLowerCase() === email);
    });
    if (!ids.length) {
      olvidarUltimo();
      setHecho('Nada que deshacer: esos sitios ya cambiaron.');
      return;
    }
    setErr('');
    setHecho('');
    const r = await correr('Deshaciendo…', () => marcarSitios(ids, false, null));
    if (!r) return;
    if (!r.ok) {
      // Se queda para reintentar; si fue sin red, la relectura dirá qué quedó.
      setErr(textoFallaEscrituraComp(r));
      if (r.sinRed) despues();
      return;
    }
    olvidarUltimo();
    const c = r.data.cambiados;
    setHecho(
      `✓ Deshecho: ${nf(c)} ${c === 1 ? 'sitio volvió' : 'sitios volvieron'} a pendientes.` +
        (r.data.sin_cambio ? ` ${nf(r.data.sin_cambio)} sin cambio.` : '')
    );
    despues();
  };

  const quitarMarca = async () => {
    const ids = selQuitar.map((s) => s.id);
    if (!ids.length) return;
    setErr('');
    setHecho('');
    olvidarUltimo();
    const r = await correr('Quitando marca…', () => marcarSitios(ids, false, null));
    if (!r) return;
    if (!r.ok) {
      setErr(textoFallaEscrituraComp(r));
      if (r.sinRed) despues();
      return;
    }
    const set = new Set(ids);
    setSel((prev) => new Set([...prev].filter((id) => !set.has(id))));
    const c = r.data.cambiados;
    setHecho(`✓ Se quitó la marca a ${nf(c)} ${c === 1 ? 'sitio' : 'sitios'}: vuelven a pendientes.` + (r.data.sin_cambio ? ` ${nf(r.data.sin_cambio)} sin cambio.` : ''));
    despues();
  };

  const cancelar = async () => {
    const ids = selCancelar.map((s) => s.id);
    const m = motivo.trim();
    if (!ids.length) return;
    if (!m) {
      setErr('Escribe el motivo de la cancelación.');
      return;
    }
    setErr('');
    setHecho('');
    olvidarUltimo();
    const r = await correr('Cancelando…', () => cancelarSitios(ids, m));
    if (!r) return;
    if (!r.ok) {
      setErr(textoFallaEscrituraComp(r));
      if (r.sinRed) despues();
      return;
    }
    const set = new Set(ids);
    setSel((prev) => new Set([...prev].filter((id) => !set.has(id))));
    setPanel(null);
    setMotivo('');
    const c = r.data.cambiados;
    setHecho(
      `✓ ${nf(c)} ${c === 1 ? 'sitio cancelado' : 'sitios cancelados'} («${m}»): ya no cuentan para la meta.` +
        (r.data.sin_cambio ? ` ${nf(r.data.sin_cambio)} sin cambio.` : '') +
        textoTomas(r.data)
    );
    despues();
  };

  const restaurar = async () => {
    const ids = selRestaurar.map((s) => s.id);
    if (!ids.length) return;
    setErr('');
    setHecho('');
    olvidarUltimo();
    const r = await correr('Regresando…', () => restaurarSitios(ids));
    if (!r) return;
    if (!r.ok) {
      setErr(textoFallaEscrituraComp(r));
      if (r.sinRed) despues();
      return;
    }
    const set = new Set(ids);
    setSel((prev) => new Set([...prev].filter((id) => !set.has(id))));
    const c = r.data.cambiados;
    setHecho(
      `✓ ${nf(c)} ${c === 1 ? 'sitio regresó' : 'sitios regresaron'} a pendientes.` +
        (r.data.sin_cambio ? ` ${nf(r.data.sin_cambio)} sin cambio.` : '') +
        textoTomas(r.data)
    );
    despues();
  };

  const agregar = async () => {
    const lista = partirClavesTexto(claves);
    if (!lista.length) {
      setErr('Escribe las columnas a agregar (por ejemplo 448, 512).');
      return;
    }
    setErr('');
    setHecho('');
    olvidarUltimo();
    const r = await correr('Agregando columnas…', () => agregarSitios(camp.id, lista));
    if (!r) return;
    if (!r.ok) {
      setErr(textoFallaEscrituraComp(r));
      if (r.sinRed) despues();
      return;
    }
    setPanel(null);
    setClaves('');
    const a = r.data.agregados;
    setHecho(
      `✓ ${nf(a)} ${a === 1 ? 'columna agregada' : 'columnas agregadas'}.` +
        (r.data.ya_estaban ? ` ${nf(r.data.ya_estaban)} ya estaban en la campaña.` : '') +
        textoTomas(r.data)
    );
    if (a) setFiltro('pendientes');
    despues();
  };

  // ---- Datos de la campaña (solo quien gestiona) ---------------------------
  // Arte, especificación, cliente, vendedor y ejecutivo: cuando la fuente no
  // los trae, la Asignación salía sin ARTES ni VENDEDOR y no había dónde
  // capturarlos (revisión 2, punta-a-punta-4). comp_editar_campanas los
  // guarda en editado_app: la próxima carga no los pisa. Vacío = null, que
  // los regresa a lo que diga la carga.
  const [datos, setDatos] = useState<BorradorDatos>(() => datosDe(props.campana));
  const abrirDatos = () => {
    setErr('');
    setDatos(datosDe(camp));
    setPanel(panel === 'datos' ? null : 'datos');
  };
  const cambiosDatos = (): CambiosCampana => {
    const antes = datosDe(camp);
    const c: CambiosCampana = {};
    const txt = (k: 'cliente' | 'vendedor' | 'administrador' | 'especificacion') => {
      const v = datos[k].trim();
      if (v !== antes[k].trim()) c[k] = v || null;
    };
    txt('cliente');
    txt('vendedor');
    txt('administrador');
    txt('especificacion');
    if (datos.arte !== antes.arte) c.arte = datos.arte || null;
    return c;
  };
  const nCambiosDatos = Object.keys(cambiosDatos()).length;
  const guardarDatos = async () => {
    const cambios = cambiosDatos();
    if (!Object.keys(cambios).length) return;
    setErr('');
    setHecho('');
    olvidarUltimo();
    const r = await correr('Guardando datos…', () => editarCampanas([camp.id], cambios));
    if (!r) return;
    if (!r.ok) {
      setErr(textoFallaEscrituraComp(r));
      if (r.sinRed) despues();
      return;
    }
    setPanel(null);
    setHecho(
      r.data.cambiadas
        ? '✓ Datos guardados: salen así en los Excel y la próxima carga no los pisa.'
        : r.data.cerradas_omitidas
          ? 'No se guardó: la campaña está cerrada.'
          : 'Sin cambios.'
    );
    despues();
  };

  // ---- Cerrar --------------------------------------------------------------
  const ocupadoAqui = ocupado != null;
  const cerrar = () => {
    if (ocupadoAqui) return;
    onCerrar();
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !panel) cerrar();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  // ---- Render ----------------------------------------------------------------
  const es24 = esMedio24h(camp.unidad) || esMedio24h(camp.medio);
  const entrega = textoEntrega(camp.entrega_tipo);
  const titulo = camp.version ? `${camp.campana} · ${camp.version}` : camp.campana;
  const nSel = elegidos.length;
  /** Botones chicos con área táctil de 44 px en el teléfono (revisión 2, uso-9). */
  const tactil = telefono ? { minHeight: 44 } : undefined;

  const fila = (s: SitioComp) => {
    const elegido = sel.has(s.id) && accionable(s);
    const puede = accionable(s);
    const tramos = Array.isArray(s.tramos) && s.tramos.length > 1 ? s.tramos : null;
    const vig = tramos ? tramos.map((t) => vigenciaTexto(t.inicio, t.fin)).filter(Boolean).join(' y ') : vigenciaTexto(s.inicio, s.fin);
    const hLv = es24 ? null : horarioParaMostrar(camp.medio, s.horario_lv);
    const hSd = es24 ? null : horarioParaMostrar(camp.medio, s.horario_sd);
    const original = s.sitio_original && s.sitio_original.trim().toUpperCase() !== s.sitio_clave.toUpperCase() ? s.sitio_original.trim() : '';
    // Accesibilidad (revisión de pantallas, 23-oct-2026): el renglón ya no
    // es role=checkbox con el ✓ ADENTRO (VoiceOver leía los dos juntos y el
    // doble toque elegía en vez de marcar). Ahora la casilla y el ✓ son dos
    // botones hermanos; tocar el resto del renglón sigue eligiéndolo con el
    // dedo, como antes.
    return (
      <div
        key={s.id}
        className={'rt-fila' + (elegido ? ' elegida' : '')}
        onClick={() => alternar(s)}
        style={{ minHeight: 44, alignItems: 'center', cursor: puede ? 'pointer' : 'default', opacity: s.estado === 'cancelado' ? 0.8 : 1 }}
      >
        {puede && (
          <button
            type="button"
            role="checkbox"
            aria-checked={elegido}
            aria-label={`Elegir ${s.sitio_clave}`}
            disabled={ocupadoAqui}
            onClick={(e) => {
              e.stopPropagation();
              alternar(s);
            }}
            style={{
              // Área táctil de 44 px con la casilla de 22 al centro.
              minWidth: 44,
              minHeight: 44,
              margin: '-8px -6px -8px -10px',
              padding: 0,
              border: 'none',
              background: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              cursor: 'inherit',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                border: '2px solid ' + (elegido ? 'var(--accent)' : 'var(--line)'),
                background: elegido ? 'var(--accent)' : 'var(--panel)',
                color: 'var(--sobre-acento)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {elegido && <Check size={15} strokeWidth={3} />}
            </span>
          </button>
        )}
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div className="rt-fila-tit" style={{ textDecoration: s.estado === 'cancelado' ? 'line-through' : undefined }}>
            {s.sitio_clave}
          </div>
          <div className="rt-fila-sub">
            {[original && `en la bitácora: ${original}`, vig, hLv && `L-V ${hLv}`, hSd && `S-D ${hSd}`].filter(Boolean).join(' · ')}
          </div>
          {s.observaciones && <div className="rt-fila-sub" style={{ color: 'var(--obs-txt)' }}>{s.observaciones}</div>}
          {s.estado === 'comprobado' && (
            <div className="rt-fila-sub">
              Comprobó {nombreDe(s.comprobado_por) || 'otra persona'} · {fechaCorta(s.comprobado_dia)}
              {s.comprobado_via === 'revision' ? ' · por revisión de fotos' : ''}
            </div>
          )}
          {s.estado === 'cancelado' && (
            <div className="rt-fila-sub">
              Cancelado: {s.cancelado_motivo}
              {s.cancelado_por ? ` (${nombreDe(s.cancelado_por)})` : ''}
            </div>
          )}
          <div className="rt-fila-tags">
            <span className="pill" style={{ color: colorTono(tonoEstado[s.estado]), background: fondoTono(tonoEstado[s.estado]) }}>
              {textoEstado[s.estado]}
            </span>
            {s.tipo_venta === 'BONUS' && <span className="tag">BONUS</span>}
            {s.fuera_de_carga && <span className="tag" style={{ color: 'var(--warn)' }}>ya no viene en la carga</span>}
            {!s.en_inventario && <span className="tag">sin inventario</span>}
            {s.origen === 'app' && <span className="tag">agregado en la app</span>}
            {s.testigos && <span className="tag">testigos</span>}
          </div>
        </div>
        {puedeEscribir && marcable(s) && (
          <div className="rt-fila-acc">
            <button
              type="button"
              className="btn-icono"
              style={{ minWidth: 44, minHeight: 44, color: colorTono('verde'), border: '1px solid var(--line)', background: 'var(--panel)' }}
              aria-label={`Marcar ${s.sitio_clave} como comprobado`}
              title={`Marcar comprobado (${diaSel ? fechaCorta(diaSel) : 'sin día'})`}
              disabled={ocupadoAqui || !diaSel}
              onClick={(e) => {
                e.stopPropagation();
                marcar([s]);
              }}
            >
              <Check size={20} strokeWidth={3} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="overlay rt-overlay-full"
      onClick={(e) => {
        if (e.target === e.currentTarget) cerrar();
      }}
    >
      <div className="modal rt-armado" role="dialog" aria-modal="true" aria-label={titulo} onClick={(e) => e.stopPropagation()}>
        <div className="rt-armado-cab" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
              {camp.unidad_etiqueta}
              {camp.unidad === 'Vía Verde' ? ` · ${camp.medio}` : ''} · {etiquetaPeriodo}
            </div>
            <h3 ref={titRef} tabIndex={-1} style={{ margin: '2px 0 0', overflowWrap: 'anywhere', outline: 'none' }}>
              {titulo}
            </h3>
            {(camp.cliente || camp.vendedor) && (
              <div style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                {[camp.cliente, camp.vendedor && `Vendedor: ${camp.vendedor}`].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn-icono"
            onClick={cerrar}
            disabled={ocupadoAqui}
            aria-label="Cerrar"
            title="Cerrar"
            style={{ minWidth: 44, minHeight: 44 }}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        {/* Resumen de la campaña */}
        <div className="rt-seccion" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6, flexWrap: 'wrap' }}>
            <b style={{ flex: '1 1 auto' }}>{textoAvance(camp.comprobados, camp.meta, camp.pct)}</b>
            <PildoraLimite c={camp} />
          </div>
          <Barra pct={camp.pct} alto={10} />
          <div className="rt-fila-tags" style={{ marginTop: 8 }}>
            {camp.es_full && <span className="tag">FULL{camp.full_minutos ? ` ${camp.full_minutos} min` : ''}</span>}
            {camp.arte && <span className="tag">{camp.arte}</span>}
            {camp.tipo_venta && camp.tipo_venta !== 'VENTA' && <span className="tag">{camp.tipo_venta}</span>}
            {entrega && <span className="tag" style={{ color: 'var(--warn)' }}>{entrega}</span>}
            {es24 && <span className="tag">{HORARIO_24H}</span>}
            {camp.estatus === 'cerrada' && <span className="tag">cerrada{camp.cerrada_en ? ` el ${fechaCorta(camp.cerrada_en)}` : ''}</span>}
            {camp.retirada && <span className="tag" style={{ color: 'var(--warn)' }}>retirada</span>}
            {camp.meta_fuente !== 'sitios' && <span className="tag">meta {camp.meta_fuente === 'full' ? 'del FULL' : 'puesta por el Supervisor'}</span>}
            {camp.cancelados > 0 && <span className="tag">{nf(camp.cancelados)} cancelados</span>}
          </div>
          {camp.especificacion && (
            <div style={{ fontSize: 13, color: 'var(--obs-txt)', marginTop: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {camp.especificacion}
            </div>
          )}
          {camp.cierre_motivo && camp.estatus === 'cerrada' && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Motivo del cierre: {camp.cierre_motivo}</div>
          )}
        </div>

        {motivoLectura && <div className="banner">{motivoLectura}</div>}
        {!motivoLectura && sinPorComprobar(camp) && (
          <div className="banner">
            {TEXTO_SIN_POR_COMPROBAR}: ya no le queda nada que marcar.{' '}
            {permisos.gestiona ? 'Ciérrala en Campañas → Acciones.' : 'Pídele al Supervisor que la cierre.'}
          </div>
        )}
        {errLeer && (
          <div className="err">
            {errLeer}{' '}
            <button type="button" className="btn ghost sm" onClick={() => releer(true)}>
              <Ic i={RotateCcw} />
              Reintentar
            </button>
          </div>
        )}

        {/* Filtros */}
        <div className="rt-chips rt-segmento" role="group" aria-label="Qué sitios ver" style={{ marginBottom: 8 }}>
          {(
            [
              ['pendientes', 'Pendientes', cuenta.pendientes],
              ['comprobados', 'Comprobados', cuenta.comprobados],
              ['cancelados', 'Cancelados', cuenta.cancelados],
              ['todos', 'Todos', cuenta.todos],
            ] as const
          )
            .filter(([k, , n]) => k !== 'cancelados' || n > 0)
            .map(([k, l, n]) => (
              <button
                key={k}
                type="button"
                className={'rt-chip' + (filtro === k ? ' on' : '')}
                aria-pressed={filtro === k}
                onClick={() => {
                  setFiltro(k);
                  setLimite(LIMITE);
                }}
              >
                {l} {leido ? `(${nf(n)})` : ''}
              </button>
            ))}
        </div>
        <div className="toolbar" style={{ alignItems: 'center', marginBottom: 8 }}>
          <div style={{ position: 'relative', flex: '1 1 180px', minWidth: 0 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }}>
              <Ic i={Search} />
            </span>
            <input
              className="search"
              type="search"
              placeholder="Buscar clave o columna"
              aria-label="Buscar clave o columna"
              value={busca}
              onChange={(e) => {
                setBusca(e.target.value);
                setLimite(LIMITE);
              }}
              style={{ paddingLeft: 32, fontSize: 16 }}
            />
          </div>
          {puedeEscribir && visiblesMarcables.length > 0 && (
            <button
              type="button"
              className="btn ghost sm"
              style={tactil}
              disabled={ocupadoAqui}
              onClick={() => {
                setHecho('');
                setSel((prev) => new Set([...prev, ...visiblesMarcables.map((s) => s.id)]));
              }}
            >
              Elegir todos los pendientes ({nf(visiblesMarcables.length)})
            </button>
          )}
          {/* Para quitar marcas en lote (antes había que tocarlas una por una). */}
          {puedeEscribir && filtro === 'comprobados' && visiblesDesmarcables.length > 0 && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={ocupadoAqui}
              onClick={() => {
                setHecho('');
                setSel((prev) => new Set([...prev, ...visiblesDesmarcables.map((s) => s.id)]));
              }}
            >
              {permisos.gestiona ? 'Elegir los marcados' : 'Elegir los que marqué'} ({nf(visiblesDesmarcables.length)})
            </button>
          )}
          {nSel > 0 && (
            <button type="button" className="btn ghost sm" style={tactil} disabled={ocupadoAqui} onClick={() => setSel(new Set())}>
              Limpiar
            </button>
          )}
          {permisos.gestiona && abierta && (
            <button type="button" className="btn ghost sm" style={tactil} disabled={ocupadoAqui} onClick={abrirDatos} aria-expanded={panel === 'datos'}>
              <Ic i={Pencil} />
              Editar datos
            </button>
          )}
          {puedeAgregar && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={ocupadoAqui}
              onClick={() => {
                setErr('');
                setPanel(panel === 'agregar' ? null : 'agregar');
              }}
            >
              <Ic i={CirclePlus} />
              Agregar columnas
            </button>
          )}
        </div>

        {panel === 'datos' && permisos.gestiona && (
          <div className="rt-seccion">
            <div className="rt-seccion-tit">Datos de la campaña</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Salen en la Asignación de clientes y en las OBSERVACIONES del Formato. Lo que guardes aquí la próxima carga no lo
              pisa; deja un campo vacío para que vuelva a lo que diga la carga.
            </div>
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: telefono ? '1fr' : '1fr 1fr' }}>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="comp-dat-cliente">Cliente</label>
                <input id="comp-dat-cliente" value={datos.cliente} onChange={(e) => setDatos({ ...datos, cliente: e.target.value })} style={{ fontSize: 16 }} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="comp-dat-arte">Arte</label>
                <select
                  id="comp-dat-arte"
                  value={datos.arte}
                  onChange={(e) => setDatos({ ...datos, arte: e.target.value as BorradorDatos['arte'] })}
                  style={{ fontSize: 16 }}
                >
                  <option value="">Sin dato (lo que diga la carga)</option>
                  <option value="NUEVO">NUEVO</option>
                  <option value="REPITE">REPITE</option>
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="comp-dat-vendedor">Vendedor</label>
                <input id="comp-dat-vendedor" value={datos.vendedor} onChange={(e) => setDatos({ ...datos, vendedor: e.target.value })} style={{ fontSize: 16 }} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="comp-dat-admin">Ejecutivo</label>
                <input
                  id="comp-dat-admin"
                  value={datos.administrador}
                  onChange={(e) => setDatos({ ...datos, administrador: e.target.value })}
                  style={{ fontSize: 16 }}
                />
              </div>
            </div>
            <div className="field" style={{ margin: '8px 0' }}>
              <label htmlFor="comp-dat-espec">Especificación (instrucciones para el monitorista)</label>
              <textarea
                id="comp-dat-espec"
                rows={3}
                value={datos.especificacion}
                onChange={(e) => setDatos({ ...datos, especificacion: e.target.value })}
                style={{ fontSize: 16 }}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost sm" style={tactil} onClick={() => setPanel(null)} disabled={ocupadoAqui}>
                Cancelar
              </button>
              <button type="button" className="btn sm" style={tactil} onClick={guardarDatos} disabled={ocupadoAqui || !nCambiosDatos}>
                {ocupado === 'Guardando datos…' && <span className="spinner" />}
                Guardar{nCambiosDatos ? ` (${nCambiosDatos})` : ''}
              </button>
            </div>
          </div>
        )}

        {panel === 'agregar' && (
          <div className="rt-seccion">
            <div className="rt-seccion-tit">Agregar columnas a este FULL</div>
            <div className="field" style={{ marginBottom: 8 }}>
              <label htmlFor="comp-claves">Columnas o pórticos (separa con comas o espacios)</label>
              <textarea
                id="comp-claves"
                rows={2}
                value={claves}
                placeholder={camp.medio === 'Pórtico' ? 'POR_0008, POR_0012' : '448, 512, 1003'}
                onChange={(e) => setClaves(e.target.value)}
                style={{ fontSize: 16 }}
              />
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Deben ser {camp.medio === 'Pórtico' ? 'pórticos' : 'columnas'} activas de CDMX. Si una clave no sirve, no se agrega
              ninguna y te decimos cuál.
              {partirClavesTexto(claves).length ? ` Vas a agregar ${partirClavesTexto(claves).length}.` : ''}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost sm" onClick={() => setPanel(null)} disabled={ocupadoAqui}>
                Cancelar
              </button>
              <button type="button" className="btn sm" onClick={agregar} disabled={ocupadoAqui || !partirClavesTexto(claves).length}>
                {ocupado === 'Agregando columnas…' && <span className="spinner" />}
                Agregar
              </button>
            </div>
          </div>
        )}

        {/* Cancelar con motivo: arriba de la lista y no en el pie fijo
            (revisión de pantallas, 23-oct-2026). En el pie, con el teclado
            abierto en un iPhone chico, el campo quedaba tapado. */}
        {puedeEscribir && panel === 'cancelar' && (
          <div className="rt-seccion" ref={panelCancelarRef} style={{ scrollMarginTop: 8 }}>
            <div className="rt-seccion-tit">
              Cancelar {nf(selCancelar.length)} {selCancelar.length === 1 ? 'sitio' : 'sitios'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              Un sitio cancelado no se comprueba y deja de contar para la meta. Se puede regresar después.
            </div>
            <div className="rt-chips" style={{ marginBottom: 6 }}>
              {MOTIVOS.map((m) => (
                <button key={m} type="button" className={'rt-chip' + (motivo === m ? ' on' : '')} onClick={() => setMotivo(m)}>
                  {m}
                </button>
              ))}
            </div>
            <div className="field" style={{ marginBottom: 8 }}>
              <label htmlFor="comp-motivo">Motivo</label>
              <input id="comp-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} style={{ fontSize: 16 }} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost sm" style={tactil} onClick={() => setPanel(null)} disabled={ocupadoAqui}>
                No cancelar
              </button>
              <button type="button" className="btn sm warn" style={tactil} onClick={cancelar} disabled={ocupadoAqui || !motivo.trim() || !selCancelar.length}>
                {ocupado === 'Cancelando…' && <span className="spinner" />}
                Cancelar {nf(selCancelar.length)}
              </button>
            </div>
          </div>
        )}

        {/* Sitios */}
        {!leido && !errLeer ? (
          <div className="phint">
            <span className="spinner" />
            Leyendo sitios…
          </div>
        ) : (
          <div className={leyendo && leido ? 'recargando' : undefined} style={{ display: 'grid', gap: 6 }}>
            {visibles.length === 0 && leido && (
              <div style={{ color: 'var(--muted)', fontSize: 13, padding: '14px 4px', textAlign: 'center' }}>
                {busca
                  ? 'Ningún sitio coincide con la búsqueda.'
                  : filtro === 'pendientes'
                    ? cuenta.todos
                      ? '¡Ya no hay pendientes en esta campaña!'
                      : camp.es_full
                        ? 'Este FULL todavía no tiene columnas. Agrégalas con «Agregar columnas».'
                        : 'Esta campaña no tiene sitios.'
                    : 'No hay sitios aquí.'}
              </div>
            )}
            {visibles.slice(0, limite).map(fila)}
            {visibles.length > limite && (
              <button type="button" className="btn ghost" onClick={() => setLimite((n) => n + LIMITE)}>
                Ver {nf(Math.min(LIMITE, visibles.length - limite))} más (faltan {nf(visibles.length - limite)})
              </button>
            )}
          </div>
        )}

        {/* Pie fijo: día y lote */}
        {puedeEscribir && (
          <div className="rt-pie" style={{ justifyContent: 'flex-start' }}>
            {err && (
              <div className="err" style={{ flex: '1 1 100%', margin: 0 }}>
                {err}
              </div>
            )}
            {hecho && !err && (
              <div className="ok-msg" role="status" style={{ flex: '1 1 100%', margin: 0 }}>
                {hecho}
              </div>
            )}
            {/* Deshacer no depende del mensaje: tocar un renglón lo borraba
                y con él el botón (revisión 2, uso-9). */}
            {ultimoMarcado.length > 0 && (
              <button type="button" className="btn ghost sm" style={tactil} disabled={ocupadoAqui} onClick={deshacer}>
                {ocupado === 'Deshaciendo…' && <span className="spinner" />}
                <Ic i={Undo2} />
                Deshacer la última marca ({nf(ultimoMarcado.length)})
              </button>
            )}
            {/* Con el panel de cancelar abierto el Día no sirve y el pie
                tapaba el motivo en el iPhone (revisión 2, uso-4). */}
            {!camp.retirada && panel !== 'cancelar' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)', flex: telefono ? '1 1 100%' : '0 1 auto' }}>
                Día
                <select
                  value={diaSel}
                  onChange={(e) => setDia(e.target.value)}
                  disabled={ocupadoAqui || !dias.length}
                  aria-label="Día en que se comprobó"
                  style={{ fontSize: 16, flex: '1 1 auto', width: 'auto', minWidth: 0 }}
                >
                  {!dias.length && <option value="">El periodo no ha empezado</option>}
                  {dias.map((d, i) => (
                    <option key={d} value={d}>
                      {etiquetaDiaMarca(d, i)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span style={{ flex: '1 1 auto' }} />
            {nSel === 0 && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {camp.retirada ? 'Toca un sitio para elegirlo.' : 'Toca los sitios para elegirlos, o ✓ para marcar uno.'}
              </span>
            )}
            {selRestaurar.length > 0 && (
              <button type="button" className="btn ghost sm" style={tactil} disabled={ocupadoAqui} onClick={restaurar}>
                {ocupado === 'Regresando…' && <span className="spinner" />}
                <Ic i={RotateCcw} />
                Regresar ({nf(selRestaurar.length)})
              </button>
            )}
            {selCancelar.length > 0 && (
              <button
                type="button"
                className="btn ghost sm"
                style={tactil}
                disabled={ocupadoAqui}
                aria-expanded={panel === 'cancelar'}
                onClick={() => {
                  setErr('');
                  setPanel(panel === 'cancelar' ? null : 'cancelar');
                }}
              >
                Cancelar sitio ({nf(selCancelar.length)})…
              </button>
            )}
            {selQuitar.length > 0 && (
              <button type="button" className="btn ghost sm" style={tactil} disabled={ocupadoAqui} onClick={quitarMarca}>
                {ocupado === 'Quitando marca…' && <span className="spinner" />}
                <Ic i={Undo2} />
                Quitar marca ({nf(selQuitar.length)})
              </button>
            )}
            {selMarcar.length > 0 && (
              <button type="button" className="btn ok" style={tactil} disabled={ocupadoAqui || !diaSel} onClick={() => marcar(selMarcar, true)}>
                {ocupado?.startsWith('Marcando') && <span className="spinner" />}
                <Ic i={Check} />
                Marcar {nf(selMarcar.length)} {selMarcar.length === 1 ? 'comprobado' : 'comprobados'}
              </button>
            )}
          </div>
        )}
        {!puedeEscribir && <div style={{ height: 8 }} />}
      </div>
    </div>
  );
}
