// ============================================================
// src/lib/colaFotos/logicaComp.ts
// Lo PURO de la cola de fotos de Comprobaciones (fase 3, incremento 2,
// 26-oct-2026): la forma del trabajo (una VISITA a un sitio en un día), la
// ruta de Storage, el nombre para compartir, qué tomas ya se pueden
// registrar y los textos. Sin red, sin IndexedDB y sin React: lo prueban
// tests/colaFotosLogica.test.mjs y tests/colaFotosComp.test.mjs. La
// pantalla puede importarlo sin arrastrar la cola.
//
// POR QUÉ UNA VISITA Y NO UNA TOMA (especificación §6.1 y §7): en un sitio
// el monitorista toma varias versiones en el mismo loop, y una foto de
// alcance sitio (copete, lateral) vale para todas las de ese día. El trabajo
// es la visita correo|unidad|sitio_clave|día; cada foto lleva las tomas a
// las que se liga (lo que eligió en la hoja «¿de cuál?») y el servidor
// contesta por cada una.
//
// REGISTRO (B11). La base cuenta (comp_registrar_tomas contesta `faltan`);
// el teléfono solo decide CUÁNDO pedirlo: cuando la plantilla de la toma ya
// está completa con lo que la pantalla vio (`tiene`) más lo que esta visita
// ligó, y ninguna foto de esa toma sigue en camino (un video no cuenta ni
// detiene: B6).
// POR QUÉ `incluidas` (26-oct-2026): después de releer la lista, `tiene` ya
// trae las fotos que la cola ligó antes de esa lectura; si se sumaran otra
// vez, la cola pediría el registro antes de tiempo y la base contestaría
// `faltan`, que la tarjeta pinta en ámbar a media visita (§6.1 y B11: el
// ámbar es de «Listo con este sitio»). La pantalla dice qué ligas ya venían
// contadas (las que la cola tenía al EMPEZAR la lectura) y aquí se saltan,
// igual que en capturaComp.tieneVisto.
// ============================================================

import type { UnidadComp } from '../unidadesComp';
import { faltan as faltanPlantilla, type FaltaPos, type MomentoPos, type PosPlantilla, type TienePos } from '../plantillasComp';
import { esFinal, limpiarNombre, type ArchivoCola, type TrabajoCola } from './logica';

// ------------------------------------------------------------
// Tipos
// ------------------------------------------------------------

/**
 * Qué contestó el servidor por cada toma al ligar una foto (comp_subir_foto,
 * §4.2 2c). 'por_camara' (comp_f3_revision, 29-oct-2026): la base la manda en
 * `duplicadas`, pero la posición en esa toma la sube la analista desde
 * cámaras (ver resolverLiga). No cuenta, no crea liga y no cierra la toma: la
 * cola la sigue registrando con lo de campo.
 */
export type ResolucionLiga = 'ligada' | 'cerrada' | 'futura' | 'ajena' | 'duplicada' | 'por_camara';

/** Por qué una foto no cuenta en una toma (lo que se le dice al monitorista). */
export type RazonNoLigada = Exclude<ResolucionLiga, 'ligada'>;

export type ArchivoComp = ArchivoCola & {
  /** UUID que genera el teléfono: llave idempotente de comp_evidencias. */
  cliente_id: string;
  /** Posición de la plantilla ('corta', 'lateral'…) o 'extra'. */
  pos: string;
  momento: MomentoPos;
  /** Hora de la foto según el teléfono (cámara: al tomarla; galería: lastModified). */
  tomada_en_tel: string | null;
  lat: number | null;
  lng: number | null;
  precision_m: number | null;
  /** Tomas a las que se liga (la hoja + «Usar también para…»). */
  toma_ids: number[];
  /** Respuesta del servidor por toma (llave = id de la toma en texto). */
  resueltas: Record<string, ResolucionLiga>;
  /** comp_subir_foto contestó ya=true: la foto ya había entrado (reintento). */
  ya?: boolean;
  evidencia_id?: number | null;
  /** Día que el SERVIDOR le puso a la foto (A1: hoy-2..hoy). */
  fecha_servidor?: string | null;
  /** Tomas de las que hay que quitar SOLO esa liga (comp_quitar_foto con p_toma_id). */
  desligar?: number[];
  /**
   * Tomas de las que el servidor YA quitó la liga (comp_quitar_foto contestó
   * bien, con o sin p_toma_id). Mientras la lista no se vuelva a leer, su
   * `tiene` todavía la cuenta: ver retiradasDe.
   */
  quitadaDe?: number[];
  /** Veces seguidas que la base contestó `sin_objeto` (el archivo no está en Storage). */
  sinObjeto?: number;
  /** Ids de toma cuya liga fallida ya se avisó (para no repetirlo). */
  avisadas?: number[];
  /** Sin copia en el teléfono: llegó por «Usar también para…» o «Quitar» de una foto ya cerrada. */
  remoto?: boolean;
  /**
   * La base no tiene su fila (se le quitó su última liga, o era nueva y
   * ninguna toma la aceptó) y el objeto sigue en Storage (26 y 27-oct-2026).
   * La foto se queda en la tarjeta y «Usar también
   * para…» puede volver a crear la fila; si no cuenta en ninguna toma, al
   * soltar o descartar la visita pasa a lápida y la cola borra el objeto
   * (mientras no lo empiece a borrar, «Usar también para…» la revive).
   */
  sinFila?: boolean;
  /** La cola ya empezó a borrar el objeto de esta lápida: ya no se revive. */
  borrando?: boolean;
};

