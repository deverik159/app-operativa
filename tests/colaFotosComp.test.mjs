// ============================================================
// tests/colaFotosComp.test.mjs
// La cola de fotos de Comprobaciones (lib/colaFotos/adaptadorComp.ts sobre
// nucleo.ts) de punta a punta, con Supabase simulado (las RPC de §4.2 2c:
// comp_subir_foto, comp_quitar_foto, comp_estado_tomas y
// comp_registrar_tomas) y una IndexedDB de mentira en memoria (cuenta los
// getAll para probar el índice). Fase 3, incremento 2, 26-oct-2026.
//
// Son las 34 de tests/tomasPautaCola.test.mjs adaptadas a la visita (la
// cola de Pauta no se toca) más las nuevas de la especificación §8: ligas
// múltiples, «ya», cerradas/futuras/ajenas/duplicadas, ocupada/55P03/40P01
// como reintento, registro automático al completar, regreso_n, «Usar
// también para…», quitar de una sola toma, sin_objeto e índice con 500
// visitas. Cada prueba usa su propio correo: la cola es de módulo y no se
// reinicia.
//
// Correr: node --test --test-concurrency=2 "tests/*.test.mjs"
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// --- Supabase simulado: delega en globalThis.__sb (cada prueba lo arma) ---
const SB = `
class R {
  constructor(n, a) { this.n = n; this.a = a; }
  abortSignal() { return this; }
  then(ok, ko) { return Promise.resolve().then(() => globalThis.__sb.rpc(this.n, this.a)).then(ok, ko); }
}
export const sb = {
  from: (t) => { throw new Error('la cola de comp no lee tablas: ' + t); },
  rpc: (n, a) => new R(n, a),
  storage: {
    from: () => ({
      upload: (p, f, o) => globalThis.__sb.upload(p, f, o),
      getPublicUrl: (p) => ({ data: { publicUrl: 'https://x/evidencias/' + p } }),
      remove: (ps) => globalThis.__sb.remove(ps),
    }),
  },
  auth: {
    getSession: async () => ({ data: { session: globalThis.__sb.sesion ? { user: { email: globalThis.__sb.sesion } } : null } }),
    refreshSession: async () => ({ data: { session: globalThis.__sb.sesion ? { user: { email: globalThis.__sb.sesion } } : null } }),
    getUser: async () =>
      globalThis.__sb.colgarAuth
        ? new Promise(() => {})
        : globalThis.__sb.anonimo || !globalThis.__sb.sesion
        ? { data: { user: null }, error: { message: 'JWT expired' } }
        : { data: { user: { email: globalThis.__sb.sesion } }, error: null },
  },
};`;

// --- IndexedDB de mentira (misma forma que lib/idbTolerante) ---
const IDB = `
export function crearBaseTolerante(nombre, llaves) {
  const g = (globalThis.__idb ??= {});
  const db = (g[nombre] ??= { stores: {}, getAll: 0, falla: false });
  for (const a of Object.keys(llaves)) db.stores[a] ??= new Map();
  const copia = (v) => (v === undefined || v === null ? v : v.blob || v.buf ? v : JSON.parse(JSON.stringify(v)));
  return {
    async tx(almacenes, modo, trabajo) {
      if (db.falla) throw new Error('IndexedDB no disponible');
      let pend = 0;
      const req = (fn) => {
        const r = {};
        pend++;
        queueMicrotask(() => {
          r.result = fn();
          pend--;
          r.onsuccess?.();
        });
        return r;
      };
      const t = {
        objectStore: (n) => {
          const m = db.stores[n];
          const k = llaves[n];
          return {
            get: (key) => req(() => copia(m.get(key))),
            getAll: () => {
              db.getAll++;
              return req(() => [...m.values()].map(copia));
            },
            put: (v) => {
              m.set(v[k], copia(v));
              return {};
            },
            delete: (key) => {
              m.delete(key);
              return {};
            },
          };
        },
      };
      const salida = trabajo(t);
      while (pend > 0) await new Promise((r) => queueMicrotask(r));
      return salida;
    },
  };
}`;

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/colaFotos/adaptadorComp.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  plugins: [
    {
      name: 'simulados',
      setup(b) {
        b.onResolve({ filter: /^\.\.?\/(supabase|reportarError|cargaDiferida|idbTolerante)$/ }, (a) => ({
          path: a.path.replace(/^.*\//, ''),
          namespace: 'sim',
        }));
        b.onLoad({ filter: /.*/, namespace: 'sim' }, (a) => ({
          contents:
            a.path === 'supabase'
              ? SB
              : a.path === 'idbTolerante'
                ? IDB
                : a.path === 'reportarError'
                  ? 'export function reportarError() {}'
                  : 'export function retenerRecargaAutomatica() { return () => {}; }',
          loader: 'js',
        }));
      },
    },
  ],
});
// En Node un BroadcastChannel con oyente mantiene vivo el proceso.
globalThis.BroadcastChannel = undefined;
// Los topes largos no deben retener el proceso al terminar.
const setTimeoutReal = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = setTimeoutReal(fn, ms, ...args);
  if (ms > 5000) t?.unref?.();
  return t;
};
const Q = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

// Sin señal "de verdad" para el navegador: conReintento no espera 1.5 s y 4 s.
try {
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
} catch {
  globalThis.navigator = { onLine: false };
}

const HOY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const MANANA = new Date(Date.parse(HOY + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
const AYER = new Date(Date.parse(HOY + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);

const RED = { message: 'Load failed' };
const SLUG = { Ecovallas: 'ecovallas', Biobox: 'biobox', 'Vía Verde': 'via-verde' };
const UNICA = [{ pos: 'normal', n: 1, alcance: 'version', momento: null, etiqueta: 'Toma' }];
const CML = [
  { pos: 'corta', n: 1, alcance: 'version', momento: null, etiqueta: 'Corta' },
  { pos: 'media', n: 1, alcance: 'version', momento: null, etiqueta: 'Media' },
  { pos: 'larga', n: 1, alcance: 'version', momento: null, etiqueta: 'Larga' },
];
const LATERAL2 = [{ pos: 'lateral', n: 2, alcance: 'sitio', momento: null, etiqueta: 'Lateral' }];

let EMAIL = '';
let correoN = 0;

/** Base simulada: tomas, fotos, ligas, objetos y fallas programables por RPC. */
function servidor() {
  const s = {
    sesion: EMAIL,
    anonimo: false,
    colgarAuth: false,
    piloto: true,
    tomas: new Map(),
    evidencias: new Map(),
    ligas: [],
    objetos: new Set(),
    porRuta: {},
    subidas: 0,
    /** Rutas que la app pidió borrar de Storage (aunque la red o la política no lo dejen). */
    borrados: [],
    evId: 0,
    llamadas: [],
    hechas: {},
    enviadas: [],
    fallas: { upload: [], remove: [], comp_subir_foto: [], comp_registrar_tomas: [], comp_estado_tomas: [], comp_quitar_foto: [] },
    frenoSubida: null,
    frenoRemove: null,
    antesDeRpc: null,
  };
  const anon = () => !s.sesion || s.anonimo;
  const evDe = (id) => [...s.evidencias.values()].find((e) => e.id === id);
  const mio = (t) =>
    t.monitorista === s.sesion ||
    s.ligas.some((l) => l.toma_id === t.id && l.regresada_en == null && evDe(l.evidencia_id)?.subido_por === s.sesion);
  const faltan = (t) =>
    t.plantilla
      .map((q) => ({
        ...q,
        tiene: s.ligas.filter((l) => {
          const e = evDe(l.evidencia_id);
          return l.toma_id === t.id && l.regresada_en == null && e.tipo === 'foto' && e.pos === q.pos && (e.momento ?? null) === q.momento;
        }).length,
      }))
      .filter((q) => q.tiene < q.n)
      .map(({ pos, momento, etiqueta, n, tiene }) => ({ pos, momento, etiqueta, n, tiene }));
  const h = {
    comp_subir_foto(a) {
      const ts = a.p_toma_ids.map((id) => s.tomas.get(id));
      if (ts.some((t) => !t) || new Set(ts.map((t) => t.unidad + '|' + t.sitio_clave)).size !== 1) return { __error: 'CP003' };
      if (!s.piloto) return { ok: false, codigo: 'captura_cerrada' };
      const p = a.p_path.split('/');
      const t0 = ts[0];
      if (
        p.length !== 5 ||
        p[0] !== 'comp' ||
        p[1] !== SLUG[t0.unidad] ||
        p[3] !== t0.sitio_clave ||
        !new RegExp(`^[0-9]{8}_${a.p_cliente_id}\\.[a-z0-9]{2,5}$`).test(p[4])
      )
        return { __error: 'CP002' };
      let ev = s.evidencias.get(a.p_cliente_id);
      let ya = false;
      if (ev) {
        if (ev.path !== a.p_path || ev.subido_por !== s.sesion) return { __error: 'CP002' };
        ya = true;
      } else if (!s.objetos.has(a.p_path)) return { ok: false, codigo: 'sin_objeto' };
      const r = { ligadas: [], cerradas: [], futuras: [], ajenas: [], duplicadas: [] };
      const ligables = [];
      const camara = [];
      for (const t of ts) {
        if (t.estado === 'comprobada' || t.estado === 'cancelada' || t.cerrada) r.cerradas.push(t.id);
        else if (t.fecha > HOY) r.futuras.push(t.id);
        else if (!mio(t)) r.ajenas.push(t.id);
        // Como comp_f3_revision (29-oct-2026): la posición que en esa toma va
        // por cámara sale en duplicadas (sin liga).
        else if ((t.por_camara ?? []).includes(ev?.pos ?? a.p_pos)) camara.push(t.id);
        else ligables.push(t);
      }
      if (new Set(ligables.map((t) => t.campana_id)).size !== ligables.length) return { __error: 'CP005' };
      // Como la base (26-oct-2026, antes del paso 9): una foto NUEVA que
      // ninguna toma acepta no crea fila; el objeto se queda suelto.
      if (!ev && !ligables.length) return { ok: true, ya: false, evidencia_id: null, fecha: null, ...r, duplicadas: camara };
      if (!ev) {
        ev = { id: ++s.evId, cliente_id: a.p_cliente_id, path: a.p_path, subido_por: s.sesion, tipo: a.p_tipo, pos: a.p_pos, momento: a.p_momento, fecha: HOY };
        s.evidencias.set(a.p_cliente_id, ev);
      }
      for (const t of ligables) {
        // Como la base (paso 10): la liga que ya existía y sigue vigente es un
        // reintento (ligadas); la devuelta (B4) o la de otro día de la misma
        // campaña (A1) es duplicada y NO cuenta.
        const mismaToma = s.ligas.find((l) => l.evidencia_id === ev.id && l.toma_id === t.id);
        const mismaCampana = s.ligas.some((l) => l.evidencia_id === ev.id && l.campana_id === t.campana_id);
        if (!mismaToma && !mismaCampana) {
          s.ligas.push({ evidencia_id: ev.id, toma_id: t.id, campana_id: t.campana_id, regresada_en: null, revisada: false });
          r.ligadas.push(t.id);
        } else if (mismaToma && mismaToma.regresada_en == null) r.ligadas.push(t.id);
        else r.duplicadas.push(t.id);
      }
      r.duplicadas.push(...camara);
      return { ok: true, ya, evidencia_id: ev.id, fecha: HOY, ...r };
    },
    comp_quitar_foto(a) {
      const ev = s.evidencias.get(a.p_cliente_id);
      if (!ev) return { ok: true, ya: true };
      if (ev.subido_por !== s.sesion) return { ok: false, codigo: 'sin_permiso' };
      const ls = s.ligas.filter((l) => l.evidencia_id === ev.id);
      if (a.p_toma_id != null) {
        const l = ls.find((x) => x.toma_id === a.p_toma_id);
        if (!l) return { ok: true, ya: true, quedan: ls.length };
        if (l.revisada || l.regresada_en != null) return { ok: false, codigo: 'revisada' };
        if (!['pendiente', 'regresada', 'cancelada'].includes(s.tomas.get(l.toma_id).estado)) return { ok: false, codigo: 'enviada' };
        s.ligas = s.ligas.filter((x) => x !== l);
        const quedan = ls.length - 1;
        // Como la base (26-oct-2026): sin ninguna liga y sin revisiones (aquí
        // viven en la liga: sin ligas no hay) se borra la fila entera.
        if (quedan === 0) {
          s.evidencias.delete(ev.cliente_id);
          return { ok: true, desligada: true, quedan: 0, borrada: true, path: ev.path };
        }
        return { ok: true, desligada: true, quedan };
      }
      if (ls.some((l) => l.revisada || l.regresada_en != null)) return { ok: false, codigo: 'revisada' };
      if (ls.some((l) => ['por_revisar', 'comprobada'].includes(s.tomas.get(l.toma_id).estado))) return { ok: false, codigo: 'enviada' };
      s.ligas = s.ligas.filter((x) => x.evidencia_id !== ev.id);
      s.evidencias.delete(ev.cliente_id);
      return { ok: true, borrada: true, path: ev.path };
    },
    comp_estado_tomas(a) {
      return a.p_ids
        .map((id) => s.tomas.get(id))
        .filter((t) => t && mio(t))
        .map((t) => ({ id: t.id, estado: t.estado, regreso_n: t.regreso_n, rechazo_motivo: t.rechazo_motivo }));
    },
    comp_registrar_tomas(a) {
      const tomas = a.p_toma_ids.map((id) => {
        const t = s.tomas.get(id);
        if (!t || !mio(t)) return { id, codigo: 'ajena' };
        if (t.estado === 'por_revisar' || t.estado === 'comprobada') return { id, estado: t.estado, ya: true, regreso_n: t.regreso_n };
        if (t.estado === 'cancelada' || t.cerrada) return { id, estado: t.estado, codigo: 'cerrada' };
        if (t.fecha > HOY) return { id, estado: t.estado, codigo: 'futura' };
        const f = faltan(t);
        if (f.length) return { id, estado: t.estado, codigo: 'faltan', faltan: f, regreso_n: t.regreso_n };
        t.estado = 'por_revisar';
        s.enviadas.push(id);
        return { id, estado: 'por_revisar', regreso_n: t.regreso_n };
      });
      return { ok: true, tomas };
    },
  };
  s.rpc = (n, a) => {
    s.llamadas.push({ n, a: JSON.parse(JSON.stringify(a)) });
    const o = s.antesDeRpc?.(n, a);
    if (o) return o;
    const falla = s.fallas[n]?.shift();
    if (falla === 'red') return { data: null, error: RED, status: 0 };
    if (falla === '55P03' || falla === '40P01' || falla === '57014') return { data: null, error: { code: falla, message: 'x' }, status: 500 };
    if (falla === 'ocupada') return { data: { ok: false, codigo: 'ocupada' }, error: null, status: 200 };
    if (falla === 'sin_objeto') return { data: { ok: false, codigo: 'sin_objeto' }, error: null, status: 200 };
    if (falla === 'vacio') return { data: [], error: null, status: 200 };
    if (falla && falla.startsWith('CP')) return { data: null, error: { code: falla, message: 'datos' }, status: 400 };
    if (anon()) return { data: null, error: { code: 'CP001', message: 'Sin sesión' }, status: 400 };
    const d = h[n](a);
    if (d && d.__error) return { data: null, error: { code: d.__error, message: 'x' }, status: 400 };
    s.hechas[n] = (s.hechas[n] || 0) + 1;
    if (falla === 'perdida') return { data: null, error: RED, status: 0 };
    return { data: d, error: null, status: 200 };
  };
  s.upload = async (p) => {
    s.subidas++;
    s.porRuta[p] = (s.porRuta[p] || 0) + 1;
    if (s.frenoSubida) await s.frenoSubida;
    const falla = s.fallas.upload.shift();
    if (falla === 'red') return { error: { name: 'StorageUnknownError', message: 'Load failed' } };
    if (falla === 'rechazo') return { error: { status: 400, statusCode: '400', message: 'invalid' } };
    if (s.objetos.has(p)) return { error: { status: 400, statusCode: '409', message: 'The resource already exists' } };
    s.objetos.add(p);
    return { error: null };
  };
  s.remove = async (ps) => {
    s.borrados.push(...ps);
    if (s.frenoRemove) await s.frenoRemove;
    if (s.fallas.remove.shift() === 'red') return { data: null, error: { name: 'StorageUnknownError', message: 'Load failed' } };
    // Política ev_obj_del_comp: sin sesión no borra nada (sin error) y nunca un objeto que una fila usa.
    if (anon()) return { data: [], error: null };
    for (const p of ps) if (![...s.evidencias.values()].some((e) => e.path === p)) s.objetos.delete(p);
    return { data: [], error: null };
  };
  globalThis.__sb = s;
  return s;
}

test.beforeEach(() => {
  correoN++;
  EMAIL = `moni${correoN}@ejemplo.test`;
  servidor();
});

let tomaId = 1000;
let campId = 100;
let sitioN = 0;
/** Un sitio con sus tomas en el servidor y la visita como la vería la pantalla. */
function sitio({ plantilla = UNICA, versiones = 1, unidad = 'Vía Verde', fecha = HOY, estado = 'pendiente', regreso_n = 0 } = {}) {
  sitioN++;
  const sitio_clave = `COL_${sitioN}`;
  const tomas = [];
  for (let i = 0; i < versiones; i++) {
    const t = { id: ++tomaId, campana_id: ++campId, campana: `Campaña ${campId}`, version: 'V1', fecha, estado, regreso_n, plantilla, tiene: [] };
    tomas.push(t);
    globalThis.__sb.tomas.set(t.id, {
      id: t.id,
      campana_id: t.campana_id,
      unidad,
      sitio_clave,
      fecha,
      estado,
      regreso_n,
      monitorista: EMAIL,
      plantilla,
      rechazo_motivo: null,
      cerrada: false,
    });
  }
  return { unidad, sitio_clave, fecha, tomas };
}

const foto = (i) => new File([new Uint8Array([0xff, 0xd8, i])], 'image.jpg', { type: 'image/jpeg' });
const nuevas = (n) => Array.from({ length: n }, (_, i) => ({ file: foto(i), origen: 'camara' }));
const hoja = (v, pos = 'normal', ids) => ({ pos, momento: null, toma_ids: ids ?? [v.tomas[0].id] });
const esperar = (ms) => new Promise((r) => setTimeoutReal(r, ms));
/** Espera a que la cola se calme (las corridas lanzadas en segundo plano). */
async function calma() {
  for (let i = 0; i < 50; i++) await esperar(5);
}
const estado = (v) => Q.estadoVisita(EMAIL, v);
const ligasDe = (s, id) => s.ligas.filter((l) => l.toma_id === id && l.regresada_en == null);
const registros = (s) => s.hechas.comp_registrar_tomas || 0;

// ============================================================
// Las 34 de Pauta, adaptadas a la visita
// ============================================================

test('1. unica: la foto sube, se liga y la toma se registra sola UNA vez', async () => {
  const s = globalThis.__sb;
  const v = sitio();
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  assert.equal(r.tipo, 'ok');
  assert.match(r.archivos[0].path, new RegExp(`^comp/via-verde/\\d{4}-\\d{2}/${v.sitio_clave}/\\d{8}_[0-9a-f-]{36}\\.jpg$`));
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.equal(ligasDe(s, v.tomas[0].id).length, 1);
  assert.equal(registros(s), 1);
  assert.equal(s.tomas.get(v.tomas[0].id).estado, 'por_revisar');
  assert.equal(await estado(v), null, 'la visita se soltó');
  const logros = Q.tomarLogrosTomasComp(EMAIL);
  assert.equal(Q.textoLogroComp(logros), `✓ ${v.sitio_clave} · 1 foto arriba · 1 toma enviada`);
});

test('2. «Listo» con la subida lenta: contesta enCola y el aviso breve lo dice después', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'media'));
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'larga'));
  const c = await Q.cerrarVisita(EMAIL, v);
  assert.equal(c.tipo, 'enCola');
  s.frenoSubida = null;
  soltar();
  await calma();
  assert.equal(registros(s), 1);
  const logros = Q.logrosPorMostrarComp(Q.tomarLogrosTomasComp(EMAIL));
  assert.match(Q.textoLogroComp(logros), /3 fotos arriba · 1 toma enviada/);
});

