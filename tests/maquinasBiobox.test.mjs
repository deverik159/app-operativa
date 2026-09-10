import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/maquinasBiobox.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { fueraDeLinea, maquinasUnicas, indicadoresMaquinas, pendienteRevision } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
);

test('Fuera de línea depende solo de Out of Service en inventario', () => {
  assert.equal(fueraDeLinea({ face_status: 'Out of Service', estado_maquina: 'operando' }), true);
  assert.equal(fueraDeLinea({ face_status: ' out of service ' }), true);
  for (const face_status of ['Active', 'Inactive', 'Retired', '', null]) {
    assert.equal(fueraDeLinea({ face_status, estado_maquina: 'fuera_de_linea' }), false);
  }
});

test('Una máquina en dos segmentos se cuenta una vez y abre el mismo detalle', () => {
  const a = { site_id: 'A', face_status: 'Out of Service', navegable: true, medio: 'Digital', dias_sin_revision: null };
  const b = { site_id: 'B', face_status: 'Active', navegable: false, dias_sin_revision: 30, puntos_anomalia: 2 };
  const filas = [a, { ...a, medio: 'Impreso' }, b];
  assert.deepEqual(maquinasUnicas(filas), [a, b]);
  const kpis = indicadoresMaquinas(filas, { B: { abiertas: 3 } });
  assert.deepEqual(kpis.map((k) => [k.id, k.filas.map((u) => u.site_id)]), [
    ['total', ['A', 'B']], ['nunca', ['A']], ['vencidas', ['B']], ['anomalias', ['B']],
    ['incidencias', ['B']], ['fuera', ['A']], ['coordenadas', ['B']],
  ]);
});

test('Guardar una revisión actualiza pendientes y anomalías sin modificar Fuera de línea', () => {
  const antes = { site_id: 'A', face_status: 'Out of Service', navegable: true, dias_sin_revision: 30, puntos_anomalia: 2 };
  const despues = { ...antes, dias_sin_revision: 0, puntos_anomalia: 0, estado_maquina: 'operando' };
  assert.equal(pendienteRevision({ ...antes, dias_sin_revision: null }), true);
  assert.equal(pendienteRevision(antes), true);
  assert.equal(pendienteRevision({ ...antes, dias_sin_revision: 29 }), false);
  assert.equal(pendienteRevision(despues), false);
  const kpis = indicadoresMaquinas([despues], {});
  assert.equal(kpis.find((k) => k.id === 'vencidas').filas.length, 0);
  assert.equal(kpis.find((k) => k.id === 'anomalias').filas.length, 0);
  assert.equal(kpis.find((k) => k.id === 'fuera').filas.length, 1);
});

test('Los indicadores respetan la base filtrada y un cambio de estado al recargar', () => {
  const a = { site_id: 'A', face_status: 'Out of Service', navegable: true };
  assert.equal(indicadoresMaquinas([a], {}).find((k) => k.id === 'fuera').filas.length, 1);
  assert.equal(indicadoresMaquinas([{ ...a, face_status: 'Active' }], {}).find((k) => k.id === 'fuera').filas.length, 0);
  assert.ok(indicadoresMaquinas([], {}).every((k) => k.filas.length === 0));
});
