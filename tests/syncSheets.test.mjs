import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// La lógica de la función sync-sheets (Incidencias → Google Sheets por
// unidad, 24-nov-2026). No toca red: solo decide celdas y filas.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../supabase/functions/sync-sheets/logica.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const {
  normalizarEncabezado,
  letraColumna,
  nombreHoja,
  celdaTexto,
  celdaDato,
  destinoDe,
  planear,
  base64Url,
  ENCABEZADOS_BASE,
  CLAVE_ACTUALIZADO,
  faltantes,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

test('cada encabezado de la base sale de una llave de vw_incidencias_sheets', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(
    fileURLToPath(new URL('../supabase/migrations/20261126160022_sheets_incidencia_digital.sql', import.meta.url)),
    'utf8'
  );
  const vista = sql.slice(sql.indexOf('create or replace view public.vw_incidencias_sheets'), sql.indexOf(') app on true;'));
  const llaves = new Set([...vista.matchAll(/^\s*'([a-z0-9]+)',/gm)].map((m) => m[1]));
  const sinLlave = ENCABEZADOS_BASE.map(normalizarEncabezado).filter((k) => k !== CLAVE_ACTUALIZADO && !llaves.has(k));
  assert.deepEqual(sinLlave, []);
  // Sin repetidos: dos encabezados con la misma llave escribirían lo mismo.
  assert.equal(new Set(ENCABEZADOS_BASE.map(normalizarEncabezado)).size, ENCABEZADOS_BASE.length);
});

test('faltantes: los encabezados de la base que no están en la hoja', () => {
  assert.equal(faltantes([]).length, ENCABEZADOS_BASE.length);
  const f = faltantes(['Folio', 'unidad', ' CAMPAÑA ']);
  assert.ok(!f.includes('Folio') && !f.includes('Unidad') && !f.includes('Campaña'));
  assert.ok(f.includes('Actualizado (UTC)'));
});

/** Un renglón de la vista, con lo mínimo. */
function fila(folio, extra = {}) {
  return {
    record_id: 'r-' + folio,
    folio,
    unidad_negocio: 'Biobox',
    texto: { folio, incidencia: 'Falla ' + folio, arearesponsable: 'TI', ...(extra.texto || {}) },
    dato: { fechareporte: '2026-11-24', tiempohoras: 1.5, ...(extra.dato || {}) },
  };
}

test('los encabezados de las hojas Gral se normalizan como las llaves de la vista', () => {
  assert.equal(normalizarEncabezado('Área Responsable'), 'arearesponsable');
  assert.equal(normalizarEncabezado('Alcaldía/Municipio'), 'alcaldiamunicipio');
  assert.equal(normalizarEncabezado('Dirección '), 'direccion');
  assert.equal(normalizarEncabezado('Detalle de Reparación'), 'detalledereparacion');
  assert.equal(normalizarEncabezado('Detalle Reparacion'), 'detallereparacion');
  assert.equal(normalizarEncabezado('Nivel de Incidencia'), 'niveldeincidencia');
  assert.equal(normalizarEncabezado('FechaMes'), 'fechames');
  assert.equal(normalizarEncabezado(null), '');
});

test('letras de columna', () => {
  assert.equal(letraColumna(0), 'A');
  assert.equal(letraColumna(25), 'Z');
  assert.equal(letraColumna(26), 'AA');
  assert.equal(letraColumna(28), 'AC');
  assert.equal(letraColumna(701), 'ZZ');
  assert.equal(letraColumna(702), 'AAA');
});

test('nombre de pestaña entre comillas simples', () => {
  assert.equal(nombreHoja('App'), "'App'");
  assert.equal(nombreHoja("O'Hara"), "'O''Hara'");
});

test('el texto siempre va forzado como texto: ni fórmula, ni número, ni fecha', () => {
  assert.equal(celdaTexto('=HYPERLINK("http://x")'), '\'=HYPERLINK("http://x")');
  assert.equal(celdaTexto('+52 55 1234'), "'+52 55 1234");
  assert.equal(celdaTexto('1/2'), "'1/2");
  assert.equal(celdaTexto('Arte roto'), "'Arte roto");
  assert.equal(celdaTexto(null), '');
  assert.equal(celdaTexto(''), '');
});

test('fechas y números van para que Sheets los convierta', () => {
  assert.equal(celdaDato('2026-11-24'), '2026-11-24');
  assert.equal(celdaDato('36:05:09'), '36:05:09');
  assert.equal(celdaDato(1.25), 1.25);
  assert.equal(celdaDato(null), '');
});

