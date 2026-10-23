// Pruebas de src/lib/bitacoraComp.ts (Comprobaciones, fase 2, 23-oct-2026):
// lector de la BITÁCORA comercial, Vía Verde desde Pauta VV y el plano, y
// el alta manual. Las hojas tienen la FORMA de la exportación real de Pauta
// VV (BitacoraVVView.tsx, exportarExcel) y de variantes que pueden traer
// Ecovallas y Biobox, con clientes, campañas y personas INVENTADOS: el repo
// es público y los Excel nunca entran aquí.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/bitacoraComp.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const B = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

// sheet_to_json deja las fechas en la medianoche LOCAL: así se arman aquí.
const D = (a, m, d) => new Date(a, m - 1, d);

const CLAVES_CAMPANA = ['fuente', 'origen_ref', 'cliente', 'campana', 'version', 'vendedor', 'administrador', 'quantum', 'mediamonitor',
  'especificacion', 'arte', 'inicio', 'fin', 'es_full', 'full_minutos', 'analista_email', 'sitios'].sort();
const CLAVES_SITIO = ['sitio_clave', 'sitio_original', 'espacio_vv', 'inicio', 'fin', 'horario_lv', 'horario_sd', 'tipo_venta', 'testigos',
  'observaciones'].sort();
/** Cada entrada cumple el contrato de comp_cargar_campanas: ni una llave de más ni de menos. */
const cumpleContrato = (cs) => {
  for (const c of cs) {
    assert.deepEqual(Object.keys(c).sort(), CLAVES_CAMPANA, c.campana);
    for (const s of c.sitios) assert.deepEqual(Object.keys(s).sort(), CLAVES_SITIO, s.sitio_clave);
  }
};

const ENC_VV = ['ID COLUMNA', 'TIPO', 'UBICACIÓN', 'CAMPAÑA', 'TIPO (VENTA O BONUS)', 'VERSION', 'INICIO', 'FIN',
  'HORARIO LUNES A VIERNES', 'HORARIO SABADO Y DOMINGO', 'TESTIGOS', 'OBSERVACIONES', 'ESTATUS'];

/** Hoja con la forma EXACTA de la exportación de Pauta VV (texto en todas las celdas). */
const hojaPautaVV = (nombre, cab, filas) => ({
  nombre,
  filas: [
    ['CLIENTE', cab.cliente, ...Array(11).fill(null)],
    ['CAMPAÑA', cab.campana, ...Array(11).fill(null)],
    ['VENDEDOR', cab.vendedor, '', 'ADMINISTRADOR', cab.administrador, ...Array(8).fill(null)],
    ['FECHA INICIO', cab.inicio, '', 'FECHA FIN', cab.fin, ...Array(8).fill(null)],
    ['MEDIAMONITOR', cab.mediamonitor, '', 'QUANTUM', cab.quantum ?? '', ...Array(8).fill(null)],
    ['ESPECIFICACIONES DE TOMAS', cab.espec ?? '', ...Array(11).fill(null)],
    Array(13).fill(null),
    ENC_VV,
    ...filas,
  ],
});

const CAB = { cliente: 'TIENDAS DEL VALLE', campana: 'OTOÑO PRUEBA', vendedor: 'Ana Prueba', administrador: 'Beto Ejemplo', inicio: '2026-10-15', fin: '2026-10-31', mediamonitor: 'SI' };
const fVV = (id, version, ini, fin, testigos = 'NO', extra = {}) => [
  id, 'B', 'CDMX', 'OTOÑO PRUEBA', extra.tv ?? 'VENTA', version, ini, fin,
  extra.lv ?? '02:00 - 09:59HRS', extra.sd ?? '02:00 - 09:59HRS', testigos, extra.obs ?? '', 'Por programar',
];

// ------------------------------------------------------------
// Claves
// ------------------------------------------------------------

test('claveDeSitio: la clave corta de Vía Verde pasa a la forma de inventario', () => {
  const k = (t, u = 'Vía Verde') => B.claveDeSitio(t, u);
  assert.deepEqual(k('856'), { clave: 'MX_CM_VV_COL_856', espacioVV: '856', medio: 'Columna', edoMex: false, cambios: [] });
  assert.equal(k('0448').clave, 'MX_CM_VV_COL_448');
  assert.deepEqual(k('0448').cambios, ['ceros']);
  assert.equal(k('COL 551').clave, 'MX_CM_VV_COL_551');
  assert.deepEqual(k('POR_0008'), { clave: 'MX_CM_VV_POR_0008', espacioVV: 'POR_0008', medio: 'Pórtico', edoMex: false, cambios: ['alias_portico'] });
  assert.equal(k('POR_00015').clave, 'MX_CM_VV_POR_0015');
  assert.deepEqual(k('A04'), { clave: 'MX_EM_VV_COL_A04', espacioVV: 'A04', medio: 'Columna', edoMex: true, cambios: [] });
  assert.equal(k('MX_CM_VV_COL_0661').espacioVV, '661');
  // En Ecovallas y Biobox un número suelto NO es una columna.
  assert.equal(k('856', 'Biobox').clave, '856');
  assert.equal(k('MX_CM_BB_MED_ 0114', 'Biobox').clave, 'MX_CM_BB_MED_0114');
  assert.equal(k('MX_CM_EV_MGP_16_3606   ', 'Ecovallas').medio, 'Pantalla');
  for (const nada of [null, '', '  ', '#N/A']) assert.equal(k(nada).clave, null);
});

test('leerSiNo y leerTipoVenta', () => {
  assert.equal(B.leerSiNo('SI'), true);
  assert.equal(B.leerSiNo('Sí'), true);
  assert.equal(B.leerSiNo('x'), true);
  assert.equal(B.leerSiNo('NO'), false);
  assert.equal(B.leerSiNo(''), null);
  assert.equal(B.leerSiNo('TAL VEZ'), null);
  assert.equal(B.leerTipoVenta('VENTA'), 'VENTA');
  assert.equal(B.leerTipoVenta('Bonificación'), 'BONUS');
  assert.equal(B.leerTipoVenta('BONUS'), 'BONUS');
  assert.equal(B.leerTipoVenta('INTERCAMBIO'), null);
});

test('rangoPeriodo: mes calculado; catorcena solo con sus fechas', () => {
  assert.deepEqual(B.rangoPeriodo({ tipo: 'mes', anio: 2026, numero: 2 }), { inicio: '2026-02-01', fin: '2026-02-28' });
  assert.deepEqual(B.rangoPeriodo({ tipo: 'mes', anio: 2028, numero: 2 }), { inicio: '2028-02-01', fin: '2028-02-29' });
  assert.equal(B.rangoPeriodo({ tipo: 'catorcena', anio: 2026, numero: 18 }), null);
  assert.deepEqual(B.rangoPeriodo({ tipo: 'catorcena', anio: 2026, numero: 18, inicio: '2026-09-01', fin: '2026-09-14' }), { inicio: '2026-09-01', fin: '2026-09-14' });
});

// ------------------------------------------------------------
// leerBitacora
// ------------------------------------------------------------

test('leerBitacora: la exportación de Pauta VV da una entrada por versión con la vigencia de cada sitio', () => {
  const hoja = hojaPautaVV('BITACORA', CAB, [
    fVV('856', 'OTONO_UNO', '2026-10-15', '2026-10-31', 'NO'),
    fVV('856', 'OTONO_DOS', '2026-10-21', '2026-10-22', 'SI'),
    fVV('856', 'OTONO_TRES', '2026-10-23', '2026-10-31', 'SI'),
  ]);
  const r = B.leerBitacora({ hojas: [hoja] }, { unidad: 'Vía Verde', medio: 'Columna', archivo: 'BITACORA_PRUEBA.xlsx' });
  cumpleContrato(r.campanas);
  assert.deepEqual(r.avisos, []);
  assert.equal(r.campanas.length, 3);
  const [uno, dos] = r.campanas;
  assert.deepEqual({ ...uno, sitios: undefined }, {
    fuente: 'bitacora', origen_ref: 'BITACORA_PRUEBA.xlsx · BITACORA', cliente: 'TIENDAS DEL VALLE', campana: 'OTOÑO PRUEBA',
    version: 'OTONO_UNO', vendedor: 'Ana Prueba', administrador: 'Beto Ejemplo', quantum: null, mediamonitor: true,
    especificacion: null, arte: null, inicio: '2026-10-15', fin: '2026-10-31', es_full: false, full_minutos: null,
    analista_email: null, sitios: undefined,
  });
  assert.deepEqual(dos.sitios, [{
    sitio_clave: 'MX_CM_VV_COL_856', sitio_original: '856', espacio_vv: '856', inicio: '2026-10-21', fin: '2026-10-22',
    horario_lv: '02:00 - 09:59HRS', horario_sd: '02:00 - 09:59HRS', tipo_venta: 'VENTA', testigos: true, observaciones: null,
  }]);
  assert.equal(dos.inicio, '2026-10-21');
  assert.equal(dos.fin, '2026-10-22');
  // El mismo libro, con el medio Pórtico: nada que cargar y se dice por qué.
  const p = B.leerBitacora({ hojas: [hoja] }, { unidad: 'Vía Verde', medio: 'Pórtico' });
  assert.equal(p.campanas.length, 0);
  assert.deepEqual(p.otroMedio, [{ medio: 'Columna', sitios: 1 }]);
});

test('leerBitacora tolera variantes: etiquetas distintas, columnas de más, claves sucias, Date, un solo HORARIO', () => {
  // Forma probable de Ecovallas Digital: título arriba, etiquetas con «:»,
  // columnas extra (PLAZA, MEDIDA) y el orden cambiado.
  const filas = [
    ['BITÁCORA DE CAMPAÑA', null, null, null, null, null, null, null, null, null],
    ['CLIENTE: CAFÉ DE PRUEBA', null, null, null, null, null, null, null, null, null],
    ['Campaña', 'AROMA PRUEBA ', null, 'Vendedora', 'Carla Inventada', null, null, null, null, null],
    ['Fecha de inicio', D(2026, 9, 1), null, 'Fecha de fin', D(2026, 9, 14), null, null, null, null, null],
    ['Media Monitor', 'NO', null, 'Quantum', 'Q-123', null, null, null, null, null],
    ['Especificaciones', 'TOMAS MEDIAS. INICIO Y FIN', null, null, null, null, null, null, null, null],
    [],
    ['PLAZA', 'CLAVE', 'MEDIDA', 'Versión', 'Fecha Inicio', 'Fecha Fin', 'Horario', 'Tipo de venta', 'Testigos', 'Observaciones'],
    ['CDMX', 'MX_CM_EV_MGP_16_3606     ', '1440x405', 'V1 AROMA', D(2026, 9, 1), D(2026, 9, 14), '24 HRS', 'VENTA', 'x', null],
    ['CDMX', 'MX_CM_EV_MGP_01_02920', '1152x324', 'V1 AROMA', D(2026, 9, 1), D(2026, 9, 7), '3:00 PM A 4:59 PM', 'BONIFICACIÓN', null, 'SOLO CÁMARAS'],
    // El mismo sitio otra vez en la misma versión y con la MISMA vigencia:
    // VENTA + BONUS se juntan (con otra vigencia irían como otro tramo).
    ['CDMX', 'MX_CM_EV_MGP_01_2920', '1152x324', 'V1 AROMA', D(2026, 9, 1), D(2026, 9, 7), '3:00 PM A 4:59 PM', 'VENTA', 'SI', 'CAMBIO DE ARTE'],
    ['CDMX', null, null, 'V1 AROMA', D(2026, 9, 1), null, null, null, null, null],
    ['CDMX', 'MX_CM_EV_MGP_99_0001', null, 'V2 AROMA', null, null, 'CUANDO SE PUEDA', 'CORTESÍA', 'NO', null],
    ['TOTAL', null, null, null, null, null, null, null, null, null],
  ];
  const r = B.leerBitacora(
    { hojas: [{ nombre: 'AROMA', filas }, { nombre: 'Hoja oculta', oculta: true, filas: [['x']] }, { nombre: 'Notas', filas: [['NADA QUE VER']] }] },
    { unidad: 'Ecovallas', medio: 'Pantalla', inventario: ['MX_CM_EV_MGP_16_3606', 'MX_CM_EV_MGP_01_2920'] },
  );
  cumpleContrato(r.campanas);
  assert.equal(r.campanas.length, 2);
  const [v1, v2] = r.campanas;
  assert.equal(v1.cliente, 'CAFÉ DE PRUEBA');
  assert.equal(v1.campana, 'AROMA PRUEBA');
  assert.equal(v1.vendedor, 'Carla Inventada');
  assert.equal(v1.mediamonitor, false);
  assert.equal(v1.quantum, 'Q-123');
  assert.equal(v1.especificacion, 'TOMAS MEDIAS. INICIO Y FIN');
  assert.equal(v1.version, 'V1 AROMA');
  assert.deepEqual([v1.inicio, v1.fin], ['2026-09-01', '2026-09-14']);
  assert.deepEqual(v1.sitios.map((s) => s.sitio_clave), ['MX_CM_EV_MGP_16_3606', 'MX_CM_EV_MGP_01_2920']);
  const [a, b] = v1.sitios;
  assert.equal(a.horario_lv, '24 HRS');
  assert.equal(a.horario_sd, '24 HRS');
  assert.equal(a.testigos, true);
  assert.deepEqual([b.inicio, b.fin, b.tipo_venta, b.testigos], ['2026-09-01', '2026-09-07', 'VENTA', true]);
  assert.equal(b.observaciones, 'SOLO CÁMARAS · CAMBIO DE ARTE');
  assert.equal(b.sitio_original, 'MX_CM_EV_MGP_01_02920');
  // Sin vigencia propia: null (la base usa la de la campaña), y el tipo de
  // venta que no se entiende queda en observaciones.
  assert.deepEqual([v2.sitios[0].inicio, v2.sitios[0].fin, v2.sitios[0].tipo_venta, v2.sitios[0].observaciones], [null, null, null, 'CORTESÍA']);
  assert.deepEqual([v2.inicio, v2.fin], ['2026-09-01', '2026-09-14']);
  assert.deepEqual(r.descartadas, [{ hoja: 'AROMA', fila: 12, motivo: 'sin clave de sitio' }]);
  assert.deepEqual(r.clavesCorregidas.map((c) => [c.fila, c.clave, c.cambios]), [
    [9, 'MX_CM_EV_MGP_16_3606', ['espacios']],
    [10, 'MX_CM_EV_MGP_01_2920', ['ceros']],
  ]);
  assert.deepEqual(r.sinInventario, [{ clave: 'MX_CM_EV_MGP_99_0001', hoja: 'AROMA', filas: [13] }]);
  assert.deepEqual(r.hojasIgnoradas, ['Hoja oculta', 'Notas']);
  assert.ok(r.avisos.some((x) => /CUANDO SE PUEDA/.test(x)), 'avisa el horario que no entiende');
  assert.ok(r.avisos.some((x) => /no están en el inventario/.test(x)));
});

