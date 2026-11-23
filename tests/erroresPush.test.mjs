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

test('en Windows (Edge) habla de Windows y no de Google Play', () => {
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';
  const t = errorSuscripcionPush(domErr('AbortError', 'Registration failed - push service error'), ua);
  assert.match(t, /servicio de avisos de Windows/);
  assert.match(t, /InPrivate/);
  assert.match(t, /Chrome/);
  assert.doesNotMatch(t, /Google Play/);
});

test('en Android sigue hablando de Google Play', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36';
  assert.match(errorSuscripcionPush(domErr('AbortError', 'Registration failed - push service error'), ua), /Google Play/);
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
