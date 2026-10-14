import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/catorcena.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const {
  anioDe,
  etiquetaCatorcena,
  claveCatorcena,
  leerClaveCatorcena,
  compararCatorcenas,
  anioMasCercano,
  esMasReciente,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

// Pedazo del calendario oficial, con los cambios de año irregulares.
const CAL = [
  { numero: 1, anio: 2024, fecha_inicio: '2023-12-26', fecha_fin: '2024-01-08' },
  { numero: 27, anio: 2025, fecha_inicio: '2025-12-23', fecha_fin: '2026-01-05' },
  { numero: 1, anio: 2026, fecha_inicio: '2026-01-06', fecha_fin: '2026-01-19' },
  { numero: 16, anio: 2026, fecha_inicio: '2026-08-04', fecha_fin: '2026-08-17' },
  { numero: 21, anio: 2026, fecha_inicio: '2026-10-13', fecha_fin: '2026-10-26' },
  { numero: 26, anio: 2026, fecha_inicio: '2026-12-22', fecha_fin: '2027-01-04' },
  { numero: 1, anio: 2027, fecha_inicio: '2027-01-05', fecha_fin: '2027-01-18' },
];

test('el año viene de la columna cuando existe', () => {
  assert.equal(anioDe({ numero: 27, anio: 2025, fecha_inicio: '2025-12-23', fecha_fin: '2026-01-05' }), 2025);
  assert.equal(anioDe({ numero: 1, anio: 2024, fecha_inicio: '2023-12-26', fecha_fin: '2024-01-08' }), 2024);
});

test('sin columna (copia vieja), el día de en medio acierta todo 2026', () => {
  assert.equal(anioDe({ numero: 26, fecha_inicio: '2026-12-22', fecha_fin: '2027-01-04' }), 2026);
  assert.equal(anioDe({ numero: 1, fecha_inicio: '2026-01-06', fecha_fin: '2026-01-19' }), 2026);
  assert.equal(anioDe({ numero: 1 }), null);
});

test('etiqueta y llave', () => {
  assert.equal(etiquetaCatorcena(1, 2027), 'Cat-1 · 2027');
  assert.equal(etiquetaCatorcena(21), 'Cat-21');
  assert.equal(claveCatorcena(2027, 1), '2027-1');
  assert.deepEqual(leerClaveCatorcena('2027-1'), { anio: 2027, numero: 1 });
  assert.equal(leerClaveCatorcena('21'), null);
  assert.equal(leerClaveCatorcena(null), null);
});

test('el orden es por fecha, no por número', () => {
  const orden = CAL.slice().reverse().sort(compararCatorcenas).map((c) => claveCatorcena(c.anio, c.numero));
  assert.deepEqual(orden, ['2024-1', '2025-27', '2026-1', '2026-16', '2026-21', '2026-26', '2027-1']);
});

test('el año más cercano a las fechas del archivo', () => {
  // La Cat-1 importada en diciembre de 2026 es la de 2027.
  assert.equal(anioMasCercano(CAL, 1, '2026-12-28'), 2027);
  // La Cat-1 con fechas de enero de 2026 es la de 2026.
  assert.equal(anioMasCercano(CAL, 1, '2026-01-10'), 2026);
  assert.equal(anioMasCercano(CAL, 16, '2026-07-20'), 2026);
  assert.equal(anioMasCercano(CAL, 27, '2026-01-01'), 2025);
  assert.equal(anioMasCercano(CAL, 99, '2026-01-01'), null);
});

test('en el cambio de año la columna de número chico es la más reciente', () => {
  assert.equal(esMasReciente(16, 15), true);
  assert.equal(esMasReciente(15, 16), false);
  assert.equal(esMasReciente(1, 26), true);
  assert.equal(esMasReciente(26, 1), false);
  assert.equal(esMasReciente(1, 27), true);
});
