import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// validaEn.ts importa zona.ts (24-nov-2026): se empaqueta en memoria.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/validaEn.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { validaEnIncidencia } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

// Como Ana (12-nov-2026): validadora Digital de Ecovallas y Vía Verde, y
// reportante de Operaciones (eso le deja VER lo de Biobox, no validarlo).
const ana = [
  { rol: 'reportante', unidad_negocio: 'Vía Verde', medio: null },
  { rol: 'reportante', unidad_negocio: 'Ecovallas', medio: null },
  { rol: 'validador', unidad_negocio: 'Ecovallas', medio: 'Digital' },
  { rol: 'validador', unidad_negocio: 'Vía Verde', medio: 'Digital' },
];

test('Validadora: solo su unidad y su medio', () => {
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'Biobox', medio: 'Impreso' }), false);
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'Biobox', medio: 'Digital' }), false);
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'Ecovallas', medio: 'Digital' }), true);
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'ecovallas', medio: 'digital' }), true);
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'Ecovallas', medio: 'Impreso' }), false);
  // Con medio en su rol, una incidencia sin medio no cuenta (como la base).
  assert.equal(validaEnIncidencia(ana, { unidad_negocio: 'Vía Verde', medio: null }), false);
});

test('Sin medio en el rol = los dos medios; sin unidad no cuenta', () => {
  const dulce = [{ rol: 'validador', unidad_negocio: 'Biobox', medio: null }];
  assert.equal(validaEnIncidencia(dulce, { unidad_negocio: 'Biobox', medio: 'Impreso' }), true);
  assert.equal(validaEnIncidencia(dulce, { unidad_negocio: 'Biobox', medio: null }), true);
  assert.equal(validaEnIncidencia(dulce, { unidad_negocio: 'Ecovallas', medio: 'Impreso' }), false);
  const sinUnidad = [{ rol: 'validador', unidad_negocio: null, medio: null }];
  assert.equal(validaEnIncidencia(sinUnidad, { unidad_negocio: 'Biobox', medio: 'Impreso' }), false);
});

test('El manager valida todo; otros roles no', () => {
  assert.equal(validaEnIncidencia([{ rol: 'manager', unidad_negocio: null }], { unidad_negocio: 'Biobox' }), true);
  assert.equal(validaEnIncidencia([{ rol: 'coordinador', unidad_negocio: 'Biobox' }], { unidad_negocio: 'Biobox' }), false);
});

// Zona (Erik, 24-nov-2026): validador propio para las foráneas.
test('Validador con zona: solo las de su zona; sin zona, las dos', () => {
  const metro = [{ rol: 'validador', unidad_negocio: 'Ecovallas', medio: null, zona: 'metro' }];
  const foranea = [{ rol: 'validador', unidad_negocio: 'Ecovallas', medio: null, zona: 'foranea' }];
  const ambas = [{ rol: 'validador', unidad_negocio: 'Ecovallas', medio: null, zona: null }];
  const cdmx = { unidad_negocio: 'Ecovallas', medio: 'Impreso', zona: 'metro' };
  const gdl = { unidad_negocio: 'Ecovallas', medio: 'Impreso', zona: 'foranea' };
  assert.equal(validaEnIncidencia(metro, cdmx), true);
  assert.equal(validaEnIncidencia(metro, gdl), false);
  assert.equal(validaEnIncidencia(foranea, cdmx), false);
  assert.equal(validaEnIncidencia(foranea, gdl), true);
  assert.equal(validaEnIncidencia(ambas, cdmx), true);
  assert.equal(validaEnIncidencia(ambas, gdl), true);
  // Copia guardada sin la columna: la zona sale de la clave.
  assert.equal(
    validaEnIncidencia(foranea, { unidad_negocio: 'Ecovallas', medio: 'Impreso', clave_medio: 'MX_GD_EV_0012_A' }),
    true
  );
  assert.equal(
    validaEnIncidencia(foranea, { unidad_negocio: 'Ecovallas', medio: 'Impreso', clave_medio: 'MX_CM_EV_3244_A' }),
    false
  );
});
