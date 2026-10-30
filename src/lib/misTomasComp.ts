// ============================================================
// src/lib/misTomasComp.ts
// La lista del monitorista en Mis rutas › Comprobaciones, fase 3
// (26-oct-2026). PURA: sin red ni React; la prueba
// tests/misTomasComp.test.mjs.
//
// DE DÓNDE SALE. comp_mis_tomas(p_desde, p_hasta) devuelve SUS tomas (las
// de su ruta, las que Victor le puso a mano en Formato y las devueltas que
// él tomó), ya con la plantilla resuelta y lo que tiene cada una. Aquí:
//   · se valida la respuesta (también la copia del teléfono, que puede ser
//     de una versión anterior de la app): lo que no se entiende se descarta;
//   · se arma UNA TARJETA POR SITIO del día que se ve (especificación §6.1),
//     con sus tomas (campaña-versión) adentro;
//   · se ordena: primero las tarjetas con alguna DEVUELTA (en rojo), luego
//     por ruta y parada y al final «Sin ruta», por clave. La parada es la
//     que numera Mis rutas (la manda la base; revisión del 26-oct-2026: en
//     Ecovallas casi ninguna ubicación trae secuencia).
//   · dentro de la tarjeta: devueltas, las del día que se ve, las vencidas
//     de la más reciente a la más vieja y al final las enviadas.
//
// QUÉ ENTRA EN EL DÍA. Las tomas de ese día. En HOY, además, las devueltas
// de cualquier día y las pendientes vencidas (de días anteriores): así no se
// pierden de vista (la base las manda hasta 31 días atrás).
// ============================================================

// Solo tipos: esbuild los borra y la prueba no arrastra el cliente de red.
import type { TurnoToma } from './comprobacionesApi';
import type { CodigoFallaComp } from './fallasComp';
import type { UnidadComp } from './unidadesComp';
import {
  avancePorPosicion,
  leerPosiciones,
  leerTiene,
  type FaltaPos,
  type MomentoPos,
  type PosPlantilla,
  type TienePos,
} from './plantillasComp';

export type EstadoTomaMia = 'pendiente' | 'regresada' | 'por_revisar';

/** Una foto que la analista rechazó (incremento 3; solo en las devueltas). */
export type FotoRechazada = { evidencia_id: number; path: string; pos: string; motivo: string };

/** Una toma de comp_mis_tomas (§4.1 1i de la especificación). */
export type TomaMia = {
  id: number;
  estado: EstadoTomaMia;
  /** AAAA-MM-DD. */
  fecha: string;
  horario_texto: string | null;
  turno: TurnoToma | null;
  observaciones: string | null;
  notas: string | null;
  /** Cuántas veces la devolvieron (la cola compara este número, nunca el reloj). */
  regreso_n: number;
  rechazo_motivo: string | null;
  campana_id: number;
  campana: string;
  version: string;
  /** Hasta 300 caracteres. */
  especificacion: string | null;
  plantilla_codigo: string | null;
  sitio_id: number;
  sitio_clave: string;
  site_id: string | null;
  vendor_face_id: string | null;
  espacio_vv: string | null;
  /** inventario.tipo_mueble (Biobox: 'M4', 'M5 OXXO'…). */
  mueble: string | null;
  lat: number | null;
  lng: number | null;
  ruta_id: number | null;
  ruta_numero: number | null;
  /** ruta_ubicaciones.secuencia tal cual (en Ecovallas casi siempre vacía). */
  secuencia: number | null;
  /**
   * La parada como la numera Mis rutas («Parada i+1»: secuencia nulls last y
   * luego site_id), calculada en la base (revisión del 26-oct-2026). Una
   * copia vieja del teléfono no la trae: entonces se usa la secuencia.
   */
  parada: number | null;
  /**
   * tipo_medio de la ruta (Digital, Impreso, Combinada). En Biobox los
   * números se repiten entre Digital e Impreso: «Ruta 3» puede ser dos.
   */
  ruta_medio: string | null;
  /**
   * Lo que pide AL MONITORISTA (plantilla_usada si ya se envió; si no, la
   * vigente). Desde comp_f3_revision (29-oct-2026) es solo la parte de campo:
   * una posición con via 'camara' nunca queda aquí (ver por_camara).
   */
  plantilla: PosPlantilla[];
  /**
   * Posiciones que en esta toma sube la analista desde cámaras (modo mixto,
   * spec §11; misma forma que plantilla, con via 'camara'). Solo se dicen
   * («La foto Corta la sube la analista desde cámaras»): no se toman, no
   * cuentan en la tarjeta ni en la hoja. Antes de la migración no viene: [].
   */
  por_camara: PosPlantilla[];
  /** Fotos vigentes no rechazadas, por posición. */
  tiene: TienePos[];
  rechazadas: FotoRechazada[];
  /**
   * La unidad. La especificación no la lista por toma (sí en `unidades`),
   * pero comp_f3_modelo la manda desde la integración del 26-oct-2026: separa
   * sitios con la misma clave en dos unidades y da el rótulo. Una copia vieja
   * del teléfono puede no traerla: entonces llega null y se agrupa por clave.
   */
  unidad: UnidadComp | null;
};

