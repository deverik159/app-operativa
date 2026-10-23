// ============================================================
// src/lib/excelComp.ts
// Los tres Excel de Comprobaciones, ARMADOS por la app (fase 2,
// rediseño de Erik del 23-oct-2026).
//
// POR QUÉ. En palabras de Erik: "la idea no es que Victor suba el excel
// lleno y la app lo procese, si no que Victor desde la app construya ese
// excel que hoy se usa y cuesta tiempo". Hoy, por unidad, se copian a mano
// tres archivos:
//   1. «Asignación de clientes»: una fila por campaña-versión (vendedor,
//      ejecutivo, arte, DISEÑADOR = analista, venta, comprobadas, %, CERRADA,
//      fecha de cierre) con el total por diseñador al pie, su hoja
//      «Comprobación diaria» (una columna por día hábil) y la hoja
//      «Especificación de tomas»;
//   2. «Formato general de comprobaciones»: un renglón por día × sitio ×
//      campaña × versión;
//   3. lo de los monitoristas: en Ecovallas Digital UN archivo compartido con
//      una columna por monitorista; en Biobox, Vía Verde y Pórticos un
//      archivo por persona (y turno) con columnas para anotar.
// Aquí se arman sus matrices con los encabezados, el orden y los títulos de
// los Excel reales de agosto y la Cat-18 de 2026 (copiados de los archivos,
// que no entran a este repo público). Lo que se simplificó a propósito está
// escrito en cada función (p. ej. la hoja diaria va con una columna por día,
// no dos o tres; el archivo por monitorista de Vía Verde no lleva los bloques
// semanales).
//
// QUÉ NO HACE. Es PURA: sin React, sin Supabase y sin importar xlsx (que se
// carga diferido, xlsxDiferido.ts). Devuelve un LibroExcel; la pantalla lo
// escribe con aLibroXlsx(libro, XLSX) y XLSX.writeFile. Los números son
// VALORES, no fórmulas: la verdad está en la app (vw_comp_campanas,
// vw_comp_diaria, vw_comp_tomas) y el Excel es una foto para mandar o
// imprimir. Si alguien lo edita, no se recalcula; se corrige en la app.
//
// Las fechas van como número de serie de Excel con formato d/m/yyyy, no como
// Date: SheetJS convierte un Date con la zona de la computadora y el 1-ago
// podía salir 31-jul (la misma lección de importadorComp al leer).
// ============================================================

import {
  compararNatural,
  diaIso,
  diasEntre,
  esCompleta,
  esFinDeSemana,
  horario24hOFranja,
  horarioParaMostrar,
  llaveComp,
  observacionesToma,
  pivotDiaria,
  type FilaDiaria,
  type MedioComp,
} from './comprobaciones';
import { diaCdmx } from './fechasCdmx';

// ------------------------------------------------------------
// Tipos de salida (lo que entiende XLSX.utils.aoa_to_sheet)
// ------------------------------------------------------------

/** Celda con tipo y formato; aoa_to_sheet la toma tal cual (SheetJS 0.20.3). */
export type CeldaObj = { t: 'n' | 's' | 'b'; v: number | string | boolean; z?: string };
/** null = celda vacía (aoa_to_sheet no la escribe). */
export type Celda = string | number | null | CeldaObj;
export type RangoExcel = { s: { r: number; c: number }; e: { r: number; c: number } };

export type HojaExcel = {
  /** Ya recortado a 31 caracteres y sin []:*?/\ (reglas de Excel). */
  nombre: string;
  filas: Celda[][];
  merges: RangoExcel[];
  /** Ancho de cada columna en caracteres (!cols wch), copiado de los Excel de hoy. */
  anchos: number[];
  /** Rango del filtro del encabezado, p. ej. 'A4:S120'. */
  autofiltro?: string;
};

export type LibroExcel = { nombreArchivo: string; hojas: HojaExcel[] };

/** El periodo como lo tiene comp_periodos. */
export type PeriodoExcel = {
  tipo: 'catorcena' | 'mes';
  anio: number;
  numero: number;
  inicio: string;
  fin: string;
};

// ------------------------------------------------------------
// Celdas y textos
// ------------------------------------------------------------

const FORMATO_FECHA = 'd/m/yyyy';
const FORMATO_PCT = '0%';

/**
 * Número de serie de Excel de un día 'YYYY-MM-DD' (días desde el
 * 30-dic-1899, sistema 1900). Cuenta en UTC: el día no se mueve con la zona.
 */
export function serialExcel(dia: string): number | null {
  const d = diaIso(dia);
  if (!d) return null;
  return Date.parse(d + 'T00:00:00Z') / 86400000 + 25569;
}

/**
 * Celda de un DÍA (comp_tomas.fecha, que es date): se queda con los 10
 * primeros caracteres, igual que el orden (ordenarTomas). Antes la fecha de
 * la toma pasaba por celdaFecha y, si llegaba como '2026-08-01T00:00:00.000Z'
 * (una pantalla que use toISOString), se ordenaba como 1-ago pero se
 * imprimía 31/7/2026 (revisión del núcleo, 23-oct-2026).
 */
export function celdaDia(x: string | null | undefined): CeldaObj | null {
  const n = typeof x === 'string' ? serialExcel(x) : null;
  return n === null ? null : { t: 'n', v: n, z: FORMATO_FECHA };
}

/**
 * Celda de fecha para una MARCA de tiempo (cerrada_en, timestamptz): la
 * marca se pasa al día de CDMX, si no una campaña cerrada a las 19:00 salía
 * cerrada «mañana». Un día sin hora se toma tal cual. null si no se entiende.
 */
export function celdaFecha(x: string | null | undefined): CeldaObj | null {
  if (typeof x !== 'string' || !x.trim()) return null;
  const s = x.trim();
  const dia = s.length > 10 && /[T ]\d{2}:\d{2}/.test(s) ? diaIso(diaCdmx(s)) : diaIso(s);
  return dia ? celdaDia(dia) : null;
}

/** Fracción con formato 0 % (como la columna % AVANCES de hoy). */
export function celdaPct(fraccion: number): CeldaObj {
  return { t: 'n', v: Number.isFinite(fraccion) ? fraccion : 0, z: FORMATO_PCT };
}

