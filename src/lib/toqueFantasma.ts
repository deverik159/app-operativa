// ============================================================
// src/lib/toqueFantasma.ts
// Ventanas que se abrían y se cerraban solas en el iPhone (Erik, 6-oct-2026).
//
// En iOS, el toque que ABRE una ventana puede llegar otra vez como un clic
// sobre lo que quede en ese mismo punto una vez abierta. Con las ventanas
// centradas (rediseño "Precisión"), en ese punto suele haber un botón de la
// ventana —el ✕, "Cerrar" o, en el detalle de Biobox, "Historial" y
// "Revisar"— y la ventana se cerraba sola al abrirse.
//
// Remedio: durante los primeros MS de una ventana (.overlay) o de un panel
// flotante (.panel-flotante, .hoja-mas), un clic DENTRO de ella se ignora.
// Nadie toca a propósito un botón medio segundo después de que aparece.
//
// Cómo se entera de que algo se abrió: esas piezas arrancan con una
// animación muda (estilo/precision.css, @keyframes tf-aparece) y aquí se
// escucha su `animationstart`. Así sirve para todas las ventanas sin tocar
// cada componente, y no depende de un MutationObserver sobre todo el DOM.
// Nunca debe romper el arranque: todo va en try/catch.
// ============================================================

const MS = 450;
const SELECTOR = '.overlay, .panel-flotante, .hoja-mas';
const ANIMACION = 'tf-aparece';

let instalado = false;

export function instalarToqueFantasma(): void {
  if (instalado) return;
  instalado = true;
  try {
    const abiertoEn = new WeakMap<Element, number>();

    document.addEventListener(
      'animationstart',
      (e) => {
        if (e.animationName !== ANIMACION) return;
        if (e.target instanceof Element) abiertoEn.set(e.target, performance.now());
      },
      true,
    );

    document.addEventListener(
      'click',
      (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const pieza = t.closest(SELECTOR);
        if (!pieza) return;
        const desde = abiertoEn.get(pieza);
        if (desde === undefined || performance.now() - desde > MS) return;
        // Recién abierta: es el mismo toque que la abrió. No llega a React.
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
  } catch {
    /* sin esto la app funciona igual que antes */
  }
}