/** La respuesta de comp_mis_tomas. */
export type RespMisTomas = {
  /** Día del SERVIDOR (CDMX) al contestar. */
  hoy: string;
  /** ¿La captura está abierta para esta cuenta (comp_piloto)? */
  captura: boolean;
  unidades: UnidadComp[];
  tomas: TomaMia[];
  /** Pasó de 1,500 tomas y la base cortó (devueltas y hoy primero). */
  cortada: boolean;
};

// ------------------------------------------------------------
// Lectura tolerante
// ------------------------------------------------------------

const ES_DIA = /^\d{4}-\d{2}-\d{2}$/;

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function unidadDe(v: unknown): UnidadComp | null {
  return v === 'Ecovallas' || v === 'Biobox' || v === 'Vía Verde' ? v : null;
}

function turnoDe(v: unknown): TurnoToma | null {
  return v === 'matutino' || v === 'vespertino' || v === 'campo' ? v : null;
}

function leerRechazadas(x: unknown): FotoRechazada[] {
  if (!Array.isArray(x)) return [];
  const out: FotoRechazada[] = [];
  for (const it of x) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const id = numero(o.evidencia_id);
    if (id === null) continue;
    out.push({
      evidencia_id: id,
      path: typeof o.path === 'string' ? o.path : '',
      pos: typeof o.pos === 'string' ? o.pos : '',
      motivo: typeof o.motivo === 'string' ? o.motivo : '',
    });
  }
  return out;
}

/**
 * La plantilla de la respuesta partida en lo de campo y lo de cámara
 * (comp_f3_revision, 29-oct-2026). La base ya manda 'plantilla' solo con lo de
 * campo y 'por_camara' aparte; por si una posición con via 'camara' llegara en
 * 'plantilla' (no debe pasar), se pasa a por_camara: el monitorista nunca la
 * debe ver como «falta» ni ofrecer en «¿Qué es?».
 */
export function partirPlantilla(plantilla: unknown, porCamara: unknown): { campo: PosPlantilla[]; camara: PosPlantilla[] } {
  const todas = leerPosiciones(plantilla);
  const campo = todas.filter((p) => p.via !== 'camara');
  const camara: PosPlantilla[] = [];
  const vistas = new Set<string>();
  for (const p of [...todas.filter((x) => x.via === 'camara'), ...leerPosiciones(porCamara)]) {
    const k = `${p.pos}|${p.momento ?? ''}`;
    if (vistas.has(k)) continue;
    vistas.add(k);
    camara.push({ ...p, via: 'camara' });
  }
  return { campo, camara };
}

