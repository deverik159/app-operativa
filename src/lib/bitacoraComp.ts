// ============================================================
// src/lib/bitacoraComp.ts
// De dónde salen las campañas de Comprobaciones (fase 2, 23-oct-2026).
//
// POR QUÉ. Erik: «la idea no es que el Supervisor suba el Excel lleno y la app lo
// procese, sino que el Supervisor desde la app construya ese Excel que hoy se usa
// y cuesta tiempo». Las campañas del periodo (la «Asignación de clientes»)
// ya no se teclean: entran de tres lados y todas acaban en la MISMA forma,
// el p_campanas de la RPC comp_cargar_campanas:
//   1. leerBitacora: el libro BITACORA que el área comercial le comparte
//      al Supervisor (Ecovallas Digital y Biobox; también sirve para Vía Verde). Es
//      el mismo formato que exporta Pauta VV (BitacoraVVView.tsx,
//      exportarExcel): una hoja por campaña, encabezado CLIENTE / CAMPAÑA /
//      VENDEDOR / ADMINISTRADOR / FECHA INICIO / FECHA FIN / MEDIAMONITOR /
//      QUANTUM / ESPECIFICACIONES DE TOMAS y una tabla de pautas (ID, TIPO,
//      UBICACIÓN, CAMPAÑA, TIPO (VENTA O BONUS), VERSION, INICIO, FIN,
//      HORARIO L-V, HORARIO S-D, TESTIGOS, OBSERVACIONES, ESTATUS).
//      Erik dejará un archivo real de Ecovallas y otro de Biobox; mientras
//      tanto el lector es TOLERANTE: busca encabezados y etiquetas por
//      nombre (con variantes), acepta columnas de más, varias hojas, varios
//      bloques en una hoja y claves sucias. Agregar una variante es agregar
//      un patrón en ENC_TABLA o ETIQUETAS.
//   2. desdePautaVV: Vía Verde, de lo que ya vive en la app (vv_campanas +
//      vv_pautas y, para lo que no esté ahí, el plano vv_ocupacion).
//   3. armarAlta: el alta a mano del Supervisor (sobre todo Biobox), con
//      «repetir del periodo anterior» (repetirCampana).
// Antes de cargar, revisarContraCargadas compara con lo que ya está en la
// base (una «ampliación» en otro archivo no debe dar de baja lo del primero).
//
// CONTRATO (idéntico en SQL, comp_cargar_campanas): una entrada por
// campaña-VERSIÓN; la llave es (periodo, medio, comp_llave(campana),
// comp_llave(version)). Cada sitio lleva SU vigencia y SUS horarios: el plan
// de tomas (comp_generar_tomas) genera los renglones dentro de esa vigencia,
// recortada al periodo. Este archivo NO recorta al periodo ni inventa
// fechas: si un sitio no trae vigencia va null y la base usa la de la
// campaña (y si tampoco, la del periodo). OJO: la lista de sitios de cada
// entrada MANDA (lo que no viene se da de baja en la base), por eso aquí
// nada se manda a medias: una lectura incompleta de Pauta VV no carga nada.
//
// ES PURO: sin React ni Supabase. Los libros se leen con hojaDeLibro (lee
// desde A1, con los valores crudos y el texto formateado). Las pruebas
// están en tests/bitacoraComp.test.mjs; la validación con la exportación
// real de Pauta VV, en un script local fuera del repo (el repo es público).
// ============================================================

import { claveEspacio, franjasTexto } from './ocupacionVV';
import { llaveComp, type MedioComp, type UnidadComp } from './comprobaciones';
import {
  buscarEncabezado,
  horaExcel,
  leerFechaCelda,
  leerHorario,
  limpiarClave,
  normTexto,
  rellenarCombinadas,
  textoCelda,
  type CambioClave,
  type Merge,
} from './importadorComp';

// ------------------------------------------------------------
// Contrato de comp_cargar_campanas (23-oct-2026)
// ------------------------------------------------------------

export type FuenteComp = 'bitacora' | 'pauta_vv' | 'plano' | 'manual';
export type TipoVenta = 'VENTA' | 'BONUS';

export type SitioContrato = {
  /** Con la forma de inventario.vendor_face_id (MX_CM_VV_COL_856, MX_CM_BB_MED_0114). */
  sitio_clave: string;
  /** Como venía en el archivo o en la base ('856', 'MX_CM_BB_MED_ 0114'). */
  sitio_original: string;
  /** Vía Verde: la clave de vv_espacios ('856', 'POR_0008'); en lo demás null. */
  espacio_vv: string | null;
  inicio: string | null;
  fin: string | null;
  horario_lv: string | null;
  horario_sd: string | null;
  tipo_venta: TipoVenta | null;
  testigos: boolean | null;
  observaciones: string | null;
};

export type CampanaContrato = {
  fuente: FuenteComp;
  /** Bitácora: 'archivo · hoja'; Pauta VV: id de vv_campanas; plano: 'plano AAAA-MM'. */
  origen_ref: string | null;
  cliente: string | null;
  campana: string;
  version: string;
  vendedor: string | null;
  administrador: string | null;
  quantum: string | null;
  mediamonitor: boolean | null;
  especificacion: string | null;
  arte: 'NUEVO' | 'REPITE' | null;
  inicio: string | null;
  fin: string | null;
  es_full: boolean;
  full_minutos: number | null;
  /**
   * PROPUESTA de analista: la base solo la usa si la campaña es nueva o si
   * su analista también vino de archivo; nunca pisa la asignada en la app.
   */
  analista_email: string | null;
  sitios: SitioContrato[];
};

/** Periodo del contrato; inicio/fin hacen falta en catorcena (el calendario vive en la base). */
export type PeriodoBit = { tipo: 'catorcena' | 'mes'; anio: number; numero: number; inicio?: string | null; fin?: string | null };

/** Fila de vv_espacios (lo que hace falta para omitir inactivas y EDO MEX y para ver un FULL). */
export type EspacioVV = { clave: string; activo: boolean; tramo: string | null };

const dos = (n: number) => String(n).padStart(2, '0');

/**
 * Fechas del periodo. Mes: del 1 al último día. Catorcena: las que se
 * pasen (de la tabla catorcenas); sin ellas, null (no se calcula: la
 * numeración de catorcenas es irregular).
 */
export function rangoPeriodo(p: PeriodoBit): { inicio: string; fin: string } | null {
  if (p.inicio && p.fin) return { inicio: p.inicio, fin: p.fin };
  if (p.tipo !== 'mes' || !(p.numero >= 1 && p.numero <= 12)) return null;
  const ultimo = new Date(Date.UTC(p.anio, p.numero, 0)).getUTCDate();
  return { inicio: `${p.anio}-${dos(p.numero)}-01`, fin: `${p.anio}-${dos(p.numero)}-${dos(ultimo)}` };
}

/** ¿[a1, b1] toca [a2, b2]? Un extremo null es abierto. */
const tocan = (a1: string | null, b1: string | null, a2: string | null, b2: string | null) =>
  (!a1 || !b2 || a1 <= b2) && (!b1 || !a2 || b1 >= a2);

const minF = (xs: (string | null | undefined)[]) => xs.reduce<string | null>((m, x) => (x && (!m || x < m) ? x : m), null);
const maxF = (xs: (string | null | undefined)[]) => xs.reduce<string | null>((m, x) => (x && (!m || x > m) ? x : m), null);

const sumarDia = (iso: string, n: number) => {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
};
const diaMes = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// ------------------------------------------------------------
// Vigencias separadas del mismo sitio (revisión del 23-oct-2026)
// ------------------------------------------------------------
// El contrato admite UN renglón por (campaña, sitio). Si el mismo sitio y
// versión vienen del 1 al 5 y del 25 al 31, se manda del 1 al 31 y el hueco
// va en observaciones («SIN AIRE DEL 06/10 AL 24/10»), con aviso, para que
// el Supervisor ajuste las tomas de esos días. El arreglo de fondo (varias
// vigencias por sitio en el contrato) queda pendiente en las dos piezas.

type Vig = [string | null, string | null];

/** Días sin aire entre las vigencias (ninguno si alguna viene sin fecha). */
export function huecosVigencia(vigs: Vig[]): [string, string][] {
  if (vigs.length < 2 || vigs.some(([a, b]) => !a || !b)) return [];
  const xs = [...vigs].sort((x, y) => (x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : 0));
  const out: [string, string][] = [];
  let fin = xs[0][1]!;
  for (const [a, b] of xs.slice(1)) {
    const sig = sumarDia(fin, 1);
    if (a! > sig) out.push([sig, sumarDia(a!, -1)]);
    if (b! > fin) fin = b!;
  }
  return out;
}

const notaHuecos = (h: [string, string][]) =>
  'SIN AIRE ' + h.map(([a, b]) => (a === b ? `EL ${diaMes(a)}` : `DEL ${diaMes(a)} AL ${diaMes(b)}`)).join(', ');

/** Pone el hueco en observaciones y devuelve el aviso (o null si no hay hueco). */
function anotarHuecos(s: SitioContrato, vigs: Vig[]): string | null {
  const h = huecosVigencia(vigs);
  if (!h.length) return null;
  const nota = notaHuecos(h);
  s.observaciones = [s.observaciones, nota].filter(Boolean).join(' · ');
  return `vigencias separadas: va del ${s.inicio} al ${s.fin} con «${nota}» en observaciones; ajusta las tomas de esos días`;
}

// ------------------------------------------------------------
// Claves de sitio por unidad
// ------------------------------------------------------------

export type ClaveSitio = {
  clave: string | null;
  espacioVV: string | null;
  /** Medio que dice la clave (Vía Verde: COL → Columna, POR → Pórtico). */
  medio: MedioComp | null;
  edoMex: boolean;
  cambios: CambioClave[];
};

/** Forma de una clave de Vía Verde en inventario (CDMX o EDO MEX, columna o pórtico). */
const FORMA_VV = /^MX_(CM|EM)_VV_(COL|POR)_[0-9A-Z]+$/;

/**
 * Clave del archivo → forma de inventario.vendor_face_id. En Vía Verde la
 * Bitácora (y vv_pautas) usa la clave CORTA de vv_espacios: '856' es la
 * columna MX_CM_VV_COL_856, 'POR_0008' / 'PORTICO 8' el pórtico
 * MX_CM_VV_POR_0008, y 'A04' / 'B06' son columnas de EDO MEX
 * (MX_EM_VV_COL_A04: de baja). Comprobado en producción el 23-oct-2026:
 * '414' ↔ MX_CM_VV_COL_414 y POR_0008 ↔ MX_CM_VV_POR_0008 en inventario.
 * En Vía Verde lo que no se reconoce como columna o pórtico da clave null
 * (revisión del 23-oct-2026: '856, 857' o 'PORTICO 8' entraban como un
 * sitio que nadie podía comprobar).
 */
