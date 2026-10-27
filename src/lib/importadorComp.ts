// ============================================================
// src/lib/importadorComp.ts
// Utilidades para leer los Excel de Comprobaciones (fase 2).
//
// QUÉ QUEDÓ (rediseño de Erik, 23-oct-2026). Este archivo empezó como el
// lector de los Excel de comprobaciones de hoy (Formato general, Asignación
// de clientes, Especificación). Erik aclaró que la idea NO es que el Supervisor suba
// esos Excel ya llenos, sino que los ARME desde la app; ese lector salió
// (queda en la historia de la rama si algún día se quiere migrar algo
// viejo). Lo que se queda son las piezas para leer celdas sucias, que usa
// el lector de la BITÁCORA comercial (bitacoraComp.ts) y que sirven a
// cualquier otro Excel del módulo:
//   · textoCelda / normTexto: texto visible, sin errores (#N/A) ni espacios;
//   · buscarEncabezado: la fila y las columnas por NOMBRE, no por posición;
//   · leerFechaCelda: Date, serial, 'dd/mm/aa', 'AAAA-MM-DD', '01/08(26';
//   · limpiarClave: claves de sitio con espacios, ceros de más o de menos,
//     texto pegado, pórticos 'POR_0008' y EDO MEX;
//   · leerHorario: '24 HRS', '7 a 9 am / 18 a 20 hrs', '02:00 - 09:59HRS'…;
//     horaExcel: una hora tecleada como hora de Excel (0.2916 → '07:00');
//   · leerObservacion: ventana, fecha límite y banderas de un texto libre;
//   · leerFechaBitacora: lo mismo más '10/13/2026' (mes primero), '17 SEP'
//     y '-' (sin fecha) de las bitácoras reales (23-oct-2026);
//   · versionSinMedida, separarEntrega, rellenarCombinadas.
//
// ES PURA: sin React ni Supabase. Recibe lo que da
//   XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true })
// Las fechas NUNCA se leen de la celda cruda: SheetJS 0.20.3 la deja a
// medianoche UTC (en CDMX, el día anterior); sheet_to_json la pasa a la
// hora local y aFecha usa getters locales.
// ============================================================

import { aFecha } from './ocupacionVV';
import { llaveComp } from './comprobaciones';

export type CambioClave = 'espacios' | 'ceros' | 'texto_pegado' | 'alias_portico' | 'prefijo';
export type TipoHorario = '24h' | 'franjas' | 'programmatic' | 'por_fecha' | 'sin';
export type Merge = { s: { r: number; c: number }; e: { r: number; c: number } };

// ------------------------------------------------------------
// Texto
// ------------------------------------------------------------

const ERROR_CELDA = /^#(N\/A|REF!|NAME\?|VALUE!|DIV\/0!|NUM!|NULL!|SPILL!|CALC!)$/i;

