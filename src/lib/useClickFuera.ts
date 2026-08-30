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

/**
 * Acepta UN ref o VARIOS. Los varios existen por los portales: cuando el
 * panel se monta en document.body (ver la nota de CampanaNotifs), deja de
 * ser hijo del ref del botón en el DOM, y con un solo ref cada toque DENTRO
 * del panel contaría como "fuera" y lo cerraría. Con dos refs —el botón y el
 * panel— tocar cualquiera de los dos cuenta como adentro.
 */
export function useClickFuera(
  refs:
    | RefObject<HTMLElement | null>
    | Array<RefObject<HTMLElement | null>>,
  activo: boolean,
  cerrar: () => void
) {
  useEffect(() => {
    if (!activo) return;
    const lista = Array.isArray(refs) ? refs : [refs];

    const alTocar = (e: MouseEvent | TouchEvent) => {
      const dentro = lista.some(
        (r) => r.current && r.current.contains(e.target as Node)
      );
      if (!dentro) cerrar();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activo, cerrar]);
}
