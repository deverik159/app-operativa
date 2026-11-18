import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/reportesAppBiobox.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const {
  abreReportesAppBiobox, unidadesBandeja, atiendeUnidad, pideMarcarAtendido, estadoBandeja,
  textoEstatusCore, desfase, equivalenciaDe, leerErrorBandeja, minutosDesde, coincideBusqueda,
  fechaCoreAIso, llaveReincidencia, reincidencias, enlaceWebadmin, maquinaOpcionalAlReparar,
  filtrarMaquinas, pideMaquinaAlClasificar, abiertasPorMaquina,
  comoSeAtendio, mediana, resumenAppBiobox, lunesDeReporte, contarPor, porSemanaApp, reincidentesApp,
  nombreCortoMaquina,
} = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const rep = (x = {}) => ({
  report_id: 10, folio_app: 'F10', unidad_negocio: 'Biobox', caso_id: 7, motivo: 'Compuerta atorada',
  etiqueta: 'Compuerta con fallas', descripcion: 'La compuerta no abre', codigo_maquina: 'MX_CM_BB_MEC_0076',
  nombre_maquina: 'OBRERO ZEMPOALA', clave_inventario: 'MX_CM_BB_MEC_0076', estatus_core: 1,
  decision: null, record_id: null, marca_atendido: null, presente: true, ...x,
});
const inc = (estatus, x = {}) => ({ record_id: 'abc', folio: 'BBMM00031', estatus, nombre_incidencia: 'Falla en el proceso de reciclaje', ...x });

test('Quién ve la bandeja y de qué unidades', () => {
  assert.deepEqual(unidadesBandeja([{ rol: 'validador', unidad_negocio: 'Biobox' }]), ['Biobox']);
  // Biobox Perú está en pausa (Erik, 10-nov-2026): su coordinador no ve bandeja.
  assert.deepEqual(unidadesBandeja([{ rol: 'coordinador', unidad_negocio: 'biobox perú' }]), []);
  assert.deepEqual(unidadesBandeja([{ rol: 'manager', unidad_negocio: null }]), ['Biobox']);
  // Consulta por unidad (Erik, 9-nov-2026): la de Ecovallas ya no la ve; sin unidad, todas.
  assert.deepEqual(unidadesBandeja([{ rol: 'viewer', unidad_negocio: 'Ecovallas' }]), []);
  assert.deepEqual(unidadesBandeja([{ rol: 'viewer', unidad_negocio: 'Biobox' }]), ['Biobox']);
  assert.deepEqual(unidadesBandeja([{ rol: 'viewer', unidad_negocio: null }]), ['Biobox']);
  // Técnico de TI (Ricardo, sin unidad): ve las dos, pero no atiende.
  const ti = [{ rol: 'reparacion', unidad_negocio: null, departamento: 'TI' }];
  assert.deepEqual(unidadesBandeja(ti), ['Biobox']);
  assert.equal(atiendeUnidad(ti, 'Biobox'), false);
  assert.deepEqual(unidadesBandeja([{ rol: 'reparacion', unidad_negocio: 'Biobox', departamento: 'ti' }]), ['Biobox']);
  assert.deepEqual(unidadesBandeja([{ rol: 'coordinador', unidad_negocio: null }]), ['Biobox']);
  // El validador sin unidad no ve nada (como inc_sel_validador en la base).
  assert.deepEqual(unidadesBandeja([{ rol: 'validador', unidad_negocio: null }]), []);
  // Técnicos de otras áreas (Digital, Op. Bio Box) y validadores de otra unidad: no.
  assert.equal(abreReportesAppBiobox([{ rol: 'reparacion', unidad_negocio: null }]), false);
  assert.equal(abreReportesAppBiobox([{ rol: 'reparacion', unidad_negocio: 'Biobox', departamento: 'Digital' }]), false);
  assert.equal(abreReportesAppBiobox([{ rol: 'reparacion', unidad_negocio: 'Biobox', departamento: 'Op. Bio Box' }]), false);
  assert.equal(abreReportesAppBiobox([{ rol: 'validador', unidad_negocio: 'Ecovallas' }]), false);
  assert.equal(abreReportesAppBiobox([{ rol: 'reportante', unidad_negocio: 'Biobox' }]), false);
});

