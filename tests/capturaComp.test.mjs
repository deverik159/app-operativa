// src/lib/capturaComp.ts (fase 3 de Comprobaciones, incremento 2,
// 26-oct-2026): lo puro de la captura en Mis rutas › Comprobaciones. Qué
// tomas entran en la visita, qué falta en cada casilla sin contar dos veces
// lo ya ligado, qué ofrece la hoja «¿qué es? ¿de cuál?» (A1, «Todas las de
// hoy», la última versión) y «Usar también para…» (B4). Repo PÚBLICO: datos
// inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/capturaComp.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const C = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const HOY = '2026-10-29';
const AYER = '2026-10-28';
const UNICA = [{ pos: 'normal', n: 1, alcance: 'version', momento: null, etiqueta: 'Toma' }];
const CML = [
  { pos: 'corta', n: 1, alcance: 'version', momento: null, etiqueta: 'Corta' },
  { pos: 'media', n: 1, alcance: 'version', momento: null, etiqueta: 'Media' },
  { pos: 'larga', n: 1, alcance: 'version', momento: null, etiqueta: 'Larga' },
];
const M4 = [
  ...UNICA,
  { pos: 'copete', n: 3, alcance: 'sitio', momento: null, etiqueta: 'Copete' },
  { pos: 'lateral', n: 2, alcance: 'sitio', momento: null, etiqueta: 'Lateral' },
];

let sig = 100;
const toma = (o = {}) => ({
  id: sig++,
  estado: 'pendiente',
  fecha: HOY,
  campana_id: sig,
  campana: 'Campaña',
  version: 'V1',
  plantilla: UNICA,
  tiene: [],
  rechazadas: [],
  unidad: 'Vía Verde',
  sitio_clave: 'COL_551',
  ...o,
});

/** Un EstadoVisita mínimo como lo arma la cola. */
const estado = (o = {}) => ({
  clave: 'x',
  trabajos: ['t1'],
  porSubir: 0,
  enTelefono: {},
  ligadas: {},
  enviadas: [],
  faltan: {},
  sinEnviar: [],
  fotos: [],
  cerrar: false,
  enviando: false,
  conError: false,
  ultimoError: null,
  ...o,
});
const foto = (o = {}) => ({
  trabajo: 't1',
  fid: 'f' + sig++,
  cliente_id: 'c' + sig++,
  path: 'comp/via-verde/2026-10/COL_551/20261029_x.jpg',
  nombre: 'COL_551_2910_1.jpg',
  tipo: 'foto',
  pos: 'normal',
  momento: null,
  estado: 'ligado',
  toma_ids: [],
  ligada_en: [],
  no_ligada: [],
  enTelefono: false,
  ...o,
});

test('lo ya ligado no se cuenta dos veces: después de releer la lista ya viene en tiene', () => {
  const t = toma({ plantilla: [{ pos: 'lateral', n: 2, alcance: 'version', momento: null, etiqueta: 'Lateral' }] });
  const f = foto({ pos: 'lateral', toma_ids: [t.id], ligada_en: [t.id] });
  const e = estado({ fotos: [f] });
  // Antes de releer: la lista dice 0 y la cola ligó 1 → 1/2.
  assert.equal(C.avanceCaptura(t, e, new Set())[0].tiene, 1);
  // Después de releer (la liga estaba antes de pedir): la lista dice 1 → 1/2, no 2/2.
  const releida = { ...t, tiene: [{ pos: 'lateral', momento: null, n: 1 }] };
  const incluidas = C.ligasDe([e]);
  assert.equal(C.avanceCaptura(releida, e, incluidas)[0].tiene, 1);
});

test('en el teléfono va en gris y nunca pasa de lo que pide', () => {
  const t = toma({ plantilla: CML });
  const e = estado({ enTelefono: { [t.id]: [{ pos: 'corta', momento: null, n: 2 }] } });
  const a = C.avanceCaptura(t, e, new Set());
  assert.deepEqual(
    a.map((q) => [q.pos, q.tiene, q.enTelefono]),
    [
      ['corta', 0, 1],
      ['media', 0, 0],
      ['larga', 0, 0],
    ]
  );
});

