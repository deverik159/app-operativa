// ============================================================
// src/lib/colaFotos/nucleo.ts
// El NÚCLEO de las colas de fotos: guarda cada foto en el teléfono antes de
// subir, la sube sola en segundo plano, la liga con lo que diga el
// adaptador y, cuando toca, pide el registro. Fase 3 de Comprobaciones,
// incremento 2 (26-oct-2026); el primer y único adaptador es
// adaptadorComp.ts.
//
// POR QUÉ UN NÚCLEO NUEVO Y NO TOCAR PAUTA (especificación §7, B9): la cola
// de Pauta (lib/tomasPauta.ts) guarda hoy fotos únicas en producción y sus
// trabajos viven en los teléfonos con su forma v:1. Este núcleo sale de ella
// (las mismas reglas, aprendidas en la fase 1) pero con lo que la ata a una
// tabla puesto como parámetro: base IndexedDB, canal, prefijos de candado,
// etiquetas de error y los pasos contra la base (ligar, limpiar, registrar).
// Cada adaptador lleva SU base y SU canal: un teléfono con la app vieja en
// caché nunca procesa trabajos de otra cola.
//
// REGLAS QUE TRAE DE PAUTA (revisiones del 22-oct-2026):
//   · Toda escritura de un trabajo es get+put en UNA transacción
//     (actualizar); la cola relee el trabajo antes de cada paso y solo lo
//     borra si, releído en la misma transacción, ya no tiene nada pendiente.
//   · Quitar no espera el candado: se marca 'quitado' (lápida) y ningún
//     cambio de estado la pisa.
//   · Solo se reintenta por RED (y lo que el adaptador declare transitorio:
//     `Ocupada`), y nada sale sin sesión real y del dueño (exigirSesion).
//     Antes de concluir algo por una respuesta VACÍA, getUser (sesionValida).
//   · Un archivo rechazado conserva su Blob, se salta en las corridas de
//     cada foto nueva y se reintenta en la vuelta del aviso.
//   · storage.remove no acepta abortSignal: va con tope propio.
//   · Sin IndexedDB (Safari privado, cuota llena) el trabajo vive en memoria
//     y se avisa; mientras haya algo así, la recarga automática se retiene.
//
// LO NUEVO (especificación §7):
//   · Índice en memoria de los trabajos: se carga una vez (getAll) y luego
//     cada escritura lo actualiza con lo que escribió. Las operaciones
//     releen SOLO el trabajo que tocan. La cola de Pauta hacía getAll en
//     cada operación (O(n²) con cientos de visitas sin señal).
//   · El canal entre pestañas manda el id que cambió: la otra pestaña relee
//     solo ese. Al volver a primer plano el índice se rearma (iOS pudo
//     congelar la página y perder mensajes).
//   · Sin estado 'ligando' ni consulta previa: ligar es idempotente.
//   · Buzón de avisos con TIPO (no se busca nada en el texto) y logros por
//     corrida (fotos ligadas y tomas registradas) para el aviso breve.
//
// En el iPhone la cola avanza mientras la app está abierta (en cualquier
// pantalla); con la app cerrada no sube nada y sigue al volver a abrirla:
// Safari no tiene sincronización en segundo plano.
// ============================================================
import { sb } from '../supabase';
import { BUCKET_EVIDENCIAS } from '../storage';
import { reportarError } from '../reportarError';
import { retenerRecargaAutomatica } from '../cargaDiferida';
import {
  ErrorIdb,
  archivoDeRegistro,
  registroDeArchivo,
  registroEnBytes,
  topeEscrituraArchivo,
  type RegistroArchivo,
} from '../idb';
import {
  SinLectura,
  SinRed,
  SinSesion,
  SubidaLenta,
  clasificarStorage,
  conCandado,
  conReintento,
  dormir,
  exigirSesion,
  mensajeDe,
  registrarRiesgoExtra,
  subir,
  textoEnCola,
} from '../envios';
import { crearBaseTolerante } from '../idbTolerante';
import {
  conPunto,
  esFinal,
  fallidos,
  listoParaCerrar,
  porLimpiar,
  porMandar,
  porSubir,
  soloLimpieza,
  textoPerdidas,
  type ArchivoCola,
  type EstadoArchivoCola,
  type TrabajoCola,
} from './logica';

// ------------------------------------------------------------
// Tipos (contrato con el adaptador)
// ------------------------------------------------------------

/**
 * La base está ocupada (candado de otra persona: `{codigo:'ocupada'}`,
 * 55P03, 57014 o 40P01; §5.2). Es transitorio como la red: se reintenta con
 * espera, sin pedir atención, pero NO corta la vuelta (la red sí está).
 */
export class Ocupada extends SinRed {
  constructor(mensaje = 'La base está ocupada; se reintenta sola.') {
    super(mensaje);
    this.name = 'Ocupada';
  }
}

/** Para qué es un aviso del buzón: la pantalla decide con esto, nunca con el texto. */
export type TipoAviso =
  /** Algo que pide al monitorista hacer algo (atención). */
  | 'error'
  /** La analista devolvió una toma después de las fotos: recargar la lista. */
  | 'regreso'
  /** Se cerró una visita y la base dijo qué falta. */
  | 'faltan'
  /** Para saber (una foto no se ligó a una toma cerrada o ajena). */
  | 'info';

export type AvisoCola = { texto: string; tipo: TipoAviso; clave?: string };

/** Lo que contesta el adaptador al ligar un archivo que ya está en Storage. */
export type ResultadoLigar<A> =
  /**
   * El servidor contestó: `cambio` se aplica al archivo FRESCO (releído en la
   * transacción: «Usar también para…» pudo agregarle tomas mientras tanto) y
   * dice si ya no le falta ninguna toma (true = 'ligado').
   */
  | { tipo: 'ok'; cambio: (a: A) => boolean; avisos?: AvisoCola[] }
  /** El archivo no está en Storage: subirlo otra vez. */
  | { tipo: 'subirOtraVez'; cambio?: (a: A) => void }
  /** No se puede ahora y no es la red (p. ej. la captura no está abierta): se queda con aviso. */
  | { tipo: 'atencion'; mensaje: string }
  /** El servidor lo rechazó (no debe pasar): 'fallido' con aviso. */
  | { tipo: 'definitivo'; mensaje: string };

/** Lo que contesta el adaptador al registrar. */
export type ResultadoRegistro =
  | 'nada'
  | { registradas: number; avisos?: AvisoCola[] }
  /** Pide atención (el núcleo lo anota y lo avisa UNA vez con su tipo); lo demás que sí se hizo, también cuenta. */
  | { error: string; tipo?: TipoAviso; registradas?: number; avisos?: AvisoCola[] };

/** Lo que el núcleo le presta al adaptador. */
export type Herramientas<T> = {
  /** El trabajo fresco del teléfono (null = ya no está). */
  leer(id: string): Promise<T | null>;
  /** get+put atómico (ver `actualizar` abajo). */
  actualizar(id: string, fn: (t: T) => T | 'borrar' | null): Promise<T | null | undefined>;
  /** getUser con tope: la sesión es real para el SERVIDOR y es del dueño; si no, lanza SinRed/SinSesion. */
  sesionValida(email: string): Promise<void>;
  /** storage.remove con tope; lanza SinRed si fue la red. */
  quitarObjeto(path: string): Promise<void>;
  /** Deja un aviso en el buzón (se entrega una vez). */
  avisar(email: string, aviso: AvisoCola): void;
  /** reportarError con la etiqueta del adaptador (`<etiqueta>.<nombre>`). */
  reportar(nombre: string, err: unknown, extra?: Record<string, unknown>, ref?: string): void;
};

