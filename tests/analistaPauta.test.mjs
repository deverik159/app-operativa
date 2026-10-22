import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/analistaPauta.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const {
  unaPorCara,
  bandejaDe,
  carpetasAnalista,
  numerar,
  extension,
  urlVigente,
  nombreFoto,
  rutasZip,
  resumenFotos,
  SIN_VERSION,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const fila = (o) => ({
  vendor_face_id: 'MX_CM_EV_EVA_01_3325',
  site_id: 'MX_CM_EV_3325',
  cara: '01',
  campana: 'SPIDERMAN',
  version: 'V1',
  estatus: 'REPITE',
  fecha_fijacion: null,
  ruta_clave: '1',
  secuencia: 1,
  avance: 'TOMADA',
  fecha_toma: '2026-10-22T15:00:00Z',
  toma_por: 'm@x',
  fecha_comprobacion: null,
  rechazo_motivo: null,
  ...o,
});

const foto = (o) => ({
  evidencia_id: 1,
  vendor_face_id: 'MX_CM_EV_EVA_01_3325',
  url: 'https://x/pauta/2026-16/a.jpg',
  tipo: 'foto',
  creado_en: '2026-10-22T15:00:00Z',
  n: 1,
  estado: 'pendiente',
  editada_url: null,
  ...o,
});

test('una fila por cara: manda la versión NUEVA y, entre iguales, la fijación más reciente', () => {
  const r = unaPorCara([
    fila({ version: 'vieja', estatus: 'REPITE' }),
    fila({ version: 'nueva', estatus: 'NUEVO' }),
    fila({ vendor_face_id: 'B', version: 'b1', fecha_fijacion: '2026-07-01' }),
    fila({ vendor_face_id: 'B', version: 'b2', fecha_fijacion: '2026-07-20' }),
  ]);
  assert.deepEqual(r.map((f) => f.version).sort(), ['b2', 'nueva']);
});

test('bandejas: por revisar, comprobadas, regresadas o ninguna', () => {
  assert.equal(bandejaDe(fila({})), 'por_revisar');
  assert.equal(bandejaDe(fila({ fecha_comprobacion: '2026-10-22T16:00:00Z' })), 'comprobadas');
  assert.equal(bandejaDe(fila({ fecha_toma: null, rechazo_motivo: 'movida' })), 'regresadas');
  assert.equal(bandejaDe(fila({ fecha_toma: null })), null);
});

test('carpetas campaña → versión de la bandeja, sin versión al final y caras por recorrido', () => {
  const g = carpetasAnalista(
    [
      fila({ vendor_face_id: 'B', version: null, secuencia: 2 }),
      fila({ vendor_face_id: 'C', version: 'V2', secuencia: 3 }),
      fila({ vendor_face_id: 'A', version: 'V2', secuencia: 1 }),
      fila({ vendor_face_id: 'D', version: 'V10' }),
      fila({ vendor_face_id: 'E', campana: 'AMSTERDAM' }),
      fila({ vendor_face_id: 'F', fecha_comprobacion: '2026-10-22T16:00:00Z' }),
    ],
    'por_revisar'
  );
  assert.deepEqual(g.map((c) => [c.campana, c.total]), [['AMSTERDAM', 1], ['SPIDERMAN', 4]]);
  assert.deepEqual(g[1].versiones.map((v) => v.version), ['V2', 'V10', SIN_VERSION]);
  assert.deepEqual(g[1].versiones[0].caras.map((f) => f.vendor_face_id), ['A', 'C']);
});

test('numera las fotos de cada cara en el orden en que se subieron', () => {
  const r = numerar([
    foto({ evidencia_id: 3, creado_en: '2026-10-22T15:02:00Z' }),
    foto({ evidencia_id: 1, creado_en: '2026-10-22T15:00:00Z' }),
    foto({ evidencia_id: 9, vendor_face_id: 'OTRA', creado_en: '2026-10-22T15:05:00Z' }),
  ]);
  assert.deepEqual(r.map((f) => f.vendor_face_id + '#' + f.n + '@' + f.evidencia_id), [
    'MX_CM_EV_EVA_01_3325#1@1',
    'MX_CM_EV_EVA_01_3325#2@3',
    'OTRA#1@9',
  ]);
});

test('nombre: vendor_face_id y número; la editada manda en la liga y la extensión', () => {
  assert.equal(nombreFoto(foto({ n: 2 })), 'MX_CM_EV_EVA_01_3325_2.jpg');
  const ed = foto({ estado: 'editada', editada_url: 'https://x/pauta-analista/e.png' });
  assert.equal(urlVigente(ed), 'https://x/pauta-analista/e.png');
  assert.equal(nombreFoto(ed), 'MX_CM_EV_EVA_01_3325_1.png');
  assert.equal(urlVigente({ ...ed, estado: 'correcta' }), ed.url);
  assert.equal(extension('https://x/sin-extension', 'video'), 'mp4');
});

test('rutas del ZIP: carpetas limpias y sin nombres repetidos', () => {
  const r = rutasZip('¡YA ABRIMOS! KFC', 'ARTE 1/EVA.jpg', [foto({}), foto({ evidencia_id: 2 })]).map((x) => x.ruta);
  assert.deepEqual(r, [
    'YA_ABRIMOS_KFC/ARTE_1_EVA_jpg/MX_CM_EV_EVA_01_3325_1.jpg',
    'YA_ABRIMOS_KFC/ARTE_1_EVA_jpg/MX_CM_EV_EVA_01_3325_1_2.jpg',
  ]);
  assert.equal(rutasZip('X', SIN_VERSION, [foto({})])[0].ruta, 'X/sin-version/MX_CM_EV_EVA_01_3325_1.jpg');
});

test('resumen de fotos', () => {
  assert.deepEqual(resumenFotos([{ estado: 'pendiente' }, { estado: 'correcta' }, { estado: 'editada' }]), {
    total: 3,
    pendientes: 1,
    correctas: 1,
    editadas: 1,
  });
});
