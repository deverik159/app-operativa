import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/fechasCdmx.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { diaCdmx, fechaHoraCdmx, inicioDiaCdmx } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('lo reportado después de las 18:00 de México es del mismo día', () => {
  // 19:30 CDMX del 8-oct = 01:30 UTC del 9-oct.
  assert.equal(diaCdmx('2026-10-09T01:30:00+00:00'), '2026-10-08');
  assert.equal(diaCdmx('2026-10-09T05:59:00Z'), '2026-10-08');
  assert.equal(diaCdmx('2026-10-09T06:00:00Z'), '2026-10-09');
  // La segunda vez sale de la memoria y debe dar lo mismo.
  assert.equal(diaCdmx('2026-10-09T01:30:00+00:00'), '2026-10-08');
});

test('también acepta Date', () => {
  assert.equal(diaCdmx(new Date('2026-01-01T03:00:00Z')), '2025-12-31');
});

test('fecha y hora de CDMX para el CSV', () => {
  assert.equal(fechaHoraCdmx('2026-10-09T01:30:00Z'), '2026-10-08 19:30');
  assert.equal(fechaHoraCdmx(null), '');
  assert.equal(fechaHoraCdmx(''), '');
});

test('el día en CDMX empieza a las 06:00 UTC', () => {
  assert.equal(inicioDiaCdmx('2026-10-08'), Date.parse('2026-10-08T06:00:00Z'));
  assert.equal(inicioDiaCdmx('2026-03-01'), Date.parse('2026-03-01T06:00:00Z'));
});

test('el año a medio teclear no es fecha', () => {
  assert.equal(inicioDiaCdmx('0002-10-08'), null);
  assert.equal(inicioDiaCdmx('2026-10'), null);
  assert.equal(inicioDiaCdmx(''), null);
});
