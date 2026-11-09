// Reloj del SLA de validación y horario del validador: L–V 8:15–17:00 CDMX
// (Erik, 9-nov-2026; antes 9:30–18:30). CDMX = UTC-6 todo el año (sin
// horario de verano desde 2022), así que 8:15 CDMX = 14:15Z y 17:00 = 23:00Z.
// Fechas: viernes 6, sábado 7, domingo 8, lunes 9 y martes 10 de nov-2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/helpers.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { minutosHabilesValidador, slaInfoValidador, fueraHorarioValidador } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);
const C = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/constants.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { VAL_DESDE, VAL_HASTA, VAL_DIAS, HORARIO_VALIDADOR_TEXTO } = await import(
  'data:text/javascript;base64,' + Buffer.from(C.outputFiles[0].text).toString('base64')
);

/** Hora de CDMX → instante real (CDMX = UTC-6). */
const cdmx = (dia, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, dia, h + 6, m)).toISOString();
};

test('el horario es L–V 8:15–17:00', () => {
  assert.equal(VAL_DESDE, 8 * 60 + 15);
  assert.equal(VAL_HASTA, 17 * 60);
  assert.deepEqual(VAL_DIAS, [1, 2, 3, 4, 5]);
  assert.match(HORARIO_VALIDADOR_TEXTO, /8:15–17:00/);
});

test('minutos hábiles: borde de las 8:15', () => {
  assert.equal(minutosHabilesValidador(cdmx(9, '07:00'), cdmx(9, '08:15')), 0);
  assert.equal(minutosHabilesValidador(cdmx(9, '08:00'), cdmx(9, '08:30')), 15);
  assert.equal(minutosHabilesValidador(cdmx(9, '08:15'), cdmx(9, '08:16')), 1);
});

test('minutos hábiles: borde de las 17:00', () => {
  assert.equal(minutosHabilesValidador(cdmx(9, '16:50'), cdmx(9, '17:10')), 10);
  assert.equal(minutosHabilesValidador(cdmx(9, '17:00'), cdmx(9, '23:59')), 0);
  // Jornada completa: 8:15 a 17:00 = 525 minutos.
  assert.equal(minutosHabilesValidador(cdmx(9, '00:00'), cdmx(10, '00:00')), 525);
});

test('minutos hábiles: el fin de semana no cuenta', () => {
  assert.equal(minutosHabilesValidador(cdmx(7, '00:00'), cdmx(9, '00:00')), 0);
  // Viernes 16:50 → lunes 8:25: 10 del viernes + 10 del lunes.
  assert.equal(minutosHabilesValidador(cdmx(6, '16:50'), cdmx(9, '08:25')), 20);
});

test('caso real BBMM00030: reparada el sábado y aprobada el lunes 9:20 cuenta 65 min', () => {
  // sla_validacion_inicio y cerrada_en tal como están en producción.
  assert.equal(minutosHabilesValidador('2026-11-07 17:40:22.066191+00', '2026-11-09 15:20:03.455324+00'), 65);
  // Con 20 min de SLA, al aprobarla ya iba vencida por 45 min. Con el
  // horario viejo (9:30) el reloj ni había arrancado.
  assert.deepEqual(
    slaInfoValidador('2026-11-07 17:40:22.066191+00', 20, '2026-11-09 15:20:03.455324+00'),
    { color: '#ef4444', label: 'vencido +45 min' }
  );
});

test('caso real BBM500002: reparada y aprobada el lunes antes de las 9:30 cuenta 10 min', () => {
  assert.equal(minutosHabilesValidador('2026-11-09 15:09:24.771676+00', '2026-11-09 15:19:49.70047+00'), 10);
});

test('reloj: reparada a las 8:15 con 20 min vence a las 8:35', () => {
  const ini = cdmx(9, '08:15');
  assert.deepEqual(slaInfoValidador(ini, 20, cdmx(9, '08:20')), { color: '#22c55e', label: 'en tiempo · 15 min' });
  assert.deepEqual(slaInfoValidador(ini, 20, cdmx(9, '08:30')), { color: '#f59e0b', label: 'por vencer · 5 min' });
  assert.deepEqual(slaInfoValidador(ini, 20, cdmx(9, '08:36')), { color: '#ef4444', label: 'vencido +1 min' });
});

test('reloj: antes de las 8:15 está en pausa y lo dice', () => {
  assert.deepEqual(slaInfoValidador(cdmx(9, '07:30'), 20, cdmx(9, '08:00')), {
    color: '#22c55e',
    label: 'en tiempo · 20 min · en pausa',
  });
});

test('reloj: a las 17:00 se pausa y sigue al día hábil siguiente', () => {
  const ini = cdmx(9, '16:59'); // 1 min el lunes, 19 el martes → vence martes 8:34
  assert.deepEqual(slaInfoValidador(ini, 20, cdmx(9, '17:00')), {
    color: '#22c55e',
    label: 'en tiempo · 19 min · en pausa',
  });
  assert.deepEqual(slaInfoValidador(ini, 20, cdmx(10, '08:30')), { color: '#f59e0b', label: 'por vencer · 4 min' });
  assert.equal(slaInfoValidador(ini, 20, cdmx(10, '08:35')).color, '#ef4444');
});

test('reloj: reparada el viernes 16:50 sigue en pausa el sábado y vence el lunes 8:25', () => {
  const ini = cdmx(6, '16:50');
  assert.deepEqual(slaInfoValidador(ini, 20, cdmx(7, '12:00')), {
    color: '#22c55e',
    label: 'en tiempo · 10 min · en pausa',
  });
  assert.deepEqual(slaInfoValidador(ini, 20, cdmx(9, '08:26')), { color: '#ef4444', label: 'vencido +1 min' });
});

test('reloj: reparada en fin de semana arranca el lunes a las 8:15', () => {
  const ini = cdmx(7, '10:14'); // sábado
  assert.deepEqual(slaInfoValidador(ini, 20, cdmx(9, '08:15')), { color: '#22c55e', label: 'en tiempo · 20 min' });
  assert.deepEqual(slaInfoValidador(ini, 20, cdmx(9, '08:45')), { color: '#ef4444', label: 'vencido +10 min' });
});

test('auto-ruteo: fuera de horario antes de las 8:15, después de las 17:00 y en fin de semana', () => {
  const f = (dia, hhmm) => fueraHorarioValidador(new Date(cdmx(dia, hhmm)));
  assert.equal(f(9, '08:14'), true);
  assert.equal(f(9, '08:15'), false);
  assert.equal(f(9, '09:00'), false); // antes era fuera de horario
  assert.equal(f(9, '17:00'), false);
  assert.equal(f(9, '17:01'), true);
  assert.equal(f(9, '18:00'), true); // antes era en horario
  assert.equal(f(7, '12:00'), true);
  assert.equal(f(8, '12:00'), true);
});
