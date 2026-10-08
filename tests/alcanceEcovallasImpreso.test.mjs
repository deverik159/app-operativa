import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/helpers.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { abreModuloEcovallasImpreso, ROLES_FIJACION_EXTERNA, ROLES_PAUTA } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const r = (rol, unidad_negocio = null, medio = null) => ({ rol, unidad_negocio, medio });
const fij = (roles) => abreModuloEcovallasImpreso(roles, ROLES_FIJACION_EXTERNA);
const pauta = (roles) => abreModuloEcovallasImpreso(roles, ROLES_PAUTA);

test('el manager abre los dos módulos', () => {
  assert.equal(fij([r('manager', 'Biobox')]), true);
  assert.equal(pauta([r('manager', 'Biobox')]), true);
});

test('técnico de Ecovallas abre Fijación; de otra unidad no', () => {
  assert.equal(fij([r('reparacion', 'Ecovallas')]), true);
  assert.equal(fij([r('reparacion', ' ecovallas ')]), true);
  assert.equal(fij([r('reparacion', 'Vía Verde')]), false);
  assert.equal(fij([r('reparacion', 'Biobox')]), false);
});

test('fila sin unidad cuenta para todas', () => {
  assert.equal(fij([r('reparacion', null)]), true);
  assert.equal(fij([r('reparacion', '')]), true);
  assert.equal(pauta([r('monitorista', null)]), true);
});

test('rol y unidad se leen de la MISMA fila', () => {
  // El caso real del 8-oct-2026: monitorista de Vía Verde que además es
  // técnico y validador en Ecovallas. Abre Fijación (su técnico es de
  // Ecovallas) pero no Pauta (su monitorista es de Vía Verde).
  const filas = [r('monitorista', 'Vía Verde'), r('reparacion', 'Ecovallas'), r('validador', 'Ecovallas')];
  assert.equal(fij(filas), true);
  assert.equal(pauta(filas), false);
  // Técnico de Biobox con reportante en Ecovallas: no abre Fijación.
  assert.equal(fij([r('reparacion', 'Biobox'), r('reportante', 'Ecovallas')]), false);
});

test('el medio Digital excluye; Impreso o sin medio pasan', () => {
  assert.equal(fij([r('reparacion', 'Ecovallas', 'Digital')]), false);
  assert.equal(fij([r('reparacion', 'Ecovallas', 'Impreso')]), true);
  assert.equal(fij([r('reparacion', 'Ecovallas', ' impreso ')]), true);
  assert.equal(fij([r('reparacion', 'Ecovallas', undefined)]), true);
  assert.equal(pauta([r('coordinador', 'Ecovallas', 'Digital'), r('coordinador', 'Ecovallas', 'Impreso')]), true);
});

test('roles que no son del módulo no abren nada', () => {
  assert.equal(fij([r('validador', 'Ecovallas', 'Impreso'), r('reportante', 'Ecovallas')]), false);
  assert.equal(pauta([r('reparacion', 'Ecovallas')]), false);
  assert.equal(fij([r('monitorista', 'Ecovallas')]), false);
  assert.equal(pauta([r('fijador', 'Ecovallas')]), true);
  assert.equal(fij([]), false);
});