const MESES = [
  'ENERO',
  'FEBRERO',
  'MARZO',
  'ABRIL',
  'MAYO',
  'JUNIO',
  'JULIO',
  'AGOSTO',
  'SEPTIEMBRE',
  'OCTUBRE',
  'NOVIEMBRE',
  'DICIEMBRE',
];
const DIAS_SEMANA = ['DOMINGO', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO'];

/** 'AGOSTO' o 'CAT 18' (así nombran hoy las hojas: «AGOSTO», «ECOVALLAS DIGITALES CAT 18»). */
export function periodoCorto(p: Pick<PeriodoExcel, 'tipo' | 'numero'>): string {
  return p.tipo === 'mes' ? MESES[p.numero - 1] ?? `MES ${p.numero}` : `CAT ${String(p.numero).padStart(2, '0')}`;
}

/** 'AGOSTO 2026' o 'CAT 18 2026' (títulos de hoy: «COMPROBACIONES BIOBOX AGOSTO 2026»). */
export function periodoTitulo(p: Pick<PeriodoExcel, 'tipo' | 'numero' | 'anio'>): string {
  return `${periodoCorto(p)} ${p.anio}`;
}

/** 'Agosto 2026' o 'Cat 18 2026', para el nombre del archivo. */
function periodoArchivo(p: Pick<PeriodoExcel, 'tipo' | 'numero' | 'anio'>): string {
  const c = periodoCorto(p);
  return `${c.charAt(0)}${c.slice(1).toLowerCase()} ${p.anio}`;
}

/** '2026-08-03' → 'LUNES 03' (encabezado de la hoja Comprobación diaria). */
export function etiquetaDia(dia: string): string {
  const d = diaIso(dia);
  if (!d) return '';
  return `${DIAS_SEMANA[new Date(d + 'T00:00:00Z').getUTCDay()]} ${d.slice(8, 10)}`;
}

const SIN_ACENTO_MAYUS: Record<string, string> = { Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U', Ü: 'U' };
const mayusSinAcento = (s: string) => s.toUpperCase().replace(/[ÁÉÍÓÚÜ]/g, (ch) => SIN_ACENTO_MAYUS[ch] ?? ch);

/**
 * Como escriben hoy al DISEÑADOR: el primer nombre en mayúsculas y sin
 * acento ('Ángel Ruiz' → 'ANGEL'). Si viene un correo, lo de antes de la @
 * hasta el primer punto. La Ñ se queda.
 */
export function nombreCorto(nombre: string | null | undefined): string {
  let s = (nombre || '').trim();
  if (!s) return '';
  if (s.includes('@')) s = s.split('@')[0].split(/[._-]/)[0];
  return mayusSinAcento(s.split(/\s+/)[0]);
}

/**
 * Nombre de hoja válido para Excel: sin []:*?/\, sin espacios ni apóstrofos
 * en los extremos (Excel rechaza «'PEPE CAT 18» y pide reparar el libro),
 * máximo 31 y nunca «History», que Excel reserva (revisión del núcleo,
 * 23-oct-2026).
 */
export function nombreHoja(s: string): string {
  const limpio = (s || '')
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31)
    .replace(/^[\s']+|[\s']+$/g, '');
  if (!limpio) return 'HOJA';
  return limpio.toLowerCase() === 'history' ? 'HISTORY 1' : limpio;
}

/** Nombre de archivo sin caracteres que Windows o iOS rechazan. */
export function nombreArchivo(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}

const texto = (x: unknown): string | null => {
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  return s === '' ? null : s;
};

const num = (x: unknown): number => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Orden estable sin depender del idioma de la computadora. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Parte del correo antes de la @, en mayúsculas ('luisa.e@x' → 'LUISA.E'). */
const usuarioCorreo = (e: string | null | undefined) => mayusSinAcento((e || '').trim().split('@')[0]);

/**
 * Hace únicas las etiquetas de varias claves (personas). Si dos claves
 * distintas dan la misma etiqueta, se prueba con la inicial del apellido
 * («MARCO P.»), luego con el usuario del correo («MARCO (MGOMEZ)») y al
 * final con un número. Así dos «Marco» no se juntan en una fila ni en un
 * archivo (revisión del núcleo, 23-oct-2026).
 */
function etiquetasUnicas(
  personas: { clave: string; base: string; nombre?: string | null; email?: string | null }[]
): Map<string, string> {
  const out = new Map<string, string>();
  const porBase = new Map<string, typeof personas>();
  for (const p of personas) {
    const g = porBase.get(p.base) ?? [];
    g.push(p);
    porBase.set(p.base, g);
  }
  for (const [base, g] of porBase) {
    if (g.length === 1) {
      out.set(g[0].clave, base);
      continue;
    }
    const intentos: ((p: (typeof personas)[number]) => string | null)[] = [
      (p) => {
        const partes = (p.nombre || '').trim().split(/\s+/);
        return partes.length > 1 && !(p.nombre || '').includes('@') ? `${base} ${mayusSinAcento(partes[1].charAt(0))}.` : null;
      },
      (p) => (p.email ? `${base} (${usuarioCorreo(p.email)})` : null),
    ];
    let elegido: Map<string, string> | null = null;
    for (const f of intentos) {
      const prueba = g.map((p) => f(p));
      if (prueba.every((x) => x !== null) && new Set(prueba).size === g.length) {
        elegido = new Map(g.map((p, i) => [p.clave, prueba[i] as string]));
        break;
      }
    }
    if (!elegido) elegido = new Map(g.map((p, i) => [p.clave, i === 0 ? base : `${base} ${i + 1}`]));
    for (const [k, v] of elegido) out.set(k, v);
  }
  return out;
}

// ------------------------------------------------------------
// Cómo se llama cada cosa en cada unidad (copiado de los Excel de hoy)
// ------------------------------------------------------------

type ConfigMedio = {
  /** En los títulos: «COMPROBACIONES BIOBOX AGOSTO 2026». */
  titulo: string;
  /** En el nombre del archivo: «Asignación de Clientes Porticos Agosto 2026.xlsx». */
  archivo: string;
  /** Encabezado de la fecha en el formato general (Biobox dice «FECHAS»). */
  fecha: string;
  /** Encabezado de la clave del sitio en el formato general. */
  sitio: string;
  /** Encabezado de la campaña en el formato general. */
  campana: string;
  /** Encabezado de la venta y lo comprobado en la asignación y la diaria. */
  venta: string;
  /** Sufijo de las hojas de la asignación («… CDMX» o «… PORTICOS»). */
  sufijoHojas: string;
  /** Tercera hoja de la asignación. */
  hojaEspecificacion: string;
  /** Título del formato general. */
  tituloFormato: (p: PeriodoExcel) => string;
  /** Hasta qué columna va combinado ese título (A2:D2, A2:E2); null = sin combinar. */
  finTituloFormato: number | null;
  /** Aviso de la fila 2 del formato general, junto al título (Biobox, F2). */
  avisoFormato: string | null;
  /** Nombre de la hoja del formato general. */
  hojaFormato: (p: PeriodoExcel) => string;
  /** ¿El formato de hoy trae RUTA? (Vía Verde no: se reparte por turno). */
  conRuta: boolean;
  /**
   * HORARIO fijo «24 HORAS» en todos los renglones (Ecovallas Digital y
   * Biobox; Erik, 23-oct-2026: no tienen pautas por horario). Vía Verde
   * lleva el horario del día de cada toma.
   */
  horario24h: boolean;
  /** Columnas de seguimiento que hoy se llenan a mano, después de MONITORISTA y ESTATUS. */
  seguimiento: string[];
  anchoSitio: number;
};

const CONFIG: Record<MedioComp, ConfigMedio> = {
  // Ecovallas Digital: hoja «ECOVALLAS DIGITALES CAT 18», sin archivo de asignación hoy.
  Pantalla: {
    titulo: 'ECOVALLAS DIGITALES',
    archivo: 'Ecovallas Digitales',
    fecha: 'FECHA',
    sitio: 'CLAVE',
    campana: 'CAMPAÑAS',
    venta: 'PANTALLAS CDMX',
    sufijoHojas: 'CDMX',
    hojaEspecificacion: 'ESPECIFICACIÓN DE TOMAS',
    tituloFormato: (p) => `TOMA COMPROBACIONES ECOVALLAS DIGITALES ${periodoTitulo(p)}`,
    finTituloFormato: 3,
    avisoFormato: null,
    hojaFormato: (p) => `ECOVALLAS DIGITALES ${periodoCorto(p)}`,
    conRuta: true,
    horario24h: true,
    seguimiento: [
      'FOTO COMPROBATORIA',
      'TOMA CORTA',
      'TOMA MEDIA',
      'TOMA LARGA',
      'FECHA DE TOMA',
      'FECHA DE COMPROBACIÓN',
      'QUIEN TOMA',
      'OBSERVACIONES',
    ],
    anchoSitio: 29.5,
  },
  Máquina: {
    titulo: 'BIOBOX',
    archivo: 'Biobox',
    // Así dice el A4 del formato de Biobox de hoy (las demás unidades, «FECHA»).
    fecha: 'FECHAS',
    sitio: 'BIOBOX',
    campana: 'CAMPAÑA',
    venta: 'BIOBOX CDMX',
    sufijoHojas: 'CDMX',
    hojaEspecificacion: 'ESPECIFICACIÓN DE TOMAS',
    tituloFormato: (p) => `TOMA COMPROBACIONES BIOBOX ${periodoTitulo(p)}`,
    finTituloFormato: 4,
    avisoFormato: 'TOMAR LAS FOTOS DE ACUERDO A LA FECHA LIMITE',
    hojaFormato: (p) => periodoCorto(p),
    conRuta: true,
    horario24h: true,
    seguimiento: ['TOMA CORTA', 'TOMA MEDIA', 'TOMA LARGA', 'PANTALLA TOUCH', 'FECHA DE TOMA', 'QUIEN TOMA', 'OBSERVACIONES'],
    anchoSitio: 27,
  },
  // Vía Verde: EDO MEX está de baja (Erik, 22-oct-2026), así que la venta
  // es solo CDMX y no se arma la columna «COLUMNAS EDO MEX» que hoy va vacía.
  Columna: {
    titulo: 'COLUMNAS',
    archivo: 'Columnas',
    fecha: 'FECHA',
    sitio: 'COLUMNA',
    campana: 'CAMPAÑA',
    venta: 'COLUMNAS CDMX',
    sufijoHojas: 'CDMX',
    hojaEspecificacion: 'ESPECIFICACIÓN DE TOMAS',
    tituloFormato: (p) => `FORMATO GENERAL COMPROBACIONES ${periodoTitulo(p)}`,
    finTituloFormato: null,
    avisoFormato: null,
    hojaFormato: () => 'GENERAL',
    conRuta: false,
    horario24h: false,
    seguimiento: ['COLOR CAMPO', 'CAMPO'],
    anchoSitio: 25.5,
  },
  Pórtico: {
    titulo: 'PORTICOS',
    archivo: 'Porticos',
    fecha: 'FECHA',
    sitio: 'PORTICO',
    campana: 'CAMPAÑA',
    // El F5 de la Asignación de Pórticos de hoy dice «COLUMNAS CDMX» (la
    // hoja nació de la de Vía Verde); se copia igual para que Victor vea su
    // archivo de siempre (revisión del núcleo, 23-oct-2026).
    venta: 'COLUMNAS CDMX',
    sufijoHojas: 'PORTICOS',
    hojaEspecificacion: 'ESPECIFICACIÓN DE COMPROBACIÓN',
    tituloFormato: (p) => `FORMATO GENERAL COMPROBACIONES ${periodoTitulo(p)}`,
    finTituloFormato: null,
    avisoFormato: null,
    hojaFormato: (p) => `PORTICOS ${periodoCorto(p)}`,
    conRuta: false,
    horario24h: false,
    seguimiento: [],
    anchoSitio: 15.7,
  },
};

export function configMedio(medio: MedioComp): Readonly<ConfigMedio> {
  return CONFIG[medio];
}

// ------------------------------------------------------------
// 1. Asignación de clientes + Comprobación diaria + Especificación
// ------------------------------------------------------------

/** Una fila de vw_comp_campanas, ya con el nombre del analista para DISEÑADOR. */
export type CampanaExcel = {
  /** comp_campanas.id: cruza con vw_comp_diaria para la hoja diaria. */
  id: number | string;
  campana: string;
  version?: string | null;
  vendedor?: string | null;
  /** «EJECUTIVO» del Excel = administrador de la bitácora. */
  ejecutivo?: string | null;
  arte?: string | null;
  /** Nombre (o correo) de quien la lleva hoy; va como nombreCorto. */
  analista?: string | null;
  /**
   * Correo de quien la lleva (analista_email). Con él se agrupa el pie
   * DISEÑADORES: dos «Marco» distintos ya no se suman en una fila.
   */
  analista_email?: string | null;
  /** La META de la vista (sitios por comprobar); es la «venta» del Excel de hoy. */
  venta: number | string | null;
  comprobados: number | string | null;
  estatus?: 'abierta' | 'cerrada' | null;
  /** Día o marca de tiempo del cierre. */
  cerrada_en?: string | null;
  /** comp_campanas.especificacion: va en la hoja de especificación. */
  especificacion?: string | null;
  /**
   * vw_comp_campanas.retirada: ya no vino en la carga o la reemplazó otra
   * versión. Va con ESTATUS «RETIRADA» (no «COMPLETA»: su meta ya no cuenta
   * pendientes) y SIEMPRE entra en la COMPROBACIÓN DIARIA, para que lo que
   * se comprobó en ella no se pierda (revisión 3, 23-oct-2026).
   */
  retirada?: boolean | null;
};

export const SIN_ANALISTA_EXCEL = 'SIN ASIGNAR';

/** 'BASE / VERSIÓN', o la base sola si no hay versión (así está la columna CAMPAÑA hoy). */
export function campanaConVersion(campana: string | null | undefined, version: string | null | undefined): string {
  const c = (campana || '').trim();
  const v = (version || '').trim();
  return v ? `${c} / ${v}` : c;
}

/**
 * ESTATUS de la fila. Hoy el Excel pone «CERRADA» solo con llegar al 100 %;
 * en la app cerrar es del Supervisor a mano (P1, 23-oct-2026), así que:
 * «CERRADA» si la cerró, «RETIRADA» si salió de la carga (su meta ya es lo
 * comprobado y sin esto saldría COMPLETA al 100 % sin serlo; revisión 3,
 * 23-oct-2026), «COMPLETA» si llegó a la meta pero sigue abierta, y vacío en
 * lo demás.
 */
export function estatusExcel(c: Pick<CampanaExcel, 'estatus' | 'venta' | 'comprobados' | 'retirada'>): string {
  if (c.estatus === 'cerrada') return 'CERRADA';
  if (c.retirada === true) return 'RETIRADA';
  return esCompleta(num(c.comprobados), num(c.venta)) ? 'COMPLETA' : '';
}

/**
 * DISEÑADOR de cada campaña: clave de agrupación (el correo; sin correo, el
 * nombre completo) → etiqueta como la de hoy (primer nombre) y única.
 */
function disenadores(campanas: CampanaExcel[]): { claveDe: (c: CampanaExcel) => string; etiqueta: Map<string, string> } {
  const claveDe = (c: CampanaExcel): string => {
    const e = (c.analista_email || '').trim().toLowerCase();
    if (e) return 'E:' + e;
    const n = (c.analista || '').trim();
    return n ? 'N:' + (llaveComp(n) || n) : '';
  };
  const vistas = new Map<string, { clave: string; base: string; nombre?: string | null; email?: string | null }>();
  for (const c of campanas) {
    const k = claveDe(c);
    if (!k || vistas.has(k)) continue;
    const base = nombreCorto(c.analista) || nombreCorto(c.analista_email) || SIN_ANALISTA_EXCEL;
    vistas.set(k, { clave: k, base, nombre: c.analista, email: c.analista_email });
  }
  const etiqueta = etiquetasUnicas([...vistas.values()]);
  etiqueta.set('', SIN_ANALISTA_EXCEL);
  return { claveDe, etiqueta };
}

const ANCHOS_ASIGNACION = [21.5, 21, 15.3, 13.7, 45, 13, 11.9, 2, 13, 15.1, 2, 10, 11, 17.4];

/**
 * Hoja «ASIGNACIÓN DE CLIENTES …». Mismo acomodo que la de Biobox de hoy:
 *   fila 2 título (combinado A2:C2) · fila 3 VENTA / COMPROBACIÓN ·
 *   fila 4 PLAZA / CDMX / TOTAL · fila 5 encabezado · datos desde la fila 6
 *   A VENDEDOR · B EJECUTIVO · C ARTES · D DISEÑADOR · E CAMPAÑA ·
 *   F venta · G VENTA CDMX · (H) · I comprobadas · J COMPROBACIÓN CDMX · (K) ·
 *   L % AVANCES · M ESTATUS · N FECHA DE CIERRE
 * Pie: TOTAL, % AVANCE y «DISEÑADORES» con la venta y el % de cada uno (lo
 * que hoy hacen SUBTOTAL y SUMIF por la columna D), agrupado por persona
 * (correo), no por el nombre visible. Las filas van en el orden en que
 * llegan: la pantalla decide (por vendedor, como hoy, o por analista).
 */
function hojaAsignacion(
  cfg: ConfigMedio,
  periodo: PeriodoExcel,
  campanas: CampanaExcel[],
  dis: ReturnType<typeof disenadores>
): HojaExcel {
  const filas: Celda[][] = [
    [],
    [`COMPROBACIONES ${cfg.titulo} ${periodoTitulo(periodo)}`],
    [null, null, null, null, null, 'VENTA', null, null, 'COMPROBACIÓN'],
    [null, null, null, null, 'PLAZA', 'CDMX', 'TOTAL', null, 'CDMX', 'TOTAL'],
    [
      'VENDEDOR',
      'EJECUTIVO',
      'ARTES',
      'DISEÑADOR',
      'CAMPAÑA',
      cfg.venta,
      ' VENTA CDMX',
      null,
      cfg.venta,
      'COMPROBACIÓN CDMX',
      null,
      '% AVANCES CDMX',
      'ESTATUS CDMX',
      'FECHA DE CIERRE CDMX',
    ],
  ];
  let totVenta = 0;
  let totComp = 0;
  const porAnalista = new Map<string, { venta: number; comprobados: number }>();
  for (const c of campanas) {
    const venta = num(c.venta);
    const comp = num(c.comprobados);
    const k = dis.claveDe(c);
    totVenta += venta;
    totComp += comp;
    const a = porAnalista.get(k) ?? { venta: 0, comprobados: 0 };
    a.venta += venta;
    a.comprobados += comp;
    porAnalista.set(k, a);
    filas.push([
      texto(c.vendedor),
      texto(c.ejecutivo),
      texto(c.arte),
      dis.etiqueta.get(k) ?? SIN_ANALISTA_EXCEL,
      campanaConVersion(c.campana, c.version),
      venta,
      venta,
      null,
      comp,
      comp,
      null,
      celdaPct(venta > 0 ? comp / venta : 0),
      estatusExcel(c) || null,
      c.estatus === 'cerrada' ? celdaFecha(c.cerrada_en) : null,
    ]);
  }
  const pct = (comp: number, venta: number) => celdaPct(venta > 0 ? comp / venta : 0);
  filas.push([]);
  filas.push([null, null, null, null, 'TOTAL', totVenta, totVenta, null, totComp, totComp, null, pct(totComp, totVenta)]);
  filas.push([]);
  filas.push([null, null, null, null, null, null, '% AVANCE', null, pct(totComp, totVenta), pct(totComp, totVenta)]);
  filas.push(['DISEÑADORES']);
  // Personas por etiqueta; «SIN ASIGNAR» al final, para que se vea lo que falta repartir.
  const claves = [...porAnalista.keys()].sort((a, b) =>
    a === '' ? 1 : b === '' ? -1 : cmp(dis.etiqueta.get(a) ?? '', dis.etiqueta.get(b) ?? '')
  );
  for (const k of claves) {
    const a = porAnalista.get(k)!;
    const n = dis.etiqueta.get(k) ?? SIN_ANALISTA_EXCEL;
    filas.push([n, a.venta, null, null, null, null, `% ${n}`, null, pct(a.comprobados, a.venta), pct(a.comprobados, a.venta)]);
  }
  return {
    nombre: nombreHoja(`ASIGNACIÓN DE CLIENTES ${cfg.sufijoHojas}`),
    filas,
    merges: [
      { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } },
      { s: { r: 2, c: 5 }, e: { r: 2, c: 6 } },
      { s: { r: 2, c: 8 }, e: { r: 2, c: 9 } },
    ],
    anchos: ANCHOS_ASIGNACION,
    autofiltro: campanas.length ? `A5:N${5 + campanas.length}` : undefined,
  };
}

