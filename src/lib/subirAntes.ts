// ============================================================
// src/lib/subirAntes.ts
// "Subir antes de cambiar": para cambios grandes de alto de la página que
// provoca el usuario (cambiar de unidad, catorcena, estado o filtro).
//
// En el iPhone (iOS 27, app instalada), si la página estaba desplazada y su
// contenido cambiaba miles de px de alto de golpe (Rutas: Ecovallas, muchas
// rutas → Vía Verde, una), iOS perdía la cuenta del scroll: el menú inferior
// quedaba a media pantalla y la barra de arriba fuera de la vista. Lo
// corrigió subir primero la página y cambiar el contenido dos cuadros
// después, cuando iOS ya aplicó el scroll (Erik lo confirmó el 5-oct-2026;
// historia completa en lib/diagPantalla.ts). Es el mismo remedio de
// 84cfe3f al cambiar de módulo.
//
// Solo en iPhone/iPad, que es donde pasa: en Android y en computadora
// corre de inmediato y la página no se mueve.
//
// Uso: subirYLuego(() => setAlgo(v), 'clave'). Con la página arriba corre
// de inmediato; si no, sube y corre dos cuadros después. Con `clave`, si
// llega otro cambio de la misma clave antes, solo cuenta el más nuevo (si
// no, un toque viejo diferido pisaría a uno nuevo inmediato). Sin `clave`
// corren todos, en el orden en que se aplican: úsese solo con updaters que
// no dependan del orden (alternar una campaña).
//
// subirYRegresar(fn): igual, pero después regresa la página a donde
// estaba. Para filtros que se tocan varias veces seguidas desde abajo de la
// barra (campañas y tarjetas de Pauta): sin regresar, cada toque mandaba al
// usuario al principio y perdía su lugar.
// ============================================================

import { flushSync } from 'react-dom';
import { armazonActivo, principal } from './armazon';
import { esIOS } from './plataforma';

/** Lo desplazado: la ventana o, con el armazón, .main. */
function scrollActual(): number {
  if (armazonActivo()) return principal()?.scrollTop ?? 0;
  return window.scrollY;
}

/** ¿La página (o .main, con el armazón) está desplazada? */
export function paginaDesplazada(): boolean {
  return window.scrollY > 0 || scrollActual() > 0;
}

const dosCuadros = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

const fichas = new Map<string, number>();

export function subirYLuego(fn: () => void, clave?: string): void {
  let ficha = 0;
  if (clave) {
    ficha = (fichas.get(clave) ?? 0) + 1;
    fichas.set(clave, ficha);
  }
  const correr = () => {
    if (clave && fichas.get(clave) !== ficha) return;
    fn();
  };
  if (!esIOS() || !paginaDesplazada()) {
    correr();
    return;
  }
  window.scrollTo(0, 0); // con el armazón, sube .main (lib/armazon.ts)
  dosCuadros(correr);
}

export function subirYRegresar(fn: () => void): void {
  if (!esIOS() || !paginaDesplazada()) {
    fn();
    return;
  }
  const y = scrollActual();
  window.scrollTo(0, 0);
  dosCuadros(() => {
    // flushSync: el contenido nuevo queda dibujado AQUÍ. Si se regresara la
    // página antes, el cambio de alto pasaría con ella desplazada, que es
    // justo lo que se evita.
    flushSync(fn);
    // De vuelta a donde estaba (lo de arriba de los filtros no cambia de
    // alto, así que quedan en el mismo lugar).
    dosCuadros(() => window.scrollTo(0, y));
  });
}