/** Texto visible de una celda: sin espacios de más; vacía o con error (#N/A) → null. */
export function textoCelda(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return aFecha(v);
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s || ERROR_CELDA.test(s)) return null;
  return s;
}

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Para buscar patrones: sin acentos, en mayúsculas y con un solo espacio. */
export function normTexto(v: unknown): string {
  return sinAcentos(String(v ?? '')).toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Nombre (o abreviatura) del mes → 1..12. */
const MES_NUM: Record<string, number> = {
  ENERO: 1, ENE: 1, FEBRERO: 2, FEB: 2, MARZO: 3, MAR: 3, ABRIL: 4, ABR: 4, MAYO: 5, MAY: 5,
  JUNIO: 6, JUN: 6, JULIO: 7, JUL: 7, AGOSTO: 8, AGO: 8, SEPTIEMBRE: 9, SETIEMBRE: 9, SEPT: 9, SEP: 9,
  OCTUBRE: 10, OCT: 10, NOVIEMBRE: 11, NOV: 11, DICIEMBRE: 12, DIC: 12,
};
// Los nombres largos primero: si no, 'SEP' se quedaría con 'SEPTIEMBRE'.
const MES_RE = '(' + Object.keys(MES_NUM).sort((a, b) => b.length - a.length).join('|') + ')\\b';

const dos = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' si el día existe (nada de 31 de septiembre), si no null. */
function fechaValida(a: number, m: number, d: number): string | null {
  const f = new Date(Date.UTC(a, m - 1, d));
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null;
  return `${a}-${dos(m)}-${dos(d)}`;
}

// ------------------------------------------------------------
// Encabezados y libros
// ------------------------------------------------------------

/**
 * Fila del encabezado y columna de cada campo, buscando por nombre (al
 * estilo de leerPlano en ocupacionVV.ts): el encabezado no está en la fila
 * 1 y las columnas cambian de lugar entre unidades. Toma la PRIMERA columna
 * que cumple cada patrón (Ecovallas repite FECHA y OBSERVACIONES más a la
 * derecha). `fila` es el índice en `filas` (0 = primera fila de la matriz).
 */
export function buscarEncabezado(
  filas: unknown[][],
  patrones: Record<string, RegExp>,
  obligatorios: string[],
  maxFila = 40,
): { fila: number; col: Record<string, number> } | null {
  for (let i = 0; i < Math.min(filas.length, maxFila); i++) {
    const col: Record<string, number> = {};
    (filas[i] || []).forEach((v, j) => {
      const t = normTexto(v);
      if (!t) return;
      for (const [campo, re] of Object.entries(patrones)) if (col[campo] === undefined && re.test(t)) col[campo] = j;
    });
    if (obligatorios.every((c) => col[c] !== undefined)) return { fila: i, col };
  }
  return null;
}

// ------------------------------------------------------------
// Celdas sueltas
// ------------------------------------------------------------

/**
 * Fecha de una celda a 'YYYY-MM-DD'. Date (sheet_to_json la deja en hora
 * local) o serial → aFecha. Texto 'dd/mm/aa' y también '01/08(26' (A5 de
 * las copias de Pórticos: un paréntesis en lugar de la diagonal). Celda de
 * error o texto que no es fecha → null (la toma queda en espera).
 */
export function leerFechaCelda(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return aFecha(v);
  // Serial con hora (46310.75 = 15-oct a las 18:00): el día es la parte
  // entera. aFecha redondea y lo pasaba al 16 (revisión del 23-oct-2026).
  if (typeof v === 'number') return Number.isFinite(v) ? aFecha(Math.floor(v)) : null;
  const s = String(v).trim();
  if (!s || ERROR_CELDA.test(s)) return null;
  const m = s.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.(]\s*(\d{2,4})\)?$/);
  if (m) return aFecha(`${m[1]}/${m[2]}/${m[3]}`);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? aFecha(s) : null;
}

/**
 * Forma de una clave de inventario: MX_CM_EV_MGP_16_3606, MX_CM_BB_MED_0114, MX_EM_VV_COL_A04.
 * La usa también la búsqueda del alta manual (buscarSitiosComp.ts) para no ofrecer una calle como clave.
 */
export const FORMA_CLAVE = /^MX_[A-Z]{2}_[A-Z]{2}_[A-Z]{3}(?:_\d{2})?_[0-9A-Z]+$/;
const FORMA_PORTICO = /^(?:MX_CM_VV_)?POR_?\d+$/;
const esForma = (s: string) => FORMA_CLAVE.test(s) || FORMA_PORTICO.test(s);

/**
 * Clave de sitio limpia, con la forma de inventario.vendor_face_id:
 *   · mayúsculas; el texto entre paréntesis se quita ('…_0001 (PLANTEL NORTE)');
 *   · fuera los espacios, también los de en medio ('MX_CM_BB_MED_ 0114')
 *     y los duros; si después de la clave viene texto suelto, se quita;
 *   · 'POR_0008' / 'POR_00015' → 'MX_CM_VV_POR_0008' / '…_0015';
 *   · ceros de más o de menos: el número final va a 4 dígitos (3 en las
 *     columnas de Vía Verde: COL_448). Las de EDO MEX (A04) no son números.
 * `edoMex` marca las ^MX_EM_ (EDO MEX). Es SOLO un dato: la omisión es
 * únicamente de Vía Verde (MX_EM_VV_, de baja; la crítica del 22-oct
 * encontró MX_EM_VV_COL_A04, que ni existe en vv_espacios) y la hace el
 * lector de la bitácora solo con unidad 'Vía Verde'. En Ecovallas las
 * MX_EM_EV_ (Edo. Méx.) son pantallas Digital activas y SÍ entran (Erik,
 * 23-oct-2026); en Biobox las MX_EM_BB_ también.
 * Clave vacía o sin letras ni números → null: la fila se descarta, nunca
 * se vuelve una toma «TODAS».
 */
