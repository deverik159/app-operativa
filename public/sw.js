// ============================================================
// public/sw.js — Service Worker
//
// Su única razón de existir es recibir notificaciones push cuando la app
// está CERRADA. El navegador lo mantiene disponible aunque no haya pestaña
// abierta; por eso las notificaciones llegan como las de una app nativa.
//
// Deliberadamente NO cachea nada. Un service worker con caché mal invalidada
// deja a los usuarios con una versión vieja de la app sin forma obvia de
// actualizar, y eso duele más de lo que ayuda. Si más adelante se quiere
// modo offline, se agrega aquí con una estrategia explícita de versionado.
// ============================================================

// Toma el control sin esperar a que se cierren las pestañas viejas: en una
// app interna conviene que la última versión mande de inmediato.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    // Si el payload no es JSON, al menos se muestra el texto crudo.
    d = { cuerpo: event.data ? event.data.text() : '' };
  }

  const titulo = d.titulo || 'GPO VALLAS';
  const opciones = {
    body: d.cuerpo || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    // tag: si llegan varias del mismo registro, se reemplazan en vez de
    // apilarse y saturar la bandeja del celular.
    tag: d.tag || undefined,
    renotify: !!d.tag,
    // Datos que necesita el clic para llevar al usuario al lugar correcto.
    data: { url: d.url || '/', record_id: d.record_id || null },
    // vibrate no lo soporta iOS, pero en Android ayuda a notarla en campo.
    vibrate: [80, 40, 80],
  };

  event.waitUntil(self.registration.showNotification(titulo, opciones));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destino = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const ventanas = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Si la app ya está abierta, se enfoca esa ventana en vez de abrir otra.
      for (const v of ventanas) {
        if ('focus' in v) {
          await v.focus();
          // Se le avisa a la app para que refresque la campana al instante.
          v.postMessage({ tipo: 'notificacion-abierta', url: destino });
          return;
        }
      }
      await self.clients.openWindow(destino);
    })()
  );
});