/**
 * Días que lleva la hoja diaria. Hoy son solo los días HÁBILES del periodo
 * (lunes a viernes: «LUNES 03 … LUNES 31»), porque es cuando trabaja el
 * analista. Pero si alguien marcó un sábado o domingo, ese día también va:
 * si no, la suma de la hoja no cuadraría con lo comprobado.
 */
export function diasDeLaDiaria(
  periodo: Pick<PeriodoExcel, 'inicio' | 'fin'>,
  marcas: Pick<FilaDiaria, 'dia'>[],
  soloHabiles = true
): string[] {
  const todos = diasEntre(periodo.inicio, periodo.fin);
  if (!soloHabiles) return todos;
  const conMarca = new Set(marcas.map((m) => (m.dia || '').slice(0, 10)));
  return todos.filter((d) => !esFinDeSemana(d) || conMarca.has(d));
}

/**
 * Hoja «COMPROBACIÓN DIARIA …»: las mismas campañas, en el mismo orden, con
 * una columna por día (diasDeLaDiaria). Hoy se teclea a mano; aquí sale de
 * vw_comp_diaria (pivotDiaria por campaña). Un día sin marcas va en blanco,
 * como hoy; el renglón TOTAL sí lleva 0. Al final, TOTAL por campaña y, si
 * alguien marcó fuera del periodo (P4 deja fechar hasta 7 días atrás y se
 * puede seguir marcando después del fin), «FUERA DEL PERIODO».
 * SIMPLIFICADO a propósito: hoy cada día ocupa 2 columnas en Biobox (CDMX y
 * una auxiliar) y 3 en Vía Verde y Pórticos (con el día combinado); aquí va
 * una por día, porque EDO MEX está de baja y la auxiliar no se usa.
 */
