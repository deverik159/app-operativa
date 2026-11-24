import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/zona.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { zonaDeClave, zonaDe, zonaCubre, unidadConZona } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

// Mismo criterio que public.zona_de_clave (migración zonas_metro_foranea).
test('Metro: CM y EM; Foránea: cualquier otra plaza', () => {
  assert.equal(zonaDeClave('Ecovallas', 'MX_CM_EV_3244'), 'metro');
  assert.equal(zonaDeClave('Ecovallas', 'MX_EM_EV_0101'), 'metro');
  assert.equal(zonaDeClave('Ecovallas', 'MX_GD_EV_0012'), 'foranea');
  assert.equal(zonaDeClave('Ecovallas', 'MX_QR_EV_0003'), 'foranea');
  assert.equal(zonaDeClave('Biobox', 'MX_MT_BB_IID_0007'), 'foranea');
  assert.equal(zonaDeClave('biobox', 'mx_pb_bb_iid_0002'), 'foranea');
  assert.equal(zonaDeClave('Biobox', 'MX_CM_BB_IID_0110'), 'metro');
});

test('Solo Ecovallas y Biobox: lo demás es Metro', () => {
  assert.equal(zonaDeClave('Vía Verde', 'MX_GD_VV_COL_1'), 'metro');
  assert.equal(zonaDeClave('Biobox Perú', 'PE_LM_BB_IID_0057'), 'metro');
  assert.equal(zonaDeClave(null, 'MX_GD_EV_0012'), 'metro');
  assert.equal(unidadConZona('Ecovallas'), true);
  assert.equal(unidadConZona(' biobox '), true);
  assert.equal(unidadConZona('Vía Verde'), false);
  assert.equal(unidadConZona('Biobox Perú'), false);
});

test('Sin clave manda la plaza; sin las dos, Metro', () => {
  assert.equal(zonaDeClave('Biobox', null, null), 'metro');
  assert.equal(zonaDeClave('Biobox', '', 'Ciudad de México'), 'metro');
  assert.equal(zonaDeClave('Biobox', null, 'México'), 'metro');
  assert.equal(zonaDeClave('Ecovallas', null, 'Jalisco'), 'foranea');
  // Con clave, la clave manda aunque la plaza diga otra cosa.
  assert.equal(zonaDeClave('Ecovallas', 'MX_CM_EV_1', 'Jalisco'), 'metro');
});

test('zonaDe usa la columna si viene; zonaCubre: rol sin zona cubre las dos', () => {
  assert.equal(zonaDe({ zona: 'foranea', unidad_negocio: 'Ecovallas', clave_medio: 'MX_CM_EV_1' }), 'foranea');
  assert.equal(zonaDe({ zona: null, unidad_negocio: 'Ecovallas', clave_medio: 'MX_GD_EV_1' }), 'foranea');
  const gdl = { zona: 'foranea' };
  assert.equal(zonaCubre(null, gdl), true);
  assert.equal(zonaCubre('', gdl), true);
  assert.equal(zonaCubre('foranea', gdl), true);
  assert.equal(zonaCubre('metro', gdl), false);
});
