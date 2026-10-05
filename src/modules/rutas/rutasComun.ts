// ============================================================
// src/modules/rutas/rutasComun.ts
// Tipos y utilidades que comparten RutasView y sus modales (armado de
// ruta, vista previa del Excel, asignación de monitoristas, avance de
// visitas) — (rutas, 5-oct-2026).
//
// Nada de React aquí: funciones puras y lecturas a la base con tope.
// ============================================================
import { sb } from '../../lib/supabase';
import { tope } from '../../lib/envios';
import { pareceSinRed } from '../../lib/enLinea';
import { sinAcentos } from '../../lib/helpers';

/** Fila de vw_rutas_con_coords. Las 4 últimas las agrega la migración
 *  20261005155712_rutas_armado_visitas.sql (al FINAL de la vista); mientras
 *  no esté aplicada no vienen, por eso son opcionales y todo cae a
 *  `direccion_archivo` como antes. */
export type Ubic = {
  ubicacion_id: number;
  ruta_id: number;
  ruta_numero: number;
  ruta_nombre: string | null;
  ruta_color: string;
  ruta_unidad: string;
  ruta_tipo: string;
  ruta_activa: boolean;
  site_id: string;
  secuencia: number | null;
  estatus_archivo: string | null;
  vallas_archivo: number | null;
  direccion_archivo: string | null;
  caras_reales: number | null;
  latitud: number | null;
  longitud: number | null;
  municipio: string | null;
  sin_match_inventario: boolean;
  direccion_qtm?: string | null;
  direccion_fuente?: 'qtm' | 'archivo' | null;
  direccion?: string | null;
  origen?: string | null;
};

export type Resumen = {
  id: number;
  numero: number;
  nombre: string | null;
  color: string;
  unidad_negocio: string;
  tipo_medio: string;
  activa: boolean;
  total_ubicaciones: number;
  retiradas: number;
  inhabilitadas: number;
};

/** La dirección que se muestra de una parada: la ELEGIDA (columna
 *  `direccion` de la vista) y, si la vista aún no la trae, la del archivo. */
export function direccionElegida(u: Ubic): string {
  if (u.direccion != null) return u.direccion;
  return u.direccion_archivo || u.direccion_qtm || '';
}

/** ¿Hay que enseñar la de QTM en gris debajo? Solo si se eligió la del
 *  archivo y de verdad dicen otra cosa (no por un acento o una abreviatura). */
export function qtmDistinta(u: Ubic): string | null {
  if (u.direccion_fuente !== 'archivo') return null;
  const q = (u.direccion_qtm || '').trim();
  if (!q) return null;
  return mismaDireccion(q, direccionElegida(u)) ? null : q;
}

/** Ecovallas Impreso: ahí manda la pauta (Pauta → Sincronizar rutas) y las
 *  paradas NO se arman a mano (Erik, 5-oct-2026). */
export function esSegmentoDePauta(unidad: string, tipo: string): boolean {
  return unidad === 'Ecovallas' && tipo === 'Impreso';
}

// ------------------------------------------------------------
// Direcciones: comparar sin marcar diferencias falsas
// ------------------------------------------------------------

/** Abreviaturas que se escriben de mil formas. Cada entrada: forma larga o
 *  variante → forma corta. Se aplican por PALABRA completa. */
