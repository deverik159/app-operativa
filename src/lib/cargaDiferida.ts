// ============================================================
// src/lib/cargaDiferida.ts
// Carga diferida de módulos (React.lazy) que sobrevive a un despliegue.
//
// POR QUÉ (auditoría primer mes, 24-sep-2026): el bundle era un solo
// index.js de ~1.3 MB; xlsx (~400 KB) y leaflet entraban aunque el usuario
// nunca abriera Rutas o la Bitácora. Con 300 celulares en campo, cada
// arranque bajaba y compilaba código que la mayoría no usa. Ahora cada
// módulo pesado es un chunk aparte que se pide al abrir su pestaña.
//
// EL COSTO de partir el bundle: tras cada despliegue, una pestaña que se
// quedó abierta con el index.html VIEJO pide chunks con hash viejo que ya
// no existen. vercel.json reescribe todo menos /assets a index.html, así
// que /assets/PautaView-viejo.js responde 404 y el import() truena. Sin
// esto, el usuario veía "este módulo tuvo un error" hasta recargar a mano.
//
// Qué hace lazyConReintento:
//   1. Si el import falla, reintenta UNA vez tras ~800 ms (un corte de red
//      de un instante no debe tumbar el módulo).
//   2. Si vuelve a fallar, es un error de chunk y ese módulo SIGUE en
//      pantalla (ver abajo), recarga la página UNA sola vez para traer el
//      index.html y los assets nuevos de Vercel. La marca va en
//      sessionStorage con la hora: si ya se recargó hace < 60 s, el error
//      sigue al ErrorBoundary (así no hay bucle de recargas).
//   3. Antes de recargar confirma que hay red y que el servidor contesta:
//      sin red, recargar dejaría la pantalla "sin conexión" del navegador
//      en vez de la app (el service worker no guarda nada en caché).
//
// CUÁNDO RECARGAR ES SEGURO (revisión primer mes, 24-sep-2026): la descarga
// de un chunk es asíncrona y SIGUE VIVA aunque el usuario se cambie de
// pestaña. La primera versión daba por hecho que "si falló, ya no hay
// captura que perder", y era falso: con Indicadores atorado en "Cargando…",
// el reportante tocaba Nueva, tomaba fotos y fijaba GPS, y cuando la
// descarga por fin fallaba la app se recargaba sola y se llevaba el alta.
// Ahora solo se recarga sola si el módulo que falló es el que está en
// pantalla EN ESE MOMENTO (App lo avisa con fijarModuloEnPantalla): ese
// módulo sigue en "Cargando…", no tiene nada capturado, y el alta (dentro
// de Incidencias, que es estático) no puede estar a la vista a la vez. Si
// el usuario ya se fue a otra pestaña, el error se guarda; al volver, el
// ErrorBoundary lo libera y se intenta de nuevo, ya con el módulo en
// pantalla (y si vuelve a fallar, aquí sí puede recargar o se muestra el
// aviso). Además, el armazón (aviso de envíos) puede pedir que no se
// recargue sola mientras un envío esté EN CURSO con
// retenerRecargaAutomatica(); el usuario decide desde el aviso.
// Las dos condiciones se revisan antes Y después de probar el servidor.
// ============================================================
import { createElement, lazy, type ComponentProps, type ComponentType } from 'react';

/** Marca en sessionStorage: hora (ms) de la última recarga por chunk. */
const CLAVE_RECARGA = 'gpovallas_recarga_por_chunk';
/** Dentro de esta ventana no se vuelve a recargar sola: el error se muestra. */
const VENTANA_RECARGA_MS = 60 * 1000;
/** Espera antes del único reintento del import. */
const ESPERA_REINTENTO_MS = 800;
/** Tope para la prueba de "¿el servidor contesta?" antes de recargar. */
const TOPE_PRUEBA_MS = 4000;

