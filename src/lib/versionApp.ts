// Detecta una publicación nueva sin interrumpir a quien está capturando datos.
// La recarga siempre la decide el usuario desde el aviso de App.
import { enLineaAhora } from './enLinea';

declare const __APP_BUILD_ID__: string;

export const BUILD_ID = __APP_BUILD_ID__;

type VersionRemota = { id?: unknown };

/**
 * Parámetro de la navegación de "Actualizar ahora": public/sw.js
 * (PARAM_ACTUALIZAR) la atiende con red SIN tope. Deben coincidir.
 */
const PARAM_ACTUALIZAR = 'actualizar';
/** Tope para que update() baje sw.js y diga si hay SW nuevo. */
const TOPE_UPDATE_MS = 20 * 1000;
/** Tope para ver si hay red de verdad (version.json, que el SW no toca). */
const TOPE_PRUEBA_RED_MS = 20 * 1000;
/** Cuánto se espera a que el SW nuevo termine de precargar y se active. */
const TOPE_SW_NUEVO_MS = 60 * 1000;

/** Resuelve `valor` si la promesa no termina a tiempo o falla (nunca rechaza). */
function conTope<T>(p: Promise<T>, ms: number, valor: T): Promise<T> {
  return new Promise<T>((res) => {
    const t = window.setTimeout(() => res(valor), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        res(v);
      },
      () => {
        window.clearTimeout(t);
        res(valor);
      }
    );
  });
}

/**
 * Espera a que el SW `w` quede activo (o a que uno nuevo tome la página).
 * false si falló su install (redundant) o se venció el tope.
 */
function esperarActivo(w: ServiceWorker, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolver) => {
    let reloj = 0;
    let listo = false;
    const fin = (ok: boolean) => {
      if (listo) return;
      listo = true;
      window.clearTimeout(reloj);
      w.removeEventListener('statechange', alCambiar);
      navigator.serviceWorker.removeEventListener('controllerchange', alTomar);
      resolver(ok);
    };
    function alCambiar() {
      if (w.state === 'activated') fin(true);
      else if (w.state === 'redundant') fin(false);
    }
    // Solo un SW más nuevo reclama la página (clients.claim en su activate).
    function alTomar() {
      fin(true);
    }
    reloj = window.setTimeout(() => fin(false), ms);
    w.addEventListener('statechange', alCambiar);
    navigator.serviceWorker.addEventListener('controllerchange', alTomar);
    alCambiar();
  });
}

/**
 * Quita ?actualizar= de la barra (lo puso traerVersionNueva): que una
 * recarga posterior no vuelva a esperar a la red sin tope. La sincronía
 * pestaña → URL de App también lo quita, pero no corre en "Falta darte
 * acceso" ni si fallaron los roles.
 */
function quitarMarcaActualizar(): void {
  try {
    const u = new URL(window.location.href);
    if (!u.searchParams.has(PARAM_ACTUALIZAR)) return;
    u.searchParams.delete(PARAM_ACTUALIZAR);
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
  } catch {
    /* sin History API: se queda en la URL, solo cuesta una espera a la red */
  }
}

export type ResultadoActualizar = 'recargando' | 'sinSenal' | 'cancelada';

/**
 * "Actualizar ahora" que SÍ trae la versión nueva (revisión sin señal,
 * 24-sep-2026). Antes era un location.reload(): con señal lenta (primer
 * byte de index.html > 4 s) el SW que controla la página servía SU
 * index.html guardado, o sea la versión vieja, y el aviso volvía a salir
 * mientras el SW nuevo no terminara de instalarse (minutos con EDGE).
 *
 *   1. Sin red → 'sinSenal' (no recarga: abriría la misma versión).
 *   2. Sin SW que controle la página → reload normal (va a la red).
 *   3. update() y, si hay un SW nuevo instalándose, se espera a que se
 *      active (tope de 60 s; `avisar('descargando')`). Activo, un reload
 *      normal ya abre la versión nueva (y sin red, su armazón).
 *   4. Si no se activó a tiempo o no se pudo revisar: navegación con
 *      ?actualizar=, que el SW actual atiende con red SIN tope (como antes
 *      de que hubiera SW con caché: lenta, pero trae la nueva).
 * `puedeRecargar` se vuelve a preguntar tras la espera: en ese minuto pudo
 * empezar un envío (confirmarRecargaConEnvios).
 */