/** Una toma de la respuesta, o null si le falta lo indispensable. */
export function leerTomaMia(x: unknown): TomaMia | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const id = numero(o.id);
  const campana_id = numero(o.campana_id);
  const sitio_id = numero(o.sitio_id);
  const fecha = typeof o.fecha === 'string' ? o.fecha.slice(0, 10) : '';
  const estado = o.estado;
  const sitio_clave = texto(o.sitio_clave);
  if (id === null || campana_id === null || sitio_id === null || !ES_DIA.test(fecha) || !sitio_clave) return null;
  if (estado !== 'pendiente' && estado !== 'regresada' && estado !== 'por_revisar') return null;
  const partes = partirPlantilla(o.plantilla, o.por_camara);
  return {
    id,
    estado,
    fecha,
    horario_texto: texto(o.horario_texto),
    turno: turnoDe(o.turno),
    observaciones: texto(o.observaciones),
    notas: texto(o.notas),
    regreso_n: Math.max(0, Math.trunc(numero(o.regreso_n) ?? 0)),
    rechazo_motivo: texto(o.rechazo_motivo),
    campana_id,
    campana: typeof o.campana === 'string' ? o.campana : '',
    version: typeof o.version === 'string' ? o.version : '',
    especificacion: texto(o.especificacion),
    plantilla_codigo: texto(o.plantilla_codigo),
    sitio_id,
    sitio_clave,
    site_id: texto(o.site_id),
    vendor_face_id: texto(o.vendor_face_id),
    espacio_vv: texto(o.espacio_vv),
    mueble: texto(o.mueble),
    lat: numero(o.lat),
    lng: numero(o.lng),
    ruta_id: numero(o.ruta_id),
    ruta_numero: numero(o.ruta_numero),
    secuencia: numero(o.secuencia),
    parada: numero(o.parada),
    ruta_medio: texto(o.ruta_medio),
    plantilla: partes.campo,
    por_camara: partes.camara,
    tiene: leerTiene(o.tiene),
    rechazadas: leerRechazadas(o.rechazadas),
    unidad: unidadDe(o.unidad),
  };
}

/**
 * La respuesta completa, o null si no es una respuesta de comp_mis_tomas.
 * Una toma rota se descarta sola; `{tomas: []}` (quien no es monitorista)
 * es una respuesta válida y vacía.
 */
export function leerMisTomas(x: unknown): RespMisTomas | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.tomas)) return null;
  const tomas: TomaMia[] = [];
  const vistas = new Set<number>();
  for (const t of o.tomas) {
    const m = leerTomaMia(t);
    if (m && !vistas.has(m.id)) {
      vistas.add(m.id);
      tomas.push(m);
    }
  }
  const unidades = Array.isArray(o.unidades) ? (o.unidades.map(unidadDe).filter(Boolean) as UnidadComp[]) : [];
  return {
    hoy: typeof o.hoy === 'string' && ES_DIA.test(o.hoy.slice(0, 10)) ? o.hoy.slice(0, 10) : '',
    captura: o.captura === true,
    unidades,
    tomas,
    cortada: o.cortada === true,
  };
}

// ------------------------------------------------------------
// Fallas de la lectura (el monitorista solo LEE)
// ------------------------------------------------------------

/**
 * Por qué se queda la copia del teléfono: sin señal, la sesión renovándose o
 * la base que no contestó a tiempo.
 */
export type MotivoCopia = 'senal' | 'sesion' | 'base';

/**
 * ¿Esta falla de comp_mis_tomas es pasajera? Entonces se queda la copia, sin
 * alerta roja, y el reintento (online / TOKEN_REFRESHED) vuelve a pedir.
 * null = error real (se enseña). Revisión del 26-oct-2026 (monitorista-1):
 * un 401 al renovar el token decía «Tu sesión venció: vuelve a entrar» (y
 * Salir borra la copia), y un candado o un statement_timeout daban textos
 * del Supervisor («Otra persona está guardando…», «Intenta con menos…»).
 */
export function motivoCopiaDeFalla(r: { sinRed: boolean; codigo?: CodigoFallaComp }): MotivoCopia | null {
  if (r.sinRed || r.codigo === 'sin_red') return 'senal';
  if (r.codigo === 'sin_sesion') return 'sesion';
  if (r.codigo === 'ocupada' || r.codigo === 'tardo') return 'base';
  return null;
}

// ------------------------------------------------------------
// Días
// ------------------------------------------------------------

