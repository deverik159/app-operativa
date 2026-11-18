import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/historialInc.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { lineasHistorial } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const ev = (evento, en, extra = {}) => ({
  record_id: 'r1', evento, estatus_antes: null, estatus_nuevo: null,
  por_email: null, en, detalle: null, reconstruido: false, ...extra,
});

test('Historial de la tarjeta: en orden, con nombre y quién (17-nov-2026)', () => {
  const l = lineasHistorial([
    ev('cerrada', '2026-11-12T20:00:00Z'),
    ev('validada', '2026-11-10T15:00:00Z', { por_email: 'ana.anaya@x.com' }),
    ev('reparacion_rechazada', '2026-11-11T18:00:00Z', { detalle: ' Falta foto ' }),
    ev('reparada', '2026-11-11T12:00:00Z', { por_email: 'tecnico@x.com' }),
    ev('reparada', '2026-11-12T10:00:00Z', { por_email: 'tecnico@x.com' }),
  ]);
  assert.deepEqual(l.map((x) => x.titulo), [
    'Validada', 'Reparada', 'Reparación rechazada', 'Reparada', 'Reparación aprobada',
  ]);
  assert.equal(l[0].por, 'ana.anaya');
  assert.equal(l[2].detalle, 'Falta foto');
  assert.equal(l[4].por, null);
  // Claves únicas aunque se repita el evento.
  assert.equal(new Set(l.map((x) => x.clave)).size, l.length);
});

test('Historial: reasignación con áreas y evento desconocido legible', () => {
  const l = lineasHistorial([
    ev('reasignacion_aprobada', '2026-11-12T10:00:00Z', { detalle: 'Digital → Op. Bio Box' }),
    ev('estatus', '2026-11-12T11:00:00Z', { estatus_nuevo: 'por_validar' }),
  ]);
  assert.equal(l[0].titulo, 'Reasignación aprobada');
  assert.equal(l[0].detalle, 'Digital → Op. Bio Box');
  assert.equal(l[1].titulo, 'Cambió a Por validar');
  // Prevalidada fuera de horario (18-nov-2026).
  assert.equal(
    lineasHistorial([ev('prevalidada', '2026-11-18T01:40:00Z', { por_email: 'perez.ivan@x.com' })])[0].titulo,
    'Prevalidada por el área'
  );
  assert.deepEqual(lineasHistorial([]), []);
});
