// ============================================================
// src/lib/comprobacionesApi.ts
// Acceso a la base de Comprobaciones, fase 2 (Erik, 23-oct-2026).
//
// QUÉ ES. Una función tipada por cada RPC comp_ de
// supabase/migrations/20261023100100_comp_base.sql y las lecturas
// paginadas de sus vistas y tablas. Las pantallas (ComprobacionesView y sus
// pestañas) NO llaman a sb directo: así los nombres, las firmas y el manejo
// de errores viven en un solo lugar.
//
// REGLAS (las mismas del resto de la app):
//   · Toda escritura pasa por una RPC security definer; las tablas solo
//     tienen SELECT. La RLS niega en SILENCIO (una lectura vacía no es un
//     error), por eso cada escritura devuelve sus conteos y la pantalla
//     DEBE enseñarlos («✓ 12 asignadas», «3 cerradas se saltaron»).
//   · PostgREST corta en 1,000 filas sin avisar: toda lectura de lista va
//     paginada con orden estable (traerTodo).
//   · Sin red ≠ error real: `sinRed` distingue «no hubo señal o tardó» de
//     «la base contestó que no». En una escritura sin respuesta NO se sabe
//     si se guardó: el texto lo dice y pide recargar antes de repetir.
//   · Los mensajes de las RPC ya vienen en español claro (raise exception);
//     aquí solo se traducen los de Postgres/PostgREST (candado ocupado,
//     función que falta porque la migración no está aplicada…).
// ============================================================

import { sb } from './supabase';
import { tope } from './envios';
import { etiquetaCatorcena } from './catorcena';
import { hoyCdmx, MEDIOS_DE_UNIDAD, type MedioComp, type UnidadComp } from './comprobaciones';
import type {
  CampanaCargada,
  CampanaContrato,
  EspacioVV,
  FuenteComp,
  SitioContrato,
  TipoVenta,
  VVCampanaFila,
  VVOcupacionFila,
  VVPautaFila,
} from './bitacoraComp';
import { leerPlantilla, type PlantillaToma } from './plantillasComp';
// La clasificación de fallas vive en fallasComp.ts (revisión del 26-oct-2026,
// regresiones-1); aquí se vuelve a exportar para las pantallas.
import {
  clasificarErrorComp,
  codigoFallaComp,
  textoFallaF3,
  type CodigoFallaComp,
  type ErrorPg,
  type ResultadoComp,
} from './fallasComp';
export {
  clasificarErrorComp,
  codigoFallaComp,
  esRespuestaDeBase,
  textoErrorComp,
  textoFallaComp,
  textoFallaEscrituraComp,
  textoFallaF3,
  type CodigoFallaComp,
  type ResultadoComp,
} from './fallasComp';

// ------------------------------------------------------------
// Resultado común
// ------------------------------------------------------------

/** Tope por página de una lectura: una red lenta corta y avisa. */
export const TOPE_LECTURA_COMP_MS = 20000;
/**
 * Tope de una escritura. Las RPC llevan lock_timeout de 3 s y la base corta
 * a los 8 s (statement_timeout); 30 s cubre la carga completa de Vía Verde
 * con una red de campo.
 */
export const TOPE_ESCRITURA_COMP_MS = 30000;
/** Tamaño de página de PostgREST (el tope duro). */
const PAGINA = 1000;
/** Ids por `.in()`: más largo arma URLs que algunos proxys rechazan. */
const IDS_POR_TROZO = 200;

type RespPg = { data: unknown; error: ErrorPg; status: number };

/** Clasifica un error con su código (para deRespuesta y deExcepcion). */
function falla(error: unknown, status?: number | null): { ok: false; error: string; sinRed: boolean; codigo: CodigoFallaComp } {
  const c = clasificarErrorComp(error, status);
  return { ok: false, ...c, codigo: codigoFallaComp(error, status, c.sinRed) };
}

/** Clasifica una respuesta de postgrest-js. */
function deRespuesta<T>(r: RespPg): ResultadoComp<T> {
  if (r.error || r.status === 0) return falla(r.error, r.status);
  return { ok: true, data: r.data as T };
}

function deExcepcion<T>(e: unknown): ResultadoComp<T> {
  return falla(e);
}

/** Llama una RPC con tope. Nunca lanza. */
async function rpc<T>(nombre: string, args: Record<string, unknown>, topeMs: number): Promise<ResultadoComp<T>> {
  try {
    const r = (await sb.rpc(nombre, args).abortSignal(tope(topeMs))) as unknown as RespPg;
    return deRespuesta<T>(r);
  } catch (e) {
    return deExcepcion<T>(e);
  }
}

const escribir = <T>(nombre: string, args: Record<string, unknown>) => rpc<T>(nombre, args, TOPE_ESCRITURA_COMP_MS);
const leerRpc = <T>(nombre: string, args: Record<string, unknown>) => rpc<T>(nombre, args, TOPE_LECTURA_COMP_MS);

/**
 * Trae TODAS las filas de una consulta, de 1000 en 1000. La consulta DEBE
 * llevar un orden estable (si no, una página puede repetir o saltar filas).
 * Si una página falla, falla todo: una lista a medias haría creer que lo
 * que falta no existe.
 */
async function traerTodo<T>(
  pagina: (desde: number, hasta: number, senal: AbortSignal) => PromiseLike<unknown>,
  maxPaginas = 60
): Promise<ResultadoComp<T[]>> {
  const filas: T[] = [];
  for (let i = 0; i < maxPaginas; i++) {
    let r: RespPg;
    try {
      r = (await pagina(i * PAGINA, i * PAGINA + PAGINA - 1, tope(TOPE_LECTURA_COMP_MS))) as RespPg;
    } catch (e) {
      return deExcepcion<T[]>(e);
    }
    const res = deRespuesta<T[] | null>(r);
    if (!res.ok) return res;
    const d = res.data || [];
    filas.push(...d);
    if (d.length < PAGINA) return { ok: true, data: filas };
  }
  return { ok: false, error: `La lista pasa de ${maxPaginas * PAGINA} filas; filtra más.`, sinRed: false };
}

function trozos<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Lee por trozos de ids (para `.in()`), cada trozo paginado. */
async function porTrozos<T>(
  ids: number[],
  consulta: (trozo: number[], desde: number, hasta: number, senal: AbortSignal) => PromiseLike<unknown>
): Promise<ResultadoComp<T[]>> {
  const unicos = [...new Set(ids.filter((x) => Number.isFinite(x)))];
  const filas: T[] = [];
  for (const t of trozos(unicos, IDS_POR_TROZO)) {
    const r = await traerTodo<T>((d, h, s) => consulta(t, d, h, s));
    if (!r.ok) return r;
    filas.push(...r.data);
  }
  return { ok: true, data: filas };
}

// ------------------------------------------------------------
// Tipos de fila (columnas reales de comp_base.sql)
// ------------------------------------------------------------

export type TipoPeriodo = 'catorcena' | 'mes';
export type EstatusCampana = 'abierta' | 'cerrada';
export type EntregaTipo = 'enviar' | 'lista_sin_enviar' | 'no_se_comprueba';
export type EstadoSitio = 'pendiente' | 'comprobado' | 'cancelado';
export type EstadoTomaComp = 'pendiente' | 'por_revisar' | 'comprobada' | 'regresada' | 'cancelada';
export type TurnoToma = 'matutino' | 'vespertino' | 'campo';

/** comp_periodos. */
export type PeriodoComp = {
  id: number;
  unidad: UnidadComp;
  tipo: TipoPeriodo;
  anio: number;
  numero: number;
  fecha_inicio: string;
  fecha_fin: string;
  /** 'Cat-18 · 2026' o 'Agosto 2026'. */
  etiqueta: string;
  creado_por: string;
  creado_en: string;
};

