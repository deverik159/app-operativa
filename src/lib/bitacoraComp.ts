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
//      Con las bitácoras REALES de Biobox y Ecovallas Digital (Erik,
//      23-oct-2026) el lector es TOLERANTE: busca encabezados y etiquetas
//      por nombre (con variantes y desplazados), deduce por contenido las
//      columnas sin nombre (o la tabla entera si falta su encabezado), lee
//      varias versiones por celda (Biobox «V5, V6, V7») o por columna
//      (Ecovallas «VERSIÓN 1..N», sin la medida pegada), salta las hojas
//      que no son campaña y saca del encabezado el plan sugerido (Biobox
//      «COMPROBACIÓN») y los testigos marcados (Ecovallas). Agregar una
//      variante es agregar un patrón en ENC_TABLA, ETIQUETAS o CLASES.
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
// recortada al periodo. leerBitacora también la recorta al periodo si se
// le pasa (23-oct-2026: Biobox trae campañas de marzo a diciembre), pero
// no inventa fechas: si un sitio no trae vigencia va null y la base usa la
// de la campaña (y si tampoco, la del periodo). Los planes sugeridos van
// FUERA del contrato (ResultadoBitacora.planesSugeridos). OJO: la lista de sitios de cada
// entrada MANDA (lo que no viene se da de baja en la base), por eso aquí
// nada se manda a medias: una lectura incompleta de Pauta VV no carga nada.
//
// ES PURO: sin React ni Supabase. Los libros se leen con hojaDeLibro (lee
// desde A1, con los valores crudos y el texto formateado). Las pruebas
// están en tests/bitacoraComp.test.mjs (con la forma real y nombres
// inventados); la validación con los archivos reales de Pauta VV, Biobox y
// Ecovallas, en scripts locales fuera del repo (el repo es público).
// ============================================================

import { claveEspacio, franjasTexto } from './ocupacionVV';
import { llaveComp, type MedioComp, type PlanTomas, type UnidadComp } from './comprobaciones';
import {
  llaveContrato,
  type CampanaContrato,
  type FuenteComp,
  type PeriodoBit,
  type PlanSugerido,
  type SitioContrato,
  type TipoVenta,
} from './contratoComp';
import {
  buscarEncabezado,
  esSoloMesDia,
  horaExcel,
  leerFechaBitacora,
  leerFechaCelda,
  leerHorario,
  limpiarClave,
  normTexto,
  rellenarCombinadas,
  textoCelda,
  versionSinMedida,
  type CambioClave,
  type Merge,
} from './importadorComp';

// ------------------------------------------------------------
// Contrato de comp_cargar_campanas (23-oct-2026)
// ------------------------------------------------------------
// Los tipos viven en contratoComp.ts (una sola definición); se vuelven a
// exportar aquí para no romper los imports que ya existen.

export type { FuenteComp, TipoVenta, SitioContrato, CampanaContrato, PeriodoBit, PlanSugerido } from './contratoComp';
export { llaveContrato } from './contratoComp';

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
// leerBitacora ya NO junta las vigencias separadas (revisión del
// 23-oct-2026): manda un renglón por tramo del mismo sitio y la base los
// agrupa en comp_sitios.tramos (R10), así el plan no cae en el hueco.
// desdePautaVV y armarAlta todavía los juntan: si el mismo sitio y versión
// vienen del 1 al 5 y del 25 al 31, se manda del 1 al 31 y el hueco va en
// observaciones («SIN AIRE DEL 06/10 AL 24/10»), con aviso. Pasarlos a
// tramos también queda pendiente (el plano de Vía Verde junta por sitio).

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

/** Negociación sin puntuación: 'VENTA.' → 'VENTA', 'VENTA - EXCLUISVA' → 'VENTA EXCLUISVA'. */
const textoNegociacion = (v: unknown) => normTexto(v).replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * 'VENTA' / 'BONUS' / 'BONIFICACIÓN' / 'BONO'; lo demás (INTERCAMBIO, CORTESÍA) → null.
 * Se reconoce el PREFIJO sin puntuación (revisión del 23-oct-2026): Biobox
 * real trae «VENTA.» (39 renglones), «VENTA - EXCLUISVA» (42) y «VENTA
 * EXCLUSIVA» (5), que quedaban sin VENTA. Lo que sigue (EXCLUSIVA) lo pone
 * extraNegociacion en observaciones.
 */
export function leerTipoVenta(v: unknown): TipoVenta | null {
  const t = textoNegociacion(v);
  if (/^VENTAS?\b/.test(t)) return 'VENTA';
  if (/^BON(US|OS?|IFICACION(ES)?|IFICADOS?)\b/.test(t)) return 'BONUS';
  return null;
}

/** Lo que la negociación dice además de VENTA/BONUS y va a observaciones: «EXCLUSIVA» (también mal escrita: EXCLUISVA). */
function extraNegociacion(v: unknown, tipo: TipoVenta | null): string | null {
  if (!tipo) return textoCelda(v);
  return /\bEXCLU/.test(textoNegociacion(v)) ? 'EXCLUSIVA' : null;
}

/**
 * ESTATUS de un renglón que NO se comprueba (revisión del 23-oct-2026: se
 * cargaban como pendientes y contaban en la meta). Los de Pauta VV («Por
 * programar», «Programada», «Cerrada») sí entran, y también los de Ecovallas
 * («SAME PRINT», «NEW PRINT», «REPITE»: dicen si el arte es nuevo).
 */
const ESTATUS_FUERA = /\bCANCELAD[AO]S?\b|\bCANCELACION\b|\bBAJA\b|\bSUSPENDID[AO]S?\b|\bNO SE COMPRUEBAN?\b|\bDETENID[AO]S?\b/;

// ------------------------------------------------------------
// Encabezado de la hoja (arriba de la tabla)
// ------------------------------------------------------------
// Bitácoras REALES (Erik, 23-oct-2026; la forma está en el scratchpad,
// nunca en el repo):
//   · Biobox: etiquetas en la columna C (o B), valor a la derecha:
//     CAMPAÑA: · MES · VENDEDOR: · FECHA INICIO: · ADMINISTRADOR: · FECHA FIN:
//     · CLIENTE: · TIPO DE PAUTA · COMPROBACIÓN: (MENSUAL / CATORCENAL) ·
//     OBSERVACIONES: (cómo van los testigos) · CONTRATO QUANTUM · FECHA DE ENVIO.
//   · Ecovallas Digital: CAMPAÑA(:) · CATORCENA: / CAT · número · TESTIGOS y
//     casillas true/false con el tipo de testigo a su derecha · VENDEDOR: ·
//     FECHA INICIO: · ADMINISTRADOR: · FECHA FIN: · CLIENTE: · UBICACIÓN: / PLAZA:.
// Las etiquetas que no se usan (MES, PLAZA…) se reconocen igual: así nunca
// se toman como el VALOR de otra etiqueta que vino vacía.

type CampoEnc =
  | 'cliente'
  | 'campana'
  | 'vendedor'
  | 'administrador'
  | 'inicio'
  | 'fin'
  | 'mediamonitor'
  | 'quantum'
  | 'especificacion'
  | 'comprobacion'
  | 'notas'
  | 'catorcena';
const OTRA = '_otra';

// Ojo con el orden: FECHA INICIO antes que cualquier «INICIO».
const ETIQUETAS: [CampoEnc | typeof OTRA, RegExp][] = [
  ['cliente', /^(NOMBRE DEL )?CLIENTES?$/],
  ['campana', /^(NOMBRE DE LA )?CAMPANAS?$/],
  ['vendedor', /^(VENDEDOR(A|ES)?|EJECUTIVO COMERCIAL)$/],
  ['administrador', /^(ADMINISTRADOR(A|ES)?|EJECUTIVO|ADMIN)$/],
  ['inicio', /^FECHA (DE )?INICIO$/],
  ['fin', /^FECHA (DE )?(FIN|FINAL|TERMINO)$/],
  ['mediamonitor', /^MEDIA ?MONITOR$/],
  ['quantum', /^(CONTRATO )?QUANTUM$/],
  ['especificacion', /^ESPECIFICACI(ON|ONES)( DE (LAS )?TOMAS)?$/],
  ['comprobacion', /^COMPROBACI(ON|ONES)$/],
  ['notas', /^OBSERVACI(ON|ONES)$/],
  ['catorcena', /^(CATORCENA|CAT)$/],
  [OTRA, /^(MES(ES)?|TIPO DE PAUTA|FECHA DE ENVIO|PLAZA|UBICACION|TESTIGOS|CONTRATOS?)$/],
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
  /** Biobox: «COMPROBACIÓN: MENSUAL / CATORCENAL» → plan sugerido. */
  comprobacion: string | null;
  /** Biobox: «OBSERVACIONES:» del encabezado (cómo van los testigos). */
  notas: string | null;
  /** Ecovallas: «CATORCENA: 21». */
  catorcena: number | null;
  /** Ecovallas: las casillas de TESTIGOS marcadas (true), con su texto. */
  testigos: string[];
};

const esEtiqueta = (v: unknown): CampoEnc | typeof OTRA | null => {
  if (typeof v === 'boolean' || typeof v === 'number') return null;
  const t = normTexto(v).replace(/\s*:$/, '');
  return ETIQUETAS.find(([, re]) => re.test(t))?.[0] ?? null;
};
/** 'CLIENTE: TIENDAS X' → ['cliente', 'TIENDAS X']. */
const etiquetaPegada = (t: string): [CampoEnc, string] | null => {
  const p = t.match(/^([^:]{3,40}):\s*(.+)$/);
  const k = p ? esEtiqueta(p[1]) : null;
  return k && k !== OTRA ? [k, p![2]] : null;
};

const esCasilla = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v;
  const t = normTexto(v);
  return /^(TRUE|VERDADERO)$/.test(t) ? true : /^(FALSE|FALSO)$/.test(t) ? false : null;
};

/**
 * Lee el encabezado de la hoja (filas antes de la tabla). Acepta la
 * etiqueta con su valor a la derecha ('VENDEDOR | Ana | | ADMINISTRADOR |
 * Luis') o en la misma celda ('CLIENTE: TIENDAS X'). `crudos` dice qué
 * etiquetas sí venían (para que un bloque nuevo solo cambie esas).
 */
