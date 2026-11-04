// ============================================================
// src/lib/menciones.ts
// Menciones con @ en el chat de una incidencia (Erik, 4-nov-2026, a pedido
// de los usuarios): a una persona (@Juan Pérez) o a toda un área (@Digital,
// todos sus técnicos), de la misma unidad que la incidencia.
//
// Aquí solo va la lógica del texto (detectar el @ que se está escribiendo,
// filtrar la lista, insertar la elegida y resaltar en la burbuja). Quién
// queda mencionado lo decide la base: notificar_chat valida cada mención y
// la guarda en chat_menciones — ver supabase/migrations/…_chat_menciones.sql.
// ============================================================
import { sinAcentos } from './helpers';

/** Un renglón de chat_mencionables(): una persona o un área con técnicos. */
export type Mencionable = {
  tipo: 'persona' | 'area';
  /** Correo (persona) o nombre del área. */
  clave: string;
  nombre: string;
  /** Áreas o roles de la persona; número de técnicos del área. */
  detalle: string | null;
};

/** Lo que viaja en `mensajes.menciones`. */
export type MencionElegida =
  | { tipo: 'persona'; email: string; nombre: string }
  | { tipo: 'area'; area: string; nombre: string };

/** El @ que se está escribiendo justo antes del cursor. */
export type TokenMencion = { inicio: number; consulta: string };

/** Máximo de sugerencias a la vista: en el celular no caben más. */
export const MAX_SUGERENCIAS = 8;

/**
 * ¿Hay un @ a medio escribir antes del cursor? Cuenta solo al inicio o
 * después de un espacio (un correo como ana@x.com no abre la lista) y hasta
 * el primer espacio: "@jua" sí, "@juan perez" ya no.
 */
export function tokenMencion(texto: string, cursor: number): TokenMencion | null {
  const antes = texto.slice(0, cursor);
  const m = antes.match(/(^|\s)@([^\s@]{0,30})$/);
  if (!m) return null;
  return { inicio: antes.length - m[2].length - 1, consulta: m[2] };
}

/**
 * Filtra la lista por lo escrito después del @ (sin acentos ni mayúsculas),
 * sin uno mismo. Primero lo que EMPIEZA con lo escrito; las áreas antes que
 * las personas cuando empatan.
 */
export function filtrarMencionables(
  lista: Mencionable[],
  consulta: string,
  yo: string
): Mencionable[] {
  const q = sinAcentos(consulta.trim());
  const mio = yo.toLowerCase();
  const puntaje = (m: Mencionable) => {
    const n = sinAcentos(m.nombre);
    const empieza = n.startsWith(q) || n.split(/\s+/).some((p) => p.startsWith(q));
    return (empieza ? 0 : 2) + (m.tipo === 'area' ? 0 : 1);
  };
  return lista
    .filter((m) => !(m.tipo === 'persona' && m.clave.toLowerCase() === mio))
    .filter(
      (m) =>
        !q ||
        sinAcentos(m.nombre).includes(q) ||
        (m.tipo === 'persona' && sinAcentos(m.clave).includes(q))
    )
    .sort((a, b) => puntaje(a) - puntaje(b) || a.nombre.localeCompare(b.nombre, 'es'))
    .slice(0, MAX_SUGERENCIAS);
}

/** Lo elegido en la lista, en la forma que guarda el mensaje. */
export function aElegida(m: Mencionable): MencionElegida {
  return m.tipo === 'area'
    ? { tipo: 'area', area: m.clave, nombre: m.nombre }
    : { tipo: 'persona', email: m.clave.toLowerCase(), nombre: m.nombre };
}

/**
 * Reemplaza el "@jua" a medio escribir por "@Juan Pérez " y dice dónde queda
 * el cursor. Si lo que sigue ya es un espacio o un signo ("@ju, revisa"), no
 * se agrega otro espacio.
 */
export function insertarMencion(
  texto: string,
  token: TokenMencion,
  cursor: number,
  nombre: string
): { texto: string; cursor: number } {
  // El resto de la palabra si el cursor estaba a la mitad ("@ju|an").
  const despues = texto.slice(cursor).replace(/^[^\s@.,;:!?¿¡)]*/, '');
  const puesto = /^[\s.,;:!?)]/.test(despues) ? `@${nombre}` : `@${nombre} `;
  return {
    texto: texto.slice(0, token.inicio) + puesto + despues,
    cursor: token.inicio + puesto.length,
  };
}

const claveDe = (m: MencionElegida) =>
  m.tipo === 'area' ? `a:${m.area.toLowerCase()}` : `p:${m.email}`;

/**
 * Las menciones que siguen escritas en el texto al enviar (si se borró
 * "@Juan Pérez", ya no se menciona), sin repetir.
 */
export function mencionesVigentes(texto: string, elegidas: MencionElegida[]): MencionElegida[] {
  const vistas = new Set<string>();
  return elegidas.filter((m) => {
    const k = claveDe(m);
    if (vistas.has(k) || !texto.includes(`@${m.nombre}`)) return false;
    vistas.add(k);
    return true;
  });
}

/** Un pedazo del texto de la burbuja: texto suelto o una mención. */
export type ParteTexto = { texto: string; mencion?: MencionElegida };

/** Lee `mensajes.menciones` tal como llega de la base (puede venir cualquier cosa). */
export function leerMenciones(valor: unknown): MencionElegida[] {
  if (!Array.isArray(valor)) return [];
  return valor.flatMap((v): MencionElegida[] => {
    if (!v || typeof v !== 'object') return [];
    const o = v as Record<string, unknown>;
    const nombre = typeof o.nombre === 'string' ? o.nombre.trim() : '';
    if (!nombre) return [];
    if (o.tipo === 'persona' && typeof o.email === 'string')
      return [{ tipo: 'persona', email: o.email.toLowerCase(), nombre }];
    if (o.tipo === 'area' && typeof o.area === 'string')
      return [{ tipo: 'area', area: o.area, nombre }];
    return [];
  });
}

/**
 * Parte el texto en pedazos para resaltar cada "@Nombre" mencionado. Los
 * nombres largos se buscan primero: "@Ana María" no se corta en "@Ana".
 */
export function partesTexto(texto: string, menciones: MencionElegida[]): ParteTexto[] {
  if (!menciones.length || !texto.includes('@')) return [{ texto }];
  const orden = [...menciones].sort((a, b) => b.nombre.length - a.nombre.length);
  const partes: ParteTexto[] = [];
  let suelto = '';
  let i = 0;
  while (i < texto.length) {
    const m =
      texto[i] === '@' ? orden.find((x) => texto.startsWith(`@${x.nombre}`, i)) : undefined;
    if (m) {
      if (suelto) partes.push({ texto: suelto });
      suelto = '';
      partes.push({ texto: `@${m.nombre}`, mencion: m });
      i += m.nombre.length + 1;
    } else {
      suelto += texto[i];
      i += 1;
    }
  }
  if (suelto) partes.push({ texto: suelto });
  return partes;
}

/** ¿Esta mención es directa para mí? (Las de área se resaltan igual que las demás.) */
export function esParaMi(m: MencionElegida, yo: string): boolean {
  return m.tipo === 'persona' && m.email === yo.toLowerCase();
}