test('3. sin red al subir: queda en cola y al volver sale sin duplicar', async () => {
  const s = globalThis.__sb;
  s.fallas.upload.push('red');
  const v = sitio();
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  let e = await estado(v);
  assert.equal(e.porSubir, 1);
  assert.equal(e.fotos[0].estado, 'local');
  assert.ok(e.ultimoError);
  assert.equal(e.conError, false);
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.equal(registros(s), 1);
  assert.equal(await estado(v), null);
});

test('4. «ya existe» en Storage cuenta como subida', async () => {
  const s = globalThis.__sb;
  s.upload = async (p) => {
    s.subidas++;
    s.objetos.add(p);
    return { error: { status: 400, statusCode: '409', message: 'The resource already exists' } };
  };
  const v = sitio();
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.equal(registros(s), 1);
});

test('5. comp_subir_foto entró pero se perdió la respuesta: el reintento contesta «ya» y no duplica', async () => {
  const s = globalThis.__sb;
  s.fallas.comp_subir_foto.push('perdida');
  const v = sitio();
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  let e = await estado(v);
  assert.equal(e.fotos[0].estado, 'subido');
  assert.equal(s.evidencias.size, 1);
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.equal(s.ligas.length, 1);
  // La liga ya existía y sigue vigente (la base la manda en «ligadas» con ya=true): cuenta y se registra.
  assert.equal(registros(s), 1);
  assert.equal(s.tomas.get(v.tomas[0].id).estado, 'por_revisar');
  assert.ok(!Q.tomarAvisosTomasComp(EMAIL).some((a) => /no cuenta/.test(a.texto)), 'sin aviso falso de duplicada');
});

test('6. toma ya comprobada: la foto no se liga (cerradas), avisa una vez y no se registra', async () => {
  const s = globalThis.__sb;
  const v = sitio();
  s.tomas.get(v.tomas[0].id).estado = 'comprobada';
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  assert.equal(s.ligas.length, 0);
  assert.equal(registros(s), 0);
  const avisos = Q.tomarAvisosTomasComp(EMAIL);
  assert.equal(avisos.filter((a) => a.tipo === 'info' && /no cuenta/.test(a.texto)).length, 1);
  assert.equal(await estado(v), null, 'la visita se soltó (la toma ya no espera nada)');
});

test('7. se comprueba mientras sube: la foto queda en cerradas y no se registra', async () => {
  const s = globalThis.__sb;
  const v = sitio();
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await esperar(10);
  s.tomas.get(v.tomas[0].id).estado = 'comprobada';
  s.frenoSubida = null;
  soltar();
  await calma();
  assert.equal(s.ligas.length, 0);
  assert.equal(registros(s), 0);
  assert.equal(s.evidencias.size, 0, 'una foto nueva sin ninguna toma no crea fila');
  // 27-oct-2026: el objeto quedó suelto y la visita se soltó (su única toma
  // ya no espera nada): su dueño lo borra, no se queda huérfano.
  assert.equal(s.objetos.size, 0, 'al soltar la visita su objeto suelto se borra');
  assert.equal(await estado(v), null);
});

test('8. una foto que llega a media corrida sale en la misma y la visita no se cierra antes', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await esperar(10);
  const otras = Promise.all([
    Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'media')),
    Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'larga')),
  ]);
  s.frenoSubida = null;
  soltar();
  const rs = await otras;
  assert.ok(rs.every((r) => r.tipo === 'ok'));
  await calma();
  assert.equal(ligasDe(s, v.tomas[0].id).length, 3);
  assert.equal(registros(s), 1);
  assert.equal(await estado(v), null);
});

test('9. dos «Listo» casi juntos: una sola llamada a comp_registrar_tomas', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'media'));
  await calma();
  assert.equal(registros(s), 0, 'incompleta: no se registra sola');
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'larga'));
  const [a, b] = await Promise.all([Q.cerrarVisita(EMAIL, v), Q.cerrarVisita(EMAIL, v)]);
  await calma();
  assert.equal(registros(s), 1);
  assert.ok([a.tipo, b.tipo].includes('listo'));
});

test('10. faltan fotos: no se registra sola y «Listo» dice qué falta', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'media'));
  await calma();
  assert.equal(registros(s), 0);
  const c = await Q.cerrarVisita(EMAIL, v);
  assert.equal(c.tipo, 'listo');
  assert.equal(c.faltan.length, 1);
  assert.equal(c.faltan[0].texto, `Falta: Larga de ${v.tomas[0].campana} V1`);
  assert.equal(s.tomas.get(v.tomas[0].id).estado, 'pendiente');
  // Lo vio en pantalla: no va también al buzón.
  assert.ok(!Q.tomarAvisosTomasComp(EMAIL).some((a) => a.tipo === 'faltan'));
});

test('11. quitar una foto en cola: no sube y la visita cierra sin ella', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  const r1 = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  const r2 = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'media'));
  await esperar(10);
  const segunda = r2.archivos[0];
  assert.equal(await Q.quitarArchivoComp(segunda.trabajo, segunda.fid), 'ok');
  s.frenoSubida = null;
  soltar();
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.equal([...s.evidencias.values()][0].path, r1.archivos[0].path);
  assert.ok(!s.objetos.has(segunda.path));
  const e = await estado(v);
  assert.equal(e.porSubir, 0);
  assert.equal(e.fotos.length, 1);
});

test('12. respuesta perdida y el teléfono «en línea»: reintenta sin duplicar', async () => {
  const s = globalThis.__sb;
  Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
  try {
    s.fallas.comp_subir_foto.push('perdida');
    const v = sitio();
    await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
    for (let i = 0; i < 40 && (await estado(v)); i++) await esperar(100);
    assert.equal(s.evidencias.size, 1);
    assert.equal(s.ligas.length, 1);
    assert.equal(s.hechas.comp_subir_foto, 2);
    assert.equal(registros(s), 1);
  } finally {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  }
});

test('13. Storage rechaza la foto: se conserva, avisa y sube en la vuelta siguiente', async () => {
  const s = globalThis.__sb;
  s.fallas.upload.push('rechazo');
  const v = sitio();
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  let e = await estado(v);
  assert.equal(e.fotos[0].estado, 'fallido');
  assert.equal(e.conError, true);
  assert.match(e.ultimoError, /No se pudo subir la foto 1/);
  assert.ok(Q.tomarAvisosTomasComp(EMAIL).some((a) => a.tipo === 'error' && /No se pudo subir/.test(a.texto)));
  assert.ok((await Q.archivoLocalComp(e.fotos[0].trabajo, e.fotos[0].fid)) !== null, 'el archivo sigue en la app');
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.equal(registros(s), 1);
  assert.equal(await estado(v), null);
});