test('los videos nunca cuentan para la plantilla', () => {
  const t = toma();
  const v = foto({ tipo: 'video', pos: 'normal', toma_ids: [t.id], ligada_en: [t.id] });
  assert.equal(C.avanceCaptura(t, estado({ fotos: [v] }), new Set())[0].tiene, 0);
  assert.equal(C.ligasDe([estado({ fotos: [v] })]).size, 0);
});

test('la visita: del día, devueltas, enviadas y vencidas solo con fotos o en la cola', () => {
  const hoy = toma();
  const devuelta = toma({ estado: 'regresada', fecha: '2026-10-20' });
  const vencidaVacia = toma({ fecha: AYER });
  const vencidaConFotos = toma({ fecha: '2026-10-27', tiene: [{ pos: 'normal', momento: null, n: 1 }] });
  const vencidaEnCola = toma({ fecha: '2026-10-26' });
  const t = { tomas: [hoy, devuelta, vencidaVacia, vencidaConFotos, vencidaEnCola], dia: HOY, unidad: 'Vía Verde', sitio_clave: 'COL_551' };
  const v = C.visitaDeTarjeta(t, new Set([vencidaEnCola.id]));
  assert.deepEqual(
    v.tomas.map((x) => x.id).sort(),
    [hoy.id, devuelta.id, vencidaConFotos.id, vencidaEnCola.id].sort()
  );
  assert.equal(C.visitaDeTarjeta({ ...t, unidad: null }), null);
});

test('¿qué es?: lo de sitio una vez y primero; lo de versión sumado; lo que ya está en el teléfono no', () => {
  const a = toma({ plantilla: M4, campana: 'Tecate', version: 'V2' });
  const b = toma({ plantilla: M4, campana: 'Suburbia', version: 'V1' });
  const e = estado({ enTelefono: { [a.id]: [{ pos: 'normal', momento: null, n: 1 }] } });
  const o = C.opcionesQueEs([a, b], e, new Set(), HOY);
  assert.deepEqual(
    o.map((x) => [x.pos, x.alcance, x.faltan]),
    [
      ['copete', 'sitio', 3],
      ['lateral', 'sitio', 2],
      ['normal', 'version', 1],
    ]
  );
});

test('¿qué es?: una toma enviada por la cola o de un día por venir ya no pide nada', () => {
  const a = toma({ plantilla: CML });
  const futura = toma({ plantilla: CML, fecha: '2026-10-30' });
  const e = estado({ enviadas: [a.id] });
  assert.deepEqual(C.opcionesQueEs([a, futura], e, new Set(), HOY), []);
});

test('¿de cuál?: devueltas primero, luego hoy y vencidas de la más reciente; «Otra» vale para todas', () => {
  const hoy = toma({ campana: 'B' });
  const vieja = toma({ fecha: '2026-10-25', campana: 'C' });
  const reciente = toma({ fecha: AYER, campana: 'D' });
  const dev = toma({ estado: 'regresada', fecha: '2026-10-24', campana: 'E' });
  const otra = toma({ campana: 'F', plantilla: CML });
  const c = C.candidatasDeCual([hoy, vieja, reciente, dev, otra], 'normal', null, null, new Set(), HOY);
  assert.deepEqual(c.map((x) => x.id), [dev.id, hoy.id, reciente.id, vieja.id]);
  const extra = C.candidatasDeCual([hoy, otra], 'extra', null, null, new Set(), HOY);
  assert.equal(extra.length, 2);
  assert.ok(extra.every((x) => x.falta));
});

test('selección por omisión: sitio → todas las de hoy; versión → la última elegida si le falta; si no, la única', () => {
  const a = toma({ plantilla: M4 });
  const b = toma({ plantilla: M4 });
  const vencida = toma({ plantilla: M4, fecha: AYER });
  const cands = C.candidatasDeCual([a, b, vencida], 'lateral', null, null, new Set(), HOY);
  assert.deepEqual(C.seleccionPorOmision(cands, 'sitio', HOY, null), [a.id, b.id]);
  const cv = C.candidatasDeCual([a, b], 'normal', null, null, new Set(), HOY);
  assert.deepEqual(C.seleccionPorOmision(cv, 'version', HOY, b.id), [b.id]);
  assert.deepEqual(C.seleccionPorOmision(cv, 'version', HOY, null), []);
  // La última ya la tiene: no se marca sola; la única a la que le falta, sí.
  const conA = { ...a, tiene: [{ pos: 'normal', momento: null, n: 1 }] };
  const cv2 = C.candidatasDeCual([conA, b], 'normal', null, null, new Set(), HOY);
  assert.deepEqual(C.seleccionPorOmision(cv2, 'version', HOY, conA.id), [b.id]);
});

