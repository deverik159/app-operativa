// ============================================================
// src/lib/modoComp.ts
// Modo de comprobación en Campañas del Supervisor (fase 3, incremento 3;
// 29-oct-2026, spec §11). PURA: sin red, sin React, sin base; la prueba
// tests/modoComp.test.mjs.
//
// QUÉ HACE. Los textos y cuentas de la columna «Modo» y del lote «Modo…»:
//   · textoModo: «Campo», «Cámaras», «Mixto · Corta por cámara» o, en
//     ámbar, «Mixto sin fotos por cámara» (se porta como Campo);
//   · posicionesDeTestigo / unionPosiciones: las casillas del lote (la unión
//     de las plantillas de las campañas elegidas);
//   · simularModo: lo que va a quedar en cada campaña, para avisar antes;
//   · textoResultadoModo: lo que contestó comp_poner_modo, en palabras.
//
// ESPEJO DE LA BASE. Quien decide es la base: el trigger comp_campana_modo_trg
// y comp_poner_modo de la migración comp_f3_revision. Reglas que se repiten
// aquí (si cambian allá, cambian aquí y en la prueba):
//   · Biobox siempre es campo (la base rechaza otro modo con CP002).
//   · En mixto, pos_camara se queda solo con posiciones de la plantilla de
//     testigo; si queda vacío AL ENTRAR a mixto (o al cambiar de plantilla)
//     y la plantilla tiene Corta, va la Corta.
//   · posCamara null en mixto = las que ya tenía (o la Corta, si entra).
//   · Las cerradas no se tocan.
// ============================================================

import type { CampanaModo, ModoToma } from './revisionTomas';
import { CATALOGO_SEMILLA, etiquetaDePos, PLANTILLA_POR_OMISION, type PlantillaToma } from './plantillasComp';

export const ETIQUETA_MODO: Record<ModoToma, string> = { campo: 'Campo', camaras: 'Cámaras', mixto: 'Mixto' };

/** La posición que va por cámara cuando el Supervisor no palomea nada (Erik, 29-oct-2026). */
export const POS_CAMARA_POR_OMISION = 'corta';

/** Una casilla del lote: la posición y cómo se le dice. */
export type PosModo = { pos: string; etiqueta: string };

const plural = (n: number, s: string, p = s + 's') => (n === 1 ? s : p);
const fmt = (n: number) => n.toLocaleString('es-MX');

/** «Corta», «Corta y Media», «Corta, Media y Larga». */
export function listaY(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join('');
  return xs.slice(0, -1).join(', ') + ' y ' + xs[xs.length - 1];
}

/** La plantilla de testigo de un código (null = 'unica'); si no está en el catálogo, la semilla. */
function plantillaTestigo(catalogo: readonly PlantillaToma[] | null | undefined, codigo: string | null | undefined): PlantillaToma | null {
  const c = codigo || PLANTILLA_POR_OMISION;
  const de = (l: readonly PlantillaToma[]) => l.find((x) => x.codigo === c && x.capa === 'testigo') ?? null;
  return de(catalogo ?? []) ?? de(CATALOGO_SEMILLA);
}

/**
 * Las posiciones de la plantilla de testigo, una por `pos` (pos_camara va
 * por posición, no por momento: «3 ángulos de día y 3 de noche» da un solo
 * «Ángulo»). Si todas las de esa pos se llaman igual se usa su etiqueta; si
 * no, la genérica.
 */
export function posicionesDeTestigo(catalogo: readonly PlantillaToma[] | null | undefined, codigo: string | null | undefined): PosModo[] {
  const t = plantillaTestigo(catalogo, codigo);
  if (!t) return [];
  const out: PosModo[] = [];
  for (const q of t.posiciones) {
    const i = out.findIndex((x) => x.pos === q.pos);
    if (i < 0) out.push({ pos: q.pos, etiqueta: q.etiqueta });
    else if (out[i].etiqueta !== q.etiqueta) out[i] = { pos: q.pos, etiqueta: etiquetaDePos(q.pos) };
  }
  return out;
}

/** Etiquetas de unas posiciones, en el orden de la plantilla (las que no tiene, al final). */
export function etiquetasPos(posPlantilla: readonly PosModo[], pos: readonly string[]): string[] {
  const set = new Set(pos);
  const out = posPlantilla.filter((q) => set.has(q.pos)).map((q) => q.etiqueta);
  for (const p of pos) if (!posPlantilla.some((q) => q.pos === p)) out.push(etiquetaDePos(p));
  return out;
}

export type TextoModo = {
  texto: string;
  /** gris = Biobox (siempre campo); ambar = mixto sin fotos por cámara. */
  tono: 'normal' | 'gris' | 'ambar';
  /** Explicación para el title. */
  titulo?: string;
};

