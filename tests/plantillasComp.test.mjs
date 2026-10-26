// src/lib/plantillasComp.ts (fase 3 de Comprobaciones, 26-oct-2026): el
// espejo de comp_plantilla_toma y comp_faltan. Los casos son los de la
// especificación (§8, incremento 1, PGlite 1): la base y la app deben dar lo
// MISMO. Si cambia una regla en la migración comp_f3_modelo, cambia aquí.
// Repo PÚBLICO: datos inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/plantillasComp.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const P = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const CAT = P.CATALOGO_SEMILLA;

/** [pos, n, alcance, momento] de cada posición: lo que importa para contar. */
const forma = (l) => l.map((q) => [q.pos, q.n, q.alcance, q.momento]);

test('el catálogo sembrado: 12 plantillas, 7 de testigo y 5 de mueble de Biobox', () => {
  assert.equal(CAT.length, 12);
  assert.equal(CAT.filter((x) => x.capa === 'testigo').length, 7);
  const muebles = CAT.filter((x) => x.capa === 'mueble');
  assert.equal(muebles.length, 5);
  // B3: en capa mueble, unidad y mueble nunca vacíos.
  for (const m of muebles) {
    assert.equal(m.unidad, 'Biobox');
    assert.ok(m.mueble);
  }
  // Por omisión: 'unica', confirmada.
  assert.equal(P.PLANTILLA_POR_OMISION, 'unica');
  assert.equal(CAT.find((x) => x.codigo === 'unica').confirmada, true);
});

test('Biobox M4: copete 3 + lateral 2 (sitio) + la de la campaña (normal 1)', () => {
  const r = P.plantillaResuelta(CAT, { codigo: null, unidad: 'Biobox', mueble: 'M4' });
  assert.deepEqual(forma(r), [
    ['normal', 1, 'version', null],
    ['copete', 3, 'sitio', null],
    ['lateral', 2, 'sitio', null],
  ]);
});

test('Biobox M4-R2 y M5 OXXO (provisional): lateral 2 + frontal', () => {
  assert.deepEqual(forma(P.plantillaResuelta(CAT, { codigo: null, unidad: 'Biobox', mueble: 'M4-R2' })), [
    ['normal', 1, 'version', null],
    ['lateral', 2, 'sitio', null],
  ]);
  const oxxo = P.plantillaResuelta(CAT, { codigo: null, unidad: 'Biobox', mueble: 'M5 OXXO' });
  assert.deepEqual(forma(oxxo), [
    ['normal', 1, 'version', null],
    ['lateral', 2, 'sitio', null],
  ]);
  assert.equal(CAT.find((x) => x.codigo === 'bb_m5oxxo').confirmada, false);
});

test('el mueble se compara EXACTO: «M5» no es «M5 OXXO» y un mueble desconocido = solo testigo', () => {
  assert.deepEqual(forma(P.plantillaResuelta(CAT, { codigo: null, unidad: 'Biobox', mueble: 'M9' })), [
    ['normal', 1, 'version', null],
  ]);
  assert.deepEqual(forma(P.plantillaResuelta(CAT, { codigo: null, unidad: 'Biobox', mueble: 'm4' })), [
    ['normal', 1, 'version', null],
  ]);
  assert.deepEqual(forma(P.plantillaResuelta(CAT, { codigo: null, unidad: 'Biobox', mueble: null })), [
    ['normal', 1, 'version', null],
  ]);
});

test('el mueble solo cuenta en su unidad: una M4 de Vía Verde no pide copetes', () => {
  assert.deepEqual(forma(P.plantillaResuelta(CAT, { codigo: null, unidad: 'Vía Verde', mueble: 'M4' })), [
    ['normal', 1, 'version', null],
  ]);
});

