import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/actividad.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const {
  diasSinUso,
  estadoActividad,
  ordenarActividad,
  tiraDias,
  textoUltimaVez,
  telefonoWhatsapp,
  mensajeRecordatorio,
  actividadPorModulo,
  areasDe,
  textoRol,
  iniciales,
} = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

// 13-nov-2026 12:00 en CDMX (UTC-6).
const AHORA = new Date('2026-11-13T18:00:00Z');

const fila = (extra) => ({
  email: 'a@x.com',
  nombre: 'Ana Pérez',
  telefono: null,
  roles: [],
  tiene_cuenta: true,
  entra_con: 'email',
  alta: null,
  ultimo_login: null,
  ultima_vez: null,
  dias_uso: [],
  push: false,
  errores: 0,
  maquinas: 0,
  reparaciones: 0,
  fotos: 0,
  chat: 0,
  rutas: 0,
  comprobaciones: 0,
  nuc: 0,
  ...extra,
});

test('Los días sin uso se cuentan por día de CDMX, no por 24 h', () => {
  // 12-nov 23:30 CDMX = 13-nov 05:30 UTC: fue ayer en CDMX.
  assert.equal(diasSinUso('2026-11-13T05:30:00Z', AHORA), 1);
  // 13-nov 00:30 CDMX = 13-nov 06:30 UTC: hoy.
  assert.equal(diasSinUso('2026-11-13T06:30:00Z', AHORA), 0);
  assert.equal(diasSinUso(null, AHORA), null);
  assert.equal(diasSinUso('no es fecha', AHORA), null);
});

test('Estado: hoy, últimos 5 días, más de 5 y nunca', () => {
  assert.equal(estadoActividad(fila({ ultima_vez: '2026-11-13T15:00:00Z' }), AHORA), 'hoy');
  assert.equal(estadoActividad(fila({ ultima_vez: '2026-11-08T15:00:00Z' }), AHORA), 'reciente');
  assert.equal(estadoActividad(fila({ ultima_vez: '2026-11-07T15:00:00Z' }), AHORA), 'inactivo');
  assert.equal(estadoActividad(fila({ ultima_vez: null }), AHORA), 'nunca');
  // Sin cuenta es «nunca» aunque traiga fecha.
  assert.equal(estadoActividad(fila({ tiene_cuenta: false, ultima_vez: '2026-11-13T15:00:00Z' }), AHORA), 'nunca');
});

test('Orden: primero nunca, luego más días sin uso, al final hoy', () => {
  const filas = [
    fila({ email: 'hoy@x', nombre: 'Hoy', ultima_vez: '2026-11-13T15:00:00Z' }),
    fila({ email: 'ocho@x', nombre: 'Ocho', ultima_vez: '2026-11-05T15:00:00Z' }),
    fila({ email: 'nunca@x', nombre: 'Nunca', ultima_vez: null }),
    fila({ email: 'nueve@x', nombre: 'Nueve', ultima_vez: '2026-11-04T15:00:00Z' }),
    fila({ email: 'dos@x', nombre: 'Dos', ultima_vez: '2026-11-11T15:00:00Z' }),
  ];
  assert.deepEqual(
    ordenarActividad(filas, AHORA).map((f) => f.nombre),
    ['Nunca', 'Nueve', 'Ocho', 'Dos', 'Hoy']
  );
});

test('Tira de días: el más viejo primero y hoy al final', () => {
  const t = tiraDias(['2026-11-13', '2026-11-11', '2026-10-01'], 5, AHORA);
  assert.deepEqual(t, [false, false, true, false, true]);
  assert.equal(tiraDias(null, 30, AHORA).length, 30);
});

test('Texto de la última vez', () => {
  assert.equal(textoUltimaVez(fila({ ultima_vez: '2026-11-13T17:38:00Z' }), AHORA), 'Hoy 11:38');
  assert.equal(textoUltimaVez(fila({ ultima_vez: '2026-11-12T15:10:00Z' }), AHORA), 'Ayer 9:10');
  assert.equal(textoUltimaVez(fila({ ultima_vez: '2026-11-05T16:00:00Z' }), AHORA), 'Hace 8 días (5-nov)');
  assert.equal(textoUltimaVez(fila({ ultima_vez: null }), AHORA), 'Nunca entró');
  assert.equal(textoUltimaVez(fila({ tiene_cuenta: false }), AHORA), 'Sin cuenta creada');
});

test('Teléfono para WhatsApp: lada 52 y solo celulares válidos', () => {
  assert.equal(telefonoWhatsapp('55 1234 5678'), '525512345678');
  assert.equal(telefonoWhatsapp('+52 1 55 1234 5678'), '5215512345678');
  assert.equal(telefonoWhatsapp('525512345678'), '525512345678');
  assert.equal(telefonoWhatsapp('12345'), null);
  assert.equal(telefonoWhatsapp(null), null);
});

test('El recordatorio cambia si nunca entró y lleva el enlace y el correo', () => {
  const nunca = mensajeRecordatorio(fila({ nombre: 'Luis Rojas', email: 'luis@x.com' }), 'https://app');
  assert.match(nunca, /^Hola Luis, ya tienes acceso/);
  assert.match(nunca, /todavía no has entrado/);
  assert.match(nunca, /https:\/\/app/);
  assert.match(nunca, /luis@x\.com/);
  const activo = mensajeRecordatorio(fila({ ultima_vez: '2026-11-05T16:00:00Z' }), 'https://app');
  assert.match(activo, /te recuerdo usar/);
});

test('Actividad por módulo: sin ceros y de mayor a menor', () => {
  const m = actividadPorModulo(fila({ maquinas: 12, chat: 3, fotos: 0, nuc: 5 }));
  assert.deepEqual(m.map((x) => [x.modulo, x.n]), [
    ['Visitas a máquinas', 12],
    ['Aviso NUC', 5],
    ['Mensajes en chat', 3],
  ]);
});

test('Áreas y texto de cada rol', () => {
  const roles = [
    { unidad: 'Biobox', area: 'Op. Bio Box', rol: 'reparacion' },
    { unidad: 'Biobox', area: 'Op. Bio Box', rol: 'coordinador' },
    { unidad: null, area: null, rol: 'viewer' },
  ];
  assert.deepEqual(areasDe({ roles }), ['Op. Bio Box']);
  assert.deepEqual(areasDe({ roles: null }), []);
  assert.equal(textoRol(roles[0], (r) => (r === 'reparacion' ? 'Técnico' : r)), 'Biobox · Op. Bio Box · Técnico');
  assert.equal(textoRol(roles[2]), 'Todas las unidades · Sin área · viewer');
});

test('Iniciales', () => {
  assert.equal(iniciales({ nombre: 'Ramsés González', email: 'r@x' }), 'RG');
  assert.equal(iniciales({ nombre: '', email: 'luis.rojas@x.com' }), 'LR');
});
