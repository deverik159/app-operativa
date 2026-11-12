// ============================================================
// tests/pushSalir.test.mjs
// Avisos push al salir y al volver a entrar (lib/push.ts, 12-nov-2026):
// «Salir» da de baja el teléfono (fila y navegador) sin trabar la salida, y
// al volver a entrar con la MISMA cuenta se reactivan solos si el permiso
// sigue dado. Un teléfono que usó otra cuenta se pasa a la que está dentro.
//
// Correr: node --test tests/*.test.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const SB = `
class Q {
  constructor(op, fila) { this.op = op; this.fila = fila; this.filtros = []; }
  eq(c, v) { this.filtros.push([c, v]); return this; }
  abortSignal(s) { this.senal = s; return this; }
  then(ok, mal) { return globalThis.__sb.ejecutar(this).then(ok, mal); }
}
export const sb = {
  from: () => ({
    upsert: (fila) => new Q('upsert', fila),
    delete: () => new Q('delete'),
    select: () => new Q('select'),
  }),
};`;

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/push.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  define: { 'import.meta.env.VITE_VAPID_PUBLIC_KEY': JSON.stringify('AQIDBA') },
  plugins: [
    {
      name: 'simulados',
      setup(b) {
        b.onResolve({ filter: /^\.\/(supabase|plataforma)$/ }, (a) => ({ path: a.path, namespace: 'sim' }));
        b.onLoad({ filter: /.*/, namespace: 'sim' }, (a) => ({
          contents: a.path === './supabase' ? SB : 'export const esIOS = () => false;',
          loader: 'js',
        }));
      },
    },
  ],
});
const P = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const nunca = () => new Promise(() => {});

/** Navegador y base simulados. */
function entorno({ suscrito = true, permiso = 'granted' } = {}) {
  const e = {
    filas: new Map(), // endpoint -> usuario
    llamadas: [],
    sus: null,
    n: 0,
    colgarBorrado: false,
    colgarBaja: false,
    fallarBaja: false,
    duenoAjeno: null, // endpoint que la RLS no deja tomar
  };
  const nuevaSus = () => {
    const endpoint = 'https://push.local/' + ++e.n;
    const s = {
      endpoint,
      options: { applicationServerKey: new Uint8Array([1, 2, 3, 4]).buffer },
      toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: async () => {
        e.llamadas.push('baja ' + endpoint);
        if (e.colgarBaja) return nunca();
        if (e.fallarBaja) throw new Error('falló');
        if (e.sus === s) e.sus = null;
        return true;
      },
    };
    return s;
  };
  if (suscrito) e.sus = nuevaSus();
  const reg = {
    pushManager: {
      getSubscription: async () => e.sus,
      subscribe: async () => {
        e.llamadas.push('suscribir');
        e.sus = nuevaSus();
        return e.sus;
      },
    },
  };
  globalThis.window = { PushManager: function () {}, matchMedia: () => ({ matches: false }), navigator: {} };
  globalThis.Notification = { permission: permiso, requestPermission: async () => permiso };
  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { getRegistration: async () => reg, register: async () => reg }, userAgent: 'prueba' },
    configurable: true,
  });
  const almacen = new Map();
  globalThis.localStorage = {
    getItem: (k) => (almacen.has(k) ? almacen.get(k) : null),
    setItem: (k, v) => almacen.set(k, String(v)),
    removeItem: (k) => almacen.delete(k),
  };
  e.almacen = almacen;
  globalThis.__sb = {
    ejecutar: async (q) => {
      if (q.op === 'delete') {
        const ep = q.filtros.find(([c]) => c === 'endpoint')?.[1];
        e.llamadas.push('borrar fila ' + ep);
        if (e.colgarBorrado)
          return new Promise((res) => q.senal?.addEventListener?.('abort', () => res({ data: null, error: { message: 'AbortError' } })));
        e.filas.delete(ep);
        return { data: null, error: null };
      }
      if (q.op === 'upsert') {
        e.llamadas.push('guardar ' + q.fila.endpoint);
        if (e.duenoAjeno === q.fila.endpoint)
          return { data: null, error: { message: 'new row violates row-level security policy (USING expression) for table "push_suscripciones"' } };
        e.filas.set(q.fila.endpoint, q.fila.usuario_email);
        return { data: null, error: null };
      }
      return { data: [], error: null };
    },
  };
  return e;
}

test('«Salir» con avisos activos: borra la fila, da de baja el navegador y anota la cuenta', async () => {
  const e = entorno();
  const ep = e.sus.endpoint;
  e.filas.set(ep, 'ana@x.com');
  await P.bajaAlSalir('Ana@X.com');
  assert.deepEqual(e.llamadas, ['borrar fila ' + ep, 'baja ' + ep]);
  assert.equal(e.sus, null);
  assert.equal(e.filas.size, 0);
  assert.equal(localStorage.getItem('gpo-push-reactivar'), 'ana@x.com');
});

test('«Salir» sin avisos activos no toca nada ni anota', async () => {
  const e = entorno({ suscrito: false });
  await P.bajaAlSalir('ana@x.com');
  assert.deepEqual(e.llamadas, []);
  assert.equal(localStorage.getItem('gpo-push-reactivar'), null);
});

test('«Salir» sin señal (base y navegador colgados) no traba la salida', async () => {
  const e = entorno();
  e.colgarBorrado = true;
  e.colgarBaja = true;
  const t0 = Date.now();
  await P.bajaAlSalir('ana@x.com');
  const ms = Date.now() - t0;
  assert.ok(ms < 5500, `tardó ${ms} ms`);
  assert.equal(localStorage.getItem('gpo-push-reactivar'), 'ana@x.com', 'igual se anota para reactivar');
});

test('al volver a entrar la MISMA cuenta con el permiso dado, se reactivan solos', async () => {
  const e = entorno({ suscrito: false });
  localStorage.setItem('gpo-push-reactivar', 'beto@x.com');
  assert.equal(await P.reactivarAlEntrar('Beto@x.com'), true);
  assert.ok(e.llamadas.includes('suscribir'));
  assert.equal([...e.filas.values()][0], 'beto@x.com');
  assert.equal(localStorage.getItem('gpo-push-reactivar'), null, 'la marca se usa una vez');
});

test('otra cuenta en el mismo teléfono no reactiva los avisos de la anterior', async () => {
  const e = entorno({ suscrito: false });
  localStorage.setItem('gpo-push-reactivar', 'carla@x.com');
  assert.equal(await P.reactivarAlEntrar('dani@x.com'), false);
  assert.deepEqual(e.llamadas, []);
  assert.equal(localStorage.getItem('gpo-push-reactivar'), 'carla@x.com', 'se guarda para cuando Carla vuelva');
});

test('sin el permiso dado no se reactiva (queda el aviso de activar)', async () => {
  const e = entorno({ suscrito: false, permiso: 'default' });
  localStorage.setItem('gpo-push-reactivar', 'eva@x.com');
  assert.equal(await P.reactivarAlEntrar('eva@x.com'), false);
  assert.deepEqual(e.llamadas, []);
});

test('teléfono que usó otra cuenta: activar lo pasa a la que está dentro', async () => {
  const e = entorno();
  const ajeno = e.sus.endpoint;
  e.filas.set(ajeno, 'otra@x.com');
  e.duenoAjeno = ajeno;
  assert.equal(await P.activarPush('fer@x.com'), null);
  assert.deepEqual(e.llamadas.slice(0, 3), ['guardar ' + ajeno, 'baja ' + ajeno, 'suscribir']);
  assert.equal(e.filas.get(e.sus.endpoint), 'fer@x.com', 'la suscripción nueva es de quien está dentro');
});

test('desactivar nunca lanza: si el navegador falla, regresa el mensaje', async () => {
  const e = entorno();
  e.fallarBaja = true;
  const r = await P.desactivarPush();
  assert.match(r, /No se pudo dar de baja/);
});