test('Ecovallas con «cml» = 3 fotos de la versión; Vía Verde por omisión = una', () => {
  const eco = P.plantillaResuelta(CAT, { codigo: 'cml', unidad: 'Ecovallas', mueble: null });
  assert.deepEqual(forma(eco), [
    ['corta', 1, 'version', null],
    ['media', 1, 'version', null],
    ['larga', 1, 'version', null],
  ]);
  assert.equal(eco.reduce((a, q) => a + q.n, 0), 3);
  assert.deepEqual(forma(P.plantillaResuelta(CAT, { codigo: null, unidad: 'Vía Verde', mueble: null })), [
    ['normal', 1, 'version', null],
  ]);
  // Un código que no está en el catálogo cuenta como la de omisión.
  assert.deepEqual(forma(P.plantillaResuelta(CAT, { codigo: 'no_existe', unidad: 'Vía Verde', mueble: null })), [
    ['normal', 1, 'version', null],
  ]);
});

test('dos capas con la misma posición se juntan: n mayor y alcance sitio si alguna lo es', () => {
  const cat = [
    ...CAT,
    {
      codigo: 'lateral_uno',
      nombre: 'Una lateral',
      capa: 'testigo',
      unidad: null,
      mueble: null,
      posiciones: [{ pos: 'lateral', n: 1, alcance: 'version', momento: null, etiqueta: 'Lateral de la campaña' }],
      orden: 200,
      activa: true,
      confirmada: false,
      notas: null,
    },
  ];
  const r = P.plantillaResuelta(cat, { codigo: 'lateral_uno', unidad: 'Biobox', mueble: 'M4' });
  assert.deepEqual(forma(r), [
    ['lateral', 2, 'sitio', null],
    ['copete', 3, 'sitio', null],
  ]);
  // Se queda la etiqueta (y el lugar) de la primera que apareció.
  assert.equal(r[0].etiqueta, 'Lateral de la campaña');
});

test('día y noche son posiciones distintas: no se juntan', () => {
  const r = P.plantillaResuelta(CAT, { codigo: 'angulos_3_dia_noche', unidad: 'Ecovallas', mueble: null });
  assert.deepEqual(forma(r), [
    ['angulo', 3, 'version', 'dia'],
    ['angulo', 3, 'version', 'noche'],
  ]);
});

test('un mueble inactivo no suma', () => {
  const cat = CAT.map((x) => (x.codigo === 'bb_m4' ? { ...x, activa: false } : x));
  assert.deepEqual(forma(P.plantillaResuelta(cat, { codigo: null, unidad: 'Biobox', mueble: 'M4' })), [
    ['normal', 1, 'version', null],
  ]);
});

test('faltan (comp_faltan): solo lo que tiene menos de n; [] = completa', () => {
  const pl = P.plantillaResuelta(CAT, { codigo: 'cml', unidad: 'Ecovallas', mueble: null });
  assert.deepEqual(
    P.faltan(pl, []).map((f) => [f.pos, f.n, f.tiene]),
    [
      ['corta', 1, 0],
      ['media', 1, 0],
      ['larga', 1, 0],
    ]
  );
  const parcial = [{ pos: 'corta', momento: null, n: 1 }];
  assert.deepEqual(
    P.faltan(pl, parcial).map((f) => f.pos),
    ['media', 'larga']
  );
  const todo = ['corta', 'media', 'larga'].map((pos) => ({ pos, momento: null, n: 1 }));
  assert.deepEqual(P.faltan(pl, todo), []);
  assert.equal(P.completa(pl, todo), true);
  assert.equal(P.completa(pl, parcial), false);
});

test('faltan: de más no estorba; extra y otra posición no cuentan; renglones repetidos se suman', () => {
  const m4 = P.plantillaResuelta(CAT, { codigo: null, unidad: 'Biobox', mueble: 'M4' });
  const tiene = [
    { pos: 'normal', momento: null, n: 2 },
    { pos: 'copete', momento: null, n: 2 },
    { pos: 'copete', momento: null, n: 1 },
    { pos: 'extra', momento: null, n: 5 },
    { pos: 'larga', momento: null, n: 1 },
  ];
  assert.deepEqual(
    P.faltan(m4, tiene).map((f) => [f.pos, f.n, f.tiene]),
    [['lateral', 2, 0]]
  );
  assert.deepEqual(
    P.faltan(m4, [...tiene, { pos: 'lateral', momento: null, n: 2 }]),
    []
  );
});