/**
 * Mensajes con que cada navegador reporta un chunk que no llegó:
 * Chrome/Edge, Safari, Firefox, el preload de CSS de Vite y webpack
 * (ChunkLoadError, por si algún día se cambia de empaquetador).
 */
const PATRONES_CHUNK = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Unable to preload CSS/i,
  /ChunkLoadError/i,
  /Loading (CSS )?chunk [\w-]+ failed/i,
];

/** ¿El error es de un chunk que no se pudo descargar (versión vieja o red)? */
export function esErrorDeChunk(e: unknown): boolean {
  if (!e) return false;
  try {
    const nombre =
      typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
    if (nombre === 'ChunkLoadError') return true;
    const mensaje =
      e instanceof Error
        ? e.message
        : typeof e === 'object' && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e);
    return PATRONES_CHUNK.some((r) => r.test(mensaje));
  } catch {
    return false;
  }
}

/** Envíos en curso que pidieron no recargar sola (ver arriba). */
let retenciones = 0;

/**
 * El módulo diferido que el usuario tiene en pantalla AHORA (el componente
 * que devolvió lazyConReintento), o null en Incidencias y demás pestañas
 * sin chunk. Se compara por identidad y no por nombre: así un nombre mal
 * escrito en App no puede autorizar una recarga (revisión primer mes,
 * 24-sep-2026).
 */
let moduloEnPantalla: ComponentType<any> | null = null;

/** La llama App en cada cambio de pestaña (ver "CUÁNDO RECARGAR ES SEGURO"). */
export function fijarModuloEnPantalla(modulo: ComponentType<any> | null): void {
  moduloEnPantalla = modulo;
}

/**
 * Mientras esté retenida, un chunk viejo NO recarga la app solo: el error
 * llega al ErrorBoundary y el usuario decide con "Recargar la app".
 * Devuelve la función que suelta la retención (llamarla una vez).
 */
export function retenerRecargaAutomatica(): () => void {
  retenciones++;
  let suelta = false;
  return () => {
    if (suelta) return;
    suelta = true;
    retenciones = Math.max(0, retenciones - 1);
  };
}

const esperar = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * ¿Se puede recargar ya? Deja la marca si sí.
 *
 * Si sessionStorage lanza (modo privado de Safari viejo, cuota llena), NO se
 * recarga: sin marca no habría forma de cortar un bucle de recargas, y un
 * bucle es peor que el aviso con su botón "Recargar la app".
 */
