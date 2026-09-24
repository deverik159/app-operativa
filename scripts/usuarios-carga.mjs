// ============================================================
// scripts/usuarios-carga.mjs — usuarios de prueba para la prueba de carga
// (auditoría primer mes, 24-sep-2026). SOLO STAGING.
//
// Crea N cuentas carga+001@…, carga+002@… por la Admin API de Auth (ya
// confirmadas: no sale ningún correo), les da su fila en usuario_roles con
// roles mezclados como la operación real (mayoría reportante / técnico /
// validador de Ecovallas) y su ficha en `usuarios` (sin ficha, el PASO 6 de
// prelanzamiento_300.sql las reporta como "cuentas vivas sin ficha"). Deja
// las credenciales en un JSON para tests/carga/k6-300.js.
//
// `borrar` deshace TODO: las cuentas, sus roles y fichas, sus avisos, y las
// incidencias/evidencias/archivos que la prueba capturó con la marca
// "PRUEBA DE CARGA". Solo toca correos que empiecen con el prefijo de carga
// Y terminen en el dominio de carga; la comparación es exacta, en el script.
//
// Node 18+ y fetch nativo: sin dependencias, a propósito — no hace falta
// npm install para correrlo.
//
// CÓMO CORRERLO (PowerShell, desde la carpeta del proyecto; guía §5.3):
//   $env:SUPABASE_URL = "https://<ref-de-STAGING>.supabase.co"
//   $env:SUPABASE_SERVICE_ROLE_KEY = <service_role de STAGING>
//   $env:CARGA_PASSWORD = <contraseña para las cuentas de prueba>
//   node scripts/usuarios-carga.mjs crear 300
//   node scripts/usuarios-carga.mjs crear 300 --simular   (enseña el plan, sin red)
//   node scripts/usuarios-carga.mjs borrar                (pide escribir BORRAR)
//   node scripts/usuarios-carga.mjs borrar --si           (sin preguntar)
//
// Variables: CARGA_PREFIJO (carga+), CARGA_DOMINIO (gpovallas.com),
// USUARIOS_CARGA (dónde escribir el JSON; por omisión
// tests/carga/.usuarios.json, que DEBE estar en .gitignore).
//
// La service_role se pasa por variable de entorno A PROPÓSITO: no se guarda
// en ningún archivo. Esa llave brinca la RLS — la de STAGING, nunca la de
// producción. Con la de producción el script se detiene (mismo candado que
// k6-300.js; CONFIRMO_PRODUCCION=si existe solo como salida de emergencia y
// la guía dice que NO se usa).
// ============================================================
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

/** Ref de PRODUCCIÓN. No es secreto (va en el bundle); aquí es el candado. */
const REF_PRODUCCION = 'qztxpcfbbbmvgmtjnlxg';
const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const URL_BASE = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const LLAVE = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PASSWORD = process.env.CARGA_PASSWORD || '';
const PREFIJO = String(process.env.CARGA_PREFIJO || 'carga+').toLowerCase();
const DOMINIO = String(process.env.CARGA_DOMINIO || 'gpovallas.com').toLowerCase();
const SALIDA = resolve(process.env.USUARIOS_CARGA || resolve(RAIZ, 'tests/carga/.usuarios.json'));

/** La marca que deja k6-300.js en observaciones (y la siembra de la guía). */
const MARCA = 'PRUEBA DE CARGA';
const BUCKET = 'evidencias';
/** Peticiones a la vez contra la Admin API: rápido sin parecer ataque. */
const EN_PARALELO = 5;
/** Filas por petición en filtros `in.(…)`: la URL no debe crecer sin tope. */
const TROZO = 100;

/**
 * Mezcla de roles, repetida cada 20 usuarios: 8 reportantes, 7 técnicos,
 * 3 validadores, 1 coordinador y 1 monitorista; 15 de 20 en Ecovallas.
 * Departamentos y medios salen de los catálogos de constants.ts
 * (AREAS_USUARIOS para reportante/validador, AREAS_REPARACION_POR_UNIDAD
 * para el técnico), para que la RLS los trate como a gente real.
 *
 * CONTRATO con tests/carga/k6-300.js: la posición 0 (carga+001, +021,
 * +041…) es SIEMPRE reportante de Ecovallas y es la que captura (captura:
 * true) — 1 de cada 20 = el 5 % de los VUs. Si mueves esa fila, cámbialo
 * también allá (CADA_CUANTOS_CAPTURA).
 */
