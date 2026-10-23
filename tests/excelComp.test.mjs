// Los tres Excel de Comprobaciones armados por la app (rediseño de Erik,
// 23-oct-2026): Asignación de clientes (+ Comprobación diaria), Formato
// general y archivo por monitorista.
// Repo PÚBLICO: campañas, personas y claves son INVENTADAS; solo se copia la
// FORMA de los Excel reales (encabezados, orden, títulos, filas de pie).
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/excelComp.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const E = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const {
  serialExcel,
  celdaFecha,
  celdaPct,
  periodoCorto,
  periodoTitulo,
  etiquetaDia,
  nombreCorto,
  nombreHoja,
  nombreArchivo,
  campanaConVersion,
  estatusExcel,
  diasDeLaDiaria,
  armarAsignacion,
  ordenarTomas,
  letraColumna,
  armarFormatoGeneral,
  repartirPorMonitorista,
  armarArchivoMonitorista,
  armarArchivosMonitoristas,
  aLibroXlsx,
  configMedio,
  SIN_ANALISTA_EXCEL,
  SIN_MONITORISTA_EXCEL,
} = E;

const AGOSTO = { tipo: 'mes', anio: 2026, numero: 8, inicio: '2026-08-01', fin: '2026-08-31' };
const CAT18 = { tipo: 'catorcena', anio: 2026, numero: 18, inicio: '2026-08-31', fin: '2026-09-13' };
const fecha = (dia) => ({ t: 'n', v: serialExcel(dia), z: 'd/m/yyyy' });
const pct = (v) => ({ t: 'n', v, z: '0%' });

// ------------------------------------------------------------
// Celdas y textos
// ------------------------------------------------------------

test('serialExcel y celdaFecha: el día no se mueve por la zona', () => {
  assert.equal(serialExcel('2026-08-01'), 46235); // A5 del formato de Vía Verde de agosto
  assert.equal(serialExcel('2026-09-03'), 46268);
  assert.equal(serialExcel('1900-03-01'), 61);
  assert.equal(serialExcel('2026-02-30'), null);
  assert.deepEqual(celdaFecha('2026-08-01'), { t: 'n', v: 46235, z: 'd/m/yyyy' });
  // Marca de tiempo: cuenta el día de CDMX (01:30 UTC del 1-ago = 31-jul a las 19:30 en CDMX).
  assert.deepEqual(celdaFecha('2026-08-01T01:30:00Z'), { t: 'n', v: 46234, z: 'd/m/yyyy' });
  assert.equal(celdaFecha(null), null);
  assert.equal(celdaFecha('  '), null);
  assert.equal(celdaFecha('ayer'), null);
  assert.deepEqual(celdaPct(0.5), { t: 'n', v: 0.5, z: '0%' });
  assert.deepEqual(celdaPct(NaN), { t: 'n', v: 0, z: '0%' });
});

test('periodo, día y nombres como en los Excel de hoy', () => {
  assert.equal(periodoCorto(AGOSTO), 'AGOSTO');
  assert.equal(periodoTitulo(AGOSTO), 'AGOSTO 2026');
  assert.equal(periodoCorto(CAT18), 'CAT 18');
  assert.equal(periodoTitulo({ tipo: 'catorcena', anio: 2026, numero: 3 }), 'CAT 03 2026');
  assert.equal(etiquetaDia('2026-08-03'), 'LUNES 03');
  assert.equal(etiquetaDia('2026-08-05'), 'MIERCOLES 05');
  assert.equal(etiquetaDia('2026-08-01'), 'SABADO 01');
  assert.equal(etiquetaDia('x'), '');
  assert.equal(nombreCorto('Ángel Prueba Uno'), 'ANGEL');
  assert.equal(nombreCorto('  luisa  ejemplo '), 'LUISA');
  assert.equal(nombreCorto('luisa.ejemplo@empresa.test'), 'LUISA');
  assert.equal(nombreCorto('Iñaki'), 'IÑAKI');
  assert.equal(nombreCorto(null), '');
  assert.equal(nombreHoja('ASIGNACIÓN DE CLIENTES CDMX'), 'ASIGNACIÓN DE CLIENTES CDMX');
  assert.equal(nombreHoja('A/B: [x]*?'), 'A B x');
  assert.equal(nombreHoja('X'.repeat(40)).length, 31);
  assert.equal(nombreHoja('  '), 'HOJA');
  assert.equal(nombreArchivo('Formato: "A/B" <x>.xlsx'), 'Formato A B x .xlsx');
  assert.equal(campanaConVersion('CAMPAÑA PRUEBA ALFA', 'V5'), 'CAMPAÑA PRUEBA ALFA / V5');
  assert.equal(campanaConVersion('CAMPAÑA PRUEBA ALFA', ''), 'CAMPAÑA PRUEBA ALFA');
  assert.equal(letraColumna(0), 'A');
  assert.equal(letraColumna(25), 'Z');
  assert.equal(letraColumna(26), 'AA');
  assert.equal(letraColumna(33), 'AH');
});

test('estatusExcel: CERRADA solo si la cerró el Supervisor; COMPLETA si llegó a la meta', () => {
  assert.equal(estatusExcel({ estatus: 'cerrada', venta: 10, comprobados: 4 }), 'CERRADA');
  assert.equal(estatusExcel({ estatus: 'abierta', venta: 10, comprobados: 10 }), 'COMPLETA');
  assert.equal(estatusExcel({ estatus: 'abierta', venta: 10, comprobados: 9 }), '');
  assert.equal(estatusExcel({ estatus: 'abierta', venta: 0, comprobados: 0 }), '');
});

// ------------------------------------------------------------
// 1. Asignación de clientes + Comprobación diaria (Biobox, agosto)
// ------------------------------------------------------------

const CAMPANAS_BB = [
  {
    id: 11,
    campana: 'CAMPAÑA PRUEBA ALFA',
    version: 'V5',
    vendedor: 'VENDEDORA UNO',
    ejecutivo: 'EJECUTIVA UNO',
    arte: 'REPITE',
    analista: 'Ángel Prueba',
    venta: 17,
    comprobados: 17,
    estatus: 'cerrada',
    cerrada_en: '2026-08-12T18:00:00Z',
  },
  {
    id: 12,
    campana: 'CAMPAÑA PRUEBA ALFA',
    version: 'V6',
    vendedor: 'VENDEDORA UNO',
    ejecutivo: 'EJECUTIVA UNO',
    arte: 'REPITE',
    analista: 'Marcos Ejemplo',
    venta: '4',
    comprobados: '1',
    estatus: 'abierta',
  },
  {
    id: 13,
    campana: 'BETA DE PRUEBA CAT 02',
    version: '',
    vendedor: 'VENDEDOR DOS',
    ejecutivo: null,
    arte: 'NUEVO',
    analista: null,
    venta: 5,
    comprobados: 5,
    estatus: 'abierta',
  },
];

const MARCAS_BB = [
  { campana_id: 11, comprobado_por: 'angel@empresa.test', dia: '2026-08-03', sitios: 10 },
  { campana_id: 11, comprobado_por: 'angel@empresa.test', dia: '2026-08-04', sitios: 7 },
  { campana_id: 12, comprobado_por: 'marcos@empresa.test', dia: '2026-08-08', sitios: 1 }, // sábado
  { campana_id: 13, comprobado_por: 'marcos@empresa.test', dia: '2026-08-31', sitios: 3 },
  { campana_id: 13, comprobado_por: 'marcos@empresa.test', dia: '2026-09-02', sitios: 2 }, // fuera
];

