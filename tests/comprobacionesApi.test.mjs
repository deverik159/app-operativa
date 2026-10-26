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

// La lista del monitorista vive en misTomasApi.ts desde la revisión del
// 26-oct-2026 (regresiones-1: Mis rutas ya no baja comprobacionesApi).
const MT = await import(
  'data:text/javascript;base64,' +
    Buffer.from(
      (
        await build({
          entryPoints: [fileURLToPath(new URL('../src/lib/misTomasApi.ts', import.meta.url))],
          bundle: true,
          write: false,
          format: 'esm',
          platform: 'neutral',
          plugins: [stubs],
        })
      ).outputFiles[0].text
    ).toString('base64')
);

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

// ---- Fase 3, incremento 1 (26-oct-2026) --------------------------------
// Las funciones nuevas deciden por el CÓDIGO (Postgres, PostgREST o el
// {ok:false, codigo} de la RPC), nunca por el texto del error.

test('fase 3: codigoFallaComp solo mira el código y el status', () => {
  assert.equal(A.codigoFallaComp({ code: 'PGRST202', message: 'cualquier cosa' }, 404), 'falta_migracion');
  assert.equal(A.codigoFallaComp({ code: '42703', message: '' }, 400), 'falta_migracion');
  assert.equal(A.codigoFallaComp({ code: 'CP001', message: '' }, 400), 'sin_sesion');
  assert.equal(A.codigoFallaComp({ code: 'CP002', message: '' }, 400), 'datos');
  assert.equal(A.codigoFallaComp({ code: '55P03', message: 'sin señal' }, 500), 'ocupada');
  assert.equal(A.codigoFallaComp({ code: '40P01' }, 500), 'ocupada');
  assert.equal(A.codigoFallaComp({ code: '42501' }, 403), 'sin_permiso');
  // El texto «lock timeout» sin código NO es «ocupada».
  assert.equal(A.codigoFallaComp({ message: 'canceling statement due to lock timeout' }, 500), 'otro');
  assert.equal(A.codigoFallaComp({ code: '55P03' }, 0, true), 'sin_red');
});

test('fase 3: un {ok:false, codigo:"ocupada"} de la RPC es una falla con su código', async () => {
  globalThis.__compFalso.rpc = () => ({ data: { ok: false, codigo: 'ocupada' }, error: null, status: 200 });
  const r = await A.ponerPlantilla([1, 2], 'cml');
  assert.equal(r.ok, false);
  assert.equal(r.codigo, 'ocupada');
  assert.equal(r.sinRed, false);
  assert.match(A.textoFallaF3(r, true), /Otra persona está guardando/);
});

test('fase 3: ponerPlantilla manda p_campana_ids y p_codigo y devuelve números', async () => {
  let pedido = null;
  globalThis.__compFalso.rpc = (n, a) => {
    pedido = { n, a };
    return { data: { cambiadas: 3, cerradas_omitidas: 1, enviadas_conservan: '2' }, error: null, status: 200 };
  };
  const r = await A.ponerPlantilla([5, 6, 7, 8], null);
  assert.deepEqual(pedido, { n: 'comp_poner_plantilla', a: { p_campana_ids: [5, 6, 7, 8], p_codigo: null } });
  assert.deepEqual(r, { ok: true, data: { cambiadas: 3, cerradas_omitidas: 1, enviadas_conservan: 2 } });
});

test('fase 3: sin la migración, refrescarMonitoristas dice falta_migracion (y la pantalla calla)', async () => {
  globalThis.__compFalso.rpc = () => ({
    data: null,
    error: { code: 'PGRST202', message: 'Could not find the function public.comp_refrescar_monitoristas' },
    status: 404,
  });
  const r = await A.refrescarMonitoristas(7);
  assert.equal(r.ok, false);
  assert.equal(r.codigo, 'falta_migracion');
  assert.equal(r.sinRed, false);
  globalThis.__compFalso.rpc = (n, a) => ({ data: { actualizadas: 4 }, error: null, status: 200, n, a });
  assert.deepEqual(await A.refrescarMonitoristas(7), { ok: true, data: { actualizadas: 4 } });
});