/** Cómo terminó el registro de una toma de la visita (null = aún no). */
export type FinRegistro = 'enviada' | 'cerrada' | 'futura' | 'ajena' | 'regresada';

export type EstadoTomaVisita = 'pendiente' | 'regresada' | 'por_revisar';

/** Una toma (campaña-versión) de la visita, como la vio la pantalla. */
export type TomaEnVisita = {
  id: number;
  campana_id: number;
  /** «Tecate Always V2»: solo para los textos. */
  nombre: string;
  /** AAAA-MM-DD de la toma (una vencida es de un día anterior a la visita). */
  fecha: string;
  estado: EstadoTomaVisita;
  /** El que vio la pantalla: si el servidor trae otro, la devolvieron después. */
  regreso_n: number;
  /** Lo que pide (la plantilla de comp_mis_tomas: solo lo de campo). */
  plantilla: PosPlantilla[];
  /**
   * Posiciones que en esta toma sube la analista desde cámaras (por_camara de
   * comp_mis_tomas, 29-oct-2026). Solo para el texto de una foto que la base
   * contestó en `duplicadas` por eso. Un trabajo de antes no la trae.
   */
  por_camara?: string[];
  /**
   * Posiciones que la BASE dijo, en esta visita, que van por cámara (una
   * foto suya salió 'por_camara'). Sobreviven a fundirTomas: la pantalla
   * puede seguir mandando la lista vieja (ver pasarACamara).
   */
  camara_servidor?: string[];
  /** Lo que el servidor ya tenía cuando la pantalla la leyó. */
  tiene: TienePos[];
  /** cliente_id de las fotos de la visita que ya vienen contadas en `tiene` (no se suman otra vez). */
  incluidas?: string[];
  reg?: FinRegistro | null;
  /** Con reg = 'enviada': cómo quedó ('comprobada' = re-entrega que se comprobó sola). */
  regEstado?: 'por_revisar' | 'comprobada' | null;
  /** Lo último que la base dijo que falta (comp_registrar_tomas). */
  faltan?: FaltaPos[] | null;
  /** Con qué fotos dijo la base `faltan`: no se vuelve a pedir hasta que cambien. */
  faltanFirma?: string | null;
};

export type TrabajoComp = TrabajoCola<ArchivoComp> & {
  v: 1;
  tipo: 'comp';
  unidad: UnidadComp;
  sitio_clave: string;
  /** Día de la visita (AAAA-MM-DD). */
  fecha: string;
  tomas: TomaEnVisita[];
  /** «Listo con este sitio»: registra lo que se pueda, dice lo que falta y cierra. */
  cerrar: boolean;
  cerrarPedidoEn: string | null;
};

/** Lo que pinta el aviso breve (se juntan por visita). */
export type LogroComp = {
  /** La clave de la visita. */
  llave: string;
  sitio_clave: string;
  /** Fotos que quedaron ligadas en esa corrida. */
  fotos: number;
  /** Tomas que quedaron enviadas (por revisar o comprobadas) en esa corrida. */
  tomas: number;
  /** Cuándo (ms, reloj del teléfono). */
  en: number;
};

// ------------------------------------------------------------
// Nombres y rutas
// ------------------------------------------------------------

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();

/** correo|unidad|sitio_clave|día: una visita activa por sitio y día. */
export function claveVisita(email: string, unidad: string, sitio_clave: string, fecha: string): string {
  return `${norm(email)}|${unidad}|${sitio_clave}|${fecha}`;
}

const SLUG: Record<string, string> = { Ecovallas: 'ecovallas', Biobox: 'biobox', 'Vía Verde': 'via-verde' };

/** Como comp_slug_unidad: Ecovallas → ecovallas, Vía Verde → via-verde. '' si no es de Comprobaciones. */
export function slugUnidad(unidad: string): string {
  return SLUG[unidad] ?? '';
}

/**
 * ¿La clave del sitio puede ir tal cual en la ruta? comp_subir_foto compara
 * la 4.ª parte de la ruta con sitio_clave EXACTA (B4), así que no se puede
 * limpiar: si trae «/» o algo que Storage no acepta, no se puede capturar.
 */
