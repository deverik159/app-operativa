// ============================================================
// src/lib/useFocoModal.ts
// Foco y teclado de una ventana modal (revisión de accesibilidad, 23-oct-2026).
//
// Al abrir, enfoca el título (que debe llevar tabIndex={-1}) para que el
// lector de pantalla anuncie la ventana y el teclado entre en ella. Mientras
// está abierta, Tab y Shift+Tab dan la vuelta dentro de la ventana en vez de
// irse al contenido de atrás. Escape llama a `cerrar` (el mismo manejador del
// ✕ y de Cancelar, con sus confirmaciones). Al cerrar, regresa el foco al
// botón que la abrió, si sigue en la página.
//
// Se escucha en el propio nodo de la ventana, no en window: si una ventana
// abre otra encima, Escape lo recibe la de adentro y lo detiene ahí.
// ============================================================
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCABLES = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visible(el: HTMLElement) {
  return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
}

export function useFocoModal(
  modalRef: RefObject<HTMLElement | null>,
  tituloRef: RefObject<HTMLElement | null>,
  cerrar?: () => void
) {
  // Siempre la última versión de `cerrar`, sin volver a montar el efecto.
  const cerrarRef = useRef(cerrar);
  cerrarRef.current = cerrar;

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const antes = document.activeElement as HTMLElement | null;
    (tituloRef.current ?? modal).focus({ preventScroll: true });

    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!cerrarRef.current || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        cerrarRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const lista = Array.from(modal.querySelectorAll<HTMLElement>(FOCABLES)).filter(visible);
      if (lista.length === 0) {
        e.preventDefault();
        (tituloRef.current ?? modal).focus();
        return;
      }
      const primero = lista[0];
      const ultimo = lista[lista.length - 1];
      const activo = document.activeElement;
      const dentro = activo instanceof Node && modal.contains(activo);
      if (e.shiftKey && (!dentro || activo === primero || activo === tituloRef.current)) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && (!dentro || activo === ultimo)) {
        e.preventDefault();
        primero.focus();
      }
    };
    modal.addEventListener('keydown', alTeclear);
    return () => {
      modal.removeEventListener('keydown', alTeclear);
      if (antes && antes !== document.body && document.contains(antes)) antes.focus({ preventScroll: true });
    };
    // Solo al montar y desmontar la ventana.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
