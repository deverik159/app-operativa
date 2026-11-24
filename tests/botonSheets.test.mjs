import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

// El botón «Actualizar» de las hojas de los equipos (Apps Script,
// 24-nov-2026). Se carga sin servicios de Google: solo la lógica pura.
const codigo = readFileSync(
  fileURLToPath(new URL('../scripts/sheets/ActualizarIncidenciasApp.gs', import.meta.url)),
  'utf8'
);
// El Date de aquí: así `instanceof Date` del script reconoce las fechas de las pruebas.
const ctx = vm.createContext({ Date });
vm.runInContext(
  codigo + '\n;globalThis.__x = { CONFIGS, LIGAR_DESDE, planear, normalizar, elegirConfig, valorDe, tramos, fechaCercana, bloques, leerBase, resumenTexto, revisarBase, idDeBase, revisarMismoArchivo, ajustarALista, serialFecha, horaDeTexto, fraccionHora, celda, formatoPara, semanaIso };',
  ctx
);
const B = ctx.__x;

// Las llaves de la base (encabezados de la pestaña «App»), de la función.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../supabase/functions/sync-sheets/logica.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { ENCABEZADOS_BASE, normalizarEncabezado } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);
const LLAVES_BASE = new Set(ENCABEZADOS_BASE.map(normalizarEncabezado));

// Encabezados reales de las tres pestañas (leídos el 24-nov-2026).
const ENC = {
  'Vía Verde': ['FOLIO', 'PLAZA', 'ID', 'CANTIDAD DE COLUMNAS', 'LADO', 'SEMANA', 'FECHA DE REPORTE', 'HORA DE REPORTE',
    'ÁREA QUE REPORTA', 'INCIDENCIA', 'CAMPAÑA', 'DETALLE DE LA INCIDENCIA', 'ESTATUS 1', 'EVIDENCIA DE INCIDENCIA',
    'ÁREA RESPONSABLE DE REPARACIÓN', 'ÁREA RESPONSABLE DE RESPUESTA', 'DETALLE DE REPARACIÓN', 'ESTATUS FINAL',
    'EVIDENCIA DE SOLUCIÓN', 'FECHA DE SOLUCIÓN', 'HORA DE SOLUCIÓN', 'TIEMPO REPORTE VS SOLUCIÓN',
    'TIEMPO EXTRA PARA SOLUCIÓN', 'COMENTARIOS FINALES', 'DIA', 'SEMANA2', 'estatus inicio', 'estatus final2',
    'Clasificación', 'TIEMPO DE RESPUESTA', 'Origen de incidencia ', 'Impacto de Incidencia', 'Orden',
    'Promedio de tiempo por impscto', 'Tipo de Incidencia', '', '87792', 'Nomenclatura'],
  'Ecovallas Fijas': [' Río Consulado 1520, Va CDMX', 'RUTA', 'CLAVE DE SITIO', 'CLAVE DE VALLA', 'DIRECCIÓN',
    'ALCALDIA/ MUNICIPIO', 'PLAZA', 'MEDIO', 'CARA', 'CATORCENA', 'FECHA DE REPORTE', 'HORA DE REPORTE',
    'ÁREA QUE REPORTA', 'VÍA DE REPORTE', 'CATEGORÍA', 'INCIDENCIA', 'DETALLE DE LA INCIDENCIA', 'CAMPAÑA',
    'ESTATUS INICIAL', 'EVIDENCIA DE INCIDENCIA', 'ÁREA RESPONSABLE', 'TIEMPO ESTIMADO DE SOLUCIÓN',
    'DETALLE DE REPARACIÓN', 'ESTATUS FINAL', 'EVIDENCIA DE SOLUCIÓN', 'FECHA DE REPARACIÓN', 'HORAS DE REPARACIÓN',
    'Comentarios', 'Tiempo de reparación de  incidencia', 'Días extras de reparación', 'MES ', 'DÍA', 'FECHAMES',
    'Estatus Inicial 2', 'Estatus final 2', 'Vencido', 'En proceso', 'Reparado', 'Clasificación',
    'Nivel de Incidencia', 'Origen de Incidencia', 'Tipo de Incidencia.1', 'Tiempo Promedio'],
  'Ecovallas Digital': ['Folio', 'Ruta', 'Clave de sitio', 'Clave de pantalla', 'Dirección ', 'Alcaldía o Municipio',
    'Plaza', 'Catorcena', 'Fecha de reporte', 'Hora de Reporte', 'Área reportante', 'Vía de reporte',
    'Tipo de incidencia ', 'Campaña', 'Área responsable de respuesta', 'Detalle de la incidencia', 'Estatus inicial',
    'Añadir evidencia de reporte', 'Área responsable de reparación', 'Detalle de reparación', 'Estatus final',
    'Añadir evidencia de reparación', 'Fecha de reparación', 'Hora de reparación', 'Tiempo de incidencia',
    'Comentarios finales', 'MES ', 'DÍA', 'FECHAMES', 'Estatus Inicial 2', 'Estatus final 2', 'Vencido',
    'En proceso', 'Clasificación', 'Nivel de Incidencia', 'Origen de Incidencia', 'Tipo de Incidencia.1',
    'Tiempo Promedio ', 'Seguimiento', 'Semana', ''],
};

