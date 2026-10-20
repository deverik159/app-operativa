// ============================================================
// src/lib/ocupacionVV.ts
// Disponibilidad y ocupación de Vía Verde por slot (fase 1, 19-oct-2026).
//
// DE DÓNDE SALE. Comercial arma cada mes el "plano de columnas" en Excel:
// una línea por campaña, columna (o pórtico), SLOT, fechas, días y horario.
// Cada columna rota varios anunciantes: tiene N slots (el estándar son 8,
// hasta 12) y un slot puede llevar varias campañas en horas o días
// distintos. El método se reconstruyó en el "Occupancy calculator" (chat
// de Claude, jul-ago 2026) y se validó contra el archivo manual de
// ocupación de Vía Verde: los % de una columna salieron idénticos (el
// detalle está en la ficha privada de la sección, no aquí: repo público).
//
// REGLAS (Erik, 19-oct-2026):
//   · Estatus del plano: NO DISPONIBLE = vendida; DISPONIBLE = apartada o
//     propuesta (aquí "reservada"); PAUTADA = convencional ya programada.
//   · Las reservas hechas en la app vencen a las 72 h; las apartadas que
//     vienen del plano no vencen (reservadaHasta null).
//   · Comercial decide el slot al vender; los pórticos también llevan slots.
//
// OCUPACIÓN. Capacidad fija de 180 jugadas por hora por columna; cada slot
// vale 180/nSlots. Se cuenta LÍNEA POR LÍNEA: si dos campañas comparten
// slot y hora, cuentan las dos (así cuadra con el archivo manual). Las
// reservas vigentes cuentan como ocupado (el archivo manual también
// contaba las apartadas); las vencidas, no.
//
// HORARIOS. El plano escribe '16:00 - 17:00' (fin exclusivo: solo la hora
// 16) y la Bitácora '07:00 - 21:59HRS' (fin inclusivo): horasDeTexto
// entiende los dos y los que cruzan la medianoche ('05:00 - 01:00'). Por
// eso en la base las horas se guardan como lista, no como texto.
//
// Fechas como 'YYYY-MM-DD' y días de la semana con 0 = lunes, igual que
// diasEnRango de la Bitácora. Sin dependencias: lo prueba
// tests/ocupacionVV.test.mjs con datos inventados (el repo es público:
// nunca el plano real).
// ============================================================

export type EstatusOcup = 'vendida' | 'reservada' | 'pautada';
export type Negociacion = 'VENTA' | 'BONIFICACION' | 'INTERCAMBIO';

export type LineaOcup = {
  /** Clave de vv_espacios: '551', 'POR_0008'. */
  espacio: string;
  slot: number;
  campana: string;
  negociacion: Negociacion;
  /** Convencional = 24 h, normalmente anual. */
  convencional: boolean;
  inicio: string;
  fin: string;
  /** 0 = lunes … 6 = domingo; null = todos los días. */
  dias: number[] | null;
  /** Horas enteras ocupadas, 0 a 23. */
  horas: number[];
  estatus: EstatusOcup;
  /** Solo reservas hechas en la app; null = no vence. */
  reservadaHasta: string | null;
};

export const JUGADAS_HORA = 180;
export const SLOTS_ESTANDAR = 8;
export const HORAS_RESERVA = 72;

const rango = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const TODAS = rango(0, 24);

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// ------------------------------------------------------------
// Horario y días
// ------------------------------------------------------------

/** Paquetes que se venden por nombre (bandas del archivo de ocupación). */
const PAQUETES: Record<string, number[]> = {
  '14': rango(7, 21),
  '16': rango(7, 23),
  '20': [0, ...rango(5, 24)], // de 05:00 a 00:59
  '24': TODAS,
};

/**
 * Horas enteras de un texto de horario, del plano o de la Bitácora.
 * Fin 'HH:00' es exclusivo y 'HH:59' incluye la hora; si el fin es antes
 * del inicio, la franja cruza la medianoche. 'NO APLICA' o vacío → [].
 */