export type AdaptadorCola<T extends TrabajoCola<A>, A extends ArchivoCola, L extends { llave: string; en: number }> = {
  /** Base IndexedDB propia (nunca la de otra cola). */
  nombreBase: string;
  canal: string;
  /** Candado por trabajo entre pestañas. */
  prefijoCandado: string;
  /** Candado por CLAVE para el registro (dos trabajos de la misma clave también chocan). */
  prefijoRegistro: string;
  /** reportarError('<etiqueta>.*'). */
  etiqueta: string;
  /** Lo que se pierde al recargar («una foto de comprobación»). */
  riesgo: string;
  /** ¿Es un trabajo de esta cola? (tipo y versión). */
  esTrabajo(x: unknown): x is T;
  /** «COL_551 · 29-oct» para el aviso global y los textos. */
  donde(t: T): string;
  ligar(t: T, a: A, h: Herramientas<T>): Promise<ResultadoLigar<A>>;
  /** Limpia del servidor un archivo quitado y le borra `limpiar`; lanza SinRed para reintentar. */
  limpiar(t: T, a: A, h: Herramientas<T>): Promise<void>;
  /** Otro paso antes de mandar archivos (p. ej. desligar de una toma). true = hizo algo. */
  pasoExtra?(t: T, h: Herramientas<T>): Promise<boolean>;
  hayExtra?(t: T): boolean;
  /** El registro, ya bajo el candado de la clave. */
  registrar?(t: T, h: Herramientas<T>): Promise<ResultadoRegistro>;
  registroPendiente?(t: T): boolean;
  /**
   * Tras un registro sin error: ¿el error que dejó un registro anterior ya no
   * aplica? (comp: false mientras una toma siga «devuelta después»). Sin él, sí.
   */
  errorDeRegistroResuelto?(t: T): boolean;
  /** ¿Se puede soltar del teléfono? (además de archivos, extra y registro). */
  puedeSoltar?(t: T): boolean;
  /** Archivos que se conservan al descartar (además de lo que hay que limpiar). */
  conservarAlDescartar?(a: A): boolean;
  /** Ajusta lo que queda de un trabajo descartado (que ya no registre nada). */
  alDescartar?(t: T): void;
  /**
   * ¿Este archivo ya ligado cuenta como «foto arriba» en el logro? (comp: si
   * el servidor lo ligó a alguna toma). Sin él, toda foto ligada cuenta.
   */
  cuentaEnLogro?(a: A): boolean;
  /** El logro de una corrida (null = nada que contar). */
  logro?(t: T, d: { fotos: number; registradas: number }): L | null;
};

/** Lo que el aviso global pinta de cada trabajo. */
export type ResumenAvisoCola = {
  id: string;
  resumen: string;
  creado_en: string;
  enviando: boolean;
  soloMemoria: boolean;
  fueraDelTelefono: number;
  ultimoError: string | null;
  conError: boolean;
  archivos: number;
  ligados: number;
  registrarPedido: boolean;
  /** Pide que el monitorista lo vea (error, algo solo en memoria). Una subida normal no lo prende. */
  atencion: boolean;
};

export type ResumenVueltaCola = { terminadas: number; siguen: number; mensajes: AvisoCola[] };

type ResultadoInterno =
  | { tipo: 'hecha' }
  | { tipo: 'sigue' }
  | { tipo: 'enCola'; cortar: boolean }
  | { tipo: 'error'; id: string; mensaje: string; nuevo: boolean; email: string; donde: string; clave: string; aviso: TipoAviso }
  | { tipo: 'ocupado' }
  | { tipo: 'yaHecha' };

// ------------------------------------------------------------
// Tiempos y topes (los de Pauta)
// ------------------------------------------------------------

/** Tope de una escritura de estado en IndexedDB (metadatos). */
const ESPERA_ESTADO_MS = 5000;
/** Tope de una lectura chica a la base o a Storage. */
export const ESPERA_LECTURA_MS = 12000;
/** Tope de una RPC que escribe: abortado = incierto, el reintento lo resuelve (todo es idempotente). */
export const ESPERA_ESCRITURA_MS = 20000;
/** Lecturas fallidas seguidas de un archivo antes de darlo por perdido. */
const MAX_LECTURAS_FALLIDAS = 3;
/** Vueltas internas de un trabajo en una sola corrida (fotos que siguen llegando). */
const MAX_PASADAS = 60;

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();

/**
 * Una llamada con tope propio (storage.remove no acepta abortSignal): si no
 * contesta a tiempo cuenta como sin red y se reintenta en la vuelta siguiente.
 */
export function conTope<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    dormir(ms).then((): never => {
      throw new SinRed('El servidor no respondió.');
    }),
  ]);
}

/**
 * ¿La sesión es real para el SERVIDOR y es del dueño? (getUser valida el
 * token allá). Con un token a medio renovar la RLS y las RPC definer que
 * filtran por correo contestan VACÍO sin error: antes de concluir «faltan»,
 * «ya no es tuya» o «ya no hay fila» se pregunta aquí.
 */
export async function sesionValidaEnServidor(email: string): Promise<void> {
  let r: Awaited<ReturnType<typeof sb.auth.getUser>>;
  try {
    r = await Promise.race([
      sb.auth.getUser(),
      dormir(ESPERA_LECTURA_MS).then((): never => {
        throw new SinRed('El servidor no respondió.');
      }),
    ]);
  } catch (err) {
    throw err instanceof SinRed ? err : new SinRed(mensajeDe(err));
  }
  const de = norm(r?.data?.user?.email);
  if (r?.error || !de || de !== norm(email)) throw new SinSesion();
}

// ------------------------------------------------------------
// La cola
// ------------------------------------------------------------

