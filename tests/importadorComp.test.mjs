// Pruebas de las utilidades de lectura de Excel de Comprobaciones
// (src/lib/importadorComp.ts, fase 2, 23-oct-2026). Desde el rediseño de
// Erik (23-oct) el lector de los Excel de comprobaciones de hoy salió: aquí
// quedan las piezas que usa el lector de la bitácora (bitacoraComp.ts).
// La paridad de llaveComp con comp_llave() vive en comprobaciones.test.mjs.
// Las filas tienen la FORMA de los Excel reales (celdas sucias) con nombres
// INVENTADOS: el repo es público y los Excel nunca entran aquí.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/importadorComp.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const L = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

// sheet_to_json deja las fechas en la medianoche LOCAL: así se arman aquí.
const D = (a, m, d) => new Date(a, m - 1, d);

test('textoCelda y normTexto: errores de Excel, espacios y acentos', () => {
  assert.equal(L.textoCelda('  RESIDENTE   MALO '), 'RESIDENTE MALO');
  for (const nada of [null, undefined, '', '   ', '#N/A', '#REF!', '#NAME?']) assert.equal(L.textoCelda(nada), null, String(nada));
  assert.equal(L.textoCelda(D(2026, 10, 15)), '2026-10-15');
  assert.equal(L.normTexto(' Ubicación  Señal '), 'UBICACION SENAL');
});

test('buscarEncabezado: la fila y las columnas por nombre, con columnas de más', () => {
  const filas = [
    ['CLIENTE', 'TIENDAS PRUEBA'],
    [],
    ['PLAZA', 'ID COLUMNA', 'VERSION', 'INICIO', 'NOTAS', 'INICIO'],
    ['CDMX', '101', 'V1', '2026-10-01', null, null],
  ];
  const enc = L.buscarEncabezado(filas, { sitio: /^ID COLUMNA$/, version: /^VERSION$/, inicio: /^INICIO$/ }, ['sitio', 'version']);
  // La PRIMERA columna que cumple gana (INICIO repetido más a la derecha).
  assert.deepEqual(enc, { fila: 2, col: { sitio: 1, version: 2, inicio: 3 } });
  assert.equal(L.buscarEncabezado(filas, { x: /^NO EXISTE$/ }, ['x']), null);
});

// ------------------------------------------------------------
// Celdas sueltas
// ------------------------------------------------------------

test('limpiarClave: espacios, ceros, texto pegado, pórticos y EDO MEX', () => {
  assert.deepEqual(L.limpiarClave('MX_CM_EV_MGP_16_3606     '), { clave: 'MX_CM_EV_MGP_16_3606', cambios: ['espacios'], edoMex: false });
  assert.deepEqual(L.limpiarClave('MX_CM_BB_MED_ 0114'), { clave: 'MX_CM_BB_MED_0114', cambios: ['espacios'], edoMex: false });
  assert.deepEqual(L.limpiarClave('MX_CM_BB_MED_00106'), { clave: 'MX_CM_BB_MED_0106', cambios: ['ceros'], edoMex: false });
  assert.deepEqual(L.limpiarClave('MX_CM_BB_IID_0001 (PLANTEL NORTE)'), { clave: 'MX_CM_BB_IID_0001', cambios: ['texto_pegado'], edoMex: false });
  assert.deepEqual(L.limpiarClave('MX_CM_BB_IID_0001 PLANTEL NORTE'), { clave: 'MX_CM_BB_IID_0001', cambios: ['texto_pegado'], edoMex: false });
  assert.deepEqual(L.limpiarClave('POR_0008'), { clave: 'MX_CM_VV_POR_0008', cambios: ['alias_portico'], edoMex: false });
  assert.deepEqual(L.limpiarClave('POR_00015'), { clave: 'MX_CM_VV_POR_0015', cambios: ['alias_portico', 'ceros'], edoMex: false });
  assert.deepEqual(L.limpiarClave('MX_CM_VV_COL_0448'), { clave: 'MX_CM_VV_COL_448', cambios: ['ceros'], edoMex: false });
  // EDO MEX: A04 no es número y no se toca; se marca para omitir.
  assert.deepEqual(L.limpiarClave('MX_EM_VV_COL_A04'), { clave: 'MX_EM_VV_COL_A04', cambios: [], edoMex: true });
  assert.equal(L.limpiarClave('MX_EM_EV_MGP_08_0002').edoMex, true);
  assert.equal(L.limpiarClave('mx_cm_vv_col_551').clave, 'MX_CM_VV_COL_551');
  for (const nada of [null, '', '   ', '#N/A', '(NADA)', '---']) assert.equal(L.limpiarClave(nada).clave, null, JSON.stringify(nada));
});