const ABREVIATURAS: [RegExp, string][] = [
  [/\bBOULEVARD\b|\bBOULEVAR\b|\bBULEVAR\b|\bBLV\b|\bBLVR\b/g, 'BLVD'],
  [/\bAVENIDA\b|\bAVE\b|\bAVDA\b/g, 'AV'],
  [/\bCALLE\b|\bCLL\b/g, 'C'],
  [/\bCALZADA\b/g, 'CALZ'],
  [/\bCARRETERA\b|\bCARRET\b/g, 'CARR'],
  [/\bPROLONGACION\b/g, 'PROL'],
  [/\bESQUINA\b/g, 'ESQ'],
  [/\bCOLONIA\b/g, 'COL'],
  [/\bANILLO PERIFERICO\b|\bPERIFERICO\b/g, 'PERIF'],
  [/\bCIRCUITO\b/g, 'CTO'],
  [/\bPRIVADA\b/g, 'PRIV'],
  [/\bCERRADA\b/g, 'CDA'],
  [/\bANDADOR\b/g, 'AND'],
  [/\bGENERAL\b/g, 'GRAL'],
  [/\bLICENCIADO\b/g, 'LIC'],
  [/\bINGENIERO\b/g, 'ING'],
  [/\bDOCTOR\b/g, 'DR'],
  [/\bSANTA\b/g, 'STA'],
  [/\bSANTO\b/g, 'STO'],
  [/\bSAN\b/g, 'S'],
  [/\bNORTE\b/g, 'NTE'],
  [/\bPONIENTE\b/g, 'PTE'],
  [/\bORIENTE\b/g, 'OTE'],
  [/\bCIUDAD DE MEXICO\b|\bMEXICO D F\b|\bD F\b/g, 'CDMX'],
  [/\bESTADO DE MEXICO\b|\bEDO MEX\b|\bEDO DE MEX\b/g, 'EDOMEX'],
  // "S N", "S/N", "SN", "SIN NUMERO": todo es "sin número".
  [/\bS N\b|\bSIN NUMERO\b|\bSIN NUM\b/g, 'SN'],
  // "No. 15", "Num 15", "Número 15", "#15": el número sin la palabra.
  [/\bNUMERO\b|\bNUM\b|\bNO\b/g, ''],
];

/**
 * Forma comparable de una dirección: sin acentos, en mayúsculas, sin
 * signos, con las abreviaturas de siempre unificadas y un solo espacio.
 * Solo sirve para COMPARAR; nunca se muestra ni se guarda.
 */
export function normalizarDireccion(s: string | null | undefined): string {
  let t = sinAcentos(s || '').toUpperCase();
  // Signos → espacio ("S/N" → "S N", "No." → "NO", "#15" → " 15").
  t = t.replace(/[^A-Z0-9Ñ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, corta] of ABREVIATURAS) t = t.replace(re, corta);
  return t.replace(/\s+/g, ' ').trim();
}

/** ¿Dicen lo mismo? (vacías las dos también cuenta como igual). */
export function mismaDireccion(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizarDireccion(a) === normalizarDireccion(b);
}

// ------------------------------------------------------------
// Colores de ruta (los elige el coordinador: identidad de la ruta, no tema)
// ------------------------------------------------------------

const RE_HEX = /^#[0-9a-fA-F]{6}$/;

/** El color de la ruta solo si es un #rrggbb válido; si no, el acento. Se
 *  usa DENTRO de HTML de Leaflet, así que nunca se mete texto sin validar. */
export function colorSeguro(c: string | null | undefined): string {
  const t = (c || '').trim();
  return RE_HEX.test(t) ? t : '#ff5a3c';
}

/** Luminancia relativa WCAG (sRGB linealizado) de un #rrggbb. */
function luminancia(hex: string): number {
  const h = hex.slice(1);
  const canal = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * canal(0) + 0.7152 * canal(2) + 0.0722 * canal(4);
}

/** Texto negro o blanco, el que MÁS contraste dé sobre el color de la ruta.
 *  (rutas, 5-oct-2026, QA) El umbral aproximado de antes ponía blanco sobre
 *  el turquesa, el verde y el acento de la paleta (2.3–3.1:1, no se leía al
 *  sol); ahora se mide el contraste real contra los dos y gana el mayor. */
export function textoSobre(c: string): string {
  const L = luminancia(colorSeguro(c));
  const contra = (otro: number) => (Math.max(L, otro) + 0.05) / (Math.min(L, otro) + 0.05);
  const NEGRO = luminancia('#151515');
  return contra(NEGRO) >= contra(1) ? '#151515' : '#ffffff';
}

// ------------------------------------------------------------
// Lecturas con tope y paginadas
// ------------------------------------------------------------

/** Tope por página: una red lenta corta y avisa, nunca deja colgada la UI. */
export const TOPE_PAGINA_MS = 20000;
/** Tope de una RPC de escritura (guardar paradas, importar). */
export const TOPE_RPC_MS = 30000;
/** Tope de una lectura corta (una catorcena, las asignaciones). */
export const TOPE_LECTURA_MS = 12000;