test('armarAsignacion Biobox: hoja de asignación con el acomodo de hoy', () => {
  const libro = armarAsignacion({ medio: 'Máquina', periodo: AGOSTO, campanas: CAMPANAS_BB, marcas: MARCAS_BB });
  assert.equal(libro.nombreArchivo, 'Asignación de Clientes Biobox Agosto 2026.xlsx');
  assert.deepEqual(
    libro.hojas.map((h) => h.nombre),
    ['ASIGNACIÓN DE CLIENTES CDMX', 'COMPROBACIÓN DIARIA CDMX', 'ESPECIFICACIÓN DE TOMAS']
  );
  const h = libro.hojas[0];
  assert.deepEqual(h.filas[0], []);
  assert.deepEqual(h.filas[1], ['COMPROBACIONES BIOBOX AGOSTO 2026']);
  assert.deepEqual(h.filas[2], [null, null, null, null, null, 'VENTA', null, null, 'COMPROBACIÓN']);
  assert.deepEqual(h.filas[3], [null, null, null, null, 'PLAZA', 'CDMX', 'TOTAL', null, 'CDMX', 'TOTAL']);
  assert.deepEqual(h.filas[4], [
    'VENDEDOR',
    'EJECUTIVO',
    'ARTES',
    'DISEÑADOR',
    'CAMPAÑA',
    'BIOBOX CDMX',
    ' VENTA CDMX',
    null,
    'BIOBOX CDMX',
    'COMPROBACIÓN CDMX',
    null,
    '% AVANCES CDMX',
    'ESTATUS CDMX',
    'FECHA DE CIERRE CDMX',
  ]);
  // Datos desde la fila 6 de Excel (índice 5), en el orden en que llegaron.
  assert.deepEqual(h.filas[5], [
    'VENDEDORA UNO',
    'EJECUTIVA UNO',
    'REPITE',
    'ANGEL',
    'CAMPAÑA PRUEBA ALFA / V5',
    17,
    17,
    null,
    17,
    17,
    null,
    pct(1),
    'CERRADA',
    fecha('2026-08-12'),
  ]);
  assert.deepEqual(h.filas[6], [
    'VENDEDORA UNO',
    'EJECUTIVA UNO',
    'REPITE',
    'MARCOS',
    'CAMPAÑA PRUEBA ALFA / V6',
    4,
    4,
    null,
    1,
    1,
    null,
    pct(0.25),
    null,
    null,
  ]);
  assert.deepEqual(h.filas[7].slice(0, 5), ['VENDEDOR DOS', null, 'NUEVO', SIN_ANALISTA_EXCEL, 'BETA DE PRUEBA CAT 02']);
  assert.equal(h.filas[7][12], 'COMPLETA'); // llegó a la meta pero nadie la cerró (P1)
  // Pie: TOTAL, % AVANCE, DISEÑADORES y uno por diseñador (SIN ASIGNAR al final).
  assert.deepEqual(h.filas[8], []);
  assert.deepEqual(h.filas[9], [null, null, null, null, 'TOTAL', 26, 26, null, 23, 23, null, pct(23 / 26)]);
  assert.deepEqual(h.filas[10], []);
  assert.deepEqual(h.filas[11], [null, null, null, null, null, null, '% AVANCE', null, pct(23 / 26), pct(23 / 26)]);
  assert.deepEqual(h.filas[12], ['DISEÑADORES']);
  assert.deepEqual(h.filas[13], ['ANGEL', 17, null, null, null, null, '% ANGEL', null, pct(1), pct(1)]);
  assert.deepEqual(h.filas[14], ['MARCOS', 4, null, null, null, null, '% MARCOS', null, pct(0.25), pct(0.25)]);
  assert.deepEqual(h.filas[15], [SIN_ANALISTA_EXCEL, 5, null, null, null, null, `% ${SIN_ANALISTA_EXCEL}`, null, pct(1), pct(1)]);
  assert.equal(h.filas.length, 16);
  assert.deepEqual(h.merges, [
    { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } }, // A2:C2, como la de hoy
    { s: { r: 2, c: 5 }, e: { r: 2, c: 6 } },
    { s: { r: 2, c: 8 }, e: { r: 2, c: 9 } },
  ]);
  assert.equal(h.autofiltro, 'A5:N8');
  assert.equal(h.anchos.length, 14);
});

test('armarAsignacion: hoja diaria con los días hábiles, el sábado marcado y lo de fuera del periodo', () => {
  const h = armarAsignacion({ medio: 'Máquina', periodo: AGOSTO, campanas: CAMPANAS_BB, marcas: MARCAS_BB }).hojas[1];
  assert.deepEqual(h.filas[1], ['COMPROBACIONES DIARIAS']);
  const dias = h.filas[3].slice(5);
  // Agosto 2026: 21 días hábiles (LUNES 03 … LUNES 31) + el sábado 08 que alguien marcó.
  assert.equal(dias[0], 'LUNES 03');
  assert.ok(dias.includes('SABADO 08'));
  assert.ok(!dias.includes('SABADO 01'));
  assert.deepEqual(dias.slice(-3), ['LUNES 31', 'TOTAL', 'FUERA DEL PERIODO']);
  assert.equal(dias.length, 22 + 2);
  assert.deepEqual(h.filas[4].slice(0, 6), ['VENDEDOR', 'EJECUTIVO', 'ARTES', 'DISEÑADOR', 'CAMPAÑA', 'BIOBOX CDMX']);
  const col = (etq) => 5 + dias.indexOf(etq);
  const f11 = h.filas[5];
  assert.equal(f11[4], 'CAMPAÑA PRUEBA ALFA / V5');
  assert.equal(f11[col('LUNES 03')], 10);
  assert.equal(f11[col('MARTES 04')], 7);
  assert.equal(f11[col('MIERCOLES 05')], null); // día sin marcas: en blanco, como hoy
  assert.equal(f11[col('TOTAL')], 17);
  assert.equal(f11[col('FUERA DEL PERIODO')], null);
  const f12 = h.filas[6];
  assert.equal(f12[col('SABADO 08')], 1);
  const f13 = h.filas[7];
  assert.equal(f13[col('LUNES 31')], 3);
  assert.equal(f13[col('TOTAL')], 3);
  assert.equal(f13[col('FUERA DEL PERIODO')], 2);
  // Renglón TOTAL: los ceros sí se escriben.
  const tot = h.filas[9];
  assert.equal(tot[4], 'TOTAL');
  assert.equal(tot[col('MIERCOLES 05')], 0);
  assert.equal(tot[col('LUNES 03')], 10);
  assert.equal(tot[col('TOTAL')], 21); // 10 + 7 + 1 (sábado) + 3; lo de fuera va aparte
  assert.equal(tot[col('FUERA DEL PERIODO')], 2);
  assert.equal(h.anchos.length, 5 + dias.length);
});

test('diasDeLaDiaria: hábiles por omisión, todos si se pide', () => {
  assert.equal(diasDeLaDiaria(AGOSTO, []).length, 21);
  assert.equal(diasDeLaDiaria(AGOSTO, [], false).length, 31);
  assert.equal(diasDeLaDiaria(AGOSTO, [{ dia: '2026-08-02' }]).length, 22);
  assert.deepEqual(diasDeLaDiaria({ inicio: '2026-08-31', fin: '2026-08-01' }, []), []);
});

test('armarAsignacion sin campañas y sin marcas: solo encabezados y pie en cero', () => {
  const libro = armarAsignacion({ medio: 'Columna', periodo: AGOSTO, campanas: [] });
  const [a, d] = libro.hojas;
  assert.equal(libro.nombreArchivo, 'Asignación de Clientes Columnas Agosto 2026.xlsx');
  assert.deepEqual(a.filas[1], ['COMPROBACIONES COLUMNAS AGOSTO 2026']);
  assert.equal(a.filas[4][5], 'COLUMNAS CDMX');
  assert.deepEqual(a.filas[6], [null, null, null, null, 'TOTAL', 0, 0, null, 0, 0, null, pct(0)]);
  assert.deepEqual(a.filas.at(-1), ['DISEÑADORES']);
  assert.equal(a.autofiltro, undefined);
  assert.ok(!d.filas[3].includes('FUERA DEL PERIODO'));
});

test('armarAsignacion Pórticos: hojas «… PORTICOS» como el archivo de hoy', () => {
  const libro = armarAsignacion({ medio: 'Pórtico', periodo: AGOSTO, campanas: [] });
  assert.equal(libro.nombreArchivo, 'Asignación de Clientes Porticos Agosto 2026.xlsx');
  assert.deepEqual(
    libro.hojas.map((h) => h.nombre),
    ['ASIGNACIÓN DE CLIENTES PORTICOS', 'COMPROBACIÓN DIARIA PORTICOS', 'ESPECIFICACIÓN DE COMPROBACIÓN']
  );
  assert.deepEqual(libro.hojas[0].filas[1], ['COMPROBACIONES PORTICOS AGOSTO 2026']);
  // El F5 de la Asignación de Pórticos de hoy dice «COLUMNAS CDMX».
  assert.equal(libro.hojas[0].filas[4][5], 'COLUMNAS CDMX');
});

// ------------------------------------------------------------
// 2. Formato general
// ------------------------------------------------------------

const TOMAS_EV = [
  {
    id: 503,
    fecha: '2026-09-02',
    sitio: 'MX_CM_EV_MGP_09_0902',
    ruta: '3',
    campana: 'TEATRO DE PRUEBA',
    version: 'OBRA UNO',
    horario: '24 HRS',
    observaciones: 'DEL 01 AL 14 DE SEPTIEMBRE. TOMAS MEDIAS',
    monitorista: 'Saúl Prueba',
  },
  {
    id: 501,
    fecha: '2026-08-31',
    sitio: 'MX_CM_EV_MGP_09_0903',
    ruta: 2,
    campana: 'TEATRO DE PRUEBA',
    version: 'OBRA UNO',
    horario: '24 HRS',
    observaciones: null,
    monitorista: 'SAUL PRUEBA',
    estatus: 'COMPROBADO',
  },
  {
    id: 502,
    fecha: '2026-08-31',
    sitio: 'MX_CM_EV_MGP_09_0901',
    ruta: 2,
    campana: 'TEATRO DE PRUEBA',
    version: 'OBRA UNO',
    comprobacion: 'VIDEO',
    horario: '7:00 - 9:59',
    monitorista: 'Aline Ejemplo',
  },
  {
    id: 504,
    fecha: null,
    sitio: 'MX_CM_EV_MGP_09_0904',
    ruta: null,
    campana: 'ALFA EN ESPERA',
    version: 'PENDIENTE',
    observaciones: 'DETENIDA',
    monitorista: null,
  },
];