test('A1: al prender una versión se apaga la otra de la misma campaña', () => {
  const hoy = toma({ campana_id: 7 });
  const ayer = toma({ campana_id: 7, fecha: AYER });
  const otra = toma({ campana_id: 8 });
  const cands = C.candidatasDeCual([hoy, ayer, otra], 'normal', null, null, new Set(), HOY);
  let sel = C.alternarCual([], cands.find((c) => c.id === hoy.id), cands);
  sel = C.alternarCual(sel, cands.find((c) => c.id === otra.id), cands);
  sel = C.alternarCual(sel, cands.find((c) => c.id === ayer.id), cands);
  assert.deepEqual(sel, [ayer.id, otra.id].sort((x, y) => x - y));
  assert.deepEqual(C.alternarCual(sel, cands.find((c) => c.id === otra.id), cands), [ayer.id]);
});

test('«Usar también para…»: sin las que ya tiene, sin otra de la misma campaña y B4 marcada', () => {
  const a = toma({ campana_id: 1 });
  const aAyer = toma({ campana_id: 1, fecha: AYER });
  const b = toma({ campana_id: 2 });
  const path = 'comp/via-verde/2026-10/COL_551/20261029_y.jpg';
  const c = toma({ campana_id: 3, rechazadas: [{ evidencia_id: 9, path, pos: 'normal', motivo: 'movida' }] });
  const f = foto({ path, toma_ids: [a.id], ligada_en: [a.id] });
  const cands = C.candidatasUsarTambien(f, [a, aAyer, b, c], null, new Set(), HOY);
  assert.deepEqual(cands.map((x) => x.id).sort(), [b.id, c.id].sort());
  assert.equal(cands.find((x) => x.id === c.id).devuelta, true);
  // La hoja no la marca nunca por omisión.
  assert.deepEqual(C.seleccionPorOmision(cands.filter((x) => x.id === c.id), 'version', HOY, c.id), []);
});

test('«Usar también para…»: la campaña donde la foto NO entró (cerrada, futura, ajena) sigue libre; una duplicada no', () => {
  const aAyer = toma({ campana_id: 11, fecha: AYER });
  const a = toma({ campana_id: 11 });
  const bAyer = toma({ campana_id: 12, fecha: AYER });
  const b = toma({ campana_id: 12 });
  // Foto nueva que ninguna toma aceptó (la base ni creó la fila).
  const f = foto({ toma_ids: [aAyer.id, bAyer.id], no_ligada: [{ toma_id: aAyer.id, razon: 'cerrada' }, { toma_id: bAyer.id, razon: 'duplicada' }] });
  const cands = C.candidatasUsarTambien(f, [aAyer, a, bAyer, b], null, new Set(), HOY);
  assert.deepEqual(cands.map((x) => x.id), [a.id]);
});

test('fila «Fotos del sitio» con la cola: lo de la que menos tiene, con el gris del teléfono', () => {
  const a = toma({ plantilla: M4 });
  const b = toma({ plantilla: M4 });
  const f1 = foto({ pos: 'lateral', toma_ids: [a.id, b.id], ligada_en: [a.id, b.id] });
  const e = estado({ fotos: [f1], enTelefono: { [a.id]: [{ pos: 'lateral', momento: null, n: 1 }], [b.id]: [{ pos: 'lateral', momento: null, n: 1 }] } });
  const lat = C.fotosDeSitioCaptura([a, b], HOY, e, new Set()).find((x) => x.pos === 'lateral');
  assert.deepEqual([lat.n, lat.tiene, lat.enTelefono], [2, 1, 1]);
});