export function claveDeSitio(t: unknown, unidad: UnidadComp): ClaveSitio {
  const crudo = textoCelda(t);
  const nada: ClaveSitio = { clave: null, espacioVV: null, medio: null, edoMex: false, cambios: [] };
  if (!crudo) return nada;
  if (unidad === 'Vía Verde') {
    const s = normTexto(crudo).replace(/\s+/g, '');
    // '856', 'COL856', 'COL_856', 'COL-0856': columna de CDMX.
    let m = s.match(/^(?:COL(?:UMNA)?[_-]?)?(\d{1,4})$/);
    if (m) {
      const n = String(Number(m[1])).padStart(3, '0');
      const cambios: CambioClave[] = n !== m[1] ? ['ceros'] : [];
      return { clave: `MX_CM_VV_COL_${n}`, espacioVV: n, medio: 'Columna', edoMex: false, cambios };
    }
    // 'A04', 'B56': columnas de EDO MEX (vv_espacios, tramo 'EDO MEX').
    m = s.match(/^(?:COL(?:UMNA)?[_-]?)?([AB]\d{2})$/);
    if (m) return { clave: `MX_EM_VV_COL_${m[1]}`, espacioVV: m[1], medio: 'Columna', edoMex: true, cambios: [] };
    // 'POR_0008', 'POR8', 'PORTICO 8', 'PÓRTICO 0008': pórtico (4 dígitos, como vv_espacios).
    m = s.match(/^POR(?:TICO)?[_-]?(\d{1,4})$/);
    if (m) {
      const n = String(Number(m[1])).padStart(4, '0');
      const cambios: CambioClave[] = n !== m[1] ? ['alias_portico', 'ceros'] : ['alias_portico'];
      return { clave: `MX_CM_VV_POR_${n}`, espacioVV: `POR_${n}`, medio: 'Pórtico', edoMex: false, cambios };
    }
  }
  // Al limpiador va el texto CRUDO: los espacios de más también son una corrección que se avisa.
  const l = limpiarClave(typeof t === 'string' ? t : crudo);
  if (!l.clave) return nada;
  let medio: MedioComp | null = null;
  let espacioVV: string | null = null;
  if (unidad === 'Vía Verde') {
    if (!FORMA_VV.test(l.clave)) return nada;
    espacioVV = claveEspacio(l.clave);
    medio = /_POR_/.test(l.clave) ? 'Pórtico' : 'Columna';
  } else if (unidad === 'Biobox') medio = 'Máquina';
  else medio = 'Pantalla';
  return { clave: l.clave, espacioVV, medio, edoMex: l.edoMex, cambios: l.cambios };
}

/** ¿Tiene la forma de una clave de inventario (MX_CM_EV_MGP_16_3606…)? */
export const esClaveInventario = (c: string) => /^(MX|PE)_[A-Z]{2}_[A-Z]{2}_[0-9A-Z_]+$/.test(c);

/**
 * Una celda con varias claves ('856, 857', '856 / 857', '856 y 857') → una
 * por clave. No parte lo que está entre paréntesis ('…_0001 (NORTE, CDMX)'
 * es una sola clave con texto pegado).
 */
export function partirClaves(t: string): string[] {
  const out: string[] = [];
  let prof = 0;
  let actual = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '(') prof++;
    if (ch === ')') prof = Math.max(0, prof - 1);
    if (prof === 0 && /[,;/&]/.test(ch)) {
      out.push(actual);
      actual = '';
      continue;
    }
    if (prof === 0 && /\s/.test(ch) && /^\s+[yY]\s+/.test(t.slice(i))) {
      out.push(actual);
      actual = '';
      i += t.slice(i).match(/^\s+[yY]\s+/)![0].length - 1;
      continue;
    }
    actual += ch;
  }
  out.push(actual);
  const partes = out.map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return partes.length ? partes : [t.trim()];
}

// ------------------------------------------------------------
// Celdas de la bitácora
// ------------------------------------------------------------

/** 'SI' / 'SÍ' / 'X' / 'NO'… → boolean; vacío o raro → null. */
export function leerSiNo(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  const t = normTexto(v);
  if (!t) return null;
  if (/^(SI|S|X|TRUE|VERDADERO|1|CON TESTIGOS?)$/.test(t)) return true;
  if (/^(NO|N|FALSE|FALSO|0|SIN TESTIGOS?)$/.test(t)) return false;
  return null;
}

/** 'VENTA' / 'BONUS' / 'BONIFICACIÓN' / 'BONO'; lo demás (INTERCAMBIO, CORTESÍA) → null. */
export function leerTipoVenta(v: unknown): TipoVenta | null {
  const t = normTexto(v);
  if (/^VENTAS?$/.test(t)) return 'VENTA';
  if (/^BON(US|O|IFICACION|IFICADO)S?$/.test(t)) return 'BONUS';
  return null;
}

/**
 * ESTATUS de un renglón que NO se comprueba (revisión del 23-oct-2026: se
 * cargaban como pendientes y contaban en la meta). Los de Pauta VV («Por
 * programar», «Programada», «Cerrada») sí entran.
 */
const ESTATUS_FUERA = /\bCANCELAD[AO]S?\b|\bCANCELACION\b|\bBAJA\b|\bSUSPENDID[AO]S?\b|\bNO SE COMPRUEBAN?\b|\bDETENID[AO]S?\b/;

// Etiquetas del encabezado (arriba de la tabla): el valor es la celda a su
// derecha. Ojo con el orden: FECHA INICIO antes que cualquier «INICIO».
const ETIQUETAS: [keyof Encabezado, RegExp][] = [
  ['cliente', /^(NOMBRE DEL )?CLIENTES?$/],
  ['campana', /^(NOMBRE DE LA )?CAMPANAS?$/],
  ['vendedor', /^(VENDEDOR(A|ES)?|EJECUTIVO COMERCIAL)$/],
  ['administrador', /^(ADMINISTRADOR(A|ES)?|EJECUTIVO|ADMIN)$/],
  ['inicio', /^FECHA (DE )?INICIO$/],
  ['fin', /^FECHA (DE )?(FIN|FINAL|TERMINO)$/],
  ['mediamonitor', /^MEDIA ?MONITOR$/],
  ['quantum', /^QUANTUM$/],
  ['especificacion', /^ESPECIFICACI(ON|ONES)( DE (LAS )?TOMAS)?$/],
];

type Encabezado = {
  cliente: string | null;
  campana: string | null;
  vendedor: string | null;
  administrador: string | null;
  inicio: string | null;
  fin: string | null;
  mediamonitor: boolean | null;
  quantum: string | null;
  especificacion: string | null;
};

const esEtiqueta = (v: unknown) => {
  const t = normTexto(v).replace(/\s*:$/, '');
  return ETIQUETAS.find(([, re]) => re.test(t))?.[0] ?? null;
};
/** 'CLIENTE: TIENDAS X' → ['cliente', 'TIENDAS X']. */
const etiquetaPegada = (t: string): [keyof Encabezado, string] | null => {
  const p = t.match(/^([^:]{3,40}):\s*(.+)$/);
  const k = p ? esEtiqueta(p[1]) : null;
  return k ? [k, p![2]] : null;
};

/**
 * Lee el encabezado de la hoja (filas antes de la tabla). Acepta la
 * etiqueta con su valor a la derecha ('VENDEDOR | Ana | | ADMINISTRADOR |
 * Luis') o en la misma celda ('CLIENTE: TIENDAS X'). `crudos` dice qué
 * etiquetas sí venían (para que un bloque nuevo solo cambie esas).
 */
function leerEncabezadoHoja(filas: unknown[][], hasta: number): { enc: Encabezado; crudos: Partial<Record<keyof Encabezado, unknown>> } {
  const crudos: Partial<Record<keyof Encabezado, unknown>> = {};
  for (let i = 0; i < hasta; i++) {
    const f = filas[i] || [];
    for (let j = 0; j < f.length; j++) {
      const t = textoCelda(f[j]);
      if (!t) continue;
      const pegada = etiquetaPegada(t);
      if (pegada) {
        if (crudos[pegada[0]] === undefined) crudos[pegada[0]] = pegada[1];
        continue;
      }
      const k = esEtiqueta(t);
      if (!k || crudos[k] !== undefined) continue;
      // El valor: la siguiente celda con algo, si no es otra etiqueta.
      let vecinaEtiqueta = true;
      for (let jj = j + 1; jj < f.length; jj++) {
        if (f[jj] === null || f[jj] === undefined || String(f[jj]).trim() === '') continue;
        vecinaEtiqueta = !!esEtiqueta(f[jj]);
        if (!vecinaEtiqueta) crudos[k] = f[jj];
        break;
      }
      // Encabezado en vertical ('CLIENTE | CAMPAÑA | VENDEDOR' y los valores
      // en la fila de abajo): si a la derecha hay otra etiqueta o nada, el
      // valor es la celda de abajo (si no es otra etiqueta).
      if (crudos[k] === undefined && vecinaEtiqueta && i + 1 < hasta) {
        const abajo = filas[i + 1]?.[j];
        if (textoCelda(abajo) && !esEtiqueta(abajo) && !etiquetaPegada(String(abajo))) crudos[k] = abajo;
      }
      if (crudos[k] === undefined) crudos[k] = null;
    }
  }
  const txt = (k: keyof Encabezado) => textoCelda(crudos[k]);
  return {
    crudos,
    enc: {
      cliente: txt('cliente'),
      campana: txt('campana'),
      vendedor: txt('vendedor'),
      administrador: txt('administrador'),
      inicio: leerFechaCelda(crudos.inicio),
      fin: leerFechaCelda(crudos.fin),
      mediamonitor: leerSiNo(crudos.mediamonitor),
      quantum: txt('quantum'),
      especificacion: txt('especificacion'),
    },
  };
}