/** Texto de la columna «Modo» de una campaña; null = todavía no se sabe. */
export function textoModo(
  m: Pick<CampanaModo, 'modo_toma' | 'pos_camara' | 'plantilla_codigo'> | null | undefined,
  unidad: string | null | undefined,
  catalogo: readonly PlantillaToma[] | null | undefined
): TextoModo | null {
  if (unidad === 'Biobox') return { texto: 'Campo', tono: 'gris', titulo: 'Biobox siempre se comprueba en campo' };
  if (!m) return null;
  if (m.modo_toma === 'camaras')
    return { texto: 'Cámaras', tono: 'normal', titulo: 'La analista sube capturas de cámara; cuentan solas, sin revisión' };
  if (m.modo_toma === 'mixto') {
    if (!m.pos_camara.length)
      return {
        texto: 'Mixto sin fotos por cámara',
        tono: 'ambar',
        titulo: 'Se porta como Campo: elige cuáles fotos van por cámara en Acciones › Modo',
      };
    const et = etiquetasPos(posicionesDeTestigo(catalogo, m.plantilla_codigo), m.pos_camara);
    return {
      texto: `Mixto · ${listaY(et)} por cámara`,
      tono: 'normal',
      titulo: 'Lo demás lo toma el monitorista en la calle',
    };
  }
  return { texto: 'Campo', tono: 'normal', titulo: 'Fotos del monitorista en la calle' };
}

/**
 * Casillas del lote en Mixto: la unión de las posiciones de las plantillas
 * de las campañas elegidas, en el orden en que aparecen. `en` = en cuántas de
 * esas plantillas está cada una; `distintas` = hay más de una plantilla.
 */
export function unionPosiciones(
  catalogo: readonly PlantillaToma[] | null | undefined,
  codigos: readonly (string | null | undefined)[]
): { posiciones: (PosModo & { en: number })[]; plantillas: number; distintas: boolean } {
  const unicos = [...new Set(codigos.map((c) => c || PLANTILLA_POR_OMISION))];
  const out: (PosModo & { en: number })[] = [];
  for (const c of unicos) {
    for (const q of posicionesDeTestigo(catalogo, c)) {
      const i = out.findIndex((x) => x.pos === q.pos);
      if (i < 0) out.push({ ...q, en: 1 });
      else out[i] = { ...out[i], en: out[i].en + 1, etiqueta: out[i].etiqueta === q.etiqueta ? q.etiqueta : etiquetaDePos(q.pos) };
    }
  }
  return { posiciones: out, plantillas: unicos.length, distintas: unicos.length > 1 };
}

/** Una campaña elegida, con lo que hace falta para saber cómo va a quedar. */
export type CampanaParaModo = {
  unidad: string;
  abierta: boolean;
  modo: Pick<CampanaModo, 'modo_toma' | 'pos_camara' | 'plantilla_codigo'> | null;
};

/**
 * Cómo queda pos_camara de UNA campaña con un modo y unas posiciones (null =
 * sin elegir), como comp_poner_modo + el trigger. null = no cambia (cerrada,
 * Biobox o sin modo leído).
 */
export function pasarA(
  c: CampanaParaModo,
  modo: ModoToma,
  posCamara: readonly string[] | null,
  catalogo: readonly PlantillaToma[] | null | undefined
): { modo_toma: ModoToma; pos_camara: string[] } | null {
  if (!c.abierta || !c.modo || c.unidad === 'Biobox') return null;
  const antes = c.modo;
  if (modo !== 'mixto') return { modo_toma: modo, pos_camara: [] };
  const dePlantilla = posicionesDeTestigo(catalogo, antes.plantilla_codigo).map((q) => q.pos);
  const entra = antes.modo_toma !== 'mixto';
  // comp_poner_modo: posCamara null = las que tenía (si ya era mixto) o vacío (si entra).
  let pos = posCamara === null ? (entra ? [] : [...antes.pos_camara]) : [...posCamara];
  // El trigger: solo las de la plantilla, sin repetir, en orden; y la Corta si entra vacía.
  pos = [...new Set(pos.filter((p) => dePlantilla.includes(p)))].sort();
  if (!pos.length && entra && dePlantilla.includes(POS_CAMARA_POR_OMISION)) pos = [POS_CAMARA_POR_OMISION];
  return { modo_toma: 'mixto', pos_camara: pos };
}

/**
 * Lo que se puede decir ANTES de guardar con lo que hay en pantalla (la base
 * cuenta al guardar): abiertas que cambian, las que ya están así, cerradas y
 * Biobox, y cuántas quedarían en Mixto sin fotos por cámara.
 */
