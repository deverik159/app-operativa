// ============================================================
// src/lib/tema.ts
// Tema claro/oscuro (24-sep-2026).
//
// POR QUÉ: los operadores trabajan en exteriores con sol directo y el tema
// oscuro se lee mal al sol. Por omisión manda el teléfono (Automático =
// prefers-color-scheme) y en el menú del avatar se puede fijar Claro u
// Oscuro; la elección se guarda en el teléfono.
//
// CÓMO: el tema NO es estado de React. Vive en un atributo del <html>
// (data-tema="claro"|"oscuro"; en Automático no hay atributo y decide el
// @media de index.css) y en las variables CSS. Cambiarlo no re-renderiza la
// app: el navegador vuelve a pintar con las variables nuevas. Solo el
// selector (useTema) se entera del cambio, y solo él re-renderiza.
//
// El script en línea de index.html pone el atributo ANTES del primer
// pintado (sin parpadeo); esto repite lo mismo al arrancar y además corrige
// el theme-color y escucha los cambios del sistema en Automático.
// ============================================================
import { useSyncExternalStore } from 'react';

export type PrefTema = 'auto' | 'claro' | 'oscuro';
export type TemaEfectivo = 'claro' | 'oscuro';

/** La misma clave que lee el script en línea de index.html. */
const CLAVE = 'gpovallas_tema';

const CONSULTA_CLARO = '(prefers-color-scheme: light)';

/**
 * Color de la barra del sistema (theme-color) por tema. Hoy el naranja de
 * marca en los dos, como antes del tema claro: la barra de Android era
 * naranja y se conserva (el reloj y los íconos se leen sobre él). iOS
 * instalado no usa theme-color (ver index.html). Se deja por tema para poder
 * cambiarlo sin tocar el resto.
 */
const COLOR_BARRA: Record<TemaEfectivo, string> = {
  claro: '#ff5a3c',
  oscuro: '#ff5a3c',
};

function esPref(v: unknown): v is PrefTema {
  return v === 'auto' || v === 'claro' || v === 'oscuro';
}

/** Lo guardado en el teléfono; lo que no se entienda (o no se pueda leer) es Automático. */
export function leerPrefTema(): PrefTema {
  try {
    const v = localStorage.getItem(CLAVE);
    return esPref(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function guardarPrefTema(p: PrefTema): void {
  // En Automático se BORRA la clave en vez de guardar 'auto': así un
  // teléfono que nunca tocó el selector y uno que volvió a Automático
  // quedan igual, y el script en línea no tiene nada que hacer.
  try {
    if (p === 'auto') localStorage.removeItem(CLAVE);
    else localStorage.setItem(CLAVE, p);
  } catch {
    // Modo privado o almacenamiento bloqueado: el tema se aplica igual,
    // solo no sobrevive a cerrar la app.
  }
}

function sistemaEsClaro(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(CONSULTA_CLARO).matches;
  } catch {
    return false;
  }
}

/** El tema que se ve de verdad: en Automático, el del teléfono. */
export function temaEfectivo(pref: PrefTema): TemaEfectivo {
  if (pref !== 'auto') return pref;
  return sistemaEsClaro() ? 'claro' : 'oscuro';
}

// ---- Escucha del sistema (solo en Automático) --------------------------
// UN solo listener para toda la vida de la página: se pone al entrar a
// Automático y se quita al fijar Claro/Oscuro. `escuchando` evita
// duplicarlo si aplicarTema('auto') se llama varias veces.
let mql: MediaQueryList | null = null;
let escuchando = false;
/** La última preferencia aplicada al <html> (no necesariamente la guardada). */
let prefAplicada: PrefTema | null = null;

function alCambiarSistema(): void {
  if (prefAplicada === 'auto') aplicarTema('auto');
}

function escucharSistema(si: boolean): void {
  if (si === escuchando) return;
  try {
    if (!mql) {
      if (typeof window === 'undefined' || !window.matchMedia) return;
      mql = window.matchMedia(CONSULTA_CLARO);
    }
    // addListener/removeListener: Safari < 14 (iPhones viejos que siguen
    // en campo) no tiene addEventListener en MediaQueryList.
    if (si) {
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', alCambiarSistema);
      else mql.addListener(alCambiarSistema);
    } else {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', alCambiarSistema);
      else mql.removeListener(alCambiarSistema);
    }
    escuchando = si;
  } catch {
    // Sin matchMedia no hay nada que escuchar: el @media del CSS decide solo.
  }
}

/**
 * Pone el tema en el <html>: data-tema (en Automático se QUITA para que
 * mande el @media de index.css), color-scheme (controles nativos: fecha,
 * select, barras de scroll) y el theme-color de la barra del sistema.
 * No toca React ni el almacenamiento.
 */
export function aplicarTema(pref: PrefTema): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  const efectivo = temaEfectivo(pref);
  if (pref === 'auto') {
    html.removeAttribute('data-tema');
    // En Automático el color-scheme lo pone el CSS según el @media.
    html.style.removeProperty('color-scheme');
  } else {
    html.setAttribute('data-tema', pref);
    html.style.setProperty('color-scheme', efectivo === 'claro' ? 'light' : 'dark');
  }
  // Todo <meta name="theme-color"> lleva el color del tema efectivo.
  const color = COLOR_BARRA[efectivo];
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    if (m.content !== color) m.content = color;
  });
  prefAplicada = pref;
  escucharSistema(pref === 'auto');
}

