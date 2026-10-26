// src/lib/misTomasComp.ts (fase 3 de Comprobaciones, 26-oct-2026): la lista
// del monitorista en Mis rutas › Comprobaciones. Casos de la especificación
// (§8, incremento 1): devueltas primero, ruta y secuencia, «Sin ruta» al
// final, varias versiones por sitio; más lo que entra en HOY (vencidas y
// devueltas de otros días) y la lectura tolerante de la respuesta y de la
// copia del teléfono. Repo PÚBLICO: datos inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/misTomasComp.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const M = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const HOY = '2026-10-29';
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

let sig = 1;
/** Una toma como la manda comp_mis_tomas. */
const toma = (o) => ({
  id: sig++,
  estado: 'pendiente',
  fecha: HOY,
  horario_texto: null,
  turno: null,
  observaciones: null,
  notas: null,
  regreso_n: 0,
  rechazo_motivo: null,
  campana_id: 10,
  campana: 'CAMPAÑA',
  version: 'V1',
  especificacion: null,
  plantilla_codigo: null,
  sitio_id: 100,
  sitio_clave: 'COL_1',
  site_id: 'COL_1',
  vendor_face_id: null,
  espacio_vv: null,
  mueble: null,
  lat: 19.4,
  lng: -99.1,
  ruta_id: null,
  ruta_numero: null,
  secuencia: null,
  plantilla: UNICA,
  tiene: [],
  ...o,
});

const leer = (tomas) => M.leerMisTomas({ hoy: HOY, captura: false, unidades: ['Vía Verde'], tomas }).tomas;

test('orden: devueltas primero; luego ruta y parada; «Sin ruta» al final por clave', () => {
  const tomas = leer([
    toma({ sitio_clave: 'COL_9', ruta_id: 5, ruta_numero: 2, secuencia: 3 }),
    toma({ sitio_clave: 'COL_10', ruta_id: 5, ruta_numero: 2, secuencia: 1 }),
    toma({ sitio_clave: 'COL_3', ruta_id: 4, ruta_numero: 1, secuencia: 7 }),
    toma({ sitio_clave: 'COL_20' }),
    toma({ sitio_clave: 'COL_4' }),
    toma({ sitio_clave: 'COL_8', ruta_id: 5, ruta_numero: 2, secuencia: 9, estado: 'regresada', rechazo_motivo: 'Salió movida', fecha: '2026-10-27' }),
    toma({ sitio_clave: 'COL_2', ruta_id: 5, ruta_numero: 2, secuencia: null }),
  ]);
  const t = M.armarTarjetas(tomas, HOY, HOY);
  assert.deepEqual(
    t.map((x) => x.sitio_clave),
    ['COL_8', 'COL_3', 'COL_10', 'COL_9', 'COL_2', 'COL_4', 'COL_20']
  );
  assert.equal(t[0].devuelta, true);
  assert.equal(M.textoRuta(t[1]), 'Ruta 1 · parada 7');
  assert.equal(M.textoRuta(t[4]), 'Ruta 2');
  assert.equal(M.textoRuta(t[6]), 'Sin ruta');
});

test('varias versiones en un sitio = UNA tarjeta, con devueltas, pendientes y enviadas en ese orden', () => {
  const tomas = leer([
    toma({ campana: 'TELCEL', version: 'V3', campana_id: 3, ruta_numero: 2, ruta_id: 5, secuencia: 5, plantilla: CML }),
    toma({ campana: 'DISNEY', version: 'V1', campana_id: 4, estado: 'por_revisar', ruta_numero: 2, ruta_id: 5, secuencia: 5 }),
    toma({ campana: 'SUBURBIA', version: 'V1', campana_id: 2, ruta_numero: 2, ruta_id: 5, secuencia: 5, plantilla: CML }),
    toma({ campana: 'TECATE', version: 'V2', campana_id: 1, estado: 'regresada', rechazo_motivo: 'x', ruta_numero: 2, ruta_id: 5, secuencia: 5 }),
    toma({ sitio_clave: 'COL_2', campana: 'OTRA', version: 'V1' }),
  ]);
  const t = M.armarTarjetas(tomas, HOY, HOY);
  assert.equal(t.length, 2);
  const col1 = t.find((x) => x.sitio_clave === 'COL_1');
  assert.deepEqual(
    col1.tomas.map((x) => M.nombreToma(x)),
    ['TECATE V2', 'SUBURBIA V1', 'TELCEL V3', 'DISNEY V1']
  );
  assert.equal(col1.devuelta, true);
  assert.equal(t[0].sitio_clave, 'COL_1');
  // Conteo de los chips sobre el día.
  assert.deepEqual(M.contarEstados(M.tomasDelDia(tomas, HOY, HOY), HOY), { por_tomar: 3, vencidas: 0, devueltas: 1, enviadas: 1 });
});