/** Columnas que el botón nunca debe llenar (las llena el equipo). */
const A_MANO = ['ruta', 'medio', 'categoria', 'comentarios', 'comentariosfinales', 'seguimiento',
  'evidenciadeincidencia', 'evidenciadesolucion', 'anadirevidenciadereporte', 'anadirevidenciadereparacion'];

const cfgDe = (nombre) => B.CONFIGS.find((c) => c.nombre === nombre);
const col = (nombre, h) => ENC[nombre].map(B.normalizar).indexOf(B.normalizar(h));

test('cada columna configurada existe en su hoja y sale de una columna real de la base', () => {
  for (const cfg of B.CONFIGS) {
    const claves = ENC[cfg.nombre].map(B.normalizar);
    assert.ok(claves.includes(cfg.fecha), `${cfg.nombre}: falta la columna de fecha`);
    for (const [clave, fuente] of Object.entries(cfg.columnas)) {
      assert.ok(claves.includes(clave), `${cfg.nombre}: no existe la columna «${clave}»`);
      assert.ok(!A_MANO.includes(clave), `${cfg.nombre}: «${clave}» la llena el equipo`);
      const llave = typeof fuente === 'string' ? fuente : fuente.base || fuente.semanaIso;
      if (llave) assert.ok(LLAVES_BASE.has(llave), `${cfg.nombre}: la base no tiene «${llave}»`);
    }
  }
});

test('elige la configuración por la pestaña que existe en el archivo', () => {
  assert.equal(B.elegirConfig(['Hoja 4', '1ER TRIMESTRE 2026']).nombre, 'Vía Verde');
  assert.equal(B.elegirConfig(['Ecovallas Digitales 2026']).nombre, 'Ecovallas Digital');
  assert.equal(B.elegirConfig(['Consolidado']), null);
});

test('un vacío en la app no borra lo del equipo; en fila nueva pone el valor por omisión', () => {
  const campana = { base: 'campana', vacio: 'N/A' };
  assert.equal(B.valorDe(campana, { campana: '' }, false), null);
  assert.equal(B.valorDe(campana, { campana: '' }, true).valor, 'N/A');
  assert.equal(B.valorDe('detalledereparacion', { detalledereparacion: null }, true), null);
  assert.deepEqual({ ...B.valorDe({ fijo: 1 }, {}, false) }, { valor: 1, tipo: 'numero' });
  assert.equal(B.valorDe('fechareporte', { fechareporte: '2026-11-24' }, false).tipo, 'fecha');
  assert.equal(B.valorDe('horareporte', { horareporte: '09:20' }, false).tipo, 'hora');
});

test('estatus con las palabras de cada hoja', () => {
  const vv = cfgDe('Vía Verde').columnas.estatusfinal;
  const fijas = cfgDe('Ecovallas Fijas').columnas.estatusfinal;
  assert.equal(B.valorDe(vv, { estatusfinal: 'Reparado por aprobar' }, false).valor, 'En proceso');
  assert.equal(B.valorDe(vv, { estatusfinal: 'Devuelta' }, false).valor, 'En proceso');
  assert.equal(B.valorDe(vv, { estatusfinal: 'No reparado' }, false).valor, 'No Reparado');
  assert.equal(B.valorDe(fijas, { estatusfinal: 'No reparado' }, false).valor, 'No reparado');
  assert.equal(B.valorDe(fijas, { estatusfinal: 'Reparado' }, false).valor, 'Reparado');
});

