// ============================================================
// tests/carga/k6-300.js — prueba de carga: 300 usuarios a la vez con el
// patrón REAL de la app (auditoría primer mes, 24-sep-2026).
//
// ES JAVASCRIPT DE k6, NO DE NODE. Los imports 'k6/...' solo existen dentro
// de k6: se corre con `k6 run`, nunca con `node`. Guía completa (instalar,
// preparar staging, leer resultados y limpiar): GUIA-STAGING-Y-CARGA.md §5.
//
// SOLO CONTRA STAGING. setup() ABORTA si SUPABASE_URL (o la llave) es de
// producción. La salida de emergencia CONFIRMO_PRODUCCION=si existe solo
// para no dejar un callejón sin salida; la guía dice que NO se usa: 300
// usuarios falsos capturando y sondeando en producción ensucian datos
// reales, mandan avisos a personas reales y compiten con la operación.
//
// QUÉ SIMULA CADA USUARIO VIRTUAL (VU) — y de qué archivo sale cada petición:
//   Al entrar
//     · login con correo y contraseña (Auth)                    → App.tsx
//     · usuario_roles del usuario                                → App.tsx
//     · Indicadores: es la pestaña de INICIO ('dashboard') de todos salvo
//       el monitorista puro                                      → IndicadoresView
//     · la bandeja (monta IncidenciasView: SLA + lista)          → IncidenciasView
//     · monitorista puro: Pauta en lugar de lo anterior          → PautaView
//   Cada 60 s
//     · campana: notificaciones con COLUMNAS/LIMITE + conteo de
//       chats sin leer                                           → useNotificaciones.ts
//     · a veces marca un aviso como leído (escritura chica)
//     · si llega un aviso NUEVO de incidencia, recarga la lista
//       (igual que App: hayNuevaIncidencia → recargarSignal)
//   Cada ~5 min (↻ o navegación): recarga la lista con el patrón NUEVO de
//     IncidenciasView (auditoría primer mes): abiertas paginadas, historial
//     (1000), fotos por la RPC fotos_tarjetas en lotes de 400 (3 a la vez) y
//     reasignaciones solicitadas.
//   De vez en cuando: abre Indicadores (90 días, columnas proyectadas,
//     paginado) y vuelve a la bandeja — lo que la remonta y la recarga.
//   5 % de los VUs, UNA vez: captura un reporte de prueba (duplicados →
//     insert en incidencias → foto + miniatura a Storage → evidencias), con
//     la marca "PRUEBA DE CARGA" en observaciones. Lo borra
//     `node scripts/usuarios-carga.mjs borrar`.
//   Opcional (APP_URL): version.json cada 15 min — es Vercel, no Supabase.
//
// LO QUE NO SIMULA (a propósito): la descarga del bundle y las miniaturas
// (CDN de Vercel y de Storage, no la base), el chat en vivo (Realtime), el
// push y los módulos de Biobox/Fijación/Rutas. El cuello que se busca es la
// base de datos y la API con 300 sesiones.
//
// VARIABLES (todas por entorno; NINGUNA llave va escrita en este archivo):
//   SUPABASE_URL        https://<ref-de-STAGING>.supabase.co          (obligatoria)
//   SUPABASE_ANON_KEY   la anon/publishable de STAGING                (obligatoria)
//   USUARIOS_CARGA      ruta ABSOLUTA al JSON [{email,password,…}] que escribe
//                       scripts/usuarios-carga.mjs. Sin ella se busca
//                       ./.usuarios.json junto a este archivo.
//   CARGA_PASSWORD      alternativa al JSON: patrón carga+NNN@<dominio> con
//                       esta contraseña (CARGA_PREFIJO, CARGA_DOMINIO, CARGA_N)
//   VUS (300) · RAMPA (5m) · MESETA (10m) · BAJADA (1m)
//   RECARGA_MIN (5)     minutos promedio entre recargas de lista
//   PROB_INDICADORES (0.05)  probabilidad POR MINUTO de abrir Indicadores
//   INDICADORES_AL_ENTRAR (si)  'no' si el arranque ya no cae en Indicadores
//   INDICADORES_COLUMNAS  proyección de Indicadores (default: la de abajo;
//                       si la cambias, deja record_id: con él se pagina)
//   CAPTURA (si)        'no' = nadie captura
//   IMG_LADO (200)      lado en px de la foto de prueba (200 ≈ 120 kB, como
//                       las fotos comprimidas reales de 100–190 kB)
//   APP_URL             p. ej. https://app-operativa-git-staging-….vercel.app
//                       (solo si la Preview no pide login de Vercel)
//   RESULTADO_JSON      ruta ABSOLUTA donde guardar el resumen completo en JSON
//   CONFIRMO_PRODUCCION NO SE USA. Ver arriba.
// ============================================================
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import encoding from 'k6/encoding';
import exec from 'k6/execution';

// ── Configuración ────────────────────────────────────────────

/** Ref de PRODUCCIÓN. No es secreto (va en el bundle); aquí es el candado. */
const REF_PRODUCCION = 'qztxpcfbbbmvgmtjnlxg';