// Columnas de la tabla. Se busca la PRIMERA que cumpla cada patrón; las
// columnas que no se reconocen se ignoran (UBICACIÓN, TIPO… se leen pero
// no van a la carga).
const ENC_TABLA: Record<string, RegExp> = {
  sitio: /^(ID|CLAVE|SITIO|ESPACIO|VENDOR FACE ID|FACE ID)( (DE )?(LA |EL )?(COLUMNA|SITIO|PANTALLA|BIOBOX|MAQUINA|ESPACIO|PORTICO|CARA|UBICACION))?$|^(COLUMNAS?|PORTICOS?|PANTALLAS?|BIOBOX|MAQUINAS?)$/,
  tipo: /^TIPO$/,
  ubicacion: /^UBICACION(ES)?$/,
  campana: /^CAMPANAS?$/,
  tipoVenta: /^TIPO \(?VENTA|^VENTA (O|\/) BONUS$|^TIPO DE VENTA$/,
  version: /^VERSION(ES)?$/,
  inicio: /^(FECHA (DE )?)?INICIO$/,
  fin: /^(FECHA (DE )?)?(FIN|FINAL|TERMINO)$/,
  horarioLV: /^HORARIO (DE )?(L(UNES)? ?(A|-|AL) ?V(IERNES)?|ENTRE SEMANA)$/,
  horarioSD: /^HORARIO (DE )?(S(ABADOS?)? ?(Y|A|-|AL) ?D(OMINGOS?)?|FIN(ES)? DE SEMANA)$/,
  horario: /^HORARIOS?$/,
  testigos: /^TESTIGOS?$/,
  observaciones: /^OBSERVACI(ON|ONES)$/,
  estatus: /^(ESTATUS|STATUS)$/,
};

/** La fila de encabezado de la tabla de pautas (o null). */
const tablaEn = (filas: unknown[][], max: number) =>
  buscarEncabezado(filas, ENC_TABLA, ['sitio', 'version'], max) ||
  buscarEncabezado(filas, ENC_TABLA, ['sitio', 'inicio'], max) ||
  buscarEncabezado(filas, ENC_TABLA, ['sitio', 'horarioLV'], max);

// ------------------------------------------------------------
// Lectura del libro (integración con SheetJS)
// ------------------------------------------------------------

export type HojaBitacora = {
  nombre: string;
  /** sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true }). */
  filas: unknown[][];
  /**
   * Lo mismo con raw: false (texto como se ve en Excel). Si viene, CAMPAÑA y
   * VERSION se leen de aquí: una versión «01» con formato llega cruda como
   * 1 y daría otra llave que la «01» tecleada como texto.
   */
  textos?: unknown[][] | null;
  merges?: Merge[] | null;
  /** Celda de la hoja que quedó en filas[0][0] (el origen de `!ref`); hojaDeLibro lee desde A1: {0,0}. */
  origen?: { r: number; c: number } | null;
  oculta?: boolean;
};

/** Lo que se usa de XLSX.utils (se pasa desde la pantalla: este archivo no importa xlsx). */
export type UtilsXlsx = {
  sheet_to_json: (...args: never[]) => unknown;
  decode_range: (r: string) => { s: { r: number; c: number }; e: { r: number; c: number } };
};

/**
 * Hoja de SheetJS → HojaBitacora, leída SIEMPRE desde A1 (si la columna A
 * está vacía Excel guarda `!ref` desde B1 y las combinadas caían una columna
 * corridas: revisión del 23-oct-2026), con los valores crudos y el texto
 * formateado. `oculta`: wb.Workbook.Sheets[i].Hidden.
 */
export function hojaDeLibro(utils: UtilsXlsx, ws: Record<string, unknown> | null | undefined, nombre: string, oculta = false): HojaBitacora {
  const ref = ws?.['!ref'];
  if (!ws || typeof ref !== 'string' || !ref) return { nombre, filas: [], textos: null, merges: null, origen: null, oculta };
  const range = { s: { r: 0, c: 0 }, e: utils.decode_range(ref).e };
  const aJson = utils.sheet_to_json as unknown as (w: unknown, o: Record<string, unknown>) => unknown[][];
  const leer = (raw: boolean) => aJson(ws, { header: 1, raw, defval: null, blankrows: true, range });
  return { nombre, filas: leer(true), textos: leer(false), merges: (ws['!merges'] as Merge[] | undefined) ?? null, origen: null, oculta };
}

// ------------------------------------------------------------
// FULL de Vía Verde por cobertura (revisión del 23-oct-2026)
// ------------------------------------------------------------
// Un FULL con rotación (BitacoraVVView «FULL con rotación») llega como N
// versiones, cada columna con la suya, y el nombre no dice FULL. Si sus
// sitios (todas las versiones juntas) cubren casi todas las columnas
// activas de CDMX, se marca es_full con aviso. Sin vv_espacios solo se
// avisa. Erik decide si un FULL con rotación es una fila o N en la Asignación.

const PCT_FULL = 0.95;
const MIN_COLUMNAS_FULL = 10;

function revisarFull(cs: CampanaContrato[], medio: MedioComp, espaciosVV: EspacioVV[] | null | undefined, avisos: string[]) {
  if (medio !== 'Columna') return;
  let activas: Set<string> | null = null;
  if (espaciosVV?.length) {
    activas = new Set();
    for (const e of espaciosVV) {
      const k = claveDeSitio(e.clave, 'Vía Verde');
      if (e.activo && k.medio === 'Columna' && !k.edoMex && !/^EDO MEX/i.test(e.tramo || '') && k.espacioVV) activas.add(k.espacioVV);
    }
  }
  const porNombre = new Map<string, CampanaContrato[]>();
  for (const c of cs) {
    const k = llaveComp(c.campana);
    if (!porNombre.has(k)) porNombre.set(k, []);
    porNombre.get(k)!.push(c);
  }
  for (const grupo of porNombre.values()) {
    if (grupo.every((c) => c.es_full)) continue;
    const union = new Set(grupo.flatMap((c) => c.sitios.map((s) => s.espacio_vv || s.sitio_clave)));
    const nombre = grupo[0].campana;
    if (activas && activas.size >= MIN_COLUMNAS_FULL) {
      const cubre = [...activas].filter((a) => union.has(a)).length;
      if (cubre / activas.size >= PCT_FULL) {
        for (const c of grupo) c.es_full = true;
        avisos.push(`«${nombre}» cubre ${cubre} de las ${activas.size} columnas activas en ${grupo.length} versión(es): se marca FULL; revisa la meta.`);
      }
    } else if (!activas && union.size >= 20 && grupo.length >= 2) {
      avisos.push(`«${nombre}» trae ${union.size} columnas en ${grupo.length} versiones: si es un FULL con rotación, márcalo FULL en la app.`);
    }
  }
}

// ------------------------------------------------------------
// leerBitacora
// ------------------------------------------------------------

export type CtxBitacora = {
  unidad: UnidadComp;
  medio: MedioComp;
  /** Nombre del archivo, para origen_ref y los avisos. */
  archivo?: string | null;
  /** Si viene, lo que no toque el periodo se deja fuera (y se avisa). */
  periodo?: { inicio: string; fin: string } | null;
  /** vendor_face_id de la unidad (para avisar «sin inventario»); sin esto no se revisa. */
  inventario?: Iterable<string> | null;
  /** Vía Verde: vv_espacios (para omitir inactivas y EDO MEX, como la base, y ver un FULL). */
  espaciosVV?: EspacioVV[] | null;
};

export type DescartadaBit = { hoja: string; fila: number; motivo: string; valor?: string };
export type ClaveCorregida = { hoja: string; fila: number; original: string; clave: string; cambios: CambioClave[] };

export type ResultadoBitacora = {
  /** p_campanas del contrato: una entrada por campaña-versión, solo del medio de ctx. */
  campanas: CampanaContrato[];
  avisos: string[];
  descartadas: DescartadaBit[];
  clavesCorregidas: ClaveCorregida[];
  /** Claves que no están en el inventario dado (entran con en_inventario = false: revisar). Misma regla que la base. */
  sinInventario: { clave: string; hoja: string; filas: number[] }[];
  /** Vía Verde: sitios del OTRO medio (se cargan aparte, con su medio). */
  otroMedio: { medio: MedioComp; sitios: number }[];
  /** Hojas que no se leen: ocultas o sin la tabla de pautas. */
  hojasIgnoradas: string[];
};

type SitioAc = SitioContrato & { _filas: number[]; _vig: Vig[] };
type Acum = CampanaContrato & { _sitios: Map<string, SitioAc>; _hojas: Set<string> };

/**
 * Junta dos renglones del mismo sitio en la misma versión (VENTA + BONUS,
 * dos vigencias…). La vigencia va de la primera a la última fecha (null si
 * alguno no trae: la de la campaña); el hueco lo anota anotarHuecos.
 */
function juntarSitio(a: SitioContrato, b: SitioContrato): string[] {
  const avisos: string[] = [];
  a.inicio = a.inicio && b.inicio ? minF([a.inicio, b.inicio]) : null;
  a.fin = a.fin && b.fin ? maxF([a.fin, b.fin]) : null;
  if (!a.horario_lv) a.horario_lv = b.horario_lv;
  else if (b.horario_lv && llaveComp(b.horario_lv) !== llaveComp(a.horario_lv)) avisos.push(`horario L-V distinto («${b.horario_lv}»): queda «${a.horario_lv}»`);
  if (!a.horario_sd) a.horario_sd = b.horario_sd;
  else if (b.horario_sd && llaveComp(b.horario_sd) !== llaveComp(a.horario_sd)) avisos.push(`horario S-D distinto («${b.horario_sd}»): queda «${a.horario_sd}»`);
  // Una venta manda sobre el bonus: el sitio se vendió.
  a.tipo_venta = a.tipo_venta === 'VENTA' || b.tipo_venta === 'VENTA' ? 'VENTA' : a.tipo_venta || b.tipo_venta;
  a.testigos = a.testigos || b.testigos ? true : a.testigos === false || b.testigos === false ? false : null;
  const obs = [...new Set([a.observaciones, b.observaciones].filter((x): x is string => !!x))];
  a.observaciones = obs.length ? obs.join(' · ') : null;
  return avisos;
}

/**
 * Lee un libro BITACORA (una hoja por campaña) y devuelve el p_campanas de
 * comp_cargar_campanas: una entrada por campaña-VERSIÓN con sus sitios, más
 * los avisos para la previa. Reglas:
 *   · La tabla se busca por nombre (ID…/VERSION/INICIO/FIN/HORARIO…); las
 *     filas de arriba son el encabezado de la campaña. Si a media hoja
 *     viene OTRO bloque (sus etiquetas CLIENTE/CAMPAÑA… y/o la fila de
 *     encabezado repetida), se lee como bloque nuevo: nunca como pauta.
 *   · Campaña: la columna CAMPAÑA del renglón; si viene vacía, la del
 *     encabezado; si tampoco, el nombre de la hoja (con aviso). Si la misma
 *     campaña viene con OTRO cliente (otra hoja), se carga aparte como
 *     «CAMPAÑA · CLIENTE» (si no, la base las fundiría en una).
 *   · Versión vacía → '' (una sola versión).
 *   · ESTATUS cancelada / baja / suspendida → no se carga (descartadas).
 *   · Clave de sitio: limpia (claveDeSitio); una celda con varias claves se
 *     parte. Vía Verde: '856' → MX_CM_VV_COL_856; lo que no es columna ni
 *     pórtico se descarta; EDO MEX (de baja) y, si se pasa vv_espacios, las
 *     inactivas se omiten con aviso, como lo hace la base.
 *   · ID 'TODAS' (FULL de Vía Verde): la versión queda es_full, sin ese
 *     renglón como sitio; full_minutos sale del horario si dura menos de 24 h.
 *   · Un sitio repetido en la misma versión se junta (juntarSitio); si sus
 *     vigencias están separadas, el hueco va en observaciones.
 *   · Vigencia de la versión: de la primera a la última fecha de sus
 *     renglones; si algún renglón no trae fecha, la del encabezado.
 *   · La misma campaña-versión en dos hojas (mismo cliente) se junta con aviso.
 * No se descarta en silencio nada que traiga datos: va a `descartadas`.
 */
export function leerBitacora(libro: { hojas: HojaBitacora[] }, ctx: CtxBitacora): ResultadoBitacora {
  const avisos: string[] = [];
  const descartadas: DescartadaBit[] = [];
  const clavesCorregidas: ClaveCorregida[] = [];
  const hojasIgnoradas: string[] = [];
  const ocultas: string[] = [];
  const sinTabla: string[] = [];
  const otro = new Map<MedioComp, Set<string>>();
  const inventario = ctx.inventario ? new Set([...ctx.inventario].map((c) => String(c).trim().toUpperCase())) : null;
  const espacios = ctx.espaciosVV ? new Map(ctx.espaciosVV.map((e) => [String(e.clave).trim().toUpperCase(), e])) : null;
  const sinInv = new Map<string, { clave: string; hoja: string; filas: number[] }>();
  const edoMex = new Set<string>();
  const inactivas = new Set<string>();
  const porLlave = new Map<string, Acum>();
  const orden: Acum[] = [];
  /** Llave → nombre de cada campaña-versión vista, entre o no (para avisar las que se pierden). */
  const vistas = new Map<string, string>();
  const deOtroMedio = new Set<string>();
  /** Llave de la campaña → llave del cliente con que llegó primero. */
  const duenos = new Map<string, string>();
  const renombradas = new Set<string>();
  const porEstatus: string[] = [];
  let fueraDePeriodo = 0;
  const VV = ctx.unidad === 'Vía Verde';

  for (const h of libro.hojas) {
    if (h.oculta) {
      hojasIgnoradas.push(h.nombre);
      if (tablaEn(h.filas || [], 60)) ocultas.push(h.nombre);
      continue;
    }
    const origen = h.origen ?? { r: 0, c: 0 };
    const filas = rellenarCombinadas(h.filas || [], h.merges, origen);
    const textos = h.textos ? rellenarCombinadas(h.textos, h.merges, origen) : null;
    const enc = tablaEn(filas, 60);
    if (!enc) {
      if (filas.some((f) => (f || []).some((v) => textoCelda(v)))) {
        hojasIgnoradas.push(h.nombre);
        sinTabla.push(h.nombre);
      }
      continue;
    }
    let col = enc.col;
    let cab = leerEncabezadoHoja(filas, enc.fila).enc;
    const cel = (f: unknown[], k: string) => (col[k] === undefined ? null : f[col[k]]);
    /** Texto como se ve en Excel (si se pasó `textos`); si no, el crudo. */
    const visto = (i: number, f: unknown[], k: string) =>
      (textos && col[k] !== undefined ? textoCelda(textos[i]?.[col[k]]) : null) ?? textoCelda(cel(f, k));
    const ref = ctx.archivo ? `${ctx.archivo} · ${h.nombre}` : h.nombre;
    const avisoFechasCab = () => {
      if (cab.inicio && cab.fin && cab.fin < cab.inicio) avisos.push(`Hoja «${h.nombre}»: FECHA FIN antes de FECHA INICIO en el encabezado.`);
    };
    avisoFechasCab();
    let campanaDeHoja = false;

    for (let i = enc.fila + 1; i < filas.length; i++) {
      const f = filas[i] || [];
      const fila = i + 1 + origen.r;
      // Otro bloque en la misma hoja (revisión del 23-oct-2026): la fila de
      // encabezado repetida se volvía la campaña «CAMPAÑA / VERSION» con el
      // sitio «IDCOLUMNA».
      const otraTabla = tablaEn([f], 1);
      if (otraTabla) {
        col = otraTabla.col;
        continue;
      }
      // Etiquetas del bloque nuevo (CLIENTE, CAMPAÑA, FECHA INICIO…) a la
      // izquierda de la clave: cambian el encabezado de lo que sigue.
      const hastaSitio = col.sitio ?? 0;
      if (f.slice(0, hastaSitio + 1).some((v) => {
        const t = textoCelda(v);
        return !!t && (!!esEtiqueta(t) || !!etiquetaPegada(t));
      })) {
        const { enc: e2, crudos } = leerEncabezadoHoja([f], 1);
        cab = { ...cab };
        for (const k of Object.keys(crudos) as (keyof Encabezado)[]) (cab as Record<string, unknown>)[k] = e2[k];
        avisoFechasCab();
        continue;
      }
      const sitioTxt = textoCelda(cel(f, 'sitio'));
      const versionTxt = visto(i, f, 'version');
      const iniTxt = cel(f, 'inicio');
      const finTxt = cel(f, 'fin');
      const conDatos = [versionTxt, textoCelda(iniTxt), textoCelda(finTxt), textoCelda(cel(f, 'horarioLV')), textoCelda(cel(f, 'horario'))].some(Boolean);
      if (!sitioTxt) {
        if (conDatos) descartadas.push({ hoja: h.nombre, fila, motivo: 'sin clave de sitio' });
        continue;
      }
      // Pies y notas al final de la tabla ('TOTAL 12', 'NOTA: …'): sin versión ni fechas no son pautas.
      if (/^(TOTAL(ES)?|NOTAS?)\b/.test(normTexto(sitioTxt)) && !conDatos) continue;
      const estatus = textoCelda(cel(f, 'estatus'));
      if (estatus && ESTATUS_FUERA.test(normTexto(estatus))) {
        descartadas.push({ hoja: h.nombre, fila, motivo: `estatus «${estatus}»`, valor: sitioTxt });
        porEstatus.push(`${sitioTxt} (${estatus})`);
        continue;
      }

      let campana = visto(i, f, 'campana') || cab.campana;
      if (!campana) {
        campana = h.nombre.trim();
        campanaDeHoja = true;
      }
      // La misma campaña con otro cliente: aparte, con el cliente en el nombre.
      {
        const lc = llaveComp(campana);
        const cl = llaveComp(cab.cliente);
        const d = duenos.get(lc);
        if (d === undefined || (!d && cl)) duenos.set(lc, cl);
        else if (d && cl && d !== cl) {
          const nuevo = `${campana} · ${cab.cliente}`;
          if (!renombradas.has(nuevo)) {
            renombradas.add(nuevo);
            avisos.push(`«${campana}» viene también con el cliente ${cab.cliente} (hoja «${h.nombre}»): se carga aparte como «${nuevo}».`);
          }
          campana = nuevo;
        }
      }
      const version = versionTxt || '';
      const inicio = leerFechaCelda(iniTxt);
      const fin = leerFechaCelda(finTxt);
      if (textoCelda(iniTxt) && !inicio) avisos.push(`Hoja «${h.nombre}» fila ${fila}: INICIO «${textoCelda(iniTxt)}» no es fecha; se toma la de la campaña.`);
      if (textoCelda(finTxt) && !fin) avisos.push(`Hoja «${h.nombre}» fila ${fila}: FIN «${textoCelda(finTxt)}» no es fecha; se toma la de la campaña.`);
      if (inicio && fin && fin < inicio) {
        descartadas.push({ hoja: h.nombre, fila, motivo: 'FIN antes de INICIO', valor: `${inicio} → ${fin}` });
        continue;
      }
      // Horario: texto tal cual. Una hora de Excel (0.2916 o un Date de
      // 1899) se lee como 'HH:MM' con aviso; otro número no es horario.
      const leerHz = (k: string): string | null => {
        const v = cel(f, k);
        if (v === 24) return '24 HRS';
        const hx = horaExcel(v);
        if (hx) {
          avisos.push(`Hoja «${h.nombre}» fila ${fila}: el horario venía como hora de Excel; se lee «${hx}» (revisa si era una franja).`);
          return hx;
        }
        if (typeof v === 'number' || v instanceof Date) {
          avisos.push(`Hoja «${h.nombre}» fila ${fila}: «${textoCelda(v)}» no es un horario; se deja vacío.`);
          return null;
        }
        const t = textoCelda(v);
        if (t && !leerHorario(t).entendido) avisos.push(`Hoja «${h.nombre}» fila ${fila}: horario «${t}» no se entiende; se guarda tal cual.`);
        return t;
      };
      const hUnico = col.horario !== undefined ? leerHz('horario') : null;
      const horarioLV = (col.horarioLV !== undefined ? leerHz('horarioLV') : null) ?? hUnico;
      const horarioSD = (col.horarioSD !== undefined ? leerHz('horarioSD') : null) ?? hUnico;
      const tvTxt = textoCelda(cel(f, 'tipoVenta'));
      const tipoVenta = leerTipoVenta(tvTxt);
      const obsTxt = textoCelda(cel(f, 'observaciones'));
      const observaciones = [tvTxt && !tipoVenta ? tvTxt : null, obsTxt].filter(Boolean).join(' · ') || null;

      if (ctx.periodo && !tocan(inicio ?? cab.inicio, fin ?? cab.fin, ctx.periodo.inicio, ctx.periodo.fin)) {
        fueraDePeriodo++;
        descartadas.push({ hoja: h.nombre, fila, motivo: 'fuera del periodo', valor: `${inicio ?? cab.inicio ?? '?'} → ${fin ?? cab.fin ?? '?'}` });
        continue;
      }

      const llave = `${llaveComp(campana)}|${llaveComp(version)}`;
      const nombreCV = `${campana}${version ? ' / ' + version : ''}`;
      if (!vistas.has(llave)) vistas.set(llave, nombreCV);
      // La campaña-versión se crea con su PRIMER sitio aceptado: una versión
      // que solo trae sitios del otro medio (o descartados) no entra vacía.
      // La vigencia de la versión es la de sus renglones aceptados (la del
      // encabezado si el renglón no trae).
      const nuevaAcum = (): Acum => ({
        fuente: 'bitacora',
        origen_ref: ref,
        cliente: cab.cliente,
        campana: campana!,
        version,
        vendedor: cab.vendedor,
        administrador: cab.administrador,
        quantum: cab.quantum,
        mediamonitor: cab.mediamonitor,
        especificacion: cab.especificacion,
        arte: null,
        inicio: null,
        fin: null,
        es_full: /^FULL\b/.test(normTexto(campana)),
        full_minutos: null,
        analista_email: null,
        sitios: [],
        _sitios: new Map(),
        _hojas: new Set([h.nombre]),
      });
      const obtener = (): Acum => {
        let c = porLlave.get(llave);
        if (!c) {
          c = nuevaAcum();
          porLlave.set(llave, c);
          orden.push(c);
        } else if (!c._hojas.has(h.nombre)) {
          if (c._hojas.size === 1) avisos.push(`«${nombreCV}» viene en más de una hoja (${[...c._hojas][0]}, ${h.nombre}): se juntan sus sitios.`);
          c._hojas.add(h.nombre);
        }
        c.inicio = minF([c.inicio, inicio ?? cab.inicio]);
        c.fin = maxF([c.fin, fin ?? cab.fin]);
        return c;
      };

      // FULL «TODAS»: todas las columnas; las agrega quien lleva la campaña.
      // En Vía Verde el FULL es de columnas (así viene en el formato GENERAL).
      if (llaveComp(sitioTxt) === 'TODAS') {
        if (VV && ctx.medio !== 'Columna') {
          // Es de la otra llamada (Columna): no es una campaña «perdida».
          deOtroMedio.add(llave);
          if (!otro.has('Columna')) otro.set('Columna', new Set());
          otro.get('Columna')!.add(`TODAS|${llave}`);
          continue;
        }
        const c = obtener();
        c.es_full = true;
        const min = leerHorario(horarioLV ?? horarioSD).minutos;
        if (min && min < 1440) c.full_minutos = Math.max(c.full_minutos ?? 0, min);
        continue;
      }

      const partes = partirClaves(sitioTxt);
      for (const parte of partes) {
        // Una sola clave: al limpiador va la celda cruda (los espacios de más se avisan).
        const k = claveDeSitio(partes.length === 1 ? cel(f, 'sitio') : parte, ctx.unidad);
        if (!k.clave) {
          descartadas.push({ hoja: h.nombre, fila, motivo: VV ? 'clave de Vía Verde ilegible (ni columna ni pórtico)' : 'clave de sitio ilegible', valor: parte });
          continue;
        }
        if (VV && k.edoMex) {
          edoMex.add(k.espacioVV || k.clave);
          descartadas.push({ hoja: h.nombre, fila, motivo: 'EDO MEX (de baja)', valor: parte });
          continue;
        }
        if (VV && espacios && k.espacioVV) {
          const e = espacios.get(k.espacioVV.toUpperCase());
          if (e && (!e.activo || /^EDO MEX/i.test(e.tramo || ''))) {
            (e.activo ? edoMex : inactivas).add(k.espacioVV);
            descartadas.push({ hoja: h.nombre, fila, motivo: e.activo ? 'EDO MEX (de baja)' : 'espacio inactivo en vv_espacios', valor: parte });
            continue;
          }
        }
        if (!esClaveInventario(k.clave) && !version && !inicio && !fin) {
          descartadas.push({ hoja: h.nombre, fila, motivo: 'no parece un sitio (sin versión ni fechas)', valor: parte });
          continue;
        }
        if (k.medio && k.medio !== ctx.medio) {
          if (!otro.has(k.medio)) otro.set(k.medio, new Set());
          otro.get(k.medio)!.add(k.clave);
          deOtroMedio.add(llave);
          continue;
        }
        if (k.cambios.length || (k.clave !== parte && !VV))
          clavesCorregidas.push({ hoja: h.nombre, fila, original: parte, clave: k.clave, cambios: k.cambios });
        if (!esClaveInventario(k.clave))
          avisos.push(`Hoja «${h.nombre}» fila ${fila}: «${parte}» no tiene forma de clave de inventario; revísala.`);
        // Misma regla que la base: solo el inventario dice «sin inventario».
        if (inventario && !inventario.has(k.clave)) {
          const s = sinInv.get(k.clave) || { clave: k.clave, hoja: h.nombre, filas: [] };
          s.filas.push(fila);
          sinInv.set(k.clave, s);
        }
        const nuevo: SitioAc = {
          sitio_clave: k.clave,
          sitio_original: parte,
          espacio_vv: k.espacioVV,
          inicio,
          fin,
          horario_lv: horarioLV,
          horario_sd: horarioSD,
          tipo_venta: tipoVenta,
          testigos: leerSiNo(cel(f, 'testigos')),
          observaciones,
          _filas: [fila],
          _vig: [[inicio, fin]],
        };
        const c = obtener();
        const previo = c._sitios.get(k.clave);
        if (!previo) c._sitios.set(k.clave, nuevo);
        else {
          previo._filas.push(fila);
          previo._vig.push([inicio, fin]);
          for (const a of juntarSitio(previo, nuevo))
            avisos.push(`«${nombreCV}», sitio ${k.clave} (filas ${previo._filas.join(', ')}): ${a}.`);
        }
      }
    }
    if (campanaDeHoja) avisos.push(`Hoja «${h.nombre}»: sin nombre de campaña; se usa el nombre de la hoja.`);
  }

  const campanas: CampanaContrato[] = orden.map(({ _sitios, _hojas, ...c }) => ({
    ...c,
    sitios: [..._sitios.values()].map(({ _filas, _vig, ...s }) => {
      const a = anotarHuecos(s, _vig);
      if (a) avisos.push(`«${c.campana}${c.version ? ' / ' + c.version : ''}», sitio ${s.sitio_clave} (filas ${_filas.join(', ')}): ${a}.`);
      return s;
    }),
  }));
  if (VV) revisarFull(campanas, ctx.medio, ctx.espaciosVV, avisos);
  for (const c of campanas)
    if (c.es_full && !c.sitios.length)
      avisos.push(`«${c.campana}${c.version ? ' / ' + c.version : ''}» es FULL sin sitios: las columnas se agregan en la app.`);
  if (porEstatus.length)
    avisos.push(`${porEstatus.length} renglón(es) con ESTATUS de cancelación, baja o suspensión: no se cargan (${porEstatus.slice(0, 8).join(', ')}${porEstatus.length > 8 ? '…' : ''}).`);
  const perdidas = [...vistas].filter(([l]) => !porLlave.has(l) && !deOtroMedio.has(l)).map(([, n]) => n);
  if (perdidas.length) avisos.push(`${perdidas.length} campaña(s)-versión quedaron sin sitios válidos y no se cargan: ${perdidas.join(', ')}.`);
  if (edoMex.size) avisos.push(`${edoMex.size} sitio(s) de EDO MEX omitidos (de baja): ${[...edoMex].join(', ')}.`);
  if (inactivas.size) avisos.push(`${inactivas.size} espacio(s) inactivos omitidos: ${[...inactivas].join(', ')}.`);
  if (fueraDePeriodo) avisos.push(`${fueraDePeriodo} renglón(es) fuera del periodo: no se cargan.`);
  const otroMedio = [...otro].map(([medio, s]) => ({ medio, sitios: s.size }));
  for (const o of otroMedio) avisos.push(`${o.sitios} sitio(s) son de ${o.medio}: se cargan aparte, eligiendo ese medio.`);
  const sinInventario = [...sinInv.values()];
  if (sinInventario.length)
    avisos.push(`${sinInventario.length} clave(s) no están en el inventario (entran, marcadas para revisar): ${sinInventario.map((s) => s.clave).join(', ')}.`);
  if (clavesCorregidas.length) avisos.push(`${clavesCorregidas.length} clave(s) se limpiaron (espacios, ceros, texto pegado).`);
  if (ocultas.length) avisos.push(`Hojas OCULTAS con tabla de pautas (no se leen; si van, muéstralas en Excel y vuelve a subir el libro): ${ocultas.join(', ')}.`);
  if (sinTabla.length) avisos.push(`Hojas sin tabla de bitácora (no se leen): ${sinTabla.join(', ')}.`);
  if (!campanas.length && !otroMedio.length) avisos.push('El libro no trae campañas: revisa que sea la bitácora (tabla ID / VERSION / INICIO / FIN / HORARIO).');
  // Sin repetir (el mismo aviso de L-V y de S-D, por ejemplo).
  return { campanas, avisos: [...new Set(avisos)], descartadas, clavesCorregidas, sinInventario, otroMedio, hojasIgnoradas };
}

// ------------------------------------------------------------
// Vía Verde: desde Pauta VV (vv_campanas + vv_pautas) y el plano (vv_ocupacion)
// ------------------------------------------------------------

/** Filas de producción (columnas comprobadas con SELECT el 23-oct-2026). */
export type VVCampanaFila = {
  id: number;
  cliente: string;
  nombre: string;
  vendedor: string | null;
  administrador: string | null;
  quantum: string | null;
  fecha_inicio: string;
  fecha_fin: string;
  mediamonitor: boolean;
  espec_tomas: string | null;
  /** 'activa' | 'cerrada' */
  estatus: string;
};
export type VVPautaFila = {
  id: number;
  campana_id: number;
  espacio_clave: string;
  /** 'VENTA' | 'BONUS' */
  tipo_venta: string;
  version: string;
  inicio: string;
  fin: string;
  horario_lv: string;
  horario_sd: string;
  testigos: boolean;
  observaciones: string | null;
  /** 'por_programar' | 'programada' | 'cerrada' */
  estatus: string;
};
export type VVOcupacionFila = {
  id: number;
  espacio_clave: string;
  slot: number;
  campana: string;
  /** 'VENTA' | 'BONIFICACION' | 'INTERCAMBIO' */
  negociacion: string;
  convencional: boolean;
  inicio: string;
  fin: string;
  /** 0 = lunes … 6 = domingo; null = todos. */
  dias: number[] | null;
  /** Horas enteras 0-23. */
  horas: number[];
  /** 'vendida' | 'reservada' | 'pautada' */
  estatus: string;
  /** 'plano' | 'app' */
  origen: string;
  plano_mes: string | null;
};

export type OpcionesPautaVV = {
  /**
   * Cuántos renglones HAY en la base con el mismo filtro (count: 'exact').
   * Si llegó menos (PostgREST corta en 1,000 por petición; la RLS puede
   * esconder filas), no se arma nada: la lista de sitios manda en la carga
   * y una lista recortada daría de baja sitios que sí están.
   */
  totales?: { campanas?: number | null; pautas?: number | null; ocupacion?: number | null } | null;
  /** vv_espacios: para reconocer un FULL con rotación por cobertura. */
  espaciosVV?: EspacioVV[] | null;
};

export type ResultadoPautaVV = {
  /** p_campanas por medio: Vía Verde se carga en dos llamadas (Columna y Pórtico). */
  porMedio: Record<'Columna' | 'Pórtico', CampanaContrato[]>;
  avisos: string[];
  /** Si trae algo, NO se llama a la carga (porMedio viene vacío). */
  errores: string[];
};

const DIA_CORTO = ['LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB', 'DOM'];

/** Espacio de vv_espacios → sitio del contrato ('856' → MX_CM_VV_COL_856). */
function sitioVV(espacio: string): { clave: string | null; espacio: string; medio: MedioComp | null; edoMex: boolean } {
  const k = claveDeSitio(espacio, 'Vía Verde');
  return { clave: k.clave, espacio: k.espacioVV || String(espacio).trim(), medio: k.medio, edoMex: k.edoMex };
}

/**
 * El plano que vale para el periodo, como planoParaMes (planoDelDia.ts): el
 * más reciente que NO sea posterior al mes del periodo; si no hay, el
 * primero después. Lo capturado en la app (origen 'app') siempre cuenta.
 * Así, si se pasan los renglones de varios planos, no se duplican.
 */
function planoVigente(filas: VVOcupacionFila[], mesPeriodo: string): string | null {
  const meses = [...new Set(filas.filter((f) => f.origen === 'plano' && f.plano_mes).map((f) => f.plano_mes!))].sort();
  const antes = meses.filter((m) => m <= mesPeriodo);
  return antes.length ? antes[antes.length - 1] : meses[0] ?? null;
}

/**
 * Vía Verde desde la app. Pauta VV es la fuente buena: una entrada por
 * campaña × versión de vv_pautas que toque el periodo, con la vigencia y
 * los horarios de cada pauta (por espacio). Reglas (23-oct-2026):
 *   · Lectura incompleta (opts.totales) → errores y nada que cargar.
 *   · Dos campañas de vv_campanas con el mismo nombre: si el cliente es
 *     otro, la de menor id conserva el nombre y las demás van como
 *     «NOMBRE · CLIENTE» (si no, la base las fundiría y ganaría la
 *     vigencia de la primera); con el mismo cliente, sus pautas se juntan.
 *   · El plano (vv_ocupacion) cubre lo que comercial no capturó en Pauta
 *     VV. Solo cuentan las líneas vendidas o pautadas (una reserva no se
 *     comprueba). Una línea del plano se omite solo si SU espacio ya está
 *     en Pauta VV para esa campaña; los espacios que sobran se agregan a la
 *     campaña de Pauta VV (si tiene una sola versión, a esa versión; si
 *     tiene varias, aparte con versión '') con aviso que los lista. Las
 *     campañas que no están en Pauta VV entran con versión '' y sin cliente.
 *   · Las campañas cerradas en Pauta VV también entran si sus pautas tocan
 *     el periodo: «cerrada» ahí es que ya no sale en «Hoy al aire», y lo
 *     que estuvo al aire en el periodo se comprueba igual.
 *   · FULL con rotación: ver revisarFull.
 */
export function desdePautaVV(
  campanas: VVCampanaFila[],
  pautas: VVPautaFila[],
  ocupacion: VVOcupacionFila[],
  periodo: PeriodoBit,
  opts: OpcionesPautaVV = {},
): ResultadoPautaVV {
  const avisos: string[] = [];
  const errores: string[] = [];
  const porMedio: ResultadoPautaVV['porMedio'] = { Columna: [], 'Pórtico': [] };

  // --- ¿Llegó todo? (revisión del 23-oct-2026) ---
  const t = opts.totales;
  if (t) {
    const ver: [string, number, number | null | undefined][] = [
      ['vv_campanas', campanas.length, t.campanas],
      ['vv_pautas', pautas.length, t.pautas],
      ['vv_ocupacion', ocupacion.length, t.ocupacion],
    ];
    for (const [tabla, llegaron, hay] of ver)
      if (typeof hay === 'number' && llegaron < hay)
        errores.push(`De ${tabla} llegaron ${llegaron} de ${hay} renglones: la lectura quedó incompleta (paginación o permisos). No se carga nada, para no dar de baja sitios que sí están.`);
  }
  if (!campanas.length && pautas.length)
    errores.push(`Llegaron ${pautas.length} pauta(s) sin ninguna campaña de Pauta VV: revisa el permiso de lectura de vv_campanas.`);
  if (errores.length) return { porMedio, avisos, errores };
  if (!campanas.length && !ocupacion.length)
    avisos.push('Pauta VV y el plano vinieron vacíos: si sí hay campañas, tu usuario no puede leerlas (permiso de Pauta VV) y no hay nada que cargar.');
  else if (!campanas.length) avisos.push('Pauta VV vino vacía: solo se toma lo del plano. Si sí hay campañas, revisa el permiso de lectura de Pauta VV.');

  const r = rangoPeriodo(periodo);
  if (!r) {
    avisos.push('Faltan las fechas de la catorcena: no se puede saber qué pautas tocan el periodo.');
    return { porMedio, avisos, errores };
  }
  const camp = new Map(campanas.map((c) => [c.id, c]));
  const edoMex = new Set<string>();
  const pautasP = pautas.filter((p) => tocan(p.inicio, p.fin, r.inicio, r.fin));

  // --- Nombres: el mismo nombre con otro cliente va aparte ---
  const porNombre = new Map<string, VVCampanaFila[]>();
  for (const id of [...new Set(pautasP.map((p) => p.campana_id))].filter((x) => camp.has(x)).sort((a, b) => a - b)) {
    const c = camp.get(id)!;
    const k = llaveComp(c.nombre);
    if (!porNombre.has(k)) porNombre.set(k, []);
    porNombre.get(k)!.push(c);
  }
  const nombreFinal = new Map<number, string>();
  /** Llave del nombre → nombre de la campaña de menor id (el que se queda sin cliente). */
  const nombreDueno = new Map<string, string>();
  for (const [k, cs] of porNombre) {
    const dueno = llaveComp(cs[0].cliente);
    nombreDueno.set(k, cs[0].nombre.trim());
    const otros: string[] = [];
    for (const c of cs) {
      const cl = llaveComp(c.cliente);
      const n = cl && cl !== dueno ? `${c.nombre.trim()} · ${String(c.cliente).trim()}` : c.nombre.trim();
      if (n !== c.nombre.trim()) otros.push(`«${n}»`);
      nombreFinal.set(c.id, n);
    }
    if (otros.length)
      avisos.push(`«${cs[0].nombre.trim()}» está en Pauta VV con ${new Set(cs.map((c) => llaveComp(c.cliente))).size} clientes: la de ${cs[0].cliente} conserva el nombre y las otras van aparte (${otros.join(', ')}).`);
    else if (cs.length > 1)
      avisos.push(`«${cs[0].nombre.trim()}» está ${cs.length} veces en Pauta VV con el mismo cliente (ids ${cs.map((c) => c.id).join(', ')}): sus pautas se juntan.`);
  }

  // --- Pauta VV ---
  type SitioVVAc = SitioContrato & { _vig: Vig[] };
  type Grupo = { c: CampanaContrato; medio: 'Columna' | 'Pórtico'; sitios: Map<string, SitioVVAc> };
  const grupos = new Map<string, Grupo>();
  const ordenG: Grupo[] = [];
  /** `${llave del nombre}|${espacio}` que ya están en Pauta VV (para no repetirlos del plano). */
  const cubierto = new Set<string>();
  /** Llave del nombre → versiones en Pauta VV (llave → texto). */
  const versionesDe = new Map<string, Map<string, string>>();
  let huerfanas = 0;
  for (const p of pautasP) {
    const c = camp.get(p.campana_id);
    if (!c) {
      huerfanas++;
      continue;
    }
    const ln = llaveComp(c.nombre);
    const s = sitioVV(p.espacio_clave);
    if (!s.clave || !s.medio) {
      avisos.push(`Pauta ${p.id}: espacio «${p.espacio_clave}» no se reconoce.`);
      continue;
    }
    cubierto.add(`${ln}|${s.espacio}`);
    if (s.edoMex) {
      edoMex.add(s.espacio);
      continue;
    }
    const version = (p.version || '').trim();
    if (!versionesDe.has(ln)) versionesDe.set(ln, new Map());
    if (!versionesDe.get(ln)!.has(llaveComp(version))) versionesDe.get(ln)!.set(llaveComp(version), version);
    const nombre = nombreFinal.get(c.id) ?? c.nombre.trim();
    const medio = s.medio as 'Columna' | 'Pórtico';
    // La llave del CONTRATO: dos entradas nunca chocan en la base.
    const llave = `${medio}|${llaveComp(nombre)}|${llaveComp(version)}`;
    let g = grupos.get(llave);
    if (!g) {
      g = {
        medio,
        c: {
          fuente: 'pauta_vv',
          origen_ref: String(c.id),
          cliente: c.cliente,
          campana: nombre,
          version,
          vendedor: c.vendedor,
          administrador: c.administrador,
          quantum: c.quantum,
          mediamonitor: c.mediamonitor,
          especificacion: c.espec_tomas,
          arte: null,
          inicio: null,
          fin: null,
          es_full: /^FULL\b/.test(normTexto(c.nombre)),
          full_minutos: null,
          analista_email: null,
          sitios: [],
        },
        sitios: new Map(),
      };
      grupos.set(llave, g);
      ordenG.push(g);
    }
    g.c.inicio = minF([g.c.inicio, p.inicio]);
    g.c.fin = maxF([g.c.fin, p.fin]);
    const nuevo: SitioVVAc = {
      sitio_clave: s.clave,
      sitio_original: p.espacio_clave,
      espacio_vv: s.espacio,
      inicio: p.inicio,
      fin: p.fin,
      horario_lv: p.horario_lv || null,
      horario_sd: p.horario_sd || null,
      tipo_venta: leerTipoVenta(p.tipo_venta),
      testigos: p.testigos,
      observaciones: p.observaciones?.trim() || null,
      _vig: [[p.inicio, p.fin]],
    };
    const previo = g.sitios.get(s.clave);
    if (!previo) g.sitios.set(s.clave, nuevo);
    else {
      previo._vig.push([p.inicio, p.fin]);
      for (const a of juntarSitio(previo, nuevo)) avisos.push(`«${nombre} / ${p.version}», ${s.espacio}: ${a}.`);
    }
  }
  if (huerfanas) avisos.push(`${huerfanas} pauta(s) sin su campaña en la lista: no se cargan.`);

  // --- Plano ---
  const mesP = r.inicio.slice(0, 7);
  const vigente = planoVigente(ocupacion, mesP);
  const lineas = ocupacion.filter(
    (o) =>
      (o.origen === 'app' || o.plano_mes === vigente) &&
      (o.estatus === 'vendida' || o.estatus === 'pautada') &&
      tocan(o.inicio, o.fin, r.inicio, r.fin),
  );
  const yaEnPauta = new Set<string>();
  /** Nombre → espacios del plano que no están en su Pauta VV. */
  const soloPlano = new Map<string, Set<string>>();
  type SitioPlanoAc = SitioVVAc & { _horasLV: Set<number>; _horasSD: Set<number>; _dias: Set<number> };
  type GrupoPlano = { c: CampanaContrato; medio: 'Columna' | 'Pórtico'; llave: string; sitios: Map<string, SitioPlanoAc> };
  const gPlano = new Map<string, GrupoPlano>();
  for (const o of lineas) {
    const cl = llaveComp(o.campana);
    if (!cl) continue;
    const s = sitioVV(o.espacio_clave);
    if (!s.clave || !s.medio) {
      avisos.push(`Plano: espacio «${o.espacio_clave}» no se reconoce.`);
      continue;
    }
    if (s.edoMex) {
      edoMex.add(s.espacio);
      continue;
    }
    let nombre = o.campana.trim();
    let version = '';
    if (porNombre.has(cl)) {
      if (cubierto.has(`${cl}|${s.espacio}`)) {
        yaEnPauta.add(o.campana.trim());
        continue;
      }
      nombre = nombreDueno.get(cl) ?? nombre;
      const vs = versionesDe.get(cl);
      version = vs && vs.size === 1 ? [...vs.values()][0] : '';
      if (!soloPlano.has(nombre)) soloPlano.set(nombre, new Set());
      soloPlano.get(nombre)!.add(s.espacio);
    }
    const medio = s.medio as 'Columna' | 'Pórtico';
    const llave = `${medio}|${llaveComp(nombre)}|${llaveComp(version)}`;
    let g = gPlano.get(llave);
    if (!g) {
      g = {
        medio,
        llave,
        c: {
          fuente: 'plano',
          origen_ref: o.origen === 'plano' && o.plano_mes ? `plano ${o.plano_mes}` : 'plano app',
          cliente: null,
          campana: nombre,
          version,
          vendedor: null,
          administrador: null,
          quantum: null,
          mediamonitor: null,
          especificacion: null,
          arte: null,
          inicio: null,
          fin: null,
          es_full: /^FULL\b/.test(normTexto(nombre)),
          full_minutos: null,
          analista_email: null,
          sitios: [],
        },
        sitios: new Map(),
      };
      gPlano.set(llave, g);
    }
    g.c.inicio = minF([g.c.inicio, o.inicio]);
    g.c.fin = maxF([g.c.fin, o.fin]);
    const dias = !o.dias || !o.dias.length ? [0, 1, 2, 3, 4, 5, 6] : o.dias;
    let st = g.sitios.get(s.clave);
    if (!st) {
      st = {
        sitio_clave: s.clave,
        sitio_original: o.espacio_clave,
        espacio_vv: s.espacio,
        inicio: o.inicio,
        fin: o.fin,
        horario_lv: null,
        horario_sd: null,
        tipo_venta: o.negociacion === 'VENTA' ? 'VENTA' : o.negociacion === 'BONIFICACION' ? 'BONUS' : null,
        testigos: null,
        observaciones: o.negociacion === 'INTERCAMBIO' ? 'INTERCAMBIO' : null,
        _vig: [[o.inicio, o.fin]],
        _horasLV: new Set(),
        _horasSD: new Set(),
        _dias: new Set(),
      };
      g.sitios.set(s.clave, st);
    } else {
      st.inicio = minF([st.inicio, o.inicio]);
      st.fin = maxF([st.fin, o.fin]);
      st._vig.push([o.inicio, o.fin]);
      if (o.negociacion === 'VENTA') st.tipo_venta = 'VENTA';
    }
    for (const d of dias) {
      st._dias.add(d);
      for (const hh of o.horas) (d < 5 ? st._horasLV : st._horasSD).add(hh);
    }
  }
  const soloDelPlano: Grupo[] = [];
  for (const g of gPlano.values()) {
    const sitios: SitioVVAc[] = [...g.sitios.values()].map(({ _horasLV, _horasSD, _dias, ...s }) => {
      const parciales = [0, 1, 2, 3, 4, 5, 6].filter((d) => !_dias.has(d));
      const soloDias = parciales.length ? `Solo ${[..._dias].sort().map((d) => DIA_CORTO[d]).join(', ')}` : null;
      return {
        ...s,
        horario_lv: _horasLV.size ? franjasTexto([..._horasLV]) : null,
        horario_sd: _horasSD.size ? franjasTexto([..._horasSD]) : null,
        observaciones: [s.observaciones, soloDias].filter(Boolean).join(' · ') || null,
      };
    });
    const destino = grupos.get(g.llave);
    if (destino) {
      // Espacios de una campaña de Pauta VV que solo están en el plano: a su versión.
      for (const s of sitios)
        if (!destino.sitios.has(s.sitio_clave))
          destino.sitios.set(s.sitio_clave, { ...s, observaciones: [s.observaciones, 'SOLO EN EL PLANO'].filter(Boolean).join(' · ') });
      destino.c.inicio = minF([destino.c.inicio, g.c.inicio]);
      destino.c.fin = maxF([destino.c.fin, g.c.fin]);
    } else soloDelPlano.push({ c: g.c, medio: g.medio, sitios: new Map(sitios.map((s) => [s.sitio_clave, s])) });
  }

  for (const g of [...ordenG, ...soloDelPlano]) {
    g.c.sitios = [...g.sitios.values()].map(({ _vig, ...s }) => {
      const a = anotarHuecos(s, _vig);
      if (a) avisos.push(`«${g.c.campana}${g.c.version ? ' / ' + g.c.version : ''}», ${s.espacio_vv}: ${a}.`);
      return s;
    });
    porMedio[g.medio].push(g.c);
  }
  revisarFull(porMedio.Columna, 'Columna', opts.espaciosVV, avisos);

  if (yaEnPauta.size) avisos.push(`${yaEnPauta.size} campaña(s) del plano ya vienen de Pauta VV: se toma lo de Pauta VV (${[...yaEnPauta].slice(0, 6).join(', ')}${yaEnPauta.size > 6 ? '…' : ''}).`);
  for (const [n, esp] of soloPlano)
    avisos.push(`«${n}» tiene espacios que solo están en el plano (${[...esp].join(', ')}): se cargan junto con lo de Pauta VV; conviene capturarlos en Pauta VV.`);
  const nPlano = soloDelPlano.filter((g) => !porNombre.has(llaveComp(g.c.campana))).length;
  if (nPlano) avisos.push(`${nPlano} campaña(s) salen solo del plano: sin versión ni cliente; complétalas si hace falta.`);
  if (edoMex.size) avisos.push(`${edoMex.size} espacio(s) de EDO MEX omitidos (de baja): ${[...edoMex].join(', ')}.`);
  if (ocupacion.length && !vigente && !ocupacion.some((o) => o.origen === 'app')) avisos.push('No hay plano importado para el periodo.');
  return { porMedio, avisos, errores };
}

// ------------------------------------------------------------
// Antes de cargar: comparar con lo que ya está en la base
// ------------------------------------------------------------

/** Una campaña ya cargada en el periodo (comp_campanas + sus comp_sitios de la carga). */
export type CampanaCargada = {
  medio: MedioComp;
  campana: string;
  version: string;
  fuente: FuenteComp;
  origen_ref: string | null;
  /** Solo los sitios de una carga (comp_sitios.origen = 'carga') que no están fuera_de_carga. */
  sitios: SitioContrato[];
};

/**
 * 'reemplazar': la lista nueva manda (lo que no viene se da de baja).
 * 'agregar': se conservan los sitios ya cargados que no vienen.
 * 'auto': agregar si es OTRO archivo u hoja de la bitácora (una
 * «ampliación»); reemplazar si es el mismo archivo, Pauta VV o el plano.
 */
export type ModoCarga = 'auto' | 'agregar' | 'reemplazar';

export type CambioContraCargada = {
  campana: string;
  version: string;
  origen_anterior: string | null;
  modo: 'agregar' | 'reemplazar';
  /** Sitios ya cargados que esta carga no trae: se conservan (agregar) o se dan de baja (reemplazar). */
  sitios_que_no_vienen: string[];
};

const normClave = (s: string) => String(s).trim().toUpperCase();

/**
 * POR QUÉ (revisión del 23-oct-2026). comp_cargar_campanas toma la lista
 * de sitios de cada entrada como la vigente y da de baja lo demás. Si
 * comercial manda una «ampliación» en OTRO archivo con la misma campaña y
 * versión, el segundo archivo borraba los sitios del primero (y al volver a
 * subir el primero, al revés). Esto se corre ANTES de cargar, con lo que ya
 * está en la base, y en modo 'agregar' le suma a cada entrada los sitios
 * ya cargados que no trae (sin tocar el contrato). También avisa cuando una
 * campaña que entró del plano sin versión llega ahora con versión: quedan
 * dos filas y la meta se cuenta dos veces (adoptarla es de la base).
 * No toca `nuevas`.
 */
export function revisarContraCargadas(
  nuevas: CampanaContrato[],
  cargadas: CampanaCargada[],
  medio: MedioComp,
  modo: ModoCarga = 'auto',
): { campanas: CampanaContrato[]; avisos: string[]; cambios: CambioContraCargada[] } {
  const avisos: string[] = [];
  const cambios: CambioContraCargada[] = [];
  const k = (c: { campana: string; version: string }) => `${llaveComp(c.campana)}|${llaveComp(c.version)}`;
  const previas = new Map(cargadas.filter((c) => c.medio === medio).map((c) => [k(c), c]));
  const campanas = nuevas.map((n) => {
    const p = previas.get(k(n));
    if (!p || !n.sitios) return n;
    const vienen = new Set(n.sitios.map((s) => normClave(s.sitio_clave)));
    const faltan = p.sitios.filter((s) => !vienen.has(normClave(s.sitio_clave)));
    if (!faltan.length) return n;
    const mismoOrigen = (p.origen_ref ?? '').trim() === (n.origen_ref ?? '').trim();
    const efectivo: 'agregar' | 'reemplazar' =
      modo !== 'auto' ? modo : n.fuente === 'bitacora' && p.fuente === 'bitacora' && !mismoOrigen ? 'agregar' : 'reemplazar';
    const nombre = `${n.campana}${n.version ? ' / ' + n.version : ''}`;
    const lista = faltan.map((s) => s.espacio_vv || s.sitio_clave);
    const corta = `${lista.slice(0, 8).join(', ')}${lista.length > 8 ? '…' : ''}`;
    cambios.push({ campana: n.campana, version: n.version, origen_anterior: p.origen_ref, modo: efectivo, sitios_que_no_vienen: faltan.map((s) => s.sitio_clave) });
    if (efectivo === 'agregar') {
      avisos.push(`«${nombre}» ya venía de «${p.origen_ref ?? p.fuente}»: se conservan ${faltan.length} sitio(s) que esta carga no trae (${corta}). Si esta carga la sustituye, elige «reemplazar».`);
      return { ...n, sitios: [...n.sitios, ...faltan.map((s) => ({ ...s }))] };
    }
    avisos.push(`«${nombre}»: se darían de baja ${faltan.length} sitio(s) que ya no vienen (${corta}); lo ya comprobado se queda, fuera de carga.`);
    return n;
  });
  // Del plano (versión '') a Pauta VV o la bitácora (con versión): otra llave.
  const llavesNuevas = new Set(nuevas.map(k));
  for (const p of cargadas) {
    if (p.medio !== medio || p.fuente !== 'plano' || llaveComp(p.version) || llavesNuevas.has(k(p))) continue;
    const otras = nuevas.filter((n) => llaveComp(n.campana) === llaveComp(p.campana) && llaveComp(n.version));
    if (otras.length)
      avisos.push(`«${p.campana}» se cargó del plano sin versión y ahora llega con versión (${otras.map((o) => o.version).join(', ')}): queda como otra campaña. Pasa la analista y lo comprobado y cierra la del plano, o la meta se cuenta dos veces.`);
  }
  return { campanas, avisos, cambios };
}

// ------------------------------------------------------------
// Alta manual (Supervisor)
// ------------------------------------------------------------

export type SitioAlta =
  | string
  | {
      clave: string;
      inicio?: string | null;
      fin?: string | null;
      horario_lv?: string | null;
      horario_sd?: string | null;
      tipo_venta?: TipoVenta | null;
      testigos?: boolean | null;
      observaciones?: string | null;
    };

export type AltaManual = {
  unidad: UnidadComp;
  medio: MedioComp;
  campana: string;
  version?: string | null;
  cliente?: string | null;
  vendedor?: string | null;
  administrador?: string | null;
  quantum?: string | null;
  mediamonitor?: boolean | null;
  especificacion?: string | null;
  arte?: 'NUEVO' | 'REPITE' | null;
  inicio?: string | null;
  fin?: string | null;
  /** Horario por omisión para los sitios que no traen el suyo. */
  horario_lv?: string | null;
  horario_sd?: string | null;
  tipo_venta?: TipoVenta | null;
  es_full?: boolean;
  full_minutos?: number | null;
  analista_email?: string | null;
  /** Claves escogidas por modelo, por ruta o a mano (la pantalla las resuelve). */
  sitios: SitioAlta[];
  /** Si se pasa, se avisa lo que no esté en el inventario. */
  inventario?: Iterable<string> | null;
};

const esFecha = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && leerFechaCelda(s) === s;
const limpio = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() || null : null);

