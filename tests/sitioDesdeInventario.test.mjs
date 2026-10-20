import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/sitioDesdeInventario.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { sitiosDesdeInventario, carasDe } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

// El caso real de la pauta 16-2026 (20-oct-2026).
const INV = new Map([
  ['MX_CM_EV_MUR_0001', 'MX_CM_MUR_0001'],
  ['MX_CM_EV_0002_A', 'MX_CM_EV_0002'],
]);

test('la cara del inventario toma su sitio de QTM y se reporta la corrección', () => {
  const filas = [
    { site_id: 'MX_CM_EV_0001', vendor_face_id: 'MX_CM_EV_MUR_0001', campana: 'X' },
    { site_id: 'MX_CM_EV_0002', vendor_face_id: 'MX_CM_EV_0002_A', campana: 'Y' },
  ];
  const r = sitiosDesdeInventario(filas, INV);
  assert.equal(r.filas[0].site_id, 'MX_CM_MUR_0001');
  assert.equal(r.filas[0].campana, 'X');
  assert.equal(r.filas[1], filas[1]);
  assert.deepEqual(r.corregidas, [
    { vendor_face_id: 'MX_CM_EV_MUR_0001', archivo: 'MX_CM_EV_0001', inventario: 'MX_CM_MUR_0001' },
  ]);
  assert.deepEqual(r.sinInventario, []);
  // No toca las filas originales.
  assert.equal(filas[0].site_id, 'MX_CM_EV_0001');
});

test('la cara que no está en el inventario conserva el sitio del archivo y se cuenta aparte', () => {
  const filas = [
    { site_id: 'MX_CM_EV_0099', vendor_face_id: 'MX_CM_EV_0099_A' },
    { site_id: 'MX_CM_EV_0099', vendor_face_id: 'MX_CM_EV_0099_A' },
  ];
  const r = sitiosDesdeInventario(filas, INV);
  assert.equal(r.filas[0].site_id, 'MX_CM_EV_0099');
  assert.deepEqual(r.corregidas, []);
  assert.deepEqual(r.sinInventario, ['MX_CM_EV_0099_A']);
});

test('una cara repetida en varias versiones se corrige en todas y se reporta una vez', () => {
  const filas = [
    { site_id: 'MX_CM_EV_0001', vendor_face_id: 'MX_CM_EV_MUR_0001', version: '1' },
    { site_id: 'MX_CM_EV_0001', vendor_face_id: 'MX_CM_EV_MUR_0001', version: '2' },
  ];
  const r = sitiosDesdeInventario(filas, INV);
  assert.deepEqual(r.filas.map((f) => f.site_id), ['MX_CM_MUR_0001', 'MX_CM_MUR_0001']);
  assert.equal(r.corregidas.length, 1);
});

test('carasDe da las caras sin repetir ni vacías', () => {
  assert.deepEqual(
    carasDe([{ vendor_face_id: 'A' }, { vendor_face_id: null }, { vendor_face_id: 'A' }, { vendor_face_id: 'B' }]),
    ['A', 'B']
  );
});
