// ============================================================
// src/lib/plantillasComp.ts
// Plantillas de toma de Comprobaciones, fase 3 (26-oct-2026). PURA: sin
// red, sin React, sin base; la prueban tests/plantillasComp.test.mjs.
//
// QUÉ ES. Una plantilla dice qué fotos pide una toma: posiciones («corta»,
// «media», «larga», «copete», «lateral»…) con cuántas de cada una, si valen
// para la versión o para todo el sitio ese día, y de día o de noche. Hay
// dos capas (Erik, 26-oct-2026):
//   · testigo: la elige el Supervisor por campaña en Campañas; sin elegir,
//     'unica' (una foto);
//   · mueble: la pone el tipo de mueble del sitio (Biobox M4: 3 copetes y
//     2 laterales que valen para todas sus campañas ese día).
//
// ESPEJO DE LA BASE. Lo que manda es la base: comp_plantilla_toma junta las
// dos capas y comp_faltan cuenta lo que falta (migración comp_f3_modelo,
// §4.1 1g de la especificación). Aquí se repite la MISMA cuenta para
// pintar «Corta ☐ Media ✓» sin red y, después (incremento 2), para que la
// cola sepa cuándo una toma ya está completa. Si se cambia una regla, se
// cambia en las dos y en tests/plantillasComp.test.mjs.
//
// CATÁLOGO. CATALOGO_SEMILLA copia las 12 plantillas que siembra la
// migración. La app lee el catálogo de la base (comp_plantillas_toma); la
// semilla solo sirve para poner nombre cuando la lectura falla y para las
// pruebas. Una plantilla nueva en la base NO necesita tocar este archivo.
// ============================================================

import type { UnidadComp } from './unidadesComp';

export type AlcancePos = 'version' | 'sitio';
export type MomentoPos = 'dia' | 'noche' | null;
export type CapaPlantilla = 'testigo' | 'mueble';

/** Una posición de la plantilla (comp_plantillas_toma.posiciones[i]). */
export type PosPlantilla = {
  /** normal | corta | media | larga | con_periodico | panoramica | angulo | copete | lateral */
  pos: string;
  /** Cuántas fotos de esta posición pide. */
  n: number;
  /** 'sitio' = vale para todas las versiones de ese sitio ese día. */
  alcance: AlcancePos;
  momento: MomentoPos;
  /** Cómo se le dice en pantalla («Corta con periódico»). */
  etiqueta: string;
  /**
   * Modo de comprobación (29-oct-2026, comp_f3_revision): 'camara' = la sube
   * la analista desde cámaras. Sin la llave = de campo (las plantillas
   * enviadas antes de esa migración no la traen).
   */
  via?: 'camara';
};

/** Una fila de comp_plantillas_toma. */
export type PlantillaToma = {
  codigo: string;
  nombre: string;
  capa: CapaPlantilla;
  /** null = todas las unidades (solo testigo). */
  unidad: UnidadComp | null;
  /** inventario.tipo_mueble exacto (solo capa mueble). */
  mueble: string | null;
  posiciones: PosPlantilla[];
  orden: number;
  activa: boolean;
  /** false = la puso Claude con lo que había; Erik o Victor no la han confirmado. */
  confirmada: boolean;
  notas: string | null;
};

/** Lo que ya tiene una toma: fotos vigentes ligadas, sin rechazar, por posición. */
export type TienePos = { pos: string; momento: MomentoPos; n: number };

/** Una posición que falta (forma de comp_faltan). */
export type FaltaPos = { pos: string; momento: MomentoPos; etiqueta: string; n: number; tiene: number };

/** Sin plantilla elegida en la campaña: una foto (comp_campanas.plantilla_codigo NULL). */
export const PLANTILLA_POR_OMISION = 'unica';

// ------------------------------------------------------------
// Catálogo sembrado (copia de comp_f3_modelo, 1b)
// ------------------------------------------------------------

const p = (pos: string, n: number, alcance: AlcancePos, etiqueta: string, momento: MomentoPos = null): PosPlantilla => ({
  pos,
  n,
  alcance,
  momento,
  etiqueta,
});

