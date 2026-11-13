// ============================================================
// src/lib/inventarioUnidades.ts
// Inventario por unidad de negocio (Erik, 13-nov-2026): la pantalla siempre
// enseña el inventario partido por unidad, con una tarjeta de indicadores por
// cada una, y el coordinador con unidad asignada ve solo la suya.
//
// Ecovallas va en dos tarjetas (Impreso y Digital): son operaciones
// distintas y juntas la digital (107 caras) se pierde entre 3,500 impresas.
// Biobox cuenta sus caras impresas y digitales juntas: son la misma máquina.
//
// El candado del coordinador es SOLO de esta pantalla (Erik, 13-nov-2026):
// rutas, Biobox, incidencias y demás siguen leyendo el inventario completo.
// ============================================================
import { sinAcentos } from './helpers';

export type GrupoInventario = {
  clave: string;
  titulo: string;
  /** Valor de inventario.unidad_negocio. */
  unidad: string;
  /** Valor de inventario.tipo_medio, o null si la tarjeta junta todos. */
  medio: string | null;
};

export const GRUPOS_INVENTARIO: readonly GrupoInventario[] = [
  { clave: 'eco-imp', titulo: 'Ecovallas Impreso', unidad: 'Ecovallas', medio: 'Impreso' },
  { clave: 'eco-dig', titulo: 'Ecovallas Digital', unidad: 'Ecovallas', medio: 'Digital' },
  { clave: 'biobox', titulo: 'Biobox', unidad: 'Biobox', medio: null },
  { clave: 'biobox-pe', titulo: 'Biobox Perú', unidad: 'Biobox Perú', medio: null },
  { clave: 'vv', titulo: 'Vía Verde', unidad: 'Vía Verde', medio: null },
];

/** Fila de rol con lo que hace falta para decidir el alcance. */
export type RolInventario = {
  rol: string;
  unidad_negocio: string | null;
};

const igual = (a: string | null | undefined, b: string | null | undefined) =>
  sinAcentos((a || '').trim()) === sinAcentos((b || '').trim());

/**
 * Tarjeta a la que pertenece una cara. Una Ecovallas sin tipo de medio cuenta
 * como impresa (hoy no hay ninguna: QTM siempre lo trae). Una
 * unidad que no está en la lista arma su propia tarjeta con su nombre, para
 * que una unidad nueva de QTM no desaparezca de la pantalla.
 */
export function grupoDe(c: { unidad_negocio: string | null; tipo_medio: string | null }): GrupoInventario {
  if (igual(c.unidad_negocio, 'Ecovallas')) {
    return GRUPOS_INVENTARIO[igual(c.tipo_medio, 'Digital') ? 1 : 0];
  }
  const g = GRUPOS_INVENTARIO.find((x) => x.medio === null && igual(x.unidad, c.unidad_negocio));
  if (g) return g;
  const u = (c.unidad_negocio || '').trim() || 'Sin unidad';
  return { clave: 'otra:' + u, titulo: u, unidad: u, medio: null };
}

/**
 * Tarjetas que ve el usuario en Inventario.
 *
 *   · manager, o quien no es coordinador (comercial, viewer): todas.
 *   · coordinador sin unidad en alguna de sus filas: todas (Erik, 13-nov-2026).
 *   · coordinador con unidad: solo las de sus unidades. «Biobox» es Biobox
 *     México; Biobox Perú no entra (Erik, 13-nov-2026).
 *
 * Una lista vacía quiere decir que el coordinador tiene una unidad sin
 * inventario (p. ej. una que QTM no maneja): la pantalla lo dice.
 */
export function gruposVisibles(roles: readonly RolInventario[]): GrupoInventario[] {
  if (roles.some((r) => r.rol === 'manager')) return [...GRUPOS_INVENTARIO];
  const coord = roles.filter((r) => r.rol === 'coordinador');
  if (!coord.length || coord.some((r) => !(r.unidad_negocio || '').trim())) {
    return [...GRUPOS_INVENTARIO];
  }
  return GRUPOS_INVENTARIO.filter((g) => coord.some((r) => igual(r.unidad_negocio, g.unidad)));
}

/** ¿Ve todas las tarjetas? (sin candado de unidad). */
export function veTodoElInventario(roles: readonly RolInventario[]): boolean {
  return gruposVisibles(roles).length === GRUPOS_INVENTARIO.length;
}

/** Unidades (inventario.unidad_negocio) que cubren unas tarjetas, sin repetir. */
export function unidadesDe(grupos: readonly GrupoInventario[]): string[] {
  return [...new Set(grupos.map((g) => g.unidad))];
}

/** ¿La cara cae en alguna de estas tarjetas? */
export function caraEnGrupos(
  c: { unidad_negocio: string | null; tipo_medio: string | null },
  grupos: readonly GrupoInventario[]
): boolean {
  const g = grupoDe(c);
  return grupos.some((x) => x.clave === g.clave);
}