test('fecha cercana: a lo más 3 días', () => {
  assert.equal(B.fechaCercana(new Date(2026, 10, 20), '2026-11-22'), true);
  assert.equal(B.fechaCercana(new Date(2026, 10, 20), '2026-11-25'), false);
  assert.equal(B.fechaCercana('20/11/2026', '2026-11-20'), false);
});

test('tramos y bloques: pocas llamadas a Sheets', () => {
  const t = B.tramos([
    { fila: 5, col: 2, valor: 'a' },
    { fila: 6, col: 2, valor: 'b' },
    { fila: 9, col: 2, valor: 'c' },
    { fila: 5, col: 3, valor: 'd' },
  ]);
  assert.deepEqual(
    [...t.map((x) => [x.col, x.desde, x.celdas.length])],
    [[2, 5, 2], [2, 9, 1], [3, 5, 1]]
  );
  assert.deepEqual(JSON.parse(JSON.stringify(B.bloques({ 26: true, 27: true, 28: true, 33: true }))), [[26, 3], [33, 1]]);
});

/** Una fila de la hoja Digital con algunas celdas. */
function filaDigital(valores) {
  const f = ENC['Ecovallas Digital'].map(() => '');
  for (const [h, v] of Object.entries(valores)) f[col('Ecovallas Digital', h)] = v;
  return f;
}

function baseFila(o) {
  return {
    plaza: 'Ciudad de México', incidencia: 'Pantalla en negro', detalledeincidencia: 'Se ve negra',
    arearesponsable: 'Digital', areareportante: 'Monitoreo', viadereporte: 'App', campana: '',
    horareporte: '10:15', catorcena: 24, afectacion: 'Operatividad', actualizadoutc: '2026-11-24T18:00:00.000Z',
    ...o,
  };
}

test('Digital: liga la copiada a mano, usa las filas preparadas y agrega al final', () => {
  const cfg = cfgDe('Ecovallas Digital');
  const datos = [
    // Misma falla que la app: se liga.
    filaDigital({ Folio: 'EVD2540', 'Fecha de reporte': new Date(2026, 10, 20), 'Comentarios finales': 'EVD00001/ OPNOV1501', Campaña: 'Coca', 'Tipo de incidencia ': 'Pantalla en negro' }),
    // Piloto de junio: EVD00008 es OTRA incidencia, no se liga.
    filaDigital({ Folio: 'EVD1790', 'Fecha de reporte': new Date(2026, 5, 6), Seguimiento: 'EVD00008' }),
    filaDigital({ Folio: 'EVD2542', 'Fecha de reporte': new Date(2026, 10, 21) }),
    filaDigital({ Folio: 'EVD2543', 'Área responsable de respuesta': 'Digital' }), // preparada
    filaDigital({}), // solo fórmulas, sin folio
  ];
  const formulasCols = {
    [col('Ecovallas Digital', 'MES ')]: true,
    [col('Ecovallas Digital', 'FECHAMES')]: true,
    [col('Ecovallas Digital', 'Clasificación')]: true,
  };
  const base = [
    baseFila({ folio: 'EVD00001', fechareporte: '2026-11-20', estatusfinal: 'Reparado por aprobar' }),
    baseFila({ folio: 'EVD00008', fechareporte: '2026-11-22', estatusfinal: 'En proceso' }),
    baseFila({ folio: 'EVD00009', fechareporte: '2026-11-23', estatusfinal: 'Reparado' }),
    baseFila({ folio: 'EVD00010', fechareporte: '2026-11-23', estatusfinal: 'Duplicada' }),
    baseFila({ folio: 'EV00036', fechareporte: '2026-11-23', estatusfinal: 'En proceso' }),
    baseFila({ folio: 'EVD00011', fechareporte: '2026-11-24', estatusfinal: 'Por validar' }),
  ];
  const plan = B.planear({ cfg, encabezados: ENC['Ecovallas Digital'], datos, formulasCols, base, desde: null, filaEncabezados: 1 });

  assert.equal(plan.crearFolioApp, true);
  assert.equal(plan.colFolioApp, col('Ecovallas Digital', 'Semana') + 1); // AO, la vacía
  assert.deepEqual({ ...plan.cuenta }, { actualizadas: 0, ligadas: 1, nuevas: 3, duplicadas: 1, iguales: 0 });
  assert.deepEqual([...plan.ligadasLista], ['EVD2540 = EVD00001']);
  assert.deepEqual(
    [...plan.nuevas.map((n) => [n.fila, n.folioEquipo, n.folioApp, n.masAllaDeLosDatos])],
    [[5, 'EVD2543', 'EVD00008', false], [6, 'EVD2544', 'EVD00009', false], [7, 'EVD2545', 'EVD00011', true]]
  );

  const en = (fila, h) => plan.escrituras.filter((e) => e.fila === fila && e.col === (h === 'Folio App' ? plan.colFolioApp : col('Ecovallas Digital', h)));
  // La ligada (fila 2): su Folio App y el estatus con sus palabras.
  assert.equal(en(2, 'Folio App')[0].valor, 'EVD00001');
  assert.equal(en(2, 'Estatus final')[0].valor, 'En proceso');
  assert.equal(en(2, 'Plaza')[0].valor, 'CDMX');
  // No pisa lo del equipo: campaña vacía en la app, comentarios, fórmulas.
  assert.equal(en(2, 'Campaña').length, 0);
  assert.equal(en(2, 'Comentarios finales').length, 0);
  assert.equal(en(2, 'Clasificación').length, 0);
  assert.equal(en(2, 'Folio').length, 0);
  // Preparada (fila 5): conserva su folio; nueva sin folio (fila 6): el siguiente.
  assert.equal(en(5, 'Folio').length, 0);
  assert.equal(en(6, 'Folio')[0].valor, 'EVD2544');
  assert.equal(en(6, 'Campaña')[0].valor, 'N/A');
  assert.equal(en(6, 'Estatus inicial')[0].valor, 'Reportado');
  assert.equal(en(6, 'Fecha de reporte')[0].tipo, 'fecha');
  assert.equal(en(7, 'Estatus final')[0].valor, 'En proceso');
  // La fila del piloto de junio no se tocó.
  assert.equal(plan.escrituras.filter((e) => e.fila === 3).length, 0);
  assert.deepEqual([...plan.calculadas], ['Clasificación']);
});