test('«N fotos arriba sin enviar»: vencidas pendientes con fotos; lo de sitio una vez por día', () => {
  const a = toma({ plantilla: M4, fecha: AYER, tiene: [{ pos: 'lateral', momento: null, n: 2 }, { pos: 'normal', momento: null, n: 1 }] });
  const b = toma({ plantilla: M4, fecha: AYER, tiene: [{ pos: 'lateral', momento: null, n: 2 }] });
  const hoy = toma({ plantilla: M4, tiene: [{ pos: 'normal', momento: null, n: 1 }] });
  const enviada = toma({ plantilla: M4, fecha: AYER, estado: 'por_revisar', tiene: [{ pos: 'normal', momento: null, n: 1 }] });
  assert.equal(C.fotosArribaSinEnviar([a, b, hoy, enviada], HOY), 3);
});

test('tomaAbiertaEnPantalla: la cola manda sobre la lista vieja', () => {
  const t = toma();
  assert.equal(C.tomaAbiertaEnPantalla(t, null), true);
  assert.equal(C.tomaAbiertaEnPantalla(t, estado({ enviadas: [t.id] })), false);
  assert.equal(C.tomaAbiertaEnPantalla(t, estado({ sinEnviar: [{ toma_id: t.id, razon: 'ajena' }] })), false);
  assert.equal(C.tomaAbiertaEnPantalla({ ...t, estado: 'por_revisar' }, null), false);
});

test('«¿Qué es?» por omisión: la fija, la única que falta o «Otra» si ya no falta nada', () => {
  assert.deepEqual(C.queEsPorOmision({ pos: 'lateral', momento: null }, []), { pos: 'lateral', momento: null });
  assert.deepEqual(C.queEsPorOmision(null, [{ pos: 'corta', momento: null }]), { pos: 'corta', momento: null });
  assert.equal(C.queEsPorOmision(null, [{ pos: 'corta', momento: null }, { pos: 'larga', momento: null }]), null);
  // Todo ya está (en el teléfono o arriba) y la toma sigue abierta: «Otra» marcada.
  assert.deepEqual(C.queEsPorOmision(null, []), { pos: C.POS_EXTRA, momento: null });
});

test('«¿Qué es?» sobre toda la tarjeta: lo que le falta a una vencida sin fotos sale aunque la de hoy siga abierta', () => {
  const deHoy = toma({ plantilla: UNICA });
  const vencida = toma({ plantilla: CML, fecha: AYER, campana: 'Suburbia' });
  const ops = C.opcionesQueEs([deHoy, vencida], null, new Set(), HOY);
  assert.deepEqual(ops.map((o) => o.pos), ['normal', 'corta', 'media', 'larga']);
  // La visita (sin fotos de la vencida) no la trae: por eso la hoja usa la tarjeta.
  assert.deepEqual(C.tomasDeVisita({ tomas: [deHoy, vencida], dia: HOY }).map((x) => x.id), [deHoy.id]);
});

test('píldora «⬆ N» e idsEnCola', () => {
  const e1 = estado({ porSubir: 2, fotos: [foto({ toma_ids: [1, 2] })], enviadas: [3], faltan: { 4: [] } });
  const e2 = estado({ porSubir: 1 });
  assert.equal(C.porSubirTotal([e1, e2, null]), 3);
  assert.deepEqual([...C.idsEnCola(e1)].sort(), [1, 2, 3, 4]);
});

// ------------------------------------------------------------
// Revisión adversarial del 26-oct-2026
// ------------------------------------------------------------

const BB_M4 = [
  { pos: 'frontal', n: 1, alcance: 'version', momento: null, etiqueta: 'Frontal' },
  { pos: 'copete', n: 3, alcance: 'sitio', momento: null, etiqueta: 'Copete' },
  { pos: 'lateral', n: 2, alcance: 'sitio', momento: null, etiqueta: 'Lateral' },
];