const URL_BASE = String(__ENV.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const ANON = String(__ENV.SUPABASE_ANON_KEY || '').trim();

const VUS = entero(__ENV.VUS, 300);
const RAMPA = __ENV.RAMPA || '5m';
const MESETA = __ENV.MESETA || '10m';
const BAJADA = __ENV.BAJADA || '1m';

/** Campana: 60 s, igual que INTERVALO_MS de useNotificaciones.ts. */
const INTERVALO_S = 60;
const LIMITE_NOTIFS = 60;
const LIMITE_CHATS = 500;
const COLUMNAS_NOTIFS = 'id,record_id,evento,mensaje,unidad_negocio,creado_en,leida';

/** Recarga de lista: promedio en minutos, con ±20 % para no sincronizar VUs. */
const RECARGA_MIN = Math.max(1, numero(__ENV.RECARGA_MIN, 5));
const PROB_INDICADORES = Math.min(1, Math.max(0, numero(__ENV.PROB_INDICADORES, 0.05)));
const INDICADORES_AL_ENTRAR = String(__ENV.INDICADORES_AL_ENTRAR || 'si').toLowerCase() !== 'no';
/** Probabilidad, en cada tick con avisos, de "atender" uno (marcarLeida). */
const PROB_MARCAR_LEIDA = 0.2;

/** Paginado: el tope duro de PostgREST es 1000 filas por consulta. */
const PAGINA = 1000;
/** Mismos topes que IncidenciasView / IndicadoresView / PautaView. */
const TOPE_PAGINAS_ABIERTAS = 20;
const TOPE_PAGINAS_KPI = 30;
const TOPE_PAGINAS_PAUTA = 20;
/** fotos_tarjetas: 400 ids por llamada, 3 llamadas a la vez (IncidenciasView). */
const LOTE_FOTOS = 400;
const FOTOS_EN_PARALELO = 3;

/**
 * Columnas de Indicadores: COPIA de COLUMNAS_KPI de IndicadoresView.tsx al
 * 24-sep-2026 (frente de indicadores del primer mes). Si allá cambia la
 * proyección, cámbiala aquí o pásala en INDICADORES_COLUMNAS; con '*' mide
 * el peor caso. Si una columna no existe (42703), se cae a '*' como la app.
 */
const COLUMNAS_KPI = [
  'record_id', 'folio', 'estatus', 'fecha_reporte', 'unidad_negocio',
  'area_responsable', 'assigned_area', 'area_reportante', 'nivel', 'catorcena',
  'nombre_incidencia', 'incidencia_srd', 'tipo_mueble', 'tipo_medio', 'medio',
  'lado', 'repaired_by_email', 'rechazos_reparacion', 'repaired_at',
  'validator_at', 'sla_reparacion_inicio', 'clave_sitio', 'clave_medio',
  'direccion', 'municipio',
].join(',');
const COLUMNAS_INDICADORES = __ENV.INDICADORES_COLUMNAS || COLUMNAS_KPI;

// La bandeja pide select=* a propósito: es lo que hace IncidenciasView hoy.
const RUTA_ABIERTAS =
  '/rest/v1/incidencias?select=*&estatus=not.in.(cerrada,no_reparado)' +
  '&order=fecha_reporte.desc,record_id.asc';
const RUTA_HISTORIAL =
  '/rest/v1/incidencias?select=*&estatus=in.(cerrada,no_reparado)' +
  '&order=fecha_reporte.desc,record_id.asc';
/** El respaldo de la app cuando la RPC fotos_tarjetas no existe (PGRST202). */
const RUTA_FOTOS_RESPALDO =
  '/rest/v1/evidencias?select=record_id,url,etapa&tipo=eq.foto' +
  '&etapa=in.(reporte,reparacion)&order=creado_en.desc&limit=3000';
const RUTA_REASIGNACIONES =
  '/rest/v1/reasignaciones?select=record_id,evidencia&estado=eq.Solicitada' +
  '&evidencia=not.is.null&limit=500';

/**
 * CONTRATO con scripts/usuarios-carga.mjs: de cada 20 usuarios, el PRIMERO
 * (índice 0, 20, 40… → carga+001, carga+021, carga+041…) es reportante de
 * Ecovallas y es el que captura. 1 de cada 20 = el 5 % de los VUs. Si cambias
 * esto, cámbialo también allá.
 */
const CADA_CUANTOS_CAPTURA = 20;
const CAPTURA = String(__ENV.CAPTURA || 'si').toLowerCase() !== 'no';
const IMG_LADO = Math.min(600, Math.max(16, entero(__ENV.IMG_LADO, 200)));
/** La marca que busca el borrado. No la cambies sin cambiarla allá. */
const MARCA = 'PRUEBA DE CARGA';
const NOMBRE_INCIDENCIA_PRUEBA = 'PRUEBA DE CARGA — no atender';

const APP_URL = String(__ENV.APP_URL || '').trim().replace(/\/+$/, '');
const PREFIJO = String(__ENV.CARGA_PREFIJO || 'carga+').toLowerCase();
const DOMINIO = String(__ENV.CARGA_DOMINIO || 'gpovallas.com').toLowerCase();

/** Viaja en cada petición: en los logs de la API de Supabase se filtra por él. */
const CLIENTE = 'k6-carga-gpovallas';

/**
 * Cada endpoint con su tipo. El tipo decide a qué umbral cuenta:
 *   lectura   → p95 < 800 ms       auth → el login, p95 < 2 s
 *   escritura / subida → solo tasa de fallas y la tabla por endpoint
 *   vercel / preflight → fuera de los umbrales de lectura
 */
const ENDPOINTS = {
  login: 'auth',
  refresh: 'auth',
  roles: 'lectura',
  campana_notifs: 'lectura',
  campana_chats: 'lectura',
  campana_marcar: 'escritura',
  sla_areas: 'lectura',
  sla_validacion: 'lectura',
  abiertas: 'lectura',
  historial: 'lectura',
  fotos_tarjetas: 'lectura',
  fotos_respaldo: 'lectura',
  reasignaciones: 'lectura',
  kpi_incidencias: 'lectura',
  kpi_abiertas_antes: 'lectura',
  nombres_tecnicos: 'lectura',
  nombres_usuarios: 'lectura',
  pauta_asignaciones: 'lectura',
  pauta_catorcenas: 'lectura',
  pauta_ruta: 'lectura',
  captura_duplicados: 'lectura',
  captura_incidencia: 'escritura',
  captura_subida: 'subida',
  captura_subida_mini: 'subida',
  captura_evidencia: 'escritura',
  version_json: 'vercel',
  preflight_login: 'preflight',
  preflight_rpc: 'preflight',
};

// ── Escenario y umbrales ─────────────────────────────────────

export const options = {
  scenarios: {
    usuarios: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMPA, target: VUS }, // van entrando, como en un arranque de turno
        { duration: MESETA, target: VUS }, // los 300 a la vez
        { duration: BAJADA, target: 0 },
      ],
      // Un tick dura 60 s: se deja terminar el que va en curso.
      gracefulRampDown: '70s',
      gracefulStop: '70s',
    },
  },
  setupTimeout: '2m',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'],
  thresholds: {
    // Los tres de la auditoría. Si alguno falla, k6 termina con código 99.
    http_req_failed: ['rate<0.01'],
    'http_req_duration{tipo:lectura}': ['p(95)<800'],
    'http_req_duration{nombre:login}': ['p(95)<2000'],
    // Además: que las verificaciones de contenido (p. ej. "la base devolvió
    // la fila creada") pasen. Un 200 con 0 filas es la RLS silenciosa.
    checks: ['rate>0.99'],
  },
};

// ── Métricas propias ─────────────────────────────────────────
// Una Trend (tiempo) y una Rate (fallas) por endpoint: así el resumen se lee
// por endpoint sin inventar umbrales de relleno. Las métricas de k6 solo se
// pueden declarar aquí, en el contexto de inicio.
const METRICAS = {};
Object.keys(ENDPOINTS).forEach(function (n) {
  METRICAS[n] = { tiempo: new Trend('t_' + n, true), fallas: new Rate('f_' + n) };
});
const cHttp401 = new Counter('http_401');
const cHttp403 = new Counter('http_403');
const cHttp429 = new Counter('http_429');
const cHttp5xx = new Counter('http_5xx');
const cSinRed = new Counter('sin_red');
const cLoginFallido = new Counter('login_fallido');
const cSinRoles = new Counter('sesiones_sin_roles');
const cRpcFaltante = new Counter('fotos_rpc_faltante');
const cKpiColumnas = new Counter('kpi_columnas_faltantes');
const cCapturaOk = new Counter('captura_ok');
const cCapturaFallida = new Counter('captura_fallida');
const cCapturaRls = new Counter('captura_rls_silenciosa');
const cCapturaOmitida = new Counter('captura_omitida');
/** Filas que ve cada usuario en su bandeja: si da 0, la prueba no mide nada. */
const tFilasBandeja = new Trend('filas_bandeja');