export function limpiarClave(t: unknown): { clave: string | null; cambios: CambioClave[]; edoMex: boolean } {
  const cambios: CambioClave[] = [];
  const nada = { clave: null, cambios, edoMex: false };
  let s = String(t ?? '').toUpperCase();
  if (ERROR_CELDA.test(s.trim())) return nada;
  if (/\(/.test(s)) {
    s = s.replace(/\s*\([^)]*\)?/g, '');
    cambios.push('texto_pegado');
  }
  const partes = s.trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return nada;
  let c = partes.join('');
  // 'MX_CM_BB_MED_ 0114': lo que sigue son números o la clave quedó abierta
  // en '_' → es la misma clave con un espacio. 'MX_CM_BB_IID_0001 PLANTEL NORTE':
  // la clave ya está completa y lo demás es texto pegado.
  const partida = partes.length > 1 && (partes[0].endsWith('_') || partes.slice(1).every((p) => /^\d+$/.test(p)));
  if (partes.length > 1 && !partida && esForma(partes[0])) {
    c = partes[0];
    if (!cambios.includes('texto_pegado')) cambios.push('texto_pegado');
  } else if (/\s/.test(s)) cambios.push('espacios');
  if (!/[A-Z0-9]/.test(c)) return nada;
  // 'X_CM_BB_MED_0049': se comió la «M» de MX (bitácora real de Biobox, 23-oct-2026).
  if (/^X_[A-Z]{2}_[A-Z]{2}_/.test(c)) {
    c = 'M' + c;
    cambios.push('prefijo');
  }
  const por = c.match(/^POR_?(\d+)$/);
  if (por) {
    c = `MX_CM_VV_POR_${por[1]}`;
    cambios.push('alias_portico');
  }
  const m = c.match(/^(MX_[A-Z]{2}_[A-Z]{2}_[A-Z]{3}(?:_\d{2})?)_(\d+)$/);
  if (m) {
    const n = String(Number(m[2])).padStart(/_VV_COL$/.test(m[1]) ? 3 : 4, '0');
    if (n !== m[2]) {
      c = `${m[1]}_${n}`;
      cambios.push('ceros');
    }
  }
  return { clave: c, cambios, edoMex: /^MX_EM_/.test(c) };
}

/**
 * Versión de Ecovallas sin la medida ni la extensión. En la bitácora real
 * (CAT 21, 23-oct-2026) la medida viene pegada al nombre del arte de mil
 * formas: 'SMARTFIT_15 ANIV-1440x405', 'INFORME - 1440 X 405-01.jpg',
 * 'GLOWUP 1440x405 V2.jpg', '…-1440×405', '…-1440X405PX_Sucursal'. La misma
 * versión en pantallas de medidas distintas es UNA versión.: el formato trae un
 * renglón por medida de pantalla ('…(3ULTIMAS) 1440x405.jpg', '…1152X324.jpg')
 * y es la misma versión. El texto original se guarda en la toma.
 */
export function versionSinMedida(nombre: unknown): string {
  const original = String(nombre ?? '').replace(/\s+/g, ' ').trim();
  const s = original
    // '[.,]': la bitácora real trae «…-C,png» (coma por punto, 23-oct-2026)
    // y daba una versión distinta de la misma pieza.
    .replace(/[.,](jpe?g|png|gif|mp4|mov|avi|webm|psd|psb|pdf|tiff?)$/i, '')
    // 'PX' también en mayúsculas: '…-1440X405PX_Altavista' (bitácora real
    // de Ecovallas, 23-oct-2026) dejaba 'PX' pegado y daba otra versión.
    .replace(/[ _-]*\d{3,4}\s*[xX×]\s*\d{2,4}(?:\s*px)?/gi, '')
    .replace(/[ _-]+$/, '')
    .trim();
  return s || original;
}

