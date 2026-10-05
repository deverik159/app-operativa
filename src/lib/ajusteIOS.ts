// ============================================================
// src/lib/ajusteIOS.ts
// El menú inferior que se queda "flotando" en iPhone (Erik, 6-oct-2026).
//
// QUÉ PASA: en iPhone, al elegir en un <select> sale la rueda de selección
// (o el teclado en un campo de texto) y iOS achica la pantalla visible; el
// menú inferior —position:fixed; bottom:0— sube para quedar encima de la
// rueda. Al cerrarse, iOS a veces NO lo regresa a su lugar hasta que la
// página se desplaza: el menú queda a media pantalla, encima del contenido.
// En Rutas se veía siempre: al cambiar la unidad, la página carga el mapa y
// cambia de alto justo mientras la rueda se cierra (captura de Erik: el
// menú a media pantalla y el mapa asomando por debajo). Chrome y Android no
// tienen este error; por eso no aparecía en las pruebas de escritorio.
//
// LA CORRECCIÓN CONOCIDA: al cerrarse la rueda o el teclado, mover la página
// un píxel y regresarla en el MISMO instante. Eso obliga a iOS a volver a
// colocar todo lo fijo; a la vista no se mueve nada. Se hace dos veces:
// cuando termina de cerrarse (~0.3 s de animación) y otra después, por si la
// página todavía cambió de alto al cargar datos (el caso de Rutas).
//
// Solo en iPhone/iPad; en lo demás no se instala. Nunca debe romper el
// arranque: todo va en try/catch.
// ============================================================

/** ¿iPhone / iPad (incluido el iPad que se presenta como Mac)? */
function esIOS(): boolean {
  try {
    const ua = navigator.userAgent || '';
    return (
      /iP(hone|ad|od)/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  } catch {
    return false;
  }
}

/** Obliga a iOS a recolocar lo fijo sin mover nada a la vista. */
function reacomodar(): void {
  const x = window.scrollX;
  const y = window.scrollY;
  window.scrollTo(x, y + 1);
  window.scrollTo(x, y);
}

let instalado = false;

export function instalarAjusteIOS(): void {
  if (instalado || !esIOS()) return;
  instalado = true;
  try {
    let pendiente = 0;
    let segundo = 0;
    const programar = () => {
      window.clearTimeout(pendiente);
      window.clearTimeout(segundo);
      pendiente = window.setTimeout(() => {
        reacomodar();
        segundo = window.setTimeout(reacomodar, 450);
      }, 150);
    };

    const esCampo = (t: EventTarget | null) =>
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLInputElement &&
        !['checkbox', 'radio', 'button', 'submit', 'file', 'range', 'color'].includes(t.type));

    // Se cierra la rueda o el teclado al salir del campo; en un <select>
    // además al elegir (el `change` llega aunque el foco siga ahí).
    document.addEventListener('focusout', (e) => {
      if (esCampo(e.target)) programar();
    }, true);
    document.addEventListener('change', (e) => {
      if (e.target instanceof HTMLSelectElement) programar();
    }, true);

    // Respaldo: la pantalla visible vuelve a crecer (se fue la rueda o el
    // teclado) aunque no haya llegado ningún evento del campo.
    const vv = window.visualViewport;
    if (vv) {
      let alto = vv.height;
      vv.addEventListener('resize', () => {
        if (vv.height > alto + 40) programar();
        alto = vv.height;
      });
    }
  } catch {
    /* sin el ajuste, la app funciona igual que antes */
  }
}
