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
  entraEnTablero, recibeNucOtra, contarPorUnidad, diasFueraDeLinea, diaSiguiente, duracionTexto, respuestasPara,
  nombreSitioDeCaras,
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
  const todas = ['Biobox', 'Biobox Perú', 'Ecovallas', 'Vía Verde'];
  assert.deepEqual(unidadesAvisoNuc([rol('reparacion', 'Vía Verde', 'Digital')]), todas);
  assert.deepEqual(unidadesAvisoNuc([rol('viewer')]), todas);
  assert.deepEqual(unidadesAvisoNuc([rol('reparacion', 'Biobox', 'Op. Bio Box')]), ['Biobox']);
  // El técnico de Op. Bio Box sin unidad no ve Ecovallas ni Vía Verde.
  assert.deepEqual(unidadesAvisoNuc([rol('reparacion', null, 'Op. Bio Box')]), ['Biobox', 'Biobox Perú']);
  assert.deepEqual(unidadesAvisoNuc([rol('coordinador', 'Biobox', 'Operaciones')]), ['Biobox']);
  assert.deepEqual(unidadesAvisoNuc([rol('reportante', 'Biobox', 'Operaciones')]), []);
  assert.deepEqual(unidadesAvisoNuc([rol('reparacion', 'Biobox', 'TI')]), []);
  // Validador: solo con la unidad exacta (Erik, 29-oct-2026).
  assert.deepEqual(unidadesAvisoNuc([rol('validador', 'Biobox', 'Operaciones')]), ['Biobox']);
  assert.deepEqual(unidadesAvisoNuc([rol('validador', 'Ecovallas', 'Operaciones')]), ['Ecovallas']);
  assert.deepEqual(unidadesAvisoNuc([rol('validador', null, null)]), []);
  assert.deepEqual(unidadesAvisoNuc([rol('coordinador', 'Vía Verde')]), ['Vía Verde']);
  // El validador de Impreso de Ecovallas no (Erik, 4-nov-2026); en Biobox el medio no importa.
  const val = (unidad, medio) => ({ rol: 'validador', unidad_negocio: unidad, departamento: null, medio });
  assert.deepEqual(unidadesAvisoNuc([val('Ecovallas', 'Impreso')]), []);
  assert.deepEqual(unidadesAvisoNuc([val('Ecovallas', 'Digital')]), ['Ecovallas']);
  assert.deepEqual(unidadesAvisoNuc([val('Biobox', 'Impreso')]), ['Biobox']);
  // Agregado a mano por el manager (4-nov-2026).
  assert.deepEqual(unidadesAvisoNuc([rol('reportante', 'Ecovallas', 'Monitoreo')], ['Ecovallas', 'Via Verde']), ['Ecovallas', 'Vía Verde']);
});

test('Qué entra al tablero: Biobox todo, Ecovallas pantallas, Vía Verde columnas y pórticos', () => {
  const f = (unidad_negocio, tipo_medio, tipo_mueble) => ({ unidad_negocio, tipo_medio, tipo_mueble });
  assert.equal(entraEnTablero(f('Biobox', 'Impreso', 'M4')), true);
  assert.equal(entraEnTablero(f('Biobox Perú', 'Digital', 'M5')), true);
  assert.equal(entraEnTablero(f('Ecovallas', 'Digital', 'Ecovallas Digital')), true);
  assert.equal(entraEnTablero(f('Ecovallas', 'Impreso', 'Ecovallas Fijas')), false);
  assert.equal(entraEnTablero(f('Vía Verde', 'Digital', 'Columna')), true);
  assert.equal(entraEnTablero(f('Vía Verde', 'Digital', 'Pórticos')), true);
  assert.equal(entraEnTablero(f('Vía Verde', 'Digital', 'Otro')), false);
  assert.equal(entraEnTablero(f('Verde Vertical', 'Digital', 'Columna')), false);
  const maq = maquinasDeInventario([
    { site_id: 'E1', site_legacy_id: null, vendor_face_id: null, unidad_negocio: 'Ecovallas', tipo_medio: 'Impreso', tipo_mueble: 'Ecovallas Fijas', direccion: null, municipio: null },
    { site_id: 'E2', site_legacy_id: null, vendor_face_id: null, unidad_negocio: 'Ecovallas', tipo_medio: 'Digital', tipo_mueble: 'Ecovallas Digital', direccion: null, municipio: null },
  ]);
  assert.deepEqual(maq.map((m) => m.site_id), ['E2']);
});

