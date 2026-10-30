import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// avisoNuc.ts importa constants/helpers: se empaqueta en memoria.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/avisoNuc.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const {
  esDigitalNuc, esTecnicoNuc, unidadesAvisoNuc, maquinasDeInventario, estadoNuc,
  contarEstados, ordenarTablero, haceCuanto, pendientesNuc, coincideMaquina,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const rol = (r, unidad = null, dep = null) => ({ rol: r, unidad_negocio: unidad, departamento: dep });

test('Digital es el técnico con área Digital de cualquier unidad, o el manager', () => {
  assert.equal(esDigitalNuc([rol('reparacion', 'Vía Verde', 'Digital')]), true);
  assert.equal(esDigitalNuc([rol('reparacion', 'Ecovallas', ' digital ')]), true);
  assert.equal(esDigitalNuc([rol('manager')]), true);
  assert.equal(esDigitalNuc([rol('reportante', 'Biobox', 'Digital')]), false);
  assert.equal(esDigitalNuc([rol('reparacion', 'Biobox', 'Op. Bio Box')]), false);
});

test('Técnico de la máquina: Op. Bio Box o coordinador de esa unidad', () => {
  const tec = [rol('reparacion', 'Biobox', 'Op. Bio Box')];
  assert.equal(esTecnicoNuc(tec, 'Biobox'), true);
  assert.equal(esTecnicoNuc(tec, 'Biobox Perú'), false);
  assert.equal(esTecnicoNuc([rol('reparacion', null, 'Op. Bio Box')], 'Biobox Perú'), true);
  assert.equal(esTecnicoNuc([rol('coordinador', 'Biobox')], 'Biobox'), true);
  assert.equal(esTecnicoNuc([rol('coordinador', 'Biobox', 'Op. Bio Box')], 'Biobox'), true);
  assert.equal(esTecnicoNuc([rol('coordinador', 'Biobox', 'TI')], 'Biobox'), false);
  assert.equal(esTecnicoNuc([rol('reparacion', 'Biobox', 'TI')], 'Biobox'), false);
  assert.equal(esTecnicoNuc([rol('reparacion', 'Vía Verde', 'Digital')], 'Biobox'), false);
  assert.equal(esTecnicoNuc([rol('manager')], 'Biobox Perú'), true);
});

test('Unidades del tablero según el rol', () => {
  assert.deepEqual(unidadesAvisoNuc([rol('reparacion', 'Vía Verde', 'Digital')]), ['Biobox', 'Biobox Perú']);
  assert.deepEqual(unidadesAvisoNuc([rol('viewer')]), ['Biobox', 'Biobox Perú']);
  assert.deepEqual(unidadesAvisoNuc([rol('reparacion', 'Biobox', 'Op. Bio Box')]), ['Biobox']);
  assert.deepEqual(unidadesAvisoNuc([rol('coordinador', 'Biobox', 'Operaciones')]), ['Biobox']);
  assert.deepEqual(unidadesAvisoNuc([rol('reportante', 'Biobox', 'Operaciones')]), []);
  assert.deepEqual(unidadesAvisoNuc([rol('reparacion', 'Biobox', 'TI')]), []);
  // Validador: solo con la unidad exacta (Erik, 29-oct-2026).
  assert.deepEqual(unidadesAvisoNuc([rol('validador', 'Biobox', 'Operaciones')]), ['Biobox']);
  assert.deepEqual(unidadesAvisoNuc([rol('validador', 'Ecovallas', 'Operaciones')]), []);
  assert.deepEqual(unidadesAvisoNuc([rol('validador', null, null)]), []);
});

test('Una máquina por sitio, con el nombre de la cara digital', () => {
  const base = { vendor_face_id: null, unidad_negocio: 'Biobox', tipo_mueble: 'M4', direccion: 'Horacio', municipio: null };
  const maq = maquinasDeInventario([
    { ...base, site_id: 'S1', site_legacy_id: 'Impresa 1', tipo_medio: 'Impreso' },
    { ...base, site_id: 'S1', site_legacy_id: 'Digital 1', tipo_medio: 'Digital' },
    { ...base, site_id: 'S2', site_legacy_id: null, tipo_medio: 'Impreso' },
    { ...base, site_id: null, site_legacy_id: 'sin sitio', tipo_medio: 'Digital' },
  ]);
  assert.equal(maq.length, 2);
  assert.equal(maq.find((m) => m.site_id === 'S1').nombre, 'Digital 1');
  assert.equal(maq.find((m) => m.site_id === 'S2').nombre, 'S2');
});

