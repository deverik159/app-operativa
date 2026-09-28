import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [new URL('../src/lib/helpers.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { departamentosDelUsuario } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const r = (rol, departamento) => ({ rol, departamento });

test('MKT va primero aunque otra fila venga antes', () => {
  assert.deepEqual(
    departamentosDelUsuario([r('reparacion', 'Digital'), r('reportante', 'MKT')]),
    ['MKT', 'Digital']
  );
  assert.deepEqual(
    departamentosDelUsuario([r('viewer', 'Operaciones'), r('reportante', 'MKT')]),
    ['MKT', 'Operaciones']
  );
});

test('la escritura se normaliza a la de AREAS_USUARIOS', () => {
  assert.deepEqual(departamentosDelUsuario([r('reportante', ' mkt ')]), ['MKT']);
  assert.deepEqual(departamentosDelUsuario([r('validador', 'monitoreo')]), ['Monitoreo']);
});

test('la pertenencia gana a un área técnica', () => {
  assert.deepEqual(
    departamentosDelUsuario([r('coordinador', 'Digital'), r('validador', 'SRD')]),
    ['SRD', 'Digital']
  );
});

test('sin pertenencia se conserva el orden de las filas y no se repite', () => {
  assert.deepEqual(
    departamentosDelUsuario([r('reparacion', 'TI'), r('reparacion', 'Digital'), r('reparacion', 'TI')]),
    ['TI', 'Digital']
  );
  assert.deepEqual(departamentosDelUsuario([r('manager', null), r('viewer', '  ')]), []);
});