// ── Usuarios de prueba ───────────────────────────────────────
// SharedArray: el JSON se lee UNA vez y lo comparten los 300 VUs (sin
// SharedArray serían 300 copias en memoria).
const USUARIOS = new SharedArray('usuarios', function () {
  const ruta = __ENV.USUARIOS_CARGA;
  if (ruta) {
    let texto;
    try {
      texto = open(ruta);
    } catch (e) {
      throw new Error(
        'No pude leer USUARIOS_CARGA=' + ruta + ' (' + e + '). Usa una ruta ' +
          'ABSOLUTA con diagonales /, p. ej. C:/app-operativa/tests/carga/.usuarios.json'
      );
    }
    return normalizarUsuarios(JSON.parse(texto));
  }
  if (__ENV.CARGA_PASSWORD) {
    const n = entero(__ENV.CARGA_N, VUS);
    const lista = [];
    for (let i = 0; i < n; i++)
      lista.push({
        email: correoCarga(i),
        password: __ENV.CARGA_PASSWORD,
        captura: i % CADA_CUANTOS_CAPTURA === 0,
      });
    return lista;
  }
  try {
    return normalizarUsuarios(JSON.parse(open('./.usuarios.json')));
  } catch (e) {
    return []; // setup() explica qué falta
  }
});

function normalizarUsuarios(lista) {
  if (!Array.isArray(lista)) throw new Error('USUARIOS_CARGA debe ser un arreglo [{email,password}].');
  return lista
    .filter(function (u) {
      return u && u.email;
    })
    .map(function (u, i) {
      return {
        email: String(u.email).toLowerCase(),
        password: u.password || __ENV.CARGA_PASSWORD || '',
        // Sin la marca en el JSON, vale el contrato por posición.
        captura: typeof u.captura === 'boolean' ? u.captura : i % CADA_CUANTOS_CAPTURA === 0,
      };
    });
}

function correoCarga(i) {
  return PREFIJO + String(i + 1).padStart(3, '0') + '@' + DOMINIO;
}

// ── setup(): candados antes de disparar una sola petición de VU ──

export function setup() {
  if (!URL_BASE || !ANON)
    exec.test.abort(
      'Faltan SUPABASE_URL y/o SUPABASE_ANON_KEY (de STAGING). Ver GUIA-STAGING-Y-CARGA.md §5.'
    );
  salvaguardaProduccion();
  validarLlaveAnon();
  if (!USUARIOS.length)
    exec.test.abort(
      'No hay usuarios de prueba: pasa USUARIOS_CARGA (ruta absoluta al JSON de ' +
        'scripts/usuarios-carga.mjs) o CARGA_PASSWORD para el patrón ' + correoCarga(0) + '.'
    );
  // SharedArray no trae .some()/.filter(): solo length, índice y for-of.
  for (let i = 0; i < USUARIOS.length; i++)
    if (!USUARIOS[i].password)
      exec.test.abort('Hay usuarios sin contraseña en el JSON y no se pasó CARGA_PASSWORD.');
  if (USUARIOS.length < VUS)
    console.warn(
      'Hay ' + USUARIOS.length + ' usuarios para ' + VUS + ' VUs: algunas cuentas ' +
        'tendrán varias sesiones a la vez. Para el caso real, crea ' + VUS + '.'
    );

  // Preflight: si el primer usuario no entra, no tiene caso lanzar 300.
  const u = USUARIOS[0];
  const s = login(u, 'preflight_login');
  if (!s)
    exec.test.abort(
      u.email + ' no pudo iniciar sesión en ' + URL_BASE + '. ¿Corriste ' +
        '`node scripts/usuarios-carga.mjs crear` contra ESTE proyecto y con la misma contraseña?'
    );

  // ¿Existe ya la RPC de fotos (primer_mes.sql)? Si no, la app cae al
  // respaldo viejo y la prueba también — pero lo avisa fuerte.
  const r = pedir('POST', '/rest/v1/rpc/fotos_tarjetas', { p_ids: [] }, {
    nombre: 'preflight_rpc',
    token: s.token,
    esperados: [200, 400, 404],
  });
  const rpcFotos = !(r.status === 404 && esFuncionFaltante(r));
  if (!rpcFotos)
    console.warn(
      '\n  ######################################################################\n' +
        '  OJO: la RPC fotos_tarjetas NO existe en este proyecto (PGRST202).\n' +
        '  La prueba usará el respaldo viejo (evidencias limit 3000), que NO es\n' +
        '  el patrón nuevo. Aplica su SQL en staging y repite para medir lo real.\n' +
        '  ######################################################################\n'
    );
  else if (r.status !== 200)
    console.warn('fotos_tarjetas respondió ' + r.status + ' con p_ids vacío: ' + recorte(r.body));
  return { rpcFotos: rpcFotos };
}