test('destino por unidad sin importar acentos ni mayúsculas', () => {
  const d = { Biobox: 'ARCH-BB', Ecovallas: 'ARCH-EV', 'Vía Verde': ' ARCH-VV ' };
  assert.equal(destinoDe(d, 'Biobox'), 'ARCH-BB');
  assert.equal(destinoDe(d, 'via verde'), 'ARCH-VV');
  assert.equal(destinoDe(d, 'VÍA VERDE'), 'ARCH-VV');
  assert.equal(destinoDe(d, 'Biobox Perú'), null);
  assert.equal(destinoDe(d, null), null);
  assert.equal(destinoDe({ Biobox: '' }, 'Biobox'), null);
});

test('folio que ya está: solo sus columnas conocidas, sin pisar Seguimiento', () => {
  const plan = planear({
    hoja: 'App',
    // C = Seguimiento (manual), E = Tipo de maquina (no viene en la fila).
    encabezados: ['Folio', 'Incidencia', 'Seguimiento', 'FechaReporte', 'Tipo de maquina'],
    folios: ['Folio', 'BBMM00001', 'BBMM00002'],
    escribir: [fila('BBMM00002')],
    borrar: [],
  });
  assert.equal(plan.actualizadas, 1);
  assert.deepEqual(plan.agregar, []);
  assert.deepEqual(plan.actualizar, [
    { range: "'App'!A3:B3", values: [["'BBMM00002", "'Falla BBMM00002"]] },
    { range: "'App'!D3:D3", values: [['2026-11-24']] },
  ]);
});

test('folio nuevo: fila completa al final, vacío lo que la app no llena', () => {
  const plan = planear({
    hoja: 'App',
    encabezados: ['Folio', 'Incidencia', 'Seguimiento', 'TiempoHoras', 'Área Responsable'],
    folios: ['Folio'],
    escribir: [fila('EV00036', { texto: { incidencia: '=1+1' } })],
    borrar: [],
  });
  assert.equal(plan.actualizadas, 0);
  assert.deepEqual(plan.actualizar, []);
  assert.deepEqual(plan.agregar, [["'EV00036", "'=1+1", '', 1.5, "'TI"]]);
});

test('un null de la base borra la celda (la app es la fuente)', () => {
  const plan = planear({
    hoja: 'App',
    encabezados: ['Folio', 'Fecha de Reparación'],
    folios: ['Folio', 'VV00001'],
    escribir: [fila('VV00001', { dato: { fechadereparacion: null } })],
    borrar: [],
  });
  assert.deepEqual(plan.actualizar, [{ range: "'App'!A2:B2", values: [["'VV00001", '']] }]);
});

test('quitar folios borrados, de abajo hacia arriba y sin repetir', () => {
  const plan = planear({
    hoja: 'App',
    encabezados: ['Folio'],
    folios: ['Folio', 'EV00001', '', 'EV00002', 'EV00003'],
    escribir: [],
    borrar: ['EV00001', 'EV00003', 'EV00003', 'NOESTA'],
  });
  assert.deepEqual(plan.borrarFilas, [5, 2]);
});

test('un folio que se escribe no se quita aunque venga en borrar', () => {
  const plan = planear({
    hoja: 'App',
    encabezados: ['Folio'],
    folios: ['Folio', 'BB00001'],
    escribir: [fila('BB00001')],
    borrar: ['BB00001'],
  });
  assert.deepEqual(plan.borrarFilas, []);
  assert.equal(plan.actualizadas, 1);
});

test('Folio en otra columna y folio repetido en la hoja', () => {
  const plan = planear({
    hoja: 'App',
    encabezados: ['Incidencia', ' FOLIO '],
    folios: [' FOLIO ', 'BB00009', 'BB00009'],
    escribir: [fila('BB00009')],
    borrar: [],
  });
  assert.deepEqual(plan.repetidos, ['BB00009']);
  assert.deepEqual(plan.actualizar, [
    { range: "'App'!A2:B2", values: [["'Falla BB00009", "'BB00009"]] },
  ]);
});

test('sin encabezado Folio no se escribe nada', () => {
  assert.throws(
    () => planear({ hoja: 'App', encabezados: ['Incidencia'], folios: [], escribir: [], borrar: [] }),
    /Folio/
  );
});

test('base64 para URL sin relleno', () => {
  assert.equal(base64Url(new Uint8Array([251, 255])), '-_8');
  assert.equal(base64Url(new TextEncoder().encode('hola')), 'aG9sYQ');
});