/** 'AAAA-MM-DD' + n días (calendario, sin zona). */
export function sumarDias(dia: string, n: number): string {
  const d = new Date(dia.slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dia;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Días que se piden y se guardan en el teléfono: hoy −3 … hoy +3. */
export const DIAS_ALREDEDOR = 3;

export function rangoMisTomas(hoy: string, dias = DIAS_ALREDEDOR): { desde: string; hasta: string } {
  return { desde: sumarDias(hoy, -dias), hasta: sumarDias(hoy, dias) };
}

const DIAS_SEM = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** '2026-10-29' → «mié 29-oct». */
export function diaCorto(dia: string): string {
  const d = new Date(dia.slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d.getTime())) return dia;
  return `${DIAS_SEM[d.getUTCDay()]} ${d.getUTCDate()}-${MESES[d.getUTCMonth()]}`;
}

/** «Hoy · mié 29-oct», «Ayer · …», «Mañana · …» o solo el día. */
export function etiquetaDia(dia: string, hoy: string): string {
  const pre = dia === hoy ? 'Hoy' : dia === sumarDias(hoy, -1) ? 'Ayer' : dia === sumarDias(hoy, 1) ? 'Mañana' : '';
  return pre ? `${pre} · ${diaCorto(dia)}` : diaCorto(dia);
}

// ------------------------------------------------------------
// Qué entra en el día y cómo se agrupa
// ------------------------------------------------------------

/** ¿Pendiente de un día que ya pasó? */
export const esVencida = (t: TomaMia, hoy: string): boolean => t.estado === 'pendiente' && t.fecha < hoy;

/**
 * Las tomas que se ven en `dia`: las de ese día y, si es HOY, también las
 * devueltas de cualquier día y las pendientes vencidas.
 */
export function tomasDelDia(tomas: readonly TomaMia[], dia: string, hoy: string): TomaMia[] {
  return tomas.filter(
    (t) => t.fecha === dia || (dia === hoy && (t.estado === 'regresada' || esVencida(t, hoy)))
  );
}

/**
 * Filtro de los chips: Por tomar · Vencidas · Devueltas · Enviadas (null =
 * todas). Las vencidas van aparte (revisión del 26-oct-2026): con plan diario
 * se juntan decenas por sitio y «Por tomar (78)» para 3 columnas confundía.
 */
export type FiltroMisTomas = 'por_tomar' | 'vencidas' | 'devueltas' | 'enviadas' | null;

/** El chip al que pertenece una toma. */
export function grupoDeToma(t: TomaMia, hoy: string): Exclude<FiltroMisTomas, null> {
  if (t.estado === 'regresada') return 'devueltas';
  if (t.estado === 'por_revisar') return 'enviadas';
  return esVencida(t, hoy) ? 'vencidas' : 'por_tomar';
}

export function pasaFiltro(t: TomaMia, f: FiltroMisTomas, hoy: string): boolean {
  return f === null || grupoDeToma(t, hoy) === f;
}

/** Conteo de los chips (sobre las tomas del día, sin filtro). */
export function contarEstados(tomas: readonly TomaMia[], hoy: string): Record<Exclude<FiltroMisTomas, null>, number> {
  const c = { por_tomar: 0, vencidas: 0, devueltas: 0, enviadas: 0 };
  for (const t of tomas) c[grupoDeToma(t, hoy)]++;
  return c;
}

/** Una posición de alcance sitio con lo que ya hay (la fila «Fotos de sitio»). */
export type FotoSitio = { pos: string; momento: MomentoPos; etiqueta: string; n: number; tiene: number };

/** Un sitio en el día que se ve: lo que pinta TarjetaSitioComp. */
export type TarjetaSitio = {
  /** Llave estable para React: unidad|clave|día. */
  clave: string;
  sitio_clave: string;
  unidad: UnidadComp | null;
  dia: string;
  ruta_id: number | null;
  ruta_numero: number | null;
  secuencia: number | null;
  /** La de Mis rutas (o la secuencia, si la copia es vieja). */
  parada: number | null;
  ruta_medio: string | null;
  /**
   * ¿Otra ruta de la misma unidad trae el mismo número en esta lista? (Biobox:
   * Digital 3 e Impreso 3). Entonces el rótulo lleva el medio.
   */
  ruta_repetida: boolean;
  lat: number | null;
  lng: number | null;
  mueble: string | null;
  espacio_vv: string | null;
  /** ¿Trae alguna toma devuelta? (va arriba, en rojo) */
  devuelta: boolean;
  /** En orden: devueltas, las del día, vencidas (de la más reciente a la más vieja), enviadas. */
  tomas: TomaMia[];
  /**
   * Posiciones de alcance sitio (valen para todas las versiones de ese día):
   * las de las tomas del día que se ve (no las vencidas que Hoy también junta).
   */
  fotosSitio: FotoSitio[];
};

const natural = (a: string, b: string) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });

