import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/indicadoresTecnicos.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { tecnicosDe, mediana, reparacionesPorTecnico, avancePorTecnico, periodosDe } =
  await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('Técnicos: solo rol reparación, filtrado por unidad y área (fila sin unidad = todas)', () => {
  const personas = [
    { email: 'A@X', nombre: 'Ana', roles: [{ unidad: 'Biobox', area: 'Op. Bio Box', rol: 'reparacion' }] },
    { email: 'b@x', nombre: 'Beto', roles: [{ unidad: null, area: 'TI', rol: 'reparacion' }] },
    { email: 'c@x', nombre: 'Coord', roles: [{ unidad: 'Biobox', area: null, rol: 'coordinador' }] },
    { email: 'd@x', nombre: 'Dora', roles: [{ unidad: 'Ecovallas', area: 'Digital', rol: 'reparacion' }, { unidad: 'Biobox', area: 'Digital', rol: 'reparacion' }] },
  ];
  assert.deepEqual(tecnicosDe(personas).map((t) => t.email), ['a@x', 'b@x', 'd@x']);
  assert.deepEqual(tecnicosDe(personas, 'Biobox').map((t) => t.nombre), ['Ana', 'Beto', 'Dora']);
  assert.deepEqual(tecnicosDe(personas, 'Biobox', 'op. bio box').map((t) => t.nombre), ['Ana']);
  assert.deepEqual(tecnicosDe(personas, 'Ecovallas').map((t) => t.nombre), ['Beto', 'Dora']);
  assert.deepEqual(tecnicosDe(personas).find((t) => t.email === 'd@x').unidades, ['Ecovallas', 'Biobox']);
});

test('Técnicos: reparaciones, rechazadas, apoyos y mediana desde que llegó al área', () => {
  const inc = (id, por, desde, hasta, extra = {}) => ({ record_id: id, repaired_by_email: por, apoyo_reparacion_email: null, sla_reparacion_inicio: desde, repaired_at: hasta, rechazos_reparacion: 0, ...extra });
  const m = reparacionesPorTecnico([
    inc('1', 'Ana@x', '2026-11-01T10:00:00Z', '2026-11-01T12:00:00Z'),
    inc('2', 'ana@x', '2026-11-02T10:00:00Z', '2026-11-02T16:00:00Z', { rechazos_reparacion: 2 }),
    inc('3', 'ana@x', '2026-11-03T10:00:00Z', '2026-11-03T14:00:00Z', { apoyo_reparacion_email: 'Beto@x' }),
    inc('4', 'ana@x', null, '2026-11-03T14:00:00Z'), // sin inicio: no entra al tiempo
    inc('5', 'beto@x', '2026-11-03T10:00:00Z', '2026-11-03T09:00:00Z', { apoyo_reparacion_email: 'beto@x' }), // tiempo negativo y apoyo a sí mismo: fuera
  ]);
  const ana = m.get('ana@x');
  assert.equal(ana.reparadas.length, 4);
  assert.equal(ana.rechazadas.length, 1);
  assert.equal(ana.medianaH, 4); // 2, 6 y 4 h
  const beto = m.get('beto@x');
  assert.equal(beto.reparadas.length, 1);
  assert.deepEqual(beto.apoyos.map((i) => i.record_id), ['3']);
  assert.equal(beto.medianaH, null);
  assert.equal(mediana([]), null);
});

test('Técnicos: avance de su ruta, sus visitas y máquinas sin visita en 14 días', () => {
  const ahora = Date.parse('2026-11-18T12:00:00Z');
  const rutasDe = new Map([['ana@x', [1]], ['beto@x', [2, 3]]]);
  const paradas = [
    { ruta_id: 1, site_id: 'A', estatus_archivo: null },
    { ruta_id: 1, site_id: 'B', estatus_archivo: null },
    { ruta_id: 1, site_id: 'X', estatus_archivo: 'RETIRADA' }, // no cuenta
    { ruta_id: 2, site_id: 'C', estatus_archivo: null },
    { ruta_id: 3, site_id: 'C', estatus_archivo: null }, // la misma máquina en dos rutas: una vez
  ];
  const visitas = [
    { site_id: 'A', usuario_email: 'Ana@x', visitado_en: '2026-11-10T10:00:00Z', tipo: 'rapida' },
    { site_id: 'A', usuario_email: 'ana@x', visitado_en: '2026-11-11T10:00:00Z', tipo: 'revision' },
    { site_id: 'C', usuario_email: 'ana@x', visitado_en: '2026-11-12T10:00:00Z', tipo: 'rapida' }, // Ana visitó la de Beto
  ];
  const ultima = new Map([['A', '2026-11-11T10:00:00Z'], ['B', '2026-10-01T10:00:00Z'], ['C', '2026-11-12T10:00:00Z']]);
  const m = avancePorTecnico(rutasDe, paradas, visitas, ultima, ahora);
  assert.deepEqual(m.get('ana@x'), { sitios: ['A', 'B'], visitados: ['A'], rapidas: 2, revisiones: 1, sinVisita: ['B'] });
  // La visita de Ana cuenta para el avance de la ruta de Beto (regla de Avance de visitas).
  assert.deepEqual(m.get('beto@x'), { sitios: ['C'], visitados: ['C'], rapidas: 0, revisiones: 0, sinVisita: [] });
});

test('Periodos: semanas de lunes a domingo y meses, el actual primero', () => {
  const ahora = new Date(2026, 10, 18, 15, 0); // miércoles 18-nov-2026
  const sem = periodosDe('semana', ahora, 3);
  assert.equal(sem.length, 3);
  assert.deepEqual([sem[0].desde.getDate(), sem[0].hasta.getDate()], [16, 23]);
  assert.equal(sem[0].etiqueta, 'Semana del 16 al 22 nov (esta semana)');
  assert.equal(sem[2].etiqueta, 'Semana del 2 al 8 nov');
  // Semana que cruza de mes.
  const cruce = periodosDe('semana', new Date(2026, 11, 2), 1)[0];
  assert.equal(cruce.etiqueta, 'Semana del 30 nov al 6 dic (esta semana)');
  const mes = periodosDe('mes', ahora, 13);
  assert.equal(mes[0].etiqueta, 'Noviembre 2026 (este mes)');
  assert.deepEqual([mes[0].desde.getDate(), mes[0].hasta.getMonth()], [1, 11]);
  assert.equal(mes[12].etiqueta, 'Noviembre 2025');
  assert.ok(new Set(mes.map((m) => m.clave)).size === 13);
});
