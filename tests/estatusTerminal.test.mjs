import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/constants.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { esTerminal, TERMINALES_LISTA, EST_LABEL } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('Duplicada es terminal, como cerrada y no reparado (23-nov-2026)', () => {
  for (const e of ['cerrada', 'no_reparado', 'duplicada']) assert.equal(esTerminal(e), true, e);
  for (const e of ['por_validar', 'en_proceso', 'reparado', 'rechazada', null, undefined, ''])
    assert.equal(esTerminal(e), false, String(e));
  assert.equal(TERMINALES_LISTA, '(cerrada,no_reparado,duplicada)');
  assert.equal(EST_LABEL.duplicada, 'Duplicada');
});
