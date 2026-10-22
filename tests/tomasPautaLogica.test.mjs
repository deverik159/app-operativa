// ============================================================
// tests/tomasPautaLogica.test.mjs
// Lo puro de la cola de tomas de Pauta (fase 1 de comprobaciones,
// 22-oct-2026): rutas fijas y únicas, orden de envío, cuándo se registra la
// toma, cuándo se cierra un trabajo, textos del aviso y grupos para la hoja
// de compartir.
//
// Correr: node --test tests/*.test.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/tomasPautaLogica.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const L = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const arch = (o) => ({
  fid: 'f' + (o.n ?? 1),
  n: 1,
  path: 'pauta/x.jpg',
  nombre: 'toma_x_1.jpg',
  mime: 'image/jpeg',
  tipo: 'foto',
  bytes: 300000,
  referencia: null,
  encolado_en: '2026-10-22T15:00:00.000Z',
  origen: 'camara',
  estado: 'local',
  ...o,
});
const trabajo = (o) => ({
  v: 1,
  id: 'id-1',
  clave: 'a@b.com|2026|22|MX_CM_EV_EVA_01_3325',
  email: 'a@b.com',
  anio: 2026,
  catorcena: 22,
  vfid: 'MX_CM_EV_EVA_01_3325',
  site_id: 'MX_CM_EV_3325',
  cara: '01',
  campana: 'SPIDERMAN',
  minimo: 3,
  registrar: false,
  registrarPedidoEn: null,
  registrada: false,
  archivos: [],
  ultimoError: null,
  conError: false,
  creado_en: '2026-10-22T15:00:00.000Z',
  actualizado_en: '2026-10-22T15:00:00.000Z',
  ...o,
});
const sinToma = { fecha_toma: null, fecha_comprobacion: null, fecha_rechazo: null };

test('claveTrabajo normaliza el correo', () => {
  assert.equal(L.claveTrabajo('  A@B.com ', 2026, 22, 'X'), 'a@b.com|2026|22|X');
});

test('rutaFoto: fija, limpia y única aunque coincida el milisegundo', () => {
  const base = { anio: 2026, catorcena: 22, dia: '2026-10-22', marcaMs: 1761145200000, idCorto: 'ab12cd', ext: 'JPG' };
  // vfid real con ", " (3 de 1,887 en producción).
  const vfid = 'MX_CM_EV_EVA_01_3493, MX_CM_EV_EVA_02_3493';
  const a = L.rutaFoto({ ...base, vfid, n: 1 });
  const b = L.rutaFoto({ ...base, vfid, n: 2 });
  assert.notEqual(a, b);
  assert.match(a, /^pauta\/2026-22\/[\w.\-]+\.jpg$/);
  assert.ok(!a.includes(' ') && !a.includes(','));
  assert.equal(a, 'pauta/2026-22/MX_CM_EV_EVA_01_3493__MX_CM_EV_EVA_02_3493_cat2026-22_2026-10-22_1761145200000-ab12cd-1.jpg');
  // Otro trabajo (otro idCorto) en el mismo milisegundo tampoco choca.
  assert.notEqual(a, L.rutaFoto({ ...base, vfid, n: 1, idCorto: 'zz99yy' }));
});

test('tipo y extensión', () => {
  assert.equal(L.tipoDeArchivo('video/quicktime', 'IMG_1.MOV'), 'video');
  assert.equal(L.tipoDeArchivo('', 'clip.MP4'), 'video');
  assert.equal(L.tipoDeArchivo('image/jpeg', 'image.jpg'), 'foto');
  assert.equal(L.tipoDeArchivo('', 'sin-extension'), 'foto');
  assert.equal(L.extensionDe('IMG_1.MOV', 'video/quicktime', 'video'), 'mov');
  assert.equal(L.extensionDe('', 'video/quicktime', 'video'), 'mov');
  assert.equal(L.extensionDe('', 'image/jpeg', 'foto'), 'jpg');
  assert.equal(L.extensionDe('', '', 'video'), 'mp4');
  assert.equal(L.extensionDe(null, null, 'foto'), 'jpg');
});

