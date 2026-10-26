// src/lib/franjaHorario.ts (fase 3 de Comprobaciones, 26-oct-2026): la
// franja de la toma en Mis rutas › Comprobaciones. Solo avisa: verde «en
// franja» o ámbar «fuera de franja». Casos de la especificación (§8,
// incremento 1): «24 HORAS», vacío, «07:00-09:59 / 14:00-14:59», bordes y
// medianoche.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/franjaHorario.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const F = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const h = (hh, mm = 0) => hh * 60 + mm;

test('«24 HORAS», sus variantes y vacío = siempre', () => {
  for (const t of ['24 HORAS', '24 horas', ' 24 Hrs ', '24h', '24 HRS.', 'Todo el día', '', '   ', null, undefined])
    assert.deepEqual(F.leerFranjas(t), { tipo: 'siempre' }, String(t));
  assert.deepEqual(F.estadoFranja('24 HORAS', h(3)), { estado: 'siempre', texto: '24 horas' });
  assert.equal(F.estadoFranja(null, null).estado, 'siempre');
});

test('dos franjas con «/»: dentro, fuera y los bordes al minuto', () => {
  const t = '07:00-09:59 / 14:00-14:59';
  const l = F.leerFranjas(t);
  assert.deepEqual(l, {
    tipo: 'franjas',
    franjas: [
      { ini: h(7), fin: h(9, 59) },
      { ini: h(14), fin: h(14, 59) },
    ],
  });
  const e = (m) => F.estadoFranja(t, m).estado;
  assert.equal(e(h(6, 59)), 'fuera');
  assert.equal(e(h(7, 0)), 'dentro');
  assert.equal(e(h(8, 30)), 'dentro');
  assert.equal(e(h(9, 59)), 'dentro');
  assert.equal(e(h(10, 0)), 'fuera');
  assert.equal(e(h(13, 59)), 'fuera');
  assert.equal(e(h(14, 0)), 'dentro');
  assert.equal(e(h(14, 59)), 'dentro');
  assert.equal(e(h(15, 0)), 'fuera');
  assert.equal(F.estadoFranja(t, h(8)).texto, '07:00–09:59 / 14:00–14:59');
});

test('otros separadores: «–», « a », « al », «,», « y », horas sin cero y con «hrs»', () => {
  const casos = [
    ['7:00 – 9:59', [{ ini: h(7), fin: h(9, 59) }]],
    ['07:00 a 09:59, 14:00 a 14:59', [{ ini: h(7), fin: h(9, 59) }, { ini: h(14), fin: h(14, 59) }]],
    ['de 7 a 10 y de 14 a 15', [{ ini: h(7), fin: h(10) }, { ini: h(14), fin: h(15) }]],
    ['desde las 8 hasta las 11', [{ ini: h(8), fin: h(11) }]],
    ['de la mañana', null],
    ['7 a 10 y 14 a 15', [{ ini: h(7), fin: h(10) }, { ini: h(14), fin: h(15) }]],
    ['07:00 hrs - 09:59 hrs', [{ ini: h(7), fin: h(9, 59) }]],
    ['7.30-9.45', [{ ini: h(7, 30), fin: h(9, 45) }]],
    ['06:00 al 18:00', [{ ini: h(6), fin: h(18) }]],
  ];
  for (const [t, esperado] of casos) {
    const l = F.leerFranjas(t);
    if (esperado === null) assert.equal(l.tipo, 'ilegible', t);
    else assert.deepEqual(l, { tipo: 'franjas', franjas: esperado }, t);
  }
});

test('am y pm (también «p. m.»)', () => {
  assert.deepEqual(F.leerFranjas('7:01 pm a 6:59 am'), { tipo: 'franjas', franjas: [{ ini: h(19, 1), fin: h(6, 59) }] });
  assert.deepEqual(F.leerFranjas('7:01 p. m. - 6:59 a. m.'), {
    tipo: 'franjas',
    franjas: [{ ini: h(19, 1), fin: h(6, 59) }],
  });
  assert.deepEqual(F.leerFranjas('12:00 am - 12:30 pm'), { tipo: 'franjas', franjas: [{ ini: 0, fin: h(12, 30) }] });
  // 13 pm no es hora.
  assert.equal(F.leerFranjas('13:00 pm - 14:00 pm').tipo, 'ilegible');
});

test('medianoche: una franja que cruza el día', () => {
  const t = '22:00-06:00';
  const e = (m) => F.estadoFranja(t, m).estado;
  assert.equal(e(h(21, 59)), 'fuera');
  assert.equal(e(h(22, 0)), 'dentro');
  assert.equal(e(h(23, 59)), 'dentro');
  assert.equal(e(0), 'dentro');
  assert.equal(e(h(3)), 'dentro');
  assert.equal(e(h(6, 0)), 'dentro');
  assert.equal(e(h(6, 1)), 'fuera');
  assert.equal(e(h(12)), 'fuera');
  // Hasta las 24:00 = hasta el último minuto del día.
  assert.equal(F.estadoFranja('18:00-24:00', h(23, 59)).estado, 'dentro');
  assert.equal(F.estadoFranja('00:00-06:00', 0).estado, 'dentro');
});

test('lo que no se entiende queda ilegible y se enseña tal cual (sin color)', () => {
  for (const t of ['MATUTINO', 'Ver observaciones', '07:00', '25:00-26:00', '07:61-08:00', '07:00-07:00', '7-8-9'])
    assert.equal(F.leerFranjas(t).tipo, 'ilegible', t);
  assert.deepEqual(F.estadoFranja('MATUTINO', h(8)), { estado: 'ilegible', texto: 'MATUTINO' });
  // Sin hora conocida, una franja tampoco se pinta.
  assert.equal(F.estadoFranja('07:00-09:59', null).estado, 'ilegible');
});

test('minutosCdmx usa la hora de CDMX, no la del teléfono', () => {
  // 15:30 UTC = 09:30 en CDMX (UTC-6, sin horario de verano desde 2022).
  assert.equal(F.minutosCdmx(new Date('2026-10-26T15:30:00Z')), h(9, 30));
  assert.equal(F.minutosCdmx(new Date('2026-10-27T05:59:00Z')), h(23, 59));
  assert.equal(F.textoMinuto(h(7, 5)), '07:05');
});