export function horasDeTexto(texto: unknown, convencional = false): number[] {
  if (convencional) return [...TODAS];
  const t = String(texto ?? '').trim().toUpperCase();
  if (!t || t.includes('NO APLICA')) return [];
  const horas = new Set<number>();
  const re = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;
  let m: RegExpExecArray | null;
  let alguna = false;
  while ((m = re.exec(t))) {
    alguna = true;
    const a = Number(m[1]) % 24;
    let b = Number(m[3]);
    if (m[4] === '00') b -= 1; // '17:00' como fin: la hora 17 ya no va
    b = ((b % 24) + 24) % 24; // '24:00' y '00:00' como fin → hasta las 23
    if (b >= a) for (let h = a; h <= b; h++) horas.add(h);
    else {
      for (let h = a; h < 24; h++) horas.add(h);
      for (let h = 0; h <= b; h++) horas.add(h);
    }
  }
  if (!alguna) {
    const p = t.match(/\b(14|16|20|24)\s*H/);
    return p ? [...PAQUETES[p[1]]] : [];
  }
  return [...horas].sort((x, y) => x - y);
}

/** Nombre de un día, completo o en 3 letras: 'LUNES', 'MIE', 'SABADOS'. */
const DIA_RE = /\b(LUN(?:ES)?|MAR(?:TES)?|MIE(?:RCOLES)?|JUE(?:VES)?|VIE(?:RNES)?|SAB(?:ADOS?)?|DOM(?:INGOS?)?)\b/g;
const DIA_NUM: Record<string, number> = { LUN: 0, MAR: 1, MIE: 2, JUE: 3, VIE: 4, SAB: 5, DOM: 6 };
/** Letras del plano abreviado ('L-V', 'S-D'): M = martes, X = miércoles. */
const LETRA_NUM: Record<string, number> = { L: 0, M: 1, X: 2, J: 3, V: 4, S: 5, D: 6 };

/** Del día a al b; si b va antes, da la vuelta a la semana ('VIERNES A LUNES'). */
const diasEntre = (a: number, b: number) => Array.from({ length: ((b - a + 7) % 7) + 1 }, (_, i) => (a + i) % 7);

/** Siete días = todos (null), como un texto vacío. */
const comoDias = (d: Iterable<number>): number[] | null => {
  const s = [...new Set(d)].sort((x, y) => x - y);
  return s.length === 7 ? null : s;
};

/**
 * Días de proyección del plano. `entendido` es false si el texto trae algo
 * que no se pudo leer: entonces se toman TODOS los días (contar de más es
 * mejor que dar por libre un día vendido) y leerPlano lo avisa.
 *   'LUNES A VIERNES' → [0..4] · 'VIERNES A DOMINGO' → [4, 5, 6]
 *   'SABADO Y DOMINGO' → [5, 6] · 'L-V', 'S-D' · 'LUNES A DOMINGO' → null
 */