test('14. quitar una foto que ya entró: comp_quitar_foto y después el objeto', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await calma();
  const a = r.archivos[0];
  assert.equal(s.ligas.length, 1);
  assert.equal(await Q.quitarArchivoComp(a.trabajo, a.fid), 'ok');
  await calma();
  assert.equal(s.evidencias.size, 0);
  assert.equal(s.ligas.length, 0);
  assert.ok(!s.objetos.has(a.path));
  assert.ok(s.llamadas.findIndex((x) => x.n === 'comp_quitar_foto') >= 0);
});

test('15. storage.remove que no contesta no atora la vuelta (tope)', async () => {
  const s = globalThis.__sb;
  const v1 = sitio({ plantilla: CML });
  const v2 = sitio();
  const r = await Q.encolarFotosComp(EMAIL, v1, nuevas(1), hoja(v1, 'corta'));
  await calma();
  s.fallas.remove.push('red');
  await Q.quitarArchivoComp(r.archivos[0].trabajo, r.archivos[0].fid);
  await calma();
  s.fallas.upload.push('red');
  await Q.encolarFotosComp(EMAIL, v2, nuevas(1), hoja(v2));
  await calma();
  s.frenoRemove = new Promise(() => {});
  const v = await Promise.race([Q.procesarTomasCompPendientes(EMAIL), esperar(20000).then(() => 'colgada')]);
  assert.notEqual(v, 'colgada', 'la vuelta termina por el tope');
  s.frenoRemove = null;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(ligasDe(s, v2.tomas[0].id).length, 1);
  assert.ok(!s.objetos.has(r.archivos[0].path));
});

test('16. comp_estado_tomas vacío con la sesión a medio renovar: no concluye «ya no es tuya»', async () => {
  const s = globalThis.__sb;
  const v = sitio();
  s.fallas.comp_registrar_tomas.push('red'); // que se quede antes de registrar
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  // La lectura del estado sale vacía (anónima) y getUser falla: espera.
  s.anonimo = true;
  s.antesDeRpc = (n) => (n === 'comp_estado_tomas' ? { data: [], error: null, status: 200 } : null);
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(registros(s), 0);
  const e = await estado(v);
  assert.ok(e, 'la visita sigue');
  assert.deepEqual(e.sinEnviar, [], 'no la marcó ajena');
  s.anonimo = false;
  s.antesDeRpc = null;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(registros(s), 1);
});

test('17. la analista la devolvió después de las fotos (regreso_n): pide atención y no registra', async () => {
  const s = globalThis.__sb;
  const v = sitio({ estado: 'regresada', regreso_n: 0 });
  const st = s.tomas.get(v.tomas[0].id);
  st.regreso_n = 1;
  st.rechazo_motivo = 'salió movida';
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  assert.equal(ligasDe(s, v.tomas[0].id).length, 1);
  assert.equal(registros(s), 0);
  const e = await estado(v);
  assert.equal(e.conError, true);
  assert.match(e.ultimoError, /devolvió/);
  const avisos = Q.tomarAvisosTomasComp(EMAIL);
  assert.equal(avisos.filter((a) => /devolvió/.test(a.texto)).length, 1, 'un solo aviso');
  assert.ok(avisos.some((a) => a.tipo === 'regreso' && /salió movida/.test(a.texto)));
  assert.ok((await Q.listarTomasCompAviso(EMAIL)).some((a) => a.atencion));
  // Otra vuelta no lo repite.
  const vu = await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal([...vu.mensajes, ...Q.tomarAvisosTomasComp(EMAIL)].filter((a) => /devolvió/.test(a.texto)).length, 0);
  // La pantalla vuelve a leer la lista (regreso_n 1): ahora sí se envía.
  await Q.actualizarVisita(EMAIL, { ...v, tomas: v.tomas.map((t) => ({ ...t, regreso_n: 1 })) });
  await calma();
  assert.equal(registros(s), 1);
  assert.equal(st.estado, 'por_revisar');
});

test('18. limpiar una foto quitada con la sesión anónima espera la sesión', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await calma();
  const a = r.archivos[0];
  s.anonimo = true;
  await Q.quitarArchivoComp(a.trabajo, a.fid);
  await calma();
  assert.equal(s.evidencias.size, 1, 'no se da por limpia');
  assert.ok((await Q.hayTomasCompPendientes(EMAIL)) > 0);
  s.anonimo = false;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.size, 0);
  assert.ok(!s.objetos.has(a.path));
});

test('19. Descartar con una limpieza pendiente la deja a la cola, sin pedir atención', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await calma();
  const a = r.archivos[0];
  s.fallas.comp_quitar_foto.push('red');
  await Q.quitarArchivoComp(a.trabajo, a.fid);
  await calma();
  assert.equal(await Q.descartarTomaComp(a.trabajo), 'ok');
  await calma();
  const aviso = (await Q.listarTomasCompAviso(EMAIL)).find((x) => x.id === a.trabajo);
  assert.ok(!aviso || !aviso.atencion);
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.size, 0);
  assert.ok(!s.objetos.has(a.path));
  assert.equal((await Q.listarTomasCompAviso(EMAIL)).length, 0);
});

test('20. Descartar una foto que el servidor rechazó al ligar (ya arriba) limpia su objeto', async () => {
  const s = globalThis.__sb;
  s.fallas.comp_subir_foto.push('CP002');
  const v = sitio();
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  const a = r.archivos[0];
  const e = await estado(v);
  assert.equal(e.fotos[0].estado, 'fallido');
  assert.ok(s.objetos.has(a.path));
  assert.equal(await Q.descartarTomaComp(a.trabajo), 'ok');
  await calma();
  assert.ok(!s.objetos.has(a.path), 'sin objeto huérfano');
  assert.equal((await Q.listarTomasCompAviso(EMAIL)).length, 0);
});

test('21. un ligar rechazado (CP002) se reintenta sin volver a subir la foto', async () => {
  const s = globalThis.__sb;
  s.fallas.comp_subir_foto.push('CP002');
  const v = sitio();
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  assert.equal(s.porRuta[r.archivos[0].path], 1);
  assert.ok(Q.tomarAvisosTomasComp(EMAIL).some((a) => a.tipo === 'error'));
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.porRuta[r.archivos[0].path], 1, 'no se volvió a subir');
  assert.equal(s.ligas.length, 1);
  assert.equal(registros(s), 1);
});

test('22. una foto rechazada no se vuelve a subir ni a avisar con cada foto nueva', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: [{ pos: 'angulo', n: 4, alcance: 'version', momento: null, etiqueta: 'Ángulo' }] });
  const subirReal = s.upload;
  let mala = null;
  s.upload = async (p, f, o) => {
    if (!mala || p === mala) {
      mala = p;
      s.porRuta[p] = (s.porRuta[p] || 0) + 1;
      return { error: { status: 400, statusCode: '400', message: 'invalid mime' } };
    }
    return subirReal(p, f, o);
  };
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'angulo'));
  await calma();
  for (let i = 0; i < 3; i++) {
    await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'angulo'));
    await calma();
  }
  assert.equal(s.porRuta[mala], 1, 'la rechazada solo se intentó una vez');
  assert.equal(Q.tomarAvisosTomasComp(EMAIL).filter((a) => /No se pudo subir la foto 1/.test(a.texto)).length, 1);
  assert.equal(ligasDe(s, v.tomas[0].id).length, 3);
});

test('23. quitar la foto rechazada apaga el error', async () => {
  const s = globalThis.__sb;
  s.upload = async () => ({ error: { status: 400, statusCode: '400', message: 'invalid' } });
  const v = sitio();
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  assert.equal((await estado(v)).conError, true);
  await Q.quitarArchivoComp(r.archivos[0].trabajo, r.archivos[0].fid);
  const e = await estado(v);
  if (e) {
    assert.equal(e.conError, false);
    assert.equal(e.ultimoError, null);
  }
});

test('24. el estado sale vacío una vez: getUser y otra lectura antes de concluir; se registra', async () => {
  const s = globalThis.__sb;
  const v = sitio();
  s.fallas.comp_estado_tomas.push('vacio');
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  assert.equal(s.llamadas.filter((x) => x.n === 'comp_estado_tomas').length, 2);
  assert.equal(registros(s), 1);
});

test('25. lo que el monitorista vio en pantalla no se repite en el aviso breve', async () => {
  const v = sitio({ plantilla: CML });
  for (const pos of ['corta', 'media']) {
    await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, pos));
    await calma();
  }
  const sueltos = Q.tomarLogrosTomasComp(EMAIL);
  assert.equal(sueltos.reduce((n, l) => n + l.fotos, 0), 2);
  await esperar(2);
  Q.marcarVisitaVista(EMAIL, v);
  assert.equal(Q.logrosPorMostrarComp(sueltos).length, 0);
});

test('26. «Listo» no se queda más de 8 s aunque la sesión no conteste', async () => {
  const s = globalThis.__sb;
  const v = sitio();
  s.fallas.comp_registrar_tomas.push('red');
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  s.colgarAuth = true;
  s.fallas.comp_estado_tomas.push('vacio'); // obliga a getUser, que no contesta
  const t0 = Date.now();
  const c = await Q.cerrarVisita(EMAIL, v);
  const ms = Date.now() - t0;
  assert.ok(ms < 9500, `tardó ${ms} ms`);
  assert.notEqual(c.tipo, 'listo');
  s.colgarAuth = false;
});

test('27. sin señal, un regreso hecho mientras tanto sí se nota', async () => {
  const s = globalThis.__sb;
  const v = sitio();
  let sinSenal = true;
  s.antesDeRpc = () => (sinSenal ? { data: null, error: RED, status: 0 } : null);
  s.fallas.upload.push('red', 'red', 'red');
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  // La analista la devuelve (¿otra toma del mismo día? da igual: regreso_n cambió).
  s.tomas.get(v.tomas[0].id).regreso_n = 1;
  s.tomas.get(v.tomas[0].id).estado = 'regresada';
  sinSenal = false;
  s.fallas.upload = [];
  const vuelta = await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(registros(s), 0, 'no se registra encima del regreso');
  const avisos = [...vuelta.mensajes, ...Q.tomarAvisosTomasComp(EMAIL)];
  assert.ok(avisos.some((a) => a.tipo === 'regreso'));
});

test('28. «Listo» con una corrida en curso reintenta la foto rechazada y registra', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: [{ pos: 'angulo', n: 2, alcance: 'version', momento: null, etiqueta: 'Ángulo' }] });
  s.fallas.upload.push('rechazo');
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'angulo'));
  await calma();
  assert.equal((await estado(v)).fotos[0].estado, 'fallido');
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'angulo'));
  await esperar(10);
  const pedido = Q.cerrarVisita(EMAIL, v);
  await esperar(10);
  assert.equal((await estado(v)).conError, true, 'el rojo de la rechazada no se apaga por pedir');
  s.frenoSubida = null;
  soltar();
  await pedido;
  await calma();
  assert.equal(ligasDe(s, v.tomas[0].id).length, 2);
  assert.equal(registros(s) >= 1, true);
  assert.equal(s.tomas.get(v.tomas[0].id).estado, 'por_revisar');
});

test('29. Descartar sin señal lo que estaba arriba lo limpia después, sin tocar lo que entró', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  // Foto 1: ligar rechazado (queda 'fallido' arriba, sin fila). Foto 2: entra.
  s.fallas.comp_subir_foto.push('CP002');
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(2), hoja(v, 'corta'));
  await calma();
  const [a1, a2] = r.archivos;
  s.anonimo = true;
  assert.equal(await Q.descartarTomaComp(a1.trabajo), 'ok');
  await calma();
  assert.ok(s.objetos.has(a1.path), 'sigue arriba mientras no hay sesión');
  const aviso = (await Q.listarTomasCompAviso(EMAIL)).find((x) => x.id === a1.trabajo);
  assert.ok(!aviso || !aviso.atencion);
  s.anonimo = false;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.ok(!s.objetos.has(a1.path), 'el archivo sin fila se borró');
  assert.ok(s.evidencias.has(a2.cliente_id), 'lo que entró se queda');
  assert.ok(s.objetos.has(a2.path));
  assert.equal((await Q.listarTomasCompAviso(EMAIL)).length, 0);
});

test('30. si la tarjeta ya no está, el aviso breve sí dice el cierre', async () => {
  const v = sitio();
  const s = globalThis.__sb;
  s.fallas.comp_registrar_tomas.push('red');
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  Q.tomarLogrosTomasComp(EMAIL);
  const c = await Q.cerrarVisita(EMAIL, v, { enPantalla: () => false });
  assert.equal(c.tipo, 'listo');
  const logros = Q.logrosPorMostrarComp(Q.tomarLogrosTomasComp(EMAIL));
  assert.equal(logros.reduce((n, l) => n + l.tomas, 0), 1);
  Q.marcarVisitaVista(EMAIL, v);
  await esperar(2);
  assert.equal(Q.logrosPorMostrarComp(logros).length, 0);
});