test('ordenarTomas: fecha, campaña, versión, ruta, sitio; sin fecha al final', () => {
  assert.deepEqual(
    ordenarTomas(TOMAS_EV).map((t) => t.id),
    [502, 501, 503, 504]
  );
  // No cambia el arreglo original.
  assert.equal(TOMAS_EV[0].id, 503);
});

test('armarFormatoGeneral Ecovallas Digital: encabezado y renglones como la hoja «ECOVALLAS DIGITALES CAT 18»', () => {
  const libro = armarFormatoGeneral({ medio: 'Pantalla', periodo: CAT18, tomas: TOMAS_EV });
  assert.equal(libro.nombreArchivo, 'Formato Comprobaciones Ecovallas Digitales Cat 18 2026.xlsx');
  const [h] = libro.hojas;
  assert.equal(h.nombre, 'ECOVALLAS DIGITALES CAT 18');
  assert.deepEqual(h.filas[1], ['TOMA COMPROBACIONES ECOVALLAS DIGITALES CAT 18 2026']);
  assert.deepEqual(h.filas[3], [
    'FECHA',
    'CLAVE',
    'RUTA',
    'CAMPAÑAS',
    'VERSIÓN',
    'COMPROBACIÓN',
    'HORARIO',
    'OBSERVACIONES',
    null,
    'MONITORISTA',
    'ESTATUS',
    'FOTO COMPROBATORIA',
    'TOMA CORTA',
    'TOMA MEDIA',
    'TOMA LARGA',
    'FECHA DE TOMA',
    'FECHA DE COMPROBACIÓN',
    'QUIEN TOMA',
    'OBSERVACIONES',
    'LLAVE',
  ]);
  assert.deepEqual(h.filas[4], [
    fecha('2026-08-31'),
    'MX_CM_EV_MGP_09_0901',
    2,
    'TEATRO DE PRUEBA',
    'OBRA UNO',
    'VIDEO',
    // Ecovallas Digital es todo 24 horas (Erik, 23-oct-2026): aunque la toma
    // traiga una franja, el HORARIO sale «24 HORAS».
    '24 HORAS',
    null,
    null,
    'Aline Ejemplo',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    502,
  ]);
  assert.equal(h.filas[5][5], 'FOTO'); // por omisión, como todas las filas de hoy
  assert.equal(h.filas[5][10], 'COMPROBADO');
  assert.equal(h.filas[6][2], 3); // ruta '3' → número, como la de hoy
  // La de sin fecha va al final, con FECHA en blanco y sin monitorista.
  const ultima = h.filas[7];
  assert.equal(ultima[0], null);
  assert.equal(ultima[2], null);
  assert.equal(ultima[9], null);
  assert.equal(ultima[19], 504);
  assert.equal(h.filas.length, 8);
  assert.equal(h.autofiltro, 'A4:T8');
  assert.equal(h.anchos.length, h.filas[3].length);
});

test('armarFormatoGeneral Biobox, Vía Verde y Pórticos: títulos, hojas y columnas de cada unidad', () => {
  const t = [{ id: 1, fecha: '2026-08-01', sitio: 'X1', campana: 'C', version: 'V1', horario: '24 HORAS' }];
  const bb = armarFormatoGeneral({ medio: 'Máquina', periodo: AGOSTO, tomas: t }).hojas[0];
  assert.equal(bb.nombre, 'AGOSTO');
  assert.deepEqual(bb.filas[1], [
    'TOMA COMPROBACIONES BIOBOX AGOSTO 2026',
    null,
    null,
    null,
    null,
    'TOMAR LAS FOTOS DE ACUERDO A LA FECHA LIMITE',
  ]);
  assert.deepEqual(bb.merges, [{ s: { r: 1, c: 0 }, e: { r: 1, c: 4 } }]); // A2:E2
  // El A4 del formato de Biobox de hoy dice «FECHAS».
  assert.deepEqual(bb.filas[3].slice(0, 4), ['FECHAS', 'BIOBOX', 'RUTA', 'CAMPAÑA']);
  assert.deepEqual(bb.filas[3].slice(11, -1), configMedio('Máquina').seguimiento);
  const vv = armarFormatoGeneral({ medio: 'Columna', periodo: AGOSTO, tomas: t });
  assert.equal(vv.nombreArchivo, 'Formato Comprobaciones Columnas Agosto 2026.xlsx');
  assert.equal(vv.hojas[0].nombre, 'GENERAL');
  assert.deepEqual(vv.hojas[0].filas[1], ['FORMATO GENERAL COMPROBACIONES AGOSTO 2026']);
  // Vía Verde no trae RUTA hoy (se reparte por turno)…
  assert.deepEqual(vv.hojas[0].filas[3], [
    'FECHA',
    'COLUMNA',
    'CAMPAÑA',
    'VERSIÓN',
    'COMPROBACIÓN',
    'HORARIO',
    'OBSERVACIONES',
    null,
    'MONITORISTA',
    'ESTATUS',
    'COLOR CAMPO',
    'CAMPO',
    'LLAVE',
  ]);
  // …y si alguna toma trae ruta, la columna va al FINAL (antes de LLAVE),
  // sin correr las demás letras respecto al Excel de hoy (revisión 2).
  const vvRuta = armarFormatoGeneral({ medio: 'Columna', periodo: AGOSTO, tomas: [{ ...t[0], ruta: '7' }] });
  assert.equal(vvRuta.hojas[0].filas[3][2], 'CAMPAÑA');
  assert.deepEqual(vvRuta.hojas[0].filas[3].slice(-2), ['RUTA', 'LLAVE']);
  assert.equal(vvRuta.hojas[0].filas[4].at(-2), 7);
  assert.equal(vvRuta.hojas[0].anchos.length, vvRuta.hojas[0].filas[3].length);
  const po = armarFormatoGeneral({ medio: 'Pórtico', periodo: AGOSTO, tomas: t }).hojas[0];
  assert.equal(po.nombre, 'PORTICOS AGOSTO');
  assert.deepEqual(po.filas[3].slice(0, 2), ['FECHA', 'PORTICO']);
  assert.equal(po.filas[3].at(-1), 'LLAVE');
});

// ------------------------------------------------------------
// 3. Archivo por monitorista
// ------------------------------------------------------------

test('repartirPorMonitorista: junta «Saúl Prueba» y «SAUL PRUEBA»; sin monitorista al final', () => {
  const g = repartirPorMonitorista(TOMAS_EV);
  assert.deepEqual(
    g.map((x) => [x.monitorista, x.tomas.map((t) => t.id)]),
    [
      ['Aline Ejemplo', [502]],
      ['Saúl Prueba', [503, 501]],
      [null, [504]],
    ]
  );
  assert.deepEqual(repartirPorMonitorista([]), []);
});

test('armarArchivoMonitorista: copia filtrada con columnas para anotar', () => {
  const libro = armarArchivoMonitorista({ medio: 'Pantalla', periodo: CAT18, monitorista: 'saul prueba', tomas: TOMAS_EV });
  assert.equal(libro.nombreArchivo, 'Formato Comprobaciones Ecovallas Digitales Cat 18 2026 SAUL PRUEBA.xlsx');
  const [h] = libro.hojas;
  assert.equal(h.nombre, 'SAUL PRUEBA CAT 18');
  const enc = h.filas[3];
  assert.deepEqual(enc, [
    'FECHA',
    'CLAVE',
    'RUTA',
    'CAMPAÑAS',
    'VERSIÓN',
    'COMPROBACIÓN',
    'HORARIO',
    'OBSERVACIONES',
    null,
    'FOTO COMPROBATORIA',
    'FECHA DE TOMA',
    'OBSERVACIONES',
    'LLAVE',
  ]);
  assert.equal(h.filas[1][0], 'TOMA COMPROBACIONES ECOVALLAS DIGITALES CAT 18 2026');
  assert.equal(h.filas[1][9], 'REGISTRAR LA FECHA DEL DIA QUE SE TOMO');
  assert.equal(h.filas[1].length, 10);
  assert.ok(h.filas[1].every((x) => x !== undefined)); // sin huecos
  assert.equal(h.filas[2][9], 'SAUL PRUEBA');
  assert.deepEqual(h.merges, [{ s: { r: 2, c: 9 }, e: { r: 2, c: 11 } }]);
  // Solo sus 2 tomas, en orden, con las columnas para anotar en blanco.
  assert.deepEqual(
    h.filas.slice(4).map((f) => f.at(-1)),
    [501, 503]
  );
  assert.deepEqual(h.filas[4].slice(9, 12), [null, null, null]);
  assert.equal(h.autofiltro, 'A4:M6');
});