test('con «Folio App» ya puesto: solo lo que cambió desde la última vez', () => {
  const cfg = cfgDe('Ecovallas Digital');
  const enc = [...ENC['Ecovallas Digital'].slice(0, -1), 'Folio App'];
  const fa = enc.length - 1;
  const fila = (folio, app, fecha) => {
    const f = enc.map(() => '');
    f[0] = folio;
    f[col('Ecovallas Digital', 'Fecha de reporte')] = fecha;
    f[fa] = app;
    return f;
  };
  const datos = [fila('EVD2600', 'EVD00020', new Date(2026, 10, 24)), fila('EVD2601', 'EVD00021', new Date(2026, 10, 24))];
  const base = [
    baseFila({ folio: 'EVD00020', fechareporte: '2026-11-24', estatusfinal: 'Reparado', actualizadoutc: '2026-11-24T10:00:00.000Z' }),
    baseFila({ folio: 'EVD00021', fechareporte: '2026-11-24', estatusfinal: 'Reparado', actualizadoutc: '2026-11-24T20:00:00.000Z' }),
  ];
  const desde = Date.parse('2026-11-24T15:00:00.000Z');
  const plan = B.planear({ cfg, encabezados: enc, datos, formulasCols: {}, base, desde, filaEncabezados: 1 });
  assert.equal(plan.crearFolioApp, false);
  assert.deepEqual({ ...plan.cuenta }, { actualizadas: 1, ligadas: 0, nuevas: 0, duplicadas: 0, iguales: 1 });
  assert.ok(plan.escrituras.every((e) => e.fila === 3));
  // Ya no está en la app: se avisa, no se borra.
  const plan2 = B.planear({ cfg, encabezados: enc, datos, formulasCols: {}, base: base.slice(1), desde: null, filaEncabezados: 1 });
  assert.deepEqual([...plan2.noEstan], ['EVD00020']);
});