function tomarTurnoDeRecarga(): boolean {
  try {
    const previa = Number(sessionStorage.getItem(CLAVE_RECARGA) || 0);
    if (previa && Date.now() - previa < VENTANA_RECARGA_MS) return false;
    sessionStorage.setItem(CLAVE_RECARGA, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * ¿El servidor contesta? version.json no lleva hash y se pide sin caché:
 * si responde, el 404 del chunk es de un despliegue nuevo (recargar lo
 * arregla); si no, es la red y recargar solo empeoraría las cosas.
 */
async function servidorContesta(): Promise<boolean> {
  const ctrl = new AbortController();
  const tope = window.setTimeout(() => ctrl.abort(), TOPE_PRUEBA_MS);
  try {
    const res = await fetch(`/version.json?_=${Date.now()}`, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(tope);
  }
}

/**
 * Intenta la recarga única para el módulo `modulo`. true = la página ya se va.
 */
async function recargarPorVersionNueva(modulo: ComponentType<any>): Promise<boolean> {
  // navigator.onLine === false sí es confiable (true no lo es: por eso
  // además se prueba el servidor).
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  // Nada en riesgo: el módulo que falló es el que se ve (sigue en
  // "Cargando…") y ningún envío pidió retener. Se revisa otra vez DESPUÉS
  // de la prueba del servidor, que tarda hasta 4 s: en ese rato el usuario
  // pudo cambiarse de pestaña y empezar a capturar, o arrancar un envío
  // (revisión primer mes, 24-sep-2026).
  const nadaEnRiesgo = () => moduloEnPantalla === modulo && retenciones === 0;
  if (!nadaEnRiesgo()) return false;
  if (!(await servidorContesta())) return false;
  if (!nadaEnRiesgo()) return false;
  // La marca se toma al final: una prueba fallida no debe gastar el turno.
  if (!tomarTurnoDeRecarga()) return false;
  window.location.reload();
  return true;
}

/**
 * Módulos cuya carga falló, esperando a que el ErrorBoundary los libere.
 *
 * El lazy fallido NO se cambia en el momento del fallo: tras el rechazo,
 * React vuelve a pintar y ESE render debe encontrar el mismo lazy rechazado
 * para lanzar el error al ErrorBoundary. Cambiarlo ahí mismo (lo que hacía
 * la primera versión) metía un bucle: cada render arrancaba otra descarga,
 * el usuario se quedaba en "Cargando…" para siempre y se consultaba
 * version.json cada 3 s (visto en prueba local, 24-sep-2026).
 */
const fallidos = new Set<() => void>();

/**
 * La llama el ErrorBoundary al limpiar un error (Reintentar, cambio de
 * pestaña, ↻): los módulos que fallaron arman un intento nuevo para su
 * siguiente render. Sin fallidos no hace nada.
 *
 * Ojo: Chrome guarda el fallo de un import() por URL durante la vida de la
 * página, así que ahí el intento nuevo puede fallar al instante; por eso el
 * aviso ofrece primero "Recargar la app". En navegadores que no lo guardan,
 * Reintentar sí vuelve a descargar.
 */
export function reintentarCargasFallidas(): void {
  const lote = [...fallidos];
  fallidos.clear();
  for (const renovar of lote) renovar();
}

/**
 * React.lazy con un reintento y recuperación tras un despliegue.
 *
 * Además, a diferencia de React.lazy a secas, un fallo NO queda pegado:
 * React.lazy guarda la promesa rechazada para siempre y "Reintentar" en el
 * ErrorBoundary volvía a lanzar el mismo error sin pedir nada a la red.
 * Aquí, al liberarlo el ErrorBoundary (reintentarCargasFallidas), el
 * módulo arma un lazy nuevo y el siguiente render vuelve a intentarlo.
 *
 * @param importar el `() => import('./ruta/Modulo')` de siempre.
 * @param nombre nombre legible para React DevTools (p. ej. 'PautaView').
 */
export function lazyConReintento<T extends ComponentType<any>>(
  importar: () => Promise<{ default: T }>,
  nombre: string
): ComponentType<ComponentProps<T>> {
  const cargar = async (): Promise<{ default: T }> => {
    try {
      return await importar();
    } catch {
      await esperar(ESPERA_REINTENTO_MS);
      try {
        return await importar();
      } catch (e) {
        // Promesa que no se resuelve nunca: Suspense sigue en "Cargando…"
        // mientras la página se recarga, sin parpadear el aviso de error.
        if (esErrorDeChunk(e) && (await recargarPorVersionNueva(Diferido)))
          return new Promise<{ default: T }>(() => {});
        // Sin recarga (p. ej. el usuario ya está en otra pestaña): el lazy
        // queda rechazado en `fallidos` y, al volver, el ErrorBoundary lo
        // libera para un intento nuevo (ver "CUÁNDO RECARGAR ES SEGURO").
        throw e;
      }
    }
  };

  const crear = () =>
    lazy(() =>
      cargar().catch((e: unknown) => {
        // Se queda el lazy rechazado (el error debe llegar al
        // ErrorBoundary); solo se apunta para renovarlo cuando lo liberen.
        fallidos.add(renovar);
        throw e;
      })
    );
  const renovar = () => {
    actual = crear();
  };
  let actual = crear();

  function Diferido(props: ComponentProps<T>) {
    return createElement(actual as ComponentType<any>, props);
  }
  Diferido.displayName = `Diferido(${nombre})`;
  return Diferido;
}
