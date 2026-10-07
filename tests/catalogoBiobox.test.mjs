import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// catalogo.ts importa constants/helpers: se empaqueta en memoria.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/catalogo.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { catalogoBiobox, catalogoDesdeArbol, esUnidadBiobox, llaveCatalogo, elementoDeIncidencia, ubicacionSinCara, ladoAlReclasificar } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const fila = (detalle, area, tipo_mueble = 'M4', impacto = 'Alto') => ({
  detalle, area, impacto, origen: 'Externo', tipo: 'Imponderable', tipo_mueble,
});

// Catálogo de Biobox como lo siembra biobox_causas.sql: el mueble es el
// modelo de la máquina (M4, M5…), igual para la cara digital y la impresa.
const CAT = [
  fila('Chapa dañada', 'Op. Bio Box'),
  fila('Chapa dañada', 'Op. Bio Box', 'M5'),
  fila('Teltonika dañado', 'TI', 'M4', 'Medio'),
  fila('Apagado parcial', 'Digital'),
  fila('Falta arte', 'Digital', 'M4', 'Medio'),
  fila('Falla en el proceso de reciclaje', 'Op. Bio Box'),
  fila('Solo en M5', 'Op. Bio Box', 'M5'),
  fila('Pantalla sin imagen', 'Digital', 'M5', 'Bajo'),
];
// El árbol trae una fila por causa/solución: nombres repetidos.
const ARBOL = [
  'Apagado parcial', 'Apagado parcial', 'Pantalla sin imagen',
  'falla en el proceso de RECICLAJE ', 'Sin video', 'Sin video',
];

const nombres = (r) => r.opciones.map((o) => `${o.detalle} (${o.area})`);

test('Biobox: árbol + catálogo sin Digital, cada falla una sola vez', () => {
  const r = catalogoBiobox(ARBOL, CAT, ['M4']);
  assert.equal(r.biobox, true);
  assert.equal(r.restringido, true);
  assert.deepEqual(nombres(r), [
    'Apagado parcial (Digital)',
    'Chapa dañada (Op. Bio Box)',
    // Regla 3: en el árbol y en el catálogo con otra área → una vez, tal
    // como lo tiene el catálogo (texto y área).
    'Falla en el proceso de reciclaje (Op. Bio Box)',
    'Pantalla sin imagen (Digital)',
    'Sin video (Digital)',
    'Teltonika dañado (TI)',
  ]);
  // "Falta arte" es Digital del catálogo y no está en el árbol: no sale.
  assert.ok(!r.opciones.some((o) => o.detalle === 'Falta arte'));
  // Llaves únicas: el <select> no repite opciones.
  const llaves = r.opciones.map(llaveCatalogo);
  assert.equal(new Set(llaves).size, llaves.length);
});

test('Biobox: el nombre del árbol hereda nivel de su fila Digital', () => {
  const r = catalogoBiobox(ARBOL, CAT, ['M4']);
  const ap = r.opciones.find((o) => o.detalle === 'Apagado parcial');
  assert.equal(ap.impacto, 'Alto');
  // Sin fila en el mueble, la toma de la Digital de otro mueble de la unidad.
  const psi = r.opciones.find((o) => o.detalle === 'Pantalla sin imagen');
  assert.equal(psi.area, 'Digital');
  assert.equal(psi.impacto, 'Bajo');
  // Sin fila en ningún lado: Digital, sin nivel.
  const sv = r.opciones.find((o) => o.detalle === 'Sin video');
  assert.equal(sv.area, 'Digital');
  assert.equal(sv.impacto, null);
  const rec = r.opciones.filter((o) => /reciclaje/i.test(o.detalle));
  assert.equal(rec.length, 1);
  assert.equal(rec[0].detalle, 'Falla en el proceso de reciclaje');
});

test('Biobox: la lista no depende del medio, solo del mueble', () => {
  const m4 = catalogoBiobox(ARBOL, CAT, ['M4']);
  assert.deepEqual(catalogoBiobox(ARBOL, CAT, ['M4', 'M4']).opciones, m4.opciones);
  const m5 = catalogoBiobox(ARBOL, CAT, ['M5']);
  assert.ok(nombres(m5).includes('Solo en M5 (Op. Bio Box)'));
  assert.ok(!nombres(m4).includes('Solo en M5 (Op. Bio Box)'));
  assert.ok(!nombres(m5).includes('Teltonika dañado (TI)'));
});

test('Biobox: si el árbol no cargó, cae al catálogo completo del mueble', () => {
  const r = catalogoBiobox([], CAT, ['M4']);
  assert.ok(!r.biobox);
  assert.ok(nombres(r).includes('Falta arte (Digital)'));
});

