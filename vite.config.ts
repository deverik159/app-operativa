import { defineConfig, type Plugin, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La línea de public/sw.js que el build reemplaza por la lista de precarga
 * (modo sin señal, 24-sep-2026). En desarrollo se sirve tal cual: con null
 * el SW no cachea nada (ver la cabecera de public/sw.js).
 */
const MARCADOR_PRECARGA = 'self.__PRECACHE__ = null;';

/**
 * Interruptor de emergencia del modo sin señal (revisión sin señal,
 * 24-sep-2026). Con SW_SIN_CACHE=1 (o true) en las variables de Vercel, el
 * build publica sw.js con la lista en null: el SW nuevo se instala, borra
 * sus cachés y deja de atender fetch (como antes del 24-sep; push sigue).
 * Antes no había forma de publicarlo: el plugin siempre reemplazaba el
 * marcador (aunque la línea dijera "// APAGADO") o tumbaba el build si se
 * quitaba. Para volver a encenderlo: quitar la variable y redesplegar.
 */
const SW_SIN_CACHE = /^(1|true)$/i.test((process.env.SW_SIN_CACHE || '').trim());

/**
 * version.json + lista de precarga del service worker.
 *
 * version.json: un archivo sin hash que la app consulta con `no-store`. Así
 * una pestaña que lleva horas abierta puede saber que Vercel publicó otro
 * bundle, aunque sus assets actuales tengan nombres con hash.
 *
 * Precarga (writeBundle): Vite ya copió public/ a dist/ ANTES de escribir el
 * bundle, así que aquí dist/sw.js existe y se reescribe con
 * {build, version, entrada, nucleo, diferidos}:
 *   · nucleo: index.html, el JS de entrada (con lo que importe de forma
 *     estática) y su CSS, más los íconos de la notificación. El SW lo exige
 *     completo para activarse.
 *   · diferidos: los demás archivos de assets/ (módulos que se abren por
 *     pestaña) y el manifest, "lo que se pueda". xlsx (~430 KB) se queda
 *     fuera: solo importa/exporta Excel y se guarda al primer uso con red.
 *   · version: hash de la lista de archivos, del index.html y de la
 *     plantilla del SW. No se usa el BUILD_ID solo: un redespliegue del
 *     mismo commit con otras variables VITE_* conserva el SHA pero cambia
 *     los hashes de los archivos.
 * Si algo no cuadra (no está el marcador, index.html no llama a su JS de
 * entrada) el build FALLA: un SW con una lista equivocada dejaría a 300
 * teléfonos abriendo sin señal una app rota.
 *
 * Con SW_SIN_CACHE=1 (ver arriba) se comprueba el marcador pero NO se
 * reemplaza: dist/sw.js sale con null. Comprobarlo en el log del build
 * (aviso "SW_SIN_CACHE=1") o con `grep "^self.__PRECACHE__" dist/sw.js`
 * (y ya publicado, en /sw.js): debe salir `self.__PRECACHE__ = null;`, no
 * la lista. El "^" va a propósito: un grep suelto del texto también
 * encontraba la cabecera de sw.js, que lo citaba, y "confirmaba" el null
 * con la lista puesta (verificación sin señal, 24-sep-2026). El id de
 * version.json lleva además "-sin-cache": un redespliegue del MISMO commit
 * conserva el SHA, y sin eso las pestañas abiertas no verían "Hay una
 * versión nueva" ni pedirían el SW nuevo hasta su siguiente arranque.
 */
function versionPublica(buildId: string): Plugin {
  return {
    name: 'version-publica',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ id: buildId }),
      });
    },
    writeBundle(opciones, bundle) {
      const dir = opciones.dir;
      if (!dir) return this.error('precarga del SW: el build no tiene carpeta de salida.');
      const rutaSw = join(dir, 'sw.js');
      if (!existsSync(rutaSw)) return this.error(`precarga del SW: no existe ${rutaSw}.`);
      const plantilla = readFileSync(rutaSw, 'utf8');
      if (plantilla.split(MARCADOR_PRECARGA).length !== 2)
        return this.error(`precarga del SW: "${MARCADOR_PRECARGA}" debe aparecer una sola vez en sw.js.`);
      if (SW_SIN_CACHE) {
        this.warn('SW_SIN_CACHE=1: sw.js se publica con __PRECACHE__ = null (modo sin señal APAGADO).');
        return;
      }

      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') return this.error('precarga del SW: falta index.html en el bundle.');
      const textoHtml =
        typeof html.source === 'string' ? html.source : new TextDecoder().decode(html.source);

      const entradas = Object.values(bundle).filter((f) => f.type === 'chunk' && f.isEntry);
      if (entradas.length !== 1 || entradas[0].type !== 'chunk')
        return this.error(`precarga del SW: se esperaba 1 JS de entrada y hay ${entradas.length}.`);
      const entrada = entradas[0];
      const rutaEntrada = '/' + entrada.fileName;
      if (!textoHtml.includes(rutaEntrada))
        return this.error(`precarga del SW: index.html no llama a su JS de entrada ${rutaEntrada}.`);

      // Núcleo: la entrada y todo lo que importa de forma estática (si Vite
      // parte un vendor, la app no arranca sin él), con su CSS y assets.
      const nucleo = new Set<string>();
      const visitar = (archivo: string) => {
        if (nucleo.has(archivo)) return;
        const f = bundle[archivo];
        if (!f) return;
        nucleo.add(archivo);
        if (f.type !== 'chunk') return;
        f.imports.forEach(visitar);
        f.viteMetadata?.importedCss.forEach((css) => nucleo.add(css));
        f.viteMetadata?.importedAssets.forEach((a) => nucleo.add(a));
      };
      visitar(entrada.fileName);
      for (const css of nucleo)
        if (css.endsWith('.css') && !textoHtml.includes('/' + css))
          return this.error(`precarga del SW: index.html no llama a su CSS /${css}.`);

      const esXlsx = (archivo: string) => {
        const f = bundle[archivo];
        return (f?.type === 'chunk' && f.name === 'xlsx') || /^assets\/xlsx-[^/]+\.js$/.test(archivo);
      };
      const diferidos = Object.keys(bundle)
        .filter((a) => a.startsWith('assets/') && !nucleo.has(a) && !a.endsWith('.map') && !esXlsx(a))
        .sort();

      const version = createHash('sha256')
        .update(JSON.stringify({ archivos: Object.keys(bundle).sort(), html: textoHtml, sw: plantilla }))
        .digest('hex')
        .slice(0, 16);
      const lista = {
        build: buildId,
        version,
        entrada: rutaEntrada,
        nucleo: ['/index.html', ...[...nucleo].sort().map((a) => '/' + a), '/icon-192.png', '/badge-96.png'],
        diferidos: [...diferidos.map((a) => '/' + a), '/manifest.webmanifest'],
      };
      writeFileSync(
        rutaSw,
        plantilla.replace(MARCADOR_PRECARGA, `self.__PRECACHE__ = ${JSON.stringify(lista)};`)
      );
    },
  };
}

