import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/subidaEnvios.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { nombrarFolios, textoSubida, textoLogroEnvio } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
);

test('Folios: uno, dos, varios y ninguno', () => {
  assert.equal(nombrarFolios(['BBMM00012']), 'BBMM00012');
  assert.equal(nombrarFolios(['BBMM00012', 'BBMM00013']), 'BBMM00012 y BBMM00013');
  assert.equal(nombrarFolios(['A', 'B', 'C', 'D']), '4 incidencias');
  assert.equal(nombrarFolios(['A', 'A']), 'A');
  assert.equal(nombrarFolios([]), 'tu reporte');
});

test('Leyenda de avance: un reporte, varios, y nada', () => {
  assert.equal(textoSubida([]), '');
  assert.equal(
    textoSubida([{ folios: ['BBMM00012'], hechos: 3, total: 6 }]),
    'Subiendo fotos de BBMM00012 · 3 de 6'
  );
  assert.equal(
    textoSubida([
      { folios: ['EV00001'], hechos: 1, total: 2 },
      { folios: ['EV00002', 'EV00003'], hechos: 0, total: 4 },
    ]),
    'Subiendo fotos de 2 reportes · 1 de 6'
  );
});

test('Logro: con sus fotos, con su foto, sin fotos y con fallas', () => {
  assert.equal(
    textoLogroEnvio([{ folios: ['BBMM00012'], archivos: 6, fallidos: 0 }]),
    '✓ BBMM00012 guardado con sus 6 fotos'
  );
  assert.equal(
    textoLogroEnvio([{ folios: ['BBMM00012'], archivos: 1, fallidos: 0 }]),
    '✓ BBMM00012 guardado con su foto'
  );
  assert.equal(
    textoLogroEnvio([{ folios: ['EV00001', 'EV00002'], archivos: 4, fallidos: 0 }]),
    '✓ EV00001 y EV00002 guardados con sus 4 fotos'
  );
  assert.equal(
    textoLogroEnvio([{ folios: ['A', 'B', 'C'], archivos: 3, fallidos: 0 }]),
    '✓ 3 incidencias guardadas con sus 3 fotos'
  );
  assert.equal(
    textoLogroEnvio([{ folios: ['BBMM00012'], archivos: 5, fallidos: 1 }]),
    '✓ BBMM00012 guardado · 1 foto no se subió, revisa el aviso'
  );
  assert.equal(
    textoLogroEnvio([{ folios: ['BBMM00012'], archivos: 4, fallidos: 2 }]),
    '✓ BBMM00012 guardado · 2 fotos no se subieron, revisa el aviso'
  );
  assert.equal(textoLogroEnvio([]), '');
});