/** 'JARABE PRUEBA ADICIONAL (INICIAL)' → campaña sin el sufijo y entrega 'inicial'. */
/** Fecha leída de la bitácora, con lo que hizo falta para leerla (para avisar). */
export type FechaLeida = {
  fecha: string | null;
  /** La celda decía '-', '—', 'N/A' o 'NA': «sin fecha» a propósito, no un error. */
  guion: boolean;
  /** Texto que solo cuadra como mes/día ('10/13/2026') o que se leyó así por la vigencia. */
  mesDia: boolean;
  /** Había texto y no es fecha. */
  ilegible: boolean;
};

const GUION = /^(-+|—+|–+|N\/?A|S\/F|SIN FECHA)$/i;

/**
 * Fecha de una celda de la bitácora comercial (23-oct-2026). Igual que
 * leerFechaCelda, más dos cosas que trae el archivo real de Ecovallas:
 *   · texto con el mes PRIMERO ('10/13/2026', '10/26/2026' en la hoja de una
 *     campaña de octubre): si como día/mes no existe y como mes/día sí, se
 *     lee mes/día. Si las dos lecturas existen ('10/05/2026'), manda día/mes,
 *     salvo que solo la de mes/día caiga en `rango` (la vigencia del
 *     encabezado de la hoja);
 *   · '-' o 'N/A' en INICIO/FIN (Biobox): «sin fecha» marcado, no error.
 * `mesPrimero` (revisión del 23-oct-2026): la HOJA escribe el mes primero
 * (alguna de sus fechas solo cuadra como mes/día, ver esSoloMesDia). Entonces
 * las ambiguas también se leen mes/día: con '10/13/2026' de INICIO, el FIN
 * '11/12/2026' es 12 de noviembre, no 11 de diciembre (celda por celda
 * ganaba día/mes si las dos lecturas caían en la vigencia del encabezado).
 */
export function leerFechaBitacora(
  v: unknown,
  rango?: { inicio?: string | null; fin?: string | null } | null,
  opts?: { mesPrimero?: boolean } | null,
): FechaLeida {
  const r: FechaLeida = { fecha: null, guion: false, mesDia: false, ilegible: false };
  if (v === null || v === undefined || v === '') return r;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return r;
    if (GUION.test(s)) {
      r.guion = true;
      return r;
    }
    const m = s.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2,4})$/);
    if (m) {
      const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const dm = fechaValida(a, Number(m[2]), Number(m[1]));
      const md = fechaValida(a, Number(m[1]), Number(m[2]));
      const dentro = (f: string | null) =>
        !!f && !!rango?.inicio && !!rango?.fin && f >= rango.inicio && f <= rango.fin;
      if (opts?.mesPrimero && md && md !== dm) {
        r.fecha = md;
        r.mesDia = true;
      } else if (dm && (!md || md === dm || dentro(dm) || !dentro(md))) r.fecha = dm;
      else if (md) {
        r.fecha = md;
        r.mesDia = true;
      }
      r.fecha = anioRazonable(r.fecha);
      r.ilegible = !r.fecha;
      return r;
    }
    // '17 SEP', '11 sep', '5 DE OCTUBRE 2026' (Biobox real): el año sale de
    // la vigencia del encabezado (cruza de año si el mes queda a más de 6).
    const t = normTexto(s).replace(/\./g, '');
    const mm = t.match(new RegExp(`^(\\d{1,2})\\s*(?:DE\\s+)?${MES_RE}(?:\\s*(?:DE\\s+|/|-)?\\s*(\\d{4}))?$`));
    if (mm) {
      const base = rango?.inicio || rango?.fin || null;
      const mes = MES_NUM[mm[2]];
      let anio = mm[3] ? Number(mm[3]) : base ? Number(base.slice(0, 4)) : NaN;
      if (!mm[3] && base) {
        const mBase = Number(base.slice(5, 7));
        if (mBase - mes > 6) anio++;
        if (mes - mBase > 6) anio--;
      }
      r.fecha = Number.isFinite(anio) ? anioRazonable(fechaValida(anio, mes, Number(mm[1]))) : null;
      r.ilegible = !r.fecha;
      return r;
    }
  }
  r.fecha = anioRazonable(leerFechaCelda(v));
  r.ilegible = !r.fecha && (!!textoCelda(v) || typeof v === 'number');
  return r;
}

