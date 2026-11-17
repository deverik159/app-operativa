import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/marcarFoto.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const m = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('Marcar foto: del toque en pantalla a pixeles de la foto, sin salirse (17-nov-2026)', () => {
  // Foto de 1600×1200 pintada en 400×300 a partir de (10, 20).
  const caja = { left: 10, top: 20, width: 400, height: 300 };
  assert.deepEqual(m.aPuntoFoto(210, 170, caja, 1600, 1200), { x: 800, y: 600 });
  // El dedo se sale de la foto: queda en la orilla.
  assert.deepEqual(m.aPuntoFoto(-50, 999, caja, 1600, 1200), { x: 0, y: 1200 });
  assert.equal(m.grosor(1600, 1200), 8);
  assert.equal(m.grosor(300, 200), 3);
});

test('Marcar foto: un toque sin arrastrar no deja marca', () => {
  const p = (x, y) => ({ x, y });
  const ovalo = (a, b) => ({ tipo: 'ovalo', color: '#f00', puntos: [a, b] });
  assert.equal(m.marcaValida(ovalo(p(10, 10), p(12, 11)), 16), false);
  assert.equal(m.marcaValida(ovalo(p(10, 10), p(200, 12)), 16), false, 'óvalo aplastado');
  assert.equal(m.marcaValida(ovalo(p(10, 10), p(200, 150)), 16), true);
  assert.equal(m.marcaValida({ tipo: 'flecha', color: '#f00', puntos: [p(0, 0), p(30, 0)] }, 16), true);
  assert.equal(m.marcaValida({ tipo: 'libre', color: '#f00', puntos: [p(0, 0)] }, 16), false);
  assert.deepEqual(m.ovaloDe(p(100, 50), p(20, 10)), { cx: 60, cy: 30, rx: 40, ry: 20 });
});

test('Marcar foto: la flecha apunta al final y el dibujo usa el contexto', () => {
  const [i, d] = m.puntaFlecha({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
  // Las dos alas quedan detrás de la punta y simétricas.
  assert.ok(i.x < 100 && d.x < 100);
  assert.ok(Math.abs(i.y + d.y) < 1e-9);

  const llamadas = [];
  const ctx = new Proxy(
    {},
    {
      get: (_, k) => (k in ctxProps ? ctxProps[k] : (...a) => llamadas.push([k, ...a])),
      set: (_, k, v) => ((ctxProps[k] = v), true),
    }
  );
  const ctxProps = {};
  m.dibujarMarca(ctx, { tipo: 'ovalo', color: '#ffd400', puntos: [{ x: 0, y: 0 }, { x: 100, y: 50 }] }, 8);
  assert.equal(ctxProps.strokeStyle, '#ffd400');
  assert.equal(ctxProps.lineWidth, 8);
  assert.deepEqual(llamadas.find((l) => l[0] === 'ellipse').slice(1, 5), [50, 25, 50, 25]);
  assert.ok(llamadas.some((l) => l[0] === 'stroke'));

  assert.equal(m.nombreMarcada('IMG_0001.HEIC'), 'IMG_0001_marcada.jpg');
  assert.equal(m.nombreMarcada('IMG_0001_marcada.jpg'), 'IMG_0001_marcada.jpg');
});
