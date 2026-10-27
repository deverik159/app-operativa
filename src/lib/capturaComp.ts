// ============================================================
// src/lib/capturaComp.ts
// Lo PURO de la captura en Mis rutas › Comprobaciones (fase 3, incremento 2,
// 26-oct-2026; especificación §6.1): qué tomas entran en la visita, qué
// falta en cada casilla, qué ofrece la hoja «¿qué es? ¿de cuál?» y qué
// ofrece «Usar también para…». Sin red, sin IndexedDB y sin React: lo
// prueba tests/capturaComp.test.mjs. Solo importa tipos y lo puro de la cola
// (logicaComp.ts), nunca la cola misma.
//
// POR QUÉ «LO QUE YA ESTÁ» NO ES tiene + ligadas: la lista (comp_mis_tomas)
// trae `tiene` contado en el servidor y la cola sabe qué fotos de la visita
// ya ligó. Después de releer la lista, esas fotos ya vienen en `tiene`: si
// se sumaran otra vez, «Lateral 1/2» saldría como 2/2 ✓ y el monitorista se
// iría sin la segunda. Por eso la pantalla guarda qué ligas ya estaban
// ligadas al EMPEZAR la última lectura buena (`incluidas`): ésas ya vienen
// en `tiene`; las demás se suman. Una liga que entra durante la lectura se
// cuenta de más (a lo mucho una), y eso lo corrige «Listo con este sitio»:
// la base cuenta y dice lo que falta.
// ============================================================

import type { UnidadComp } from './unidadesComp';
import { avancePorPosicion, type MomentoPos, type PosPlantilla, type TienePos } from './plantillasComp';
import type { TarjetaSitio, TomaMia } from './misTomasComp';
import type { EstadoVisita, FotoEnVisita } from './colaFotos/logicaComp';

/** La visita como la pide la cola (misma forma que VisitaComp de adaptadorComp). */
export type VisitaPantalla = {
  unidad: UnidadComp;
  sitio_clave: string;
  fecha: string;
  tomas: TomaMia[];
};

/** Llave de una liga foto ↔ toma. */
export const llaveLiga = (cliente_id: string, toma_id: number) => `${cliente_id}|${toma_id}`;

/**
 * Las ligas (solo fotos: los videos nunca cuentan) que la cola ya confirmó,
 * más las que el monitorista quitó y el servidor TODAVÍA tiene (26-oct-2026):
 * una lectura que empieza antes de que la cola las quite las trae en `tiene`,
 * y así tieneVisto sabe que debe descontarlas.
 */
export function ligasDe(estados: Iterable<EstadoVisita | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const e of estados) {
    if (!e) continue;
    for (const f of e.fotos) {
      if (f.tipo !== 'foto') continue;
      for (const id of f.ligada_en) out.add(llaveLiga(f.cliente_id, id));
    }
    for (const r of e.retiradas ?? []) if (r.pendiente) out.add(llaveLiga(r.cliente_id, r.toma_id));
  }
  return out;
}

function sumar(l: TienePos[], pos: string, momento: MomentoPos, n = 1): void {
  const x = l.find((y) => y.pos === pos && y.momento === momento);
  if (x) x.n += n;
  else l.push({ pos, momento, n });
}

/**
 * Lo que la toma ya tiene según la pantalla: lo del servidor (`tiene`) más
 * lo que esta visita ligó DESPUÉS de la última lectura buena, menos lo que el
 * monitorista quitó y esa lectura todavía traía (26-oct-2026: sin esto,
 * después de «Quitar» la casilla seguía con ✓ hasta releer la lista).
 */
export function tieneVisto(
  toma: Pick<TomaMia, 'id' | 'tiene'>,
  estado: EstadoVisita | null | undefined,
  incluidas: ReadonlySet<string>
): TienePos[] {
  const out = toma.tiene.map((x) => ({ ...x }));
  if (!estado) return out;
  for (const r of estado.retiradas ?? []) {
    if (r.toma_id !== toma.id || !incluidas.has(llaveLiga(r.cliente_id, toma.id))) continue;
    const x = out.find((y) => y.pos === r.pos && (y.momento ?? null) === (r.momento ?? null) && y.n > 0);
    if (x) x.n--;
  }
  for (const f of estado.fotos) {
    if (f.tipo !== 'foto' || !f.ligada_en.includes(toma.id)) continue;
    if (incluidas.has(llaveLiga(f.cliente_id, toma.id))) continue;
    sumar(out, f.pos, f.momento);
  }
  return out;
}

