// ============================================================
// src/components/Mapa.tsx
// Wrapper reutilizable de Leaflet.
//
// Encapsula el aprendizaje #6 del handoff: recrear el mapa si el contenedor
// cambió (bug del mapa en blanco al cambiar de filtro/loading) y llamar
// invalidateSize() dos veces (inmediato + diferido) para que tome bien el
// tamaño cuando el layout aún se está acomodando.
//
// Cada módulo solo aporta sus puntos; ya no repite el boilerplate del mapa.
// ============================================================
import { useEffect, useRef } from 'react';
import L from 'leaflet';

/** Punto a dibujar. `popupHtml` es HTML crudo (lo pinta Leaflet, no React). */
export type PuntoMapa = {
  lat: number;
  lng: number;
  color?: string;
  radio?: number;
  popupHtml?: string;
  onClick?: () => void;
};

/** Polígono opcional (ej. el convex hull de una ruta). */
export type PoligonoMapa = {
  puntos: [number, number][];
  color: string;
  opacidad?: number;
};

type MapaProps = {
  puntos: PuntoMapa[];
  poligonos?: PoligonoMapa[];
  /** Alto del contenedor. Puede ser number (px) o string CSS. */
  alto?: number | string;
  /** Centro inicial si no hay puntos. Default: CDMX. */
  centro?: [number, number];
  zoom?: number;
  className?: string;
  /** Si false, no reencuadra al cambiar los puntos (respeta el zoom del usuario). */
  autoAjustar?: boolean;
};

const COLOR_DEFAULT = '#ff5a3c';
const CENTRO_CDMX: [number, number] = [19.43, -99.13];
const TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

function Mapa({
  puntos,
  poligonos = [],
  alto = 420,
  centro = CENTRO_CDMX,
  zoom = 11,
  className = '',
  autoAjustar = true,
}: MapaProps) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const capaRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!divRef.current) return;

    // Aprendizaje #6: si React reemplazó el nodo (cambio de filtro / fin de
    // loading), el mapa viejo apunta a un div huérfano → sale en blanco.
    // Se destruye y se vuelve a crear sobre el contenedor actual.
    if (mapRef.current && mapRef.current.getContainer() !== divRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
      capaRef.current = null;
    }

    if (!mapRef.current) {
      mapRef.current = L.map(divRef.current, { zoomControl: true }).setView(
        centro,
        zoom
      );
      L.tileLayer(TILES, {
        attribution: '© OpenStreetMap © CARTO',
        maxZoom: 19,
      }).addTo(mapRef.current);
    }

    // Se redibuja la capa completa: más simple y barato que diffear marcadores.
    if (capaRef.current) mapRef.current.removeLayer(capaRef.current);
    const grupo = L.layerGroup();
    const coords: [number, number][] = [];

    poligonos.forEach((p) => {
      // Un polígono necesita al menos 3 vértices para tener área.
      if (p.puntos.length < 3) return;
      L.polygon(p.puntos, {
        color: p.color,
        weight: 2,
        fillColor: p.color,
        fillOpacity: p.opacidad ?? 0.15,
      }).addTo(grupo);
    });

    puntos.forEach((p) => {
      if (!isFinite(p.lat) || !isFinite(p.lng)) return;
      coords.push([p.lat, p.lng]);
      const m = L.circleMarker([p.lat, p.lng], {
        radius: p.radio ?? 7,
        color: '#151515',
        weight: 1,
        fillColor: p.color || COLOR_DEFAULT,
        fillOpacity: 0.95,
      });
      if (p.popupHtml) m.bindPopup(p.popupHtml);
      if (p.onClick) m.on('click', p.onClick);
      m.addTo(grupo);
    });

    grupo.addTo(mapRef.current);
    capaRef.current = grupo;

    const ajustar = () => {
      const mapa = mapRef.current;
      if (!mapa) return;
      // Sin esto el mapa cree que mide 0px si el contenedor acaba de aparecer.
      mapa.invalidateSize();
      if (!autoAjustar) return;
      if (coords.length === 1) mapa.setView(coords[0], 14);
      else if (coords.length > 1)
        mapa.fitBounds(coords, { padding: [40, 40], maxZoom: 15 });
    };
    ajustar();
    // Segunda pasada: el layout (sidebar, modales, media queries) puede
    // terminar de acomodarse después del primer paint.
    const t = setTimeout(ajustar, 250);
    return () => clearTimeout(t);
  }, [puntos, poligonos, autoAjustar]);

  // Destruye el mapa al desmontar, si no Leaflet deja listeners colgados.
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        capaRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={divRef}
      className={className}
      style={{
        height: typeof alto === 'number' ? `${alto}px` : alto,
        width: '100%',
        borderRadius: 14,
        overflow: 'hidden',
        border: '1px solid var(--line)',
      }}
    />
  );
}

export default Mapa;
