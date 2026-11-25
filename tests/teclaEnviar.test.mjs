import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// teclaEnviar.ts importa plataforma.ts: se empaqueta en memoria.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/teclaEnviar.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { enviaConTecla } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('Computadora: Intro envía y Shift+Intro salta de renglón', () => {
  assert.equal(enviaConTecla({ key: 'Enter' }, true), true);
  assert.equal(enviaConTecla({ key: 'Enter', shiftKey: true }, true), false);
  assert.equal(enviaConTecla({ key: 'Enter', altKey: true }, true), false);
  assert.equal(enviaConTecla({ key: 'Enter', ctrlKey: true }, true), true);
  assert.equal(enviaConTecla({ key: 'Enter', metaKey: true }, true), true);
  assert.equal(enviaConTecla({ key: 'a' }, true), false);
});

test('Teléfono: Intro salta de renglón (igual que antes); Ctrl/⌘+Intro envía', () => {
  assert.equal(enviaConTecla({ key: 'Enter' }, false), false);
  assert.equal(enviaConTecla({ key: 'Enter', shiftKey: true }, false), false);
  assert.equal(enviaConTecla({ key: 'Enter', ctrlKey: true }, false), true);
  assert.equal(enviaConTecla({ key: 'Enter', metaKey: true }, false), true);
});

test('Componiendo texto (acentos, IME) Intro nunca envía', () => {
  assert.equal(enviaConTecla({ key: 'Enter', isComposing: true }, true), false);
  assert.equal(enviaConTecla({ key: 'Enter', ctrlKey: true, isComposing: true }, true), false);
});