test('Solo la validadora de ESA unidad o el manager atienden', () => {
  assert.equal(atiendeUnidad([{ rol: 'validador', unidad_negocio: 'Biobox' }], 'Biobox'), true);
  assert.equal(atiendeUnidad([{ rol: 'validador', unidad_negocio: 'Biobox' }], 'Biobox Perú'), false);
  assert.equal(atiendeUnidad([{ rol: 'coordinador', unidad_negocio: 'Biobox' }], 'Biobox'), false);
  assert.equal(atiendeUnidad([{ rol: 'validador', unidad_negocio: null }], 'Biobox'), false);
  assert.equal(atiendeUnidad([{ rol: 'manager', unidad_negocio: null }], 'Biobox Perú'), true);
});

test('Marcar Atendido: la validadora al cerrar, el técnico al reparar', () => {
  const v = rep({ decision: 'clasificado', record_id: 'abc', marca_atendido: 'validador', estatus_core: 2 });
  assert.equal(pideMarcarAtendido(v, inc('en_proceso')), false);
  assert.equal(pideMarcarAtendido(v, inc('reparado')), false);
  assert.equal(pideMarcarAtendido(v, inc('cerrada')), true);
  assert.equal(pideMarcarAtendido({ ...v, estatus_core: 3 }, inc('cerrada')), false);
  const t = { ...v, decision: 'directo', marca_atendido: 'tecnico' };
  assert.equal(pideMarcarAtendido(t, inc('en_proceso')), false);
  assert.equal(pideMarcarAtendido(t, inc('reparado')), true);
  assert.equal(pideMarcarAtendido(t, inc('cerrada')), true);
  assert.equal(pideMarcarAtendido(t, undefined), false);
});

test('Cada reporte cae en una sola pestaña', () => {
  assert.equal(estadoBandeja(rep(), undefined), 'por_clasificar');
  assert.equal(estadoBandeja(rep({ decision: 'descartado' }), undefined), 'descartado');
  // Lo atendido en el Webadmin sin pasar por nosotros va en su propio filtro (10-nov-2026).
  assert.equal(estadoBandeja(rep({ decision: 'atendido_en_webadmin', estatus_core: 3 }), undefined), 'atendido_app');
  const v = rep({ decision: 'ligado', record_id: 'abc', marca_atendido: 'validador', estatus_core: 2 });
  assert.equal(estadoBandeja(v, inc('en_proceso')), 'en_proceso');
  assert.equal(estadoBandeja(v, inc('cerrada')), 'marcar_atendido');
  assert.equal(estadoBandeja({ ...v, estatus_core: 3 }, inc('cerrada')), 'terminado');
  // Biobox ya lo atendió y aquí sigue abierta: se queda En proceso (con aviso de desfase).
  assert.equal(estadoBandeja({ ...v, estatus_core: 3 }, inc('en_proceso')), 'en_proceso');
  assert.match(desfase({ ...v, estatus_core: 3 }, inc('en_proceso')), /ya dice «Atendido»/);
  assert.equal(desfase(v, inc('en_proceso')), null);
});

test('Textos, equivalencias y errores', () => {
  assert.equal(textoEstatusCore({ estatus_core: 2 }), 'En atención');
  assert.equal(textoEstatusCore({ estatus_core: 9, estatus_core_nombre: 'Cancelado' }), 'Cancelado');
  const eq = [
    { unidad_negocio: 'Biobox', caso_id: 7, catalogo_detalle: 'Falla en el proceso de reciclaje', activo: true },
    { unidad_negocio: 'Biobox Perú', caso_id: 7, catalogo_detalle: 'Otra', activo: true },
    { unidad_negocio: 'Biobox', caso_id: 2, catalogo_detalle: 'Fallas con la aplicación', activo: false },
  ];
  assert.equal(equivalenciaDe(rep(), eq).catalogo_detalle, 'Falla en el proceso de reciclaje');
  assert.equal(equivalenciaDe(rep({ unidad_negocio: 'Biobox Perú' }), eq).catalogo_detalle, 'Otra');
  assert.equal(equivalenciaDe(rep({ caso_id: 2 }), eq), null);
  const d = leerErrorBandeja('DUPLICADO:BBMM00031');
  assert.equal(d.folioDuplicado, 'BBMM00031');
  assert.match(d.texto, /BBMM00031/);
  assert.equal(leerErrorBandeja('Escribe el motivo del descarte.').folioDuplicado, null);
});

