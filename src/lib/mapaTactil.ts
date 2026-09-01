// ============================================================
// src/lib/mapaTactil.ts
// Candado de gestos para mapas Leaflet en pantalla táctil.
//
// EL PROBLEMA: en celular el mapa ocupa casi todo el ancho y cualquier dedo
// encima panea el mapa en vez de desplazar la página. En Fijación Externa el
// mapa queda al final, después de decenas de tarjetas: al llegar abajo el
// usuario se quedaba "pegado" en el mapa sin forma cómoda de volver a subir.
//
// LA SOLUCIÓN: en dispositivos táctiles el arrastre con UN dedo arranca
// apagado — un dedo desplaza la página, como en el resto de la app. El mapa
// sigue siendo usable: con DOS dedos se hace zoom y de paso se panea (es el
// gesto que la gente ya conoce de Google Maps embebido), y un botón 🔒/🔓
// junto al zoom activa el paneo de un dedo para quien va a trabajar el mapa
// en serio. Al apagar el arrastre, Leaflet quita su `touch-action: none` del
// contenedor y el navegador recupera el scroll — no hace falta más magia.
//
// En escritorio (puntero fino) no cambia nada: no hay conflicto con la rueda.
// ============================================================
import L from 'leaflet';

/** ¿Pantalla táctil como puntero principal? */
function esTactil(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

/**
 * Aplica el candado táctil a un mapa recién creado. En escritorio no hace
 * nada. Llamar UNA vez por instancia, justo después de L.map(...).
 */
export function candadoTactil(map: L.Map): void {
  if (!esTactil()) return;

  map.dragging.disable();

  const Candado = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const caja = L.DomUtil.create('div', 'leaflet-bar');
      const btn = L.DomUtil.create('a', '', caja) as HTMLAnchorElement;
      btn.href = '#';
      btn.setAttribute('role', 'button');
      // 40px y no los 26 que hereda de .leaflet-bar: este control solo
      // existe en táctil y es LA única vía para soltar el paneo con un
      // dedo — el elemento más dependiente del dedo no puede ser el más
      // chico de la app. Todo junto en cssText porque el font-size inline
      // le ganaría a cualquier hoja de estilos.
      btn.style.cssText =
        'width:40px;height:40px;line-height:40px;font-size:18px;text-align:center;';

      const pintar = () => {
        const libre = map.dragging.enabled();
        btn.textContent = libre ? '🔓' : '🔒';
        const titulo = libre
          ? 'Mapa suelto: un dedo lo mueve. Toca para soltarlo y poder desplazar la página.'
          : 'Mapa fijo: desliza la página con un dedo; usa dos dedos para moverte en el mapa, o toca para soltarlo.';
        btn.title = titulo;
        btn.setAttribute('aria-label', titulo);
      };
      pintar();

      L.DomEvent.on(btn, 'click', (e: Event) => {
        L.DomEvent.stop(e);
        if (map.dragging.enabled()) map.dragging.disable();
        else map.dragging.enable();
        pintar();
      });
      L.DomEvent.disableClickPropagation(caja);
      return caja;
    },
  });

  map.addControl(new Candado());
}
