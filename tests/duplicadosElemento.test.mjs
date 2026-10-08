// ============================================================
// tests/duplicadosElemento.test.mjs
// La regla de duplicados con las incidencias del Adicional y la Puerta
// (Erik, 6-oct-2026): se comparan por sitio, no por cara. Supabase y la RPC
// de la máquina se simulan con las filas de cada prueba.
//
// Correr: node --test tests/*.test.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const SB = `
class Q {
  constructor(t) { this.t = t; this.p = []; }
  select() { return this; } abortSignal() { return this; } retry() { return this; }
  eq(c, v) { this.p.push((r) => r[c] === v); return this; }
  in(c, vs) { this.p.push((r) => vs.includes(r[c])); return this; }
  is(c, v) { this.p.push((r) => r[c] === v); return this; }
  then(ok, ko) {
    const rs = (globalThis.__tablas[this.t] || []).filter((r) => this.p.every((f) => f(r)));
    return Promise.resolve({ data: rs, error: null, status: 200 }).then(ok, ko);
  }
}
// La RPC incidencias_en_proceso_iguales: todo lo en proceso con esas caras
// o sitios y esos nombres, SIN la RLS de quien llama (es security definer).
class Rpc {
  constructor(a) { this.a = a; }
  abortSignal() { return this; } retry() { return this; }
  then(ok, ko) {
    globalThis.__rpcLlamadas = (globalThis.__rpcLlamadas || 0) + 1;
    const { p_caras, p_sitios, p_nombres } = this.a;
    const rs = (globalThis.__tablas.incidencias || []).filter(
      (r) =>
        r.estatus === 'en_proceso' &&
        p_nombres.includes(r.nombre_incidencia) &&
        (p_caras.includes(r.clave_medio) || p_sitios.includes(r.clave_sitio))
    );
    return Promise.resolve({ data: rs, error: null, status: 200 }).then(ok, ko);
  }
}
export const sb = {
  from: () => { throw new Error('la regla no debe consultar incidencias directo (RLS)'); },
  rpc: (n, a) => new Rpc(a),
};`;
const MAQUINA = `export async function detalleMaquina() { return { filas: globalThis.__filasMaquina }; }`;

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/duplicados.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  plugins: [
    {
      name: 'simulados',
      setup(b) {
        b.onResolve({ filter: /^\.\/(supabase|estadoMaquina)$/ }, (a) => ({
          path: a.path,
          namespace: 'simulado',
        }));
        b.onLoad({ filter: /.*/, namespace: 'simulado' }, (a) => ({
          contents: a.path === './supabase' ? SB : MAQUINA,
          loader: 'js',
        }));
      },
    },
  ],
});
const { duplicadasEnProceso, duplicadasEnProcesoDeSitio } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const abierta = (o) => ({ estatus: 'en_proceso', folio: 'F-' + o.nombre_incidencia, ...o });

test('Biobox de una cara: la Puerta de NuevaInc choca con la que levantó la revisión', async () => {
  globalThis.__tablas = {
    incidencias: [
      abierta({ clave_sitio: 'BB1', clave_medio: 'BB1-D', lado: null, nombre_incidencia: 'Puertas / copetes abiertos', unidad_negocio: 'Biobox', medio: 'Digital' }),
    ],
  };
  const r = await duplicadasEnProceso([
    { clave_sitio: 'BB1', clave_medio: 'BB1-D', lado: 'Puerta', nombre_incidencia: 'Puertas / copetes abiertos', unidad_negocio: 'Biobox', medio: 'Digital' },
  ]);
  assert.equal(r.length, 1);
});

test('Sitio de varias caras: sin cara choca por sitio, y el medio separa Digital de Impreso', async () => {
  globalThis.__tablas = {
    incidencias: [
      abierta({ clave_sitio: 'EV1', clave_medio: null, lado: 'Adicional', nombre_incidencia: 'Adicional dañado', unidad_negocio: 'Ecovallas', medio: 'Impreso' }),
    ],
  };
  const fila = { clave_sitio: 'EV1', clave_medio: null, lado: 'Adicional', nombre_incidencia: 'Adicional dañado', unidad_negocio: 'Ecovallas' };
  assert.equal((await duplicadasEnProceso([{ ...fila, medio: 'Impreso' }])).length, 1);
  assert.equal((await duplicadasEnProceso([{ ...fila, medio: 'Digital' }])).length, 0);
  // Otro sitio: libre.
  assert.equal((await duplicadasEnProceso([{ ...fila, clave_sitio: 'EV2', medio: 'Impreso' }])).length, 0);
});

test('Sin máquina (MKT) no se compara por sitio', async () => {
  globalThis.__tablas = {
    incidencias: [
      abierta({ clave_sitio: 'SIN-MAQUINA', clave_medio: null, lado: 'Puerta', nombre_incidencia: 'Puertas / copetes abiertos', unidad_negocio: 'Biobox', medio: null }),
    ],
  };
  const r = await duplicadasEnProceso([
    { clave_sitio: 'SIN-MAQUINA', clave_medio: null, lado: 'Puerta', nombre_incidencia: 'Puertas / copetes abiertos', unidad_negocio: 'Biobox', medio: null },
  ]);
  assert.equal(r.length, 0);
});

test('Las de cara siguen comparándose por cara', async () => {
  globalThis.__tablas = {
    incidencias: [
      abierta({ clave_sitio: 'EV1', clave_medio: 'EV1-A', lado: 'Norte', nombre_incidencia: 'Arte con grafiti', unidad_negocio: 'Ecovallas', medio: 'Impreso' }),
    ],
  };
  const fila = { clave_sitio: 'EV1', lado: 'Norte', nombre_incidencia: 'Arte con grafiti', unidad_negocio: 'Ecovallas', medio: 'Impreso' };
  assert.equal((await duplicadasEnProceso([{ ...fila, clave_medio: 'EV1-A' }])).length, 1);
  assert.equal((await duplicadasEnProceso([{ ...fila, clave_medio: 'EV1-B' }])).length, 0);
});

test('El monitorista choca con la que capturó otra persona (8-oct-2026)', async () => {
  // Con la consulta directa, la RLS le escondía esta fila al monitorista y
  // el duplicado entraba. La RPC la ve.
  globalThis.__tablas = {
    incidencias: [
      abierta({ clave_sitio: 'EV1', clave_medio: 'EV1-A', lado: 'Norte', nombre_incidencia: 'Lona rota', unidad_negocio: 'Ecovallas', medio: 'Impreso', captured_by: 'otra@persona' }),
    ],
  };
  const r = await duplicadasEnProceso([
    { clave_sitio: 'EV1', clave_medio: 'EV1-A', lado: 'Norte', nombre_incidencia: 'Lona rota', unidad_negocio: 'Ecovallas', medio: 'Impreso' },
  ]);
  assert.deepEqual(r.map((x) => x.folio), ['F-Lona rota']);
});

test('Una sola llamada aunque haya filas por cara y por sitio', async () => {
  globalThis.__tablas = { incidencias: [] };
  globalThis.__rpcLlamadas = 0;
  await duplicadasEnProceso([
    { clave_sitio: 'EV1', clave_medio: 'EV1-A', lado: 'Norte', nombre_incidencia: 'Lona rota', unidad_negocio: 'Ecovallas', medio: 'Impreso' },
    { clave_sitio: 'EV1', clave_medio: null, lado: 'Adicional', nombre_incidencia: 'Adicional dañado', unidad_negocio: 'Ecovallas', medio: 'Impreso' },
  ]);
  assert.equal(globalThis.__rpcLlamadas, 1);
});

test('Revisión de Biobox: la Puerta sin cara del sitio también bloquea', async () => {
  globalThis.__filasMaquina = [
    { estatus: 'en_proceso', folio: 'BBMM00042', clave_medio: null, nombre_incidencia: 'Puertas / copetes abiertos' },
    { estatus: 'en_proceso', folio: 'BBMM00043', clave_medio: 'X-I', nombre_incidencia: 'Chapa dañada' },
  ];
  const r = await duplicadasEnProcesoDeSitio('BB1', [
    { clave_medio: 'X-D', nombre_incidencia: 'Puertas / copetes abiertos' },
    { clave_medio: 'X-D', nombre_incidencia: 'Chapa dañada' },
  ]);
  assert.deepEqual(r, [{ nombre_incidencia: 'Puertas / copetes abiertos', folio: 'BBMM00042' }]);
});
