// ============================================================
// tests/colaFotosLogica.test.mjs
// Lo puro de la cola de fotos de Comprobaciones (fase 3, incremento 2,
// 26-oct-2026): la máquina local → subido → ligado del núcleo
// (lib/colaFotos/logica.ts) y lo propio de la visita
// (lib/colaFotos/logicaComp.ts): ruta de Storage de §4.2 y B4, nombre para
// compartir, cuándo toca registrar una toma (B11), lectura tolerante de las
// respuestas de las RPC y los textos.
//
// Correr: node --test --test-concurrency=2 "tests/*.test.mjs"
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('../src/lib/colaFotos/', import.meta.url));
const { outputFiles } = await build({
  stdin: {
    contents: "export * from './logica'; export * from './logicaComp';",
    resolveDir: raiz,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const L = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const UUID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

const arch = (o = {}) => ({
  fid: 'f' + (o.n ?? 1),
  n: 1,
  path: 'comp/via-verde/2026-10/COL_551/20261026_' + UUID + '.jpg',
  nombre: 'COL_551_2610_1.jpg',
  mime: 'image/jpeg',
  tipo: 'foto',
  bytes: 300000,
  encolado_en: '2026-10-26T15:00:00.000Z',
  origen: 'camara',
  estado: 'local',
  cliente_id: UUID,
  pos: 'normal',
  momento: null,
  tomada_en_tel: null,
  lat: null,
  lng: null,
  precision_m: null,
  toma_ids: [1],
  resueltas: {},
  ...o,
});

const CML = [
  { pos: 'corta', n: 1, alcance: 'version', momento: null, etiqueta: 'Corta' },
  { pos: 'media', n: 1, alcance: 'version', momento: null, etiqueta: 'Media' },
  { pos: 'larga', n: 1, alcance: 'version', momento: null, etiqueta: 'Larga' },
];
const UNICA = [{ pos: 'normal', n: 1, alcance: 'version', momento: null, etiqueta: 'Toma' }];

const toma = (o = {}) => ({
  id: 1,
  campana_id: 10,
  nombre: 'Suburbia V1',
  fecha: '2026-10-26',
  estado: 'pendiente',
  regreso_n: 0,
  plantilla: UNICA,
  tiene: [],
  reg: null,
  ...o,
});

const visita = (o = {}) => ({
  v: 1,
  tipo: 'comp',
  id: 'v-1',
  clave: 'moni@ejemplo.test|Vía Verde|COL_551|2026-10-26',
  email: 'moni@ejemplo.test',
  unidad: 'Vía Verde',
  sitio_clave: 'COL_551',
  fecha: '2026-10-26',
  tomas: [toma()],
  cerrar: false,
  cerrarPedidoEn: null,
  archivos: [],
  ultimoError: null,
  conError: false,
  creado_en: '2026-10-26T15:00:00.000Z',
  actualizado_en: '2026-10-26T15:00:00.000Z',
  ...o,
});

// ------------------------------------------------------------
// Núcleo
// ------------------------------------------------------------

test('esFinal: ligado, quitado y perdido; fallido NO (se reintenta)', () => {
  assert.equal(L.esFinal('ligado'), true);
  assert.equal(L.esFinal('quitado'), true);
  assert.equal(L.esFinal('perdido'), true);
  assert.equal(L.esFinal('local'), false);
  assert.equal(L.esFinal('subido'), false);
  assert.equal(L.esFinal('fallido'), false);
});

test('porMandar: fotos antes que videos, cada grupo en orden de captura', () => {
  const t = {
    archivos: [
      arch({ fid: 'a', n: 1, tipo: 'video' }),
      arch({ fid: 'b', n: 3 }),
      arch({ fid: 'c', n: 2 }),
      arch({ fid: 'd', n: 4, estado: 'ligado' }),
      arch({ fid: 'e', n: 5, tipo: 'video', estado: 'subido' }),
      arch({ fid: 'f', n: 6, estado: 'fallido' }),
    ],
  };
  assert.deepEqual(
    L.porMandar(t).map((a) => a.fid),
    ['c', 'b', 'f', 'a', 'e']
  );
});

test('listoParaCerrar: todo final y sin limpieza pendiente', () => {
  assert.equal(L.listoParaCerrar({ archivos: [] }), true);
  assert.equal(L.listoParaCerrar({ archivos: [arch({ estado: 'ligado' })] }), true);
  assert.equal(L.listoParaCerrar({ archivos: [arch({ estado: 'subido' })] }), false);
  assert.equal(L.listoParaCerrar({ archivos: [arch({ estado: 'quitado', limpiar: true })] }), false);
  assert.equal(L.listoParaCerrar({ archivos: [arch({ estado: 'fallido' })] }), false);
});

test('fallidos, perdidas, porSubir y porLimpiar', () => {
  const t = {
    archivos: [
      arch({ fid: 'a', estado: 'fallido' }),
      arch({ fid: 'b', estado: 'perdido' }),
      arch({ fid: 'c', estado: 'perdido', tipo: 'video' }),
      arch({ fid: 'd', estado: 'local' }),
      arch({ fid: 'e', estado: 'quitado', limpiar: 'objeto' }),
      arch({ fid: 'f', estado: 'ligado' }),
    ],
  };
  assert.equal(L.fallidos(t), 1);
  assert.equal(L.perdidas(t), 2);
  assert.equal(L.porSubir(t), 2);
  assert.deepEqual(L.porLimpiar(t).map((a) => a.fid), ['e']);
  assert.equal(L.soloLimpieza(t), false);
  assert.equal(L.soloLimpieza({ archivos: [arch({ estado: 'quitado', limpiar: true })] }), true);
});

test('textoPerdidas: singular, plural y mezcla', () => {
  assert.equal(L.textoPerdidas({ archivos: [] }), '');
  assert.match(L.textoPerdidas({ archivos: [arch({ estado: 'perdido' })] }), /^Una foto ya no estaba/);
  assert.match(
    L.textoPerdidas({ archivos: [arch({ estado: 'perdido' }), arch({ estado: 'perdido', tipo: 'video' })] }),
    /Una foto y un video ya no estaban.*tomarlos/
  );
});

test('gruposParaCompartir se reexporta de Pauta sin cambios', () => {
  const f = (n) => ({ size: n });
  assert.deepEqual(L.gruposParaCompartir([f(1), f(2)], false).length, 1);
  assert.equal(L.gruposParaCompartir(Array.from({ length: 12 }, () => f(1)), true).length, 2);
});

// ------------------------------------------------------------
// Rutas y nombres
// ------------------------------------------------------------

test('ruta de Storage de §4.2: 5 partes, slug, mes, clave exacta y día_cliente_id.ext', () => {
  const p = L.rutaFotoComp({ unidad: 'Vía Verde', sitio_clave: 'COL_551', dia: '2026-10-26', cliente_id: UUID, ext: 'jpg' });
  assert.equal(p, `comp/via-verde/2026-10/COL_551/20261026_${UUID}.jpg`);
  const partes = p.split('/');
  assert.equal(partes.length, 5);
  assert.match(partes[4], new RegExp(`^[0-9]{8}_${UUID}\\.[a-z0-9]{2,5}$`));
  assert.equal(L.slugUnidad('Ecovallas'), 'ecovallas');
  assert.equal(L.slugUnidad('Biobox'), 'biobox');
  assert.equal(L.slugUnidad('Pauta'), '');
});

test('clave del sitio: con «/» o acentos no se puede usar en la ruta', () => {
  assert.equal(L.claveUsableEnRuta('COL_551'), true);
  assert.equal(L.claveUsableEnRuta('MX_CM_EV_3325'), true);
  assert.equal(L.claveUsableEnRuta('A/B'), false);
  assert.equal(L.claveUsableEnRuta('PEÑA_1'), false);
  assert.equal(L.claveUsableEnRuta(''), false);
  assert.equal(L.claveUsableEnRuta('..'), false);
});

test('extensión que la base acepta: jpeg → jpg; rara → jpg o mp4', () => {
  assert.equal(L.extensionComp('jpeg', 'foto'), 'jpg');
  assert.equal(L.extensionComp('HEIC', 'foto'), 'heic');
  assert.equal(L.extensionComp('quicktimex', 'video'), 'mp4');
  assert.equal(L.extensionComp('', 'foto'), 'jpg');
  assert.equal(L.extensionComp('x', 'foto'), 'jpg');
});

test('nombre para compartir: <sitio_clave>_<DDMM>_<n>.<ext>', () => {
  assert.equal(L.nombreParaCompartirComp('COL_551', '2026-10-29', 3, 'jpg'), 'COL_551_2910_3.jpg');
  assert.equal(L.nombreParaCompartirComp('MX CM, 1', '2026-01-05', 1, 'MOV'), 'MX_CM__1_0501_1.mov');
});

test('clave de la visita: correo en minúsculas|unidad|sitio|día', () => {
  assert.equal(L.claveVisita(' Moni@Ejemplo.Test ', 'Biobox', 'BB_1', '2026-10-26'), 'moni@ejemplo.test|Biobox|BB_1|2026-10-26');
  assert.equal(L.esUuid(UUID), true);
  assert.equal(L.esUuid('3f2a1b4c5d6e4f708a9b0c1d2e3f4a5b'), false);
});

// ------------------------------------------------------------
// Ligas
// ------------------------------------------------------------

test('resolverLiga: cada toma pedida con su respuesta; la que no vino cuenta como ligada', () => {
  const r = L.resolverLiga([1, 2, 3, 4, 5, 6], {
    ok: true,
    ya: false,
    evidencia_id: 9,
    fecha: '2026-10-26',
    ligadas: [1],
    cerradas: [2],
    futuras: [3],
    ajenas: [4],
    duplicadas: [5, 99],
  });
  assert.deepEqual(r, { 1: 'ligada', 2: 'cerrada', 3: 'futura', 4: 'ajena', 5: 'duplicada', 6: 'ligada' });
});

test('cuentaEnToma: solo «ligada»; una duplicada (devuelta B4 u otro día A1) nunca cuenta, ni con `ya`', () => {
  assert.equal(L.cuentaEnToma({ resueltas: { 1: 'ligada' } }, 1), true);
  assert.equal(L.cuentaEnToma({ resueltas: { 1: 'duplicada' } }, 1), false);
  // La base contesta un reintento de una liga vigente en `ligadas`: una
  // duplicada con ya=true es la foto devuelta o la de otro día de la campaña.
  assert.equal(L.cuentaEnToma({ resueltas: { 1: 'duplicada' }, ya: true }, 1), false);
  assert.equal(L.cuentaEnToma({ resueltas: { 1: 'cerrada' }, ya: true }, 1), false);
  assert.deepEqual(L.porLigar({ toma_ids: [1, 2, 3], resueltas: { 2: 'ligada' } }), [1, 3]);
});

test('leerRespSubirFoto: forma fija y tolerante', () => {
  assert.equal(L.leerRespSubirFoto(null), null);
  assert.deepEqual(L.leerRespSubirFoto({ ok: false, codigo: 'ocupada' }), { ok: false, codigo: 'ocupada' });
  const r = L.leerRespSubirFoto({ ok: true, ya: true, evidencia_id: '7', ligadas: ['1', 2], cerradas: null });
  assert.equal(r.ok, true);
  assert.equal(r.ya, true);
  assert.equal(r.evidencia_id, 7);
  assert.deepEqual(r.ligadas, [1, 2]);
  assert.deepEqual(r.cerradas, []);
  // Ninguna toma existe ya: la base contesta evidencia_id null (no 0).
  const sin = L.leerRespSubirFoto({ ok: true, ya: false, evidencia_id: null, fecha: null, ligadas: [], cerradas: [5, 9] });
  assert.equal(sin.evidencia_id, null);
  assert.equal(sin.fecha, null);
  assert.deepEqual(sin.cerradas, [5, 9]);
});

test('leerRespRegistrar y leerEstadoTomas', () => {
  const r = L.leerRespRegistrar({
    ok: true,
    tomas: [
      { id: 1, estado: 'por_revisar', regreso_n: 0 },
      { id: 2, estado: 'pendiente', codigo: 'faltan', faltan: [{ pos: 'larga', momento: null, etiqueta: 'Larga', n: 1, tiene: 0 }] },
      { id: 'x' },
    ],
  });
  assert.equal(r.tomas.length, 2);
  assert.equal(r.tomas[1].faltan[0].etiqueta, 'Larga');
  assert.deepEqual(L.leerRespRegistrar({ ok: false, codigo: 'ocupada' }), { ok: false, codigo: 'ocupada' });
  assert.deepEqual(L.leerEstadoTomas([{ id: 3, estado: 'regresada', regreso_n: 2, rechazo_motivo: 'movida' }]), [
    { id: 3, estado: 'regresada', regreso_n: 2, rechazo_motivo: 'movida' },
  ]);
  assert.equal(L.leerEstadoTomas({}), null);
  assert.deepEqual(L.leerRespQuitar({ ok: true, borrada: true, path: 'comp/x' }), {
    ok: true,
    ya: false,
    borrada: true,
    desligada: false,
    path: 'comp/x',
    quedan: null,
  });
  // Con p_toma_id (26-oct-2026): al quedar 0 ligas sin revisiones, la base borra la fila.
  assert.deepEqual(L.leerRespQuitar({ ok: true, desligada: true, quedan: 0, borrada: true, path: 'comp/y' }), {
    ok: true,
    ya: false,
    borrada: true,
    desligada: true,
    path: 'comp/y',
    quedan: 0,
  });
  assert.equal(L.leerRespQuitar({ ok: true, desligada: true, quedan: 1 }).quedan, 1);
  assert.equal(L.leerRespQuitar({ ok: true, ya: true }).quedan, null, 'ya sin quedan: la fila ya no existe');
});

// ------------------------------------------------------------
// Cuándo se registra (B11)
// ------------------------------------------------------------

test('registro: unica con su foto ligada → toca; con la foto en camino → espera', () => {
  const v = visita({ archivos: [arch({ estado: 'ligado', resueltas: { 1: 'ligada' } })] });
  assert.deepEqual(L.tomasPorRegistrar(v), [1]);
  const v2 = visita({ archivos: [arch({ estado: 'subido' })] });
  assert.deepEqual(L.tomasPorRegistrar(v2), []);
});

test('registro: cml incompleta no toca hasta «Listo»; lo que vio la pantalla suma', () => {
  const t = toma({ plantilla: CML, tiene: [{ pos: 'corta', momento: null, n: 1 }] });
  const media = arch({ fid: 'm', pos: 'media', estado: 'ligado', resueltas: { 1: 'ligada' } });
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [t], archivos: [media] })), []);
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [t], archivos: [media], cerrar: true })), [1]);
  const larga = arch({ fid: 'l', cliente_id: 'otro', pos: 'larga', estado: 'ligado', resueltas: { 1: 'ligada' } });
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [t], archivos: [media, larga] })), [1]);
});