test('Fijas: el folio del equipo (EV10638) nunca se confunde con uno de la app', () => {
  const cfg = cfgDe('Ecovallas Fijas');
  const enc = ENC['Ecovallas Fijas'];
  const c = (h) => enc.map(B.normalizar).indexOf(B.normalizar(h));
  const f = enc.map(() => '');
  f[0] = 'EV14001';
  f[c('FECHA DE REPORTE')] = new Date(2026, 10, 23);
  f[c('Comentarios')] = 'ver EV10638 y EV00036';
  f[c('CLAVE DE VALLA')] = 'MX_CM_EV_LUM_11_3318';
  const plan = B.planear({
    cfg, encabezados: enc, datos: [f], formulasCols: {}, filaEncabezados: 1, desde: null,
    base: [
      // Misma clave de valla que la fila: se liga aunque la falla se llame distinto.
      baseFila({ folio: 'EV00036', fechareporte: '2026-11-23', estatusfinal: 'No reparado', plaza: 'México', clavedemedio: 'MX_CM_EV_LUM_11_3318', incidencia: 'Arte roto' }),
      baseFila({ folio: 'EVD00040', fechareporte: '2026-11-23', estatusfinal: 'Reparado' }),
    ],
  });
  assert.deepEqual([...plan.ligadasLista], ['EV14001 = EV00036']);
  assert.equal(plan.cuenta.nuevas, 0); // EVD00040 es de la hoja Digital
  const plaza = plan.escrituras.find((e) => e.col === c('PLAZA'));
  assert.equal(plaza.valor, 'Estado de México');
  const est = plan.escrituras.find((e) => e.col === c('ESTATUS FINAL'));
  assert.equal(est.valor, 'No reparado');
  // Ningún folio nuevo cuando no hay nada nuevo; el siguiente sería EV14002.
  assert.match(B.resumenTexto(cfg, plan), /ligada/);
});

test('leerBase: encabezados normalizados y sin filas sin folio', () => {
  const filas = B.leerBase([
    ['Folio', 'Estatus Final', 'Hora Reporte'],
    ['EVD00001', 'Reparado', '09:20'],
    ['', 'x', 'y'],
  ]);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].estatusfinal, 'Reparado');
  assert.equal(filas[0].horareporte, '09:20');
});

test('BASE_ID de otra unidad: avisa y no toca nada (caso del 24-nov-2026)', () => {
  const digital = cfgDe('Ecovallas Digital');
  const vv = cfgDe('Vía Verde');
  const baseVV = [{ folio: 'VV00001' }, { folio: 'VV00002' }];
  const baseEV = [{ folio: 'EV00001' }, { folio: 'EVD00001' }];
  assert.match(B.revisarBase(digital, baseVV, 'Incidencias VV Gral'), /no tiene folios de Ecovallas Digital[\s\S]*BASE_ID/);
  assert.match(B.revisarBase(vv, baseEV, 'Incidencias EV Gral'), /Vía Verde lee «Incidencias VV Gral»/);
  assert.match(B.revisarBase(vv, [], 'Incidencias VV Gral'), /no tiene folios todavía/);
  assert.equal(B.revisarBase(digital, baseEV, 'Incidencias EV Gral'), null);
});

/** Fila de Vía Verde con folio, día de noviembre, ticket y falla. */
function filaVV(folio, dia, ticket, incidencia) {
  const enc = ENC['Vía Verde'];
  const f = enc.map(() => '');
  f[0] = folio;
  f[col('Vía Verde', 'FECHA DE REPORTE')] = new Date(2026, 10, dia);
  f[enc.indexOf('87792')] = ticket;
  f[col('Vía Verde', 'INCIDENCIA')] = incidencia;
  return f;
}

test('caso VV00005 (24-nov-2026): en dos filas, se liga la de la misma falla, no la más reciente', () => {
  const cfg = cfgDe('Vía Verde');
  const datos = [
    filaVV('VV0921', 23, 'VV00005/ OPNOV2301', 'Cámara desconectada'),
    filaVV('VV0922', 23, '', 'Pantalla en negro'),
    filaVV('VV0923', 23, 'VV00005', 'Falla en el medidor'),
  ];
  const plan = B.planear({
    cfg, encabezados: ENC['Vía Verde'], datos, formulasCols: {}, filaEncabezados: 1, desde: null,
    base: [baseFila({ folio: 'VV00005', fechareporte: '2026-11-23', estatusfinal: 'Reparado por aprobar', plaza: 'CDMX', incidencia: 'Cámara desconectada' })],
  });
  assert.deepEqual([...plan.ligadasLista], ['VV0921 = VV00005']);
  assert.deepEqual([...plan.tambienEn], ['VV00005 también está en VV0923']);
  // VV0923 (fila 4) no se toca.
  assert.equal(plan.escrituras.filter((e) => e.fila === 4).length, 0);
  assert.equal(plan.deEstaHoja, 1);
  const t = B.resumenTexto(cfg, plan, {
    nombreBase: 'Incidencias VV Gral',
    fallas: [{ columna: 'ÁREA QUE REPORTA', fila: 930, mensaje: 'no cumple la validación' }],
  });
  assert.match(t, /Base: «Incidencias VV Gral», 1 folio\(s\) de esta hoja de 1/);
  assert.match(t, /Sin tocar: VV00005 también está en VV0923/);
  assert.match(t, /ÁREA QUE REPORTA: filas 930 — no cumple la validación/);
});