function refDeUrl(url) {
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

function payloadJwt(llave) {
  const partes = String(llave).split('.');
  if (partes.length !== 3) return null;
  try {
    return JSON.parse(encoding.b64decode(partes[1], 'rawurl', 's'));
  } catch (e) {
    return null;
  }
}

function salvaguardaProduccion() {
  const p = payloadJwt(ANON);
  const esProduccion =
    URL_BASE.toLowerCase().indexOf(REF_PRODUCCION) !== -1 ||
    (p !== null && p.ref === REF_PRODUCCION);
  if (!esProduccion) return;
  if (String(__ENV.CONFIRMO_PRODUCCION || '') !== 'si')
    exec.test.abort(
      '\n\n  ALTO: SUPABASE_URL o la llave son de PRODUCCIÓN (' + REF_PRODUCCION + ').\n' +
        '  Esta prueba es SOLO para staging: 300 usuarios falsos capturando en\n' +
        '  producción ensucian datos reales y avisan a personas reales.\n' +
        '  Cambia SUPABASE_URL y SUPABASE_ANON_KEY a las de staging.\n'
    );
  console.warn(
    '\n  ######################################################################\n' +
      '  ######  CORRIENDO CONTRA PRODUCCIÓN (CONFIRMO_PRODUCCION=si)  ########\n' +
      '  ######  Crea incidencias, fotos y avisos REALES. Ctrl+C YA si no  #####\n' +
      '  ######  es lo que quieres. Arranca en 10 segundos.              #####\n' +
      '  ######################################################################\n'
  );
  sleep(10);
}

function validarLlaveAnon() {
  if (/^sb_secret_/.test(ANON))
    exec.test.abort(
      'SUPABASE_ANON_KEY trae una llave SECRETA (sb_secret_…). k6 va con la anon/publishable: ' +
        'la secreta se salta la RLS y la prueba no mediría lo que vive un usuario.'
    );
  const p = payloadJwt(ANON);
  if (!p) return; // llave publishable nueva (sb_publishable_…): no trae payload
  if (p.role === 'service_role')
    exec.test.abort(
      'SUPABASE_ANON_KEY es la service_role. k6 va con la anon: la service_role ' +
        'se salta la RLS y la prueba no mediría lo que vive un usuario.'
    );
  const ref = refDeUrl(URL_BASE);
  if (p.ref && ref && p.ref !== ref)
    exec.test.abort(
      'La anon key es del proyecto "' + p.ref + '" pero SUPABASE_URL apunta a "' + ref + '".'
    );
}

// ── Estado de cada VU ────────────────────────────────────────
// Las variables de módulo son POR VU en k6: cada usuario virtual tiene la suya.
const estado = {
  usuario: null,
  sesion: null, // { token, refresh, expira }
  perfil: '', // 'incidencias' | 'pauta' | 'sin_roles' | 'otro'
  departamento: null,
  unidad: 'Ecovallas',
  capturar: false,
  yaCapturo: false,
  momentoCaptura: 0,
  proximaRecarga: 0,
  proximaVersion: 0,
  reintentarLogin: 0,
  notifsVistas: null, // { id: true } del tick anterior; null = aún no hay base
  columnasKpi: COLUMNAS_INDICADORES,
  rpcFotos: true,
};

// ── El ciclo de un usuario: una iteración = un minuto de campana ──

export default function (datos) {
  if (estado.usuario === null) {
    estado.usuario = USUARIOS[(__VU - 1) % USUARIOS.length];
    estado.rpcFotos = !datos || datos.rpcFotos !== false;
  }

  if (!estado.sesion) {
    if (Date.now() >= estado.reintentarLogin) entrar();
    if (!estado.sesion) {
      // Login fallido: se reintenta al minuto, sin martillar Auth.
      estado.reintentarLogin = Date.now() + INTERVALO_S * 1000;
      sleep(INTERVALO_S);
      return;
    }
  }

  const inicioTick = Date.now();
  renovarSiHaceFalta();
  if (!estado.sesion) {
    sleep(5);
    return;
  }
  if (!estado.perfil && !resolverPerfil()) {
    sleep(INTERVALO_S);
    return;
  }

  const aviso = campana();

  if (estado.perfil === 'incidencias') {
    if (aviso.hayNueva || Date.now() >= estado.proximaRecarga) {
      cargarLista(false);
      programarRecarga();
    }
    if (Math.random() < PROB_INDICADORES) {
      // Abrir Indicadores DESMONTA la bandeja; al volver, se remonta y recarga.
      cargarIndicadores();
      cargarLista(true);
      programarRecarga();
    }
    if (estado.capturar && !estado.yaCapturo && Date.now() >= estado.momentoCaptura) {
      estado.yaCapturo = true;
      capturar();
    }
  } else if (estado.perfil === 'pauta' && Date.now() >= estado.proximaRecarga) {
    cargarPauta();
    programarRecarga();
  }

  if (APP_URL && Date.now() >= estado.proximaVersion) {
    pedir('GET', APP_URL + '/version.json?_=' + Date.now(), null, {
      nombre: 'version_json',
      externo: true,
    });
    estado.proximaVersion = Date.now() + 15 * 60 * 1000;
  }

  // Completa el minuto: el siguiente tick de campana cae a los 60 s.
  const transcurrido = (Date.now() - inicioTick) / 1000;
  sleep(Math.max(1, INTERVALO_S - transcurrido));
}

function programarRecarga() {
  estado.proximaRecarga = Date.now() + RECARGA_MIN * 60 * 1000 * (0.8 + Math.random() * 0.4);
}

// ── Sesión ───────────────────────────────────────────────────

function login(u, nombre) {
  const r = pedir('POST', '/auth/v1/token?grant_type=password', {
    email: u.email,
    password: u.password,
  }, { nombre: nombre });
  if (r.status !== 200) {
    cLoginFallido.add(1);
    if (nombre === 'login' && r.status !== 429)
      console.warn('login de ' + u.email + ' → ' + r.status + ': ' + recorte(r.body));
    return null;
  }
  return sesionDe(r);
}

function sesionDe(r) {
  const j = jsonDe(r);
  if (!j || !j.access_token) return null;
  return {
    token: j.access_token,
    refresh: j.refresh_token,
    expira: Date.now() + (Number(j.expires_in) || 3600) * 1000,
  };
}

/** supabase-js renueva el token antes de que venza; la prueba también. */
function renovarSiHaceFalta() {
  const s = estado.sesion;
  if (Date.now() < s.expira - 120000) return;
  const r = pedir('POST', '/auth/v1/token?grant_type=refresh_token', {
    refresh_token: s.refresh,
  }, { nombre: 'refresh' });
  // Si no se pudo, al siguiente minuto vuelve a entrar desde cero.
  estado.sesion = r.status === 200 ? sesionDe(r) : null;
}

/** Solo el login: los roles y la primera carga los resuelve el tick. */
function entrar() {
  const s = login(estado.usuario, 'login');
  if (!s) return;
  estado.sesion = s;
  estado.perfil = '';
  estado.notifsVistas = null;
}

/**
 * usuario_roles, como App.tsx al entrar, y de ahí qué pantallas abre este
 * usuario. Devuelve false si la consulta falló (se reintenta al minuto).
 */
function resolverPerfil() {
  const u = estado.usuario;
  const r = pedir('GET',
    '/rest/v1/usuario_roles?select=rol,unidad_negocio,departamento&usuario_email=ilike.' +
      encodeURIComponent(u.email),
    null, { nombre: 'roles' });
  if (!exito(r)) return false;
  const roles = jsonDe(r) || [];
  const misRoles = [];
  roles.forEach(function (x) {
    if (x && x.rol && misRoles.indexOf(x.rol) === -1) misRoles.push(x.rol);
  });
  const primero = roles[0] || {};
  estado.departamento = primero.departamento || null;
  estado.unidad = primero.unidad_negocio || 'Ecovallas';

  if (!misRoles.length) {
    // La app le enseña "Falta darte acceso": solo esa pantalla.
    estado.perfil = 'sin_roles';
    cSinRoles.add(1);
    return true;
  }
  const todos = function (lista) {
    return misRoles.every(function (x) { return lista.indexOf(x) !== -1; });
  };
  if (todos(['monitorista'])) estado.perfil = 'pauta';
  // Comercial/pautas puros arrancan en la Bitácora VV: fuera de esta prueba.
  else if (todos(['comercial', 'pautas'])) estado.perfil = 'otro';
  else estado.perfil = 'incidencias';

  const reporta = misRoles.indexOf('reportante') !== -1 || misRoles.indexOf('manager') !== -1;
  estado.capturar = CAPTURA && u.captura && reporta && estado.perfil === 'incidencias';
  if (CAPTURA && u.captura && !estado.capturar) cCapturaOmitida.add(1);
  // La captura cae entre el minuto 1 y el 8 después de entrar: en la meseta.
  if (estado.capturar) estado.momentoCaptura = Date.now() + (60 + Math.random() * 420) * 1000;

  if (estado.perfil === 'incidencias') {
    if (INDICADORES_AL_ENTRAR) cargarIndicadores();
    cargarLista(true);
    programarRecarga();
  } else if (estado.perfil === 'pauta') {
    cargarPauta();
    programarRecarga();
  }
  return true;
}

// ── Campana (useNotificaciones.ts) ───────────────────────────

function campana() {
  const rs = lote([
    armar('GET',
      '/rest/v1/notificaciones?select=' + COLUMNAS_NOTIFS +
        '&leida=eq.false&order=creado_en.desc&limit=' + LIMITE_NOTIFS,
      null, { nombre: 'campana_notifs' }),
    armar('GET',
      '/rest/v1/notificaciones?select=record_id&evento=eq.chat&leida=eq.false&limit=' + LIMITE_CHATS,
      null, { nombre: 'campana_chats' }),
  ]);
  const aviso = { hayNueva: false };
  if (!exito(rs[0])) return aviso;
  const lista = jsonDe(rs[0]) || [];
  const actuales = {};
  lista.forEach(function (n) {
    actuales[n.id] = true;
    // Mismo criterio que App.tsx: aviso nuevo, no de chat y con incidencia.
    if (estado.notifsVistas && !estado.notifsVistas[n.id] && n.evento !== 'chat' && n.record_id)
      aviso.hayNueva = true;
  });
  estado.notifsVistas = actuales;

  if (lista.length && Math.random() < PROB_MARCAR_LEIDA)
    pedir('PATCH', '/rest/v1/notificaciones?id=eq.' + encodeURIComponent(lista[0].id),
      { leida: true }, { nombre: 'campana_marcar', headers: { Prefer: 'return=minimal' } });
  return aviso;
}

// ── Bandeja (IncidenciasView, patrón del primer mes) ─────────

/**
 * `montaje` = la vista se acaba de montar (al entrar o al volver de otra
 * pestaña): además de la lista pide sus SLA, como el useEffect de montaje.
 */
function cargarLista(montaje) {
  const pedidos = [
    armar('GET', RUTA_ABIERTAS + rango(0), null, { nombre: 'abiertas' }),
    // Historial sin fecha pedida: UNA página (las 1000 más recientes).
    armar('GET', RUTA_HISTORIAL + rango(0), null, { nombre: 'historial' }),
  ];
  if (montaje) {
    pedidos.push(armar('GET', '/rest/v1/sla_areas?select=area,sla_horas', null, { nombre: 'sla_areas' }));
    pedidos.push(armar('GET', '/rest/v1/sla_validacion?select=etapa,minutos', null, { nombre: 'sla_validacion' }));
  }
  const rs = lote(pedidos);
  // Con error la app conserva la lista anterior y no pide fotos.
  if (!exito(rs[0]) || !exito(rs[1])) return;

  let ids = idsDe(rs[0].body);
  let enPagina = ids.length;
  for (let n = 1; enPagina === PAGINA && n < TOPE_PAGINAS_ABIERTAS; n++) {
    const r = pedir('GET', RUTA_ABIERTAS + rango(n * PAGINA), null, { nombre: 'abiertas' });
    if (!exito(r)) return;
    const mas = idsDe(r.body);
    enPagina = mas.length;
    ids = ids.concat(mas);
  }
  const todos = unicos(ids.concat(idsDe(rs[1].body)));
  tFilasBandeja.add(todos.length);
  fotosYReasignaciones(todos);
}

/** Fotos de tarjeta (RPC en lotes de 400, 3 a la vez) + reasignaciones. */
function fotosYReasignaciones(ids) {
  const reas = armar('GET', RUTA_REASIGNACIONES, null, { nombre: 'reasignaciones' });
  if (!ids.length) {
    lote([reas]);
    return;
  }
  if (!estado.rpcFotos) {
    lote([reas, armar('GET', RUTA_FOTOS_RESPALDO, null, { nombre: 'fotos_respaldo' })]);
    return;
  }
  const lotes = trozos(ids, LOTE_FOTOS);
  for (let k = 0; k < lotes.length; k += FOTOS_EN_PARALELO) {
    const grupo = lotes.slice(k, k + FOTOS_EN_PARALELO).map(function (l) {
      return armar('POST', '/rest/v1/rpc/fotos_tarjetas', { p_ids: l }, { nombre: 'fotos_tarjetas' });
    });
    if (k === 0) grupo.push(reas); // viajan en paralelo, como el Promise.all
    const rs = lote(grupo);
    for (let i = 0; i < rs.length; i++) {
      if (rs[i].status === 404 && esFuncionFaltante(rs[i])) {
        // Igual que faltaRpcFotos en la app: se recuerda y se usa el respaldo.
        estado.rpcFotos = false;
        cRpcFaltante.add(1);
        lote([armar('GET', RUTA_FOTOS_RESPALDO, null, { nombre: 'fotos_respaldo' })]);
        return;
      }
    }
  }
}

// ── Indicadores (IndicadoresView, periodo por omisión: 90 días) ──

function cargarIndicadores() {
  const desde = inicioPeriodo90().toISOString();
  const rutaKpi = function () {
    return '/rest/v1/incidencias?select=' + estado.columnasKpi +
      '&fecha_reporte=gte.' + encodeURIComponent(desde) +
      '&order=fecha_reporte.desc,record_id.asc';
  };
  const rs = lote([
    armar('GET', rutaKpi() + rango(0), null, { nombre: 'kpi_incidencias' }),
    // Abiertas de ANTES del periodo: conteo sin filas (head + count=exact).
    armar('HEAD',
      '/rest/v1/incidencias?select=record_id&estatus=not.in.(cerrada,no_reparado)&or=' +
        encodeURIComponent('(fecha_reporte.lt."' + desde + '",fecha_reporte.is.null)'),
      null, { nombre: 'kpi_abiertas_antes', headers: { Prefer: 'count=exact' } }),
    // Configuración que la vista pide al montarse.
    armar('GET', '/rest/v1/sla_areas?select=area,sla_horas', null, { nombre: 'sla_areas' }),
    armar('GET', '/rest/v1/sla_validacion?select=etapa,minutos', null, { nombre: 'sla_validacion' }),
    armar('GET', '/rest/v1/tecnicos?select=nombre,email', null, { nombre: 'nombres_tecnicos' }),
    armar('GET', '/rest/v1/usuarios?select=nombre,email', null, { nombre: 'nombres_usuarios' }),
  ]);
  let r = rs[0];
  if (r.status === 400 && /42703/.test(r.body || '') && estado.columnasKpi !== '*') {
    // Una columna de la proyección no existe: la app cae a '*' y avisa.
    estado.columnasKpi = '*';
    cKpiColumnas.add(1);
    r = pedir('GET', rutaKpi() + rango(0), null, { nombre: 'kpi_incidencias' });
  }
  if (!exito(r)) return;
  let n = contar(r.body, /"record_id"\s*:/g);
  for (let p = 1; n === PAGINA && p < TOPE_PAGINAS_KPI; p++) {
    const rp = pedir('GET', rutaKpi() + rango(p * PAGINA), null, { nombre: 'kpi_incidencias' });
    if (!exito(rp)) return;
    n = contar(rp.body, /"record_id"\s*:/g);
  }
}

/** 00:00 local de hace 89 días: "últimos 90 días" contando hoy (IndicadoresView). */
function inicioPeriodo90() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 89);
  return d;
}