test('registro: un video nunca cuenta; una foto cerrada en esa toma tampoco', () => {
  const v = visita({ archivos: [arch({ tipo: 'video', estado: 'ligado', resueltas: { 1: 'ligada' } })] });
  assert.deepEqual(L.tomasPorRegistrar(v), []);
  const v2 = visita({ archivos: [arch({ estado: 'ligado', resueltas: { 1: 'duplicada' } })] });
  assert.deepEqual(L.tomasPorRegistrar(v2), []);
});

test('registro: una duplicada con `ya` no completa la plantilla ni sale como ligada', () => {
  const dup = arch({ estado: 'ligado', ya: true, resueltas: { 1: 'duplicada' } });
  assert.deepEqual(L.tomasPorRegistrar(visita({ archivos: [dup] })), []);
  const e = L.estadoDeVisita('k', [visita({ archivos: [dup] })], { enviando: () => false, hayCopia: () => false });
  assert.deepEqual(e.fotos[0].ligada_en, []);
  assert.deepEqual(e.fotos[0].no_ligada, [{ toma_id: 1, razon: 'duplicada' }]);
  assert.deepEqual(e.ligadas, {});
});

test('registro: un video en camino (B6) no detiene el registro de la toma', () => {
  const f = arch({ estado: 'ligado', resueltas: { 1: 'ligada' } });
  const vid = arch({ fid: 'v', n: 2, cliente_id: 'vid', tipo: 'video', pos: 'extra', estado: 'local' });
  assert.deepEqual(L.tomasPorRegistrar(visita({ archivos: [f, vid] })), [1]);
  // Una FOTO en camino de esa toma sí la detiene.
  const f2 = arch({ fid: 'g', n: 3, cliente_id: 'g', estado: 'subido' });
  assert.deepEqual(L.tomasPorRegistrar(visita({ archivos: [f, vid, f2] })), []);
});