test('31. quitar desde la miniatura una foto cuya visita ya se soltó: la cola la limpia con reintento', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await calma();
  // La visita se suelta (Listo) y la foto ya no está en la cola.
  await Q.cerrarVisita(EMAIL, v);
  await calma();
  assert.equal(await estado(v), null);
  const a = r.archivos[0];
  s.fallas.comp_quitar_foto.push('red');
  const q = await Q.quitarFotoComp(EMAIL, v, { cliente_id: a.cliente_id, path: a.path, pos: 'corta', momento: null, tipo: 'foto' });
  assert.equal(q, 'ok');
  await calma();
  assert.equal(s.evidencias.size, 1, 'sin señal sigue');
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.size, 0);
  assert.ok(!s.objetos.has(a.path));
});

test('32. sesión anónima al registrar: no es «faltan», espera la sesión', async () => {
  const s = globalThis.__sb;
  const v = sitio();
  s.fallas.comp_registrar_tomas.push('red');
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  s.anonimo = true;
  const c = await Q.cerrarVisita(EMAIL, v);
  assert.equal(c.tipo, 'enCola');
  assert.equal(registros(s), 0);
  s.anonimo = false;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(registros(s), 1);
});

test('33. la analista la devolvió mientras el registro esperaba la red: no se registra sola', async () => {
  const s = globalThis.__sb;
  const v = sitio();
  s.fallas.comp_registrar_tomas.push('red', 'red');
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  const st = s.tomas.get(v.tomas[0].id);
  st.estado = 'regresada';
  st.regreso_n = 1;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(registros(s), 0);
  const e = await estado(v);
  assert.equal(e.conError, true);
  assert.match(e.ultimoError, /devolvió/);
});

test('34. sin la plantilla completa: las fotos suben y el logro no dice tomas', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'media'));
  await calma();
  assert.equal(registros(s), 0);
  assert.equal(ligasDe(s, v.tomas[0].id).length, 2);
  const logros = Q.tomarLogrosTomasComp(EMAIL);
  assert.ok(logros.length >= 1 && logros.every((l) => l.tomas === 0));
  const e = await estado(v);
  assert.ok(e, 'la visita sigue hoy, esperando la larga');
  assert.equal(e.porSubir, 0);
  assert.equal(await Q.hayTomasCompPendientes(EMAIL), 0, 'al salir no se pierde nada');
});

// ============================================================
// Nuevas (§8, incremento 2)
// ============================================================

test('ligas múltiples: un lateral de alcance sitio se liga a las 3 versiones y las registra', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: LATERAL2, versiones: 3, unidad: 'Biobox' });
  const ids = v.tomas.map((t) => t.id);
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'lateral', ids));
  assert.match(r.archivos[0].path, /^comp\/biobox\//);
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.equal(s.ligas.length, 3);
  assert.equal(registros(s), 0, 'falta el segundo lateral');
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'lateral', ids));
  await calma();
  assert.equal(s.ligas.length, 6);
  assert.equal(registros(s), 1, 'una sola llamada para las 3');
  assert.deepEqual(s.enviadas.sort(), ids.sort());
  assert.equal(s.llamadas.find((x) => x.n === 'comp_registrar_tomas').a.p_toma_ids.length, 3);
});

test('«ya»: la misma foto mandada dos veces no duplica la evidencia', async () => {
  const s = globalThis.__sb;
  s.fallas.comp_subir_foto.push('perdida', 'perdida');
  const v = sitio();
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  const subir = s.llamadas.filter((x) => x.n === 'comp_subir_foto');
  assert.equal(new Set(subir.map((x) => x.a.p_cliente_id)).size, 1, 'siempre el mismo cliente_id');
  assert.equal(s.evidencias.size, 1);
  assert.equal(s.ligas.length, 1);
});

test('cerradas, futuras, ajenas y duplicadas: cada una se avisa una vez y esa toma no se registra', async () => {
  const s = globalThis.__sb;
  const v = sitio({ versiones: 4 });
  const [t1, t2, t3, t4] = v.tomas;
  s.tomas.get(t1.id).estado = 'cancelada';
  s.tomas.get(t2.id).fecha = MANANA; // el servidor ya la ve de mañana
  s.tomas.get(t3.id).monitorista = 'otra@ejemplo.test';
  // t4: la misma foto ya cuenta en otro día de esa campaña.
  s.antesDeRpc = (n, a) => {
    if (n !== 'comp_subir_foto') return null;
    s.antesDeRpc = null;
    const r = s.rpc(n, a);
    r.data.ligadas = r.data.ligadas.filter((x) => x !== t4.id);
    r.data.duplicadas = [t4.id];
    // Una duplicada solo existe para una foto que ya estaba (29-oct-2026:
    // con ya=false la base solo manda en duplicadas lo que va por cámara).
    r.data.ya = true;
    s.ligas = s.ligas.filter((l) => l.toma_id !== t4.id);
    return r;
  };
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'normal', [t1.id, t2.id, t3.id, t4.id]));
  await calma();
  const avisos = Q.tomarAvisosTomasComp(EMAIL).filter((a) => a.tipo === 'info');
  assert.equal(avisos.length, 4);
  assert.ok(avisos.some((a) => /comprobada, cancelada/.test(a.texto)));
  assert.ok(avisos.some((a) => /aún no llega/.test(a.texto)));
  assert.ok(avisos.some((a) => /ya no es tuya/.test(a.texto)));
  assert.ok(avisos.some((a) => /otro día de esa campaña/.test(a.texto)));
  assert.equal(registros(s), 0);
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(Q.tomarAvisosTomasComp(EMAIL).filter((a) => a.tipo === 'info').length, 0, 'no se repiten');
});

test('ocupada, 55P03, 40P01 y 57014: reintento sin atención y sin cortar la vuelta', async () => {
  const s = globalThis.__sb;
  const v1 = sitio();
  const v2 = sitio();
  s.fallas.comp_subir_foto.push('ocupada', '55P03');
  await Q.encolarFotosComp(EMAIL, v1, nuevas(1), hoja(v1));
  await calma();
  let e = await estado(v1);
  assert.equal(e.conError, false);
  assert.ok(e.ultimoError);
  // Sin señal en el navegador conReintento no espera: el 55P03 queda para la vuelta.
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.ligas.length, 0);
  assert.equal((await estado(v1)).conError, false);
  // En la vuelta: v1 vuelve a chocar (40P01) y v2 sí sale en la MISMA vuelta.
  s.fallas.upload.push('red');
  await Q.encolarFotosComp(EMAIL, v2, nuevas(1), hoja(v2));
  await calma();
  s.fallas.comp_subir_foto = ['40P01'];
  s.fallas.comp_registrar_tomas.push('57014');
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(ligasDe(s, v2.tomas[0].id).length, 1, 'la otra visita salió');
  assert.equal((await Q.listarTomasCompAviso(EMAIL)).filter((a) => a.atencion && a.conError).length, 0);
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(ligasDe(s, v1.tomas[0].id).length, 1);
  assert.equal(s.tomas.get(v1.tomas[0].id).estado, 'por_revisar');
  assert.equal(s.tomas.get(v2.tomas[0].id).estado, 'por_revisar');
  assert.ok(Q.esTransitorioComp({ data: { ok: false, codigo: 'ocupada' } }));
  assert.ok(Q.esTransitorioComp({ error: { code: '55P03' }, status: 500 }));
  assert.ok(!Q.esTransitorioComp({ error: { code: 'CP002' }, status: 400 }));
  assert.equal(Q.claseFallaComp({ code: 'CP005' }, 400), 'datos');
});

test('registro automático al completar: cml en tres visitas a la tarjeta, una sola llamada al final', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  for (const pos of ['corta', 'media']) {
    await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, pos));
    await calma();
    assert.equal(registros(s), 0);
  }
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'larga'));
  await calma();
  assert.equal(registros(s), 1);
  assert.equal(s.tomas.get(v.tomas[0].id).estado, 'por_revisar');
  assert.equal(await estado(v), null);
});

test('«Usar también para…»: misma foto y cliente_id a otra versión, en cola y ya soltada', async () => {
  const s = globalThis.__sb;
  const v = sitio({ versiones: 3, plantilla: CML });
  const [t1, t2, t3] = v.tomas;
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [t1.id]));
  await calma();
  const e = await estado(v);
  const f = e.fotos[0];
  assert.equal(await Q.usarTambienPara(EMAIL, v, f, [t2.id]), 'ok');
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.deepEqual(s.ligas.map((l) => l.toma_id).sort(), [t1.id, t2.id].sort());
  // Ya soltada la visita (Listo), con solo la referencia de la foto.
  await Q.cerrarVisita(EMAIL, v);
  await calma();
  assert.equal(await estado(v), null);
  const a = r.archivos[0];
  assert.equal(await Q.usarTambienPara(EMAIL, v, { cliente_id: a.cliente_id, path: a.path, pos: 'corta', momento: null, tipo: 'foto' }, [t3.id]), 'ok');
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.equal(s.ligas.length, 3);
  assert.equal(new Set(s.llamadas.filter((x) => x.n === 'comp_subir_foto').map((x) => x.a.p_cliente_id)).size, 1);
});

test('A1 en el teléfono: dos tomas de la misma campaña o una de mañana no se mandan', async () => {
  const s = globalThis.__sb;
  const v = sitio();
  const otra = { ...v.tomas[0], id: v.tomas[0].id + 50000, fecha: '2000-01-01' };
  const vv = { ...v, tomas: [...v.tomas, otra] };
  const r = await Q.encolarFotosComp(EMAIL, vv, nuevas(1), hoja(vv, 'normal', [v.tomas[0].id, otra.id]));
  assert.equal(r.tipo, 'error');
  assert.match(r.mensaje, /un solo día de cada campaña/);
  const fut = { ...v.tomas[0], id: v.tomas[0].id + 60000, campana_id: 9, fecha: MANANA };
  const r2 = await Q.encolarFotosComp(EMAIL, { ...v, tomas: [fut] }, nuevas(1), { pos: 'normal', momento: null, toma_ids: [fut.id] });
  assert.equal(r2.tipo, 'error');
  assert.match(r2.mensaje, /aún no llega/);
  const r3 = await Q.encolarFotosComp(EMAIL, { ...v, sitio_clave: 'A/B' }, nuevas(1), hoja(v));
  assert.equal(r3.tipo, 'error');
  assert.equal(s.subidas, 0);
});

test('captura cerrada (comp_piloto): pide atención con su texto y sale al abrirse', async () => {
  const s = globalThis.__sb;
  s.piloto = false;
  const v = sitio();
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  const e = await estado(v);
  assert.equal(e.conError, true);
  assert.match(e.ultimoError, /captura aún no está abierta/);
  s.piloto = true;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(registros(s), 1);
});

test('captura cerrada que se abre: al ligar, la atención y su texto se borran (la visita sigue viva)', async () => {
  const s = globalThis.__sb;
  s.piloto = false;
  const v = sitio({ plantilla: CML });
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await calma();
  assert.equal((await estado(v)).conError, true);
  s.piloto = true;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  const e = await estado(v);
  assert.equal(ligasDe(s, v.tomas[0].id).length, 1);
  assert.equal(e.conError, false);
  assert.equal(e.ultimoError, null);
  assert.ok(!(await Q.listarTomasCompAviso(EMAIL)).some((a) => a.atencion), 'sin «sitio sin enviar» con texto viejo');
});

test('un «Sin señal…» que ya se resolvió no se queda pintado mientras la visita sigue abierta', async () => {
  const s = globalThis.__sb;
  s.fallas.upload.push('red');
  const v = sitio({ plantilla: CML });
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await calma();
  let e = await estado(v);
  assert.ok(e.ultimoError);
  assert.equal(e.conError, false);
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  e = await estado(v);
  assert.equal(e.porSubir, 0);
  assert.equal(ligasDe(s, v.tomas[0].id).length, 1);
  assert.equal(e.ultimoError, null);
  assert.ok(!(await Q.listarTomasCompAviso(EMAIL)).some((a) => a.atencion));
  const c = await Q.cerrarVisita(EMAIL, v);
  assert.equal(c.tipo, 'listo');
});

test('un video que no sube (B6, nunca cuenta) no detiene el registro de la toma completa', async () => {
  const s = globalThis.__sb;
  const subir = s.upload;
  s.upload = async (p, f, o) => (p.endsWith('.mp4') ? { error: { name: 'StorageUnknownError', message: 'Load failed' } } : subir(p, f, o));
  const v = sitio();
  const video = { file: new File([new Uint8Array([0, 0, 0, 1])], 'clip.mp4', { type: 'video/mp4' }), origen: 'galeria' };
  const r = await Q.encolarFotosComp(EMAIL, v, [...nuevas(1), video], hoja(v));
  assert.equal(r.tipo, 'ok');
  assert.equal(r.archivos[1].pos, 'extra');
  await calma();
  assert.equal(registros(s), 1);
  assert.equal(s.tomas.get(v.tomas[0].id).estado, 'por_revisar');
  assert.equal((await estado(v)).porSubir, 1, 'el video sigue en el teléfono');
});