test('leerFechaCelda: Date, serial, «01/08(26» y celdas de error', () => {
  assert.equal(L.leerFechaCelda(D(2026, 8, 1)), '2026-08-01');
  assert.equal(L.leerFechaCelda(46235), '2026-08-01');
  assert.equal(L.leerFechaCelda('01/08(26'), '2026-08-01');
  assert.equal(L.leerFechaCelda('14/09/2026'), '2026-09-14');
  assert.equal(L.leerFechaCelda('2026-09-03'), '2026-09-03');
  assert.equal(L.leerFechaCelda('31/02/2026'), null);
  for (const nada of [null, undefined, '', '#N/A', 'PENDIENTE', 'TIENE FECHA DE JULIO']) assert.equal(L.leerFechaCelda(nada), null, String(nada));
});

test('versionSinMedida: las 3 medidas de Ecovallas son la misma versión', () => {
  const v = ['OBRA DE PRUEBA (3ULTIMAS) 1440x405.jpg', 'OBRA DE PRUEBA (3ULTIMAS) 1152X324.jpg', 'OBRA DE PRUEBA (3ULTIMAS) 989X240.jpg'].map(L.versionSinMedida);
  assert.deepEqual(v, ['OBRA DE PRUEBA (3ULTIMAS)', 'OBRA DE PRUEBA (3ULTIMAS)', 'OBRA DE PRUEBA (3ULTIMAS)']);
  assert.equal(L.versionSinMedida('OBRAS_MES_1440X405 LA FUNCION.jpg'), 'OBRAS_MES LA FUNCION');
  assert.equal(L.versionSinMedida('V1-R1 Revista Prueba 1056x324'), 'V1-R1 Revista Prueba');
  assert.equal(L.versionSinMedida('PENDIENTE'), 'PENDIENTE');
});

test("separarEntrega: el sufijo (INICIAL) o (FINAL) sale del nombre", () => {
  assert.deepEqual(L.separarEntrega('JARABE PRUEBA ADICIONAL (INICIAL)'), { campana: 'JARABE PRUEBA ADICIONAL', entrega: 'inicial' });
  assert.deepEqual(L.separarEntrega('SERIE PRUEBA (FINAL)'), { campana: 'SERIE PRUEBA', entrega: 'final' });
  assert.deepEqual(L.separarEntrega(' MARCA SIN SUFIJO '), { campana: 'MARCA SIN SUFIJO', entrega: null });
});

test('leerHorario: 24 h, franjas con a/AM/PM/hrs, FULL de minutos, por fecha y programmatic', () => {
  const h = (t) => L.leerHorario(t);
  assert.deepEqual(h('24 HRS').franjas, [[0, 1439]]);
  assert.equal(h('24 HORAS').tipo, '24h');
  assert.deepEqual(h('7 a 9 am / 18 a 20 hrs').franjas, [[420, 539], [1080, 1199]]);
  assert.deepEqual(h('3:00 PM A 4:59 PM').franjas, [[900, 1019]]);
  assert.deepEqual(h('19:00 - 24:00HRS').franjas, [[1140, 1439]]);
  assert.deepEqual(h('07:00 - 22:59HRS').franjas, [[420, 1379]]);
  assert.deepEqual(h('19.00 - 19:06').franjas, [[1140, 1146]]);
  assert.deepEqual(h('22:00 - 02:00').franjas, [[1320, 1439], [0, 119]]);
  const full = h('19:00 - 19:50');
  assert.equal(full.tipo, 'franjas');
  assert.equal(full.minutos, 50);
  assert.equal(h('PROGRAMMATIC').tipo, 'programmatic');
  const porFecha = h('DEL 01 AL 03 DE (8:00 AM A 9:59 AM), (1:00 PM A 2:59 PM)');
  assert.equal(porFecha.tipo, 'por_fecha');
  assert.equal(porFecha.franjas, null);
  assert.equal(h('L-V 09:00 - 09:59 // S-D 14:00 - 16:00').tipo, 'por_fecha');
  assert.deepEqual(h(null), { tipo: 'sin', franjas: null, llave: '', minutos: null, entendido: true });
  assert.equal(h('CUANDO SE PUEDA').entendido, false);
  // Dos horarios distintos del mismo día tienen llave distinta.
  assert.notEqual(h('07:45 - 08:15').llave, h('19:00 - 19:03').llave);
});