export type Paginado<T> = { filas: T[]; error: string | null; sinRed: boolean };

type RespPg = { data: unknown; error: { message: string } | null; status: number };

/**
 * Trae TODAS las filas de una consulta, de 1000 en 1000 (el tope de
 * PostgREST corta en silencio en 1000). La consulta DEBE llevar un orden
 * estable; aquí se le pone `.range` y el tope por página.
 */
export async function traerPaginado<T>(
  pagina: (desde: number, hasta: number, senal: AbortSignal) => PromiseLike<RespPg>,
  op?: { tam?: number; maxPaginas?: number; topeMs?: number }
): Promise<Paginado<T>> {
  const tam = op?.tam ?? 1000;
  const maxPaginas = op?.maxPaginas ?? 40;
  const filas: T[] = [];
  for (let i = 0; i < maxPaginas; i++) {
    let r: RespPg;
    try {
      r = await pagina(i * tam, i * tam + tam - 1, tope(op?.topeMs ?? TOPE_PAGINA_MS));
    } catch (e) {
      return { filas, error: e instanceof Error ? e.message : String(e), sinRed: pareceSinRed(e) };
    }
    if (r.error || r.status === 0) {
      return {
        filas,
        error: r.error?.message || 'Sin señal',
        sinRed: r.status === 0 || pareceSinRed(r.error, r.status),
      };
    }
    const d = (r.data as T[]) || [];
    filas.push(...d);
    if (d.length < tam) break;
  }
  return { filas, error: null, sinRed: false };
}

/** Parte un arreglo en trozos (para `.in()` sin URLs gigantes). */
export function trozos<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** El correo de la sesión, con tope (getSession puede esperar a una
 *  renovación de token colgada). '' si no hay o no contestó a tiempo. */
export async function correoDeSesion(ms = 3000): Promise<string> {
  try {
    const r = await Promise.race([
      sb.auth.getSession(),
      new Promise<null>((res) => setTimeout(() => res(null), ms)),
    ]);
    return ((r && r.data.session?.user?.email) || '').toLowerCase();
  } catch {
    return '';
  }
}

/** Texto para el usuario de una falla de red/servidor. */
export function textoFalla(error: string | null, sinRed: boolean): string {
  if (sinRed) return 'Sin señal o la red tardó demasiado. Vuelve a intentarlo cuando tengas señal.';
  return error || 'Algo falló.';
}

// ------------------------------------------------------------
// Catorcenas
// ------------------------------------------------------------

export type Catorcena = { numero: number; fecha_inicio: string | null; fecha_fin: string | null };

/** 'yyyy-mm-dd' (fecha local de la catorcena) → Date a las 00:00 locales. */
export function inicioDelDia(fecha: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha || '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** La catorcena que contiene hoy; si ninguna, la más reciente que ya empezó;
 *  si tampoco, la de número más alto. */
export function catorcenaActual(cats: Catorcena[], hoy = new Date()): Catorcena | null {
  const t = hoy.getTime();
  const con = cats.filter((c) => c.fecha_inicio && c.fecha_fin);
  const dentro = con.find((c) => {
    const a = inicioDelDia(c.fecha_inicio!);
    const b = inicioDelDia(c.fecha_fin!);
    return a && b && t >= a.getTime() && t < b.getTime() + 86400000;
  });
  if (dentro) return dentro;
  const empezadas = con
    .filter((c) => (inicioDelDia(c.fecha_inicio!)?.getTime() ?? Infinity) <= t)
    .sort((a, b) => b.numero - a.numero);
  if (empezadas[0]) return empezadas[0];
  return cats.slice().sort((a, b) => b.numero - a.numero)[0] || null;
}

/** "12 sep – 25 sep" para el selector. */
export function rangoCorto(c: Catorcena): string {
  const f = (s: string | null) => {
    const d = s ? inicioDelDia(s) : null;
    return d ? d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) : '?';
  };
  return `${f(c.fecha_inicio)} – ${f(c.fecha_fin)}`;
}