test('fase 3: leerMisTomasComp valida la respuesta; una que no se entiende es falla, no lista vacía', async () => {
  let pedido = null;
  globalThis.__compFalso.rpc = (n, a) => {
    pedido = { n, a };
    return {
      data: {
        hoy: '2026-10-29',
        captura: false,
        unidades: ['Vía Verde'],
        tomas: [
          { id: 1, estado: 'pendiente', fecha: '2026-10-29', campana_id: 2, sitio_id: 3, sitio_clave: 'COL_1', plantilla: [], tiene: [] },
          { id: 2, estado: 'comprobada', fecha: '2026-10-29', campana_id: 2, sitio_id: 3, sitio_clave: 'COL_1' },
        ],
      },
      error: null,
      status: 200,
    };
  };
  const r = await MT.leerMisTomasComp('2026-10-26', '2026-11-01');
  assert.deepEqual(pedido, { n: 'comp_mis_tomas', a: { p_desde: '2026-10-26', p_hasta: '2026-11-01' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.tomas.map((t) => t.id), [1]);
  globalThis.__compFalso.rpc = () => ({ data: [1, 2], error: null, status: 200 });
  const mal = await MT.leerMisTomasComp('2026-10-26', '2026-11-01');
  assert.equal(mal.ok, false);
  assert.equal(mal.codigo, 'otro');
  // Rango de más de 45 días: CP002 = datos.
  globalThis.__compFalso.rpc = () => ({ data: null, error: { code: 'CP002', message: 'Rango de 46 días.' }, status: 400 });
  const lejos = await MT.leerMisTomasComp('2026-09-01', '2026-10-17');
  assert.equal(lejos.codigo, 'datos');
});

test('fase 3: leerPlantillasCampanas y leerMonitoristaManual leen comp_campanas y comp_tomas', async () => {
  globalThis.__compFalso.errorDe = {};
  globalThis.__compFalso.tablas = {
    comp_campanas: [
      { id: 1, plantilla_codigo: 'cml' },
      { id: 2, plantilla_codigo: null },
    ],
    comp_tomas: [
      { id: 10, monitorista_manual: true },
      { id: 11, monitorista_manual: false },
    ],
  };
  const p = await A.leerPlantillasCampanas([1, 2, 3]);
  assert.equal(p.ok, true);
  assert.equal(p.data.get(1), 'cml');
  assert.equal(p.data.get(2), null);
  assert.equal(p.data.has(3), false);
  const m = await A.leerMonitoristaManual([10, 11]);
  assert.equal(m.data.get(10), true);
  assert.equal(m.data.get(11), false);
  // Antes de la migración la columna no existe: 42703.
  globalThis.__compFalso.errorDe = { comp_tomas: { code: '42703', message: 'column comp_tomas.monitorista_manual does not exist' } };
  const sin = await A.leerMonitoristaManual([10]);
  assert.equal(sin.ok, false);
  assert.equal(sin.codigo, 'falta_migracion');
  globalThis.__compFalso.errorDe = {};
});

// ---- Revisión adversarial del 26-oct-2026 ------------------------------

test('revisión: un 401 de comp_mis_tomas (token renovándose) es sin_sesion, no un error de datos', async () => {
  globalThis.__compFalso.rpc = () => ({ data: null, error: { code: '42501', message: 'permission denied' }, status: 401 });
  const r = await MT.leerMisTomasComp('2026-10-26', '2026-11-01');
  assert.equal(r.ok, false);
  assert.equal(r.codigo, 'sin_sesion');
  assert.equal(r.sinRed, false);
  globalThis.__compFalso.rpc = () => ({ data: null, error: { code: '40P01', message: 'deadlock detected' }, status: 500 });
  assert.equal((await MT.leerMisTomasComp('2026-10-26', '2026-11-01')).codigo, 'ocupada');
});

test('revisión: leerRutasComp sigue la regla V1 (Impreso solo fuera de Ecovallas) y leerMediosRutas lee el medio', async () => {
  globalThis.__compFalso.errorDe = {};
  globalThis.__compFalso.tablas = {
    rutas_monitoreo: [
      { id: 10, numero: 3, nombre: 'a', tipo_medio: 'Digital', unidad_negocio: 'Biobox', activa: true },
      { id: 20, numero: 3, nombre: 'b', tipo_medio: 'Impreso', unidad_negocio: 'Biobox', activa: true },
      { id: 30, numero: 1, nombre: 'c', tipo_medio: 'Digital', unidad_negocio: 'Ecovallas', activa: true },
      { id: 31, numero: 2, nombre: 'd', tipo_medio: 'Impreso', unidad_negocio: 'Ecovallas', activa: true },
    ],
    ruta_ubicaciones: [],
  };
  assert.deepEqual((await A.leerRutasComp('Biobox')).data.map((r) => r.id).sort(), [10, 20]);
  assert.deepEqual((await A.leerRutasComp('Ecovallas')).data.map((r) => r.id), [30]);
  const m = await A.leerMediosRutas([10, 20]);
  assert.equal(m.ok, true);
  assert.deepEqual([m.data.get(10), m.data.get(20)], ['Digital', 'Impreso']);
});