const CICLO = [
  { rol: 'reportante', unidad_negocio: 'Ecovallas', departamento: 'Monitoreo', captura: true },
  { rol: 'reportante', unidad_negocio: 'Ecovallas', departamento: 'Operaciones' },
  { rol: 'reportante', unidad_negocio: 'Ecovallas', departamento: 'Monitoreo' },
  { rol: 'reportante', unidad_negocio: 'Ecovallas', departamento: 'SRD' },
  { rol: 'reportante', unidad_negocio: 'Ecovallas', departamento: 'PPD' },
  { rol: 'reportante', unidad_negocio: 'Ecovallas', departamento: 'Operaciones' },
  { rol: 'reportante', unidad_negocio: 'Vía Verde', departamento: 'Monitoreo' },
  { rol: 'reportante', unidad_negocio: 'Biobox', departamento: 'Operaciones' },
  { rol: 'reparacion', unidad_negocio: 'Ecovallas', departamento: 'Mantenimiento' },
  { rol: 'reparacion', unidad_negocio: 'Ecovallas', departamento: 'Mantenimiento' },
  { rol: 'reparacion', unidad_negocio: 'Ecovallas', departamento: 'Fijación' },
  { rol: 'reparacion', unidad_negocio: 'Ecovallas', departamento: 'Digital' },
  { rol: 'reparacion', unidad_negocio: 'Ecovallas', departamento: 'Iluminación' },
  { rol: 'reparacion', unidad_negocio: 'Vía Verde', departamento: 'Mantenimiento' },
  { rol: 'reparacion', unidad_negocio: 'Biobox', departamento: 'Op. Bio Box' },
  // `medio` solo aplica al validador (null = Impreso y Digital), igual que UsuariosView.
  { rol: 'validador', unidad_negocio: 'Ecovallas', departamento: 'Monitoreo', medio: 'Impreso' },
  { rol: 'validador', unidad_negocio: 'Ecovallas', departamento: 'Operaciones', medio: 'Digital' },
  { rol: 'validador', unidad_negocio: 'Vía Verde', departamento: 'Monitoreo' },
  { rol: 'coordinador', unidad_negocio: 'Ecovallas' },
  { rol: 'monitorista', unidad_negocio: 'Ecovallas' },
];

const ETIQUETA_ROL = {
  reportante: 'Reportante',
  reparacion: 'Técnico',
  validador: 'Validador',
  coordinador: 'Coordinador',
  monitorista: 'Monitorista',
};

// ── Arranque ─────────────────────────────────────────────────

const [comando, ...resto] = process.argv.slice(2);
const banderas = new Set(resto.filter((a) => a.startsWith('--')));
const posicionales = resto.filter((a) => !a.startsWith('--'));