export function claveUsableEnRuta(sitio_clave: string): boolean {
  return /^[A-Za-z0-9_\-.,()' &$@=;:+!*]{1,120}$/.test(sitio_clave || '') && !/^\.+$/.test(sitio_clave);
}

/** Extensión que la base acepta ([a-z0-9]{2,5}); si no, jpg o mp4. */
export function extensionComp(ext: string | null | undefined, tipo: 'foto' | 'video'): string {
  const e = (ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (e === 'jpeg') return 'jpg';
  return /^[a-z0-9]{2,5}$/.test(e) ? e : tipo === 'video' ? 'mp4' : 'jpg';
}

/**
 * Ruta FIJA de la foto (§4.2, B4):
 * comp/<ecovallas|biobox|via-verde>/<AAAA-MM>/<sitio_clave>/<AAAAMMDD>_<cliente_id>.<ext>.
 * El día es el del teléfono al encolar (la base pone el suyo en la fila).
 */
export function rutaFotoComp(p: { unidad: string; sitio_clave: string; dia: string; cliente_id: string; ext: string }): string {
  const [a, m, d] = p.dia.split('-');
  return `comp/${slugUnidad(p.unidad)}/${a}-${m}/${p.sitio_clave}/${a}${m}${d}_${p.cliente_id.toLowerCase()}.${p.ext}`;
}

/** <sitio_clave>_<DDMM>_<n>.<ext> (§6.1): único dentro de la visita y con extensión (iOS). */
export function nombreParaCompartirComp(sitio_clave: string, dia: string, n: number, ext: string): string {
  const [, m, d] = (dia || '').split('-');
  return `${limpiarNombre(sitio_clave)}_${d || '00'}${m || '00'}_${n}.${(ext || 'jpg').toLowerCase()}`;
}

/** ¿Parece un UUID? (cliente_id). */
export function esUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
}

// ------------------------------------------------------------
// Ligas
// ------------------------------------------------------------

/** Tomas de la foto que el servidor aún no contesta. */
export function porLigar(a: Pick<ArchivoComp, 'toma_ids' | 'resueltas'>): number[] {
  return a.toma_ids.filter((id) => !a.resueltas[String(id)]);
}

/**
 * ¿La foto cuenta en esa toma? Solo 'ligada'. POR QUÉ (26-oct-2026): la base
 * contesta un reintento de una liga vigente en `ligadas`; en `duplicadas`
 * solo quedan la liga devuelta (B4) y la de otro día de la misma campaña
 * (A1), y en ninguna de las dos la foto cuenta (aunque venga con `ya`).
 */
export function cuentaEnToma(a: Pick<ArchivoComp, 'resueltas'>, tomaId: number): boolean {
  return a.resueltas[String(tomaId)] === 'ligada';
}

/**
 * ¿La foto ya ocupa la campaña de esa toma? (A1: una foto vale para un solo
 * día de cada campaña). Sí mientras el servidor no contesta y cuando la ligó
 * o la dio por duplicada (devuelta, B4, u otro día ya ligado, A1). No si la
 * dio por cerrada, futura o ajena. POR QUÉ (27-oct-2026): ahí la base no
 * crea liga (y si era una foto nueva, ni siquiera la fila), así que esa
 * misma foto sí puede ir a otro día de la misma campaña con «Usar también
 * para…».
 */
// 'por_camara' (29-oct-2026) tampoco ocupa: la base no creó la liga.
export function ocupaCampana(a: Pick<ArchivoComp, 'resueltas'>, tomaId: number): boolean {
  const r = a.resueltas[String(tomaId)];
  return !r || r === 'ligada' || r === 'duplicada';
}

/** ¿Una FOTO de esa toma sigue en camino? (en el teléfono, subiendo o rechazada; un video nunca cuenta, B6). */
function enCamino(a: ArchivoComp, tomaId: number): boolean {
  if (a.tipo !== 'foto') return false;
  if (a.estado === 'quitado' || a.estado === 'perdido') return false;
  if (a.estado === 'ligado') return false;
  return a.toma_ids.includes(tomaId) && !a.resueltas[String(tomaId)];
}

/** Fotos de la visita que cuentan en la toma y que `tiene` todavía no trae. */
function sumanEnToma(toma: Pick<TomaEnVisita, 'id' | 'incluidas'>, a: ArchivoComp): boolean {
  return a.estado !== 'quitado' && cuentaEnToma(a, toma.id) && !toma.incluidas?.includes(a.cliente_id);
}

/** Una liga foto ↔ toma que el monitorista quitó: `pendiente` = el servidor todavía la tiene. */
export type Retirada = { toma_id: number; pendiente: boolean };

/**
 * Las ligas de una FOTO que el monitorista quitó (26-oct-2026). POR QUÉ: la
 * lista (`tiene`) que se leyó antes de «Quitar» todavía la cuenta; si no se
 * descontara, la casilla seguía con ✓ y la cola pedía el registro con una foto
 * que ya no está. Pendientes: la foto entera por limpiar (sus ligas y las que
 * esperaban desligarse) o lo que espera `desligar`. Confirmadas: `quitadaDe`.
 * Un descarte (limpiar = 'objeto') no quita ligas: no cuenta. La lápida que
 * la cola deja al soltar una foto sin fila también lleva 'objeto', y sus
 * ligas ya van confirmadas en `quitadaDe`.
 */
export function retiradasDe(a: ArchivoComp): Retirada[] {
  if (a.tipo !== 'foto' || a.estado === 'perdido') return [];
  const pend = new Set<number>();
  if (a.estado === 'quitado') {
    if (a.limpiar === true) {
      for (const id of a.toma_ids) if (cuentaEnToma(a, id)) pend.add(id);
      for (const id of a.desligar ?? []) pend.add(id);
    }
  } else for (const id of a.desligar ?? []) pend.add(id);
  const out: Retirada[] = [...pend].map((toma_id) => ({ toma_id, pendiente: true }));
  for (const id of a.quitadaDe ?? []) if (!pend.has(id)) out.push({ toma_id: id, pendiente: false });
  return out;
}

/** Resta una de esa posición (sin bajar de 0). */
function restar(l: TienePos[], pos: string, momento: MomentoPos): void {
  const x = l.find((y) => y.pos === pos && (y.momento ?? null) === (momento ?? null) && y.n > 0);
  if (x) x.n--;
}

/** Lo que la toma tiene contando lo que esta visita ya ligó (solo fotos; los videos nunca cuentan). */
export function tieneConVisita(toma: Pick<TomaEnVisita, 'id' | 'tiene' | 'incluidas'>, archivos: readonly ArchivoComp[]): TienePos[] {
  const out = toma.tiene.map((x) => ({ ...x }));
  // Lo quitado que la lista leída todavía cuenta (venía en `incluidas`) se descuenta.
  for (const a of archivos)
    if (toma.incluidas?.includes(a.cliente_id) && retiradasDe(a).some((r) => r.toma_id === toma.id)) restar(out, a.pos, a.momento);
  for (const a of archivos) {
    if (a.tipo !== 'foto' || !sumanEnToma(toma, a)) continue;
    out.push({ pos: a.pos, momento: a.momento, n: 1 });
  }
  return out;
}

/** Con qué se decidió: lo que vio la pantalla más las fotos ligadas de la visita que aún no trae. */
export function firmaToma(toma: Pick<TomaEnVisita, 'id' | 'tiene' | 'incluidas'>, archivos: readonly ArchivoComp[]): string {
  const ligadas = archivos
    .filter((a) => sumanEnToma(toma, a))
    .map((a) => a.cliente_id)
    .sort();
  const tiene = toma.tiene
    .map((x) => `${x.pos}|${x.momento ?? ''}|${x.n}`)
    .sort()
    .join(',');
  const quitadas = archivos
    .filter((a) => toma.incluidas?.includes(a.cliente_id) && retiradasDe(a).some((r) => r.toma_id === toma.id))
    .map((a) => a.cliente_id)
    .sort();
  return `${tiene}#${ligadas.join(',')}${quitadas.length ? `#-${quitadas.join(',')}` : ''}`;
}

/**
 * La base dijo que esa posición, en esa toma, va por cámara ('por_camara'):
 * la cola deja de pedirla para decidir el registro, la anota en `por_camara`
 * (para el texto) y en `camara_servidor` (para no olvidarla). POR QUÉ
 * (29-oct-2026): con la lista vieja del teléfono (el Supervisor pasó la
 * campaña a mixto después de leerla) la plantilla de la visita todavía pide
 * la Corta; como nunca cuenta, la toma no se registraba sola. Cada foto nueva
 * vuelve a fundir las tomas con esa lista vieja: reaplicarCamara lo repone.
 * La base cuenta al registrar: si algo no cuadra, contesta `faltan`.
 * Devuelve si cambió algo.
 */
export function pasarACamara(
  toma: Pick<TomaEnVisita, 'plantilla' | 'por_camara' | 'camara_servidor'>,
  pos: string
): boolean {
  const antes = toma.plantilla.length;
  toma.plantilla = toma.plantilla.filter((q) => q.pos !== pos);
  const ya = toma.por_camara?.includes(pos) ?? false;
  if (!ya) toma.por_camara = [...(toma.por_camara ?? []), pos];
  const sabida = toma.camara_servidor?.includes(pos) ?? false;
  if (!sabida) toma.camara_servidor = [...(toma.camara_servidor ?? []), pos];
  return toma.plantilla.length !== antes || !ya || !sabida;
}

/** Después de fundir las tomas con la pantalla: lo que la base ya dijo por cámara sigue sin pedirse. */
export function reaplicarCamara(toma: Pick<TomaEnVisita, 'plantilla' | 'por_camara' | 'camara_servidor'>): void {
  for (const pos of toma.camara_servidor ?? []) pasarACamara(toma, pos);
}

/** ¿La toma sigue esperando algo de esta visita? (sin registrar y sin un final del servidor). */
export function tomaAbierta(x: Pick<TomaEnVisita, 'reg' | 'estado'>): boolean {
  return !x.reg && x.estado !== 'por_revisar';
}

/**
 * Las tomas que ya toca registrar: abiertas, sin fotos en camino y con la
 * plantilla completa (lo que vio la pantalla + lo ligado aquí), o cualquiera
 * si la visita se cerró («Listo con este sitio»: la base dice qué falta). Si
 * la base ya contestó `faltan` con las mismas fotos, no se vuelve a pedir.
 */
export function tomasPorRegistrar(t: Pick<TrabajoComp, 'tomas' | 'archivos' | 'cerrar'>): number[] {
  const out: number[] = [];
  for (const x of t.tomas) {
    if (!tomaAbierta(x)) continue;
    if (t.archivos.some((a) => enCamino(a, x.id))) continue;
    const completa = faltanPlantilla(x.plantilla, tieneConVisita(x, t.archivos)).length === 0;
    if (!completa && !t.cerrar) continue;
    if (x.faltanFirma && x.faltanFirma === firmaToma(x, t.archivos)) continue;
    out.push(x.id);
  }
  return out;
}

/**
 * ¿La visita ya se puede soltar del teléfono? (además de que sus archivos
 * terminaron y no hay registro por hacer). Mientras alguna toma siga
 * abierta, el trabajo se queda HOY: así las fotos que se tomen después
 * suman con las de antes para decidir el registro. Se suelta al cerrar la
 * visita o al pasar el día.
 */
export function puedeSoltarVisita(t: Pick<TrabajoComp, 'tomas' | 'cerrar' | 'fecha'>, hoy: string): boolean {
  // Una toma «devuelta después» también la detiene: el trabajo pide atención
  // hasta que la pantalla la vuelva a leer (actualizarVisita) o se descarte.
  return t.cerrar || t.fecha < hoy || !t.tomas.some((x) => tomaAbierta(x) || x.reg === 'regresada');
}

/** Fotos de la visita (no videos) que siguen en el teléfono sin quedar ligadas. */
export function fotosEnCamino(t: Pick<TrabajoComp, 'archivos'>): number {
  return t.archivos.filter((a) => a.tipo === 'foto' && !esFinal(a.estado)).length;
}

// ------------------------------------------------------------
// Lo que pinta la pantalla
// ------------------------------------------------------------

/** Una foto de la visita para la miniatura y «Usar también para…». */
export type FotoEnVisita = {
  trabajo: string;
  fid: string;
  cliente_id: string;
  path: string;
  nombre: string;
  tipo: 'foto' | 'video';
  pos: string;
  momento: MomentoPos;
  estado: ArchivoComp['estado'];
  toma_ids: number[];
  /** Tomas donde ya cuenta (el servidor la ligó). */
  ligada_en: number[];
  /** Tomas donde no entró, con la razón (como se le dice: ver RazonNoLigada). */
  /**
   * ocupa: la base sí dejó la liga (una 'duplicada' de verdad), aunque el
   * texto diga «por cámara»: esa campaña ya no se ofrece en «Usar también
   * para…» (revisión adversarial, 29-oct-2026).
   */
  no_ligada: { toma_id: number; razon: RazonNoLigada; ocupa?: boolean }[];
  /**
   * ¿Hay copia en el teléfono? (miniatura y Guardar en Fotos). Una ligada ya
   * no: la pantalla usa el File que ella misma encoló o la URL pública.
   */
  enTelefono: boolean;
};

/** El estado de una visita para la tarjeta del sitio. */
export type EstadoVisita = {
  clave: string;
  trabajos: string[];
  /** Archivos que siguen en el teléfono (la píldora de la tarjeta). */
  porSubir: number;
  /** Por toma: lo que sigue en el teléfono sin confirmar (gris «en el teléfono»). */
  enTelefono: Record<string, TienePos[]>;
  /** Por toma: lo que esta visita ya ligó (✓ antes de que la lista se vuelva a leer). */
  ligadas: Record<string, TienePos[]>;
  /** Tomas que la cola ya envió (por revisar o comprobadas). */
  enviadas: number[];
  /** Por toma: lo que la base dijo que falta (tras «Listo» o un registro). */
  faltan: Record<string, FaltaPos[]>;
  /** Tomas donde la cola ya no hará nada, con la razón. */
  sinEnviar: { toma_id: number; razon: Exclude<FinRegistro, 'enviada'> }[];
  fotos: FotoEnVisita[];
  /**
   * Ligas que el monitorista quitó (la foto entera o de una toma), con su
   * posición: la pantalla las descuenta del `tiene` que ya las traía, y las
   * pendientes (el servidor todavía las tiene) siguen contando como «ya
   * venían» en la siguiente lectura (ver capturaComp.ligasDe).
   */
  retiradas: { cliente_id: string; toma_id: number; pos: string; momento: MomentoPos; pendiente: boolean }[];
  /**
   * Fotos que el monitorista quitó (lápidas). `porConfirmar`: «Quitar» entera
   * de una foto que ya está arriba y la base todavía puede negar (vuelve a la
   * tarjeta). No entra la lápida que la cola deja por su cuenta al soltar una
   * foto sin fila. POR QUÉ (26-oct-2026): la copia de cámara sale de «Guardar
   * en Fotos» solo cuando la foto de verdad se fue; si la base no dejó
   * quitarla, o se quitó solo de una toma, la foto se queda.
   */
  lapidas: { cliente_id: string; nombre: string; porConfirmar: boolean }[];
  cerrar: boolean;
  enviando: boolean;
  conError: boolean;
  ultimoError: string | null;
};

function sumar(m: Record<string, TienePos[]>, id: number, a: ArchivoComp): void {
  const k = String(id);
  const l = (m[k] ??= []);
  const x = l.find((y) => y.pos === a.pos && y.momento === a.momento);
  if (x) x.n++;
  else l.push({ pos: a.pos, momento: a.momento, n: 1 });
}

/**
 * Junta los trabajos de UNA visita (casi siempre uno; dos si uno quedó en
 * memoria y otro en el teléfono). `enviando` y `enTelefonoDe` los da el núcleo.
 */
export function estadoDeVisita(
  clave: string,
  trabajos: readonly TrabajoComp[],
  op: { enviando: (id: string) => boolean; hayCopia: (id: string, fid: string) => boolean }
): EstadoVisita {
  const e: EstadoVisita = {
    clave,
    trabajos: trabajos.map((t) => t.id),
    porSubir: 0,
    enTelefono: {},
    ligadas: {},
    enviadas: [],
    faltan: {},
    sinEnviar: [],
    fotos: [],
    retiradas: [],
    lapidas: [],
    cerrar: false,
    enviando: false,
    conError: false,
    ultimoError: null,
  };
  for (const t of trabajos) {
    e.cerrar ||= t.cerrar;
    e.enviando ||= op.enviando(t.id);
    e.conError ||= !!t.conError;
    e.ultimoError ||= t.ultimoError;
    for (const a of t.archivos) {
      for (const r of retiradasDe(a))
        e.retiradas.push({ cliente_id: a.cliente_id, toma_id: r.toma_id, pos: a.pos, momento: a.momento, pendiente: r.pendiente });
      if (a.estado === 'quitado') {
        // Con `sinFila` (y sin limpiar === true) la volvió lápida la cola al soltar la visita.
        if (a.limpiar === true || !a.sinFila)
          e.lapidas.push({ cliente_id: a.cliente_id, nombre: a.nombre, porConfirmar: a.limpiar === true });
        continue;
      }
      if (!esFinal(a.estado)) e.porSubir++;
      if (a.tipo === 'foto' && a.estado !== 'perdido')
        for (const id of a.toma_ids) {
          if (cuentaEnToma(a, id)) sumar(e.ligadas, id, a);
          else if (!a.resueltas[String(id)]) sumar(e.enTelefono, id, a);
        }
      e.fotos.push({
        trabajo: t.id,
        fid: a.fid,
        cliente_id: a.cliente_id,
        path: a.path,
        nombre: a.nombre,
        tipo: a.tipo,
        pos: a.pos,
        momento: a.momento,
        estado: a.estado,
        toma_ids: [...a.toma_ids],
        ligada_en: a.toma_ids.filter((id) => cuentaEnToma(a, id)),
        no_ligada: a.toma_ids
          .filter((id) => a.resueltas[String(id)] && !cuentaEnToma(a, id))
          .map((id) => ({
            toma_id: id,
            razon: razonNoLigada(
              a.resueltas[String(id)] as Exclude<ResolucionLiga, 'ligada'>,
              t.tomas.find((x) => x.id === id),
              a.pos
            ),
            ...(a.resueltas[String(id)] === 'duplicada' ? { ocupa: true } : {}),
          })),
        // Al quedar ligada su copia se borra del teléfono (como en Pauta).
        enTelefono: !a.remoto && !esFinal(a.estado) && op.hayCopia(t.id, a.fid),
      });
    }
    for (const x of t.tomas) {
      if (x.reg === 'enviada') e.enviadas.push(x.id);
      else if (x.reg) e.sinEnviar.push({ toma_id: x.id, razon: x.reg });
      if (x.faltan?.length && !x.reg) e.faltan[String(x.id)] = x.faltan;
    }
  }
  return e;
}

// ------------------------------------------------------------
// Respuestas de las RPC (lectura tolerante, §4.2 2c)
// ------------------------------------------------------------

const ids = (x: unknown): number[] =>
  Array.isArray(x) ? x.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : [];

const texto = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);