test('armarArchivosMonitoristas: uno por monitorista y uno de lo que falta repartir', () => {
  const libros = armarArchivosMonitoristas({ medio: 'Columna', periodo: AGOSTO, tomas: TOMAS_EV });
  assert.deepEqual(
    libros.map((l) => l.nombreArchivo),
    [
      'Formato Comprobaciones Columnas Agosto 2026 ALINE EJEMPLO.xlsx',
      'Formato Comprobaciones Columnas Agosto 2026 SAUL PRUEBA.xlsx', // el nombre de su primera toma en orden (501, del 31-ago)
      `Formato Comprobaciones Columnas Agosto 2026 ${SIN_MONITORISTA_EXCEL}.xlsx`,
    ]
  );
  // Vía Verde: con ruta en las tomas aparece RUTA al final (antes de
  // LLAVE); la de sin ruta no. La columna C sigue siendo CAMPAÑA.
  assert.equal(libros[0].hojas[0].filas[3][2], 'CAMPAÑA');
  assert.deepEqual(libros[0].hojas[0].filas[3].slice(-2), ['RUTA', 'LLAVE']);
  assert.equal(libros[2].hojas[0].filas[3][2], 'CAMPAÑA');
  assert.notEqual(libros[2].hojas[0].filas[3].at(-2), 'RUTA');
  assert.equal(libros[2].hojas[0].filas.length, 5);
});

// ------------------------------------------------------------
// De ida y vuelta por SheetJS (lo que hará la pantalla)
// ------------------------------------------------------------

function idaYVuelta(libro) {
  const wb = aLibroXlsx(libro, XLSX);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return XLSX.read(buf, { type: 'buffer', cellNF: true, cellStyles: true });
}

test('aLibroXlsx: fechas, %, combinadas, anchos y filtro sobreviven al escribir y leer el .xlsx', () => {
  const wb = idaYVuelta(armarAsignacion({ medio: 'Máquina', periodo: AGOSTO, campanas: CAMPANAS_BB, marcas: MARCAS_BB }));
  assert.deepEqual(wb.SheetNames, ['ASIGNACIÓN DE CLIENTES CDMX', 'COMPROBACIÓN DIARIA CDMX', 'ESPECIFICACIÓN DE TOMAS']);
  const ws = wb.Sheets['ASIGNACIÓN DE CLIENTES CDMX'];
  assert.equal(ws.A2.v, 'COMPROBACIONES BIOBOX AGOSTO 2026');
  assert.equal(ws.A5.v, 'VENDEDOR');
  assert.equal(ws.E6.v, 'CAMPAÑA PRUEBA ALFA / V5');
  assert.equal(ws.F6.v, 17);
  assert.equal(ws.L7.v, 0.25);
  assert.equal(ws.L7.z, '0%');
  assert.equal(ws.N6.v, 46246); // 12-ago-2026
  assert.equal(ws.N6.z, 'd/m/yyyy');
  assert.equal(ws.H6, undefined); // separador vacío
  assert.equal(ws['!merges'].length, 3);
  assert.equal(XLSX.utils.encode_range(ws['!merges'][0]), 'A2:C2');
  assert.equal(ws['!autofilter'].ref, 'A5:N8');
  assert.ok(Math.abs(ws['!cols'][4].wch - 45) < 0.5);
  const d = wb.Sheets['COMPROBACIÓN DIARIA CDMX'];
  assert.equal(d.F4.v, 'LUNES 03');
  assert.equal(d.F6.v, 10);
});

test('aLibroXlsx: el formato general se lee igual que los Excel de hoy (A4 FECHA, A5 la fecha)', () => {
  const wb = idaYVuelta(armarFormatoGeneral({ medio: 'Pantalla', periodo: CAT18, tomas: TOMAS_EV }));
  const ws = wb.Sheets['ECOVALLAS DIGITALES CAT 18'];
  assert.equal(ws.A4.v, 'FECHA');
  assert.equal(ws.A5.v, 46265); // 31-ago-2026
  assert.equal(ws.A5.z, 'd/m/yyyy');
  assert.equal(ws.T4.v, 'LLAVE');
  assert.equal(ws.T5.v, 502);
  // sheet_to_json con cellDates (como lee la app) da el mismo día.
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null, blankrows: true });
  assert.equal(filas[4][0], '31/8/2026');
});

test('aLibroXlsx: dos hojas con el mismo nombre no truenan', () => {
  const hoja = { nombre: 'GENERAL', filas: [['a']], merges: [], anchos: [10] };
  const wb = aLibroXlsx({ nombreArchivo: 'x.xlsx', hojas: [hoja, hoja] }, XLSX);
  assert.deepEqual(wb.SheetNames, ['GENERAL', 'GENERAL (2)']);
});

// ------------------------------------------------------------
// Revisión del núcleo (23-oct-2026): lo que se corrigió
// ------------------------------------------------------------

const {
  celdaDia,
  estatusToma,
  tomaParaCampo,
  armarArchivoMonitoristasCompartido,
} = E;

const T = (o) => ({ fecha: '2026-08-03', sitio: 'MX_CM_BB_MED_0002', ruta: 2, campana: 'CAMPAÑA PRUEBA', version: 'V1', ...o });
const llaves = (h) => h.filas.slice(4).map((f) => f.at(-1));

test('OBSERVACIONES lleva la especificación de la campaña, como los Excel de hoy', () => {
  const esp = 'DEL 01 AL 31 DE AGOSTO. FOTOS A MAS TARDAR EL 10 DE AGOSTO. (CONSIDERAR TOMAS NORMALES Y POR LADO)';
  const tomas = [
    T({ id: 1, especificacion: esp, observaciones: null }),
    T({ id: 2, sitio: 'MX_CM_BB_MED_0023', especificacion: esp, observaciones: 'SOLO LADO A' }),
    T({ id: 3, sitio: 'MX_CM_BB_MED_0032', especificacion: null, observaciones: 'SIN ESPECIFICACIÓN' }),
  ];
  const g = armarFormatoGeneral({ medio: 'Máquina', periodo: AGOSTO, tomas }).hojas[0];
  const col = g.filas[3].indexOf('OBSERVACIONES');
  assert.equal(g.filas[4][col], esp); // sin observación del sitio: la especificación sola
  assert.equal(g.filas[5][col], `${esp} · SOLO LADO A`);
  assert.equal(g.filas[6][col], 'SIN ESPECIFICACIÓN');
  // El archivo del monitorista dice lo mismo.
  const m = armarArchivoMonitorista({ medio: 'Máquina', periodo: AGOSTO, monitorista: null, tomas }).hojas[0];
  assert.equal(m.filas[4][m.filas[3].indexOf('OBSERVACIONES')], esp);
});

test('estatusToma y tomaParaCampo: quitadas, cerradas y ya tomadas', () => {
  assert.equal(estatusToma({}), null);
  assert.equal(estatusToma({ estado: 'pendiente' }), null);
  assert.equal(estatusToma({ estado: 'cancelada' }), 'QUITADA');
  assert.equal(estatusToma({ sitio_estado: 'cancelado' }), 'QUITADA');
  assert.equal(estatusToma({ estado: 'comprobada', campana_estatus: 'cerrada' }), 'COMPROBADA');
  assert.equal(estatusToma({ estado: 'pendiente', campana_estatus: 'cerrada' }), 'CERRADA');
  assert.equal(estatusToma({ estado: 'por_revisar' }), 'POR REVISAR');
  assert.equal(estatusToma({ estado: 'regresada' }), 'REGRESADA');
  assert.equal(estatusToma({ estado: 'cancelada', estatus: 'NOTA A MANO' }), 'NOTA A MANO');
  assert.equal(tomaParaCampo({}), true);
  assert.equal(tomaParaCampo({ estado: 'regresada' }), true);
  assert.equal(tomaParaCampo({ estado: 'cancelada' }), false);
  assert.equal(tomaParaCampo({ estado: 'por_revisar' }), false);
  assert.equal(tomaParaCampo({ estado: 'comprobada' }), false);
  assert.equal(tomaParaCampo({ campana_estatus: 'cerrada' }), false);
  assert.equal(tomaParaCampo({ sitio_estado: 'cancelado' }), false);
});

