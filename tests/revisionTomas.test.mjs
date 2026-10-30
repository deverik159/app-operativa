// src/lib/revisionTomas.ts (fase 3 de Comprobaciones, incremento 3;
// 29-oct-2026): el espejo en la app de comp_plantilla_toma (con su «via»),
// de la parte de cámara que falta y de las rutas que valida
// comp_subir_captura y comp_revisar_fotos. Si cambia una regla en la
// migración comp_f3_revision, cambia aquí. Repo PÚBLICO: datos inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/revisionTomas.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const R = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const CML = [
  { pos: 'corta', n: 1, alcance: 'version', momento: null, etiqueta: 'Corta' },
  { pos: 'media', n: 1, alcance: 'version', momento: null, etiqueta: 'Media' },
  { pos: 'larga', n: 1, alcance: 'version', momento: null, etiqueta: 'Larga' },
];
let id = 0;
const foto = (o) => ({
  evidencia_id: ++id,
  toma_id: 1,
  cliente_id: 'c' + id,
  path: 'comp/x/' + id + '.jpg',
  tipo: 'foto',
  pos: 'media',
  momento: null,
  fecha: '2026-10-29',
  origen: 'campo',
  subido_por: 'mon@x',
  creado_en: '2026-10-29T15:00:00Z',
  tomada_en_tel: null,
  devuelta: false,
  revision: null,
  otras_tomas: 0,
  ...o,
});
const buena = { estado: 'correcta', motivo: null, editada_path: null, revisado_por: 'ana@x', revisado_en: '2026-10-29T16:00:00Z' };

test('conVia: campo no marca nada; cámaras todo; mixto solo las de pos_camara (como comp_plantilla_toma)', () => {
  assert.deepEqual(R.conVia(CML, { modo_toma: 'campo', pos_camara: [] }).map((q) => q.via), [undefined, undefined, undefined]);
  assert.deepEqual(R.conVia(CML, { modo_toma: 'camaras', pos_camara: [] }).map((q) => q.via), ['camara', 'camara', 'camara']);
  assert.deepEqual(R.conVia(CML, { modo_toma: 'mixto', pos_camara: ['corta'] }).map((q) => q.via), ['camara', undefined, undefined]);
  // Una via vieja no se arrastra.
  assert.equal(R.conVia([{ ...CML[0], via: 'camara' }], { modo_toma: 'campo', pos_camara: [] })[0].via, undefined);
});

test('plantillaDeToma: la enviada si espera revisión o ya se comprobó; si no, la vigente (A2 y regla de la devuelta)', () => {
  const usada = [{ ...CML[1] }];
  const vig = R.conVia(CML, { modo_toma: 'mixto', pos_camara: ['corta'] });
  assert.deepEqual(R.plantillaDeToma({ estado: 'por_revisar', plantilla_usada: usada }, vig), usada);
  assert.deepEqual(R.plantillaDeToma({ estado: 'comprobada', plantilla_usada: usada }, vig), usada);
  assert.deepEqual(R.plantillaDeToma({ estado: 'regresada', plantilla_usada: usada }, vig), vig);
  assert.deepEqual(R.plantillaDeToma({ estado: 'pendiente', plantilla_usada: null }, vig), vig);
  assert.deepEqual(R.parteCamara(vig).map((q) => q.pos), ['corta']);
  assert.deepEqual(R.parteCampo(vig).map((q) => q.pos), ['media', 'larga']);
});

test('resumenToma: cuenta campo, sin revisar, capturas, devueltas y la cámara que falta', () => {
  const pl = R.conVia(CML, { modo_toma: 'mixto', pos_camara: ['corta'] });
  const fotos = [
    foto({ pos: 'media', revision: buena }),
    foto({ pos: 'larga' }),
    foto({ pos: 'larga', devuelta: true, revision: { ...buena, estado: 'rechazada', motivo: 'movida' } }),
  ];
  let r = R.resumenToma(pl, fotos);
  assert.deepEqual([r.campo, r.sinRevisar, r.camara, r.devueltas, r.faltaCamara.map((f) => f.pos)], [2, 1, 0, 1, ['corta']]);
  // Como comp_faltan: una Corta de campo (subida antes de pasar a mixto) también cubre la posición.
  r = R.resumenToma(pl, [...fotos, foto({ pos: 'corta' })]);
  assert.deepEqual(r.faltaCamara.map((f) => f.pos), []);
  r = R.resumenToma(pl, [...fotos, foto({ pos: 'corta', origen: 'camara', revision: buena })]);
  assert.deepEqual([r.camara, r.faltaCamara.length], [1, 0]);
  // Un video de cámara no cuenta.
  r = R.resumenToma(pl, [foto({ pos: 'corta', origen: 'camara', tipo: 'video' })]);
  assert.equal(r.faltaCamara.length, 1);
});