test('escrito a mano pero sin prueba de que sea la misma: ni se liga ni se duplica', () => {
  const cfg = cfgDe('Vía Verde');
  const datos = [filaVV('VV0923', 23, 'VV00005', 'Falla en el medidor')];
  const plan = B.planear({
    cfg, encabezados: ENC['Vía Verde'], datos, formulasCols: {}, filaEncabezados: 1, desde: null,
    base: [baseFila({ folio: 'VV00005', fechareporte: '2026-11-23', estatusfinal: 'En proceso', incidencia: 'Cámara desconectada' })],
  });
  assert.equal(plan.cuenta.ligadas, 0);
  assert.equal(plan.cuenta.nuevas, 0);
  assert.equal(plan.escrituras.length, 0);
  assert.match([...plan.revisar][0], /VV00005 \(«Cámara desconectada»\) está escrito en VV0923/);
  assert.match(B.resumenTexto(cfg, plan), /Revisar a mano[\s\S]*Folio App/);
});

test('semana ISO, igual que la de las hojas de los equipos', () => {
  // Pares reales de «1ER TRIMESTRE 2026» y «Ecovallas Digitales 2026».
  const pares = [
    ['2026-01-01', 1], ['2026-01-04', 1], ['2026-01-05', 2], ['2026-01-18', 3], ['2026-01-19', 4],
    ['2026-03-08', 10], ['2026-03-09', 11], ['2026-03-29', 13], ['2026-03-30', 14], ['2026-06-28', 26],
    ['2026-06-29', 27], ['2026-09-06', 36], ['2026-09-14', 38], ['2026-11-22', 47], ['2026-11-23', 48],
  ];
  for (const [f, s] of pares) assert.equal(B.semanaIso(f), s, f);
  assert.equal(B.semanaIso('2027-01-01'), 53); // viernes: aún es la última de 2026
  assert.equal(B.semanaIso('nada'), null);
  const vv = cfgDe('Vía Verde').columnas.semana;
  assert.deepEqual({ ...B.valorDe(vv, { fechareporte: '2026-11-23' }, true) }, { valor: 48, tipo: 'numero' });
});

test('BASE_ID acepta el enlace completo y avisa si es el mismo archivo', () => {
  assert.equal(B.idDeBase('https://docs.google.com/spreadsheets/d/ABC_123-x/edit?gid=0#gid=0'), 'ABC_123-x');
  assert.equal(B.idDeBase('  ABC_123-x  '), 'ABC_123-x');
  const fijas = cfgDe('Ecovallas Fijas');
  assert.match(
    B.revisarMismoArchivo(fijas, 'ID1', 'ID1', '1erTrimestre Ecovallas 2026'),
    /mismo archivo[\s\S]*Incidencias EV Gral/
  );
  assert.match(B.revisarMismoArchivo(cfgDe('Vía Verde'), 'X', 'X', 'Incidencias Vía Verde 2026'), /Incidencias VV Gral/);
  assert.equal(B.revisarMismoArchivo(fijas, 'GRAL', 'ID1', '1erTrimestre Ecovallas 2026'), null);
});

test('listas desplegables: se escribe como lo dice la lista; lo que no está, no', () => {
  const lista = ['Monitoreo', 'Comercial', 'Operación Digital', 'Soporte Digital', 'Digital', 'No Reparado'];
  assert.equal(B.ajustarALista('monitoreo', lista), 'Monitoreo');
  assert.equal(B.ajustarALista('Operacion digital', lista), 'Operación Digital');
  assert.equal(B.ajustarALista('No reparado', lista), 'No Reparado');
  assert.equal(B.ajustarALista('SRD', lista), null);
  assert.equal(B.ajustarALista('', lista), null);
});

test('el aviso separa por columna y por valor rechazado', () => {
  const cfg = cfgDe('Ecovallas Digital');
  const plan = B.planear({ cfg, encabezados: ENC['Ecovallas Digital'], datos: [], formulasCols: {}, base: [], desde: null, filaEncabezados: 1 });
  const t = B.resumenTexto(cfg, plan, {
    fallas: [
      { columna: 'Área reportante', fila: 1449, mensaje: '«SRD» no está en su lista (…)' },
      { columna: 'Área reportante', fila: 1450, mensaje: '«Operaciones» no está en su lista (…)' },
      { columna: 'Área reportante', fila: 1451, mensaje: '«SRD» no está en su lista (…)' },
    ],
  });
  assert.match(t, /Área reportante: filas 1449, 1451 — «SRD»/);
  assert.match(t, /Área reportante: filas 1450 — «Operaciones»/);
  assert.match(t, /siguiente «Actualizar»/);
});

