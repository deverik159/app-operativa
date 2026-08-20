// ============================================================
// src/lib/haversine.ts
// Helpers de geolocalización. Funciones puras (sin React).
// Traducido del HTML original: fijHaversine y fijNearestRoute.
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
