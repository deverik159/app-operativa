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
export default defineConfig(async ({ mode }) => {
  // `npm run dev:http` arranca con --mode http y se salta el certificado.
  const usarHttps = mode !== 'http';
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
  } else {
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
      port: 5173,
      // Sin esto, si el 5173 está ocupado Vite se cambia de puerto en
      // silencio y la IP que anotaste deja de servir.
      strictPort: true,
    },
  };
});