test('leerBitacora en Vía Verde: EDO MEX, inactivas, pórticos aparte, FULL «TODAS» y celdas combinadas', () => {
  const hoja = hojaPautaVV('FULL', { ...CAB, campana: 'FULL BANCO PRUEBA', inicio: '2026-08-01', fin: '2026-08-31' }, [
    fVV('TODAS', '13 DE AGOSTO', '2026-08-13', '2026-08-13', 'NO', { lv: '19:00 - 19:50', sd: '' }),
    fVV('0448', 'GENERAL', '2026-08-01', '2026-08-31'),
    fVV(null, null, '2026-08-01', '2026-08-31'), // la versión viene combinada con la fila de arriba
    fVV('A04', 'GENERAL', '2026-08-01', '2026-08-31'),
    fVV('646', 'GENERAL', '2026-08-01', '2026-08-31'),
    fVV('POR_0015', 'GENERAL', '2026-08-01', '2026-08-31'),
  ]);
  for (const f of hoja.filas.slice(8)) f[3] = 'FULL BANCO PRUEBA';
  // La fila 11 (índice 10) trae la clave 551 escrita bajo la combinación.
  hoja.filas[10][0] = '551';
  hoja.merges = [{ s: { r: 9, c: 5 }, e: { r: 10, c: 5 } }];
  const ctx = { unidad: 'Vía Verde', medio: 'Columna', espaciosVV: [
    { clave: '448', activo: true, tramo: 'CDMX' }, { clave: '551', activo: true, tramo: 'CDMX' },
    { clave: '646', activo: false, tramo: 'CDMX' }, { clave: 'POR_0015', activo: true, tramo: null },
  ] };
  const r = B.leerBitacora({ hojas: [hoja] }, ctx);
  cumpleContrato(r.campanas);
  assert.deepEqual(r.campanas.map((c) => [c.version, c.es_full, c.full_minutos, c.sitios.map((s) => s.sitio_clave)]), [
    ['13 DE AGOSTO', true, 50, []],
    ['GENERAL', true, null, ['MX_CM_VV_COL_448', 'MX_CM_VV_COL_551']],
  ]);
  assert.deepEqual(r.descartadas.map((d) => [d.fila, d.motivo]), [[12, 'EDO MEX (de baja)'], [13, 'espacio inactivo en vv_espacios']]);
  assert.deepEqual(r.otroMedio, [{ medio: 'Pórtico', sitios: 1 }]);
  const p = B.leerBitacora({ hojas: [hoja] }, { ...ctx, medio: 'Pórtico' });
  assert.deepEqual(p.campanas.map((c) => [c.version, c.sitios.map((s) => [s.sitio_clave, s.espacio_vv])]), [['GENERAL', [['MX_CM_VV_POR_0015', 'POR_0015']]]]);
});

test('leerBitacora: periodo, campaña en dos hojas, hoja sin nombre de campaña y fechas al revés', () => {
  const h1 = hojaPautaVV('PARTE 1', CAB, [fVV('856', 'V1', '2026-10-15', '2026-10-20'), fVV('857', 'V1', '2026-09-01', '2026-09-30')]);
  const h2 = hojaPautaVV('PARTE 2', CAB, [fVV('858', 'v1', '2026-10-25', '2026-10-31'), fVV('859', 'V1', '2026-10-31', '2026-10-01')]);
  const h3 = hojaPautaVV('SIN NOMBRE', { ...CAB, campana: '' }, [fVV('860', 'V9', '2026-10-01', '2026-10-31')]);
  h3.filas[8][3] = ''; // la columna CAMPAÑA del renglón también vacía
  const r = B.leerBitacora({ hojas: [h1, h2, h3] }, { unidad: 'Vía Verde', medio: 'Columna', periodo: { inicio: '2026-10-01', fin: '2026-10-31' } });
  cumpleContrato(r.campanas);
  assert.deepEqual(r.campanas.map((c) => [c.campana, c.version, c.inicio, c.fin, c.sitios.length]), [
    ['OTOÑO PRUEBA', 'V1', '2026-10-15', '2026-10-31', 2],
    ['SIN NOMBRE', 'V9', '2026-10-01', '2026-10-31', 1],
  ]);
  assert.deepEqual(r.descartadas.map((d) => [d.hoja, d.fila, d.motivo]), [
    ['PARTE 1', 10, 'fuera del periodo'],
    ['PARTE 2', 10, 'FIN antes de INICIO'],
  ]);
  assert.ok(r.avisos.some((x) => /más de una hoja/.test(x)));
  assert.ok(r.avisos.some((x) => /SIN NOMBRE.*nombre de la hoja/.test(x)));
  assert.ok(r.avisos.some((x) => /fuera del periodo/.test(x)));
});

test('leerBitacora: un libro que no es bitácora no carga nada y lo dice', () => {
  const r = B.leerBitacora({ hojas: [{ nombre: 'Hoja1', filas: [['FECHA', 'CLAVE', 'CAMPAÑA'], ['x', 'y', 'z']] }] }, { unidad: 'Biobox', medio: 'Máquina' });
  assert.equal(r.campanas.length, 0);
  assert.deepEqual(r.hojasIgnoradas, ['Hoja1']);
  assert.ok(r.avisos.some((x) => /no trae campañas/.test(x)));
});

// ------------------------------------------------------------
// Vía Verde desde la app
// ------------------------------------------------------------

const CAMP_VV = [
  { id: 8, cliente: 'TIENDA EN LÍNEA PRUEBA', nombre: 'CATÁLOGO PRUEBA', vendedor: 'Ana Prueba', administrador: 'Beto Ejemplo', quantum: null,
    fecha_inicio: '2026-09-01', fecha_fin: '2026-10-31', mediamonitor: false, espec_tomas: 'TESTIGOS AL INICIO Y AL FINAL', estatus: 'activa' },
  { id: 9, cliente: 'OTRA', nombre: 'VIEJA', vendedor: null, administrador: null, quantum: null,
    fecha_inicio: '2026-07-01', fecha_fin: '2026-07-31', mediamonitor: false, espec_tomas: null, estatus: 'cerrada' },
];
const pauta = (id, campana_id, espacio, version, inicio, fin, extra = {}) => ({
  id, campana_id, espacio_clave: espacio, tipo_venta: 'VENTA', version, inicio, fin,
  horario_lv: '00:00 - 23:59HRS', horario_sd: '00:00 - 23:59HRS', testigos: true, observaciones: null, estatus: 'programada', ...extra,
});
const PAUTAS_VV = [
  pauta(99, 8, '639', 'R1_UNO / R1_DOS', '2026-09-01', '2026-10-21'),
  pauta(100, 8, '661', 'R1_UNO / R1_DOS', '2026-09-01', '2026-10-21'),
  pauta(101, 8, 'POR_0078', 'R1_UNO / R1_DOS', '2026-09-01', '2026-10-21'),
  pauta(102, 8, '639', 'PRUEBA', '2026-10-22', '2026-10-31', { estatus: 'por_programar' }),
  pauta(103, 8, '639', 'PRUEBA', '2026-10-22', '2026-10-31', { tipo_venta: 'BONUS', observaciones: 'BONUS DE CIERRE' }),
  pauta(104, 9, '639', 'VIEJA', '2026-07-01', '2026-07-31'),
  pauta(105, 8, 'B06', 'PRUEBA', '2026-10-22', '2026-10-31'),
];
const ocup = (id, espacio, campana, extra = {}) => ({
  id, espacio_clave: espacio, slot: 1, campana, negociacion: 'VENTA', convencional: false, inicio: '2026-10-01', fin: '2026-10-31',
  dias: null, horas: [7, 8], estatus: 'vendida', origen: 'plano', plano_mes: '2026-10', ...extra,
});
const OCUP_VV = [
  ocup(1, '639', 'CATALOGO PRUEBA'),                       // ya viene de Pauta VV (mismo nombre, sin acento)
  ocup(2, '700', 'REFRESCO PRUEBA', { dias: [0, 1, 2, 3, 4], horas: [7, 8, 18, 19] }),
  ocup(3, '700', 'REFRESCO PRUEBA', { slot: 2, horas: [20], negociacion: 'BONIFICACION', inicio: '2026-09-20', fin: '2026-10-10' }),
  ocup(4, '701', 'REFRESCO PRUEBA', { negociacion: 'BONIFICACION', dias: [5, 6], horas: [10] }),
  ocup(5, '702', 'APARTADO PRUEBA', { estatus: 'reservada' }),
  ocup(6, '703', 'PLANO VIEJO', { plano_mes: '2026-08' }),  // otro plano: no se duplica
  ocup(7, '704', 'NOVIEMBRE PRUEBA', { inicio: '2026-11-01', fin: '2026-11-30' }),
  ocup(8, 'POR_0092', 'REFRESCO PRUEBA', { origen: 'app', plano_mes: null, horas: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] }),
];