// ── Pauta (monitorista puro) ─────────────────────────────────

function cargarPauta() {
  const rs = lote([
    armar('GET', '/rest/v1/ruta_asignaciones?select=id,ruta_id,usuario_email', null, { nombre: 'pauta_asignaciones' }),
    armar('GET', '/rest/v1/pautas?select=catorcena&order=catorcena.desc', null, { nombre: 'pauta_catorcenas' }),
  ]);
  if (!exito(rs[1])) return;
  const m = /"catorcena"\s*:\s*(\d+)/.exec(rs[1].body || '');
  if (!m) return; // staging sin pautas importadas: no hay más que pedir
  let n = PAGINA;
  for (let p = 0; n === PAGINA && p < TOPE_PAGINAS_PAUTA; p++) {
    const r = pedir('GET',
      '/rest/v1/vw_pauta_ruta?select=*&catorcena=eq.' + m[1] +
        '&order=ruta_numero.asc.nullslast,secuencia.asc' + rango(p * PAGINA),
      null, { nombre: 'pauta_ruta' });
    if (!exito(r)) return;
    n = contar(r.body, /"vendor_face_id"\s*:/g);
  }
}

// ── Captura de un reporte de prueba (lib/crearReporte.ts) ────

function capturar() {
  const u = estado.usuario;
  const rid = idCorto();
  const cara = 'PRUEBA-CARGA-VU' + __VU;
  const ahora = new Date();
  const fila = {
    record_id: rid,
    estatus: 'por_validar',
    requiere_prevalidacion: false,
    captured_by: u.email,
    area_reportante: estado.departamento || 'Monitoreo',
    fecha_reporte: ahora.toISOString(),
    unidad_negocio: estado.unidad,
    clave_sitio: 'PRUEBA-CARGA',
    clave_medio: cara,
    medio: 'Impreso',
    tipo_medio: 'Impreso',
    nombre_incidencia: NOMBRE_INCIDENCIA_PRUEBA,
    area_responsable: 'Mantenimiento',
    nivel: 'Bajo',
    observaciones:
      MARCA + ' · k6 — no atender. VU ' + __VU + ', ' + ahora.toISOString() +
      '. Se borra con: node scripts/usuarios-carga.mjs borrar',
  };

  // 1) Regla de duplicidad (duplicados.ts): en_proceso con la misma cara e incidencia.
  pedir('GET',
    '/rest/v1/incidencias?select=folio,nombre_incidencia,clave_medio,unidad_negocio,medio' +
      '&estatus=eq.en_proceso&clave_medio=' + encodeURIComponent(enLista([cara])) +
      '&nombre_incidencia=' + encodeURIComponent(enLista([NOMBRE_INCIDENCIA_PRUEBA])),
    null, { nombre: 'captura_duplicados' });

  // 2) Insert con .select(): hay que CONTAR lo que regresa (RLS silenciosa).
  const ri = pedir('POST', '/rest/v1/incidencias?select=*', [fila], {
    nombre: 'captura_incidencia',
    headers: { Prefer: 'return=representation' },
  });
  if (!exito(ri)) {
    cCapturaFallida.add(1);
    console.warn('captura de ' + u.email + ' → ' + ri.status + ': ' + recorte(ri.body));
    return;
  }
  const devueltas = contar(ri.body, /"record_id"\s*:/g);
  check(ri, {
    'captura: la base devuelve la fila creada (sin RLS silenciosa)': function () {
      return devueltas === 1;
    },
  });
  if (devueltas !== 1) cCapturaRls.add(1);

  // 3) Foto + miniatura. La app sube multipart desde un File; aquí va el
  // binario directo (la otra vía que acepta Storage): la carga es la misma.
  const fecha = ahora.toISOString().slice(0, 10);
  const path = (rid + '/PRUEBA-CARGA_' + cara + '_' + fecha + '_reporte_' + Date.now() + '.png')
    .replace(/[^\w/.\-]/g, '_');
  const cabeceras = { 'Content-Type': 'image/png', 'cache-control': 'max-age=31536000', 'x-upsert': 'false' };
  const rs = pedir('POST', '/storage/v1/object/evidencias/' + path, pngPrueba(IMG_LADO, __VU), {
    nombre: 'captura_subida',
    headers: cabeceras,
  });
  if (!exito(rs)) {
    cCapturaFallida.add(1);
    console.warn('subida de ' + u.email + ' → ' + rs.status + ': ' + recorte(rs.body));
    return;
  }
  // La miniatura va en …/mini/….jpg como rutaMiniatura() de storage.ts. La
  // app la genera JPEG en el navegador; aquí es un PNG chico con el mismo
  // nombre (el borrado la encuentra por esa misma regla).
  pedir('POST', '/storage/v1/object/evidencias/' + rutaMiniatura(path),
    pngPrueba(Math.max(16, Math.round(IMG_LADO / 3)), __VU), {
      nombre: 'captura_subida_mini',
      headers: cabeceras,
    });

  // 4) La fila de evidencia (la app no le pide .select()).
  const re = pedir('POST', '/rest/v1/evidencias', [{
    record_id: rid,
    etapa: 'reporte',
    tipo: 'foto',
    url: URL_BASE + '/storage/v1/object/public/evidencias/' + path,
    path: path,
    subido_por: u.email,
    referencia: cara,
  }], { nombre: 'captura_evidencia', headers: { Prefer: 'return=minimal' } });
  if (exito(re)) cCapturaOk.add(1);
  else {
    cCapturaFallida.add(1);
    console.warn('evidencia de ' + u.email + ' → ' + re.status + ': ' + recorte(re.body));
  }
}