test('registro: tras releer la lista, lo que ya viene en `tiene` (incluidas) no se suma otra vez (n ≥ 2)', () => {
  // Biobox: frontal 1 + copete 3 + lateral 2. Ligados: frontal, 3 copetes y 1 lateral.
  const M4 = [
    { pos: 'normal', n: 1, alcance: 'version', momento: null, etiqueta: 'Frontal' },
    { pos: 'copete', n: 3, alcance: 'sitio', momento: null, etiqueta: 'Copete' },
    { pos: 'lateral', n: 2, alcance: 'sitio', momento: null, etiqueta: 'Lateral' },
  ];
  const lig = (cid, pos) => arch({ fid: cid, cliente_id: cid, pos, estado: 'ligado', resueltas: { 1: 'ligada' } });
  const archivos = [lig('fr', 'normal'), lig('c1', 'copete'), lig('c2', 'copete'), lig('c3', 'copete'), lig('l1', 'lateral')];
  // Antes de releer: tiene vacío y todo en la visita → falta un lateral.
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [toma({ plantilla: M4 })], archivos })), []);
  // Después de releer: `tiene` ya trae las 5 ligas. Sin incluidas se contaban dos veces.
  const tiene = [
    { pos: 'normal', momento: null, n: 1 },
    { pos: 'copete', momento: null, n: 3 },
    { pos: 'lateral', momento: null, n: 1 },
  ];
  const incluidas = ['fr', 'c1', 'c2', 'c3', 'l1'];
  const t = toma({ plantilla: M4, tiene, incluidas });
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [t], archivos })), [], 'sin registro prematuro');
  // El segundo lateral (nuevo, no incluido) sí completa.
  const l2 = lig('l2', 'lateral');
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [t], archivos: [...archivos, l2] })), [1]);
  // La firma cambia con la foto nueva y no con las ya incluidas.
  assert.notEqual(L.firmaToma(t, archivos), L.firmaToma(t, [...archivos, l2]));
});