const testigo = (codigo: string, nombre: string, orden: number, confirmada: boolean, posiciones: PosPlantilla[]): PlantillaToma => ({
  codigo,
  nombre,
  capa: 'testigo',
  unidad: null,
  mueble: null,
  posiciones,
  orden,
  activa: true,
  confirmada,
  notas: null,
});

const mueble = (codigo: string, nombre: string, tipo: string, orden: number, confirmada: boolean, posiciones: PosPlantilla[]): PlantillaToma => ({
  codigo,
  nombre,
  capa: 'mueble',
  unidad: 'Biobox',
  mueble: tipo,
  posiciones,
  orden,
  activa: true,
  confirmada,
  notas: null,
});

/**
 * Las 12 de la migración (Erik, 22 y 26-oct-2026). Las de confirmada=false
 * salen de las hojas reales (Banco Compartamos, Nissan, Walmart) o son
 * provisionales (M5, M5 OXXO, M4 URBANA mientras Victor confirma).
 */
export const CATALOGO_SEMILLA: readonly PlantillaToma[] = [
  testigo('unica', 'Una toma', 10, true, [p('normal', 1, 'version', 'Toma')]),
  testigo('cml', 'Corta, media y larga', 20, true, [
    p('corta', 1, 'version', 'Corta'),
    p('media', 1, 'version', 'Media'),
    p('larga', 1, 'version', 'Larga'),
  ]),
  testigo('cml_periodico', 'Corta con periódico, media y larga', 30, false, [
    p('con_periodico', 1, 'version', 'Corta con periódico'),
    p('media', 1, 'version', 'Media'),
    p('larga', 1, 'version', 'Larga'),
  ]),
  testigo('corta_media', 'Corta y media', 40, false, [p('corta', 1, 'version', 'Corta'), p('media', 1, 'version', 'Media')]),
  testigo('panoramica', 'Panorámica', 50, false, [p('panoramica', 1, 'version', 'Panorámica')]),
  testigo('angulos_3', '3 ángulos', 60, false, [p('angulo', 3, 'version', 'Ángulo')]),
  testigo('angulos_3_dia_noche', '3 ángulos de día y 3 de noche', 70, false, [
    p('angulo', 3, 'version', 'Ángulo de día', 'dia'),
    p('angulo', 3, 'version', 'Ángulo de noche', 'noche'),
  ]),
  mueble('bb_m4', 'Biobox M4', 'M4', 110, true, [p('copete', 3, 'sitio', 'Copete'), p('lateral', 2, 'sitio', 'Lateral')]),
  mueble('bb_m4r2', 'Biobox M4-R2', 'M4-R2', 120, true, [p('lateral', 2, 'sitio', 'Lateral')]),
  mueble('bb_m5', 'Biobox M5', 'M5', 130, false, [p('lateral', 2, 'sitio', 'Lateral')]),
  mueble('bb_m5oxxo', 'Biobox M5 OXXO', 'M5 OXXO', 140, false, [p('lateral', 2, 'sitio', 'Lateral')]),
  mueble('bb_m4urbana', 'Biobox M4 URBANA', 'M4 URBANA', 150, false, [p('lateral', 2, 'sitio', 'Lateral')]),
];

// ------------------------------------------------------------
// Lectura tolerante (lo que llega de la base o de la copia del teléfono)
// ------------------------------------------------------------

const ES_POS = /^[a-z_]{1,20}$/;

function aMomento(v: unknown): MomentoPos {
  return v === 'dia' || v === 'noche' ? v : null;
}

/**
 * posiciones jsonb → PosPlantilla[]. Lo que no se entiende se descarta (una
 * posición rota no debe tumbar la lista del monitorista); n se acota a
 * 1..20 como enteros.
 */