/** Plan guardado (comp_plan_normal). Se lee con leerPlan de comprobaciones.ts. */
export type PlanGuardado = { tipo: string; cada_n?: number | null; fechas?: string[] | null; incluir_comprobados?: boolean } | null;

/** vw_comp_campanas: una fila por campaña-versión (= «Asignación de clientes»). */
export type VwCampana = {
  id: number;
  periodo_id: number;
  unidad: UnidadComp;
  /** 'Ecovallas Digital', 'Biobox' o 'Vía Verde'. */
  unidad_etiqueta: string;
  medio: MedioComp;
  fuente: FuenteComp;
  origen_ref: string | null;
  cliente: string | null;
  campana: string;
  version: string;
  campana_llave: string;
  version_llave: string;
  vendedor: string | null;
  administrador: string | null;
  quantum: string | null;
  mediamonitor: boolean | null;
  arte: 'NUEVO' | 'REPITE' | null;
  especificacion: string | null;
  inicio: string | null;
  fin: string | null;
  es_full: boolean;
  full_minutos: number | null;
  meta_full: number | null;
  meta_app: number | null;
  analista_email: string | null;
  asignacion_origen: 'archivo' | 'app' | null;
  asignado_por: string | null;
  asignado_en: string | null;
  sugerido_email: string | null;
  fecha_limite: string | null;
  banderas: string[];
  entrega_tipo: EntregaTipo;
  plan_tomas: PlanGuardado;
  retirada: boolean;
  retirada_en: string | null;
  reemplazada_por: number | null;
  estatus: EstatusCampana;
  cerrada_por: string | null;
  cerrada_en: string | null;
  cierre_motivo: string | null;
  editado_app: string[];
  cargado_por: string | null;
  cargado_en: string | null;
  creado_en: string;
  actualizado_en: string;
  periodo_tipo: TipoPeriodo;
  periodo_etiqueta: string;
  periodo_inicio: string;
  periodo_fin: string;
  sitios_total: number;
  sitios_activos: number;
  comprobados: number;
  pendientes: number;
  cancelados: number;
  fuera_de_carga: number;
  sin_inventario: number;
  comprobados_hoy: number;
  tipo_venta: 'VENTA' | 'BONUS' | 'MIXTA' | null;
  tomas_total: number;
  tomas_pendientes: number;
  tomas_editadas: number;
  meta: number;
  meta_fuente: 'app' | 'full' | 'sitios';
  pct: number | null;
  completa: boolean | null;
  fecha_limite_efectiva: string | null;
  fecha_limite_fuente: 'app' | 'regla' | 'fin';
  dias_restantes: number | null;
};

/** comp_sitios: campaña-versión × sitio (la unidad de la venta y de la marca). */
export type SitioComp = {
  id: number;
  campana_id: number;
  unidad: UnidadComp;
  sitio_clave: string;
  sitio_original: string | null;
  vendor_face_id: string | null;
  site_id: string | null;
  espacio_vv: string | null;
  en_inventario: boolean;
  inicio: string | null;
  fin: string | null;
  tramos: { inicio: string | null; fin: string | null }[] | null;
  horario_lv: string | null;
  horario_sd: string | null;
  tipo_venta: TipoVenta | null;
  testigos: boolean | null;
  observaciones: string | null;
  estado: EstadoSitio;
  comprobado_dia: string | null;
  comprobado_en: string | null;
  comprobado_por: string | null;
  comprobado_via: 'marca' | 'revision' | null;
  cancelado_motivo: string | null;
  cancelado_por: string | null;
  cancelado_en: string | null;
  origen: 'carga' | 'app';
  fuera_de_carga: boolean;
  creado_en: string;
  actualizado_en: string;
};

/** vw_comp_tomas: un renglón del «Formato general» con su campaña y su sitio. */
export type VwToma = {
  id: number;
  campana_id: number;
  sitio_id: number;
  unidad: UnidadComp;
  medio: MedioComp;
  periodo_id: number;
  periodo_etiqueta: string;
  cliente: string | null;
  campana: string;
  version: string;
  vendedor: string | null;
  administrador: string | null;
  quantum: string | null;
  mediamonitor: boolean | null;
  especificacion: string | null;
  arte: 'NUEVO' | 'REPITE' | null;
  es_full: boolean;
  analista_email: string | null;
  campana_estatus: EstatusCampana;
  campana_retirada: boolean;
  sitio_clave: string;
  sitio_original: string | null;
  vendor_face_id: string | null;
  site_id: string | null;
  espacio_vv: string | null;
  en_inventario: boolean;
  sitio_inicio: string | null;
  sitio_fin: string | null;
  sitio_tramos: { inicio: string | null; fin: string | null }[] | null;
  tipo_venta: TipoVenta | null;
  testigos: boolean | null;
  sitio_estado: EstadoSitio;
  sitio_fuera_de_carga: boolean;
  /**
   * comp_sitios.comprobado_dia. NO está en la vista: lo llena leerTomas
   * (completarDiaComprobado) solo en campañas cuyo plan lleva
   * incluir_comprobados; en las demás llega undefined y tomaCubiertaPorSitio
   * toma como cubierta toda toma pendiente de un sitio comprobado.
   */
  sitio_comprobado_dia?: string | null;
  fecha: string;
  /** 1 = lunes … 7 = domingo. */
  dia_semana: number;
  fecha_plan: string | null;
  horario_texto: string | null;
  observaciones: string | null;
  notas: string | null;
  comprobacion: string;
  turno: TurnoToma | null;
  ruta_id: number | null;
  ruta_numero: number | null;
  monitorista_email: string | null;
  origen: 'plan' | 'app';
  estado: EstadoTomaComp;
  baja_auto: boolean;
  editado_por: string | null;
  editado_en: string | null;
  creado_en: string;
};

/** vw_comp_diaria: sitios que alguien marcó un día en una campaña. */
export type VwDiaria = {
  campana_id: number;
  unidad: UnidadComp;
  medio: MedioComp;
  periodo_id: number;
  /** Quien lleva la campaña HOY. */
  analista_email: string | null;
  /** Quien marcó (el crédito). */
  comprobado_por: string | null;
  dia: string;
  sitios: number;
};

/** vw_comp_avance_analista: carga (quien lleva) y crédito (quien marcó). */
export type VwAvanceAnalista = {
  unidad: UnidadComp;
  periodo_id: number;
  /** null = «Sin analista». */
  analista_email: string | null;
  campanas: number;
  abiertas: number;
  meta: number;
  pendientes: number;
  comprobados_en_sus_campanas: number;
  comprobados: number;
  hoy: number;
  vencidas: number;
};

export type TipoRegla =
  | 'full_porcentaje'
  | 'avances_por_sitios'
  | 'dias_limite_por_sitios'
  | 'pendientes_dias_antes'
  | 'toma_especial_cliente'
  | 'texto_general';

/** comp_reglas: datos editables, SIN CONFIRMAR con el Supervisor. */
export type ReglaComp = {
  id: number;
  /** null = todas las unidades (solo el manager las edita). */
  unidad: UnidadComp | null;
  tipo: TipoRegla;
  desde: number | null;
  hasta: number | null;
  valor: number | null;
  valor_texto: string | null;
  cliente_patron: string | null;
  confirmada: boolean;
  notas: string | null;
  actualizada_por: string | null;
  actualizada_en: string;
};

/** comp_movimientos: bitácora de lotes (solo la lee el Supervisor). */
export type MovimientoComp = {
  id: number;
  accion: string;
  unidad: string | null;
  periodo_id: number | null;
  campana_ids: number[] | null;
  sitio_ids: number[] | null;
  n: number;
  de_email: string | null;
  a_email: string | null;
  detalle: Record<string, unknown> | null;
  por: string;
  en: string;
};

