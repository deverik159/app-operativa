// src/lib/buscarSitiosComp.ts (alta manual de Comprobaciones, 26-oct-2026):
// buscar un sitio para escogerlo uno por uno. Erik se atoró armando una
// campaña de Vía Verde Columna con 3 columnas sueltas; aquí, «679» debe
// encontrar su columna primero y en orden natural el resto.
// Repo PÚBLICO: datos inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/buscarSitiosComp.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const B = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const cara = (vendor_face_id, extra = {}) => ({
  vendor_face_id,
  site_id: null,
  direccion: null,
  municipio: null,
  ...extra,
});

// Columnas inventadas, desordenadas a propósito.
const COLUMNAS = [
  cara('MX_CM_VV_COL_1679', { direccion: 'Av. Inventada 10' }),
  cara('MX_CM_VV_COL_679', { site_id: 'VVC-0679', direccion: 'Calzada Ficticia 200', municipio: 'Coyoacán' }),
  cara('MX_CM_VV_COL_689', { direccion: 'Calle Imaginaria 679', municipio: 'Tlalpan' }),
  cara('MX_CM_VV_COL_651', { direccion: 'Paseo de Prueba 5', municipio: 'Álvaro Obregón' }),
  cara('MX_CM_VV_COL_067', { direccion: 'Callejón Supuesto 1' }),
  cara('MX_CM_VV_COL_6790', { direccion: 'Otra Calle 2' }),
  cara('MX_EM_VV_COL_A04', { direccion: 'Calle de Baja 679' }),
];
const OP_COL = { unidad: 'Vía Verde', medio: 'Columna' };
const indiceCol = B.indexarSitios(COLUMNAS, 'Vía Verde');
const claves = (r) => r.sitios.map((c) => c.vendor_face_id);

test('normBusqueda: sin acentos, en mayúsculas y con un solo espacio', () => {
  assert.equal(B.normBusqueda('  álvaro   Obregón '), 'ALVARO OBREGON');
  assert.equal(B.normBusqueda(null), '');
});

test('Vía Verde: EDO MEX no entra al índice', () => {
  assert.equal(indiceCol.length, COLUMNAS.length - 1);
  assert.ok(!indiceCol.some((e) => e.clave.startsWith('MX_EM_')));
});

test('«679»: la exacta primero, luego las que empiezan con 679, luego el resto', () => {
  const r = B.buscarSitios(indiceCol, '679', OP_COL);
  assert.deepEqual(claves(r), ['MX_CM_VV_COL_679', 'MX_CM_VV_COL_6790', 'MX_CM_VV_COL_689', 'MX_CM_VV_COL_1679']);
  assert.equal(r.total, 4);
  assert.equal(r.exacta.vendor_face_id, 'MX_CM_VV_COL_679');
  assert.equal(r.suelta, null);
  assert.equal(r.aviso, null);
});

test('la clave completa, en minúsculas y con espacios, también es exacta', () => {
  const r = B.buscarSitios(indiceCol, ' mx_cm_vv_col_651 ', OP_COL);
  assert.equal(r.exacta.vendor_face_id, 'MX_CM_VV_COL_651');
  assert.equal(claves(r)[0], 'MX_CM_VV_COL_651');
});

test('por municipio sin acentos y por varias palabras', () => {
  assert.deepEqual(claves(B.buscarSitios(indiceCol, 'alvaro obregon', OP_COL)), ['MX_CM_VV_COL_651']);
  assert.deepEqual(claves(B.buscarSitios(indiceCol, 'calle tlalpan', OP_COL)), ['MX_CM_VV_COL_689']);
  assert.deepEqual(claves(B.buscarSitios(indiceCol, 'coyoacan', OP_COL)), ['MX_CM_VV_COL_679']);
});

test('por site_id: igual es exacta, el inicio va antes que el resto', () => {
  const r = B.buscarSitios(indiceCol, 'vvc-0679', OP_COL);
  assert.deepEqual(claves(r), ['MX_CM_VV_COL_679']);
  assert.equal(r.exacta, null, 'Enter solo agrega por clave');
  const p = B.buscarSitios(indiceCol, 'vvc', OP_COL);
  assert.deepEqual(claves(p), ['MX_CM_VV_COL_679']);
});