function leerEncabezadoHoja(
  filas: unknown[][],
  hasta: number,
  refFecha: string | null = null,
): { enc: Encabezado; crudos: Partial<Record<CampoEnc, unknown>> } {
  const crudos: Partial<Record<CampoEnc, unknown>> = {};
  const testigos: string[] = [];
  let filaCampana = -1;
  for (let i = 0; i < hasta; i++) {
    const f = filas[i] || [];
    for (let j = 0; j < f.length; j++) {
      const t = textoCelda(f[j]);
      if (!t) continue;
      const pegada = etiquetaPegada(t);
      if (pegada) {
        if (crudos[pegada[0]] === undefined) crudos[pegada[0]] = pegada[1];
        if (pegada[0] === 'campana' && filaCampana < 0) filaCampana = i;
        continue;
      }
      const k = esEtiqueta(t);
      if (!k) continue;
      if (k === OTRA) {
        // TESTIGOS de Ecovallas: casillas en la columna de al lado (una por
        // fila) y el tipo de testigo más a la derecha. Las marcadas (true)
        // son lo que se pide → especificación de la campaña.
        if (normTexto(t).replace(/\s*:$/, '') === 'TESTIGOS' && esCasilla(f[j + 1]) !== null) {
          for (let r = i; r < hasta; r++) {
            const fr = filas[r] || [];
            const b = esCasilla(fr[j + 1]);
            if (b === null) break;
            if (!b) continue;
            for (let jj = j + 2; jj < fr.length; jj++) {
              const x = textoCelda(fr[jj]);
              if (x) {
                testigos.push(x);
                break;
              }
            }
          }
        }
        continue;
      }
      if (k === 'campana' && filaCampana < 0) filaCampana = i;
      if (crudos[k] !== undefined) continue;
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
  const txt = (k: CampoEnc) => (typeof crudos[k] === 'boolean' ? null : textoCelda(crudos[k]));
  const numCat = (v: unknown) => {
    const n = typeof v === 'number' ? v : /^\d{1,2}$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 27 ? n : null;
  };
  let catorcena = numCat(crudos.catorcena);
  // 'CAMPAÑA: | X | (sin etiqueta) | 21' (Ecovallas): el número suelto de la fila de la campaña.
  if (catorcena === null && crudos.catorcena === undefined && filaCampana >= 0)
    for (const v of filas[filaCampana] || []) if (typeof v === 'number' && (catorcena = numCat(v)) !== null) break;
  // FECHA INICIO / FECHA FIN con leerFechaBitacora (revisión del 23-oct-2026):
  // con leerFechaCelda un «11 SEP» del encabezado no se leía, los renglones
  // «11 SEP» quedaban sin año y el sitio entraba con vigencia null (= todo
  // el periodo en la base). El año sale del otro extremo si es fecha, si no
  // de refFecha (el periodo o el nombre del archivo).
  const fechaEnc = (v: unknown, otro: unknown) => {
    const otroF = leerFechaCelda(otro);
    const base = otroF ?? refFecha;
    return leerFechaBitacora(v, base ? { inicio: base, fin: base } : null).fecha;
  };
  return {
    crudos,
    enc: {
      cliente: txt('cliente'),
      campana: txt('campana'),
      vendedor: txt('vendedor'),
      administrador: txt('administrador'),
      inicio: fechaEnc(crudos.inicio, crudos.fin),
      fin: fechaEnc(crudos.fin, crudos.inicio),
      mediamonitor: leerSiNo(crudos.mediamonitor),
      quantum: txt('quantum'),
      especificacion: txt('especificacion'),
      comprobacion: txt('comprobacion'),
      notas: txt('notas'),
      catorcena,
      testigos,
    },
  };
}

/**
 * «COMPROBACIÓN» del encabezado de Biobox → plan de tomas SUGERIDO (lectura
 * de Claude, 23-oct-2026, por confirmar con Erik/Victor):
 *   · MENSUAL(ES) → «al inicio»: una toma por sitio en el mes, al inicio de
 *     su vigencia dentro del mes (la ventana ya está recortada al periodo);
 *   · CATORCENAL(ES) → «cada 14 días»: una por catorcena desde el inicio de
 *     la vigencia del sitio en el periodo;
 *   · QUINCENAL → cada 15; SEMANAL → cada 7; DIARIA → diario.
 * Lo demás → null (sin sugerencia).
 */
export function planDeComprobacion(t: unknown): { plan: PlanTomas; lectura: string } | null {
  const s = normTexto(t);
  if (!s) return null;
  if (/MENSUAL/.test(s)) return { plan: { tipo: 'inicio' }, lectura: 'mensual: una toma por sitio en el mes, al inicio de su vigencia dentro del mes' };
  if (/CATORCENAL/.test(s))
    return { plan: { tipo: 'cada_n', cada_n: 14 }, lectura: 'catorcenal: una toma por catorcena (cada 14 días desde el inicio de la vigencia del sitio)' };
  if (/QUINCENAL/.test(s)) return { plan: { tipo: 'cada_n', cada_n: 15 }, lectura: 'quincenal: una toma cada 15 días' };
  if (/SEMANAL/.test(s)) return { plan: { tipo: 'cada_n', cada_n: 7 }, lectura: 'semanal: una toma cada 7 días' };
  if (/DIARI/.test(s)) return { plan: { tipo: 'diario' }, lectura: 'diaria: una toma cada día' };
  return null;
}

// ------------------------------------------------------------
// Tabla de pautas
// ------------------------------------------------------------
// Columnas por NOMBRE (la primera que cumple cada patrón; las que no se
// reconocen se ignoran). Variantes de las bitácoras reales (23-oct-2026):
// «ID BIOBOX», «CLAVE», «NEGOCIACIÓN», «HORAS», «C QTM» / «CONTRATO»,
// «VERSIÓN 1 | VERSION 2 | VERISÓN 4», «TOMA DE TESTIGOS», «COMENTARIOS»,
// «HORARIO (3 HORARIOS EN 1 DÍA)», «DIRECCIÓN» en vez de UBICACIÓN.
const ENC_TABLA: Record<string, RegExp> = {
  no: /^(NO\.?|N°|NUM(ERO)?|#|\d{1,3})$/,
  sitio: /^(ID|CLAVE|SITIO|ESPACIO|VENDOR FACE ID|FACE ID)( (DE )?(LA |EL )?(COLUMNA|SITIO|PANTALLA|BIOBOX|MAQUINA|ESPACIO|PORTICO|CARA|UBICACION))?$|^(COLUMNAS?|PORTICOS?|PANTALLAS?|BIOBOX|MAQUINAS?)$/,
  tipo: /^TIPO$/,
  ubicacion: /^(UBICACION(ES)?|DIRECCION)$/,
  medio: /^MEDIOS?$/,
  medidas: /^(MEDIDAS?|PIXELES)$/,
  campana: /^CAMPANAS?$/,
  tipoVenta: /^TIPO \(?VENTA|^VENTA (O|\/) BONUS$|^TIPO DE VENTA$|^NEGOCIACI(ON|ONES)$/,
  version: /^VER(SI|IS)ON(ES)?( ?\d{1,2})?$/,
  inicio: /^(FECHA (DE )?)?INICIO$/,
  fin: /^(FECHA (DE )?)?(FIN|FINAL|TERMINO)$/,
  horarioLV: /^HORARIO (DE )?(L(UNES)? ?(A|-|AL) ?V(IERNES)?|ENTRE SEMANA)$/,
  horarioSD: /^HORARIO (DE )?(S(ABADOS?)? ?(Y|A|-|AL) ?D(OMINGOS?)?|FIN(ES)? DE SEMANA)$/,
  horario: /^(HORARIOS?|HORAS)( \(.*\))?$/,
  testigos: /^(TOMA DE )?TESTIGOS?$/,
  observaciones: /^(OBSERVACI(ON|ONES)|COMENTARIOS?)$/,
  estatus: /^(ESTATUS|STATUS)$/,
  quantum: /^(C\.? ?QTM|CONTRATO( QUANTUM)?|QUANTUM)$/,
};

/** La fila de encabezado de la tabla de pautas (o null). */
const tablaEn = (filas: unknown[][], max: number) =>
  buscarEncabezado(filas, ENC_TABLA, ['sitio', 'version'], max) ||
  buscarEncabezado(filas, ENC_TABLA, ['sitio', 'inicio'], max) ||
  buscarEncabezado(filas, ENC_TABLA, ['sitio', 'horarioLV'], max);

/** ¿Tiene la forma de una clave de inventario (MX_CM_EV_MGP_16_3606, MX_CM_EV_MGV_2-4_3492…)? */
export const esClaveInventario = (c: string) => /^(MX|PE)_[A-Z]{2}_[A-Z]{2}_[0-9A-Z_-]+$/.test(c);

const claveLimpiaDe = (v: unknown) => {
  if (typeof v !== 'string') return null;
  const c = limpiarClave(v).clave;
  return c && esClaveInventario(c) ? c : null;
};

/** 'V5', 'V 12', 'V3A': el código corto de versión de Biobox. */
const VERSION_CORTA = /^V ?\d{1,3}[A-Z]?$/;

/**
 * Las versiones de una celda. Biobox trae VARIAS en una: 'V5, V6, V7',
 * 'V1 Y V2' y, con la marca delante, 'COLGATE V16, V17, V18' o 'P&G V14 Y
 * 15' (→ 'COLGATE V16', 'COLGATE V17'…). Solo se parte una lista de códigos
 * cortos: un nombre de arte con coma ('ARTISTA, OTRA Y OTRA-1440x405') es
 * una sola versión.
 */
export function partirVersiones(t: string): string[] {
  // Separadores repetidos o al final («V33,, V34» y «V5, V6,» en la bitácora
  // real de Biobox, 23-oct-2026) daban una versión falsa con la coma dentro.
  const s = t
    .replace(/\s+/g, ' ')
    .replace(/\s*([,;/&])(?:\s*[,;/&])+\s*/g, '$1 ')
    .replace(/[\s,;/&]+$/, '')
    .trim();
  const m = s.match(/^(.*?)\bV ?(\d{1,3}[A-Z]?)((?:\s*(?:,|;|\/|&|\bY\b)\s*(?:V ?)?\d{1,3}[A-Z]?)+)\s*$/i);
  if (!m) return [s];
  const prefijo = m[1].replace(/[\s,;/-]+$/, '').trim();
  const nums = [m[2], ...m[3].split(/\s*(?:,|;|\/|&|\bY\b)\s*/i).map((x) => x.replace(/^V ?/i, '').trim()).filter(Boolean)];
  return nums.map((n) => `${prefijo ? prefijo + ' ' : ''}V${n.toUpperCase()}`);
}

/** Las columnas de versión: todas las VERSIÓN n y las que las siguen sin nombre (o con solo un número). */
function columnasVersion(fila: unknown[]): number[] {
  const out: number[] = [];
  let racha = false;
  let extra = 0;
  for (let j = 0; j < fila.length; j++) {
    const t = normTexto(fila[j]);
    if (ENC_TABLA.version.test(t)) {
      out.push(j);
      racha = true;
      extra = 0;
    } else if (racha && (!t || /^\d{1,2}$/.test(t)) && extra < 6) {
      out.push(j);
      extra++;
    } else racha = false;
  }
  return out;
}

// Para deducir una columna sin nombre por lo que trae (bitácora real de
// Ecovallas: 'CLAVE | | | NEGOCIACIÓN | | INICIO…'; Biobox: hojas sin la
// fila de encabezado). Una columna es de una clase si al menos el 60% de sus
// celdas con algo la cumplen.
const esFechaValor = (v: unknown) =>
  v instanceof Date ||
  (typeof v === 'number' && v > 30000 && v < 80000) ||
  (typeof v === 'string' && /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})$/.test(v.trim()));
const CLASES: [string, (v: unknown) => boolean][] = [
  ['medio', (v) => /^(MEGA ?PANTALLA|MEGA ?VALLA|PANTALLA( SENCILLA)?|VALLA( SENCILLA)?|LUMINA|LANDMARK\b.*|MURO)$/.test(normTexto(v))],
  ['tipoVenta', (v) => /^(VENTA|BONUS|BONO|BONIFICACION|BONIFICADO|INTERCAMBIO|EXCLUSIVA|CORTESIA)S?\b/.test(textoNegociacion(v))],
  ['horario', (v) => /^24 ?H|^\d{1,2}(:\d{2})? ?(HRS?|AM|PM)? ?(A|-) ?\d/.test(normTexto(v))],
  ['fecha', esFechaValor],
  [
    'version',
    (v) => {
      if (typeof v !== 'string') return false;
      const t = normTexto(v);
      if (VERSION_CORTA.test(t) || partirVersiones(t).length > 1) return true;
      return /\d{3,4} ?[X×] ?\d{3,4}|\.(JPE?G|PNG|MP4)$/.test(t) && /[A-WYZ]{3,}/.test(t.replace(/PX/g, ''));
    },
  ],
  ['testigos', (v) => typeof v === 'string' && /TESTIG|TOMAS?\b/.test(normTexto(v)) && normTexto(v).length > 12],
  ['no', (v) => /^(\d{1,3}|REU.*)$/.test(normTexto(v))],
];

type Columnas = { col: Record<string, number>; versiones: number[]; deducidas: string[] };

/**
 * Completa por contenido las columnas que no traen nombre. `encFila` es la
 * fila de encabezado (null si la hoja no tiene: se deduce todo). Solo mira
 * los renglones cuya clave tiene forma de inventario.
 */
function deducirColumnas(filas: unknown[][], desde: number, encFila: unknown[] | null, base: Record<string, number>): Columnas {
  const col = { ...base };
  const deducidas: string[] = [];
  const muestra: unknown[][] = [];
  for (let i = desde; i < filas.length && muestra.length < 40; i++) {
    const f = filas[i] || [];
    if (i > desde && tablaEn([f], 1)) break;
    if (col.sitio !== undefined && claveLimpiaDe(f[col.sitio])) muestra.push(f);
  }
  if (!muestra.length) return { col, versiones: encFila ? columnasVersion(encFila) : [], deducidas };
  const ancho = Math.max(...muestra.map((f) => f.length));
  const libre = (j: number) => j !== col.sitio && (!encFila || !normTexto(encFila[j])) && !Object.values(col).includes(j);
  const clase: (string | null)[] = [];
  for (let j = 0; j < ancho; j++) {
    clase[j] = null;
    if (!libre(j)) continue;
    const vals = muestra.map((f) => f[j]).filter((v) => v !== null && v !== undefined && String(v).trim() !== '' && typeof v !== 'boolean');
    if (!vals.length) continue;
    for (const [c, ok] of CLASES) {
      if (c === 'no' && j > col.sitio!) continue;
      if (vals.filter(ok).length / vals.length >= 0.6) {
        clase[j] = c;
        break;
      }
    }
  }
  const poner = (campo: string, j: number | undefined) => {
    if (j === undefined || col[campo] !== undefined) return;
    col[campo] = j;
    deducidas.push(campo);
  };
  const fechas = clase.map((c, j) => (c === 'fecha' && j > col.sitio! ? j : -1)).filter((j) => j >= 0);
  if (col.inicio === undefined && col.fin === undefined) {
    poner('inicio', fechas[0]);
    poner('fin', fechas[1]);
  } else if (col.fin === undefined) poner('fin', fechas.find((j) => j > col.inicio!));
  for (const c of ['medio', 'tipoVenta', 'horario', 'testigos', 'no']) poner(c, clase.findIndex((x) => x === c) >= 0 ? clase.indexOf(c) : undefined);
  let versiones = encFila ? columnasVersion(encFila) : [];
  if (!versiones.length) {
    versiones = clase.map((c, j) => (c === 'version' ? j : -1)).filter((j) => j >= 0);
    if (versiones.length) {
      col.version = versiones[0];
      deducidas.push('version');
    }
  }
  return { col, versiones, deducidas };
}

/** Columnas a partir de una fila de encabezado encontrada (con lo que falte deducido). */
function columnasDeEncabezado(filas: unknown[][], fila: number, col: Record<string, number>): Columnas {
  const c = { ...col };
  // «No» solo cuenta a la izquierda de la clave (un «2» suelto más a la derecha es una versión).
  if (c.no !== undefined && c.sitio !== undefined && c.no >= c.sitio) delete c.no;
  return deducirColumnas(filas, fila + 1, filas[fila] || [], c);
}

/**
 * Hoja SIN fila de encabezado de tabla (Biobox real: una hoja trae el
 * encabezado de la campaña y los renglones, pero no la fila «No | ID BIOBOX
 * | …»). Solo si arriba hay etiquetas de campaña y abajo claves con forma de
 * inventario: la columna de la clave es la que más claves trae y lo demás
 * se deduce por contenido.
 */
function inferirTabla(filas: unknown[][]): { fila: number; cols: Columnas } | null {
  let conCampana = false;
  for (let i = 0; i < Math.min(filas.length, 15) && !conCampana; i++)
    conCampana = (filas[i] || []).some((v) => {
      const t = textoCelda(v);
      return !!t && (esEtiqueta(t) === 'campana' || etiquetaPegada(t)?.[0] === 'campana');
    });
  if (!conCampana) return null;
  let primera = -1;
  const votos = new Map<number, number>();
  for (let i = 0; i < Math.min(filas.length, 400); i++) {
    const f = filas[i] || [];
    for (let j = 0; j < f.length; j++)
      if (claveLimpiaDe(f[j])) {
        if (primera < 0) primera = i;
        votos.set(j, (votos.get(j) ?? 0) + 1);
        break;
      }
  }
  if (primera < 0) return null;
  const sitio = [...votos].sort((a, b) => b[1] - a[1])[0][0];
  const cols = deducirColumnas(filas, primera, null, { sitio });
  if (cols.col.inicio === undefined && !cols.versiones.length) return null;
  return { fila: primera - 1, cols: { ...cols, deducidas: ['sitio', ...cols.deducidas] } };
}

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
 * Las bitácoras reales pesan 67-103 MB por las imágenes: la pantalla debe
 * leer el libro con XLSX.read(datos, { cellStyles: false, cellHTML: false })
 * (las imágenes no se cargan en las celdas).
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

/** Un renglón de inventario con su tipo de medio (SELECT vendor_face_id, tipo_medio). */
export type InventarioBit = { clave: string; tipo_medio?: string | null };

export type CtxBitacora = {
  unidad: UnidadComp;
  medio: MedioComp;
  /** Nombre del archivo, para origen_ref y los avisos. */
  archivo?: string | null;
  /**
   * Si viene, lo que no toque el periodo se deja fuera (y se avisa) y la
   * vigencia de cada sitio se RECORTA al periodo (Biobox trae campañas de
   * marzo a diciembre; en la Asignación de octubre va solo octubre).
   */
  periodo?: { inicio: string; fin: string } | null;
  /** Ecovallas: el número de catorcena que se arma; avisa las hojas de otra catorcena. */
  catorcena?: number | null;
  /**
   * vendor_face_id de la unidad (para avisar «sin inventario»); sin esto no
   * se revisa. Con tipo_medio, en Ecovallas Digital lo que no es 'Digital'
   * no entra (con aviso); en Biobox solo se avisa.
   */
  inventario?: Iterable<string | InventarioBit> | null;
  /** Vía Verde: vv_espacios (para omitir inactivas y EDO MEX, como la base, y ver un FULL). */
  espaciosVV?: EspacioVV[] | null;
};

export type DescartadaBit = { hoja: string; fila: number; motivo: string; valor?: string };
export type ClaveCorregida = { hoja: string; fila: number; original: string; clave: string; cambios: CambioClave[] };

/** Cómo quedó cada hoja del libro (para la previa y para validar contra el Excel). */
export type ResumenHoja = {
  nombre: string;
  estado: 'leida' | 'oculta' | 'sin_tabla' | 'vacia';
  campana: string | null;
  cliente: string | null;
  catorcena: number | null;
  comprobacion: string | null;
  /** Ecovallas: casillas de TESTIGOS marcadas. */
  testigos: string[];
  /** Columnas que se dedujeron por contenido (sin nombre en el encabezado). */
  deducidas: string[];
  /** Renglones que entraron (al menos una versión con un sitio). */
  renglones: number;
  descartados: number;
};

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
  /** Cada hoja del libro: leída, oculta, sin tabla o vacía. */
  hojas: ResumenHoja[];
  /**
   * Planes de tomas que propone el encabezado (Biobox «COMPROBACIÓN»), por
   * llaveContrato (campaña|versión). FUERA del contrato: la pantalla los
   * aplica con comp_generar_tomas cuando Victor los confirma.
   */
  planesSugeridos: Record<string, PlanSugerido>;
};

type SitioAc = SitioContrato & { _filas: number[]; _testigosTxt: string | null };
type Acum = CampanaContrato & {
  /** Clave → sus renglones, UNO POR TRAMO de vigencia (ver «Tramos» en leerBitacora). */
  _sitios: Map<string, SitioAc[]>;
  _hojas: Set<string>;
  _quantum: Set<string>;
  _arte: Set<'NUEVO' | 'REPITE'>;
  _plan: PlanSugerido | null;
};

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
  // Por partes y con unir() (revisión del 23-oct-2026): con un Set de textos
  // enteros salía «REUBICACIÓN · INTERCAMBIO · MONITOREO EXTERNO · INTERCAMBIO · …».
  a.observaciones = unir([a.observaciones, b.observaciones].flatMap((x) => (x ? x.split(' · ') : [])));
  return avisos;
}

