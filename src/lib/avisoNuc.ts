// ============================================================
// src/lib/avisoNuc.ts
// Aviso NUC (Erik, 29-oct-2026): Digital detecta a distancia que el NUC de
// una máquina Biobox está fuera de línea, lo revisa, lo repara y lo vuelve a
// poner en línea; el técnico de Op. Bio Box de la unidad se entera de cada
// paso y ve en el tablero si la máquina está fuera de línea o en revisión.
// Aquí va lo que no toca la red: quién es quién, el estado de cada máquina,
// el orden del tablero y los textos de tiempo. La base repite las mismas
// reglas (nuc_es_digital, nuc_es_tecnico, nuc_puede_ver en las migraciones
// 20261029234311_aviso_nuc y 20261030010610_aviso_nuc_digital_repara): la
// pantalla solo evita ofrecer lo que la base va a rechazar.
// ============================================================
import { UNIDADES_BIOBOX } from './constants';
import { sinAcentos } from './helpers';
import type { Tono } from './tonos';

/** Estado del NUC de una máquina. Sin aviso abierto = en_linea. */
export type EstadoNuc = 'fuera_linea' | 'en_revision' | 'en_linea';

/** tabla `nuc_avisos`. */
export interface AvisoNuc {
  id: number;
  site_id: string;
  unidad_negocio: string;
  maquina: string | null;
  estado: EstadoNuc;
  nota_digital: string | null;
  abierto_por: string;
  abierto_en: string;
  /** Quién de Digital lo está revisando. */
  tomado_por: string | null;
  tomado_en: string | null;
  cerrado_por: string | null;
  cerrado_en: string | null;
  /** Qué hizo Digital para ponerlo en línea. */
  nota_cierre: string | null;
  actualizado_en: string;
}

/** tabla `nuc_avisos_eventos`. */
export interface EventoNuc {
  id: number;
  aviso_id: number;
  accion: 'abierto' | 'tomado' | 'en_linea';
  estado: EstadoNuc;
  por: string;
  en: string;
  nota: string | null;
}

/** Fila de `inventario` que hace falta para el tablero. */
export interface FilaInventarioNuc {
  site_id: string | null;
  site_legacy_id: string | null;
  vendor_face_id: string | null;
  unidad_negocio: string | null;
  tipo_medio: string | null;
  tipo_mueble: string | null;
  direccion: string | null;
  municipio: string | null;
}

/** Una máquina del tablero (una por site_id). */
export interface MaquinaNuc {
  site_id: string;
  nombre: string;
  unidad_negocio: string;
  tipo_mueble: string | null;
  direccion: string | null;
  municipio: string | null;
}

export const ESTADOS_NUC: readonly EstadoNuc[] = ['fuera_linea', 'en_revision', 'en_linea'];

export const ETIQUETA_NUC: Record<EstadoNuc, string> = {
  fuera_linea: 'Fuera de línea',
  en_revision: 'En revisión',
  en_linea: 'En línea',
};

export const TONO_NUC: Record<EstadoNuc, Tono> = {
  fuera_linea: 'rojo',
  en_revision: 'ambar',
  en_linea: 'verde',
};

/** Respuestas rápidas de Digital al ponerlo en línea; también puede escribir la suya. */
export const RESPUESTAS_DIGITAL: readonly string[] = [
  'Se reinició el NUC',
  'Se restableció la red',
  'Volvió solo',
  'Se reinstaló el software',
];

type Rol = { rol: string; unidad_negocio: string | null; departamento: string | null };

const igual = (a: string | null | undefined, b: string) =>
  sinAcentos((a || '').trim()) === sinAcentos(b);

/** Digital: técnico con área Digital de cualquier unidad, o el manager. */
export function esDigitalNuc(roles: Rol[]): boolean {
  return roles.some((r) => r.rol === 'manager' || (r.rol === 'reparacion' && igual(r.departamento, 'digital')));
}

/**
 * Técnico de la máquina (recibe los avisos): técnico de Op. Bio Box de la
 * unidad, coordinador de la unidad sin área o de Op. Bio Box, o el manager.
 * Fila sin unidad = todas.
 */
export function esTecnicoNuc(roles: Rol[], unidad: string): boolean {
  return roles.some((r) => {
    if (r.rol === 'manager') return true;
    if (r.unidad_negocio && !igual(r.unidad_negocio, unidad)) return false;
    if (r.rol === 'reparacion') return igual(r.departamento, 'op. bio box');
    if (r.rol === 'coordinador') return !r.departamento || igual(r.departamento, 'op. bio box');
    return false;
  });
}

/**
 * Validador de la unidad (Erik, 29-oct-2026): también recibe los avisos y ve
 * el tablero, sin botones. Solo con esa unidad exacta, como la base.
 */
export function esValidadorNuc(roles: Rol[], unidad: string): boolean {
  return roles.some((r) => r.rol === 'validador' && !!r.unidad_negocio && igual(r.unidad_negocio, unidad));
}