/** comp_subir_foto → forma fija. */
export type RespSubirFoto =
  | { ok: false; codigo: string }
  | {
      ok: true;
      ya: boolean;
      evidencia_id: number | null;
      fecha: string | null;
      ligadas: number[];
      cerradas: number[];
      futuras: number[];
      ajenas: number[];
      duplicadas: number[];
    };

export function leerRespSubirFoto(x: unknown): RespSubirFoto | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (o.ok === false) return { ok: false, codigo: texto(o.codigo) ?? 'otro' };
  if (o.ok !== true) return null;
  // Integración (26-oct-2026): sin ninguna toma viva la base contesta
  // evidencia_id null, y Number(null) es 0 (un id que no existe). Igual con
  // una foto NUEVA que ninguna toma aceptó (todas cerradas, futuras o
  // ajenas): la base no crea la fila y contesta ya:false, evidencia_id y
  // fecha null y ligadas []. El objeto queda suelto en Storage; «Usar
  // también para…» con el mismo cliente_id crea la fila (otra vez ya:false)
  // y «Quitar» contesta ya:true sin path (se borra con el path del archivo).
  const ev = o.evidencia_id === null || o.evidencia_id === undefined ? NaN : Number(o.evidencia_id);
  return {
    ok: true,
    ya: o.ya === true,
    evidencia_id: Number.isFinite(ev) && ev > 0 ? ev : null,
    fecha: texto(o.fecha),
    ligadas: ids(o.ligadas),
    cerradas: ids(o.cerradas),
    futuras: ids(o.futuras),
    ajenas: ids(o.ajenas),
    duplicadas: ids(o.duplicadas),
  };
}