test('tarjeta de Hoy con solo una vencida bb_m4: la fila «Fotos del sitio» sale con copete y lateral de ese día', () => {
  const vencida = toma({ plantilla: BB_M4, fecha: AYER, unidad: 'Biobox' });
  assert.equal(C.diaFilaSitio([vencida], HOY), AYER);
  const fila = C.fotosDeSitioCaptura([vencida], HOY, null, new Set());
  assert.deepEqual(
    fila.map((f) => [f.pos, f.tiene, f.n]),
    [
      ['copete', 0, 3],
      ['lateral', 0, 2],
    ]
  );
  // Dos campañas vencidas del mismo día: lo de sitio trae marcadas las dos («Todas las del 28-oct»).
  const otra = toma({ plantilla: BB_M4, fecha: AYER, unidad: 'Biobox' });
  const cands = C.candidatasDeCual([vencida, otra], 'copete', null, null, new Set(), HOY);
  const dia = C.diaFilaSitio([vencida, otra], HOY);
  assert.deepEqual(C.todasLasDeHoy(cands, dia).sort(), [vencida.id, otra.id].sort());
  assert.deepEqual(C.seleccionPorOmision(cands, 'sitio', dia, null).sort(), [vencida.id, otra.id].sort());
});

test('hoy completo y devuelta de ayer sin lateral: la fila de sitio es la de hoy y la devuelta pide su lateral aparte', () => {
  const deHoy = toma({
    plantilla: BB_M4,
    tiene: [
      { pos: 'frontal', momento: null, n: 1 },
      { pos: 'copete', momento: null, n: 3 },
      { pos: 'lateral', momento: null, n: 2 },
    ],
  });
  const devuelta = toma({
    plantilla: BB_M4,
    fecha: AYER,
    estado: 'regresada',
    tiene: [
      { pos: 'frontal', momento: null, n: 1 },
      { pos: 'copete', momento: null, n: 3 },
      { pos: 'lateral', momento: null, n: 1 },
    ],
  });
  const dia = C.diaFilaSitio([deHoy, devuelta], HOY);
  assert.equal(dia, HOY);
  const lat = C.fotosDeSitioCaptura([deHoy, devuelta], HOY, null, new Set()).find((x) => x.pos === 'lateral');
  assert.deepEqual([lat.tiene, lat.n], [2, 2]);
  // La devuelta es de otro día: su fila lleva sus casillas de sitio y el lateral falta.
  assert.notEqual(devuelta.fecha, dia);
  const suyo = C.avanceCaptura(devuelta, null, new Set()).find((q) => q.pos === 'lateral');
  assert.deepEqual([suyo.alcance, suyo.tiene, suyo.n], ['sitio', 1, 2]);
  // Y la hoja lo ofrece.
  assert.ok(C.opcionesQueEs([deHoy, devuelta], null, new Set(), HOY).some((o) => o.pos === 'lateral' && o.faltan === 1));
});

test('después de «Quitar»: la casilla descuenta lo que la lista leída todavía traía', () => {
  const t = toma({ plantilla: CML, tiene: [{ pos: 'corta', momento: null, n: 1 }] });
  const P = 'c-quitada';
  const incluidas = new Set([C.llaveLiga(P, t.id)]);
  // Quitada entera y el servidor todavía la tiene (pendiente).
  const e = estado({ retiradas: [{ cliente_id: P, toma_id: t.id, pos: 'corta', momento: null, pendiente: true }] });
  assert.equal(C.avanceCaptura(t, e, incluidas).find((q) => q.pos === 'corta').tiene, 0);
  assert.ok(C.opcionesQueEs([t], e, incluidas, HOY).some((o) => o.pos === 'corta'), '«¿Qué es?» vuelve a ofrecer Corta');
  // La siguiente lectura que empieza mientras sigue pendiente la da por incluida (su `tiene` la trae).
  assert.ok(C.ligasDe([e]).has(C.llaveLiga(P, t.id)));
  // Ya quitada en el servidor: la siguiente lectura no la trae ni la incluye.
  const e2 = estado({ retiradas: [{ cliente_id: P, toma_id: t.id, pos: 'corta', momento: null, pendiente: false }] });
  assert.ok(!C.ligasDe([e2]).has(C.llaveLiga(P, t.id)));
  const releida = { ...t, tiene: [] };
  assert.equal(C.avanceCaptura(releida, e2, C.ligasDe([e2])).find((q) => q.pos === 'corta').tiene, 0);
  // Una lectura vieja que no la incluía no se descuenta dos veces.
  assert.equal(C.avanceCaptura(t, e2, new Set()).find((q) => q.pos === 'corta').tiene, 1);
});

