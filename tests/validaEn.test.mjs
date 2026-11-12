import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/validaEn.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { validaEnIncidencia } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

// Como Ana (12-nov-2026): validadora Digital de Ecovallas y Vía Verde, y
// reportante de Operaciones (eso le deja VER lo de Biobox, no validarlo).
const ana = [
  { rol: 'reportante', unidad_negocio: 'Vía Verde', medio: null },
  { rol: 'reportante', unidad_negocio: 'Ecovallas', medio: null },
  { rol: 'validador', unidad_negocio: 'Ecovallas', medio: 'Digital' },
  { rol: 'validador', unidad_negocio: 'Vía Verde', medio: 'Digital' },
];

test('Validadora: solo su unidad y su medio', () => {
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'Biobox', medio: 'Impreso' }), false);
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'Biobox', medio: 'Digital' }), false);
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'Ecovallas', medio: 'Digital' }), true);
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'ecovallas', medio: 'digital' }), true);
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'Ecovallas', medio: 'Impreso' }), false);
  // Con medio en su rol, una incidencia sin medio no cuenta (como la base).
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'Vía Verde', medio: null }), false);
});

test('Sin medio en el rol = los dos medios; sin unidad no cuenta', () => {
  const dulce = [{ rol: 'validador', unidad_negocio: 'Biobox', medio: null }];
  assert.equal(validaEnIncidencia(dulce, { unidad_negocio: 'Biobox', medio: 'Impreso' }), true);
  assert.equal(validaEnIncidencia(dulce, { unidad_negocio: 'Biobox', medio: null }), true);
  assert.equal(validaEnIncidencia(dulce, { unidad_negocio: 'Ecovallas', medio: 'Impreso' }), false);
  const sinUnidad = [{ rol: 'validador', unidad_negocio: null, medio: null }];
  assert.equal(validaEnIncidencia(sinUnidad, { unidad_negocio: 'Biobox', medio: 'Impreso' }), false);
});

test('El manager valida todo; otros roles no', () => {
  assert.equal(validaEnIncidencia([{ rol: 'manager', unidad_negocio: null }], { unidad_negocio: 'Biobox' }), true);
  assert.equal(validaEnIncidencia([{ rol: 'coordinador', unidad_negocio: 'Biobox' }], { unidad_negocio: 'Biobox' }), false);
});
