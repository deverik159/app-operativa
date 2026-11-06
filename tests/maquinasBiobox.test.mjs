import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/maquinasBiobox.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { fueraDeLinea, maquinasUnicas, indicadoresMaquinas, pendienteRevision, abreMaquinasBiobox } = await import(
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

// Quién abre Máquinas Biobox (Erik, 6-nov-2026): técnicos y coordinadores de
// Op. Bio Box, coordinadores de Biobox sin área y el manager. Casos tomados de
// las filas reales de producción de ese día.
const fila = (rol, unidad_negocio, departamento = null) => ({ rol, unidad_negocio, departamento });

test('Máquinas Biobox: entran el manager, Op. Bio Box y el coordinador de Biobox sin área', () => {
  assert.equal(abreMaquinasBiobox([fila('manager', null)]), true);
  // Técnico de ruta: reportante de Operaciones + técnico de Op. Bio Box.
  assert.equal(abreMaquinasBiobox([fila('reportante', 'Biobox', 'Operaciones'), fila('reparacion', 'Biobox', 'Op. Bio Box')]), true);
  assert.equal(abreMaquinasBiobox([fila('reparacion', 'Biobox Perú', 'Op. Bio Box')]), true);
  assert.equal(abreMaquinasBiobox([fila('reparacion', null, ' op. bio box ')]), true);
  assert.equal(abreMaquinasBiobox([fila('coordinador', 'Biobox', 'Op. Bio Box')]), true);
  assert.equal(abreMaquinasBiobox([fila('coordinador', 'Biobox', null)]), true);
});

test('Máquinas Biobox: un técnico de Digital o TI de todas las unidades ya no entra', () => {
  assert.equal(abreMaquinasBiobox([fila('reparacion', null, 'Digital')]), false);
  assert.equal(abreMaquinasBiobox([fila('reparacion', null, 'TI')]), false);
  assert.equal(abreMaquinasBiobox([fila('reportante', null, 'SRD'), fila('reparacion', null, 'Digital')]), false);
  // Ni el técnico de Digital de la unidad Biobox, ni otras áreas técnicas de Biobox.
  assert.equal(abreMaquinasBiobox([fila('reparacion', 'Biobox', 'Digital')]), false);
  assert.equal(abreMaquinasBiobox([fila('reparacion', 'Biobox', 'Iluminación'), fila('validador', 'Biobox', 'Operaciones')]), false);
});

test('Máquinas Biobox: coordinadores de otra área, reportantes y Consulta no entran', () => {
  assert.equal(abreMaquinasBiobox([fila('coordinador', 'Biobox', 'Digital'), fila('reparacion', null, 'Digital')]), false);
  assert.equal(abreMaquinasBiobox([fila('coordinador', null, 'Digital')]), false);
  assert.equal(abreMaquinasBiobox([fila('coordinador', null, null)]), false);
  assert.equal(abreMaquinasBiobox([fila('reportante', 'Biobox', 'Monitoreo'), fila('analista', 'Biobox')]), false);
  assert.equal(abreMaquinasBiobox([fila('reportante', 'Biobox', 'MKT')]), false);
  assert.equal(abreMaquinasBiobox([fila('viewer', 'Biobox')]), false);
  assert.equal(abreMaquinasBiobox([fila('fijador', 'Biobox')]), false);
  // Op. Bio Box en una fila de otra unidad no cuenta.
  assert.equal(abreMaquinasBiobox([fila('reparacion', 'Ecovallas', 'Op. Bio Box')]), false);
  // Rol y área de filas distintas no se mezclan.
  assert.equal(abreMaquinasBiobox([fila('reportante', 'Biobox', 'Op. Bio Box'), fila('reparacion', null, 'Digital')]), false);
  assert.equal(abreMaquinasBiobox([]), false);
});