test('el monitorista no recibe tomas quitadas ni de campañas cerradas; el formato general sí, con su ESTATUS', () => {
  const tomas = [
    T({ id: 1, sitio: 'B1', monitorista: 'Saúl Prueba' }),
    T({ id: 2, sitio: 'B2', monitorista: 'Saúl Prueba', estado: 'cancelada' }),
    T({ id: 3, sitio: 'B3', monitorista: 'Saúl Prueba', campana_estatus: 'cerrada' }),
    T({ id: 4, sitio: 'B4', monitorista: 'Saúl Prueba', sitio_estado: 'cancelado' }),
    T({ id: 5, sitio: 'B5', monitorista: 'Saúl Prueba', estado: 'por_revisar' }),
    T({ id: 6, sitio: 'B6', monitorista: 'Saúl Prueba', estado: 'regresada' }),
  ];
  const a = armarArchivoMonitorista({ medio: 'Máquina', periodo: AGOSTO, monitorista: 'Saúl Prueba', tomas });
  assert.deepEqual(llaves(a.hojas[0]), [1, 6]);
  const todas = armarArchivoMonitorista({ medio: 'Máquina', periodo: AGOSTO, monitorista: 'Saúl Prueba', tomas, incluirTodas: true });
  assert.equal(llaves(todas.hojas[0]).length, 6);
  const libros = armarArchivosMonitoristas({ medio: 'Máquina', periodo: AGOSTO, tomas });
  assert.equal(libros.length, 1);
  assert.deepEqual(llaves(libros[0].hojas[0]), [1, 6]);
  const g = armarFormatoGeneral({ medio: 'Máquina', periodo: AGOSTO, tomas }).hojas[0];
  const est = g.filas[3].indexOf('ESTATUS');
  assert.deepEqual(
    g.filas.slice(4).map((f) => [f.at(-1), f[est]]),
    [
      [1, null],
      [2, 'QUITADA'],
      [3, 'CERRADA'],
      [4, 'QUITADA'],
      [5, 'POR REVISAR'],
      [6, 'REGRESADA'],
    ]
  );
});

test('Vía Verde: una toma con dos turnos va en el archivo de cada uno', () => {
  const dos = [
    { email: 'saul@empresa.test', nombre: 'Saúl Prueba', turno: 'matutino' },
    { email: 'ivan@empresa.test', nombre: 'Iván Ejemplo', turno: 'vespertino' },
  ];
  const tomas = [
    { id: 10, fecha: '2026-08-01', sitio: 'MX_CM_VV_COL_448', campana: 'C', version: 'V', monitoristas: dos },
    { id: 11, fecha: '2026-08-01', sitio: 'MX_CM_VV_COL_491', campana: 'C', version: 'V', monitoristas: [dos[0]] },
  ];
  const libros = armarArchivosMonitoristas({ medio: 'Columna', periodo: AGOSTO, tomas });
  assert.deepEqual(
    libros.map((l) => [l.nombreArchivo, llaves(l.hojas[0])]),
    [
      ['Formato Comprobaciones Columnas Agosto 2026 IVÁN EJEMPLO VESPERTINO.xlsx', [10]],
      ['Formato Comprobaciones Columnas Agosto 2026 SAÚL PRUEBA MATUTINO.xlsx', [10, 11]],
    ]
  );
  assert.equal(libros[1].hojas[0].nombre, 'SAÚL PRUEBA MATUTINO AGOSTO');
  // En el formato general, MONITORISTA dice los dos, como hoy («SAÚL/IVAN/»).
  const g = armarFormatoGeneral({ medio: 'Columna', periodo: AGOSTO, tomas }).hojas[0];
  assert.equal(g.filas[4][g.filas[3].indexOf('MONITORISTA')], 'Saúl Prueba (MATUTINO) / Iván Ejemplo (VESPERTINO)');
  // Uno solo por correo y turno.
  const solo = armarArchivoMonitorista({
    medio: 'Columna',
    periodo: AGOSTO,
    monitorista: { email: 'IVAN@empresa.test', turno: 'Vespertino' },
    tomas,
  });
  assert.deepEqual(llaves(solo.hojas[0]), [10]);
});

test('dos personas con el mismo nombre visible: dos archivos distintos', () => {
  const tomas = [
    T({ id: 1, monitoristas: [{ email: 'jlopez@empresa.test', nombre: 'Juan López' }] }),
    T({ id: 2, sitio: 'B2', monitoristas: [{ email: 'juan.lopez2@empresa.test', nombre: 'JUAN LOPEZ' }] }),
  ];
  const g = repartirPorMonitorista(tomas);
  assert.equal(g.length, 2);
  assert.equal(new Set(g.map((x) => x.etiqueta)).size, 2);
  const libros = armarArchivosMonitoristas({ medio: 'Máquina', periodo: AGOSTO, tomas });
  assert.equal(new Set(libros.map((l) => l.nombreArchivo)).size, 2);
  assert.deepEqual(libros.map((l) => llaves(l.hojas[0])).sort(), [[1], [2]]);
  // Sin correo, «Saúl» y «SAUL» siguen siendo la misma persona.
  assert.equal(repartirPorMonitorista([T({ monitorista: 'Saúl' }), T({ monitorista: 'SAUL' })]).length, 1);
});

test('Ecovallas Digital, como hoy: un archivo compartido con una columna por monitorista', () => {
  const tomas = [
    ...TOMAS_EV,
    { ...TOMAS_EV[0], id: 505, sitio: 'MX_CM_EV_MGP_09_0905', estado: 'cancelada' },
  ];
  const libros = armarArchivosMonitoristas({ medio: 'Pantalla', periodo: CAT18, tomas });
  assert.equal(libros.length, 1);
  const [l] = libros;
  assert.equal(l.nombreArchivo, 'Formato Comprobaciones Ecovallas Digitales Cat 18 2026 MONITORISTAS.xlsx');
  const [h] = l.hojas;
  assert.equal(h.nombre, 'ECOVALLAS DIGITALES CAT 18');
  assert.deepEqual(h.filas[3].slice(8), [null, 'ALINE', 'SAUL', 'LLAVE']);
  assert.equal(h.filas[1][0], 'TOMA COMPROBACIONES ECOVALLAS DIGITALES CAT 18 2026');
  assert.equal(h.filas[1][9], 'REGISTRAR LA FECHA DEL DIA QUE SE TOMO');
  assert.deepEqual(h.merges, [
    { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } }, // A2:D2
    { s: { r: 1, c: 9 }, e: { r: 1, c: 10 } }, // J2:K2 (hoy J2:L2 con tres personas)
  ]);
  // Todas las tomas para campo, también la sin monitorista; la quitada no.
  assert.deepEqual(llaves(h), [502, 501, 503, 504]);
  assert.equal(h.autofiltro, 'A4:L8');
  // Si Victor lo pide, uno por persona también en Ecovallas.
  const porPersona = armarArchivosMonitoristas({ medio: 'Pantalla', periodo: CAT18, tomas, formato: 'por_persona' });
  assert.equal(porPersona.length, 3);
  // Sin monitoristas: una sola columna para anotar.
  const nadie = armarArchivoMonitoristasCompartido({ medio: 'Pantalla', periodo: CAT18, tomas: [TOMAS_EV[3]] }).hojas[0];
  assert.deepEqual(nadie.filas[3].slice(8), [null, 'MONITORISTA', 'LLAVE']);
});

test('DISEÑADORES por persona: dos «Marco» no se suman en una fila', () => {
  const campanas = [
    { id: 1, campana: 'A', venta: 10, comprobados: 10, analista: 'Marco Pérez', analista_email: 'mperez@empresa.test' },
    { id: 2, campana: 'B', venta: 10, comprobados: 0, analista: 'Marco Gómez', analista_email: 'mgomez@empresa.test' },
    { id: 3, campana: 'C', venta: 4, comprobados: 2, analista: 'Marco Pérez', analista_email: 'MPEREZ@empresa.test' },
  ];
  const [h, d] = armarAsignacion({ medio: 'Máquina', periodo: AGOSTO, campanas }).hojas;
  assert.deepEqual(
    h.filas.slice(5, 8).map((f) => f[3]),
    ['MARCO P.', 'MARCO G.', 'MARCO P.']
  );
  const pie = h.filas.slice(h.filas.findIndex((f) => f[0] === 'DISEÑADORES') + 1);
  assert.deepEqual(
    pie.map((f) => [f[0], f[1], f[8].v]),
    [
      ['MARCO G.', 10, 0],
      ['MARCO P.', 14, 12 / 14],
    ]
  );
  assert.deepEqual(
    d.filas.slice(5, 8).map((f) => f[3]),
    ['MARCO P.', 'MARCO G.', 'MARCO P.']
  );
  // Sin apellido: el usuario del correo.
  const [h2] = armarAsignacion({
    medio: 'Máquina',
    periodo: AGOSTO,
    campanas: [
      { id: 1, campana: 'A', venta: 1, comprobados: 0, analista: 'Luis', analista_email: 'luis.a@empresa.test' },
      { id: 2, campana: 'B', venta: 1, comprobados: 0, analista: 'Luis', analista_email: 'luis.b@empresa.test' },
    ],
  }).hojas;
  assert.deepEqual(
    h2.filas.slice(5, 7).map((f) => f[3]),
    ['LUIS (LUIS.A)', 'LUIS (LUIS.B)']
  );
});