function hojaDiaria(
  cfg: ConfigMedio,
  periodo: PeriodoExcel,
  campanas: CampanaExcel[],
  marcas: FilaDiaria[],
  soloHabiles: boolean,
  dis: ReturnType<typeof disenadores>
): HojaExcel {
  const dias = diasDeLaDiaria(periodo, marcas, soloHabiles);
  const piv = new Map(pivotDiaria(marcas, dias, 'campana').map((r) => [r.clave, r]));
  // Solo cuenta lo de las campañas que se descargan (piv puede traer otras).
  const ids = new Set(campanas.map((c) => String(c.id)));
  const hayFuera = [...piv.values()].some((r) => ids.has(r.clave) && r.fuera > 0);
  const filas: Celda[][] = [
    [],
    ['COMPROBACIONES DIARIAS'],
    [],
    [null, null, null, null, null, ...dias.map(etiquetaDia), 'TOTAL', ...(hayFuera ? ['FUERA DEL PERIODO'] : [])],
    ['VENDEDOR', 'EJECUTIVO', 'ARTES', 'DISEÑADOR', 'CAMPAÑA', ...dias.map(() => cfg.venta), cfg.venta, ...(hayFuera ? [cfg.venta] : [])],
  ];
  const totDia = dias.map(() => 0);
  let total = 0;
  let totFuera = 0;
  for (const c of campanas) {
    const r = piv.get(String(c.id));
    const porDia = dias.map((d, i) => {
      const n = r?.porDia[d] ?? 0;
      totDia[i] += n;
      return n > 0 ? n : null;
    });
    total += r?.total ?? 0;
    totFuera += r?.fuera ?? 0;
    filas.push([
      texto(c.vendedor),
      texto(c.ejecutivo),
      texto(c.arte),
      dis.etiqueta.get(dis.claveDe(c)) ?? SIN_ANALISTA_EXCEL,
      campanaConVersion(c.campana, c.version),
      ...porDia,
      r?.total ? r.total : null,
      ...(hayFuera ? [r?.fuera ? r.fuera : null] : []),
    ]);
  }
  filas.push([]);
  filas.push([null, null, null, null, 'TOTAL', ...totDia, total, ...(hayFuera ? [totFuera] : [])]);
  return {
    nombre: nombreHoja(`COMPROBACIÓN DIARIA ${cfg.sufijoHojas}`),
    filas,
    merges: [{ s: { r: 1, c: 0 }, e: { r: 1, c: 4 } }],
    anchos: [21.5, 21, 15.3, 13.7, 45, ...dias.map(() => 12), 10, ...(hayFuera ? [12] : [])],
  };
}

/**
 * Hoja «ESPECIFICACIÓN DE TOMAS» (Pórticos: «… DE COMPROBACIÓN»), la tercera
 * de la Asignación de hoy: CAMPAÑA · ARTE · ESPECIFICACIÓN DE TOMAS Y
 * COMPROBACIÓN, encabezado en la fila 2. Sale de comp_campanas.especificacion.
 * `nota` es el texto general de la fila 1 («REVISAR LAS FECHAS DE ENTREGA…»),
 * si Victor lo quiere.
 */
function hojaEspecificacion(cfg: ConfigMedio, campanas: CampanaExcel[], nota?: string | null): HojaExcel {
  const filas: Celda[][] = [
    texto(nota) ? [texto(nota)] : [],
    ['CAMPAÑA', 'ARTE', 'ESPECIFICACIÓN DE TOMAS Y COMPROBACIÓN'],
  ];
  for (const c of campanas) {
    filas.push([campanaConVersion(c.campana, c.version), texto(c.arte), texto(c.especificacion)]);
  }
  return {
    nombre: nombreHoja(cfg.hojaEspecificacion),
    filas,
    merges: texto(nota) ? [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }] : [],
    anchos: [45, 10, 90],
    autofiltro: `A2:C${2 + campanas.length}`,
  };
}

/**
 * Libro «Asignación de Clientes <unidad> <periodo>.xlsx» con sus tres hojas.
 * `marcas` son las filas de vw_comp_diaria del periodo y la unidad (o las
 * campañas que se descargan). `soloHabiles` (por omisión sí) copia la hoja de
 * hoy, que solo trae lunes a viernes. `notaEspecificacion` = fila 1 de la
 * hoja de especificación.
 * Campañas RETIRADAS (revisión 3, 23-oct-2026): por omisión van en las tres
 * hojas, con ESTATUS «RETIRADA». `omitirRetiradas` las quita SOLO de la
 * ASIGNACIÓN (filas, TOTAL y pie DISEÑADORES) y de la ESPECIFICACIÓN; la
 * COMPROBACIÓN DIARIA siempre las lleva, porque lo comprobado en ellas es
 * crédito de la analista y, sin ellas, su TOTAL no cuadraba con
 * vw_comp_diaria ni con el avance por analista.
 */
export function armarAsignacion(args: {
  medio: MedioComp;
  periodo: PeriodoExcel;
  campanas: CampanaExcel[];
  marcas?: FilaDiaria[];
  soloHabiles?: boolean;
  notaEspecificacion?: string | null;
  omitirRetiradas?: boolean;
}): LibroExcel {
  const cfg = CONFIG[args.medio];
  const dis = disenadores(args.campanas);
  const visibles = args.omitirRetiradas ? args.campanas.filter((c) => c.retirada !== true) : args.campanas;
  return {
    nombreArchivo: nombreArchivo(`Asignación de Clientes ${cfg.archivo} ${periodoArchivo(args.periodo)}.xlsx`),
    hojas: [
      hojaAsignacion(cfg, args.periodo, visibles, dis),
      hojaDiaria(cfg, args.periodo, args.campanas, args.marcas ?? [], args.soloHabiles ?? true, dis),
      hojaEspecificacion(cfg, visibles, args.notaEspecificacion),
    ],
  };
}

// ------------------------------------------------------------
// 2. Formato general y 3. lo de los monitoristas
// ------------------------------------------------------------

/** Quién toma la foto: de la ruta del sitio o, en Vía Verde, por turno. */
export type MonitoristaToma = { email?: string | null; nombre?: string | null; turno?: string | null };

/** Estado de comp_tomas (fase 3; en la fase 2 casi todo es 'pendiente'). */
export type EstadoToma = 'pendiente' | 'por_revisar' | 'comprobada' | 'regresada' | 'cancelada';

