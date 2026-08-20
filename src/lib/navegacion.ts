// ============================================================
// src/lib/navegacion.ts
// Enlaces de navegación hacia apps de mapas.
//
// A propósito NO se usa la API de Google (Directions/Routes): esas cobran y
// necesitan llave. Los "deep links" son gratis, no requieren registro y abren
// la app que el monitorista ya tiene instalada, con su tráfico y su voz.
//
// Límite real que condiciona el diseño: la URL de direcciones de Google
// acepta como MÁXIMO 9 puntos intermedios. Una ruta de 40 ubicaciones no cabe
// en un solo enlace: hay que partirla en tramos (ver `tramosGoogleMaps`).
// ============================================================

/** Un punto navegable. */
export type Destino = {
  lat: number;
  lng: number;
  /** Etiqueta para mostrar en la app, no afecta la navegación. */
  nombre?: string | null;
};

/** Waypoints intermedios que admite la URL de Google Maps. */
export const MAX_WAYPOINTS_GOOGLE = 9;

/** Paradas por tramo: los waypoints + el destino final. */
export const PARADAS_POR_TRAMO = MAX_WAYPOINTS_GOOGLE + 1;

const coord = (d: Destino) => `${d.lat},${d.lng}`;

/**
 * Google Maps hacia un destino. Es la opción más segura por defecto:
 * existe en Android, iOS y escritorio.
 */
export function urlGoogleMaps(
  destino: Destino,
  opciones?: { origen?: Destino; waypoints?: Destino[] }
): string {
  const p = new URLSearchParams({
    api: '1',
    destination: coord(destino),
    travelmode: 'driving',
  });
  // Sin origen, Google usa la ubicación actual del dispositivo, que es lo
  // que quiere el monitorista en campo.
  if (opciones?.origen) p.set('origin', coord(opciones.origen));
  if (opciones?.waypoints?.length) {
    p.set(
      'waypoints',
      opciones.waypoints.slice(0, MAX_WAYPOINTS_GOOGLE).map(coord).join('|')
    );
  }
  return `https://www.google.com/maps/dir/?api=1&${p.toString()}`;
}

/** Waze. Solo admite UN destino: no tiene paradas intermedias. */
export function urlWaze(destino: Destino): string {
  return `https://waze.com/ul?ll=${coord(destino)}&navigate=yes`;
}

/** Apple Maps. Útil en iPhone para quien no tiene Google Maps instalado. */
export function urlAppleMaps(destino: Destino): string {
  return `https://maps.apple.com/?daddr=${coord(destino)}&dirflg=d`;
}

/**
 * Parte una lista larga de paradas en tramos que sí caben en una URL.
 *
 * Cada tramo arranca donde terminó el anterior, para que no queden huecos:
 * la última parada de un tramo es el origen del siguiente.
 *
 * @param paradas en el orden en que se deben visitar
 * @param origen  punto de partida del primer tramo (ej. la posición GPS)
 */
export function tramosGoogleMaps(
  paradas: Destino[],
  origen?: Destino
): { url: string; desde: number; hasta: number; paradas: Destino[] }[] {
  const tramos: {
    url: string;
    desde: number;
    hasta: number;
    paradas: Destino[];
  }[] = [];
  if (paradas.length === 0) return tramos;

  let i = 0;
  let puntoPartida = origen;
  while (i < paradas.length) {
    const bloque = paradas.slice(i, i + PARADAS_POR_TRAMO);
    const destino = bloque[bloque.length - 1];
    const waypoints = bloque.slice(0, -1);
    tramos.push({
      url: urlGoogleMaps(destino, { origen: puntoPartida, waypoints }),
      desde: i + 1,
      hasta: i + bloque.length,
      paradas: bloque,
    });
    // El siguiente tramo continúa desde donde terminó este.
    puntoPartida = destino;
    i += bloque.length;
  }
  return tramos;
}

/** ¿Tiene coordenadas utilizables? Sin esto se navega al golfo de Guinea. */
export function esNavegable(d: {
  lat?: number | null;
  lng?: number | null;
}): boolean {
  return (
    d.lat != null &&
    d.lng != null &&
    isFinite(d.lat) &&
    isFinite(d.lng) &&
    !(d.lat === 0 && d.lng === 0)
  );
}
