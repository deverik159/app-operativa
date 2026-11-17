import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/origenInc.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { origenInc, contarOrigen } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('Origen: usuario de la app contra operación/campo (17-nov-2026)', () => {
  assert.equal(origenInc({ area_reportante: 'App Biobox' }), 'app');
  assert.equal(origenInc({ area_reportante: ' App Biobox ' }), 'app');
  for (const a of ['Operaciones', 'Monitoreo', 'MKT', null, undefined, ''])
    assert.equal(origenInc({ area_reportante: a }), 'campo', String(a));
  assert.deepEqual(
    contarOrigen([
      { area_reportante: 'App Biobox' },
      { area_reportante: 'Operaciones' },
      { area_reportante: 'App Biobox' },
      { area_reportante: 'MKT' },
    ]),
    { campo: 2, app: 2 }
  );
});
