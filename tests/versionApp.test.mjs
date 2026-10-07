import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Entorno mínimo de navegador: ventana, documento, reloj, temporizadores,
// service worker y fetch simulados.
const oyentes = { window: {}, document: {} };
const on = (donde) => (ev, fn) => ((oyentes[donde][ev] ||= []).push(fn));
const off = (donde) => (ev, fn) => (oyentes[donde][ev] = (oyentes[donde][ev] || []).filter((f) => f !== fn));
const disparar = (donde, ev) => (oyentes[donde][ev] || []).forEach((f) => f());
let ahora = 1_000_000;
let visible = 'visible';
let idRemoto = 'build-viejo';
let redCaida = false;
let consultas = 0;
let updatesSw = 0;
let tickIntervalo = null;
const timeouts = new Map();
let sigTimeout = 1;
globalThis.window = {
  addEventListener: on('window'), removeEventListener: off('window'),
  setInterval: (fn) => ((tickIntervalo = fn), 1), clearInterval: () => {},
  setTimeout: (fn) => { const id = sigTimeout++; timeouts.set(id, fn); return id; },
  clearTimeout: (id) => timeouts.delete(id),
  location: { href: 'https://app.test/', pathname: '/', search: '', hash: '' },
  history: { state: null, replaceState() {} },
};
globalThis.document = {
  addEventListener: on('document'), removeEventListener: off('document'),
  get visibilityState() { return visible; },
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { serviceWorker: { getRegistration: async () => ({ update: async () => { updatesSw++; } }) } },
});
Date.now = () => ahora;
globalThis.fetch = async () => {
  consultas++;
  if (redCaida) throw new TypeError('Load failed');
  return { ok: true, json: async () => ({ id: idRemoto }) };
};
const correrTimeouts = () => { const fns = [...timeouts.values()]; timeouts.clear(); fns.forEach((f) => f()); };

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/versionApp.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'neutral',
  define: { __APP_BUILD_ID__: '"build-viejo"', 'import.meta.env.PROD': 'true' },
});
const { vigilarNuevaVersion, revisarVersionAhora } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);
const esperar = () => new Promise((r) => setTimeout(r, 5));

test('revisa al arrancar, al enfocar, con ↻, al volver la red y por intervalo, sin repetir de más', async () => {
  let avisos = 0;
  const detener = vigilarNuevaVersion(() => avisos++);
  await esperar();
  assert.equal(consultas, 1, 'revisa al arrancar');

  disparar('window', 'focus');
  await esperar();
  assert.equal(consultas, 1, 'un foco a los pocos segundos no vuelve a preguntar');

  ahora += 31_000;
  disparar('window', 'focus');
  await esperar();
  assert.equal(consultas, 2, 'pasados 30 s, el foco sí pregunta');

  revisarVersionAhora();
  await esperar();
  assert.equal(consultas, 3, '↻ pregunta aunque sea enseguida');

  disparar('window', 'online');
  await esperar();
  assert.equal(consultas, 4, 'volvió la red: pregunta aunque sea enseguida');

  ahora += 31_000;
  tickIntervalo();
  await esperar();
  assert.equal(consultas, 5, 'el intervalo pregunta con la app a la vista');

  visible = 'hidden';
  ahora += 31_000;
  disparar('window', 'online');
  tickIntervalo();
  await esperar();
  assert.equal(consultas, 5, 'con la app oculta no pregunta');

  // Sin señal: la revisión falla, se programa un reintento, y 'online' pregunta.
  visible = 'visible';
  redCaida = true;
  disparar('document', 'visibilitychange');
  await esperar();
  assert.equal(consultas, 6);
  assert.equal(timeouts.size, 1, 'sin respuesta se programa un reintento');
  redCaida = false;
  ahora += 10_000;
  disparar('window', 'online');
  await esperar();
  assert.equal(consultas, 7, 'volvió la red a los 10 s: sí pregunta');

  redCaida = true;
  revisarVersionAhora();
  await esperar();
  redCaida = false;
  idRemoto = 'build-nuevo';
  correrTimeouts();
  await esperar();
  assert.equal(consultas, 9, 'el reintento programado pregunta solo');
  assert.equal(avisos, 1, 've la versión nueva');
  await esperar();
  const updatesAlEncontrar = updatesSw;
  assert.ok(updatesAlEncontrar >= 1, 'pide el service worker nuevo');

  ahora += 31_000;
  disparar('window', 'focus');
  await esperar();
  assert.equal(consultas, 9, 'ya avisó: no vuelve a preguntar');
  assert.equal(updatesSw, updatesAlEncontrar + 1, '…pero sigue pidiendo el SW nuevo');
  assert.equal(avisos, 1, 'no repite el aviso');

  detener();
  revisarVersionAhora();
  await esperar();
  assert.equal(consultas, 9, 'detenido, ↻ ya no hace nada');
});
