// ============================================================
// src/lib/armazon.ts
// "Armazón de app" en el celular: PRUEBA por teléfono (Erik, 6-oct-2026).
//
// Para el menú inferior que en iPhone (iOS 27, app instalada) quedaba a
// media pantalla sobre el mapa de Rutas (ver lib/diagPantalla.ts). Hoy el
// documento entero se desplaza y el menú (position:fixed) y la barra de
// arriba (sticky) dependen de que iOS lleve bien la cuenta de ese scroll;
// con cambios grandes de alto, iOS 26/27 a veces los coloca como si el
// scroll fuera otro. Con el armazón el documento NO se desplaza: mide justo
// la pantalla, la barra y el menú son piezas normales de una columna, y solo
// .main tiene scroll. Así no queda ningún scroll de la página que iOS pueda
// perder.
//
// Va APAGADO para todos. Se prende en un teléfono desde el diagnóstico
// escondido (5 toques al logo → botón "Armazón"), se guarda en ese
// teléfono y recarga la app. Si en el iPhone de Erik resuelve el error, el
// siguiente paso es dejarlo para todos (ver HANDOFF).
//
// El CSS está al final de index.css y solo aplica con html.armazon, en
// celular (≤780px) y cuando existe la barra de la app (no en el login).
// Nunca debe romper el arranque: todo va en try/catch.
// ============================================================

const CLAVE = 'gpo-armazon';

/** ¿Este teléfono pidió el armazón? */
export function armazonPedido(): boolean {
  try {
    return localStorage.getItem(CLAVE) === '1';
  } catch {
    return false;
  }
}

export function fijarArmazon(v: boolean): void {
  try {
    if (v) localStorage.setItem(CLAVE, '1');
    else localStorage.removeItem(CLAVE);
  } catch {
    /* sin almacenamiento no se puede probar */
  }
}

/** El contenedor con scroll del armazón. */
export function principal(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.layout > .main');
}

let celular: MediaQueryList | null = null;

/** ¿Está actuando ahora mismo? (el mismo filtro que el CSS; la clase solo
 *  se pone si el navegador entiende :has(), ver iniciarArmazon) */
export function armazonActivo(): boolean {
  try {
    if (!document.documentElement.classList.contains('armazon')) return false;
    celular ??= window.matchMedia('(max-width: 780px)');
    return celular.matches && !!document.querySelector('.topbar');
  } catch {
    return false;
  }
}

/** ¿Hay un campo de captura con el foco (teclado posiblemente abierto)? */
function campoConFoco(): boolean {
  const a = document.activeElement;
  return !!a && a.matches('input, textarea, select, [contenteditable="true"]');
}

let iniciado = false;

export function iniciarArmazon(): void {
  if (iniciado || !armazonPedido()) return;
  iniciado = true;
  try {
    // Todo el CSS depende de :has(). Sin él (iOS < 15.4) el CSS no actúa y
    // el JS, creyéndose activo, regresaría la página a 0 en cada scroll.
    if (typeof CSS === 'undefined' || !CSS.supports?.('selector(:has(*))')) return;
    document.documentElement.classList.add('armazon');

    // window.scrollTo → .main. Lo usan el cambio de módulo (App: "arranca
    // arriba") y el cambio de unidad en Rutas; con el armazón la ventana no
    // se desplaza y el que debe subir es .main. Fuera del armazón (escritorio, login,
    // horizontal) se usa el de siempre.
    const nativo = window.scrollTo.bind(window) as (...a: unknown[]) => void;
    window.scrollTo = function (...a: unknown[]) {
      if (armazonActivo()) {
        const m = principal();
        if (m) {
          (m.scrollTo as (...b: unknown[]) => void)(...a);
          nativo(0, 0);
          return;
        }
      }
      nativo(...a);
    } as typeof window.scrollTo;

    // Si iOS llega a desplazar la ventana (al mostrar un campo con el
    // teclado), se regresa a 0 cuando ya no hay campo con foco ni teclado.
    // Nunca mientras se escribe: ahí iOS acomoda el campo y no hay que
    // pelearle.
    const reponer = () => {
      if (!armazonActivo() || campoConFoco()) return;
      const vv = window.visualViewport;
      if (vv && vv.height < window.innerHeight - 1) return;
      if (window.scrollY !== 0 || document.body.scrollTop !== 0) {
        nativo(0, 0);
        document.body.scrollTop = 0;
      }
    };
    document.addEventListener('focusout', () => window.setTimeout(reponer, 350), true);
    window.visualViewport?.addEventListener('resize', () => window.setTimeout(reponer, 350));
    window.addEventListener('scroll', reponer, { passive: true });

    // Con el teclado abierto, lo último de .main queda detrás del teclado y
    // la página ya no se desplaza para alcanzarlo: --teclado agrega a .main
    // el relleno de abajo que tapa el teclado (CSS al final de index.css).
    let tecladoPx = -1;
    const medirTeclado = () => {
      let px = 0;
      const vv = window.visualViewport;
      const m = principal();
      if (armazonActivo() && campoConFoco() && vv && m && vv.height < window.innerHeight - 100) {
        px = Math.max(0, Math.round(m.getBoundingClientRect().bottom - (vv.offsetTop + vv.height)));
      }
      if (px === tecladoPx) return;
      tecladoPx = px;
      document.documentElement.style.setProperty('--teclado', px + 'px');
    };
    window.visualViewport?.addEventListener('resize', medirTeclado);
    document.addEventListener('focusin', () => window.setTimeout(medirTeclado, 350), true);
    document.addEventListener('focusout', () => window.setTimeout(medirTeclado, 350), true);

    // Tocar el fondo de la barra de arriba sube .main (reemplaza el "tocar
    // la barra de estado para subir" de iOS, que solo sube la página).
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof Element) || !armazonActivo()) return;
      if (!t.closest('.topbar') || t.closest('button, a, .logo, .who')) return;
      principal()?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  } catch {
    /* sin armazón, la app funciona igual que antes */
  }
}