test('en HOY entran las vencidas y las devueltas de otros días; en otro día solo las de ese día', () => {
  const tomas = leer([
    toma({ sitio_clave: 'A', fecha: HOY }),
    toma({ sitio_clave: 'B', fecha: '2026-10-27' }), // vencida
    toma({ sitio_clave: 'C', fecha: '2026-10-25', estado: 'regresada', rechazo_motivo: 'x' }),
    toma({ sitio_clave: 'D', fecha: '2026-10-27', estado: 'por_revisar' }), // enviada de antier: no
    toma({ sitio_clave: 'E', fecha: '2026-10-30' }), // mañana
  ]);
  assert.deepEqual(
    M.tomasDelDia(tomas, HOY, HOY).map((x) => x.sitio_clave).sort(),
    ['A', 'B', 'C']
  );
  assert.deepEqual(M.tomasDelDia(tomas, '2026-10-27', HOY).map((x) => x.sitio_clave).sort(), ['B', 'D']);
  assert.deepEqual(M.tomasDelDia(tomas, '2026-10-30', HOY).map((x) => x.sitio_clave), ['E']);
  assert.equal(M.esVencida(tomas[1], HOY), true);
  assert.equal(M.esVencida(tomas[0], HOY), false);
});

test('una vencida y una de hoy del mismo sitio van en la misma tarjeta (la visita es hoy)', () => {
  const tomas = leer([
    toma({ sitio_clave: 'COL_7', fecha: HOY, campana: 'A' }),
    toma({ sitio_clave: 'COL_7', fecha: '2026-10-28', campana: 'B' }),
  ]);
  const t = M.armarTarjetas(tomas, HOY, HOY);
  assert.equal(t.length, 1);
  // Revisión del 26-oct-2026 (monitorista-5): la de hoy primero; la vencida
  // después (y la tarjeta la pliega).
  assert.deepEqual(t[0].tomas.map((x) => x.campana), ['A', 'B']);
  assert.deepEqual(M.vencidasDeOtroDia(t[0], HOY).map((x) => x.campana), ['B']);
});

test('filtro de chips: Por tomar, Devueltas, Enviadas', () => {
  const tomas = leer([
    toma({ sitio_clave: 'A' }),
    toma({ sitio_clave: 'B', estado: 'regresada', rechazo_motivo: 'x' }),
    toma({ sitio_clave: 'C', estado: 'por_revisar' }),
  ]);
  assert.deepEqual(M.armarTarjetas(tomas, HOY, HOY, 'por_tomar').map((x) => x.sitio_clave), ['A']);
  assert.deepEqual(M.armarTarjetas(tomas, HOY, HOY, 'devueltas').map((x) => x.sitio_clave), ['B']);
  assert.deepEqual(M.armarTarjetas(tomas, HOY, HOY, 'enviadas').map((x) => x.sitio_clave), ['C']);
  assert.equal(M.armarTarjetas(tomas, HOY, HOY).length, 3);
});

test('fotos del sitio (Biobox M4): valen para todas las versiones y cuenta la que menos tiene', () => {
  const tomas = leer([
    toma({ sitio_clave: 'BB_1', mueble: 'M4', plantilla: M4, campana: 'A', tiene: [{ pos: 'copete', momento: null, n: 2 }] }),
    toma({
      sitio_clave: 'BB_1',
      mueble: 'M4',
      plantilla: M4,
      campana: 'B',
      tiene: [
        { pos: 'copete', momento: null, n: 3 },
        { pos: 'normal', momento: null, n: 1 },
      ],
    }),
    // Una enviada ya no pide nada del sitio.
    toma({ sitio_clave: 'BB_1', mueble: 'M4', plantilla: M4, campana: 'C', estado: 'por_revisar' }),
  ]);
  const [t] = M.armarTarjetas(tomas, HOY, HOY);
  assert.equal(t.mueble, 'M4');
  assert.deepEqual(
    t.fotosSitio.map((f) => [f.pos, f.tiene, f.n]),
    [
      ['copete', 2, 3],
      ['lateral', 0, 2],
    ]
  );
  // Lo de la versión va aparte (sin copetes ni laterales).
  const b = t.tomas.find((x) => x.campana === 'B');
  assert.deepEqual(M.posicionesDeVersion(b).map((q) => [q.pos, q.tiene, q.n]), [['normal', 1, 1]]);
  assert.deepEqual(M.faltanDeToma(b).map((f) => f.pos), ['lateral']);
});

