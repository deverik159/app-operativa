import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/ubicacionMaquina.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { ubicacionDeMaquina } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('Asignar máquina: la ubicación sale de la cara del inventario (17-nov-2026)', () => {
  const cara = {
    site_id: 'MX_CM_BB_0058',
    vendor_face_id: 'MX_CM_BB_MEC_0058',
    direccion: 'Av. Siempre Viva 1',
    municipio: 'Cuauhtémoc',
    estado: 'Ciudad de México',
    tipo_medio: 'Biobox',
    tipo_mueble: 'Máquina',
    site_legacy_id: 'Antonio y Xola',
  };
  assert.deepEqual(ubicacionDeMaquina(cara, 'otra'), {
    clave_sitio: 'MX_CM_BB_0058',
    clave_medio: 'MX_CM_BB_MEC_0058',
    direccion: 'Av. Siempre Viva 1',
    municipio: 'Cuauhtémoc',
    plaza: 'Ciudad de México',
    medio: 'Biobox',
    tipo_mueble: 'Máquina',
    nombre_biobox: 'Antonio y Xola',
  });
  // Sin dirección en la cara: la del sitio; sin nombre: null.
  const r = ubicacionDeMaquina({ ...cara, direccion: null, site_legacy_id: '' }, 'Dir del sitio');
  assert.equal(r.direccion, 'Dir del sitio');
  assert.equal(r.nombre_biobox, null);
  assert.equal(ubicacionDeMaquina({ ...cara, direccion: null }).direccion, null);
});
