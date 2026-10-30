// Técnico que apoyó la reparación (Op. Bio Box de Biobox, 29-oct-2026):
// cuándo se pregunta, cómo se limpia la lista y cómo busca la ventana.
// Sin red ni base: supabase, idbDatos y datosLocales van falsos.
// Repo PÚBLICO: datos inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/(supabase|idbDatos|datosLocales)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      loader: 'js',
      contents: `
        export const sb = {};
        export const datosGet = async () => undefined;
        export const datosPut = async () => {};
        export const redOLocal = async () => ({ datos: null, origen: 'local' });
      `,
    }));
  },
};

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/apoyoReparacion.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  plugins: [stubs],
});
const { pideApoyo, limpiarTecnicos, filtrarTecnicos } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

test('solo pregunta en Op. Bio Box de la unidad Biobox', () => {
  assert.equal(pideApoyo({ unidad_negocio: 'Biobox', area_responsable: 'Op. Bio Box' }), true);
  assert.equal(pideApoyo({ unidad_negocio: ' biobox ', area_responsable: 'Op. Bio Box' }), true);
  assert.equal(pideApoyo({ unidad_negocio: 'Biobox Perú', area_responsable: 'Op. Bio Box' }), false);
  assert.equal(pideApoyo({ unidad_negocio: 'Biobox', area_responsable: 'TI' }), false);
  assert.equal(pideApoyo({ unidad_negocio: 'Ecovallas', area_responsable: 'Op. Bio Box' }), false);
  // El área que repara manda sobre la del catálogo (como el blindaje).
  assert.equal(pideApoyo({ unidad_negocio: 'Biobox', area_responsable: 'TI', assigned_area: 'Op. Bio Box' }), true);
  assert.equal(pideApoyo({ unidad_negocio: 'Biobox', area_responsable: 'Op. Bio Box', assigned_area: 'TI' }), false);
});

test('la lista quita a quien repara, repetidos y basura, y ordena por nombre', () => {
  const lista = limpiarTecnicos(
    [
      { email: 'Zeta.Uno@ejemplo.com', nombre: 'Zeta Uno' },
      { email: 'yo@ejemplo.com', nombre: 'Yo Mismo' },
      { email: 'zeta.uno@ejemplo.com', nombre: 'Repetido' },
      { email: '', nombre: 'Sin correo' },
      null,
      'texto',
      { email: 'ana.alfa@ejemplo.com', nombre: '' },
      { email: 'beto@ejemplo.com', nombre: 'Álvaro Beto' },
    ],
    ' YO@ejemplo.com '
  );
  // «Álvaro» antes que «ana»: el orden ignora acentos y mayúsculas.
  assert.deepEqual(lista, [
    { email: 'beto@ejemplo.com', nombre: 'Álvaro Beto' },
    { email: 'ana.alfa@ejemplo.com', nombre: 'ana.alfa' },
    { email: 'zeta.uno@ejemplo.com', nombre: 'Zeta Uno' },
  ]);
  assert.deepEqual(limpiarTecnicos(null, 'yo@ejemplo.com'), []);
  assert.deepEqual(limpiarTecnicos({ email: 'x@y.z' }, ''), []);
});

test('busca sin acentos ni mayúsculas, con espacios como comodín y en orden', () => {
  const lista = [
    { email: 'jonas.perez@ejemplo.com', nombre: 'Jonás Pérez' },
    { email: 'luis.gomez@ejemplo.com', nombre: 'Luis Gómez' },
  ];
  assert.deepEqual(filtrarTecnicos(lista, '').length, 2);
  assert.deepEqual(filtrarTecnicos(lista, '  ').length, 2);
  assert.deepEqual(filtrarTecnicos(lista, 'JONAS').map((t) => t.nombre), ['Jonás Pérez']);
  assert.deepEqual(filtrarTecnicos(lista, 'jo pe').map((t) => t.nombre), ['Jonás Pérez']);
  assert.deepEqual(filtrarTecnicos(lista, 'gomez').map((t) => t.nombre), ['Luis Gómez']);
  assert.deepEqual(filtrarTecnicos(lista, 'gomez jonas'), []);
});