/**
 * Unidades Biobox cuyo tablero puede abrir: Digital, manager y Consulta ven
 * las dos; el técnico, el coordinador y el validador, las de sus filas.
 * Lista vacía = no ve el módulo.
 */
export function unidadesAvisoNuc(roles: Rol[]): string[] {
  if (esDigitalNuc(roles) || roles.some((r) => r.rol === 'viewer')) return [...UNIDADES_BIOBOX];
  return UNIDADES_BIOBOX.filter(
    (u) =>
      esTecnicoNuc(roles, u) ||
      esValidadorNuc(roles, u) ||
      roles.some((r) => r.rol === 'coordinador' && (!r.unidad_negocio || igual(r.unidad_negocio, u)))
  );
}

/**
 * Una máquina por site_id. El nombre y el mueble salen de la cara digital si
 * la hay (como nuc_aviso_abrir), si no de la primera.
 */
export function maquinasDeInventario(filas: FilaInventarioNuc[]): MaquinaNuc[] {
  const porSitio = new Map<string, FilaInventarioNuc>();
  for (const f of filas) {
    if (!f.site_id) continue;
    const previa = porSitio.get(f.site_id);
    if (!previa || (previa.tipo_medio !== 'Digital' && f.tipo_medio === 'Digital')) porSitio.set(f.site_id, f);
  }
  return [...porSitio.values()].map((f) => ({
    site_id: f.site_id as string,
    nombre: f.site_legacy_id || (f.site_id as string),
    unidad_negocio: f.unidad_negocio || '',
    tipo_mueble: f.tipo_mueble,
    direccion: f.direccion,
    municipio: f.municipio,
  }));
}

/** Estado del NUC: el del aviso abierto, o en línea si no hay. */
export function estadoNuc(aviso: Pick<AvisoNuc, 'estado'> | null | undefined): EstadoNuc {
  return aviso && aviso.estado !== 'en_linea' ? aviso.estado : 'en_linea';
}

/** Cuántas máquinas hay en cada estado. */
export function contarEstados(
  maquinas: Pick<MaquinaNuc, 'site_id'>[],
  avisos: Map<string, Pick<AvisoNuc, 'estado'>>
): Record<EstadoNuc, number> {
  const n: Record<EstadoNuc, number> = { fuera_linea: 0, en_revision: 0, en_linea: 0 };
  for (const m of maquinas) n[estadoNuc(avisos.get(m.site_id))]++;
  return n;
}

const PESO: Record<EstadoNuc, number> = { fuera_linea: 0, en_revision: 1, en_linea: 2 };

/**
 * Orden del tablero: primero las fuera de línea (la más vieja arriba: es la
 * que más lleva esperando), luego en revisión y al final las en línea por
 * clave del mueble, que es lo que el tablero enseña arriba.
 */
export function ordenarTablero<M extends Pick<MaquinaNuc, 'site_id'>>(
  maquinas: M[],
  avisos: Map<string, Pick<AvisoNuc, 'estado' | 'actualizado_en'>>
): M[] {
  return maquinas.slice().sort((a, b) => {
    const aa = avisos.get(a.site_id);
    const ab = avisos.get(b.site_id);
    const d = PESO[estadoNuc(aa)] - PESO[estadoNuc(ab)];
    if (d) return d;
    if (aa && ab && aa.estado !== 'en_linea') {
      const t = Date.parse(aa.actualizado_en) - Date.parse(ab.actualizado_en);
      if (t) return t;
    }
    return a.site_id.localeCompare(b.site_id, undefined, { numeric: true });
  });
}

/** 'hace 5 min', 'hace 2 h 15 min', 'hace 3 días'. Para leerse rápido. */
export function haceCuanto(iso: string | null | undefined, ahora: number = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const min = Math.max(0, Math.floor((ahora - ms) / 60000));
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
  const dias = Math.floor(h / 24);
  return `hace ${dias} día${dias === 1 ? '' : 's'}`;
}

/**
 * Número del menú: al técnico y al validador, cuántas de sus unidades están
 * fuera de línea o en revisión (lo que necesitan saber); a Digital, cuántas
 * siguen fuera de línea sin que nadie las revise (lo que le toca atender).
 * Cada aviso cuenta una vez aunque la persona sea varias cosas.
 */
export function pendientesNuc(
  avisos: Pick<AvisoNuc, 'estado' | 'unidad_negocio'>[],
  roles: Rol[]
): number {
  const digital = esDigitalNuc(roles);
  return avisos.filter(
    (a) =>
      (a.estado !== 'en_linea' &&
        (esTecnicoNuc(roles, a.unidad_negocio) || esValidadorNuc(roles, a.unidad_negocio))) ||
      (a.estado === 'fuera_linea' && digital)
  ).length;
}

/** Busca por nombre visible, clave o dirección, sin acentos. */
export function coincideMaquina(m: MaquinaNuc, q: string): boolean {
  const t = sinAcentos(q.trim());
  return !t || sinAcentos([m.nombre, m.site_id, m.direccion, m.municipio].join(' ')).includes(t);
}
