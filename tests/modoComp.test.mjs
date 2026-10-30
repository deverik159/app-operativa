// src/lib/modoComp.ts (fase 3 de Comprobaciones, incremento 3; 29-oct-2026):
// la columna «Modo» y el lote «Modo…» de Campañas. pasarA repite el trigger
// comp_campana_modo_trg y comp_poner_modo de la migración comp_f3_revision:
// si cambia una regla allá, cambia aquí. Repo PÚBLICO: datos inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/modoComp.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const M = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const modo = (modo_toma, pos_camara = [], plantilla_codigo = null) => ({ modo_toma, pos_camara, plantilla_codigo });
const camp = (m, { unidad = 'Ecovallas', abierta = true } = {}) => ({ unidad, abierta, modo: m });

test('textoModo: campo, cámaras, mixto con sus posiciones y mixto sin cámara en ámbar', () => {
  assert.equal(M.textoModo(modo('campo'), 'Ecovallas', null).texto, 'Campo');
  assert.equal(M.textoModo(modo('camaras'), 'Vía Verde', null).texto, 'Cámaras');
  assert.equal(M.textoModo(modo('mixto', ['corta'], 'cml'), 'Ecovallas', null).texto, 'Mixto · Corta por cámara');
  // En el orden de la plantilla, no en el de pos_camara.
  assert.equal(M.textoModo(modo('mixto', ['larga', 'corta'], 'cml'), 'Ecovallas', null).texto, 'Mixto · Corta y Larga por cámara');
  const sin = M.textoModo(modo('mixto', [], 'panoramica'), 'Ecovallas', null);
  assert.equal(sin.texto, 'Mixto sin fotos por cámara');
  assert.equal(sin.tono, 'ambar');
  // Sin leer todavía: null (la celda dice «—»).
  assert.equal(M.textoModo(null, 'Ecovallas', null), null);
});

test('textoModo: Biobox siempre Campo en gris, aunque no se haya leído', () => {
  const b = M.textoModo(null, 'Biobox', null);
  assert.equal(b.texto, 'Campo');
  assert.equal(b.tono, 'gris');
});

test('posicionesDeTestigo: una por pos; ángulos de día y de noche dan un solo «Ángulo»', () => {
  assert.deepEqual(M.posicionesDeTestigo(null, 'cml').map((q) => q.pos), ['corta', 'media', 'larga']);
  assert.deepEqual(M.posicionesDeTestigo(null, 'angulos_3_dia_noche'), [{ pos: 'angulo', etiqueta: 'Ángulo' }]);
  // null = la de omisión (una toma).
  assert.deepEqual(M.posicionesDeTestigo(null, null), [{ pos: 'normal', etiqueta: 'Toma' }]);
  // Del catálogo leído antes que de la semilla.
  const cat = [{ codigo: 'x', nombre: 'X', capa: 'testigo', unidad: null, mueble: null, orden: 1, activa: true, confirmada: true, notas: null,
    posiciones: [{ pos: 'corta', n: 1, alcance: 'version', momento: null, etiqueta: 'Cerca' }] }];
  assert.deepEqual(M.posicionesDeTestigo(cat, 'x'), [{ pos: 'corta', etiqueta: 'Cerca' }]);
});

test('unionPosiciones: plantillas distintas dan la unión y cuántas tienen cada una', () => {
  const u = M.unionPosiciones(null, ['cml', 'corta_media', null]);
  assert.equal(u.plantillas, 3);
  assert.equal(u.distintas, true);
  assert.deepEqual(u.posiciones.map((q) => [q.pos, q.en]), [['corta', 2], ['media', 2], ['larga', 1], ['normal', 1]]);
  const una = M.unionPosiciones(null, ['cml', 'cml']);
  assert.equal(una.distintas, false);
  assert.equal(una.posiciones.length, 3);
});

test('pasarA (espejo del trigger): sin elegir, la Corta al ENTRAR a mixto si la plantilla la tiene', () => {
  assert.deepEqual(M.pasarA(camp(modo('campo', [], 'cml')), 'mixto', null, null), { modo_toma: 'mixto', pos_camara: ['corta'] });
  // Sin Corta en la plantilla (Toma, Panorámica, con periódico): queda vacío.
  assert.deepEqual(M.pasarA(camp(modo('campo', [], null)), 'mixto', null, null), { modo_toma: 'mixto', pos_camara: [] });
  assert.deepEqual(M.pasarA(camp(modo('campo', [], 'cml_periodico')), 'mixto', null, null), { modo_toma: 'mixto', pos_camara: [] });
  // Ya en mixto y sin elegir: se queda con las suyas.
  assert.deepEqual(M.pasarA(camp(modo('mixto', ['media'], 'cml')), 'mixto', null, null), { modo_toma: 'mixto', pos_camara: ['media'] });
});