test('«Quitar» y «Quitar de A»: la copia de cámara sale de «Guardar en Fotos» solo cuando la cola la dejó como lápida firme', () => {
  const A = 501;
  const B = 502;
  const p = { cliente_id: 'cq1', nombre: 'COL_551_2910_7.jpg' };
  // Caso 1: A no contaba (B ajena): la foto se queda en la tarjeta sin A.
  const queda = estado({
    fotos: [foto({ cliente_id: 'cq1', estado: 'ligado', toma_ids: [B], no_ligada: [{ toma_id: B, razon: 'ajena' }] })],
    retiradas: [],
    lapidas: [],
  });
  assert.deepEqual(C.camaraPorSacar(queda, [p]), { sacar: [], resueltas: ['cq1'] }, 'se queda: su copia no se saca');
  // Caso 2: A ya enviada o revisada: la base no dejó y la foto sigue en A.
  const enA = estado({
    fotos: [foto({ cliente_id: 'cq1', estado: 'ligado', toma_ids: [B, A], ligada_en: [A], no_ligada: [{ toma_id: B, razon: 'ajena' }] })],
    retiradas: [],
    lapidas: [],
  });
  assert.deepEqual(C.camaraPorSacar(enA, [p]), { sacar: [], resueltas: ['cq1'] }, 'sigue en A: no se saca');
  // La cola todavía no lo resuelve (desligar pendiente): se espera.
  const espera = estado({
    fotos: [foto({ cliente_id: 'cq1', estado: 'ligado', toma_ids: [B], no_ligada: [{ toma_id: B, razon: 'ajena' }] })],
    retiradas: [{ cliente_id: 'cq1', toma_id: A, pos: 'normal', momento: null, pendiente: true }],
    lapidas: [],
  });
  assert.deepEqual(C.camaraPorSacar(espera, [p]), { sacar: [], resueltas: [] });
  // Quitada entera (o era su única toma) y ya confirmada: lápida firme, se saca.
  const lapida = estado({ fotos: [], retiradas: [], lapidas: [{ cliente_id: 'cq1', nombre: p.nombre, porConfirmar: false }] });
  assert.deepEqual(C.camaraPorSacar(lapida, [p]), { sacar: [p.nombre], resueltas: ['cq1'] });
  // La visita ya no está en la cola: ante la duda, la copia se queda.
  assert.deepEqual(C.camaraPorSacar(null, [p]), { sacar: [], resueltas: ['cq1'] });
});

test('«Quitar» entera (26-oct-2026): mientras la base no contesta se espera; si la base no deja y la foto vuelve a la tarjeta, la copia se queda', () => {
  const A = 501;
  const B = 502;
  const p = { cliente_id: 'cq2', nombre: 'COL_551_2910_8.jpg' };
  // Recién tocada: la foto es lápida por confirmar (no está en fotos).
  const espera = estado({ fotos: [], retiradas: [], lapidas: [{ cliente_id: 'cq2', nombre: p.nombre, porConfirmar: true }] });
  assert.deepEqual(C.camaraPorSacar(espera, [p]), { sacar: [], resueltas: [] }, 'no se saca antes de que conteste la base');
  // La base no dejó (Tecate ya enviada): vuelve como 'ligado' y se quita de la abierta.
  const vuelve = estado({
    fotos: [foto({ cliente_id: 'cq2', estado: 'ligado', toma_ids: [A], ligada_en: [A] })],
    retiradas: [{ cliente_id: 'cq2', toma_id: B, pos: 'normal', momento: null, pendiente: true }],
    lapidas: [],
  });
  assert.deepEqual(C.camaraPorSacar(vuelve, [p]), { sacar: [], resueltas: [] }, 'espera el desligue de la abierta');
  const quedo = estado({ fotos: [foto({ cliente_id: 'cq2', estado: 'ligado', toma_ids: [A], ligada_en: [A] })], retiradas: [], lapidas: [] });
  assert.deepEqual(C.camaraPorSacar(quedo, [p]), { sacar: [], resueltas: ['cq2'] }, 'se quedó en Tecate: su copia no se saca');
});