test('Biobox: mueble desconocido avisa y usa todo el catálogo de la unidad', () => {
  const r = catalogoBiobox(ARBOL, CAT, ['Otro']);
  assert.equal(r.restringido, false);
  assert.deepEqual(r.sinCatalogo, ['Otro']);
  assert.ok(nombres(r).includes('Solo en M5 (Op. Bio Box)'));
  assert.ok(!r.opciones.some((o) => o.area === 'Digital' && o.detalle === 'Falta arte'));
});

test('Biobox: sin catálogo cargado sale el árbol y no se acusa al mueble', () => {
  const r = catalogoBiobox(ARBOL, [], ['M4']);
  assert.equal(r.biobox, true);
  assert.deepEqual(r.sinCatalogo, []);
  assert.ok(r.opciones.length > 0 && r.opciones.every((o) => o.area === 'Digital'));
});

test('Biobox: el mismo nombre Digital y de otra área en el mueble sale con las dos', () => {
  const cat = [...CAT, fila('Apagado parcial', 'Iluminación')];
  const r = catalogoBiobox(ARBOL, cat, ['M4']);
  assert.deepEqual(
    nombres(r).filter((n) => n.startsWith('Apagado parcial')),
    ['Apagado parcial (Digital)', 'Apagado parcial (Iluminación)']
  );
});

test('Fuera de Biobox la cara digital sigue siendo solo árbol', () => {
  const r = catalogoDesdeArbol(ARBOL, CAT, ['M4']);
  assert.ok(!nombres(r).includes('Chapa dañada (Op. Bio Box)'));
  assert.equal(esUnidadBiobox('Biobox'), true);
  assert.equal(esUnidadBiobox(' biobox perú '), true);
  assert.equal(esUnidadBiobox('Ecovallas'), false);
  assert.equal(esUnidadBiobox(''), false);
});

test('Adicional y Puerta se reconocen por el texto de la incidencia', () => {
  assert.equal(elementoDeIncidencia('Adicional dañado'), 'Adicional');
  assert.equal(elementoDeIncidencia('ADICIONAL roto'), 'Adicional');
  assert.equal(elementoDeIncidencia('Puertas / copetes abiertos'), 'Puerta');
  assert.equal(elementoDeIncidencia('Puerta sin chapa'), 'Puerta');
  assert.equal(elementoDeIncidencia('Pantalla apagada'), null);
  assert.equal(elementoDeIncidencia('Chapa dañada'), null);
  assert.equal(elementoDeIncidencia(null), null);
});

test('Sin cara: medio y mueble salen de las caras del mueble elegido', () => {
  const dig = { tipo_medio: 'Digital', tipo_mueble: 'Ecovallas Digital' };
  const imp = { tipo_medio: 'Impreso', tipo_mueble: 'Ecovallas Fijas' };
  // Sitio mixto: el mueble de la entrada decide.
  assert.deepEqual(ubicacionSinCara('ecovallas fijas ', [dig, imp]), {
    medio: 'Impreso', tipo_mueble: 'Ecovallas Fijas',
  });
  assert.deepEqual(ubicacionSinCara('Ecovallas Digital', [dig, imp, imp]), {
    medio: 'Digital', tipo_mueble: 'Ecovallas Digital',
  });
  // Entrada solo del árbol (sin mueble): las caras marcadas, todas digitales.
  assert.deepEqual(ubicacionSinCara(null, [dig, dig]), {
    medio: 'Digital', tipo_mueble: 'Ecovallas Digital',
  });
  // Sin un único valor: null, no se inventa.
  assert.deepEqual(ubicacionSinCara(null, [dig, imp]), { medio: null, tipo_mueble: null });
  assert.deepEqual(ubicacionSinCara('Otro', [imp, imp]), {
    medio: 'Impreso', tipo_mueble: 'Ecovallas Fijas',
  });
});

test('Al reclasificar, el lado entra o sale del Adicional y la Puerta', () => {
  assert.equal(ladoAlReclasificar('Norte', 'Adicional dañado'), 'Adicional');
  assert.equal(ladoAlReclasificar(null, 'Puertas / copetes abiertos'), 'Puerta');
  assert.equal(ladoAlReclasificar('Adicional', 'Pantalla apagada'), null);
  assert.equal(ladoAlReclasificar('Adicional', 'Puerta sin chapa'), 'Puerta');
  assert.equal(ladoAlReclasificar('Adicional', 'Adicional roto'), undefined);
  assert.equal(ladoAlReclasificar('Sur', 'Pantalla apagada'), undefined);
  assert.equal(ladoAlReclasificar(null, 'Chapa dañada'), undefined);
});
