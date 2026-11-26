// ============================================================
// supabase/functions/sync-sheets/logica.ts
// La parte de sync-sheets que no habla con nadie: qué celdas escribir,
// qué filas agregar y cuáles quitar. Sin Deno ni red, para probarla con
// `node --test` (tests/syncSheets.test.mjs).
// ============================================================

/** Lo que se manda a una celda. Un número se queda número; lo demás, texto. */
export type Celda = string | number;

/** Un renglón de vw_incidencias_sheets. */
export type Fila = {
  record_id: string;
  folio: string;
  unidad_negocio: string | null;
  /** Se escribe como texto tal cual. */
  texto: Record<string, unknown>;
  /** Fechas, tiempos y números: Sheets los convierte. */
  dato: Record<string, unknown>;
};

export type Plan = {
  /** Filas que ya estaban: un rango por cada tramo de columnas que la app conoce. */
  actualizar: { range: string; values: Celda[][] }[];
  /** Cuántos folios ya tenían fila. */
  actualizadas: number;
  /** Filas nuevas, a lo ancho de todos los encabezados. */
  agregar: Celda[][];
  /** Números de fila a quitar (1 = encabezados), de mayor a menor. */
  borrarFilas: number[];
  /** Folios que aparecen más de una vez en la hoja: se actualizó la primera. */
  repetidos: string[];
};

/**
 * Encabezados de la pestaña «App» de la base general, en orden. Cada uno,
 * normalizado, es una llave de vw_incidencias_sheets («Campaña» → campana,
 * «Hora de Reparación» → horadereparacion). Si a una pestaña que ya existe
 * le falta alguno, se agrega al final. «Actualizado (UTC)» lo pone la
 * función: el botón de cada equipo solo trae lo que cambió desde su última
 * vez.
 */
export const ENCABEZADOS_BASE = [
  'Folio', 'Unidad', 'Negocio', 'Estatus Final', 'Estatus Inicial',
  'Fecha Reporte', 'Hora Reporte', 'Semana', 'Catorcena', 'FechaMes', 'Trimestre',
  'Clave de sitio', 'Clave de medio', 'Cara', 'ID', 'Nombre', 'Dirección', 'Alcaldía',
  'Plaza', 'Lado', 'Tipo de máquina', 'Área Reportante', 'Vía de reporte',
  'Incidencia', 'Incidencia Digital', 'Detalle de Incidencia', 'Campaña', 'Afectación', 'Nivel de Incidencia',
  'Origen de Incidencia', 'Causa', 'Área Responsable', 'Fecha de Reparación',
  'Hora de Reparación', 'Detalle de Reparación', 'Tiempo', 'TiempoHoras',
  'Correo', 'Teléfono', 'Actualizado (UTC)',
];

/** Llave de la marca de escritura («Actualizado (UTC)»). */
export const CLAVE_ACTUALIZADO = 'actualizadoutc';

/** Los de ENCABEZADOS_BASE que no están en la fila de encabezados. */
export function faltantes(encabezados: unknown[]): string[] {
  const hay = new Set(encabezados.map(normalizarEncabezado));
  return ENCABEZADOS_BASE.filter((h) => !hay.has(normalizarEncabezado(h)));
}

/**
 * «Área Responsable» → «arearesponsable». Sin acentos, espacios ni signos,
 * igual que las llaves de vw_incidencias_sheets: así «Alcaldía/Municipio»,
 * «Dirección » (con espacio al final) o un acento de menos no rompen nada.
 */
