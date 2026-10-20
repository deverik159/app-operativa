// Pruebas de src/lib/ocupacionVV.ts con datos INVENTADOS: el repo es
// público y el plano real trae nombres de clientes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/ocupacionVV.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const {
  horasDeTexto,
  diasDeTexto,
  franjasTexto,
  diaSemana,
  claveEspacio,
  aFecha,
  ocupacionDelMes,
  matrizDeEspacio,
  slotsLibresPorHora,
  leerPlano,
  mesDelPlano,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const r = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const AHORA = new Date('2026-06-15T12:00:00Z');

test('horario del plano: el fin HH:00 es exclusivo', () => {
  assert.deepEqual(horasDeTexto('16:00 - 17:00'), [16]);
  assert.deepEqual(horasDeTexto('07:00 - 09:00 / 18:00 - 20:00'), [7, 8, 18, 19]);
  assert.deepEqual(horasDeTexto('21:00 - 24:00'), [21, 22, 23]);
  assert.deepEqual(horasDeTexto('00:00 - 08:00'), r(0, 7));
});

test('horario de la Bitácora: el fin HH:59 incluye la hora', () => {
  assert.deepEqual(horasDeTexto('07:00 - 21:59HRS'), r(7, 21));
  assert.deepEqual(horasDeTexto('00:00 - 23:59HRS'), r(0, 23));
});

test('24 HRS, paquetes, convencional, medianoche y NO APLICA', () => {
  assert.equal(horasDeTexto('24 HRS').length, 24);
  assert.deepEqual(horasDeTexto('14 HRS'), r(7, 20));
  assert.deepEqual(horasDeTexto('20 HRS'), [0, ...r(5, 23)]);
  assert.equal(horasDeTexto('16:00 - 17:00', true).length, 24);
  assert.deepEqual(horasDeTexto('05:00 - 01:00'), [0, ...r(5, 23)]);
  assert.deepEqual(horasDeTexto('NO APLICA'), []);
  assert.deepEqual(horasDeTexto(null), []);
});

test('días de proyección', () => {
  assert.deepEqual(diasDeTexto('LUNES A VIERNES'), [0, 1, 2, 3, 4]);
  assert.deepEqual(diasDeTexto('Sábado y Domingo'), [5, 6]);
  assert.deepEqual(diasDeTexto('MARTES, JUEVES'), [1, 3]);
  assert.equal(diasDeTexto(null), null);
  assert.equal(diaSemana('2026-10-19'), 0); // lunes
  assert.equal(diaSemana('2026-10-24'), 5); // sábado
});

test('franjas a texto', () => {
  assert.equal(franjasTexto([7, 8, 9, 18, 19]), '07:00 - 09:59 / 18:00 - 19:59');
  assert.equal(franjasTexto(r(0, 23)), '24 HRS');
  assert.equal(franjasTexto([]), '');
});

test('clave del espacio desde la de QTM', () => {
  assert.equal(claveEspacio('MX_CM_VV_COL_551'), '551');
  assert.equal(claveEspacio('MX_CM_VV_POR_0008'), 'POR_0008');
  assert.equal(claveEspacio('414'), '414');
  assert.equal(claveEspacio('POR_0015'), 'POR_0015');
});

