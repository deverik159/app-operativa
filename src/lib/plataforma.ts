// ============================================================
// src/lib/plataforma.ts
// Detección de plataforma, en UN solo lugar.
//
// LA TRAMPA DEL iPAD: desde iPadOS 13, Safari se anuncia como "Macintosh"
// —Apple lo hizo para que los sitios sirvieran su versión de escritorio—
// así que el clásico /iPhone|iPad|iPod/ NO detecta iPads modernos. La seña
// que los delata es el táctil: una Mac reporta 0 puntos de toque, un iPad
// reporta 5. Sin esto, en iPad el botón de notificaciones desaparecía
// (en vez de explicar cómo instalar la app) y nunca se ofrecía Apple Maps.
// ============================================================

/** ¿iPhone, iPad o iPod? Incluye los iPad que se anuncian como Mac. */
export function esIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}