/** comp_equipo(p_unidad): analistas (asignables) y supervisores de la unidad. */
export type MiembroEquipo = { email: string; nombre: string; rol: 'analista' | 'supervisor'; asignable: boolean };

/** comp_monitoristas(p_unidad). */
export type MonitoristaComp = { email: string; nombre: string };

// ------------------------------------------------------------
// Lecturas
// ------------------------------------------------------------

const COLS_PERIODO = 'id,unidad,tipo,anio,numero,fecha_inicio,fecha_fin,etiqueta,creado_por,creado_en';

/** Periodos ya armados de una unidad, el más reciente primero. */
export function leerPeriodos(unidad: UnidadComp): Promise<ResultadoComp<PeriodoComp[]>> {
  return traerTodo<PeriodoComp>((d, h, s) =>
    sb
      .from('comp_periodos')
      .select(COLS_PERIODO)
      .eq('unidad', unidad)
      .order('fecha_inicio', { ascending: false })
      .order('id', { ascending: false })
      .range(d, h)
      .abortSignal(s)
  );
}

/**
 * Campañas de un periodo (vw_comp_campanas). La RLS ya acota: el analista
 * solo recibe las suyas; `analistaEmail` filtra además en la consulta
 * (Victor es Supervisor Y analista: en «Mis campañas» solo las suyas).
 */
export function leerCampanas(f: {
  periodoId: number;
  unidad?: UnidadComp;
  medio?: MedioComp;
  analistaEmail?: string | null;
  ids?: number[];
}): Promise<ResultadoComp<VwCampana[]>> {
  const base = (d: number, h: number, s: AbortSignal, ids?: number[]) => {
    let q = sb.from('vw_comp_campanas').select('*').eq('periodo_id', f.periodoId);
    if (f.unidad) q = q.eq('unidad', f.unidad);
    if (f.medio) q = q.eq('medio', f.medio);
    if (f.analistaEmail) q = q.eq('analista_email', f.analistaEmail.trim().toLowerCase());
    if (ids) q = q.in('id', ids);
    return q.order('id').range(d, h).abortSignal(s);
  };
  if (f.ids) return porTrozos<VwCampana>(f.ids, (t, d, h, s) => base(d, h, s, t));
  return traerTodo<VwCampana>((d, h, s) => base(d, h, s));
}

/** Una campaña (para refrescar el detalle después de una escritura). */
export async function leerCampana(id: number): Promise<ResultadoComp<VwCampana | null>> {
  try {
    const r = (await sb
      .from('vw_comp_campanas')
      .select('*')
      .eq('id', id)
      .abortSignal(tope(TOPE_LECTURA_COMP_MS))
      .maybeSingle()) as unknown as RespPg;
    return deRespuesta<VwCampana | null>(r);
  } catch (e) {
    return deExcepcion(e);
  }
}

/** Sitios de unas campañas (comp_sitios), por trozos y paginados. */
export function leerSitios(f: {
  campanaIds: number[];
  estado?: EstadoSitio;
  origen?: 'carga' | 'app';
  sinFueraDeCarga?: boolean;
}): Promise<ResultadoComp<SitioComp[]>> {
  return porTrozos<SitioComp>(f.campanaIds, (t, d, h, s) => {
    let q = sb.from('comp_sitios').select('*').in('campana_id', t);
    if (f.estado) q = q.eq('estado', f.estado);
    if (f.origen) q = q.eq('origen', f.origen);
    if (f.sinFueraDeCarga) q = q.eq('fuera_de_carga', false);
    return q.order('id').range(d, h).abortSignal(s);
  });
}

/**
 * Renglones del Formato general (vw_comp_tomas) de un periodo. Vía Verde
 * pasa de 5,000 renglones: siempre paginado. Por omisión SIN las quitadas
 * (estado 'cancelada'), que es lo que lleva el Excel.
 */
export async function leerTomas(f: {
  periodoId: number;
  unidad?: UnidadComp;
  medio?: MedioComp;
  campanaIds?: number[];
  monitoristaEmail?: string | null;
  desde?: string;
  hasta?: string;
  incluirQuitadas?: boolean;
}): Promise<ResultadoComp<VwToma[]>> {
  const base = (d: number, h: number, s: AbortSignal, ids?: number[]) => {
    let q = sb.from('vw_comp_tomas').select('*').eq('periodo_id', f.periodoId);
    if (f.unidad) q = q.eq('unidad', f.unidad);
    if (f.medio) q = q.eq('medio', f.medio);
    if (ids) q = q.in('campana_id', ids);
    if (f.monitoristaEmail) q = q.eq('monitorista_email', f.monitoristaEmail.trim().toLowerCase());
    if (f.desde) q = q.gte('fecha', f.desde);
    if (f.hasta) q = q.lte('fecha', f.hasta);
    if (!f.incluirQuitadas) q = q.neq('estado', 'cancelada');
    return q.order('id').range(d, h).abortSignal(s);
  };
  const r = f.campanaIds
    ? await porTrozos<VwToma>(f.campanaIds, (t, d, h, s) => base(d, h, s, t))
    : await traerTodo<VwToma>((d, h, s) => base(d, h, s), 100);
  if (!r.ok) return r;
  return completarDiaComprobado(r.data);
}

/**
 * vw_comp_tomas no trae comp_sitios.comprobado_dia (revisión 2, contrato-2;
 * la vista está en producción y no se edita). Sin ese día, tomaCubiertaPorSitio
 * da por cubierta TODA toma por hacer de un sitio comprobado, y la opción del
 * plan «también los comprobados» (R11) no servía en los Excel. Aquí se llena
 * SOLO en las campañas cuyo plan guardado lleva incluir_comprobados: ahí las
 * tomas posteriores al día de la marca siguen yendo a campo. En las demás se
 * deja vacío a propósito: comp_aplicar_planes conserva las tomas que un sitio
 * tenía antes de marcarse y esas NO deben volver a campo.
 * Si una de las dos lecturas falla, falla todo: un Excel con el día a medias
 * mandaría (o dejaría de mandar) gente a campo sin que nadie lo note.
 */
async function completarDiaComprobado(tomas: VwToma[]): Promise<ResultadoComp<VwToma[]>> {
  const conSitioComprobado = [...new Set(tomas.filter((t) => t.sitio_estado === 'comprobado').map((t) => t.campana_id))];
  if (!conSitioComprobado.length) return { ok: true, data: tomas };
  const planes = await porTrozos<{ id: number; plan_tomas: PlanGuardado }>(conSitioComprobado, (t, d, h, s) =>
    sb.from('comp_campanas').select('id,plan_tomas').in('id', t).order('id').range(d, h).abortSignal(s)
  );
  if (!planes.ok) return planes;
  const conR11 = planes.data.filter((c) => c.plan_tomas?.incluir_comprobados === true).map((c) => c.id);
  if (!conR11.length) return { ok: true, data: tomas };
  const sitios = await porTrozos<{ id: number; comprobado_dia: string | null }>(conR11, (t, d, h, s) =>
    sb
      .from('comp_sitios')
      .select('id,comprobado_dia')
      .in('campana_id', t)
      .eq('estado', 'comprobado')
      .order('id')
      .range(d, h)
      .abortSignal(s)
  );
  if (!sitios.ok) return sitios;
  const dia = new Map(sitios.data.map((s) => [s.id, s.comprobado_dia]));
  const r11 = new Set(conR11);
  return {
    ok: true,
    data: tomas.map((t) =>
      r11.has(t.campana_id) && t.sitio_estado === 'comprobado' && dia.get(t.sitio_id)
        ? { ...t, sitio_comprobado_dia: dia.get(t.sitio_id) }
        : t
    ),
  };
}