/** '13/10/0206' (año tecleado mal) no es una fecha de campaña: fuera de 2000-2100 → null. */
const anioRazonable = (f: string | null) => (f && /^20\d\d-\d\d-\d\d$/.test(f) ? f : null);

/**
 * ¿Es un texto 'aa/bb/aaaa' que SOLO cuadra con el mes primero ('10/13/2026')?
 * Con una sola celda así, la hoja escribe mes/día (leerFechaBitacora con
 * mesPrimero). Revisión del 23-oct-2026.
 */
export function esSoloMesDia(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const m = v.trim().match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2,4})$/);
  if (!m) return false;
  const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return !fechaValida(a, Number(m[2]), Number(m[1])) && !!anioRazonable(fechaValida(a, Number(m[1]), Number(m[2])));
}

export function separarEntrega(campana: unknown): { campana: string; entrega: 'inicial' | 'final' | null } {
  const s = String(campana ?? '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.*?)[\s_-]*\(\s*(INICIAL|FINAL)\s*\)$/i);
  if (!m || !m[1].trim()) return { campana: s, entrega: null };
  return { campana: m[1].trim(), entrega: m[2].toLowerCase() as 'inicial' | 'final' };
}

// ------------------------------------------------------------
// HORARIO
// ------------------------------------------------------------

export type Horario = {
  tipo: TipoHorario;
  /** [[minuto_desde, minuto_hasta]] inclusivos; null si no hay franja que leer. */
  franjas: [number, number][] | null;
  /** Lo que distingue dos tomas del mismo día (índice comp_tomas_llave). */
  llave: string;
  /** Duración escrita en minutos ('19:00 - 19:50' → 50: es el full_minutos de un FULL). */
  minutos: number | null;
  /** false si había texto y no se pudo leer (se guarda tal cual y se avisa). */
  entendido: boolean;
};

const RE_FRANJA = /(\d{1,2})(?:[:.](\d{2}))?\s?(AM|PM)?\s?(?:-|\bA\b)\s?(\d{1,2})(?:[:.](\d{2}))?\s?(AM|PM)?/g;
// Horario que cambia por fecha o por día: se muestra el texto y no se parte en franjas.
const RE_POR_FECHA = /\bDEL \d{1,2}\b(?![:.]\d)|\bEL \d{1,2} DE\b|\bAL \d{1,2} DE\b|\b[LMXJVSD]-[LMXJVSD]\b|\/\/|\b(LUNES|MARTES|MIERCOLES|JUEVES|VIERNES|SABADOS?|DOMINGOS?)\b|\bFIN(ES)? DE SEMANA\b/;

/**
 * HORARIO → franjas en minutos. Por qué no basta horasDeTexto
 * (ocupacionVV.ts): trabaja en horas enteras y solo con 'HH:MM - HH:MM';
 * aquí hay 'a', AM/PM, 'hrs', '19.00' y FULL de minutos.
 *   '24 HRS' → [[0,1439]] · '7 a 9 am / 18 a 20 hrs' → [[420,539],[1080,1199]]
 *   '3:00 PM A 4:59 PM' → [[900,1019]] · '19:00 - 24:00HRS' → [[1140,1439]]
 * Un fin en hora en punto no cuenta (como horasDeTexto): '18 a 20' llega a
 * las 19:59. Si el fin va antes que el inicio, la franja cruza la medianoche.
 */
export function leerHorario(t: unknown): Horario {
  const s = normTexto(t);
  if (!s) return { tipo: 'sin', franjas: null, llave: '', minutos: null, entendido: true };
  if (/^(24 ?H(RS?|ORAS)?\.?|00:00 ?- ?23:59( ?HRS)?)$/.test(s))
    return { tipo: '24h', franjas: [[0, 1439]], llave: '24H', minutos: 1440, entendido: true };
  if (/PROGRAM/.test(s)) return { tipo: 'programmatic', franjas: null, llave: 'PROGRAMMATIC', minutos: null, entendido: true };
  if (RE_POR_FECHA.test(s)) return { tipo: 'por_fecha', franjas: null, llave: llaveComp(s), minutos: null, entendido: true };
  const franjas: [number, number][] = [];
  let minutos = 0;
  // '12:00 HRS A 13:00 HRS', '15:00 hrs a 15:59hrs' (bitácora real de
  // Ecovallas, 23-oct-2026): el «HRS» entre la hora y el «A» no dejaba leer
  // la franja. Se quita antes de buscar (la llave sigue saliendo de las franjas).
  const sf = s.replace(/(\d)\s*H(RS?|ORAS?)\b\.?/g, '$1');
  for (const m of sf.matchAll(RE_FRANJA)) {
    let h1 = Number(m[1]);
    let h2 = Number(m[4]);
    const m1 = Number(m[2] || 0);
    const m2 = Number(m[5] || 0);
    const ap2 = m[6] || null;
    // '7 a 9 am': el AM/PM del final vale para el inicio si cabe.
    const ap1 = m[3] || (ap2 === 'PM' && h1 <= h2 && h2 < 12 ? 'PM' : ap2 === 'AM' ? 'AM' : null);
    if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) continue;
    if (ap1 === 'PM' && h1 < 12) h1 += 12;
    if (ap1 === 'AM' && h1 === 12) h1 = 0;
    if (ap2 === 'PM' && h2 < 12) h2 += 12;
    if (ap2 === 'AM' && h2 === 12) h2 = 0;
    const a = Math.min(h1 * 60 + m1, 1439);
    const fin = Math.min(h2 * 60 + m2, 1440);
    const b = m2 === 0 && fin > 0 ? fin - 1 : Math.min(fin, 1439);
    if (fin > a) {
      franjas.push([a, b]);
      minutos += fin - a;
    } else if (fin < a) {
      franjas.push([a, 1439]);
      if (fin > 0) franjas.push([0, b]);
      minutos += 1440 - a + fin;
    }
  }
  if (!franjas.length) return { tipo: 'sin', franjas: null, llave: llaveComp(s), minutos: null, entendido: false };
  return { tipo: 'franjas', franjas, llave: franjas.map(([a, b]) => `${a}-${b}`).join('/'), minutos, entendido: true };
}

