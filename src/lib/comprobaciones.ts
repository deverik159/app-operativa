// ============================================================
// src/lib/comprobaciones.ts
// Núcleo puro (sin React ni Supabase) de Comprobaciones, fase 2
// (Erik, 22/23-oct-2026).
//
// QUÉ ES. El analista marca, sitio por sitio o en lote, lo que ya comprobó
// de cada campaña-versión; el Supervisor reparte las campañas, ve el avance
// del equipo y cierra o reabre. Lo que aquí se calcula (meta, %, semáforo,
// la tabla diaria y la carga por analista) es ESPEJO de lo que calcula la
// base en vw_comp_campanas / vw_comp_diaria: si una regla cambia aquí, cambia
// también en la migración, y al revés. Las pruebas están en
// tests/comprobaciones.test.mjs.
//
// UNIDADES. Las cadenas son las MISMAS de usuario_roles.unidad_negocio
// ('Ecovallas', 'Biobox', 'Vía Verde') para que la RLS no tenga que
// traducir. En pantalla Ecovallas se lee "Ecovallas Digital": en
// Comprobaciones solo entran las pantallas (en inventario, Digital es
// tipo_medio y no otra unidad).
// ============================================================

import { diaCdmx } from './fechasCdmx';

// La lista vive en unidadesComp.ts para no arrastrar este núcleo al chunk
// principal (helpers.ts la usa); aquí se reexporta.
import { UNIDADES_COMP, type UnidadComp } from './unidadesComp';
export { UNIDADES_COMP, type UnidadComp };
export type MedioComp = 'Pantalla' | 'Máquina' | 'Columna' | 'Pórtico';

export const ETIQUETA_UNIDAD_COMP: Record<UnidadComp, string> = {
  Ecovallas: 'Ecovallas Digital',
  Biobox: 'Biobox',
  'Vía Verde': 'Vía Verde',
};

/** Medios de cada unidad: los mismos pares que acepta comp_importar. */
export const MEDIOS_DE_UNIDAD: Record<UnidadComp, MedioComp[]> = {
  Ecovallas: ['Pantalla'],
  Biobox: ['Máquina'],
  'Vía Verde': ['Columna', 'Pórtico'],
};

/** ¿Es exactamente una de las 3 unidades? (sin tolerar "Via Verde" ni "Biobox Perú") */
export function esUnidadComp(u: unknown): u is UnidadComp {
  return typeof u === 'string' && (UNIDADES_COMP as readonly string[]).includes(u);
}

// ------------------------------------------------------------
// Llave de texto
// ------------------------------------------------------------

const CON_ACENTO = 'áéíóúÁÉÍÓÚüÜñÑ';
const SIN_ACENTO = 'aeiouAEIOUuUnN';

/**
 * Llave para comparar nombres de campaña, versión y sitio que vienen de
 * Excel escritos cada vez distinto ("Televisa_LCDF4", "TELEVISA LCDF 4",
 * "televisa-lcdf4"). ESPEJO EXACTO de comp_llave() en SQL (23-oct-2026):
 *
 *   1. translate de áéíóúÁÉÍÓÚüÜñÑ → aeiouAEIOUuUnN (carácter por carácter,
 *      sin normalize(): Postgres no lo hace);
 *   2. se quita todo lo que no sea [A-Za-z0-9]: espacios, espacio duro de
 *      Excel (U+00A0), _ . / - y cualquier letra con otro acento;
 *   3. a MAYÚSCULAS.
 *
 * El orden importa: si se pasara a mayúsculas ANTES de quitar, JS convierte
 * 'ß' en 'SS' e 'ı' en 'I' y Postgres no (o según el locale), y las dos
 * llaves dejarían de coincidir. Quitando primero solo queda ASCII y las
 * mayúsculas dan lo mismo en los dos lados. En SQL:
 *   upper(regexp_replace(translate(coalesce(t,''), '<con>', '<sin>'), '[^A-Za-z0-9]', '', 'g'))
 * La tabla fija de 20 textos de la prueba es la misma que verifica la
 * migración.
 *
 * Una fecha (Date) no se pasa por String(): eso depende de la zona de la
 * computadora ("Sat Aug 01 2026 … GMT-0600") y la misma celda daría llaves
 * distintas en dos máquinas. Si xlsx leyó como fecha una versión o campaña,
 * la llave es su día UTC AAAAMMDD; lo correcto es que el importador lea esas
 * columnas como texto (revisión del núcleo, 23-oct-2026).
 */
export function llaveComp(t: unknown): string {
  if (t === null || t === undefined) return '';
  if (t instanceof Date) {
    return Number.isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 10).replace(/-/g, '');
  }
  const s = String(t);
  let out = '';
  for (const ch of s) {
    const i = CON_ACENTO.indexOf(ch);
    out += i >= 0 ? SIN_ACENTO[i] : ch;
  }
  return out.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

// ------------------------------------------------------------
// Meta, % y semáforo
// ------------------------------------------------------------

/**
 * Número de la base: PostgREST puede mandar bigint/numeric como texto. Un
 * texto en blanco (' ') es "no hay", no 0: Number(' ') da 0 y una meta_app
 * en blanco tapaba la venta (revisión del núcleo, 23-oct-2026).
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export type DatosMeta = {
  meta_app?: number | string | null;
  es_full?: boolean | null;
  meta_full?: number | string | null;
  sitios_activos?: number | string | null;
};

/**
 * Meta de una campaña: cuántos sitios tienen que quedar comprobados para que
 * esté "completa". ESPEJO EXACTO de vw_comp_campanas:
 *   coalesce(meta_app, case when es_full then meta_full end, sitios_activos)
 *   1. meta_app: la que corrigió el Supervisor en la app;
 *   2. meta_full: solo si es FULL (se propone con la regla de minutos, P2);
 *   3. los sitios activos: comprobados + pendientes que siguen en la carga
 *      (un cancelado ya no cuenta, así la campaña sí puede llegar al 100 %).
 * Ya no hay rama de «venta − cancelados»: con el rediseño (23-oct-2026) la
 * venta no viene de un Excel, son los sitios cargados de la bitácora, y la
 * vista dejó de tenerla. Si esta función la conservara, una pantalla que le
 * pasara una venta obtendría otra meta que la base (revisión del núcleo,
 * 23-oct-2026).
 */
export function metaDe(c: DatosMeta): number {
  const app = num(c.meta_app);
  if (app !== null) return app;
  if (c.es_full) {
    const full = num(c.meta_full);
    if (full !== null) return full;
  }
  return num(c.sitios_activos) ?? 0;
}

/**
 * % de avance con un decimal, como round(100.0 * comprobados / meta, 1) de
 * la vista. Sin meta (0 o menos) no hay % (null), no "0 %" ni "infinito".
 * Puede pasar de 100 (se comprobaron más sitios que la venta).
 */
export function pctAvance(comprobados: number, meta: number): number | null {
  const c = num(comprobados) ?? 0;
  const m = num(meta) ?? 0;
  if (m <= 0) return null;
  // En enteros (1000·c/m) para que 12.5 no se vuelva 12.4999… al redondear.
  return Math.round((1000 * c) / m) / 10;
}

/** "Completa" = llegó a la meta. La app solo lo marca; cerrar es del Supervisor (P1). */
export function esCompleta(comprobados: number, meta: number): boolean {
  const m = num(meta) ?? 0;
  return m > 0 && (num(comprobados) ?? 0) >= m;
}

