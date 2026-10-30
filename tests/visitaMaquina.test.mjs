import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// visitaMaquina.ts importa fechasCdmx y haversine: se empaqueta en memoria.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/visitaMaquina.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const {
  ultimoContacto, diasDesde, semaforoVisita, textoDiasVisita, distanciaAMaquina, estaLejos, LEJOS_M,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

test('Cuenta lo más reciente entre la visita rápida y la revisión completa', () => {
  assert.equal(ultimoContacto(null, undefined), null);
  assert.equal(ultimoContacto('2026-10-20T15:00:00Z', null), '2026-10-20T15:00:00Z');
  assert.equal(ultimoContacto('2026-10-20T15:00:00Z', '2026-10-25T15:00:00+00:00'), '2026-10-25T15:00:00+00:00');
  assert.equal(ultimoContacto('basura', '2026-10-01T00:00:00Z'), '2026-10-01T00:00:00Z');
});

test('Los días se cuentan por día de CDMX, no de UTC', () => {
  const ahora = new Date('2026-10-30T03:00:00Z'); // 29-oct 21:00 en CDMX
  // 29-oct 19:00 CDMX = 30-oct 01:00 UTC: es de hoy.
  assert.equal(diasDesde('2026-10-30T01:00:00Z', ahora), 0);
  // 28-oct 23:30 CDMX: ayer.
  assert.equal(diasDesde('2026-10-29T05:30:00Z', ahora), 1);
  assert.equal(diasDesde('2026-10-19T18:00:00Z', ahora), 10);
  assert.equal(diasDesde(null, ahora), null);
  // Reloj adelantado: nunca negativo.
  assert.equal(diasDesde('2026-11-02T18:00:00Z', ahora), 0);
});

test('Semáforo: verde hasta 7, ámbar hasta 14, rojo más o nunca', () => {
  assert.equal(semaforoVisita(0), 'verde');
  assert.equal(semaforoVisita(7), 'verde');
  assert.equal(semaforoVisita(8), 'ambar');
  assert.equal(semaforoVisita(14), 'ambar');
  assert.equal(semaforoVisita(15), 'rojo');
  assert.equal(semaforoVisita(null), 'rojo');
  assert.equal(textoDiasVisita(null), 'Nunca visitada');
  assert.equal(textoDiasVisita(0), 'Visitada hoy');
  assert.equal(textoDiasVisita(1), 'Visitada ayer');
  assert.equal(textoDiasVisita(5), 'Visitada hace 5 días');
});

test('Lejos de la máquina solo con las dos coordenadas y más de 150 m', () => {
  const maq = { latitud: '19.4326', longitud: '-99.1332' };
  assert.equal(distanciaAMaquina(null, maq), null);
  assert.equal(distanciaAMaquina({ lat: 19.4326, lng: -99.1332 }, { latitud: null, longitud: null }), null);
  assert.equal(distanciaAMaquina({ lat: 19.4326, lng: -99.1332 }, maq), 0);
  const cerca = distanciaAMaquina({ lat: 19.4335, lng: -99.1332 }, maq); // ~100 m
  const lejos = distanciaAMaquina({ lat: 19.4426, lng: -99.1332 }, maq); // ~1.1 km
  assert.ok(cerca > 90 && cerca < 110);
  assert.equal(estaLejos(cerca), false);
  assert.equal(estaLejos(lejos), true);
  assert.equal(estaLejos(null), false);
  assert.equal(estaLejos(LEJOS_M), false);
});