/** Lo que sigue en el teléfono sin confirmar para esa toma (gris «en el teléfono»). */
export function enTelefonoDe(estado: EstadoVisita | null | undefined, tomaId: number): TienePos[] {
  return (estado?.enTelefono[String(tomaId)] ?? []).map((x) => ({ ...x }));
}

/** Una casilla de la tarjeta: lo que pide, lo que ya está (✓) y lo que va en camino (gris). */
export type AvanceCasilla = PosPlantilla & {
  /** Confirmadas por el servidor (tope n). */
  tiene: number;
  /** En el teléfono, sin confirmar (tope n − tiene). */
  enTelefono: number;
};

/** Cada posición de la plantilla de una toma con lo confirmado y lo que va en camino. */
export function avanceCaptura(
  toma: Pick<TomaMia, 'id' | 'tiene' | 'plantilla'>,
  estado: EstadoVisita | null | undefined,
  incluidas: ReadonlySet<string>
): AvanceCasilla[] {
  const visto = avancePorPosicion(toma.plantilla, tieneVisto(toma, estado, incluidas));
  const tel = avancePorPosicion(toma.plantilla, enTelefonoDe(estado, toma.id));
  return visto.map((q, i) => ({ ...q, enTelefono: Math.min(tel[i]?.tiene ?? 0, q.n - q.tiene) }));
}

/** Una casilla de la fila «Fotos del sitio». */
export type CasillaSitio = { pos: string; momento: MomentoPos; etiqueta: string; n: number; tiene: number; enTelefono: number };

/**
 * El día de la fila «Fotos del sitio» (como diaSitio de armarTarjetas): el de
 * la tarjeta si alguna toma abierta lo trae; si no, el más reciente que trae
 * (sin pasar del de la tarjeta). POR QUÉ (26-oct-2026): con la captura
 * abierta, una tarjeta de Hoy con solo una vencida de ayer (Biobox M4) se
 * quedaba sin fila de sitio y sin casillas de copete y lateral.
 */
export function diaFilaSitio(tomas: readonly Pick<TomaMia, 'fecha' | 'estado'>[], dia: string): string {
  const piden = tomas.filter((t) => t.estado !== 'por_revisar' && t.fecha <= dia);
  if (!piden.length || piden.some((t) => t.fecha === dia)) return dia;
  return piden.reduce((m, t) => (t.fecha > m ? t.fecha : m), '');
}

/**
 * La fila «Fotos del sitio» con la cola: cada posición de alcance sitio de
 * las tomas abiertas del día de la fila (diaFilaSitio), con el n mayor y lo
 * de la toma que MENOS tiene (como fotosDeSitio de misTomasComp, más el gris
 * del teléfono). Las de otro día llevan sus casillas de sitio en su propia
 * fila (TarjetaSitioComp).
 */
export function fotosDeSitioCaptura(
  tomas: readonly TomaMia[],
  dia: string,
  estado: EstadoVisita | null | undefined,
  incluidas: ReadonlySet<string>
): CasillaSitio[] {
  const out = new Map<string, CasillaSitio>();
  const ref = diaFilaSitio(tomas, dia);
  for (const t of tomas) {
    if (t.fecha !== ref || t.estado === 'por_revisar') continue;
    for (const q of avanceCaptura(t, estado, incluidas)) {
      if (q.alcance !== 'sitio') continue;
      const k = `${q.pos}|${q.momento ?? ''}`;
      const a = out.get(k);
      if (!a) out.set(k, { pos: q.pos, momento: q.momento, etiqueta: q.etiqueta, n: q.n, tiene: q.tiene, enTelefono: q.enTelefono });
      else {
        const tiene = Math.min(a.tiene, q.tiene);
        const n = Math.max(a.n, q.n);
        out.set(k, { ...a, n, tiene, enTelefono: Math.min(a.tiene + a.enTelefono, q.tiene + q.enTelefono) - tiene });
      }
    }
  }
  return [...out.values()];
}

/** ¿La toma sigue esperando fotos? (pendiente o devuelta, y la cola no la cerró). */
export function tomaAbiertaEnPantalla(
  toma: Pick<TomaMia, 'id' | 'estado'>,
  estado: EstadoVisita | null | undefined
): boolean {
  if (toma.estado !== 'pendiente' && toma.estado !== 'regresada') return false;
  if (!estado) return true;
  if (estado.enviadas.includes(toma.id)) return false;
  return !estado.sinEnviar.some((s) => s.toma_id === toma.id);
}

