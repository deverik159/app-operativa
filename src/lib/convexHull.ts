// ============================================================
// src/lib/convexHull.ts
// Calcula la envolvente convexa (convex hull) de un conjunto de puntos:
// el polígono mínimo que envuelve todos los puntos (como estirar una liga).
// Se usa para dibujar el área sombreada de cada ruta en el mapa.
// Algoritmo: Andrew's monotone chain. O(n log n). Sin dependencias.
// ============================================================

export type Pt = { lat: number; lng: number };

// Producto cruz de OA x OB. >0 gira a la izquierda, <0 a la derecha.
function cross(o: Pt, a: Pt, b: Pt): number {
  return (
    (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng)
  );
}

// Devuelve los puntos del contorno (hull) en orden. Para 0/1/2 puntos,
// devuelve los mismos puntos (no forman área, el mapa los maneja aparte).
export function convexHull(points: Pt[]): Pt[] {
  const n = points.length;
  if (n < 3) return points.slice();

  // ordenar por lng, luego lat
  const pts = points
    .slice()
    .sort((a, b) => (a.lng === b.lng ? a.lat - b.lat : a.lng - b.lng));

  const lower: Pt[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  // quitar el último de cada mitad (se repite con el primero de la otra)
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
