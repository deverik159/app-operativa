// ============================================================
// src/lib/indicadoresPauta.ts
// Cálculos de la pestaña Indicadores de Pauta y Monitoreo (Erik,
// 14-oct-2026): el avance de la catorcena y las comprobaciones agrupadas.
//
// Funciones puras sobre las filas de vw_pauta_ruta que ya tiene la
// pantalla: no consultan nada, así se prueban sin base (ver
// tests/indicadoresPauta.test.mjs).
//
// Estados de una cara (los mismos que la lista de Pauta):
//   · comprobada  → el coordinador la validó (fecha_comprobacion).
//   · tomada      → el monitorista registró la toma y falta validarla.
//   · pendiente   → sin toma vigente. Incluye las REGRESADAS (el
//                   coordinador regresó la toma con motivo y hay que
//                   repetirla), que además se cuentan aparte.
//
// OJO: vw_pauta_ruta trae un renglón por cada VERSIÓN de la pauta, así que
// una cara puede venir dos o tres veces (en la Cat-16 de 2026: 1,196
// renglones para 1,187 caras). La toma y las fotos son por cara, así que
// aquí se cuenta y se agrupa por cara única (vendor_face_id).
// ============================================================
import { diaCdmx } from './fechasCdmx';

/** Lo que estos cálculos leen de una fila de vw_pauta_ruta. */
export type FilaIndicador = {
  site_id: string;
  vendor_face_id: string;
  cara: string | null;
  ruta_clave: string | null;
  campana: string | null;
  fecha_toma: string | null;
  toma_por: string | null;
  fecha_comprobacion: string | null;
  rechazo_motivo?: string | null;
  /** Orden de la parada en la ruta (el del recorrido). */
  secuencia?: number | null;
};

/** Una fila por cara (la primera versión que llegue). */
export function carasUnicas<T extends FilaIndicador>(filas: T[]): T[] {
  const vistas = new Set<string>();
  return filas.filter((f) => !vistas.has(f.vendor_face_id) && !!vistas.add(f.vendor_face_id));
}

export type Conteo = {
  caras: number;
  sitios: number;
  pendientes: number;
  tomadas: number;
  comprobadas: number;
  regresadas: number;
  /** Comprobadas sobre caras, 0..100 sin decimales. */
  pct: number;
};

export function estadoCara(f: FilaIndicador): 'COMPROBADA' | 'TOMADA' | 'PENDIENTE' {
  if (f.fecha_comprobacion) return 'COMPROBADA';
  if (f.fecha_toma) return 'TOMADA';
  return 'PENDIENTE';
}

export function esRegresada(f: FilaIndicador): boolean {
  return !f.fecha_comprobacion && !f.fecha_toma && !!(f.rechazo_motivo || '').trim();
}

export function contar(todas: FilaIndicador[]): Conteo {
  const filas = carasUnicas(todas);
  const c: Conteo = { caras: filas.length, sitios: 0, pendientes: 0, tomadas: 0, comprobadas: 0, regresadas: 0, pct: 0 };
  const sitios = new Set<string>();
  for (const f of filas) {
    sitios.add(f.site_id);
    const e = estadoCara(f);
    if (e === 'COMPROBADA') c.comprobadas++;
    else if (e === 'TOMADA') c.tomadas++;
    else c.pendientes++;
    if (esRegresada(f)) c.regresadas++;
  }
  c.sitios = sitios.size;
  // Hacia abajo: 199 de 200 no debe decir 100%.
  c.pct = !c.caras ? 0 : c.comprobadas === c.caras ? 100 : Math.floor((c.comprobadas / c.caras) * 100);
  return c;
}

/** Nombre a mostrar de una ruta del archivo ("1" → "Ruta 1"). */
export function nombreRuta(clave: string | null): string {
  if (!clave) return 'Sin ruta';
  return /^\d+$/.test(clave) ? `Ruta ${clave}` : clave;
}

/** Rutas numéricas en orden y luego las foráneas (PLAZA, EDOMEX) y sin ruta. */
function compararRutas(a: string | null, b: string | null): number {
  const na = a && /^\d+$/.test(a) ? Number(a) : Infinity;
  const nb = b && /^\d+$/.test(b) ? Number(b) : Infinity;
  if (na !== nb) return na - nb;
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return a.localeCompare(b, 'es');
}

export const SIN_CAMPANA = '(sin campaña)';

export type FilaPorMonitorista = {
  correo: string;
  /** Tomas registradas (vigentes): tomadas + comprobadas. */
  tomas: number;
  comprobadas: number;
  sitios: number;
};

export type Avance = {
  total: Conteo;
  porRuta: ({ ruta: string | null } & Conteo)[];
  porCampana: ({ campana: string } & Conteo)[];
  porMonitorista: FilaPorMonitorista[];
};