/**
 * Cómo queda cada toma pedida tras comp_subir_foto. Una toma que no vino en
 * ninguna lista (no debe pasar) se da por ligada: la base no se quejó y, si
 * no entró, la plantilla lo dirá al registrar.
 *
 * 'por_camara' (comp_f3_revision, 29-oct-2026): la base contesta en
 * `duplicadas` una posición que en esa toma va por cámara. Se distingue de
 * la duplicada de siempre (devuelta, B4, u otro día de la campaña, A1) así:
 *   · `esPorCamara(id)`: la pantalla ya sabe que esa posición va por cámara
 *     en esa toma (por_camara de comp_mis_tomas);
 *   · o la foto es NUEVA (`ya` = false): una foto que no existía no tiene
 *     ligas viejas, así que no puede estar devuelta ni en otro día (A1 con
 *     dos tomas de la misma campaña en una llamada es CP005). Cubre la lista
 *     vieja del teléfono (el Supervisor cambió el modo después de leerla).
 */
export function resolverLiga(
  pedidas: readonly number[],
  r: Extract<RespSubirFoto, { ok: true }>,
  esPorCamara?: (tomaId: number) => boolean
): Record<string, ResolucionLiga> {
  const out: Record<string, ResolucionLiga> = {};
  const marca = (lista: number[], que: ResolucionLiga) => {
    for (const id of lista) if (pedidas.includes(id) && !out[String(id)]) out[String(id)] = que;
  };
  marca(r.ligadas, 'ligada');
  marca(r.cerradas, 'cerrada');
  marca(r.futuras, 'futura');
  marca(r.ajenas, 'ajena');
  for (const id of r.duplicadas)
    if (pedidas.includes(id) && !out[String(id)])
      out[String(id)] = !r.ya || esPorCamara?.(id) ? 'por_camara' : 'duplicada';
  for (const id of pedidas) out[String(id)] ??= 'ligada';
  return out;
}

