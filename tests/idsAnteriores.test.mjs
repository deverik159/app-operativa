import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/idsAnteriores.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { armarIdsAnteriores, anterioresDe, carasPorIdAnterior } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

// IDs reales de la migración del 3-nov-2026.
const FILAS = [
  { id_anterior: 'MX_EM_BB_IID_0002', vendor_face_id: 'MX_EM_BB_UCL_0007' },
  { id_anterior: 'MX_EM_BB_IID_0001', vendor_face_id: 'MX_EM_BB_UCL_0003' },
  { id_anterior: 'MX_CM_BB_0115', vendor_face_id: 'MX_CM_BB_MEC_0115' },
];

test('Arma el alias por cara y enseña el ID viejo', () => {
  const ids = armarIdsAnteriores(FILAS);
  assert.deepEqual(anterioresDe(ids, 'MX_EM_BB_UCL_0007'), ['MX_EM_BB_IID_0002']);
  assert.deepEqual(anterioresDe(ids, 'MX_EM_BB_UCL_0099'), []);
  assert.deepEqual(anterioresDe(ids, null), []);
});

test('Buscar por el ID viejo encuentra la máquina, sin importar mayúsculas', () => {
  const ids = armarIdsAnteriores(FILAS);
  assert.deepEqual(carasPorIdAnterior(ids, 'iid_0002'), ['MX_EM_BB_UCL_0007']);
  assert.deepEqual(carasPorIdAnterior(ids, ' MX_CM_BB_0115 '), ['MX_CM_BB_MEC_0115']);
  assert.deepEqual(carasPorIdAnterior(ids, 'IID').sort(), ['MX_EM_BB_UCL_0003', 'MX_EM_BB_UCL_0007']);
  assert.deepEqual(carasPorIdAnterior(ids, 'UCL_0007'), [], 'el ID nuevo lo encuentra la búsqueda normal');
  assert.deepEqual(carasPorIdAnterior(ids, ''), []);
});

test('Filas vacías, repetidas o iguales al ID nuevo no hacen alias', () => {
  const ids = armarIdsAnteriores([
    ...FILAS,
    { id_anterior: 'MX_EM_BB_IID_0002', vendor_face_id: 'MX_EM_BB_UCL_0007' },
    { id_anterior: 'MX_X', vendor_face_id: 'MX_X' },
    { id_anterior: '', vendor_face_id: 'MX_Y' },
  ]);
  assert.deepEqual(anterioresDe(ids, 'MX_EM_BB_UCL_0007'), ['MX_EM_BB_IID_0002']);
  assert.equal(ids.has('MX_X'), false);
  assert.equal(ids.has('MX_Y'), false);
  assert.equal(armarIdsAnteriores(null).size, 0);
});