test('desdePautaVV: una entrada por campaña × versión de vv_pautas que toca el periodo, por medio', () => {
  const r = B.desdePautaVV(CAMP_VV, PAUTAS_VV, [], { tipo: 'mes', anio: 2026, numero: 10 });
  cumpleContrato([...r.porMedio.Columna, ...r.porMedio['Pórtico']]);
  assert.deepEqual(r.porMedio.Columna.map((c) => [c.fuente, c.origen_ref, c.campana, c.version, c.inicio, c.fin, c.sitios.map((s) => s.sitio_clave)]), [
    ['pauta_vv', '8', 'CATÁLOGO PRUEBA', 'R1_UNO / R1_DOS', '2026-09-01', '2026-10-21', ['MX_CM_VV_COL_639', 'MX_CM_VV_COL_661']],
    ['pauta_vv', '8', 'CATÁLOGO PRUEBA', 'PRUEBA', '2026-10-22', '2026-10-31', ['MX_CM_VV_COL_639']],
  ]);
  const c = r.porMedio.Columna[0];
  assert.deepEqual([c.cliente, c.vendedor, c.administrador, c.mediamonitor, c.especificacion], ['TIENDA EN LÍNEA PRUEBA', 'Ana Prueba', 'Beto Ejemplo', false, 'TESTIGOS AL INICIO Y AL FINAL']);
  assert.deepEqual(c.sitios[0], {
    sitio_clave: 'MX_CM_VV_COL_639', sitio_original: '639', espacio_vv: '639', inicio: '2026-09-01', fin: '2026-10-21',
    horario_lv: '00:00 - 23:59HRS', horario_sd: '00:00 - 23:59HRS', tipo_venta: 'VENTA', testigos: true, observaciones: null,
  });
  // VENTA + BONUS del mismo espacio y versión: un sitio, manda la venta.
  assert.deepEqual([r.porMedio.Columna[1].sitios[0].tipo_venta, r.porMedio.Columna[1].sitios[0].observaciones], ['VENTA', 'BONUS DE CIERRE']);
  assert.deepEqual(r.porMedio['Pórtico'].map((x) => [x.version, x.sitios.map((s) => s.espacio_vv)]), [['R1_UNO / R1_DOS', ['POR_0078']]]);
  assert.ok(r.avisos.some((x) => /EDO MEX/.test(x) && /B06/.test(x)));
});

test('desdePautaVV: el plano cubre lo que no está en Pauta VV, sin versión, con horario por días', () => {
  const r = B.desdePautaVV(CAMP_VV, PAUTAS_VV, OCUP_VV, { tipo: 'mes', anio: 2026, numero: 10 });
  const plano = r.porMedio.Columna.filter((c) => c.fuente === 'plano');
  cumpleContrato(plano);
  assert.deepEqual(plano.map((c) => [c.campana, c.version, c.origen_ref, c.inicio, c.fin]), [['REFRESCO PRUEBA', '', 'plano 2026-10', '2026-09-20', '2026-10-31']]);
  const [s700, s701] = plano[0].sitios;
  assert.deepEqual(s700, {
    sitio_clave: 'MX_CM_VV_COL_700', sitio_original: '700', espacio_vv: '700', inicio: '2026-09-20', fin: '2026-10-31',
    horario_lv: '07:00 - 08:59 / 18:00 - 20:59', horario_sd: '20:00 - 20:59', tipo_venta: 'VENTA', testigos: null, observaciones: null,
  });
  assert.deepEqual([s701.horario_lv, s701.horario_sd, s701.tipo_venta, s701.observaciones], [null, '10:00 - 10:59', 'BONUS', 'Solo SAB, DOM']);
  // Lo capturado en la app (origen 'app') también cuenta, en su medio.
  const porPlano = r.porMedio['Pórtico'].filter((c) => c.fuente === 'plano');
  assert.deepEqual(porPlano.map((c) => [c.campana, c.origen_ref, c.sitios[0].horario_lv]), [['REFRESCO PRUEBA', 'plano app', '24 HRS']]);
  assert.ok(r.avisos.some((x) => /ya vienen de Pauta VV/.test(x)));
});

test('desdePautaVV: catorcena sin fechas no adivina', () => {
  const r = B.desdePautaVV(CAMP_VV, PAUTAS_VV, [], { tipo: 'catorcena', anio: 2026, numero: 20 });
  assert.equal(r.porMedio.Columna.length, 0);
  assert.ok(r.avisos[0].includes('catorcena'));
});

// ------------------------------------------------------------
// Alta manual
// ------------------------------------------------------------

test('armarAlta: valida, limpia y junta los sitios escogidos', () => {
  const r = B.armarAlta({
    unidad: 'Biobox', medio: 'Máquina', campana: '  JUGOS  PRUEBA ', version: 'V3', cliente: 'BEBIDAS INVENTADAS',
    inicio: '2026-08-01', fin: '2026-08-31', horario_lv: '24 HRS', horario_sd: '24 HRS', tipo_venta: 'VENTA',
    analista_email: ' Analista.Prueba@Ejemplo.test ',
    sitios: ['MX_CM_BB_MED_ 0114', { clave: 'MX_CM_BB_MED_0114', observaciones: 'REPETIDA' }, { clave: 'MX_CM_BB_MEC_0201', inicio: '2026-08-10', fin: '2026-08-20', horario_sd: '10:00 - 12:59' }],
    inventario: ['MX_CM_BB_MED_0114'],
  });
  assert.deepEqual(r.errores, []);
  cumpleContrato([r.campana]);
  assert.deepEqual([r.campana.fuente, r.campana.campana, r.campana.version, r.campana.analista_email], ['manual', 'JUGOS PRUEBA', 'V3', 'analista.prueba@ejemplo.test']);
  assert.deepEqual(r.campana.sitios.map((s) => [s.sitio_clave, s.inicio, s.fin, s.horario_lv, s.horario_sd, s.tipo_venta, s.observaciones]), [
    ['MX_CM_BB_MED_0114', null, null, '24 HRS', '24 HRS', 'VENTA', 'REPETIDA'],
    ['MX_CM_BB_MEC_0201', '2026-08-10', '2026-08-20', '24 HRS', '10:00 - 12:59', 'VENTA', null],
  ]);
  assert.ok(r.avisos.some((x) => /MEC_0201/.test(x)), 'avisa lo que no está en el inventario');
});

test('armarAlta: errores claros y sin entrada cuando algo no cuadra', () => {
  const r = B.armarAlta({ unidad: 'Vía Verde', medio: 'Columna', campana: ' ', inicio: '2026-08-31', fin: '2026-08-01', sitios: ['POR_0008', 'A04', '#N/A'] });
  assert.equal(r.campana, null);
  assert.ok(r.errores.includes('Falta el nombre de la campaña.'));
  assert.ok(r.errores.includes('La fecha de fin va antes que la de inicio.'));
  assert.ok(r.errores.some((x) => /EDO MEX/.test(x)));
  assert.ok(r.errores.some((x) => /ilegible/.test(x)));
  assert.ok(r.errores.some((x) => /no son de Columna: POR_0008/.test(x)));
  assert.ok(r.errores.some((x) => /al menos un sitio/.test(x)));
  // Un FULL sí puede ir sin sitios (las columnas se agregan después).
  const full = B.armarAlta({ unidad: 'Vía Verde', medio: 'Columna', campana: 'FULL PRUEBA', inicio: '2026-08-13', fin: '2026-08-13', es_full: true, full_minutos: 50, sitios: [] });
  assert.deepEqual([full.errores, full.campana.es_full, full.campana.full_minutos, full.campana.version], [[], true, 50, '']);
});

test('repetirCampana: REPITE en el periodo nuevo, sin las vigencias viejas y con la analista como propuesta', () => {
  const { campana } = B.armarAlta({
    unidad: 'Biobox', medio: 'Máquina', campana: 'JUGOS PRUEBA', inicio: '2026-08-01', fin: '2026-08-31', analista_email: 'a@ejemplo.test',
    sitios: [{ clave: 'MX_CM_BB_MED_0114', inicio: '2026-08-05', fin: '2026-08-09', horario_lv: '24 HRS' }],
  });
  const rep = B.repetirCampana(campana, { inicio: '2026-09-01', fin: '2026-09-30' });
  cumpleContrato([rep]);
  assert.deepEqual([rep.arte, rep.fuente, rep.inicio, rep.fin, rep.analista_email], ['REPITE', 'manual', '2026-09-01', '2026-09-30', 'a@ejemplo.test']);
  assert.deepEqual([rep.sitios[0].inicio, rep.sitios[0].fin, rep.sitios[0].horario_lv], [null, null, '24 HRS']);
  assert.equal(campana.sitios[0].inicio, '2026-08-05', 'no toca la original');
});

// ------------------------------------------------------------
// Revisión del 23-oct-2026: un caso por hallazgo
// ------------------------------------------------------------

const XLSX = (await import('xlsx')).default;
const CTX_COL = { unidad: 'Vía Verde', medio: 'Columna', archivo: 'BITACORA_PRUEBA.xlsx', periodo: { inicio: '2026-10-01', fin: '2026-10-31' } };
const leer1 = (filas, ctx = CTX_COL, extra = {}) => B.leerBitacora({ hojas: [{ nombre: 'BITACORA', filas, ...extra }] }, ctx);
const fOct = (id, version, extra = {}) => fVV(id, version, extra.ini ?? '2026-10-01', extra.fin ?? '2026-10-31', 'NO', extra);
const claves = (r) => r.campanas.flatMap((c) => c.sitios.map((s) => s.sitio_clave));

test('dos bloques en una hoja: el encabezado repetido no es una pauta y las etiquetas nuevas cambian la campaña', () => {
  const base = hojaPautaVV('BITACORA', CAB, [fOct('856', 'V1')]).filas;
  const bloque2 = [
    Array(13).fill(null),
    ['CLIENTE', 'OTRO CLIENTE PRUEBA', ...Array(11).fill(null)],
    ['CAMPAÑA', 'INVIERNO PRUEBA', ...Array(11).fill(null)],
    ENC_VV,
    fOct('857', 'V2'),
  ];
  bloque2[4][3] = ''; // la columna CAMPAÑA vacía: manda la etiqueta del bloque
  const r = leer1([...base, ...bloque2]);
  cumpleContrato(r.campanas);
  assert.deepEqual(r.campanas.map((c) => [c.cliente, c.campana, c.version, c.sitios.map((s) => s.sitio_clave)]), [
    ['TIENDAS DEL VALLE', 'OTOÑO PRUEBA', 'V1', ['MX_CM_VV_COL_856']],
    ['OTRO CLIENTE PRUEBA', 'INVIERNO PRUEBA', 'V2', ['MX_CM_VV_COL_857']],
  ]);
  assert.ok(!claves(r).some((c) => /ID ?COLUMNA/.test(c)));
  assert.deepEqual(r.descartadas, []);
});

test('ESTATUS cancelada, baja o suspendida no se carga; los de Pauta VV sí', () => {
  const filas = hojaPautaVV('BITACORA', CAB, [fOct('856', 'V1'), fOct('857', 'V1'), fOct('858', 'V1'), fOct('859', 'V1'), fOct('860', 'V1')]).filas;
  filas[9][12] = 'CANCELADA';
  filas[10][12] = 'Baja';
  filas[11][12] = 'SUSPENDIDO';
  filas[12][12] = 'Cerrada';
  const r = leer1(filas);
  assert.deepEqual(claves(r), ['MX_CM_VV_COL_856', 'MX_CM_VV_COL_860']);
  assert.deepEqual(r.descartadas.map((d) => [d.fila, d.motivo]), [[10, 'estatus «CANCELADA»'], [11, 'estatus «Baja»'], [12, 'estatus «SUSPENDIDO»']]);
  assert.ok(r.avisos.some((a) => /3 renglón\(es\) con ESTATUS/.test(a)));
});

test('Vía Verde: varias claves en una celda se parten, «PÓRTICO 8» es POR_0008 y lo ilegible se descarta', () => {
  const k = (t) => B.claveDeSitio(t, 'Vía Verde');
  assert.deepEqual(k('PÓRTICO 0008'), { clave: 'MX_CM_VV_POR_0008', espacioVV: 'POR_0008', medio: 'Pórtico', edoMex: false, cambios: ['alias_portico'] });
  assert.deepEqual([k('PORTICO 8').clave, k('PORTICO 8').cambios], ['MX_CM_VV_POR_0008', ['alias_portico', 'ceros']]);
  assert.equal(k('POR8').espacioVV, 'POR_0008');
  for (const malo of ['XYZ', 'MX_CM_EV_MGP_16_3606', 'COLUMNA NORTE', '856-A']) assert.equal(k(malo).clave, null, malo);
  assert.deepEqual(B.partirClaves('856, 857'), ['856', '857']);
  assert.deepEqual(B.partirClaves('856 y 857 / 858'), ['856', '857', '858']);
  assert.deepEqual(B.partirClaves('MX_CM_BB_IID_0001 (NORTE, CDMX)'), ['MX_CM_BB_IID_0001 (NORTE, CDMX)']);
  const r = leer1(hojaPautaVV('BITACORA', CAB, [fOct('856, 857', 'V1'), fOct('PORTICO 8', 'V1'), fOct('COLUMNA NORTE', 'V1'), fOct('859', 'V1')]).filas);
  assert.deepEqual(r.campanas[0].sitios.map((s) => [s.sitio_clave, s.sitio_original, s.espacio_vv]), [
    ['MX_CM_VV_COL_856', '856', '856'], ['MX_CM_VV_COL_857', '857', '857'], ['MX_CM_VV_COL_859', '859', '859'],
  ]);
  assert.deepEqual(r.otroMedio, [{ medio: 'Pórtico', sitios: 1 }]);
  assert.deepEqual(r.descartadas.map((d) => [d.fila, d.valor, d.motivo]), [[11, 'COLUMNA NORTE', 'clave de Vía Verde ilegible (ni columna ni pórtico)']]);
});

