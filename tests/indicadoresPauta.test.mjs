import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/indicadoresPauta.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { carasUnicas, contar, avancePauta, agruparComprobaciones, diaDeToma, etiquetaDia, paraArchivo, nombreRuta, SIN_CAMPANA } =
  await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const f = (o) => ({
  site_id: 'S1',
  vendor_face_id: 'V' + Math.random(),
  cara: '01',
  ruta_clave: '1',
  campana: 'A',
  fecha_toma: null,
  toma_por: null,
  fecha_comprobacion: null,
  rechazo_motivo: null,
  ...o,
});

test('cuenta pendientes, tomadas, comprobadas y regresadas', () => {
  const c = contar([
    f({}),
    f({ fecha_toma: '2026-10-14T15:00:00Z', toma_por: 'a@x' }),
    f({ fecha_toma: '2026-10-14T15:00:00Z', toma_por: 'a@x', fecha_comprobacion: '2026-10-15T15:00:00Z' }),
    f({ site_id: 'S2', rechazo_motivo: 'foto borrosa' }),
  ]);
  assert.deepEqual(c, { caras: 4, sitios: 2, pendientes: 2, tomadas: 1, comprobadas: 1, regresadas: 1, pct: 25 });
  assert.equal(contar([]).pct, 0);
});

test('una cara con varias versiones cuenta una vez', () => {
  const a = f({ vendor_face_id: 'X', campana: 'A', fecha_comprobacion: '2026-10-16T16:00:00Z', fecha_toma: '2026-10-15T16:00:00Z' });
  const b = { ...a, campana: 'A' };
  assert.equal(carasUnicas([a, b]).length, 1);
  assert.equal(contar([a, b]).caras, 1);
  assert.equal(avancePauta([a, b]).porCampana[0].caras, 1);
  const g = agruparComprobaciones([a, b]);
  assert.equal(g[0].total, 1);
});

test('el porcentaje no redondea a 100 si falta una cara', () => {
  const filas = Array.from({ length: 200 }, (_, i) =>
    f({ vendor_face_id: 'V' + i, fecha_comprobacion: i ? '2026-10-16T16:00:00Z' : null })
  );
  assert.equal(contar(filas).pct, 99);
  assert.equal(contar(filas.slice(1)).pct, 100);
});

test('avance por ruta en orden: numéricas y luego foráneas y sin ruta', () => {
  const a = avancePauta([
    f({ ruta_clave: '10' }),
    f({ ruta_clave: 'PLAZA' }),
    f({ ruta_clave: null }),
    f({ ruta_clave: '2' }),
  ]);
  assert.deepEqual(a.porRuta.map((r) => r.ruta), ['2', '10', 'PLAZA', null]);
  assert.equal(nombreRuta('2'), 'Ruta 2');
  assert.equal(nombreRuta(null), 'Sin ruta');
});

test('avance por campaña y por monitorista', () => {
  const a = avancePauta([
    f({ campana: 'A', fecha_toma: '2026-10-14T15:00:00Z', toma_por: 'Ana@x' }),
    f({ campana: 'A', fecha_toma: '2026-10-14T15:00:00Z', toma_por: 'ana@x', fecha_comprobacion: '2026-10-15T15:00:00Z' }),
    f({ campana: ' ', fecha_toma: '2026-10-14T15:00:00Z', toma_por: 'beto@x' }),
  ]);
  assert.deepEqual(a.porCampana.map((c) => [c.campana, c.caras]), [['A', 2], [SIN_CAMPANA, 1]]);
  assert.deepEqual(a.porMonitorista[0], { correo: 'ana@x', tomas: 2, comprobadas: 1, sitios: 1 });
});

test('el día del agrupado es el de la TOMA en hora de CDMX', () => {
  // 01:30 UTC del 15 = 19:30 del 14 en CDMX.
  assert.equal(diaDeToma(f({ fecha_toma: '2026-10-15T01:30:00Z', fecha_comprobacion: '2026-10-16T18:00:00Z' })), '2026-10-14');
  // Sin toma registrada, el día de la comprobación.
  assert.equal(diaDeToma(f({ fecha_comprobacion: '2026-10-16T18:00:00Z' })), '2026-10-16');
});

test('agrupa solo comprobadas por campaña y día', () => {
  const g = agruparComprobaciones([
    f({ campana: 'A', site_id: 'S2', fecha_toma: '2026-10-15T16:00:00Z', fecha_comprobacion: '2026-10-16T16:00:00Z' }),
    f({ campana: 'A', site_id: 'S1', fecha_toma: '2026-10-15T17:00:00Z', fecha_comprobacion: '2026-10-16T16:00:00Z' }),
    f({ campana: 'A', fecha_toma: '2026-10-14T16:00:00Z', fecha_comprobacion: '2026-10-16T16:00:00Z' }),
    f({ campana: 'B', fecha_toma: '2026-10-14T16:00:00Z', fecha_comprobacion: '2026-10-16T16:00:00Z' }),
    f({ campana: 'B', fecha_toma: '2026-10-14T16:00:00Z' }), // tomada sin validar: no entra
  ]);
  assert.deepEqual(g.map((c) => [c.campana, c.total]), [['A', 3], ['B', 1]]);
  assert.deepEqual(g[0].dias.map((d) => [d.dia, d.filas.length]), [['2026-10-14', 1], ['2026-10-15', 2]]);
  assert.deepEqual(g[0].dias[1].filas.map((x) => x.site_id), ['S1', 'S2']);
});

test('etiquetas y nombres de archivo', () => {
  assert.equal(etiquetaDia('2026-10-19'), 'lun 19 oct 2026');
  assert.equal(etiquetaDia(''), 'Sin fecha de toma');
  assert.equal(paraArchivo('Casa de los Famosos 4 · Ñandú!'), 'Casa_de_los_Famosos_4_Nandu');
});
