import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/inventarioUnidades.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { gruposVisibles, grupoDe, caraEnGrupos, unidadesDe, veTodoElInventario } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const claves = (gs) => gs.map((g) => g.clave);
const TODAS = ['eco-imp', 'eco-dig', 'biobox', 'biobox-pe', 'vv'];

test('Manager, comercial y viewer ven todas las unidades', () => {
  assert.deepEqual(claves(gruposVisibles([{ rol: 'manager', unidad_negocio: null }])), TODAS);
  assert.deepEqual(claves(gruposVisibles([{ rol: 'comercial', unidad_negocio: 'Vía Verde' }])), TODAS);
  assert.deepEqual(claves(gruposVisibles([{ rol: 'viewer', unidad_negocio: 'Biobox' }])), TODAS);
  assert.ok(veTodoElInventario([{ rol: 'viewer', unidad_negocio: null }]));
});

test('El coordinador con unidad ve solo la suya; Biobox no incluye Perú', () => {
  assert.deepEqual(claves(gruposVisibles([{ rol: 'coordinador', unidad_negocio: 'Biobox' }])), ['biobox']);
  assert.deepEqual(
    claves(gruposVisibles([{ rol: 'coordinador', unidad_negocio: 'Ecovallas' }])),
    ['eco-imp', 'eco-dig']
  );
  // Sin acentos ni mayúsculas exactas también cuadra.
  assert.deepEqual(claves(gruposVisibles([{ rol: 'coordinador', unidad_negocio: 'via verde' }])), ['vv']);
  // Un viewer extra no le quita el candado al coordinador.
  assert.deepEqual(
    claves(
      gruposVisibles([
        { rol: 'coordinador', unidad_negocio: 'Biobox' },
        { rol: 'viewer', unidad_negocio: 'Biobox' },
      ])
    ),
    ['biobox']
  );
  assert.ok(!veTodoElInventario([{ rol: 'coordinador', unidad_negocio: 'Biobox' }]));
});

test('Coordinador sin unidad o también manager: ve todo', () => {
  assert.deepEqual(claves(gruposVisibles([{ rol: 'coordinador', unidad_negocio: null }])), TODAS);
  assert.deepEqual(
    claves(
      gruposVisibles([
        { rol: 'coordinador', unidad_negocio: 'Biobox' },
        { rol: 'coordinador', unidad_negocio: '  ' },
      ])
    ),
    TODAS
  );
  assert.deepEqual(
    claves(
      gruposVisibles([
        { rol: 'coordinador', unidad_negocio: 'Biobox' },
        { rol: 'manager', unidad_negocio: null },
      ])
    ),
    TODAS
  );
});

test('Coordinador de una unidad sin inventario: lista vacía', () => {
  assert.deepEqual(gruposVisibles([{ rol: 'coordinador', unidad_negocio: 'Verde Vertical' }]), []);
});

test('Cada cara cae en su tarjeta; Ecovallas se parte por medio', () => {
  assert.equal(grupoDe({ unidad_negocio: 'Ecovallas', tipo_medio: 'Impreso' }).clave, 'eco-imp');
  assert.equal(grupoDe({ unidad_negocio: 'Ecovallas', tipo_medio: 'Digital' }).clave, 'eco-dig');
  assert.equal(grupoDe({ unidad_negocio: 'Ecovallas', tipo_medio: null }).clave, 'eco-imp');
  assert.equal(grupoDe({ unidad_negocio: 'Biobox', tipo_medio: 'Impreso' }).clave, 'biobox');
  assert.equal(grupoDe({ unidad_negocio: 'Biobox Perú', tipo_medio: 'Digital' }).clave, 'biobox-pe');
  const nueva = grupoDe({ unidad_negocio: 'Unidad Nueva', tipo_medio: null });
  assert.equal(nueva.titulo, 'Unidad Nueva');

  const soloBiobox = gruposVisibles([{ rol: 'coordinador', unidad_negocio: 'Biobox' }]);
  assert.ok(caraEnGrupos({ unidad_negocio: 'Biobox', tipo_medio: 'Digital' }, soloBiobox));
  assert.ok(!caraEnGrupos({ unidad_negocio: 'Biobox Perú', tipo_medio: 'Digital' }, soloBiobox));
  assert.deepEqual(
    unidadesDe(gruposVisibles([{ rol: 'coordinador', unidad_negocio: 'Ecovallas' }])),
    ['Ecovallas']
  );
});