/** Comprobación diaria (vw_comp_diaria) de un periodo. */
export function leerDiaria(f: { periodoId: number; unidad?: UnidadComp }): Promise<ResultadoComp<VwDiaria[]>> {
  return traerTodo<VwDiaria>((d, h, s) => {
    let q = sb.from('vw_comp_diaria').select('*').eq('periodo_id', f.periodoId);
    if (f.unidad) q = q.eq('unidad', f.unidad);
    return q.order('campana_id').order('dia').order('comprobado_por').range(d, h).abortSignal(s);
  });
}

/** Avance por analista (vw_comp_avance_analista) de un periodo. */
export function leerAvanceAnalista(f: {
  periodoId: number;
  unidad?: UnidadComp;
}): Promise<ResultadoComp<VwAvanceAnalista[]>> {
  return traerTodo<VwAvanceAnalista>((d, h, s) => {
    let q = sb.from('vw_comp_avance_analista').select('*').eq('periodo_id', f.periodoId);
    if (f.unidad) q = q.eq('unidad', f.unidad);
    return q.order('analista_email', { nullsFirst: false }).range(d, h).abortSignal(s);
  });
}

/** Reglas de la unidad y las generales (unidad NULL). */
export function leerReglas(unidad?: UnidadComp): Promise<ResultadoComp<ReglaComp[]>> {
  return traerTodo<ReglaComp>((d, h, s) => {
    let q = sb.from('comp_reglas').select('*');
    if (unidad) q = q.or(`unidad.is.null,unidad.eq."${unidad}"`);
    return q.order('tipo').order('desde', { nullsFirst: true }).order('id').range(d, h).abortSignal(s);
  });
}

/** Últimos movimientos (lotes) de la unidad; solo el Supervisor los lee. */
export async function leerMovimientos(unidad: UnidadComp, limite = 50): Promise<ResultadoComp<MovimientoComp[]>> {
  try {
    const r = (await sb
      .from('comp_movimientos')
      .select('*')
      .eq('unidad', unidad)
      .order('en', { ascending: false })
      .limit(Math.min(Math.max(1, limite), PAGINA))
      .abortSignal(tope(TOPE_LECTURA_COMP_MS))) as unknown as RespPg;
    return deRespuesta<MovimientoComp[]>(r);
  } catch (e) {
    return deExcepcion(e);
  }
}

/** Equipo de la unidad para los selectores (comp_equipo; Supervisor y Coordinador). */
export async function leerEquipo(unidad: UnidadComp): Promise<ResultadoComp<MiembroEquipo[]>> {
  const r = await leerRpc<MiembroEquipo[] | null>('comp_equipo', { p_unidad: unidad });
  return r.ok ? { ok: true, data: r.data || [] } : r;
}

/** Monitoristas de la unidad (comp_monitoristas). */
export async function leerMonitoristas(unidad: UnidadComp): Promise<ResultadoComp<MonitoristaComp[]>> {
  const r = await leerRpc<MonitoristaComp[] | null>('comp_monitoristas', { p_unidad: unidad });
  return r.ok ? { ok: true, data: r.data || [] } : r;
}

/** Correo → nombre (para NombresPorCorreo de excelComp y los chips). */
export function nombresPorCorreo(lista: { email: string; nombre: string }[]): Map<string, string> {
  return new Map(lista.map((m) => [m.email.trim().toLowerCase(), m.nombre] as [string, string]));
}

/**
 * Lo que comp_fuente_pauta_vv entrega para armar la carga de Vía Verde
 * con desdePautaVV (bitacoraComp.ts). El Supervisor NO puede leer
 * vv_campanas, vv_pautas, vv_ocupacion ni vv_espacios directo: llegarían
 * vacías y la foto completa retiraría todo.
 */
export type FuentePautaVV = {
  desde: string;
  hasta: string;
  plano_mes: string | null;
  campanas: VVCampanaFila[];
  pautas: VVPautaFila[];
  ocupacion: VVOcupacionFila[];
  espacios: (EspacioVV & { tipo_espacio: string | null })[];
  totales: { campanas: number; pautas: number; ocupacion: number; espacios: number };
  /**
   * Columnas «reservada» del plano que NO entran (Erik, 23-oct-2026), solo
   * para avisar: por campaña, las de campañas que sí tienen algo vendido o
   * pautado en el rango; de las demás, solo cuántas líneas. Llegan con la
   * migración comp_fuente_reservadas; antes no vienen.
   */
  reservadas?: { campana: string; n: number; espacios: string[] }[];
  reservadas_otras?: number;
};

/**
 * Fuente de Vía Verde (comp_fuente_pauta_vv). Un solo jsonb: si falla, la
 * pantalla NO arma nada (nunca cargar con una lectura a medias). El rango
 * va de 1 a 93 días contando los dos extremos.
 */
export async function leerFuentePautaVV(desde: string, hasta: string): Promise<ResultadoComp<FuentePautaVV>> {
  const r = await leerRpc<FuentePautaVV | null>('comp_fuente_pauta_vv', { p_desde: desde, p_hasta: hasta });
  if (!r.ok) return r;
  const v = r.data;
  if (!v || !Array.isArray(v.campanas) || !Array.isArray(v.pautas) || !Array.isArray(v.ocupacion) || !Array.isArray(v.espacios))
    return { ok: false, error: 'La fuente de Pauta VV llegó incompleta. No se armó nada; vuelve a intentar.', sinRed: false };
  return { ok: true, data: v };
}

/** Calendario de catorcenas (lo lee cualquier usuario con sesión). */
export type CatorcenaCal = { numero: number; anio: number; fecha_inicio: string | null; fecha_fin: string | null };

export function leerCatorcenas(): Promise<ResultadoComp<CatorcenaCal[]>> {
  return traerTodo<CatorcenaCal>((d, h, s) =>
    sb
      .from('catorcenas')
      .select('numero,anio,fecha_inicio,fecha_fin')
      .order('fecha_inicio')
      .order('anio')
      .order('numero')
      .range(d, h)
      .abortSignal(s)
  );
}

/** Una cara del inventario de la unidad (para el lector y el alta manual). */
export type CaraInventario = {
  vendor_face_id: string;
  site_id: string | null;
  tipo_medio: string | null;
  tipo_mueble: string | null;
  direccion: string | null;
  municipio: string | null;
  face_status: string | null;
};

/**
 * Inventario de la unidad. En Ecovallas trae TODO (Impreso y Digital): el
 * lector de la bitácora necesita tipo_medio para avisar lo que no es
 * pantalla. `soloDigital` lo acota para el alta manual de Ecovallas.
 */
export function leerInventarioComp(
  unidad: UnidadComp,
  op?: { soloDigital?: boolean }
): Promise<ResultadoComp<CaraInventario[]>> {
  return traerTodo<CaraInventario>((d, h, s) => {
    let q = sb
      .from('inventario')
      .select('vendor_face_id,site_id,tipo_medio,tipo_mueble,direccion,municipio,face_status')
      .eq('unidad_negocio', unidad);
    if (op?.soloDigital) q = q.ilike('tipo_medio', 'digital%');
    return q.order('vendor_face_id').range(d, h).abortSignal(s);
  });
}

/**
 * Ruta activa de la unidad con sus site_id, para escoger sitios «por ruta».
 * Ecovallas: Digital o Combinada; Biobox y Vía Verde: cualquier medio (V1).
 */
export type RutaComp = { id: number; numero: number; nombre: string | null; tipo_medio: string; sitios: string[] };