/**
 * Las tomas que entran en la visita: las del día de la tarjeta, las devueltas,
 * las enviadas (una foto extra se liga y la analista la ve) y, de las
 * vencidas, solo las que ya tienen fotos o que la cola ya conoce (`extra`).
 * Las demás vencidas de un plan diario (hasta 25 por sitio) no: «Listo con
 * este sitio» diría «Falta…» de cada una.
 */
export function tomasDeVisita(t: Pick<TarjetaSitio, 'tomas' | 'dia'>, extra: ReadonlySet<number> = new Set()): TomaMia[] {
  return t.tomas.filter(
    (x) =>
      x.fecha === t.dia ||
      x.estado === 'regresada' ||
      x.estado === 'por_revisar' ||
      x.tiene.some((y) => y.n > 0) ||
      extra.has(x.id)
  );
}

/** Ids de toma que la cola ya trae para esta visita (fotos y lo que la base contestó). */
export function idsEnCola(estado: EstadoVisita | null | undefined): Set<number> {
  const out = new Set<number>();
  if (!estado) return out;
  for (const f of estado.fotos) for (const id of f.toma_ids) out.add(id);
  for (const id of estado.enviadas) out.add(id);
  for (const s of estado.sinEnviar) out.add(s.toma_id);
  for (const k of Object.keys(estado.faltan)) out.add(Number(k));
  return out;
}

/**
 * La visita de una tarjeta, o null si no se puede capturar ahí (sin unidad:
 * una copia vieja del teléfono no la trae).
 */
export function visitaDeTarjeta(
  t: Pick<TarjetaSitio, 'tomas' | 'dia' | 'unidad' | 'sitio_clave'>,
  extra: ReadonlySet<number> = new Set()
): VisitaPantalla | null {
  if (!t.unidad) return null;
  return { unidad: t.unidad, sitio_clave: t.sitio_clave, fecha: t.dia, tomas: tomasDeVisita(t, extra) };
}

// ------------------------------------------------------------
// La hoja «¿qué es? ¿de cuál?»
// ------------------------------------------------------------

/** Posición que se guarda cuando el monitorista elige «Otra». */
export const POS_EXTRA = 'extra';

/** Un chip de «¿Qué es?». */
export type OpcionQueEs = {
  pos: string;
  momento: MomentoPos;
  etiqueta: string;
  /** Si alguna toma la pide como foto de sitio, vale para todas las del día. */
  alcance: 'version' | 'sitio';
  /** Cuántas faltan todavía (sumando las tomas que la piden). */
  faltan: number;
};

const llavePos = (pos: string, momento: MomentoPos) => `${pos}|${momento ?? ''}`;

/**
 * Lo que falta en las tomas abiertas de la visita (plantilla − tiene − en el
 * teléfono), en el orden de las plantillas. Lo de alcance sitio va primero
 * una sola vez (vale para todas las versiones del día). Sin nada que falte,
 * lista vacía: la hoja solo ofrece «Otra».
 */
export function opcionesQueEs(
  tomas: readonly TomaMia[],
  estado: EstadoVisita | null | undefined,
  incluidas: ReadonlySet<string>,
  hoy: string
): OpcionQueEs[] {
  const sitio = new Map<string, OpcionQueEs>();
  const version = new Map<string, OpcionQueEs>();
  for (const t of tomas) {
    if (t.fecha > hoy || !tomaAbiertaEnPantalla(t, estado)) continue;
    for (const q of avanceCaptura(t, estado, incluidas)) {
      const falta = q.n - q.tiene - q.enTelefono;
      if (falta <= 0) continue;
      const k = llavePos(q.pos, q.momento);
      const m = q.alcance === 'sitio' ? sitio : version;
      const a = m.get(k);
      // Lo de sitio se cuenta una vez (la misma foto sirve a todas); lo de
      // versión se suma por toma.
      if (!a) m.set(k, { pos: q.pos, momento: q.momento, etiqueta: q.etiqueta, alcance: q.alcance, faltan: falta });
      else a.faltan = q.alcance === 'sitio' ? Math.max(a.faltan, falta) : a.faltan + falta;
    }
  }
  // Una posición que una toma pide de sitio y otra de versión: gana sitio.
  for (const k of sitio.keys()) version.delete(k);
  return [...sitio.values(), ...version.values()];
}

