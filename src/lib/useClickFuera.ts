// ============================================================
// src/lib/useClickFuera.ts
// Cierra un panel flotante al tocar fuera de él o al presionar Escape.
//
// Vive en un hook porque lo necesitan la campana y el menú de usuario, y
// porque el detalle que lo hace funcionar bien es fácil de equivocar:
//
//   Se escucha en 'mousedown'/'touchstart', NO en 'click'. Con 'click' el
//   navegador dispara primero el clic del botón que abre el panel y después
//   el del documento, así que el panel se abriría y se cerraría en el mismo
//   gesto — el botón nunca funcionaría.
//
//   Y por eso el ref debe envolver TAMBIÉN al botón que abre, no solo al
//   panel: si el botón queda fuera del ref, tocarlo para cerrar lo cierra
//   por este camino y el onClick lo vuelve a abrir.
// ============================================================
import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useClickFuera(
  ref: RefObject<HTMLElement | null>,
  activo: boolean,
  cerrar: () => void
) {
  useEffect(() => {
    if (!activo) return;

    const alTocar = (e: MouseEvent | TouchEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) cerrar();
    };
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cerrar();
    };

    document.addEventListener('mousedown', alTocar);
    document.addEventListener('touchstart', alTocar);
    document.addEventListener('keydown', alTeclear);
    return () => {
      document.removeEventListener('mousedown', alTocar);
      document.removeEventListener('touchstart', alTocar);
      document.removeEventListener('keydown', alTeclear);
    };
  }, [ref, activo, cerrar]);
}
