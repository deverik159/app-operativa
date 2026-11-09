import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/avisoPush.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { decidirAvisoPush, POSPONER_MS } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

const base = { dispositivosActivos: 0, esCelular: true, pospuestoHasta: null, ahora: 1_000_000 };

test('sin aviso si el dispositivo recibe push, no lo soporta o aún no se sabe', () => {
  for (const estado of ['activo', 'no-soportado', null])
    assert.equal(decidirAvisoPush({ ...base, estado }), null);
});

test('en el celular sale aunque tenga otros dispositivos activos', () => {
  const a = decidirAvisoPush({ ...base, estado: 'sin-permiso', dispositivosActivos: 2 });
  assert.equal(a.tipo, 'activar');
  assert.equal(a.boton, 'Activar avisos');
});

test('suscripción caída en la base: pide reactivar', () => {
  const a = decidirAvisoPush({ ...base, estado: 'caido' });
  assert.equal(a.tipo, 'reactivar');
  assert.match(a.texto, /dejaron de llegar/);
});

test('iPhone en Safari y avisos bloqueados explican qué hacer', () => {
  assert.equal(decidirAvisoPush({ ...base, estado: 'requiere-instalar' }).tipo, 'instalar');
  assert.equal(decidirAvisoPush({ ...base, estado: 'bloqueado' }).boton, 'Cómo desbloquear');
});

test('en la computadora solo si no tiene ningún dispositivo activo', () => {
  const pc = { ...base, esCelular: false, estado: 'sin-permiso' };
  assert.equal(decidirAvisoPush({ ...pc, dispositivosActivos: 1 }), null);
  assert.equal(decidirAvisoPush({ ...pc, dispositivosActivos: null }), null);
  const a = decidirAvisoPush(pc);
  assert.match(a.texto, /ningún dispositivo/);
  assert.equal(a.boton, 'Activar aquí');
  assert.equal(decidirAvisoPush({ ...pc, estado: 'bloqueado' }).boton, 'Ver cómo');
});

test('«Ahora no» lo esconde hasta que vence', () => {
  const hasta = base.ahora + POSPONER_MS;
  assert.equal(decidirAvisoPush({ ...base, estado: 'sin-permiso', pospuestoHasta: hasta }), null);
  assert.notEqual(
    decidirAvisoPush({ ...base, estado: 'sin-permiso', pospuestoHasta: hasta, ahora: hasta + 1 }),
    null
  );
});
