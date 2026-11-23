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
const {
  unaFotoPorCara,
  filasDelArchivo,
  pideCaraPorFoto,
  ajustarCarasDeFotos,
  faltaCaraDeFoto,
  indicesDeFotos,
} = await cargar('../src/lib/fotoPorCara.ts');

test('Se elige la cara de cada foto cuando no coinciden fotos y caras (23-nov-2026)', () => {
  // Caso EV00038–EV00043: 6 caras y 4 fotos.
  assert.equal(pideCaraPorFoto(6, 4), true);
  assert.equal(pideCaraPorFoto(2, 3), true);
  // Iguales: reparto automático, uno por cara.
  assert.equal(pideCaraPorFoto(6, 6), false);
  // Una cara o sin fotos: nada que elegir.
  assert.equal(pideCaraPorFoto(1, 3), false);
  assert.equal(pideCaraPorFoto(6, 0), false);
});

test('La elección se alinea con las fotos y las caras marcadas', () => {
  const caras = ['A', 'B', 'C'];
  // Falta la elección de la 2ª foto y la 1ª trae una cara ya desmarcada (X).
  assert.deepEqual(ajustarCarasDeFotos([['C', 'X', 'A']], 2, caras), [['A', 'C'], []]);
  // Sobran entradas (se quitó una foto): se recortan.
  assert.deepEqual(ajustarCarasDeFotos([['A'], ['B'], ['C']], 1, caras), [['A']]);
  assert.deepEqual(ajustarCarasDeFotos(undefined, 2, caras), [[], []]);
});

test('Cada foto con cara y cada cara con foto', () => {
  const caras = ['A', 'B', 'C'];
  assert.match(faltaCaraDeFoto([['A'], []], caras), /foto 2/);
  assert.match(faltaCaraDeFoto([['A'], ['B']], caras, (c) => 'cara ' + c), /cara C no tiene foto/);
  assert.match(faltaCaraDeFoto([['A'], ['A']], caras), /B, C no tienen foto/);
  assert.equal(faltaCaraDeFoto([['A', 'B'], ['C']], caras), null);
  // Índices de fila en el orden de las caras de la partida.
  assert.deepEqual(indicesDeFotos([['C', 'A'], ['B']], caras), [[2, 0], [1]]);
});

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