/**
 * Orden dentro de la tarjeta (revisión del 26-oct-2026, monitorista-5):
 * devueltas, las del día que se ve, las vencidas de la más reciente a la más
 * vieja (como las corta la base) y las enviadas. Antes la de hoy salía al
 * final, debajo de 25 vencidas de un plan diario.
 */
function pesoToma(t: TomaMia, dia: string): number {
  if (t.estado === 'regresada') return 0;
  if (t.estado === 'por_revisar') return 3;
  return t.fecha === dia ? 1 : 2;
}

function compararTomas(dia: string) {
  return (a: TomaMia, b: TomaMia): number => {
    const pa = pesoToma(a, dia);
    const pb = pesoToma(b, dia);
    const f = a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0;
    return (
      pa - pb ||
      (pa === 2 ? -f : f) ||
      natural(a.campana, b.campana) ||
      natural(a.version, b.version) ||
      a.id - b.id
    );
  };
}

/** Las vencidas de OTROS días que Hoy junta en la tarjeta (van plegadas). */
export function vencidasDeOtroDia(t: Pick<TarjetaSitio, 'tomas' | 'dia'>, hoy: string): TomaMia[] {
  return t.tomas.filter((x) => esVencida(x, hoy) && x.fecha !== t.dia);
}

/**
 * Fotos de sitio de una tarjeta: cada posición de alcance 'sitio' de sus
 * tomas por tomar o devueltas (las enviadas ya no piden nada), con el n
 * mayor y lo que tiene la que MENOS tiene (lo que aún falta en alguna).
 */
export function fotosDeSitio(tomas: readonly TomaMia[]): FotoSitio[] {
  const out = new Map<string, FotoSitio>();
  for (const t of tomas) {
    if (t.estado === 'por_revisar') continue;
    for (const q of avancePorPosicion(t.plantilla, t.tiene)) {
      if (q.alcance !== 'sitio') continue;
      const k = `${q.pos}|${q.momento ?? ''}`;
      const a = out.get(k);
      if (!a) out.set(k, { pos: q.pos, momento: q.momento, etiqueta: q.etiqueta, n: q.n, tiene: q.tiene });
      else out.set(k, { ...a, n: Math.max(a.n, q.n), tiene: Math.min(a.tiene, q.tiene) });
    }
  }
  return [...out.values()];
}

/** Lo de la versión (alcance 'version') de una toma, con lo que ya tiene. */
export function posicionesDeVersion(t: TomaMia): (PosPlantilla & { tiene: number })[] {
  return avancePorPosicion(t.plantilla, t.tiene).filter((q) => q.alcance === 'version');
}

/** Lo que le falta a una toma (las dos capas), como comp_faltan. */
export function faltanDeToma(t: TomaMia): FaltaPos[] {
  return avancePorPosicion(t.plantilla, t.tiene)
    .filter((q) => q.tiene < q.n)
    .map((q) => ({ pos: q.pos, momento: q.momento, etiqueta: q.etiqueta, n: q.n, tiene: q.tiene }));
}

/** Orden de las tarjetas: devueltas, con ruta (ruta y parada), sin ruta (clave). */
export function compararTarjetas(a: TarjetaSitio, b: TarjetaSitio): number {
  const sinRutaA = a.ruta_numero === null ? 1 : 0;
  const sinRutaB = b.ruta_numero === null ? 1 : 0;
  const BIG = Number.MAX_SAFE_INTEGER;
  return (
    (a.devuelta ? 0 : 1) - (b.devuelta ? 0 : 1) ||
    sinRutaA - sinRutaB ||
    (a.ruta_numero ?? BIG) - (b.ruta_numero ?? BIG) ||
    (a.ruta_id ?? BIG) - (b.ruta_id ?? BIG) ||
    (a.parada ?? BIG) - (b.parada ?? BIG) ||
    natural(a.sitio_clave, b.sitio_clave) ||
    natural(a.unidad ?? '', b.unidad ?? '')
  );
}

