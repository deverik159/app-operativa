import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const cargar = async (archivo) => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(`../src/lib/${archivo}`, import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
  });
  return import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
};
const { foliosApp } = await cargar('folioApp.ts');
const { lineasHistorial } = await cargar('historialInc.ts');

test('Folio de la app: el que creó la incidencia y los ligados (17-nov-2026)', () => {
  const obs = 'App Biobox · reporte BBOTR-00422 · Puntos · «Puntos o aplicación»\nNota del validador';
  const hist = [
    { evento: 'validada', detalle: null },
    { evento: 'reporte_app_ligado', detalle: 'BBAPP-00431' },
    { evento: 'reporte_app_ligado', detalle: ' BBOTR-00437 ' },
    { evento: 'reporte_app_ligado', detalle: 'BBAPP-00431' },
  ];
  assert.deepEqual(foliosApp(obs, hist), ['BBOTR-00422', 'BBAPP-00431', 'BBOTR-00437']);
  // Sin reporte de la app: nada (una observación cualquiera no cuenta).
  assert.deepEqual(foliosApp('Se reporta App Biobox · reporte X a medio texto', undefined), []);
  assert.deepEqual(foliosApp(null, []), []);
});

test('Historial: el reporte ligado enseña su folio en el título', () => {
  const [l] = lineasHistorial([
    {
      record_id: 'r1', evento: 'reporte_app_ligado', estatus_antes: null, estatus_nuevo: null,
      por_email: 'ana@x.com', en: '2026-11-13T17:00:00Z', detalle: 'BBOTR-00437', reconstruido: true,
    },
  ]);
  assert.equal(l.titulo, 'Reporte de la app BBOTR-00437 ligado');
  assert.equal(l.detalle, null);
  assert.equal(l.por, 'ana');
});