export function simularModo(
  campanas: readonly CampanaParaModo[],
  modo: ModoToma,
  posCamara: readonly string[] | null,
  catalogo: readonly PlantillaToma[] | null | undefined
): { cambian: number; yaAsi: number; cerradas: number; biobox: number; sinLeer: number; mixtoSinCamara: number } {
  let cambian = 0,
    yaAsi = 0,
    cerradas = 0,
    biobox = 0,
    sinLeer = 0,
    mixtoSinCamara = 0;
  for (const c of campanas) {
    if (c.unidad === 'Biobox') biobox++;
    if (!c.abierta) {
      cerradas++;
      continue;
    }
    if (c.unidad === 'Biobox') continue;
    if (!c.modo) {
      sinLeer++;
      continue;
    }
    const d = pasarA(c, modo, posCamara, catalogo);
    if (!d) continue;
    const igual =
      d.modo_toma === c.modo.modo_toma &&
      (d.modo_toma !== 'mixto' || [...c.modo.pos_camara].sort().join('|') === d.pos_camara.join('|'));
    if (igual) yaAsi++;
    else cambian++;
    if (d.modo_toma === 'mixto' && !d.pos_camara.length) mixtoSinCamara++;
  }
  return { cambian, yaAsi, cerradas, biobox, sinLeer, mixtoSinCamara };
}

/**
 * Las posiciones que conviene dejar palomeadas al elegir Mixto: las de las
 * elegidas que ya están en Mixto, si todas tienen las mismas; si no, ninguna
 * (sin palomear = la Corta para las que entran).
 */
export function posicionesIniciales(campanas: readonly CampanaParaModo[]): string[] {
  const mixtas = campanas.filter((c) => c.abierta && c.modo?.modo_toma === 'mixto').map((c) => [...(c.modo?.pos_camara ?? [])].sort().join('|'));
  if (!mixtas.length || new Set(mixtas).size !== 1 || !mixtas[0]) return [];
  return mixtas[0].split('|');
}

/** Lo que contesta comp_poner_modo (ResPonerModo de revisionApi). */
export type ResultadoModo = {
  cambiadas: number;
  sin_cambio: number;
  cerradas_omitidas: number;
  enviadas_conservan: number;
  mixto_sin_camara: number;
  con_fotos: number;
};

/**
 * Lo que contestó la base, en palabras. `linea` = el renglón principal
 * («✓ 3 cambiadas a Mixto» o «Sin cambios…»); `avisos` = lo que el
 * Supervisor tiene que saber (enviadas que conservan, mixto sin cámara,
 * pendientes con fotos de campo de una posición que ahora va por cámara).
 */
export function textoResultadoModo(d: ResultadoModo, modo: ModoToma): { linea: string; avisos: string[]; texto: string } {
  const partes: string[] = [];
  if (d.sin_cambio) partes.push(`${fmt(d.sin_cambio)} ya ${plural(d.sin_cambio, 'estaba', 'estaban')} así`);
  if (d.cerradas_omitidas) partes.push(`${fmt(d.cerradas_omitidas)} ${plural(d.cerradas_omitidas, 'cerrada')} sin tocar`);
  const linea = d.cambiadas
    ? `✓ ${fmt(d.cambiadas)} ${plural(d.cambiadas, 'cambiada')} a ${ETIQUETA_MODO[modo]}` + (partes.length ? ' · ' + partes.join(' · ') : '')
    : 'Sin cambios' + (partes.length ? ': ' + partes.join(' · ') : '') + '.';
  const avisos: string[] = [];
  if (d.enviadas_conservan)
    avisos.push(
      `${fmt(d.enviadas_conservan)} ${plural(d.enviadas_conservan, 'toma')} ya ${plural(d.enviadas_conservan, 'enviada')} ` +
        `${plural(d.enviadas_conservan, 'conserva', 'conservan')} el modo anterior`
    );
  if (d.mixto_sin_camara)
    avisos.push(
      `${fmt(d.mixto_sin_camara)} ${plural(d.mixto_sin_camara, 'queda', 'quedan')} en Mixto sin fotos por cámara ` +
        `(se ${plural(d.mixto_sin_camara, 'porta', 'portan')} como Campo): elige cuáles`
    );
  if (d.con_fotos)
    avisos.push(
      `${fmt(d.con_fotos)} ${plural(d.con_fotos, 'toma pendiente ya tiene', 'tomas pendientes ya tienen')} fotos de campo de una posición que ahora va por cámara`
    );
  return { linea, avisos, texto: [linea, ...avisos].join(' · ') };
}