/**
 * Rutas de la unidad con sus paradas (rutas_monitoreo + ruta_ubicaciones;
 * las dos se leen con cualquier sesión, SELECT del 23-oct-2026). Mismas
 * reglas que comp_ruta_sitio: activas, de la unidad y, solo en Ecovallas,
 * Digital o Combinada (su Impreso es Pauta). Revisión del 26-oct-2026
 * (regresiones-3): con V1 la base ya usa las rutas Impreso de Biobox y Vía
 * Verde, y Armar › «Por ruta» no las ofrecía.
 * OJO: en Ecovallas Digital ruta_ubicaciones.site_id guarda casi siempre la
 * forma vendor_face_id; la pantalla debe cruzar por los dos.
 */
export async function leerRutasComp(unidad: UnidadComp): Promise<ResultadoComp<RutaComp[]>> {
  const rutas = await traerTodo<{ id: number; numero: number; nombre: string | null; tipo_medio: string }>((d, h, s) => {
    const q = sb.from('rutas_monitoreo').select('id,numero,nombre,tipo_medio').eq('unidad_negocio', unidad).eq('activa', true);
    return (unidad === 'Ecovallas' ? q.in('tipo_medio', ['Digital', 'Combinada']) : q)
      .order('numero')
      .order('id')
      .range(d, h)
      .abortSignal(s);
  });
  if (!rutas.ok) return rutas;
  const ubic = await porTrozos<{ ruta_id: number; site_id: string; secuencia: number | null }>(
    rutas.data.map((r) => r.id),
    (t, d, h, s) =>
      sb
        .from('ruta_ubicaciones')
        .select('ruta_id,site_id,secuencia')
        .in('ruta_id', t)
        .order('ruta_id')
        .order('secuencia', { nullsFirst: false })
        .order('id')
        .range(d, h)
        .abortSignal(s)
  );
  if (!ubic.ok) return ubic;
  const porRuta = new Map<number, string[]>();
  for (const u of ubic.data) {
    const l = porRuta.get(u.ruta_id) ?? [];
    l.push(u.site_id);
    porRuta.set(u.ruta_id, l);
  }
  return { ok: true, data: rutas.data.map((r) => ({ ...r, sitios: porRuta.get(r.id) ?? [] })) };
}

/**
 * tipo_medio de unas rutas (rutas_monitoreo; cualquier sesión la lee).
 * Revisión del 26-oct-2026 (sql-2): en Biobox los números de ruta se repiten
 * entre Digital e Impreso y Formato rotula «Ruta 3 · Impreso» cuando pasa.
 */
export async function leerMediosRutas(ids: number[]): Promise<ResultadoComp<Map<number, string>>> {
  const r = await porTrozos<{ id: number; tipo_medio: string }>(ids, (t, d, h, s) =>
    sb.from('rutas_monitoreo').select('id,tipo_medio').in('id', t).order('id').range(d, h).abortSignal(s)
  );
  if (!r.ok) return r;
  return { ok: true, data: new Map(r.data.map((x) => [Number(x.id), String(x.tipo_medio)] as [number, string])) };
}

/**
 * Lo ya cargado de un periodo y medio, en la forma que pide
 * revisarContraCargadas (bitacoraComp.ts): cada campaña con SOLO sus
 * sitios de una carga (origen 'carga') que siguen en ella. Se corre antes
 * de cargar para avisar «ampliaciones» y no dar de baja sitios de otra hoja.
 */
export async function leerCampanasCargadas(periodoId: number, medio: MedioComp): Promise<ResultadoComp<CampanaCargada[]>> {
  const cams = await leerCampanas({ periodoId, medio });
  if (!cams.ok) return cams;
  const abiertas = cams.data.filter((c) => !c.retirada);
  const sit = await leerSitios({ campanaIds: abiertas.map((c) => c.id), origen: 'carga', sinFueraDeCarga: true });
  if (!sit.ok) return sit;
  const porCampana = new Map<number, SitioContrato[]>();
  for (const s of sit.data) {
    const l = porCampana.get(s.campana_id) ?? [];
    l.push({
      sitio_clave: s.sitio_clave,
      sitio_original: s.sitio_original ?? s.sitio_clave,
      espacio_vv: s.espacio_vv,
      inicio: s.inicio,
      fin: s.fin,
      horario_lv: s.horario_lv,
      horario_sd: s.horario_sd,
      tipo_venta: s.tipo_venta,
      testigos: s.testigos,
      observaciones: s.observaciones,
    });
    porCampana.set(s.campana_id, l);
  }
  return {
    ok: true,
    data: abiertas.map((c) => ({
      medio: c.medio,
      campana: c.campana,
      version: c.version,
      fuente: c.fuente,
      origen_ref: c.origen_ref,
      sitios: porCampana.get(c.id) ?? [],
    })),
  };
}

// ------------------------------------------------------------
// Periodos de la pantalla (catorcena para Ecovallas, mes para el resto)
// ------------------------------------------------------------

export const MESES_COMP = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

/** Ecovallas Digital va por catorcena; Biobox y Vía Verde, por mes (igual que la base). */
export const tipoPeriodoDe = (u: UnidadComp): TipoPeriodo => (u === 'Ecovallas' ? 'catorcena' : 'mes');

/**
 * Un periodo del selector. `id` = comp_periodos.id si ya se armó; null si
 * todavía no (solo la pestaña Armar trabaja con uno sin armar: la primera
 * carga lo crea y devuelve su periodo_id).
 */
export type PeriodoSel = {
  /** 'catorcena:2026:18' / 'mes:2026:10': llave estable del selector. */
  clave: string;
  id: number | null;
  unidad: UnidadComp;
  tipo: TipoPeriodo;
  anio: number;
  numero: number;
  /** 'YYYY-MM-DD'. */
  inicio: string;
  fin: string;
  /** Igual que la base: 'Cat-18 · 2026' o 'Octubre 2026'. */
  etiqueta: string;
};

/** Un periodo que ya tiene campañas cargadas (lo que reciben las pestañas fuera de Armar). */
export type PeriodoCargado = PeriodoSel & { id: number };

export const clavePeriodo = (tipo: TipoPeriodo, anio: number, numero: number) => `${tipo}:${anio}:${numero}`;

/** El argumento p_periodo de comp_cargar_campanas. */
export const periodoParaCarga = (p: Pick<PeriodoSel, 'tipo' | 'anio' | 'numero'>) => ({
  tipo: p.tipo,
  anio: p.anio,
  numero: p.numero,
});

function finDeMes(anio: number, mes: number): string {
  const d = new Date(Date.UTC(anio, mes, 0));
  return d.toISOString().slice(0, 10);
}

function periodoMes(unidad: UnidadComp, anio: number, mes: number): PeriodoSel {
  return {
    clave: clavePeriodo('mes', anio, mes),
    id: null,
    unidad,
    tipo: 'mes',
    anio,
    numero: mes,
    inicio: `${anio}-${String(mes).padStart(2, '0')}-01`,
    fin: finDeMes(anio, mes),
    etiqueta: `${MESES_COMP[mes - 1]} ${anio}`,
  };
}

/**
 * Opciones del selector de periodo, el más reciente primero:
 *   · los periodos ya armados (comp_periodos), con su id;
 *   · si `conPorArmar` (quien gestiona), además el actual, los 2 anteriores
 *     y el siguiente que aún no existan: catorcenas del calendario para
 *     Ecovallas Digital, meses para Biobox y Vía Verde.
 * Una analista solo ve los ya armados.
 */