test('«6»: los tramos que empiezan con 6 antes que el resto, en orden natural', () => {
  const r = B.buscarSitios(indiceCol, '6', OP_COL);
  // claveDeSitio entiende «6» como la columna 006, que no existe: no hay exacta.
  assert.equal(r.exacta, null);
  assert.deepEqual(claves(r).slice(0, 4), ['MX_CM_VV_COL_651', 'MX_CM_VV_COL_679', 'MX_CM_VV_COL_689', 'MX_CM_VV_COL_6790']);
  assert.ok(claves(r).includes('MX_CM_VV_COL_067'));
  assert.ok(claves(r).includes('MX_CM_VV_COL_1679'));
  // La 006 no está: se ofrece agregarla igual, como en «Pegar lista».
  assert.equal(r.suelta, 'MX_CM_VV_COL_006');
});

test('tope: regresa a lo más `limite`, pero cuenta todas', () => {
  const muchas = Array.from({ length: 120 }, (_, i) => cara(`MX_CM_VV_COL_${String(i + 100).padStart(3, '0')}`));
  const ix = B.indexarSitios(muchas, 'Vía Verde');
  const r = B.buscarSitios(ix, 'col', { ...OP_COL, limite: 50 });
  assert.equal(r.sitios.length, 50);
  assert.equal(r.total, 120);
  assert.equal(r.sitios[0].vendor_face_id, 'MX_CM_VV_COL_100');
  assert.equal(r.sitios[49].vendor_face_id, 'MX_CM_VV_COL_149');
});

test('vacío: nada, ni pista de clave', () => {
  assert.deepEqual(B.buscarSitios(indiceCol, '   ', OP_COL), { sitios: [], total: 0, exacta: null, suelta: null, aviso: null });
});

test('clave válida que no está en el inventario: se ofrece agregarla', () => {
  const r = B.buscarSitios(indiceCol, '999', OP_COL);
  assert.equal(r.total, 0);
  assert.equal(r.suelta, 'MX_CM_VV_COL_999');
});

test('EDO MEX y el otro medio: aviso, sin ofrecer agregar', () => {
  const em = B.buscarSitios(indiceCol, 'A04', OP_COL);
  assert.equal(em.suelta, null);
  assert.match(em.aviso, /EDO MEX/);
  const por = B.buscarSitios(indiceCol, 'POR_0008', OP_COL);
  assert.equal(por.suelta, null);
  assert.match(por.aviso, /es de Pórtico, no de Columna/);
  const col = B.buscarSitios(B.indexarSitios([cara('MX_CM_VV_POR_0008')], 'Vía Verde'), 'COL_679', { unidad: 'Vía Verde', medio: 'Pórtico' });
  assert.match(col.aviso, /es de Columna, no de Pórtico/);
});

test('Pórtico: un número suelto es un pórtico, sin aviso de Columna', () => {
  const ix = B.indexarSitios([cara('MX_CM_VV_POR_0018'), cara('MX_CM_VV_POR_0012'), cara('MX_CM_VV_POR_0008')], 'Vía Verde');
  const OP_POR = { unidad: 'Vía Verde', medio: 'Pórtico' };
  const r = B.buscarSitios(ix, '8', OP_POR);
  assert.equal(r.aviso, null);
  assert.equal(r.exacta.vendor_face_id, 'MX_CM_VV_POR_0008');
  assert.equal(claves(r)[0], 'MX_CM_VV_POR_0008');
  assert.ok(claves(r).includes('MX_CM_VV_POR_0018'));
  // Un pórtico que no está: se ofrece con su botón, sin aviso.
  const nuevo = B.buscarSitios(ix, '99', OP_POR);
  assert.equal(nuevo.aviso, null);
  assert.equal(nuevo.suelta, 'MX_CM_VV_POR_0099');
});

