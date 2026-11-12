import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// envios.ts trae el cliente de Supabase: solo se prueban las piezas puras.
const cargar = async (archivo) => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(archivo, import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
  });
  return import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
};
const { unaFotoPorCara, filasDelArchivo } = await cargar('../src/lib/fotoPorCara.ts');

test('Cada archivo va a su fila; sin `para`, a todas', () => {
  const g = { filas: [{ record_id: 'a' }, { record_id: 'b' }, { record_id: 'c' }] };
  assert.deepEqual(filasDelArchivo(g, {}), ['a', 'b', 'c']);
  assert.deepEqual(filasDelArchivo(g, { para: ['b'] }), ['b']);
  // Su fila se omitió por duplicada: la foto ya no va a ningún lado.
  assert.deepEqual(filasDelArchivo({ filas: [{ record_id: 'a' }] }, { para: ['b'] }), []);
});

test('Una foto por cara solo si hay tantos archivos como caras (12-nov-2026)', () => {
  // Caso EV00001–EV00006: 6 caras, 6 fotos → una a cada una.
  assert.equal(unaFotoPorCara(6, 6), true);
  assert.equal(unaFotoPorCara(2, 2), true);
  // Con distinto número, cada foto va a todas (como antes).
  assert.equal(unaFotoPorCara(6, 1), false);
  assert.equal(unaFotoPorCara(6, 7), false);
  assert.equal(unaFotoPorCara(3, 2), false);
  // Una sola cara: no hay nada que repartir.
  assert.equal(unaFotoPorCara(1, 1), false);
  assert.equal(unaFotoPorCara(0, 0), false);
});