test('La fecha de Biobox se lee como UTC', () => {
  // BBMAQ-00369: Biobox dice 18:25:09 y en CDMX fueron las 12:25 (UTC-6).
  assert.equal(fechaCoreAIso('2026-11-09 18:25:09'), '2026-11-09T18:25:09Z');
  // BBOTR-00366: 01:00 UTC del 9 fue el 8 a las 19:00 en CDMX.
  assert.equal(new Date(fechaCoreAIso('2026-11-09 01:00:53')).getTime() - 6 * 3600e3,
    Date.parse('2026-11-08T19:00:53Z'));
  assert.equal(fechaCoreAIso('2026-11-09T07:05'), '2026-11-09T07:05:00Z');
  assert.equal(fechaCoreAIso('2026-11-09 18:25:09.123'), '2026-11-09T18:25:09Z');
  for (const raro of ['', null, '09/11/2026 18:25', 'ayer']) assert.equal(fechaCoreAIso(raro), null);
});

test('Minutos desde la última carga y búsqueda', () => {
  const ahora = Date.parse('2026-11-09T19:00:00Z');
  assert.equal(minutosDesde('2026-11-09T18:20:00Z', ahora), 40);
  assert.equal(minutosDesde(null, ahora), null);
  assert.equal(coincideBusqueda(rep(), undefined, 'compuerta zempoala'), true);
  assert.equal(coincideBusqueda(rep(), undefined, 'cómpuerta'), true);
  assert.equal(coincideBusqueda(rep(), inc('en_proceso'), 'BBMM00031'), true);
  assert.equal(coincideBusqueda(rep(), undefined, 'puntos'), false);
});

test('Llave de reincidencia: misma máquina y mismo motivo, sin importar el usuario', () => {
  const a = llaveReincidencia(rep());
  assert.ok(a);
  assert.equal(llaveReincidencia(rep({ report_id: 99, descripcion: 'otro usuario' })), a);
  // Otro motivo u otra máquina: otra llave.
  assert.notEqual(llaveReincidencia(rep({ caso_id: 6 })), a);
  assert.notEqual(llaveReincidencia(rep({ clave_inventario: 'MX_CM_BB_MED_0059' })), a);
  // Sin máquina (puntos, cuenta, QR) o sin motivo: no hay reincidencia.
  assert.equal(llaveReincidencia(rep({ clave_inventario: null, codigo_maquina: null })), null);
  assert.equal(llaveReincidencia(rep({ clave_inventario: 'SIN-MAQUINA', codigo_maquina: null })), null);
  assert.equal(llaveReincidencia(rep({ caso_id: null, motivo: null })), null);
  // Sin clave de inventario usa el código de Biobox.
  assert.ok(llaveReincidencia(rep({ clave_inventario: null, codigo_maquina: 'mx_cm_bb_mec_0076' })));
});