test('B4: la foto ya devuelta en esa toma sale duplicada con `ya`: no cuenta, se avisa y no se pide el registro', async () => {
  const s = globalThis.__sb;
  const v = sitio({ estado: 'regresada', regreso_n: 1 });
  const t = v.tomas[0];
  const cid = Q.nuevoClienteId();
  const path = `comp/via-verde/${HOY.slice(0, 7)}/${v.sitio_clave}/${HOY.replace(/-/g, '')}_${cid}.jpg`;
  s.objetos.add(path);
  s.evidencias.set(cid, { id: ++s.evId, cliente_id: cid, path, subido_por: EMAIL, tipo: 'foto', pos: 'normal', momento: null, fecha: HOY });
  s.ligas.push({ evidencia_id: s.evId, toma_id: t.id, campana_id: t.campana_id, regresada_en: 'ayer', revisada: false });
  assert.equal(await Q.usarTambienPara(EMAIL, v, { cliente_id: cid, path, pos: 'normal', momento: null, tipo: 'foto' }, [t.id]), 'ok');
  await calma();
  const e = await estado(v);
  assert.deepEqual(e.fotos[0].ligada_en, []);
  assert.deepEqual(e.fotos[0].no_ligada, [{ toma_id: t.id, razon: 'duplicada', ocupa: true }]);
  assert.equal(registros(s), 0, 'no se pide el registro con una foto que no cuenta');
  assert.ok(Q.tomarAvisosTomasComp(EMAIL).some((a) => /no cuenta para .*devuelto/.test(a.texto)));
  // Quitarla de la visita no intenta desligar la liga devuelta.
  assert.equal(s.llamadas.filter((x) => x.n === 'comp_quitar_foto').length, 0);
});

test('releer la lista a media visita: lo que ya viene en `tiene` (incluidas) no adelanta el registro ni pinta «Falta…»', async () => {
  const s = globalThis.__sb;
  const PL = [UNICA[0], ...LATERAL2];
  const v = sitio({ plantilla: PL });
  const t = v.tomas[0];
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'normal'));
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'lateral'));
  await calma();
  assert.equal(ligasDe(s, t.id).length, 2);
  assert.equal(registros(s), 0);
  const e = await estado(v);
  const incluidas = new Set(e.fotos.map((f) => `${f.cliente_id}|${t.id}`));
  const tiene = [
    { pos: 'normal', momento: null, n: 1 },
    { pos: 'lateral', momento: null, n: 1 },
  ];
  await Q.actualizarVisita(EMAIL, { ...v, tomas: [{ ...t, tiene }], incluidas });
  await calma();
  assert.equal(registros(s), 0, 'sin registro prematuro');
  assert.deepEqual((await estado(v)).faltan, {}, 'sin ámbar a media visita');
  // El segundo lateral sí completa y se registra.
  await Q.encolarFotosComp(EMAIL, { ...v, tomas: [{ ...t, tiene }], incluidas }, nuevas(1), hoja(v, 'lateral'));
  await calma();
  assert.equal(registros(s), 1);
  assert.equal(s.tomas.get(t.id).estado, 'por_revisar');
});

test('sin_objeto: se vuelve a subir con cliente_id y ruta nuevos, sin duplicar', async () => {
  const s = globalThis.__sb;
  s.fallas.comp_subir_foto.push('sin_objeto');
  const v = sitio();
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
  await calma();
  const rutas = Object.keys(s.porRuta);
  assert.equal(rutas.length, 2, 'dos rutas: la original y la nueva');
  assert.ok(rutas.includes(r.archivos[0].path));
  assert.equal(s.evidencias.size, 1);
  assert.equal(registros(s), 1);
});

test('quitar de UNA sola toma: comp_quitar_foto con p_toma_id y la foto sigue en las demás', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: LATERAL2, versiones: 2, unidad: 'Biobox' });
  const ids = v.tomas.map((t) => t.id);
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'lateral', ids));
  await calma();
  const f = (await estado(v)).fotos[0];
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, ids[1]), 'ok');
  await calma();
  assert.deepEqual(s.ligas.map((l) => l.toma_id), [ids[0]]);
  assert.ok(s.llamadas.some((x) => x.n === 'comp_quitar_foto' && x.a.p_toma_id === ids[1]));
  assert.equal(s.evidencias.size, 1);
});

test('píldora y cierre de sesión: cuentan lo que sigue en el teléfono', async () => {
  const s = globalThis.__sb;
  s.fallas.upload.push('red');
  const v = sitio({ plantilla: CML });
  await Q.encolarFotosComp(EMAIL, v, nuevas(3), hoja(v, 'corta'));
  await calma();
  assert.equal(await Q.fotosPendientesComp(EMAIL), 3);
  assert.ok((await Q.hayTomasCompPendientes(EMAIL)) >= 3);
  const files = await Q.archivosParaGuardar(EMAIL, v);
  assert.deepEqual(
    files.map((f) => f.name),
    [1, 2, 3].map((n) => `${v.sitio_clave}_${HOY.slice(8, 10)}${HOY.slice(5, 7)}_${n}.jpg`)
  );
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(await Q.fotosPendientesComp(EMAIL), 0);
});

test('Pauta intacta: la cola usa su propia base y su canal', () => {
  assert.equal(Q.BASE_COMP, 'gpo-tomas-comp');
  assert.equal(Q.CANAL_COMP, 'gpo-tomas-comp');
  assert.equal(Q.CANDADO_COMP, 'compt-');
  assert.equal(Q.CANDADO_REGISTRO_COMP, 'compt-registro-');
  assert.ok(globalThis.__idb['gpo-tomas-comp']);
  assert.equal(globalThis.__idb['gpo-tomas'], undefined);
  for (const t of globalThis.__idb['gpo-tomas-comp'].stores.trabajos.values()) {
    assert.equal(t.tipo, 'comp');
    assert.equal(t.v, 1);
  }
});

test('sin IndexedDB: la visita vive en memoria, lo avisa y aun así sube', async () => {
  const s = globalThis.__sb;
  const db = globalThis.__idb['gpo-tomas-comp'];
  db.falla = true;
  try {
    const v = sitio();
    const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
    assert.equal(r.tipo, 'ok');
    assert.equal(r.fueraDelTelefono, 1);
    await calma();
    assert.equal(s.ligas.length, 1);
    assert.equal(registros(s), 1);
  } finally {
    db.falla = false;
  }
});

test('índice en memoria con 500 visitas: sin getAll por operación', async () => {
  const s = globalThis.__sb;
  s.sesion = null; // sin sesión: todo se queda en el teléfono
  const db = globalThis.__idb['gpo-tomas-comp'];
  // Que el índice ya esté cargado (lo cargó cualquier prueba anterior o esta lectura).
  await Q.estadoVisitas(EMAIL);
  const antes = db.getAll;
  const t0 = Date.now();
  const visitas = [];
  for (let i = 0; i < 500; i++) {
    const v = sitio();
    visitas.push(v);
    const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v));
    assert.equal(r.tipo, 'ok');
  }
  await calma();
  const m = await Q.estadoVisitas(EMAIL);
  assert.equal(m.size, 500);
  assert.equal(await Q.fotosPendientesComp(EMAIL), 500);
  assert.ok(await Q.estadoVisita(EMAIL, visitas[250]));
  const ms = Date.now() - t0;
  assert.equal(db.getAll - antes, 0, 'ningún getAll mientras se encolan y se leen 500 visitas');
  assert.ok(ms < 20000, `tardó ${ms} ms`);
});

// ============================================================
// Revisión adversarial del 26-oct-2026
// ============================================================

/** Dos versiones: la primera solo pide un lateral (sitio); la segunda, además, su Toma. */
function sitioTecateSuburbia() {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: [{ pos: 'lateral', n: 1, alcance: 'sitio', momento: null, etiqueta: 'Lateral' }], versiones: 2, unidad: 'Biobox' });
  const PL2 = [UNICA[0], { pos: 'lateral', n: 1, alcance: 'sitio', momento: null, etiqueta: 'Lateral' }];
  v.tomas[0].campana = 'Tecate';
  v.tomas[0].version = 'V2';
  v.tomas[1].campana = 'Suburbia';
  v.tomas[1].plantilla = PL2;
  s.tomas.get(v.tomas[1].id).plantilla = PL2;
  return v;
}

test('quitar entera una foto cuya toma ya se envió: se queda ahí, se quita de la abierta y sigue a la vista', async () => {
  const s = globalThis.__sb;
  const v = sitioTecateSuburbia();
  const [tecate, suburbia] = v.tomas.map((t) => t.id);
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'lateral', [tecate, suburbia]));
  await calma();
  assert.equal(s.tomas.get(tecate).estado, 'por_revisar', 'Tecate se registró sola');
  assert.equal(ligasDe(s, suburbia).length, 1);
  Q.tomarAvisosTomasComp(EMAIL);
  const antes = Q.quitadasHastaAhora();
  const f = (await estado(v)).fotos[0];
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f), 'ok');
  await calma();
  // La base no dejó quitarla entera (Tecate ya se envió): se quitó de Suburbia con p_toma_id.
  const quitar = s.llamadas.filter((x) => x.n === 'comp_quitar_foto').map((x) => x.a.p_toma_id);
  assert.deepEqual(quitar, [null, suburbia]);
  assert.deepEqual(s.ligas.map((l) => l.toma_id), [tecate]);
  // La foto sigue en la tarjeta, ligada solo a Tecate; Suburbia ya no la cuenta.
  const e = await estado(v);
  assert.equal(e.fotos.length, 1);
  assert.equal(e.fotos[0].estado, 'ligado');
  assert.deepEqual(e.fotos[0].ligada_en, [tecate]);
  assert.deepEqual(e.retiradas.map((r) => [r.toma_id, r.pendiente]), [[suburbia, false]]);
  // El aviso dice de cuál no se pudo quitar.
  const avisos = Q.tomarAvisosTomasComp(EMAIL).map((a) => a.texto);
  assert.ok(avisos.some((x) => /se queda en Tecate V2: ya se envió; de las demás se quita/.test(x)), avisos.join(' | '));
  assert.ok(Q.quitadasHastaAhora() > antes, 'el aviso global relee la lista');
  // Suburbia no se registra con la foto equivocada.
  assert.equal(s.tomas.get(suburbia).estado, 'pendiente');
});

test('quitar entera con la RPC fallando (CP002): la foto no se esconde y se intenta toma por toma', async () => {
  const s = globalThis.__sb;
  const v = sitioTecateSuburbia();
  const [tecate, suburbia] = v.tomas.map((t) => t.id);
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'lateral', [tecate, suburbia]));
  await calma();
  s.fallas.comp_quitar_foto.push('CP002');
  const f = (await estado(v)).fotos[0];
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f), 'ok');
  await calma();
  assert.deepEqual(s.ligas.map((l) => l.toma_id), [tecate]);
  const e = await estado(v);
  assert.equal(e.fotos.length, 1, 'sigue a la vista');
  assert.deepEqual(e.fotos[0].ligada_en, [tecate]);
});

test('después de «Quitar» con la lista ya releída: lo quitado no completa la toma ni pinta «Falta…»', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML });
  const t = v.tomas[0];
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await calma();
  const P = (await estado(v)).fotos[0];
  // La lista se relee: `tiene` ya trae la Corta P.
  const leida = { ...v, tomas: [{ ...t, tiene: [{ pos: 'corta', momento: null, n: 1 }] }], incluidas: new Set([`${P.cliente_id}|${t.id}`]) };
  await Q.actualizarVisita(EMAIL, leida);
  await calma();
  assert.equal(await Q.quitarFotoComp(EMAIL, leida, P), 'ok');
  await calma();
  assert.equal(ligasDe(s, t.id).length, 0, 'P se quitó del servidor');
  await Q.encolarFotosComp(EMAIL, leida, nuevas(1), hoja(v, 'media'));
  await Q.encolarFotosComp(EMAIL, leida, nuevas(1), hoja(v, 'larga'));
  await calma();
  assert.equal(registros(s), 0, 'sin registro con la Corta quitada');
  assert.deepEqual((await estado(v)).faltan, {}, 'sin ámbar a media visita');
});

test('un error de registro que ya se resolvió no deja la visita en «atención» mientras quede otra toma abierta', async () => {
  const s = globalThis.__sb;
  s.fallas.comp_estado_tomas.push('CP002');
  const v = sitio({ versiones: 2 });
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'normal', [v.tomas[0].id]));
  await calma();
  let e = await estado(v);
  assert.equal(e.conError, true);
  assert.match(e.ultimoError, /No se pudo leer el estado/);
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(registros(s), 1);
  assert.equal(s.tomas.get(v.tomas[0].id).estado, 'por_revisar');
  e = await estado(v);
  assert.ok(e, 'la visita sigue viva (la otra toma está abierta)');
  assert.equal(e.conError, false);
  assert.equal(e.ultimoError, null);
  assert.ok(!(await Q.listarTomasCompAviso(EMAIL)).some((a) => a.atencion));
});

// ============================================================
// Foto NUEVA que ninguna toma acepta (comp_subir_foto, 26-oct-2026): la base
// no crea la fila y contesta ya:false, evidencia_id y fecha null, ligadas [].
// ============================================================

/** Un sitio con dos versiones CML: la primera NO acepta la foto (`como`), la segunda queda abierta. */
function sitioPrimeraNoAcepta(como) {
  const s = globalThis.__sb;
  const v = sitio({ versiones: 2, plantilla: CML });
  const t1 = s.tomas.get(v.tomas[0].id);
  if (como === 'ajena') t1.monitorista = 'otra@ejemplo.test';
  else if (como === 'cerrada') t1.estado = 'comprobada';
  return v;
}
const llamadasSubir = (s) => s.llamadas.filter((x) => x.n === 'comp_subir_foto');

