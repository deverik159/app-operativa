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
const { origenInc, contarOrigen, esSinMaquina } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('Origen: usuario de la app contra operación/campo (17-nov-2026)', () => {
  assert.equal(origenInc({ area_reportante: 'App Biobox' }), 'app');
  assert.equal(origenInc({ area_reportante: ' App Biobox ' }), 'app');
  for (const a of ['Operaciones', 'Monitoreo', 'MKT', null, undefined, ''])
    assert.equal(origenInc({ area_reportante: a }), 'campo', String(a));
  assert.deepEqual(
    contarOrigen([
      { area_reportante: 'App Biobox', clave_sitio: 'SIN-MAQUINA' },
      { area_reportante: 'Operaciones', clave_sitio: 'MX_CM_BB_0058' },
      { area_reportante: 'App Biobox', clave_sitio: 'MX_CM_BB_0012' },
      { area_reportante: 'MKT', clave_sitio: 'SIN-MAQUINA' },
    ]),
    { campo: 2, app: 2, sinMaquina: 2 }
  );
});

test('Sin máquina: solo la clave SIN-MAQUINA (17-nov-2026)', () => {
  assert.equal(esSinMaquina({ clave_sitio: 'SIN-MAQUINA' }), true);
  assert.equal(esSinMaquina({ clave_sitio: ' SIN-MAQUINA ' }), true);
  assert.equal(esSinMaquina({ clave_sitio: 'MX_CM_BB_0058' }), false);
  assert.equal(esSinMaquina({ clave_sitio: null }), false);
  assert.equal(esSinMaquina({}), false);
});
