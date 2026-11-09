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
  assert.deepEqual(unidadesBandeja([{ rol: 'coordinador', unidad_negocio: 'biobox perú' }]), ['Biobox Perú']);
  assert.deepEqual(unidadesBandeja([{ rol: 'manager', unidad_negocio: null }]), ['Biobox', 'Biobox Perú']);
  assert.deepEqual(unidadesBandeja([{ rol: 'viewer', unidad_negocio: 'Ecovallas' }]), ['Biobox', 'Biobox Perú']);
  assert.deepEqual(unidadesBandeja([{ rol: 'coordinador', unidad_negocio: null }]), ['Biobox', 'Biobox Perú']);
  // El validador sin unidad no ve nada (como inc_sel_validador en la base).
  assert.deepEqual(unidadesBandeja([{ rol: 'validador', unidad_negocio: null }]), []);
  // Técnicos (también Ricardo, TI sin unidad) y validadores de otra unidad: no.
  assert.equal(abreReportesAppBiobox([{ rol: 'reparacion', unidad_negocio: null }]), false);
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
  assert.equal(estadoBandeja(rep({ decision: 'atendido_en_webadmin', estatus_core: 3 }), undefined), 'terminado');
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

test('Minutos desde la última carga y búsqueda', () => {
  const ahora = Date.parse('2026-11-09T19:00:00Z');
  assert.equal(minutosDesde('2026-11-09T18:20:00Z', ahora), 40);
  assert.equal(minutosDesde(null, ahora), null);
  assert.equal(coincideBusqueda(rep(), undefined, 'compuerta zempoala'), true);
  assert.equal(coincideBusqueda(rep(), undefined, 'cómpuerta'), true);
  assert.equal(coincideBusqueda(rep(), inc('en_proceso'), 'BBMM00031'), true);
  assert.equal(coincideBusqueda(rep(), undefined, 'puntos'), false);
});
