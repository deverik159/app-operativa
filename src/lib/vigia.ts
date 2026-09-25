// ============================================================
// src/lib/vigia.ts
// Vigía de renders: convierte un ciclo de renders que NO suelta el hilo en
// un error que atrapa el ErrorBoundary del módulo (app pasmada sin señal,
// 24-sep-2026).
//
// QUÉ PASÓ: sin señal, abrir "+ Nueva" metía a NuevaInc en un ciclo infinito
// de microtareas (render → efecto → lectura local cumplida en microtarea →
// setState → render…). El hilo nunca volvía al bucle de eventos: ni toques,
// ni menú, ni ↻, ni el evento `online`. Solo matar la app lo destrababa. La
// causa ya se corrigió en NuevaInc; esto es para que un ciclo FUTURO de la
// misma clase cueste ~1.5 s y un aviso "Este módulo tuvo un error", y no la
// app congelada hasta que la maten.
//
// POR QUÉ NO PUEDE HABER UN "BOTÓN DE PÁNICO" EN LA PÁGINA: mientras dura un
// ciclo de microtareas, el navegador no despacha NINGUNA tarea. Los toques,
// los timers, los mensajes y hasta el repintado esperan a que la cola de
// microtareas se vacíe, y en el ciclo nunca se vacía. Un botón (de React o
// de HTML puro), un setTimeout que vigile o un Worker que avise por
// postMessage nunca llegan a correr su código en el hilo principal, y un
// Worker no puede interrumpir al hilo principal. Lo ÚNICO que corre durante
// el ciclo es el propio ciclo: por eso el corte vive dentro del render. Un
// throw en el render lo entrega React al ErrorBoundary, que desmonta el
// módulo; al desmontar, los efectos apagan sus `vivo` y el ciclo muere.
//
// CÓMO DECIDE: un "latido" marca cada vez que el hilo SÍ soltó (corrió una
// tarea): un reloj de fondo de 250 ms; visibilitychange/pageshow/focus
// (volver de segundo plano); y un mensaje por MessageChannel que se agenda
// en el primer render vigilado de cada vuelta del bucle. Ese mensaje es el
// latido fino: Chrome estrangula los timers de una pestaña oculta hasta uno
// por minuto, pero no los mensajes, y sin él los renders de varios minutos
// en segundo plano se sumarían como si fueran una sola tanda. Solo dispara
// con MÁS de 400 renders vigilados Y MÁS de 1.5 s sin un solo latido, las
// dos cosas a la vez (o, para ciclos lentos con renders pesados, más de 60
// renders y más de 4 s sin latido).
//
// POR QUÉ NUNCA DISPARA EN USO NORMAL: cada toque, tecla, respuesta de red o
// timer es una tarea, y entre dos tareas corre el latido (el contador vuelve
// a cero). Teclear rápido, una lista enorme o el primer render pesado son
// pocos renders del modal por tarea, aunque la tarea dure segundos (un
// render pesado de 2 s son 1-3 renders vigilados, no 400). Un alert/confirm
// abierto congela el reloj, pero no suma renders. Para llegar a 400 sin
// soltar el hilo hay que estar en un ciclo: en el de NuevaInc eran ~30 000
// renders por segundo.
//
// PEGAJOSO: al disparar, React reintenta el render una vez en el mismo
// trabajo síncrono (y en desarrollo, otra más): si ese reintento pasara, el
// ciclo seguiría. Por eso todo render vigilado lanza hasta que termina ese
// trabajo síncrono (una microtarea después), y el contador vuelve a cero:
// un toque que quedó en cola durante el congelamiento y abre otro modal no
// hereda la cuenta vieja.
//
// Uso: `vigilarRender('NuevaInc')` en la PRIMERA línea del cuerpo del
// componente, y solo en componentes que estén DENTRO de un ErrorBoundary
// (fuera de él, un throw desmonta la app entera). Se reporta una sola vez
// por carga con reportarError; el ErrorBoundary agrega su propia fila
// ('render:<módulo>') con la pila de componentes.
// ============================================================
import { reportarError } from './reportarError';

