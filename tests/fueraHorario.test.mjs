import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/fueraHorario.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { estadoFueraHorario, contarFueraHorario } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('Fuera de horario: en qué quedó la prevalidación (18-nov-2026)', () => {
  const r = (requiere_prevalidacion, prevalidada, estatus) => ({ requiere_prevalidacion, prevalidada, estatus });
  assert.equal(estadoFueraHorario(r(false, false, 'por_validar')), null);
  assert.equal(estadoFueraHorario(r(null, null, 'en_proceso')), null);
  assert.equal(estadoFueraHorario(r(true, false, 'en_proceso')), 'pendiente');
  assert.equal(estadoFueraHorario(r(true, true, 'en_proceso')), 'prevalidada');
  // Prevalidada sigue siéndolo aunque ya se reparó o cerró.
  assert.equal(estadoFueraHorario(r(true, true, 'cerrada')), 'prevalidada');
  assert.equal(estadoFueraHorario(r(true, false, 'rechazada')), 'descartada');
  assert.deepEqual(
    contarFueraHorario([
      r(true, false, 'en_proceso'),
      r(true, true, 'reparado'),
      r(true, false, 'rechazada'),
      r(false, false, 'por_validar'),
      r(true, true, 'cerrada'),
    ]),
    { pendiente: 1, prevalidada: 2, descartada: 1, total: 4 }
  );
});
