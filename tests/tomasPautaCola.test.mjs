// ============================================================
// tests/tomasPautaCola.test.mjs
// La cola de tomas de Pauta (lib/tomasPauta.ts) de punta a punta, en modo
// memoria (Node no tiene IndexedDB: la cola cae a memoria, como en Safari
// privado) y con Supabase simulado. Fase 1 de comprobaciones, 22-oct-2026.
//
// Cubre lo que pidió la revisión del diseño: registrar solo con todo ligado
// y una sola vez, "ya existe" = subida, INSERT cuya respuesta se perdió sin
// duplicar, toma comprobada mientras subía, la foto que llega a media
// corrida, quitar una foto en cola, el mínimo y la sesión anónima.
//
// Correr: node --test tests/*.test.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// --- Supabase simulado: delega en globalThis.__sb (cada prueba lo arma) ---
const SB = `
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.lim = null; this.row = null; this.cols = null; }
  select(c) { if (this.op !== 'delete' && this.op !== 'insert') this.op = 'select'; this.cols = c; return this; }
  eq(c, v) { this.f.push((r) => r[c] === v); return this; }
  is(c, v) { this.f.push((r) => (r[c] ?? null) === v); return this; }
  limit(n) { this.lim = n; return this; }
  abortSignal() { return this; }
  retry() { return this; }
  insert(row) { this.op = 'insert'; this.row = row; return this; }
  delete() { this.op = 'delete'; return this; }
  then(ok, ko) { return Promise.resolve().then(() => globalThis.__sb.query(this)).then(ok, ko); }
}
class R {
  constructor(n, a) { this.n = n; this.a = a; }
  abortSignal() { return this; }
  then(ok, ko) { return Promise.resolve().then(() => globalThis.__sb.rpc(this.n, this.a)).then(ok, ko); }
}
export const sb = {
  from: (t) => new Q(t),
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

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/tomasPauta.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  plugins: [
    {
      name: 'simulados',
      setup(b) {
        b.onResolve({ filter: /^\.\/(supabase|reportarError|cargaDiferida)$/ }, (a) => ({ path: a.path, namespace: 'sim' }));
        b.onLoad({ filter: /.*/, namespace: 'sim' }, (a) => ({
          contents:
            a.path === './supabase'
              ? SB
              : a.path === './reportarError'
                ? 'export function reportarError() {}'
                : 'export function retenerRecargaAutomatica() { return () => {}; }',
          loader: 'js',
        }));
      },
    },
  ],
});
// En Node un BroadcastChannel con oyente mantiene vivo el proceso y la
// prueba no terminaría: las colas solo lo crean si existe.
globalThis.BroadcastChannel = undefined;
// Los topes largos (la subida espera hasta ~60 s) no deben retener el
// proceso al terminar: se sueltan (unref) los de más de 5 s.
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

const EMAIL = 'moni@gpovallas.com';
let caraN = 0;
/** Una cara distinta por prueba: la cola es de módulo y no se reinicia. */
function nuevaCara() {
  caraN++;
  return {
    anio: 2026,
    catorcena: 22,
    vfid: `MX_CM_EV_EVA_0${caraN}_3325`,
    site_id: 'MX_CM_EV_3325',
    cara: String(caraN),
    campana: 'SPIDERMAN',
  };
}

const RED = { message: 'Load failed' };

/** Base simulada: evidencias, monitoreo, objetos y fallas programables. */
function servidor(op = {}) {
  const s = {
    sesion: EMAIL,
    evidencias: [],
    monitoreo: [],
    objetos: new Set(),
    rpcs: [],
    subidas: 0,
    inserts: 0,
    fallas: { upload: [], insert: [], rpc: [], delete: [] },
    // Promesa que la subida espera (para simular una subida lenta).
    frenoSubida: null,
    // Promesa que storage.remove espera (un fetch que no contesta).
    frenoRemove: null,
    // Subidas por ruta (para ver si una foto se vuelve a subir).
    porRuta: {},
    // Gancho por consulta: si devuelve algo, ésa es la respuesta.
    antesDeConsulta: null,
    ...op,
  };
  s.query = (q) => {
    const o = s.antesDeConsulta?.(q);
    if (o) return o;
    // Sesión anónima: la RLS contesta [] sin error (también al borrar).
    const anon = !s.sesion || s.anonimo;
    if (q.t === 'pauta_monitoreo') {
      if (anon) return { data: [], error: null, status: 200 };
      const rs = s.monitoreo.filter((r) => q.f.every((f) => f(r)));
      return { data: rs.slice(0, q.lim ?? rs.length), error: null, status: 200 };
    }
    if (q.t === 'pauta_evidencias') {
      if (q.op === 'insert') {
        s.inserts++;
        const falla = s.fallas.insert.shift();
        const m = s.monitoreo.find((r) => r.vendor_face_id === q.row.vendor_face_id);
        if (m?.fecha_comprobacion)
          return { data: null, error: { code: 'P0001', message: 'Esta toma ya está comprobada: no se le pueden agregar fotos.' }, status: 400 };
        if (falla === 'perdida') {
          // Entró, pero la respuesta no llegó.
          s.evidencias.push({ id: s.evidencias.length + 1, regresada_en: null, ...q.row });
          return { data: null, error: RED, status: 0 };
        }
        if (falla === 'red') return { data: null, error: RED, status: 0 };
        if (falla === 'rechazo')
          return { data: null, error: { code: '23514', message: 'viola una restricción' }, status: 400 };
        s.evidencias.push({ id: s.evidencias.length + 1, regresada_en: null, ...q.row });
        return { data: null, error: null, status: 201 };
      }
      if (q.op === 'delete') {
        if (s.fallas.delete.shift() === 'red') return { data: null, error: RED, status: 0 };
        if (anon) return { data: [], error: null, status: 200 };
        const quedan = [];
        const borradas = [];
        for (const r of s.evidencias) (q.f.every((f) => f(r)) ? borradas : quedan).push(r);
        s.evidencias = quedan;
        return { data: borradas.map((r) => ({ id: r.id })), error: null, status: 200 };
      }
      // Sesión anónima: la RLS contesta [] sin error.
      if (!s.sesion || s.anonimo) return { data: [], error: null, status: 200 };
      const rs = s.evidencias.filter((r) => q.f.every((f) => f(r)));
      return { data: rs.slice(0, q.lim ?? rs.length), error: null, status: 200 };
    }
    throw new Error('tabla inesperada ' + q.t);
  };
  s.rpc = (n, a) => {
    const falla = s.fallas.rpc.shift();
    if (falla === 'red') return { data: null, error: RED, status: 0 };
    s.rpcs.push({ n, a });
    let m = s.monitoreo.find((r) => r.vendor_face_id === a.p_vendor_face_id);
    if (!m) {
      m = { anio: a.p_anio, catorcena: a.p_catorcena, vendor_face_id: a.p_vendor_face_id, fecha_toma: null, fecha_comprobacion: null, fecha_rechazo: null };
      s.monitoreo.push(m);
    }
    if (!m.fecha_toma) m.fecha_toma = new Date().toISOString();
    return { data: null, error: null, status: 200 };
  };
  s.upload = async (p) => {
    s.subidas++;
    s.porRuta[p] = (s.porRuta[p] || 0) + 1;
    if (s.frenoSubida) await s.frenoSubida;
    const falla = s.fallas.upload.shift();
    if (falla === 'red') return { error: { name: 'StorageUnknownError', message: 'Load failed' } };
    if (s.objetos.has(p)) return { error: { status: 400, statusCode: '409', message: 'The resource already exists' } };
    s.objetos.add(p);
    return { error: null };
  };
  s.remove = async (ps) => {
    if (s.frenoRemove) await s.frenoRemove;
    ps.forEach((p) => s.objetos.delete(p));
    return { error: null };
  };
  globalThis.__sb = s;
  return s;
}

/** Cada prueba empieza con la cola vacía (la cola es de módulo). */
async function limpiar() {
  for (const a of await Q.listarTomasAviso(EMAIL)) await Q.descartarToma(a.id);
  Q.tomarLogrosTomas(EMAIL);
  Q.tomarAvisosTomas(EMAIL);
}
test.beforeEach(async () => {
  servidor();
  await limpiar();
});

const foto = (i) => new File([new Uint8Array([0xff, 0xd8, i])], 'image.jpg', { type: 'image/jpeg' });
const nuevos = (n) => Array.from({ length: n }, (_, i) => ({ file: foto(i), origen: 'camara' }));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
/** Espera a que la cola se calme (las corridas lanzadas en segundo plano). */
async function calma() {
  for (let i = 0; i < 50; i++) {
    await esperar(5);
  }
}

test('3 fotos + registrar: suben, se ligan y se registra UNA vez', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  const r = await Q.encolarFotos(EMAIL, ctx, nuevos(3), 'toma larga');
  assert.equal(r.tipo, 'ok');
  assert.equal(r.archivos.length, 3);
  assert.equal(new Set(r.archivos.map((a) => a.path)).size, 3);
  const reg = await Q.pedirRegistro(EMAIL, ctx, 3);
  assert.equal(reg.tipo, 'registrada');
  await calma();
  assert.equal(s.evidencias.length, 3);
  assert.equal(s.objetos.size, 3);
  assert.equal(s.rpcs.length, 1);
  assert.deepEqual(s.evidencias.map((e) => e.referencia), ['toma larga', 'toma larga', 'toma larga']);
  assert.equal((await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid)).length, 0);
  // El monitorista lo vio registrarse en pantalla: el aviso breve no lo repite.
  assert.ok(!Q.tomarLogrosTomas(EMAIL).some((l) => l.cara === ctx.cara && l.site_id === ctx.site_id));
  assert.ok(Q.tomasRegistradasEnSesion(EMAIL).some((x) => x.vfid === ctx.vfid && x.fotos === 3));
});

test('el registro termina después de cerrar la pantalla: el aviso breve sí lo dice', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  await Q.encolarFotos(EMAIL, ctx, nuevos(3), null);
  // La subida tarda más que la espera de pedirRegistro (8 s): queda en cola.
  const reg = await Q.pedirRegistro(EMAIL, ctx, 3);
  assert.equal(reg.tipo, 'enCola');
  soltar();
  await calma();
  assert.equal(s.rpcs.length, 1);
  const logros = Q.tomarLogrosTomas(EMAIL);
  assert.ok(logros.some((l) => l.registrada && l.fotos === 3 && l.cara === ctx.cara));
});

test('sin red al subir: queda en cola y al volver sale sin duplicar', async () => {
  const s = servidor();
  s.fallas.upload.push('red');
  const ctx = nuevaCara();
  await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  let ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].archivos[0].estado, 'local');
  assert.ok(ts[0].ultimoError);
  assert.equal(ts[0].conError, false);
  // Vuelve la red: la vuelta del aviso global la manda.
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 1);
  ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts.length, 0);
});

test('"ya existe" en Storage cuenta como subida', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  // Una corrida anterior la subió y se perdió la respuesta: el objeto ya está.
  s.upload = async (p) => {
    s.subidas++;
    s.objetos.add(p);
    return { error: { status: 400, statusCode: '409', message: 'The resource already exists' } };
  };
  await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 1);
});

test('el INSERT entró pero se perdió la respuesta: no se duplica', async () => {
  const s = servidor();
  s.fallas.insert.push('perdida');
  const ctx = nuevaCara();
  await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  let ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts[0].archivos[0].estado, 'ligando');
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 1);
  ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts.length, 0);
});

test('toma comprobada: no sube lo que falta (sin huérfanos) y lo deja con aviso', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  s.monitoreo.push({ anio: 2026, catorcena: 22, vendor_face_id: ctx.vfid, fecha_toma: '2026-10-22 10:00:00+00', fecha_comprobacion: '2026-10-22 11:00:00+00', fecha_rechazo: null });
  await Q.encolarFotos(EMAIL, ctx, nuevos(2), null);
  await calma();
  assert.equal(s.subidas, 0);
  assert.equal(s.evidencias.length, 0);
  const ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].conError, true);
  assert.match(ts[0].ultimoError, /comprobó/);
  const avisos = await Q.listarTomasAviso(EMAIL);
  assert.ok(avisos.find((a) => a.id === ts[0].id).atencion);
  assert.equal(await Q.descartarToma(ts[0].id), 'ok');
  assert.equal((await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid)).length, 0);
});

test('se comprueba mientras sube: no se inserta; el objeto se queda hasta descartar', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await esperar(10);
  // El analista comprueba mientras la foto sube.
  s.monitoreo.push({ anio: 2026, catorcena: 22, vendor_face_id: ctx.vfid, fecha_toma: 'x', fecha_comprobacion: '2026-10-22 11:00:00+00', fecha_rechazo: null });
  soltar();
  await calma();
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 0);
  // El objeto NO se borra mientras exista el trabajo: si después la toma se
  // des-comprueba, la cola no debe insertar una fila sin archivo.
  assert.equal([...s.objetos].filter((p) => p.includes(ctx.vfid)).length, 1);
  const ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts[0].conError, true);
  // Descartar limpia el objeto que no tiene fila.
  assert.equal(await Q.descartarToma(ts[0].id), 'ok');
  await calma();
  assert.equal([...s.objetos].filter((p) => p.includes(ctx.vfid)).length, 0);
});

test('una foto que llega a media corrida sale en la misma y el trabajo no se cierra antes', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await esperar(10);
  // Mientras la 1.ª sube, el monitorista toma la 2.ª y pide registrar.
  const segunda = Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  s.frenoSubida = null;
  soltar();
  const r2 = await segunda;
  assert.equal(r2.tipo, 'ok');
  const reg = await Q.pedirRegistro(EMAIL, ctx, 2);
  assert.equal(reg.tipo, 'registrada');
  await calma();
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 2);
  assert.equal(s.rpcs.filter((x) => x.a.p_vendor_face_id === ctx.vfid).length, 1);
  assert.equal((await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid)).length, 0);
});

test('dos "Registrar" casi juntos: una sola llamada a registrar_toma', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  await Q.encolarFotos(EMAIL, ctx, nuevos(3), null);
  await calma();
  const [a, b] = await Promise.all([Q.pedirRegistro(EMAIL, ctx, 3), Q.pedirRegistro(EMAIL, ctx, 3)]);
  assert.equal(a.tipo, 'registrada');
  assert.equal(b.tipo, 'registrada');
  await calma();
  assert.equal(s.rpcs.filter((x) => x.a.p_vendor_face_id === ctx.vfid).length, 1);
});

test('faltan fotos para el mínimo: no se registra y lo dice', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  await Q.encolarFotos(EMAIL, ctx, nuevos(2), null);
  const reg = await Q.pedirRegistro(EMAIL, ctx, 9);
  assert.equal(reg.tipo, 'error');
  assert.match(reg.mensaje, /Faltan 7 fotos/);
  await calma();
  assert.equal(s.rpcs.filter((x) => x.a.p_vendor_face_id === ctx.vfid).length, 0);
  // Una foto nueva limpia el error (se vuelve a evaluar).
  await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  const ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.ok(ts.length <= 1);
});

test('quitar una foto en cola: no sube y el trabajo cierra sin ella', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  const r = await Q.encolarFotos(EMAIL, ctx, nuevos(2), null);
  await esperar(10);
  // La 1.ª está subiendo; la 2.ª sigue en el teléfono: se quita.
  const segunda = r.archivos[1];
  assert.equal(await Q.quitarArchivo(segunda.trabajo, segunda.fid), 'ok');
  s.frenoSubida = null;
  soltar();
  await calma();
  const mias = s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid);
  assert.equal(mias.length, 1);
  assert.equal(mias[0].path, r.archivos[0].path);
  assert.ok(![...s.objetos].includes(segunda.path));
  assert.equal((await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid)).length, 0);
});

test('INSERT con respuesta perdida y el teléfono "en línea": consulta antes de reintentar', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  // Con onLine=true conReintento sí reintenta (1.5 s): antes duplicaba la fila.
  Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
  try {
    s.fallas.insert.push('perdida');
    await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
    for (let i = 0; i < 40 && (await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid)).length; i++)
      await esperar(100);
    assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 1);
    assert.equal(s.inserts, 1);
  } finally {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  }
});

test('el servidor rechaza la foto: se conserva, avisa, y sube en la vuelta siguiente', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  let rechazar = true;
  const subirReal = s.upload;
  s.upload = async (p, f, o) => {
    if (rechazar) {
      s.subidas++;
      return { error: { status: 400, statusCode: '400', message: 'invalid' } };
    }
    return subirReal(p, f, o);
  };
  await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  let ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts.length, 1, 'el trabajo NO se cierra: era la única copia');
  assert.equal(ts[0].archivos[0].estado, 'fallido');
  assert.equal(ts[0].conError, true);
  assert.match(ts[0].ultimoError, /No se pudo subir la foto 1/);
  assert.ok(Q.tomarAvisosTomas(EMAIL).some((m) => /No se pudo subir/.test(m)));
  assert.ok((await Q.archivoLocal(ts[0].id, ts[0].archivos[0].fid)) !== null, 'el archivo sigue en la app');
  // El servidor vuelve a aceptar: sube, se liga y se apaga el error.
  rechazar = false;
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 1);
  ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts.length, 0);
});

test('quitar una foto que ya subió: la cola borra la fila (si entró) y el objeto', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  // Entró la fila pero se perdió la respuesta: queda 'ligando'.
  s.fallas.insert.push('perdida');
  const r = await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  const a = r.archivos[0];
  let ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts[0].archivos[0].estado, 'ligando');
  assert.equal(await Q.quitarArchivo(a.trabajo, a.fid), 'ok');
  await calma();
  assert.equal(s.evidencias.filter((e) => e.path === a.path).length, 0);
  assert.ok(![...s.objetos].includes(a.path));
  ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts.length, 0);
});

test('verificación: storage.remove que no contesta no atora la cola (tope)', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  const otra = nuevaCara();
  // La foto 1 queda 'ligando' con su fila dentro (respuesta perdida) y se
  // quita sin señal: la limpieza queda pendiente para la vuelta del aviso.
  s.fallas.insert.push('perdida');
  const r = await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  s.fallas.delete.push('red');
  await Q.quitarArchivo(r.archivos[0].trabajo, r.archivos[0].fid);
  await calma();
  // Otra cara con una foto que no salió en su primer intento.
  s.fallas.upload.push('red');
  await Q.encolarFotos(EMAIL, otra, nuevos(1), null);
  await calma();
  // En la vuelta, storage.remove no contesta nunca: antes la vuelta se
  // quedaba colgada para siempre y ninguna toma volvía a salir.
  s.frenoRemove = new Promise(() => {});
  const v1 = await Promise.race([Q.procesarTomasPendientes(EMAIL), esperar(20000).then(() => 'colgada')]);
  assert.notEqual(v1, 'colgada', 'la vuelta termina por el tope');
  s.frenoRemove = null;
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === otra.vfid).length, 1);
  assert.equal(s.evidencias.filter((e) => e.path === r.archivos[0].path).length, 0);
});

test('verificación: la base de "regresada" no se fija con una lectura anónima', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  // La toma se regresó ayer; el monitorista repone las 3 fotos.
  s.monitoreo.push({ anio: 2026, catorcena: 22, vendor_face_id: ctx.vfid, fecha_toma: null, fecha_comprobacion: null, fecha_rechazo: '2026-10-21 10:00:00+00' });
  await Q.encolarFotos(EMAIL, ctx, nuevos(3), null);
  await calma();
  // Pide el registro justo en la ventana anónima (token a medio renovar).
  s.anonimo = true;
  const reg = await Q.pedirRegistro(EMAIL, ctx, 3);
  assert.equal(reg.tipo, 'enCola');
  assert.equal(s.rpcs.length, 0);
  // Vuelve la sesión: se registra (antes salía «regresada» y no se registraba).
  s.anonimo = false;
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.rpcs.length, 1);
  assert.equal((await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid)).length, 0);
});

test('verificación: un regreso entre el pedido y la subida sí se nota', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  s.monitoreo.push({ anio: 2026, catorcena: 22, vendor_face_id: ctx.vfid, fecha_toma: null, fecha_comprobacion: null, fecha_rechazo: null });
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  await Q.encolarFotos(EMAIL, ctx, nuevos(3), null);
  const pedido = Q.pedirRegistro(EMAIL, ctx, 3);
  await esperar(30);
  // El analista la regresa mientras las fotos suben.
  s.monitoreo[s.monitoreo.length - 1].fecha_rechazo = '2026-10-22 18:00:00+00';
  soltar();
  const reg = await pedido;
  await calma();
  assert.equal(s.rpcs.length, 0);
  assert.equal(reg.tipo, 'error');
  assert.match(reg.mensaje, /regresó la toma/);
});

test('verificación: limpiar una foto quitada con la sesión anónima espera la sesión', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  s.fallas.insert.push('perdida');
  const r = await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  const a = r.archivos[0];
  s.anonimo = true;
  await Q.quitarArchivo(a.trabajo, a.fid);
  await calma();
  let ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts.length, 1, 'no se da por limpia');
  assert.equal(ts[0].archivos[0].limpiar, true);
  assert.equal(s.evidencias.filter((e) => e.path === a.path).length, 1);
  s.anonimo = false;
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.filter((e) => e.path === a.path).length, 0);
  assert.ok(![...s.objetos].includes(a.path));
  ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts.length, 0);
});

test('verificación: Descartar con una limpieza pendiente la deja a la cola, sin pedir atención', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  s.fallas.insert.push('perdida');
  const r = await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  const a = r.archivos[0];
  // Se quita sin señal: el DELETE falla por red.
  s.fallas.delete.push('red');
  await Q.quitarArchivo(a.trabajo, a.fid);
  await calma();
  assert.equal(await Q.descartarToma(a.trabajo), 'ok');
  await calma();
  // Ya no pide atención ni se pinta en la lista…
  const aviso = (await Q.listarTomasAviso(EMAIL)).find((x) => x.id === a.trabajo);
  assert.ok(!aviso || !aviso.atencion);
  assert.ok(!(await Q.resumenTomas(EMAIL)).has(`2026-22-${ctx.vfid}`));
  // …y la cola termina la limpieza: la foto quitada no se queda en la toma.
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.filter((e) => e.path === a.path).length, 0);
  assert.ok(![...s.objetos].includes(a.path));
  assert.equal((await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid)).length, 0);
});

test('verificación: Descartar una foto rechazada que ya estaba arriba limpia su objeto', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  s.fallas.insert.push('rechazo');
  const r = await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  const a = r.archivos[0];
  let ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts[0].archivos[0].estado, 'fallido');
  assert.equal(ts[0].archivos[0].arriba, true);
  assert.ok(s.objetos.has(a.path));
  assert.equal(await Q.descartarToma(a.trabajo), 'ok');
  await calma();
  assert.ok(!s.objetos.has(a.path), 'sin objeto huérfano');
  ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts.length, 0);
});

test('verificación: un INSERT rechazado se reintenta sin volver a subir la foto', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  s.fallas.insert.push('rechazo');
  const r = await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  const subidas = s.porRuta[r.archivos[0].path];
  assert.equal(subidas, 1);
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.porRuta[r.archivos[0].path], 1, 'no se volvió a subir');
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 1);
  assert.equal((await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid)).length, 0);
});

test('verificación: una foto rechazada no se vuelve a subir ni a avisar con cada foto nueva', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  const subirReal = s.upload;
  let rutaMala = null;
  s.upload = async (p, f, o) => {
    if (!rutaMala || p === rutaMala) {
      rutaMala = p;
      s.subidas++;
      s.porRuta[p] = (s.porRuta[p] || 0) + 1;
      return { error: { status: 400, statusCode: '400', message: 'invalid mime' } };
    }
    return subirReal(p, f, o);
  };
  await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  for (let i = 0; i < 3; i++) {
    await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
    await calma();
  }
  assert.equal(s.porRuta[rutaMala], 1, 'la rechazada solo se intentó una vez');
  const avisos = Q.tomarAvisosTomas(EMAIL).filter((m) => /No se pudo subir la foto 1/.test(m));
  assert.equal(avisos.length, 1, 'un solo aviso');
  // Las otras 3 sí entraron.
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 3);
});

test('verificación: quitar la foto rechazada apaga el error', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  s.upload = async (p) => {
    s.subidas++;
    return { error: { status: 400, statusCode: '400', message: 'invalid' } };
  };
  const r = await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  let ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts[0].conError, true);
  await Q.quitarArchivo(r.archivos[0].trabajo, r.archivos[0].fid);
  ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  if (ts.length) {
    assert.equal(ts[0].conError, false);
    assert.equal(ts[0].ultimoError, null);
  }
});

test('verificación: "faltan" se decide con un conteo hecho con la sesión validada', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  await Q.encolarFotos(EMAIL, ctx, nuevos(3), null);
  await calma();
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 3);
  // El primer conteo sale anónimo ([]); después la sesión está bien.
  let primero = true;
  s.antesDeConsulta = (q) => {
    if (q.t === 'pauta_evidencias' && q.op === 'select' && q.cols === 'path,tipo' && primero) {
      primero = false;
      return { data: [], error: null, status: 200 };
    }
    return null;
  };
  const reg = await Q.pedirRegistro(EMAIL, ctx, 3);
  assert.equal(reg.tipo, 'registrada');
  assert.equal(s.rpcs.length, 1);
});

test('verificación: lo que el monitorista vio registrarse no se repite en el aviso breve', async () => {
  servidor();
  const ctx = nuevaCara();
  // Fotos una por una (cada una cierra su trabajo y deja su logro).
  for (let i = 0; i < 3; i++) {
    await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
    await calma();
  }
  const sueltos = Q.tomarLogrosTomas(EMAIL).filter((l) => l.cara === ctx.cara);
  assert.equal(sueltos.length, 3);
  const reg = await Q.pedirRegistro(EMAIL, ctx, 3);
  assert.equal(reg.tipo, 'registrada');
  // Al mostrarse (cuando se cierra la ventana), ya no queda nada de esa cara.
  assert.equal(Q.logrosPorMostrar(sueltos).length, 0);
});

test('verificación 2: «Registrar» no se queda más de 8 s aunque la sesión no conteste', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  await Q.encolarFotos(EMAIL, ctx, nuevos(3), null);
  await calma();
  s.colgarAuth = true;
  // Con un regreso a la vista (la base hay que leerla) y sin él.
  for (const sinRechazo of [false, true]) {
    const t0 = Date.now();
    const reg = await Q.pedirRegistro(EMAIL, ctx, 3, { sinRechazo });
    const ms = Date.now() - t0;
    assert.ok(ms < 9500, `tardó ${ms} ms`);
    // Sin la base, la cola necesita validar la sesión: no registra todavía.
    // Con «sin rechazo» no hace falta ir a auth y sí puede registrar.
    if (!sinRechazo) assert.notEqual(reg.tipo, 'registrada');
  }
  s.colgarAuth = false;
});

test('verificación 2: sin regreso a la vista, un regreso hecho mientras no había señal sí se nota', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  s.monitoreo.push({ anio: 2026, catorcena: 22, vendor_face_id: ctx.vfid, fecha_toma: null, fecha_comprobacion: null, fecha_rechazo: null });
  // Sin señal: la base de datos no contesta.
  let sinSenal = true;
  s.antesDeConsulta = () => (sinSenal ? { data: null, error: RED, status: 0 } : null);
  s.fallas.upload.push('red', 'red', 'red');
  await Q.encolarFotos(EMAIL, ctx, nuevos(3), null);
  const reg = await Q.pedirRegistro(EMAIL, ctx, 3, { sinRechazo: true });
  assert.equal(reg.tipo, 'enCola');
  // El analista la regresa antes de que vuelva la señal.
  s.monitoreo[s.monitoreo.length - 1].fecha_rechazo = '2026-10-22 19:00:00+00';
  sinSenal = false;
  s.fallas.upload = [];
  const v = await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.rpcs.length, 0, 'no se registra encima del regreso');
  // El aviso sale una vez: en la vuelta del aviso global o en el buzón.
  const avisos = [...v.mensajes, ...Q.tomarAvisosTomas(EMAIL)];
  assert.ok(avisos.some((m) => /regresó la toma/.test(m)));
});

test('verificación 2: «Registrar» con una corrida en curso reintenta la foto rechazada y registra', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  const subirReal = s.upload;
  let rechazos = 1;
  s.upload = async (p, f, o) => {
    if (rechazos > 0) {
      rechazos--;
      s.subidas++;
      return { error: { status: 400, statusCode: '400', message: 'invalid' } };
    }
    return subirReal(p, f, o);
  };
  await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  let ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts[0].archivos[0].estado, 'fallido');
  // La foto 2 sube lenta: hay una corrida (no forzada) en curso al pedir.
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await esperar(10);
  const pedido = Q.pedirRegistro(EMAIL, ctx, 2, { sinRechazo: true });
  await esperar(10);
  ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts[0].conError, true, 'el rojo de la rechazada no se apaga por pedir');
  soltar();
  s.frenoSubida = null;
  await pedido;
  await calma();
  assert.equal(s.rpcs.length, 1);
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 2);
});

test('verificación 2: Descartar sin señal lo que ya estaba arriba lo limpia después, sin tocar lo que entró', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  // Foto 1: el INSERT se rechaza (queda 'fallido' arriba, sin fila).
  // Foto 2: el INSERT entra pero se pierde la respuesta (queda 'ligando' con fila).
  s.fallas.insert.push('rechazo', 'perdida');
  const r = await Q.encolarFotos(EMAIL, ctx, nuevos(2), null);
  await calma();
  const [a1, a2] = r.archivos;
  s.anonimo = true; // sin sesión validada: no se puede limpiar ahora
  assert.equal(await Q.descartarToma(a1.trabajo), 'ok');
  await calma();
  assert.ok(s.objetos.has(a1.path), 'sigue arriba mientras no hay sesión');
  // No pide atención ni se pinta.
  const aviso = (await Q.listarTomasAviso(EMAIL)).find((x) => x.id === a1.trabajo);
  assert.ok(!aviso || !aviso.atencion);
  s.anonimo = false;
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.ok(!s.objetos.has(a1.path), 'el archivo sin fila se borró');
  assert.equal(s.evidencias.filter((e) => e.path === a2.path).length, 1, 'lo que entró se queda');
  assert.ok(s.objetos.has(a2.path), 'y su archivo también');
  assert.equal((await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid)).length, 0);
});

test('verificación 2: el aviso breve no repite un registro visto en la ventana; sí lo dice si la ventana ya no está', async () => {
  servidor();
  const ctx = nuevaCara();
  await Q.encolarFotos(EMAIL, ctx, nuevos(3), null);
  await calma();
  Q.tomarLogrosTomas(EMAIL);
  // La ventana se cerró mientras esperaba: el registro sí sale en el aviso breve.
  const reg = await Q.pedirRegistro(EMAIL, ctx, 3, { sinRechazo: true, enPantalla: () => false });
  assert.equal(reg.tipo, 'registrada');
  await calma();
  const logros = Q.logrosPorMostrar(Q.tomarLogrosTomas(EMAIL)).filter((l) => l.cara === ctx.cara);
  assert.equal(logros.length, 1);
  assert.equal(logros[0].registrada, true);
  // Lo que la ventana vio registrarse ya no se muestra.
  Q.marcarRegistroVisto(ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(Q.logrosPorMostrar(logros).length, 0);
});

test('verificación 4: borrar desde la miniatura sin señal deja la limpieza a la cola; con el trabajo cerrado, false', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  // Foto 1 entra; la 2 se queda subiendo: el trabajo sigue vivo.
  await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  await calma();
  const yaCerrada = s.evidencias.find((e) => e.vendor_face_id === ctx.vfid).path;
  // Su trabajo ya cerró: quitarPorPath no deja lápida y lo dice.
  assert.equal(await Q.quitarPorPath(EMAIL, yaCerrada), false);
  let soltar;
  s.frenoSubida = new Promise((r) => (soltar = r));
  s.fallas.insert.push('perdida'); // la foto 2 entra, se pierde la respuesta
  const r = await Q.encolarFotos(EMAIL, ctx, nuevos(1), null);
  soltar();
  s.frenoSubida = null;
  await calma();
  const p2 = r.archivos[0].path;
  assert.equal(s.evidencias.filter((e) => e.path === p2).length, 1);
  // La ventana la borra: lápida…
  assert.equal(await Q.quitarPorPath(EMAIL, p2), true);
  // …su DELETE falla sin señal y se la deja a la cola.
  assert.equal(await Q.limpiarDespuesPorPath(EMAIL, p2), true);
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.evidencias.filter((e) => e.path === p2).length, 0);
  assert.ok(!s.objetos.has(p2));
  assert.equal((await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid)).length, 0);
});

test('sesión anónima al contar: no es "faltan", espera la sesión', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  await Q.encolarFotos(EMAIL, ctx, nuevos(3), null);
  await calma();
  s.anonimo = true;
  const reg = await Q.pedirRegistro(EMAIL, ctx, 3);
  assert.equal(reg.tipo, 'enCola');
  assert.equal(s.rpcs.filter((x) => x.a.p_vendor_face_id === ctx.vfid).length, 0);
  // Vuelve la sesión: se registra.
  s.anonimo = false;
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.rpcs.filter((x) => x.a.p_vendor_face_id === ctx.vfid).length, 1);
});

test('el analista regresó la toma después de pedir el registro: no la registra sola', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  // Sin señal al registrar: falla la corrida en curso y también la vuelta
  // forzada que «Registrar» espera después.
  s.fallas.rpc.push('red', 'red');
  await Q.encolarFotos(EMAIL, ctx, nuevos(3), null);
  const reg = await Q.pedirRegistro(EMAIL, ctx, 3);
  assert.equal(reg.tipo, 'enCola');
  // Mientras tanto otro la registró y el analista la regresó.
  s.monitoreo.push({ anio: 2026, catorcena: 22, vendor_face_id: ctx.vfid, fecha_toma: null, fecha_comprobacion: null, fecha_rechazo: new Date(Date.now() + 1000).toISOString() });
  await Q.procesarTomasPendientes(EMAIL);
  await calma();
  assert.equal(s.rpcs.filter((x) => x.a.p_vendor_face_id === ctx.vfid).length, 0);
  const ts = await Q.trabajosDeCara(EMAIL, ctx.anio, ctx.catorcena, ctx.vfid);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].conError, true);
  assert.equal(ts[0].registrar, false);
  assert.match(ts[0].ultimoError, /regresó/);
});

test('sin pedir registro: las fotos suben como evidencia y el logro no dice registrada', async () => {
  const s = servidor();
  const ctx = nuevaCara();
  Q.tomarLogrosTomas(EMAIL);
  await Q.encolarFotos(EMAIL, ctx, nuevos(2), null);
  await calma();
  assert.equal(s.rpcs.filter((x) => x.a.p_vendor_face_id === ctx.vfid).length, 0);
  assert.equal(s.evidencias.filter((e) => e.vendor_face_id === ctx.vfid).length, 2);
  const logros = Q.tomarLogrosTomas(EMAIL);
  assert.ok(logros.length >= 1 && logros.every((l) => !l.registrada));
});