test('Reincidencias en 30, 60 y 90 días; los descartados no cuentan', () => {
  const ahora = Date.parse('2026-11-10T18:00:00Z');
  const hace = (d) => new Date(ahora - d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const lista = [
    rep({ report_id: 1, fecha_reporte_core: hace(2) }),
    rep({ report_id: 2, fecha_reporte_core: hace(20), estatus_core: 3, decision: 'atendido_en_webadmin' }),
    rep({ report_id: 3, fecha_reporte_core: hace(45) }),
    rep({ report_id: 4, fecha_reporte_core: hace(80) }),
    rep({ report_id: 5, fecha_reporte_core: hace(120) }), // fuera de 90 días
    rep({ report_id: 6, fecha_reporte_core: hace(5), decision: 'descartado' }), // prueba: no cuenta
    rep({ report_id: 7, fecha_reporte_core: hace(3), caso_id: 6 }), // otro motivo
  ];
  const m = reincidencias(lista, ahora);
  const x = m.get(llaveReincidencia(rep()));
  assert.deepEqual(x.porVentana, { 30: 2, 60: 3, 90: 4 });
  assert.deepEqual(x.reportes.map((r) => r.report_id), [1, 2, 3, 4]); // del más reciente al más viejo
  assert.equal(x.reportes[1].estatus, 'Atendido');
  assert.equal(m.get(llaveReincidencia(rep({ caso_id: 6 }))).porVentana[90], 1);
});

test('Enlace al Webadmin solo con un número de reporte válido', () => {
  assert.match(enlaceWebadmin(369), /\/buzon\/detail\/369$/);
  for (const malo of [0, -1, 1.5, null, undefined, NaN]) assert.equal(enlaceWebadmin(malo), null);
});

test('Máquina opcional al reparar: solo las de abono de puntos', () => {
  const app = (obs) => ({ nombre_incidencia: 'Fallas con la aplicación', area_reportante: 'App Biobox', observaciones: obs });
  // Motivo y etiqueta de la app en la primera línea.
  assert.equal(maquinaOpcionalAlReparar(app('App Biobox · reporte BBAPP-00379 · Abono de puntos · «Error de abono de punto»')), true);
  assert.equal(maquinaOpcionalAlReparar(app('App Biobox · reporte BBAPP-1 · Otro · «Error de abono de punto»\nnota')), true);
  // Falla del catálogo, venga de donde venga.
  assert.equal(maquinaOpcionalAlReparar({ nombre_incidencia: 'Error en el abono de puntos', area_reportante: 'MKT' }), true);
  // Canjeo de puntos y demás motivos: la máquina sigue obligatoria.
  assert.equal(maquinaOpcionalAlReparar(app('App Biobox · reporte BBAPP-2 · Detección del código de barras del producto · «Error en el canjeo de puntos»')), false);
  // Lo que escribió la validadora (segunda línea) no cuenta.
  assert.equal(maquinaOpcionalAlReparar(app('App Biobox · reporte BBAPP-3 · Compuerta atorada\nquizá abono de puntos')), false);
  // Si no vino de la app, las Observaciones no cuentan.
  assert.equal(maquinaOpcionalAlReparar({ nombre_incidencia: 'Fallas con la aplicación', area_reportante: 'MKT', observaciones: 'App Biobox · reporte X · Abono de puntos' }), false);
  assert.equal(maquinaOpcionalAlReparar({}), false);
});

test('Máquina opcional al reparar: todo lo de TI que vino de la app (11-nov-2026)', () => {
  const ti = (x = {}) => ({ nombre_incidencia: 'Fallas con la aplicación', area_reportante: 'App Biobox', area_responsable: 'TI', ...x });
  assert.equal(maquinaOpcionalAlReparar(ti({ observaciones: 'App Biobox · reporte F1 · Problemas con mi cuenta · «Problemas con mi cuenta»' })), true);
  assert.equal(maquinaOpcionalAlReparar(ti({ observaciones: 'App Biobox · reporte F2 · Canjeo de puntos · «Error en el canjeo de puntos»' })), true);
  assert.equal(maquinaOpcionalAlReparar(ti({ observaciones: 'App Biobox · reporte F3 · «Puntos o aplicación»' })), true);
  // Reasignada a TI desde otra área: cuenta la asignada.
  assert.equal(maquinaOpcionalAlReparar(ti({ area_responsable: 'Digital', assigned_area: 'TI' })), true);
  // Lo de Digital que vino de la app sigue pidiendo máquina.
  assert.equal(maquinaOpcionalAlReparar(ti({ nombre_incidencia: 'Falla en el proceso de reciclaje', area_responsable: 'Digital' })), false);
  // TI que NO vino de la app: sigue pidiendo máquina.
  assert.equal(maquinaOpcionalAlReparar(ti({ area_reportante: 'Operaciones' })), false);
});

test('Clasificar: buscar la máquina por clave, nombre, dirección o municipio (12-nov-2026)', () => {
  const lista = [
    { vendor_face_id: 'MX_CM_BB_MEC_0076', site_legacy_id: 'OBRERO ZEMPOALA', direccion: 'Av. Obrero Mundial', municipio: 'Benito Juárez' },
    { vendor_face_id: 'MX_EM_BB_UCL_0007', site_legacy_id: 'UCL 7', direccion: 'Calle 0076 Norte', municipio: 'Toluca' },
    { vendor_face_id: 'MX_CM_BB_IID_0001', site_legacy_id: null, direccion: null, municipio: 'Coyoacán' },
  ];
  const claves = (q) => filtrarMaquinas(lista, q).map((m) => m.vendor_face_id);
  assert.deepEqual(claves(''), []);
  assert.deepEqual(claves('   '), []);
  // «0076» está en la clave de una y en la dirección de otra: primero la clave.
  assert.deepEqual(claves('0076'), ['MX_CM_BB_MEC_0076', 'MX_EM_BB_UCL_0007']);
  assert.deepEqual(claves('zempoala'), ['MX_CM_BB_MEC_0076']);
  assert.deepEqual(claves('ucl 7'), ['MX_EM_BB_UCL_0007']);
  assert.deepEqual(claves('JUAREZ'), ['MX_CM_BB_MEC_0076']); // sin acentos ni mayúsculas
  assert.deepEqual(claves('coyoacán'), ['MX_CM_BB_IID_0001']);
  assert.deepEqual(claves('toluca zempoala'), []); // todas las palabras deben aparecer
  assert.equal(filtrarMaquinas(lista, 'mx', 2).length, 2);
});

test('Clasificar: reciclaje pide máquina; lo de la aplicación no (17-nov-2026)', () => {
  assert.equal(pideMaquinaAlClasificar('Falla en el proceso de reciclaje'), true);
  assert.equal(pideMaquinaAlClasificar('  falla en el PROCESO de reciclaje '), true);
  assert.equal(pideMaquinaAlClasificar('Fallas con la aplicación'), false);
  assert.equal(pideMaquinaAlClasificar('Recolección de reciclaje'), false);
  assert.equal(pideMaquinaAlClasificar(null), false);
});

test('Bandeja: incidencias abiertas agrupadas por máquina, la más reciente primero (18-nov-2026)', () => {
  const m = abiertasPorMaquina([
    { folio: 'A', clave_medio: 'MX_1', creado_en: '2026-11-10T10:00:00Z' },
    { folio: 'B', clave_medio: 'MX_1', creado_en: '2026-11-12T10:00:00Z' },
    { folio: 'C', clave_medio: 'MX_2', creado_en: '2026-11-11T10:00:00Z' },
    { folio: 'D', clave_medio: null, creado_en: '2026-11-11T10:00:00Z' },
    { folio: 'E', clave_medio: '  ', creado_en: null },
  ]);
  assert.deepEqual([...m.keys()].sort(), ['MX_1', 'MX_2']);
  assert.deepEqual(m.get('MX_1').map((x) => x.folio), ['B', 'A']);
  assert.equal(m.get('MX_3'), undefined);
});

test('Indicadores App Biobox: cómo se atendió y resumen con medianas (18-nov-2026)', () => {
  assert.equal(comoSeAtendio({ decision: 'directo', decidido_por: null }), 'directo');
  assert.equal(comoSeAtendio({ decision: 'ligado', decidido_por: null }), 'ligado_regla');
  assert.equal(comoSeAtendio({ decision: 'ligado', decidido_por: 'dulce@x' }), 'ligado_validadora');
  assert.equal(comoSeAtendio({ decision: 'atendido_en_webadmin', decidido_por: null }), 'atendido_webadmin');
  assert.equal(comoSeAtendio({ decision: null, decidido_por: null }), 'por_clasificar');
  assert.equal(mediana([]), null);
  assert.equal(mediana([5, 1, 3]), 3);
  assert.equal(mediana([4, 1, 3, 2]), 2.5);

  const base = { unidad_negocio: 'Biobox', caso_id: 7, motivo: 'Compuerta atorada', codigo_maquina: 'MX_1', nombre_maquina: 'X', atendido_core_en: null, decidido_por: null, decidido_en: null, record_id: null };
  const lista = [
    // Directo: reportó 10:00 UTC, reparada 12:00, cerrada 14:00, Atendido 16:00.
    { ...base, report_id: 1, clave_inventario: 'MX_1', fecha_reporte_core: '2026-11-10 10:00:00', decision: 'directo', record_id: 'a', atendido_core_en: '2026-11-10T16:00:00Z' },
    // Clasificado por Dulce 4 h después; sin máquina.
    // Llegó a la bandeja a las 12:00 (no a las 10:00, cuando reportó): cuenta desde ahí.
    { ...base, report_id: 2, clave_inventario: null, fecha_reporte_core: '2026-11-10 10:00:00', primera_vez: '2026-11-10T12:00:00Z', decision: 'clasificado', decidido_por: 'dulce@x', decidido_en: '2026-11-10T14:00:00Z', record_id: 'b' },
    { ...base, report_id: 3, clave_inventario: 'MX_1', fecha_reporte_core: '2026-11-11 10:00:00', decision: 'ligado', record_id: 'a' },
    { ...base, report_id: 4, clave_inventario: null, fecha_reporte_core: '2026-11-11 10:00:00', decision: null },
    { ...base, report_id: 5, clave_inventario: null, fecha_reporte_core: '2026-11-11 10:00:00', decision: 'descartado', decidido_por: 'dulce@x' },
    { ...base, report_id: 6, clave_inventario: 'MX_2', fecha_reporte_core: '2026-10-01 10:00:00', decision: 'atendido_en_webadmin' },
  ];
  const incs = new Map([
    ['a', { record_id: 'a', repaired_at: '2026-11-10T12:00:00Z', cerrada_en: '2026-11-10T14:00:00Z' }],
    ['b', { record_id: 'b', repaired_at: null, cerrada_en: null }],
  ]);
  const r = resumenAppBiobox(lista, incs);
  assert.equal(r.total, 6);
  assert.equal(r.sinMaquina, 3);
  assert.equal(r.automaticos, 2); // directo + ligado por regla
  assert.equal(r.porValidadora, 1);
  assert.equal(r.porClasificar, 1);
  assert.equal(r.descartados, 1);
  assert.equal(r.atendidosAntes, 1);
  assert.equal(r.enBandeja, 5);
  assert.deepEqual(r.aClasificar, { h: 2, n: 1 });
  // El ligado (3) comparte la incidencia «a», pero se reportó DESPUÉS de repararse: no cuenta.
  assert.deepEqual(r.aReparar, { h: 2, n: 1 });
  assert.deepEqual(r.aCierre, { h: 4, n: 1 });
  assert.deepEqual(r.cierreAAtendido, { h: 2, n: 1 });
});

test('Indicadores App Biobox: semana en día de CDMX y reincidencia en 30 días', () => {
  // Lunes 9-nov 05:59 UTC = domingo 8-nov 23:59 en CDMX → semana del lunes 2-nov.
  assert.equal(lunesDeReporte('2026-11-09 05:59:00'), '2026-11-02');
  assert.equal(lunesDeReporte('2026-11-09 06:00:00'), '2026-11-09');
  assert.equal(lunesDeReporte('basura'), null);
  const s = porSemanaApp([
    { fecha_reporte_core: '2026-11-10 10:00:00' },
    { fecha_reporte_core: '2026-11-03 10:00:00' },
    { fecha_reporte_core: '2026-11-11 10:00:00' },
  ]);
  assert.deepEqual(s.map((x) => [x.etiqueta, x.n]), [['2026-11-02', 1], ['2026-11-09', 2]]);
  assert.deepEqual(contarPor([{ m: 'a' }, { m: 'b' }, { m: 'a' }, { m: null }], (x) => x.m).map((x) => [x.etiqueta, x.n]), [['a', 2], ['b', 1]]);

  const r = (id, maq, fecha, extra = {}) => ({ report_id: id, unidad_negocio: 'Biobox', caso_id: 7, motivo: 'Compuerta atorada', clave_inventario: maq, codigo_maquina: maq, nombre_maquina: 'N', fecha_reporte_core: fecha, decision: 'directo', decidido_por: null, decidido_en: null, record_id: null, atendido_core_en: null, ...extra });
  const rein = reincidentesApp([
    r(1, 'MX_1', '2026-10-01 10:00:00'),
    r(2, 'MX_1', '2026-10-20 10:00:00'), // 19 días después: reincide
    r(3, 'MX_2', '2026-09-01 10:00:00'),
    r(4, 'MX_2', '2026-11-01 10:00:00'), // 61 días: no
    r(5, 'MX_3', '2026-11-01 10:00:00'),
    r(6, 'MX_3', '2026-11-02 10:00:00', { decision: 'descartado' }), // descartado no cuenta
    r(7, null, '2026-11-01 10:00:00'),
    r(8, null, '2026-11-02 10:00:00'), // sin máquina no hay reincidencia
  ]);
  assert.deepEqual(rein.map((x) => [x.etiqueta, x.n]), [['N — Compuerta atorada', 2]]);
});

test('Indicadores: la máquina se nombra solo con su nombre o la clave sin MX ni BB (18-nov-2026)', () => {
  assert.equal(nombreCortoMaquina('MX_CM_BB_MED_0031', 'MIRAMONTES Y LA VIRGEN'), 'MIRAMONTES Y LA VIRGEN');
  assert.equal(nombreCortoMaquina('MX_CM_BB_MED_0031', '  '), 'CM_MED_0031');
  assert.equal(nombreCortoMaquina('MX_EM_BB_UCL_0007', null), 'EM_UCL_0007');
  assert.equal(nombreCortoMaquina('PE_LM_BB_IID_0004', null), 'PE_LM_IID_0004');
  assert.equal(nombreCortoMaquina('MX_BB', null), 'MX_BB');
  assert.equal(nombreCortoMaquina(null, null), 'Sin máquina');
});