/**
 * Lo que «¿Qué es?» trae marcado: la posición fija («Usar también para…», o
 * «Otra» para un video), la única que falta o, si ya no falta nada, «Otra»
 * (la hoja lo promete: «la foto se guarda como Otra»). null = elige él.
 */
export function queEsPorOmision(
  fija: { pos: string; momento: MomentoPos } | null,
  opciones: readonly Pick<OpcionQueEs, 'pos' | 'momento'>[]
): { pos: string; momento: MomentoPos } | null {
  if (fija) return { pos: fija.pos, momento: fija.momento };
  if (opciones.length === 1) return { pos: opciones[0].pos, momento: opciones[0].momento };
  if (!opciones.length) return { pos: POS_EXTRA, momento: null };
  return null;
}

/** Un botón de «¿De cuál?». */
export type CandidataDeCual = {
  id: number;
  campana_id: number;
  nombre: string;
  fecha: string;
  estado: TomaMia['estado'];
  /** ¿Todavía le falta esa posición? */
  falta: boolean;
  /** B4: esta misma foto ya se le devolvió (no se ofrece). */
  devuelta: boolean;
};

/** ¿La plantilla de la toma pide esa posición? «Otra» vale para cualquiera. */
export function pidePosicion(t: Pick<TomaMia, 'plantilla'>, pos: string, momento: MomentoPos): boolean {
  if (pos === POS_EXTRA) return true;
  return t.plantilla.some((q) => q.pos === pos && q.momento === momento);
}

/** «Tecate Always V2» (como nombreToma de misTomasComp, sin importarlo dos veces). */
function nombreDe(t: Pick<TomaMia, 'campana' | 'version'>): string {
  const c = (t.campana || '').trim();
  const v = (t.version || '').trim();
  if (!v) return c || 'Sin campaña';
  return c.toUpperCase().endsWith(v.toUpperCase()) ? c : `${c} ${v}`;
}

/** Orden de «¿De cuál?»: devueltas, las de hoy, vencidas (de la más reciente), y por nombre. */
function pesoCandidata(t: Pick<TomaMia, 'estado' | 'fecha'>, hoy: string): number {
  if (t.estado === 'regresada') return 0;
  return t.fecha === hoy ? 1 : 2;
}

/**
 * Las versiones a las que se puede ligar una foto de esa posición: las
 * tomas abiertas de la visita (hoy, vencidas y devueltas; nunca un día por
 * venir) cuya plantilla la pide. `path` (en «Usar también para…») marca las
 * que ya devolvieron esa misma foto (B4).
 */
export function candidatasDeCual(
  tomas: readonly TomaMia[],
  pos: string,
  momento: MomentoPos,
  estado: EstadoVisita | null | undefined,
  incluidas: ReadonlySet<string>,
  hoy: string,
  path?: string | null
): CandidataDeCual[] {
  const out: (CandidataDeCual & { _p: number })[] = [];
  for (const t of tomas) {
    if (t.fecha > hoy || !tomaAbiertaEnPantalla(t, estado) || !pidePosicion(t, pos, momento)) continue;
    const q = avanceCaptura(t, estado, incluidas).find((x) => x.pos === pos && x.momento === momento);
    out.push({
      id: t.id,
      campana_id: t.campana_id,
      nombre: nombreDe(t),
      fecha: t.fecha,
      estado: t.estado,
      falta: pos === POS_EXTRA ? true : !!q && q.tiene + q.enTelefono < q.n,
      devuelta: !!path && t.rechazadas.some((r) => r.path === path),
      _p: pesoCandidata(t, hoy),
    });
  }
  out.sort(
    (a, b) =>
      a._p - b._p ||
      (a._p === 2 ? (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0) : 0) ||
      a.nombre.localeCompare(b.nombre, 'es', { numeric: true, sensitivity: 'base' }) ||
      a.id - b.id
  );
  return out.map(({ _p: _, ...c }) => c);
}

/**
 * «Todas las de hoy» (alcance sitio): las candidatas del día de la visita.
 * Una campaña tiene una sola toma por sitio y día, así que nunca choca con
 * A1. Las que ya la tienen completa también: la foto les sobra pero no estorba.
 */
