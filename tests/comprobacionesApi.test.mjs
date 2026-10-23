// Contrato de src/lib/comprobacionesApi.ts (revisión 2 de la fase 2,
// 23-oct-2026), sin red y sin base: se empaqueta con un cliente FALSO en
// lugar de ./supabase.
//   · Un error que la base SÍ contestó (lock_timeout 55P03, statement_timeout
//     57014…) no es «sin señal», aunque su texto diga «timeout».
//   · leerTomas llena sitio_comprobado_dia solo en las campañas cuyo plan
//     lleva incluir_comprobados (vw_comp_tomas no lo trae).
// Repo PÚBLICO: datos inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Cliente falso: .rpc y .from sobre tablas en memoria. Cada prueba pone lo suyo.
globalThis.__compFalso = { rpc: () => ({ data: null, error: null, status: 200 }), tablas: {} };

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/supabase$/ }, () => ({ path: 'supabase', namespace: 'stub' }));
    b.onResolve({ filter: /^\.\/envios$/ }, () => ({ path: 'envios', namespace: 'stub' }));
    b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
      if (a.path === 'envios') return { contents: 'export const tope = () => undefined;', loader: 'js' };
      if (a.path === 'react') return { contents: 'export const useSyncExternalStore = () => true;', loader: 'js' };
      return {
        loader: 'js',
        contents: `
          class Q {
            constructor(t) { this.t = t; this.f = []; this.r = null; }
            select() { return this; }
            eq(c, v) { this.f.push((x) => x[c] === v); return this; }
            neq(c, v) { this.f.push((x) => x[c] !== v); return this; }
            in(c, vs) { this.f.push((x) => vs.includes(x[c])); return this; }
            gte(c, v) { this.f.push((x) => x[c] >= v); return this; }
            lte(c, v) { this.f.push((x) => x[c] <= v); return this; }
            order() { return this; }
            range(d, h) { this.r = [d, h]; return this; }
            abortSignal() { return this; }
            then(ok, mal) {
              const err = globalThis.__compFalso.errorDe?.[this.t];
              if (err) return Promise.resolve({ data: null, error: err, status: 500 }).then(ok, mal);
              let d = (globalThis.__compFalso.tablas[this.t] || []).filter((x) => this.f.every((g) => g(x)));
              if (this.r) d = d.slice(this.r[0], this.r[1] + 1);
              return Promise.resolve({ data: d, error: null, status: 200 }).then(ok, mal);
            }
          }
          export const sb = {
            from: (t) => new Q(t),
            rpc: (n, a) => ({ abortSignal: () => Promise.resolve(globalThis.__compFalso.rpc(n, a)) }),
          };`,
      };
    });
  },
};

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/comprobacionesApi.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  plugins: [stubs],
});
const A = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

test('clasificarErrorComp: lo que contestó la base no es «sin señal» aunque diga timeout', () => {
  const candado = A.clasificarErrorComp({ code: '55P03', message: 'canceling statement due to lock timeout' }, 500);
  assert.equal(candado.sinRed, false);
  assert.match(candado.error, /Otra persona está guardando/);
  const tarde = A.clasificarErrorComp({ code: '57014', message: 'canceling statement due to statement timeout' }, 500);
  assert.equal(tarde.sinRed, false);
  assert.match(tarde.error, /tardó demasiado/);
  // Un raise exception de las RPC va tal cual.
  const raise = A.clasificarErrorComp({ code: 'P0001', message: 'No elegiste sitios.' }, 400);
  assert.deepEqual(raise, { error: 'No elegiste sitios.', sinRed: false });
  // PostgREST también contesta.
  assert.equal(A.clasificarErrorComp({ code: 'PGRST202', message: 'Could not find the function' }, 404).sinRed, false);
  // Número fuera de rango: en español (contrato-7).
  assert.match(A.clasificarErrorComp({ code: '22003', message: 'value "99999999999" is out of range for type integer' }, 400).error, /fuera de rango/);
});

test('clasificarErrorComp: sin respuesta sí es «sin señal»', () => {
  assert.equal(A.clasificarErrorComp({ message: 'TypeError: Failed to fetch', code: '' }, 0).sinRed, true);
  assert.equal(A.clasificarErrorComp({ message: 'Gateway Timeout' }, 504).sinRed, true);
  // Status de gateway gana aunque traiga un código raro.
  assert.equal(A.clasificarErrorComp({ code: '57014', message: 'x' }, 504).sinRed, true);
  const abort = new Error('The operation was aborted.');
  abort.name = 'AbortError';
  assert.equal(A.clasificarErrorComp(abort).sinRed, true);
  assert.equal(A.esRespuestaDeBase({ code: '' }), false);
  assert.equal(A.esRespuestaDeBase({ code: '55P03' }), true);
});

test('una RPC que corta por candado enseña su texto, no «Sin señal… recarga»', async () => {
  globalThis.__compFalso.rpc = () => ({
    data: null,
    error: { code: '55P03', message: 'canceling statement due to lock timeout', details: null, hint: null },
    status: 500,
  });
  const r = await A.generarTomas([1, 2], null);
  assert.equal(r.ok, false);
  assert.equal(r.sinRed, false);
  assert.match(A.textoFallaEscrituraComp(r), /Otra persona está guardando/);
});

const toma = (id, campana_id, sitio_id, fecha, sitio_estado = 'comprobado') => ({
  id,
  campana_id,
  sitio_id,
  periodo_id: 7,
  unidad: 'Vía Verde',
  medio: 'Columna',
  fecha,
  estado: 'pendiente',
  sitio_estado,
});

test('leerTomas: el día de la marca solo en campañas con «también comprobados»', async () => {
  globalThis.__compFalso.errorDe = {};
  globalThis.__compFalso.tablas = {
    vw_comp_tomas: [
      toma(1, 10, 100, '2026-10-03'),
      toma(2, 10, 100, '2026-10-20'),
      toma(3, 11, 110, '2026-10-20'),
      toma(4, 11, 111, '2026-10-20', 'pendiente'),
    ],
    comp_campanas: [
      { id: 10, plan_tomas: { tipo: 'diario', incluir_comprobados: true } },
      { id: 11, plan_tomas: { tipo: 'diario' } },
    ],
    comp_sitios: [
      { id: 100, campana_id: 10, estado: 'comprobado', comprobado_dia: '2026-10-05' },
      { id: 110, campana_id: 11, estado: 'comprobado', comprobado_dia: '2026-10-05' },
      { id: 111, campana_id: 11, estado: 'pendiente', comprobado_dia: null },
    ],
  };
  const r = await A.leerTomas({ periodoId: 7, unidad: 'Vía Verde' });
  assert.equal(r.ok, true);
  const porId = new Map(r.data.map((t) => [t.id, t]));
  assert.equal(porId.get(1).sitio_comprobado_dia, '2026-10-05');
  assert.equal(porId.get(2).sitio_comprobado_dia, '2026-10-05');
  // Sin R11: se deja vacío (las tomas que el sitio tenía antes de marcarse
  // NO vuelven a campo).
  assert.equal(porId.get(3).sitio_comprobado_dia, undefined);
  assert.equal(porId.get(4).sitio_comprobado_dia, undefined);
});

test('leerTomas: si no se pueden leer los sitios, falla todo (no un Excel a medias)', async () => {
  globalThis.__compFalso.errorDe = { comp_sitios: { code: '42501', message: 'permission denied for table comp_sitios' } };
  const r = await A.leerTomas({ periodoId: 7 });
  assert.equal(r.ok, false);
  assert.equal(r.sinRed, false);
  globalThis.__compFalso.errorDe = {};
});