test('Ecovallas y Vía Verde: reciben coordinador (sin área o Digital), validador y Digital', () => {
  assert.equal(recibeNucOtra([rol('coordinador', 'Ecovallas')], 'Ecovallas'), true);
  assert.equal(recibeNucOtra([rol('coordinador', 'Ecovallas', 'Digital')], 'Ecovallas'), true);
  assert.equal(recibeNucOtra([rol('coordinador', 'Ecovallas', 'Fijación')], 'Ecovallas'), false);
  assert.equal(recibeNucOtra([rol('coordinador', 'Vía Verde')], 'Ecovallas'), false);
  assert.equal(recibeNucOtra([rol('reparacion', 'Vía Verde', 'Digital')], 'Vía Verde'), true);
  assert.equal(recibeNucOtra([rol('reparacion', null, 'Digital')], 'Ecovallas'), true);
  assert.equal(recibeNucOtra([rol('reparacion', 'Vía Verde', 'Digital')], 'Ecovallas'), false);
  assert.equal(recibeNucOtra([rol('reparacion', 'Ecovallas', 'Mantenimiento')], 'Ecovallas'), false);
  // En Biobox manda la regla de siempre (técnico de Op. Bio Box).
  assert.equal(recibeNucOtra([rol('coordinador', 'Biobox')], 'Biobox'), false);
  assert.equal(esTecnicoNuc([rol('reparacion', null, 'Op. Bio Box')], 'Ecovallas'), false);
});

test('Contador del menú con Ecovallas, Vía Verde y agregados a mano', () => {
  const avisos = [
    { estado: 'fuera_linea', unidad_negocio: 'Ecovallas' },
    { estado: 'fuera_linea', unidad_negocio: 'Vía Verde' },
    { estado: 'fuera_linea', unidad_negocio: 'Biobox' },
  ];
  assert.equal(pendientesNuc(avisos, [rol('coordinador', 'Ecovallas')]), 1);
  assert.equal(pendientesNuc(avisos, [rol('validador', 'Vía Verde', 'Operaciones')]), 1);
  assert.equal(pendientesNuc(avisos, [rol('reportante', 'Ecovallas')], ['Ecovallas', 'Biobox']), 2);
  assert.equal(pendientesNuc(avisos, [rol('reparacion', null, 'Digital')]), 3);
});

test('Desglose por unidad de cada estado', () => {
  const maq = [
    { site_id: 'A', unidad_negocio: 'Vía Verde' }, { site_id: 'B', unidad_negocio: 'Vía Verde' },
    { site_id: 'C', unidad_negocio: 'Ecovallas' }, { site_id: 'D', unidad_negocio: 'Biobox' },
    { site_id: 'E', unidad_negocio: 'Biobox' },
  ];
  const av = new Map([['A', { estado: 'fuera_linea' }], ['B', { estado: 'fuera_linea' }], ['C', { estado: 'fuera_linea' }], ['D', { estado: 'fuera_linea' }]]);
  assert.deepEqual(contarPorUnidad(maq, av), {
    fuera_linea: { 'Vía Verde': 2, Ecovallas: 1, Biobox: 1 },
    apagado: {},
    en_linea: { Biobox: 1 },
  });
});