export type Semaforo = 'verde' | 'gris' | 'ambar' | 'rojo';

/**
 * Color de la fecha límite: verde si ya está completa (no importa cuándo
 * vence), rojo si ya venció (días < 0), ámbar si faltan 2 días o menos, y
 * gris en lo demás o si no hay fecha. `dias` = fecha límite − hoy (CDMX),
 * el dias_restantes de la vista.
 *
 * Una campaña CERRADA ya no corre contra la fecha: verde si llegó a la meta
 * y gris si el Supervisor la cerró abajo, con motivo (P1). Antes seguía en
 * rojo para siempre y no cuadraba con «vencidas» de vw_comp_avance_analista,
 * que solo cuenta las abiertas (revisión del núcleo, 23-oct-2026).
 */
export function semaforoLimite(
  dias: number | null | undefined,
  completa: boolean,
  // Obligatorio a propósito: que ninguna pantalla lo olvide y pinte de rojo
  // una cerrada. null/undefined = se trata como abierta.
  estatus: 'abierta' | 'cerrada' | null | undefined
): Semaforo {
  if (completa) return 'verde';
  if (estatus === 'cerrada') return 'gris';
  const d = num(dias);
  if (d === null) return 'gris';
  if (d < 0) return 'rojo';
  if (d <= 2) return 'ambar';
  return 'gris';
}

// ------------------------------------------------------------
// Días (CDMX)
// ------------------------------------------------------------

/** ¿El teléfono conoce la zona de CDMX? Se prueba una vez con una hora fija. */
let zonaCdmxOk: boolean | null = null;
function conoceZonaCdmx(): boolean {
  // 03:00 UTC del 1-ene son las 21:00 del 31-dic en CDMX. Si diaCdmx da el
  // 1-ene es que cayó al día UTC (teléfono sin la base de zonas).
  if (zonaCdmxOk === null) zonaCdmxOk = diaCdmx(new Date('2026-01-01T03:00:00Z')) === '2025-12-31';
  return zonaCdmxOk;
}

/**
 * 'YYYY-MM-DD' de hoy en la Ciudad de México (no en la zona del teléfono).
 * Si el teléfono no conoce la zona, diaCdmx cae al día UTC y después de las
 * 18:00 ofrecía «mañana» para marcar, que el servidor rechaza; entonces se
 * usa UTC−6, el horario fijo de CDMX desde que quitaron el de verano en 2022
 * (revisión del núcleo, 23-oct-2026). '' si la fecha no es válida.
 */
export function hoyCdmx(ahora: Date = new Date()): string {
  const ms = ahora.getTime();
  if (Number.isNaN(ms)) return '';
  if (conoceZonaCdmx()) return diaCdmx(ahora);
  return new Date(ms - 6 * 3600 * 1000).toISOString().slice(0, 10);
}

const ES_DIA = /^\d{4}-\d{2}-\d{2}$/;

