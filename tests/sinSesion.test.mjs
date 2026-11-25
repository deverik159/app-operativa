// tests/sinSesion.test.mjs — consultas sin sesión retenidas (lib/sinSesion.ts, 25-nov-2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/sinSesion.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { esConsultaSinSesion, respuestaSinSesion } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const LLAVE = 'eyJ.llave.publica';
const BASE = 'https://x.supabase.co';

test('consulta a la base con la llave pública: se retiene', () => {
  assert.equal(esConsultaSinSesion(BASE + '/rest/v1/nuc_avisos?select=*', 'Bearer ' + LLAVE, LLAVE), true);
  assert.equal(esConsultaSinSesion(BASE + '/rest/v1/rpc/marcar_actividad', 'Bearer ' + LLAVE, LLAVE), true);
});

test('con sesión (token del usuario) sale normal', () => {
  assert.equal(esConsultaSinSesion(BASE + '/rest/v1/nuc_avisos', 'Bearer eyJ.token.usuario', LLAVE), false);
});

test('entrar o renovar la sesión nunca se retiene', () => {
  assert.equal(esConsultaSinSesion(BASE + '/auth/v1/token?grant_type=refresh_token', 'Bearer ' + LLAVE, LLAVE), false);
});

test('Storage, funciones y realtime no se tocan', () => {
  assert.equal(esConsultaSinSesion(BASE + '/storage/v1/object/evidencias/a.jpg', 'Bearer ' + LLAVE, LLAVE), false);
  assert.equal(esConsultaSinSesion(BASE + '/functions/v1/enviar-push', 'Bearer ' + LLAVE, LLAVE), false);
});

test('sin cabecera o sin llave configurada: se deja pasar', () => {
  assert.equal(esConsultaSinSesion(BASE + '/rest/v1/x', null, LLAVE), false);
  assert.equal(esConsultaSinSesion(BASE + '/rest/v1/x', 'Bearer ', ''), false);
});

test('la respuesta es la misma que da PostgREST: 401 con 42501', async () => {
  const r = respuestaSinSesion();
  assert.equal(r.status, 401);
  const cuerpo = await r.json();
  assert.equal(cuerpo.code, '42501');
});