// ============================================================
// Configuración de Vite
//
// DOS MODOS DE DESARROLLO:
//
//   npm run dev        → HTTPS  (https://TU-IP:5173)  ← el GPS funciona
//   npm run dev:http   → HTTP   (http://TU-IP:5173)   ← sin GPS, pero simple
//
// Por qué existe el modo HTTPS: la geolocalización del navegador SOLO
// funciona en "orígenes seguros" (https:// o localhost). Al abrir la app en
// red local por http://192.168.x.x:5173 el GPS queda bloqueado.
//
// OJO AL PROBAR DESDE EL CELULAR: hay que escribir el https:// COMPLETO.
// Si escribes solo la IP, el navegador asume http://, el servidor TLS corta
// la conexión y verás "se interrumpió la conexión" — que parece un problema
// de red pero no lo es.
//
// La primera vez, cada dispositivo avisará "conexión no privada" por el
// certificado autofirmado: Configuración avanzada → Continuar. Pasa una vez.
//
// En producción (Vercel) el HTTPS es real y nada de esto aplica.
// ============================================================
export default defineConfig(async ({ command, mode }) => {
  // Vercel entrega este SHA en cada despliegue. En local se usa un id por
  // arranque: basta para que el detector no confunda un servidor de desarrollo
  // con una versión publicada.
  const buildId =
    (process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.VERCEL_DEPLOYMENT_ID ||
      `local-${Date.now().toString(36)}`) + (SW_SIN_CACHE ? '-sin-cache' : '');
  // `command` vale 'serve' al desarrollar y 'build' al compilar.
  //
  // POR QUÉ IMPORTA: sin este filtro, al construir para Vercel también se
  // cargaba el plugin del certificado autofirmado y se imprimía el aviso de
  // "escribe la dirección COMPLETA" en el log del despliegue — un mensaje
  // sobre desarrollo local, en medio de un build de producción, que confunde
  // a quien lee el log buscando el error de verdad.
  //
  // Un plugin de TLS para desarrollo no tiene nada que hacer en un build.
  const enDesarrollo = command === 'serve';
  // `npm run dev:http` arranca con --mode http y se salta el certificado.
  const usarHttps = enDesarrollo && mode !== 'http';
  const plugins: PluginOption[] = [
    react(),
    // version.json y la lista de precarga del service worker (ver arriba).
    versionPublica(buildId),
  ];

  if (usarHttps) {
    try {
      const { default: basicSsl } = await import('@vitejs/plugin-basic-ssl');
      plugins.push(basicSsl());
      console.log(
        '\n  🔒 HTTPS activo. Desde el celular escribe la dirección COMPLETA:\n' +
          '     https://TU-IP:5173     (con https://, no solo la IP)\n' +
          '     Si falla, prueba:  npm run dev:http\n'
      );
    } catch {
      // Una dependencia de conveniencia no debe impedir levantar el proyecto.
      console.warn(
        '\n  ⚠️  Servidor en HTTP: falta @vitejs/plugin-basic-ssl.\n' +
          '     El GPS no funcionará salvo en localhost.\n' +
          '     Para activarlo:  npm install\n'
      );
    }
  } else if (enDesarrollo) {
    console.log(
      '\n  🌐 Modo HTTP (sin certificado). Desde el celular:\n' +
        '     http://TU-IP:5173\n' +
        '     El buscador "Sitios cerca de mí" NO funcionará aquí.\n'
    );
  }

  return {
    plugins,
    define: {
      __APP_BUILD_ID__: JSON.stringify(buildId),
    },
    server: {
      // host:true expone el servidor en la red local para probar desde celular.
      host: true,
      // Si el entorno asigna un puerto (PORT), se respeta: así pueden
      // convivir dos servidores de desarrollo a la vez (p. ej. la vista
      // previa de Claude Code junto al `npm run dev` de siempre). Sin PORT,
      // se queda el 5173 de las notas y del celular.
      port: Number(process.env.PORT) || 5173,
      // Sin esto, si el 5173 está ocupado Vite se cambia de puerto en
      // silencio y la IP que anotaste deja de servir.
      strictPort: true,
    },
  };
});