export function avancePauta(todas: FilaIndicador[]): Avance {
  const porRuta = new Map<string, FilaIndicador[]>();
  const porCampana = new Map<string, FilaIndicador[]>();
  const porMon = new Map<string, FilaIndicador[]>();
  // Por campaña con TODAS las versiones (contar() quita las repetidas de
  // cada campaña); lo demás, por cara única.
  for (const f of todas) {
    const c = (f.campana || '').trim() || SIN_CAMPANA;
    porCampana.set(c, [...(porCampana.get(c) || []), f]);
  }
  const filas = carasUnicas(todas);
  for (const f of filas) {
    const r = f.ruta_clave || '';
    porRuta.set(r, [...(porRuta.get(r) || []), f]);
    if (f.fecha_toma && f.toma_por) {
      const m = f.toma_por.toLowerCase();
      porMon.set(m, [...(porMon.get(m) || []), f]);
    }
  }
  return {
    total: contar(filas),
    porRuta: [...porRuta.entries()]
      .map(([ruta, fs]) => ({ ruta: ruta || null, ...contar(fs) }))
      .sort((a, b) => compararRutas(a.ruta, b.ruta)),
    porCampana: [...porCampana.entries()]
      .map(([campana, fs]) => ({ campana, ...contar(fs) }))
      .sort((a, b) => b.caras - a.caras || a.campana.localeCompare(b.campana, 'es')),
    porMonitorista: [...porMon.entries()]
      .map(([correo, fs]) => ({
        correo,
        tomas: fs.length,
        comprobadas: fs.filter((f) => !!f.fecha_comprobacion).length,
        sitios: new Set(fs.map((f) => f.site_id)).size,
      }))
      .sort((a, b) => b.tomas - a.tomas || a.correo.localeCompare(b.correo)),
  };
}

/** Día (CDMX) en que se tomó; si no hay toma registrada, el de la comprobación. */
export function diaDeToma(f: FilaIndicador): string {
  if (f.fecha_toma) return diaCdmx(f.fecha_toma);
  if (f.fecha_comprobacion) return diaCdmx(f.fecha_comprobacion);
  return '';
}

export type GrupoDia<T> = { dia: string; filas: T[] };
export type GrupoCampana<T> = { campana: string; total: number; dias: GrupoDia<T>[] };

/**
 * Comprobaciones agrupadas por campaña y por DÍA EN QUE SE TOMÓ (Erik,
 * 14-oct-2026). Solo entran las comprobadas: nada sin validar sale por
 * correo. Campañas de más caras primero; días del más viejo al más nuevo;
 * dentro de cada día, por ruta, sitio y cara (el orden del recorrido).
 */
export function agruparComprobaciones<T extends FilaIndicador>(filas: T[]): GrupoCampana<T>[] {
  const m = new Map<string, Map<string, T[]>>();
  const yaEn = new Set<string>();
  for (const f of filas) {
    if (!f.fecha_comprobacion) continue;
    const c = (f.campana || '').trim() || SIN_CAMPANA;
    // Una cara una sola vez por campaña aunque traiga varias versiones.
    if (yaEn.has(c + '\u0000' + f.vendor_face_id)) continue;
    yaEn.add(c + '\u0000' + f.vendor_face_id);
    const dias = m.get(c) || new Map<string, T[]>();
    const d = diaDeToma(f);
    dias.set(d, [...(dias.get(d) || []), f]);
    m.set(c, dias);
  }
  const ordenFila = (a: T, b: T) =>
    compararRutas(a.ruta_clave, b.ruta_clave) ||
    (a.secuencia ?? Infinity) - (b.secuencia ?? Infinity) ||
    a.site_id.localeCompare(b.site_id) ||
    (a.cara || '').localeCompare(b.cara || '', 'es', { numeric: true });
  return [...m.entries()]
    .map(([campana, dias]) => ({
      campana,
      total: [...dias.values()].reduce((n, fs) => n + fs.length, 0),
      dias: [...dias.entries()]
        .map(([dia, fs]) => ({ dia, filas: fs.slice().sort(ordenFila) }))
        .sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0)),
    }))
    .sort((a, b) => b.total - a.total || a.campana.localeCompare(b.campana, 'es'));
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** 'YYYY-MM-DD' → "lun 19 oct 2026". */
export function etiquetaDia(dia: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
  if (!m) return 'Sin fecha de toma';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DIAS[d.getUTCDay()]} ${+m[3]} ${MESES[+m[2] - 1]} ${m[1]}`;
}

/** Texto seguro para nombre de archivo. */
export function paraArchivo(s: string): string {
  return (s || 'sin-nombre')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}
