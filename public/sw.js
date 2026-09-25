// ============================================================
// public/sw.js — Service Worker
//
// Dos trabajos:
//   1. Recibir notificaciones push cuando la app está CERRADA (push y
//      notificationclick, abajo; sin cambios). El navegador lo mantiene
//      disponible aunque no haya pestaña abierta.
//   2. Guardar el ARMAZÓN de la app (index.html, el JS y CSS de entrada, los
//      módulos y los íconos) para que abra SIN SEÑAL (modo sin señal,
//      24-sep-2026). Antes no guardaba nada a propósito, y si iOS cerraba la
//      PWA y se abría sin red salía la página de error de Safari: la cola de
//      reportes seguía en el teléfono pero no había forma de llegar a ella.
//
// POR QUÉ NO SE QUEDA PEGADA UNA VERSIÓN VIEJA (el miedo de siempre con un
// SW que cachea):
//   · Con red, la navegación SIEMPRE trae el index.html vigente de Vercel
//     (red primero, con tope de ~4 s); la respuesta de red no se guarda.
//     Solo sin red (o si no contesta a tiempo) se sirve el index.html
//     guardado, que es el del build de ESTE SW: completo y consistente con
//     sus /assets.
//   · El build (vite.config.ts, plugin version-publica) escribe en la copia
//     publicada de este archivo la lista de precarga con una versión que es
//     hash de los archivos del build. Cada despliegue cambia el contenido de
//     sw.js y el navegador instala el SW nuevo; versionApp.ts además le pide
//     update() en cuanto ve una versión nueva publicada.
//   · "Actualizar ahora" espera (con tope) a que el SW nuevo se active y, si
//     no alcanza, navega con ?actualizar=…, que va a la red SIN tope: con
//     señal lenta ya no recarga la versión vieja (PARAM_ACTUALIZAR).
//   · activate conserva solo la caché actual y la anterior (una pestaña que
//     sigue con el build anterior aún encuentra sus chunks) y borra el resto.
//   · /version.json nunca se cachea: el aviso "Hay una versión nueva" y la
//     prueba de servidor de cargaDiferida siguen viendo la red real.
//
// INTERRUPTOR: en desarrollo (vite serve) este archivo se sirve tal cual,
// con la lista en null, y entonces el SW se comporta como antes (solo push)
// y además borra sus cachés. Para APAGAR el modo sin señal a todos en
// producción: definir SW_SIN_CACHE=1 en las variables de Vercel y
// redesplegar (vite.config.ts publica este archivo con null; revisión sin
// señal, 24-sep-2026). Editar la línea de abajo NO sirve: el build la
// reemplaza igual, o falla si ya no la encuentra. Comprobar en el log del
// build el aviso "SW_SIN_CACHE=1", o con `grep "^self.__PRECACHE__"` sobre
// dist/sw.js (o el /sw.js publicado): esa línea debe decir null y no traer
// la lista. El "^" va a propósito: sin él el grep cuenta también los
// comentarios que la mencionan. Cada teléfono lo toma al abrir la app o
// al ver "Hay una versión nueva". Para volver a encenderlo: quitar la
// variable y redesplegar.
//
// Qué NO se toca: nada que no sea GET, nada de otro origen (Supabase — los
// datos van a IndexedDB con su propia sincronización —, mosaicos de OSM,
// Google), /version.json, /sw.js, peticiones con Range.
// ============================================================

// El build reemplaza la línea siguiente por {build, version, entrada,
// nucleo, diferidos}; debe quedar exactamente una vez en este archivo.
self.__PRECACHE__ = null;

const PRECARGA = self.__PRECACHE__;
const PREFIJO_CACHE = 'gpo-shell-';
const CACHE_ACTUAL = PRECARGA ? PREFIJO_CACHE + PRECARGA.version : null;
/**
 * Marca que se guarda al terminar el núcleo: una caché sin ella quedó a
 * medias (iOS mató el install) y no cuenta como "la anterior" ni como
 * respaldo de index.html.
 */
const MARCA_COMPLETA = '/__gpo_armazon_completo__';
/** Tope de la navegación con red antes de servir el armazón guardado. */
const TOPE_NAVEGACION_MS = 4000;
/**
 * Parámetro de "Actualizar ahora" (src/lib/versionApp.ts, PARAM_ACTUALIZAR;
 * deben coincidir). Una navegación que lo trae espera a la red SIN tope
 * (revisión sin señal, 24-sep-2026): con señal lenta, el tope de 4 s volvía
 * a servir el index.html guardado de ESTE SW y el botón recargaba la misma
 * versión vieja mientras el SW nuevo no terminara de instalarse.
 */
