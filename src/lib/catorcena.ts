// ============================================================
// src/lib/catorcena.ts
// La catorcena es NÚMERO + AÑO (Erik, 14-oct-2026).
//
// Hasta el 14-oct-2026 la app la identificaba solo por su número (1..26).
// Con 2027 en el calendario la Cat-1 de 2027 chocaría con la de 2026: el
// selector las juntaría, "la más reciente" ordenada por número sería la
// Cat-26 de 2026 aunque la Cat-1 de 2027 ya hubiera empezado, y la ventana
// de Nueva incidencia se iría a enero. Por eso aquí:
//   · se ordena por FECHA, no por número;
//   · las llaves de los selectores llevan el año ("2027-1");
//   · en pantalla se lee "Cat-1 · 2027".
//
// OJO con el año: es el del calendario OFICIAL, no siempre el de sus fechas
// (la Cat-27 de 2025 terminó el 5-ene-2026; la Cat-1 de 2024 empezó el
// 26-dic-2023). La base lo guarda en la columna `anio`; la numeración por
// año es irregular y no se calcula.
// ============================================================

/** Lo mínimo para ubicar una catorcena. */
export type CatConAnio = {
  numero: number;
  /** Del calendario oficial. Las copias del teléfono anteriores al 14-oct-2026 no lo traen. */
  anio?: number | null;
  fecha_inicio?: string | null;
  fecha_fin?: string | null;
};

const DIA = 86400000;

/** 'YYYY-MM-DD…' → ms UTC de ese día, o null. */
function msDia(iso: string | null | undefined): number | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const ms = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * El año de una catorcena. Si la fila no lo trae (copia vieja del
 * teléfono), se toma el año del DÍA DE EN MEDIO de sus fechas: acierta en
 * todo el calendario 2026 (la Cat-26 va del 22-dic-2026 al 4-ene-2027 y su
 * mitad cae en 2026). Es solo un respaldo: la copia se vuelve a bajar con
 * el año en cuanto hay red.
 */
export function anioDe(c: CatConAnio): number | null {
  if (c.anio != null && Number.isFinite(Number(c.anio))) return Number(c.anio);
  const a = msDia(c.fecha_inicio);
  const b = msDia(c.fecha_fin);
  if (a == null || b == null) return null;
  return new Date(a + Math.floor((b - a) / DIA / 2) * DIA).getUTCFullYear();
}

/** "Cat-1 · 2027" (o "Cat-1" si no se sabe el año). */
export function etiquetaCatorcena(numero: number | string, anio?: number | string | null): string {
  return anio != null && anio !== '' ? `Cat-${numero} · ${anio}` : `Cat-${numero}`;
}

/** Llave de selector: "2027-1". */
export function claveCatorcena(anio: number, numero: number): string {
  return `${anio}-${numero}`;
}

/** "2027-1" → { anio: 2027, numero: 1 }, o null si no es una llave. */
export function leerClaveCatorcena(clave: string | null | undefined): { anio: number; numero: number } | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec(clave || '');
  return m ? { anio: Number(m[1]), numero: Number(m[2]) } : null;
}

/**
 * Orden cronológico (la más vieja primero): por fecha de inicio; sin fechas,
 * por año y número.
 */
export function compararCatorcenas(a: CatConAnio, b: CatConAnio): number {
  const fa = a.fecha_inicio || '';
  const fb = b.fecha_inicio || '';
  if (fa && fb && fa !== fb) return fa < fb ? -1 : 1;
  return (anioDe(a) ?? 0) - (anioDe(b) ?? 0) || a.numero - b.numero;
}

/**
 * El año de la catorcena `numero` más cercana a `fechaRef` ('YYYY-MM-DD';
 * hoy si no se da), buscándola en el calendario. Es lo mismo que hace la
 * base con anio_de_catorcena() para quien no manda el año. null si ese
 * número no está en el calendario.
 */
export function anioMasCercano(
  calendario: CatConAnio[],
  numero: number,
  fechaRef?: string | null
): number | null {
  const ref = msDia(fechaRef) ?? Date.now();
  let mejor: { anio: number; d: number } | null = null;
  for (const c of calendario) {
    if (Number(c.numero) !== numero) continue;
    const anio = anioDe(c);
    const ini = msDia(c.fecha_inicio);
    if (anio == null || ini == null) continue;
    const d = Math.abs(ini - ref);
    if (!mejor || d < mejor.d) mejor = { anio, d };
  }
  return mejor ? mejor.anio : null;
}

/**
 * De dos números de catorcena vecinos, ¿cuál es el más reciente? En el
 * cambio de año el archivo de la Cat-1 trae también la columna de la
 * Cat-26 (o 27) anterior: el número mayor NO es el más reciente. Dos
 * catorcenas a más de medio año de distancia se toman como de años
 * distintos, y entonces la de número chico es la nueva.
 */
export function esMasReciente(a: number, b: number): boolean {
  if (Math.abs(a - b) > 13) return a < b;
  return a > b;
}