export function leerPosiciones(x: unknown): PosPlantilla[] {
  if (!Array.isArray(x)) return [];
  const out: PosPlantilla[] = [];
  for (const it of x) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const pos = typeof o.pos === 'string' ? o.pos.trim() : '';
    if (!ES_POS.test(pos)) continue;
    const n = Math.trunc(Number(o.n));
    if (!Number.isFinite(n) || n < 1) continue;
    const etiqueta = typeof o.etiqueta === 'string' && o.etiqueta.trim() ? o.etiqueta.trim() : etiquetaDePos(pos);
    out.push({
      pos,
      n: Math.min(n, 20),
      alcance: o.alcance === 'sitio' ? 'sitio' : 'version',
      momento: aMomento(o.momento),
      etiqueta,
      ...(o.via === 'camara' ? { via: 'camara' as const } : {}),
    });
  }
  return out;
}

/** [{pos, momento, n}] de comp_mis_tomas.tiene → TienePos[]. */
export function leerTiene(x: unknown): TienePos[] {
  if (!Array.isArray(x)) return [];
  const out: TienePos[] = [];
  for (const it of x) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const pos = typeof o.pos === 'string' ? o.pos.trim() : '';
    const n = Math.trunc(Number(o.n));
    if (!pos || !Number.isFinite(n) || n < 0) continue;
    out.push({ pos, momento: aMomento(o.momento), n });
  }
  return out;
}

/** Una fila de comp_plantillas_toma → PlantillaToma, o null si no sirve. */
export function leerPlantilla(x: unknown): PlantillaToma | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const codigo = typeof o.codigo === 'string' ? o.codigo : '';
  if (!codigo) return null;
  const capa: CapaPlantilla = o.capa === 'mueble' ? 'mueble' : 'testigo';
  const u = o.unidad;
  return {
    codigo,
    nombre: typeof o.nombre === 'string' && o.nombre.trim() ? o.nombre.trim() : codigo,
    capa,
    unidad: u === 'Ecovallas' || u === 'Biobox' || u === 'Vía Verde' ? u : null,
    mueble: typeof o.mueble === 'string' ? o.mueble : null,
    posiciones: leerPosiciones(o.posiciones),
    orden: Number.isFinite(Number(o.orden)) ? Number(o.orden) : 100,
    activa: o.activa !== false,
    confirmada: o.confirmada === true,
    notas: typeof o.notas === 'string' ? o.notas : null,
  };
}

// ------------------------------------------------------------
// Resolver y contar (espejo de comp_plantilla_toma y comp_faltan)
// ------------------------------------------------------------

const llave = (pos: string, momento: MomentoPos) => `${pos}|${momento ?? ''}`;

/**
 * Junta capas (testigo primero, mueble después) como comp_plantilla_toma:
 * dos posiciones con la misma (pos, momento) quedan en UNA, con el n mayor
 * y alcance 'sitio' si alguna lo es. Se queda el lugar y la etiqueta de la
 * primera que apareció; lo que solo trae el mueble va al final.
 */
export function juntarPosiciones(capas: PosPlantilla[][]): PosPlantilla[] {
  const out: PosPlantilla[] = [];
  const idx = new Map<string, number>();
  for (const capa of capas) {
    for (const q of capa) {
      const k = llave(q.pos, q.momento);
      const i = idx.get(k);
      if (i === undefined) {
        idx.set(k, out.length);
        out.push({ ...q });
      } else {
        const a = out[i];
        out[i] = { ...a, n: Math.max(a.n, q.n), alcance: a.alcance === 'sitio' || q.alcance === 'sitio' ? 'sitio' : 'version' };
      }
    }
  }
  return out;
}

/**
 * La plantilla VIGENTE de una toma: la de testigo de la campaña (o 'unica')
 * más la del mueble del sitio en esa unidad. El mueble se compara EXACTO
 * (inventario.tipo_mueble: 'M5 OXXO' no es 'M5'). Si el código de la
 * campaña no está en el catálogo, cuenta como 'unica' (la base lo impide
 * con la llave foránea; aquí es por si el catálogo no se pudo leer).
 */