test('leerObservacion: ventana, límite, banderas y «DEL08 AL 14DE»', () => {
  const sep = { anio: 2026, mes: 9 };
  const ago = { anio: 2026, mes: 8 };
  assert.deepEqual(L.leerObservacion('DEL 01 AL 14 DE SEPTIEMBRE. TOMAS MEDIAS', sep), {
    ventanaInicio: '2026-09-01', ventanaFin: '2026-09-14', fechaLimite: null, banderas: ['medias'], entendido: true,
  });
  const b = L.leerObservacion('DEL 01 AL 31 DE AGOSTO. FOTOS A MAS TARDAR EL 10 DE AGOSTO. (CONSIDERAR TOMAS NORMALES Y POR LADO)', ago);
  assert.equal(b.ventanaInicio, '2026-08-01');
  assert.equal(b.ventanaFin, '2026-08-31');
  assert.equal(b.fechaLimite, '2026-08-10');
  assert.deepEqual(b.banderas, ['por_lado']);
  const pegado = L.leerObservacion('DEL08 AL 14DE SEPTIEMBRE', sep);
  assert.equal(pegado.ventanaInicio, '2026-09-08');
  assert.equal(pegado.ventanaFin, '2026-09-14');
  assert.deepEqual(L.leerObservacion('DEL 28 DE AGOSTO AL 07 DE SEPTIEMBRE', ago).ventanaFin, '2026-09-07');
  assert.equal(L.leerObservacion('UNICAMENTE EL 03 DE SEPTIEMBRE.', sep).ventanaFin, '2026-09-03');
  assert.equal(L.leerObservacion('A PARTIR DEL 15 DE AGOSTO', ago).ventanaFin, null);
  assert.equal(L.leerObservacion('11 Y 12 DE AGOSTO', ago).ventanaFin, '2026-08-12');
  assert.equal(L.leerObservacion('SUBE EL 07 DE AGOSTO (ENVIAR ANTES)', ago).ventanaInicio, '2026-08-07');
  // Cruce de año: diciembre leído con base enero es del año anterior.
  assert.equal(L.leerObservacion('DEL 28 DE DICIEMBRE AL 03 DE ENERO', { anio: 2027, mes: 1 }).ventanaInicio, '2026-12-28');
  const lista = L.leerObservacion('TOMAS MEDIAS (SOLO SE COMPRUEBA UNA VEZ DE AMBAS CATORCENAS) TENER LISTA PERO NO ENVIAR', sep);
  assert.deepEqual(lista.banderas, ['lista_sin_enviar', 'una_vez', 'medias']);
  assert.equal(lista.entendido, false);
  assert.deepEqual(L.leerObservacion('DETENIDA', sep).banderas, ['detenida']);
  assert.deepEqual(L.leerObservacion('TOMAS CORRESPONDIENTES A CAT 02 NO SE COMPRUEBAN', ago).banderas, ['no_se_comprueba']);
  assert.equal(L.leerObservacion(null, ago).entendido, true);
});

test('rellenarCombinadas copia la esquina a toda la combinación sin tocar el original', () => {
  const filas = [['A', 'texto', null], ['B', null, null], ['C', null, null]];
  const out = L.rellenarCombinadas(filas, [{ s: { r: 0, c: 1 }, e: { r: 2, c: 1 } }]);
  assert.deepEqual(out.map((f) => f[1]), ['texto', 'texto', 'texto']);
  assert.equal(filas[1][1], null);
});

test('rellenarCombinadas resta el origen de la hoja (!ref desde B1)', () => {
  // La matriz empieza en B1 (columna A vacía) y el merge viene en coordenadas de hoja: G4:G5.
  const filas = [['x'], [], [], [null, null, null, null, null, 'V1'], [null, null, null, null, null, null]];
  const out = L.rellenarCombinadas(filas, [{ s: { r: 3, c: 6 }, e: { r: 4, c: 6 } }], { r: 0, c: 1 });
  assert.equal(out[4][5], 'V1');
  // Sin el origen caería una columna a la derecha (el error de la revisión del 23-oct-2026).
  assert.equal(L.rellenarCombinadas(filas, [{ s: { r: 3, c: 6 }, e: { r: 4, c: 6 } }])[4][5], null);
});