export function opcionesPeriodo(args: {
  unidad: UnidadComp;
  armados: PeriodoComp[];
  catorcenas?: CatorcenaCal[];
  conPorArmar: boolean;
  hoy?: string;
}): PeriodoSel[] {
  const { unidad } = args;
  const tipo = tipoPeriodoDe(unidad);
  const mapa = new Map<string, PeriodoSel>();
  if (args.conPorArmar) {
    const hoy = args.hoy || hoyCdmx();
    if (tipo === 'mes') {
      const a = Number(hoy.slice(0, 4));
      const m = Number(hoy.slice(5, 7));
      for (let k = -2; k <= 1; k++) {
        const idx = a * 12 + (m - 1) + k;
        const p = periodoMes(unidad, Math.floor(idx / 12), (idx % 12) + 1);
        mapa.set(p.clave, p);
      }
    } else {
      const cal = (args.catorcenas || [])
        .filter((c) => c.fecha_inicio && c.fecha_fin && c.anio)
        .sort((x, y) => (x.fecha_inicio! < y.fecha_inicio! ? -1 : x.fecha_inicio! > y.fecha_inicio! ? 1 : 0));
      let i = cal.findIndex((c) => c.fecha_inicio! <= hoy && hoy <= c.fecha_fin!);
      if (i < 0) i = cal.reduce((acc, c, j) => (c.fecha_inicio! <= hoy ? j : acc), -1);
      if (i >= 0) {
        for (const c of cal.slice(Math.max(0, i - 2), i + 2)) {
          const clave = clavePeriodo('catorcena', c.anio, c.numero);
          mapa.set(clave, {
            clave,
            id: null,
            unidad,
            tipo: 'catorcena',
            anio: c.anio,
            numero: c.numero,
            inicio: c.fecha_inicio!.slice(0, 10),
            fin: c.fecha_fin!.slice(0, 10),
            etiqueta: etiquetaCatorcena(c.numero, c.anio),
          });
        }
      }
    }
  }
  for (const p of args.armados) {
    if (p.unidad !== unidad) continue;
    const clave = clavePeriodo(p.tipo, p.anio, p.numero);
    mapa.set(clave, {
      clave,
      id: p.id,
      unidad,
      tipo: p.tipo,
      anio: p.anio,
      numero: p.numero,
      inicio: String(p.fecha_inicio).slice(0, 10),
      fin: String(p.fecha_fin).slice(0, 10),
      etiqueta: p.etiqueta,
    });
  }
  return [...mapa.values()].sort((a, b) => (a.inicio < b.inicio ? 1 : a.inicio > b.inicio ? -1 : 0));
}

/** El que se abre por omisión: el que contiene hoy; si no, el más reciente que ya empezó; si no, el primero. */
export function periodoPorOmision(opciones: PeriodoSel[], hoy = hoyCdmx()): PeriodoSel | null {
  return (
    opciones.find((p) => p.inicio <= hoy && hoy <= p.fin) ??
    opciones.find((p) => p.inicio <= hoy) ??
    opciones[0] ??
    null
  );
}

/** Medios de la unidad (Vía Verde se carga en dos llamadas: Columna y Pórtico). */
export const mediosDe = (u: UnidadComp): MedioComp[] => MEDIOS_DE_UNIDAD[u];

// ------------------------------------------------------------
// Escrituras (RPC). Cada una devuelve lo que contesta la base: la pantalla
// DEBE enseñar esos conteos y avisos.
// ------------------------------------------------------------

type ListaCampanaCarga = { i: number; id: number | null; campana: string; version: string; estatus: EstatusCampana; nueva: boolean };
type CampanaRetiradaCarga = { id: number; campana: string; version: string; borrada?: boolean; reemplazada_por?: number | null } & Record<string, unknown>;

/** Reporte de comp_cargar_campanas (el mismo en la previa y en la carga real). */
export type ReporteCarga = {
  /** null en la previa (p_solo_revisar). */
  periodo_id: number | null;
  periodo: string;
  periodo_inicio: string;
  periodo_fin: string;
  unidad: UnidadComp;
  medio: MedioComp;
  /** ¿Se tomó como foto completa (Pauta VV / plano)? Entonces retira lo que no vino. */
  completa: boolean;
  solo_revisar: boolean;
  campanas_recibidas: number;
  campanas_duplicadas: number;
  campanas_nuevas: number;
  campanas_actualizadas: number;
  cerradas_sin_tocar: unknown[];
  campanas_retiradas: CampanaRetiradaCarga[];
  campanas_borradas: number;
  /** Misma campaña abierta con otra versión que no vino: el Supervisor decide (comp_retirar_campanas). */
  posibles_duplicados: { id: number; campana: string; version: string; fuente: FuenteComp }[];
  /** Filas del plano (versión '') que tomaron la versión de Pauta VV. */
  campanas_adoptadas: unknown[];
  analista_de_la_app_conservada: number;
  sitios_recibidos: number;
  sitios_nuevos: number;
  sitios_actualizados: number;
  sitios_baja: number;
  sitios_fuera_de_carga: number;
  sin_inventario: unknown[];
  edo_mex_omitidas: unknown[];
  inactivas_omitidas: unknown[];
  otro_medio_omitidas: unknown[];
  sitios_fuera_del_periodo: unknown[];
  sitios_repetidos: unknown[];
  campanas_replanificadas: number;
  tomas_nuevas: number;
  tomas_borradas: number;
  tomas_actualizadas: number;
  tomas_canceladas: number;
  tomas_regresadas: number;
  tomas_app_fuera_de_vigencia: number[];
  analistas_no_reconocidos: string[];
  sin_analista: number;
  campanas: ListaCampanaCarga[];
};

/**
 * comp_cargar_campanas: UNA entrada para la bitácora, Pauta VV, el plano y
 * el alta manual. Con soloRevisar = true hace todo y lo deshace (previa
 * con las cifras del servidor). `completa`: null = la base lo deduce (sí,
 * si todo es pauta_vv/plano); false al recargar UNA campaña de Pauta VV
 * (si no, retiraría las demás).
 */
export function cargarCampanas(args: {
  unidad: UnidadComp;
  medio: MedioComp;
  periodo: Pick<PeriodoSel, 'tipo' | 'anio' | 'numero'>;
  campanas: CampanaContrato[];
  soloRevisar?: boolean;
  completa?: boolean | null;
}): Promise<ResultadoComp<ReporteCarga>> {
  return escribir<ReporteCarga>('comp_cargar_campanas', {
    p_unidad: args.unidad,
    p_medio: args.medio,
    p_periodo: periodoParaCarga(args.periodo),
    p_campanas: args.campanas,
    p_solo_revisar: args.soloRevisar ?? false,
    p_completa: args.completa ?? null,
  });
}

/** Plan que se manda (lo valida antes validarPlan/leerPlan de comprobaciones.ts). */
export type PlanEnvio = {
  tipo: 'inicio' | 'inicio_fin' | 'cada_n' | 'diario' | 'fechas';
  cada_n?: number | null;
  fechas?: string[] | null;
  incluir_comprobados?: boolean;
};

export type ResGenerarTomas = {
  campanas: number;
  cerradas_omitidas: number;
  tomas_nuevas: number;
  tomas_borradas: number;
  tomas_actualizadas: number;
  tomas_conservadas: number;
  tomas_canceladas: number;
  tomas_regresadas: number;
  omitidas_comprobados: number;
  /** Ids de tomas editadas a mano que quedaron fuera de la vigencia. */
  tomas_app_fuera_de_vigencia: number[];
  /**
   * NOMBRES («CAMPAÑA / V2») de las campañas a las que el plan no les dio
   * ninguna toma: comp_generar_tomas los arma con jsonb_agg del nombre, no
   * con ids (integración, 23-oct-2026; antes decía number[]).
   */
  sin_tomas: string[];
  plan: PlanGuardado;
};