test('foto nueva sin ninguna toma que la acepte: sin fila, queda final sin reintentos, avisa «no cuenta» y no es «foto arriba»', async () => {
  const s = globalThis.__sb;
  const v = sitioPrimeraNoAcepta('ajena');
  const [t1] = v.tomas;
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [t1.id]));
  await calma();
  const path = r.archivos[0].path;
  assert.equal(s.evidencias.size, 0, 'la base no creó la fila');
  assert.ok(s.objetos.has(path), 'el objeto se queda suelto');
  const e = await estado(v);
  assert.ok(e, 'la visita sigue (la otra versión está abierta)');
  assert.equal(e.fotos[0].estado, 'ligado', 'estado final');
  assert.equal(e.porSubir, 0);
  assert.deepEqual(e.fotos[0].ligada_en, []);
  assert.deepEqual(e.fotos[0].no_ligada, [{ toma_id: t1.id, razon: 'ajena' }]);
  assert.deepEqual(e.sinEnviar, [{ toma_id: t1.id, razon: 'ajena' }]);
  assert.equal(e.conError, false);
  assert.equal(e.ultimoError, null);
  const avisos = Q.tomarAvisosTomasComp(EMAIL);
  assert.equal(avisos.filter((a) => a.tipo === 'info' && /no cuenta para .*ya no es tuya/.test(a.texto)).length, 1);
  assert.ok(!avisos.some((a) => a.tipo === 'error'), avisos.map((a) => a.texto).join(' | '));
  assert.equal(Q.textoLogroComp(Q.tomarLogrosTomasComp(EMAIL)), '', 'una foto que no cuenta en nada no es «foto arriba»');
  // Otra vuelta no la vuelve a mandar ni a avisar.
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(llamadasSubir(s).length, 1);
  assert.equal(Q.tomarAvisosTomasComp(EMAIL).length, 0);
  assert.equal(registros(s), 0);
});

test('«Usar también para…» de una foto sin fila: la base la crea en esa llamada (ya:false) y la app la cuenta', async () => {
  const s = globalThis.__sb;
  const v = sitioPrimeraNoAcepta('ajena');
  const [t1, t2] = v.tomas;
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [t1.id]));
  await calma();
  Q.tomarAvisosTomasComp(EMAIL);
  Q.tomarLogrosTomasComp(EMAIL);
  const f = (await estado(v)).fotos[0];
  assert.equal(await Q.usarTambienPara(EMAIL, v, f, [t2.id]), 'ok');
  await calma();
  const ultima = llamadasSubir(s).at(-1);
  assert.equal(ultima.a.p_cliente_id, r.archivos[0].cliente_id, 'mismo cliente_id');
  assert.equal(ultima.a.p_path, r.archivos[0].path, 'misma ruta');
  assert.deepEqual(ultima.a.p_toma_ids, [t2.id], 'solo la toma nueva');
  assert.equal(s.evidencias.size, 1, 'ahora sí hay fila');
  assert.equal(ligasDe(s, t2.id).length, 1);
  const e = await estado(v);
  assert.equal(e.fotos[0].estado, 'ligado');
  assert.deepEqual(e.fotos[0].ligada_en, [t2.id]);
  assert.deepEqual(e.fotos[0].no_ligada, [{ toma_id: t1.id, razon: 'ajena' }]);
  assert.deepEqual(e.ligadas[String(t2.id)], [{ pos: 'corta', momento: null, n: 1 }], 'la casilla de Corta sale con ✓');
  assert.equal(e.conError, false);
  assert.match(Q.textoLogroComp(Q.tomarLogrosTomasComp(EMAIL)), /1 foto arriba/, 'ahora sí cuenta, una vez');
  // El aviso de la ajena no se repite.
  assert.ok(!Q.tomarAvisosTomasComp(EMAIL).some((a) => /no cuenta/.test(a.texto)));
  // Un reintento ya contesta «ya» y no duplica.
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.equal(s.ligas.length, 1);
});

test('«Usar también para…» a otro día de la misma campaña cuando el primero estaba cerrado: A1 no lo bloquea', async () => {
  const s = globalThis.__sb;
  const v = sitio({ versiones: 2, plantilla: CML });
  const [t1, t2] = v.tomas;
  // t1: la de ayer de la MISMA campaña que t2, ya comprobada.
  t1.campana_id = t2.campana_id;
  t1.fecha = AYER;
  Object.assign(s.tomas.get(t1.id), { campana_id: t2.campana_id, fecha: AYER, estado: 'comprobada' });
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [t1.id]));
  await calma();
  assert.equal(s.evidencias.size, 0);
  const f = (await estado(v)).fotos[0];
  assert.deepEqual(f.no_ligada, [{ toma_id: t1.id, razon: 'cerrada' }]);
  assert.equal(await Q.usarTambienPara(EMAIL, v, f, [t2.id]), 'ok');
  await calma();
  assert.equal(ligasDe(s, t2.id).length, 1);
  assert.equal(s.evidencias.size, 1);
});

test('«Usar también para…» de una foto sin fila cuyo objeto ya se borró (sin_objeto): termina sin reintentos', async () => {
  const s = globalThis.__sb;
  const v = sitioPrimeraNoAcepta('ajena');
  const [t1, t2] = v.tomas;
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [t1.id]));
  await calma();
  s.objetos.delete(r.archivos[0].path); // la purga (o su dueño) borró el objeto suelto
  const f = (await estado(v)).fotos[0];
  assert.equal(await Q.usarTambienPara(EMAIL, v, f, [t2.id]), 'ok');
  await calma();
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(llamadasSubir(s).length, 2, 'una llamada contestó sin_objeto y no se repite');
  assert.equal(s.subidas, 1, 'sin copia en el teléfono no se vuelve a subir');
  assert.equal(s.evidencias.size, 0);
  assert.equal(ligasDe(s, t2.id).length, 0);
  const e = await estado(v);
  assert.equal(e.fotos[0].estado, 'perdido', 'final: hay que volver a tomarla');
  assert.equal(e.porSubir, 0);
  assert.deepEqual(e.ligadas, {}, 'no pinta ✓ en t2');
});

test('«Quitar» una foto sin fila: comp_quitar_foto contesta ya sin path y la app borra el objeto con su ruta', async () => {
  const s = globalThis.__sb;
  const v = sitioPrimeraNoAcepta('cerrada');
  const [t1] = v.tomas;
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [t1.id]));
  await calma();
  const path = r.archivos[0].path;
  assert.equal(s.evidencias.size, 0);
  assert.ok(s.objetos.has(path));
  const f = (await estado(v)).fotos[0];
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f), 'ok');
  await calma();
  const q = s.llamadas.filter((x) => x.n === 'comp_quitar_foto');
  assert.equal(q.length, 1);
  assert.equal(q[0].a.p_toma_id, null);
  assert.ok(!s.objetos.has(path), 'el objeto suelto se borró');
  const e = await estado(v);
  assert.ok(e, 'la visita sigue (la otra versión está abierta)');
  assert.equal(e.fotos.length, 0);
  assert.equal(e.conError, false);
  assert.deepEqual(e.retiradas, [], 'no descuenta nada: no contaba en ninguna toma');
});


// ============================================================
// Quitar la ÚLTIMA liga de una foto (comp_quitar_foto con p_toma_id,
// 26-oct-2026): la base borra también la fila y contesta borrada + path. La
// foto se queda en la tarjeta sin fila (el monitorista la quitó SOLO de esa
// toma), con su objeto; éste se borra al soltar o descartar la visita.
// ============================================================

/** Foto Corta ligada a la segunda versión (abierta) y ajena en la primera: toma_ids = [abierta, ajena]. */
async function fotoLigadaYAjena() {
  const s = globalThis.__sb;
  const v = sitioPrimeraNoAcepta('ajena');
  const [ajena, abierta] = v.tomas;
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [abierta.id, ajena.id]));
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.equal(ligasDe(s, abierta.id).length, 1);
  const f = (await estado(v)).fotos[0];
  assert.deepEqual(f.ligada_en, [abierta.id]);
  assert.deepEqual(f.no_ligada, [{ toma_id: ajena.id, razon: 'ajena' }]);
  Q.tomarAvisosTomasComp(EMAIL);
  return { s, v, ajena, abierta, f, path: r.archivos[0].path };
}

/** La foto quedó en la tarjeta sin fila: no cuenta en ninguna toma, su objeto sigue y no es lápida. */
async function quedaSinFila(s, v, ajena, path) {
  assert.equal(s.evidencias.size, 0, 'sin fila');
  assert.equal(s.ligas.length, 0);
  assert.ok(s.objetos.has(path), 'el objeto se queda');
  assert.deepEqual(s.borrados, [], 'ni se intenta borrar');
  const e = await estado(v);
  assert.ok(e, 'la visita sigue (la toma abierta sigue abierta)');
  assert.equal(e.fotos.length, 1, 'la foto sigue en la tarjeta');
  assert.equal(e.fotos[0].estado, 'ligado');
  assert.deepEqual(e.fotos[0].toma_ids, [ajena.id]);
  assert.deepEqual(e.fotos[0].ligada_en, [], '«arriba, pero no cuenta en ninguna versión»');
  assert.deepEqual(e.ligadas, {});
  assert.deepEqual(e.lapidas, [], 'no es lápida: su copia de cámara se queda');
  assert.equal(e.conError, false);
  assert.equal(e.ultimoError, null);
  return e;
}

test('«Quitar de A» (ligada a A, ajena en B): la base borra la fila, pero la foto se queda en la tarjeta con su objeto (el monitorista la quitó solo de A)', async () => {
  const { s, v, ajena, abierta, f, path } = await fotoLigadaYAjena();
  const antes = Q.quitadasHastaAhora();
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'ok');
  await calma();
  const q = s.llamadas.filter((x) => x.n === 'comp_quitar_foto');
  assert.deepEqual(q.map((x) => x.a.p_toma_id), [abierta.id], 'va por desligar (dos tomas en la cola)');
  const e = await quedaSinFila(s, v, ajena, path);
  assert.deepEqual(e.retiradas.map((r) => [r.toma_id, r.pendiente]), [[abierta.id, false]], 'la pantalla descuenta lo que ya leyó');
  assert.ok(Q.quitadasHastaAhora() > antes, 'el aviso global relee la lista');
  const avisos = Q.tomarAvisosTomasComp(EMAIL).map((a) => a.texto);
  assert.ok(!avisos.some((x) => /sigue en|se queda en/.test(x)), avisos.join(' | '));
  // Otra vuelta no vuelve a llamar a la base ni a Storage, ni la liga otra vez.
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.llamadas.filter((x) => x.n === 'comp_quitar_foto').length, 1);
  assert.deepEqual(s.borrados, []);
  assert.equal(llamadasSubir(s).length, 1);
  assert.equal(registros(s), 0);
  assert.equal(await Q.hayTomasCompPendientes(EMAIL), 0, 'nada pendiente');
});

test('«Quitar de A» con la respuesta perdida: el reintento contesta ya (sin fila) y la foto se queda igual', async () => {
  const { s, v, ajena, abierta, f, path } = await fotoLigadaYAjena();
  s.fallas.comp_quitar_foto.push('perdida');
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'ok');
  await calma();
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.llamadas.filter((x) => x.n === 'comp_quitar_foto').length, 2);
  const e = await quedaSinFila(s, v, ajena, path);
  assert.deepEqual(e.retiradas.map((r) => [r.toma_id, r.pendiente]), [[abierta.id, false]]);
});

test('«Quitar de A» y luego «Usar también para… C»: ligar vuelve a crear la fila con el mismo objeto (sin volver a tomarla)', async () => {
  const { s, v, abierta, f, path } = await fotoLigadaYAjena();
  const otra = otraTomaAbierta(s, v, abierta);
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'ok');
  await calma();
  assert.equal(s.evidencias.size, 0);
  // La hoja se abrió antes con la foto vieja: igual la encuentra viva.
  assert.equal(await Q.usarTambienPara(EMAIL, v, f, [otra.id]), 'ok');
  await calma();
  assert.ok(s.objetos.has(path), 'el objeto no se borró');
  assert.deepEqual(s.borrados, []);
  assert.equal(s.evidencias.size, 1, 'ligar volvió a crear la fila');
  assert.deepEqual(s.ligas.map((l) => l.toma_id), [otra.id]);
  const ultima = llamadasSubir(s).at(-1);
  assert.equal(ultima.a.p_cliente_id, f.cliente_id, 'mismo cliente_id');
  assert.equal(ultima.a.p_path, path, 'misma ruta');
  const e = await estado(v);
  assert.equal(e.fotos.length, 1);
  assert.deepEqual(e.fotos[0].ligada_en, [otra.id]);
  assert.deepEqual(e.lapidas, []);
  assert.equal(e.conError, false);
});

test('foto sin fila al soltar la visita («Listo con este sitio»): pasa a lápida de la cola y su objeto se borra, con reintento; no es lápida del monitorista', async () => {
  const { s, v, ajena, abierta, f, path } = await fotoLigadaYAjena();
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'ok');
  await calma();
  await quedaSinFila(s, v, ajena, path);
  s.fallas.remove.push('red');
  await Q.cerrarVisita(EMAIL, v);
  await calma();
  assert.ok(s.objetos.has(path), 'la red cortó el borrado del objeto');
  let e = await estado(v);
  assert.ok(e, 'la limpieza sigue pendiente');
  assert.equal(e.fotos.length, 0, 'ya no sale en la tarjeta');
  assert.deepEqual(e.lapidas, [], 'la cola la quitó por su cuenta: la copia de cámara no se saca');
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.ok(!s.objetos.has(path), 'el reintento borró el objeto');
  assert.deepEqual(s.borrados, [path, path]);
  assert.equal(s.llamadas.filter((x) => x.n === 'comp_quitar_foto').length, 1, 'no se vuelve a llamar a la base');
  e = await estado(v);
  assert.equal(e, null, 'la visita se soltó');
});