test('leerFechaCelda: un serial con hora de la tarde se queda en su día', () => {
  assert.equal(L.leerFechaCelda(46310), '2026-10-15');
  assert.equal(L.leerFechaCelda(46310.75), '2026-10-15');
  assert.equal(L.leerFechaCelda(46310.999), '2026-10-15');
  assert.equal(L.leerFechaCelda(Number.NaN), null);
});

test('horaExcel: la hora tecleada como hora de Excel', () => {
  assert.equal(L.horaExcel(0.291666), '07:00');
  assert.equal(L.horaExcel(0), '00:00');
  assert.equal(L.horaExcel(0.999999), '23:59');
  assert.equal(L.horaExcel(new Date(1899, 11, 30, 19, 30)), '19:30');
  for (const no of [1, 46310.5, '07:00', null, new Date(2026, 9, 1)]) assert.equal(L.horaExcel(no), null, String(no));
});

// ------------------------------------------------------------
// Libros y periodo
// ------------------------------------------------------------

test('leerHorario: el formato de la Bitácora VV («02:00 - 09:59HRS», «00:00 - 23:59HRS»)', () => {
  assert.deepEqual(L.leerHorario('02:00 - 09:59HRS').franjas, [[120, 599]]);
  assert.equal(L.leerHorario('00:00 - 23:59HRS').tipo, '24h');
  assert.equal(L.leerHorario('07:00 - 21:59HRS / 23:00 - 23:59HRS').franjas.length, 2);
});

// ------------------------------------------------------------
// Celdas de las bitácoras REALES (23-oct-2026), con valores inventados.
// ------------------------------------------------------------

test('leerFechaBitacora: mes primero, «17 SEP», «-» y años tecleados mal', () => {
  const R = { inicio: '2026-10-13', fin: '2026-10-26' };
  const f = (v, r = R) => L.leerFechaBitacora(v, r);
  assert.deepEqual(f('10/13/2026'), { fecha: '2026-10-13', guion: false, mesDia: true, ilegible: false });
  assert.deepEqual(f('13/10/2026'), { fecha: '2026-10-13', guion: false, mesDia: false, ilegible: false });
  // Las dos lecturas existen: manda día/mes, salvo que solo mes/día caiga en la vigencia.
  assert.equal(f('05/10/2026', { inicio: '2026-10-01', fin: '2026-10-31' }).fecha, '2026-10-05');
  assert.deepEqual(f('10/05/2026', { inicio: '2026-10-01', fin: '2026-10-31' }), { fecha: '2026-10-05', guion: false, mesDia: true, ilegible: false });
  assert.equal(f('17 SEP', { inicio: '2026-08-18', fin: '2026-12-31' }).fecha, '2026-09-17');
  assert.equal(f('11 sep.', { inicio: '2026-08-18', fin: null }).fecha, '2026-09-11');
  assert.equal(f('5 DE ENERO', { inicio: '2026-11-01', fin: null }).fecha, '2027-01-05', 'cruza de año');
  assert.equal(f('5 DE OCTUBRE 2026', null).fecha, '2026-10-05');
  for (const g of ['-', ' — ', 'N/A', 'NA']) assert.deepEqual(f(g), { fecha: null, guion: true, mesDia: false, ilegible: false });
  for (const mal of ['13/10/0206', '14/16/26', '26/210/2026', '15/2026', 'PENDIENTE']) assert.deepEqual([mal, f(mal).fecha, f(mal).ilegible], [mal, null, true]);
  assert.equal(f(46308).fecha, '2026-10-13');
  assert.equal(f(D(2026, 10, 26)).fecha, '2026-10-26');
  assert.deepEqual(f(null), { fecha: null, guion: false, mesDia: false, ilegible: false });
});

test('versionSinMedida: variantes de la bitácora real de Ecovallas', () => {
  const v = L.versionSinMedida;
  assert.equal(v('SMARTFIT_PRUEBA-1440x405'), 'SMARTFIT_PRUEBA');
  assert.equal(v('INFORME PRUEBA - 1440 X 405-01.jpg'), v('INFORME PRUEBA - 1152X324-01.jpg'));
  assert.equal(v('GLOW PRUEBA 1440x405 V2.jpg'), 'GLOW PRUEBA V2');
  assert.equal(v('MARCA PRUEBA_CRISTAL-1440×405'), 'MARCA PRUEBA_CRISTAL');
  assert.equal(v('BOLSA PRUEBA-1440X405PX_Sucursal'), 'BOLSA PRUEBA_Sucursal');
  assert.equal(v('R1 PRUEBA_NAP_A_362X45 LMP.psb'), 'R1 PRUEBA_NAP_A LMP');
});