test('bandejasDe: por revisar, devueltas, comprobadas y por capturar (solo hoy o antes y con parte de cámara)', () => {
  const hoy = '2026-10-29';
  assert.deepEqual(R.bandejasDe({ estado: 'por_revisar', fecha: hoy }, { tieneCamara: true, faltaCamara: 1 }, hoy), ['por_revisar', 'por_capturar']);
  assert.deepEqual(R.bandejasDe({ estado: 'por_revisar', fecha: hoy }, { tieneCamara: false, faltaCamara: 0 }, hoy), ['por_revisar']);
  assert.deepEqual(R.bandejasDe({ estado: 'regresada', fecha: hoy }, { tieneCamara: true, faltaCamara: 0 }, hoy), ['devueltas']);
  assert.deepEqual(R.bandejasDe({ estado: 'comprobada', fecha: hoy }, { tieneCamara: true, faltaCamara: 1 }, hoy), ['comprobadas']);
  assert.deepEqual(R.bandejasDe({ estado: 'pendiente', fecha: hoy }, { tieneCamara: true, faltaCamara: 3 }, hoy), ['por_capturar']);
  assert.deepEqual(R.bandejasDe({ estado: 'pendiente', fecha: '2026-10-30' }, { tieneCamara: true, faltaCamara: 3 }, hoy), []);
  assert.deepEqual(R.bandejasDe({ estado: 'cancelada', fecha: hoy }, { tieneCamara: true, faltaCamara: 3 }, hoy), []);
});

test('enFiltroDia y sumarDias', () => {
  const hoy = '2026-11-01';
  assert.equal(R.sumarDias(hoy, -1), '2026-10-31');
  assert.ok(R.enFiltroDia(hoy, 'hoy', hoy));
  assert.ok(R.enFiltroDia('2026-10-31', 'ayer', hoy));
  assert.ok(!R.enFiltroDia('2026-10-30', 'ayer', hoy));
  assert.ok(R.enFiltroDia('2026-10-26', '7', hoy));
  assert.ok(!R.enFiltroDia('2026-10-25', '7', hoy));
  assert.ok(!R.enFiltroDia('2026-11-02', '7', hoy), 'a futuro no');
  assert.ok(R.enFiltroDia('2025-01-01', 'todo', hoy));
});

test('ordenarFotos: en el orden de la plantilla, numera solo las vigentes; nombreFoto con sitio y día', () => {
  const fs = [foto({ pos: 'larga' }), foto({ pos: 'extra' }), foto({ pos: 'corta', devuelta: true }), foto({ pos: 'corta' }), foto({ pos: 'media' })];
  const o = R.ordenarFotos(fs, CML);
  assert.deepEqual(o.map((f) => [f.pos, f.n]), [['corta', 1], ['media', 2], ['larga', 3], ['extra', 4], ['corta', null]]);
  assert.equal(R.nombreFoto('COL_551', '2026-10-29', 2), 'COL_551_2910_2');
  assert.equal(R.nombreFoto('MX CM/1', '2026-01-05', null), 'MX_CM_1_0501');
  assert.equal(R.pathVigente({ path: 'a.jpg', revision: { ...buena, estado: 'editada', editada_path: 'e.jpg' } }), 'e.jpg');
  assert.equal(R.pathVigente({ path: 'a.jpg', revision: buena }), 'a.jpg');
});

test('rutas de Storage: las mismas que valida la base', () => {
  const cid = '0b1c2d3e-0000-4000-8000-000000000001';
  assert.equal(R.rutaCaptura('Vía Verde', 'COL_551', '2026-10-29', cid, 'jpg'), `comp/via-verde/2026-10/COL_551/20261029_${cid}.jpg`);
  assert.equal(R.rutaEditada('Ecovallas', 77, '2026-11-02', 1761750000000, 'png'), 'comp-analista/ecovallas/2026-11/77_editada_1761750000000.png');
  assert.throws(() => R.rutaCaptura('Otra', 'X', '2026-10-29', cid, 'jpg'));
  assert.equal(R.extensionDe('foto.JPEG'), 'jpeg');
  assert.equal(R.extensionDe('sinpunto'), 'jpg');
  assert.equal(R.extensionDe('x.toolongext'), 'jpg');
});

test('diasCaptura: del más reciente al más viejo, nunca a futuro y siempre con el día de la toma', () => {
  assert.deepEqual(R.diasCaptura('2026-10-03', '2026-10-01', '2026-10-31', '2026-10-02'), ['2026-10-03', '2026-10-02', '2026-10-01']);
  // La toma quedó fuera de la vigencia de la campaña: su día entra.
  assert.deepEqual(R.diasCaptura('2026-10-10', '2026-10-05', '2026-10-06', '2026-10-08'), ['2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05']);
  assert.deepEqual(R.diasCaptura('2026-10-01', '2026-10-05', '2026-10-31', '2026-10-05'), []);
});

test('textoCodigoRevision: cada código de las RPC tiene su texto y lo desconocido uno genérico', () => {
  for (const c of ['ocupada', 'sin_permiso', 'toma_cerrada', 'incompleta', 'por_camara', 'comprobada', 'captura_cerrada', 'sin_objeto'])
    assert.notEqual(R.textoCodigoRevision(c), R.textoCodigoRevision('raro'), c);
  assert.match(R.textoCodigoRevision(undefined), /Recarga/);
});