test('área que reporta con las equivalencias de Erik (24-nov-2026)', () => {
  const vv = cfgDe('Vía Verde').columnas.areaquereporta;
  const digital = cfgDe('Ecovallas Digital').columnas.areareportante;
  const fijas = cfgDe('Ecovallas Fijas').columnas.areaquereporta;
  assert.equal(B.valorDe(vv, { areareportante: 'SRD' }, false).valor, 'Digital');
  assert.equal(B.valorDe(vv, { areareportante: 'Monitoreo' }, false).valor, 'Monitoreo');
  assert.equal(B.valorDe(digital, { areareportante: 'SRD' }, false).valor, 'Digital');
  assert.equal(B.valorDe(digital, { areareportante: 'Operaciones' }, true).valor, 'Digital');
  // Fijas: «Operaciones» no se escribe (ni en fila nueva ni ligada).
  assert.equal(B.valorDe(fijas, { areareportante: 'Operaciones' }, true), null);
  assert.equal(B.valorDe(fijas, { areareportante: 'Monitoreo' }, false).valor, 'Monitoreo');
});

test('fechas y horas como número de Sheets, sin zonas horarias', () => {
  // 1-ene-1900 es el 2 en Sheets; 24-nov-2026 es 46350.
  assert.equal(B.serialFecha('1900-01-01'), 2);
  assert.equal(B.serialFecha('2026-11-24'), 46350);
  assert.equal(B.serialFecha('24/11/2026'), null);
  assert.equal(B.horaDeTexto('9:03'), '09:03');
  assert.equal(B.horaDeTexto('16:57:00'), '16:57');
  assert.equal(B.horaDeTexto('25:00'), null);
  assert.equal(B.fraccionHora('12:00'), 0.5);
  assert.equal(B.fraccionHora('09:03'), (9 * 60 + 3) / 1440);
  assert.equal(B.celda({ tipo: 'fecha', valor: '2026-11-24' }), 46350);
  assert.equal(B.celda({ tipo: 'hora', valor: '18:00' }), 0.75);
  // Si no se puede leer, va como texto y no se inventa una fecha.
  assert.equal(B.celda({ tipo: 'fecha', valor: 'mañana' }), "'mañana");
  assert.equal(B.celda({ tipo: 'texto', valor: '1/2' }), "'1/2");
  assert.equal(B.celda({ tipo: 'numero', valor: 1 }), 1);
});

test('formato de la columna: el de la última fila real, o uno de México', () => {
  assert.equal(B.formatoPara('fecha', 'd/mm/yyyy'), 'd/mm/yyyy');
  assert.equal(B.formatoPara('hora', 'h:mm:ss am/pm'), 'h:mm:ss am/pm');
  assert.equal(B.formatoPara('fecha', ''), 'd/M/yyyy');
  assert.equal(B.formatoPara('fecha', 'General'), 'd/M/yyyy');
  assert.equal(B.formatoPara('hora', '0.00'), 'H:mm');
});

test('leerBase toma la hora como se ve en la celda', () => {
  const filas = B.leerBase(
    [['Folio', 'Hora Reporte'], ['VV00001', 'objeto-fecha-1899']],
    (k, v, m) => (k === 'horareporte' ? B.horaDeTexto(m) : v),
    [['Folio', 'Hora Reporte'], ['VV00001', '9:03']]
  );
  assert.equal(filas[0].horareporte, '09:03');
});

test('Digital: «Estructura con grafiti» y «Estructura dañada» se quedan como las escribió el equipo', () => {
  const f = cfgDe('Ecovallas Digital').columnas.tipodeincidencia;
  assert.equal(B.valorDe(f, { incidencia: 'Estructura con grafiti' }, false), null);
  assert.equal(B.valorDe(f, { incidencia: 'Estructura dañada' }, true), null);
  assert.equal(B.valorDe(f, { incidencia: 'Pantalla en negro' }, false).valor, 'Pantalla en negro');
});