test('FULL «TODAS» en la llamada de Pórtico: sin avisos falsos', () => {
  const r = leer1(hojaPautaVV('BITACORA', { ...CAB, campana: 'FULL PRUEBA' }, [fOct('TODAS', 'FULLV', { lv: '19:00 - 19:50' })]).filas, { ...CTX_COL, medio: 'Pórtico' });
  assert.equal(r.campanas.length, 0);
  assert.ok(!r.avisos.some((a) => /sin sitios válidos|no trae campañas/.test(a)), r.avisos.join(' | '));
});

test('vigencias separadas del mismo sitio: un renglón por tramo (la base guarda comp_sitios.tramos) y aviso informativo', () => {
  assert.deepEqual(B.huecosVigencia([['2026-10-25', '2026-10-31'], ['2026-10-01', '2026-10-05']]), [['2026-10-06', '2026-10-24']]);
  assert.deepEqual(B.huecosVigencia([['2026-10-01', '2026-10-05'], ['2026-10-06', '2026-10-31']]), []);
  assert.deepEqual(B.huecosVigencia([['2026-10-01', '2026-10-05'], [null, null]]), []);
  // Revisión del 23-oct-2026: antes salía UN renglón del 1 al 31 con «SIN
  // AIRE…» en observaciones y el plan de tomas caía en el hueco.
  const r = leer1(hojaPautaVV('BITACORA', CAB, [fOct('856', 'V1', { fin: '2026-10-05' }), fOct('856', 'V1', { ini: '2026-10-07', fin: '2026-10-07' }), fOct('856', 'V1', { ini: '2026-10-25' })]).filas);
  cumpleContrato(r.campanas);
  const ss = r.campanas[0].sitios;
  assert.deepEqual(ss.map((s) => [s.sitio_clave, s.inicio, s.fin, s.observaciones]), [
    ['MX_CM_VV_COL_856', '2026-10-01', '2026-10-05', null],
    ['MX_CM_VV_COL_856', '2026-10-07', '2026-10-07', null],
    ['MX_CM_VV_COL_856', '2026-10-25', '2026-10-31', null],
  ]);
  assert.ok(r.avisos.some((a) => /tramos separados/.test(a) && /SIN AIRE EL 06\/10, DEL 08\/10 AL 24\/10/.test(a)), r.avisos.join(' | '));
});

test('hojaDeLibro: lee desde A1 (columna A vacía), combinadas en su lugar, versión «01» y horas de Excel', () => {
  const aoa = [
    [null, 'CLIENTE', 'TIENDAS DEL VALLE'],
    [null, 'CAMPAÑA', 'OTOÑO PRUEBA'],
    [],
    [null, ...ENC_VV],
    [null, ...fOct('856', '01')],
    [null, ...fOct('857', null)],
    [null, ...fOct('858', 1, { lv: 0.291666, ini: 46296.75 })],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 4, c: 6 }, e: { r: 5, c: 6 } }]; // VERSION combinada G5:G6 (coordenadas de hoja)
  ws['G7'].z = '00'; // la versión 1 con formato «00»: en Excel se ve «01»
  ws['!ref'] = 'B1:N7'; // como lo guarda Excel cuando la columna A está vacía
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'BITACORA');
  const leido = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const hoja = B.hojaDeLibro(XLSX.utils, leido.Sheets.BITACORA, 'BITACORA');
  assert.equal(hoja.filas[3][1], 'ID COLUMNA', 'la matriz empieza en A1');
  const r = B.leerBitacora({ hojas: [hoja] }, CTX_COL);
  cumpleContrato(r.campanas);
  assert.deepEqual(r.campanas.map((c) => [c.version, c.sitios.map((s) => s.espacio_vv)]), [['01', ['856', '857', '858']]]);
  const s858 = r.campanas[0].sitios[2];
  assert.deepEqual([s858.inicio, s858.horario_lv], ['2026-10-01', '07:00']);
  assert.ok(r.avisos.some((a) => /hora de Excel/.test(a)));
  // Una matriz cruda que empieza en B1: con `origen` las combinadas también caen bien.
  const cruda = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const r2 = B.leerBitacora({ hojas: [{ nombre: 'BITACORA', filas: cruda, merges: ws['!merges'], origen: { r: 0, c: 1 } }] }, CTX_COL);
  assert.deepEqual(r2.campanas.find((c) => c.version === '01').sitios.map((s) => s.espacio_vv), ['856', '857']);
  assert.equal(B.hojaDeLibro(XLSX.utils, {}, 'VACIA').filas.length, 0);
});

test('encabezado en vertical: el valor de abajo', () => {
  const filas = [['CLIENTE', 'CAMPAÑA', 'VENDEDOR'], ['CLIENTE INVENTADO', 'CAMP V', 'Vendedor Ficticio'], [], ENC_VV, fOct('856', 'V1')];
  filas[4][3] = '';
  const [c] = leer1(filas).campanas;
  assert.deepEqual([c.cliente, c.campana, c.vendedor], ['CLIENTE INVENTADO', 'CAMP V', 'Vendedor Ficticio']);
});

test('la misma campaña con otro cliente en otra hoja va aparte', () => {
  const h1 = hojaPautaVV('A', CAB, [fOct('856', 'V1')]);
  const h2 = hojaPautaVV('B', { ...CAB, cliente: 'OTRO CLIENTE PRUEBA' }, [fOct('857', 'V1')]);
  const h3 = hojaPautaVV('C', CAB, [fOct('858', 'V1')]); // mismo cliente que la primera: se junta
  const r = B.leerBitacora({ hojas: [h1, h2, h3] }, CTX_COL);
  assert.deepEqual(r.campanas.map((c) => [c.campana, c.cliente, c.sitios.map((s) => s.espacio_vv)]), [
    ['OTOÑO PRUEBA', 'TIENDAS DEL VALLE', ['856', '858']],
    ['OTOÑO PRUEBA · OTRO CLIENTE PRUEBA', 'OTRO CLIENTE PRUEBA', ['857']],
  ]);
  assert.ok(r.avisos.some((a) => /se carga aparte como «OTOÑO PRUEBA · OTRO CLIENTE PRUEBA»/.test(a)));
});

test('sinInventario: la misma regla que la base (solo el inventario)', () => {
  const r = leer1(hojaPautaVV('BITACORA', CAB, [fOct('552', 'V1')]).filas, { ...CTX_COL, inventario: ['MX_CM_VV_COL_856'], espaciosVV: [{ clave: '552', activo: true, tramo: 'CDMX' }] });
  assert.deepEqual(r.sinInventario.map((s) => s.clave), ['MX_CM_VV_COL_552']);
});

const ESPACIOS_12 = Array.from({ length: 12 }, (_, i) => ({ clave: String(401 + i), activo: true, tramo: 'CDMX' }))
  .concat([{ clave: '499', activo: false, tramo: 'CDMX' }, { clave: 'A04', activo: true, tramo: 'EDO MEX' }, { clave: 'POR_0008', activo: true, tramo: null }]);

test('FULL con rotación: se marca si cubre las columnas activas; sin vv_espacios solo se avisa', () => {
  const vs = ['CAMASTRO', 'FRUTERO', 'MESA'];
  const filas = hojaPautaVV('BITACORA', { ...CAB, campana: 'MUEBLES ROTACION' }, Array.from({ length: 12 }, (_, i) => fOct(String(401 + i), vs[i % 3]))).filas;
  for (const f of filas.slice(8)) f[3] = 'MUEBLES ROTACION';
  const r = leer1(filas, { ...CTX_COL, espaciosVV: ESPACIOS_12 });
  assert.deepEqual(r.campanas.map((c) => [c.version, c.es_full, c.sitios.length]), [['CAMASTRO', true, 4], ['FRUTERO', true, 4], ['MESA', true, 4]]);
  assert.ok(r.avisos.some((a) => /cubre 12 de las 12 columnas activas/.test(a)));
  // Una campaña de 3 columnas no es FULL.
  const chica = leer1(hojaPautaVV('BITACORA', CAB, [fOct('401', 'V1'), fOct('402', 'V1'), fOct('403', 'V2')]).filas, { ...CTX_COL, espaciosVV: ESPACIOS_12 });
  assert.ok(chica.campanas.every((c) => !c.es_full));
  // Pauta VV sin vv_espacios: 30 columnas en 3 versiones → aviso, sin marcar.
  const pautas = Array.from({ length: 30 }, (_, i) => pauta(i + 1, 8, String(414 + i), vs[i % 3], '2026-10-01', '2026-10-31'));
  const p = B.desdePautaVV([CAMP_VV[0]], pautas, [], { tipo: 'mes', anio: 2026, numero: 10 });
  assert.ok(p.porMedio.Columna.every((c) => !c.es_full));
  assert.ok(p.avisos.some((a) => /FULL con rotación/.test(a)));
  const p2 = B.desdePautaVV([CAMP_VV[0]], pautas.slice(0, 12).map((x, i) => ({ ...x, espacio_clave: String(401 + i) })), [], { tipo: 'mes', anio: 2026, numero: 10 }, { espaciosVV: ESPACIOS_12 });
  assert.ok(p2.porMedio.Columna.every((c) => c.es_full));
});

const OCT = { tipo: 'mes', anio: 2026, numero: 10 };
const campVV = (id, nombre, cliente = 'CLIENTE PRUEBA') => ({ ...CAMP_VV[0], id, nombre, cliente });

test('desdePautaVV: lectura incompleta o sin permiso no arma nada', () => {
  const p = [pauta(1, 8, '856', 'V1', '2026-10-01', '2026-10-31')];
  const corta = B.desdePautaVV(CAMP_VV, p, [], OCT, { totales: { campanas: 2, pautas: 1000, ocupacion: 0 } });
  assert.deepEqual([corta.porMedio.Columna.length, corta.porMedio['Pórtico'].length], [0, 0]);
  assert.ok(corta.errores.some((e) => /vv_pautas llegaron 1 de 1000/.test(e)));
  const sinCamp = B.desdePautaVV([], p, [], OCT);
  assert.equal(sinCamp.porMedio.Columna.length, 0);
  assert.ok(sinCamp.errores.some((e) => /sin ninguna campaña/.test(e)));
  const vacia = B.desdePautaVV([], [], [], OCT);
  assert.deepEqual(vacia.errores, []);
  assert.ok(vacia.avisos.some((a) => /vinieron vacíos/.test(a)));
  const completa = B.desdePautaVV(CAMP_VV, p, [], OCT, { totales: { campanas: 2, pautas: 1, ocupacion: 0 } });
  assert.deepEqual([completa.errores, completa.porMedio.Columna.length], [[], 1]);
});

test('desdePautaVV: mismo nombre y versión: otro cliente va aparte; el mismo cliente se junta', () => {
  const r = B.desdePautaVV(
    [campVV(11, 'NAVIDAD', 'CLIENTE A'), campVV(12, 'NAVIDAD', 'CLIENTE B'), campVV(13, 'NAVIDAD', 'CLIENTE A')],
    [pauta(1, 11, '856', 'V1', '2026-10-01', '2026-10-05'), pauta(2, 12, '856', 'V1', '2026-10-20', '2026-10-31'),
      pauta(3, 12, '857', 'V1', '2026-10-01', '2026-10-31'), pauta(4, 13, '856', 'V1', '2026-10-20', '2026-10-31')],
    [], OCT,
  );
  cumpleContrato(r.porMedio.Columna);
  const llaves = r.porMedio.Columna.map((c) => `${c.campana}|${c.version}`);
  assert.equal(new Set(llaves).size, llaves.length, 'nunca dos entradas con la misma llave');
  assert.deepEqual(r.porMedio.Columna.map((c) => [c.campana, c.cliente, c.origen_ref, c.sitios.map((s) => [s.espacio_vv, s.inicio, s.fin, s.observaciones])]), [
    ['NAVIDAD', 'CLIENTE A', '11', [['856', '2026-10-01', '2026-10-31', 'SIN AIRE DEL 06/10 AL 19/10']]],
    ['NAVIDAD · CLIENTE B', 'CLIENTE B', '12', [['856', '2026-10-20', '2026-10-31', null], ['857', '2026-10-01', '2026-10-31', null]]],
  ]);
  assert.ok(r.avisos.some((a) => /2 clientes/.test(a)));
});

