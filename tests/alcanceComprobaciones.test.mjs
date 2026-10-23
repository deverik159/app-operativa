// Quién abre Comprobaciones y en qué unidades (fase 2, 23-oct-2026).
// Espejo de comp_mis_unidades() en SQL: rol y unidad de la MISMA fila.
// Nombres inventados (repo público); los casos copian la FORMA de las filas
// reales de usuario_roles.
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
const { unidadesComprobaciones, abreComprobaciones, veTomasPauta, soloVeTomasPauta, ROLES_COMPROBACIONES, ROLES_PAUTA } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const r = (rol, unidad_negocio = null, medio = null) => ({ rol, unidad_negocio, medio });
const u = (roles, modulo) => [...unidadesComprobaciones(roles, modulo)].sort();
const TODAS = ['Biobox', 'Ecovallas', 'Vía Verde'];

test('roles del módulo; el supervisor no entra a Pauta', () => {
  // El coordinador ya no entra (Erik, 23-oct-2026: solo Supervisor y Manager;
  // la analista, a «Mis campañas»).
  assert.deepEqual([...ROLES_COMPROBACIONES], ['supervisor', 'analista']);
  assert.equal(ROLES_PAUTA.includes('supervisor'), false);
});

test('analista de Vía Verde que además es reportante: solo Vía Verde', () => {
  // La forma de una analista real: fila analista de VV + fila reportante de VV.
  assert.deepEqual(u([r('analista', 'Vía Verde'), r('reportante', 'Vía Verde')]), ['Vía Verde']);
  // Una fila reportante de otra unidad no le abre esa unidad.
  assert.deepEqual(u([r('analista', 'Vía Verde'), r('reportante', 'Ecovallas')]), ['Vía Verde']);
});

test('analista de Biobox: solo Biobox; Biobox Perú no entra', () => {
  assert.deepEqual(u([r('analista', 'Biobox')]), ['Biobox']);
  assert.deepEqual(u([r('analista', 'Biobox Perú')]), []);
  assert.deepEqual(u([r('supervisor', 'Biobox Perú')]), []);
});

test('la unidad se compara EXACTA, como `ur.unidad_negocio = u.unidad` en SQL', () => {
  // Revisión del núcleo (23-oct-2026): antes la app recortaba y no
  // distinguía mayúsculas, y la SQL sí; la pestaña abría vacía y sin error.
  assert.deepEqual(u([r('analista', 'Vía Verde')]), ['Vía Verde']);
  assert.deepEqual(u([r('analista', ' vía verde ')]), []);
  assert.deepEqual(u([r('analista', 'BIOBOX')]), []);
  assert.deepEqual(u([r('analista', 'biobox')]), []);
  assert.deepEqual(u([r('analista', ' Biobox ')]), []);
  // Sin acento no es la misma: la RLS tampoco la aceptaría.
  assert.deepEqual(u([r('analista', 'Via Verde')]), []);
  assert.deepEqual(u([r('analista', 'Ecovallas Digital')]), []);
});

test('Ecovallas: el medio se lee sin recortar, como `ur.medio ilike \'digital%\'`', () => {
  assert.deepEqual(u([r('analista', 'Ecovallas', 'digital')]), ['Ecovallas']);
  assert.deepEqual(u([r('analista', 'Ecovallas', 'DIGITAL 2')]), ['Ecovallas']);
  // '' no es null en SQL y no empieza con «digital».
  assert.deepEqual(u([r('analista', 'Ecovallas', '')]), []);
  assert.deepEqual(u([r('analista', 'Ecovallas', ' Digital')]), []);
});

test('Ecovallas: medio Impreso no abre; sin medio o Digital sí', () => {
  assert.deepEqual(u([r('analista', 'Ecovallas', 'Impreso')]), []);
  assert.deepEqual(u([r('analista', 'Ecovallas', 'Digital')]), ['Ecovallas']);
  assert.deepEqual(u([r('analista', 'Ecovallas', null)]), ['Ecovallas']);
  assert.deepEqual(u([r('analista', 'Ecovallas', undefined)]), ['Ecovallas']);
  assert.deepEqual(u([r('coordinador', 'Ecovallas', 'impreso')]), []);
  // En otras unidades el medio no importa.
  assert.deepEqual(u([r('analista', 'Biobox', 'Impreso')]), ['Biobox']);
});

test('Ecovallas, FORMA REAL de hoy: medio NULL abre Ecovallas Digital a la analista; al coordinador no', () => {
  // Usuarios solo guarda el medio del validador: en producción (23-oct-2026)
  // TODAS las filas de coordinador y analista de Ecovallas tienen medio NULL,
  // también las del equipo de Pauta (Impreso). Con «sin medio = ambos» la
  // analista abre Ecovallas Digital y queda asignable (Erik lo dio por bueno
  // el 23-oct-2026). El coordinador ya no entra al módulo.
  assert.deepEqual(u([r('coordinador', 'Ecovallas', null)]), []);
  assert.deepEqual(u([r('analista', 'Ecovallas', null), r('reportante', 'Ecovallas', null)]), ['Ecovallas']);
  // Solo el medio explícito Impreso la cierra, y hoy la app no lo guarda en estos roles.
  assert.deepEqual(u([r('coordinador', 'Ecovallas', 'Impreso')]), []);
});