/** Una toma en la respuesta de comp_registrar_tomas. */
export type RegistroToma = {
  id: number;
  estado: string | null;
  ya: boolean;
  codigo: string | null;
  faltan: FaltaPos[];
  regreso_n: number | null;
};

export type RespRegistrar = { ok: false; codigo: string } | { ok: true; tomas: RegistroToma[] };

function leerFaltan(x: unknown): FaltaPos[] {
  if (!Array.isArray(x)) return [];
  const out: FaltaPos[] = [];
  for (const it of x) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const pos = texto(o.pos);
    if (!pos) continue;
    const n = Number(o.n);
    const tiene = Number(o.tiene);
    out.push({
      pos,
      momento: o.momento === 'dia' || o.momento === 'noche' ? o.momento : null,
      etiqueta: texto(o.etiqueta) ?? pos,
      n: Number.isFinite(n) ? n : 1,
      tiene: Number.isFinite(tiene) ? tiene : 0,
    });
  }
  return out;
}

export function leerRespRegistrar(x: unknown): RespRegistrar | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (o.ok === false) return { ok: false, codigo: texto(o.codigo) ?? 'otro' };
  if (o.ok !== true || !Array.isArray(o.tomas)) return null;
  const tomas: RegistroToma[] = [];
  for (const it of o.tomas) {
    if (!it || typeof it !== 'object') continue;
    const y = it as Record<string, unknown>;
    const id = Number(y.id);
    if (!Number.isFinite(id)) continue;
    const rn = Number(y.regreso_n);
    tomas.push({
      id,
      estado: texto(y.estado),
      ya: y.ya === true,
      codigo: texto(y.codigo),
      faltan: leerFaltan(y.faltan),
      regreso_n: y.regreso_n === null || y.regreso_n === undefined || !Number.isFinite(rn) ? null : rn,
    });
  }
  return { ok: true, tomas };
}