/** Un renglón de vw_comp_tomas, ya con los textos de su campaña y su sitio. */
export type TomaExcel = {
  /** comp_tomas.id: va en LLAVE para poder cruzar el archivo de vuelta (fase 3). */
  id?: number | string | null;
  /** Día 'YYYY-MM-DD' (comp_tomas.fecha). null = en espera; va al final. */
  fecha: string | null;
  sitio: string;
  ruta?: string | number | null;
  campana: string;
  version?: string | null;
  /** 'FOTO' si no viene (así está en todas las filas de hoy). */
  comprobacion?: string | null;
  horario?: string | null;
  /** comp_campanas.especificacion: va primero en OBSERVACIONES, como hoy. */
  especificacion?: string | null;
  /** La observación del sitio o de la toma (comp_tomas.observaciones). */
  observaciones?: string | null;
  /**
   * Quién(es) la toman. Una toma puede ir a dos personas (Vía Verde visita
   * cada columna en dos turnos: «SAÚL/IVAN/»), así que es una lista; se
   * agrupa por correo, no por el nombre visible.
   */
  monitoristas?: MonitoristaToma[] | null;
  /** Atajo para una sola persona (lo que trae vw_comp_tomas hoy). */
  monitorista?: string | null;
  monitorista_email?: string | null;
  /** comp_tomas.turno; se usa si la persona no trae el suyo. */
  turno?: string | null;
  /** comp_tomas.estado. */
  estado?: EstadoToma | null;
  /** vw_comp_tomas.campana_estatus. */
  campana_estatus?: 'abierta' | 'cerrada' | null;
  /** vw_comp_tomas.sitio_estado. */
  sitio_estado?: 'pendiente' | 'comprobado' | 'cancelado' | null;
  /**
   * Día en que se marcó comprobado el sitio (comp_sitios.comprobado_dia).
   * Con él, las tomas del sitio hasta ese día quedan cubiertas y las
   * posteriores (las que pidió incluir_comprobados) siguen yendo a campo.
   * Sin él, TODA toma por hacer de un sitio comprobado queda cubierta.
   */
  sitio_comprobado_dia?: string | null;
  /** Texto libre para ESTATUS; si viene, gana sobre el estado calculado. */
  estatus?: string | null;
};

/** Lo que se le pide a una toma para saber si su sitio ya la cubre. */
type DatosCubierta = Pick<TomaExcel, 'estado' | 'sitio_estado' | 'sitio_comprobado_dia' | 'fecha'>;

/**
 * ¿La toma ya no hace falta porque su SITIO ya quedó comprobado? En la fase 2
 * se marca por sitio (comp_marcar_sitios) y sus tomas siguen 'pendiente', así
 * que una toma pendiente de un sitio comprobado seguía en el archivo del
 * monitorista y sin ESTATUS en el Formato general: alguien iba otra vez a un
 * sitio ya comprobado (revisión 3, 23-oct-2026). Cubierta = toma por hacer
 * (pendiente o regresada) de un sitio 'comprobado' cuya fecha es ≤ el día en
 * que se comprobó. Si no se sabe ese día (vw_comp_tomas todavía no lo trae)
 * o la toma no tiene fecha, cuenta como cubierta: es mejor no mandar a
 * alguien a campo que mandarlo de más.
 */
export function tomaCubiertaPorSitio(t: DatosCubierta): boolean {
  if (t.sitio_estado !== 'comprobado') return false;
  const e = t.estado ?? 'pendiente';
  if (e !== 'pendiente' && e !== 'regresada') return false;
  const dia = diaIso(t.sitio_comprobado_dia);
  const fecha = diaIso(t.fecha);
  return dia === null || fecha === null || fecha <= dia;
}

/** ESTATUS de una toma que su sitio ya cubre (tomaCubiertaPorSitio). */
export const ESTATUS_SITIO_COMPROBADO = 'SITIO COMPROBADO';

/**
 * ESTATUS legible de la toma en el Formato general. Antes era texto libre y
 * nada decía que una toma estaba quitada o su campaña cerrada (revisión del
 * núcleo, 23-oct-2026):
 *   QUITADA (toma cancelada o sitio cancelado) · COMPROBADA · CERRADA (la
 *   campaña) · SITIO COMPROBADO (tomaCubiertaPorSitio; revisión 3,
 *   23-oct-2026) · POR REVISAR · REGRESADA · vacío si está pendiente.
 */
export function estatusToma(
  t: Pick<TomaExcel, 'estatus' | 'estado' | 'campana_estatus' | 'sitio_estado' | 'sitio_comprobado_dia' | 'fecha'>
): string | null {
  const libre = texto(t.estatus);
  if (libre) return libre;
  if (t.estado === 'cancelada' || t.sitio_estado === 'cancelado') return 'QUITADA';
  if (t.estado === 'comprobada') return 'COMPROBADA';
  if (t.campana_estatus === 'cerrada') return 'CERRADA';
  if (tomaCubiertaPorSitio(t)) return ESTATUS_SITIO_COMPROBADO;
  if (t.estado === 'por_revisar') return 'POR REVISAR';
  if (t.estado === 'regresada') return 'REGRESADA';
  return null;
}

/**
 * ¿Le toca ir a campo por esta toma? Pendiente o regresada, de una campaña
 * abierta y un sitio no cancelado. Lo quitado, lo de campañas cerradas, lo
 * ya tomado (por revisar, comprobada) y lo que su sitio ya cubre
 * (tomaCubiertaPorSitio) NO va en los archivos de los monitoristas: si no,
 * alguien iba a campo por fotos que ya no se necesitan.
 */
export function tomaParaCampo(
  t: Pick<TomaExcel, 'estado' | 'campana_estatus' | 'sitio_estado' | 'sitio_comprobado_dia' | 'fecha'>
): boolean {
  const e = t.estado ?? 'pendiente';
  return (
    (e === 'pendiente' || e === 'regresada') &&
    t.campana_estatus !== 'cerrada' &&
    t.sitio_estado !== 'cancelado' &&
    !tomaCubiertaPorSitio(t)
  );
}

/** Las personas de una toma, sin vacías. */
function monitoristasDe(t: TomaExcel): MonitoristaToma[] {
  const lista: MonitoristaToma[] =
    Array.isArray(t.monitoristas) && t.monitoristas.length
      ? t.monitoristas
      : [{ email: t.monitorista_email, nombre: t.monitorista, turno: t.turno }];
  return lista
    .map((m) => ({ email: texto(m?.email), nombre: texto(m?.nombre), turno: texto(m?.turno) ?? texto(t.turno) }))
    .filter((m) => m.email || m.nombre);
}

/** Clave de agrupación: el correo (o, sin correo, el nombre) + el turno. */
function claveMonitorista(m: MonitoristaToma): string {
  const quien = m.email ? 'E:' + m.email.trim().toLowerCase() : 'N:' + (llaveComp(m.nombre) || (m.nombre || '').trim());
  return `${quien}|${llaveComp(m.turno)}`;
}

/** 'SAÚL PRUEBA MATUTINO' (así se llaman hoy los archivos de Vía Verde: «SAUL MATUTINO»). */
function etiquetaMonitorista(m: MonitoristaToma, corto = false): string {
  const n = m.nombre ? (corto ? nombreCorto(m.nombre) : m.nombre.toUpperCase()) : usuarioCorreo(m.email);
  return [n, m.turno ? m.turno.toUpperCase() : ''].filter(Boolean).join(' ');
}

/** «SAÚL PRUEBA (MATUTINO) / IVAN EJEMPLO (VESPERTINO)» para la columna MONITORISTA. */
function nombresMonitoristas(t: TomaExcel): string | null {
  const ms = monitoristasDe(t);
  if (!ms.length) return null;
  return ms.map((m) => (m.nombre || m.email || '') + (m.turno ? ` (${m.turno.toUpperCase()})` : '')).join(' / ');
}

/**
 * Orden del formato general de hoy: por fecha, y dentro del día por campaña,
 * versión, ruta y sitio (ruta y sitio en orden natural: COL_448 antes que
 * COL_1000). Las de sin fecha (en espera) al final. La llave de cada toma se
 * calcula UNA vez (con 11 mil renglones, recalcularla en cada comparación
 * tardaba medio segundo; revisión del núcleo, 23-oct-2026).
 */
export function ordenarTomas(tomas: TomaExcel[]): TomaExcel[] {
  const dec = tomas.map((t, i) => ({
    t,
    i,
    f: diaIso(t.fecha) ?? '9999-99-99',
    c: (t.campana || '').toUpperCase(),
    v: (t.version || '').toUpperCase(),
    r: t.ruta === null || t.ruta === undefined ? '' : String(t.ruta),
    s: t.sitio || '',
  }));
  dec.sort(
    (a, b) =>
      cmp(a.f, b.f) || cmp(a.c, b.c) || cmp(a.v, b.v) || compararNatural(a.r, b.r) || compararNatural(a.s, b.s) || a.i - b.i
  );
  return dec.map((d) => d.t);
}