test('«Descartar» una visita con una foto sin fila que no cuenta en ninguna toma: su objeto se borra (no queda huérfano)', async () => {
  const { s, v, ajena, abierta, f, path } = await fotoLigadaYAjena();
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'ok');
  await calma();
  const e = await quedaSinFila(s, v, ajena, path);
  assert.equal(await Q.descartarTomaComp(e.trabajos[0]), 'ok');
  await calma();
  assert.ok(!s.objetos.has(path), 'el objeto suelto se borró');
  assert.deepEqual(s.borrados, [path]);
  assert.equal(s.evidencias.size, 0);
  assert.equal(await estado(v), null, 'la visita se fue');
  assert.equal(await Q.hayTomasCompPendientes(EMAIL), 0);
});

test('quitar de A su última liga mientras espera ligarse a otra toma: no se borra el objeto y ligar vuelve a crear la fila', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML, versiones: 2 });
  const [t1, t2] = v.tomas;
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [t1.id]));
  await calma();
  const path = r.archivos[0].path;
  const f = (await estado(v)).fotos[0];
  // Sin sesión la cola no corre: «Usar también para…» t2 queda por ligar.
  s.sesion = null;
  assert.equal(await Q.usarTambienPara(EMAIL, v, f, [t2.id]), 'ok');
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, t1.id), 'ok');
  await calma();
  s.sesion = EMAIL;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.deepEqual(s.llamadas.filter((x) => x.n === 'comp_quitar_foto').map((x) => x.a.p_toma_id), [t1.id]);
  assert.ok(s.objetos.has(path), 'el objeto no se borró');
  assert.deepEqual(s.borrados, []);
  assert.equal(s.evidencias.size, 1, 'ligar volvió a crear la fila');
  assert.deepEqual(s.ligas.map((l) => l.toma_id), [t2.id]);
  const e = await estado(v);
  assert.equal(e.fotos.length, 1);
  assert.deepEqual(e.fotos[0].ligada_en, [t2.id]);
});

/** Otra toma abierta del mismo sitio (para «Usar también para…»). */
function otraTomaAbierta(s, v, como) {
  const otra = { id: ++tomaId, campana_id: ++campId, campana: `Campaña ${campId}`, version: 'V1', fecha: HOY, estado: 'pendiente', regreso_n: 0, plantilla: CML, tiene: [] };
  s.tomas.set(otra.id, { ...s.tomas.get(como.id), id: otra.id, campana_id: otra.campana_id });
  v.tomas.push(otra);
  return otra;
}

test('quitar de A su última liga mientras espera ligarse a otra toma que sale ajena: la foto se queda sin fila con su objeto y se borra al soltar la visita', async () => {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML, versiones: 2 });
  const [t1, t2] = v.tomas;
  s.tomas.get(t2.id).monitorista = 'otra@ejemplo.test';
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [t1.id]));
  await calma();
  const path = r.archivos[0].path;
  const f = (await estado(v)).fotos[0];
  s.sesion = null;
  assert.equal(await Q.usarTambienPara(EMAIL, v, f, [t2.id]), 'ok');
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, t1.id), 'ok');
  await calma();
  s.sesion = EMAIL;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.size, 0, 'la otra toma no la aceptó: sin fila');
  assert.ok(s.objetos.has(path), 't1 sigue abierta: el objeto se queda');
  assert.deepEqual(s.borrados, []);
  let e = await estado(v);
  assert.equal(e.fotos.length, 1);
  assert.deepEqual(e.fotos[0].ligada_en, []);
  assert.deepEqual(e.lapidas, []);
  assert.deepEqual(e.retiradas.map((x) => [x.toma_id, x.pendiente]), [[t1.id, false]]);
  assert.equal(e.conError, false);
  assert.equal(await Q.hayTomasCompPendientes(EMAIL), 0);
  await Q.cerrarVisita(EMAIL, v);
  await calma();
  assert.ok(!s.objetos.has(path), 'al soltar la visita el objeto suelto se borró');
  assert.deepEqual(s.borrados, [path]);
  e = await estado(v);
  assert.equal(e, null);
});

test('«Usar también para…» con la hoja abierta mientras la cola ya borra el objeto (al soltar la visita): error claro, sin registro remoto ni «vuelve a tomarla»', async () => {
  const { s, v, abierta, f, path } = await fotoLigadaYAjena();
  const otra = otraTomaAbierta(s, v, abierta);
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'ok');
  await calma();
  // «Listo con este sitio»: la cola la vuelve lápida y empieza a borrar el objeto (Storage no contesta aún).
  let soltar;
  s.frenoRemove = new Promise((r) => (soltar = r));
  const cierre = Q.cerrarVisita(EMAIL, v);
  await calma();
  assert.deepEqual(s.borrados, [path], 'ya empezó a borrar');
  // La hoja conserva la foto vieja (f) y el monitorista confirma otra toma.
  const r = await Q.usarTambienPara(EMAIL, v, f, [otra.id]);
  assert.equal(typeof r, 'object', 'no contesta ok');
  assert.match(r.error, /ya se quitó/);
  s.frenoRemove = null;
  soltar();
  await cierre;
  await calma();
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.ok(!s.objetos.has(path));
  assert.equal(llamadasSubir(s).length, 1, 'no se intentó ligar otra vez');
  assert.equal(s.evidencias.size, 0);
  assert.equal(await estado(v), null, 'no aparece un registro remoto');
  assert.ok(!Q.tomarAvisosTomasComp(EMAIL).some((a) => a.tipo === 'error'));
});

test('«Usar también para…» con la hoja abierta cuando la cola ya la volvió lápida al soltar la visita (la limpieza aún no corre): la foto revive y el objeto no se borra', async () => {
  const { s, v, abierta, f, path } = await fotoLigadaYAjena();
  const otra = otraTomaAbierta(s, v, abierta);
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'ok');
  await calma();
  // Sesión a medio renovar: la cola la vuelve lápida pero la limpieza espera la sesión real.
  s.anonimo = true;
  await Q.cerrarVisita(EMAIL, v);
  await calma();
  assert.ok(s.objetos.has(path), 'la limpieza no ha corrido');
  assert.equal((await estado(v)).fotos.length, 0, 'ya es lápida');
  assert.equal(await Q.usarTambienPara(EMAIL, v, f, [otra.id]), 'ok');
  s.anonimo = false;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.ok(s.objetos.has(path), 'el objeto no se borró');
  assert.deepEqual(s.borrados, []);
  assert.equal(s.evidencias.size, 1, 'ligar volvió a crear la fila');
  assert.deepEqual(s.ligas.map((l) => l.toma_id), [otra.id]);
  const e = await estado(v);
  assert.equal(e.fotos.length, 1);
  assert.equal(e.fotos[0].estado, 'ligado');
  assert.deepEqual(e.fotos[0].ligada_en, [otra.id]);
  assert.deepEqual(e.lapidas, []);
  assert.equal(e.conError, false);
});

test('«Quitar de A» cuando A no contaba (A y B ajenas): la foto se queda y no es lápida', async () => {
  const s = globalThis.__sb;
  // La tercera versión sigue abierta: la visita no se suelta.
  const v = sitio({ plantilla: CML, versiones: 3 });
  const [a, b] = v.tomas;
  s.tomas.get(a.id).monitorista = 'otra@ejemplo.test';
  s.tomas.get(b.id).monitorista = 'otra@ejemplo.test';
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [a.id, b.id]));
  await calma();
  const f = (await estado(v)).fotos[0];
  assert.equal(f.estado, 'ligado');
  assert.deepEqual(f.ligada_en, []);
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, a.id), 'ok');
  await calma();
  const e = await estado(v);
  assert.equal(e.fotos.length, 1, 'la foto sigue en la tarjeta');
  assert.deepEqual(e.fotos[0].toma_ids, [b.id]);
  assert.deepEqual(e.lapidas, [], 'no es lápida: su copia de cámara se queda');
  assert.equal(s.llamadas.filter((x) => x.n === 'comp_quitar_foto').length, 0);
});

test('«Quitar de A» con A ya enviada (B ajena): la base no deja, la foto sigue en A y no es lápida', async () => {
  const { s, v, abierta, f, path } = await fotoLigadaYAjena();
  s.tomas.get(abierta.id).estado = 'por_revisar';
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'ok');
  await calma();
  assert.equal(s.evidencias.size, 1);
  assert.ok(s.objetos.has(path));
  const e = await estado(v);
  assert.equal(e.fotos.length, 1);
  assert.deepEqual(e.fotos[0].ligada_en, [abierta.id], 'sigue contando en A');
  assert.deepEqual(e.lapidas, []);
});

// ============================================================
// «Quitar de A» y en seguida «Usar también para… A» (26-oct-2026): se
// cancela el desligue pendiente; si la RPC ya iba en camino, se vuelve a ligar.
// ============================================================

/** Foto Corta ligada a las dos versiones (dos ligas vivas). */
async function fotoDosLigas() {
  const s = globalThis.__sb;
  const v = sitio({ plantilla: CML, versiones: 2 });
  const [a, b] = v.tomas;
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [a.id, b.id]));
  await calma();
  assert.equal(s.ligas.length, 2);
  return { s, v, abierta: a, otra: b, f: (await estado(v)).fotos[0], path: r.archivos[0].path };
}

for (const [caso, preparar] of [
  ['su última liga (B ajena)', fotoLigadaYAjena],
  ['dos ligas vivas', fotoDosLigas],
]) {
  test(`«Quitar de A» sin señal y luego «Usar también para… A» (${caso}): la foto sigue en A y no se borra nada`, async () => {
    const { s, v, abierta, path } = await preparar();
    const ligasAntes = s.ligas.map((l) => l.toma_id).sort();
    s.fallas.comp_quitar_foto.push('red');
    const f = (await estado(v)).fotos[0];
    assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'ok');
    await calma();
    assert.equal(s.ligas.length, ligasAntes.length, 'la red cortó el desligue');
    const f2 = (await estado(v)).fotos[0];
    assert.equal(await Q.usarTambienPara(EMAIL, v, f2, [abierta.id]), 'ok');
    await Q.procesarTomasCompPendientes(EMAIL);
    await calma();
    assert.equal(s.llamadas.filter((x) => x.n === 'comp_quitar_foto').length, 1, 'el desligue pendiente se canceló');
    assert.deepEqual(s.ligas.map((l) => l.toma_id).sort(), ligasAntes, 'la liga a A sigue');
    assert.equal(s.evidencias.size, 1);
    assert.ok(s.objetos.has(path));
    assert.deepEqual(s.borrados, []);
    const e = await estado(v);
    assert.equal(e.fotos.length, 1);
    assert.ok(e.fotos[0].ligada_en.includes(abierta.id), 'cuenta en A');
    assert.deepEqual(e.lapidas, []);
    assert.deepEqual(e.retiradas, []);
    assert.equal(e.porSubir, 0);
  });

  test(`«Usar también para… A» con el desligue de A en camino (${caso}): la cola la vuelve a ligar a A con el mismo objeto`, async () => {
    const { s, v, abierta, f, path } = await preparar();
    const ligasAntes = s.ligas.map((l) => l.toma_id).sort();
    let respuesta;
    s.antesDeRpc = (n, a) => {
      if (n !== 'comp_quitar_foto') return null;
      s.antesDeRpc = null;
      s.llamadas.pop();
      return (async () => {
        const f2 = (await estado(v)).fotos[0];
        respuesta = await Q.usarTambienPara(EMAIL, v, f2, [abierta.id]);
        return s.rpc(n, a);
      })();
    };
    assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'ok');
    await calma();
    await Q.procesarTomasCompPendientes(EMAIL);
    await calma();
    assert.equal(respuesta, 'ok');
    assert.equal(s.llamadas.filter((x) => x.n === 'comp_quitar_foto').length, 1);
    assert.deepEqual(s.ligas.map((l) => l.toma_id).sort(), ligasAntes, 'A se volvió a ligar');
    assert.equal(s.evidencias.size, 1);
    assert.ok(s.objetos.has(path), 'el objeto no se borró');
    assert.deepEqual(s.borrados, []);
    assert.equal(llamadasSubir(s).at(-1).a.p_path, path, 'misma ruta');
    const e = await estado(v);
    assert.equal(e.fotos.length, 1);
    assert.equal(e.fotos[0].estado, 'ligado');
    assert.ok(e.fotos[0].ligada_en.includes(abierta.id), 'cuenta en A');
    assert.deepEqual(e.lapidas, []);
  });
}