test('registro: la base dijo «faltan» con las mismas fotos → no se repite; con otra foto, sí', () => {
  const a = arch({ estado: 'ligado', resueltas: { 1: 'ligada' } });
  const t = toma();
  const firma = L.firmaToma(t, [a]);
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [{ ...t, faltanFirma: firma }], archivos: [a] })), []);
  const b = arch({ fid: 'b', cliente_id: 'b', estado: 'ligado', resueltas: { 1: 'ligada' } });
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [{ ...t, faltanFirma: firma }], archivos: [a, b] })), [1]);
});

test('registro: enviada, por revisar o con final del servidor ya no toca', () => {
  const a = arch({ estado: 'ligado', resueltas: { 1: 'ligada' } });
  for (const x of [toma({ reg: 'enviada' }), toma({ reg: 'ajena' }), toma({ estado: 'por_revisar' })])
    assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [x], archivos: [a] })), []);
});

test('alcance sitio: una foto ligada a 3 versiones cuenta en las 3', () => {
  const lat = [{ pos: 'lateral', n: 2, alcance: 'sitio', momento: null, etiqueta: 'Lateral' }];
  const tomas = [1, 2, 3].map((id) => toma({ id, campana_id: id * 10, plantilla: lat }));
  const ligada = { 1: 'ligada', 2: 'ligada', 3: 'ligada' };
  const a1 = arch({ fid: 'a', cliente_id: 'a', pos: 'lateral', toma_ids: [1, 2, 3], estado: 'ligado', resueltas: ligada });
  const a2 = arch({ fid: 'b', cliente_id: 'b', pos: 'lateral', toma_ids: [1, 2, 3], estado: 'ligado', resueltas: ligada });
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas, archivos: [a1] })), []);
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas, archivos: [a1, a2] })), [1, 2, 3]);
});