test('Sin aviso abierto la máquina está en línea', () => {
  assert.equal(estadoNuc(undefined), 'en_linea');
  assert.equal(estadoNuc({ estado: 'en_linea' }), 'en_linea');
  assert.equal(estadoNuc({ estado: 'en_revision' }), 'en_revision');
});

test('El tablero pone primero la fuera de línea más vieja y cuenta por estado', () => {
  const maq = ['A', 'B', 'C', 'D', 'E', 'F'].map((s) => ({ site_id: s, nombre: 'Máquina ' + s }));
  const avisos = new Map([
    ['B', { estado: 'en_revision', actualizado_en: '2026-10-29T10:00:00Z' }],
    ['C', { estado: 'fuera_linea', actualizado_en: '2026-10-29T12:00:00Z' }],
    ['D', { estado: 'fuera_linea', actualizado_en: '2026-10-29T09:00:00Z' }],
    ['E', { estado: 'en_revision', actualizado_en: '2026-10-29T08:00:00Z' }],
  ]);
  assert.deepEqual(ordenarTablero(maq, avisos).map((m) => m.site_id), ['D', 'C', 'E', 'B', 'A', 'F']);
  assert.deepEqual(contarEstados(maq, avisos), { fuera_linea: 2, en_revision: 2, en_linea: 2 });
  // Las en línea van por clave del mueble, no por nombre (Erik, 29-oct-2026).
  const porClave = [
    { site_id: 'MX_CM_BB_MED_0117', nombre: 'A LA SALLE' },
    { site_id: 'MX_CM_BB_MED_0087', nombre: 'Z INSURGENTES Y LA PAZ' },
  ];
  assert.deepEqual(ordenarTablero(porClave, new Map()).map((m) => m.site_id), ['MX_CM_BB_MED_0087', 'MX_CM_BB_MED_0117']);
});

test('Tiempo transcurrido legible', () => {
  const ahora = Date.parse('2026-10-29T12:00:00Z');
  assert.equal(haceCuanto('2026-10-29T11:59:40Z', ahora), 'hace un momento');
  assert.equal(haceCuanto('2026-10-29T11:35:00Z', ahora), 'hace 25 min');
  assert.equal(haceCuanto('2026-10-29T09:45:00Z', ahora), 'hace 2 h 15 min');
  assert.equal(haceCuanto('2026-10-29T10:00:00Z', ahora), 'hace 2 h');
  assert.equal(haceCuanto('2026-10-27T11:00:00Z', ahora), 'hace 2 días');
  assert.equal(haceCuanto(null, ahora), '');
});

test('Número del menú: al técnico lo abierto de su unidad, a Digital lo que nadie revisa', () => {
  const avisos = [
    { estado: 'fuera_linea', unidad_negocio: 'Biobox' },
    { estado: 'fuera_linea', unidad_negocio: 'Biobox Perú' },
    { estado: 'en_revision', unidad_negocio: 'Biobox' },
  ];
  assert.equal(pendientesNuc(avisos, [rol('reparacion', 'Biobox', 'Op. Bio Box')]), 2);
  assert.equal(pendientesNuc(avisos, [rol('reparacion', 'Vía Verde', 'Digital')]), 2);
  assert.equal(pendientesNuc(avisos, [rol('manager')]), 3);
  assert.equal(pendientesNuc(avisos, [rol('validador', 'Biobox', 'Operaciones')]), 2);
  assert.equal(pendientesNuc(avisos, [rol('validador', 'Biobox', 'Operaciones'), rol('reparacion', 'Biobox', 'Op. Bio Box')]), 2);
  assert.equal(pendientesNuc(avisos, [rol('viewer')]), 0);
});

test('Búsqueda por nombre, clave o dirección sin acentos', () => {
  const m = { site_id: 'MX_CM_BB_MED_0022', nombre: 'BB022', direccion: 'Paseo de las Palmas', municipio: 'Miguel Hidalgo' };
  assert.equal(coincideMaquina(m, 'med_0022'), true);
  assert.equal(coincideMaquina(m, 'hidalgo'), true);
  assert.equal(coincideMaquina(m, 'palmás'), true);
  assert.equal(coincideMaquina(m, 'horacio'), false);
  assert.equal(coincideMaquina(m, '  '), true);
});
