// ============================================================
// src/lib/atrasVentana.ts
// El botón Atrás con una ventana abierta (Erik, 12-nov-2026).
//
// Antes, con Reparar, el Chat o una revisión abiertos, Atrás cambiaba de
// pestaña (o cerraba la app) y se perdía lo capturado: solo «Nueva» estaba
// protegida (onPop de App.tsx). Ahora cada ventana de captura se registra
// aquí y Atrás la CIERRA con su propio cierre seguro —el mismo del ✕, que
// pregunta si hay algo sin guardar— en vez de cambiar de pestaña.
//
// Cómo:
//   · Al abrirse, la ventana apila una entrada del MISMO documento y la
//     misma URL, marcada con su id. Así, aunque la app se haya abierto
//     directo en esa pantalla (desde un push), Atrás no cierra la app.
//   · Atrás saca esa entrada; App.tsx llama a atrasEnVentana(): vuelve a
//     apilar la marca (la ventana sigue a la vista mientras decide) y llama
//     al cierre seguro. Si la ventana se cierra, su limpieza consume la
//     marca; si el usuario dice que no, la marca se queda para el siguiente
//     Atrás.
//   · Al cerrarse con sus botones, si la marca sigue arriba se consume con
//     history.back(), y ese popstate se ignora (como cerrarNueva).
// ============================================================
import { useEffect, useId, useRef } from 'react';

type Ventana = { id: string; cerrar: () => void };

/** Ventanas abiertas, la de arriba al final. */
const pila: Ventana[] = [];
/** popstate que causamos nosotros (history.back() al cerrar): se ignoran. */
let ignorar = 0;
/**
 * Ventana que se abrió mientras un back() propio seguía en camino (se cerró
 * una y se abrió otra enseguida): su marca se apila cuando llega ese
 * popstate; antes, el back() la habría dejado debajo de la marca vieja.
 */
let marcaPendiente: string | null = null;

const CLAVE = 'atrasVentana';

function marcaActual(): string | null {
  try {
    const s = window.history.state as Record<string, unknown> | null;
    return s && typeof s[CLAVE] === 'string' ? (s[CLAVE] as string) : null;
  } catch {
    return null;
  }
}

function apilarMarca(id: string, ruta?: string): void {
  try {
    window.history.pushState({ [CLAVE]: id }, '', ruta ?? window.location.pathname + window.location.search);
  } catch {
    /* sin historial (prueba o navegador raro): Atrás se queda como antes */
  }
}

/** Registra una ventana abierta; regresa la función que la suelta al cerrarse. */
export function registrarVentana(id: string, cerrar: () => void): () => void {
  pila.push({ id, cerrar });
  // Con StrictMode (desarrollo) se monta dos veces: si la marca ya está
  // arriba no se apila otra.
  if (ignorar > 0) marcaPendiente = id;
  else if (marcaActual() !== id) apilarMarca(id);
  return () => {
    const i = pila.findIndex((v) => v.id === id);
    if (i >= 0) pila.splice(i, 1);
    if (marcaPendiente === id) marcaPendiente = null;
    // Cerrada con sus botones: se consume la marca para que el siguiente
    // Atrás no caiga en la misma pantalla y parezca que no hizo nada.
    if (marcaActual() === id) {
      ignorar++;
      try {
        window.history.back();
      } catch {
        ignorar--;
      }
    }
  };
}

/**
 * Para el popstate de App.tsx. true = ya se atendió (no cambiar de pestaña).
 * `ruta` es la de la pestaña a la vista: si la entrada a la que se regresó
 * es de otra pestaña, la marca se vuelve a apilar con la ruta correcta.
 */
export function atrasEnVentana(ruta?: string): boolean {
  if (ignorar > 0) {
    ignorar--;
    if (ignorar === 0 && marcaPendiente) {
      const id = marcaPendiente;
      marcaPendiente = null;
      if (pila.some((v) => v.id === id) && marcaActual() !== id) apilarMarca(id);
    }
    return true;
  }
  const arriba = pila[pila.length - 1];
  if (!arriba) return false;
  // Si Atrás cayó en una entrada de OTRA pestaña (la marca no estaba arriba:
  // doble montaje de desarrollo, o la ventana se abrió antes de que la URL
  // se sincronizara), se repone primero la entrada de la pestaña a la vista.
  // Si no, al cerrar la ventana su back() dejaría la URL de la otra pestaña
  // con esta en pantalla.
  try {
    if (ruta && window.location.pathname !== ruta) window.history.pushState(null, '', ruta);
  } catch {
    /* sin historial */
  }
  apilarMarca(arriba.id, ruta);
  arriba.cerrar();
  return true;
}

/**
 * Una ventana de captura: mientras esté montada, Atrás llama a `cerrar` (su
 * cierre seguro) en vez de cambiar de pestaña.
 */
export function useAtrasCierra(cerrar: () => void): void {
  const id = useId();
  const ref = useRef(cerrar);
  ref.current = cerrar;
  useEffect(() => registrarVentana(id, () => ref.current()), [id]);
}

/** Solo para pruebas. */
export function _estado() {
  return { pila: pila.map((v) => v.id), ignorar, marcaPendiente };
}