test('nombreParaCompartir: único y con extensión (la cámara llama a todo image.jpg)', () => {
  assert.equal(L.nombreParaCompartir('MX_CM_EV_EVA_01_3325', 3, 'JPG'), 'toma_MX_CM_EV_EVA_01_3325_3.jpg');
  assert.notEqual(L.nombreParaCompartir('X', 1, 'jpg'), L.nombreParaCompartir('X', 2, 'jpg'));
  // Con señal cada foto cae en su propio trabajo (n=1 en todos): el id corto los separa.
  assert.notEqual(L.nombreParaCompartir('X', 'ab12cd-1', 'jpg'), L.nombreParaCompartir('X', 'zz99yy-1', 'jpg'));
});

test('porMandar: fotos en orden de captura y los videos al final', () => {
  const t = trabajo({
    archivos: [
      arch({ n: 1, tipo: 'video', estado: 'local' }),
      arch({ n: 3, estado: 'local' }),
      arch({ n: 2, estado: 'subido' }),
      arch({ n: 4, estado: 'ligado' }),
      arch({ n: 5, estado: 'quitado' }),
      arch({ n: 6, estado: 'ligando' }),
    ],
  });
  assert.deepEqual(
    L.porMandar(t).map((a) => `${a.tipo}${a.n}`),
    ['foto2', 'foto3', 'foto6', 'video1']
  );
});

test('listoParaCerrar: un archivo nuevo o un registro pendiente lo mantienen vivo', () => {
  const ligado = arch({ n: 1, estado: 'ligado' });
  assert.equal(L.listoParaCerrar(trabajo({ archivos: [ligado] })), true);
  // La foto que llegó entre la lectura de la cola y el cierre: no se borra.
  assert.equal(L.listoParaCerrar(trabajo({ archivos: [ligado, arch({ n: 2 })] })), false);
  // Se pidió registrar y aún no se registra: tampoco.
  assert.equal(L.listoParaCerrar(trabajo({ archivos: [ligado], registrar: true })), false);
  assert.equal(L.listoParaCerrar(trabajo({ archivos: [ligado], registrar: true, registrada: true })), true);
  assert.equal(L.listoParaCerrar(trabajo({ archivos: [arch({ estado: 'quitado' }), arch({ estado: 'perdido' })] })), true);
  // Quitada después de subir: no se cierra hasta limpiar el servidor.
  assert.equal(L.listoParaCerrar(trabajo({ archivos: [arch({ estado: 'quitado', limpiar: true })] })), false);
  // Rechazada por el servidor: su Blob se conserva y el trabajo sigue vivo.
  assert.equal(L.listoParaCerrar(trabajo({ archivos: [ligado, arch({ n: 2, estado: 'fallido' })] })), false);
  assert.equal(L.fallidos(trabajo({ archivos: [ligado, arch({ n: 2, estado: 'fallido' })] })), 1);
  assert.equal(L.porLimpiar(trabajo({ archivos: [arch({ estado: 'quitado', limpiar: true }), arch({ estado: 'quitado' })] })).length, 1);
});

test('faltanFotos no baja de cero', () => {
  assert.equal(L.faltanFotos(9, 4, 3), 2);
  assert.equal(L.faltanFotos(3, 4, 3), 0);
  assert.equal(L.faltanFotos(3, -1, 0), 3);
});