// Integración del 26-oct-2026 (salió en PGlite con un plan diario: la tarjeta
// de Hoy de una M4 juntaba 25 vencidas en 0 y la fila decía «Copete 0/3»
// aunque hoy ya había 2).
test('fotos del sitio en Hoy: cuentan las tomas de hoy, no las vencidas que la tarjeta también junta', () => {
  const ayer = M.sumarDias(HOY, -1);
  const tomas = leer([
    toma({ sitio_clave: 'BB_2', mueble: 'M4', plantilla: M4, tiene: [{ pos: 'copete', momento: null, n: 2 }] }),
    toma({ sitio_clave: 'BB_2', mueble: 'M4', plantilla: M4, fecha: ayer }),
    toma({ sitio_clave: 'BB_2', mueble: 'M4', plantilla: M4, fecha: M.sumarDias(HOY, -2) }),
  ]);
  const [t] = M.armarTarjetas(tomas, HOY, HOY);
  assert.equal(t.tomas.length, 3);
  assert.deepEqual(t.fotosSitio.map((f) => [f.pos, f.tiene, f.n]), [['copete', 2, 3], ['lateral', 0, 2]]);
  // Sin tomas de hoy (solo vencidas): las del día más reciente.
  const soloVencidas = leer([
    toma({ sitio_clave: 'BB_3', mueble: 'M4', plantilla: M4, fecha: ayer, tiene: [{ pos: 'lateral', momento: null, n: 1 }] }),
    toma({ sitio_clave: 'BB_3', mueble: 'M4', plantilla: M4, fecha: M.sumarDias(HOY, -2) }),
  ]);
  const [v] = M.armarTarjetas(soloVencidas, HOY, HOY);
  assert.deepEqual(v.fotosSitio.map((f) => [f.pos, f.tiene, f.n]), [['copete', 0, 3], ['lateral', 1, 2]]);
});

test('la misma clave en dos unidades no se junta (si la base manda la unidad)', () => {
  const tomas = leer([
    toma({ sitio_clave: 'X1', unidad: 'Biobox' }),
    toma({ sitio_clave: 'X1', unidad: 'Vía Verde' }),
  ]);
  assert.equal(M.armarTarjetas(tomas, HOY, HOY).length, 2);
});

test('lectura tolerante: tomas rotas o repetidas se descartan; {tomas: []} es válida', () => {
  const r = M.leerMisTomas({
    hoy: HOY,
    captura: true,
    unidades: ['Vía Verde', 'Marte'],
    cortada: true,
    tomas: [
      toma({ id: 900 }),
      toma({ id: 900 }),
      toma({ id: 901, estado: 'comprobada' }),
      toma({ id: 902, fecha: 'ayer' }),
      toma({ id: 903, sitio_clave: '' }),
      { id: 'x' },
      null,
      toma({ id: 904, ruta_numero: '3', secuencia: '12', lat: 'no', regreso_n: -2, turno: 'noche' }),
    ],
  });
  assert.deepEqual(r.tomas.map((x) => x.id), [900, 904]);
  assert.equal(r.captura, true);
  assert.equal(r.cortada, true);
  assert.deepEqual(r.unidades, ['Vía Verde']);
  const t = r.tomas[1];
  assert.equal(t.ruta_numero, 3);
  assert.equal(t.secuencia, 12);
  assert.equal(t.lat, null);
  assert.equal(t.regreso_n, 0);
  assert.equal(t.turno, null);
  assert.deepEqual(M.leerMisTomas({ tomas: [] }).tomas, []);
  assert.equal(M.leerMisTomas(null), null);
  assert.equal(M.leerMisTomas([]), null);
  assert.equal(M.leerMisTomas({ hoy: HOY }), null);
});

test('días: rango hoy ±3, etiquetas y fin de mes', () => {
  assert.deepEqual(M.rangoMisTomas(HOY), { desde: '2026-10-26', hasta: '2026-11-01' });
  assert.equal(M.sumarDias('2026-12-31', 1), '2027-01-01');
  assert.equal(M.etiquetaDia(HOY, HOY), 'Hoy · jue 29-oct');
  assert.equal(M.etiquetaDia('2026-10-28', HOY), 'Ayer · mié 28-oct');
  assert.equal(M.etiquetaDia('2026-10-30', HOY), 'Mañana · vie 30-oct');
  assert.equal(M.etiquetaDia('2026-11-01', HOY), 'dom 1-nov');
});

test('nombreToma no repite la versión', () => {
  assert.equal(M.nombreToma({ campana: 'TECATE ALWAYS', version: 'V2' }), 'TECATE ALWAYS V2');
  assert.equal(M.nombreToma({ campana: 'TECATE V2', version: 'V2' }), 'TECATE V2');
  assert.equal(M.nombreToma({ campana: '', version: '' }), 'Sin campaña');
});

