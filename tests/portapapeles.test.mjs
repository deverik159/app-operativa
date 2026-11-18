import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/portapapeles.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { nombreRecorte, archivoDeRecorte, imagenDePegado, puedePegarConBoton } =
  await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const hora = new Date(2026, 10, 18, 9, 5, 7);

test('Recorte pegado: nombre con la hora y la extensión del tipo', () => {
  assert.equal(nombreRecorte('image/png', hora), 'recorte-090507.png');
  assert.equal(nombreRecorte('image/jpeg', hora), 'recorte-090507.jpg');
  assert.equal(nombreRecorte('image/svg+xml', hora), 'recorte-090507.svgxml');
  assert.equal(nombreRecorte('', hora), 'recorte-090507.png');
  const f = archivoDeRecorte(new Blob(['x'], { type: 'image/png' }), hora);
  assert.equal(f.name, 'recorte-090507.png');
  assert.equal(f.type, 'image/png');
});

test('Pegar: solo toma imágenes; el texto sigue su camino', () => {
  const blob = new Blob(['x'], { type: 'image/png' });
  const item = (kind, type, b) => ({ kind, type, getAsFile: () => b });
  assert.equal(imagenDePegado({ items: [item('string', 'text/plain', null)] }), null);
  assert.equal(imagenDePegado({ items: [] }), null);
  assert.equal(imagenDePegado(null), null);
  const f = imagenDePegado({ items: [item('string', 'text/html', null), item('file', 'image/png', blob)] });
  assert.ok(f && f.type === 'image/png' && f.name.startsWith('recorte-'));
  // Un archivo que no es imagen (p. ej. un PDF copiado) no entra.
  assert.equal(imagenDePegado({ items: [item('file', 'application/pdf', new Blob(['x'], { type: 'application/pdf' }))] }), null);
});

test('Botón «Pegar imagen»: solo en computadora y si el navegador lee el portapapeles', () => {
  const conRead = { clipboard: { read: () => Promise.resolve([]) } };
  assert.equal(puedePegarConBoton(conRead, true), true);
  assert.equal(puedePegarConBoton(conRead, false), false); // celular
  assert.equal(puedePegarConBoton({ clipboard: {} }, true), false); // Firefox viejo
  assert.equal(puedePegarConBoton(undefined, true), false);
});