/** Renders vigilados sin un solo latido de por medio. */
const MAX_RENDERS = 400;
/** …y además este tiempo sin latido. Las dos cosas a la vez, nunca una sola. */
const MAX_SIN_LATIDO_MS = 1500;
/**
 * Segunda regla, para ciclos LENTOS (revisión del blindaje, 24-sep-2026): si
 * cada vuelta incluye un render pesado (la lista con 150 tarjetas en un
 * iPhone), 400 renders pueden tardar minutos. 60 renders sin soltar el hilo
 * durante 4 s tampoco ocurren en uso normal: un render pesado legítimo son
 * 1-3 renders por tarea.
 */
const MAX_RENDERS_LENTO = 60;
const MAX_SIN_LATIDO_LENTO_MS = 4000;
/**
 * Reloj de fondo. 1 s basta (antes 250 ms): el latido fino es el mensaje por
 * MessageChannel de cada vuelta; el reloj solo cubre el caso sin renders.
 */
const LATIDO_MS = 1000;

/** Ya se instalaron los latidos (se arma con el primer render vigilado). */
let armado = false;
/** Sin reloj no se vigila: el contador nunca volvería a cero y dispararía en falso. */
let activo = false;
/** La última vez que el hilo soltó. */
let latido = 0;
/** Renders vigilados desde ese latido. */
let renders = 0;
/** Pegajoso hasta que acabe el trabajo síncrono en curso (ver cabecera). */
let disparado = false;
let reportado = false;
let canal: MessageChannel | null = null;
/** El mensaje del latido fino ya va en camino (uno por vuelta del bucle). */
let pingEnCamino = false;

function latir(): void {
  latido = performance.now();
  renders = 0;
  // Si el mensaje se perdió (p. ej. la página se congeló con él en camino),
  // el siguiente render agenda otro; dos en camino no estorban.
  pingEnCamino = false;
}

function armar(): void {
  armado = true;
  latir();
  try {
    setInterval(latir, LATIDO_MS);
    activo = true;
  } catch {
    return; // sin reloj de fondo, no se vigila
  }
  try {
    if (typeof addEventListener === 'function')
      for (const ev of ['visibilitychange', 'pageshow', 'focus'])
        addEventListener(ev, latir, true);
  } catch {
    /* con el reloj basta */
  }
  try {
    if (typeof MessageChannel === 'function') {
      canal = new MessageChannel();
      canal.port1.onmessage = latir;
    }
  } catch {
    canal = null;
  }
}

/**
 * Va en la primera línea del render. No hace nada salvo contar, hasta que
 * el hilo lleva >1.5 s y >400 renders sin soltar: entonces lanza
 * `AppPasmada: <quien>` para que el ErrorBoundary desmonte el módulo.
 */
export function vigilarRender(quien: string): void {
  if (!armado) armar();
  if (!activo) return;
  if (disparado) throw new Error('AppPasmada: ' + quien);
  renders++;
  if (canal && !pingEnCamino) {
    pingEnCamino = true;
    try {
      canal.port2.postMessage(0);
    } catch {
      pingEnCamino = false;
    }
  }
  if (renders <= MAX_RENDERS_LENTO) return;
  const sinLatido = performance.now() - latido;
  const ciclo =
    (renders > MAX_RENDERS && sinLatido > MAX_SIN_LATIDO_MS) ||
    sinLatido > MAX_SIN_LATIDO_LENTO_MS;
  if (!ciclo) return;

  const n = renders;
  disparado = true;
  renders = 0;
  void Promise.resolve().then(() => {
    disparado = false;
  });
  // Mensaje fijo (sin conteos): el ErrorBoundary reporta por firma
  // módulo+mensaje, así el reintento de React no deja otra fila.
  const err = new Error('AppPasmada: ' + quien);
  if (!reportado) {
    reportado = true;
    reportarError('vigia', err, {
      quien,
      renders: n,
      msSinLatido: Math.round(sinLatido),
      visible: typeof document !== 'undefined' ? document.visibilityState : null,
    });
  }
  throw err;
}
