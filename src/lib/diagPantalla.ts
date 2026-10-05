// ============================================================
// src/lib/diagPantalla.ts
// Diagnóstico de pantalla, escondido (Erik, 6-oct-2026).
//
// EL ERROR: en el iPhone (iOS 27, app instalada), al elegir la unidad en
// Rutas el menú inferior quedaba a media pantalla encima del mapa y la barra
// de arriba desaparecía. Es un error de iOS 26/27 (WebKit 297779; foros de
// Apple 800154 y 800125, reportado de nuevo en iOS 27; Apple lo pasó a un
// componente del sistema): al cerrarse el teclado o el menú de un <select>,
// iOS a veces no regresa el área visible a su lugar y todo lo fijo
// (position:fixed) y lo pegado arriba (sticky) queda corrido. Se dispara con
// la "sesión de captura" del campo más un cambio grande de alto de la página
// justo al cerrarse (en Rutas: llegan las rutas y el mapa).
//
// HISTORIA (para no repetirla):
// - 1652b24: mover la página 1 px y regresarla (lib/ajusteIOS.ts, ya
//   borrado). NO sirve: WebKit junta las dos llamadas y no hay movimiento;
//   aunque lo hubiera, no corrige el desfase del área visible.
// - b494e1a: no desmontar el <select> al recargar. Mejora, pero no la causa.
// - Tercer intento: en Rutas, unidad y medio son botones, que no abren esa
//   sesión. Se descartó soltar el foco de TODOS los <select> al elegir: si
//   iOS manda el cambio con la rueda aún girando, cerraría la rueda en una
//   opción intermedia (en Pauta, "Asignar a…" asignaría a otra persona).
//
// ESTE DIAGNÓSTICO: Chrome no reproduce el error, así que la única forma de
// ver qué hace iOS es medirlo EN el teléfono. 5 toques seguidos al logo de la
// barra de arriba muestran un recuadro con medidas; otros 5 lo quitan. Se
// recuerda en ese teléfono 24 h y luego se apaga solo. Hay que prenderlo
// ANTES de reproducir el error: con el error, la barra (y el logo) no se ven.
//
// Cómo leerlo con el error en pantalla:
// - "desfase" > 0 sin teclado → el área visible quedó corrida dentro de la
//   ventana (offsetTop pegado, WebKit 297779 / Apple 800154).
// - "ventana" menor que "pantalla" (app instalada) o "hueco" > 0 → la
//   ventana o el área visible se quedaron encogidas (Apple 800125).
// - "fijos" ≠ "ventana" → iOS coloca lo fijo con otra ventana que la del
//   documento.
// - "abajo toca" dice qué recibe un toque cerca del borde de abajo: si dice
//   "menú" mientras el menú se ve a media pantalla, el error es solo de
//   pintado; si dice otra cosa, el layout también está corrido.
// - La bitácora (últimos eventos, con segundos) dice en qué orden pasó.
//
// Los colores van fijos y no con variables del tema a propósito: es una
// herramienta interna y debe leerse igual en claro y oscuro.
//
// No es estado de React ni toca nada de la app: solo lee medidas mientras
// está prendido. Nunca debe romper el arranque: todo va en try/catch.
// ============================================================

import { BUILD_ID } from './versionApp';

const CLAVE = 'gpo-diag-pantalla';
const DURA_MS = 24 * 60 * 60 * 1000;
const TOQUES = 5;
const VENTANA_TOQUES_MS = 3000;
const CADA_MS = 300;
const RENGLONES_BITACORA = 7;

let caja: HTMLDivElement | null = null;
let sonda: HTMLDivElement | null = null;
let reloj = 0;
let inicio = 0;
let bitacora: string[] = [];
let ultimaFirma = '';

function prendido(): boolean {
  try {
    const v = Number(localStorage.getItem(CLAVE));
    return isFinite(v) && v > 0 && Date.now() - v < DURA_MS;
  } catch {
    return false;
  }
}

function recordar(v: boolean): void {
  try {
    if (v) localStorage.setItem(CLAVE, String(Date.now()));
    else localStorage.removeItem(CLAVE);
  } catch {
    /* sin almacenamiento: dura hasta cerrar la app */
  }
}

const n = (x: number | undefined | null) =>
  x == null || !isFinite(x) ? '–' : String(Math.round(x));

/** Nombre corto de un elemento: "menú", "barra", "mapa" o etiqueta.clase. */
function nombre(el: EventTarget | null): string {
  if (!(el instanceof Element)) return '–';
  if (el.closest('.side')) return 'menú';
  if (el.closest('.topbar')) return 'barra';
  if (el.closest('.rutas-map, .leaflet-container')) return 'mapa';
  const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
  return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
}

/** Valores clave en una línea corta, para la bitácora. */
function firma(): string {
  const vv = window.visualViewport;
  return vv
    ? `v${n(vv.height)} d${n(vv.offsetTop)} w${n(window.innerHeight)} s${n(window.scrollY)}`
    : `w${n(window.innerHeight)} s${n(window.scrollY)}`;
}