test('Biobox: una clave a medias no se vuelve otra al rellenar con ceros', () => {
  const OP_BB = { unidad: 'Biobox', medio: 'Máquina' };
  // Con la MED_0011 en el inventario: «MX_CM_BB_MED_011» va camino a la 0114.
  const con = B.indexarSitios([cara('MX_CM_BB_MED_0011'), cara('MX_CM_BB_MED_0114')], 'Biobox');
  const a = B.buscarSitios(con, 'MX_CM_BB_MED_011', OP_BB);
  assert.equal(a.exacta, null);
  assert.equal(a.suelta, null);
  assert.deepEqual(claves(a), ['MX_CM_BB_MED_0114']);
  // Sin la MED_0011: no se ofrece como clave fuera del inventario.
  const sin = B.indexarSitios([cara('MX_CM_BB_MED_0114'), cara('MX_CM_BB_MED_0115')], 'Biobox');
  const b = B.buscarSitios(sin, 'MX_CM_BB_MED_011', OP_BB);
  assert.equal(b.exacta, null);
  assert.equal(b.suelta, null);
  assert.deepEqual(claves(b), ['MX_CM_BB_MED_0114', 'MX_CM_BB_MED_0115']);
  // Sin otra clave que empiece igual, el relleno sí vale: «MED_11» es la 0011.
  assert.equal(B.buscarSitios(con, 'MX_CM_BB_MED_11', OP_BB).exacta.vendor_face_id, 'MX_CM_BB_MED_0011');
});

test('sitioDeBaja: solo EDO MEX de Vía Verde', () => {
  assert.equal(B.sitioDeBaja('MX_EM_VV_COL_A04', 'Vía Verde'), true);
  assert.equal(B.sitioDeBaja('MX_CM_VV_COL_679', 'Vía Verde'), false);
  assert.equal(B.sitioDeBaja('MX_EM_BB_MED_0001', 'Biobox'), false);
  assert.equal(B.sitioDeBaja('MX_EM_EV_MGV_0001', 'Ecovallas'), false);
});

test('Pórtico: «POR8» encuentra MX_CM_VV_POR_0008', () => {
  const ix = B.indexarSitios([cara('MX_CM_VV_POR_0012'), cara('MX_CM_VV_POR_0008')], 'Vía Verde');
  const r = B.buscarSitios(ix, 'por8', { unidad: 'Vía Verde', medio: 'Pórtico' });
  assert.equal(r.exacta.vendor_face_id, 'MX_CM_VV_POR_0008');
  assert.deepEqual(claves(r), ['MX_CM_VV_POR_0008']);
});

test('Biobox: una calle no se ofrece como clave; una clave con forma sí', () => {
  const ix = B.indexarSitios(
    [cara('MX_CM_BB_MED_0114', { direccion: 'Av. Reforma Inventada 1' }), cara('MX_CM_BB_MED_0020')],
    'Biobox'
  );
  const calle = B.buscarSitios(ix, 'reforma', { unidad: 'Biobox', medio: 'Máquina' });
  assert.deepEqual(claves(calle), ['MX_CM_BB_MED_0114']);
  assert.equal(calle.suelta, null);
  const nueva = B.buscarSitios(ix, 'MX_CM_BB_MED_0999', { unidad: 'Biobox', medio: 'Máquina' });
  assert.equal(nueva.total, 0);
  assert.equal(nueva.suelta, 'MX_CM_BB_MED_0999');
  // «0114» empieza un tramo de la clave.
  assert.deepEqual(claves(B.buscarSitios(ix, '0114', { unidad: 'Biobox', medio: 'Máquina' })), ['MX_CM_BB_MED_0114']);
});

test('revisarClave: los mismos avisos que «Pegar lista»', () => {
  assert.deepEqual(B.revisarClave('679', 'Vía Verde', 'Columna'), { tipo: 'ok', clave: 'MX_CM_VV_COL_679' });
  assert.equal(B.revisarClave('???', 'Vía Verde', 'Columna').aviso, '«???» no se entiende como clave');
  assert.equal(B.revisarClave('A04', 'Vía Verde', 'Columna').aviso, 'A04: es de EDO MEX (de baja)');
  assert.equal(B.revisarClave('POR_0008', 'Vía Verde', 'Columna').aviso, 'POR_0008: es de Pórtico, no de Columna');
});