/**
 * Una hora tecleada como hora de Excel → 'HH:MM'. Excel guarda «7:00» como
 * la fracción del día 0.2916…; con cellDates llega como un Date de
 * 1899-12-30. Antes se perdía sin aviso (revisión del 23-oct-2026). Lo que
 * no es una hora de Excel → null.
 */
export function horaExcel(v: unknown): string | null {
  let min: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1) min = Math.round(v * 1440);
  else if (v instanceof Date && !Number.isNaN(v.getTime()) && v.getFullYear() <= 1900)
    min = Math.round(v.getHours() * 60 + v.getMinutes() + v.getSeconds() / 60);
  if (min === null) return null;
  min = Math.min(min, 1439);
  return `${dos(Math.floor(min / 60))}:${dos(min % 60)}`;
}

// ------------------------------------------------------------
// OBSERVACIONES / ESPECIFICACIÓN
// ------------------------------------------------------------

export type Observacion = {
  ventanaInicio: string | null;
  ventanaFin: string | null;
  fechaLimite: string | null;
  banderas: string[];
  /** false si había texto y no se encontró ni ventana ni fecha límite. */
  entendido: boolean;
};

/**
 * Banderas por patrón, como especToma.ts: una redacción nueva es una línea
 * nueva. Son DATOS para la pantalla y para la fase 3; nada se cancela solo.
 */