test('fechas de Excel: serial, Date local y texto', () => {
  const serial = (Date.UTC(2026, 5, 1) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.equal(aFecha(serial), '2026-06-01');
  assert.equal(aFecha(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(aFecha('30/09/2026'), '2026-09-30');
  assert.equal(aFecha('2026-06-10'), '2026-06-10');
  assert.equal(aFecha(''), null);
  // Días que no existen no pasan (la base los rechazaría y tumbaría la importación).
  assert.equal(aFecha('31/02/2026'), null);
  assert.equal(aFecha('2026-13-45'), null);
  assert.equal(aFecha('29/02/2028'), '2028-02-29');
});

// Una columna de 12 slots en junio de 2026 (30 días: 22 entre semana, 8 de fin).
const base = { espacio: '639', campana: 'CAMPAÑA', convencional: false, inicio: '2026-06-01', fin: '2026-06-30', reservadaHasta: null };
const LINEAS = [
  // 24 h todo el mes en el slot 1: 720 horas-slot.
  { ...base, slot: 1, negociacion: 'VENTA', dias: null, horas: r(0, 23), estatus: 'vendida' },
  // Bonificación ENCIMADA en el mismo slot y horas, L-V: cuenta aparte (3 h × 22 días = 66).
  { ...base, slot: 1, negociacion: 'BONIFICACION', dias: [0, 1, 2, 3, 4], horas: [7, 8, 9], estatus: 'vendida' },
  // Apartada del plano (no vence), S-D: 2 h × 8 días = 16.
  { ...base, slot: 2, negociacion: 'VENTA', dias: [5, 6], horas: [18, 19], estatus: 'reservada' },
  // Reserva de la app ya vencida: no cuenta.
  { ...base, slot: 3, negociacion: 'VENTA', dias: null, horas: r(0, 23), estatus: 'reservada', reservadaHasta: '2026-06-01T00:00:00Z' },
];

test('ocupación del mes: línea por línea, con capacidad de 180 jugadas por hora', () => {
  const [f] = ocupacionDelMes(LINEAS, ['639'], { 639: 12 }, '2026-06', AHORA);
  assert.equal(f.dias, 30);
  assert.equal(f.mensual.capacidad, 129600);
  // 802 horas-slot × (180 / 12) jugadas.
  assert.equal(f.mensual.ocupado, 802 * 15);
  assert.equal(f.mensual.venta, 736 * 15);
  assert.equal(f.mensual.bonificacion, 66 * 15);
  assert.equal(f.mensual.reservado, 16 * 15);
  assert.ok(Math.abs(f.mensual.pOcupado - 802 / 8640) < 1e-12);
  // Banda 07:00-10:59: 4 h × 30 días de la venta + 66 de la bonificación.
  assert.ok(Math.abs(f.bandas.b2.pOcupado - 186 / 1440) < 1e-12);
});

test('ocupación: sin slots en el catálogo usa el estándar de 8', () => {
  const [f] = ocupacionDelMes(LINEAS.slice(0, 1), ['639'], {}, '2026-06', AHORA);
  assert.equal(f.slots, 8);
  assert.ok(Math.abs(f.mensual.pOcupado - 1 / 8) < 1e-12);
});

test('una línea en un slot que el catálogo ya no tiene no se pierde ni pasa de 100 %', () => {
  // El catálogo dice 8, pero el plano de ese mes usaba el slot 12 (antes era de 12).
  const lineas = Array.from({ length: 12 }, (_, i) => ({
    ...base, slot: i + 1, negociacion: 'VENTA', dias: null, horas: r(0, 23), estatus: 'vendida',
  }));
  const [f] = ocupacionDelMes(lineas, ['639'], { 639: 8 }, '2026-06', AHORA);
  assert.equal(f.slots, 12);
  assert.ok(Math.abs(f.mensual.pOcupado - 1) < 1e-12);
  const m = matrizDeEspacio(lineas, '639', 8, '2026-06-01', '2026-06-01', AHORA);
  assert.equal(m.length, 12);
  assert.equal(m[11][5].estado, 'vendida');
});

test('matriz de un fin de semana: L-V no ocupa, la apartada sí, la vencida no', () => {
  const m = matrizDeEspacio(LINEAS, '639', 12, '2026-06-06', '2026-06-07', AHORA);
  assert.equal(m.length, 12);
  assert.equal(m[0][8].estado, 'vendida');
  assert.equal(m[0][8].lineas.length, 1); // la bonificación L-V no entra
  assert.equal(m[1][18].estado, 'reservada');
  assert.equal(m[2][3].estado, 'libre');
  const libres = slotsLibresPorHora(m);
  assert.equal(libres[18], 10);
  assert.equal(libres[3], 11);
});

test('matriz: en una celda con venta y reserva manda la venta', () => {
  const lineas = [
    { ...base, slot: 1, negociacion: 'VENTA', dias: null, horas: [10], estatus: 'reservada' },
    { ...base, slot: 1, negociacion: 'VENTA', dias: null, horas: [10], estatus: 'vendida' },
  ];
  const m = matrizDeEspacio(lineas, '639', 8, '2026-06-01', '2026-06-01', AHORA);
  assert.equal(m[0][10].estado, 'vendida');
  assert.equal(m[0][10].lineas.length, 2);
});

test('leer el plano: encabezado abajo, columnas de más y avisos', () => {
  const serial = (Date.UTC(2026, 5, 1) - Date.UTC(1899, 11, 30)) / 86400000;
  const filas = [
    ['PLANO DE COLUMNAS VÍA VERDE'],
    [],
    ['Plaza', 'Columna', 'Slots', 'Tipo Pauta', 'Campaña', 'Negociación', 'Fecha Inicio', 'Fecha Fin', 'Estatus', 'Dias Proyección', 'Horarios', '00:00:00'],
    ['CDMX', 'MX_CM_VV_COL_551', 1, 'POR HORARIO', 'CAMPAÑA UNO', 'VENTA', serial, serial + 29, 'NO DISPONIBLE', null, '07:00 - 09:00 / 18:00 - 20:00', 'X'],
    ['CDMX', 'MX_CM_VV_COL_551', 2, 'CONVENCIONAL', 'CAMPAÑA DOS', 'BONIFICACIÓN', new Date(2026, 0, 1), '30/09/2026', 'PAUTADA', null, '24 HRS'],
    ['CDMX', 'MX_CM_VV_COL_551', 3, 'POR HORARIO', 'CAMPAÑA TRES', 'VENTA', '2026-06-10', '2026-06-20', 'DISPONIBLE', 'SÁBADO Y DOMINGO', '16:00 - 17:00'],
    ['CDMX', 'MX_CM_VV_COL_551', 12, null, null, null, null, null, 'DISPONIBLE', null, null],
    ['CDMX', 'MX_CM_VV_POR_0008', 1, 'POR HORARIO', 'CAMPAÑA CUATRO', 'TRUEQUE', '2026-06-01', '2026-06-30', 'NO DISPONIBLE', null, '08:00 - 09:00'],
    ['CDMX', 'MX_CM_VV_COL_639', 'x', 'POR HORARIO', 'CAMPAÑA CINCO', 'VENTA', '2026-06-01', '2026-06-30', 'NO DISPONIBLE', null, '08:00 - 09:00'],
    ['CDMX', 'MX_CM_VV_COL_639', 25, 'POR HORARIO', 'CAMPAÑA SIETE', 'VENTA', '2026-06-01', '2026-06-30', 'NO DISPONIBLE', null, '08:00 - 09:00'],
  ];
  const res = leerPlano(filas, 'PAUTA JUNIO');
  assert.deepEqual(res.faltan, []);
  assert.equal(res.mes, '2026-06');
  assert.equal(res.lineas.length, 3);
  const [a, b, c] = res.lineas;
  assert.equal(a.espacio, '551');
  assert.equal(a.fila, 4);
  assert.equal(a.inicio, '2026-06-01');
  assert.equal(a.fin, '2026-06-30');
  assert.deepEqual(a.horas, [7, 8, 18, 19]);
  assert.equal(a.estatus, 'vendida');
  assert.equal(b.convencional, true);
  assert.equal(b.horas.length, 24);
  assert.equal(b.negociacion, 'BONIFICACION');
  assert.equal(b.estatus, 'pautada');
  assert.equal(b.inicio, '2026-01-01');
  assert.equal(b.fin, '2026-09-30');
  assert.equal(c.estatus, 'reservada');
  assert.equal(c.reservadaHasta, null);
  assert.deepEqual(c.dias, [5, 6]);
  assert.deepEqual(c.horas, [16]);
  assert.equal(res.slotsVistos['551'], 12);
  assert.equal(res.slotsVistos['639'], undefined); // ni 'x' ni 25 cuentan como slots
  assert.equal(res.avisos.length, 3);
});

test('leer el plano: franjas separadas con guion se leen las dos y avisan', () => {
  const filas = [
    ['Columna', 'Slots', 'Campaña', 'Fecha Inicio', 'Fecha Fin', 'Horarios'],
    ['MX_CM_VV_COL_639', 4, 'CAMPAÑA SEIS', '2026-06-01', '2026-06-30', '09:00 - 12:00 - 16:00 - 19:00'],
  ];
  const res = leerPlano(filas, 'PAUTA JUNIO');
  assert.deepEqual(res.lineas[0].horas, [9, 10, 11, 16, 17, 18]);
  assert.equal(res.avisos.length, 1);
  assert.match(res.avisos[0], /guion/);
});

test('leer el plano: sin la columna de horarios no importa nada', () => {
  const res = leerPlano([['Columna', 'Slots', 'Campaña', 'Fecha Inicio', 'Fecha Fin']], 'PAUTA JUNIO');
  assert.deepEqual(res.faltan, ['horario']);
  assert.equal(res.lineas.length, 0);
});

test('mes del plano: hoja con año, o el más común', () => {
  assert.equal(mesDelPlano('PAUTA AGOSTO 2027', []), '2027-08');
  assert.equal(mesDelPlano('Hoja1', [{ inicio: '2026-11-01' }, { inicio: '2026-11-15' }, { inicio: '2026-10-20' }]), '2026-11');
});