export function crearColaFotos<T extends TrabajoCola<A>, A extends ArchivoCola, L extends { llave: string; en: number }>(
  ad: AdaptadorCola<T, A, L>
) {
  type Almacen = 'trabajos' | 'blobs';
  const base = crearBaseTolerante<Almacen>(ad.nombreBase, { trabajos: 'id', blobs: 'clave' });
  const claveBlob = (id: string, fid: string) => `t:${id}:${fid}`;
  const clonar = (t: T): T => JSON.parse(JSON.stringify(t)) as T;
  const reportar = (nombre: string, err: unknown, extra?: Record<string, unknown>, ref?: string) =>
    reportarError(`${ad.etiqueta}.${nombre}`, err, extra, ref);

  // --- IndexedDB -------------------------------------------------------

  async function idbTodos(): Promise<T[]> {
    const caja: { v: T[] } = { v: [] };
    await base.tx(['trabajos'], 'readonly', (t) => {
      const r = t.objectStore('trabajos').getAll();
      r.onsuccess = () => {
        caja.v = ((r.result as unknown[]) || []).filter((x): x is T => ad.esTrabajo(x));
      };
    });
    return caja.v;
  }

  async function idbUno(id: string): Promise<T | undefined> {
    const caja: { v?: T } = {};
    await base.tx(['trabajos'], 'readonly', (t) => {
      const r = t.objectStore('trabajos').get(id);
      r.onsuccess = () => {
        caja.v = ad.esTrabajo(r.result) ? (r.result as T) : undefined;
      };
    });
    return caja.v;
  }

  /** null = de verdad no está; si IndexedDB falla, lanza. */
  async function idbBlob(clave: string): Promise<File | null> {
    const caja: { r?: RegistroArchivo } = {};
    await base.tx(['blobs'], 'readonly', (t) => {
      const r = t.objectStore('blobs').get(clave);
      r.onsuccess = () => {
        caja.r = r.result as RegistroArchivo | undefined;
      };
    });
    return caja.r ? archivoDeRegistro(caja.r) : null;
  }

  // --- Estado de la pestaña -------------------------------------------

  /** Trabajos que NO se pudieron guardar en el teléfono (sin IndexedDB). */
  const memoria = new Map<string, T>();
  const soloMemoria = new Set<string>();
  /** Los File originales por llave de Blob: preferibles a leerlos de IndexedDB. */
  const archivosMem = new Map<string, File>();
  /** Llaves de Blob que no cupieron en el teléfono (solo viven en archivosMem). */
  const fueraDelTelefono = new Set<string>();
  const enCurso = new Map<string, Promise<ResultadoInterno>>();
  /** Llegó un "procesa" mientras corría: al terminar, otra corrida (forzada si se pidió). */
  const otraVuelta = new Set<string>();
  const otraVueltaForzada = new Set<string>();
  /** Descartados: ninguna escritura tardía debe resucitarlos. */
  const descartados = new Set<string>();
  const buzon: { email: string; aviso: AvisoCola }[] = [];
  const logros: { email: string; logro: L }[] = [];
  /** Llaves que el monitorista ya vio en pantalla (→ cuándo): sus logros previos no se repiten. */
  const vistas = new Map<string, number>();
  /** Lo que se logró en la corrida en curso de cada trabajo (fotos ligadas, tomas registradas). */
  const deltas = new Map<string, { fotos: number; registradas: number; ultimo: T | null }>();

  // --- Índice en memoria ----------------------------------------------

  /** Trabajos del teléfono por id (se carga una vez; cada escritura lo pone al día). */
  const indice = new Map<string, T>();
  /** id por clave (para encontrar la visita sin recorrer todo). */
  const porClaveIdx = new Map<string, Set<string>>();
  let indiceListo = false;
  let cargaIndice: Promise<void> | null = null;
  /** Escrituras que llegaron mientras se cargaba el índice: mandan sobre lo que traiga getAll. */
  let tocadosEnCarga: Map<string, T | null> | null = null;

  function quitarDeClave(id: string): void {
    const viejo = indice.get(id);
    if (!viejo) return;
    const s = porClaveIdx.get(viejo.clave);
    s?.delete(id);
    if (s && !s.size) porClaveIdx.delete(viejo.clave);
  }

  function alIndice(id: string, v: T | null | undefined): void {
    tocadosEnCarga?.set(id, v ?? null);
    quitarDeClave(id);
    if (v && !descartados.has(id)) {
      indice.set(id, v);
      let s = porClaveIdx.get(v.clave);
      if (!s) porClaveIdx.set(v.clave, (s = new Set()));
      s.add(id);
    } else indice.delete(id);
  }

  async function cargarIndice(): Promise<void> {
    if (indiceListo) return;
    if (!cargaIndice)
      cargaIndice = (async () => {
        const tocados = new Map<string, T | null>();
        tocadosEnCarga = tocados;
        try {
          const todos = await idbTodos();
          indice.clear();
          porClaveIdx.clear();
          tocadosEnCarga = null;
          for (const t of todos) if (!tocados.has(t.id)) alIndice(t.id, t);
          tocados.forEach((v, id) => alIndice(id, v));
          indiceListo = true;
        } catch {
          /* sin IndexedDB: solo lo de memoria; se intenta otra vez después */
        } finally {
          tocadosEnCarga = null;
          cargaIndice = null;
        }
      })();
    await cargaIndice;
  }

  /** Rearme: la siguiente lectura vuelve a cargar el índice del teléfono. */
  function rearmarIndice(): void {
    indiceListo = false;
  }

  try {
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') rearmarIndice();
      });
  } catch {
    /* sin documento (pruebas) */
  }

  // --- Avisos entre pestañas y suscriptores ----------------------------

  const bus: EventTarget | null = typeof EventTarget !== 'undefined' ? new EventTarget() : null;
  let canal: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      canal = new BroadcastChannel(ad.canal);
      canal.onmessage = (ev: MessageEvent) => {
        const id = (ev?.data as { id?: unknown } | null)?.id;
        // Otra pestaña cambió UN trabajo: se relee solo ése.
        if (typeof id === 'string') {
          void idbUno(id)
            .then((t) => alIndice(id, t ?? null))
            .catch(() => rearmarIndice())
            .finally(() => emitir(undefined, true));
        } else {
          rearmarIndice();
          emitir(undefined, true);
        }
      };
    }
  } catch {
    canal = null;
  }

  function enRiesgo(): boolean {
    return soloMemoria.size > 0 || fueraDelTelefono.size > 0 || enCurso.size > 0;
  }
  registrarRiesgoExtra(enRiesgo, ad.riesgo);

  let soltarRetencion: (() => void) | null = null;
  function sincronizarRetencion(): void {
    const riesgo = enRiesgo();
    if (riesgo && !soltarRetencion) soltarRetencion = retenerRecargaAutomatica();
    else if (!riesgo && soltarRetencion) {
      soltarRetencion();
      soltarRetencion = null;
    }
  }

  function emitir(id?: string, desdeOtraPestana = false): void {
    sincronizarRetencion();
    try {
      bus?.dispatchEvent(new Event('cambio'));
    } catch {
      /* sin suscriptores */
    }
    if (!desdeOtraPestana && id) {
      try {
        canal?.postMessage({ id });
      } catch {
        /* canal cerrado */
      }
    }
  }

  function suscribir(cb: () => void): () => void {
    if (!bus) return () => {};
    const h = () => cb();
    bus.addEventListener('cambio', h);
    return () => bus.removeEventListener('cambio', h);
  }

  function avisar(email: string, aviso: AvisoCola): void {
    buzon.push({ email: norm(email), aviso });
  }

  function tomarAvisos(email?: string): AvisoCola[] {
    const em = norm(email);
    const mios: AvisoCola[] = [];
    for (let i = 0; i < buzon.length; ) {
      if (!em || buzon[i].email === em) mios.push(buzon.splice(i, 1)[0].aviso);
      else i++;
    }
    return mios;
  }

  function tomarLogros(email?: string): L[] {
    const em = norm(email);
    const mios: L[] = [];
    for (let i = 0; i < logros.length; ) {
      if (!em || logros[i].email === em) mios.push(logros.splice(i, 1)[0].logro);
      else i++;
    }
    return mios;
  }

  /** Suelta los logros de una llave que el monitorista ya vio en pantalla después de que pasaron. */
  function logrosPorMostrar(lista: L[]): L[] {
    return lista.filter((l) => {
      const vista = vistas.get(l.llave);
      return vista === undefined || l.en > vista;
    });
  }

  function marcarVisto(llave: string): void {
    vistas.set(llave, Date.now());
  }

  // --- Leer y escribir trabajos ----------------------------------------

  function soltar(id: string, fid: string): void {
    archivosMem.delete(claveBlob(id, fid));
    fueraDelTelefono.delete(claveBlob(id, fid));
  }

  /** El trabajo fresco: el de memoria si es solo de memoria; si no, el del teléfono (y pone al día el índice). */
  async function leer(id: string): Promise<T | null> {
    if (descartados.has(id)) return null;
    if (soloMemoria.has(id)) return memoria.get(id) ?? null;
    let t: T | undefined;
    try {
      t = await idbUno(id);
    } catch (err) {
      throw new SinLectura('No se pudo leer lo guardado en el teléfono: ' + mensajeDe(err));
    }
    alIndice(id, t ?? null);
    return t ?? null;
  }

  /** Todos los trabajos de este correo (índice + memoria), del más viejo al más nuevo. */
  async function listar(email: string): Promise<T[]> {
    await cargarIndice();
    const porId = new Map<string, T>();
    indice.forEach((t, id) => porId.set(id, t));
    memoria.forEach((t, id) => porId.set(id, t));
    const em = norm(email);
    return [...porId.values()]
      .filter((t) => norm(t.email) === em && !descartados.has(t.id))
      .sort((x, y) => x.creado_en.localeCompare(y.creado_en));
  }

  /** Los trabajos de una clave (del más viejo al más nuevo), sin recorrer todo. */
  async function deClave(clave: string): Promise<T[]> {
    await cargarIndice();
    const out: T[] = [];
    porClaveIdx.get(clave)?.forEach((id) => {
      const t = indice.get(id);
      if (t && !memoria.has(id)) out.push(t);
    });
    memoria.forEach((t) => {
      if (t.clave === clave) out.push(t);
    });
    return out.filter((t) => !descartados.has(t.id)).sort((x, y) => x.creado_en.localeCompare(y.creado_en));
  }

  /**
   * Un trabajo que vive en memoria pudo dejar una copia vieja en el teléfono
   * (pasó a memoria a medias). Cada cambio se copia también ahí, de mejor
   * esfuerzo y en orden: si iOS recarga la app, la copia dice lo último. A lo
   * más una copia en vuelo y una pendiente por trabajo.
   */
  const espejoPendiente = new Map<string, { copia: T | null; claves: Set<string> }>();
  const espejoCorriendo = new Set<string>();
  function espejar(id: string, cambio: T | 'borrar', claves: string[]): void {
    const copia = cambio === 'borrar' ? null : clonar(cambio);
    const previa = espejoPendiente.get(id);
    espejoPendiente.set(id, { copia, claves: new Set([...(previa?.claves ?? []), ...claves]) });
    if (!espejoCorriendo.has(id)) void correrEspejo(id);
  }
  async function correrEspejo(id: string): Promise<void> {
    espejoCorriendo.add(id);
    try {
      for (let p = espejoPendiente.get(id); p; p = espejoPendiente.get(id)) {
        espejoPendiente.delete(id);
        const copia = descartados.has(id) ? null : p.copia;
        const claves = p.claves;
        await base
          .tx(
            ['trabajos', 'blobs'],
            'readwrite',
            (x) => {
              if (copia) x.objectStore('trabajos').put(copia);
              else x.objectStore('trabajos').delete(id);
              claves.forEach((k) => x.objectStore('blobs').delete(k));
            },
            ESPERA_ESTADO_MS
          )
          .catch(() => undefined);
      }
    } finally {
      espejoCorriendo.delete(id);
    }
  }

  type Cambio = T | 'borrar' | null;

  /**
   * Lee el trabajo, le aplica `fn` y lo escribe en UNA transacción (atómico
   * aunque escriban dos pestañas). `fn` es síncrona: null = no cambiar,
   * 'borrar' = quitar el trabajo y los Blobs de sus archivos. Devuelve el
   * trabajo como quedó (null si se borró, undefined si no existía) y lo deja
   * en el índice.
   */
  async function actualizar(
    id: string,
    fn: (t: T) => Cambio,
    op: { blobs?: RegistroArchivo[]; borrarBlobs?: string[]; topeMs?: number } = {}
  ): Promise<T | null | undefined> {
    if (descartados.has(id)) return undefined;
    if (soloMemoria.has(id)) {
      const cur = memoria.get(id);
      if (!cur) return undefined;
      const r = fn(clonar(cur));
      if (r === 'borrar') {
        memoria.delete(id);
        soloMemoria.delete(id);
        cur.archivos.forEach((a) => soltar(id, a.fid));
        descartados.add(id);
        alIndice(id, null);
        espejar(
          id,
          'borrar',
          cur.archivos.map((a) => claveBlob(id, a.fid))
        );
        emitir(id);
        return null;
      }
      if (r) {
        r.actualizado_en = new Date().toISOString();
        memoria.set(id, r);
        espejar(id, r, op.borrarBlobs ?? []);
        emitir(id);
        return r;
      }
      return cur;
    }
    const caja: { v?: T | null; borrados?: A[] } = {};
    await base.tx(
      ['trabajos', 'blobs'],
      'readwrite',
      (t) => {
        const st = t.objectStore('trabajos');
        const bs = t.objectStore('blobs');
        const req = st.get(id);
        req.onsuccess = () => {
          const cur = ad.esTrabajo(req.result) ? (req.result as T) : undefined;
          if (!cur) {
            caja.v = undefined;
            return;
          }
          const r = fn(cur);
          if (r === 'borrar') {
            st.delete(id);
            cur.archivos.forEach((a) => bs.delete(claveBlob(id, a.fid)));
            caja.v = null;
            caja.borrados = cur.archivos;
            return;
          }
          if (r) {
            r.actualizado_en = new Date().toISOString();
            st.put(r);
            op.blobs?.forEach((b) => bs.put(b));
            caja.v = r;
          } else caja.v = cur;
          op.borrarBlobs?.forEach((k) => bs.delete(k));
        };
      },
      op.topeMs ?? ESPERA_ESTADO_MS
    );
    caja.borrados?.forEach((a) => soltar(id, a.fid));
    alIndice(id, caja.v ?? null);
    emitir(id);
    return caja.v;
  }

  /** Cambia un archivo del trabajo (atómico). */
  function conArchivo(id: string, fid: string, cambio: (a: A) => void, op?: { borrarBlob?: boolean }) {
    return actualizar(
      id,
      (t) => {
        const a = t.archivos.find((x) => x.fid === fid);
        if (!a) return null;
        cambio(a);
        return t;
      },
      op?.borrarBlob ? { borrarBlobs: [claveBlob(id, fid)] } : {}
    );
  }

  /**
   * Anota el último error. Uno de red NO pisa un error definitivo vigente
   * (si no, con la señal yendo y viniendo el mismo aviso volvía a salir).
   */
  async function anotar(id: string, error: string | null, conError: boolean, origen: 'ligar' | 'registro' | null = null): Promise<void> {
    try {
      await actualizar(id, (t) => {
        if (!conError && t.conError) return null;
        t.ultimoError = error ? error.slice(0, 300) : null;
        t.conError = conError;
        if (origen === 'ligar') t.errorDeLigar = true;
        else delete t.errorDeLigar;
        if (origen === 'registro') t.errorDeRegistro = true;
        else delete t.errorDeRegistro;
        return t;
      });
    } catch {
      /* el aviso no debe tumbar la cola */
    }
  }

  /** Lo que pedía atención ya se resolvió. */
  async function limpiarError(id: string): Promise<void> {
    try {
      await actualizar(id, (t) => {
        if (!t.conError && !t.ultimoError && !t.avisado) return null;
        t.conError = false;
        t.ultimoError = null;
        t.avisado = null;
        delete t.errorDeLigar;
        delete t.errorDeRegistro;
        return t;
      });
    } catch {
      /* nada */
    }
  }

  /**
   * POR QUÉ (26-oct-2026): en Comprobaciones la visita sigue viva mientras
   * quede una toma abierta, así que un «Sin señal…» que ya se resolvió (la
   * foto subió y se ligó) se quedaba pintado en el aviso global. Un error
   * pasajero (conError = false) se borra en cuanto algo sale bien; uno
   * definitivo no se toca aquí.
   */
  async function limpiarPasajero(id: string): Promise<void> {
    try {
      await actualizar(id, (t) => {
        if (t.conError || !t.ultimoError) return null;
        t.ultimoError = null;
        return t;
      });
    } catch {
      /* nada */
    }
  }

  // --- Encolar ----------------------------------------------------------

  /** Crea el trabajo en el teléfono; si no hay IndexedDB, en memoria. */
  async function crear(t: T): Promise<void> {
    try {
      await base.tx(
        ['trabajos'],
        'readwrite',
        (x) => {
          x.objectStore('trabajos').put(t);
        },
        ESPERA_ESTADO_MS
      );
      alIndice(t.id, t);
    } catch (err) {
      soloMemoria.add(t.id);
      memoria.set(t.id, t);
      reportar('idb', err, { motivo: err instanceof ErrorIdb ? err.motivo : 'otro' });
    }
    emitir(t.id);
  }

  /**
   * "Buscar o crear" el trabajo de una clave, de uno en uno por clave en la
   * pestaña: dos toques casi juntos no deben crear dos trabajos.
   * `ajustar` se aplica al encontrado (en una transacción); `nuevo` arma uno.
   */
  const porClave = new Map<string, Promise<unknown>>();
  function obtenerTrabajo(clave: string, nuevo: () => T, ajustar?: (t: T) => T | null): Promise<T> {
    const previo = porClave.get(clave) ?? Promise.resolve();
    const p = previo.then(async () => {
      const t = (await deClave(clave)).pop();
      if (t) {
        if (!ajustar) return t;
        const r = await actualizar(t.id, ajustar);
        if (r) return r;
        if (r === null) {
          // Se cerró en medio: uno nuevo.
        } else if (r === undefined && !(await leer(t.id).catch(() => null))) {
          // Ya no estaba.
        } else return t;
      }
      const n = nuevo();
      await crear(n);
      return n;
    });
    const cola = p.catch(() => undefined);
    porClave.set(clave, cola);
    void cola.then(() => {
      if (porClave.get(clave) === cola) porClave.delete(clave);
    });
    return p;
  }

  /**
   * Agrega UN archivo al trabajo con su Blob en la misma transacción.
   * `preparar` ajusta el trabajo en esa misma transacción. Si no cabe como
   * Blob se intenta en bytes (Safari viejo); si tampoco, queda solo el
   * registro y el archivo vive en la memoria de esta pestaña ('memoria').
   * Sin `file` (una foto que ya está arriba) solo se agrega el registro.
   */
  async function agregarArchivo(
    id: string,
    a: A,
    f: File | null,
    preparar?: (t: T) => void
  ): Promise<'telefono' | 'memoria' | 'sinTrabajo'> {
    const k = claveBlob(id, a.fid);
    const agregar = (t: T): Cambio => {
      if (t.archivos.some((x) => x.fid === a.fid)) return null;
      t.archivos.push(a);
      preparar?.(t);
      // Una foto nueva es información nueva: el error anterior se vuelve a
      // evaluar. Salvo el de una foto que el servidor rechazó.
      if (!fallidos(t)) {
        t.conError = false;
        t.ultimoError = null;
      }
      return t;
    };
    if (!f) {
      const r = await actualizar(id, agregar).catch(() => undefined);
      return r ? (soloMemoria.has(id) ? 'memoria' : 'telefono') : 'sinTrabajo';
    }
    if (soloMemoria.has(id)) {
      if ((await actualizar(id, agregar)) === undefined) return 'sinTrabajo';
      archivosMem.set(k, f);
      fueraDelTelefono.add(k);
      return 'memoria';
    }
    const intentar = async (r: RegistroArchivo | null): Promise<boolean | 'sinTrabajo'> => {
      try {
        const res = await actualizar(id, agregar, { blobs: r ? [r] : [], topeMs: topeEscrituraArchivo(f.size) });
        return res === undefined || res === null ? 'sinTrabajo' : true;
      } catch (err) {
        if (err instanceof ErrorIdb && (err.motivo === 'no-disponible' || err.motivo === 'tope')) throw err;
        return false;
      }
    };
    try {
      let r = await intentar(registroDeArchivo(k, f));
      if (r === 'sinTrabajo') return r;
      if (r) {
        archivosMem.set(k, f);
        return 'telefono';
      }
      const enBytes = await registroEnBytes(k, f);
      if (enBytes) {
        r = await intentar(enBytes);
        if (r === 'sinTrabajo') return r;
        if (r) {
          archivosMem.set(k, f);
          return 'telefono';
        }
      }
      r = await intentar(null);
      if (r === 'sinTrabajo') return r;
      if (r) {
        archivosMem.set(k, f);
        fueraDelTelefono.add(k);
        reportar('idb', new Error('archivo solo en memoria'), { bytes: f.size });
        return 'memoria';
      }
    } catch {
      /* sin IndexedDB: abajo */
    }
    // Ni el registro entró: el trabajo pasa a memoria con lo que tenga.
    let t: T | undefined;
    try {
      t = (await idbUno(id).catch(() => undefined)) ?? memoria.get(id) ?? indice.get(id);
    } catch {
      t = memoria.get(id);
    }
    if (!t) return 'sinTrabajo';
    const copia = clonar(t);
    const r = agregar(copia);
    memoria.set(id, r && r !== 'borrar' ? r : t);
    soloMemoria.add(id);
    archivosMem.set(k, f);
    fueraDelTelefono.add(k);
    reportar('idb', new Error('trabajo solo en memoria'), { bytes: f.size });
    emitir(id);
    return 'memoria';
  }

  /**
   * Quitar un archivo SIN esperar el candado: se marca 'quitado' (lápida) y
   * la cola lo respeta. Si ya había llegado al servidor se marca `limpiar` y
   * la limpieza la hace la COLA, bajo su candado y con reintento.
   */
  async function quitarArchivo(id: string, fid: string): Promise<'ok' | 'no-estaba'> {
    let estaba = false;
    const r = await actualizar(
      id,
      (t) => {
        const a = t.archivos.find((x) => x.fid === fid);
        if (!a || a.estado === 'quitado') return null;
        estaba = true;
        const eraFallido = a.estado === 'fallido';
        if (a.estado === 'subido' || a.estado === 'ligado' || a.arriba) a.limpiar = true;
        a.estado = 'quitado';
        if (eraFallido && !fallidos(t)) {
          t.conError = false;
          t.ultimoError = null;
        }
        return t;
      },
      { borrarBlobs: [claveBlob(id, fid)] }
    ).catch(() => undefined);
    soltar(id, fid);
    if (r === undefined || !estaba) return 'no-estaba';
    void procesar(id);
    return 'ok';
  }

  // --- Lo que lee la pantalla ------------------------------------------

  /** El File de un archivo en cola (miniatura, Guardar en Fotos): memoria o teléfono; null si no está. */
  async function archivoLocal(id: string, fid: string): Promise<File | null> {
    const k = claveBlob(id, fid);
    const mem = archivosMem.get(k);
    if (mem) return mem;
    if (fueraDelTelefono.has(k)) return null;
    try {
      return await idbBlob(k);
    } catch {
      return null;
    }
  }

  /** ¿Hay copia del archivo en esta pestaña o en el teléfono? (sin leerla). */
  function hayCopia(id: string, fid: string): boolean {
    const k = claveBlob(id, fid);
    return archivosMem.has(k) || !fueraDelTelefono.has(k);
  }

  function estaEnviando(id: string): boolean {
    return enCurso.has(id);
  }

  /** Archivos del trabajo que solo viven en la memoria de esta pestaña. */
  function enRiesgoTrabajo(t: T): number {
    if (soloMemoria.has(t.id)) return t.archivos.filter((a) => !esFinal(a.estado)).length;
    return t.archivos.filter((a) => !esFinal(a.estado) && fueraDelTelefono.has(claveBlob(t.id, a.fid))).length;
  }

  const registroPendiente = (t: T) => !!ad.registroPendiente?.(t);

  /** Lo que pinta el aviso global (todos; `atencion` decide cuáles se ven). */
  async function listarAviso(email: string): Promise<ResumenAvisoCola[]> {
    return (await listar(email)).map((t) => {
      const fuera = enRiesgoTrabajo(t);
      const sm = soloMemoria.has(t.id);
      return {
        id: t.id,
        resumen: ad.donde(t),
        creado_en: t.creado_en,
        enviando: enCurso.has(t.id),
        soloMemoria: sm,
        fueraDelTelefono: fuera,
        ultimoError: t.ultimoError,
        conError: !!t.conError,
        archivos: t.archivos.filter((a) => a.estado !== 'quitado').length,
        ligados: t.archivos.filter((a) => a.estado === 'ligado').length,
        registrarPedido: registroPendiente(t),
        atencion: !soloLimpieza(t) && (!!t.conError || sm || fuera > 0 || !!t.ultimoError),
      };
    });
  }

  /**
   * Lo que se perdería o quedaría a medias al salir: archivos sin terminar,
   * limpiezas, pasos extra y registros por hacer. Una visita que solo espera
   * más fotos no cuenta (lo que tenía ya está arriba).
   */
  async function pendientes(email: string): Promise<number> {
    try {
      let n = 0;
      for (const t of await listar(email)) {
        n += porSubir(t) + porLimpiar(t).length;
        if (ad.hayExtra?.(t)) n++;
        if (registroPendiente(t)) n++;
      }
      return n;
    } catch {
      return 0;
    }
  }

  // --- Pasos de la cola --------------------------------------------------

  async function quitarObjeto(path: string): Promise<void> {
    const r = await conTope(sb.storage.from(BUCKET_EVIDENCIAS).remove([path]), ESPERA_LECTURA_MS);
    if (r.error && clasificarStorage(r.error) === 'red') throw new SinRed(mensajeDe(r.error));
  }

  const h: Herramientas<T> = {
    leer,
    actualizar: (id, fn) => actualizar(id, fn),
    sesionValida: sesionValidaEnServidor,
    quitarObjeto,
    avisar,
    reportar,
  };

  /**
   * El File de un archivo: el original en memoria o el del teléfono. null =
   * de verdad no está. Si IndexedDB FALLA se lanza SinLectura (sigue en
   * cola) hasta MAX_LECTURAS_FALLIDAS seguidas. También se prueba (con
   * tope) que los bytes se dejen leer.
   */
  async function archivoDe(t: T, a: A): Promise<File | null> {
    const k = claveBlob(t.id, a.fid);
    const legible = async (f: File) => {
      await conTope(f.slice(0, 1).arrayBuffer(), ESPERA_LECTURA_MS);
      if (a.lecturasFallidas) await conArchivo(t.id, a.fid, (x) => void delete x.lecturasFallidas);
      return f;
    };
    const enTelefono = !fueraDelTelefono.has(k);
    const mem = archivosMem.get(k) ?? null;
    try {
      if (mem) {
        try {
          return await legible(mem);
        } catch (err) {
          if (!enTelefono) throw err;
          archivosMem.delete(k);
          const copia = await idbBlob(k);
          if (!copia) throw err;
          return await legible(copia);
        }
      }
      if (!enTelefono) return null;
      const f = await idbBlob(k);
      if (!f) return null;
      return await legible(f);
    } catch (err) {
      const n = (a.lecturasFallidas || 0) + 1;
      if (n >= MAX_LECTURAS_FALLIDAS) {
        reportar('lecturaLocal', err, { intentos: n });
        return null;
      }
      await conArchivo(t.id, a.fid, (x) => {
        x.lecturasFallidas = n;
      }).catch(() => undefined);
      throw new SinLectura('No se pudo leer una foto guardada en el teléfono: ' + mensajeDe(err));
    }
  }

  /** Cambia el estado de un archivo SIN pisar la lápida. Devuelve el archivo como quedó. */
  async function moverA(id: string, fid: string, estado: EstadoArchivoCola, op?: { borrarBlob?: boolean }): Promise<A | null> {
    const r = await conArchivo(
      id,
      fid,
      (x) => {
        if (x.estado === 'quitado') return;
        x.estado = estado;
        if (estado === 'subido') x.arriba = true;
      },
      op
    );
    return r?.archivos.find((x) => x.fid === fid) ?? null;
  }

  /** Quitado después de llegar al servidor: que la cola limpie. */
  function marcarLimpiar(id: string, fid: string) {
    return conArchivo(id, fid, (x) => {
      if (x.estado === 'quitado') x.limpiar = true;
    });
  }

  function delta(id: string) {
    let d = deltas.get(id);
    if (!d) deltas.set(id, (d = { fotos: 0, registradas: 0, ultimo: null }));
    return d;
  }

  /**
   * Un archivo, de su estado actual hasta 'ligado' (o quitado/perdido/fallido).
   *   · Ningún cambio de estado pisa una lápida ('quitado').
   *   · Un rechazo definitivo deja el archivo 'fallido' con su Blob y lo
   *     salta en esta corrida.
   */
  async function mandarArchivo(t: T, a0: A, saltar: Set<string>): Promise<void> {
    const id = t.id;
    let a = a0;
    const venia = a0.estado;
    const desdeCero = a.estado === 'local' || (a.estado === 'fallido' && !a.arriba);
    if (desdeCero) {
      const f = await archivoDe(t, a);
      if (!f) {
        reportar('archivoPerdido', new Error('archivo no encontrado'), { bytes: a.bytes }, a.path);
        await moverA(id, a.fid, 'perdido');
        soltar(id, a.fid);
        return;
      }
      await exigirSesion(undefined, t.email);
      const res = await conReintento(() => subir(a, f, t.email));
      if (res !== 'ok') {
        reportar('subida', res.definitivo, { bytes: f.size }, a.path);
        await moverA(id, a.fid, 'fallido');
        saltar.add(a.fid);
        await anotar(id, conPunto(`No se pudo subir la foto ${a.n}: ${mensajeDe(res.definitivo)}`), true);
        return;
      }
      const y = await moverA(id, a.fid, 'subido');
      if (!y || y.estado === 'quitado') {
        await marcarLimpiar(id, a.fid);
        return;
      }
      a = y;
    }
    await exigirSesion(undefined, t.email);
    const fresco = (await leer(id)) ?? t;
    const r = await conReintento(() => ad.ligar(fresco, a, h));
    switch (r.tipo) {
      case 'ok': {
        let primera = false;
        let final = false;
        // El Blob se borra en la misma transacción solo si quedó ligado
        // (actualizar lee la lista después de correr la función).
        const borrarBlobs: string[] = [];
        const y = await actualizar(
          id,
          (tt) => {
            const x = tt.archivos.find((z) => z.fid === a.fid);
            if (!x || x.estado === 'quitado') return null;
            final = r.cambio(x);
            if (final) {
              // POR QUÉ `en_logro` (27-oct-2026): una foto que el servidor no
              // ligó a ninguna toma (todas cerradas, futuras o ajenas) no es
              // «foto arriba» en el aviso breve; si después «Usar también
              // para…» la liga, ahí sí cuenta (una sola vez). Un archivo
              // viejo, ya ligado y sin la marca, no se vuelve a contar.
              if (!x.ligado_en || x.en_logro === false) {
                primera = x.tipo === 'foto' && (ad.cuentaEnLogro ? ad.cuentaEnLogro(x) : true);
                x.en_logro = primera;
              }
              x.estado = 'ligado';
              x.arriba = true;
              x.ligado_en = x.ligado_en ?? new Date().toISOString();
              borrarBlobs.push(claveBlob(id, a.fid));
            } else {
              x.estado = 'subido';
              x.arriba = true;
            }
            return tt;
          },
          { borrarBlobs }
        );
        const x = y?.archivos.find((z) => z.fid === a.fid);
        if (final) soltar(id, a.fid);
        if (primera) delta(id).fotos++;
        r.avisos?.forEach((v) => avisar(t.email, v));
        if (x?.estado === 'quitado') await marcarLimpiar(id, a.fid);
        if (y && !fallidos(y) && (venia === 'fallido' || (y.conError && y.errorDeLigar))) await limpiarError(id);
        else if (y && !y.conError && y.ultimoError) await limpiarPasajero(id);
        if (!final) saltar.add(a.fid);
        return;
      }
      case 'subirOtraVez': {
        await conArchivo(id, a.fid, (x) => {
          if (x.estado === 'quitado') return;
          r.cambio?.(x);
          x.estado = 'local';
          delete x.arriba;
        });
        // Se vuelve a subir en esta misma corrida (el adaptador pone el tope).
        return;
      }
      case 'atencion': {
        saltar.add(a.fid);
        await anotar(id, conPunto(r.mensaje), true, 'ligar');
        return;
      }
      case 'definitivo': {
        await moverA(id, a.fid, 'fallido');
        saltar.add(a.fid);
        await anotar(id, conPunto(r.mensaje), true);
        return;
      }
    }
  }

  /** Claves registrándose ahora en esta pestaña. */
  const registrando = new Set<string>();

  async function registrarSiToca(t: T): Promise<'nada' | 'ocupado' | ResultadoRegistro> {
    if (!ad.registrar || !registroPendiente(t)) return 'nada';
    // Otro trabajo de la misma clave (raro: uno quedó en memoria) con
    // archivos en camino: primero ellos.
    // POR QUÉ solo fotos (26-oct-2026): un video nunca cuenta (B6) y uno
    // lento no debe frenar el envío de las tomas que ya están completas.
    const otros = (await deClave(t.clave)).filter((x) => x.id !== t.id);
    if (otros.some((x) => porMandar(x).some((a) => a.tipo === 'foto'))) return 'nada';
    if (registrando.has(t.clave)) return 'ocupado';
    registrando.add(t.clave);
    try {
      return await conCandado<'ocupado' | ResultadoRegistro>(
        t.clave,
        async () => {
          const fresco = await leer(t.id);
          // Lo que sigue en camino lo decide el adaptador POR TOMA
          // (registroPendiente): un archivo de otra toma, o un video, no
          // detiene el registro de las que ya están completas.
          if (!fresco || !registroPendiente(fresco)) return 'nada';
          return ad.registrar!(fresco, h);
        },
        'ocupado',
        ad.prefijoRegistro
      );
    } finally {
      registrando.delete(t.clave);
    }
  }

  const cerrable = (x: T) =>
    listoParaCerrar(x) && !ad.hayExtra?.(x) && !registroPendiente(x) && (ad.puedeSoltar ? ad.puedeSoltar(x) : true);

  /**
   * Manda un trabajo: limpia lo quitado que llegó al servidor, el paso extra
   * del adaptador, sube y liga sus archivos (fotos primero), registra lo que
   * toque y lo cierra si ya no queda nada. Relee el trabajo en cada pasada.
   */
  async function ejecutar(id: string, forzar: boolean): Promise<ResultadoInterno> {
    let t = await leer(id);
    if (!t) return { tipo: 'yaHecha' };
    const avisadoPrevio = t.avisado ?? null;
    const error = (tt: T, mensaje: string, aviso: TipoAviso = 'error'): ResultadoInterno => ({
      tipo: 'error',
      id,
      mensaje,
      nuevo: mensaje.slice(0, 300) !== avisadoPrevio,
      email: norm(tt.email),
      donde: ad.donde(tt),
      clave: tt.clave,
      aviso,
    });
    const saltar = new Set<string>(forzar ? [] : t.archivos.filter((a) => a.estado === 'fallido').map((a) => a.fid));
    const pend = (x: T) => porMandar(x).filter((a) => !saltar.has(a.fid));
    // El registro falló en esta corrida: no se repite, pero los videos que
    // queden sí se mandan (el error ya quedó anotado y se devuelve al final).
    let regFallo: TipoAviso | null = null;
    try {
      await exigirSesion(undefined, t.email);
      for (let pasada = 0; pasada < MAX_PASADAS; pasada++) {
        t = await leer(id);
        if (!t) return { tipo: 'yaHecha' };
        delta(id).ultimo = t;
        const limpiar = porLimpiar(t)[0];
        if (limpiar) {
          await ad.limpiar(t, limpiar, h);
          continue;
        }
        if (ad.pasoExtra && (await ad.pasoExtra(t, h))) continue;
        const siguiente = pend(t)[0];
        // Fotos primero; los videos (al final de porMandar) esperan a que se
        // registre lo que ya se puede (B11): un video lento no frena el envío.
        if (siguiente && siguiente.tipo !== 'video') {
          await mandarArchivo(t, siguiente, saltar);
          continue;
        }
        const reg: Awaited<ReturnType<typeof registrarSiToca>> = regFallo ? 'nada' : await registrarSiToca(t);
        if (typeof reg === 'object' && 'error' in reg) {
          delta(id).registradas += reg.registradas ?? 0;
          reg.avisos?.forEach((v) => avisar(t!.email, v));
          await anotar(id, reg.error, true, 'registro');
          if (!siguiente) return error(t, reg.error, reg.tipo ?? 'error');
          regFallo = reg.tipo ?? 'error';
          await mandarArchivo(t, siguiente, saltar);
          continue;
        }
        const registro = typeof reg === 'object';
        if (registro) {
          delta(id).registradas += reg.registradas;
          reg.avisos?.forEach((v) => avisar(t!.email, v));
          t = await leer(id);
          if (!t) return { tipo: 'yaHecha' };
          // POR QUÉ (26-oct-2026): el error que dejó un registro anterior («No
          // se pudo leer el estado…») ya se resolvió; mientras quede otra toma
          // abierta la visita sigue viva y, sin esto, se quedaba en «atención»
          // con un texto que ya no aplica. Uno de una foto rechazada o de un
          // regreso todavía vigente (lo dice el adaptador) se queda.
          if (
            t.conError &&
            t.errorDeRegistro &&
            !fallidos(t) &&
            (ad.errorDeRegistroResuelto ? ad.errorDeRegistroResuelto(t) : true)
          ) {
            await limpiarError(id);
            t = await leer(id);
            if (!t) return { tipo: 'yaHecha' };
          }
          delta(id).ultimo = t;
        }
        if (siguiente) {
          if (registro) continue;
          await mandarArchivo(t, siguiente, saltar);
          continue;
        }
        // Cierre atómico: solo si, releído en la misma transacción, ya no queda nada.
        const antes = t;
        const r = await actualizar(id, (x) => (cerrable(x) ? 'borrar' : null));
        if (r === undefined) return { tipo: 'yaHecha' };
        if (r === null) {
          const perdidosTxt = textoPerdidas(antes);
          if (perdidosTxt) return error(antes, perdidosTxt);
          return { tipo: 'hecha' };
        }
        if (pend(r).length || porLimpiar(r).length || ad.hayExtra?.(r)) continue;
        // Registró algo y aún queda por registrar (otra toma lista): otra pasada.
        if (registro && registroPendiente(r)) continue;
        if (r.conError && r.ultimoError) return error(r, r.ultimoError, regFallo ?? 'error');
        // Llegó hasta aquí sin tropezar: un «Sin señal…» viejo ya no aplica.
        if (r.ultimoError) await limpiarPasajero(id);
        return { tipo: 'sigue' };
      }
      return { tipo: 'sigue' };
    } catch (err) {
      if (err instanceof SinRed) {
        const texto = err instanceof Ocupada ? err.message : textoEnCola(err, 'sola');
        await anotar(id, texto, false);
        // Una subida lenta o la base ocupada no detienen a las demás visitas.
        return { tipo: 'enCola', cortar: !(err instanceof SubidaLenta || err instanceof Ocupada) };
      }
      reportar('ejecutar', err, undefined, id);
      await anotar(id, 'Falló por un error de la app; se reintenta sola.', false);
      return { tipo: 'enCola', cortar: false };
    }
  }

  /** Empuja el logro de la corrida (si hubo algo) al buzón del aviso breve. */
  function soltarLogro(id: string): void {
    const d = deltas.get(id);
    deltas.delete(id);
    if (!d || !d.ultimo || (!d.fotos && !d.registradas) || !ad.logro) return;
    const l = ad.logro(d.ultimo, { fotos: d.fotos, registradas: d.registradas });
    if (l) logros.push({ email: norm(d.ultimo.email), logro: l });
  }

  /**
   * Una corrida por trabajo a la vez en la pestaña, con candado entre
   * pestañas. `forzar` = también reintenta lo que el servidor rechazó.
   */
  function procesar(id: string, forzar = false): Promise<ResultadoInterno> {
    const previo = enCurso.get(id);
    if (previo) {
      otraVuelta.add(id);
      if (forzar) otraVueltaForzada.add(id);
      return Promise.resolve({ tipo: 'ocupado' });
    }
    const p = conCandado<ResultadoInterno>(id, () => ejecutar(id, forzar), { tipo: 'ocupado' }, ad.prefijoCandado)
      .catch((err): ResultadoInterno => {
        reportar('procesar', err);
        return { tipo: 'enCola', cortar: false };
      })
      .then(async (r) => {
        soltarLogro(id);
        // Un error definitivo NUEVO se avisa una vez y se anota que ya se avisó.
        if (r.tipo === 'error' && r.nuevo) {
          avisar(r.email, { texto: `Fotos de ${r.donde}: ${conPunto(r.mensaje)}`, tipo: r.aviso, clave: r.clave });
          await actualizar(r.id, (x) => {
            x.avisado = r.mensaje.slice(0, 300);
            return x;
          }).catch(() => undefined);
          emitir(r.id);
        }
        return r;
      })
      .finally(() => {
        enCurso.delete(id);
        emitir(id);
        if (otraVuelta.delete(id)) void procesar(id, otraVueltaForzada.delete(id));
      });
    enCurso.set(id, p);
    emitir(id);
    return p;
  }

  /**
   * Corre el trabajo (forzado) y espera hasta `ms` a que termine, también la
   * corrida extra que pudo quedar pedida. Devuelve el último error de una
   * corrida esperada (la pantalla lo muestra si el trabajo ya se cerró).
   */
  async function correrYEsperar(id: string, ms: number): Promise<{ error: string | null }> {
    const inicio = Date.now();
    const resta = () => Math.max(0, ms - (Date.now() - inicio));
    let errorCorrida: string | null = null;
    const anotarCorrida = (r: ResultadoInterno) => {
      if (r.tipo === 'error') errorCorrida = r.mensaje;
    };
    const yaCorria = enCurso.get(id);
    if (yaCorria) {
      otraVuelta.add(id);
      otraVueltaForzada.add(id);
    }
    const corrida = yaCorria ?? procesar(id, true);
    await Promise.race([corrida.then(anotarCorrida), dormir(resta())]);
    for (let s = enCurso.get(id); yaCorria && s && resta() > 0; s = enCurso.get(id))
      await Promise.race([s.then(anotarCorrida), dormir(resta())]);
    return { error: errorCorrida };
  }

  /**
   * El usuario descarta un trabajo desde el aviso: lo que no subió se borra
   * del teléfono y lo que subió sin ligar se limpia del servidor (solo el
   * objeto que nada usa). Lo que ya entró a una toma se queda. Lo que el
   * monitorista QUITÓ y la cola aún no limpia no se suelta: el trabajo se
   * queda solo con esa limpieza, sin pedir atención.
   */
  async function descartar(id: string): Promise<'ok' | 'ocupado'> {
    if (enCurso.has(id)) return 'ocupado';
    let relanzar = false;
    const r = await conCandado<'ok' | 'ocupado'>(
      id,
      async () => {
        const t = await leer(id).catch(() => null);
        const arriba = (a: A) => a.estado === 'subido' || (a.estado === 'fallido' && !!a.arriba);
        const quedan = t
          ? new Set(
              t.archivos
                .filter((a) => arriba(a) || (a.estado === 'quitado' && a.limpiar) || !!ad.conservarAlDescartar?.(a))
                .map((a) => a.fid)
            )
          : new Set<string>();
        if (t && quedan.size) {
          const r = await actualizar(
            id,
            (x) => {
              x.archivos = x.archivos
                .filter((a) => quedan.has(a.fid))
                .map((a) => (arriba(a) ? { ...a, estado: 'quitado' as const, limpiar: 'objeto' as const } : a));
              ad.alDescartar?.(x);
              x.conError = false;
              x.ultimoError = null;
              return x;
            },
            { borrarBlobs: t.archivos.map((a) => claveBlob(id, a.fid)) }
          ).catch(() => undefined);
          t.archivos.forEach((a) => soltar(id, a.fid));
          if (r) {
            relanzar = true;
            return 'ok' as const;
          }
        }
        descartados.add(id);
        alIndice(id, null);
        t?.archivos.forEach((a) => soltar(id, a.fid));
        memoria.delete(id);
        const soloMem = soloMemoria.delete(id);
        const borrado = base
          .tx(['trabajos', 'blobs'], 'readwrite', (x) => {
            x.objectStore('trabajos').delete(id);
            t?.archivos.forEach((a) => x.objectStore('blobs').delete(claveBlob(id, a.fid)));
          })
          .catch(() => {
            /* sin IndexedDB no había nada guardado */
          });
        if (!soloMem) await borrado;
        emitir(id);
        return 'ok' as const;
      },
      'ocupado' as const,
      ad.prefijoCandado
    );
    if (relanzar) void procesar(id, true);
    return r;
  }

  /** La vuelta en curso de cada correo (una por correo, como las otras colas). */
  const vueltas = new Map<string, Promise<ResumenVueltaCola>>();

  /**
   * Procesa los trabajos de este correo, del más viejo al más nuevo. Al
   * primer "sin red" los demás no se intentan; una subida lenta o la base
   * ocupada no cortan la vuelta. Un error definitivo se reintenta en cada
   * vuelta y su aviso sale una sola vez.
   */
  function procesarPendientes(email: string): Promise<ResumenVueltaCola> {
    const em = norm(email);
    const enCursoDe = vueltas.get(em);
    if (enCursoDe) return enCursoDe;
    const vuelta: Promise<ResumenVueltaCola> = (async () => {
      const res: ResumenVueltaCola = { terminadas: 0, siguen: 0, mensajes: [] };
      const lista = await listar(em);
      let cortar = false;
      for (const t of lista) {
        if (cortar || enCurso.has(t.id)) {
          res.siguen++;
          continue;
        }
        const r = await procesar(t.id, true);
        if (r.tipo === 'hecha' || r.tipo === 'yaHecha') res.terminadas++;
        else {
          res.siguen++;
          if (r.tipo === 'enCola' && r.cortar) cortar = true;
        }
      }
      res.mensajes.push(...tomarAvisos(em));
      return res;
    })().finally(() => {
      if (vueltas.get(em) === vuelta) vueltas.delete(em);
    });
    vueltas.set(em, vuelta);
    return vuelta;
  }

  return {
    // lectura
    leer,
    listar,
    deClave,
    archivoLocal,
    hayCopia,
    estaEnviando,
    enRiesgoTrabajo,
    listarAviso,
    pendientes,
    // escritura
    crear,
    obtenerTrabajo,
    agregarArchivo,
    actualizar,
    quitarArchivo,
    claveBlob,
    // corridas
    procesar,
    correrYEsperar,
    procesarPendientes,
    descartar,
    // avisos
    emitir,
    suscribir,
    avisar,
    tomarAvisos,
    tomarLogros,
    logrosPorMostrar,
    marcarVisto,
    rearmarIndice,
  };
}

export type ColaFotos<T extends TrabajoCola<A>, A extends ArchivoCola, L extends { llave: string; en: number }> = ReturnType<
  typeof crearColaFotos<T, A, L>
>;