test('«Quitar» confirmada en la misma corrida en que la visita se suelta (27-oct-2026): sin ver la lápida, la copia sale si la cola la quitó de verdad', () => {
  const p = { cliente_id: 'cq3', nombre: 'COL_551_2910_9.jpg' };
  // La pantalla ya no ve la visita (se soltó antes de releer) pero la cola la anotó.
  assert.deepEqual(C.camaraPorSacar(null, [p], new Set(['cq3'])), { sacar: [p.nombre], resueltas: ['cq3'] });
  // Otra visita del mismo sitio ya está en la cola (estado sin la foto): igual.
  assert.deepEqual(C.camaraPorSacar(estado({ fotos: [], lapidas: [], retiradas: [] }), [p], new Set(['cq3'])), {
    sacar: [p.nombre],
    resueltas: ['cq3'],
  });
  // Sin la anota, ante la duda se queda.
  assert.deepEqual(C.camaraPorSacar(null, [p], new Set(['otra'])), { sacar: [], resueltas: ['cq3'] });
});

test('hoja «Usar también para…» (27-oct-2026): se cierra solo si la foto de verdad se fue; si solo se soltó la visita, sigue', () => {
  const f = foto({ trabajo: 'tv', cliente_id: 'ch1', estado: 'ligado', toma_ids: [701], ligada_en: [701] });
  // La cola registró su toma y soltó la visita: la foto sigue arriba y contando.
  assert.equal(C.fotoDeLaHoja(null, f), f, 'visita fuera de la cola: la hoja sigue con la última foto');
  assert.equal(C.fotoDeLaHoja(estado({ trabajos: ['otro'], fotos: [], lapidas: [] }), f), f, 'otro trabajo del sitio: sigue');
  // La de ahora reemplaza a la vieja.
  const ahora = { ...f, ligada_en: [701, 702] };
  assert.equal(C.fotoDeLaHoja(estado({ trabajos: ['tv'], fotos: [ahora], lapidas: [] }), f), ahora);
  // Se fue: su trabajo sigue sin ella (la cola la volvió lápida), es lápida o se perdió.
  assert.equal(C.fotoDeLaHoja(estado({ trabajos: ['tv'], fotos: [], lapidas: [] }), f), null);
  assert.equal(
    C.fotoDeLaHoja(estado({ trabajos: ['otro'], fotos: [], lapidas: [{ cliente_id: 'ch1', nombre: f.nombre, porConfirmar: true }] }), f),
    null
  );
  assert.equal(C.fotoDeLaHoja(estado({ trabajos: ['tv'], fotos: [{ ...f, estado: 'perdido' }], lapidas: [] }), f), null);
});

test('mixto (29-oct-2026): «¿Qué es?» y «¿De cuál?» nunca ofrecen lo que va por cámara', () => {
  // Como la deja misTomasComp: plantilla = campo; por_camara aparte.
  const ML = CML.filter((q) => q.pos !== 'corta');
  const a = toma({ plantilla: ML, por_camara: [{ ...CML[0], via: 'camara' }] });
  const b = toma({ plantilla: ML, por_camara: [{ ...CML[0], via: 'camara' }] });
  const ops = C.opcionesQueEs([a, b], null, new Set(), HOY);
  assert.deepEqual(ops.map((o) => o.pos), ['media', 'larga']);
  assert.deepEqual(C.candidatasDeCual([a, b], 'corta', null, null, new Set(), HOY), []);
  assert.equal(C.candidatasDeCual([a, b], 'media', null, null, new Set(), HOY).length, 2);
  // «Otra» sigue valiendo para cualquiera.
  assert.equal(C.candidatasDeCual([a], C.POS_EXTRA, null, null, new Set(), HOY).length, 1);
});

test('mixto: «Usar también para…» deja libre la campaña donde la foto salió «por cámara» (la base no la ligó)', () => {
  const aAyer = toma({ fecha: AYER, plantilla: UNICA });
  const aHoy = toma({ campana_id: aAyer.campana_id, plantilla: UNICA });
  const f = foto({ toma_ids: [aAyer.id], no_ligada: [{ toma_id: aAyer.id, razon: 'por_camara' }] });
  assert.deepEqual(
    C.candidatasUsarTambien(f, [aAyer, aHoy], null, new Set(), HOY).map((c) => c.id),
    [aHoy.id]
  );
});