test('«Quitar de A» con el ligar de A en camino (B ajena, sin fila): la base desliga y borra la fila, pero la foto se queda con su objeto', async () => {
  const s = globalThis.__sb;
  const v = sitioPrimeraNoAcepta('ajena');
  const [b, a] = v.tomas;
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [b.id]));
  await calma();
  const path = r.archivos[0].path;
  assert.equal(s.evidencias.size, 0, 'B no la aceptó: sin fila');
  const f = (await estado(v)).fotos[0];
  let quitar;
  s.antesDeRpc = (n, x) => {
    if (n !== 'comp_subir_foto') return null;
    s.antesDeRpc = null;
    s.llamadas.pop();
    return (async () => {
      const f2 = (await estado(v)).fotos[0];
      quitar = await Q.quitarFotoComp(EMAIL, v, f2, a.id);
      return s.rpc(n, x);
    })();
  };
  assert.equal(await Q.usarTambienPara(EMAIL, v, f, [a.id]), 'ok');
  await calma();
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(quitar, 'ok');
  assert.deepEqual(s.llamadas.filter((x) => x.n === 'comp_quitar_foto').map((x) => x.a.p_toma_id), [a.id], 'la cola desligó A');
  assert.equal(s.evidencias.size, 0);
  assert.ok(s.objetos.has(path), 'el objeto se queda');
  assert.deepEqual(s.borrados, []);
  const e = await estado(v);
  assert.equal(e.fotos.length, 1, 'la foto sigue en la tarjeta');
  assert.deepEqual(e.fotos[0].toma_ids, [b.id]);
  assert.deepEqual(e.fotos[0].ligada_en, []);
  assert.deepEqual(e.lapidas, []);
});

test('«Quitar» entera: mientras la base no contesta es lápida por confirmar; si la base no deja (Tecate enviada), vuelve a la tarjeta y deja de ser lápida', async () => {
  const s = globalThis.__sb;
  const v = sitioTecateSuburbia();
  const [tecate, suburbia] = v.tomas.map((t) => t.id);
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'lateral', [tecate, suburbia]));
  await calma();
  assert.equal(s.tomas.get(tecate).estado, 'por_revisar');
  const f = (await estado(v)).fotos[0];
  s.sesion = null;
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f), 'ok');
  await calma();
  let e = await estado(v);
  assert.equal(e.fotos.length, 0);
  assert.deepEqual(e.lapidas, [{ cliente_id: f.cliente_id, nombre: f.nombre, porConfirmar: true }], 'la copia de cámara todavía no se saca');
  s.sesion = EMAIL;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  e = await estado(v);
  assert.equal(e.fotos.length, 1, 'volvió a la tarjeta');
  assert.deepEqual(e.fotos[0].ligada_en, [tecate]);
  assert.deepEqual(e.lapidas, [], 'no es lápida: su copia de cámara se queda');
});

test('«Quitar» entera que la base sí deja: lápida firme (la copia de cámara ya se puede sacar)', async () => {
  const { v, f } = await fotoLigadaYAjena();
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f), 'ok');
  await calma();
  const e = await estado(v);
  assert.deepEqual(e.lapidas, [{ cliente_id: f.cliente_id, nombre: f.nombre, porConfirmar: false }]);
});

// ============================================================
// Revisión del 27-oct-2026: fotos sin fila desde el principio, descartes con
// un «Quitar de A» pendiente, «Usar también para…» de una foto que ya se
// quitó y lo que la pantalla necesita cuando la visita se suelta enseguida.
// ============================================================

for (const [caso, soltar] of [
  ['«Listo con este sitio»', async (v) => (await Q.cerrarVisita(EMAIL, v)).tipo],
  ['«Descartar»', async (v) => Q.descartarTomaComp((await estado(v)).trabajos[0])],
]) {
  test(`foto nueva que ninguna toma aceptó (sin fila desde el principio) y ${caso}: su objeto se borra, no queda huérfano`, async () => {
    const s = globalThis.__sb;
    const v = sitioPrimeraNoAcepta('ajena');
    const [t1] = v.tomas;
    const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [t1.id]));
    await calma();
    const path = r.archivos[0].path;
    assert.equal(s.evidencias.size, 0, 'la base no creó la fila');
    assert.ok(s.objetos.has(path), 'el objeto queda suelto mientras la visita sigue');
    assert.deepEqual(s.borrados, []);
    assert.ok(['listo', 'ok'].includes(await soltar(v)));
    await calma();
    await Q.procesarTomasCompPendientes(EMAIL);
    await calma();
    assert.ok(!s.objetos.has(path), 'el objeto suelto se borró');
    assert.deepEqual(s.borrados, [path]);
    assert.equal(s.llamadas.filter((x) => x.n === 'comp_quitar_foto').length, 0, 'no hay fila que quitar');
    assert.equal(await estado(v), null, 'la visita se fue');
    assert.equal(await Q.hayTomasCompPendientes(EMAIL), 0);
  });
}

test('foto nueva sin fila desde el principio: «Usar también para…» la revive mientras la cola no empiece a borrar su objeto', async () => {
  const s = globalThis.__sb;
  const v = sitioPrimeraNoAcepta('ajena');
  const [t1, t2] = v.tomas;
  const r = await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta', [t1.id]));
  await calma();
  const path = r.archivos[0].path;
  const f = (await estado(v)).fotos[0];
  // «Listo» con la sesión a medio renovar: la vuelve lápida y la limpieza espera.
  s.anonimo = true;
  await Q.cerrarVisita(EMAIL, v);
  await calma();
  assert.equal((await estado(v)).fotos.length, 0, 'ya es lápida');
  assert.equal(await Q.usarTambienPara(EMAIL, v, f, [t2.id]), 'ok');
  s.anonimo = false;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.ok(s.objetos.has(path), 'el objeto no se borró');
  assert.deepEqual(s.borrados, []);
  assert.equal(ligasDe(s, t2.id).length, 1, 'ligar creó la fila con el mismo objeto');
});

test('«Descartar» con un «Quitar de A» pendiente en una foto que aún espera ligarse a otra toma (subida): la cola la desliga de A antes de soltarla', async () => {
  const { s, v, abierta: a, otra: b, path } = await fotoDosLigas();
  const c = otraTomaAbierta(s, v, a);
  // Sin señal: «Usar también para… C» (vuelve a 'subido') y luego «Quitar de A».
  s.sesion = null;
  assert.equal(await Q.usarTambienPara(EMAIL, v, (await estado(v)).fotos[0], [c.id]), 'ok');
  assert.equal(await Q.quitarFotoComp(EMAIL, v, (await estado(v)).fotos[0], a.id), 'ok');
  await calma();
  let e = await estado(v);
  assert.equal(e.fotos[0].estado, 'subido', 'C sigue por ligar');
  assert.equal(await Q.descartarTomaComp(e.trabajos[0]), 'ok');
  await calma();
  e = await estado(v);
  assert.ok(e, 'el desligue queda pendiente');
  assert.ok(
    e.retiradas.some((x) => x.toma_id === a.id && x.pendiente),
    'A sigue descontada mientras la base no contesta (no vuelve a salir con ✓)'
  );
  assert.deepEqual(e.lapidas, [], 'no es lápida: la foto sigue en B (su copia de cámara se queda)');
  s.sesion = EMAIL;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.deepEqual(
    s.llamadas.filter((x) => x.n === 'comp_quitar_foto').map((x) => x.a.p_toma_id),
    [a.id],
    'la cola la desligó de A'
  );
  assert.deepEqual(s.ligas.map((l) => l.toma_id), [b.id], 'ya no está en A; en B se queda');
  assert.equal(ligasDe(s, c.id).length, 0, 'lo descartado ya no se liga');
  assert.ok(s.objetos.has(path), 'B la usa');
  assert.equal(await estado(v), null, 'la visita se soltó');
});

test('«Usar también para…» de una foto que ya se quitó entera (otra pestaña, sin señal): error claro, sin registro remoto ni «vuelve a tomarla»', async () => {
  const { s, v, abierta, f, path } = await fotoDosLigas();
  const otra = otraTomaAbierta(s, v, abierta);
  s.sesion = null;
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f), 'ok');
  await calma();
  // La hoja de la otra pestaña conserva la foto vieja (f).
  const r = await Q.usarTambienPara(EMAIL, v, f, [otra.id]);
  assert.equal(typeof r, 'object', 'no contesta ok');
  assert.match(r.error, /ya se quitó/);
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'no-estaba', '«Quitar de A» de una lápida no crea otra limpieza');
  s.sesion = EMAIL;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(llamadasSubir(s).length, 1, 'no se intentó ligar otra vez');
  assert.equal(s.llamadas.filter((x) => x.n === 'comp_quitar_foto').length, 1);
  assert.equal(s.evidencias.size, 0);
  assert.ok(!s.objetos.has(path));
  const e = await estado(v);
  assert.equal(e.fotos.length, 0);
  assert.equal(e.conError, false);
  assert.ok(!Q.tomarAvisosTomasComp(EMAIL).some((a) => a.tipo === 'error'));
});

test('«Usar también para…» con la hoja abierta cuando la visita ya se soltó y la cola borró el objeto de la foto sin fila: el registro remoto termina sin «vuelve a tomarla» ni atención', async () => {
  const { s, v, abierta, f, path } = await fotoLigadaYAjena();
  const otra = otraTomaAbierta(s, v, abierta);
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f, abierta.id), 'ok');
  await calma();
  // La cola todavía no conoce `otra`: al cerrar se suelta, borra el objeto y el trabajo.
  await Q.cerrarVisita(EMAIL, { ...v, tomas: v.tomas.filter((x) => x.id !== otra.id) });
  await calma();
  assert.ok(!s.objetos.has(path));
  assert.equal(await estado(v), null);
  Q.tomarAvisosTomasComp(EMAIL);
  // La hoja conserva la foto vieja (f): ya no la encuentra en la cola.
  assert.equal(await Q.usarTambienPara(EMAIL, v, f, [otra.id]), 'ok');
  await calma();
  const vuelta = await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.equal(llamadasSubir(s).length, 2, 'el registro remoto preguntó una vez (sin_objeto) y no se repite');
  assert.equal(s.evidencias.size, 0);
  const e = await estado(v);
  assert.ok(!e || (e.fotos.length === 0 && !e.conError && e.ultimoError === null), JSON.stringify(e));
  assert.ok(!(await Q.listarTomasCompAviso(EMAIL)).some((x) => x.atencion), 'el aviso global no pide atención');
  const avisos = [...vuelta.mensajes, ...Q.tomarAvisosTomasComp(EMAIL)];
  assert.ok(!avisos.some((a) => a.tipo === 'error'), avisos.map((a) => a.texto).join(' | '));
  assert.ok(avisos.some((a) => a.tipo === 'info' && /ya se quitó del servidor/.test(a.texto)), avisos.map((a) => a.texto).join(' | '));
});

test('«Quitar» entera confirmada en la misma corrida en que la visita se suelta: la cola recuerda que de verdad se quitó (para sacar la copia de cámara)', async () => {
  const { s, v, f, path } = await fotoLigadaYAjena();
  s.sesion = null;
  assert.equal((await Q.cerrarVisita(EMAIL, v)).tipo, 'enCola');
  assert.equal(await Q.quitarFotoComp(EMAIL, v, f), 'ok');
  await calma();
  assert.ok(!Q.fotosQuitadasDeVerdad().has(f.cliente_id), 'la base todavía no contesta');
  s.sesion = EMAIL;
  await Q.procesarTomasCompPendientes(EMAIL);
  await calma();
  assert.ok(!s.objetos.has(path));
  assert.equal(await estado(v), null, 'la visita se soltó en la misma corrida');
  assert.ok(Q.fotosQuitadasDeVerdad().has(f.cliente_id));
  // Una foto que nunca llegó al servidor se quita al momento.
  const v2 = sitio();
  s.sesion = null;
  await Q.encolarFotosComp(EMAIL, v2, nuevas(1), hoja(v2));
  await calma();
  const g = (await estado(v2)).fotos[0];
  assert.equal(g.estado, 'local');
  assert.equal(await Q.quitarFotoComp(EMAIL, v2, g), 'ok');
  assert.ok(Q.fotosQuitadasDeVerdad().has(g.cliente_id));
});

// ============================================================
// Incremento 3 (comp_f3_revision, 29-oct-2026): posición por cámara
// ============================================================

test('mixto con la lista vieja del teléfono: la Corta sale «por cámara» (no «toma otra») y la toma se registra con Media y Larga', async () => {
  const s = globalThis.__sb;
  // La pantalla leyó la lista ANTES de que el Supervisor pasara la campaña a
  // mixto: todavía pide Corta, Media y Larga.
  const v = sitio({ plantilla: CML });
  const t = v.tomas[0];
  // El servidor ya la ve en mixto: la Corta la sube la analista.
  const st = s.tomas.get(t.id);
  st.plantilla = CML.filter((q) => q.pos !== 'corta');
  st.por_camara = ['corta'];
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'corta'));
  await calma();
  const avisos = Q.tomarAvisosTomasComp(EMAIL).filter((a) => a.tipo === 'info');
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].texto, /no cuenta para .*: esa foto la sube la analista desde cámaras \(no tienes que tomarla\)/);
  assert.doesNotMatch(avisos[0].texto, /toma otra/);
  let e = await estado(v);
  assert.deepEqual(e.fotos[0].no_ligada, [{ toma_id: t.id, razon: 'por_camara' }]);
  assert.deepEqual(e.sinEnviar, [], 'la toma sigue abierta');
  assert.equal(registros(s), 0);
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'media'));
  await Q.encolarFotosComp(EMAIL, v, nuevas(1), hoja(v, 'larga'));
  await calma();
  assert.equal(registros(s), 1, 'se registró sola sin esperar la Corta');
  assert.equal(s.tomas.get(t.id).estado, 'por_revisar');
  assert.equal(ligasDe(s, t.id).length, 2);
});