test('Días fuera de línea: horas por día de CDMX y veces que se cayó', () => {
  // CDMX es UTC-6: el 3-nov empieza a las 06:00 UTC.
  const avisos = [
    // 3-nov 10:00 → 3-nov 12:30 (CDMX): 2 h 30 min, 1 caída.
    { abierto_en: '2026-11-03T16:00:00Z', cerrado_en: '2026-11-03T18:30:00Z' },
    // 3-nov 23:00 → 4-nov 01:00 (CDMX): 1 h el 3 y 1 h el 4; cuenta como caída del 3.
    { abierto_en: '2026-11-04T05:00:00Z', cerrado_en: '2026-11-04T07:00:00Z' },
    // 4-nov 08:00 CDMX, sigue abierto: hasta "ahora" (4-nov 10:00 CDMX).
    { abierto_en: '2026-11-04T14:00:00Z', cerrado_en: null },
  ];
  const ahora = Date.parse('2026-11-04T16:00:00Z');
  const d = diasFueraDeLinea(avisos, '2026-11-02', '2026-11-04', ahora);
  assert.deepEqual(d, [
    { dia: '2026-11-02', minutos: 0, apagado: 0, caidas: 0 },
    { dia: '2026-11-03', minutos: 210, apagado: 0, caidas: 2 },
    { dia: '2026-11-04', minutos: 180, apagado: 0, caidas: 1 },
  ]);
  // Un aviso de varios días llena las 24 h del día de en medio.
  const largo = diasFueraDeLinea([{ abierto_en: '2026-11-01T18:00:00Z', cerrado_en: '2026-11-03T18:00:00Z' }], '2026-11-02', '2026-11-02');
  assert.deepEqual(largo, [{ dia: '2026-11-02', minutos: 1440, apagado: 0, caidas: 0 }]);
  assert.deepEqual(diasFueraDeLinea(avisos, '2026-11-05', '2026-11-01'), []);
  assert.deepEqual(diasFueraDeLinea(avisos, 'mal', '2026-11-01'), []);
  assert.equal(diaSiguiente('2026-12-31'), '2027-01-01');
  assert.equal(duracionTexto(210), '3 h 30 min');
  assert.equal(duracionTexto(45), '45 min');
  assert.equal(duracionTexto(1440), '24 h');
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
  assert.equal(estadoNuc({ estado: 'fuera_linea' }), 'fuera_linea');
  // Un aviso viejo «en revisión» (antes del 30-oct) cuenta como fuera de línea.
  assert.equal(estadoNuc({ estado: 'en_revision' }), 'fuera_linea');
});