export function normalizarEncabezado(h: unknown): string {
  return String(h ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** 0 → A, 25 → Z, 26 → AA. */
export function letraColumna(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Nombre de pestaña para un rango A1: entre comillas simples, dobladas por dentro. */
export function nombreHoja(nombre: string): string {
  return `'${nombre.replace(/'/g, "''")}'`;
}

/**
 * Texto para una celda. Siempre con apóstrofo al frente: con USER_ENTERED,
 * Sheets convertiría «=HYPERLINK(…)» en fórmula (un reporte con eso se
 * ejecutaría al abrir la hoja), «+52 55…» o «007» en número y «1/2» en
 * fecha. El apóstrofo deja el valor como texto y Sheets no lo enseña.
 */
export function celdaTexto(v: unknown): Celda {
  if (v == null) return '';
  const s = String(v);
  return s === '' ? '' : "'" + s;
}

/** Fecha (AAAA-MM-DD), tiempo (h:mm:ss) o número: Sheets lo interpreta. */
export function celdaDato(v: unknown): Celda {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  return String(v);
}

/**
 * Valor para un encabezado ya normalizado. `undefined` = la app no conoce
 * ese encabezado (Seguimiento, Ruta…): esa columna no se toca.
 */
export function valorPara(clave: string, fila: Fila): Celda | undefined {
  if (clave === '') return undefined;
  if (Object.prototype.hasOwnProperty.call(fila.dato, clave)) return celdaDato(fila.dato[clave]);
  if (Object.prototype.hasOwnProperty.call(fila.texto, clave)) return celdaTexto(fila.texto[clave]);
  return undefined;
}

/**
 * Archivo de una unidad en SHEETS_DESTINOS, sin importar mayúsculas,
 * acentos ni espacios («Vía Verde» = «via verde»). null = sin destino.
 */
export function destinoDe(destinos: Record<string, string>, unidad: string | null): string | null {
  const buscada = normalizarEncabezado(unidad);
  if (!buscada) return null;
  for (const [nombre, id] of Object.entries(destinos)) {
    if (normalizarEncabezado(nombre) === buscada && typeof id === 'string' && id.trim()) return id.trim();
  }
  return null;
}

/**
 * Qué hacer en una pestaña: actualizar las filas de los folios que ya
 * están (solo las columnas que la app conoce), agregar los nuevos y quitar
 * los borrados.
 *
 * `encabezados` es la fila 1 y `folios` la columna Folio desde la fila 1
 * (la celda 0 es el propio encabezado), tal como los regresa Sheets.
 */
export function planear(opts: {
  hoja: string;
  encabezados: unknown[];
  folios: unknown[];
  escribir: Fila[];
  borrar: string[];
}): Plan {
  const claves = opts.encabezados.map(normalizarEncabezado);
  if (!claves.includes('folio')) {
    throw new Error('La pestaña no tiene el encabezado «Folio».');
  }

  // Folio → número de fila (la primera vez que aparece).
  const filaDe = new Map<string, number>();
  const repetidos = new Set<string>();
  for (let k = 1; k < opts.folios.length; k++) {
    const f = String(opts.folios[k] ?? '').trim();
    if (!f) continue;
    if (filaDe.has(f)) repetidos.add(f);
    else filaDe.set(f, k + 1);
  }

  const hoja = nombreHoja(opts.hoja);
  const actualizar: Plan['actualizar'] = [];
  const agregar: Celda[][] = [];
  let actualizadas = 0;

  // Si un folio viniera dos veces, gana la última versión.
  const unicos = new Map<string, Fila>();
  for (const f of opts.escribir) unicos.set(String(f.folio).trim(), f);

  for (const [folio, fila] of unicos) {
    const valores = claves.map((c) => valorPara(c, fila));
    const n = filaDe.get(folio);

    if (n === undefined) {
      agregar.push(valores.map((v) => (v === undefined ? '' : v)));
      continue;
    }

    // Tramos seguidos de columnas conocidas: lo de en medio (Seguimiento)
    // no se pisa.
    actualizadas++;
    let j = 0;
    while (j < valores.length) {
      if (valores[j] === undefined) {
        j++;
        continue;
      }
      const desde = j;
      while (j < valores.length && valores[j] !== undefined) j++;
      actualizar.push({
        range: `${hoja}!${letraColumna(desde)}${n}:${letraColumna(j - 1)}${n}`,
        values: [valores.slice(desde, j) as Celda[]],
      });
    }
  }

  // Un folio que se escribe no se quita (dos unidades en el mismo archivo y
  // el folio pasó de una a otra).
  const borrarFilas = [
    ...new Set(
      opts.borrar
        .map((f) => String(f ?? '').trim())
        .filter((f) => !unicos.has(f))
        .map((f) => filaDe.get(f))
        .filter((n): n is number => n !== undefined)
    ),
  ].sort((a, b) => b - a);

  return { actualizar, actualizadas, agregar, borrarFilas, repetidos: [...repetidos] };
}

/** Base64 para URL, sin relleno (el JWT de la cuenta de servicio). */
export function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