/**
 * Las tarjetas del día: una por sitio (y unidad, si la base la manda), con
 * las tomas que pasan el filtro. La ruta de la tarjeta es la de su toma con
 * ruta de número y parada más bajos (un sitio suele estar en una sola).
 */
export function armarTarjetas(
  tomas: readonly TomaMia[],
  dia: string,
  hoy: string,
  filtro: FiltroMisTomas = null
): TarjetaSitio[] {
  // Números de ruta repetidos en la unidad (Biobox Digital 3 e Impreso 3).
  const idsPorNumero = new Map<string, Set<number>>();
  for (const t of tomas) {
    if (t.ruta_numero === null || t.ruta_id === null) continue;
    const k = `${t.unidad ?? ''}|${t.ruta_numero}`;
    const s = idsPorNumero.get(k) ?? new Set<number>();
    s.add(t.ruta_id);
    idsPorNumero.set(k, s);
  }
  const grupos = new Map<string, TomaMia[]>();
  for (const t of tomasDelDia(tomas, dia, hoy)) {
    if (!pasaFiltro(t, filtro, hoy)) continue;
    const k = `${t.unidad ?? ''}|${t.sitio_clave}`;
    const l = grupos.get(k);
    if (l) l.push(t);
    else grupos.set(k, [t]);
  }
  const out: TarjetaSitio[] = [];
  for (const [k, l] of grupos) {
    l.sort(compararTomas(dia));
    const conRuta = l
      .filter((t) => t.ruta_numero !== null)
      .sort(
        (a, b) =>
          (a.ruta_numero as number) - (b.ruta_numero as number) ||
          (paradaDe(a) ?? Number.MAX_SAFE_INTEGER) - (paradaDe(b) ?? Number.MAX_SAFE_INTEGER)
      )[0];
    const conPunto = l.find((t) => t.lat !== null && t.lng !== null);
    // «Fotos del sitio» valen para las campañas de UN día (integración,
    // 26-oct-2026): en Hoy la tarjeta también junta vencidas y devueltas de
    // otros días, que siguen en 0 y dejarían la fila en «0/3» aunque hoy ya se
    // tomaron. Se cuentan las del día que se ve; si la tarjeta no tiene ninguna
    // de ese día, las del día más reciente que trae.
    const pideSitio = l.filter((t) => t.estado !== 'por_revisar');
    const diaSitio = pideSitio.some((t) => t.fecha === dia)
      ? dia
      : pideSitio.reduce((m, t) => (t.fecha > m ? t.fecha : m), '');
    out.push({
      clave: `${k}|${dia}`,
      sitio_clave: l[0].sitio_clave,
      unidad: l[0].unidad,
      dia,
      ruta_id: conRuta?.ruta_id ?? null,
      ruta_numero: conRuta?.ruta_numero ?? null,
      secuencia: conRuta?.secuencia ?? null,
      parada: conRuta ? paradaDe(conRuta) : null,
      ruta_medio: conRuta?.ruta_medio ?? null,
      ruta_repetida:
        !!conRuta && (idsPorNumero.get(`${conRuta.unidad ?? ''}|${conRuta.ruta_numero}`)?.size ?? 0) > 1,
      lat: conPunto?.lat ?? null,
      lng: conPunto?.lng ?? null,
      mueble: l.find((t) => t.mueble)?.mueble ?? null,
      espacio_vv: l.find((t) => t.espacio_vv)?.espacio_vv ?? null,
      devuelta: l.some((t) => t.estado === 'regresada'),
      tomas: l,
      fotosSitio: fotosDeSitio(l.filter((t) => t.fecha === diaSitio)),
    });
  }
  return out.sort(compararTarjetas);
}

/** La parada de una toma: la de Mis rutas o, en una copia vieja, la secuencia. */
const paradaDe = (t: Pick<TomaMia, 'parada' | 'secuencia'>): number | null => t.parada ?? t.secuencia;