/** Fila de Ecovallas Fijas capturada a mano (sin folio de la app escrito). */
function filaFijas(folio, dia, valla, sitio, falla, extra = {}) {
  const enc = ENC['Ecovallas Fijas'];
  const c = (h) => enc.map(B.normalizar).indexOf(B.normalizar(h));
  const f = enc.map(() => '');
  f[0] = folio;
  f[c('FECHA DE REPORTE')] = new Date(2026, 10, dia);
  f[c('CLAVE DE VALLA')] = valla;
  f[c('CLAVE DE SITIO')] = sitio;
  f[c('INCIDENCIA')] = falla;
  for (const [h, v] of Object.entries(extra)) f[c(h)] = v;
  return f;
}

test('Fijas (24-nov-2026): capturada a mano sin folio de la app se liga por valla, falla y fecha', () => {
  const cfg = cfgDe('Ecovallas Fijas');
  const datos = [
    filaFijas('EV13884', 12, 'MX_CM_EV_LUM_11_3318', 'MX_CM_EV_3318', 'Arte sucio'),
    filaFijas('EV13885', 12, 'MX_CM_EV_LUM_12_3318', 'MX_CM_EV_3318', 'Arte sucio'),
    filaFijas('EV14069', 23, 'MX_CM_EV_EVA_03_3645', 'MX_CM_EV_3645', 'Arte mal fijado'),
    filaFijas('EV14081', 23, '', 'MX_CM_EV_3631', 'Adicional con grafiti'),
    filaFijas('EV14090', 20, 'MX_CM_EV_EVA_01_2547', 'MX_CM_EV_2547', 'Arte con grafiti'),
    // Menciona otro folio de la app: no se usa para coincidencias.
    filaFijas('EV14095', 24, 'MX_CM_EV_EVA_02_3318', 'MX_CM_EV_3318', 'Valla obstruida', { Comentarios: 'ver EV00099' }),
  ];
  const base = [
    // Orden distinto al de las filas: cada uno con SU valla.
    baseFila({ folio: 'EV00002', fechareporte: '2026-11-12', clavedemedio: 'MX_CM_EV_LUM_12_3318', clavedesitio: 'MX_CM_EV_3318', incidencia: 'Arte sucio', estatusfinal: 'Reparado' }),
    baseFila({ folio: 'EV00001', fechareporte: '2026-11-12', clavedemedio: 'MX_CM_EV_LUM_11_3318', clavedesitio: 'MX_CM_EV_3318', incidencia: 'Arte sucio', estatusfinal: 'Reparado' }),
    // Misma valla, otra falla: es otra incidencia → fila nueva.
    baseFila({ folio: 'EV00032', fechareporte: '2026-11-23', clavedemedio: 'MX_CM_EV_EVA_03_3645', clavedesitio: 'MX_CM_EV_3645', incidencia: 'Moldura dañada', estatusfinal: 'En proceso' }),
    // Adicional: sin valla, por sitio y falla.
    baseFila({ folio: 'EV00035', fechareporte: '2026-11-23', clavedemedio: null, clavedesitio: 'MX_CM_EV_3631', incidencia: 'Adicional con grafiti', estatusfinal: 'En proceso' }),
    // Misma valla y falla pero 4 días después: no es la misma.
    baseFila({ folio: 'EV00059', fechareporte: '2026-11-24', clavedemedio: 'MX_CM_EV_EVA_01_2547', clavedesitio: 'MX_CM_EV_2547', incidencia: 'Arte con grafiti', estatusfinal: 'En proceso' }),
    // La única candidata menciona otro folio: no se liga.
    baseFila({ folio: 'EV00046', fechareporte: '2026-11-24', clavedemedio: 'MX_CM_EV_EVA_02_3318', clavedesitio: 'MX_CM_EV_3318', incidencia: 'Valla obstruida', estatusfinal: 'En proceso' }),
  ];
  const plan = B.planear({ cfg, encabezados: ENC['Ecovallas Fijas'], datos, formulasCols: {}, base, desde: null, filaEncabezados: 1 });
  assert.deepEqual([...plan.coincidencias].sort(), ['EV13884 = EV00001', 'EV13885 = EV00002', 'EV14081 = EV00035']);
  assert.deepEqual([...plan.nuevas.map((n) => n.folioApp)].sort(), ['EV00032', 'EV00046', 'EV00059']);
  assert.match(B.resumenTexto(cfg, plan), /Ligadas por misma valla o sitio, falla y fecha[\s\S]*EV13884 = EV00001/);
});
