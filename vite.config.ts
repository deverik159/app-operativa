import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  const plugins = [react()];

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