/**
 * Alta de una campaña-versión hecha en la app → entrada del contrato.
 * Valida lo que la base también rechazaría (campaña vacía, fechas
 * inválidas o al revés, sitios de otro medio) para avisar ANTES de llamar.
 * Con errores devuelve campana = null. Los sitios repetidos se juntan.
 */
export function armarAlta(a: AltaManual): { campana: CampanaContrato | null; errores: string[]; avisos: string[] } {
  const errores: string[] = [];
  const avisos: string[] = [];
  const nombre = limpio(a.campana);
  if (!nombre) errores.push('Falta el nombre de la campaña.');
  const inicio = a.inicio || null;
  const fin = a.fin || null;
  if (inicio && !esFecha(inicio)) errores.push(`Fecha de inicio no válida: ${inicio}.`);
  if (fin && !esFecha(fin)) errores.push(`Fecha de fin no válida: ${fin}.`);
  if (inicio && fin && fin < inicio) errores.push('La fecha de fin va antes que la de inicio.');
  const inv = a.inventario ? new Set([...a.inventario].map((c) => String(c).trim().toUpperCase())) : null;
  const sitios = new Map<string, SitioContrato & { _vig: Vig[] }>();
  const otroMedio: string[] = [];
  const sinInv: string[] = [];
  for (const x of a.sitios || []) {
    const o = typeof x === 'string' ? { clave: x } : x;
    const k = claveDeSitio(o.clave, a.unidad);
    if (!k.clave) {
      errores.push(`Clave de sitio ilegible: «${o.clave}».`);
      continue;
    }
    if (a.unidad === 'Vía Verde' && k.edoMex) {
      errores.push(`${o.clave} es de EDO MEX (de baja).`);
      continue;
    }
    if (k.medio && k.medio !== a.medio) {
      otroMedio.push(String(o.clave));
      continue;
    }
    const si = 'inicio' in o ? o.inicio || null : null;
    const sf = 'fin' in o ? o.fin || null : null;
    if ((si && !esFecha(si)) || (sf && !esFecha(sf)) || (si && sf && sf < si)) {
      errores.push(`Vigencia no válida en ${k.clave}.`);
      continue;
    }
    if ((si && fin && si > fin) || (sf && inicio && sf < inicio)) avisos.push(`La vigencia de ${k.clave} queda fuera de la campaña.`);
    if (inv && !inv.has(k.clave)) sinInv.push(k.clave);
    const nuevo: SitioContrato & { _vig: Vig[] } = {
      sitio_clave: k.clave,
      sitio_original: String(o.clave).trim(),
      espacio_vv: k.espacioVV,
      inicio: si,
      fin: sf,
      horario_lv: limpio('horario_lv' in o ? o.horario_lv : null) ?? limpio(a.horario_lv),
      horario_sd: limpio('horario_sd' in o ? o.horario_sd : null) ?? limpio(a.horario_sd),
      tipo_venta: ('tipo_venta' in o ? o.tipo_venta : null) ?? a.tipo_venta ?? null,
      testigos: 'testigos' in o ? o.testigos ?? null : null,
      observaciones: limpio('observaciones' in o ? o.observaciones : null),
      _vig: [[si, sf]],
    };
    const previo = sitios.get(k.clave);
    if (!previo) sitios.set(k.clave, nuevo);
    else {
      previo._vig.push([si, sf]);
      juntarSitio(previo, nuevo);
    }
  }
  if (otroMedio.length) errores.push(`${otroMedio.length} sitio(s) no son de ${a.medio}: ${otroMedio.join(', ')}.`);
  if (!sitios.size && !a.es_full) errores.push('Escoge al menos un sitio (o márcala FULL).');
  if (sinInv.length) avisos.push(`${sinInv.length} clave(s) no están en el inventario: ${sinInv.join(', ')}.`);
  for (const h of [a.horario_lv, a.horario_sd]) if (h && !leerHorario(h).entendido) avisos.push(`El horario «${h}» no se entiende; se guarda tal cual.`);
  const email = limpio(a.analista_email)?.toLowerCase() ?? null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errores.push('El correo de la analista no es válido.');
  if (errores.length) return { campana: null, errores, avisos };
  const lista = [...sitios.values()].map(({ _vig, ...s }) => {
    const av = anotarHuecos(s, _vig);
    if (av) avisos.push(`${s.sitio_clave}: ${av}.`);
    return s;
  });
  return {
    campana: {
      fuente: 'manual',
      origen_ref: null,
      cliente: limpio(a.cliente),
      campana: nombre!,
      version: limpio(a.version) ?? '',
      vendedor: limpio(a.vendedor),
      administrador: limpio(a.administrador),
      quantum: limpio(a.quantum),
      mediamonitor: a.mediamonitor ?? null,
      especificacion: limpio(a.especificacion),
      arte: a.arte ?? null,
      inicio,
      fin,
      es_full: !!a.es_full,
      full_minutos: a.es_full && a.full_minutos && a.full_minutos > 0 ? Math.round(a.full_minutos) : null,
      analista_email: email,
      sitios: lista,
    },
    errores,
    avisos,
  };
}

/**
 * «Copiar del periodo anterior» (REPITE): la misma campaña-versión con sus
 * sitios y horarios, en el periodo nuevo. Las vigencias por sitio se quitan
 * (eran del periodo viejo) y la campaña toma las fechas que se le den (por
 * omisión, todo el periodo); la analista que la llevó va como PROPUESTA.
 */
export function repetirCampana(
  anterior: CampanaContrato,
  nuevo: { inicio: string | null; fin: string | null },
): CampanaContrato {
  return {
    ...anterior,
    fuente: 'manual',
    origen_ref: anterior.origen_ref,
    arte: 'REPITE',
    inicio: nuevo.inicio,
    fin: nuevo.fin,
    sitios: anterior.sitios.map((s) => ({ ...s, inicio: null, fin: null })),
  };
}
