// ============================================================
// tests/authInterno.test.mjs
// App.tsx (renovarSesionYa) olvida `lastRefreshFailure`, un campo INTERNO de
// @supabase/auth-js, para que al volver la señal la sesión se renueve YA y no
// tras el enfriamiento de 60 s (app pasmada sin señal, 24-sep-2026). Si una
// actualización de supabase-js lo quita, lo renombra o le cambia la forma, el
// parche deja de hacer efecto EN SILENCIO (no truena: vuelve el minuto de
// espera). Esta prueba es la alarma: si falla, revisar renovarSesionYa contra
// el GoTrueClient nuevo antes de publicar.
//
// Correr: node --test tests/*.test.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('..', import.meta.url));

/**
 * El auth-js que de verdad empaqueta la app: el que resuelve supabase-js
 * (anidado bajo él si npm no pudo subirlo, o el de arriba).
 */
function carpetaAuth() {
  const anidada = `${raiz}node_modules/@supabase/supabase-js/node_modules/@supabase/auth-js/`;
  if (existsSync(anidada + 'package.json')) return anidada;
  return `${raiz}node_modules/@supabase/auth-js/`;
}

const dir = carpetaAuth();
const { version } = JSON.parse(readFileSync(dir + 'package.json', 'utf8'));
// module = lo que empaqueta Vite; main = el mismo código en CommonJS.
const fuentes = ['dist/module/GoTrueClient.js', 'dist/main/GoTrueClient.js'].map((f) => [
  f,
  readFileSync(dir + f, 'utf8'),
]);

for (const [archivo, src] of fuentes) {
  test(`auth-js ${version} (${archivo}): lastRefreshFailure existe y se inicia en null`, () => {
    // Se inicia en el constructor: por eso `'lastRefreshFailure' in sb.auth`
    // es true aunque no haya fallado nada todavía.
    assert.match(src, /this\.lastRefreshFailure\s*=\s*null\s*;/);
  });

  test(`auth-js ${version} (${archivo}): la falla guardada corta la renovación durante el enfriamiento`, () => {
    // Lo que renovarSesionYa salta: misma llave, antes de expiresAt → la falla
    // guardada, sin salir a la red.
    assert.match(src, /this\.lastRefreshFailure\.refreshToken\s*===\s*refreshToken/);
    assert.match(src, /Date\.now\(\)\s*<\s*this\.lastRefreshFailure\.expiresAt/);
    assert.match(src, /return\s+this\.lastRefreshFailure\.result\s*;/);
  });

  test(`auth-js ${version} (${archivo}): la falla guarda { refreshToken, result, expiresAt } con result = { data: null, error }`, () => {
    // renovarSesionYa lee lastRefreshFailure.result.error para olvidar solo
    // las fallas de RED (isAuthRetryableFetchError).
    assert.match(
      src,
      /this\.lastRefreshFailure\s*=\s*\{\s*refreshToken\s*,\s*result\s*,\s*expiresAt\s*:/
    );
    assert.match(src, /const\s+result\s*=\s*\{\s*data:\s*null\s*,\s*error\s*\}/);
  });
}

test(`auth-js ${version}: con la falla guardada no sale a la red; al olvidarla, sí`, async () => {
  const require = createRequire(import.meta.url);
  const mod = require(dir + 'dist/main/GoTrueClient.js');
  const GoTrueClient = mod.default ?? mod;
  let llamadas = 0;
  // Un 400 (token rechazado) y no un fallo de red: auth-js no lo reintenta y
  // la prueba no espera sus ~26 s de reintentos.
  const fetchFalso = async () => {
    llamadas++;
    return new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'prueba' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  };
  const cliente = new GoTrueClient({
    url: 'http://127.0.0.1:9/auth/v1',
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    fetch: fetchFalso,
  });
  assert.ok('lastRefreshFailure' in cliente, 'el cliente ya no tiene lastRefreshFailure');
  assert.equal(cliente.lastRefreshFailure, null);

  const guardada = { data: null, error: new Error('sin red') };
  cliente.lastRefreshFailure = {
    refreshToken: 'tok',
    result: guardada,
    expiresAt: Date.now() + 60000,
  };
  assert.equal(await cliente._callRefreshToken('tok'), guardada);
  assert.equal(llamadas, 0, 'con la falla guardada no debía pedir /token');

  // Lo que hace renovarSesionYa:
  cliente.lastRefreshFailure = null;
  await cliente._callRefreshToken('tok');
  assert.equal(llamadas, 1, 'olvidada la falla, debía volver a pedir /token');
});