test('hoja ESPECIFICACIÓN DE TOMAS: campaña, arte y especificación', () => {
  const campanas = [
    { id: 1, campana: 'CAMPAÑA PRUEBA ALFA', version: 'V5', arte: 'REPITE', venta: 1, comprobados: 0, especificacion: 'DEL 01 AL 31 DE AGOSTO. AVANCES CADA 3ER DIA' },
    { id: 2, campana: 'BETA', version: '', arte: 'NUEVO', venta: 1, comprobados: 0 },
  ];
  const h = armarAsignacion({ medio: 'Máquina', periodo: AGOSTO, campanas, notaEspecificacion: 'REVISAR LAS FECHAS DE ENTREGA' }).hojas[2];
  assert.equal(h.nombre, 'ESPECIFICACIÓN DE TOMAS');
  assert.deepEqual(h.filas, [
    ['REVISAR LAS FECHAS DE ENTREGA'],
    ['CAMPAÑA', 'ARTE', 'ESPECIFICACIÓN DE TOMAS Y COMPROBACIÓN'],
    ['CAMPAÑA PRUEBA ALFA / V5', 'REPITE', 'DEL 01 AL 31 DE AGOSTO. AVANCES CADA 3ER DIA'],
    ['BETA', 'NUEVO', null],
  ]);
  assert.deepEqual(h.merges, [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]);
  assert.equal(h.autofiltro, 'A2:C4');
});

test('orden natural del sitio: COL_448 antes que COL_1000', () => {
  const tomas = ['MX_CM_VV_COL_1000', 'MX_CM_VV_COL_448', 'MX_CM_VV_COL_606'].map((sitio, i) => ({
    id: i,
    fecha: '2026-08-01',
    sitio,
    campana: 'C',
    version: 'V',
  }));
  assert.deepEqual(
    ordenarTomas(tomas).map((t) => t.sitio),
    ['MX_CM_VV_COL_448', 'MX_CM_VV_COL_606', 'MX_CM_VV_COL_1000']
  );
  // La ruta también: 2 antes que 10.
  assert.deepEqual(
    ordenarTomas([T({ id: 'a', ruta: 10 }), T({ id: 'b', ruta: 2 })]).map((t) => t.id),
    ['b', 'a']
  );
});

test('la fecha de la toma es el día: se ordena y se imprime igual aunque llegue con hora UTC', () => {
  const tomas = [
    { id: 1, fecha: '2026-08-01T00:00:00.000Z', sitio: 'A', campana: 'C' },
    { id: 2, fecha: '2026-07-31', sitio: 'A', campana: 'C' },
  ];
  const h = armarFormatoGeneral({ medio: 'Columna', periodo: AGOSTO, tomas }).hojas[0];
  assert.deepEqual(llaves(h), [2, 1]);
  assert.deepEqual(h.filas[5][0], fecha('2026-08-01')); // antes salía 31/7/2026
  assert.deepEqual(celdaDia('2026-08-01T00:00:00.000Z'), fecha('2026-08-01'));
  assert.equal(celdaDia('x'), null);
  // cerrada_en (marca de tiempo) sí pasa al día de CDMX.
  assert.deepEqual(celdaFecha('2026-08-01T01:30:00Z'), fecha('2026-07-31'));
});

test('nombreHoja: sin apóstrofos en los extremos y nunca «History»', () => {
  assert.equal(nombreHoja("'PEPE CAT 18"), 'PEPE CAT 18');
  assert.equal(nombreHoja("O'BRIEN'"), "O'BRIEN");
  assert.equal(nombreHoja('History'), 'HISTORY 1');
  assert.equal(nombreHoja(' history '), 'HISTORY 1');
  assert.equal(nombreHoja("'''"), 'HOJA');
  // Recortar a 31 puede dejar un apóstrofo al final: también se quita.
  assert.equal(nombreHoja('X'.repeat(30) + "'Y"), 'X'.repeat(30));
  // Y Excel lo acepta al escribir.
  const wb = aLibroXlsx({ nombreArchivo: 'x.xlsx', hojas: [{ nombre: nombreHoja("'PEPE'"), filas: [['a']], merges: [], anchos: [5] }] }, XLSX);
  assert.deepEqual(wb.SheetNames, ['PEPE']);
});

test('11,300 renglones (el GENERAL de Vía Verde de hoy) se arman sin congelar', () => {
  const n = 11300;
  const tomas = Array.from({ length: n }, (_, i) => ({
    id: i,
    fecha: `2026-08-${String(31 - (i % 31)).padStart(2, '0')}`,
    sitio: `MX_CM_VV_COL_${(i * 7919) % 1200}`,
    campana: `CAMPAÑA ${i % 40}`,
    version: `V${i % 3}`,
    monitoristas: [{ email: `m${i % 5}@empresa.test`, nombre: `Monitorista ${i % 5}` }],
  }));
  const t0 = Date.now();
  const g = armarFormatoGeneral({ medio: 'Columna', periodo: AGOSTO, tomas });
  const libros = armarArchivosMonitoristas({ medio: 'Columna', periodo: AGOSTO, tomas });
  const ms = Date.now() - t0;
  assert.equal(g.hojas[0].filas.length, 4 + n);
  assert.equal(libros.length, 5);
  assert.equal(libros.reduce((s, l) => s + l.hojas[0].filas.length - 4, 0), n);
  // Holgado a propósito (en la PC de Erik tarda ~0.2 s): solo atrapa una regresión grande.
  assert.ok(ms < 4000, `tardó ${ms} ms`);
});

// ------------------------------------------------------------
// De las vistas de la base al Excel (revisión de la SQL, 23-oct-2026)
// ------------------------------------------------------------

const { campanasExcelDeVista, tomasExcelDeVista } = E;

// Filas con la FORMA de vw_comp_campanas / vw_comp_tomas; nombres inventados.
const VISTA_CAMPANAS = [
  {
    id: '11',
    campana: 'REFRESCO PRUEBA',
    version: 'V1',
    vendedor: 'Vendedora Uno',
    administrador: 'Admin Dos',
    arte: 'NUEVO',
    analista_email: 'Luisa.Ejemplo@empresa.test',
    meta: '20',
    comprobados: 5,
    estatus: 'abierta',
    especificacion: 'DEL 01 AL 31 DE AGOSTO. TOMAS MEDIAS',
    retirada: false,
    // Columnas de la vista que el Excel no usa.
    sitios_activos: 22,
    meta_fuente: 'app',
  },
  {
    id: 12,
    campana: 'BANCO PRUEBA',
    version: '',
    administrador: null,
    analista_email: null,
    meta: 8,
    comprobados: 8,
    estatus: 'cerrada',
    cerrada_en: '2026-08-20T19:30:00-06:00',
  },
  { id: 13, campana: 'VIEJA PRUEBA', version: 'V2', meta: 3, comprobados: 3, estatus: 'abierta', retirada: true },
];

test('campanasExcelDeVista: venta ← meta, ejecutivo ← administrador; las retiradas también, con RETIRADA', () => {
  const nombres = new Map([['luisa.ejemplo@empresa.test', 'Luisa Ejemplo']]);
  const cs = campanasExcelDeVista(VISTA_CAMPANAS, { nombres });
  assert.deepEqual(
    cs.map((c) => c.id),
    ['11', 12, 13]
  );
  assert.deepEqual(cs[0], {
    id: '11',
    campana: 'REFRESCO PRUEBA',
    version: 'V1',
    vendedor: 'Vendedora Uno',
    ejecutivo: 'Admin Dos',
    arte: 'NUEVO',
    analista: 'Luisa Ejemplo',
    analista_email: 'luisa.ejemplo@empresa.test',
    venta: '20',
    comprobados: 5,
    estatus: 'abierta',
    cerrada_en: null,
    especificacion: 'DEL 01 AL 31 DE AGOSTO. TOMAS MEDIAS',
    retirada: false,
  });
  assert.equal(cs[1].analista, null);
  assert.deepEqual(cs.map((c) => c.retirada), [false, false, true]);
  // Sin nombres, DISEÑADOR sale del correo; con objeto en vez de Map también.
  assert.equal(campanasExcelDeVista(VISTA_CAMPANAS)[0].analista, 'Luisa.Ejemplo@empresa.test');
  assert.equal(
    campanasExcelDeVista(VISTA_CAMPANAS, { nombres: { 'luisa.ejemplo@empresa.test': 'Luisa E' } })[0].analista,
    'Luisa E'
  );
  // Y arma la Asignación: VENTA = meta (20), EJECUTIVO = administrador, DISEÑADOR = LUISA.
  const h = armarAsignacion({ medio: 'Máquina', periodo: AGOSTO, campanas: cs }).hojas[0];
  assert.deepEqual(h.filas[5].slice(0, 7), ['Vendedora Uno', 'Admin Dos', 'NUEVO', 'LUISA', 'REFRESCO PRUEBA / V1', 20, 20]);
  assert.deepEqual(h.filas[6].slice(4, 6), ['BANCO PRUEBA', 8]);
  assert.equal(h.filas[6][12], 'CERRADA');
  assert.deepEqual(h.filas[6][13], fecha('2026-08-20'));
  // La retirada va con ESTATUS RETIRADA, no COMPLETA (3 de 3), y sin fecha de cierre.
  assert.deepEqual(h.filas[7].slice(4, 6), ['VIEJA PRUEBA / V2', 3]);
  assert.equal(h.filas[7][12], 'RETIRADA');
  assert.equal(h.filas[7][13], null);
});