test('faltan: el momento debe empatar (null solo con null)', () => {
  const dn = P.plantillaResuelta(CAT, { codigo: 'angulos_3_dia_noche', unidad: 'Ecovallas', mueble: null });
  const tiene = [
    { pos: 'angulo', momento: 'dia', n: 3 },
    { pos: 'angulo', momento: null, n: 3 },
  ];
  assert.deepEqual(
    P.faltan(dn, tiene).map((f) => [f.pos, f.momento, f.tiene]),
    [['angulo', 'noche', 0]]
  );
  const una = P.plantillaResuelta(CAT, { codigo: null, unidad: 'Vía Verde', mueble: null });
  assert.equal(P.completa(una, [{ pos: 'normal', momento: 'dia', n: 1 }]), false);
});

test('lectura tolerante: posiciones rotas se descartan, n se acota', () => {
  const l = P.leerPosiciones([
    { pos: 'corta', n: 1, alcance: 'version', momento: null, etiqueta: 'Corta' },
    { pos: 'MAL ESCRITA', n: 1 },
    { pos: 'media', n: 0 },
    { pos: 'larga', n: '2', alcance: 'raro', momento: 'tarde' },
    null,
    'texto',
    { pos: 'angulo', n: 99 },
  ]);
  assert.deepEqual(forma(l), [
    ['corta', 1, 'version', null],
    ['larga', 2, 'version', null],
    ['angulo', 20, 'version', null],
  ]);
  assert.equal(l[1].etiqueta, 'Larga');
  assert.deepEqual(P.leerPosiciones(null), []);
  assert.deepEqual(P.leerTiene([{ pos: 'corta', n: 1 }, { pos: '', n: 1 }, { pos: 'media', n: -1 }]), [
    { pos: 'corta', momento: null, n: 1 },
  ]);
});

test('nombres y elegibles: solo testigo activa, en su orden; NULL = «Una toma»', () => {
  assert.equal(P.nombrePlantilla([], null), 'Una toma');
  assert.equal(P.nombrePlantilla([], 'cml'), 'Corta, media y larga');
  assert.equal(P.nombrePlantilla([], 'xyz'), 'xyz');
  const el = P.plantillasElegibles(CAT).map((x) => x.codigo);
  assert.deepEqual(el, ['unica', 'cml', 'cml_periodico', 'corta_media', 'panoramica', 'angulos_3', 'angulos_3_dia_noche']);
  const sinPano = CAT.map((x) => (x.codigo === 'panoramica' ? { ...x, activa: false } : x));
  assert.equal(P.plantillasElegibles(sinPano).some((x) => x.codigo === 'panoramica'), false);
  assert.equal(
    P.resumenPosiciones(P.plantillaResuelta(CAT, { codigo: null, unidad: 'Biobox', mueble: 'M4' })),
    'Toma 1 · Copete 3 (del sitio) · Lateral 2 (del sitio)'
  );
});

test('leerPlantilla: una fila de comp_plantillas_toma', () => {
  const p = P.leerPlantilla({
    codigo: 'bb_m4',
    nombre: 'Biobox M4',
    capa: 'mueble',
    unidad: 'Biobox',
    mueble: 'M4',
    posiciones: [{ pos: 'copete', n: 3, alcance: 'sitio', momento: null, etiqueta: 'Copete' }],
    orden: 110,
    activa: true,
    confirmada: true,
    notas: 'x',
  });
  assert.equal(p.capa, 'mueble');
  assert.equal(p.posiciones[0].alcance, 'sitio');
  assert.equal(P.leerPlantilla({ nombre: 'sin código' }), null);
  assert.equal(P.leerPlantilla(null), null);
});