// ---- Tienda mínima para el selector -------------------------------------
// No es estado global de React ni contexto: un valor de módulo y los
// componentes que lo leen con useSyncExternalStore (hoy solo el selector
// del menú del avatar). Nadie más re-renderiza al cambiar el tema.
let prefActual: PrefTema | null = null;
const oyentes = new Set<() => void>();
let iniciado = false;

function leerActual(): PrefTema {
  if (prefActual === null) prefActual = leerPrefTema();
  return prefActual;
}

function avisar(): void {
  oyentes.forEach((cb) => cb());
}

function suscribir(cb: () => void): () => void {
  oyentes.add(cb);
  return () => {
    oyentes.delete(cb);
  };
}

/** Guarda, aplica al instante y avisa al selector. */
export function fijarPrefTema(p: PrefTema): void {
  if (!esPref(p)) p = 'auto';
  guardarPrefTema(p);
  aplicarTema(p);
  if (p === prefActual) return;
  prefActual = p;
  avisar();
}

/**
 * Al arrancar (main.tsx, antes del render): aplica lo guardado —el script
 * de index.html ya puso el atributo; esto corrige el theme-color y enciende
 * la escucha del sistema— y sigue los cambios hechos en otra pestaña.
 * Idempotente.
 */
export function iniciarTema(): void {
  if (iniciado || typeof window === 'undefined') return;
  iniciado = true;
  aplicarTema(leerActual());
  try {
    window.addEventListener('storage', (e) => {
      // key null = alguien vació el almacenamiento completo.
      if (e.key !== CLAVE && e.key !== null) return;
      const p = leerPrefTema();
      // Se compara antes de avisar: el evento llega también cuando otra
      // pestaña guarda el mismo valor, y eso no debe re-renderizar nada.
      if (p === prefActual) return;
      prefActual = p;
      aplicarTema(p);
      avisar();
    });
  } catch {
    // Sin eventos de almacenamiento: cada pestaña se queda con el suyo.
  }
}

/**
 * Para el selector: [preferencia, fijar]. Solo re-renderiza el componente
 * que lo usa, y solo cuando la preferencia cambia (el valor es un string:
 * useSyncExternalStore no ve cambio si es el mismo).
 */
export function useTema(): [PrefTema, (p: PrefTema) => void] {
  const pref = useSyncExternalStore(suscribir, leerActual, leerActual);
  return [pref, fijarPrefTema];
}