const VISTA_TOMAS = [
  {
    id: 900,
    medio: 'Columna',
    campana: 'REFRESCO PRUEBA',
    version: 'V1',
    especificacion: 'TOMAS DE DÍA',
    campana_estatus: 'abierta',
    sitio_clave: 'MX_CM_VV_COL_448',
    sitio_estado: 'pendiente',
    fecha: '2026-08-01',
    horario_texto: '06:00 - 09:59',
    observaciones: 'LADO NORTE',
    comprobacion: 'FOTO',
    turno: 'matutino',
    ruta_numero: 4,
    monitorista_email: 'Saul.Prueba@empresa.test',
    estado: 'pendiente',
    // Columnas de la vista que el Excel no usa.
    sitio_fuera_de_carga: false,
    baja_auto: false,
  },
  {
    id: 901,
    medio: 'Columna',
    campana: 'REFRESCO PRUEBA',
    version: 'V1',
    sitio_clave: 'MX_CM_VV_COL_491',
    fecha: '2026-08-02',
    horario_texto: null,
    estado: 'cancelada',
    baja_auto: true,
  },
  {
    id: 902,
    medio: 'Columna',
    campana: 'REFRESCO PRUEBA',
    version: 'V1',
    sitio_clave: 'MX_CM_VV_COL_606',
    fecha: '2026-08-02T00:00:00',
    horario_texto: '18:00 - 21:59',
    estado: 'comprobada',
    ruta_numero: null,
    monitorista_email: null,
  },
];

test('tomasExcelDeVista: solo estado <> cancelada; ruta ← ruta_numero, horario ← horario_texto', () => {
  const ts = tomasExcelDeVista(VISTA_TOMAS, { nombres: { 'saul.prueba@empresa.test': 'Saúl Prueba' } });
  assert.deepEqual(
    ts.map((t) => t.id),
    [900, 902]
  );
  assert.deepEqual(ts[0], {
    id: 900,
    fecha: '2026-08-01',
    sitio: 'MX_CM_VV_COL_448',
    ruta: 4,
    campana: 'REFRESCO PRUEBA',
    version: 'V1',
    comprobacion: 'FOTO',
    horario: '06:00 - 09:59',
    especificacion: 'TOMAS DE DÍA',
    observaciones: 'LADO NORTE',
    monitorista: 'Saúl Prueba',
    monitorista_email: 'saul.prueba@empresa.test',
    turno: 'matutino',
    estado: 'pendiente',
    campana_estatus: 'abierta',
    sitio_estado: 'pendiente',
    sitio_comprobado_dia: null,
  });
  assert.equal(ts[1].fecha, '2026-08-02');
  assert.equal(ts[1].monitorista, null);
  // El formato general de Vía Verde lleva la franja del día y el ESTATUS.
  const h = armarFormatoGeneral({ medio: 'Columna', periodo: AGOSTO, tomas: ts }).hojas[0];
  // Alguna trae ruta: en Vía Verde va al final, antes de LLAVE (revisión 2).
  assert.deepEqual(h.filas[3].slice(-2), ['RUTA', 'LLAVE']);
  assert.equal(h.filas[4].at(-2), 4);
  assert.deepEqual(h.filas[4].slice(1, 7), [
    'MX_CM_VV_COL_448',
    'REFRESCO PRUEBA',
    'V1',
    'FOTO',
    '06:00 - 09:59',
    'TOMAS DE DÍA · LADO NORTE',
  ]);
  assert.equal(h.filas[4][8], 'Saúl Prueba (MATUTINO)');
  assert.equal(h.filas[5][9], 'COMPROBADA');
  assert.equal(h.filas.length, 6);
});

test('Ecovallas Digital y Biobox: HORARIO «24 HORAS» en todos los Excel, sin franjas ni sábado y domingo', () => {
  const vista = [
    // Lo que deja la base con la bitácora: «24 HRS» entre semana y nada el domingo.
    {
      id: 1,
      medio: 'Máquina',
      campana: 'C',
      sitio_clave: 'MX_CM_BB_MED_0002',
      fecha: '2026-08-03',
      horario_texto: '24 HRS',
      estado: 'pendiente',
      ruta_numero: 2,
      monitorista_email: 'a@empresa.test',
    },
    {
      id: 2,
      medio: 'Máquina',
      campana: 'C',
      sitio_clave: 'MX_CM_BB_MED_0002',
      fecha: '2026-08-02',
      horario_texto: null,
      estado: 'pendiente',
      ruta_numero: 2,
      monitorista_email: 'a@empresa.test',
    },
  ];
  const ts = tomasExcelDeVista(vista);
  assert.deepEqual(
    ts.map((t) => t.horario),
    ['24 HORAS', '24 HORAS']
  );
  // Aunque la pantalla pase el horario crudo, el Excel de la unidad lo fija.
  const crudas = vista.map((t) => ({
    id: t.id,
    fecha: t.fecha,
    sitio: t.sitio_clave,
    campana: t.campana,
    horario: t.horario_texto,
    ruta: 2,
    monitorista_email: t.monitorista_email,
  }));
  const columnaHorario = (h) => {
    const i = h.filas[3].indexOf('HORARIO');
    return h.filas.slice(4).map((f) => f[i]);
  };
  for (const medio of ['Máquina', 'Pantalla']) {
    assert.equal(configMedio(medio).horario24h, true, medio);
    const g = armarFormatoGeneral({ medio, periodo: AGOSTO, tomas: crudas }).hojas[0];
    assert.deepEqual(columnaHorario(g), ['24 HORAS', '24 HORAS'], medio);
    for (const libro of armarArchivosMonitoristas({ medio, periodo: AGOSTO, tomas: crudas })) {
      const h = libro.hojas[0];
      assert.deepEqual(columnaHorario(h), ['24 HORAS', '24 HORAS'], medio);
      // Una sola columna HORARIO: nada de LUNES A VIERNES / SÁBADO Y DOMINGO.
      assert.equal(h.filas[3].filter((e) => typeof e === 'string' && /HORARIO/.test(e)).length, 1);
    }
  }
  // Vía Verde conserva el del día (y vacío si no hay). Orden: el 2 de agosto primero.
  assert.equal(configMedio('Columna').horario24h, false);
  assert.equal(configMedio('Pórtico').horario24h, false);
  const vv = armarFormatoGeneral({ medio: 'Columna', periodo: AGOSTO, tomas: crudas }).hojas[0];
  assert.deepEqual(columnaHorario(vv), [null, '24 HRS']);
});

// ------------------------------------------------------------
// Revisión 3 (23-oct-2026): sitio ya comprobado, retiradas y fechas Date
// ------------------------------------------------------------

const { tomaCubiertaPorSitio, ESTATUS_SITIO_COMPROBADO, diaDeVista } = E;

test('tomaCubiertaPorSitio: la toma por hacer de un sitio comprobado, hasta el día en que se comprobó', () => {
  const base = { estado: 'pendiente', sitio_estado: 'comprobado', sitio_comprobado_dia: '2026-08-10' };
  assert.equal(tomaCubiertaPorSitio({ ...base, fecha: '2026-08-03' }), true);
  assert.equal(tomaCubiertaPorSitio({ ...base, fecha: '2026-08-10' }), true);
  // Después del día: la pidió incluir_comprobados, sigue yendo a campo.
  assert.equal(tomaCubiertaPorSitio({ ...base, fecha: '2026-08-11' }), false);
  // Regresada cuenta como por hacer; por revisar o comprobada ya no.
  assert.equal(tomaCubiertaPorSitio({ ...base, estado: 'regresada', fecha: '2026-08-03' }), true);
  assert.equal(tomaCubiertaPorSitio({ ...base, estado: 'por_revisar', fecha: '2026-08-03' }), false);
  assert.equal(tomaCubiertaPorSitio({ ...base, estado: 'comprobada', fecha: '2026-08-03' }), false);
  // Sin el día (la vista aún no lo trae) o sin fecha: cubierta.
  assert.equal(tomaCubiertaPorSitio({ estado: 'pendiente', sitio_estado: 'comprobado', fecha: '2026-08-30' }), true);
  assert.equal(tomaCubiertaPorSitio({ ...base, fecha: null }), true);
  // Sitio pendiente o sin estado: no aplica.
  assert.equal(tomaCubiertaPorSitio({ ...base, sitio_estado: 'pendiente', fecha: '2026-08-03' }), false);
  assert.equal(tomaCubiertaPorSitio({ ...base, sitio_estado: null, fecha: '2026-08-03' }), false);
});