/** Une textos sin repetir (compara con llaveComp; uno contenido en otro no se repite). */
function unir(xs: (string | null | undefined)[], sep = ' · '): string | null {
  const out: string[] = [];
  for (const x of xs) {
    const t = x?.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const k = llaveComp(t);
    if (out.some((o) => llaveComp(o).includes(k))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (k.includes(llaveComp(out[i]))) out.splice(i, 1);
    out.push(t);
  }
  return out.length ? out.join(sep) : null;
}

/** ESTATUS de Ecovallas → arte: NEW PRINT es arte nuevo; SAME PRINT / REPITE, el mismo. */
const arteDeEstatus = (t: string | null): 'NUEVO' | 'REPITE' | null => {
  const s = normTexto(t);
  // «SAME PRNT» (7 renglones de la bitácora real, 23-oct-2026) es SAME PRINT.
  if (/^NEW PRI?NT$|^NUEVO$/.test(s)) return 'NUEVO';
  if (/^SAME PRI?NT$|^REPITE$/.test(s)) return 'REPITE';
  return null;
};

/**
 * Ecovallas Digital: lo IMPRESO no entra. Manda el tipo_medio del
 * inventario si se pasó; si no, la columna MEDIO (MEGAVALLA, VALLA SENCILLA,
 * ECOVALLA) y, sin MEDIO, el código de la clave (MGV, EVA). En la bitácora
 * real una hoja dice MEGAPANTALLA con claves EVA (que el inventario tiene
 * como Impreso): por eso el inventario va primero.
 */
function impresoEco(medioTxt: string | null, clave: string, tipoMedio: string | undefined): string | null {
  if (tipoMedio) return normTexto(tipoMedio) === 'DIGITAL' ? null : `impreso según inventario (${tipoMedio})`;
  const m = normTexto(medioTxt);
  if (m) return /VALLA/.test(m) ? `impreso (${medioTxt})` : null;
  const cod = clave.match(/^MX_[A-Z]{2}_EV_(MGV|EVA)_/)?.[1];
  return cod ? `impreso (${cod})` : null;
}

/**
 * Junta los tramos del mismo sitio que se tocan o se enciman Y traen
 * exactamente lo mismo (horarios, venta, testigos, observaciones). Solo
 * compacta: la base y ventanasToma ya juntan las ventanas que se tocan, así
 * que el plan no cambia, pero un programmatic diario de Mercado Libre
 * mandaba 63 renglones para 8 pantallas (bitácora real, 23-oct-2026). Lo
 * que trae otra cosa (REUBICACIÓN, otro horario) se queda en su tramo.
 */
function compactarTramos(lista: SitioAc[]): SitioAc[] {
  if (lista.length < 2 || lista.some((s) => !s.inicio || !s.fin)) return lista;
  const igual = (a: SitioAc, b: SitioAc) =>
    a.horario_lv === b.horario_lv &&
    a.horario_sd === b.horario_sd &&
    a.tipo_venta === b.tipo_venta &&
    a.testigos === b.testigos &&
    a.observaciones === b.observaciones &&
    a._testigosTxt === b._testigosTxt;
  const xs = [...lista].sort((a, b) => (a.inicio! < b.inicio! ? -1 : a.inicio! > b.inicio! ? 1 : 0));
  const out: SitioAc[] = [];
  for (const s of xs) {
    const prev = out.find((p) => igual(p, s) && s.inicio! <= sumarDia(p.fin!, 1) && s.fin! >= sumarDia(p.inicio!, -1));
    if (!prev) out.push(s);
    else {
      if (s.fin! > prev.fin!) prev.fin = s.fin;
      prev._filas.push(...s._filas);
    }
  }
  // Vuelve al orden en que llegaron (el primero manda en la base: horario y sitio_original).
  return lista.filter((s) => out.includes(s));
}

/** Códigos de contrato Quantum de un texto ('C560270 - C560270-R1 -- C560270-R2' → {C560270}). */
const contratosDe = (q: string | null | undefined) => new Set(normTexto(q).match(/\bC\d{5,}\b/g) ?? []);

const MESES_NOMBRE = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

/**
 * Fecha de referencia sacada del nombre del archivo ('BITACORA BIOBOX
 * OCTUBRE 2026.xlsx' → '2026-10-01'), para el año de un «11 SEP» cuando no
 * hay periodo. Sin mes, julio: así el año no se corre (ver leerFechaBitacora).
 */
export function fechaDeArchivo(nombre: string | null | undefined): string | null {
  const t = normTexto(nombre);
  const a = t.match(/(?:^|\D)(20\d\d)(?:\D|$)/);
  if (!a) return null;
  const m = MESES_NOMBRE.findIndex((x) => t.includes(x));
  return `${a[1]}-${dos(m >= 0 ? m + 1 : 7)}-01`;
}

/**
 * Lee un libro BITACORA (una hoja por campaña) y devuelve el p_campanas de
 * comp_cargar_campanas: una entrada por campaña-VERSIÓN con sus sitios, más
 * los avisos para la previa. Sirve para la exportación de Pauta VV y para
 * las bitácoras REALES de Biobox y Ecovallas Digital (23-oct-2026). Reglas:
 *   · La tabla se busca por nombre (ID…/CLAVE/VERSION/INICIO/FIN/HORARIO…);
 *     las filas de arriba son el encabezado de la campaña. Una columna sin
 *     nombre se deduce por lo que trae (medio, fechas, versiones…) y una
 *     hoja sin la fila de encabezado de la tabla también (con aviso). Si a
 *     media hoja viene OTRO bloque (sus etiquetas y/o la fila de encabezado
 *     repetida), se lee como bloque nuevo: nunca como pauta.
 *   · Una hoja que no trae tabla con claves (LISTADO DE PANTALLAS, LISTA,
 *     EXCLUSIVAS…) se salta con aviso; las ocultas también.
 *   · Campaña: la del ENCABEZADO de la hoja (hoja = campaña); si no trae, la
 *     columna CAMPAÑA del renglón; si tampoco, el nombre de la hoja (con
 *     aviso). La misma campaña con OTRO cliente va aparte como «CAMPAÑA ·
 *     CLIENTE»; con el mismo cliente, dos hojas se juntan, SALVO que sean
 *     otro contrato (revisión del 23-oct-2026): si el CONTRATO QUANTUM del
 *     encabezado no comparte ningún código con el de la primera hoja, o si
 *     la columna CAMPAÑA de los renglones dice otro nombre (Biobox «BOSQUE
 *     REAL» y «BOSQUE REAL DESIGNO», las dos con CAMPAÑA: BOSQUE REAL) y no
 *     es el mismo contrato, la segunda va aparte con el nombre de la columna
 *     o «CAMPAÑA · hoja». En Biobox las versiones son V1, V2…: juntarlas
 *     mezclaba los artes de dos contratos. Ecovallas no trae el quantum en el
 *     encabezado (va por renglón) y su hoja bonus se sigue juntando.
 *   · Versiones: Biobox trae varias en una celda ('V5, V6, V7') y Ecovallas
 *     varias columnas VERSIÓN 1..N con la medida pegada (versionSinMedida):
 *     el sitio entra en CADA versión. Versión vacía → '' (una sola versión).
 *   · NEGOCIACIÓN: VENTA / BONUS (BONIFICACIÓN), también «VENTA.» o «VENTA -
 *     EXCLUSIVA» (la EXCLUSIVA va a observaciones); INTERCAMBIO, EXCLUSIVA o
 *     CORTESÍA solas van a observaciones. «REU» en la columna No → «REUBICACIÓN».
 *   · Vigencia por sitio (INICIO/FIN), RECORTADA al periodo si se pasa; '-'
 *     en las dos es «sin vigencia» (no entra, con aviso por hoja); FIN antes
 *     de INICIO no entra (con aviso por hoja); un texto '10/13/2026' (mes
 *     primero) se lee mes/día con aviso, y entonces TODA la hoja lee sus
 *     fechas ambiguas mes/día. Si las fechas del renglón no se leen y la
 *     campaña tampoco tiene, el renglón no entra («sin vigencia legible»):
 *     con null la base le daría todo el periodo.
 *   · Horario: Biobox y Ecovallas son 24 horas (Erik, 23-oct-2026): sin
 *     columna o vacío → '24 HRS'. Vía Verde sí va por franjas (L-V y S-D).
 *     Las campañas programáticas de Biobox y Ecovallas que SÍ traen franjas
 *     se guardan tal cual y se avisan (no son 24 horas).
 *   · ESTATUS cancelada / baja / suspendida → no se carga (descartadas).
 *   · Clave de sitio: limpia (claveDeSitio); una celda con varias claves se
 *     parte. Biobox y Ecovallas: lo que no tiene forma de clave de
 *     inventario no entra ('PENDIENTE DE REUBICACIÓN'). Ecovallas: lo impreso
 *     (MEGAVALLA, valla; o tipo_medio del inventario ≠ Digital) no entra,
 *     con aviso; las MX_EM_EV_ (Edo. Méx.) SÍ entran. Vía Verde: '856' →
 *     MX_CM_VV_COL_856; EDO MEX (de baja) y las inactivas se omiten.
 *   · ID 'TODAS' (FULL de Vía Verde): la versión queda es_full, sin ese
 *     renglón como sitio; full_minutos sale del horario si dura menos de 24 h.
 *   · Tramos (revisión del 23-oct-2026): un sitio repetido en la misma
 *     versión se junta (juntarSitio) SOLO si trae la misma vigencia (VENTA y
 *     BONUS el mismo día). Con otra vigencia va como OTRO renglón del mismo
 *     sitio: comp_cargar_campanas los agrupa por (campaña, sitio) y guarda
 *     sus tramos (comp_sitios.tramos, R10), y el plan de tomas solo cae
 *     dentro de ellos. Antes se mandaba un solo renglón del primer al último
 *     día con «SIN AIRE…» en observaciones y las tomas caían en el hueco.
 *     Las observaciones (REUBICACIÓN…) quedan en el tramo que las trae.
 *   · Especificación: ESPECIFICACIONES DE TOMAS, OBSERVACIONES del
 *     encabezado (Biobox), las casillas de TESTIGOS marcadas (Ecovallas) y
 *     la columna TESTIGOS si es la misma en todos los sitios (si no, va en
 *     las observaciones de cada sitio).
 *   · Quantum: el del encabezado o los C QTM / CONTRATO de los renglones.
 *     Arte: NEW PRINT → NUEVO, SAME PRINT / REPITE → REPITE, si todos dicen lo mismo.
 * No se descarta en silencio nada que traiga datos: va a `descartadas`.
 */
export function leerBitacora(libro: { hojas: HojaBitacora[] }, ctx: CtxBitacora): ResultadoBitacora {
  const avisos: string[] = [];
  const descartadas: DescartadaBit[] = [];
  const clavesCorregidas: ClaveCorregida[] = [];
  const hojasIgnoradas: string[] = [];
  const hojas: ResumenHoja[] = [];
  const ocultas: string[] = [];
  const sinTabla: string[] = [];
  const otro = new Map<MedioComp, Set<string>>();
  let inventario: Set<string> | null = null;
  const tipoMedioInv = new Map<string, string>();
  if (ctx.inventario) {
    inventario = new Set();
    for (const x of ctx.inventario) {
      const c = String(typeof x === 'string' ? x : x?.clave ?? '').trim().toUpperCase();
      if (!c) continue;
      inventario.add(c);
      if (typeof x !== 'string' && x?.tipo_medio) tipoMedioInv.set(c, String(x.tipo_medio));
    }
  }
  const espacios = ctx.espaciosVV ? new Map(ctx.espaciosVV.map((e) => [String(e.clave).trim().toUpperCase(), e])) : null;
  const sinInv = new Map<string, { clave: string; hoja: string; filas: number[] }>();
  const edoMex = new Set<string>();
  const inactivas = new Set<string>();
  const porLlave = new Map<string, Acum>();
  const orden: Acum[] = [];
  /** Llave → campaña-versión vista, entre o no (para avisar las que se pierden). */
  const vistas = new Map<string, { nombre: string; campana: string; version: string }>();
  const deOtroMedio = new Set<string>();
  /** Campañas-versión que traían sitios impresos (Ecovallas): si quedan vacías ya se avisó por qué. */
  const deImpresos = new Set<string>();
  /** Llave de la campaña → llave del cliente con que llegó primero. */
  const duenos = new Map<string, string>();
  const renombradas = new Set<string>();
  /** Llave de la campaña → la hoja que la trajo primero, con su contrato (para no juntar dos contratos). */
  const hojaDueno = new Map<string, { hoja: string; contratos: Set<string>; nombreFilas: string | null }>();
  /** `hoja|llave de la campaña` → nombre con que se carga en esa hoja. */
  const nombreEnHoja = new Map<string, string>();
  /** `hoja|motivo` → filas descartadas por la vigencia (FIN antes de INICIO, «-», ilegible). */
  const sinVigencia = new Map<string, { hoja: string; motivo: string; filas: number[] }>();
  /** Campañas de Biobox/Ecovallas con horario por franjas o por día (no son 24 horas). */
  const conFranjas = new Set<string>();
  const porEstatus: string[] = [];
  const impresos = new Map<string, Set<string>>();
  const impresosBiobox = new Set<string>();
  const mesDia = new Set<string>();
  const distintos = new Map<string, { sitios: Set<string>; ej: string }>();
  const fechasMal = new Map<string, { hoja: string; lado: string; texto: string; filas: number[] }>();
  /** Campaña → sus sitios en tramos separados (un aviso por campaña, informativo). */
  const huecos = new Map<string, { sitios: Map<string, string>; versiones: Set<string> }>();
  const deducidasAviso: string[] = [];
  const otraCatorcena: string[] = [];
  let fueraDePeriodo = 0;
  let recortados = 0;
  let sin24 = 0;
  const VV = ctx.unidad === 'Vía Verde';
  const per = ctx.periodo ?? null;
  /** Para el año de una fecha en texto sin año («11 SEP») cuando el encabezado no trae. */
  const refFecha = per?.inicio ?? fechaDeArchivo(ctx.archivo);

  for (const h of libro.hojas) {
    const res: ResumenHoja = {
      nombre: h.nombre,
      estado: 'leida',
      campana: null,
      cliente: null,
      catorcena: null,
      comprobacion: null,
      testigos: [],
      deducidas: [],
      renglones: 0,
      descartados: 0,
    };
    hojas.push(res);
    const descartar = (d: DescartadaBit) => {
      descartadas.push(d);
      res.descartados++;
    };
    const origen = h.origen ?? { r: 0, c: 0 };
    if (h.oculta) {
      res.estado = 'oculta';
      hojasIgnoradas.push(h.nombre);
      // Solo se avisan las ocultas que tocan el periodo (revisión del
      // 23-oct-2026): en CAT 21 de Ecovallas el aviso listaba ocho hojas de
      // catorcenas viejas (CAT 9, 10, 14…) y tapaba los avisos de verdad.
      const fo = rellenarCombinadas(h.filas || [], h.merges, origen);
      const eo = tablaEn(fo, 60);
      if (eo) {
        const co = leerEncabezadoHoja(fo, eo.fila, refFecha).enc;
        const fueraPorFecha = !!per && !!(co.inicio || co.fin) && !tocan(co.inicio, co.fin, per.inicio, per.fin);
        const fueraPorCat = !co.inicio && !co.fin && !!ctx.catorcena && !!co.catorcena && co.catorcena !== ctx.catorcena;
        if (!fueraPorFecha && !fueraPorCat) ocultas.push(h.nombre);
      }
      continue;
    }
    const filas = rellenarCombinadas(h.filas || [], h.merges, origen);
    const textos = h.textos ? rellenarCombinadas(h.textos, h.merges, origen) : null;
    let cols: Columnas;
    let filaEnc: number;
    const enc = tablaEn(filas, 60);
    if (enc) {
      filaEnc = enc.fila;
      cols = columnasDeEncabezado(filas, enc.fila, enc.col);
    } else {
      const inf = inferirTabla(filas);
      if (!inf) {
        if (filas.some((f) => (f || []).some((v) => textoCelda(v)))) {
          res.estado = 'sin_tabla';
          hojasIgnoradas.push(h.nombre);
          sinTabla.push(h.nombre);
        } else res.estado = 'vacia';
        continue;
      }
      filaEnc = inf.fila;
      cols = inf.cols;
    }
    let col = cols.col;
    let versionesCol = cols.versiones;
    const notarDeducidas = (c: Columnas) => {
      for (const d of c.deducidas) if (!res.deducidas.includes(d)) res.deducidas.push(d);
    };
    notarDeducidas(cols);
    // El encabezado de la campaña son las filas ANTES de la tabla (sin la
    // fila de encabezado: sus «CAMPAÑA», «TESTIGOS»… son nombres de columna).
    let cab = leerEncabezadoHoja(filas, enc ? filaEnc : filaEnc + 1, refFecha).enc;
    res.campana = cab.campana;
    res.cliente = cab.cliente;
    res.catorcena = cab.catorcena;
    res.comprobacion = cab.comprobacion;
    res.testigos = cab.testigos;
    if (ctx.catorcena && cab.catorcena && cab.catorcena !== ctx.catorcena) otraCatorcena.push(`${h.nombre} (${cab.catorcena})`);
    const cel = (f: unknown[], k: string) => (col[k] === undefined ? null : f[col[k]]);
    /** Texto como se ve en Excel (si se pasó `textos`); si no, el crudo. */
    const vistoJ = (i: number, f: unknown[], j: number | undefined) =>
      j === undefined ? null : (textos ? textoCelda(textos[i]?.[j]) : null) ?? (typeof f[j] === 'boolean' ? null : textoCelda(f[j]));
    const visto = (i: number, f: unknown[], k: string) => vistoJ(i, f, col[k]);
    const ref = ctx.archivo ? `${ctx.archivo} · ${h.nombre}` : h.nombre;
    const avisoFechasCab = () => {
      if (cab.inicio && cab.fin && cab.fin < cab.inicio) avisos.push(`Hoja «${h.nombre}»: FECHA FIN antes de FECHA INICIO en el encabezado.`);
    };
    avisoFechasCab();
    let campanaDeHoja = false;
    // Pasada previa por la tabla (revisión del 23-oct-2026):
    //  · mesPrimero: si alguna fecha de la hoja SOLO cuadra como mes/día
    //    ('10/13/2026'), toda la hoja escribe el mes primero y las ambiguas
    //    ('11/12/2026') también se leen mes/día;
    //  · nombreFilas: el nombre que trae la columna CAMPAÑA si es el mismo en
    //    todos los renglones con clave (para separar dos contratos que
    //    comparten la CAMPAÑA del encabezado, ver separarPorContrato).
    let mesPrimero = false;
    let nombreFilas: string | null = null;
    {
      const nombres = new Map<string, string>();
      for (let i = filaEnc + 1; i < filas.length; i++) {
        const f = filas[i] || [];
        if (!mesPrimero && (esSoloMesDia(cel(f, 'inicio')) || esSoloMesDia(cel(f, 'fin')))) mesPrimero = true;
        if (col.campana === undefined || !textoCelda(cel(f, 'sitio')) || (!VV && !claveLimpiaDe(cel(f, 'sitio')))) continue;
        const t = visto(i, f, 'campana');
        if (t && !nombres.has(llaveComp(t))) nombres.set(llaveComp(t), t);
      }
      if (nombres.size === 1) nombreFilas = [...nombres.values()][0];
    }
    /**
     * Dos hojas con la misma CAMPAÑA y el mismo cliente se juntan, salvo que
     * sean OTRO contrato (revisión del 23-oct-2026; ver la regla en la
     * documentación de leerBitacora). Se decide una vez por hoja y campaña.
     * La hoja «dueña» de un nombre es la primera con un renglón que ENTRA
     * (reclamarNombre): una hoja vieja, toda fuera del periodo, no le quita
     * el nombre a la que sí se carga.
     */
    const separarPorContrato = (nombre: string): string => {
      const lc = llaveComp(nombre);
      const memo = nombreEnHoja.get(`${h.nombre}|${lc}`);
      if (memo !== undefined) return memo;
      let final = nombre;
      const contratos = contratosDe(cab.quantum);
      const d = hojaDueno.get(lc);
      if (!d) return nombre;
      if (d.hoja !== h.nombre) {
        const ambos = contratos.size > 0 && d.contratos.size > 0;
        const mismoContrato = ambos && [...contratos].some((x) => d.contratos.has(x));
        const otroContrato = ambos && !mismoContrato;
        const otroNombre =
          !mismoContrato && !!nombreFilas && llaveComp(nombreFilas) !== lc && llaveComp(nombreFilas) !== llaveComp(d.nombreFilas ?? nombre)
            ? nombreFilas
            : null;
        if (otroContrato || otroNombre) {
          final = otroNombre ?? `${nombre} · ${h.nombre.trim()}`;
          const ocupado = hojaDueno.get(llaveComp(final));
          if (ocupado && ocupado.hoja !== h.nombre) final = `${nombre} · ${h.nombre.trim()}`;
          const porque = otroContrato
            ? `otro contrato (${[...contratos].join(', ')}; en «${d.hoja}»: ${[...d.contratos].join(', ')})`
            : `otro nombre en la columna CAMPAÑA («${nombreFilas}»)`;
          avisos.push(`«${nombre}» viene también en la hoja «${h.nombre}» con ${porque}: no se junta con «${d.hoja}» y se carga aparte como «${final}».`);
        }
      }
      nombreEnHoja.set(`${h.nombre}|${lc}`, final);
      return final;
    };
    const reclamarNombre = (nombre: string) => {
      if (!hojaDueno.has(llaveComp(nombre))) hojaDueno.set(llaveComp(nombre), { hoja: h.nombre, contratos: contratosDe(cab.quantum), nombreFilas });
    };

    for (let i = filaEnc + 1; i < filas.length; i++) {
      const f = filas[i] || [];
      const fila = i + 1 + origen.r;
      // Otro bloque en la misma hoja (revisión del 23-oct-2026): la fila de
      // encabezado repetida se volvía la campaña «CAMPAÑA / VERSION» con el
      // sitio «IDCOLUMNA». Biobox real repite la fila por semana o por mes.
      const otraTabla = tablaEn([f], 1);
      if (otraTabla) {
        const c2 = columnasDeEncabezado(filas, i, otraTabla.col);
        col = c2.col;
        versionesCol = c2.versiones;
        notarDeducidas(c2);
        continue;
      }
      // Etiquetas del bloque nuevo (CLIENTE, CAMPAÑA, FECHA INICIO…) a la
      // izquierda de la clave: cambian el encabezado de lo que sigue.
      const hastaSitio = col.sitio ?? 0;
      if (f.slice(0, hastaSitio + 1).some((v) => {
        const t = typeof v === 'string' ? textoCelda(v) : null;
        return !!t && (!!esEtiqueta(t) || !!etiquetaPegada(t));
      })) {
        const { enc: e2, crudos } = leerEncabezadoHoja([f], 1, cab.inicio ?? cab.fin ?? refFecha);
        cab = { ...cab };
        for (const k of Object.keys(crudos) as CampoEnc[]) (cab as Record<string, unknown>)[k] = e2[k];
        avisoFechasCab();
        continue;
      }
      const sitioTxt = textoCelda(cel(f, 'sitio'));
      // Versiones del renglón: todas las columnas de versión, cada celda
      // partida ('V5, V6, V7') y, fuera de Vía Verde, sin la medida pegada.
      const versiones: string[] = [];
      {
        const vistos = new Set<string>();
        const cols = versionesCol.length ? versionesCol : col.version !== undefined ? [col.version] : [];
        for (const j of cols) {
          const t = vistoJ(i, f, j);
          if (!t) continue;
          for (const p of partirVersiones(t)) {
            const v = VV ? p : versionSinMedida(p);
            const k = llaveComp(v);
            if (!k || vistos.has(k)) continue;
            vistos.add(k);
            versiones.push(v);
          }
        }
      }
      // Sin fechas en el encabezado, el año de un «11 SEP» sale del periodo
      // (o del nombre del archivo).
      const rango = cab.inicio || cab.fin ? { inicio: cab.inicio, fin: cab.fin } : per ?? (refFecha ? { inicio: refFecha, fin: refFecha } : null);
      const fi = leerFechaBitacora(cel(f, 'inicio'), rango, { mesPrimero });
      const ff = leerFechaBitacora(cel(f, 'fin'), rango, { mesPrimero });
      const conDatos = [versiones.length > 0, fi.fecha || fi.ilegible, ff.fecha || ff.ilegible, textoCelda(cel(f, 'horarioLV')), textoCelda(cel(f, 'horario'))].some(Boolean);
      if (!sitioTxt) {
        if (conDatos) descartar({ hoja: h.nombre, fila, motivo: 'sin clave de sitio' });
        continue;
      }
      // Pies y notas al final de la tabla ('TOTAL 12', 'NOTA: …', 'CROQUIS …'): sin versión ni fechas no son pautas.
      if (!conDatos && (/^(TOTAL(ES)?|NOTAS?)\b/.test(normTexto(sitioTxt)) || (!VV && !claveLimpiaDe(sitioTxt)))) continue;
      const estatus = textoCelda(cel(f, 'estatus'));
      if (estatus && ESTATUS_FUERA.test(normTexto(estatus))) {
        descartar({ hoja: h.nombre, fila, motivo: `estatus «${estatus}»`, valor: sitioTxt });
        porEstatus.push(`${sitioTxt} (${estatus})`);
        continue;
      }

      let campana = cab.campana || visto(i, f, 'campana');
      if (!campana) {
        campana = h.nombre.trim();
        campanaDeHoja = true;
      }
      // La misma campaña con otro cliente: aparte, con el cliente en el nombre.
      // 'PERNOD RICARD' y 'Pernod Ricard México, S.A. de C.V.' son el mismo
      // (bitácora real, 23-oct-2026): uno empieza con el otro.
      {
        const lc = llaveComp(campana);
        const cl = llaveComp(cab.cliente);
        const d = duenos.get(lc);
        if (d === undefined || (!d && cl)) duenos.set(lc, cl);
        else if (d && cl && !d.startsWith(cl) && !cl.startsWith(d)) {
          const nuevo = `${campana} · ${cab.cliente}`;
          if (!renombradas.has(nuevo)) {
            renombradas.add(nuevo);
            avisos.push(`«${campana}» viene también con el cliente ${cab.cliente} (hoja «${h.nombre}»): se carga aparte como «${nuevo}».`);
          }
          campana = nuevo;
        }
      }
      campana = separarPorContrato(campana);
      if (!versiones.length) versiones.push('');
      const llaves = versiones.map((v) => llaveContrato({ campana, version: v }));
      /** Las que quedan sin sitios se avisan; las que solo traían renglones de otro periodo, no. */
      const verVistas = () =>
        versiones.forEach((v, n) => {
          if (!vistas.has(llaves[n])) vistas.set(llaves[n], { nombre: `${campana}${v ? ' / ' + v : ''}`, campana: campana!, version: v });
        });
      /** Descartes por la vigencia: van a `descartadas` y a un aviso por hoja (antes solo a `descartadas`). */
      const sinVig = (motivo: string, valor: string) => {
        descartar({ hoja: h.nombre, fila, motivo, valor });
        const g = sinVigencia.get(`${h.nombre}|${motivo}`) ?? { hoja: h.nombre, motivo, filas: [] };
        g.filas.push(fila);
        sinVigencia.set(`${h.nombre}|${motivo}`, g);
      };

      if (fi.guion && ff.guion) {
        verVistas();
        sinVig('sin vigencia (INICIO y FIN «-»)', sitioTxt);
        continue;
      }
      let inicio = fi.fecha;
      let fin = ff.fecha;
      if (fi.mesDia || ff.mesDia) mesDia.add(h.nombre);
      // Fechas que no se leen y la campaña tampoco tiene (revisión del
      // 23-oct-2026): con null la base le daba TODO el periodo a un renglón
      // que podía ser de otro mes. No entra.
      if ((fi.ilegible || ff.ilegible) && !(inicio ?? cab.inicio) && !(fin ?? cab.fin)) {
        verVistas();
        sinVig('sin vigencia legible (ni el renglón ni la campaña)', `${textoCelda(cel(f, 'inicio')) ?? '?'} → ${textoCelda(cel(f, 'fin')) ?? '?'}`);
        continue;
      }
      // Agrupado por hoja y texto: la bitácora real trae 58 renglones con
      // «13/10/0206» en una sola hoja (23-oct-2026).
      for (const [lado, fx, k] of [['INICIO', fi, 'inicio'], ['FIN', ff, 'fin']] as const) {
        if (!fx.ilegible) continue;
        const kk = `${h.nombre}|${lado}|${textoCelda(cel(f, k))}`;
        const g = fechasMal.get(kk) ?? { hoja: h.nombre, lado, texto: textoCelda(cel(f, k)) ?? '', filas: [] };
        g.filas.push(fila);
        fechasMal.set(kk, g);
      }
      if (inicio && fin && fin < inicio) {
        verVistas();
        sinVig('FIN antes de INICIO', `${inicio} → ${fin}`);
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
      let horarioLV = (col.horarioLV !== undefined ? leerHz('horarioLV') : null) ?? hUnico;
      let horarioSD = (col.horarioSD !== undefined ? leerHz('horarioSD') : null) ?? hUnico;
      // Biobox y Ecovallas no van por franjas: todo es 24 horas (Erik, 23-oct-2026).
      if (!VV && !horarioLV && !horarioSD) {
        horarioLV = horarioSD = '24 HRS';
        sin24++;
      }
      const tvTxt = textoCelda(cel(f, 'tipoVenta'));
      const tipoVenta = leerTipoVenta(tvTxt);
      const obsTxt = textoCelda(cel(f, 'observaciones'));
      const reu = col.no !== undefined && /^REU/.test(normTexto(cel(f, 'no')));
      const observaciones = unir([reu ? 'REUBICACIÓN' : null, extraNegociacion(tvTxt, tipoVenta), obsTxt]);
      // TESTIGOS: SI/NO, o (Biobox) la instrucción de cómo van los testigos.
      const testigosCel = cel(f, 'testigos');
      let testigos = leerSiNo(testigosCel);
      let testigosTxt: string | null = null;
      if (testigos === null && typeof testigosCel === 'string' && textoCelda(testigosCel)) {
        testigosTxt = textoCelda(testigosCel);
        testigos = !/^NO\b/.test(normTexto(testigosTxt));
      }

      if (per && !tocan(inicio ?? cab.inicio, fin ?? cab.fin, per.inicio, per.fin)) {
        fueraDePeriodo++;
        descartar({ hoja: h.nombre, fila, motivo: 'fuera del periodo', valor: `${inicio ?? cab.inicio ?? '?'} → ${fin ?? cab.fin ?? '?'}` });
        continue;
      }
      verVistas();
      reclamarNombre(campana);
      // Programáticas de Biobox/Ecovallas con franjas (revisión del
      // 23-oct-2026): no son 24 horas; se guardan tal cual y se avisan.
      if (!VV && [horarioLV, horarioSD].some((x) => x && !['24h', 'sin'].includes(leerHorario(x).tipo))) conFranjas.add(campana);
      // La vigencia de cada sitio, recortada al periodo (la base también lo
      // hace al generar tomas; así la Asignación y los avisos ya cuadran).
      if (per) {
        let r = false;
        if (inicio && inicio < per.inicio) [inicio, r] = [per.inicio, true];
        if (fin && fin > per.fin) [fin, r] = [per.fin, true];
        if (r) recortados++;
      }
      const recorta = (x: string | null, lado: 'i' | 'f') => (!x || !per ? x : lado === 'i' ? (x < per.inicio ? per.inicio : x) : x > per.fin ? per.fin : x);
      const cabIni = recorta(cab.inicio, 'i');
      const cabFin = recorta(cab.fin, 'f');
      const quantumFila = textoCelda(cel(f, 'quantum'));
      const arte = arteDeEstatus(estatus);
      const medioTxt = textoCelda(cel(f, 'medio'));

      // La campaña-versión se crea con su PRIMER sitio aceptado: una versión
      // que solo trae sitios del otro medio (o descartados) no entra vacía.
      // La vigencia de la versión es la de sus renglones aceptados (la del
      // encabezado si el renglón no trae).
      const sugerido = cab.comprobacion ? planDeComprobacion(cab.comprobacion) : null;
      const obtener = (llave: string, version: string): Acum => {
        let c = porLlave.get(llave);
        const nombreCV = `${campana}${version ? ' / ' + version : ''}`;
        if (!c) {
          c = {
            fuente: 'bitacora',
            origen_ref: ref,
            cliente: cab.cliente,
            campana: campana!,
            version,
            vendedor: cab.vendedor,
            administrador: cab.administrador,
            quantum: cab.quantum,
            mediamonitor: cab.mediamonitor,
            especificacion: unir([
              cab.especificacion,
              cab.notas,
              cab.testigos.length ? `TESTIGOS: ${cab.testigos.join(' / ')}` : null,
            ]),
            arte: null,
            inicio: null,
            fin: null,
            es_full: /^FULL\b/.test(normTexto(campana)),
            full_minutos: null,
            analista_email: null,
            sitios: [],
            _sitios: new Map(),
            _hojas: new Set([h.nombre]),
            _quantum: new Set(),
            _arte: new Set(),
            _plan: sugerido
              ? { plan: sugerido.plan, comprobacion: cab.comprobacion!, lectura: sugerido.lectura, hojas: [h.nombre], porConfirmar: true }
              : null,
          };
          porLlave.set(llave, c);
          orden.push(c);
        } else if (!c._hojas.has(h.nombre)) {
          if (c._hojas.size === 1) avisos.push(`«${nombreCV}» viene en más de una hoja (${[...c._hojas][0]}, ${h.nombre}): se juntan sus sitios.`);
          c._hojas.add(h.nombre);
          if (sugerido && !c._plan)
            c._plan = { plan: sugerido.plan, comprobacion: cab.comprobacion!, lectura: sugerido.lectura, hojas: [h.nombre], porConfirmar: true };
          else if (sugerido && c._plan && JSON.stringify(c._plan.plan) !== JSON.stringify(sugerido.plan))
            avisos.push(`«${nombreCV}»: la hoja «${h.nombre}» pide comprobación «${cab.comprobacion}» y otra hoja «${c._plan.comprobacion}»; se sugiere la primera.`);
          else if (c._plan && !c._plan.hojas.includes(h.nombre)) c._plan.hojas.push(h.nombre);
        }
        c.inicio = minF([c.inicio, inicio ?? cabIni]);
        c.fin = maxF([c.fin, fin ?? cabFin]);
        if (quantumFila) c._quantum.add(quantumFila);
        if (arte) c._arte.add(arte);
        return c;
      };

      // FULL «TODAS»: todas las columnas; las agrega quien lleva la campaña.
      // En Vía Verde el FULL es de columnas (así viene en el formato GENERAL).
      if (llaveComp(sitioTxt) === 'TODAS') {
        versiones.forEach((version, n) => {
          const llave = llaves[n];
          if (VV && ctx.medio !== 'Columna') {
            // Es de la otra llamada (Columna): no es una campaña «perdida».
            deOtroMedio.add(llave);
            if (!otro.has('Columna')) otro.set('Columna', new Set());
            otro.get('Columna')!.add(`TODAS|${llave}`);
            return;
          }
          const c = obtener(llave, version);
          c.es_full = true;
          const min = leerHorario(horarioLV ?? horarioSD).minutos;
          if (min && min < 1440) c.full_minutos = Math.max(c.full_minutos ?? 0, min);
        });
        res.renglones++;
        continue;
      }

      let entro = false;
      const partes = partirClaves(sitioTxt);
      for (const parte of partes) {
        // Una sola clave: al limpiador va la celda cruda (los espacios de más se avisan).
        const k = claveDeSitio(partes.length === 1 ? cel(f, 'sitio') : parte, ctx.unidad);
        if (!k.clave) {
          descartar({ hoja: h.nombre, fila, motivo: VV ? 'clave de Vía Verde ilegible (ni columna ni pórtico)' : 'clave de sitio ilegible', valor: parte });
          continue;
        }
        // La omisión de EDO MEX es SOLO de Vía Verde (MX_EM_VV_). En
        // Ecovallas las MX_EM_EV_ son pantallas activas y entran.
        if (VV && k.edoMex) {
          edoMex.add(k.espacioVV || k.clave);
          descartar({ hoja: h.nombre, fila, motivo: 'EDO MEX (de baja)', valor: parte });
          continue;
        }
        if (VV && espacios && k.espacioVV) {
          const e = espacios.get(k.espacioVV.toUpperCase());
          if (e && (!e.activo || /^EDO MEX/i.test(e.tramo || ''))) {
            (e.activo ? edoMex : inactivas).add(k.espacioVV);
            descartar({ hoja: h.nombre, fila, motivo: e.activo ? 'EDO MEX (de baja)' : 'espacio inactivo en vv_espacios', valor: parte });
            continue;
          }
        }
        if (!esClaveInventario(k.clave)) {
          // Biobox y Ecovallas: 'PENDIENTE DE REUBICACIÓN' o una dirección no es un sitio.
          if (!VV || (!versiones.some(Boolean) && !inicio && !fin)) {
            descartar({ hoja: h.nombre, fila, motivo: VV ? 'no parece un sitio (sin versión ni fechas)' : 'no es una clave de inventario', valor: parte });
            continue;
          }
        }
        if (k.medio && k.medio !== ctx.medio) {
          if (!otro.has(k.medio)) otro.set(k.medio, new Set());
          otro.get(k.medio)!.add(k.clave);
          for (const l of llaves) deOtroMedio.add(l);
          continue;
        }
        // Ecovallas Digital: lo impreso (MEGAVALLA, valla) no se comprueba aquí.
        const tm = tipoMedioInv.get(k.clave);
        const impreso = ctx.unidad === 'Ecovallas' ? impresoEco(medioTxt, k.clave, tm) : null;
        if (impreso) {
          descartar({ hoja: h.nombre, fila, motivo: impreso, valor: parte });
          for (const l of llaves) deImpresos.add(l);
          const etq = normTexto(medioTxt) || k.clave.split('_')[3] || 'IMPRESO';
          if (!impresos.has(etq)) impresos.set(etq, new Set());
          impresos.get(etq)!.add(k.clave);
          continue;
        }
        if (ctx.unidad === 'Biobox' && tm && normTexto(tm) !== 'DIGITAL') impresosBiobox.add(k.clave);
        if (k.cambios.length || (k.clave !== parte && !VV))
          clavesCorregidas.push({ hoja: h.nombre, fila, original: parte, clave: k.clave, cambios: k.cambios });
        if (!esClaveInventario(k.clave))
          avisos.push(`Hoja «${h.nombre}» fila ${fila}: «${parte}» no tiene forma de clave de inventario; revísala.`);
        // Misma regla que la base: solo el inventario dice «sin inventario».
        if (inventario && !inventario.has(k.clave)) {
          const s = sinInv.get(k.clave) || { clave: k.clave, hoja: h.nombre, filas: [] };
          if (!s.filas.includes(fila)) s.filas.push(fila);
          sinInv.set(k.clave, s);
        }
        versiones.forEach((version, n) => {
          const nuevo: SitioAc = {
            sitio_clave: k.clave!,
            sitio_original: parte,
            espacio_vv: k.espacioVV,
            inicio,
            fin,
            horario_lv: horarioLV,
            horario_sd: horarioSD,
            tipo_venta: tipoVenta,
            testigos,
            observaciones,
            _filas: [fila],
            _testigosTxt: testigosTxt,
          };
          const c = obtener(llaves[n], version);
          // Tramos: solo se junta con el renglón de la MISMA vigencia; con
          // otra vigencia va como otro tramo del mismo sitio (la base guarda
          // comp_sitios.tramos y el plan no cae en el hueco).
          const lista = c._sitios.get(k.clave!) ?? [];
          if (!lista.length) c._sitios.set(k.clave!, lista);
          const previo = lista.find((s) => s.inicio === inicio && s.fin === fin);
          if (!previo) lista.push(nuevo);
          else {
            previo._filas.push(fila);
            previo._testigosTxt = unir([previo._testigosTxt, testigosTxt]);
            const nombreCV = `${campana}${version ? ' / ' + version : ''}`;
            for (const a of juntarSitio(previo, nuevo)) {
              // Agrupado por campaña-versión: un programmatic con 3 horarios
              // por día daba cientos de avisos iguales (bitácora real).
              const g = distintos.get(nombreCV) ?? { sitios: new Set<string>(), ej: a };
              g.sitios.add(k.clave!);
              distintos.set(nombreCV, g);
            }
          }
        });
        entro = true;
      }
      if (entro) res.renglones++;
    }
    if (campanaDeHoja) avisos.push(`Hoja «${h.nombre}»: sin nombre de campaña; se usa el nombre de la hoja.`);
    const importan = res.deducidas.filter((d) => d !== 'medio');
    if (importan.length) deducidasAviso.push(`${h.nombre} (${importan.join(', ')})`);
  }

  const planesSugeridos: Record<string, PlanSugerido> = {};
  const campanas: CampanaContrato[] = orden.map(({ _sitios, _hojas, _quantum, _arte, _plan, ...c }) => {
    for (const [clave, lista] of _sitios) _sitios.set(clave, compactarTramos(lista));
    // Un renglón por tramo: el mismo sitio puede venir varias veces (la base los agrupa).
    const sitios = [..._sitios.values()].flat();
    // TESTIGOS de la tabla: si todos los sitios dicen lo mismo, es de la
    // campaña (especificación); si no, va en las observaciones de cada sitio.
    const txts = new Set(sitios.map((s) => llaveComp(s._testigosTxt)).filter(Boolean));
    const especificacion = txts.size === 1 ? unir([c.especificacion, sitios.find((s) => s._testigosTxt)!._testigosTxt]) : c.especificacion;
    if (_plan) planesSugeridos[llaveContrato(c)] = _plan;
    const nombreCV = `${c.campana}${c.version ? ' / ' + c.version : ''}`;
    for (const [clave, lista] of _sitios) {
      if (lista.length < 2) continue;
      // La base guarda UN horario por sitio (el del primer tramo): si los
      // tramos traen otro, se avisa (Mercado Libre programmatic por semana).
      for (const [lado, campo] of [['L-V', 'horario_lv'], ['S-D', 'horario_sd']] as const) {
        const hs = [...new Map(lista.filter((s) => s[campo]).map((s) => [llaveComp(s[campo]), s[campo]!])).values()];
        if (hs.length < 2) continue;
        const g = distintos.get(nombreCV) ?? { sitios: new Set<string>(), ej: `horario ${lado} distinto por tramo («${hs[1]}»): la base guarda «${hs[0]}»` };
        g.sitios.add(clave);
        distintos.set(nombreCV, g);
      }
      // Aviso informativo: los tramos separados ya no se juntan.
      const h = huecosVigencia(lista.map((s) => [s.inicio, s.fin] as Vig));
      if (!h.length) continue;
      const g = huecos.get(c.campana) ?? { sitios: new Map<string, string>(), versiones: new Set<string>() };
      if (!g.sitios.has(clave)) g.sitios.set(clave, notaHuecos(h));
      if (c.version) g.versiones.add(c.version);
      huecos.set(c.campana, g);
    }
    return {
      ...c,
      especificacion,
      quantum: c.quantum ?? (_quantum.size ? [..._quantum].join(' -- ') : null),
      arte: _arte.size === 1 ? [..._arte][0] : null,
      sitios: sitios.map(({ _filas, _testigosTxt, ...s }) => {
        if (txts.size > 1 && _testigosTxt) s.observaciones = unir([s.observaciones, _testigosTxt]);
        return s;
      }),
    };
  });
  for (const [campana, g] of huecos) {
    const vs = [...g.versiones];
    const quien = vs.length > 1 ? ` (${vs.length} versiones: ${vs.slice(0, 4).join(', ')}${vs.length > 4 ? '…' : ''})` : vs.length ? ` / ${vs[0]}` : '';
    const ej = [...g.sitios].slice(0, 4).map(([s, n]) => `${s} ${n}`).join('; ');
    avisos.push(
      `«${campana}»${quien}: ${g.sitios.size} sitio(s) corren en tramos separados (${ej}${g.sitios.size > 4 ? '…' : ''}): van por tramo y las tomas solo caen dentro de cada tramo.`,
    );
  }
  for (const [n, g] of distintos)
    avisos.push(`«${n}»: ${g.sitios.size} sitio(s) vienen en varios renglones con datos distintos (${g.ej}); revisa sus tomas.`);
  if (VV) revisarFull(campanas, ctx.medio, ctx.espaciosVV, avisos);
  for (const c of campanas)
    if (c.es_full && !c.sitios.length)
      avisos.push(`«${c.campana}${c.version ? ' / ' + c.version : ''}» es FULL sin sitios: las columnas se agregan en la app.`);
  if (porEstatus.length)
    avisos.push(`${porEstatus.length} renglón(es) con ESTATUS de cancelación, baja o suspensión: no se cargan (${porEstatus.slice(0, 8).join(', ')}${porEstatus.length > 8 ? '…' : ''}).`);
  // La versión '' de una campaña que SÍ entró con otra versión no se perdió:
  // es un renglón sin versión ni clave («PENDIENTE DE REUBICACIÓN») que ya
  // fue a descartadas (revisión del 23-oct-2026, aviso falso en FOOD & WINE OCT).
  const cargadas = new Set(orden.map((c) => llaveComp(c.campana)));
  const perdidas = [...vistas]
    .filter(([l, v]) => !porLlave.has(l) && !deOtroMedio.has(l) && !deImpresos.has(l) && !(!llaveComp(v.version) && cargadas.has(llaveComp(v.campana))))
    .map(([, v]) => v.nombre);
  if (perdidas.length) avisos.push(`${perdidas.length} campaña(s)-versión quedaron sin sitios válidos y no se cargan: ${perdidas.slice(0, 12).join(', ')}${perdidas.length > 12 ? '…' : ''}.`);
  if (edoMex.size) avisos.push(`${edoMex.size} sitio(s) de EDO MEX omitidos (de baja): ${[...edoMex].join(', ')}.`);
  if (inactivas.size) avisos.push(`${inactivas.size} espacio(s) inactivos omitidos: ${[...inactivas].join(', ')}.`);
  if (fueraDePeriodo) avisos.push(`${fueraDePeriodo} renglón(es) fuera del periodo: no se cargan.`);
  if (recortados) avisos.push(`${recortados} renglón(es) con vigencia más larga que el periodo: se recorta al periodo.`);
  if (sin24) avisos.push(`${sin24} renglón(es) sin horario: van como 24 HRS (Biobox y Ecovallas son 24 horas).`);
  if (conFranjas.size)
    avisos.push(
      `${conFranjas.size} campaña(s) traen horario por franjas o por día (no son 24 horas; se guarda tal cual y la toma debe caer en ese horario): ${[...conFranjas].slice(0, 8).join(', ')}${conFranjas.size > 8 ? '…' : ''}.`,
    );
  for (const g of sinVigencia.values())
    avisos.push(`Hoja «${g.hoja}» ${g.filas.length > 1 ? 'filas' : 'fila'} ${g.filas.slice(0, 8).join(', ')}${g.filas.length > 8 ? '…' : ''}: ${g.motivo}; no se cargan.`);
  for (const g of fechasMal.values())
    avisos.push(`Hoja «${g.hoja}» ${g.filas.length > 1 ? 'filas' : 'fila'} ${g.filas.slice(0, 6).join(', ')}${g.filas.length > 6 ? '…' : ''}: ${g.lado} «${g.texto}» no es fecha; se toma la de la campaña.`);
  if (mesDia.size) avisos.push(`Fechas escritas con el mes primero (10/13/2026) en: ${[...mesDia].join(', ')}; se leyeron mes/día, revísalas.`);
  for (const [medio, cs] of impresos)
    avisos.push(`${cs.size} sitio(s) ${medio} son impresos y no entran a Ecovallas Digital: ${[...cs].slice(0, 8).join(', ')}${cs.size > 8 ? '…' : ''}.`);
  if (impresosBiobox.size) avisos.push(`${impresosBiobox.size} máquina(s) son Impreso en el inventario (entran; revisa): ${[...impresosBiobox].join(', ')}.`);
  const otroMedio = [...otro].map(([medio, s]) => ({ medio, sitios: s.size }));
  for (const o of otroMedio) avisos.push(`${o.sitios} sitio(s) son de ${o.medio}: se cargan aparte, eligiendo ese medio.`);
  const sinInventario = [...sinInv.values()];
  if (sinInventario.length)
    avisos.push(`${sinInventario.length} clave(s) no están en el inventario (entran, marcadas para revisar): ${sinInventario.map((s) => s.clave).join(', ')}.`);
  if (clavesCorregidas.length) avisos.push(`${clavesCorregidas.length} clave(s) se limpiaron (espacios, ceros, texto pegado).`);
  if (deducidasAviso.length) avisos.push(`Columnas sin nombre deducidas por su contenido: ${deducidasAviso.join('; ')}. Revisa la previa.`);
  if (otraCatorcena.length) avisos.push(`Hojas de OTRA catorcena (se leen; el periodo decide qué entra): ${otraCatorcena.join(', ')}.`);
  if (ocultas.length) avisos.push(`Hojas OCULTAS con tabla de pautas (no se leen; si van, muéstralas en Excel y vuelve a subir el libro): ${ocultas.join(', ')}.`);
  if (sinTabla.length) avisos.push(`Hojas que no son campaña, sin tabla de bitácora (no se leen): ${sinTabla.join(', ')}.`);
  const nPlanes = Object.keys(planesSugeridos).length;
  if (nPlanes)
    avisos.push(`${nPlanes} campaña(s)-versión traen COMPROBACIÓN en el encabezado: se sugiere su plan de tomas (por confirmar).`);
  if (!campanas.length && !otroMedio.length) avisos.push('El libro no trae campañas: revisa que sea la bitácora (tabla ID / VERSION / INICIO / FIN / HORARIO).');
  // Sin repetir (el mismo aviso de L-V y de S-D, por ejemplo).
  return {
    campanas,
    avisos: [...new Set(avisos)],
    descartadas,
    clavesCorregidas,
    sinInventario,
    otroMedio,
    hojasIgnoradas,
    hojas,
    planesSugeridos,
  };
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
/** Inicio del aviso de plano de otro mes (la pantalla lo pone como banner). */
export const AVISO_PLANO_OTRO_MES = 'El plano más reciente es de ';

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
  // El plano de un mes ANTERIOR se usa como foto completa del periodo: se
  // dice, porque lo vendido después de ese plano no está (revisión 2,
  // punta-a-punta-7). Va primero para que se vea.
  if (vigente && vigente !== mesP)
    avisos.unshift(
      `${AVISO_PLANO_OTRO_MES}${vigente} y el periodo es de ${mesP}: solo entran sus líneas que siguen vigentes, y lo vendido después de ese plano no está. Puede estar incompleto; importa el plano de ${mesP} si ya existe.`
    );
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
