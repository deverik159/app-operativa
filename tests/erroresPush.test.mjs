import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/erroresPush.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { errorSuscripcionPush } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const domErr = (name, message) => Object.assign(new Error(message), { name });

test('push service error de Chrome sale en español y dice qué hacer', () => {
  const t = errorSuscripcionPush(domErr('AbortError', 'Registration failed - push service error'));
  assert.match(t, /servicio de avisos de Google/);
  assert.match(t, /vuelve a tocar Activar/);
  assert.doesNotMatch(t, /Registration failed/);
});

test('el mismo texto aunque el navegador no ponga name', () => {
  assert.match(errorSuscripcionPush(new Error('Registration failed - push service error')), /Servicios de Google Play/);
});

test('permiso negado', () => {
  assert.match(errorSuscripcionPush(domErr('NotAllowedError', 'Registration failed - permission denied')), /permiso/);
});

test('llave vieja', () => {
  assert.match(
    errorSuscripcionPush(domErr('InvalidStateError', 'A subscription with a different applicationServerKey already exists')),
    /versión anterior/
  );
});

test('lo desconocido se muestra como llegó', () => {
  assert.equal(errorSuscripcionPush(new Error('algo raro')), 'No se pudo suscribir: algo raro');
  assert.equal(errorSuscripcionPush(null), 'No se pudo suscribir: error desconocido del navegador.');
});
