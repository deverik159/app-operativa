// lib/menciones.ts (4-nov-2026): el @ del chat. Quién queda mencionado lo
// valida la base (notificar_chat); aquí solo el texto: detectar el @ que se
// escribe, filtrar la lista, insertar lo elegido y resaltarlo en la burbuja.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/menciones.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const {
  tokenMencion,
  filtrarMencionables,
  aElegida,
  insertarMencion,
  mencionesVigentes,
  leerMenciones,
  partesTexto,
  esParaMi,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const LISTA = [
  { tipo: 'persona', clave: 'juan.perez@x.com', nombre: 'Juan Pérez', detalle: 'Digital' },
  { tipo: 'persona', clave: 'ana.maria@x.com', nombre: 'Ana María López', detalle: 'validador' },
  { tipo: 'persona', clave: 'ana@x.com', nombre: 'Ana', detalle: 'Op. Bio Box' },
  { tipo: 'persona', clave: 'yo@x.com', nombre: 'Yo Mismo', detalle: 'Digital' },
  { tipo: 'area', clave: 'Digital', nombre: 'Digital', detalle: '4' },
  { tipo: 'area', clave: 'Op. Bio Box', nombre: 'Op. Bio Box', detalle: '14' },
];

test('El @ abre la lista solo al inicio o tras un espacio, y hasta el primer espacio', () => {
  assert.deepEqual(tokenMencion('@ju', 3), { inicio: 0, consulta: 'ju' });
  assert.deepEqual(tokenMencion('hola @', 6), { inicio: 5, consulta: '' });
  assert.deepEqual(tokenMencion('hola @dig y más', 9), { inicio: 5, consulta: 'dig' });
  assert.equal(tokenMencion('ana@x.com', 9), null, 'un correo no es mención');
  assert.equal(tokenMencion('@juan perez', 11), null);
  assert.equal(tokenMencion('sin arroba', 10), null);
});

test('Filtra sin acentos, sin uno mismo, primero lo que empieza igual y áreas antes', () => {
  const nombres = (q) => filtrarMencionables(LISTA, q, 'YO@x.com').map((m) => m.nombre);
  assert.deepEqual(nombres('perez'), ['Juan Pérez']);
  assert.deepEqual(nombres('dig'), ['Digital']);
  assert.ok(!nombres('').includes('Yo Mismo'));
  assert.deepEqual(nombres('ana'), ['Ana', 'Ana María López']);
  assert.deepEqual(nombres('maria'), ['Ana María López'], 'empata con cualquier palabra');
  assert.deepEqual(nombres('bio')[0], 'Op. Bio Box');
  assert.deepEqual(nombres('juan.perez@'), ['Juan Pérez'], 'también por correo');
});

test('Insertar reemplaza lo escrito tras el @ y deja el cursor después', () => {
  const texto = 'hola @ju, revisa';
  const r = insertarMencion(texto, tokenMencion(texto, 8), 8, 'Juan Pérez');
  assert.equal(r.texto, 'hola @Juan Pérez, revisa', 'sin espacio antes de la coma');
  assert.equal(r.cursor, 'hola @Juan Pérez'.length);
  const r2 = insertarMencion('@', tokenMencion('@', 1), 1, 'Digital');
  assert.deepEqual(r2, { texto: '@Digital ', cursor: 9 });
  // Cursor a la mitad de la palabra: se va el resto ("an").
  const r3 = insertarMencion('@juan ok', tokenMencion('@juan ok', 3), 3, 'Juan Pérez');
  assert.equal(r3.texto, '@Juan Pérez ok');
});

test('Solo viajan las menciones que siguen escritas, sin repetir', () => {
  const juan = aElegida(LISTA[0]);
  const dig = aElegida(LISTA[4]);
  assert.deepEqual(juan, { tipo: 'persona', email: 'juan.perez@x.com', nombre: 'Juan Pérez' });
  assert.deepEqual(dig, { tipo: 'area', area: 'Digital', nombre: 'Digital' });
  assert.deepEqual(mencionesVigentes('@Digital urge', [juan, dig, dig]), [dig]);
  assert.deepEqual(mencionesVigentes('ya no hay nadie', [juan]), []);
});

test('Lo que llega de la base se lee con cuidado', () => {
  assert.deepEqual(leerMenciones(null), []);
  assert.deepEqual(leerMenciones('x'), []);
  assert.deepEqual(
    leerMenciones([
      { tipo: 'persona', email: 'A@X.com', nombre: ' Ana ' },
      { tipo: 'area', area: 'TI', nombre: 'TI' },
      { tipo: 'persona', nombre: 'sin correo' },
      { tipo: 'otro', nombre: 'x' },
      null,
    ]),
    [
      { tipo: 'persona', email: 'a@x.com', nombre: 'Ana' },
      { tipo: 'area', area: 'TI', nombre: 'TI' },
    ]
  );
});

test('La burbuja resalta cada mención, la más larga primero', () => {
  const ana = { tipo: 'persona', email: 'ana@x.com', nombre: 'Ana' };
  const anaMaria = { tipo: 'persona', email: 'ana.maria@x.com', nombre: 'Ana María López' };
  const partes = partesTexto('@Ana María López y @Ana: ¿lo ven?', [ana, anaMaria]);
  assert.deepEqual(
    partes.map((p) => [p.texto, p.mencion?.email ?? null]),
    [
      ['@Ana María López', 'ana.maria@x.com'],
      [' y ', null],
      ['@Ana', 'ana@x.com'],
      [': ¿lo ven?', null],
    ]
  );
  assert.deepEqual(partesTexto('sin menciones', [ana]), [{ texto: 'sin menciones' }]);
  assert.deepEqual(partesTexto('@Ana', []), [{ texto: '@Ana' }]);
});

test('Una mención directa es para mí; la de área no se marca así', () => {
  assert.equal(esParaMi({ tipo: 'persona', email: 'yo@x.com', nombre: 'Yo' }, 'YO@x.com'), true);
  assert.equal(esParaMi({ tipo: 'area', area: 'Digital', nombre: 'Digital' }, 'yo@x.com'), false);
});