test('soltar la visita: con tomas abiertas se queda hoy; al cerrar o al pasar el día, no', () => {
  assert.equal(L.puedeSoltarVisita(visita(), '2026-10-26'), false);
  assert.equal(L.puedeSoltarVisita(visita({ cerrar: true }), '2026-10-26'), true);
  assert.equal(L.puedeSoltarVisita(visita(), '2026-10-27'), true);
  assert.equal(L.puedeSoltarVisita(visita({ tomas: [toma({ reg: 'enviada' })] }), '2026-10-26'), true);
});

test('estadoDeVisita: en el teléfono, ligadas, enviadas y lo que falta por toma', () => {
  const v = visita({
    tomas: [toma({ id: 1 }), toma({ id: 2, campana_id: 20, reg: 'enviada' }), toma({ id: 3, campana_id: 30, faltan: [{ pos: 'larga', momento: null, etiqueta: 'Larga', n: 1, tiene: 0 }] })],
    archivos: [
      arch({ fid: 'a', toma_ids: [1], estado: 'local' }),
      arch({ fid: 'b', cliente_id: 'b', toma_ids: [2], estado: 'ligado', resueltas: { 2: 'ligada' } }),
      arch({ fid: 'c', cliente_id: 'c', toma_ids: [1, 3], estado: 'ligado', resueltas: { 1: 'ligada', 3: 'cerrada' } }),
      arch({ fid: 'd', cliente_id: 'd', estado: 'quitado' }),
    ],
  });
  const e = L.estadoDeVisita(v.clave, [v], { enviando: () => false, hayCopia: () => true });
  assert.equal(e.porSubir, 1);
  assert.deepEqual(e.enTelefono['1'], [{ pos: 'normal', momento: null, n: 1 }]);
  assert.deepEqual(e.ligadas['1'], [{ pos: 'normal', momento: null, n: 1 }]);
  assert.deepEqual(e.enviadas, [2]);
  assert.deepEqual(Object.keys(e.faltan), ['3']);
  assert.equal(e.fotos.length, 3);
  assert.deepEqual(e.fotos.find((f) => f.fid === 'c').no_ligada, [{ toma_id: 3, razon: 'cerrada' }]);
});