/** comp_generar_tomas: aplica un plan (o el que ya tiene cada campaña, con plan null). */
export function generarTomas(campanaIds: number[], plan: PlanEnvio | null): Promise<ResultadoComp<ResGenerarTomas>> {
  return escribir<ResGenerarTomas>('comp_generar_tomas', { p_campana_ids: campanaIds, p_plan: plan });
}

/** Lo que se puede cambiar de una toma (comp_editar_tomas). La fecha, de una en una. */
export type CambiosToma = {
  fecha?: string;
  horario_texto?: string | null;
  observaciones?: string | null;
  notas?: string | null;
  monitorista_email?: string | null;
  turno?: TurnoToma | null;
  comprobacion?: string;
  /** Mover fuera de la vigencia del sitio (la pantalla lo confirma antes). */
  fuera_de_vigencia?: boolean;
};

export type ResEditarTomas = {
  cambiadas: number;
  sin_cambio: number;
  quitada_reemplazada: boolean;
  /**
   * Fase 3 (comp_f3_modelo, V6; 26-oct-2026): tomas devueltas que se saltaron
   * porque el cambio traía algo más que monitorista y notas (de una devuelta
   * solo se reasigna el monitorista). Antes de la migración no viene.
   */
  regresadas_omitidas?: number;
};

export function editarTomas(tomaIds: number[], cambios: CambiosToma): Promise<ResultadoComp<ResEditarTomas>> {
  return escribir<ResEditarTomas>('comp_editar_tomas', { p_toma_ids: tomaIds, p_cambios: cambios });
}

export type ResAgregarTomas = { agregadas: number; fuera_del_periodo: number; fuera_de_vigencia: number; ya_estaban: number };

/** comp_agregar_tomas: fechas sueltas para unos sitios (origen 'app'). */
export function agregarTomas(
  sitioIds: number[],
  fechas: string[],
  fueraDeVigencia = false
): Promise<ResultadoComp<ResAgregarTomas>> {
  return escribir<ResAgregarTomas>('comp_agregar_tomas', {
    p_sitio_ids: sitioIds,
    p_fechas: fechas,
    p_fuera_de_vigencia: fueraDeVigencia,
  });
}

export type ResCambiadas = { cambiadas: number; sin_cambio: number };

/** comp_quitar_tomas: quitar (true) o regresar (false) tomas pendientes. */
export function quitarTomas(tomaIds: number[], quitar = true): Promise<ResultadoComp<ResCambiadas>> {
  return escribir<ResCambiadas>('comp_quitar_tomas', { p_toma_ids: tomaIds, p_quitar: quitar });
}

export type ResAsignar = { asignadas: number; cerradas_omitidas: number; sin_cambio: number };

/** comp_asignar_analista: asignar en lote; analista null = quitar. */
export function asignarAnalista(campanaIds: number[], analista: string | null): Promise<ResultadoComp<ResAsignar>> {
  return escribir<ResAsignar>('comp_asignar_analista', { p_campana_ids: campanaIds, p_analista: analista });
}

export type ResPasarPendiente = Partial<ResAsignar> & { campanas: number; sitios_pendientes: number; solo_contar: boolean };

/**
 * comp_pasar_pendiente: de una analista a otra. Con soloContar = true es la
 * previa («N campañas · M sitios pendientes»). Lo comprobado conserva su
 * crédito (comprobado_por).
 */
export function pasarPendiente(args: {
  de: string;
  a: string | null;
  unidad: UnidadComp;
  periodoId?: number | null;
  soloSinAvance?: boolean;
  soloContar?: boolean;
}): Promise<ResultadoComp<ResPasarPendiente>> {
  return escribir<ResPasarPendiente>('comp_pasar_pendiente', {
    p_de: args.de,
    p_a: args.a,
    p_unidad: args.unidad,
    p_periodo_id: args.periodoId ?? null,
    p_solo_sin_avance: args.soloSinAvance ?? false,
    p_solo_contar: args.soloContar ?? false,
  });
}

export type ResMarcar = { cambiados: number; sin_cambio: number; dia: string | null };

/**
 * comp_marcar_sitios: marcar (o quitar marca) en lote. `dia`: hoy (null) o
 * hasta 7 días atrás, nunca antes del periodo (P4; ver diasParaMarcar).
 */
export function marcarSitios(sitioIds: number[], comprobado = true, dia: string | null = null): Promise<ResultadoComp<ResMarcar>> {
  return escribir<ResMarcar>('comp_marcar_sitios', { p_sitio_ids: sitioIds, p_comprobado: comprobado, p_dia: dia });
}

/** Las llaves de tomas que suman los reportes cuando se vuelve a aplicar el plan. */
export type TomasReaplicadas = {
  tomas_nuevas?: number;
  tomas_borradas?: number;
  tomas_actualizadas?: number;
  tomas_canceladas?: number;
  tomas_regresadas?: number;
  tomas_app_fuera_de_vigencia?: number[];
};

export type ResSitios = { cambiados: number; sin_cambio: number } & TomasReaplicadas;

/** comp_cancelar_sitios: bajas («no se comprueban»); el motivo es obligatorio. */
export function cancelarSitios(sitioIds: number[], motivo: string): Promise<ResultadoComp<ResSitios>> {
  return escribir<ResSitios>('comp_cancelar_sitios', { p_sitio_ids: sitioIds, p_motivo: motivo });
}

/** comp_restaurar_sitios: regresar sitios cancelados. */
export function restaurarSitios(sitioIds: number[]): Promise<ResultadoComp<ResSitios>> {
  return escribir<ResSitios>('comp_restaurar_sitios', { p_sitio_ids: sitioIds });
}

export type ResAgregarSitios = { agregados: number; ya_estaban: number } & TomasReaplicadas;

/**
 * comp_agregar_sitios: el Supervisor a cualquier campaña abierta; la
 * analista solo a un FULL de Vía Verde. Si una clave no sirve, no se agrega
 * ninguna (el mensaje de la base dice cuál).
 */
export function agregarSitios(campanaId: number, claves: string[]): Promise<ResultadoComp<ResAgregarSitios>> {
  return escribir<ResAgregarSitios>('comp_agregar_sitios', { p_campana_id: campanaId, p_claves: claves });
}

export type ResCerrar = { cambiadas: number; sin_cambio: number; incompletas: number };

/**
 * comp_cerrar_campanas (P1: solo Supervisor o manager). Debajo de la meta
 * la base pide motivo: la pantalla lo pide ANTES («3 no llegan al 100 %»).
 */
export function cerrarCampanas(campanaIds: number[], cerrar: boolean, motivo: string | null = null): Promise<ResultadoComp<ResCerrar>> {
  return escribir<ResCerrar>('comp_cerrar_campanas', { p_campana_ids: campanaIds, p_cerrar: cerrar, p_motivo: motivo });
}

export type ResRetirar = {
  cambiadas: number;
  borradas: number;
  retiradas: number;
  regresadas: number;
  sin_cambio: number;
  lista: unknown[];
} & TomasReaplicadas;

/** comp_retirar_campanas: retirar (o regresar) la versión repetida o la que se cayó. */
export function retirarCampanas(campanaIds: number[], retirar = true): Promise<ResultadoComp<ResRetirar>> {
  return escribir<ResRetirar>('comp_retirar_campanas', { p_campana_ids: campanaIds, p_retirar: retirar });
}

/**
 * Lo que se puede editar de una campaña (comp_editar_campanas). Un null
 * en un campo que viene de la carga lo devuelve a lo que diga la próxima
 * carga; es_full solo en Vía Verde (la base lo rechaza en las otras).
 */