function anotar(evento: string): void {
  if (!caja) return;
  const f = firma();
  // Los eventos de scroll se repiten mucho: solo cuentan si algo cambió.
  if (evento.startsWith('scroll') && f === ultimaFirma) return;
  ultimaFirma = f;
  const t = ((performance.now() - inicio) / 1000).toFixed(1);
  bitacora.push(`${t}s ${evento} ${f}`);
  if (bitacora.length > RENGLONES_BITACORA) bitacora = bitacora.slice(-RENGLONES_BITACORA);
  pintar();
}

function medidas(): string {
  const vv = window.visualViewport;
  const menu = document.querySelector('.side')?.getBoundingClientRect();
  const barra = document.querySelector('.topbar')?.getBoundingClientRect();
  const foco = document.activeElement;
  const iH = window.innerHeight;
  let instalada = false;
  try {
    instalada =
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    /* sin dato */
  }
  const abajo = document.elementFromPoint(window.innerWidth / 2, iH - 30);
  return [
    `ventana ${n(iH)} · pantalla ${n(window.screen?.height)} · fijos ${n(sonda?.offsetHeight)} · doc ${n(document.documentElement.clientHeight)}`,
    vv
      ? `visible ${n(vv.height)} · desfase ${n(vv.offsetTop)} · hueco ${n(iH - vv.height - vv.offsetTop)} · zoom ${vv.scale.toFixed(2)}`
      : 'visible: sin dato',
    `scroll ${n(window.scrollY)} de ${n(document.documentElement.scrollHeight)} · pageTop ${n(vv?.pageTop)}`,
    `menú ${n(menu?.top)}–${n(menu?.bottom)} · barra ${n(barra?.top)} · abajo toca: ${nombre(abajo)}`,
    `foco ${nombre(foco)} · ${instalada ? 'app instalada' : 'navegador'} · ${String(BUILD_ID).slice(0, 7)}`,
    ...bitacora,
    '5 toques al logo para quitar',
  ].join('\n');
}

function pintar(): void {
  if (!caja) return;
  try {
    caja.textContent = medidas();
  } catch {
    /* una medida que falla no debe tumbar nada */
  }
}

function mostrar(): void {
  if (caja) return;
  inicio = performance.now();
  bitacora = [];
  ultimaFirma = '';
  // Sonda invisible: un fijo de arriba a abajo mide la ventana con la que
  // iOS coloca lo fijo (puede no ser la del documento).
  sonda = document.createElement('div');
  sonda.setAttribute('aria-hidden', 'true');
  Object.assign(sonda.style, {
    position: 'fixed',
    top: '0',
    bottom: '0',
    left: '0',
    width: '1px',
    visibility: 'hidden',
    pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);
  caja = document.createElement('div');
  caja.setAttribute('aria-hidden', 'true');
  Object.assign(caja.style, {
    position: 'fixed',
    left: '8px',
    right: '8px',
    bottom: 'calc(env(safe-area-inset-bottom) + 96px)',
    zIndex: '1200',
    background: 'rgba(0,0,0,.85)',
    color: '#fff',
    font: '10.5px/1.35 ui-monospace, Menlo, monospace',
    whiteSpace: 'pre-wrap',
    padding: '6px 8px',
    borderRadius: '8px',
    pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(sonda);
  document.body.appendChild(caja);
  anotar('inicio');
  reloj = window.setInterval(pintar, CADA_MS);
}

function ocultar(): void {
  window.clearInterval(reloj);
  caja?.remove();
  sonda?.remove();
  caja = null;
  sonda = null;
}

let instalado = false;

export function instalarDiagPantalla(): void {
  if (instalado) return;
  instalado = true;
  try {
    let toques: number[] = [];
    // pointerup y no click: en iPhone un div sin manejador propio no
    // siempre recibe click delegado.
    document.addEventListener(
      'pointerup',
      (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        // Bitácora: los botones de unidad/medio de Rutas son el disparador.
        const chip = t.closest('.rt-segmento .rt-chip');
        if (chip) anotar('toque ' + (chip.textContent || '').replace('✓', '').trim());
        if (!t.closest('.topbar .logo')) return;
        const ahora = Date.now();
        toques = toques.filter((x) => ahora - x < VENTANA_TOQUES_MS);
        toques.push(ahora);
        if (toques.length < TOQUES) return;
        toques = [];
        if (caja) {
          ocultar();
          recordar(false);
        } else {
          mostrar();
          recordar(true);
        }
      },
      true
    );
    document.addEventListener('focusin', (e) => anotar('foco→' + nombre(e.target)), true);
    document.addEventListener('focusout', (e) => anotar('suelta ' + nombre(e.target)), true);
    document.addEventListener(
      'change',
      (e) => {
        if (e.target instanceof HTMLSelectElement) anotar('elige select');
      },
      true
    );
    window.addEventListener('resize', () => anotar('resize ventana'));
    window.addEventListener('scroll', () => anotar('scroll'), { passive: true });
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', () => anotar('resize visible'));
      vv.addEventListener('scroll', () => anotar('scroll visible'));
    }
    if (prendido()) {
      if (document.body) mostrar();
      else document.addEventListener('DOMContentLoaded', mostrar, { once: true });
    } else {
      recordar(false);
    }
  } catch {
    /* sin diagnóstico, la app funciona igual */
  }
}
