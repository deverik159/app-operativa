import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/equipos.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { cambioVacio, faltaEnCambio, limpiarCambio, esCambioEquipo, historiaPorPantalla, coincideBusqueda } =
  await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const cambio = (tipo, fecha, sale, entra) => ({
  tipo,
  fecha,
  sale: { serie: sale, inventario: '', obs: '' },
  entra: { serie: entra, inventario: '', obs: '' },
});
const reg = (folio, cara, c) => ({
  record_id: folio.toLowerCase(),
  folio,
  unidad_negocio: 'Ecovallas',
  clave_sitio: 'MX_CM_EV_2994',
  clave_medio: cara,
  nombre_biobox: 'Insurgentes 1761',
  direccion: null,
  repaired_by_email: 'tecnico@prueba',
  estatus: 'cerrada',
  cambio: c,
});

test('las dos series son obligatorias y distintas', () => {
  const c = cambioVacio('NUC', '2026-10-15');
  assert.match(faltaEnCambio(c, '2026-10-15'), /sale/);
  c.sale.serie = 'abc1';
  assert.match(faltaEnCambio(c, '2026-10-15'), /entra/);
  c.entra.serie = ' ABC1 ';
  assert.match(faltaEnCambio(c, '2026-10-15'), /mismo No\. de serie/);
  c.entra.serie = 'XYZ9';
  assert.equal(faltaEnCambio(c, '2026-10-15'), null);
});

test('la fecha no puede ser futura', () => {
  const c = cambio('NUC', '2026-10-16', 'A', 'B');
  assert.match(faltaEnCambio(c, '2026-10-15'), /futura/);
});

test('limpiar: sin espacios y serie en mayúsculas', () => {
  const l = limpiarCambio({ tipo: ' NUC ', fecha: '2026-10-15', sale: { serie: ' ab-1 ', inventario: ' v12 ', obs: ' ok ' }, entra: { serie: 'c2', inventario: '', obs: '' } });
  assert.deepEqual(l.sale, { serie: 'AB-1', inventario: 'V12', obs: 'ok' });
  assert.equal(l.tipo, 'NUC');
});

test('reconoce un cambio guardado y rechaza basura', () => {
  assert.equal(esCambioEquipo(cambio('UPS', '2026-10-01', 'A', 'B')), true);
  assert.equal(esCambioEquipo(null), false);
  assert.equal(esCambioEquipo({ tipo: 'UPS' }), false);
});

test('historia por pantalla: cuánto duró cada equipo y cuál está hoy', () => {
  const h = historiaPorPantalla([
    reg('EVD00003', 'CARA_A', cambio('NUC', '2026-10-20', 'N2', 'N3')),
    reg('EVD00001', 'CARA_A', cambio('NUC', '2026-10-01', 'N1', 'N2')),
    reg('EVD00002', 'CARA_A', cambio('UPS', '2026-10-05', 'U1', 'U2')),
  ]);
  assert.equal(h.length, 1);
  const p = h[0];
  // Del más reciente al más viejo.
  assert.deepEqual(p.cambios.map((c) => c.folio), ['EVD00003', 'EVD00002', 'EVD00001']);
  // N2 entró el 1-oct y salió el 20-oct: 19 días.
  assert.equal(p.cambios[0].saleDesde, '2026-10-01');
  assert.equal(p.cambios[0].diasQueDuro, 19);
  // Del primero de cada tipo no se sabe desde cuándo estaba.
  assert.equal(p.cambios[2].diasQueDuro, null);
  assert.deepEqual(p.vigentes, [
    { tipo: 'NUC', serie: 'N3', inventario: '', desde: '2026-10-20' },
    { tipo: 'UPS', serie: 'U2', inventario: '', desde: '2026-10-05' },
  ]);
});

test('cada cara es su propia pantalla, la más reciente primero', () => {
  const h = historiaPorPantalla([
    reg('A1', 'CARA_A', cambio('NUC', '2026-10-01', 'N1', 'N2')),
    reg('B1', 'CARA_B', cambio('NUC', '2026-10-09', 'M1', 'M2')),
  ]);
  assert.deepEqual(h.map((p) => p.clave), ['CARA_B', 'CARA_A']);
});

test('buscar por serie (de cualquiera de los dos), pantalla o folio, sin acentos', () => {
  const r = reg('EVD00001', 'MX_CM_EV_MGP_03_2994', cambio('Módulo LED', '2026-10-01', 'SN-111', 'SN-222'));
  assert.equal(coincideBusqueda(r, 'sn-222'), true);
  assert.equal(coincideBusqueda(r, 'sn-111'), true);
  assert.equal(coincideBusqueda(r, 'mgp 03'), true);
  assert.equal(coincideBusqueda(r, 'modulo'), true);
  assert.equal(coincideBusqueda(r, 'evd00001'), true);
  assert.equal(coincideBusqueda(r, 'sn-333'), false);
  assert.equal(coincideBusqueda(r, ''), true);
});