const PARAM_ACTUALIZAR = 'actualizar';
/** Archivos sueltos de public/ que se sirven caché primero. */
const ESTATICOS = new Set([
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/badge-96.png',
  '/manifest.webmanifest',
]);

/** Promesa con tope. AbortSignal.timeout no existe en iOS < 16. */
function conTope(promesa, ms) {
  let reloj;
  const vencida = new Promise((_, rechazar) => {
    reloj = setTimeout(() => rechazar(new Error('tope')), ms);
  });
  return Promise.race([promesa, vencida]).finally(() => clearTimeout(reloj));
}

/**
 * Respuesta apta para guardarse: 200-299, mismo origen ('basic'). Una
 * redirigida se reconstruye: WebKit se niega a servir en una navegación una
 * respuesta con redirected = true.
 */
async function sanear(res) {
  if (!res || !res.ok || res.type !== 'basic') return null;
  if (!res.redirected) return res;
  return new Response(await res.blob(), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** Nombres de nuestras cachés, de la más nueva a la más vieja. */
async function cachesArmazon() {
  const nombres = (await caches.keys()).filter((n) => n.startsWith(PREFIJO_CACHE));
  return nombres.reverse();
}

/** ¿Esa caché terminó su núcleo? */
async function estaCompleta(nombre) {
  return !!(await caches.match(MARCA_COMPLETA, { cacheName: nombre }));
}

/**
 * Tope de una búsqueda en las cachés (app pasmada sin señal, 24-sep-2026):
 * caches.keys/match no tienen tope propio, y si el navegador no contesta, el
 * chunk o la navegación se quedaban esperando para siempre. Al vencer cuenta
 * como "no está" y se sigue por la red. La del index.html de una navegación
 * (soloCompletas) lleva más margen: ahí ya falló la red, y sin la copia no
 * hay app que servir; mejor esperar a una caché lenta en frío que dar error.
 */
const TOPE_CACHE_MS = 3000;
const TOPE_CACHE_NAVEGACION_MS = 8000;
/** Tope para que la red empiece a contestar un /assets/* que no está guardado. */
const TOPE_RED_ARCHIVO_MS = 8000;

/**
 * Busca en la caché actual y luego en las demás (más nueva primero). Con
 * `cacheName` y no caches.open: open CREA una caché vacía si no existe.
 * ignoreVary: la petición de un módulo (crossorigin) no lleva las mismas
 * cabeceras que la de la precarga. Con tope (ver TOPE_CACHE_MS); un error de
 * la caché también cuenta como "no está".
 */
async function buscarGuardado(peticion, soloCompletas) {
  try {
    return await conTope(
      buscarEnCaches(peticion, soloCompletas),
      soloCompletas ? TOPE_CACHE_NAVEGACION_MS : TOPE_CACHE_MS
    );
  } catch {
    return null;
  }
}

async function buscarEnCaches(peticion, soloCompletas) {
  const nombres = await cachesArmazon();
  if (CACHE_ACTUAL && nombres.includes(CACHE_ACTUAL)) {
    nombres.splice(nombres.indexOf(CACHE_ACTUAL), 1);
    nombres.unshift(CACHE_ACTUAL);
  }
  for (const nombre of nombres) {
    if (soloCompletas && !(await estaCompleta(nombre))) continue;
    const r = await caches.match(peticion, { cacheName: nombre, ignoreVary: true });
    if (r) return r;
  }
  return null;
}

/**
 * Precarga un archivo en `cache`. Un /assets/* es inmutable (nombre con
 * hash): si ya está en alguna caché se copia sin tocar la red. Lanza si no
 * se pudo (el núcleo lo exige; los diferidos van con allSettled).
 */
async function precargar(cache, ruta) {
  const inmutable = ruta.startsWith('/assets/');
  if (inmutable) {
    const ya = await buscarGuardado(ruta, false);
    if (ya) {
      await cache.put(ruta, ya);
      return;
    }
  }
  // Un /assets/* puede salir de la caché HTTP (max-age de un año, inmutable);
  // lo demás (íconos, manifest) se pide fresco.
  const res = await sanear(
    await fetch(new Request(ruta, { cache: inmutable ? 'default' : 'reload' }))
  );
  if (!res) throw new Error('No se pudo precargar ' + ruta);
  await cache.put(ruta, res);
}

/**
 * index.html se baja siempre de la red y se comprueba que sea el de ESTE
 * build (que llame a su JS de entrada): durante un despliegue Vercel ya
 * puede estar sirviendo otro. Si no coincide, el install falla y se queda
 * el SW anterior; el siguiente update() trae el sw.js que sí coincide.
 */
async function precargarIndex(cache) {
  const res = await sanear(await fetch(new Request('/index.html', { cache: 'reload' })));
  if (!res) throw new Error('No se pudo precargar /index.html');
  const texto = await res.text();
  if (!texto.includes(PRECARGA.entrada))
    throw new Error('index.html no corresponde a este build (' + PRECARGA.entrada + ')');
  await cache.put(
    '/index.html',
    new Response(texto, {
      status: 200,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'text/html; charset=utf-8' },
    })
  );
}

self.addEventListener('install', (event) => {
  // Sin lista (desarrollo o interruptor apagado): como siempre, toma el
  // control sin esperar a que se cierren las pestañas viejas.
  if (!PRECARGA) {
    self.skipWaiting();
    return;
  }
  event.waitUntil(
    (async () => {
      const existia = await caches.has(CACHE_ACTUAL);
      const cache = await caches.open(CACHE_ACTUAL);
      try {
        // Núcleo, estricto: sin él no se activa (nunca un SW a medias).
        await precargarIndex(cache);
        await Promise.all(
          PRECARGA.nucleo.filter((r) => r !== '/index.html').map((r) => precargar(cache, r))
        );
        await cache.put(MARCA_COMPLETA, new Response(PRECARGA.version));
      } catch (e) {
        // Una caché nueva a medias no sirve: se borra. Si ya existía (mismo
        // build, SW reinstalado) es la de un SW que funciona y se queda.
        if (!existia) await caches.delete(CACHE_ACTUAL);
        throw e;
      }
      // Módulos diferidos: lo que se pueda. El que falte se baja (y se
      // guarda) la primera vez que se abra con red.
      await Promise.allSettled(PRECARGA.diferidos.map((r) => precargar(cache, r)));
      // Solo al terminar: la pestaña abierta sigue con el SW anterior
      // mientras tanto, y el aviso "Hay una versión nueva" decide la recarga.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const nombres = await cachesArmazon(); // más nueva primero
      if (!PRECARGA) {
        // Interruptor: fuera todo lo guardado.
        await Promise.all(nombres.map((n) => caches.delete(n)));
      } else {
        // Se quedan la actual y la anterior COMPLETA más reciente; el resto
        // (y cualquier caché a medias) se borra.
        let anterior = null;
        for (const n of nombres) {
          if (n !== CACHE_ACTUAL && (await estaCompleta(n))) {
            anterior = n;
            break;
          }
        }
        await Promise.all(
          nombres
            .filter((n) => n !== CACHE_ACTUAL && n !== anterior)
            .map((n) => caches.delete(n))
        );
      }
      await self.clients.claim();
    })()
  );
});

/**
 * Navegación: red primero con tope. La respuesta de red no se guarda (el
 * index.html guardado es SIEMPRE el del build de este SW). Sin red, lenta
 * o con error del servidor (5xx): el index.html guardado; la app lee la
 * ruta y ?record= / ?ir= de location, así que sirve para cualquier URL.
 * Un 4xx de verdad (p. ej. la protección de Vercel en un preview) se
 * entrega tal cual: ahí no hay app que servir por encima.
 * `sinTope` (la navegación de "Actualizar ahora", ver PARAM_ACTUALIZAR):
 * se espera a la red lo que tarde; el guardado solo si la red falla.
 */
async function navegar(event, sinTope) {
  const red = fetch(event.request);
  red.catch(() => {
    /* se atiende abajo; evita el "unhandled rejection" si ganó el tope */
  });
  let respuesta = null;
  try {
    respuesta = sinTope ? await red : await conTope(red, TOPE_NAVEGACION_MS);
  } catch {
    respuesta = null;
  }
  // opaqueredirect (status 0): la navegación sigue la redirección sola.
  if (
    respuesta &&
    (respuesta.type === 'opaqueredirect' || (respuesta.status > 0 && respuesta.status < 500))
  )
    return respuesta;
  const guardado = await buscarGuardado('/index.html', true);
  if (guardado) return guardado;
  if (respuesta) return respuesta;
  // Sin copia (SW recién instalado sin núcleo, caché desalojada): se espera
  // a la red sin tope, como si no hubiera SW.
  try {
    return await red;
  } catch {
    return Response.error();
  }
}

/**
 * /assets/* e íconos: caché primero; si no está, red, y se guarda si llegó
 * bien (un chunk de un build más nuevo cargado con red). Un 404 NUNCA se
 * guarda: los chunks de un build viejo dan 404 real (vercel.json no
 * reescribe /assets) y cargaDiferida lo trata como versión nueva.
 * La red lleva tope hasta que EMPIEZA a contestar (TOPE_RED_ARCHIVO_MS; app
 * pasmada sin señal, 24-sep-2026): con señal fantasma el módulo se quedaba
 * en "Cargando…" para siempre. El cuerpo llega después sin tope, así que un
 * chunk grande con 3G lenta no se corta.
 */
async function cachePrimero(event) {
  const req = event.request;
  const guardado = await buscarGuardado(req, false);
  if (guardado) return guardado;
  let res;
  try {
    res = await conTope(fetch(req), TOPE_RED_ARCHIVO_MS);
  } catch {
    // Sin red (o no contestó): si la caché solo iba lenta, que sirva ella
    // (el chunk de entrada sin señal); si no, que el import() falle rápido
    // y cargaDiferida decida.
    return (await buscarGuardado(req, false)) || Response.error();
  }
  if (res.ok && res.type === 'basic' && !res.redirected && CACHE_ACTUAL) {
    const copia = res.clone();
    event.waitUntil(
      caches
        .open(CACHE_ACTUAL)
        .then((c) => c.put(req, copia))
        .catch(() => {
          /* sin espacio: se sirve igual, solo no queda guardado */
        })
    );
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  if (!PRECARGA) return;
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // Otro origen (Supabase, OSM, Google): directo a la red, sin SW.
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/version.json' || url.pathname === '/sw.js') return;
  if (req.headers.has('range')) return;
  if (url.pathname.startsWith('/assets/') || ESTATICOS.has(url.pathname)) {
    event.respondWith(cachePrimero(event));
    return;
  }
  if (req.mode === 'navigate') {
    event.respondWith(navegar(event, url.searchParams.has(PARAM_ACTUALIZAR)));
    return;
  }
  // Todo lo demás: red, sin SW.
});

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
    // `evento` decide la sección: las notificaciones de pauta van a Pauta.
    data: {
      url: d.url || '/',
      record_id: d.record_id || null,
      evento: d.evento || null,
    },
    // vibrate no lo soporta iOS, pero en Android ayuda a notarla en campo.
    vibrate: [80, 40, 80],
  };

  event.waitUntil(self.registration.showNotification(titulo, opciones));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const datos = event.notification.data || {};
  const destino = datos.url || '/';
  const recordId = datos.record_id || null;
  const evento = datos.evento || null;
  // Estos eventos viven en Pauta y Monitoreo, no en Incidencias.
  const esPauta =
    evento === 'pauta_toma' || evento === 'pauta_revision' || evento === 'ruta';
  // Y estos en la Bitácora VV (versión por programar / programada).
  const esBitacora = evento === 'vv_version' || evento === 'vv_programada';
  // La URL se usa tanto al abrir una ventana nueva como al navegar una ya
  // abierta. De esta manera la app arranca desde el bundle actual y lee el
  // destino en App.tsx (`?record=` enfoca la incidencia; `?ir=pauta`
  // aterriza en Pauta), en vez de entregar el clic a JavaScript viejo que
  // pudo quedarse abierto durante días.
  const sep = destino.includes('?') ? '&' : '?';
  const url = recordId
    ? destino + sep + 'record=' + encodeURIComponent(recordId)
    : esPauta
      ? destino + sep + 'ir=pauta'
      : esBitacora
        ? destino + sep + 'ir=bitacora'
        : destino;

  event.waitUntil(
    (async () => {
      const ventanas = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Si la app ya está abierta, se enfoca esa ventana en vez de abrir otra.
      for (const v of ventanas) {
        if ('focus' in v) {
          // `navigate` fuerza a leer el HTML y los assets actuales de Vercel.
          // El postMessage anterior conservaba una SPA vieja en memoria.
          try {
            if ('navigate' in v) await v.navigate(url);
            else throw new Error('El cliente no permite navegar');
          } catch {
            // Respaldo para navegadores que no implementan WindowClient.navigate.
            v.postMessage({
              tipo: 'notificacion-abierta',
              url: destino,
              record_id: recordId,
              evento,
            });
          }
          await v.focus();
          return;
        }
      }
      // App cerrada: el record_id viaja en la URL para que App.tsx lo lea al
      // arrancar y enfoque la incidencia. Sin esto, abrir desde la
      // notificación aterrizaba en la portada como si nada.
      await self.clients.openWindow(url);
    })()
  );
});