test('estatusToma y tomaParaCampo: SITIO COMPROBADO, fuera del archivo del monitorista', () => {
  // El caso de la revisión: toma pendiente de un sitio que ya quedó comprobado.
  const t = { estado: 'pendiente', sitio_estado: 'comprobado' };
  assert.equal(ESTATUS_SITIO_COMPROBADO, 'SITIO COMPROBADO');
  assert.equal(estatusToma(t), 'SITIO COMPROBADO');
  assert.equal(tomaParaCampo(t), false);
  // Las de después del día de la marca siguen en campo y sin ESTATUS.
  const despues = { ...t, sitio_comprobado_dia: '2026-08-05', fecha: '2026-08-12' };
  assert.equal(estatusToma(despues), null);
  assert.equal(tomaParaCampo(despues), true);
  // QUITADA, COMPROBADA, CERRADA y el texto libre siguen ganando.
  assert.equal(estatusToma({ ...t, estado: 'cancelada' }), 'QUITADA');
  assert.equal(estatusToma({ ...t, estado: 'comprobada' }), 'COMPROBADA');
  assert.equal(estatusToma({ ...t, campana_estatus: 'cerrada' }), 'CERRADA');
  assert.equal(estatusToma({ ...t, estatus: 'NOTA A MANO' }), 'NOTA A MANO');

  const tomas = [
    T({ id: 1, fecha: '2026-08-03', sitio: 'MX_CM_BB_MED_0001', monitorista: 'Saúl Prueba', sitio_estado: 'comprobado', sitio_comprobado_dia: '2026-08-04' }),
    T({ id: 2, fecha: '2026-08-06', sitio: 'MX_CM_BB_MED_0001', monitorista: 'Saúl Prueba', sitio_estado: 'comprobado', sitio_comprobado_dia: '2026-08-04' }),
    T({ id: 3, fecha: '2026-08-03', sitio: 'MX_CM_BB_MED_0002', monitorista: 'Saúl Prueba', sitio_estado: 'pendiente' }),
    T({ id: 4, fecha: '2026-08-03', sitio: 'MX_CM_BB_MED_0003', monitorista: 'Saúl Prueba', sitio_estado: 'comprobado' }),
  ];
  // Formato general: todas, con su ESTATUS.
  const g = armarFormatoGeneral({ medio: 'Máquina', periodo: AGOSTO, tomas }).hojas[0];
  const ce = g.filas[3].indexOf('ESTATUS');
  const porLlave = new Map(g.filas.slice(4).map((f) => [String(f.at(-1)), f[ce]]));
  assert.equal(porLlave.size, 4);
  assert.equal(porLlave.get('1'), 'SITIO COMPROBADO');
  assert.equal(porLlave.get('2'), null);
  assert.equal(porLlave.get('3'), null);
  assert.equal(porLlave.get('4'), 'SITIO COMPROBADO');
  // Archivo del monitorista: solo las que de veras hay que ir a tomar.
  const libros = armarArchivosMonitoristas({ medio: 'Máquina', periodo: AGOSTO, tomas });
  assert.equal(libros.length, 1);
  assert.deepEqual(llaves(libros[0].hojas[0]).map(String).sort(), ['2', '3']);
  // incluirTodas sigue metiendo todo.
  const todas = armarArchivosMonitoristas({ medio: 'Máquina', periodo: AGOSTO, tomas, incluirTodas: true });
  assert.equal(llaves(todas[0].hojas[0]).length, 4);
});

test('tomasExcelDeVista: fechas Date (PGlite) y el día en que se comprobó el sitio', () => {
  assert.equal(diaDeVista(new Date('2026-10-05T00:00:00Z')), '2026-10-05');
  assert.equal(diaDeVista('2026-10-05'), '2026-10-05');
  assert.equal(diaDeVista('2026-10-05T00:00:00'), '2026-10-05');
  assert.equal(diaDeVista(new Date('no')), null);
  assert.equal(diaDeVista('2026-02-30'), null);
  assert.equal(diaDeVista(null), null);
  const ts = tomasExcelDeVista([
    {
      id: 1,
      medio: 'Máquina',
      campana: 'C',
      sitio_clave: 'MX_CM_BB_MED_0002',
      fecha: new Date('2026-10-05T00:00:00Z'),
      sitio_estado: 'comprobado',
      sitio_comprobado_dia: new Date('2026-10-04T00:00:00Z'),
      estado: 'pendiente',
    },
    { id: 2, medio: 'Máquina', campana: 'C', sitio_clave: 'MX_CM_BB_MED_0003', fecha: '2026-10-03', estado: 'pendiente' },
  ]);
  assert.deepEqual(
    ts.map((t) => [t.fecha, t.sitio_comprobado_dia]),
    [
      ['2026-10-05', '2026-10-04'],
      ['2026-10-03', null],
    ]
  );
  // El 5 es después del día de la marca: sigue yendo a campo.
  assert.equal(tomaParaCampo(ts[0]), true);
});

test('Asignación con una campaña retirada que tiene marcas: la COMPROBACIÓN DIARIA no pierde el crédito', () => {
  // REV-5: Biobox, un sitio comprobado en la retirada; la vista dice meta 1, comprobados 1, retirada.
  const vista = [
    { id: 21, campana: 'ACTIVA PRUEBA', version: 'V1', analista_email: 'luisa.ejemplo@empresa.test', meta: 4, comprobados: 1, estatus: 'abierta', retirada: false },
    { id: 22, campana: 'RETIRADA PRUEBA', version: 'V1', analista_email: 'luisa.ejemplo@empresa.test', meta: 1, comprobados: 1, estatus: 'abierta', retirada: true },
  ];
  const marcas = [
    { campana_id: 21, comprobado_por: 'luisa.ejemplo@empresa.test', dia: '2026-08-04', sitios: 1 },
    { campana_id: 22, comprobado_por: 'luisa.ejemplo@empresa.test', dia: '2026-08-04', sitios: 1 },
  ];
  const cs = campanasExcelDeVista(vista, { nombres: { 'luisa.ejemplo@empresa.test': 'Luisa Ejemplo' } });
  const totalDiaria = (h) => {
    const fila = h.filas.find((f) => f[4] === 'TOTAL');
    return fila[h.filas[3].indexOf('TOTAL')];
  };
  for (const omitirRetiradas of [false, true]) {
    const [asig, diaria, esp] = armarAsignacion({ medio: 'Máquina', periodo: AGOSTO, campanas: cs, marcas, omitirRetiradas }).hojas;
    // La diaria SIEMPRE lleva la retirada: TOTAL 2, igual que vw_comp_diaria.
    assert.equal(totalDiaria(diaria), 2, `diaria, omitir=${omitirRetiradas}`);
    assert.ok(diaria.filas.some((f) => f[4] === 'RETIRADA PRUEBA / V1'));
    const filasAsig = asig.filas.slice(5).filter((f) => typeof f[4] === 'string' && f[4].includes('PRUEBA'));
    const totalAsig = asig.filas.find((f) => f[4] === 'TOTAL');
    const pie = asig.filas[asig.filas.findIndex((f) => f[0] === 'DISEÑADORES') + 1];
    if (omitirRetiradas) {
      assert.deepEqual(filasAsig.map((f) => f[4]), ['ACTIVA PRUEBA / V1']);
      assert.deepEqual([totalAsig[5], totalAsig[8]], [4, 1]);
      assert.deepEqual(pie.slice(0, 2), ['LUISA', 4]);
      assert.equal(esp.filas.length, 3);
    } else {
      assert.deepEqual(
        filasAsig.map((f) => [f[4], f[12]]),
        [
          ['ACTIVA PRUEBA / V1', null],
          ['RETIRADA PRUEBA / V1', 'RETIRADA'],
        ]
      );
      assert.deepEqual([totalAsig[5], totalAsig[8]], [5, 2]);
      assert.deepEqual(pie.slice(0, 2), ['LUISA', 5]);
      assert.equal(esp.filas.length, 4);
    }
  }
  // estatusExcel: CERRADA gana; RETIRADA antes que COMPLETA.
  assert.equal(E.estatusExcel({ estatus: 'cerrada', retirada: true, venta: 1, comprobados: 1 }), 'CERRADA');
  assert.equal(E.estatusExcel({ estatus: 'abierta', retirada: true, venta: 1, comprobados: 1 }), 'RETIRADA');
  assert.equal(E.estatusExcel({ estatus: 'abierta', retirada: false, venta: 1, comprobados: 1 }), 'COMPLETA');
});