export function plantillaResuelta(
  catalogo: readonly PlantillaToma[],
  args: { codigo: string | null | undefined; unidad: UnidadComp | string | null | undefined; mueble: string | null | undefined }
): PosPlantilla[] {
  const codigo = args.codigo || PLANTILLA_POR_OMISION;
  const t =
    catalogo.find((x) => x.codigo === codigo && x.capa === 'testigo') ??
    catalogo.find((x) => x.codigo === PLANTILLA_POR_OMISION) ??
    CATALOGO_SEMILLA[0];
  const muebles = args.mueble
    ? catalogo.filter((x) => x.capa === 'mueble' && x.activa && x.unidad === args.unidad && x.mueble === args.mueble)
    : [];
  return juntarPosiciones([t.posiciones, ...muebles.map((m) => m.posiciones)]);
}

/** Cuántas fotos hay de (pos, momento), sumando renglones repetidos. */
function cuantas(tiene: readonly TienePos[], pos: string, momento: MomentoPos): number {
  let n = 0;
  for (const t of tiene) if (t.pos === pos && t.momento === momento) n += t.n;
  return n;
}

/**
 * Lo que falta, como comp_faltan: por cada posición, cuántas fotos tiene
 * (misma pos y mismo momento; momento null solo empata con null). Solo
 * salen las que tienen menos de n. [] = completa. Las fotos «extra» o de
 * una posición que la plantilla no pide no cuentan para nada.
 */
export function faltan(plantilla: readonly PosPlantilla[], tiene: readonly TienePos[]): FaltaPos[] {
  const out: FaltaPos[] = [];
  for (const q of plantilla) {
    const t = cuantas(tiene, q.pos, q.momento);
    if (t < q.n) out.push({ pos: q.pos, momento: q.momento, etiqueta: q.etiqueta, n: q.n, tiene: t });
  }
  return out;
}

/** ¿Ya tiene todo lo que pide su plantilla? */
export const completa = (plantilla: readonly PosPlantilla[], tiene: readonly TienePos[]): boolean =>
  faltan(plantilla, tiene).length === 0;

/** Cada posición de la plantilla con lo que ya tiene (para «Corta ✓ Media ☐»). */
export function avancePorPosicion(
  plantilla: readonly PosPlantilla[],
  tiene: readonly TienePos[]
): (PosPlantilla & { tiene: number })[] {
  return plantilla.map((q) => ({ ...q, tiene: Math.min(cuantas(tiene, q.pos, q.momento), q.n) }));
}

// ------------------------------------------------------------
// Textos
// ------------------------------------------------------------

const ETIQUETA_POS: Record<string, string> = {
  normal: 'Toma',
  corta: 'Corta',
  media: 'Media',
  larga: 'Larga',
  con_periodico: 'Corta con periódico',
  panoramica: 'Panorámica',
  angulo: 'Ángulo',
  copete: 'Copete',
  lateral: 'Lateral',
  extra: 'Otra',
};

/** Etiqueta de una posición sin plantilla a la mano. */
export function etiquetaDePos(pos: string): string {
  return ETIQUETA_POS[pos] ?? pos.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** «Corta 1 · Media 1 · Larga 1», «Ángulo de día 3 · Ángulo de noche 3». */
export function resumenPosiciones(posiciones: readonly PosPlantilla[]): string {
  return posiciones.map((q) => `${q.etiqueta} ${q.n}${q.alcance === 'sitio' ? ' (del sitio)' : ''}`).join(' · ');
}

/** Nombre de una plantilla por código; NULL o vacío = la de omisión. */
export function nombrePlantilla(catalogo: readonly PlantillaToma[], codigo: string | null | undefined): string {
  const c = codigo || PLANTILLA_POR_OMISION;
  return (catalogo.find((x) => x.codigo === c) ?? CATALOGO_SEMILLA.find((x) => x.codigo === c))?.nombre ?? c;
}

/** Las que el Supervisor puede elegir en una campaña: testigo y activas, en su orden. */
export function plantillasElegibles(catalogo: readonly PlantillaToma[]): PlantillaToma[] {
  return catalogo
    .filter((x) => x.capa === 'testigo' && x.activa)
    .sort((a, b) => a.orden - b.orden || a.codigo.localeCompare(b.codigo));
}