export type CambiosCampana = Partial<{
  fecha_limite: string | null;
  meta_app: number | null;
  meta_full: number | null;
  full_minutos: number | null;
  entrega_tipo: EntregaTipo;
  especificacion: string | null;
  arte: 'NUEVO' | 'REPITE' | null;
  inicio: string | null;
  fin: string | null;
  cliente: string | null;
  vendedor: string | null;
  administrador: string | null;
  quantum: string | null;
  mediamonitor: boolean | null;
  es_full: boolean | null;
}>;

export type ResEditarCampanas = { cambiadas: number; cerradas_omitidas: number; sin_cambio: number } & TomasReaplicadas;

export function editarCampanas(campanaIds: number[], cambios: CambiosCampana): Promise<ResultadoComp<ResEditarCampanas>> {
  return escribir<ResEditarCampanas>('comp_editar_campanas', { p_campana_ids: campanaIds, p_cambios: cambios });
}

/** Regla para guardar (sin id = nueva). Las generales (unidad null) solo el manager. */
export type ReglaEnvio = Partial<Omit<ReglaComp, 'actualizada_por' | 'actualizada_en'>> & { tipo: TipoRegla };

/** comp_guardar_regla: devuelve el id de la regla. */
export function guardarRegla(r: ReglaEnvio): Promise<ResultadoComp<number>> {
  return escribir<number>('comp_guardar_regla', { p: r });
}

/** comp_borrar_regla: false si ya no existía. */
export function borrarRegla(id: number): Promise<ResultadoComp<boolean>> {
  return escribir<boolean>('comp_borrar_regla', { p_id: id });
}

// ============================================================
// Fase 3 · incremento 1 (26-oct-2026): plantillas, refresco de ruta y
// monitorista, y la lista del monitorista. Firmas de la migración
// comp_f3_modelo (§4.1 1i de la especificación).
//
// Las RPC nuevas contestan los errores ESPERADOS dentro del resultado
// ({ok:false, codigo:'ocupada'|'sin_permiso'|…}); aquí se vuelven una falla
// con su código, igual que un error de Postgres. Nada decide por el texto.
// ============================================================

/** Código del resultado de una RPC f3 ({ok:false, codigo}) → código de falla. */
function codigoDeResultado(c: unknown): CodigoFallaComp {
  if (c === 'ocupada') return 'ocupada';
  if (c === 'sin_permiso') return 'sin_permiso';
  return 'otro';
}

/**
 * Llama una RPC de la fase 3: además de los errores de Postgres, un
 * resultado {ok:false, codigo} es una falla (con su código; sin red = no).
 */
async function rpcF3<T>(nombre: string, args: Record<string, unknown>, topeMs: number): Promise<ResultadoComp<T>> {
  const r = await rpc<unknown>(nombre, args, topeMs);
  if (!r.ok) return r;
  const d = r.data as { ok?: unknown; codigo?: unknown } | null;
  if (d && typeof d === 'object' && !Array.isArray(d) && d.ok === false) {
    const codigo = codigoDeResultado(d.codigo);
    const crudo = { error: typeof d.codigo === 'string' ? d.codigo : 'error', sinRed: false, codigo };
    return { ok: false, ...crudo, error: textoFallaF3(crudo) };
  }
  return { ok: true, data: r.data as T };
}

// ---- Plantillas ------------------------------------------------

/** Catálogo (comp_plantillas_toma: todos lo leen), en su orden. */
export async function leerCatalogoPlantillas(): Promise<ResultadoComp<PlantillaToma[]>> {
  const r = await traerTodo<unknown>((d, h, s) =>
    sb.from('comp_plantillas_toma').select('*').order('orden').order('codigo').range(d, h).abortSignal(s)
  );
  if (!r.ok) return r;
  return { ok: true, data: r.data.map(leerPlantilla).filter((x): x is PlantillaToma => !!x) };
}

/**
 * plantilla_codigo de unas campañas (comp_campanas; la vista no se tocó,
 * M9). null = la de omisión ('unica'). Las que la RLS no deja ver no salen.
 */
export async function leerPlantillasCampanas(campanaIds: number[]): Promise<ResultadoComp<Map<number, string | null>>> {
  const r = await porTrozos<{ id: number; plantilla_codigo: string | null }>(campanaIds, (t, d, h, s) =>
    sb.from('comp_campanas').select('id,plantilla_codigo').in('id', t).order('id').range(d, h).abortSignal(s)
  );
  if (!r.ok) return r;
  return { ok: true, data: new Map(r.data.map((c) => [Number(c.id), c.plantilla_codigo ?? null] as [number, string | null])) };
}

export type ResPonerPlantilla = {
  cambiadas: number;
  cerradas_omitidas: number;
  /** Tomas ya enviadas (por revisar o comprobadas) que conservan la plantilla anterior (A2). */
  enviadas_conservan: number;
};

/**
 * comp_poner_plantilla: plantilla de testigo en lote (Supervisor o
 * manager). `codigo` null = la de omisión. Un código de mueble o que no
 * existe lo rechaza la base (CP002 → codigo 'datos').
 */
export async function ponerPlantilla(campanaIds: number[], codigo: string | null): Promise<ResultadoComp<ResPonerPlantilla>> {
  const r = await rpcF3<Partial<ResPonerPlantilla> | null>(
    'comp_poner_plantilla',
    { p_campana_ids: campanaIds, p_codigo: codigo },
    TOPE_ESCRITURA_COMP_MS
  );
  if (!r.ok) return r;
  const d = r.data || {};
  return {
    ok: true,
    data: {
      cambiadas: Number(d.cambiadas) || 0,
      cerradas_omitidas: Number(d.cerradas_omitidas) || 0,
      enviadas_conservan: Number(d.enviadas_conservan) || 0,
    },
  };
}

// ---- Ruta y monitorista ------------------------------------------

/**
 * comp_refrescar_monitoristas: vuelve a tomar la ruta y el monitorista de
 * Rutas en las tomas pendientes del periodo que no tienen monitorista
 * puesto a mano ni fotos (A4, M2, M3). Nunca espera un candado: una toma
 * que otro está guardando se salta y se corrige la siguiente vez.
 */
export async function refrescarMonitoristas(periodoId: number): Promise<ResultadoComp<{ actualizadas: number }>> {
  const r = await rpcF3<{ actualizadas?: unknown } | null>(
    'comp_refrescar_monitoristas',
    { p_periodo_id: periodoId },
    TOPE_ESCRITURA_COMP_MS
  );
  if (!r.ok) return r;
  return { ok: true, data: { actualizadas: Number(r.data?.actualizadas) || 0 } };
}

/**
 * comp_tomas.monitorista_manual de unas tomas (M3): true = Victor puso al
 * monitorista a mano y el cambio de ruta ya no lo mueve; false = es el de
 * la ruta. Antes de la migración la columna no existe: codigo
 * 'falta_migracion' y el modal se porta como en la fase 2.
 */
export async function leerMonitoristaManual(tomaIds: number[]): Promise<ResultadoComp<Map<number, boolean>>> {
  const r = await porTrozos<{ id: number; monitorista_manual: boolean | null }>(tomaIds, (t, d, h, s) =>
    sb.from('comp_tomas').select('id,monitorista_manual').in('id', t).order('id').range(d, h).abortSignal(s)
  );
  if (!r.ok) return r;
  return { ok: true, data: new Map(r.data.map((x) => [Number(x.id), x.monitorista_manual === true] as [number, boolean])) };
}

// La lista del monitorista (comp_mis_tomas) se lee en misTomasApi.ts
// (revisión del 26-oct-2026, regresiones-1): así Mis rutas no baja este API.