const BANDERAS: [string, RegExp][] = [
  ['lista_sin_enviar', /PERO NO ENVIAR|NO SE ENVIA|SOLO TENER/],
  ['no_se_comprueba', /NO SE COMPRUEBAN?\b/],
  ['una_vez', /SOLO SE COMPRUEBA UNA VEZ/],
  ['programmatic', /PROGRAM{1,2}A?T{1,2}IC|PDOOH/],
  ['corta_media_larga', /CORTAS?,? (Y )?MEDIAS?,? Y LARGAS?/],
  ['medias', /TOMAS? MEDIAS?\b/],
  ['solo_larga', /SOLO SE MANDA TOMA LARGA/],
  ['camaras', /CAMARAS?\b/],
  ['periodico', /PERIODICO/],
  ['video', /\bVIDEOS?\b/],
  ['por_lado', /POR LADO/],
  ['inicial_final', /INICIAL Y FINAL/],
  ['avance_n_dias', /AVANCES? (1ER DIA|1ROS? (\d+|DOS|TRES) DIAS|CADA \d+ ?ER DIA|POR SEMANA)/],
  ['detenida', /DETENIDA|DETENER/],
  ['baja', /\bBAJA\b/],
];
/** Banderas que valen para una toma y no para toda la campaña, salvo que vengan en todas sus filas. */
const BANDERAS_DE_TOMA = new Set(['no_se_comprueba', 'baja', 'detenida']);

/**
 * Ventana, fecha límite y banderas del texto de OBSERVACIONES o de la
 * Especificación. El año sale del periodo y cruza de año si el mes está a
 * más de 6 meses ('DEL 28 DE DICIEMBRE…' en una base de enero).
 *   'DEL dd [DE MES] AL dd DE MES' · 'dd Y dd DE MES' · 'UNICAMENTE EL dd DE MES'
 *   'A PARTIR DEL dd DE MES' (solo inicio) · 'SUBE EL dd DE MES' (un día)
 *   límite: '(A MAS TARDAR|LISTA|COMPLETA) EL dd DE MES'
 * Antes de leer se separan letra y número ('DEL08 AL 14DE' de Ecovallas H825).
 */
export function leerObservacion(t: unknown, base: { anio: number; mes: number }): Observacion {
  const s = normTexto(t).replace(/UNICMANETE|UNICAMNETE|UNICAMETE/g, 'UNICAMENTE');
  const r: Observacion = { ventanaInicio: null, ventanaFin: null, fechaLimite: null, banderas: [], entendido: true };
  if (!s) return r;
  const f = (d: string, mesTxt: string) => {
    const mm = MES_NUM[mesTxt];
    let a = base.anio;
    if (base.mes - mm > 6) a++;
    if (mm - base.mes > 6) a--;
    return fechaValida(a, mm, Number(d));
  };
  const x = s.replace(/([A-Z])(\d)/g, '$1 $2').replace(/(\d)([A-Z])/g, '$1 $2').replace(/\s+/g, ' ');
  let m: RegExpMatchArray | null;
  if ((m = x.match(new RegExp(`\\bDEL? (\\d{1,2})(?: DE ${MES_RE})?(?: DE \\d{4})? AL (\\d{1,2}) DE ${MES_RE}`)))) {
    r.ventanaInicio = f(m[1], m[2] || m[4]);
    r.ventanaFin = f(m[3], m[4]);
  } else if ((m = x.match(new RegExp(`\\b(\\d{1,2}) (?:Y|AL) (\\d{1,2}) DE ${MES_RE}`)))) {
    r.ventanaInicio = f(m[1], m[3]);
    r.ventanaFin = f(m[2], m[3]);
  } else if ((m = x.match(new RegExp(`\\bUNICAMENTE (?:EL )?(?:DIA )?(\\d{1,2}) DE ${MES_RE}`)))) {
    r.ventanaInicio = r.ventanaFin = f(m[1], m[2]);
  } else if ((m = x.match(new RegExp(`\\bA PARTIR DEL? (?:DIA )?(\\d{1,2}) DE ${MES_RE}`)))) {
    r.ventanaInicio = f(m[1], m[2]);
  } else if ((m = x.match(new RegExp(`\\bSUBE EL (\\d{1,2}) DE ${MES_RE}`)))) {
    r.ventanaInicio = r.ventanaFin = f(m[1], m[2]);
  }
  if ((m = x.match(new RegExp(`\\b(?:A MAS TARDAR|MAS TARDAR|LISTAS?|COMPLETAS?) (?:EL )?(?:DIA )?(\\d{1,2}) DE ${MES_RE}`))))
    r.fechaLimite = f(m[1], m[2]);
  for (const [b, re] of BANDERAS) if (re.test(s)) r.banderas.push(b);
  r.entendido = !!(r.ventanaInicio || r.fechaLimite);
  return r;
}