test('desdePautaVV: del plano solo se omite el espacio que ya está en Pauta VV; lo demás se agrega y se lista', () => {
  const o = (id, esp, nombre) => ocup(id, esp, nombre, { plano_mes: '2026-10' });
  const r = B.desdePautaVV([campVV(1, 'MARCA X')], [pauta(1, 1, '856', 'V1', '2026-10-01', '2026-10-31')],
    [o(1, '856', 'MARCA X'), o(2, '857', 'MARCA X'), o(3, 'POR_0008', 'MARCA X')], OCT);
  assert.deepEqual(r.porMedio.Columna.map((c) => [c.fuente, c.version, c.sitios.map((s) => [s.espacio_vv, s.observaciones])]), [
    ['pauta_vv', 'V1', [['856', null], ['857', 'SOLO EN EL PLANO']]],
  ]);
  assert.deepEqual(r.porMedio['Pórtico'].map((c) => [c.fuente, c.campana, c.version, c.sitios.map((s) => s.espacio_vv)]), [['plano', 'MARCA X', 'V1', ['POR_0008']]]);
  assert.ok(r.avisos.some((a) => /solo están en el plano \(857, POR_0008\)/.test(a)));
  // Con varias versiones en Pauta VV, lo del plano va aparte con versión ''.
  const r2 = B.desdePautaVV([campVV(1, 'MARCA X')], [pauta(1, 1, '856', 'V1', '2026-10-01', '2026-10-15'), pauta(2, 1, '856', 'V2', '2026-10-16', '2026-10-31')],
    [o(2, '857', 'MARCA X')], OCT);
  assert.deepEqual(r2.porMedio.Columna.map((c) => [c.fuente, c.version, c.sitios.map((s) => s.espacio_vv)]), [
    ['pauta_vv', 'V1', ['856']], ['pauta_vv', 'V2', ['856']], ['plano', '', ['857']],
  ]);
});

test('revisarContraCargadas: una ampliación en otro archivo no da de baja lo del primero', () => {
  const sitio = (esp) => ({ sitio_clave: `MX_CM_VV_COL_${esp}`, sitio_original: esp, espacio_vv: esp, inicio: null, fin: null, horario_lv: null, horario_sd: null, tipo_venta: 'VENTA', testigos: null, observaciones: null });
  const cargada = { medio: 'Columna', campana: 'OTOÑO PRUEBA', version: 'V1', fuente: 'bitacora', origen_ref: 'A.xlsx · BITACORA', sitios: [sitio('856'), sitio('857')] };
  const amplia = leer1(hojaPautaVV('BITACORA', CAB, [fOct('858', 'V1')]).filas, { ...CTX_COL, archivo: 'AMPLIACION.xlsx' }).campanas;
  const r = B.revisarContraCargadas(amplia, [cargada], 'Columna');
  assert.deepEqual(r.campanas[0].sitios.map((s) => s.espacio_vv), ['858', '856', '857']);
  assert.deepEqual(r.cambios.map((c) => [c.modo, c.sitios_que_no_vienen.length]), [['agregar', 2]]);
  assert.ok(r.avisos.some((a) => /se conservan 2 sitio\(s\)/.test(a)));
  assert.equal(amplia[0].sitios.length, 1, 'no toca la entrada original');
  cumpleContrato(r.campanas);
  // El mismo archivo otra vez: reemplaza (y avisa cuántos se darían de baja).
  const mismo = leer1(hojaPautaVV('BITACORA', CAB, [fOct('856', 'V1')]).filas, { ...CTX_COL, archivo: 'A.xlsx' }).campanas;
  const r2 = B.revisarContraCargadas(mismo, [cargada], 'Columna');
  assert.deepEqual([r2.campanas[0].sitios.length, r2.cambios[0].modo], [1, 'reemplazar']);
  assert.ok(r2.avisos.some((a) => /se darían de baja 1 sitio/.test(a) && /857/.test(a)));
  // Forzado.
  assert.equal(B.revisarContraCargadas(amplia, [cargada], 'Columna', 'reemplazar').campanas[0].sitios.length, 1);
  assert.equal(B.revisarContraCargadas(mismo, [cargada], 'Columna', 'agregar').campanas[0].sitios.length, 2);
  // Otro medio: no se compara.
  assert.deepEqual(B.revisarContraCargadas(amplia, [cargada], 'Pórtico').cambios, []);
});

test('revisarContraCargadas: la campaña que venía del plano sin versión y ahora llega con versión se avisa', () => {
  const delPlano = { medio: 'Columna', campana: 'MARCA Y', version: '', fuente: 'plano', origen_ref: 'plano 2026-10', sitios: [] };
  const nuevas = B.desdePautaVV([campVV(21, 'MARCA Y')], [pauta(5, 21, '857', 'V1', '2026-10-01', '2026-10-31')], [], OCT).porMedio.Columna;
  const r = B.revisarContraCargadas(nuevas, [delPlano], 'Columna');
  assert.ok(r.avisos.some((a) => /se cargó del plano sin versión y ahora llega con versión \(V1\)/.test(a)));
});

// ------------------------------------------------------------
// Bitácoras REALES de comercial (23-oct-2026): Biobox y Ecovallas Digital.
// Las filas tienen la FORMA de los archivos que dejó Erik (encabezados
// desplazados, columnas sin nombre, varias versiones por celda o por
// columna, fechas como serial de Excel); clientes, campañas, personas y
// claves son INVENTADOS. Los Excel reales nunca entran al repo.
// ------------------------------------------------------------