// ---- Revisión adversarial del 26-oct-2026 ------------------------------

test('revisión: dentro de la tarjeta, devueltas, hoy, vencidas de la más reciente a la más vieja, enviadas', () => {
  const d = (n) => M.sumarDias(HOY, n);
  const tomas = leer([
    toma({ campana: 'V3', fecha: d(-3) }),
    toma({ campana: 'ENV', estado: 'por_revisar' }),
    toma({ campana: 'V1', fecha: d(-1) }),
    toma({ campana: 'HOY' }),
    toma({ campana: 'DEV', estado: 'regresada', rechazo_motivo: 'x', fecha: d(-5) }),
    toma({ campana: 'V2', fecha: d(-2) }),
  ]);
  const [t] = M.armarTarjetas(tomas, HOY, HOY);
  assert.deepEqual(t.tomas.map((x) => x.campana), ['DEV', 'HOY', 'V1', 'V2', 'V3', 'ENV']);
  // Las vencidas cuentan aparte y tienen su chip.
  assert.deepEqual(M.contarEstados(M.tomasDelDia(tomas, HOY, HOY), HOY), { por_tomar: 1, vencidas: 3, devueltas: 1, enviadas: 1 });
  assert.deepEqual(M.armarTarjetas(tomas, HOY, HOY, 'vencidas')[0].tomas.map((x) => x.campana), ['V1', 'V2', 'V3']);
  assert.deepEqual(M.armarTarjetas(tomas, HOY, HOY, 'por_tomar')[0].tomas.map((x) => x.campana), ['HOY']);
  // En un día pasado, las de ese día no son «de otro día»: no se pliegan.
  const [ayer] = M.armarTarjetas(tomas, d(-1), HOY);
  assert.deepEqual(M.vencidasDeOtroDia(ayer, HOY), []);
});

test('revisión: la parada es la que manda la base (como Mis rutas); sin ella, la secuencia', () => {
  const tomas = leer([
    toma({ sitio_clave: 'EV_3', ruta_id: 30, ruta_numero: 1, secuencia: null, parada: 4 }),
    toma({ sitio_clave: 'EV_1', ruta_id: 30, ruta_numero: 1, secuencia: null, parada: 3 }),
    toma({ sitio_clave: 'EV_9', ruta_id: 30, ruta_numero: 1, secuencia: 5, parada: 1 }),
  ]);
  const t = M.armarTarjetas(tomas, HOY, HOY);
  assert.deepEqual(t.map((x) => x.sitio_clave), ['EV_9', 'EV_1', 'EV_3']);
  assert.equal(M.textoRuta(t[1]), 'Ruta 1 · parada 3');
  // Copia vieja sin «parada»: se usa la secuencia.
  assert.equal(M.textoRuta({ ruta_numero: 2, secuencia: 7 }), 'Ruta 2 · parada 7');
});

test('revisión: en Biobox «Ruta 3» Digital e Impreso llevan el medio en el rótulo', () => {
  const tomas = leer([
    toma({ sitio_clave: 'BB_1', unidad: 'Biobox', ruta_id: 10, ruta_numero: 3, parada: 1, ruta_medio: 'Digital' }),
    toma({ sitio_clave: 'BB_2', unidad: 'Biobox', ruta_id: 20, ruta_numero: 3, parada: 1, ruta_medio: 'Impreso' }),
    toma({ sitio_clave: 'BB_3', unidad: 'Biobox', ruta_id: 11, ruta_numero: 4, parada: 2, ruta_medio: 'Digital' }),
  ]);
  const t = M.armarTarjetas(tomas, HOY, HOY);
  assert.deepEqual(t.map((x) => M.textoRuta(x)), ['Ruta 3 · Digital · parada 1', 'Ruta 3 · Impreso · parada 1', 'Ruta 4 · parada 2']);
});

test('revisión: qué fallas de la lista dejan la copia sin alerta (monitorista-1)', () => {
  assert.equal(M.motivoCopiaDeFalla({ sinRed: true, codigo: 'sin_red' }), 'senal');
  assert.equal(M.motivoCopiaDeFalla({ sinRed: false, codigo: 'sin_sesion' }), 'sesion');
  assert.equal(M.motivoCopiaDeFalla({ sinRed: false, codigo: 'ocupada' }), 'base');
  assert.equal(M.motivoCopiaDeFalla({ sinRed: false, codigo: 'tardo' }), 'base');
  assert.equal(M.motivoCopiaDeFalla({ sinRed: false, codigo: 'falta_migracion' }), null);
  assert.equal(M.motivoCopiaDeFalla({ sinRed: false, codigo: 'otro' }), null);
});
