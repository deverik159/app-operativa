// ============================================================
// tests/atrasVentana.test.mjs
// El botón Atrás con una ventana de captura abierta (lib/atrasVentana.ts,
// 12-nov-2026): Atrás llama al cierre seguro de la ventana en vez de cambiar
// de pestaña, y cerrar con sus botones consume la entrada que se apiló.
//
// Correr: node --test tests/*.test.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/atrasVentana.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  // React no se usa en estas pruebas (solo el hook): se sustituye.
  plugins: [
    {
      name: 'sin-react',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'sim' }));
        b.onLoad({ filter: /.*/, namespace: 'sim' }, () => ({
          contents: 'export const useEffect = () => {}; export const useId = () => "x"; export const useRef = (v) => ({ current: v });',
          loader: 'js',
        }));
      },
    },
  ],
});
const A = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

/**
 * Historial de navegador simulado: pushState es síncrono y back() avisa
 * con popstate después, como en el navegador. onPop hace lo de App.tsx:
 * si atrasEnVentana no lo atiende, cambia de pestaña (lo anota).
 */
function historial(ruta = '/pendientes') {
  const h = { entradas: [{ state: null, url: '/incidencias' }, { state: null, url: ruta }], i: 1, cambios: [] };
  globalThis.window = {
    location: {
      get pathname() {
        return h.entradas[h.i].url;
      },
      search: '',
    },
    history: {
      get state() {
        return h.entradas[h.i].state;
      },
      pushState(state, _t, url) {
        h.entradas = h.entradas.slice(0, h.i + 1);
        h.entradas.push({ state, url: url ?? h.entradas[h.i].url });
        h.i++;
      },
      back() {
        if (h.i === 0) return;
        h.i--;
        queueMicrotask(() => h.onPop());
      },
    },
  };
  h.onPop = () => {
    if (A.atrasEnVentana(ruta)) return;
    h.cambios.push(h.entradas[h.i].url);
  };
  /** El usuario presiona Atrás. */
  h.atras = async () => {
    h.i--;
    h.onPop();
    await new Promise((r) => setTimeout(r, 0));
  };
  return h;
}
const calma = () => new Promise((r) => setTimeout(r, 0));

test('al abrirse apila una entrada del mismo documento con su marca', () => {
  const h = historial();
  const soltar = A.registrarVentana('v1', () => {});
  assert.equal(h.entradas.length, 3);
  assert.deepEqual(h.entradas[2], { state: { atrasVentana: 'v1' }, url: '/pendientes' });
  soltar();
});

test('Atrás con la ventana abierta llama a su cierre seguro y NO cambia de pestaña', async () => {
  const h = historial();
  let cierres = 0;
  const soltar = A.registrarVentana('v2', () => cierres++);
  await h.atras();
  assert.equal(cierres, 1);
  assert.deepEqual(h.cambios, [], 'no cambió de pestaña');
  // Mientras decide (o si dijo que no), la marca vuelve a estar arriba.
  assert.equal(window.history.state?.atrasVentana, 'v2');
  soltar();
  await calma();
});

test('si el cierre seguro sí cierra, la marca se consume sin un Atrás muerto', async () => {
  const h = historial();
  let soltar;
  soltar = A.registrarVentana('v3', () => soltar());
  await h.atras();
  await calma();
  assert.equal(h.i, 1, 'quedó en la entrada de la pestaña');
  assert.equal(window.history.state, null);
  assert.deepEqual(A._estado(), { pila: [], ignorar: 0, marcaPendiente: null });
  // El siguiente Atrás ya cambia de pestaña.
  await h.atras();
  assert.deepEqual(h.cambios, ['/incidencias']);
});

test('si el usuario dice que no (sigue abierta), el siguiente Atrás vuelve a preguntar', async () => {
  const h = historial();
  let preguntas = 0;
  const soltar = A.registrarVentana('v4', () => preguntas++);
  await h.atras();
  await h.atras();
  assert.equal(preguntas, 2);
  assert.deepEqual(h.cambios, []);
  soltar();
  await calma();
  assert.deepEqual(A._estado(), { pila: [], ignorar: 0, marcaPendiente: null });
});