// ------------------------------------------------------------
// Celdas combinadas
// ------------------------------------------------------------

/**
 * Copia el valor de la esquina de cada combinación (ws['!merges']) a todas
 * sus celdas. La Especificación combina la columna C entre versiones
 * (Biobox C3:C5): sin esto la V6 y la V7 quedan sin texto. `filas` debe
 * venir con blankrows: true. Las coordenadas de `!merges` son de la HOJA
 * (base 0) y `origen` es la celda de la hoja que quedó en filas[0][0]:
 * sheet_to_json empieza en el origen de `!ref`, y Excel guarda 'B1:N5'
 * cuando la columna A está vacía; sin restarlo todo caía una columna
 * corrido (revisión del 23-oct-2026). Leer con hojaDeLibro
 * (bitacoraComp.ts) evita el problema: siempre lee desde A1. No toca la
 * matriz original.
 */
export function rellenarCombinadas(
  filas: unknown[][],
  merges: Merge[] | null | undefined,
  origen: { r: number; c: number } | null = null,
): unknown[][] {
  if (!merges?.length) return filas;
  const r0 = origen?.r ?? 0;
  const c0 = origen?.c ?? 0;
  const out = filas.slice();
  for (const m of merges) {
    const mg = { s: { r: m.s.r - r0, c: m.s.c - c0 }, e: { r: m.e.r - r0, c: m.e.c - c0 } };
    if (mg.e.r < 0 || mg.e.c < 0) continue;
    const v = filas[mg.s.r]?.[mg.s.c];
    if (v === null || v === undefined || v === '') continue;
    for (let r = Math.max(mg.s.r, 0); r <= mg.e.r; r++) {
      const fila = (out[r] = (out[r] === filas[r] ? (filas[r] || []).slice() : out[r]) || []);
      for (let c = Math.max(mg.s.c, 0); c <= mg.e.c; c++) if (r !== mg.s.r || c !== mg.s.c) fila[c] = v;
    }
  }
  return out;
}

/**
 * El error de SheetJS o fflate al abrir un archivo, en palabras de campo
 * (revisión 2, uso-10): antes se enseñaba crudo y en inglés («File is
 * password-protected», «invalid zip data»). Lo que no se reconoce se dice
 * en general; el mensaje original queda para la consola.
 */
export function errorLectorEnEspanol(ex: unknown): string {
  const msg = ex instanceof Error ? ex.message : typeof ex === 'string' ? ex : '';
  if (/password|encrypt|protegid/i.test(msg)) return 'el archivo tiene contraseña; quítasela en Excel y vuelve a subirlo';
  if (/zip|unexpected end|corrupt|crc|invalid (data|block|distance|stored)/i.test(msg))
    return 'el archivo está dañado o no terminó de bajarse; vuelve a guardarlo en Excel';
  if (/unsupported|not supported|unknown (file )?format|bad (file|header)|cannot find|is not a (spreadsheet|workbook)/i.test(msg))
    return 'no parece un Excel; guárdalo como .xlsx y vuelve a subirlo';
  if (/memory|allocation|array buffer|invalid array length|too large/i.test(msg))
    return 'el archivo es demasiado grande para este equipo; ábrelo en una computadora o quita hojas que no se usan';
  return 'archivo dañado o no es Excel';
}
