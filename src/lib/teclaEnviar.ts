// ============================================================
// src/lib/teclaEnviar.ts
// ¿Esta tecla envía el mensaje del chat? (Erik, 25-nov-2026)
//
// Teléfono: como WhatsApp (13-nov-2026): Intro salta de renglón y solo el
// botón redondo envía. Se queda igual.
// Computadora: como WhatsApp Web: Intro envía y Shift+Intro salta de
// renglón, sin tener que apretar Ctrl. Ctrl/⌘+Intro sigue enviando en los
// dos (quien ya se acostumbró no pierde nada).
//
// Mientras se compone texto con el teclado (acentos, IME) Intro nunca envía.
// ============================================================


export type TeclaChat = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
};

/** Los datos que importan de un evento de teclado de React. */
export function teclaDe(e: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  nativeEvent: { isComposing?: boolean };
}): TeclaChat {
  return {
    key: e.key,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    isComposing: !!e.nativeEvent.isComposing,
  };
}

/** ¿Envía (o guarda, en la edición) esta tecla? `computadora`: ver `esComputadora`. */
export function enviaConTecla(e: TeclaChat, computadora: boolean): boolean {
  if (e.key !== 'Enter' || e.isComposing) return false;
  if (e.ctrlKey || e.metaKey) return true;
  return computadora && !e.shiftKey && !e.altKey;
}

// Vive en plataforma.ts (también la usa el visor de fotos, 25-nov-2026).
export { esComputadora } from './plataforma';