/** `abc/EV1_x_123.png` → `abc/mini/EV1_x_123.jpg` (misma regla que storage.ts). */
function rutaMiniatura(path) {
  const i = path.lastIndexOf('/');
  const dir = i >= 0 ? path.slice(0, i + 1) : '';
  const nombre = (i >= 0 ? path.slice(i + 1) : path).replace(/\.[^.]+$/, '');
  return dir + 'mini/' + nombre + '.jpg';
}

/** 8 hex, como idCorto() de helpers.ts. */
function idCorto() {
  let s = '';
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// ── Imagen de prueba: PNG generado aquí mismo, sin archivos ──
// RGB de 8 bits con compresión "stored" (sin comprimir): el tamaño es
// predecible (~3 bytes por píxel) y no hace falta ninguna librería.

const TABLA_CRC = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, desde, hasta) {
  let c = 0xffffffff;
  for (let i = desde; i < hasta; i++) c = TABLA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function escribir32(buf, pos, v) {
  buf[pos] = (v >>> 24) & 255;
  buf[pos + 1] = (v >>> 16) & 255;
  buf[pos + 2] = (v >>> 8) & 255;
  buf[pos + 3] = v & 255;
}

function trozoPng(tipo, datos) {
  const out = new Uint8Array(12 + datos.length);
  escribir32(out, 0, datos.length);
  for (let i = 0; i < 4; i++) out[4 + i] = tipo.charCodeAt(i);
  out.set(datos, 8);
  escribir32(out, 8 + datos.length, crc32(out, 4, 8 + datos.length));
  return out;
}

function pngPrueba(lado, semilla) {
  const fila = 1 + lado * 3;
  const crudo = new Uint8Array(fila * lado);
  const r0 = (semilla * 53) % 256;
  const g0 = (semilla * 97) % 256;
  const b0 = (semilla * 193) % 256;
  for (let y = 0; y < lado; y++) {
    const o = y * fila; // crudo[o] = 0: filtro "None"
    for (let x = 0; x < lado; x++) {
      const p = o + 1 + x * 3;
      const franja = ((x + y) >> 4) % 2 === 0; // franjas diagonales
      crudo[p] = franja ? r0 : 255 - r0;
      crudo[p + 1] = (g0 + x) & 255;
      crudo[p + 2] = (b0 + y) & 255;
    }
  }
  // zlib con bloques "stored" de hasta 65535 bytes + adler32.
  const MAX = 65535;
  const bloques = Math.max(1, Math.ceil(crudo.length / MAX));
  const z = new Uint8Array(2 + crudo.length + bloques * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let p = 2;
  for (let b = 0; b < bloques; b++) {
    const ini = b * MAX;
    const len = Math.min(MAX, crudo.length - ini);
    z[p++] = b === bloques - 1 ? 1 : 0;
    z[p++] = len & 255;
    z[p++] = (len >>> 8) & 255;
    z[p++] = ~len & 255;
    z[p++] = (~len >>> 8) & 255;
    z.set(crudo.subarray(ini, ini + len), p);
    p += len;
  }
  let a = 1;
  let c = 0;
  for (let i = 0; i < crudo.length; i++) {
    a = (a + crudo[i]) % 65521;
    c = (c + a) % 65521;
  }
  escribir32(z, p, ((c << 16) | a) >>> 0);

  const ihdr = new Uint8Array(13);
  escribir32(ihdr, 0, lado);
  escribir32(ihdr, 4, lado);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // RGB
  const partes = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    trozoPng('IHDR', ihdr),
    trozoPng('IDAT', z),
    trozoPng('IEND', new Uint8Array(0)),
  ];
  let total = 0;
  partes.forEach(function (x) { total += x.length; });
  const out = new Uint8Array(total);
  let q = 0;
  partes.forEach(function (x) {
    out.set(x, q);
    q += x.length;
  });
  return out.buffer;
}

// ── Peticiones: una sola puerta, con etiquetas y métricas ────

/**
 * Arma una petición para http.request o http.batch.
 *   op.nombre     endpoint (tags.nombre + su tipo de ENDPOINTS)
 *   op.token      JWT del usuario (por omisión, el de la sesión del VU)
 *   op.headers    cabeceras extra
 *   op.esperados  estados que NO cuentan como falla (por omisión 2xx/3xx)
 *   op.externo    no es Supabase: sin apikey
 */
function armar(metodo, ruta, cuerpo, op) {
  const url = /^https?:\/\//.test(ruta) ? ruta : URL_BASE + ruta;
  const headers = {};
  if (!op.externo) {
    headers.apikey = ANON;
    headers['X-Client-Info'] = CLIENTE;
    const token = op.token || (estado.sesion ? estado.sesion.token : '');
    headers.Authorization = 'Bearer ' + (token || ANON);
  }
  let body = null;
  if (cuerpo instanceof ArrayBuffer) body = cuerpo;
  else if (cuerpo !== null && cuerpo !== undefined) {
    body = JSON.stringify(cuerpo);
    headers['Content-Type'] = 'application/json';
  }
  const extra = op.headers || {};
  Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
  const params = {
    headers: headers,
    tags: { nombre: op.nombre, tipo: ENDPOINTS[op.nombre] || 'otro' },
    timeout: '60s',
  };
  if (op.esperados) params.responseCallback = http.expectedStatuses.apply(null, op.esperados);
  return { method: metodo, url: url, body: body, params: params, op: op };
}

function pedir(metodo, ruta, cuerpo, op) {
  const p = armar(metodo, ruta, cuerpo, op);
  const r = http.request(p.method, p.url, p.body, p.params);
  registrar(r, op);
  return r;
}

/** Varias a la vez, como un Promise.all del navegador. */
function lote(peticiones) {
  const rs = http.batch(peticiones.map(function (p) {
    return { method: p.method, url: p.url, body: p.body, params: p.params };
  }));
  rs.forEach(function (r, i) { registrar(r, peticiones[i].op); });
  return rs;
}

function registrar(r, op) {
  const ok = op.esperados ? op.esperados.indexOf(r.status) !== -1 : exito(r);
  const m = METRICAS[op.nombre];
  if (m) {
    m.tiempo.add(r.timings.duration);
    m.fallas.add(!ok);
  }
  if (r.status === 0) cSinRed.add(1);
  else if (r.status === 401) cHttp401.add(1);
  else if (r.status === 403) cHttp403.add(1);
  else if (r.status === 429) cHttp429.add(1);
  else if (r.status >= 500) cHttp5xx.add(1);
  const nombreCheck = op.nombre + ': responde bien';
  const chequeo = {};
  chequeo[nombreCheck] = function () { return ok; };
  check(r, chequeo, { nombre: op.nombre });
}

/** postgrest-js no lanza: status 0 = sin red; >= 400 = error. */
function exito(r) {
  return r.status >= 200 && r.status < 400;
}

function esFuncionFaltante(r) {
  const b = String(r.body || '');
  return b.indexOf('PGRST202') !== -1 || /could not find the function/i.test(b);
}

function jsonDe(r) {
  try {
    return JSON.parse(r.body);
  } catch (e) {
    return null;
  }
}

/**
 * record_id de una respuesta de lista SIN JSON.parse: con 1000 filas de
 * select=* por página, parsear en el motor de k6 le cuesta CPU a la máquina
 * que genera la carga y eso atrasa las peticiones de los demás VUs.
 */
function idsDe(body) {
  const ids = [];
  const re = /"record_id"\s*:\s*"([^"]*)"/g;
  const texto = String(body || '');
  let m = re.exec(texto);
  while (m) {
    ids.push(m[1]);
    m = re.exec(texto);
  }
  return ids;
}