export function todasLasDeHoy(cands: readonly CandidataDeCual[], dia: string): number[] {
  return cands.filter((c) => c.fecha === dia && !c.devuelta).map((c) => c.id);
}

/**
 * Lo que viene marcado en «¿De cuál?»: alcance sitio → todas las de hoy;
 * si no, la última versión que eligió en este sitio (el loop de Vía Verde)
 * si sigue ahí y le falta esa foto; si no, la única a la que le falta.
 */
export function seleccionPorOmision(
  cands: readonly CandidataDeCual[],
  alcance: 'version' | 'sitio',
  dia: string,
  ultima: number | null
): number[] {
  const vivas = cands.filter((c) => !c.devuelta);
  if (alcance === 'sitio') {
    const hoy = todasLasDeHoy(vivas, dia);
    if (hoy.length) return hoy;
  }
  if (ultima !== null) {
    const u = vivas.find((c) => c.id === ultima);
    if (u && u.falta) return [u.id];
  }
  const conFalta = vivas.filter((c) => c.falta);
  if (conFalta.length === 1) return [conFalta[0].id];
  if (vivas.length === 1) return [vivas[0].id];
  return [];
}

/**
 * Prende o apaga una versión. A1: una foto vale para un solo día de cada
 * campaña; al prender una, se apaga la otra de la misma campaña.
 */
export function alternarCual(sel: readonly number[], c: Pick<CandidataDeCual, 'id' | 'campana_id'>, cands: readonly CandidataDeCual[]): number[] {
  if (sel.includes(c.id)) return sel.filter((x) => x !== c.id);
  const misma = new Set(cands.filter((x) => x.campana_id === c.campana_id).map((x) => x.id));
  return [...sel.filter((x) => !misma.has(x)), c.id].sort((a, b) => a - b);
}

/**
 * «Usar también para…»: las versiones abiertas de la visita a las que la
 * foto todavía no va, cuya plantilla pide esa posición y de una campaña que
 * la foto todavía no tiene (A1). Las que ya devolvieron esa foto salen
 * marcadas (B4) y la hoja no deja elegirlas.
 */
export function candidatasUsarTambien(
  foto: Pick<FotoEnVisita, 'pos' | 'momento' | 'toma_ids' | 'path' | 'tipo'> & Partial<Pick<FotoEnVisita, 'no_ligada'>>,
  tomas: readonly TomaMia[],
  estado: EstadoVisita | null | undefined,
  incluidas: ReadonlySet<string>,
  hoy: string
): CandidataDeCual[] {
  const pos = foto.tipo === 'video' ? POS_EXTRA : foto.pos;
  // POR QUÉ (27-oct-2026): donde el servidor no la ligó por cerrada, futura o
  // ajena, la campaña sigue libre para esa foto (A1 solo cuenta ligas; una
  // duplicada sí la ocupa). Igual que ocupaCampana de la cola.
  const libres = new Set((foto.no_ligada ?? []).filter((x) => x.razon !== 'duplicada').map((x) => x.toma_id));
  const campanasYa = new Set(tomas.filter((t) => foto.toma_ids.includes(t.id) && !libres.has(t.id)).map((t) => t.campana_id));
  return candidatasDeCual(tomas, pos, foto.momento, estado, incluidas, hoy, foto.path).filter(
    (c) => !foto.toma_ids.includes(c.id) && !campanasYa.has(c.campana_id)
  );
}

/**
 * La foto con la que sigue abierta la hoja «Usar también para…» (la de
 * ahora), o null si la foto se fue y la hoja se cierra.
 * POR QUÉ (27-oct-2026): se fue solo si sale como lápida o perdida, o si su
 * trabajo sigue en la cola sin ella (la cola la volvió lápida al soltar la
 * visita). Si la visita salió de la cola (estado null, o ya no está su
 * trabajo) la foto sigue arriba, p. ej. registrada en su toma: la hoja sigue
 * con la última que se vio y la cola la liga por el registro remoto. Antes se
 * cerraba con «Esa foto ya no está en la visita.» y ya no había cómo usarla.
 */
export function fotoDeLaHoja(
  estado: Pick<EstadoVisita, 'fotos' | 'trabajos' | 'lapidas'> | null | undefined,
  f: FotoEnVisita
): FotoEnVisita | null {
  const ahora = estado?.fotos.find((x) => (x.trabajo === f.trabajo && x.fid === f.fid) || x.cliente_id === f.cliente_id);
  if (ahora) return ahora.estado === 'perdido' ? null : ahora;
  const seFue = !!estado && (estado.trabajos.includes(f.trabajo) || estado.lapidas.some((l) => l.cliente_id === f.cliente_id));
  return seFue ? null : f;
}