test('decidirRegistro: solo con todo ligado, sin perdidas, con el mínimo y sin cambios en el servidor', () => {
  const tres = [1, 2, 3].map((n) => arch({ n, estado: 'ligado' }));
  const pedido = { registrar: true, registrarPedidoEn: '2026-10-22T16:00:00.000Z', minimo: 3 };
  // La base: la fecha_rechazo del servidor en la primera lectura tras el pedido.
  const conBase = (base) => ({ ...pedido, rechazoBase: base });
  assert.deepEqual(L.decidirRegistro(trabajo({ archivos: tres }), sinToma, 3), { tipo: 'noPedido' });
  assert.deepEqual(
    L.decidirRegistro(trabajo({ ...pedido, archivos: [...tres, arch({ n: 4 })] }), sinToma, 3),
    { tipo: 'esperar' }
  );
  assert.deepEqual(L.decidirRegistro(trabajo({ ...pedido, archivos: tres }), sinToma, 3), { tipo: 'registrar' });
  // Ya la registró alguien (u otro intento cuya respuesta se perdió).
  assert.deepEqual(
    L.decidirRegistro(trabajo({ ...pedido, archivos: tres }), { ...sinToma, fecha_toma: '2026-10-22 16:01:00+00' }, 3),
    { tipo: 'hecho' }
  );
  // El analista la regresó DESPUÉS de pedir el registro: el servidor trae
  // una fecha_rechazo distinta de la base (o la hay y la base era nula).
  assert.deepEqual(
    L.decidirRegistro(trabajo({ ...conBase(null), archivos: tres }), { ...sinToma, fecha_rechazo: '2026-10-22 16:05:00.123456+00' }, 3),
    { tipo: 'regresada' }
  );
  assert.deepEqual(
    L.decidirRegistro(
      trabajo({ ...conBase('2026-10-22T15:00:00Z'), archivos: tres }),
      { ...sinToma, fecha_rechazo: '2026-10-22 16:05:00+00' },
      3
    ),
    { tipo: 'regresada' }
  );
  // El rechazo que ya estaba al pedir (lo que esta toma repone) no cuenta,
  // aunque el reloj del teléfono vaya atrasado.
  assert.deepEqual(
    L.decidirRegistro(
      trabajo({ ...conBase('2026-10-22 15:00:00.123456+00'), registrarPedidoEn: '2026-10-22T09:00:00Z', archivos: tres }),
      { ...sinToma, fecha_rechazo: '2026-10-22T15:00:00.123Z' },
      3
    ),
    { tipo: 'registrar' }
  );
  // Sin base aún (no se ha leído tras el pedido): no se decide "regresada".
  assert.deepEqual(
    L.decidirRegistro(trabajo({ ...pedido, archivos: tres }), { ...sinToma, fecha_rechazo: '2026-10-22 15:00:00+00' }, 3),
    { tipo: 'registrar' }
  );
  // Una foto rechazada por el servidor (fallida) hace esperar.
  assert.deepEqual(
    L.decidirRegistro(trabajo({ ...pedido, archivos: [...tres, arch({ n: 4, estado: 'fallido' })] }), sinToma, 3),
    { tipo: 'esperar' }
  );
  assert.deepEqual(
    L.decidirRegistro(trabajo({ ...pedido, archivos: [...tres, arch({ n: 4, estado: 'perdido' })] }), sinToma, 3),
    { tipo: 'perdidas', n: 1 }
  );
  // La RLS da [] a una sesión anónima: ver menos de lo que ya entró no es "faltan".
  assert.deepEqual(L.decidirRegistro(trabajo({ ...pedido, archivos: tres }), sinToma, 0), { tipo: 'sinSesion' });
  assert.deepEqual(
    L.decidirRegistro(trabajo({ ...pedido, minimo: 9, archivos: tres }), sinToma, 5),
    { tipo: 'faltan', n: 4 }
  );
  // Videos y quitadas no cuentan como fotos ligadas.
  assert.deepEqual(
    L.decidirRegistro(
      trabajo({ ...pedido, archivos: [arch({ n: 1, estado: 'quitado' }), arch({ n: 2, tipo: 'video', estado: 'ligado' })] }),
      sinToma,
      3
    ),
    { tipo: 'registrar' }
  );
});

test('resumenPorCara junta por año-catorcena-cara', () => {
  const m = L.resumenPorCara([
    trabajo({ archivos: [arch({ n: 1 }), arch({ n: 2, tipo: 'video' }), arch({ n: 3, estado: 'ligado' })], registrar: true }),
  ]);
  const r = m.get(L.llaveCara(2026, 22, 'MX_CM_EV_EVA_01_3325'));
  assert.equal(r.porSubir, 2);
  assert.equal(r.fotosPorSubir, 1);
  assert.equal(r.ligadas, 1);
  assert.equal(r.ligadasEn.length, 1);
  assert.equal(r.registrarPedido, true);
  // Un trabajo que solo espera limpiar el servidor no se pinta.
  const solo = L.resumenPorCara([trabajo({ archivos: [arch({ estado: 'quitado', limpiar: true })] })]);
  assert.equal(solo.size, 0);
});