test('cerrar con sus botones consume la marca y ese popstate no cambia de pestaña', async () => {
  const h = historial();
  const soltar = A.registrarVentana('v5', () => {});
  soltar();
  await calma();
  assert.equal(h.i, 1);
  assert.deepEqual(h.cambios, [], 'el back() propio se ignoró');
  assert.deepEqual(A._estado(), { pila: [], ignorar: 0, marcaPendiente: null });
});

test('sin ventanas abiertas Atrás sigue como antes', async () => {
  const h = historial();
  await h.atras();
  assert.deepEqual(h.cambios, ['/incidencias']);
});

test('con dos ventanas encimadas Atrás atiende la de arriba', async () => {
  const h = historial();
  const llamadas = [];
  const s1 = A.registrarVentana('abajo', () => llamadas.push('abajo'));
  const s2 = A.registrarVentana('arriba', () => llamadas.push('arriba'));
  await h.atras();
  assert.deepEqual(llamadas, ['arriba']);
  s2();
  await calma();
  s1();
  await calma();
  assert.deepEqual(A._estado(), { pila: [], ignorar: 0, marcaPendiente: null });
});

test('sin la marca arriba, Atrás cae en otra pestaña: se repone la pestaña y al cerrar la URL queda bien', async () => {
  // La entrada de abajo es de otra pestaña (/incidencias) y la marca no está.
  const h = historial('/pendientes');
  h.entradas = [{ state: null, url: '/incidencias' }, { state: null, url: '/pendientes' }];
  h.i = 1;
  const soltar = A.registrarVentana('v8', () => {});
  // Simula que la marca se consumió (doble montaje): se quita a mano.
  h.entradas.pop();
  h.i = 1;
  const soltarYa = () => soltar();
  // Ahora Atrás cae en /incidencias con la ventana abierta…
  await h.atras();
  assert.equal(window.location.pathname, '/pendientes', 'se repuso la pestaña a la vista');
  assert.equal(window.history.state?.atrasVentana, 'v8');
  // …y al cerrarla, su back() deja la URL de la pestaña a la vista.
  soltarYa();
  await calma();
  assert.equal(window.location.pathname, '/pendientes');
  assert.equal(window.history.state, null);
  assert.deepEqual(h.cambios, []);
});

test('se cierra una y se abre otra enseguida: la marca de la nueva queda arriba', async () => {
  const h = historial();
  const s1 = A.registrarVentana('primera', () => {});
  s1(); // su back() todavía no llega
  let cierres = 0;
  const s2 = A.registrarVentana('segunda', () => cierres++);
  await calma(); // llega el popstate del back(): se ignora y se apila la marca pendiente
  assert.equal(window.history.state?.atrasVentana, 'segunda');
  assert.equal(h.entradas.filter((e) => e.state?.atrasVentana).length, 1, 'sin marcas viejas');
  s2();
  await calma();
  assert.equal(window.history.state, null, 'cerrarla no deja un Atrás muerto');
  assert.deepEqual(A._estado(), { pila: [], ignorar: 0, marcaPendiente: null });
  assert.equal(cierres, 0);
});

test('montada dos veces seguidas (StrictMode) no apila dos marcas', async () => {
  const h = historial();
  const s1 = A.registrarVentana('v6', () => {});
  s1(); // limpieza de la primera montada: pide back(), que llega después
  const s2 = A.registrarVentana('v6', () => {});
  assert.equal(h.entradas.filter((e) => e.state?.atrasVentana === 'v6').length, 1);
  await calma(); // llega el popstate del back(): se ignora
  assert.deepEqual(h.cambios, []);
  // Ya sin marca arriba, Atrás todavía cierra la ventana (vuelve a apilarla).
  let cierres = 0;
  s2();
  await calma();
  const s3 = A.registrarVentana('v7', () => cierres++);
  await h.atras();
  assert.equal(cierres, 1);
  s3();
  await calma();
});