// ------------------------------------------------------------
// Textos
// ------------------------------------------------------------

test('«Falta: Larga de Suburbia V1» y listas', () => {
  const f = (etiqueta, n = 1, tiene = 0) => ({ pos: 'x', momento: null, etiqueta, n, tiene });
  assert.equal(L.textoFaltan('Suburbia V1', [f('Larga')]), 'Falta: Larga de Suburbia V1');
  assert.equal(L.textoFaltan('Suburbia V1', [f('Corta'), f('Larga')]), 'Falta: Corta y Larga de Suburbia V1');
  assert.equal(L.listaFaltan([f('Copete', 3, 1), f('Lateral', 2, 1), f('Toma')]), 'Copete ×2, Lateral y Toma');
  assert.equal(L.textoFaltan('X', []), '');
});

test('aviso breve: «✓ COL_551 · 6 fotos arriba · 3 tomas enviadas», juntando por visita', () => {
  const l = (o) => ({ llave: 'k1', sitio_clave: 'COL_551', fotos: 0, tomas: 0, en: 1, ...o });
  assert.equal(
    L.textoLogroComp([l({ fotos: 4 }), l({ fotos: 2, tomas: 3 })]),
    '✓ COL_551 · 6 fotos arriba · 3 tomas enviadas'
  );
  assert.equal(L.textoLogroComp([l({ fotos: 1 })]), '✓ COL_551 · 1 foto arriba');
  assert.equal(
    L.textoLogroComp([l({ fotos: 1 }), l({ llave: 'k2', sitio_clave: 'COL_552', tomas: 1 })]),
    '✓ 2 sitios · 1 foto arriba · 1 toma enviada'
  );
  assert.equal(L.textoLogroComp([]), '');
});

