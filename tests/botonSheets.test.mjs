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
  codigo + '\n;globalThis.__x = { CONFIGS, LIGAR_DESDE, planear, normalizar, elegirConfig, valorDe, tramos, fechaCercana, bloques, leerBase, resumenTexto, revisarBase, idDeBase, revisarMismoArchivo, ajustarALista, serialFecha, horaDeTexto, fraccionHora, celda, formatoPara, semanaIso, elegirGrupo, esDeLaHoja, tipoFallaBiobox, idBiobox, viaBiobox, fechaInicioDeTexto };',
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

// Encabezados reales de las pestañas de «Incidencias Bio Box 2026» (24-nov-2026).
const ENC_BB = {
  '1er Trimestre 2025 M': ['BB', 'ID', 'Nombre', 'Municipio / Localidad', 'Tipo de medio (IMPRESO/ Digital)', 'Semana',
    'Fecha de reporte', 'Hora de reporte', 'Área reportante', 'Vía de reporte', 'Incidencia', 'Detalle de incidencias',
    'Tipo de incidencia', 'Estatus Incial', 'Evidencia Incidencia', 'Departamento responsable reparación',
    'Dias de reparación', 'Detalle de reparación', 'Estatus', 'Evidencia de reparación', 'Fecha de reparación concluida',
    'Hora de reparación concluida', 'Tiempo de reparación incidencia', 'Días extra de reparación', 'Comentarios', 'MES',
    'DÍA', 'FECHAMES', 'Estatus Inicial 2', 'Estatus final 2', 'Tiempo de reparación', 'Afectación', 'Promedio de tiempo',
    'Origen de Incidencia', 'Nivel de Impacto', 'Porcentaje', 'Tipo de Incidencia', 'FOLIO APP', 'Tipo de red',
    'Nomenclarutas Quantum', 'A', 'B', 'Correo', 'Telefono', 'Tipo de máquina'],
  '1er Trimestre 2025 MMA': ['Folio', 'ID', 'Nombre', 'Municipio / Localidad', 'Tipo de medio (IMPRESO/ Digital)', 'Semana',
    'Fecha  de reporte', 'Hora de reporte', 'Área reportante', 'Vía de reporte', 'Incidencia', 'Detalle de Incidencia',
    'Tipo de incidencia', 'Estatus Inicial', 'Evidencia Incidencia', 'Departamento responsable reparación',
    'Tiempo estimado de reparación', 'Detalle de reparación', 'Estatus final', 'Evidencia de reparación',
    'Fecha de reparación concluida', 'Hora de reparación concluida', 'Tiempo de reparación incidencia',
    'Días extra de reparación', 'Comentarios Finales', 'MES', 'DÍA', 'FECHAMES', 'Estatus Inicial 2', 'Estatus final 2',
    'Clasificación', 'Origen de Incidencia', 'Nivel de impacto', 'Tiempo Promedio', 'Tipo de Incidencia',
    'Tipo de incidencia.1', 'FOLIO APP', 'Tipo de red', 'Nomenclarutas Quantum', 'A', 'B', 'C', '', '', 'Tipo de Máquina'],
  'Incidencias M5 OXXO': ['Folio', 'ID', 'Nombre', 'Municipio / Localidad', 'Tipo de medio (IMPRESO/ Digital)', 'Semana',
    'Fecha  de reporte', 'Hora de reporte', 'Área reportante', 'Vía de reporte', 'Incidencia', 'Detalle de Incidencia',
    'Tipo de incidencia', 'Estatus Inicial', 'Evidencia Incidencia', 'Departamento responsable reparación',
    'Tiempo estimado de reparación', 'Detalle de reparación', 'Estatus Final', 'Evidencia de reparación',
    'Fecha de reparación concluida', 'Hora de reparación concluida', 'Tiempo de reparación incidencia',
    'Días extra de reparación', 'Comentarios Finales', 'MES', 'DÍA', 'FECHAMES', 'Estatus Inicial 2', 'Estatus final 2',
    'Clasificación', 'Origen de Incidencia', 'tiempo de reparación', 'nivel de impacto', 'tiempo promedio',
    'Tipo de Incidencia _2', 'Tipo de Incidencia', 'FOLIO APP', 'Tipo de red', 'Nomenclarutas Quantum', '', '',
    'Tipo de Máquina'],
};
ENC_BB['App Biobox'] = ENC_BB['1er Trimestre 2025 MMA'];