test('leerHorario: «HRS» entre la hora y el «A» (bitácora real de Ecovallas)', () => {
  assert.deepEqual(L.leerHorario('12:00 HRS A 13:00 HRS').franjas, [[720, 779]]);
  assert.deepEqual(L.leerHorario('15:00 hrs a 15:59hrs').franjas, [[900, 959]]);
  assert.deepEqual(L.leerHorario('(8:00 AM A 09:59 AM), (3:00 PM A 7:59 PM)').franjas, [[480, 599], [900, 1199]]);
  assert.equal(L.leerHorario('24 HORAS').tipo, '24h');
});

test('limpiarClave: la «M» perdida de MX y las claves con guion de las megavallas', () => {
  assert.deepEqual(L.limpiarClave('X_CM_BB_MED_0049'), { clave: 'MX_CM_BB_MED_0049', cambios: ['prefijo'], edoMex: false });
  assert.deepEqual(L.limpiarClave('MX_CM_EV_MGV_2-4_3492'), { clave: 'MX_CM_EV_MGV_2-4_3492', cambios: [], edoMex: false });
  // MX_EM_ solo se MARCA: la omisión es de Vía Verde y la hace el lector con esa unidad.
  assert.equal(L.limpiarClave('MX_EM_EV_MGP_02_0010').edoMex, true);
});

test('leerFechaBitacora con mesPrimero y esSoloMesDia (revisión del 23-oct-2026)', () => {
  // Una celda que SOLO cuadra con el mes primero marca toda la hoja.
  assert.equal(L.esSoloMesDia('10/13/2026'), true);
  assert.equal(L.esSoloMesDia('11/12/2026'), false, 'ambigua');
  assert.equal(L.esSoloMesDia('13/10/2026'), false, 'día primero');
  assert.equal(L.esSoloMesDia('10/13/0206'), false, 'año tecleado mal');
  assert.equal(L.esSoloMesDia(46308), false);
  const R = { inicio: '2026-10-01', fin: '2026-12-31' };
  // Celda por celda, la ambigua se lee día/mes (las dos lecturas caen en la vigencia)…
  assert.equal(L.leerFechaBitacora('11/12/2026', R).fecha, '2026-12-11');
  // …con la hoja en mes primero, mes/día.
  assert.deepEqual(L.leerFechaBitacora('11/12/2026', R, { mesPrimero: true }), { fecha: '2026-11-12', guion: false, mesDia: true, ilegible: false });
  assert.equal(L.leerFechaBitacora('10/10/2026', R, { mesPrimero: true }).fecha, '2026-10-10');
  assert.equal(L.leerFechaBitacora('13/10/2026', R, { mesPrimero: true }).fecha, '2026-10-13', 'si mes/día no existe, día/mes');
});

test('versionSinMedida: la extensión con coma («-C,png», bitácora real de Ecovallas)', () => {
  assert.equal(L.versionSinMedida('PAN PRUEBA-C,png'), 'PAN PRUEBA-C');
  assert.equal(L.versionSinMedida('PAN PRUEBA-C,png'), L.versionSinMedida('PAN PRUEBA-C.png'));
});

test('errorLectorEnEspanol: los errores de SheetJS y fflate en palabras de campo (revisión 2)', () => {
  assert.match(L.errorLectorEnEspanol(new Error('File is password-protected')), /contraseña/);
  assert.match(L.errorLectorEnEspanol(new Error('invalid zip data')), /dañado/);
  assert.match(L.errorLectorEnEspanol(new Error('Unsupported file 0x1234')), /no parece un Excel/);
  assert.match(L.errorLectorEnEspanol(new RangeError('Invalid array length')), /demasiado grande/);
  // Nada en inglés para lo que no se reconoce.
  assert.equal(L.errorLectorEnEspanol(new Error('something odd')), 'archivo dañado o no es Excel');
  assert.equal(L.errorLectorEnEspanol(undefined), 'archivo dañado o no es Excel');
});