/**
 * «Ruta 2 · parada 5», «Ruta 2», «Ruta 3 · Impreso · parada 1» (cuando el
 * número se repite en la unidad) o «Sin ruta».
 */
export function textoRuta(
  t: Pick<TarjetaSitio, 'ruta_numero' | 'secuencia'> &
    Partial<Pick<TarjetaSitio, 'parada' | 'ruta_medio' | 'ruta_repetida'>>
): string {
  if (t.ruta_numero === null) return 'Sin ruta';
  const p = t.parada ?? t.secuencia;
  const medio = t.ruta_repetida && t.ruta_medio ? ` · ${t.ruta_medio}` : '';
  return `Ruta ${t.ruta_numero}${medio}${p !== null ? ` · parada ${p}` : ''}`;
}

/** «Tecate Always V2» (campaña y versión sin repetir). */
export function nombreToma(t: Pick<TomaMia, 'campana' | 'version'>): string {
  const c = (t.campana || '').trim();
  const v = (t.version || '').trim();
  if (!v) return c || 'Sin campaña';
  return c.toUpperCase().endsWith(v.toUpperCase()) ? c : `${c} ${v}`;
}

// ------------------------------------------------------------
// Lo que va por cámara (modo mixto, comp_f3_revision, 29-oct-2026)
// ------------------------------------------------------------

/** «Corta», «Corta y Media», «Corta, Media y Larga» (sin repetir). */
function listaEtiquetas(pos: readonly Pick<PosPlantilla, 'etiqueta'>[]): string {
  const l = [...new Set(pos.map((p) => p.etiqueta.trim()).filter(Boolean))];
  if (l.length <= 1) return l.join('');
  return `${l.slice(0, -1).join(', ')} y ${l[l.length - 1]}`;
}

/**
 * «La foto Corta la sube la analista desde cámaras: tú no la tomas.» (spec
 * §11, Mis rutas). «La foto …» y no «La Corta …»: las etiquetas mezclan
 * géneros (Ángulo, Toma). '' si no hay nada por cámara.
 */
export function textoPorCamara(pos: readonly Pick<PosPlantilla, 'etiqueta'>[]): string {
  const lista = listaEtiquetas(pos);
  if (!lista) return '';
  const varias = lista.includes(' y ');
  return varias
    ? `Las fotos ${lista} las sube la analista desde cámaras: tú no las tomas.`
    : `La foto ${lista} la sube la analista desde cámaras: tú no la tomas.`;
}

/** ¿La toma todavía pide fotos al monitorista? (las enviadas ya no). */
const pideFotos = (t: Pick<TomaMia, 'estado'>) => t.estado !== 'por_revisar';

/** Firma de lo que va por cámara (pos|momento ordenado). */
const firmaCamara = (t: Pick<TomaMia, 'por_camara'>) =>
  (t.por_camara ?? [])
    .map((p) => `${p.pos}|${p.momento ?? ''}`)
    .sort()
    .join(',');

/**
 * El aviso de cámara de la TARJETA: si todas las tomas que todavía piden
 * fotos llevan lo mismo por cámara (lo normal: la campaña de Vía Verde en
 * mixto con la Corta por cámara), se dice una vez arriba y no en cada
 * versión; si no, null y cada versión dice la suya (porCamaraDeToma).
 */
export function porCamaraDeTarjeta(tomas: readonly Pick<TomaMia, 'estado' | 'por_camara'>[]): string | null {
  const abiertas = tomas.filter(pideFotos);
  if (!abiertas.length) return null;
  const f = firmaCamara(abiertas[0]);
  if (!f || abiertas.some((t) => firmaCamara(t) !== f)) return null;
  return textoPorCamara(abiertas[0].por_camara);
}

/**
 * El aviso de cámara de UNA versión dentro de la tarjeta: '' si ya se dijo
 * arriba (`deTarjeta`), si ya se envió o si no lleva nada por cámara.
 */
export function porCamaraDeToma(t: Pick<TomaMia, 'estado' | 'por_camara'>, deTarjeta: string | null): string {
  if (deTarjeta || !pideFotos(t)) return '';
  return textoPorCamara(t.por_camara ?? []);
}
