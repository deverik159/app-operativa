// ============================================================
// src/lib/tonos.ts
// Colores de estatus que se leen en los dos temas (tema claro/oscuro,
// 24-sep-2026).
//
// POR QUÉ EXISTE: los estatus (EST_COLOR, NIVEL_COLOR, los relojes de SLA,
// los chips) se pintan con hex fijos pensados para fondo negro: texto en el
// color y fondo `color + '22'`. Sobre blanco, el ámbar #f59e0b y el verde
// #22c55e dan 2.2:1 y al sol no se leen. Aquí se separa el TONO semántico
// (rojo, ámbar…) del color PINTADO: cada tono es una variable CSS
// (--st-<tono>, -fondo, -borde) que index.css define para cada tema.
//
// OJO: la lógica que COMPARA colores (slaInfo devuelve '#ef4444' y
// IncidenciasView pregunta `reloj.color === '#ef4444'`) sigue recibiendo y
// comparando los hex de siempre. Esto solo cambia cómo se pinta: se llama
// al final, en el `style`, nunca antes de comparar.
// ============================================================

export type Tono = 'rojo' | 'ambar' | 'verde' | 'azul' | 'morado' | 'gris' | 'acento';

/**
 * Los hex de la paleta de siempre y su tono. Un color que no esté aquí no
 * se toca (quien llama se queda con su color): mejor un color de más que
 * adivinar el tono de uno que no conocemos.
 */
const TONO_POR_HEX: Record<string, Tono> = {
  '#ef4444': 'rojo',
  '#dc2626': 'rojo',
  '#f59e0b': 'ambar',
  '#22c55e': 'verde',
  '#4f8cff': 'azul',
  '#3b82f6': 'azul',
  '#a78bfa': 'morado',
  '#6b7280': 'gris',
  '#9ca3af': 'gris',
  '#ff5a3c': 'acento',
};

/** #rrggbb, con o sin alfa (#rrggbbaa: el `color + '22'` de siempre). */
const RE_HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

/**
 * El tono de un hex de la paleta, o null si no es de la paleta. Ignora
 * mayúsculas, espacios y el sufijo de alfa ('#EF444422' → 'rojo').
 */
export function tonoDe(hex: string | null | undefined): Tono | null {
  if (typeof hex !== 'string') return null;
  const h = hex.trim().toLowerCase();
  if (!RE_HEX.test(h)) return null;
  return TONO_POR_HEX[h.slice(0, 7)] ?? null;
}

/** Color para TEXTO, borde o ícono: legible en los dos temas. */
export function colorTono(t: Tono): string {
  return `var(--st-${t})`;
}

/** Tinte de fondo (el equivalente del `color + '22'` de hoy). */
export function fondoTono(t: Tono): string {
  return `var(--st-${t}-fondo)`;
}

/** Borde del tinte (el equivalente del `color + '55'` de hoy). */
export function bordeTono(t: Tono): string {
  return `var(--st-${t}-borde)`;
}

/**
 * Atajo para chips y pastillas: si el hex es de la paleta, las tres
 * variables del tono; si no, null y quien llama deja su color de siempre.
 */
export function pintar(
  hex: string | null | undefined
): { color: string; background: string; borderColor: string } | null {
  const t = tonoDe(hex);
  if (!t) return null;
  return { color: colorTono(t), background: fondoTono(t), borderColor: bordeTono(t) };
}

/** Solo el color de texto: el del tono, o el hex tal cual si no es de la paleta. */
export function pintarTexto(hex: string | null | undefined): string {
  const t = tonoDe(hex);
  return t ? colorTono(t) : hex ?? '';
}