/** Una fila de comp_estado_tomas. */
export type EstadoServidorToma = { id: number; estado: string; regreso_n: number; rechazo_motivo: string | null };

export function leerEstadoTomas(x: unknown): EstadoServidorToma[] | null {
  if (!Array.isArray(x)) return null;
  const out: EstadoServidorToma[] = [];
  for (const it of x) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const id = Number(o.id);
    if (!Number.isFinite(id)) continue;
    const rn = Number(o.regreso_n);
    out.push({
      id,
      estado: texto(o.estado) ?? '',
      regreso_n: Number.isFinite(rn) ? rn : 0,
      rechazo_motivo: texto(o.rechazo_motivo),
    });
  }
  return out;
}

/**
 * comp_quitar_foto → forma fija. Con p_toma_id (26-oct-2026): `desligada` y
 * `quedan` (ligas que le quedan); si quedan 0 y nadie la revisó, la base
 * borra también la fila y contesta además `borrada` y `path`. `ya` sin
 * `quedan` = la fila ya no existe; `ya` con `quedan` = esa liga ya no estaba.
 */
export type RespQuitar =
  | { ok: false; codigo: string }
  | { ok: true; ya: boolean; borrada: boolean; desligada: boolean; path: string | null; quedan: number | null };

export function leerRespQuitar(x: unknown): RespQuitar | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (o.ok === false) return { ok: false, codigo: texto(o.codigo) ?? 'otro' };
  if (o.ok !== true) return null;
  const q = typeof o.quedan === 'number' || typeof o.quedan === 'string' ? Number(o.quedan) : NaN;
  return {
    ok: true,
    ya: o.ya === true,
    borrada: o.borrada === true,
    desligada: o.desligada === true,
    path: texto(o.path),
    quedan: Number.isFinite(q) && q >= 0 ? q : null,
  };
}

