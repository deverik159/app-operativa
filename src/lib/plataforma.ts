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

/**
 * Traduce el error de geolocalización a instrucciones ACCIONABLES.
 *
 * El caso que lo motivó (Brayan, 11-sep-2026): el GPS del teléfono estaba
 * encendido, pero el NAVEGADOR tenía la ubicación bloqueada para la app —
 * el error crudo decía "User denied Geolocation" y no había botón que la
 * reactivara: ese permiso solo se desbloquea en los ajustes del navegador,
 * y el mensaje tiene que decir exactamente dónde, según la plataforma.
 */
export function explicarErrorGps(err: GeolocationPositionError): string {
  // En origen inseguro (http://IP-de-red) el navegador niega SIEMPRE, con
  // el mismo código 1 del bloqueo real: hay que distinguirlo primero.
  if (!window.isSecureContext || /secure origin/i.test(err.message || '')) {
    return (
      'El GPS solo funciona en conexiones seguras (https:// o localhost).\n\n' +
      'Estás entrando por ' +
      window.location.protocol +
      '//' +
      window.location.host +
      '.\nAbre la app con https:// y vuelve a intentar.'
    );
  }
  if (err.code === 1) {
    return (
      'La ubicación está BLOQUEADA para esta app en el navegador, aunque ' +
      'el GPS del teléfono esté encendido. Para desbloquearla:\n\n' +
      (esIOS()
        ? '1. Ajustes del iPhone → Privacidad y seguridad → Localización → ' +
          'Safari (o "Sitios web de Safari") → "Preguntar" o "Al usarla".\n' +
          '2. Si usas la app instalada en pantalla de inicio y sigue igual, ' +
          'bórrala de la pantalla de inicio y vuelve a instalarla.'
        : '1. Abre la app en Chrome, toca el candado junto a la dirección → ' +
          'Permisos → Ubicación → Permitir.\n' +
          '2. Si es la app instalada: Ajustes del teléfono → Aplicaciones → ' +
          'Central de Operaciones → Permisos → Ubicación → Permitir.') +
      '\n\nDespués regresa aquí y vuelve a tocar el botón.'
    );
  }
  if (err.code === 2)
    return (
      'El teléfono no pudo fijar tu posición (sin señal de GPS). ' +
      'Intenta en un lugar más abierto.'
    );
  if (err.code === 3)
    return 'Se agotó el tiempo buscando tu posición. Vuelve a intentar.';
  return 'No se pudo obtener tu ubicación: ' + err.message;
}