/** Serial de Excel de un día (46296 = 1-oct-2026). */
const SER = (a, m, d) => (Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
const OCT_MES = { inicio: '2026-10-01', fin: '2026-10-31' };
const ENC_BB = ['No', 'ID BIOBOX', 'UBICACIÓN', 'CAMPAÑA', 'NEGOCIACIÓN', 'MODULACION', 'VERSION ', 'INICIO', 'FIN', 'DÍAS PROYECCIÓN', 'HORARIO', 'TESTIGOS', 'OBSERVACIONES', 'ESTATUS'];
const TESTIGOS_BB = 'TESTIGOS PRUEBA COMPLETOS ANTES DE 10 DÍAS';
/** Renglón de Biobox: columna A vacía y B «No» (la tabla empieza en B). */
const fBB = (no, clave, neg, version, ini, fin, extra = {}) => [
  null, no, clave, 'Calle Inventada 1', extra.campana ?? 'CAFÉ PRUEBA', neg, null, version, ini, fin, 'Lunes a domingo', extra.horario ?? '24 HORAS',
  extra.testigos ?? TESTIGOS_BB, extra.obs ?? null, null,
];
/** Hoja de Biobox: etiquetas en la columna C y valores a la derecha, como el archivo real. */
const hojaBB = (nombre, cab, filas, conEncabezado = true) => ({
  nombre,
  filas: [
    [],
    [null, null, 'CAMPAÑA:', cab.campana, 'MES', 'AGOSTO - DICIEMBRE'],
    [null, null, 'VENDEDOR:', 'Vendedora Ficticia', 'FECHA INICIO:', cab.ini],
    [null, null, 'ADMINISTRADOR:', 'Admin Inventado', 'FECHA FIN:', cab.fin],
    [null, null, 'CLIENTE:', cab.cliente ?? 'CLIENTE INVENTADO SA', 'TIPO DE PAUTA', 'DIGITAL'],
    [null, null, 'COMPROBACIÓN:', cab.comprobacion ?? 'MENSUAL', 'OBSERVACIONES:', cab.obs ?? null],
    [null, null, 'CONTRATO QUANTUM', cab.quantum ?? 'Q-001 -- Q-001-R2', 'FECHA DE ENVIO'],
    [],
    [],
    conEncabezado ? [null, ...ENC_BB] : [],
    ...filas,
  ],
});

test('Biobox real: varias versiones por celda, REU, NEGOCIACIÓN, vigencia recortada al mes y plan sugerido MENSUAL', () => {
  const hoja = hojaBB('CAFÉ PRUEBA ', { campana: 'CAFÉ PRUEBA', ini: SER(2026, 8, 18), fin: SER(2026, 12, 31), obs: 'TOMAS DE 5 VISTAS POR SITIO' }, [
    fBB(1, 'MX_CM_BB_MED_0901', 'VENTA', 'V5, V6, V7', SER(2026, 8, 18), SER(2026, 12, 31)),
    fBB(2, 'MX_CM_BB_MED_0902', 'VENTA ', 'V4, V6, V7', SER(2026, 10, 5), SER(2026, 10, 20)),
    fBB('REU', 'MX_CM_BB_MED_0903', 'BONUS', 'V5', SER(2026, 10, 21), SER(2026, 11, 15)),
    fBB(3, 'MX_EM_BB_OXD_0904', 'INTERCAMBIO', 'V5', SER(2026, 10, 1), SER(2026, 10, 31)),
    fBB(4, 'MX_CM_BB_MED_0905', 'VENTA', 'V5', '-', '-'),
    fBB(5, 'MX_CM_BB_MED_0906', 'VENTA', 'V5', SER(2026, 9, 1), SER(2026, 9, 30)),
    fBB(6, 'MX_CM_BB_MED_0907', 'VENTA', 'V5', '17 SEP', SER(2026, 10, 10)),
    [null, null, 'CROQUIS CAFÉ M4', 'CROQUIS CAFÉ M4R2'],
  ]);
  const r = B.leerBitacora({ hojas: [hoja] }, { unidad: 'Biobox', medio: 'Máquina', archivo: 'BITACORA PRUEBA.xlsx', periodo: OCT_MES });
  cumpleContrato(r.campanas);
  const v = Object.fromEntries(r.campanas.map((c) => [c.version, c]));
  assert.deepEqual(Object.keys(v), ['V5', 'V6', 'V7', 'V4']);
  assert.deepEqual(v.V5.sitios.map((s) => s.sitio_clave), ['MX_CM_BB_MED_0901', 'MX_CM_BB_MED_0903', 'MX_EM_BB_OXD_0904', 'MX_CM_BB_MED_0907']);
  assert.deepEqual(v.V4.sitios.map((s) => s.sitio_clave), ['MX_CM_BB_MED_0902']);
  assert.deepEqual(v.V6.sitios.map((s) => s.sitio_clave), ['MX_CM_BB_MED_0901', 'MX_CM_BB_MED_0902']);
  const [s1, s3, s4, s7] = v.V5.sitios;
  // Vigencia por sitio recortada al periodo; 24 HORAS en L-V y S-D.
  assert.deepEqual([s1.inicio, s1.fin, s1.horario_lv, s1.horario_sd], ['2026-10-01', '2026-10-31', '24 HORAS', '24 HORAS']);
  assert.deepEqual([s3.inicio, s3.fin, s3.tipo_venta, s3.observaciones], ['2026-10-21', '2026-10-31', 'BONUS', 'REUBICACIÓN']);
  assert.deepEqual([s4.tipo_venta, s4.observaciones], [null, 'INTERCAMBIO'], 'INTERCAMBIO no es VENTA ni BONUS: va a observaciones');
  assert.deepEqual([s7.inicio, s7.fin], ['2026-10-01', '2026-10-10'], '«17 SEP» se lee con el año del encabezado y se recorta');
  // Encabezado: campaña, cliente, quantum y especificación (OBSERVACIONES + TESTIGOS, igual en todos).
  assert.deepEqual([v.V5.campana, v.V5.cliente, v.V5.vendedor, v.V5.quantum], ['CAFÉ PRUEBA', 'CLIENTE INVENTADO SA', 'Vendedora Ficticia', 'Q-001 -- Q-001-R2']);
  assert.equal(v.V5.especificacion, `TOMAS DE 5 VISTAS POR SITIO · ${TESTIGOS_BB}`);
  assert.equal(s1.testigos, true);
  assert.deepEqual([v.V5.inicio, v.V5.fin, v.V5.origen_ref], ['2026-10-01', '2026-10-31', 'BITACORA PRUEBA.xlsx · CAFÉ PRUEBA ']);
  // Descartadas: «-» en las dos fechas y fuera del mes; el croquis sin datos no cuenta.
  assert.deepEqual(r.descartadas.map((d) => [d.fila, d.motivo]), [[15, 'sin vigencia (INICIO y FIN «-»)'], [16, 'fuera del periodo']]);
  // Plan sugerido FUERA del contrato, por llave de campaña-versión.
  assert.deepEqual(Object.keys(r.planesSugeridos).sort(), ['CAFEPRUEBA|V4', 'CAFEPRUEBA|V5', 'CAFEPRUEBA|V6', 'CAFEPRUEBA|V7']);
  const p = r.planesSugeridos[B.llaveContrato({ campana: 'CAFÉ PRUEBA', version: 'V5' })];
  assert.deepEqual([p.plan, p.comprobacion, p.porConfirmar, p.hojas], [{ tipo: 'inicio' }, 'MENSUAL', true, ['CAFÉ PRUEBA ']]);
  assert.ok(!('plan' in v.V5) && !('planesSugeridos' in v.V5), 'el contrato no cambia');
  assert.ok(r.avisos.some((a) => /se recorta al periodo/.test(a)));
  assert.deepEqual(r.hojas.map((h) => [h.estado, h.campana, h.comprobacion, h.renglones]), [['leida', 'CAFÉ PRUEBA', 'MENSUAL', 5]]);
});

test('Biobox real: bloques repetidos por semana, versiones con marca y hoja SIN fila de encabezado de tabla', () => {
  const bloques = hojaBB('PLAN TOTAL PRUEBA', { campana: 'PLAN TOTAL PRUEBA', ini: SER(2026, 6, 1), fin: SER(2027, 6, 30), comprobacion: 'CATORCENAL' }, [
    fBB('REU', 'MX_CM_BB_MED_0911', 'INTERCAMBIO', 'V21, V22', SER(2026, 10, 12), SER(2026, 10, 17), { campana: 'TOTAL PRUEBA' }),
    fBB(1, 'MX_CM_BB_MED_0912', 'INTERCAMBIO', 'MARCA X V16, V17 Y 18', SER(2026, 10, 12), SER(2026, 10, 17), { campana: 'TOTAL PRUEBA' }),
    [],
    [null, ...ENC_BB],
    fBB('REU', 'MX_CM_BB_MED_0911', 'INTERCAMBIO', 'V15, V16', SER(2026, 10, 1), SER(2026, 10, 9), { campana: 'TOTAL PRUEBA' }),
  ]);
  const sinEnc = hojaBB('SIN ENCABEZADO', { campana: 'LUJO PRUEBA', ini: SER(2026, 5, 1), fin: SER(2026, 11, 30), comprobacion: 'TESTIGS CATORCENALES' }, [
    fBB(1, 'MX_CM_BB_MED_0921', 'VENTA', 'V4, V5', SER(2026, 10, 2), SER(2026, 10, 14), { horario: '24 HRS' }),
    fBB('REU', 'MX_CM_BB_MED_0922', 'BONUS', 'V4, V5', SER(2026, 10, 15), SER(2026, 10, 28)),
    fBB(2, 'MX_CM_BB_MED_0923', 'VENTA', 'V4', SER(2026, 10, 15), SER(2026, 10, 1)),
  ], false);
  const r = B.leerBitacora({ hojas: [bloques, sinEnc] }, { unidad: 'Biobox', medio: 'Máquina', periodo: OCT_MES });
  cumpleContrato(r.campanas);
  const resumen = r.campanas.map((c) => [c.campana, c.version, c.sitios.map((s) => `${s.sitio_clave.slice(-4)} ${s.inicio.slice(8)}-${s.fin.slice(8)}`).join(' ')]);
  assert.deepEqual(resumen, [
    ['PLAN TOTAL PRUEBA', 'V21', '0911 12-17'],
    ['PLAN TOTAL PRUEBA', 'V22', '0911 12-17'],
    ['PLAN TOTAL PRUEBA', 'MARCA X V16', '0912 12-17'],
    ['PLAN TOTAL PRUEBA', 'MARCA X V17', '0912 12-17'],
    ['PLAN TOTAL PRUEBA', 'MARCA X V18', '0912 12-17'],
    ['PLAN TOTAL PRUEBA', 'V15', '0911 01-09'],
    ['PLAN TOTAL PRUEBA', 'V16', '0911 01-09'],
    ['LUJO PRUEBA', 'V4', '0921 02-14 0922 15-28'],
    ['LUJO PRUEBA', 'V5', '0921 02-14 0922 15-28'],
  ]);
  // La campaña es la del ENCABEZADO de la hoja (hoja = campaña), no la columna del renglón.
  assert.ok(!r.campanas.some((c) => c.campana === 'TOTAL PRUEBA'));
  assert.deepEqual(r.descartadas.map((d) => [d.hoja, d.fila, d.motivo]), [['SIN ENCABEZADO', 13, 'FIN antes de INICIO']]);
  assert.deepEqual(r.hojas[1].deducidas.slice(0, 3), ['sitio', 'inicio', 'fin']);
  assert.ok(r.hojas[1].deducidas.includes('version') && r.hojas[1].deducidas.includes('tipoVenta'));
  assert.ok(r.avisos.some((a) => /deducidas por su contenido: SIN ENCABEZADO/.test(a)));
  assert.deepEqual(r.campanas[7].sitios.map((s) => [s.tipo_venta, s.observaciones]), [['VENTA', null], ['BONUS', 'REUBICACIÓN']]);
  // CATORCENAL (también «TESTIGS CATORCENALES») → una toma cada 14 días.
  assert.deepEqual(r.planesSugeridos['LUJOPRUEBA|V4'].plan, { tipo: 'cada_n', cada_n: 14 });
  assert.deepEqual(r.planesSugeridos['PLANTOTALPRUEBA|MARCAXV17'].plan, { tipo: 'cada_n', cada_n: 14 });
});

const ENC_EV = ['CLAVE', null, null, 'NEGOCIACIÓN', null, 'INICIO', 'FINAL', 'HORAS', 'C QTM', 'ESTATUS', 'VERSIÓN 1', 'VERSION 2'];
/** Hoja de Ecovallas Digital: encabezado en A-G con las casillas de TESTIGOS y la tabla en la fila 7. */
const hojaEV = (nombre, cab, filas, opts = {}) => ({
  nombre,
  oculta: opts.oculta,
  filas: [
    ['CAMPAÑA:', cab.campana, 'CATORCENA:', cab.cat ?? 21, 'TESTIGOS', false, 'TOMA CORTA, MEDIA Y LARGA'],
    ['VENDEDOR:', 'Vendedor Ficticio', 'FECHA INICIO:', SER(2026, 10, 13), null, true, '1 TOMA CON LA MEJOR VISTA'],
    ['ADMINISTRADOR:', null, 'FECHA FIN:', SER(2026, 10, 26), null, cab.video ?? false, 'VIDEO DE DÍA Y DE NOCHE'],
    ['CLIENTE:', cab.cliente ?? 'BEBIDAS INVENTADAS SA DE CV', 'UBICACIÓN:', 'CDMX', null, false, '3 TOMAS DE MEJOR ÁNGULO'],
    [],
    [],
    opts.encabezado ?? ENC_EV,
    ...filas,
  ],
});
const fEV = (clave, medio, neg, medida, ini, fin, v1, v2 = null, estatus = 'NEW PRINT') => [
  clave, 'Av. Inventada 100, CDMX', medio, neg, medida, ini, fin, '24 HRS', 'C000111', estatus, v1, v2,
];
const CAT21 = { inicio: '2026-10-13', fin: '2026-10-26' };

test('Ecovallas real: columnas sin nombre, VERSIÓN 1..N con la medida pegada, MEGAVALLA fuera, MX_EM_EV dentro y casillas de TESTIGOS', () => {
  const h1 = hojaEV('REFRESCO PRUEBA', { campana: 'REFRESCO PRUEBA', video: true }, [
    fEV('MX_CM_EV_MGP_01_9001', 'MEGAPANTALLA', 'VENTA', '1440.00 px x 405.00 px', SER(2026, 10, 13), SER(2026, 10, 26), 'REFRESCO_SABOR-1440x405', 'REFRESCO_LATA-1440X405PX_Sur'),
    fEV('MX_CM_EV_MGP_07_9002', 'MEGAPANTALLA', 'VENTA ', '1152.00 px x 324.00 px', SER(2026, 10, 13), SER(2026, 10, 26), 'REFRESCO_SABOR-1152x324.jpg'),
    fEV('MX_EM_EV_MGP_02_9003', 'MEGAPANTALLA', 'BONIFICACIÓN', '2880 px x 405 px', '10/20/2026', '10/26/2026', 'REFRESCO_SABOR-2880x405'),
    fEV('MX_CM_EV_MGV_2-4_9004', 'MEGAVALLA', 'VENTA', 'NA', SER(2026, 10, 13), SER(2026, 10, 26), 'REFRESCO-MGV'),
    fEV('MX_CM_EV_EVA_05_9005', 'VALLA SENCILLA', 'VENTA', 'NA', SER(2026, 10, 13), SER(2026, 10, 26), 'REFRESCO-EVA'),
    fEV('PENDIENTE DE REUBICACIÓN', null, 'VENTA', null, SER(2026, 10, 13), SER(2026, 10, 16), null),
  ]);
  // La misma campaña en otra hoja (su bonus) con el cliente escrito más corto: se junta.
  const h2 = hojaEV(' REFRESCO PRUEBA bonus ', { campana: 'REFRESCO PRUEBA ', cliente: 'BEBIDAS INVENTADAS' }, [
    fEV('MX_CM_EV_MGP_03_9006', 'MEGAPANTALLA', 'BONUS', '1440 px x 405 px', SER(2026, 10, 15), SER(2026, 10, 26), 'REFRESCO_SABOR 1440x405.jpg'),
  ]);
  const aux = [
    { nombre: 'LISTADO DE PANTALLAS', oculta: true, filas: [['MX_CM_EV_MGP_01_9001', 'Dirección', '1440 px x 405 px', 'MEGAPANTALLA']] },
    { nombre: 'LISTA ', filas: [['CAMPAÑAS ', 'CONTRATO'], ['REFRESCO PRUEBA', '000111']] },
    { nombre: 'EXCLUSIVAS GLOBALES', filas: [[null, 'EXCLUSIVAS ', 'CAMPAÑA ', 'SITIOS ', 'UBICACIÓN ', 'CAT 4']] },
    hojaEV('VIEJA PRUEBA', { campana: 'VIEJA PRUEBA', cat: 9 }, [fEV('MX_CM_EV_MGP_01_9001', 'MEGAPANTALLA', 'VENTA', null, SER(2026, 5, 1), SER(2026, 5, 14), 'VIEJA')], { oculta: true }),
  ];
  const r = B.leerBitacora({ hojas: [aux[0], aux[1], h1, aux[2], h2, aux[3]] }, {
    unidad: 'Ecovallas', medio: 'Pantalla', periodo: CAT21, catorcena: 21,
    inventario: ['MX_CM_EV_MGP_01_9001', 'MX_CM_EV_MGP_07_9002', 'MX_EM_EV_MGP_02_9003', { clave: 'MX_CM_EV_MGP_03_9006', tipo_medio: 'Digital' }],
  });
  cumpleContrato(r.campanas);
  assert.deepEqual(r.campanas.map((c) => [c.campana, c.version, c.sitios.map((s) => s.sitio_clave.slice(-4))]), [
    ['REFRESCO PRUEBA', 'REFRESCO_SABOR', ['9001', '9002', '9003', '9006']],
    ['REFRESCO PRUEBA', 'REFRESCO_LATA_Sur', ['9001']],
  ]);
  const [sabor] = r.campanas;
  // Casillas marcadas → especificación; quantum de la columna C QTM; NEW PRINT → arte NUEVO.
  assert.equal(sabor.especificacion, 'TESTIGOS: 1 TOMA CON LA MEJOR VISTA / VIDEO DE DÍA Y DE NOCHE');
  assert.deepEqual([sabor.quantum, sabor.arte, sabor.cliente], ['C000111', 'NUEVO', 'BEBIDAS INVENTADAS SA DE CV']);
  const em = sabor.sitios[2];
  assert.deepEqual([em.inicio, em.fin, em.tipo_venta, em.horario_lv], ['2026-10-20', '2026-10-26', 'BONUS', '24 HRS'], 'EDO MEX de Ecovallas entra; fecha mes/día');
  assert.deepEqual(r.descartadas.map((d) => [d.fila, d.motivo]), [
    [11, 'impreso (MEGAVALLA)'],
    [12, 'impreso (VALLA SENCILLA)'],
    [13, 'no es una clave de inventario'],
  ]);
  assert.deepEqual(r.hojas.map((h) => [h.nombre, h.estado]), [
    ['LISTADO DE PANTALLAS', 'oculta'], ['LISTA ', 'sin_tabla'], ['REFRESCO PRUEBA', 'leida'],
    ['EXCLUSIVAS GLOBALES', 'sin_tabla'], [' REFRESCO PRUEBA bonus ', 'leida'], ['VIEJA PRUEBA', 'oculta'],
  ]);
  assert.deepEqual(r.hojas[2].testigos, ['1 TOMA CON LA MEJOR VISTA', 'VIDEO DE DÍA Y DE NOCHE']);
  assert.deepEqual([r.hojas[2].catorcena, r.hojas[2].deducidas], [21, ['medio']]);
  assert.deepEqual(r.sinInventario, []);
  assert.deepEqual(Object.keys(r.planesSugeridos), [], 'Ecovallas no trae COMPROBACIÓN: sin plan sugerido');
  assert.ok(r.avisos.some((a) => /MEGAVALLA son impresos/.test(a)));
  assert.ok(r.avisos.some((a) => /mes primero.*REFRESCO PRUEBA/.test(a)));
  assert.ok(r.avisos.some((a) => /no son campaña.*LISTA , EXCLUSIVAS GLOBALES/.test(a)));
  assert.ok(r.avisos.some((a) => /OCULTAS con tabla.*VIEJA PRUEBA/.test(a)));
  assert.ok(r.avisos.some((a) => /más de una hoja/.test(a)));
  assert.ok(!r.avisos.some((a) => /se carga aparte/.test(a)), 'el cliente corto es el mismo');
});

test('Ecovallas real: el inventario manda sobre la columna MEDIO (Impreso fuera, aunque diga MEGAPANTALLA)', () => {
  const h = hojaEV('BOTANA PRUEBA', { campana: 'BOTANA PRUEBA' }, [
    fEV('MX_CM_EV_EVA_09_9101', 'MEGAPANTALLA', 'VENTA', '1440 px x 405 px', SER(2026, 10, 13), SER(2026, 10, 26), 'BOTANA_TERROR'),
    fEV('MX_CM_EV_LUM_10_9102', 'LUMINA', 'VENTA', 'NA', SER(2026, 10, 13), SER(2026, 10, 26), 'BOTANA_TERROR-LUM'),
    fEV('MX_CM_EV_MGP_11_9103', 'MEGAPANTALLA', 'VENTA', '1440 px x 405 px', SER(2026, 10, 13), SER(2026, 10, 26), 'BOTANA_TERROR'),
  ]);
  const inventario = [
    { clave: 'MX_CM_EV_EVA_09_9101', tipo_medio: 'Impreso' },
    { clave: 'MX_CM_EV_LUM_10_9102', tipo_medio: 'Impreso' },
    { clave: 'MX_CM_EV_MGP_11_9103', tipo_medio: 'Digital' },
  ];
  const r = B.leerBitacora({ hojas: [h] }, { unidad: 'Ecovallas', medio: 'Pantalla', periodo: CAT21, inventario });
  assert.deepEqual(r.campanas.map((c) => [c.version, c.sitios.map((s) => s.sitio_clave)]), [['BOTANA_TERROR', ['MX_CM_EV_MGP_11_9103']]]);
  assert.deepEqual(r.descartadas.map((d) => d.motivo), ['impreso según inventario (Impreso)', 'impreso según inventario (Impreso)']);
  assert.ok(!r.avisos.some((a) => /sin sitios válidos/.test(a)), 'la versión que solo traía impresos ya se avisó como impresa');
  // Sin inventario, MEGAPANTALLA con clave EVA se queda (manda la columna MEDIO).
  const sin = B.leerBitacora({ hojas: [h] }, { unidad: 'Ecovallas', medio: 'Pantalla', periodo: CAT21 });
  assert.deepEqual(sin.campanas[0].sitios.map((s) => s.sitio_clave.slice(-4)), ['9101', '9103']);
});

test('Biobox: la «M» perdida de la clave se repone y el inventario Impreso solo se avisa', () => {
  const hoja = hojaBB('MAQUINA PRUEBA', { campana: 'MAQUINA PRUEBA', ini: SER(2026, 10, 1), fin: SER(2026, 10, 31) }, [
    fBB(1, 'X_CM_BB_MED_0931', 'VENTA', 'V1', SER(2026, 10, 13), SER(2026, 10, 31)),
    fBB(2, 'MX_CM_BB_MEC_0932', 'VENTA', 'V1', SER(2026, 10, 13), SER(2026, 10, 31)),
  ]);
  const r = B.leerBitacora({ hojas: [hoja] }, {
    unidad: 'Biobox', medio: 'Máquina', periodo: OCT_MES,
    inventario: [{ clave: 'MX_CM_BB_MED_0931', tipo_medio: 'Digital' }, { clave: 'MX_CM_BB_MEC_0932', tipo_medio: 'Impreso' }],
  });
  assert.deepEqual(r.campanas[0].sitios.map((s) => s.sitio_clave), ['MX_CM_BB_MED_0931', 'MX_CM_BB_MEC_0932']);
  assert.deepEqual(r.clavesCorregidas.map((c) => [c.original, c.cambios]), [['X_CM_BB_MED_0931', ['prefijo']]]);
  assert.ok(r.avisos.some((a) => /1 máquina\(s\) son Impreso en el inventario/.test(a)));
});

test('partirVersiones y planDeComprobacion', () => {
  assert.deepEqual(B.partirVersiones('V5, V6, V7'), ['V5', 'V6', 'V7']);
  assert.deepEqual(B.partirVersiones('V1 Y V2'), ['V1', 'V2']);
  assert.deepEqual(B.partirVersiones('MARCA X V11, 12 Y 13'), ['MARCA X V11', 'MARCA X V12', 'MARCA X V13']);
  assert.deepEqual(B.partirVersiones('MARCA Z - V4'), ['MARCA Z - V4']);
  assert.deepEqual(B.partirVersiones('Artista Uno, Dos y Tres-Gira'), ['Artista Uno, Dos y Tres-Gira']);
  assert.deepEqual(B.partirVersiones('REFRESCO_V2'), ['REFRESCO_V2']);
  const p = (t) => B.planDeComprobacion(t)?.plan ?? null;
  assert.deepEqual(p('MENSUAL '), { tipo: 'inicio' });
  assert.deepEqual(p('MENSUALES'), { tipo: 'inicio' });
  assert.deepEqual(p('CATORCENAL'), { tipo: 'cada_n', cada_n: 14 });
  assert.deepEqual(p('TESTIGS CATORCENALES'), { tipo: 'cada_n', cada_n: 14 });
  assert.deepEqual(p('QUINCENAL'), { tipo: 'cada_n', cada_n: 15 });
  assert.equal(p('A VECES'), null);
  assert.equal(p(null), null);
});

test('contratoComp: un solo lugar para los tipos y la llave del contrato', async () => {
  const { outputFiles: o } = await build({
    entryPoints: [fileURLToPath(new URL('../src/lib/contratoComp.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral',
  });
  const C = await import('data:text/javascript;base64,' + Buffer.from(o[0].text).toString('base64'));
  assert.equal(C.llaveContrato({ campana: 'Café  Prueba', version: 'v 1' }), 'CAFEPRUEBA|V1');
  assert.equal(B.llaveContrato({ campana: 'Café  Prueba', version: '' }), 'CAFEPRUEBA|', 'bitacoraComp lo vuelve a exportar');
});

// ------------------------------------------------------------
// Revisión de la bitácora real (23-oct-2026): forma real, nombres inventados
// ------------------------------------------------------------

const { outputFiles: oNucleo } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/comprobaciones.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const N = await import('data:text/javascript;base64,' + Buffer.from(oNucleo[0].text).toString('base64'));
const CTX_BB = { unidad: 'Biobox', medio: 'Máquina', archivo: 'BITACORA PRUEBA.xlsx', periodo: OCT_MES };
/** Lo que hace comp_cargar_campanas con los renglones del mismo sitio: tramos = sus vigencias distintas. */
const comoLaBase = (c, clave) => {
  const rs = c.sitios.filter((s) => s.sitio_clave === clave);
  const tramos = [...new Map(rs.map((s) => [`${s.inicio}|${s.fin}`, { inicio: s.inicio, fin: s.fin }])).values()];
  return { inicio: rs[0].inicio, fin: rs.at(-1).fin, tramos: tramos.length > 1 ? tramos : null };
};

test('tramos: el mismo sitio con vigencias separadas va en un renglón por tramo y el plan no cae en el hueco', () => {
  const h = hojaBB('SOPA PRUEBA', { campana: 'SOPA PRUEBA', ini: SER(2026, 9, 23), fin: SER(2026, 10, 31), comprobacion: 'CATORCENAL' }, [
    fBB(1, 'MX_CM_BB_OXD_0941', 'VENTA', 'V3', SER(2026, 9, 29), SER(2026, 10, 4)),
    fBB(2, 'MX_CM_BB_OXD_0941', 'VENTA', 'V3', SER(2026, 10, 21), SER(2026, 10, 31)),
    // La misma vigencia (VENTA y BONUS el mismo día) sí se junta, sin repetir observaciones.
    fBB(3, 'MX_CM_BB_OXD_0942', 'INTERCAMBIO', 'V3', SER(2026, 10, 9), SER(2026, 10, 12), { obs: 'MONITOREO EXTERNO' }),
    fBB(4, 'MX_CM_BB_OXD_0942', 'INTERCAMBIO', 'V3', SER(2026, 10, 9), SER(2026, 10, 12), { obs: 'MONITOREO EXTERNO' }),
    // Tramos que se tocan: el REU se queda en SU tramo; los iguales que se tocan se compactan.
    fBB(5, 'MX_CM_BB_OXD_0943', 'VENTA', 'V3', SER(2026, 10, 2), SER(2026, 10, 14)),
    fBB('REU', 'MX_CM_BB_OXD_0943', 'VENTA', 'V3', SER(2026, 10, 15), SER(2026, 10, 28)),
    fBB(6, 'MX_CM_BB_OXD_0944', 'VENTA', 'V3', SER(2026, 10, 1), SER(2026, 10, 10)),
    fBB(7, 'MX_CM_BB_OXD_0944', 'VENTA', 'V3', SER(2026, 10, 11), SER(2026, 10, 20)),
  ]);
  const r = B.leerBitacora({ hojas: [h] }, CTX_BB);
  cumpleContrato(r.campanas);
  const c = r.campanas[0];
  assert.deepEqual(c.sitios.map((s) => [s.sitio_clave.slice(-4), s.inicio.slice(5), s.fin.slice(5), s.observaciones]), [
    ['0941', '10-01', '10-04', null],
    ['0941', '10-21', '10-31', null],
    ['0942', '10-09', '10-12', 'INTERCAMBIO · MONITOREO EXTERNO'],
    ['0943', '10-02', '10-14', null],
    ['0943', '10-15', '10-28', 'REUBICACIÓN'],
    ['0944', '10-01', '10-20', null],
  ]);
  // El plan sugerido (CATORCENAL) con los tramos, como la base: nunca en el hueco del 5 al 20.
  const plan = r.planesSugeridos['SOPAPRUEBA|V3'].plan;
  const fechas = N.ventanasToma(comoLaBase(c, 'MX_CM_BB_OXD_0941'), c, OCT_MES).flatMap((v) => N.generarFechasPlan(plan, v.inicio, v.fin));
  assert.deepEqual(fechas, ['2026-10-01', '2026-10-21']);
  assert.ok(r.avisos.some((a) => /1 sitio\(s\) corren en tramos separados \(MX_CM_BB_OXD_0941 SIN AIRE DEL 05\/10 AL 20\/10\)/.test(a)), r.avisos.join(' | '));
  assert.ok(!r.avisos.some((a) => /datos distintos/.test(a)));
});

test('tramos con otro horario: la base guarda uno por sitio y se avisa', () => {
  const h = hojaBB('PROGRAMATICO PRUEBA', { campana: 'PROGRAMATICO PRUEBA', ini: SER(2026, 10, 1), fin: SER(2026, 10, 31) }, [
    fBB(1, 'MX_CM_BB_MED_0951', 'VENTA', 'V1', SER(2026, 10, 1), SER(2026, 10, 1), { horario: '(8:00 AM A 09:59 AM), (3:00 PM A 7:59 PM)' }),
    fBB(2, 'MX_CM_BB_MED_0951', 'VENTA', 'V1', SER(2026, 10, 2), SER(2026, 10, 2), { horario: '12:00 PM A 3:59 PM' }),
  ]);
  const r = B.leerBitacora({ hojas: [h] }, CTX_BB);
  assert.equal(r.campanas[0].sitios.length, 2);
  assert.ok(r.avisos.some((a) => /horario L-V distinto por tramo.*la base guarda «\(8:00 AM/.test(a)), r.avisos.join(' | '));
  assert.ok(r.avisos.some((a) => /1 campaña\(s\) traen horario por franjas.*PROGRAMATICO PRUEBA/.test(a)));
});

test('dos hojas con la misma CAMPAÑA: otro contrato va aparte; el mismo contrato (bonus) se junta', () => {
  const a = hojaBB('PARQUE PRUEBA', { campana: 'PARQUE PRUEBA', ini: SER(2026, 8, 1), fin: SER(2026, 12, 31), quantum: 'C100001 - C100001-R1 -- C100001' }, [
    fBB(1, 'MX_CM_BB_MED_0961', 'VENTA', 'V2', SER(2026, 8, 1), SER(2026, 12, 31), { campana: 'PARQUE PRUEBA' }),
  ]);
  const b = hojaBB('PARQUE PRUEBA TORRE', { campana: 'PARQUE PRUEBA', ini: SER(2026, 9, 20), fin: SER(2026, 10, 20), quantum: 'C200002 --- C200002-R1' }, [
    fBB(1, 'MX_CM_BB_MED_0962', 'VENTA', 'V2, V3', SER(2026, 9, 20), SER(2026, 10, 14), { campana: 'PARQUE PRUEBA TORRE' }),
  ]);
  const bonus = hojaBB('PARQUE PRUEBA BONUS', { campana: 'PARQUE PRUEBA', ini: SER(2026, 10, 1), fin: SER(2026, 10, 31), quantum: 'C100001-R3' }, [
    fBB(1, 'MX_CM_BB_MED_0963', 'BONUS', 'V2', SER(2026, 10, 1), SER(2026, 10, 31), { campana: 'PARQUE PRUEBA BONUS' }),
  ]);
  const r = B.leerBitacora({ hojas: [a, b, bonus] }, CTX_BB);
  cumpleContrato(r.campanas);
  assert.deepEqual(r.campanas.map((c) => [c.campana, c.version, c.quantum, c.sitios.map((s) => s.sitio_clave.slice(-4)).join(',')]), [
    ['PARQUE PRUEBA', 'V2', 'C100001 - C100001-R1 -- C100001', '0961,0963'],
    ['PARQUE PRUEBA TORRE', 'V2', 'C200002 --- C200002-R1', '0962'],
    ['PARQUE PRUEBA TORRE', 'V3', 'C200002 --- C200002-R1', '0962'],
  ]);
  assert.ok(
    r.avisos.some((x) => /viene también en la hoja «PARQUE PRUEBA TORRE» con otro contrato \(C200002; en «PARQUE PRUEBA»: C100001\).*«PARQUE PRUEBA TORRE»/.test(x)),
    r.avisos.join(' | '),
  );
  assert.ok(r.avisos.some((x) => /«PARQUE PRUEBA \/ V2» viene en más de una hoja/.test(x)), 'el bonus del mismo contrato se junta con aviso');
  // Una hoja vieja (todo fuera del periodo) no le quita el nombre a la que sí entra.
  const vieja = hojaBB('PARQUE VIEJO', { campana: 'PARQUE PRUEBA', ini: SER(2026, 3, 1), fin: SER(2026, 4, 30), quantum: 'C300003' }, [
    fBB(1, 'MX_CM_BB_MED_0964', 'VENTA', 'V2', SER(2026, 3, 1), SER(2026, 4, 30)),
  ]);
  const r2 = B.leerBitacora({ hojas: [vieja, a] }, CTX_BB);
  assert.deepEqual(r2.campanas.map((c) => c.campana), ['PARQUE PRUEBA']);
});

test('NEGOCIACIÓN con puntuación o EXCLUSIVA: «VENTA.» y «VENTA - EXCLUISVA» son VENTA', () => {
  for (const t of ['VENTA.', 'VENTA - EXCLUISVA', 'VENTA EXCLUSIVA', 'Venta,']) assert.equal(B.leerTipoVenta(t), 'VENTA', t);
  assert.equal(B.leerTipoVenta('BONIFICACIÓN.'), 'BONUS');
  assert.equal(B.leerTipoVenta('VENTANA'), null);
  assert.equal(B.leerTipoVenta('INTERCAMBIO'), null);
  const h = hojaBB('GALLETA PRUEBA', { campana: 'GALLETA PRUEBA', ini: SER(2026, 10, 1), fin: SER(2026, 10, 31) }, [
    fBB(1, 'MX_CM_BB_MED_0971', 'VENTA - EXCLUISVA', 'V1', SER(2026, 10, 1), SER(2026, 10, 31)),
    fBB(2, 'MX_CM_BB_MED_0972', 'VENTA.', 'V1', SER(2026, 10, 1), SER(2026, 10, 31)),
  ]);
  const s = B.leerBitacora({ hojas: [h] }, CTX_BB).campanas[0].sitios;
  assert.deepEqual(s.map((x) => [x.tipo_venta, x.observaciones]), [['VENTA', 'EXCLUSIVA'], ['VENTA', null]]);
});

test('partirVersiones: separadores repetidos o al final (Biobox real «V33,, V34»)', () => {
  assert.deepEqual(B.partirVersiones('V33,, V34'), ['V33', 'V34']);
  assert.deepEqual(B.partirVersiones('V5, V6,'), ['V5', 'V6']);
  assert.deepEqual(B.partirVersiones('V1 ; ; V2'), ['V1', 'V2']);
});

test('fechas: encabezado «11 SEP» con el año del periodo, hoja con el mes primero y sin vigencia legible', () => {
  // Encabezado y renglón en texto: septiembre NO entra a octubre (antes entraba con vigencia null = todo el mes).
  const sep = hojaBB('SEPTIEMBRE PRUEBA', { campana: 'SEPTIEMBRE PRUEBA', ini: '11 SEP', fin: '30 SEP' }, [
    fBB(1, 'MX_CM_BB_MED_0981', 'VENTA', 'V1', '11 SEP', '30 SEP'),
  ]);
  const r1 = B.leerBitacora({ hojas: [sep] }, CTX_BB);
  assert.equal(r1.campanas.length, 0);
  assert.deepEqual(r1.descartadas.map((d) => [d.motivo, d.valor]), [['fuera del periodo', '2026-09-11 → 2026-09-30']]);
  // Sin periodo, el año sale del nombre del archivo.
  assert.equal(B.fechaDeArchivo('BITACORA BIOBOX OCTUBRE 2026.xlsx'), '2026-10-01');
  assert.equal(B.fechaDeArchivo('bitacora 2027.xlsx'), '2027-07-01');
  assert.equal(B.fechaDeArchivo('bitacora.xlsx'), null);
  const r2 = B.leerBitacora({ hojas: [sep] }, { unidad: 'Biobox', medio: 'Máquina', archivo: 'BITACORA SEPTIEMBRE 2026.xlsx' });
  assert.deepEqual([r2.campanas[0].sitios[0].inicio, r2.campanas[0].sitios[0].fin], ['2026-09-11', '2026-09-30']);
  // Sin año en ningún lado: el renglón no entra (con null la base le daría todo el periodo).
  const r3 = B.leerBitacora({ hojas: [sep] }, { unidad: 'Biobox', medio: 'Máquina' });
  assert.equal(r3.campanas.length, 0);
  assert.equal(r3.descartadas[0].motivo, 'sin vigencia legible (ni el renglón ni la campaña)');
  assert.ok(r3.avisos.some((a) => /Hoja «SEPTIEMBRE PRUEBA» fila 11: sin vigencia legible/.test(a)), r3.avisos.join(' | '));
  // Hoja que escribe el mes primero: «11/12/2026» después de «10/13/2026» es 12 de noviembre.
  const mp = hojaBB('MES PRIMERO', { campana: 'MES PRIMERO', ini: SER(2026, 10, 1), fin: SER(2026, 12, 31) }, [
    fBB(1, 'MX_CM_BB_MED_0982', 'VENTA', 'V1', '10/13/2026', '11/12/2026'),
  ]);
  const r4 = B.leerBitacora({ hojas: [mp] }, { ...CTX_BB, periodo: { inicio: '2026-11-01', fin: '2026-11-30' } });
  assert.equal(r4.campanas[0].sitios[0].fin, '2026-11-12');
});

test('FIN antes de INICIO y «-» se avisan por hoja; la versión «» de un renglón sin clave no es una campaña perdida', () => {
  const h = hojaBB('AVISOS PRUEBA', { campana: 'AVISOS PRUEBA', ini: SER(2026, 10, 1), fin: SER(2026, 10, 31) }, [
    fBB(1, 'MX_CM_BB_MED_0991', 'VENTA', 'V1', SER(2026, 10, 15), SER(2026, 10, 1)),
    fBB(2, 'MX_CM_BB_MED_0992', 'VENTA', 'V1', '-', '-'),
    fBB(3, 'MX_CM_BB_MED_0993', 'VENTA', 'V1', SER(2026, 10, 2), SER(2026, 10, 31)),
    fBB(4, 'PENDIENTE DE REUBICACIÓN', 'VENTA', null, SER(2026, 10, 2), SER(2026, 10, 5)),
  ]);
  const r = B.leerBitacora({ hojas: [h] }, CTX_BB);
  assert.ok(r.avisos.includes('Hoja «AVISOS PRUEBA» fila 11: FIN antes de INICIO; no se cargan.'), r.avisos.join(' | '));
  assert.ok(r.avisos.includes('Hoja «AVISOS PRUEBA» fila 12: sin vigencia (INICIO y FIN «-»); no se cargan.'));
  assert.ok(!r.avisos.some((a) => /sin sitios válidos/.test(a)), r.avisos.join(' | '));
});

test('Ecovallas: SAME PRNT es REPITE, «,png» no cambia la versión y las ocultas viejas no se avisan', () => {
  const h = hojaEV('PAN PRUEBA', { campana: 'PAN PRUEBA' }, [
    fEV('MX_CM_EV_MGP_01_9201', 'MEGAPANTALLA', 'VENTA', '1440 px x 405 px', SER(2026, 10, 13), SER(2026, 10, 26), 'PAN-PRUEBA-C,png', null, 'SAME PRNT'),
    fEV('MX_CM_EV_MGP_02_9202', 'MEGAPANTALLA', 'VENTA', '1440 px x 405 px', SER(2026, 10, 13), SER(2026, 10, 26), 'PAN-PRUEBA-C.png', null, 'SAME PRINT'),
  ]);
  const vieja = hojaEV('OCULTA VIEJA', { campana: 'OCULTA VIEJA', cat: 9 }, [], { oculta: true });
  vieja.filas[1][3] = SER(2026, 4, 20);
  vieja.filas[2][3] = SER(2026, 5, 3);
  const actual = hojaEV('OCULTA ACTUAL', { campana: 'OCULTA ACTUAL' }, [], { oculta: true });
  const r = B.leerBitacora({ hojas: [h, vieja, actual] }, { unidad: 'Ecovallas', medio: 'Pantalla', periodo: CAT21, catorcena: 21 });
  assert.deepEqual(r.campanas.map((c) => [c.version, c.arte, c.sitios.length]), [['PAN-PRUEBA-C', 'REPITE', 2]]);
  const aviso = r.avisos.find((a) => /OCULTAS/.test(a)) ?? '';
  assert.ok(/OCULTA ACTUAL/.test(aviso) && !/OCULTA VIEJA/.test(aviso), aviso);
});