export async function traerVersionNueva(
  avisar: (estado: 'descargando' | 'abriendo') => void,
  puedeRecargar: () => boolean
): Promise<ResultadoActualizar> {
  if (!enLineaAhora()) return 'sinSenal';
  const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
  if (!sw?.controller) {
    avisar('abriendo');
    window.location.reload();
    return 'recargando';
  }
  // version.json no pasa por el SW: si no llega, no hay señal que alcance
  // (navigator.onLine miente con "señal fantasma").
  const hayRed = conTope(
    fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' }).then((r) => r.ok),
    TOPE_PRUEBA_RED_MS,
    false
  );
  let reg: ServiceWorkerRegistration | undefined;
  /** update() contestó: el SW activo (o el que se instala) es el publicado. */
  let revisado = false;
  let nuevo: ServiceWorker | null = null;
  try {
    reg = await conTope(sw.getRegistration(), 5000, undefined);
    if (reg && !reg.installing && !reg.waiting)
      revisado = await conTope(
        reg.update().then(() => true),
        TOPE_UPDATE_MS,
        false
      );
    // El SW nuevo se toma en cuanto contesta update() y no tras la sonda:
    // si su install falla en ese rato ya no sale en reg.installing, y con
    // `revisado` se haría un reload normal que, con señal lenta, vuelve a
    // abrir la versión vieja. Tomado aquí, esperarActivo lo ve redundant y
    // se navega con ?actualizar= (verificación sin señal, 24-sep-2026).
    nuevo = reg?.installing || reg?.waiting || null;
  } catch {
    /* sin registro: se navega a la red */
  }
  if (!(await hayRed)) return 'sinSenal';

  // Uno que apareció después (update() venció su tope pero siguió).
  nuevo = nuevo || reg?.installing || reg?.waiting || null;
  let activo = false;
  if (nuevo) {
    avisar('descargando');
    activo = await esperarActivo(nuevo, TOPE_SW_NUEVO_MS);
    if (!puedeRecargar()) return 'cancelada';
  }
  avisar('abriendo');
  if (activo || (revisado && !nuevo)) {
    window.location.reload();
  } else {
    const u = new URL(window.location.href);
    u.searchParams.set(PARAM_ACTUALIZAR, Date.now().toString(36));
    window.location.replace(u.toString());
  }
  return 'recargando';
}

/**
 * Con versión nueva publicada, que el service worker nuevo se instale YA
 * (modo sin señal, 24-sep-2026). iOS no revisa si hay sw.js nuevo mientras
 * la PWA está suspendida: solo al navegar, al registrar o con update(). Así
 * el SW nuevo precarga el armazón en segundo plano mientras el usuario
 * decide tocar "Actualizar ahora"; si luego se queda sin señal, abre la
 * versión nueva completa y no la anterior. Nunca recarga nada: el SW no
 * escucha controllerchange para recargar (podría haber una captura a
 * medias). Sin red o sin SW, update() falla y no pasa nada.
 */
function pedirServiceWorkerNuevo(): void {
  try {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .getRegistration()
      .then((r) => r?.update())
      .catch(() => {
        /* se reintenta en la siguiente revisión */
      });
  } catch {
    /* navegador sin soporte: nada que actualizar */
  }
}

export function vigilarNuevaVersion(alEncontrar: () => void): () => void {
  quitarMarcaActualizar();
  if (!import.meta.env.PROD) return () => {};
  let detenida = false;

  const revisar = async () => {
    // Con la app oculta no se pregunta: al volver a primer plano `alVolver`
    // revisa de inmediato. Con 300 usuarios, el sondeo en segundo plano eran
    // miles de peticiones por jornada que nadie iba a ver (auditoría, 24-sep).
    if (document.visibilityState !== 'visible') return;
    try {
      const res = await fetch(`/version.json?_=${Date.now()}`, {
        cache: 'no-store',
      });
      if (!res.ok || detenida) return;
      const version = (await res.json()) as VersionRemota;
      if (typeof version.id === 'string' && version.id !== BUILD_ID) {
        alEncontrar();
        pedirServiceWorkerNuevo();
      }
    } catch {
      // Una pérdida de red no debe mostrar una falsa actualización.
    }
  };

  const alVolver = () => {
    if (document.visibilityState === 'visible') void revisar();
  };
  void revisar();
  document.addEventListener('visibilitychange', alVolver);
  const intervalo = window.setInterval(revisar, 15 * 60 * 1000);
  return () => {
    detenida = true;
    window.clearInterval(intervalo);
    document.removeEventListener('visibilitychange', alVolver);
  };
}