// ------------------------------------------------------------
// Textos
// ------------------------------------------------------------

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** «Corta», «Corta y Larga», «Corta, Media y Larga» (con «×2» si faltan varias de la misma). */
export function listaFaltan(f: readonly FaltaPos[]): string {
  const partes = f.map((x) => (x.n - x.tiene > 1 ? `${x.etiqueta} ×${x.n - x.tiene}` : x.etiqueta));
  if (partes.length <= 1) return partes.join('');
  return `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`;
}

/** «Falta: Larga de Suburbia V1» (§6.1). */
export function textoFaltan(nombre: string, f: readonly FaltaPos[]): string {
  return f.length ? `Falta: ${listaFaltan(f)} de ${nombre}` : '';
}

/** Junta los logros de una misma visita (sumando fotos y tomas). */
export function juntarLogrosComp(logros: readonly LogroComp[]): LogroComp[] {
  const m = new Map<string, LogroComp>();
  for (const l of logros) {
    const p = m.get(l.llave);
    if (!p) m.set(l.llave, { ...l });
    else {
      p.fotos += l.fotos;
      p.tomas += l.tomas;
      p.en = Math.max(p.en, l.en);
    }
  }
  return [...m.values()];
}

/** «✓ COL_551 · 6 fotos arriba · 3 tomas enviadas» (§6.1); varios sitios se juntan en uno. */
export function textoLogroComp(todos: readonly LogroComp[]): string {
  const ls = juntarLogrosComp(todos).filter((l) => l.fotos > 0 || l.tomas > 0);
  if (!ls.length) return '';
  const fotos = ls.reduce((s, l) => s + l.fotos, 0);
  const tomas = ls.reduce((s, l) => s + l.tomas, 0);
  const donde = ls.length === 1 ? ls[0].sitio_clave : plural(ls.length, 'sitio', 'sitios');
  const partes = [`✓ ${donde}`];
  if (fotos) partes.push(plural(fotos, 'foto arriba', 'fotos arriba'));
  if (tomas) partes.push(plural(tomas, 'toma enviada', 'tomas enviadas'));
  return partes.join(' · ');
}

/**
 * La razón que se le dice al monitorista. POR QUÉ (29-oct-2026,
 * comp_f3_revision): la base contesta en `duplicadas` también una foto cuya
 * posición en esa toma va por cámara (la sube la analista); «ya se había
 * devuelto: toma otra» lo mandaba a repetir una foto que no le toca. Una
 * 'duplicada' que resolverLiga no pudo distinguir (foto ya existente y la
 * lista de entonces sin por_camara) se dice «por cámara» en cuanto la lista
 * nueva lo sabe. Solo cambia el texto.
 */
export function razonNoLigada(
  que: Exclude<ResolucionLiga, 'ligada'>,
  toma: Pick<TomaEnVisita, 'por_camara'> | null | undefined,
  pos: string
): RazonNoLigada {
  return que === 'duplicada' && !!toma?.por_camara?.includes(pos) ? 'por_camara' : que;
}

/** Por qué una foto no se ligó a una toma, en palabras de campo. */
export function textoNoLigada(razon: RazonNoLigada): string {
  switch (razon) {
    case 'cerrada':
      return 'ya estaba comprobada, cancelada o su campaña se cerró';
    case 'futura':
      return 'es de un día que aún no llega';
    case 'ajena':
      return 'ya no es tuya (la reasignaron, o ahora la sube la analista desde cámaras)';
    case 'duplicada':
      return 'esa foto ya cuenta en otro día de esa campaña o ya se había devuelto: toma otra';
    case 'por_camara':
      return 'esa foto la sube la analista desde cámaras (no tienes que tomarla)';
  }
}