test('fila sin unidad = las 3 (sin Ecovallas si su medio es Impreso)', () => {
  assert.deepEqual(u([r('supervisor', null)]), TODAS);
  assert.deepEqual(u([r('supervisor', undefined)]), TODAS);
  // Solo NULL es «todas»: '' en SQL no es null ni igual a ninguna unidad.
  assert.deepEqual(u([r('supervisor', '')]), []);
  assert.deepEqual(u([r('analista', null, 'Impreso')]), ['Biobox', 'Vía Verde']);
  assert.deepEqual(u([r('coordinador', null)]), []);
});

test('el manager ve las 3, tenga la unidad que tenga', () => {
  assert.deepEqual(u([r('manager', 'Biobox')]), TODAS);
  assert.deepEqual(u([r('manager', 'Ecovallas', 'Impreso')]), TODAS);
});

test('el Supervisor con su fila de analista de Ecovallas: 3 filas de supervisor, una por unidad', () => {
  // La forma recomendada (crítica #10, 23-oct-2026): una fila de supervisor
  // por unidad. Una fila de supervisor SIN unidad activaría
  // tieneTodasLasUnidades en App.tsx y su teléfono bajaría el inventario de
  // todas las unidades (también las miles de caras de Impreso).
  // Conserva su fila de analista de Ecovallas para Pauta.
  const filas = [
    r('analista', 'Ecovallas'),
    r('supervisor', 'Ecovallas'),
    r('supervisor', 'Biobox'),
    r('supervisor', 'Vía Verde'),
  ];
  assert.deepEqual(u(filas), TODAS);
  // Lo que GESTIONA (solo filas supervisor) también son las 3.
  assert.deepEqual(u(filas, ['supervisor']), TODAS);
  // La fila sin unidad da lo mismo aquí, pero no es la forma a usar (ver arriba).
  assert.deepEqual(u([r('supervisor', null)], ['supervisor']), TODAS);
});

test('rol y unidad de la MISMA fila: supervisor de Biobox + analista de VV', () => {
  const filas = [r('supervisor', 'Biobox'), r('analista', 'Vía Verde')];
  assert.deepEqual(u(filas), ['Biobox', 'Vía Verde']);
  assert.deepEqual(u(filas, ['supervisor']), ['Biobox']);
});

test('roles que no son del módulo no abren nada', () => {
  assert.deepEqual(u([r('reportante', null), r('monitorista', 'Vía Verde'), r('validador', 'Biobox')]), []);
  assert.equal(abreComprobaciones([r('reparacion', 'Ecovallas'), r('fijador', null)]), false);
  assert.equal(abreComprobaciones([]), false);
});

test('abreComprobaciones', () => {
  assert.equal(abreComprobaciones([r('analista', 'Vía Verde')]), true);
  // El coordinador (de rutas o de Pauta y Monitoreo) ya no lo ve.
  assert.equal(abreComprobaciones([r('coordinador', 'Biobox')]), false);
  assert.equal(abreComprobaciones([r('coordinador', null)]), false);
  // La analista de Pauta (Impreso) entra por «Tomas de Pauta», aunque no
  // tenga unidades de Comprobaciones.
  assert.equal(abreComprobaciones([r('analista', 'Ecovallas', 'Impreso')]), true);
  assert.deepEqual(u([r('analista', 'Ecovallas', 'Impreso')]), []);
  assert.equal(abreComprobaciones([r('manager', null)]), true);
});

test('«Tomas de Pauta» en Comprobaciones (se mudó de Pauta, 23-oct-2026)', () => {
  // La ve la analista que la veía en Pauta (Ecovallas Impreso o sin medio).
  assert.equal(veTomasPauta([r('analista', 'Ecovallas', null)]), true);
  assert.equal(veTomasPauta([r('analista', 'Ecovallas', 'Impreso')]), true);
  assert.equal(veTomasPauta([r('analista', null)]), true);
  // Una analista de Vía Verde o Biobox no revisa tomas de Pauta.
  assert.equal(veTomasPauta([r('analista', 'Vía Verde'), r('reportante', 'Vía Verde')]), false);
  // El Supervisor de cualquier unidad las ve («las tomas de todos») y el manager.
  assert.equal(veTomasPauta([r('supervisor', 'Vía Verde')]), true);
  assert.equal(veTomasPauta([r('manager', null)]), true);
  // El coordinador y el monitorista, no.
  assert.equal(veTomasPauta([r('coordinador', 'Ecovallas', null)]), false);
  assert.equal(veTomasPauta([r('monitorista', 'Ecovallas', null)]), false);
});

test('«Tomas de Pauta»: el Supervisor sin fila de analista solo ve', () => {
  // Las RPC de Pauta piden tiene_rol('analista') o manager.
  assert.equal(soloVeTomasPauta([r('supervisor', 'Vía Verde')]), true);
  assert.equal(soloVeTomasPauta([r('analista', 'Ecovallas')]), false);
  assert.equal(soloVeTomasPauta([r('manager', null)]), false);
  // La forma de Victor hoy: supervisor de Vía Verde + analista de Ecovallas.
  const victor = [r('analista', 'Ecovallas', null), r('supervisor', 'Vía Verde')];
  assert.equal(abreComprobaciones(victor), true);
  assert.deepEqual(u(victor), ['Ecovallas', 'Vía Verde']);
  assert.deepEqual(u(victor, ['supervisor']), ['Vía Verde']);
  assert.equal(veTomasPauta(victor), true);
  assert.equal(soloVeTomasPauta(victor), false);
});
