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
const { extension, urlVigente, nombreFoto, carpetasAnalista, rutasZip, resumenEnvio, SIN_VERSION } =
  await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

let sec = 0;
const foto = (o) => ({
  id: ++sec,
  envio_id: 1,
  campana: 'SPIDERMAN',
  version: 'V1',
  vendor_face_id: 'MX_CM_EV_EVA_01_3325',
  site_id: 'MX_CM_EV_0001',
  tipo: 'foto',
  original_url: 'https://x/pauta/2026-16/MX_CM_EV_EVA_01_3325_cat2026-16_2026-07-21_1.jpg',
  n: 1,
  estado: 'pendiente',
  editada_url: null,
  ...o,
});

test('el nombre es el vendor_face_id y el número, con la extensión de la foto', () => {
  assert.equal(nombreFoto(foto({ n: 2 })), 'MX_CM_EV_EVA_01_3325_2.jpg');
  assert.equal(nombreFoto(foto({ original_url: 'https://x/a.PNG?t=1' })), 'MX_CM_EV_EVA_01_3325_1.png');
  assert.equal(extension('https://x/sin-extension', 'video'), 'mp4');
  assert.equal(extension('https://x/sin-extension', 'foto'), 'jpg');
});

test('la editada manda sobre la original, también en la extensión', () => {
  const f = foto({ estado: 'editada', editada_url: 'https://x/pauta-analista/e.png' });
  assert.equal(urlVigente(f), 'https://x/pauta-analista/e.png');
  assert.equal(nombreFoto(f), 'MX_CM_EV_EVA_01_3325_1.png');
  // "correcta" con una editada vieja no la usa
  assert.equal(urlVigente({ ...f, estado: 'correcta' }), f.original_url);
});

test('carpetas campaña → versión; sin versión al final; fotos por cara y número', () => {
  const g = carpetasAnalista([
    foto({ version: null, vendor_face_id: 'B', n: 1 }),
    foto({ version: 'V2', vendor_face_id: 'B', n: 2 }),
    foto({ version: 'V2', vendor_face_id: 'A', n: 1 }),
    foto({ version: 'V10', vendor_face_id: 'A', n: 1 }),
    foto({ version: 'V2', vendor_face_id: 'B', n: 1 }),
    foto({ campana: 'AMSTERDAM', version: 'V1' }),
  ]);
  assert.deepEqual(g.map((c) => c.campana), ['AMSTERDAM', 'SPIDERMAN']);
  assert.deepEqual(g[1].versiones.map((v) => v.version), ['V2', 'V10', SIN_VERSION]);
  assert.deepEqual(g[1].versiones[0].fotos.map((f) => f.vendor_face_id + f.n), ['A1', 'B1', 'B2']);
});

test('rutas del ZIP: carpetas limpias y sin nombres repetidos', () => {
  const g = carpetasAnalista([
    foto({ campana: '¡YA ABRIMOS! KFC', version: 'ARTE 1/EVA.jpg' }),
    foto({ campana: '¡YA ABRIMOS! KFC', version: 'ARTE 1/EVA.jpg' }),
    foto({ campana: '¡YA ABRIMOS! KFC', version: '' }),
  ]);
  const r = rutasZip(g).map((x) => x.ruta);
  assert.deepEqual(r, [
    'YA_ABRIMOS_KFC/ARTE_1_EVA_jpg/MX_CM_EV_EVA_01_3325_1.jpg',
    'YA_ABRIMOS_KFC/ARTE_1_EVA_jpg/MX_CM_EV_EVA_01_3325_1_2.jpg',
    'YA_ABRIMOS_KFC/sin-version/MX_CM_EV_EVA_01_3325_1.jpg',
  ]);
});

test('resumen del envío', () => {
  assert.deepEqual(
    resumenEnvio([{ estado: 'pendiente' }, { estado: 'correcta' }, { estado: 'editada' }, { estado: 'correcta' }]),
    { total: 4, pendientes: 1, correctas: 2, editadas: 1 }
  );
});