test('El tablero pone primero la fuera de línea más vieja y cuenta por estado', () => {
  const maq = ['A', 'B', 'C', 'D', 'E', 'F'].map((s) => ({ site_id: s, nombre: 'Máquina ' + s }));
  const avisos = new Map([
    ['B', { estado: 'fuera_linea', actualizado_en: '2026-10-29T10:00:00Z' }],
    ['C', { estado: 'fuera_linea', actualizado_en: '2026-10-29T12:00:00Z' }],
    ['D', { estado: 'fuera_linea', actualizado_en: '2026-10-29T09:00:00Z' }],
    ['E', { estado: 'fuera_linea', actualizado_en: '2026-10-29T08:00:00Z' }],
  ]);
  assert.deepEqual(ordenarTablero(maq, avisos).map((m) => m.site_id), ['E', 'D', 'B', 'C', 'A', 'F']);
  assert.deepEqual(contarEstados(maq, avisos), { fuera_linea: 4, apagado: 0, en_linea: 2 });
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

test('Número del menú: al técnico lo fuera de línea de su unidad, a Digital todo', () => {
  const avisos = [
    { estado: 'fuera_linea', unidad_negocio: 'Biobox' },
    { estado: 'fuera_linea', unidad_negocio: 'Biobox Perú' },
    { estado: 'fuera_linea', unidad_negocio: 'Biobox' },
    { estado: 'en_linea', unidad_negocio: 'Biobox' },
  ];
  assert.equal(pendientesNuc(avisos, [rol('reparacion', 'Biobox', 'Op. Bio Box')]), 2);
  assert.equal(pendientesNuc(avisos, [rol('reparacion', 'Vía Verde', 'Digital')]), 3);
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

test('Sitio apagado: tercer estado, orden y respuesta para encenderlo (4-nov-2026)', () => {
  assert.equal(estadoNuc({ estado: 'apagado' }), 'apagado');
  const maq = [{ site_id: 'A' }, { site_id: 'B' }, { site_id: 'C' }];
  const av = new Map([
    ['A', { estado: 'apagado', actualizado_en: '2026-11-04T10:00:00Z' }],
    ['B', { estado: 'fuera_linea', actualizado_en: '2026-11-04T11:00:00Z' }],
  ]);
  assert.deepEqual(contarEstados(maq, av), { fuera_linea: 1, apagado: 1, en_linea: 1 });
  // Primero fuera de línea, luego apagado, al final en línea.
  assert.deepEqual(ordenarTablero(maq, av).map((m) => m.site_id), ['B', 'A', 'C']);
  assert.equal(respuestasPara('apagado')[0], 'Se encendió el sitio');
  assert.equal(respuestasPara('fuera_linea').includes('Se encendió el sitio'), false);
  // El apagado cuenta como pendiente en el menú.
  assert.equal(pendientesNuc([{ estado: 'apagado', unidad_negocio: 'Biobox' }], [rol('reparacion', 'Biobox', 'Op. Bio Box')]), 1);
});

test('Gráfico: lo de antes del apagado es fuera de línea; lo de después, apagado', () => {
  // 3-nov CDMX: cae 08:00, se marca apagado 10:00, se enciende 15:00.
  const d = diasFueraDeLinea([{
    abierto_en: '2026-11-03T14:00:00Z', apagado_en: '2026-11-03T16:00:00Z', cerrado_en: '2026-11-03T21:00:00Z',
  }], '2026-11-03', '2026-11-03');
  assert.deepEqual(d, [{ dia: '2026-11-03', minutos: 120, apagado: 300, caidas: 1 }]);
  // Sigue apagado: cuenta hasta "ahora", y al día siguiente es todo apagado.
  const ahora = Date.parse('2026-11-04T18:00:00Z'); // 4-nov 12:00 CDMX
  const sigue = diasFueraDeLinea([{
    abierto_en: '2026-11-03T14:00:00Z', apagado_en: '2026-11-03T16:00:00Z', cerrado_en: null,
  }], '2026-11-03', '2026-11-04', ahora);
  assert.deepEqual(sigue, [
    { dia: '2026-11-03', minutos: 120, apagado: 840, caidas: 1 },
    { dia: '2026-11-04', minutos: 0, apagado: 720, caidas: 0 },
  ]);
});

test('Ecovallas: el nombre del sitio sale de sus pantallas, sin el «1/4» de la cara', () => {
  assert.equal(nombreSitioDeCaras(['Andres Bello (Hotel Presidente) 218 1/4', 'Andres Bello (Hotel Presidente) 218 2/4']), 'Andres Bello (Hotel Presidente) 218');
  assert.equal(nombreSitioDeCaras(['Río Magdalena', 'San Jeronimo', 'Río Magdalena']), 'Río Magdalena · San Jeronimo');
  assert.equal(nombreSitioDeCaras(['Av. Juárez 95 1/2 Reforma', 'Av. Juárez 95 2/2 Juarez']), 'Av. Juárez 95 Reforma · Av. Juárez 95 Juarez');
  assert.equal(nombreSitioDeCaras(['Reforma 350']), 'Reforma 350');
  assert.equal(nombreSitioDeCaras([null, '']), '');
  const cara = (id, sitio) => ({ site_id: sitio, site_legacy_id: '', vendor_face_id: id, unidad_negocio: 'Ecovallas', tipo_medio: 'Digital', tipo_mueble: 'Ecovallas Digital', direccion: null, municipio: null });
  const maq = maquinasDeInventario(
    [cara('F1', 'E1'), cara('F2', 'E1'), cara('F3', 'E2')],
    new Map([['F1', 'Tecamachalco 1/2'], ['F2', 'Tecamachalco 2/2']])
  );
  assert.deepEqual(maq.map((m) => [m.site_id, m.nombre]), [['E1', 'Tecamachalco'], ['E2', 'E2']]);
});