test('cada columna configurada existe en su hoja y sale de una columna real de la base', () => {
  const todasBB = new Set(Object.values(ENC_BB).flat().map(B.normalizar));
  for (const cfg of B.CONFIGS) {
    const enc = ENC[cfg.nombre] || ENC_BB[cfg.pestana];
    const claves = enc.map(B.normalizar);
    assert.ok(claves.includes(cfg.fecha), `${cfg.nombre}: falta la columna de fecha`);
    for (const [clave, fuente] of Object.entries(cfg.columnas)) {
      // En Biobox las columnas son opcionales por pestaña, pero cada una existe en alguna.
      if (cfg.columnasOpcionales) assert.ok(todasBB.has(clave), `${cfg.nombre}: ninguna pestaña tiene «${clave}»`);
      // Las de crearColumnas las agrega el botón al final si no están.
      else assert.ok(claves.includes(clave) || (cfg.crearColumnas || []).map(B.normalizar).includes(clave), `${cfg.nombre}: no existe la columna «${clave}»`);
      assert.ok(!A_MANO.includes(clave), `${cfg.nombre}: «${clave}» la llena el equipo`);
      const llaves = typeof fuente === 'string' ? [fuente] : [fuente.base, fuente.semanaIso, ...(fuente.fechaHora || [])];
      for (const llave of llaves.filter(Boolean)) assert.ok(LLAVES_BASE.has(llave), `${cfg.nombre}: la base no tiene «${llave}»`);
    }
    // Nuestro folio nunca va en su «FOLIO APP» (tickets del Webadmin en Biobox).
    if (cfg.encabezadoFolioApp) assert.notEqual(B.normalizar(cfg.encabezadoFolioApp), 'folioapp');
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
  // La ligada (fila 2), capturada a mano: SOLO su Folio App (26-nov-2026).
  assert.equal(en(2, 'Folio App')[0].valor, 'EVD00001');
  assert.deepEqual([...plan.escrituras.filter((e) => e.fila === 2).map((e) => e.col)], [plan.colFolioApp]);
  assert.equal(en(2, 'Estatus final').length, 0);
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
  // Capturada a mano: solo se anota el folio de la app.
  assert.deepEqual([...plan.escrituras.map((e) => e.col)], [plan.colFolioApp]);
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

// ---------------- Biobox (24-nov-2026) ----------------
const bb = (o) => baseFila({ fechareporte: '2026-11-20', horareporte: '10:15', estatusfinal: 'En proceso', ...o });
const pestanaDe = (b) => B.CONFIGS.filter((c) => c.grupo === 'Biobox' && B.esDeLaHoja(c, b)).map((c) => c.pestana);

test('Biobox: un archivo llena sus cuatro pestañas', () => {
  const g = B.elegirGrupo(['Inventario BBX', '1er Trimestre 2025 M', '1er Trimestre 2025 MMA', 'Incidencias M5 OXXO']);
  assert.deepEqual([...g.map((c) => c.pestana)], ['1er Trimestre 2025 M', '1er Trimestre 2025 MMA', 'Incidencias M5 OXXO', 'App Biobox']);
  assert.equal(B.elegirGrupo(['1ER TRIMESTRE 2026']).length, 1);
});

test('Biobox: cada folio va a UNA pestaña, por clave y falla', () => {
  const casos = [
    [bb({ folio: 'BBMM00001', clavedesitio: 'MX_CM_BB_MED_0063', incidencia: 'Pantallas en negro' }), '1er Trimestre 2025 M'],
    [bb({ folio: 'BBMM00002', clavedesitio: 'MX_CM_BB_MEC_0038', incidencia: 'Recolección de reciclaje' }), '1er Trimestre 2025 M'],
    [bb({ folio: 'BBMM00003', clavedesitio: 'MX_CM_BB_MED_0110', incidencia: 'NUC fuera de línea' }), '1er Trimestre 2025 MMA'],
    [bb({ folio: 'BBM00001', clavedesitio: 'MX_CM_BB_UCL_0018', incidencia: 'Falla en el proceso de reciclaje' }), '1er Trimestre 2025 MMA'],
    [bb({ folio: 'BB00028', clavedesitio: 'MX_MT_BB_MIC_0301', incidencia: 'Fallas con la aplicación' }), '1er Trimestre 2025 MMA'],
    [bb({ folio: 'BBOXXO00001', clavedesitio: 'MX_CM_BB_OXD_0002', incidencia: 'Daños estructurales' }), 'Incidencias M5 OXXO'],
    [bb({ folio: 'BBM500001', clavedesitio: 'MX_EM_BB_IID_0007', incidencia: 'Arte no proyectado' }), 'App Biobox'],
    [bb({ folio: 'BB00001', clavedesitio: 'SIN-MAQUINA', incidencia: 'Error en el abono de puntos' }), 'App Biobox'],
  ];
  for (const [b, esperada] of casos) assert.deepEqual([...pestanaDe(b)], [esperada], b.folio);
  // Una falla que no está en la tabla va por su área.
  assert.equal(B.tipoFallaBiobox({ incidencia: 'Algo nuevo', arearesponsable: 'TI' }), 'Mecanismo');
  assert.equal(B.tipoFallaBiobox({ incidencia: 'Algo nuevo', arearesponsable: 'Op. Bio Box' }), 'Mueble');
  // Los de Ecovallas no entran a Biobox.
  assert.deepEqual([...pestanaDe(bb({ folio: 'EV00001', clavedesitio: 'MX_CM_EV_3318' }))], []);
});

test('Biobox: ID como el de «Inventario BBX»', () => {
  const ctx = { idPorClave: { [B.normalizar('MX_CM_BB_UCL_0018')]: 'BB 018' } };
  assert.equal(B.idBiobox({ clavedesitio: 'MX_CM_BB_UCL_0018' }, ctx).valor, 'BB 018');
  assert.equal(B.idBiobox({ clavedesitio: 'MX_CM_BB_MED_0089' }, {}).valor, 'BB 089');
  assert.equal(B.idBiobox({ clavedesitio: 'MX_MT_BB_MIC_0301' }, {}).valor, 'BB 301');
  assert.equal(B.idBiobox({ clavedesitio: 'MX_CM_BB_OXD_0013' }, {}).valor, 'MX_CM_BB_OXD_0013');
  assert.equal(B.idBiobox({ clavedesitio: 'SIN-MAQUINA' }, {}), null);
  assert.equal(B.viaBiobox({ areareportante: 'App Biobox' }).valor, 'APP BioBox');
  assert.equal(B.viaBiobox({ areareportante: 'MKT', viadereporte: 'WhatsApp' }).valor, 'WhatsApp');
  assert.equal(B.viaBiobox({ areareportante: 'Operaciones', viadereporte: 'App' }).valor, 'APP');
});

test('Biobox M: fila nueva con su consecutivo, fecha con hora, tipo y sin tocar su «FOLIO APP»', () => {
  const cfg = B.CONFIGS.find((c) => c.pestana === '1er Trimestre 2025 M');
  const enc = ENC_BB[cfg.pestana];
  const c = (h) => enc.map(B.normalizar).indexOf(B.normalizar(h));
  const fila = enc.map(() => '');
  fila[0] = 'BM2483';
  fila[c('Fecha de reporte')] = new Date(2026, 10, 11);
  const plan = B.planear({
    cfg, encabezados: enc, datos: [fila], formulasCols: { [c('Nombre')]: true, [c('Hora de reporte')]: true },
    filaEncabezados: 1, desde: null, contexto: { idPorClave: {} },
    base: [bb({ folio: 'BBMM00090', clavedesitio: 'MX_CM_BB_MED_0089', incidencia: 'Pantallas en negro', areareportante: 'App Biobox', arearesponsable: 'Digital' })],
  });
  assert.equal(plan.crearFolioApp, true);
  assert.equal(plan.encFolioApp, 'Folio Incidencias App');
  assert.equal(plan.colFolioApp, enc.length); // al final, no en su «FOLIO APP»
  assert.deepEqual([...plan.nuevas.map((n) => n.folioEquipo)], ['BM2484']);
  const en = (h) => plan.escrituras.find((e) => e.fila === 3 && e.col === c(h));
  assert.deepEqual({ ...en('Fecha de reporte') }, { fila: 3, col: c('Fecha de reporte'), valor: '2026-11-20 10:15', tipo: 'fechahora' });
  assert.equal(en('ID').valor, 'BB 089');
  assert.equal(en('Tipo de incidencia').valor, 'Mueble');
  assert.equal(en('Área reportante').valor, 'Usuario');
  assert.equal(en('Vía de reporte').valor, 'APP BioBox');
  assert.equal(en('Estatus Incial').valor, 'Reportado');
  assert.equal(en('Semana').valor, 47);
  assert.equal(en('FOLIO APP'), undefined);
  assert.equal(en('Nombre'), undefined); // fórmula
  assert.equal(B.celda({ tipo: 'fechahora', valor: '2026-11-24 18:00' }), 46350.75);
});

test('Biobox «App Biobox»: pestaña nueva, el folio del equipo es el de la app', () => {
  const cfg = B.CONFIGS.find((c) => c.pestana === 'App Biobox');
  const plan = B.planear({
    cfg, encabezados: ENC_BB['App Biobox'], datos: [], formulasCols: {}, filaEncabezados: 1, desde: null,
    base: [bb({ folio: 'BB00001', clavedesitio: 'SIN-MAQUINA', incidencia: 'Error en el abono de puntos', arearesponsable: 'TI' })],
  });
  assert.deepEqual([...plan.nuevas.map((n) => n.folioEquipo)], ['BB00001']);
  const inc = plan.escrituras.find((e) => e.col === ENC_BB['App Biobox'].map(B.normalizar).indexOf('incidencia'));
  assert.equal(inc.valor, 'Error en el abono de punto');
});

test('Biobox: liga lo que el equipo capturó a mano desde el 14-oct por nomenclatura, falla y fecha', () => {
  const cfg = B.CONFIGS.find((c) => c.pestana === '1er Trimestre 2025 MMA');
  const enc = ENC_BB[cfg.pestana];
  const c = (h) => enc.map(B.normalizar).indexOf(B.normalizar(h));
  const fila = (folio, dia, mes, clave, falla) => {
    const f = enc.map(() => '');
    f[0] = folio;
    f[c('Fecha  de reporte')] = new Date(2026, mes, dia, 9, 30);
    f[c('Nomenclarutas Quantum')] = clave;
    f[c('Incidencia')] = falla;
    return f;
  };
  const datos = [
    fila('BMM4700', 20, 10, 'MX_CM_BB_MED_0110', 'NUC fuera de línea'),
    fila('BMM3000', 12, 9, 'MX_CM_BB_MED_0110', 'NUC fuera de línea'), // 12-oct: antes del 14-oct
  ];
  const plan = B.planear({
    cfg, encabezados: enc, datos, formulasCols: {}, filaEncabezados: 1, desde: null,
    base: [
      bb({ folio: 'BBMM00003', fechareporte: '2026-11-20', clavedesitio: 'MX_CM_BB_MED_0110', incidencia: 'NUC fuera de línea', arearesponsable: 'Digital' }),
      bb({ folio: 'BBMM00004', fechareporte: '2026-10-12', clavedesitio: 'MX_CM_BB_MED_0110', incidencia: 'NUC fuera de línea', arearesponsable: 'Digital' }),
    ],
  });
  assert.deepEqual([...plan.coincidencias], ['BMM4700 = BBMM00003']);
  assert.deepEqual([...plan.nuevas.map((n) => n.folioApp)], ['BBMM00004']);
});

test('Biobox: Correo y Teléfono, en sus columnas o creadas al final', () => {
  const contacto = { correo: 'quien@ejemplo.test', telefono: '5500000000' };
  const base = [bb({ folio: 'BBMM00090', clavedesitio: 'MX_CM_BB_MED_0089', incidencia: 'Falla en el proceso de reciclaje', arearesponsable: 'Digital', ...contacto })];
  // MMA no las tiene: van después de «Folio Incidencias App».
  const mma = B.CONFIGS.find((c) => c.pestana === '1er Trimestre 2025 MMA');
  const encMma = ENC_BB[mma.pestana];
  const p1 = B.planear({ cfg: mma, encabezados: encMma, datos: [], formulasCols: {}, filaEncabezados: 1, desde: null, base, contexto: { idPorClave: {} } });
  const ultima = encMma.length - 1; // «Tipo de Máquina»
  assert.deepEqual(JSON.parse(JSON.stringify(p1.columnasNuevas)), [
    { col: ultima + 1, encabezado: 'Folio Incidencias App' },
    { col: ultima + 2, encabezado: 'Correo' },
    { col: ultima + 3, encabezado: 'Teléfono' },
  ]);
  const en1 = (col) => p1.escrituras.find((e) => e.col === col);
  assert.equal(en1(ultima + 2).valor, contacto.correo);
  assert.equal(en1(ultima + 3).valor, contacto.telefono);
  // M sí las tiene («Correo», «Telefono»): no crea otras.
  const m = B.CONFIGS.find((c) => c.pestana === '1er Trimestre 2025 M');
  const encM = ENC_BB[m.pestana];
  const baseM = [bb({ folio: 'BBMM00091', clavedesitio: 'MX_CM_BB_MED_0089', incidencia: 'Pantallas en negro', arearesponsable: 'Digital', ...contacto })];
  const p2 = B.planear({ cfg: m, encabezados: encM, datos: [], formulasCols: {}, filaEncabezados: 1, desde: null, base: baseM, contexto: { idPorClave: {} } });
  assert.deepEqual([...p2.columnasNuevas.map((c) => c.encabezado)], ['Folio Incidencias App']);
  assert.equal(p2.escrituras.find((e) => e.col === encM.indexOf('Telefono')).valor, contacto.telefono);
  assert.equal(p2.escrituras.find((e) => e.col === encM.indexOf('Correo')).valor, contacto.correo);
});

// ---------------- Respetar lo del equipo (26-nov-2026) ----------------
test('fecha de inicio: lo anterior ni se agrega ni se liga', () => {
  assert.equal(B.fechaInicioDeTexto('01/11/2026'), '2026-11-01');
  assert.equal(B.fechaInicioDeTexto('5/1/2027'), '2027-01-05');
  assert.equal(B.fechaInicioDeTexto('31/02/2026'), null);
  assert.equal(B.fechaInicioDeTexto('2026-11-01'), null);
  const cfg = cfgDe('Ecovallas Fijas');
  const enc = ENC['Ecovallas Fijas'];
  const c = (h) => enc.map(B.normalizar).indexOf(B.normalizar(h));
  const f = enc.map(() => '');
  f[0] = 'EV14001';
  f[c('FECHA DE REPORTE')] = new Date(2026, 10, 10);
  f[c('CLAVE DE VALLA')] = 'MX_CM_EV_LUM_11_3318';
  const base = [
    baseFila({ folio: 'EV00030', fechareporte: '2026-11-10', estatusfinal: 'Reparado', clavedemedio: 'MX_CM_EV_LUM_11_3318' }),
    baseFila({ folio: 'EV00031', fechareporte: '2026-11-19', estatusfinal: 'Reparado' }),
    baseFila({ folio: 'EV00032', fechareporte: '2026-11-20', estatusfinal: 'En proceso', plaza: 'México' }),
  ];
  const plan = B.planear({ cfg, encabezados: enc, datos: [f], formulasCols: {}, filaEncabezados: 1, desde: null, base, fechaInicio: '2026-11-20' });
  assert.deepEqual([...plan.nuevas.map((n) => n.folioApp)], ['EV00032']);
  assert.equal(plan.cuenta.ligadas, 0);
  assert.ok(plan.escrituras.every((e) => e.fila === 3));
  assert.deepEqual([...plan.noEstan], []);
  // En la fila nueva sí van los datos de la app, con las palabras de la hoja.
  assert.equal(plan.escrituras.find((e) => e.col === c('PLAZA')).valor, 'Estado de México');
});

test('fila que ya existe: solo se llenan sus celdas vacías', () => {
  const cfg = cfgDe('Ecovallas Digital');
  const enc = [...ENC['Ecovallas Digital'].slice(0, -1), 'Folio App'];
  const fa = enc.length - 1;
  const c = (h) => col('Ecovallas Digital', h);
  const f = enc.map(() => '');
  f[0] = 'EVD2600';
  f[fa] = 'EVD00020';
  f[c('Fecha de reporte')] = new Date(2026, 10, 21); // el equipo la corrigió
  f[c('Estatus final')] = 'Reparado';
  const base = [baseFila({ folio: 'EVD00020', fechareporte: '2026-11-24', estatusfinal: 'En proceso', actualizadoutc: '2026-11-25T10:00:00.000Z' })];
  const plan = B.planear({ cfg, encabezados: enc, datos: [f], formulasCols: {}, base, desde: null, filaEncabezados: 1 });
  const cols = plan.escrituras.map((e) => e.col);
  assert.ok(!cols.includes(c('Fecha de reporte')));
  assert.ok(!cols.includes(c('Estatus final')));
  assert.ok(cols.includes(c('Plaza'))); // estaba vacía
  assert.equal(plan.cuenta.actualizadas, 1);
  // Si ya no hay nada vacío que llenar, cuenta como igual.
  const llena = f.map((v, j) => (v === '' && j !== 0 ? 'x' : v));
  const plan2 = B.planear({ cfg, encabezados: enc, datos: [llena], formulasCols: {}, base, desde: null, filaEncabezados: 1 });
  assert.equal(plan2.escrituras.length, 0);
  assert.equal(plan2.cuenta.iguales, 1);
});

test('Digital: falla del usuario en su columna; la técnica, en «Incidencia Digital» al final', () => {
  const cfg = cfgDe('Ecovallas Digital');
  const enc = ENC['Ecovallas Digital'];
  const plan = B.planear({
    cfg, encabezados: enc, datos: [], formulasCols: {}, filaEncabezados: 1, desde: null,
    base: [
      baseFila({ folio: 'EVD00050', fechareporte: '2026-11-25', estatusfinal: 'En proceso', incidencia: 'Pantalla en negro', incidenciadigital: 'Corte de Fibra Telmex' }),
      baseFila({ folio: 'EVD00051', fechareporte: '2026-11-25', estatusfinal: 'En proceso', incidencia: 'Cámara obstruída' }),
    ],
  });
  const nueva = plan.columnasNuevas.find((c) => c.encabezado === 'Incidencia Digital');
  assert.ok(nueva);
  const de = (fila, c) => plan.escrituras.find((e) => e.fila === fila && e.col === c);
  const m = col('Ecovallas Digital', 'Tipo de incidencia ');
  assert.equal(de(2, m).valor, 'Pantalla en negro');
  assert.equal(de(2, nueva.col).valor, 'Corte de Fibra Telmex');
  assert.equal(de(3, m).valor, 'Obstrucción cámara');
  assert.equal(de(3, nueva.col), undefined); // el técnico aún no la elige
});