function sumarDiasIso(dia: string, n: number): string {
  const d = new Date(dia + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Cuántos días atrás se puede fechar una marca (P4, 23-oct-2026). */
export const DIAS_ATRAS_MARCA = 7;

/**
 * Días que se pueden elegir al marcar, de hoy hacia atrás: hoy y hasta 7
 * días antes, pero nunca antes del inicio del periodo (P4). Es lo mismo que
 * valida comp_marcar_sitios; la lista evita que el analista elija un día que
 * el servidor rechazaría. Vacía si el periodo todavía no empieza.
 *
 * Entradas de la vida real (revisión del núcleo, 23-oct-2026): si `hoy` no
 * es 'YYYY-MM-DD' (hoyCdmx da '' con una fecha inválida) devuelve [] en vez
 * de tronar el modal con RangeError; el inicio puede llegar con hora
 * ('2026-10-20T00:00:00') y se compara solo el día, si no el primer día del
 * periodo quedaba fuera.
 */
export function diasParaMarcar(hoy: string, inicioPeriodo?: string | null): string[] {
  const out: string[] = [];
  const h = typeof hoy === 'string' ? hoy.slice(0, 10) : '';
  if (!ES_DIA.test(h) || Number.isNaN(Date.parse(h + 'T00:00:00Z'))) return out;
  const inicio = typeof inicioPeriodo === 'string' ? inicioPeriodo.slice(0, 10) : '';
  for (let i = 0; i <= DIAS_ATRAS_MARCA; i++) {
    const d = sumarDiasIso(h, -i);
    if (inicio && d < inicio) break;
    out.push(d);
  }
  return out;
}

// ------------------------------------------------------------
// Comprobación diaria y carga por analista
// ------------------------------------------------------------

/** Una fila de vw_comp_diaria: sitios que alguien marcó un día en una campaña. */
export type FilaDiaria = {
  campana_id: number;
  /** Quien lleva la campaña HOY (cambia al reasignar). */
  analista_email?: string | null;
  /** Quien marcó: a esta persona va el crédito. */
  comprobado_por: string | null;
  dia: string;
  sitios: number;
};

export type RenglonDiaria = {
  clave: string;
  porDia: Record<string, number>;
  /** Suma de los días mostrados. */
  total: number;
  /** Sitios marcados en días fuera de `dias` (p. ej. después del fin del periodo). */
  fuera: number;
};

const correo = (e: string | null | undefined) => (e || '').trim().toLowerCase();

/**
 * Marcas sin autor (comprobado_por NULL: datos viejos o lo que llegue sin
 * correo en la fase 3). UNA sola regla en la tabla diaria y en los chips
 * (revisión del núcleo, 23-oct-2026): van juntas en un renglón con clave ''
 * que la pantalla rotula ETIQUETA_SIN_REGISTRO, siempre al final; no se
 * descartan, para que las dos vistas del Supervisor sumen lo mismo.
 */
export const CLAVE_SIN_REGISTRO = '';
export const ETIQUETA_SIN_REGISTRO = '(sin registro)';

/**
 * La hoja COMPROBACIÓN DIARIA: un renglón por campaña o por analista y una
 * columna por día de `dias` (los del periodo; ocupacionVV.diasDelRango).
 * Un día sin marcas vale 0, no falta.
 *
 * Por analista, el CRÉDITO es de quien marcó (comprobado_por), no de quien
 * lleva la campaña hoy (analista_email): con "Pasar lo pendiente", lo que
 * comprobó A no debe sumársele a B (crítica de la fase 2, 23-oct-2026). La
 * clave es el correo en minúsculas; CLAVE_SIN_REGISTRO si la fila no lo trae.
 *
 * `fuera` = sitios marcados en días que no están en `dias`. P4 deja fechar
 * hasta 7 días atrás y el periodo puede seguir marcándose después de su fin,
 * así que la pantalla DEBE mostrarlo como columna «Fuera del periodo»: si no,
 * el total de la hoja no cuadra con lo comprobado.
 * Orden: mayor total primero, luego la clave; sin registro al final.
 */
export function pivotDiaria(
  filas: FilaDiaria[],
  dias: string[],
  por: 'campana' | 'analista'
): RenglonDiaria[] {
  const enRango = new Set(dias);
  const mapa = new Map<string, RenglonDiaria>();
  for (const f of filas) {
    const clave = por === 'campana' ? String(f.campana_id) : correo(f.comprobado_por);
    let r = mapa.get(clave);
    if (!r) {
      r = { clave, porDia: Object.fromEntries(dias.map((d) => [d, 0])), total: 0, fuera: 0 };
      mapa.set(clave, r);
    }
    const n = num(f.sitios) ?? 0;
    const dia = (f.dia || '').slice(0, 10);
    if (enRango.has(dia)) {
      r.porDia[dia] += n;
      r.total += n;
    } else {
      r.fuera += n;
    }
  }
  return [...mapa.values()].sort((a, b) => {
    const sa = a.clave === CLAVE_SIN_REGISTRO;
    if (sa !== (b.clave === CLAVE_SIN_REGISTRO)) return sa ? 1 : -1;
    return b.total - a.total || (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0);
  });
}

/** Lo que se usa de una fila de vw_comp_campanas. */
export type CampanaFila = DatosMeta & {
  id: number;
  unidad: UnidadComp;
  medio: MedioComp;
  periodo_id: number;
  campana: string;
  version: string;
  analista_email: string | null;
  estatus: 'abierta' | 'cerrada';
  comprobados: number;
  pendientes: number;
  comprobados_hoy?: number | null;
  /** La de la vista; si no viene, se calcula con metaDe. */
  meta?: number | null;
  /** De dónde salió la meta, como vw_comp_campanas.meta_fuente. */
  meta_fuente?: 'app' | 'full' | 'sitios' | null;
  pct?: number | null;
  completa?: boolean | null;
  fecha_limite_efectiva?: string | null;
  /**
   * Como vw_comp_campanas.fecha_limite_fuente: 'app' (la puso el
   * Supervisor), 'regla' (comp_reglas) o 'fin' (fin de la campaña o del
   * periodo). Ya no hay 'archivo': con el rediseño (23-oct-2026) las
   * campañas no salen de un Excel de comprobaciones con fecha límite, y la
   * vista dejó de devolverlo; si el tipo lo conservara, la pantalla
   * seguiría pintando una etiqueta que nunca llega.
   */
  fecha_limite_fuente?: 'app' | 'regla' | 'fin' | null;
  dias_restantes?: number | null;
  /**
   * La campaña ya no vino en la carga completa de Pauta VV o del plano, o
   * la reemplazó otra versión (R1/R2 de la SQL, 23-oct-2026): sigue abierta
   * pero sin pendientes ni tomas por hacer.
   */
  retirada?: boolean | null;
};

/** Sitios comprobados por alguien (vw_comp_diaria, ya filtrada al periodo y unidad). */
export type Credito = { comprobado_por: string | null; dia?: string | null; sitios: number };

export type CargaAnalista = {
  /**
   * Correo en minúsculas. null = "Sin analista" (campañas sin asignar);
   * CLAVE_SIN_REGISTRO ('') = crédito de marcas sin autor.
   */
  email: string | null;
  /** Carga: campañas que lleva HOY (analista_email). */
  campanas: number;
  abiertas: number;
  meta: number;
  /** Sitios por comprobar SOLO de sus campañas abiertas: lo de una cerrada ya no se marca. */
  pendientes: number;
  /** Lo comprobado en SUS campañas, lo haya marcado quien sea. */
  comprobadosCarga: number;
  /** % de avance de su carga: comprobadosCarga / meta. */
  pct: number | null;
  /** CRÉDITO: sitios que esta persona marcó (comprobado_por), en cualquier campaña. */
  comprobados: number;
  /** Crédito con día de comprobación = `hoy` (comprobado_dia, no la hora en que se marcó). */
  hoy: number;
};

/** Para ordenar: personas, luego "(sin registro)", luego "Sin analista". */
const rangoCarga = (e: string | null) => (e === null ? 2 : e === CLAVE_SIN_REGISTRO ? 1 : 0);

/**
 * Chips "carga por analista" del Supervisor. Dos cosas distintas que no se
 * deben mezclar (crítica de la fase 2, 23-oct-2026):
 *   · la CARGA (campañas, meta, pendientes y su %) es de quien lleva la
 *     campaña hoy: analista_email;
 *   · el CRÉDITO (comprobados, hoy) es de quien marcó: comprobado_por, que
 *     no se mueve al reasignar.
 * Quien solo tiene crédito (p. ej. ya le pasaron todo lo pendiente a otra)
 * sale con carga 0. Los pendientes son solo de las campañas ABIERTAS: los de
 * una cerrada abajo de la meta (P1) inflaban la carga con la que el
 * Supervisor reparte (revisión del núcleo, 23-oct-2026). El crédito sin
 * autor va al renglón CLAVE_SIN_REGISTRO, igual que en pivotDiaria.
 * Orden: personas por campañas abiertas, luego meta, luego correo; después
 * "(sin registro)" y al final "Sin analista".
 */
export function cargaPorAnalista(
  campanas: CampanaFila[],
  creditos: Credito[],
  hoy?: string
): CargaAnalista[] {
  const mapa = new Map<string, CargaAnalista>();
  // null ("Sin analista") y '' ("sin registro") son renglones distintos; un
  // correo nunca lleva espacios, así que '(sin analista)' no choca con nadie.
  const de = (email: string | null) => {
    const k = email === null ? '(sin analista)' : email;
    let r = mapa.get(k);
    if (!r) {
      r = {
        email,
        campanas: 0,
        abiertas: 0,
        meta: 0,
        pendientes: 0,
        comprobadosCarga: 0,
        pct: null,
        comprobados: 0,
        hoy: 0,
      };
      mapa.set(k, r);
    }
    return r;
  };
  for (const c of campanas) {
    const r = de(correo(c.analista_email) || null);
    r.campanas++;
    if (c.estatus === 'abierta') {
      r.abiertas++;
      r.pendientes += num(c.pendientes) ?? 0;
    }
    r.meta += num(c.meta) ?? metaDe(c);
    r.comprobadosCarga += num(c.comprobados) ?? 0;
  }
  for (const k of creditos) {
    const r = de(correo(k.comprobado_por));
    const n = num(k.sitios) ?? 0;
    r.comprobados += n;
    if (hoy && (k.dia || '').slice(0, 10) === hoy) r.hoy += n;
  }
  const out = [...mapa.values()];
  for (const r of out) r.pct = pctAvance(r.comprobadosCarga, r.meta);
  return out.sort((a, b) => {
    const ra = rangoCarga(a.email);
    const rb = rangoCarga(b.email);
    if (ra !== rb) return ra - rb;
    return (
      b.abiertas - a.abiertas ||
      b.meta - a.meta ||
      ((a.email || '') < (b.email || '') ? -1 : (a.email || '') > (b.email || '') ? 1 : 0)
    );
  });
}

// ------------------------------------------------------------
// Plan de tomas (= renglones del «Formato general»)
// ------------------------------------------------------------
//
// Rediseño de Erik (23-oct-2026): Victor ya no sube el Formato general
// lleno; elige un PLAN por campaña o en lote y la app genera los renglones
// día × sitio. Lo que sigue es ESPEJO EXACTO de comp_generar_tomas en SQL:
// las dos tienen que dar las MISMAS fechas para el mismo plan y la misma
// vigencia. La tabla de casos que comparten vive en
// tests/comprobaciones.test.mjs (CASOS_PLAN); si una regla cambia aquí,
// cambia allá, y al revés.

export type TipoPlan = 'inicio' | 'inicio_fin' | 'cada_n' | 'diario' | 'fechas';

/** Lo que se guarda en comp_campanas.plan_tomas (jsonb) y recibe comp_generar_tomas. */
export type PlanTomas = {
  tipo: TipoPlan;
  /** Solo 'cada_n': entero de 1 a 366 (MAX_CADA_N). */
  cada_n?: number | null;
  /** Solo 'fechas': 'YYYY-MM-DD'. */
  fechas?: string[] | null;
  /**
   * R11 de la SQL (23-oct-2026): sin esto, el plan NO le crea tomas nuevas a
   * un sitio que ya está comprobado (conserva las que tenía). Solo existe si
   * es true, igual que en comp_plan_normal.
   */
  incluir_comprobados?: true;
};

export const TIPOS_PLAN: readonly TipoPlan[] = ['inicio', 'inicio_fin', 'cada_n', 'diario', 'fechas'];

/** Palabras de Erik (23-oct-2026) para el selector del plan. */
export const ETIQUETA_PLAN: Record<TipoPlan, string> = {
  inicio: 'Al inicio',
  inicio_fin: 'Inicio y fin',
  cada_n: 'Cada N días',
  diario: 'Diario',
  fechas: 'Fechas a mano',
};


/** Tope de días de una ventana: un periodo es un mes o una catorcena; nada debe pasar de esto. */
const TOPE_DIAS_PLAN = 400;

/**
 * «Cada N días» acepta N de 1 a 366, igual que comp_plan_normal. Antes aquí
 * pasaba cualquier entero ≥ 1: con 367 la pantalla dejaba mandar un plan que
 * la base rechazaba, y con N enorme sumarDiasIso tronaba con RangeError y se
 * caía la vista previa (revisión del núcleo, 23-oct-2026).
 */
export const MAX_CADA_N = 366;

/**
 * Errores del plan: los MISMOS textos que lanza comp_plan_normal, para que
 * la pantalla diga antes de mandar lo mismo que diría la base.
 */
export const MENSAJES_PLAN = {
  tipo: 'Plan de tomas no válido: elige «al inicio», «inicio y fin», «cada N días», «diario» o «fechas a mano».',
  cada_n: 'Para «cada N días» escribe N (de 1 a 366).',
  sinFechas: 'Para «fechas a mano» elige al menos una fecha.',
  fechaRara: 'Hay una fecha del plan que no se entiende.',
} as const;

/**
 * 'YYYY-MM-DD' si `x` es un día de calendario válido (acepta una marca con
 * hora, '2026-08-01T00:00:00', y se queda con el día), si no null.
 * '2026-02-30' es null: Date.UTC lo pasaría al 2-mar sin avisar, y Postgres
 * lo rechaza al convertir a date.
 */
export function diaIso(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const d = x.trim().slice(0, 10);
  if (!ES_DIA.test(d)) return null;
  const ms = Date.parse(d + 'T00:00:00Z');
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === d ? d : null;
}

/** Como btrim() de Postgres: solo espacios normales, no tabuladores ni el espacio duro. */
const btrim = (s: string) => s.replace(/^ +| +$/g, '');

/**
 * Una fecha de «fechas a mano»: 'YYYY-MM-DD', opcionalmente con hora y sin
 * zona ('2026-08-03T10:00:00'). Nada más: ni '3/8/2026' (Postgres, con
 * DateStyle MDY, lo leía como 8 de marzo y la campaña se quedaba sin tomas
 * y sin error) ni números (20260803). La pieza SQL debe usar la misma regla
 * (revisión del núcleo, 23-oct-2026):
 *   btrim(x) ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$'
 *   y luego left(btrim(x), 10)::date (solo el día: la hora no lo mueve).
 */
const ES_FECHA_PLAN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

/** El día de una fecha del plan; undefined = vacía (se ignora, como el nullif de SQL); null = no se entiende. */
function fechaDelPlan(x: unknown): string | null | undefined {
  if (x === null || x === undefined) return undefined;
  if (typeof x !== 'string') return null;
  const s = btrim(x);
  if (s === '') return undefined;
  if (!ES_FECHA_PLAN.test(s)) return null;
  return diaIso(s.slice(0, 10));
}

/**
 * Entero de «cada N» como lo convierte (p->>'cada_n')::int: un número entero
 * o un texto de solo dígitos (con signo y espacios a los lados). true, '1e1'
 * y '3.0' no son enteros para Postgres, así que aquí tampoco (antes true
 * daba 1 y '1e1' daba 10).
 */
function enteroPlan(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^[ \t\n\r\f\v]*[+-]?\d+[ \t\n\r\f\v]*$/.test(v)) return Number(v.trim());
  return null;
}

export type LecturaPlan = { plan: PlanTomas; error: null } | { plan: null; error: string };

/**
 * ESPEJO de comp_plan_normal (23-oct-2026): lee el plan tal como llega (jsonb
 * de la base, estado de la pantalla) y devuelve el plan limpio, o el motivo
 * del error con el MISMO texto que la base.
 *   · tipo: uno de TIPOS_PLAN, exacto ('INICIO' no);
 *   · cada_n: entero de 1 a 366 (un texto de dígitos también, como ::int);
 *   · fechas: arreglo con al menos una; las vacías (null, '') se ignoran,
 *     pero UNA que no se entienda rechaza todo el plan, como la base. Antes
 *     aquí se tiraba sin avisar y la base rechazaba el lote completo.
 *     Quedan sin repetir y en orden.
 *   · incluir_comprobados: se conserva SOLO si viene exactamente true (como
 *     p->'incluir_comprobados' = 'true'::jsonb); 'true' como texto o 1 no.
 *     Antes aquí se tiraba, y la vista previa contaba tomas nuevas para
 *     sitios comprobados que la base no iba a crear (23-oct-2026).
 * Lo demás del objeto se ignora (cada_n en un plan diario, etc.).
 */
export function leerPlan(x: unknown): LecturaPlan {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { plan: null, error: MENSAJES_PLAN.tipo };
  const o = x as Record<string, unknown>;
  const tipo = o.tipo;
  if (typeof tipo !== 'string' || !(TIPOS_PLAN as readonly string[]).includes(tipo)) {
    return { plan: null, error: MENSAJES_PLAN.tipo };
  }
  let n: number | null = null;
  if (tipo === 'cada_n') {
    n = enteroPlan(o.cada_n);
    if (n === null || n < 1 || n > MAX_CADA_N) return { plan: null, error: MENSAJES_PLAN.cada_n };
  }
  let fechas: string[] | null = null;
  if (tipo === 'fechas') {
    const crudas = o.fechas;
    if (!Array.isArray(crudas) || crudas.length === 0) return { plan: null, error: MENSAJES_PLAN.sinFechas };
    const dias = new Set<string>();
    for (const c of crudas) {
      const d = fechaDelPlan(c);
      if (d === undefined) continue;
      if (d === null) return { plan: null, error: MENSAJES_PLAN.fechaRara };
      dias.add(d);
    }
    if (!dias.size) return { plan: null, error: MENSAJES_PLAN.sinFechas };
    fechas = [...dias].sort();
  }
  const plan: PlanTomas = { tipo: tipo as TipoPlan, cada_n: n, fechas };
  // La llave solo existe si es true: un plan sin ella sale idéntico al de
  // antes (deepEqual estricto distingue «undefined» de «no está»).
  if (o.incluir_comprobados === true) plan.incluir_comprobados = true;
  return { plan, error: null };
}

/** El plan limpio (lo que guarda comp_plan_normal) o null si no sirve. */
export function normalizarPlan(x: unknown): PlanTomas | null {
  return leerPlan(x).plan;
}

/**
 * null si el plan sirve; si no, el motivo para la pantalla (el mismo texto
 * que lanzaría comp_generar_tomas). Recibe el plan crudo: no hace falta
 * normalizarlo antes.
 */
export function validarPlan(x: unknown): string | null {
  return leerPlan(x).error;
}

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** '2026-08-03' → '3 ago' (el día ya es de CDMX: no pasa por ninguna zona). */
function diaCorto(d: string): string {
  return `${Number(d.slice(8, 10))} ${MESES_CORTOS[Number(d.slice(5, 7)) - 1]}`;
}

/** Texto corto del plan para la lista de campañas: «Cada 3 días», «Fechas: 3 ago, 10 ago». */
export function describirPlan(x: unknown): string {
  const { plan, error } = leerPlan(x);
  if (!plan) {
    const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
    if (o?.tipo === 'cada_n') {
      const c = o.cada_n;
      return c === null || c === undefined || c === '' ? 'Cada N días (falta el número)' : 'Cada N días (número no válido)';
    }
    if (o?.tipo === 'fechas') {
      return error === MENSAJES_PLAN.fechaRara ? 'Fechas a mano (hay una que no se entiende)' : 'Fechas a mano (ninguna)';
    }
    return 'Sin plan';
  }
  // R11 (23-oct-2026): que se vea en la lista que este plan sí vuelve a
  // pedir toma de los sitios ya comprobados.
  const extra = plan.incluir_comprobados ? ' (también comprobados)' : '';
  if (plan.tipo === 'cada_n') return (plan.cada_n === 1 ? 'Cada día' : `Cada ${plan.cada_n} días`) + extra;
  if (plan.tipo === 'fechas') {
    const f = plan.fechas ?? [];
    const muestra = f.slice(0, 4).map(diaCorto).join(', ');
    return `Fechas: ${muestra}${f.length > 4 ? ` y ${f.length - 4} más` : ''}${extra}`;
  }
  return ETIQUETA_PLAN[plan.tipo] + extra;
}

/** Días de a hasta b, dos 'YYYY-MM-DD' válidos. */
function restaDias(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/**
 * Las fechas de toma de UN sitio: espejo de comp_generar_tomas.
 * `inicio` y `fin` son UNA ventana YA recortada (ventanasToma), inclusiva;
 * con tramos separados se llama una vez por ventana.
 *   · 'inicio'     → [inicio]
 *   · 'inicio_fin' → [inicio, fin]; una sola si coinciden
 *   · 'cada_n'     → inicio, inicio+n, inicio+2n… mientras ≤ fin. El fin
 *                    NO se agrega si no cae en la cuenta (igual que
 *                    generate_series(inicio, fin, n días))
 *   · 'diario'     → todos los días de inicio a fin
 *   · 'fechas'     → solo las que caen en [inicio, fin], sin repetir, en orden
 * El plan puede llegar CRUDO: se lee con leerPlan por dentro (antes, con
 * cada_n '3' sin normalizar daba [] y la base 11 fechas). Sin ventana
 * (inicio o fin inválidos, o inicio > fin: el sitio no corre en el periodo)
 * o con un plan inválido → []; la SQL, con un plan inválido, lanza error y
 * la pantalla ya lo frenó con validarPlan. Nunca más de 400 días.
 */
export function generarFechasPlan(
  plan: unknown,
  inicio: string | null | undefined,
  fin: string | null | undefined
): string[] {
  const a = diaIso(inicio);
  const b = diaIso(fin);
  const p = normalizarPlan(plan);
  if (!a || !b || a > b || !p) return [];
  switch (p.tipo) {
    case 'inicio':
      return [a];
    case 'inicio_fin':
      return a === b ? [a] : [a, b];
    case 'diario':
    case 'cada_n': {
      const n = p.tipo === 'diario' ? 1 : (p.cada_n as number);
      const out: string[] = [];
      for (let d = a; d <= b && out.length < TOPE_DIAS_PLAN; d = sumarDiasIso(d, n)) out.push(d);
      return out;
    }
    case 'fechas':
      return (p.fechas ?? []).filter((d) => d >= a && d <= b);
    default:
      return [];
  }
}

/**
 * Cuántas fechas daría generarFechasPlan, SIN armar la lista (vista previa
 * de cientos de campañas en un teléfono). `p` ya leído; a y b válidos.
 */
function contarFechas(p: PlanTomas, a: string, b: string): number {
  if (a > b) return 0;
  switch (p.tipo) {
    case 'inicio':
      return 1;
    case 'inicio_fin':
      return a === b ? 1 : 2;
    case 'diario':
    case 'cada_n': {
      const n = p.tipo === 'diario' ? 1 : (p.cada_n as number);
      return Math.min(Math.floor(restaDias(a, b) / n) + 1, TOPE_DIAS_PLAN);
    }
    case 'fechas': {
      let k = 0;
      for (const d of p.fechas ?? []) if (d >= a && d <= b) k++;
      return k;
    }
    default:
      return 0;
  }
}

type Vigencia = { inicio?: string | null; fin?: string | null } | null | undefined;

/** Un tramo de vigencia del mismo sitio en la misma versión (comp_sitios.tramos, R10). */
export type TramoVigencia = { inicio?: string | null; fin?: string | null };

/** Vigencia del sitio: su inicio y fin y, si corre en tramos separados, la lista. */
export type VigenciaSitio =
  | { inicio?: string | null; fin?: string | null; tramos?: TramoVigencia[] | null }
  | null
  | undefined;

export type Ventana = { inicio: string; fin: string };

/** El día siguiente de un 'YYYY-MM-DD' válido (para juntar tramos que se tocan). */
const diaSiguiente = (d: string) => sumarDiasIso(d, 1);

/** greatest()/least() de Postgres: IGNORAN los NULL; todos NULL → null. */
function mayorDia(...xs: (string | null)[]): string | null {
  let r: string | null = null;
  for (const x of xs) if (x !== null && (r === null || x > r)) r = x;
  return r;
}
function menorDia(...xs: (string | null)[]): string | null {
  let r: string | null = null;
  for (const x of xs) if (x !== null && (r === null || x < r)) r = x;
  return r;
}

/**
 * Ventanas de toma de un sitio: ESPEJO EXACTO de comp_ventanas en SQL
 * (rediseño del 23-oct-2026, R3 y R10 de la revisión de la SQL). Antes aquí
 * se usaba coalesce (la vigencia del sitio GANABA a la de la campaña) y la
 * base ya usaba la intersección: en 139 de 306 casos la vista previa
 * mostraba tomas que la base no iba a crear, todos con el sitio corriendo
 * más allá de la campaña (p. ej. Victor recorta la campaña en la app y la
 * pantalla seguía ofreciendo los días recortados).
 *
 * Regla: la vigencia del sitio RECORTADA por la de la campaña y la del
 * periodo, por cada tramo del sitio:
 *   inicio = greatest(tramo.inicio, campaña.inicio, periodo.inicio)
 *   fin    = least(tramo.fin, campaña.fin, periodo.fin)
 * greatest/least ignoran los vacíos, así que un extremo sin fecha toma el
 * de la campaña y, si tampoco, el del periodo. Un tramo queda solo si
 * inicio ≤ fin (en SQL, un extremo NULL tampoco pasa el filtro a <= b).
 *   · Sin `tramos` (o arreglo vacío) el único tramo es inicio/fin del sitio;
 *     con `tramos`, SOLO cuentan los tramos (como la SQL, que ignora
 *     inicio/fin del sitio en ese caso).
 *   · Los tramos que se enciman o se tocan (del 1 al 5 y del 6 al 9) se
 *     juntan en uno: «al inicio» no da dos tomas.
 *   · [] = el sitio no corre en este periodo, o el periodo no trae sus dos
 *     fechas (o vienen al revés): sin periodo no se ofrecen tomas.
 * Una fecha que no se entiende cuenta como vacía (la SQL ni siquiera la
 * aceptaría: la columna es date). Orden: por inicio.
 */
export function ventanasToma(
  sitio: VigenciaSitio,
  campana: Vigencia,
  periodo: Vigencia
): Ventana[] {
  const ci = diaIso(campana?.inicio);
  const cf = diaIso(campana?.fin);
  const pi = diaIso(periodo?.inicio);
  const pf = diaIso(periodo?.fin);
  // Sin periodo completo no hay ventana (revisión 3 del núcleo, 23-oct-2026).
  // greatest/least ignoran los vacíos, así que un periodo sin fechas (una
  // catorcena de la tabla con fechas null) dejaba la ventana solo con el
  // sitio o la campaña y la vista previa ofrecía hasta 400 tomas por sitio
  // que la base nunca crea. En SQL no pasa: comp_periodos siempre trae las
  // dos fechas, así que la paridad con comp_ventanas no cambia.
  if (pi === null || pf === null || pi > pf) return [];
  const tramos: TramoVigencia[] =
    Array.isArray(sitio?.tramos) && sitio.tramos.length ? sitio.tramos : [{ inicio: sitio?.inicio, fin: sitio?.fin }];
  const recortados: Ventana[] = [];
  for (const t of tramos) {
    const a = mayorDia(diaIso(t?.inicio), ci, pi);
    const b = menorDia(diaIso(t?.fin), cf, pf);
    if (a !== null && b !== null && a <= b) recortados.push({ inicio: a, fin: b });
  }
  recortados.sort((x, y) => (x.inicio < y.inicio ? -1 : x.inicio > y.inicio ? 1 : x.fin < y.fin ? -1 : x.fin > y.fin ? 1 : 0));
  const out: Ventana[] = [];
  for (const v of recortados) {
    const ult = out[out.length - 1];
    // Se toca o se encima con lo anterior (a ≤ máximo fin + 1 día): se junta.
    if (ult && v.inicio <= diaSiguiente(ult.fin)) {
      if (v.fin > ult.fin) ult.fin = v.fin;
    } else {
      out.push({ ...v });
    }
  }
  return out;
}

/**
 * La ventana de toma de un sitio en una sola pieza: del inicio del primer
 * tramo al fin del último (ventanasToma). Sin tramos es exactamente la
 * intersección de la vigencia del sitio, la de la campaña y la del periodo
 * (comp_ventanas). Nunca se sale del periodo ni de la campaña. null si el
 * sitio no corre en este periodo. Para generar tomas usa ventanasToma: con
 * tramos separados, esta ventana incluye el hueco.
 */
export function ventanaToma(sitio: VigenciaSitio, campana: Vigencia, periodo: Vigencia): Ventana | null {
  const vs = ventanasToma(sitio, campana, periodo);
  if (!vs.length) return null;
  return { inicio: vs[0].inicio, fin: vs[vs.length - 1].fin };
}

/**
 * Las fechas del plan para un sitio, por cada una de sus ventanas (como
 * comp_aplicar_planes: comp_fechas_plan por ventana y distinct). Las
 * ventanas ya vienen juntadas y en orden, así que no se repiten fechas.
 */
function fechasDeVentanas(p: PlanTomas, vs: Ventana[]): string[] {
  const out: string[] = [];
  for (const v of vs) for (const d of generarFechasPlan(p, v.inicio, v.fin)) out.push(d);
  return out;
}

/** ¿Sábado o domingo? (isodow 6 o 7 en SQL). El día ya es de CDMX: se lee en UTC para no moverlo. */
export function esFinDeSemana(fecha: string): boolean {
  const d = diaIso(fecha);
  if (!d) return false;
  const dow = new Date(d + 'T00:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Horario de la toma según el día, como la bitácora: «HORARIO LUNES A
 * VIERNES» o «HORARIO SABADO Y DOMINGO». Espejo de comp_generar_tomas:
 *   nullif(btrim(case when extract(isodow from fecha) in (6, 7) then horario_sd else horario_lv end), '')
 * SIN caer al otro horario: si el de fin de semana viene en blanco puede ser
 * que la campaña no corra sábado y domingo, y adivinar le mandaría al
 * monitorista una franja que no existe (23-oct-2026). El renglón sale sin
 * horario y Victor lo ve en el Formato general. Como btrim, solo quita
 * espacios normales. null también si la fecha no es válida.
 */
export function horarioDelDia(
  lv: string | null | undefined,
  sd: string | null | undefined,
  fecha: string
): string | null {
  if (!diaIso(fecha)) return null;
  const t = esFinDeSemana(fecha) ? sd : lv;
  if (typeof t !== 'string') return null;
  const limpio = btrim(t);
  return limpio === '' ? null : limpio;
}

/**
 * Erik (23-oct-2026): «Biobox y Ecovallas no tienen pautas por horarios,
 * todo es 24 hrs, como en Vía Verde que sí lo hace por franjas horarias».
 * Así que en Ecovallas Digital (Pantalla) y Biobox (Máquina) el horario de
 * TODA toma es «24 HORAS», sin lunes a viernes ni sábado y domingo y sin
 * franjas; solo Vía Verde (Columna y Pórtico) lleva el horario del día.
 */
export const HORARIO_24H = '24 HORAS';

/**
 * Llaves (llaveComp) de los medios y unidades que corren 24 horas. Incluye
 * la etiqueta que da la propia vista (vw_comp_campanas.unidad_etiqueta =
 * 'Ecovallas Digital'): antes solo se aceptaban los nombres exactos y con
 * esa etiqueta, o con 'Maquina' sin acento o 'BIOBOX', se enseñaba el
 * horario crudo (revisión 3 del núcleo, 23-oct-2026).
 */
const LLAVES_24H = new Set(['PANTALLA', 'MAQUINA', 'ECOVALLAS', 'ECOVALLASDIGITAL', 'BIOBOX']);

/**
 * ¿Este medio (o unidad) corre 24 horas, sin franjas? Pantalla/Máquina,
 * Ecovallas/Ecovallas Digital o Biobox; sin importar acentos, mayúsculas ni
 * espacios. Vía Verde, Columna y Pórtico no.
 */
export function esMedio24h(medioOUnidad: MedioComp | UnidadComp | string | null | undefined): boolean {
  return LLAVES_24H.has(llaveComp(medioOUnidad));
}

/** ¿El texto dice «24 horas»? El mismo patrón que leerHorario (importadorComp). */
function dice24h(s: string): boolean {
  const t = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  return /^(24 ?H(RS?|ORAS)?\.?|00:00 ?- ?23:59( ?HRS)?)$/.test(t);
}

/**
 * HORARIO de una toma de Ecovallas Digital o Biobox (Erik, 23-oct-2026):
 * «24 HORAS» si la bitácora dice 24 horas o no trae nada (sábado y domingo
 * vacíos); si trae una franja («3 PM A 4 PM», «6:00 AM A 15:00 HRS») o
 * «PROGRAMMATIC», el texto tal cual, como en los Excel de hoy (en la CAT 21
 * son el 14% de los sitios de Ecovallas y el 5% de Biobox). Antes salía
 * «24 HORAS» siempre y el monitorista iba a una hora en que el anuncio no
 * sale (revisión 2, punta-a-punta-1).
 */
export function horario24hOFranja(horario: string | null | undefined): string {
  const s = typeof horario === 'string' ? horario.trim() : '';
  return s === '' || dice24h(s) ? HORARIO_24H : s;
}

/**
 * El HORARIO que se le enseña a la gente (Excel, pantalla): en Ecovallas
 * Digital y Biobox, horario24hOFranja; en Vía Verde, el horario del día tal
 * como lo guardó la base (horario_texto), recortado.
 */
export function horarioParaMostrar(
  medioOUnidad: MedioComp | UnidadComp | string | null | undefined,
  horario: string | null | undefined
): string | null {
  if (esMedio24h(medioOUnidad)) return horario24hOFranja(horario);
  const s = typeof horario === 'string' ? horario.trim() : '';
  return s === '' ? null : s;
}

/**
 * OBSERVACIONES del renglón que lee el monitorista. En los Excel de hoy esa
 * columna lleva la ESPECIFICACIÓN DE TOMAS de la campaña («DEL 01 AL 31 DE
 * AGOSTO. FOTOS A MAS TARDAR EL 10 DE AGOSTO…»), no la observación suelta
 * del sitio; sin ella el monitorista no sabía qué foto tomar (revisión del
 * núcleo, 23-oct-2026). Así que: especificación de la campaña · observación
 * del sitio o de la toma. Si una ya contiene a la otra (p. ej. si la base un
 * día guarda la concatenación en comp_tomas.observaciones) no se repite; se
 * compara con llaveComp, así que espacios y acentos no cuentan. null si no
 * hay nada.
 */
export function observacionesToma(
  especificacion: string | null | undefined,
  observaciones: string | null | undefined
): string | null {
  const e = (especificacion || '').trim();
  const o = (observaciones || '').trim();
  if (!e) return o || null;
  if (!o) return e;
  const ke = llaveComp(e);
  const ko = llaveComp(o);
  if (ko.includes(ke)) return o;
  if (ke.includes(ko)) return e;
  return `${e} · ${o}`;
}

/**
 * Orden "natural" de claves de sitio, sin depender del idioma de la
 * computadora: los números se comparan como números, así MX_CM_VV_COL_448
 * va antes que MX_CM_VV_COL_1000 (como texto quedaba al revés; revisión del
 * núcleo, 23-oct-2026). Sin distinguir mayúsculas. Si solo difieren en
 * ceros a la izquierda ('POR_08' / 'POR_8'), va primero el más corto.
 */
export function compararNatural(a: string | null | undefined, b: string | null | undefined): number {
  const x = (a ?? '').toUpperCase().split(/(\d+)/);
  const y = (b ?? '').toUpperCase().split(/(\d+)/);
  let empate = 0;
  const m = Math.min(x.length, y.length);
  for (let i = 0; i < m; i++) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    if (i % 2 === 1) {
      // split con grupo deja los dígitos en las posiciones impares.
      const pn = p.replace(/^0+/, '');
      const qn = q.replace(/^0+/, '');
      if (pn.length !== qn.length) return pn.length - qn.length;
      if (pn !== qn) return pn < qn ? -1 : 1;
      if (!empate) empate = p.length - q.length;
    } else {
      return p < q ? -1 : 1;
    }
  }
  return x.length - y.length || empate;
}

/** Un sitio de la campaña con su vigencia y horario (comp_sitios). */
export type SitioPlan = {
  sitio_clave: string;
  inicio?: string | null;
  fin?: string | null;
  /** comp_sitios.tramos: vigencias separadas del mismo sitio (R10); null = un solo tramo. */
  tramos?: TramoVigencia[] | null;
  horario_lv?: string | null;
  horario_sd?: string | null;
  observaciones?: string | null;
  /** comp_sitios.estado: un 'cancelado' no lleva tomas. */
  estado?: 'pendiente' | 'comprobado' | 'cancelado' | null;
  /** La última carga ya no lo trajo: no genera tomas nuevas. */
  fuera_de_carga?: boolean | null;
};

/**
 * Lo que se usa de la campaña: su vigencia, su especificación de tomas y
 * (revisión 3 del núcleo, 23-oct-2026) su estatus, si está retirada y su
 * medio o unidad. Sin estatus ni retirada se toma como abierta y vigente,
 * como antes.
 */
export type CampanaPlan =
  | {
      inicio?: string | null;
      fin?: string | null;
      especificacion?: string | null;
      /** comp_campanas.estatus: una 'cerrada' no recibe tomas del plan. */
      estatus?: 'abierta' | 'cerrada' | null;
      /** comp_campanas.retirada: tampoco recibe tomas del plan. */
      retirada?: boolean | null;
      /** Medio o unidad: con él sale horarioMostrar («24 HORAS» en Ecovallas y Biobox). */
      medio?: MedioComp | string | null;
      unidad?: UnidadComp | string | null;
    }
  | null
  | undefined;

/** Por qué el plan no toca una campaña: cerrada o retirada. */
export type CampanaOmitida = 'cerrada' | 'retirada';

/**
 * ¿El plan se salta esta campaña? Espejo de comp_aplicar_planes: comp_ap_cam
 * solo toma las de estatus 'abierta' y comp_ap_sit deja fuera las retiradas
 * (where not c.retirada). Antes la vista previa les contaba todos sus
 * renglones (8 en una retirada y 8 en una cerrada donde la base crea 0;
 * revisión 3 del núcleo, 23-oct-2026). Cerrada gana a retirada porque es la
 * primera que filtra la base. null = el plan sí la toca.
 */
export function campanaOmitidaDelPlan(campana: CampanaPlan): CampanaOmitida | null {
  if (campana?.estatus === 'cerrada') return 'cerrada';
  if (campana?.retirada === true) return 'retirada';
  return null;
}

/**
 * ¿El plan le crea tomas a este sitio? Mismo filtro que comp_aplicar_plan:
 * s.estado <> 'cancelado' and not s.fuera_de_carga. Sin esto la vista previa
 * contaba los cancelados y daba más renglones que la base (930 contra 775 en
 * una campaña de 30 sitios con 5 cancelados; revisión del núcleo, 23-oct-2026).
 */
export function sitioEntraAlPlan(s: Pick<SitioPlan, 'estado' | 'fuera_de_carga'>): boolean {
  return s.estado !== 'cancelado' && !s.fuera_de_carga;
}

/**
 * ¿El plan le CREA tomas nuevas a este sitio? Además de entrar al plan, un
 * sitio ya comprobado no recibe tomas nuevas salvo que el plan traiga
 * incluir_comprobados (R11 de la SQL, 23-oct-2026: «crea» en
 * comp_aplicar_planes). OJO: no conserva TODAS sus tomas de antes; la base
 * solo le deja las pendientes del plan que también da el plan nuevo (y las
 * hechas a mano o ya trabajadas); las demás pendientes del plan se borran
 * (paso 3 de comp_aplicar_planes; revisión 3 del núcleo, 23-oct-2026). Aquí
 * solo se cuenta lo nuevo.
 */
export function sitioRecibeTomasNuevas(
  s: Pick<SitioPlan, 'estado' | 'fuera_de_carga'>,
  plan: Pick<PlanTomas, 'incluir_comprobados'> | null | undefined
): boolean {
  return sitioEntraAlPlan(s) && (s.estado !== 'comprobado' || plan?.incluir_comprobados === true);
}

/** Un renglón generado del Formato general (una toma de comp_tomas). */
export type RenglonPlan = {
  sitio_clave: string;
  fecha: string;
  /** El que guarda la base (comp_tomas.horario_texto): horarioDelDia. La paridad con la SQL va con este. */
  horario: string | null;
  /**
   * El que se le enseña a Victor: horarioParaMostrar con el medio (o la
   * unidad) de la campaña. «24 HORAS» en Ecovallas y Biobox, igual que el
   * Excel; antes la vista previa enseñaba el crudo (null en sábado y domingo
   * si la bitácora de Biobox solo trae una columna) y el Excel «24 HORAS»
   * (revisión 3 del núcleo, 23-oct-2026). Sin medio, igual a horario.
   */
  horarioMostrar: string | null;
  /** La del sitio: lo que guarda comp_tomas.observaciones. */
  observaciones: string | null;
  /** Lo que verá el monitorista en OBSERVACIONES: especificación · observación (observacionesToma). */
  observacionesExcel: string | null;
};

/**
 * Vista previa de las tomas NUEVAS que creará comp_generar_tomas para una
 * campaña: un renglón por sitio × fecha del plan, dentro de las ventanas de
 * cada sitio (ventanasToma: su vigencia recortada por la de la campaña y la
 * del periodo, por tramo) y con el horario del día, sin los sitios
 * cancelados, los que quedaron fuera de la carga ni, salvo
 * incluir_comprobados, los ya comprobados (sitioRecibeTomasNuevas). Lo que
 * se guarda lo decide la base, que además respeta las tomas editadas a
 * mano: la pantalla debe decir «hasta N renglones». Una campaña cerrada o
 * retirada no da renglones (campanaOmitidaDelPlan), como en la base. Para
 * solo contar, resumenPlan (no arma los objetos).
 * Orden: fecha, luego la clave del sitio en orden natural.
 */
export function generarRenglonesPlan(
  plan: unknown,
  campana: CampanaPlan,
  sitios: SitioPlan[],
  periodo: { inicio?: string | null; fin?: string | null }
): RenglonPlan[] {
  const p = normalizarPlan(plan);
  if (!p || campanaOmitidaDelPlan(campana)) return [];
  const medio = campana?.medio ?? campana?.unidad ?? null;
  // Se ordenan los sitios una vez y se genera en ese orden; el sort por
  // fecha es estable, así que dentro del día queda el orden natural sin
  // volver a comparar claves en cada renglón.
  const orden = sitios
    .filter((s) => sitioRecibeTomasNuevas(s, p))
    .sort((x, y) => compararNatural(x.sitio_clave, y.sitio_clave));
  const out: RenglonPlan[] = [];
  for (const s of orden) {
    const vs = ventanasToma(s, campana, periodo);
    if (!vs.length) continue;
    const obs = (s.observaciones || '').trim() || null;
    const obsExcel = observacionesToma(campana?.especificacion, obs);
    for (const fecha of fechasDeVentanas(p, vs)) {
      const horario = horarioDelDia(s.horario_lv, s.horario_sd, fecha);
      out.push({
        sitio_clave: s.sitio_clave,
        fecha,
        horario,
        horarioMostrar: medio ? horarioParaMostrar(medio, horario) : horario,
        observaciones: obs,
        observacionesExcel: obsExcel,
      });
    }
  }
  return out.sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : 0));
}

export type ResumenPlan = {
  /** El motivo si el plan no sirve (MENSAJES_PLAN); entonces todo va en 0. */
  error: string | null;
  /** Renglones que crearía el plan: «hasta N» (la base respeta las editadas a mano). */
  renglones: number;
  /** Sitios que sí tendrán al menos una toma. */
  sitiosConTomas: number;
  /** Corren fuera del periodo (su vigencia no lo toca): no tendrán toma. */
  sitiosSinVentana: string[];
  /** Tienen vigencia en el periodo, pero ninguna fecha del plan cae en ella. */
  sitiosSinFechas: string[];
  /** Cancelados o fuera de la carga: el plan no los toca. */
  sitiosExcluidos: number;
  /**
   * Ya comprobados: el plan no les crea tomas nuevas (R11) salvo
   * incluir_comprobados. NO conservan todas sus tomas: la base solo les deja
   * las pendientes del plan que también da el plan nuevo, y borra las demás
   * pendientes del plan (paso 3 de comp_aplicar_planes). Se listan para que
   * Victor decida (revisión 3 del núcleo, 23-oct-2026: el texto anterior
   * decía que conservaban sus tomas).
   */
  sitiosComprobados: string[];
  /**
   * La campaña está cerrada o retirada: la base no le crea ni le cambia
   * tomas del plan, así que todo va en 0 y la pantalla dice por qué
   * (campanaOmitidaDelPlan). null = el plan sí la toca.
   */
  campanaOmitida: CampanaOmitida | null;
};

/**
 * Lo que la pantalla le enseña a Victor antes de mandar el plan: cuántos
 * renglones saldrían y QUÉ sitios se quedan sin toma y por qué (antes
 * desaparecían sin aviso; la base solo reporta las campañas sin sitios).
 * Cuenta sin armar renglones: 180 campañas × 30 sitios en plan diario son
 * 167 mil objetos, varios segundos congelados en un teléfono.
 */
export function resumenPlan(
  plan: unknown,
  campana: CampanaPlan,
  sitios: SitioPlan[],
  periodo: { inicio?: string | null; fin?: string | null }
): ResumenPlan {
  const r: ResumenPlan = {
    error: null,
    renglones: 0,
    sitiosConTomas: 0,
    sitiosSinVentana: [],
    sitiosSinFechas: [],
    sitiosExcluidos: 0,
    sitiosComprobados: [],
    campanaOmitida: null,
  };
  const { plan: p, error } = leerPlan(plan);
  if (!p) {
    r.error = error;
    return r;
  }
  r.campanaOmitida = campanaOmitidaDelPlan(campana);
  if (r.campanaOmitida) return r;
  for (const s of sitios) {
    if (!sitioEntraAlPlan(s)) {
      r.sitiosExcluidos++;
      continue;
    }
    if (!sitioRecibeTomasNuevas(s, p)) {
      r.sitiosComprobados.push(s.sitio_clave);
      continue;
    }
    const vs = ventanasToma(s, campana, periodo);
    if (!vs.length) {
      r.sitiosSinVentana.push(s.sitio_clave);
      continue;
    }
    let n = 0;
    for (const v of vs) n += contarFechas(p, v.inicio, v.fin);
    if (!n) {
      r.sitiosSinFechas.push(s.sitio_clave);
      continue;
    }
    r.renglones += n;
    r.sitiosConTomas++;
  }
  r.sitiosSinVentana.sort(compararNatural);
  r.sitiosSinFechas.sort(compararNatural);
  r.sitiosComprobados.sort(compararNatural);
  return r;
}

/** Días de un rango inclusivo 'YYYY-MM-DD' (tope 400). [] si el rango no sirve. */
export function diasEntre(inicio: string | null | undefined, fin: string | null | undefined): string[] {
  return generarFechasPlan({ tipo: 'diario' }, inicio, fin);
}
