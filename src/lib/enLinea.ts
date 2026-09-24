// ============================================================
// src/lib/enLinea.ts
// ¿Hay señal? Hook para pintar el aviso "Sin señal" y clasificador de
// errores de red (modo sin señal, 24-sep-2026).
//
// navigator.onLine === false SÍ es confiable: el teléfono no tiene red.
// true NO lo es (portal cautivo, "señal fantasma" que conecta pero no
// transmite, algunos Android que mienten): por eso esto solo decide QUÉ
// AVISAR y cuándo NO intentar; quien consulta sigue poniendo topes y
// tratando los errores de red como "sin señal".
// ============================================================
import { useSyncExternalStore } from 'react';

/** true salvo que el navegador diga explícitamente que no hay red. */
export function enLineaAhora(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function suscribir(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

/**
 * Estado de la red para la UI: se actualiza solo con los eventos
 * online/offline. useSyncExternalStore y no useState+useEffect: así no hay
 * un primer render "con señal" antes de leer el valor real.
 */
export function useEnLinea(): boolean {
  return useSyncExternalStore(suscribir, enLineaAhora, () => true);
}

/**
 * Mensajes de fetch sin red en Chrome, Safari ("Load failed"), Firefox y
 * WebViews. Mismo patrón que RE_RED de envios.ts (que no se exporta).
 */
const RE_RED =
  /failed to fetch|load failed|networkerror|network request failed|network connection was lost|internet connection appears to be offline|timed? ?out|timeout|aborterror|operation was aborted|fetcherror|err_network|err_internet_disconnected/i;

/** HTTP que no son respuesta de la base: sin respuesta, gateway o tope. */
const STATUS_RED = new Set([0, 408, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * ¿El error es "no hubo red" y no una respuesta de verdad del servidor?
 * Sirve para errores de postgrest-js ({error, status}; status 0 = sin red),
 * de auth-js (AuthRetryableFetchError, status 0) y excepciones de fetch.
 */
export function pareceSinRed(error: unknown, status?: number | null): boolean {
  if (!error && status == null) return false;
  if (!enLineaAhora()) return true;
  if (typeof status === 'number' && STATUS_RED.has(status)) return true;
  const e = (typeof error === 'object' && error ? error : {}) as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
  };
  const nombre = typeof e.name === 'string' ? e.name : '';
  if (nombre === 'AuthRetryableFetchError' || /abort|timeout/i.test(nombre)) return true;
  if (typeof e.status === 'number' && e.status === 0) return true;
  const mensaje =
    typeof e.message === 'string' ? e.message : typeof error === 'string' ? error : '';
  return RE_RED.test(mensaje);
}