/** Columna en letras: 0 → 'A', 26 → 'AA'. */
export function letraColumna(c: number): string {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** ¿Lleva RUTA? La de la unidad (Ecovallas y Biobox) o si alguna toma la trae. */
function llevaRuta(cfg: ConfigMedio): boolean {
  return cfg.conRuta;
}

/**
 * RUTA de los medios que hoy NO la llevan (Vía Verde: se reparte por turno).
 * Si alguna toma trae ruta, va al final, antes de LLAVE: antes se metía en la
 * columna C y corría todas las demás una letra respecto al Excel de hoy
 * (revisión 2, punta-a-punta-6).
 */
function rutaAlFinal(cfg: ConfigMedio, tomas: TomaExcel[]): boolean {
  return !cfg.conRuta && tomas.some((t) => texto(t.ruta) !== null);
}

/** La ruta como la de hoy: número si son solo dígitos. */
function celdaRuta(t: TomaExcel): Celda {
  const ruta = texto(t.ruta);
  return ruta !== null && /^\d+$/.test(ruta) ? Number(ruta) : ruta;
}

/** Las columnas comunes: FECHA · sitio · [RUTA] · CAMPAÑA · VERSIÓN · COMPROBACIÓN · HORARIO · OBSERVACIONES. */
function columnasBase(cfg: ConfigMedio, conRuta: boolean): { enc: string[]; anchos: number[] } {
  const enc = [cfg.fecha, cfg.sitio, ...(conRuta ? ['RUTA'] : []), cfg.campana, 'VERSIÓN', 'COMPROBACIÓN', 'HORARIO', 'OBSERVACIONES'];
  const anchos = [12, cfg.anchoSitio, ...(conRuta ? [8.5] : []), 30, 34, 13, 26, 60];
  return { enc, anchos };
}

/**
 * Las celdas comunes de una toma. HORARIO: en Ecovallas Digital y Biobox
 * (cfg.horario24h) «24 HORAS» si la toma trae el «24 HRS» de la bitácora o
 * nada en sábado y domingo, y la franja tal cual si la trae (Erik,
 * 23-oct-2026, horario24hOFranja); en Vía Verde el horario del día de la toma.
 */
function celdasBase(cfg: ConfigMedio, t: TomaExcel, conRuta: boolean): Celda[] {
  return [
    celdaDia(t.fecha),
    texto(t.sitio),
    ...(conRuta ? [celdaRuta(t)] : []),
    texto(t.campana),
    texto(t.version),
    texto(t.comprobacion) ?? 'FOTO',
    cfg.horario24h ? horario24hOFranja(t.horario) : texto(t.horario),
    observacionesToma(t.especificacion, t.observaciones),
  ];
}

const llaveToma = (t: TomaExcel): Celda => {
  if (t.id === null || t.id === undefined || t.id === '') return null;
  return typeof t.id === 'number' ? t.id : String(t.id);
};

/** Huecos de un arreglo disperso → null (aoa_to_sheet salta undefined, pero así la matriz es la misma en pruebas y en pantalla). */
const denso = (f: Celda[]) => Array.from(f, (x) => x ?? null);

/** Fila 2: el título y, si la unidad lo trae, el aviso (Biobox, F2). */
function filaTitulo(cfg: ConfigMedio, periodo: PeriodoExcel): Celda[] {
  const f: Celda[] = [cfg.tituloFormato(periodo)];
  if (cfg.avisoFormato) f[(cfg.finTituloFormato ?? 0) + 1] = cfg.avisoFormato;
  return denso(f);
}

const mergeTitulo = (cfg: ConfigMedio): RangoExcel[] =>
  cfg.finTituloFormato ? [{ s: { r: 1, c: 0 }, e: { r: 1, c: cfg.finTituloFormato } }] : [];

/**
 * Libro «Formato Comprobaciones <unidad> <periodo>.xlsx»: un renglón por
 * toma (día × sitio × campaña × versión), como la hoja de hoy:
 *   fila 2 título · fila 4 encabezado · datos desde la fila 5
 *   FECHA · sitio · [RUTA] · CAMPAÑA · VERSIÓN · COMPROBACIÓN · HORARIO ·
 *   OBSERVACIONES · (separador) · MONITORISTA · ESTATUS · columnas de
 *   seguimiento de la unidad (vacías, para anotar) · LLAVE
 * OBSERVACIONES = especificación de la campaña · observación (como hoy).
 * MONITORISTA sustituye al BUSCARV a la «Hoja 2» / «ASIGNACIÓN COLUMNAS» de
 * hoy; ESTATUS sale del estado de la toma (estatusToma); LLAVE, que hoy va
 * vacía, lleva el id de la toma. Van TODAS las tomas que se le pasen, con
 * su ESTATUS (también las de campañas cerradas y las ya comprobadas): es la
 * hoja maestra de Victor. La pantalla las pasa por tomasExcelDeVista, que
 * deja fuera las canceladas (23-oct-2026); si se le pasa una cancelada a
 * mano, sale como QUITADA. HORARIO: «24 HORAS» en Ecovallas Digital y Biobox.
 */
export function armarFormatoGeneral(args: { medio: MedioComp; periodo: PeriodoExcel; tomas: TomaExcel[] }): LibroExcel {
  const cfg = CONFIG[args.medio];
  const conRuta = llevaRuta(cfg);
  const alFinal = rutaAlFinal(cfg, args.tomas);
  const base = columnasBase(cfg, conRuta);
  const enc = [...base.enc, '', 'MONITORISTA', 'ESTATUS', ...cfg.seguimiento, ...(alFinal ? ['RUTA'] : []), 'LLAVE'];
  const filas: Celda[][] = [[], filaTitulo(cfg, args.periodo), [], enc.map((e) => e || null)];
  const vacias = cfg.seguimiento.map(() => null);
  for (const t of ordenarTomas(args.tomas)) {
    filas.push([
      ...celdasBase(cfg, t, conRuta),
      null,
      nombresMonitoristas(t),
      estatusToma(t),
      ...vacias,
      ...(alFinal ? [celdaRuta(t)] : []),
      llaveToma(t),
    ]);
  }
  const ultima = letraColumna(enc.length - 1);
  return {
    nombreArchivo: nombreArchivo(`Formato Comprobaciones ${cfg.archivo} ${periodoArchivo(args.periodo)}.xlsx`),
    hojas: [
      {
        nombre: nombreHoja(cfg.hojaFormato(args.periodo)),
        filas,
        merges: mergeTitulo(cfg),
        anchos: [...base.anchos, 2, 18, 13, ...cfg.seguimiento.map((s) => Math.max(12, s.length + 2)), ...(alFinal ? [8.5] : []), 10],
        autofiltro: `A4:${ultima}${4 + args.tomas.length}`,
      },
    ],
  };
}

export const SIN_MONITORISTA_EXCEL = 'SIN MONITORISTA';

export type GrupoMonitorista = {
  /** Correo (o nombre) + turno; '' = las tomas sin monitorista. */
  clave: string;
  /** Nombre como llegó (el primero), null en el grupo sin monitorista. */
  monitorista: string | null;
  email: string | null;
  turno: string | null;
  /** Para el archivo y la hoja: «SAÚL PRUEBA MATUTINO», única entre los grupos. */
  etiqueta: string;
  tomas: TomaExcel[];
};

/**
 * Reparte las tomas por monitorista (y turno) en UNA pasada. Se agrupa por
 * correo: dos personas con el mismo nombre visible van en archivos
 * distintos (con la inicial o el usuario del correo para distinguirlos), y
 * «Saúl» y «SAUL» sin correo se juntan (llaveComp). Una toma con dos
 * personas (Vía Verde: mañana y tarde) va en el grupo de cada una. Las tomas
 * sin monitorista van en un grupo aparte (clave ''), al final: son las que
 * Victor todavía tiene que repartir. Conserva el orden en que llegan las
 * tomas; NO filtra (eso lo hacen los armar…, con tomaParaCampo).
 */
export function repartirPorMonitorista(tomas: TomaExcel[]): GrupoMonitorista[] {
  const grupos = new Map<string, Omit<GrupoMonitorista, 'etiqueta'> & { base: MonitoristaToma }>();
  for (const t of tomas) {
    const ms = monitoristasDe(t);
    const claves = ms.length ? ms.map((m) => [claveMonitorista(m), m] as const) : ([['', null]] as const);
    const vistas = new Set<string>();
    for (const [k, m] of claves) {
      if (vistas.has(k)) continue; // la misma persona dos veces en una toma
      vistas.add(k);
      let g = grupos.get(k);
      if (!g) {
        g = {
          clave: k,
          monitorista: m?.nombre ?? null,
          email: m?.email ?? null,
          turno: m?.turno ?? null,
          base: m ?? {},
          tomas: [],
        };
        grupos.set(k, g);
      }
      g.tomas.push(t);
    }
  }
  const personas = [...grupos.values()].filter((g) => g.clave !== '');
  const etiquetas = etiquetasUnicas(
    personas.map((g) => ({ clave: g.clave, base: etiquetaMonitorista(g.base), nombre: g.monitorista, email: g.email }))
  );
  return [...grupos.values()]
    .map(({ base: _b, ...g }) => ({ ...g, etiqueta: g.clave ? etiquetas.get(g.clave) ?? '' : SIN_MONITORISTA_EXCEL }))
    .sort((a, b) => (a.clave === '' ? 1 : b.clave === '' ? -1 : cmp(a.etiqueta, b.etiqueta)));
}

/** Lo que el monitorista anota a mano en su archivo. */
const COLUMNAS_MONITORISTA = ['FOTO COMPROBATORIA', 'FECHA DE TOMA', 'OBSERVACIONES'];

/** El libro de UN grupo, con sus tomas ya filtradas y ordenadas. */
function libroMonitorista(cfg: ConfigMedio, periodo: PeriodoExcel, etiqueta: string, suyas: TomaExcel[]): LibroExcel {
  const conRuta = llevaRuta(cfg);
  const alFinal = rutaAlFinal(cfg, suyas);
  const base = columnasBase(cfg, conRuta);
  const enc = [...base.enc, '', ...COLUMNAS_MONITORISTA, ...(alFinal ? ['RUTA'] : []), 'LLAVE'];
  const anota = base.enc.length + 1; // primera columna para anotar
  const fila2: Celda[] = [`TOMA COMPROBACIONES ${cfg.titulo} ${periodoTitulo(periodo)}`];
  fila2[anota] = 'REGISTRAR LA FECHA DEL DIA QUE SE TOMO';
  const fila3: Celda[] = [];
  fila3[anota] = etiqueta;
  const filas: Celda[][] = [[], denso(fila2), denso(fila3), enc.map((e) => e || null)];
  const vacias = COLUMNAS_MONITORISTA.map(() => null);
  for (const t of suyas)
    filas.push([...celdasBase(cfg, t, conRuta), null, ...vacias, ...(alFinal ? [celdaRuta(t)] : []), llaveToma(t)]);
  const ultima = letraColumna(enc.length - 1);
  return {
    nombreArchivo: nombreArchivo(`Formato Comprobaciones ${cfg.archivo} ${periodoArchivo(periodo)} ${etiqueta}.xlsx`),
    hojas: [
      {
        nombre: nombreHoja(`${etiqueta} ${periodoCorto(periodo)}`),
        filas,
        merges: [{ s: { r: 2, c: anota }, e: { r: 2, c: anota + COLUMNAS_MONITORISTA.length - 1 } }],
        anchos: [...base.anchos, 2, 22, 14, 30, ...(alFinal ? [8.5] : []), 10],
        autofiltro: `A4:${ultima}${4 + suyas.length}`,
      },
    ],
  };
}

/**
 * Libro de UN monitorista: la copia filtrada del formato general (solo sus
 * tomas; `monitorista` null = las que no tienen) con columnas en blanco para
 * anotar FOTO COMPROBATORIA, FECHA DE TOMA y OBSERVACIONES:
 *   fila 2 título y, sobre lo que se anota, «REGISTRAR LA FECHA DEL DIA QUE
 *   SE TOMO» · fila 3 el nombre del monitorista · fila 4 encabezado ·
 *   datos desde la fila 5 · LLAVE al final.
 * `monitorista` puede ser el nombre (compatibilidad) o {email, nombre,
 * turno}; con correo se compara el correo. Por omisión solo van las tomas
 * para campo (tomaParaCampo); `incluirTodas` mete también las quitadas, las
 * ya tomadas y las de campañas cerradas.
 * DIFERENTE a hoy, a propósito: el archivo de Vía Verde y Pórticos trae
 * «TOMAS POR SEMANA» y 5 bloques semanales de FOTO COMPROBATORIA /
 * OBSERVACIONES; aquí cada renglón ya es de un día (el plan de tomas), así
 * que va un solo bloque.
 */
export function armarArchivoMonitorista(args: {
  medio: MedioComp;
  periodo: PeriodoExcel;
  monitorista: string | MonitoristaToma | null;
  tomas: TomaExcel[];
  incluirTodas?: boolean;
}): LibroExcel {
  const cfg = CONFIG[args.medio];
  const quien: MonitoristaToma | null =
    typeof args.monitorista === 'string' ? { nombre: args.monitorista } : args.monitorista ?? null;
  const email = texto(quien?.email)?.toLowerCase() ?? null;
  const nombre = texto(quien?.nombre);
  const turno = texto(quien?.turno);
  const sinNadie = !email && !nombre;
  const kNombre = nombre ? llaveComp(nombre) || nombre : '';
  const esSuya = (m: MonitoristaToma) =>
    (email ? (m.email || '').toLowerCase() === email : (llaveComp(m.nombre) || (m.nombre || '')) === kNombre) &&
    (!turno || llaveComp(m.turno) === llaveComp(turno));
  const suyas = ordenarTomas(
    args.tomas.filter((t) => {
      if (!args.incluirTodas && !tomaParaCampo(t)) return false;
      const ms = monitoristasDe(t);
      return sinNadie ? ms.length === 0 : ms.some(esSuya);
    })
  );
  const etiqueta = sinNadie ? SIN_MONITORISTA_EXCEL : etiquetaMonitorista({ email, nombre, turno });
  return libroMonitorista(cfg, args.periodo, etiqueta, suyas);
}

/**
 * Ecovallas Digital, como hoy: UN archivo compartido con las tomas para
 * campo y una columna por monitorista («ALINE», «SAUL», «IVAN») bajo
 * «REGISTRAR LA FECHA DEL DIA QUE SE TOMO» (J2:L2 en el de hoy), donde
 * cada quien anota el día en que tomó la foto. Las columnas de las personas
 * van en blanco; el reparto es por la RUTA del renglón, como hoy.
 * Sin monitoristas, una sola columna «MONITORISTA».
 */
export function armarArchivoMonitoristasCompartido(args: {
  medio: MedioComp;
  periodo: PeriodoExcel;
  tomas: TomaExcel[];
  incluirTodas?: boolean;
}): LibroExcel {
  const cfg = CONFIG[args.medio];
  const tomas = ordenarTomas(args.incluirTodas ? args.tomas : args.tomas.filter(tomaParaCampo));
  const grupos = repartirPorMonitorista(tomas).filter((g) => g.clave !== '');
  const cortas = etiquetasUnicas(
    grupos.map((g) => ({
      clave: g.clave,
      base: etiquetaMonitorista({ nombre: g.monitorista, email: g.email, turno: g.turno }, true),
      nombre: g.monitorista,
      email: g.email,
    }))
  );
  const personas = grupos.length ? grupos.map((g) => cortas.get(g.clave) ?? g.etiqueta) : ['MONITORISTA'];
  const conRuta = llevaRuta(cfg);
  const alFinal = rutaAlFinal(cfg, tomas);
  const base = columnasBase(cfg, conRuta);
  const enc = [...base.enc, '', ...personas, ...(alFinal ? ['RUTA'] : []), 'LLAVE'];
  const anota = base.enc.length + 1;
  const fila2: Celda[] = [cfg.tituloFormato(args.periodo)];
  fila2[anota] = 'REGISTRAR LA FECHA DEL DIA QUE SE TOMO';
  const filas: Celda[][] = [[], denso(fila2), [], enc.map((e) => e || null)];
  const vacias = personas.map(() => null);
  for (const t of tomas)
    filas.push([...celdasBase(cfg, t, conRuta), null, ...vacias, ...(alFinal ? [celdaRuta(t)] : []), llaveToma(t)]);
  const ultima = letraColumna(enc.length - 1);
  return {
    nombreArchivo: nombreArchivo(
      `Formato Comprobaciones ${cfg.archivo} ${periodoArchivo(args.periodo)} MONITORISTAS.xlsx`
    ),
    hojas: [
      {
        nombre: nombreHoja(cfg.hojaFormato(args.periodo)),
        filas,
        merges: [
          ...mergeTitulo(cfg),
          ...(personas.length > 1 ? [{ s: { r: 1, c: anota }, e: { r: 1, c: anota + personas.length - 1 } }] : []),
        ],
        anchos: [...base.anchos, 2, ...personas.map(() => 12), ...(alFinal ? [8.5] : []), 10],
        autofiltro: `A4:${ultima}${4 + tomas.length}`,
      },
    ],
  };
}

/**
 * Los archivos de los monitoristas «como hoy»:
 *   · Ecovallas Digital: UNO compartido (armarArchivoMonitoristasCompartido);
 *   · Biobox, Vía Verde y Pórticos: uno por monitorista y turno, y uno de
 *     «SIN MONITORISTA» si quedan tomas sin repartir.
 * `formato: 'por_persona'` da uno por persona también en Ecovallas.
 * Solo tomas para campo, salvo `incluirTodas`. Se ordena y reparte una sola
 * vez para todos los libros.
 */
export function armarArchivosMonitoristas(args: {
  medio: MedioComp;
  periodo: PeriodoExcel;
  tomas: TomaExcel[];
  formato?: 'como_hoy' | 'por_persona';
  incluirTodas?: boolean;
}): LibroExcel[] {
  if (args.medio === 'Pantalla' && args.formato !== 'por_persona') {
    return [armarArchivoMonitoristasCompartido(args)];
  }
  const cfg = CONFIG[args.medio];
  const tomas = ordenarTomas(args.incluirTodas ? args.tomas : args.tomas.filter(tomaParaCampo));
  return repartirPorMonitorista(tomas).map((g) => libroMonitorista(cfg, args.periodo, g.etiqueta, g.tomas));
}

// ------------------------------------------------------------
// De las vistas de la base a lo que arman los Excel
// ------------------------------------------------------------
//
// Revisión de la SQL (23-oct-2026): la pantalla lee vw_comp_campanas y
// vw_comp_tomas, y los nombres de las columnas no son los del Excel. Para que
// cada pantalla no haga su propio mapeo (y uno se equivoque de columna), se
// hace aquí UNA vez:
//   CampanaExcel ← vw_comp_campanas: venta ← meta (la de la vista: meta_app,
//     meta_full si es FULL, o los sitios activos), ejecutivo ← administrador
//     (el EJECUTIVO del Excel es el ADMINISTRADOR de la bitácora).
//   TomaExcel ← vw_comp_tomas: sitio ← sitio_clave, ruta ← ruta_numero,
//     horario ← horario_texto (o «24 HORAS» en Ecovallas Digital y Biobox) y
//     solo estado <> 'cancelada': ese filtro deja fuera las tomas de sitios
//     cancelados, de sitios que salieron de la carga y de campañas retiradas
//     (R4 de la SQL), y las que Victor quitó a mano. NO basta para los
//     sitios YA COMPROBADOS (revisión 3, 23-oct-2026): sus tomas siguen
//     'pendiente'; de esas se encarga tomaCubiertaPorSitio (ESTATUS «SITIO
//     COMPROBADO» y fuera de los archivos de los monitoristas).

/** Lo que se usa de una fila de vw_comp_campanas (PostgREST puede mandar números como texto). */
export type FilaVistaCampana = {
  id: number | string;
  campana: string;
  version?: string | null;
  vendedor?: string | null;
  administrador?: string | null;
  arte?: string | null;
  analista_email?: string | null;
  meta?: number | string | null;
  comprobados?: number | string | null;
  estatus?: 'abierta' | 'cerrada' | null;
  cerrada_en?: string | null;
  especificacion?: string | null;
  retirada?: boolean | null;
};

/** Lo que se usa de una fila de vw_comp_tomas. */
export type FilaVistaToma = {
  id?: number | string | null;
  medio?: MedioComp | string | null;
  campana: string;
  version?: string | null;
  especificacion?: string | null;
  campana_estatus?: 'abierta' | 'cerrada' | null;
  sitio_clave: string;
  sitio_estado?: 'pendiente' | 'comprobado' | 'cancelado' | null;
  /** comp_sitios.comprobado_dia (pendiente en la vista: ver tomaCubiertaPorSitio). */
  sitio_comprobado_dia?: string | Date | null;
  /** PostgREST manda texto; otros clientes (PGlite) mandan Date. */
  fecha: string | Date | null;
  horario_texto?: string | null;
  observaciones?: string | null;
  comprobacion?: string | null;
  turno?: string | null;
  ruta_numero?: number | string | null;
  monitorista_email?: string | null;
  estado?: EstadoToma | null;
};

/** Correo → nombre (de comp_equipo o comp_monitoristas); se busca en minúsculas. */
export type NombresPorCorreo = Map<string, string> | Record<string, string | null | undefined> | null | undefined;

function nombreDe(nombres: NombresPorCorreo, email: string | null | undefined): string | null {
  const e = (email || '').trim().toLowerCase();
  if (!e || !nombres) return null;
  const n = nombres instanceof Map ? nombres.get(e) : nombres[e];
  return texto(n);
}

/**
 * Filas de vw_comp_campanas → CampanaExcel, TODAS y en el mismo orden.
 * `nombres` pone el nombre de la analista en DISEÑADOR (sin él va su correo,
 * que nombreCorto recorta). Las campañas RETIRADAS (ya no vienen en Pauta VV
 * o el plano, o las reemplazó otra versión) también van, con `retirada`:
 * antes se quitaban aquí y con ellas se perdía lo comprobado en la
 * COMPROBACIÓN DIARIA y en el pie DISEÑADORES (revisión 3, 23-oct-2026).
 * Ahora salen con ESTATUS «RETIRADA», y armarAsignacion({ omitirRetiradas })
 * las quita solo de la hoja de ASIGNACIÓN si Victor no las quiere ver.
 */
export function campanasExcelDeVista(filas: FilaVistaCampana[], opts: { nombres?: NombresPorCorreo } = {}): CampanaExcel[] {
  return filas.map((c) => ({
      id: c.id,
      campana: c.campana,
      version: c.version ?? null,
      vendedor: c.vendedor ?? null,
      ejecutivo: c.administrador ?? null,
      arte: c.arte ?? null,
      analista: nombreDe(opts.nombres, c.analista_email) ?? texto(c.analista_email),
      analista_email: texto(c.analista_email)?.toLowerCase() ?? null,
      venta: c.meta ?? null,
      comprobados: c.comprobados ?? null,
      estatus: c.estatus ?? null,
      cerrada_en: c.cerrada_en ?? null,
      especificacion: c.especificacion ?? null,
      retirada: c.retirada === true,
    }));
}

/**
 * Día 'YYYY-MM-DD' de una fecha de la vista. PostgREST manda texto, pero
 * otros clientes (PGlite, un arnés de pruebas) mandan Date y antes eso se
 * volvía null sin aviso: TODAS las tomas caían al final como «en espera»
 * (revisión 3, 23-oct-2026). Un Date de una columna date viene a la
 * medianoche UTC, así que se lee su día UTC. null si no se entiende.
 */
export function diaDeVista(x: unknown): string | null {
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
  return diaIso(x);
}

/**
 * Filas de vw_comp_tomas → TomaExcel, solo las que no están canceladas
 * (estado <> 'cancelada'), en el mismo orden. `nombres` pone el nombre del
 * monitorista (sin él, el archivo se llama como el usuario del correo).
 * El horario sale de horarioParaMostrar: «24 HORAS» en Ecovallas Digital y
 * Biobox, el horario_texto del día en Vía Verde. Si la fila no trae `medio`,
 * el horario va tal cual y lo corrige el Excel con la unidad que se arma.
 */
export function tomasExcelDeVista(filas: FilaVistaToma[], opts: { nombres?: NombresPorCorreo } = {}): TomaExcel[] {
  const out: TomaExcel[] = [];
  for (const t of filas) {
    if (t.estado === 'cancelada') continue;
    const email = texto(t.monitorista_email)?.toLowerCase() ?? null;
    out.push({
      id: t.id ?? null,
      fecha: diaDeVista(t.fecha),
      sitio: t.sitio_clave,
      ruta: t.ruta_numero ?? null,
      campana: t.campana,
      version: t.version ?? null,
      comprobacion: t.comprobacion ?? null,
      horario: horarioParaMostrar(t.medio, t.horario_texto),
      especificacion: t.especificacion ?? null,
      observaciones: t.observaciones ?? null,
      monitorista: nombreDe(opts.nombres, email),
      monitorista_email: email,
      turno: t.turno ?? null,
      estado: t.estado ?? null,
      campana_estatus: t.campana_estatus ?? null,
      sitio_estado: t.sitio_estado ?? null,
      sitio_comprobado_dia: diaDeVista(t.sitio_comprobado_dia),
    });
  }
  return out;
}

// ------------------------------------------------------------
// Escribir con SheetJS (lo único que toca xlsx; se lo pasa la pantalla)
// ------------------------------------------------------------

/** Lo poco de XLSX que se usa; la pantalla pasa el módulo de cargarXlsx(). */
export type XlsxMinimo = {
  utils: {
    book_new: () => unknown;
    aoa_to_sheet: (filas: Celda[][]) => unknown;
    book_append_sheet: (libro: unknown, hoja: unknown, nombre?: string) => unknown;
  };
};

/**
 * LibroExcel → libro de SheetJS, listo para XLSX.writeFile(wb, libro.nombreArchivo).
 * Pone combinadas, anchos y el filtro del encabezado.
 */
export function aLibroXlsx(libro: LibroExcel, X: XlsxMinimo): unknown {
  const wb = X.utils.book_new();
  const usados = new Set<string>();
  for (const h of libro.hojas) {
    const ws = X.utils.aoa_to_sheet(h.filas) as Record<string, unknown>;
    if (h.merges.length) ws['!merges'] = h.merges;
    ws['!cols'] = h.anchos.map((wch) => ({ wch }));
    if (h.autofiltro) ws['!autofilter'] = { ref: h.autofiltro };
    // Dos hojas con el mismo nombre truenan book_append_sheet.
    let nombre = h.nombre;
    for (let i = 2; usados.has(nombre.toUpperCase()); i++) nombre = nombreHoja(`${h.nombre.slice(0, 27)} (${i})`);
    usados.add(nombre.toUpperCase());
    X.utils.book_append_sheet(wb, ws, nombre);
  }
  return wb;
}