export function leerDias(texto: unknown): { dias: number[] | null; entendido: boolean } {
  const t = sinAcentos(String(texto ?? ''))
    .toUpperCase()
    .replace(/\./g, '') // 'LUN. A VIE.'
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || /^(TODOS( LOS DIAS)?|DIARIO|TODA LA SEMANA)$/.test(t)) return { dias: null, entendido: true };
  if (/^FIN(ES)? DE SEMANA$/.test(t)) return { dias: [5, 6], entendido: true };
  if (/^ENTRE SEMANA$/.test(t)) return { dias: [0, 1, 2, 3, 4], entendido: true };
  const letras = t.match(/^([LMXJVSD]) ?(?:-|–|A|AL) ?([LMXJVSD])$/);
  if (letras) return { dias: comoDias(diasEntre(LETRA_NUM[letras[1]], LETRA_NUM[letras[2]])), entendido: true };

  // Nombres de días unidos por 'A' (rango) o por 'Y', coma o diagonal (lista).
  const dias = new Set<number>();
  let previo: number | null = null;
  let ultimo = 0;
  let entendido = true;
  for (const m of t.matchAll(DIA_RE)) {
    const d = DIA_NUM[m[1].slice(0, 3)];
    const ini = m.index ?? 0;
    const entre = t.slice(ultimo, ini).trim();
    if (previo !== null && /^(A|AL|-|–|HASTA)$/.test(entre)) diasEntre(previo, d).forEach((x) => dias.add(x));
    else {
      // Antes del primer día solo puede ir 'DE' o 'DIAS' ('DE LUNES A VIERNES').
      if (previo === null ? !/^((DE|DIAS?|LOS):? ?)*$/.test(entre) : !/^(Y|E|,|\/|&|, ?Y)?$/.test(entre)) entendido = false;
      dias.add(d);
    }
    previo = d;
    ultimo = ini + m[0].length;
  }
  if (!dias.size || !/^[,;]?$/.test(t.slice(ultimo).trim())) entendido = false;
  return entendido ? { dias: comoDias(dias), entendido } : { dias: null, entendido };
}

/** Los días de leerDias, sin el aviso. Vacío o todos → null. */
export function diasDeTexto(texto: unknown): number[] | null {
  return leerDias(texto).dias;
}

/** De horas a texto con fin inclusivo: '07:00 - 09:59 / 18:00 - 21:59'. */
export function franjasTexto(horas: number[]): string {
  const set = [...new Set(horas)].filter((h) => h >= 0 && h < 24).sort((a, b) => a - b);
  if (set.length === 24) return '24 HRS';
  const partes: string[] = [];
  let ini = set[0];
  for (let i = 0; i < set.length; i++) {
    if (set[i + 1] !== set[i] + 1) {
      partes.push(`${String(ini).padStart(2, '0')}:00 - ${String(set[i]).padStart(2, '0')}:59`);
      ini = set[i + 1];
    }
  }
  return partes.join(' / ');
}

// ------------------------------------------------------------
// Fechas (en UTC para no pelearse con la zona del teléfono)
// ------------------------------------------------------------

function utc(fecha: string): Date {
  const [a, m, d] = fecha.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d));
}

/** 0 = lunes … 6 = domingo. */
export function diaSemana(fecha: string): number {
  return (utc(fecha).getUTCDay() + 6) % 7;
}

