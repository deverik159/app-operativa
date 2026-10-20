import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/claveSitio.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { claveSitioCorta, nombreSitio, nombrePlaza, nombrePortico, porticosPorNombre } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const { outputFiles: ofHelpers } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/helpers.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { ladoFijoDePortico } = await import(
  'data:text/javascript;base64,' + Buffer.from(ofHelpers[0].text).toString('base64')
);

// Los site_id reales del inventario de QTM (consulta del 19-oct-2026).
test('Pórticos reales: sentido fijo al capturar una incidencia', () => {
  assert.equal(ladoFijoDePortico('Vía Verde', 'MX_CM_VV_POR_0008'), 'Sur a Norte');
  assert.equal(ladoFijoDePortico('Vía Verde', 'MX_CM_VV_POR_0015'), 'Norte a Sur');
  assert.equal(ladoFijoDePortico('Vía Verde', 'MX_CM_VV_POR_0078'), 'Norte a Sur');
  assert.equal(ladoFijoDePortico('Vía Verde', 'MX_CM_VV_POR_0092'), 'Sur a Norte');
  assert.equal(ladoFijoDePortico('Vía Verde', 'MX_CM_VV_COL_669'), null);
  assert.equal(ladoFijoDePortico('Ecovallas', 'MX_CM_VV_POR_0008'), null);
});

test('Pórticos reales: nombre con que se conocen y búsqueda sin acentos', () => {
  assert.equal(nombrePortico('MX_CM_VV_POR_0008'), 'San Antonio Norte');
  assert.equal(nombrePortico('MX_CM_VV_POR_0092'), 'San Ángel Sur');
  assert.equal(nombrePortico('MX_CM_VV_COL_669'), null);
  assert.equal(nombrePortico(null), null);
  assert.deepEqual(porticosPorNombre('san angel'), ['0078', '0092']);
  assert.deepEqual(porticosPorNombre('ANTONIO  sur'), ['0015']);
  assert.deepEqual(porticosPorNombre(''), []);
});

test('Ecovallas impreso: sin país ni plaza', () => {
  assert.equal(nombreSitio('MX_CM_EV_3244', null), 'EV_3244');
  assert.equal(nombreSitio('MX_EM_EV_0009', ''), 'EV_0009');
});

test('Ecovallas pantalla y Biobox: el nombre', () => {
  assert.equal(nombreSitio('MX_CM_EV_2994', 'Avenida Insurgentes Sur 1761'), 'Avenida Insurgentes Sur 1761');
  assert.equal(nombreSitio('MX_CM_BB_MED_0056', 'ESCOBEDO 500'), 'ESCOBEDO 500');
});

test('Biobox sin nombre: la clave sin país, plaza ni BB', () => {
  assert.equal(nombreSitio('MX_CM_BB_MED_0094', null), 'MED_0094');
  assert.equal(claveSitioCorta('MX_EM_BB_IID_0008'), 'IID_0008');
});

test('Biobox Perú: mismo patrón que México', () => {
  assert.equal(claveSitioCorta('PE_LM_BB_IID_0057'), 'IID_0057');
  assert.equal(nombreSitio('PE_LM_BB_IID_0001', 'BI-001 · PASAJE SAN RAMON'), 'BI-001 · PASAJE SAN RAMON');
  assert.equal(nombreSitio('PE_LM_BB_IID_0001', null), 'IID_0001');
});

test('Vía Verde: COL y POR como en la Bitácora, aunque traiga nombre', () => {
  assert.equal(nombreSitio('MX_CM_VV_COL_551', 'algo'), 'COL 551');
  assert.equal(claveSitioCorta('MX_CM_VV_COL_551'), 'COL 551');
  assert.equal(claveSitioCorta('MX_CM_VV_POR_0078'), 'POR 0078 · San Ángel Norte');
  assert.equal(claveSitioCorta('MX_CM_VV_POR_0099'), 'POR 0099');
});

test('Lo que no sigue el patrón se deja igual', () => {
  assert.equal(claveSitioCorta('SIN-MAQUINA'), 'SIN-MAQUINA');
  assert.equal(claveSitioCorta('XX_CM_EV_1'), 'XX_CM_EV_1');
  assert.equal(claveSitioCorta(null), '');
});

test('Plaza: México es el Estado de México', () => {
  assert.equal(nombrePlaza('México'), 'Estado de México');
  assert.equal(nombrePlaza('Ciudad de México'), 'Ciudad de México');
  assert.equal(nombrePlaza(''), null);
});