// ------------------------------------------------------------
// Lo que dice la tarjeta
// ------------------------------------------------------------

/**
 * «N fotos arriba sin enviar» (B11): fotos que el servidor ya tiene en tomas
 * pendientes de días anteriores que nadie envió (se cerró la app o no se tocó
 * «Listo con este sitio»). Lo de alcance sitio se cuenta una vez por día y
 * posición (la misma foto vale para todas las versiones).
 */
export function fotosArribaSinEnviar(tomas: readonly TomaMia[], hoy: string): number {
  let n = 0;
  const sitio = new Map<string, number>();
  for (const t of tomas) {
    if (t.estado !== 'pendiente' || t.fecha >= hoy) continue;
    const alcance = new Map(t.plantilla.map((q) => [llavePos(q.pos, q.momento), q.alcance]));
    for (const x of t.tiene) {
      if (x.n <= 0) continue;
      if (alcance.get(llavePos(x.pos, x.momento)) === 'sitio') {
        const k = `${t.fecha}|${llavePos(x.pos, x.momento)}`;
        sitio.set(k, Math.max(sitio.get(k) ?? 0, x.n));
      } else n += x.n;
    }
  }
  for (const v of sitio.values()) n += v;
  return n;
}

/** Una foto de cámara que el monitorista quitó (entera o de una toma) y espera saber si de verdad se fue. */
export type FotoPorSacar = { cliente_id: string; nombre: string };

/**
 * «Quitar» o «Quitar de A»: ¿ya se puede sacar su copia de cámara de
 * «Guardar en Fotos»? POR QUÉ (26-oct-2026): antes se sacaba al tocar el
 * botón; pero si la base no dejaba quitarla (una toma ya enviada o revisada)
 * la foto volvía a la tarjeta, y «Quitar de A» nunca se lleva la foto (se
 * queda aunque A fuera su última liga): se perdía la única copia que
 * «Guardar en Fotos» podía ofrecer. Ahora decide la cola:
 *   · `sacar`: la cola ya la dejó como lápida firme (estado.lapidas) o ya
 *     la quitó de verdad (`quitadas`, adaptadorComp.fotosQuitadasDeVerdad:
 *     sirve aunque la visita se haya soltado sin que la pantalla viera la
 *     lápida, 27-oct-2026);
 *   · `resueltas`: ya no hay que esperar (se fue, se quedó o la visita ya no
 *     está en la cola: ante la duda la copia se queda);
 *   · lo demás espera: la base todavía no contesta.
 */
export function camaraPorSacar(
  estado: Pick<EstadoVisita, 'fotos'> & Partial<Pick<EstadoVisita, 'lapidas' | 'retiradas'>> | null | undefined,
  pendientes: readonly FotoPorSacar[],
  quitadas: ReadonlySet<string> = new Set()
): { sacar: string[]; resueltas: string[] } {
  const sacar: string[] = [];
  const resueltas: string[] = [];
  for (const p of pendientes) {
    if (quitadas.has(p.cliente_id)) {
      sacar.push(p.nombre);
      resueltas.push(p.cliente_id);
      continue;
    }
    if (!estado) {
      resueltas.push(p.cliente_id);
      continue;
    }
    const l = (estado.lapidas ?? []).find((x) => x.cliente_id === p.cliente_id);
    if (l) {
      if (!l.porConfirmar) {
        sacar.push(p.nombre);
        resueltas.push(p.cliente_id);
      }
      continue;
    }
    const f = estado.fotos.find((x) => x.cliente_id === p.cliente_id);
    const enCurso =
      !!f &&
      (!(f.estado === 'ligado' || f.estado === 'perdido') ||
        (estado.retiradas ?? []).some((r) => r.cliente_id === p.cliente_id && r.pendiente));
    if (!enCurso) resueltas.push(p.cliente_id);
  }
  return { sacar, resueltas };
}

/** Fotos de la cola en todas las visitas (la píldora «⬆ N»). */
export function porSubirTotal(estados: Iterable<EstadoVisita | null | undefined>): number {
  let n = 0;
  for (const e of estados) n += e?.porSubir ?? 0;
  return n;
}

/** «1 foto», «3 fotos». */
export function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}
