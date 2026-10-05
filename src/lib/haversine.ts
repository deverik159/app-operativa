// ============================================================
// src/lib/haversine.ts
// Helpers de geolocalización. Funciones puras (sin React).
// Traducido del HTML original: fijHaversine y fijNearestRoute.
//
// (rutas, 5-oct-2026) Ya no es código muerto: el armado de rutas lo usa
// para la vista previa de "Ordenar por cercanía" y el avance de visitas
// para decir a cuántos metros del sitio se marcó la visita. Las otras dos
// copias de la fórmula (kml.ts `metrosEntre`, helpers.ts `distKm`) se
// quedan donde están: son de otros módulos y funcionan igual.
// ============================================================

// Un punto en el mapa. En TypeScript declaramos la "forma" de los datos.
export type Punto = { lat: number; lng: number };

// Distancia en km entre dos puntos (fórmula de Haversine).
export function haversine(a: Punto, b: Punto): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Lo mismo en metros, redondeado (para textos como "a 35 m del sitio"). */
export function metros(a: Punto, b: Punto): number {
  return Math.round(haversine(a, b) * 1000);
}

// Ruta por vecino más próximo desde un punto de inicio.
// Recibe una lista de puntos y el punto de partida; devuelve la ruta ordenada
// y la distancia total.
export function nearestRoute<T extends Punto>(
  pts: T[],
  start: Punto
): { route: T[]; total: number } {
  const remaining = pts.slice();
  const route: T[] = [];
  let cur: Punto = start;
  let total = 0;
  while (remaining.length) {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(cur, remaining[i]);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    const next = remaining.splice(bestI, 1)[0];
    total += bestD;
    route.push(next);
    cur = next;
  }
  return { route, total };
}

/**
 * Orden por cercanía con la MISMA regla que la RPC
 * `ordenar_ruta_por_cercania` (rutas, 5-oct-2026): arranca en la parada más
 * al norte (estable: dos corridas dan el mismo orden, así la ruta del
 * monitorista no cambia sola) y de ahí siempre a la más cercana. Las que no
 * tienen coordenadas van al final, en el orden que traían.
 *
 * Recibe claves y una función que da la coordenada de cada una (o null).
 */
export function ordenarPorCercania(
  claves: string[],
  coordDe: (clave: string) => Punto | null
): string[] {
  const con: (Punto & { k: string })[] = [];
  const sin: string[] = [];
  for (const k of claves) {
    const p = coordDe(k);
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) con.push({ k, lat: p.lat, lng: p.lng });
    else sin.push(k);
  }
  if (con.length === 0) return claves.slice();
  // Desempate por clave para que el arranque no dependa del orden de entrada.
  const inicio = con
    .slice()
    .sort((a, b) => b.lat - a.lat || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))[0];
  const resto = con.filter((p) => p !== inicio);
  const { route } = nearestRoute(resto, inicio);
  return [inicio.k, ...route.map((p) => p.k), ...sin];
}