test('soloLimpieza: todo quitado y sin registro pendiente', () => {
  assert.equal(L.soloLimpieza(trabajo({ archivos: [arch({ estado: 'quitado', limpiar: true })] })), true);
  assert.equal(L.soloLimpieza(trabajo({ archivos: [] })), false);
  assert.equal(L.soloLimpieza(trabajo({ archivos: [arch({ estado: 'quitado' }), arch({ n: 2 })] })), false);
  assert.equal(
    L.soloLimpieza(trabajo({ archivos: [arch({ estado: 'quitado', limpiar: true })], registrar: true })),
    false
  );
});

test('textoLogro: con sitio y cara, y varios en uno', () => {
  assert.equal(
    L.textoLogro([{ site_id: 'MX_QR_EV_CPP024', cara: 'CP', registrada: true, fotos: 9 }]),
    '✓ Toma registrada · MX_QR_EV_CPP024 · cara CP · 9 fotos'
  );
  // Las fotos subieron antes y solo faltaba registrar: sin "(0 fotos)".
  assert.equal(
    L.textoLogro([{ site_id: 'S', cara: '1', registrada: true, fotos: 0 }]),
    '✓ Toma registrada · S · cara 1'
  );
  assert.equal(
    L.textoLogro([{ site_id: 'S', cara: null, registrada: false, fotos: 1 }]),
    '✓ 1 foto subida · S'
  );
  assert.equal(
    L.textoLogro([
      { site_id: 'A', cara: '1', registrada: true, fotos: 9 },
      { site_id: 'B', cara: '2', registrada: true, fotos: 3 },
      { site_id: 'C', cara: '3', registrada: false, fotos: 2 },
    ]),
    '✓ 2 tomas registradas · 14 fotos'
  );
  assert.equal(L.textoLogro([]), '');
  // Fotos sueltas de una cara y luego su registro: UNA toma con las fotos de
  // la toma (antes sumaba 1 + 1 + 3 = «5 fotos» con 3 en el servidor).
  assert.equal(
    L.textoLogro([
      { site_id: 'S', cara: '1', registrada: false, fotos: 1, llave: '2026-22-X' },
      { site_id: 'S', cara: '1', registrada: false, fotos: 1, llave: '2026-22-X' },
      { site_id: 'S', cara: '1', registrada: true, fotos: 3, llave: '2026-22-X' },
    ]),
    '✓ Toma registrada · S · cara 1 · 3 fotos'
  );
  // Sin registro, las sueltas de una cara se suman.
  assert.equal(
    L.textoLogro([
      { site_id: 'S', cara: '1', registrada: false, fotos: 1, llave: 'k' },
      { site_id: 'S', cara: '1', registrada: false, fotos: 2, llave: 'k' },
    ]),
    '✓ 3 fotos subidas · S · cara 1'
  );
});

test('gruposParaCompartir: Android de 10 en 10 y hasta 50 MiB; iOS en uno', () => {
  const fotos = Array.from({ length: 23 }, () => ({ size: 400000 }));
  assert.equal(L.gruposParaCompartir(fotos, false).length, 1);
  assert.deepEqual(L.gruposParaCompartir(fotos, true).map((g) => g.length), [10, 10, 3]);
  const pesadas = [{ size: 30 * 1024 * 1024 }, { size: 30 * 1024 * 1024 }, { size: 1 }];
  assert.deepEqual(L.gruposParaCompartir(pesadas, true).map((g) => g.length), [1, 2]);
  assert.deepEqual(L.gruposParaCompartir([], true), []);
});

test('instanteDe tolera los formatos de la base', () => {
  assert.equal(L.instanteDe('2026-10-22 16:05:00.123456+00'), Date.parse('2026-10-22T16:05:00.123Z'));
  assert.equal(L.instanteDe('2026-10-22T16:05:00'), Date.parse('2026-10-22T16:05:00Z'));
  assert.ok(Number.isNaN(L.instanteDe(null)));
});