function contar(body, re) {
  const m = String(body || '').match(re);
  return m ? m.length : 0;
}

/** Filtro `in.(…)` de PostgREST con valores entre comillas (correos con + y @). */
function enLista(valores) {
  return 'in.(' + valores.map(function (v) {
    return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }).join(',') + ')';
}

function rango(desde) {
  return '&offset=' + desde + '&limit=' + PAGINA;
}

function trozos(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function unicos(arr) {
  const visto = {};
  return arr.filter(function (x) {
    if (visto[x]) return false;
    visto[x] = true;
    return true;
  });
}

function recorte(t) {
  return String(t || '').slice(0, 200);
}

function entero(v, porOmision) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : porOmision;
}

function numero(v, porOmision) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : porOmision;
}

// ── Resumen al terminar: umbrales, tabla por endpoint y avisos ──

export function handleSummary(data) {
  const M = data.metrics || {};
  const L = [];
  const valor = function (nombre, campo) {
    return M[nombre] && M[nombre].values ? M[nombre].values[campo] : undefined;
  };

  L.push('');
  L.push('══ Prueba de carga · ' + (URL_BASE || '(sin URL)') + ' ══');
  L.push('VUs máx: ' + (valor('vus_max', 'max') || 0) +
    ' · peticiones: ' + (valor('http_reqs', 'count') || 0) +
    ' (' + fmtNum(valor('http_reqs', 'rate')) + '/s)' +
    ' · recibido: ' + fmtBytes(valor('data_received', 'count')) +
    ' · duración: ' + fmtMs(data.state ? data.state.testRunDurationMs : 0));
  L.push('');
  L.push('UMBRALES');
  Object.keys(M).sort().forEach(function (nombre) {
    const th = M[nombre].thresholds;
    if (!th) return;
    Object.keys(th).forEach(function (expr) {
      const m = /^(p\(\d+(?:\.\d+)?\)|rate|avg|med|max|count)/.exec(expr);
      const v = m ? valor(nombre, m[1]) : undefined;
      const txt = M[nombre].type === 'rate' ? fmtPct(v) : fmtMs(v);
      L.push('  ' + (th[expr].ok ? 'OK   ' : 'FALLA') + '  ' + pad(nombre, 34) + pad(expr, 14) + 'valor: ' + txt);
    });
  });

  L.push('');
  L.push('POR ENDPOINT' + ' '.repeat(24) + pad('n', 8) + pad('p50', 10) + pad('p95', 10) + pad('max', 10) + 'fallas');
  Object.keys(ENDPOINTS).forEach(function (n) {
    const t = M['t_' + n];
    if (!t || !t.values || !t.values.count) return;
    const f = M['f_' + n];
    L.push('  ' + pad(n + ' (' + ENDPOINTS[n] + ')', 34) +
      pad(String(t.values.count), 8) + pad(fmtMs(t.values.med), 10) +
      pad(fmtMs(t.values['p(95)']), 10) + pad(fmtMs(t.values.max), 10) +
      fmtPct(f && f.values ? f.values.rate : 0));
  });

  const cuenta = function (n) { return valor(n, 'count') || 0; };
  L.push('');
  L.push('CONTADORES   401: ' + cuenta('http_401') + ' · 403: ' + cuenta('http_403') +
    ' · 429: ' + cuenta('http_429') + ' · 5xx: ' + cuenta('http_5xx') +
    ' · sin red: ' + cuenta('sin_red') + ' · logins fallidos: ' + cuenta('login_fallido'));
  L.push('CAPTURAS     ok: ' + cuenta('captura_ok') + ' · fallidas: ' + cuenta('captura_fallida') +
    ' · RLS silenciosa: ' + cuenta('captura_rls_silenciosa') + ' · omitidas: ' + cuenta('captura_omitida'));
  const filas = M.filas_bandeja && M.filas_bandeja.values;
  if (filas) L.push('BANDEJA      filas por usuario: mediana ' + Math.round(filas.med) + ', máx ' + Math.round(filas.max));

  const avisos = [];
  if (cuenta('fotos_rpc_faltante') || cuenta('t_fotos_respaldo'))
    avisos.push('Se usó el RESPALDO de fotos (la RPC fotos_tarjetas no existe en este proyecto): aplica su SQL en staging y repite.');
  if (filas && filas.max === 0)
    avisos.push('Todas las bandejas vinieron VACÍAS: staging no tiene incidencias (siembra de la guía §5.2) o la RLS no deja ver nada. Así la prueba no mide la carga real.');
  if (cuenta('sesiones_sin_roles'))
    avisos.push(cuenta('sesiones_sin_roles') + ' sesiones sin roles: vuelve a correr `node scripts/usuarios-carga.mjs crear`.');
  if (cuenta('http_429'))
    avisos.push('Hubo 429 (límite de peticiones). Si son de login: sube el límite de Auth por IP en STAGING (guía §5.2).');
  if (cuenta('kpi_columnas_faltantes'))
    avisos.push('Falta alguna columna de la proyección de Indicadores: se cayó a select=*.');
  if (cuenta('captura_rls_silenciosa'))
    avisos.push('Hubo capturas que la base aceptó pero no devolvió (RLS silenciosa): revisa la política SELECT del reportante.');
  if (avisos.length) {
    L.push('');
    L.push('AVISOS');
    avisos.forEach(function (a) { L.push('  • ' + a); });
  }
  L.push('');
  L.push('Limpieza: node scripts/usuarios-carga.mjs borrar');
  L.push('');

  const salida = { stdout: L.join('\n') };
  if (__ENV.RESULTADO_JSON) salida[__ENV.RESULTADO_JSON] = JSON.stringify(data, null, 2);
  return salida;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}

function fmtMs(v) {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  if (v < 1000) return Math.round(v) + ' ms';
  if (v < 120000) return (v / 1000).toFixed(2) + ' s';
  return (v / 60000).toFixed(1) + ' min';
}

function fmtPct(v) {
  return v === undefined || v === null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(2) + ' %';
}

function fmtNum(v) {
  return v === undefined || v === null || !Number.isFinite(v) ? '—' : v.toFixed(1);
}

function fmtBytes(v) {
  if (!v) return '0 MB';
  return (v / 1048576).toFixed(1) + ' MB';
}