test('pasarA: solo cuentan las posiciones que tiene la plantilla de cada campaña', () => {
  assert.deepEqual(M.pasarA(camp(modo('campo', [], 'corta_media')), 'mixto', ['larga', 'media'], null), { modo_toma: 'mixto', pos_camara: ['media'] });
  // Ninguna le toca y entra a mixto: la Corta (si la tiene).
  assert.deepEqual(M.pasarA(camp(modo('campo', [], 'corta_media')), 'mixto', ['larga'], null), { modo_toma: 'mixto', pos_camara: ['corta'] });
  // Ya era mixto: no se vuelve a poner la Corta (queda sin cámara).
  assert.deepEqual(M.pasarA(camp(modo('mixto', ['corta'], 'corta_media')), 'mixto', ['larga'], null), { modo_toma: 'mixto', pos_camara: [] });
  // Fuera de mixto, vacío.
  assert.deepEqual(M.pasarA(camp(modo('mixto', ['corta'], 'cml')), 'camaras', null, null), { modo_toma: 'camaras', pos_camara: [] });
});

test('pasarA: cerradas, Biobox y sin leer no cambian', () => {
  assert.equal(M.pasarA(camp(modo('campo'), { abierta: false }), 'mixto', null, null), null);
  assert.equal(M.pasarA(camp(modo('campo'), { unidad: 'Biobox' }), 'campo', null, null), null);
  assert.equal(M.pasarA(camp(null), 'mixto', null, null), null);
});

test('simularModo: cuenta las que cambian, las que ya están así y las que quedarían sin cámara', () => {
  const l = [
    camp(modo('campo', [], 'cml')),
    camp(modo('mixto', ['corta'], 'cml')),
    camp(modo('campo', [], 'panoramica')),
    camp(modo('campo', [], 'cml'), { abierta: false }),
    camp(modo('campo'), { unidad: 'Biobox' }),
    camp(null),
  ];
  assert.deepEqual(M.simularModo(l, 'mixto', null, null), { cambian: 2, yaAsi: 1, cerradas: 1, biobox: 1, sinLeer: 1, mixtoSinCamara: 1 });
  assert.deepEqual(M.simularModo(l, 'campo', null, null), { cambian: 1, yaAsi: 2, cerradas: 1, biobox: 1, sinLeer: 1, mixtoSinCamara: 0 });
});

test('posicionesIniciales: las de las mixtas solo si todas coinciden', () => {
  assert.deepEqual(M.posicionesIniciales([camp(modo('mixto', ['media', 'corta'])), camp(modo('mixto', ['corta', 'media'])), camp(modo('campo'))]), ['corta', 'media']);
  assert.deepEqual(M.posicionesIniciales([camp(modo('mixto', ['corta'])), camp(modo('mixto', ['media']))]), []);
  assert.deepEqual(M.posicionesIniciales([camp(modo('campo'))]), []);
});

test('textoResultadoModo: lo que contestó la base, en palabras', () => {
  const r = M.textoResultadoModo({ cambiadas: 3, sin_cambio: 1, cerradas_omitidas: 0, enviadas_conservan: 2, mixto_sin_camara: 1, con_fotos: 4 }, 'mixto');
  assert.equal(r.linea, '✓ 3 cambiadas a Mixto · 1 ya estaba así');
  assert.deepEqual(r.avisos, [
    '2 tomas ya enviadas conservan el modo anterior',
    '1 queda en Mixto sin fotos por cámara (se porta como Campo): elige cuáles',
    '4 tomas pendientes ya tienen fotos de campo de una posición que ahora va por cámara',
  ]);
  const n = M.textoResultadoModo({ cambiadas: 0, sin_cambio: 2, cerradas_omitidas: 1, enviadas_conservan: 0, mixto_sin_camara: 0, con_fotos: 0 }, 'campo');
  assert.equal(n.linea, 'Sin cambios: 2 ya estaban así · 1 cerrada sin tocar.');
  assert.deepEqual(n.avisos, []);
});

test('listaY', () => {
  assert.equal(M.listaY(['Corta']), 'Corta');
  assert.equal(M.listaY(['Corta', 'Media']), 'Corta y Media');
  assert.equal(M.listaY(['Corta', 'Media', 'Larga']), 'Corta, Media y Larga');
});