export function sumarDias(fecha: string, n: number): string {
  const d = utc(fecha);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Días de un rango inclusivo; tope para que un rango absurdo no congele la pantalla. */
export function diasDelRango(desde: string, hasta: string, tope = 400): string[] {
  const out: string[] = [];
  for (let f = desde; f <= hasta && out.length < tope; f = sumarDias(f, 1)) out.push(f);
  return out;
}

/** 'YYYY-MM' → todos sus días. */
export function diasDelMes(mes: string): string[] {
  const [a, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return diasDelRango(`${mes}-01`, `${mes}-${String(ultimo).padStart(2, '0')}`);
}

// ------------------------------------------------------------
// Qué cuenta y cuándo
// ------------------------------------------------------------

/** Una reserva vencida ya no ocupa nada; lo demás siempre cuenta. */
export function cuenta(l: LineaOcup, ahora: Date): boolean {
  if (l.estatus !== 'reservada' || !l.reservadaHasta) return true;
  return Date.parse(l.reservadaHasta) > ahora.getTime();
}

export function activaEn(l: LineaOcup, fecha: string): boolean {
  if (fecha < l.inicio || fecha > l.fin) return false;
  return !l.dias || l.dias.length === 0 || l.dias.includes(diaSemana(fecha));
}

// ------------------------------------------------------------
// Ocupación del mes (el reporte que hoy se arma a mano)
// ------------------------------------------------------------

export const BANDAS: { clave: string; etiqueta: string; horas: number[] }[] = [
  { clave: 'b1', etiqueta: '00:00 - 06:59', horas: rango(0, 7) },
  { clave: 'b2', etiqueta: '07:00 - 10:59', horas: rango(7, 11) },
  { clave: 'b3', etiqueta: '11:00 - 16:59', horas: rango(11, 17) },
  { clave: 'b4', etiqueta: '17:00 - 22:59', horas: rango(17, 23) },
  { clave: 'b5', etiqueta: '23:00 - 23:59', horas: [23] },
  { clave: 'p14', etiqueta: '14 HRS (07-21)', horas: PAQUETES['14'] },
  { clave: 'p16', etiqueta: '16 HRS (07-23)', horas: PAQUETES['16'] },
  { clave: 'p20', etiqueta: '20 HRS (05-01)', horas: PAQUETES['20'] },
  { clave: 'p24', etiqueta: '24 HRS', horas: TODAS },
];

/** Jugadas de un bloque de horas: capacidad, ocupado y su desglose, con %. */
export type Bloque = {
  capacidad: number;
  ocupado: number;
  venta: number;
  bonificacion: number;
  intercambio: number;
  /** Parte de "ocupado" que son reservas vigentes (apartadas). */
  reservado: number;
  pOcupado: number;
  pVenta: number;
  pBonificacion: number;
  pIntercambio: number;
};

export type FilaOcupacion = {
  espacio: string;
  slots: number;
  dias: number;
  mensual: Bloque;
  bandas: Record<string, Bloque>;
};

/**
 * Ocupación de cada espacio en un mes, línea por línea. `slots` da los
 * slots de cada espacio (los de vv_espacios); sin dato, el estándar.
 */
export function ocupacionDelMes(
  lineas: LineaOcup[],
  espacios: string[],
  slots: Record<string, number>,
  mes: string,
  ahora: Date
): FilaOcupacion[] {
  const dias = diasDelMes(mes);
  const porEspacio = new Map<string, LineaOcup[]>();
  lineas.forEach((l) => {
    if (!cuenta(l, ahora)) return;
    const arr = porEspacio.get(l.espacio) || [];
    arr.push(l);
    porEspacio.set(l.espacio, arr);
  });
  return espacios.map((espacio) => {
    // Nunca menos que el slot más alto de sus líneas: con los slots de hoy
    // un mes viejo podía pasar de 100 % (revisión del 19-oct-2026).
    const n = Math.max(1, slots[espacio] || SLOTS_ESTANDAR, ...(porEspacio.get(espacio) || []).map((l) => l.slot));
    // Horas-slot ocupadas por hora del día, sumando cada día activo.
    const oc = Array(24).fill(0);
    const ve = Array(24).fill(0);
    const bo = Array(24).fill(0);
    const it = Array(24).fill(0);
    const re = Array(24).fill(0);
    for (const l of porEspacio.get(espacio) || []) {
      const nd = dias.filter((f) => activaEn(l, f)).length;
      if (!nd) continue;
      for (const h of l.horas) {
        oc[h] += nd;
        if (l.negociacion === 'VENTA') ve[h] += nd;
        else if (l.negociacion === 'BONIFICACION') bo[h] += nd;
        else it[h] += nd;
        if (l.estatus === 'reservada') re[h] += nd;
      }
    }
    const valor = JUGADAS_HORA / n; // jugadas por hora-slot
    const bloque = (hs: number[]): Bloque => {
      const suma = (arr: number[]) => hs.reduce((a, h) => a + arr[h], 0) * valor;
      const capacidad = JUGADAS_HORA * hs.length * dias.length;
      const b = {
        capacidad,
        ocupado: suma(oc),
        venta: suma(ve),
        bonificacion: suma(bo),
        intercambio: suma(it),
        reservado: suma(re),
      };
      const p = (x: number) => (capacidad ? x / capacidad : 0);
      return {
        ...b,
        pOcupado: p(b.ocupado),
        pVenta: p(b.venta),
        pBonificacion: p(b.bonificacion),
        pIntercambio: p(b.intercambio),
      };
    };
    const bandas: Record<string, Bloque> = {};
    BANDAS.forEach((b) => (bandas[b.clave] = bloque(b.horas)));
    return { espacio, slots: n, dias: dias.length, mensual: bloque(TODAS), bandas };
  });
}

// ------------------------------------------------------------
// Disponibilidad: rejilla slot × hora de un espacio en un rango
// ------------------------------------------------------------

export type Celda = { estado: 'libre' | EstatusOcup; lineas: LineaOcup[] };

/** Si una celda tiene varias líneas, manda la más firme. */
const PESO: Record<EstatusOcup, number> = { vendida: 3, pautada: 2, reservada: 1 };

/**
 * matriz[slot - 1][hora]. Una hora de un slot está ocupada si alguna línea
 * de ese slot la usa en CUALQUIER día del rango (libre solo si está libre
 * todos los días: así se puede vender el rango completo).
 */
export function matrizDeEspacio(
  lineas: LineaOcup[],
  espacio: string,
  slots: number,
  desde: string,
  hasta: string,
  ahora: Date
): Celda[][] {
  const dias = diasDelRango(desde, hasta);
  // Nunca menos que el slot más alto de sus líneas: una línea en un slot
  // que el catálogo ya no tiene no debe desaparecer (saldría libre).
  const n = Math.max(1, slots, ...lineas.filter((l) => l.espacio === espacio).map((l) => l.slot));
  const m: Celda[][] = Array.from({ length: n }, () =>
    Array.from({ length: 24 }, () => ({ estado: 'libre' as Celda['estado'], lineas: [] as LineaOcup[] }))
  );
  for (const l of lineas) {
    if (l.espacio !== espacio || l.slot < 1 || l.slot > n || !cuenta(l, ahora)) continue;
    if (!dias.some((f) => activaEn(l, f))) continue;
    for (const h of l.horas) {
      const c = m[l.slot - 1][h];
      c.lineas.push(l);
      if (c.estado === 'libre' || PESO[l.estatus] > PESO[c.estado]) c.estado = l.estatus;
    }
  }
  return m;
}

/** Cuántos slots quedan libres en cada hora (0 a 23). */
export function slotsLibresPorHora(matriz: Celda[][]): number[] {
  return TODAS.map((h) => matriz.filter((fila) => fila[h].estado === 'libre').length);
}

// ------------------------------------------------------------
// Lectura del plano de columnas (Excel)
// ------------------------------------------------------------

/** 'MX_CM_VV_COL_551' → '551'; 'MX_CM_VV_POR_0008' → 'POR_0008'; lo demás tal cual. */
export function claveEspacio(sitio: string): string {
  const s = String(sitio ?? '').trim().toUpperCase();
  const m = s.match(/(?:^|_)(COL|POR)_(\w+)$/);
  if (!m) return s;
  return m[1] === 'POR' ? `POR_${m[2]}` : m[2];
}

/** Celda de fecha a 'YYYY-MM-DD': Date de SheetJS, serial de Excel o texto. */
export function aFecha(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // SheetJS arma la fecha en hora local: toISOString podría restar un día.
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  // Seriales de Excel válidos: 1 (1900) a 2958465 (año 9999); fuera de eso
  // no es una fecha (y toISOString tronaría).
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v < 1 || v > 2958465) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return fechaValida(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return fechaValida(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

/** 'YYYY-MM-DD' si el día existe (nada de 31/02 ni de mes 13), si no null. */
function fechaValida(a: number, m: number, d: number): string | null {
  const f = new Date(Date.UTC(a, m - 1, d));
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null;
  return f.toISOString().slice(0, 10);
}

const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

/** Línea del plano tal como se leyó, con la fila del Excel para los avisos. */
export type LineaPlano = Omit<LineaOcup, 'espacio'> & { sitio: string; espacio: string; fila: number };

export type ResultadoPlano = {
  lineas: LineaPlano[];
  /** 'YYYY-MM' del plano, o null si no se pudo saber. */
  mes: string | null;
  /** Slot más alto visto por espacio, contando renglones vacíos (dan la capacidad). */
  slotsVistos: Record<string, number>;
  avisos: string[];
  /** Encabezados obligatorios que no se encontraron. */
  faltan: string[];
};

const ENCABEZADOS: { campo: string; re: RegExp; obligatorio: boolean }[] = [
  { campo: 'sitio', re: /^(ID )?(COLUMNA|SITIO|ESPACIO)\b/, obligatorio: true },
  { campo: 'slot', re: /^SLOTS?\b/, obligatorio: true },
  { campo: 'tipo', re: /^TIPO( DE)? PAUTA\b/, obligatorio: false },
  { campo: 'campana', re: /^CAMPANA\b/, obligatorio: true },
  { campo: 'negociacion', re: /^NEGOCIACION\b/, obligatorio: false },
  { campo: 'inicio', re: /^(FECHA (DE )?)?INICIO\b/, obligatorio: true },
  { campo: 'fin', re: /^(FECHA (DE )?)?FIN\b/, obligatorio: true },
  { campo: 'estatus', re: /^(ESTATUS|STATUS)\b/, obligatorio: false },
  { campo: 'dias', re: /^DIAS\b/, obligatorio: false },
  { campo: 'horario', re: /^HORARIOS?\b/, obligatorio: true },
];

const norm = (v: unknown) => sinAcentos(String(v ?? '')).trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * Lee las filas de la hoja del plano (sheet_to_json con header: 1). El
 * encabezado puede no estar en la primera fila y puede haber columnas de
 * más (Plaza, la rejilla de horas…): se busca cada columna por su nombre.
 * Los renglones sin campaña no son líneas, pero su slot cuenta para saber
 * cuántos slots tiene la columna.
 */
export function leerPlano(filas: unknown[][], hoja: string): ResultadoPlano {
  const avisos: string[] = [];
  let fila0 = -1;
  let col: Record<string, number> = {};
  for (let i = 0; i < Math.min(filas.length, 40) && fila0 < 0; i++) {
    const c: Record<string, number> = {};
    (filas[i] || []).forEach((v, j) => {
      const t = norm(v);
      const e = ENCABEZADOS.find((x) => x.re.test(t));
      if (e && c[e.campo] === undefined) c[e.campo] = j;
    });
    if (c.sitio !== undefined && c.campana !== undefined && c.slot !== undefined) {
      fila0 = i;
      col = c;
    }
  }
  const faltan = ENCABEZADOS.filter((e) => e.obligatorio && col[e.campo] === undefined).map((e) => e.campo);
  if (fila0 < 0 || faltan.length) return { lineas: [], mes: null, slotsVistos: {}, avisos, faltan };

  const celda = (f: unknown[], campo: string) => (col[campo] === undefined ? undefined : f[col[campo]]);
  const lineas: LineaPlano[] = [];
  const slotsVistos: Record<string, number> = {};
  for (let i = fila0 + 1; i < filas.length; i++) {
    const f = filas[i] || [];
    const sitio = String(celda(f, 'sitio') ?? '').trim();
    if (!sitio) continue;
    const espacio = claveEspacio(sitio);
    const slot = Number(celda(f, 'slot'));
    const filaExcel = i + 1;
    if (Number.isInteger(slot) && slot > 0 && slot <= 24)
      slotsVistos[espacio] = Math.max(slotsVistos[espacio] || 0, slot);
    const campana = String(celda(f, 'campana') ?? '').trim();
    if (!campana) continue; // renglón vacío: solo dice que el slot existe
    if (!Number.isInteger(slot) || slot < 1 || slot > 24) {
      avisos.push(`Fila ${filaExcel}: slot "${celda(f, 'slot') ?? ''}" no es un número de 1 a 24; no se tomó.`);
      continue;
    }
    const inicio = aFecha(celda(f, 'inicio'));
    const fin = aFecha(celda(f, 'fin'));
    if (!inicio || !fin || fin < inicio) {
      avisos.push(`Fila ${filaExcel}: fechas incompletas o al revés; no se tomó.`);
      continue;
    }
    const neg = norm(celda(f, 'negociacion'));
    const negociacion: Negociacion | null = !neg || neg === 'VENTA'
      ? 'VENTA'
      : neg.startsWith('BONIF')
        ? 'BONIFICACION'
        : neg.startsWith('INTERC')
          ? 'INTERCAMBIO'
          : null;
    if (!negociacion) {
      avisos.push(`Fila ${filaExcel}: negociación "${neg}" desconocida; no se tomó.`);
      continue;
    }
    const est = norm(celda(f, 'estatus'));
    let estatus: EstatusOcup = 'vendida';
    if (est === 'DISPONIBLE') estatus = 'reservada';
    else if (est === 'PAUTADA') estatus = 'pautada';
    else if (est && est !== 'NO DISPONIBLE')
      avisos.push(`Fila ${filaExcel}: estatus "${est}" desconocido; se tomó como vendida.`);
    const convencional = norm(celda(f, 'tipo')) === 'CONVENCIONAL';
    const horas = horasDeTexto(celda(f, 'horario'), convencional);
    const textoHorario = String(celda(f, 'horario') ?? '');
    if (!horas.length) {
      avisos.push(`Fila ${filaExcel}: horario "${textoHorario}" sin horas; no se tomó.`);
      continue;
    }
    // '09:00 - 12:00 - 16:00 - 19:00' (guion en vez de '/'): se leen las
    // dos franjas, pero conviene que comercial lo vea (el calculator viejo
    // solo leía la primera).
    if (!textoHorario.includes('/') && (textoHorario.match(/\d{1,2}:\d{2}/g) || []).length > 2)
      avisos.push(`Fila ${filaExcel}: el horario "${textoHorario}" separa franjas con guion; se leyó como ${franjasTexto(horas)}.`);
    // Días que no se entienden: la línea sí entra, con todos los días (así
    // no queda libre un día vendido), pero comercial lo ve en los avisos.
    const { dias, entendido } = leerDias(celda(f, 'dias'));
    if (!entendido)
      avisos.push(`Fila ${filaExcel}: los días "${String(celda(f, 'dias') ?? '').trim()}" no se entienden; se tomaron todos los días.`);
    lineas.push({
      sitio,
      espacio,
      fila: filaExcel,
      slot,
      campana,
      negociacion,
      convencional,
      inicio,
      fin,
      dias,
      horas,
      estatus,
      reservadaHasta: null, // las apartadas del plano no vencen (Erik, 19-oct-2026)
    });
  }
  return { lineas, mes: mesDelPlano(hoja, lineas), slotsVistos, avisos, faltan };
}

/**
 * El mes sale del nombre de la hoja ('PAUTA JUNIO'); el año, de la hoja o
 * del inicio más común de las líneas. Sin mes en la hoja, el mes más común.
 */
export function mesDelPlano(hoja: string, lineas: { inicio: string }[]): string | null {
  const h = norm(hoja);
  const mesHoja = MESES.findIndex((m) => h.includes(m) || (m === 'SEPTIEMBRE' && /\bSEPT?\b|SETIEMBRE/.test(h)));
  const anioHoja = h.match(/\b(20\d{2})\b/)?.[1];
  const moda = (vals: string[]) => {
    const c = new Map<string, number>();
    vals.forEach((v) => c.set(v, (c.get(v) || 0) + 1));
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  if (mesHoja >= 0) {
    const mm = String(mesHoja + 1).padStart(2, '0');
    const anio = anioHoja || moda(lineas.filter((l) => l.inicio.slice(5, 7) === mm).map((l) => l.inicio.slice(0, 4))) || moda(lineas.map((l) => l.inicio.slice(0, 4)));
    return anio ? `${anio}-${mm}` : null;
  }
  return moda(lineas.map((l) => l.inicio.slice(0, 7)));
}
