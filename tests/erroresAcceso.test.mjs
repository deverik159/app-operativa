import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/erroresAcceso.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { errorAccesoEnEspanol, errorEnlaceCorreo, respondioElServidor } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('contraseña equivocada, con code o solo con el texto', () => {
  const esperado = /^Correo o contraseña incorrectos/;
  assert.match(errorAccesoEnEspanol({ code: 'invalid_credentials', message: 'Invalid login credentials' }), esperado);
  assert.match(errorAccesoEnEspanol({ message: 'Invalid login credentials' }), esperado);
});

test('espera entre correos trae los segundos', () => {
  assert.equal(
    errorAccesoEnEspanol({ code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this after 45 seconds.' }),
    'Por seguridad, espera 45 segundos antes de pedir otro correo.'
  );
});

test('contraseña nueva igual a la anterior', () => {
  assert.match(errorAccesoEnEspanol({ code: 'same_password', message: 'x' }), /distinta de la anterior/);
});

test('un 500 de Auth es respuesta del servidor, no falta de señal', () => {
  // Así llega cuando Gmail rechaza el SMTP (21-oct-2026).
  const e = { name: 'AuthRetryableFetchError', status: 500, message: 'Error sending recovery email' };
  assert.equal(respondioElServidor(e), true);
  assert.match(errorAccesoEnEspanol(e), /configuración de correo/);
  assert.equal(respondioElServidor({ name: 'AuthRetryableFetchError', status: 0 }), false);
  assert.equal(respondioElServidor({ status: 504 }), false);
  assert.match(errorAccesoEnEspanol({ status: 500, message: 'otra cosa' }), /falla en el servidor/);
});

test('lo desconocido sale como llegó', () => {
  assert.equal(errorAccesoEnEspanol({ message: 'Something new' }), 'Something new');
  assert.equal(errorAccesoEnEspanol({}), 'No se pudo completar. Intenta de nuevo.');
});

test('enlace de correo vencido en el hash', () => {
  assert.match(
    errorEnlaceCorreo('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'),
    /ya venció o ya se usó/
  );
  assert.equal(errorEnlaceCorreo('#access_token=abc&type=recovery'), null);
  assert.equal(errorEnlaceCorreo(''), null);
});
