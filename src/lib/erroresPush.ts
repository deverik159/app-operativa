// ============================================================
// src/lib/erroresPush.ts
// Errores de pushManager.subscribe() en palabras para quien activa los
// avisos. Sin dependencias, para poder probarlo en node.
//
// POR QUÉ (23-nov-2026): un técnico cambió de celular y al tocar Activar le
// salió «No se pudo suscribir: Registration failed - push service error». Ese
// texto lo da Chrome cuando el servicio de avisos de Google (FCM) no responde
// en ese teléfono: pasa seguido en un celular recién configurado, sin
// Servicios de Google Play al día o con la red mala. Al volver a intentar un
// rato después, se activó solo. El mensaje en inglés no decía qué hacer.
// ============================================================

/**
 * Texto para el usuario cuando falla la suscripción del navegador.
 * @param ua navigator.userAgent: en Windows el error viene del servicio de
 *   avisos de Windows (WNS, en Edge) y no del de Google, y los pasos son otros.
 */
export function errorSuscripcionPush(e: unknown, ua = ''): string {
  const nombre = (e as { name?: unknown } | null)?.name;
  const msg = String((e as { message?: unknown } | null)?.message ?? e ?? '');

  // Antes que "registration failed": Chrome también dice
  // «Registration failed - permission denied».
  if (nombre === 'NotAllowedError' || /permission denied|not allowed/i.test(msg))
    return 'No se concedió el permiso de notificaciones. Puedes activarlo desde los ajustes del navegador.';

  const servicioNoRespondio =
    /push service error|registration failed|push service not available/i.test(msg) || nombre === 'AbortError';

  // Edge en Windows registra con WNS (23-nov-2026: a un usuario le fallaba en
  // su computadora mientras otros sí los activaban en Edge 157). Pasa con las
  // notificaciones de Windows apagadas, en ventana InPrivate, con el servicio
  // de notificaciones de inserción de Windows detenido o con la red bloqueando
  // *.notify.windows.com.
  if (servicioNoRespondio && /Windows NT/i.test(ua))
    return (
      'No se pudo activar: el servicio de avisos de Windows no respondió en esta computadora. ' +
      'Revisa que en Configuración de Windows › Sistema › Notificaciones estén activadas (también para el navegador) ' +
      'y que no estés en una ventana InPrivate o de incógnito, y vuelve a tocar Activar. ' +
      'Si sigue fallando, abre la app en Chrome en esta computadora y actívalos ahí.'
    );

  if (servicioNoRespondio)
    return (
      'No se pudo activar: el servicio de avisos de Google no respondió en este celular ' +
      '(pasa seguido en un celular recién configurado o con mala señal). ' +
      'Revisa que tenga internet y que Chrome y los Servicios de Google Play estén actualizados, ' +
      'espera unos minutos y vuelve a tocar Activar.'
    );

  if (nombre === 'InvalidStateError' || /different applicationServerKey/i.test(msg))
    return 'Este navegador tenía avisos de una versión anterior. Vuelve a tocar Activar para renovarlos.';

  return 'No se pudo suscribir: ' + (msg || 'error desconocido del navegador.');
}