try {
  if (comando === 'crear') await crear(Number(posicionales[0]), banderas.has('--simular'));
  else if (comando === 'borrar') await borrar(banderas.has('--si'));
  else {
    uso();
    process.exitCode = comando ? 1 : 0;
  }
} catch (e) {
  console.error('\n✖ ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
}

function uso() {
  console.log(
    'Uso:\n' +
      '  node scripts/usuarios-carga.mjs crear <N> [--simular]\n' +
      '  node scripts/usuarios-carga.mjs borrar [--si]\n\n' +
      'Variables: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (de STAGING), CARGA_PASSWORD (crear),\n' +
      'CARGA_PREFIJO (carga+), CARGA_DOMINIO (gpovallas.com), USUARIOS_CARGA (ruta del JSON).\n' +
      'Detalle: GUIA-STAGING-Y-CARGA.md §5.'
  );
}

// ── Candados ─────────────────────────────────────────────────

function refDeUrl(url) {
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

function payloadJwt(llave) {
  const partes = llave.split('.');
  if (partes.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function candados({ conLlave }) {
  if (!URL_BASE) throw new Error('Falta SUPABASE_URL (la de STAGING).');
  if (!/^https:\/\//.test(URL_BASE)) throw new Error('SUPABASE_URL debe empezar con https://');
  validarPrefijoYDominio();

  const p = conLlave ? payloadJwt(LLAVE) : null;
  const esProduccion =
    URL_BASE.toLowerCase().includes(REF_PRODUCCION) || (p && p.ref === REF_PRODUCCION);
  if (esProduccion) {
    if (process.env.CONFIRMO_PRODUCCION !== 'si')
      throw new Error(
        `ALTO: SUPABASE_URL o la llave son de PRODUCCIÓN (${REF_PRODUCCION}).\n` +
          '  Los usuarios y datos de carga van SOLO a staging. Cambia SUPABASE_URL y\n' +
          '  SUPABASE_SERVICE_ROLE_KEY a las del proyecto de staging.'
      );
    console.warn(
      '\n######################################################################\n' +
        '######  PRODUCCIÓN (CONFIRMO_PRODUCCION=si): se crean/borran  ########\n' +
        '######  cuentas REALES. Ctrl+C YA si no es lo que quieres.    ########\n' +
        '######################################################################\n'
    );
    for (let s = 10; s > 0; s--) {
      process.stdout.write(`  arranca en ${s}…\r`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('');
  }
  if (!conLlave) return;

  if (!LLAVE) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY (la de STAGING).');
  if (/^sb_publishable_/.test(LLAVE) || (p && p.role === 'anon'))
    throw new Error(
      'Esa es la llave anon/publishable. Este script necesita la service_role (o sb_secret_…) ' +
        'de STAGING: Settings → API Keys.'
    );
  if (p && p.role && p.role !== 'service_role')
    throw new Error(`La llave es de rol "${p.role}"; se necesita la service_role.`);
  const ref = refDeUrl(URL_BASE);
  if (p && p.ref && ref && p.ref !== ref)
    throw new Error(`La llave es del proyecto "${p.ref}" pero SUPABASE_URL apunta a "${ref}".`);
}

function validarPrefijoYDominio() {
  // Un prefijo vacío o corto en `borrar` alcanzaría cuentas que no son de
  // prueba: se exige uno reconocible.
  if (PREFIJO.length < 4 || !/^[a-z0-9.+-]+$/.test(PREFIJO))
    throw new Error(`CARGA_PREFIJO "${PREFIJO}" no sirve: mínimo 4 caracteres [a-z0-9.+-].`);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(DOMINIO))
    throw new Error(`CARGA_DOMINIO "${DOMINIO}" no parece un dominio.`);
}

function correo(i) {
  return `${PREFIJO}${String(i + 1).padStart(3, '0')}@${DOMINIO}`;
}

function esDeCarga(email) {
  const e = String(email || '').toLowerCase();
  return e.startsWith(PREFIJO) && e.endsWith('@' + DOMINIO);
}

// ── HTTP ─────────────────────────────────────────────────────

/**
 * Una petición a Supabase con la service_role. No lanza por estado HTTP:
 * devuelve {status, ok, datos} y quien llama decide. Sí lanza sin red.
 */
async function api(metodo, ruta, { cuerpo, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(URL_BASE + ruta, {
      method: metodo,
      headers: {
        apikey: LLAVE,
        Authorization: 'Bearer ' + LLAVE,
        ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
  } catch (e) {
    throw new Error(`Sin red hacia ${URL_BASE} (${metodo} ${ruta.split('?')[0]}): ${e.message}`);
  }
  const texto = await res.text();
  let datos = texto;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    /* no era JSON */
  }
  return { status: res.status, ok: res.ok, datos };
}

function mensajeDe(r) {
  const d = r.datos;
  if (d && typeof d === 'object')
    return [d.code || d.error_code, d.message || d.msg || d.error_description || d.error]
      .filter(Boolean)
      .join(': ');
  return String(d || '').slice(0, 300);
}

/** ¿La tabla no existe en este proyecto? (se omite en vez de fallar). */
function tablaFaltante(r) {
  const d = r.datos && typeof r.datos === 'object' ? r.datos : {};
  return r.status === 404 || d.code === 'PGRST205' || d.code === '42P01';
}

/** Filtro `in.(…)` de PostgREST con valores entre comillas (correos con + y @). */
function enLista(valores) {
  return (
    'in.(' +
    valores.map((v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') +
    ')'
  );
}

function trozos(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function enParalelo(items, n, fn) {
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < items.length) {
      const i = siguiente++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, trabajador));
}

/** Todas las cuentas de Auth que son de carga: correo → id. */
async function cuentasDeCarga() {
  const m = new Map();
  // Se corta con una página VACÍA: si el servidor topa per_page por debajo
  // de lo pedido, cortar por "vino incompleta" se saltaría cuentas.
  for (let pagina = 1; pagina <= 1000; pagina++) {
    const r = await api('GET', `/auth/v1/admin/users?page=${pagina}&per_page=200`);
    if (!r.ok) throw new Error('No pude listar las cuentas de Auth: ' + mensajeDe(r));
    const lista = (r.datos && r.datos.users) || [];
    for (const u of lista) if (esDeCarga(u.email)) m.set(u.email.toLowerCase(), u.id);
    if (!lista.length) break;
  }
  return m;
}

// ── crear ────────────────────────────────────────────────────

async function crear(n, simular) {
  if (!Number.isInteger(n) || n < 1 || n > 2000)
    throw new Error('Indica cuántos: `crear 300` (entre 1 y 2000).');

  const plan = Array.from({ length: n }, (_, i) => {
    const c = CICLO[i % CICLO.length];
    return {
      email: correo(i),
      rol: c.rol,
      unidad_negocio: c.unidad_negocio,
      departamento: c.departamento || null,
      medio: c.medio || null,
      captura: !!c.captura,
      nombre: `Carga ${String(i + 1).padStart(3, '0')} · ${ETIQUETA_ROL[c.rol] || c.rol}`,
    };
  });

  if (simular) {
    if (URL_BASE) await candados({ conLlave: false });
    imprimirPlan(plan);
    console.log(`\n(--simular) No se tocó nada. El JSON iría a: ${relative(RAIZ, SALIDA) || SALIDA}`);
    return;
  }

  await candados({ conLlave: true });
  if (PASSWORD.length < 8)
    throw new Error('Falta CARGA_PASSWORD (mínimo 8 caracteres) para las cuentas de prueba.');

  console.log(`Staging: ${URL_BASE}\nCreando ${n} usuarios de carga (${correo(0)} … ${correo(n - 1)})…`);
  const existentes = await cuentasDeCarga();

  // 1) Cuentas de Auth: nueva, o la existente con la contraseña de hoy (y
  // desbloqueada, por si una prueba anterior la dio de baja).
  let hechas = 0;
  const errores = [];
  await enParalelo(plan, EN_PARALELO, async (p) => {
    const id = existentes.get(p.email);
    const meta = { name: p.nombre };
    const r = id
      ? await api('PUT', `/auth/v1/admin/users/${id}`, {
          cuerpo: { password: PASSWORD, email_confirm: true, ban_duration: 'none', user_metadata: meta },
        })
      : await api('POST', '/auth/v1/admin/users', {
          cuerpo: { email: p.email, password: PASSWORD, email_confirm: true, user_metadata: meta },
        });
    if (!r.ok) {
      errores.push(`${p.email}: ${r.status} ${mensajeDe(r)}`);
      return;
    }
    p.id = (r.datos && r.datos.id) || id;
    if (++hechas % 25 === 0) console.log(`  ${hechas}/${n} cuentas…`);
  });
  if (errores.length)
    throw new Error(
      `${errores.length} cuentas no se pudieron crear. Primeras:\n  ` + errores.slice(0, 5).join('\n  ')
    );
  console.log(`✔ ${n} cuentas de Auth listas (${existentes.size} ya existían).`);

  const correos = plan.map((p) => p.email);

  // 2) Roles: se reemplazan completos, así una re-corrida no duplica filas.
  await borrarPorLista('usuario_roles', 'usuario_email', correos);
  let roles = 0;
  for (const t of trozos(plan, 200)) {
    const r = await api('POST', '/rest/v1/usuario_roles?select=id', {
      headers: { Prefer: 'return=representation' },
      cuerpo: t.map((p) => ({
        usuario_email: p.email,
        rol: p.rol,
        unidad_negocio: p.unidad_negocio,
        departamento: p.departamento,
        medio: p.medio,
      })),
    });
    if (!r.ok) throw new Error('No se pudieron insertar los roles: ' + mensajeDe(r));
    // Se CUENTA lo que regresó: "sin error" no garantiza filas.
    roles += Array.isArray(r.datos) ? r.datos.length : 0;
  }
  if (roles !== n) throw new Error(`Se esperaban ${n} filas en usuario_roles y quedaron ${roles}.`);
  console.log(`✔ ${roles} roles en usuario_roles.`);

  // 3) Fichas en `usuarios` (lo mismo que manda UsuariosView al dar de alta).
  await borrarPorLista('usuarios', 'email', correos);
  let fichas = 0;
  for (const t of trozos(plan, 200)) {
    const cuerpo = t.map((p) => ({ email: p.email, nombre: p.nombre, telefono: null }));
    let r = await api('POST', '/rest/v1/usuarios?select=email', {
      headers: { Prefer: 'return=representation' },
      cuerpo,
    });
    // Si en este proyecto `usuarios.id` no tiene default (o es la llave de
    // la cuenta de Auth), se reintenta mandando el id de la cuenta.
    if (!r.ok && r.datos && r.datos.code === '23502' && /"id"/.test(r.datos.message || '')) {
      r = await api('POST', '/rest/v1/usuarios?select=email', {
        headers: { Prefer: 'return=representation' },
        cuerpo: t.map((p, i) => ({ ...cuerpo[i], id: p.id })),
      });
    }
    if (!r.ok) throw new Error('No se pudieron crear las fichas en usuarios: ' + mensajeDe(r));
    fichas += Array.isArray(r.datos) ? r.datos.length : 0;
  }
  if (fichas !== n) throw new Error(`Se esperaban ${n} fichas en usuarios y quedaron ${fichas}.`);
  console.log(`✔ ${fichas} fichas en usuarios.`);

  // 4) El JSON para k6.
  await mkdir(dirname(SALIDA), { recursive: true });
  const json = plan.map((p) => ({
    email: p.email,
    password: PASSWORD,
    rol: p.rol,
    unidad_negocio: p.unidad_negocio,
    departamento: p.departamento,
    medio: p.medio,
    captura: p.captura,
  }));
  await writeFile(SALIDA, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`✔ Credenciales en ${SALIDA}`);
  avisarSiNoEstaIgnorado(SALIDA);
  imprimirPlan(plan);
  console.log(
    '\nSiguiente: k6 run tests/carga/k6-300.js con USUARIOS_CARGA=' +
      SALIDA.replace(/\\/g, '/') +
      '\nAl terminar: node scripts/usuarios-carga.mjs borrar'
  );
}

function imprimirPlan(plan) {
  const cuenta = {};
  for (const p of plan) {
    const k = `${p.rol} · ${p.unidad_negocio}`;
    cuenta[k] = (cuenta[k] || 0) + 1;
  }
  console.log(`\nMezcla de roles (${plan.length} usuarios; capturan ${plan.filter((p) => p.captura).length}):`);
  for (const [k, v] of Object.entries(cuenta).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log('Primeros:');
  for (const p of plan.slice(0, 3))
    console.log(`  ${p.email}  ${p.rol} · ${p.unidad_negocio} · ${p.departamento || '—'}${p.captura ? '  (captura)' : ''}`);
}

/** El JSON trae contraseñas: si git no lo ignora, se avisa fuerte. */
function avisarSiNoEstaIgnorado(ruta) {
  const dentro = !relative(RAIZ, ruta).startsWith('..');
  if (!dentro) return;
  try {
    execFileSync('git', ['check-ignore', '-q', ruta], { cwd: RAIZ, stdio: 'ignore' });
  } catch (e) {
    if (e && e.status === 1)
      console.warn(
        '\n⚠ ' + relative(RAIZ, ruta).replace(/\\/g, '/') + ' NO está en .gitignore y trae contraseñas.\n' +
          '  Agrega la línea  tests/carga/.usuarios.json  al .gitignore antes de cualquier commit.'
      );
  }
}

// ── borrar ───────────────────────────────────────────────────

async function borrar(sinPreguntar) {
  await candados({ conLlave: true });
  console.log(`Staging: ${URL_BASE}\nBuscando datos de carga (${PREFIJO}…@${DOMINIO})…`);

  // Correos de carga: los de Auth y también los que solo quedaron en tablas
  // (p. ej. una corrida que se cortó a medias).
  const cuentas = await cuentasDeCarga();
  const correos = new Set(cuentas.keys());
  for (const [tabla, col] of [['usuario_roles', 'usuario_email'], ['usuarios', 'email']]) {
    const patron = encodeURIComponent(`ilike.${PREFIJO}*@${DOMINIO}`);
    const r = await api('GET', `/rest/v1/${tabla}?select=${col}&${col}=${patron}&limit=5000`);
    if (r.ok && Array.isArray(r.datos))
      for (const f of r.datos) if (esDeCarga(f[col])) correos.add(f[col].toLowerCase());
  }
  const lista = [...correos];
  if (lista.length > 2500)
    throw new Error(`Salieron ${lista.length} correos de carga: demasiados, revisa CARGA_PREFIJO/CARGA_DOMINIO.`);

  // Incidencias de esos usuarios: se borran SOLO las que traen la marca.
  const marcadas = [];
  let sinMarca = 0;
  for (const t of trozos(lista, TROZO)) {
    for (let desde = 0; ; desde += 1000) {
      const r = await api(
        'GET',
        `/rest/v1/incidencias?select=record_id,observaciones,clave_sitio&captured_by=${encodeURIComponent(enLista(t))}` +
          `&order=record_id.asc&offset=${desde}&limit=1000`
      );
      if (!r.ok) throw new Error('No pude leer incidencias: ' + mensajeDe(r));
      for (const f of r.datos) {
        if (String(f.observaciones || '').includes(MARCA)) marcadas.push(f);
        else sinMarca++;
      }
      if (r.datos.length < 1000) break;
    }
  }
  const ids = marcadas.map((f) => f.record_id);

  console.log(
    `\nSe va a borrar:\n  ${cuentas.size} cuentas de Auth (${lista.length} correos de carga en total)\n` +
      `  ${ids.length} incidencias con la marca "${MARCA}", con sus evidencias, archivos y avisos`
  );
  if (sinMarca)
    console.log(`  (${sinMarca} incidencias de estos usuarios NO traen la marca: se dejan, revísalas a mano)`);
  if (!lista.length && !ids.length) {
    console.log('\nNo hay nada de carga que borrar.');
    await borrarJsonLocal();
    return;
  }
  if (!sinPreguntar) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const resp = await rl.question('\nEscribe BORRAR para continuar: ');
    rl.close();
    if (resp.trim() !== 'BORRAR') {
      console.log('Cancelado: no se borró nada.');
      return;
    }
  }

  // 1) Archivos de Storage. Las capturas de k6 van en la carpeta <record_id>/
  // (con su mini/): se lista la carpeta para no dejar huérfanos de una
  // subida que no alcanzó a registrar su evidencia. La siembra no sube
  // archivos, así que solo se listan las carpetas de capturas de k6.
  const rutas = new Set();
  for (const t of trozos(ids, TROZO)) {
    const r = await api('GET', `/rest/v1/evidencias?select=path&record_id=${encodeURIComponent(enLista(t))}&limit=5000`);
    if (!r.ok || !Array.isArray(r.datos)) continue;
    for (const f of r.datos) {
      if (!f.path) continue;
      rutas.add(f.path);
      rutas.add(rutaMiniatura(f.path));
    }
  }
  for (const f of marcadas.filter((x) => x.clave_sitio === 'PRUEBA-CARGA')) {
    for (const carpeta of [f.record_id, `${f.record_id}/mini`]) {
      const r = await api('POST', `/storage/v1/object/list/${BUCKET}`, {
        cuerpo: { prefix: carpeta, limit: 1000, offset: 0 },
      });
      if (r.ok && Array.isArray(r.datos))
        for (const o of r.datos) if (o.id) rutas.add(`${carpeta}/${o.name}`);
    }
  }
  let archivos = 0;
  for (const t of trozos([...rutas], TROZO)) {
    const r = await api('DELETE', `/storage/v1/object/${BUCKET}`, { cuerpo: { prefixes: t } });
    if (!r.ok) throw new Error('Storage rechazó el borrado: ' + mensajeDe(r) + '. Vuelve a correr `borrar`.');
    archivos += Array.isArray(r.datos) ? r.datos.length : 0;
  }
  console.log(`✔ ${archivos} archivos borrados de Storage.`);

  // 2) Filas que cuelgan de esas incidencias, de hijas a madre.
  for (const tabla of ['notificaciones', 'mensajes', 'chat_adjuntos', 'reasignaciones', 'evidencias', 'incidencias'])
    await borrarPorLista(tabla, 'record_id', ids, true);

  // 3) Lo que es de las personas de carga.
  for (const [tabla, col] of [
    ['notificaciones', 'para_email'],
    ['errores_cliente', 'usuario_email'],
    ['push_suscripciones', 'usuario_email'],
    ['ruta_asignaciones', 'usuario_email'],
    ['usuario_roles', 'usuario_email'],
    ['usuarios', 'email'],
  ])
    await borrarPorLista(tabla, col, lista, true);

  // 4) Las cuentas de Auth.
  let fuera = 0;
  const fallidas = [];
  await enParalelo([...cuentas], EN_PARALELO, async ([email, id]) => {
    const r = await api('DELETE', `/auth/v1/admin/users/${id}`);
    if (r.ok || r.status === 404) fuera++;
    else fallidas.push(`${email}: ${r.status} ${mensajeDe(r)}`);
  });
  console.log(`✔ ${fuera} cuentas de Auth eliminadas.`);
  if (fallidas.length)
    throw new Error(`${fallidas.length} cuentas no se borraron (vuelve a correr \`borrar\`):\n  ` + fallidas.slice(0, 5).join('\n  '));

  await borrarJsonLocal();
  console.log('\nListo: staging quedó sin datos de carga.');
}

/**
 * DELETE por `col=in.(…)` en trozos, contando lo que de verdad se borró
 * (con RLS o sin permiso, un DELETE puede responder 200 y borrar 0).
 */
async function borrarPorLista(tabla, col, valores, informar = false) {
  if (!valores.length) return 0;
  let total = 0;
  for (const t of trozos(valores, TROZO)) {
    const r = await api('DELETE', `/rest/v1/${tabla}?${col}=${encodeURIComponent(enLista(t))}&select=${col}`, {
      headers: { Prefer: 'return=representation' },
    });
    if (!r.ok) {
      if (tablaFaltante(r)) {
        if (informar) console.log(`  · ${tabla}: no existe en este proyecto, se omite.`);
        return 0;
      }
      throw new Error(`No pude borrar de ${tabla}: ${mensajeDe(r)}`);
    }
    total += Array.isArray(r.datos) ? r.datos.length : 0;
  }
  if (informar) console.log(`  · ${tabla} (${col}): ${total} filas`);
  return total;
}

/** `abc/EV1_x_123.png` → `abc/mini/EV1_x_123.jpg` (misma regla que storage.ts). */
function rutaMiniatura(path) {
  const i = path.lastIndexOf('/');
  const dir = i >= 0 ? path.slice(0, i + 1) : '';
  const nombre = (i >= 0 ? path.slice(i + 1) : path).replace(/\.[^.]+$/, '');
  return `${dir}mini/${nombre}.jpg`;
}

/** El JSON de credenciales ya no sirve: se quita para que no quede rodando. */
async function borrarJsonLocal() {
  if (!existsSync(SALIDA)) return;
  await unlink(SALIDA);
  console.log(`✔ Se borró ${SALIDA} (traía contraseñas).`);
}