test('después de «Quitar» (26-oct-2026): lo quitado que `tiene` todavía cuenta no completa la toma ni pide el registro', () => {
  const P = '11111111-2222-4333-8444-555555555555';
  const Q = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  // La lista ya se releyó: `tiene` trae la Corta P (incluida); P se quitó entera.
  const t = toma({ plantilla: CML, tiene: [{ pos: 'corta', momento: null, n: 1 }], incluidas: [P] });
  const p = arch({ fid: 'p', cliente_id: P, pos: 'corta', estado: 'quitado', limpiar: true, resueltas: { 1: 'ligada' } });
  const media = arch({ n: 2, fid: 'm', cliente_id: '22222222-2222-4333-8444-555555555555', pos: 'media', estado: 'ligado', resueltas: { 1: 'ligada' } });
  const larga = arch({ n: 3, fid: 'l', cliente_id: Q, pos: 'larga', estado: 'ligado', resueltas: { 1: 'ligada' } });
  const v = visita({ tomas: [t], archivos: [p, media, larga] });
  assert.equal(L.tieneConVisita(t, v.archivos).filter((x) => x.pos === 'corta').reduce((s, x) => s + x.n, 0), 0);
  assert.deepEqual(L.tomasPorRegistrar(v), [], 'sin registro con la Corta quitada');
  // Ya quitada en el servidor (limpiar terminó): sigue descontada hasta releer.
  const p2 = { ...p, limpiar: undefined, quitadaDe: [1] };
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [t], archivos: [p2, media, larga] })), []);
  // Quitada solo de esta toma (desligar pendiente o ya hecho): igual.
  const d = arch({ fid: 'd', cliente_id: P, pos: 'corta', estado: 'ligado', toma_ids: [2], resueltas: { 2: 'ligada' }, desligar: [1] });
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [t], archivos: [d, media, larga] })), []);
  const d2 = { ...d, desligar: undefined, quitadaDe: [1] };
  assert.deepEqual(L.tomasPorRegistrar(visita({ tomas: [t], archivos: [d2, media, larga] })), []);
  // El estado de la visita lo dice a la pantalla (pendiente / confirmada).
  const e = L.estadoDeVisita('x', [visita({ tomas: [t], archivos: [p, d2] })], { enviando: () => false, hayCopia: () => false });
  assert.deepEqual(
    e.retiradas.map((r) => [r.toma_id, r.pendiente]),
    [
      [1, true],
      [1, false],
    ]
  );
  // Un descarte (limpiar 'objeto') no quita ligas: no se descuenta.
  assert.deepEqual(L.retiradasDe({ ...p, limpiar: 'objeto' }), []);
});

test('lápidas (26-oct-2026): «Quitar» entera sin confirmar sale «por confirmar»; la que la cola deja al soltar una foto sin fila no sale', () => {
  const op = { enviando: () => false, hayCopia: () => false };
  const lapidas = (a) => L.estadoDeVisita('x', [visita({ archivos: [a] })], op).lapidas;
  const base = { estado: 'quitado', resueltas: { 1: 'ligada' } };
  // «Quitar» entera de una foto arriba: la base todavía puede negar (vuelve a la tarjeta).
  assert.deepEqual(lapidas(arch({ ...base, limpiar: true })), [{ cliente_id: UUID, nombre: 'COL_551_2610_1.jpg', porConfirmar: true }]);
  // Igual con la marca sinFila (una foto suelta que el monitorista quitó entera).
  assert.equal(lapidas(arch({ ...base, limpiar: true, sinFila: true }))[0].porConfirmar, true);
  // Ya confirmada (o nunca subió): firme.
  assert.deepEqual(lapidas(arch(base)), [{ cliente_id: UUID, nombre: 'COL_551_2610_1.jpg', porConfirmar: false }]);
  // La que la cola dejó al soltar la visita (sin fila, no cuenta en ninguna toma): no la quitó el monitorista.
  assert.deepEqual(lapidas(arch({ ...base, resueltas: {}, sinFila: true, limpiar: 'objeto' })), []);
  assert.deepEqual(lapidas(arch({ ...base, resueltas: {}, sinFila: true, borrando: true })), []);
});
