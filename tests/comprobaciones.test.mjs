// Núcleo de Comprobaciones (fase 2, 23-oct-2026): llave de texto, meta, %,
// semáforo, días para marcar, tabla diaria y carga por analista.
// Repo PÚBLICO: los nombres son inventados; solo se copia la FORMA de los
// textos reales (acentos, espacios duros de Excel, claves con _ y ceros).
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/comprobaciones.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const C = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);
const {
  UNIDADES_COMP,
  ETIQUETA_UNIDAD_COMP,
  MEDIOS_DE_UNIDAD,
  esUnidadComp,
  llaveComp,
  metaDe,
  pctAvance,
  esCompleta,
  semaforoLimite,
  hoyCdmx,
  diasParaMarcar,
  pivotDiaria,
  cargaPorAnalista,
  CLAVE_SIN_REGISTRO,
  ETIQUETA_SIN_REGISTRO,
} = C;

// ------------------------------------------------------------
// Llave: tabla FIJA. La migración (comp_llave) verifica EXACTAMENTE esta
// misma tabla en Postgres; si se cambia aquí, se cambia allá.
// ------------------------------------------------------------
const LLAVES_ESPERADAS = [
  ['Campaña Ñandú', 'CAMPANANANDU'],
  ['Televisión_Azul / V2', 'TELEVISIONAZULV2'],
  ['  mx_cm_vv_col_448  ', 'MXCMVVCOL448'],
  ['MX_CM_EV_MGP_16_3606   ', 'MXCMEVMGP163606'], // espacio duro de Excel
  ['Pingüino Dulce-V3.1', 'PINGUINODULCEV31'],
  ['ÁÉÍÓÚ áéíóú', 'AEIOUAEIOU'],
  ['Müller ÜBER', 'MULLERUBER'],
  ['Straße', 'STRAE'], // ß se quita: JS la haría 'SS' si se subiera antes
  ['Iıİ', 'I'], // ı e İ se quitan: toUpperCase('ı') sería 'I'
  ['Café à la crème', 'CAFELACRME'], // à y è no están en el translate
  ['tab\tsalto\nfin', 'TABSALTOFIN'],
  ['', ''],
  ['POR_00015', 'POR00015'],
  ['Versión (Inicial) #2 — 50%', 'VERSIONINICIAL250'],
  ['árbol', 'ARBOL'], // acento combinado (NFD): no se normaliza, se quita
  ['Fiesta \u{1F389} 2026', 'FIESTA2026'],
  ['ESPECIAL.FULL/19:00-19:50', 'ESPECIALFULL19001950'],
  ['ｆｕｌｌ１２', ''], // letras y dígitos de ancho completo
  ['Señor Ñoño ñ', 'SENORNONON'],
  ["O'Brien + Hijos, S.A. de C.V.", 'OBRIENHIJOSSADECV'],
];

test('la tabla fija tiene 20 textos distintos', () => {
  assert.equal(LLAVES_ESPERADAS.length, 20);
  assert.equal(new Set(LLAVES_ESPERADAS.map(([t]) => t)).size, 20);
});

test('llaveComp da la llave esperada en los 20 textos', () => {
  for (const [texto, esperada] of LLAVES_ESPERADAS) {
    assert.equal(llaveComp(texto), esperada, JSON.stringify(texto));
  }
});

test('llaveComp: solo [A-Z0-9], nulos y números', () => {
  assert.equal(llaveComp(null), '');
  assert.equal(llaveComp(undefined), '');
  assert.equal(llaveComp(448), '448');
  for (const [texto] of LLAVES_ESPERADAS) assert.match(llaveComp(texto), /^[A-Z0-9]*$/);
  // Lo que en Excel se escribe distinto cae en la misma llave.
  assert.equal(llaveComp('Televisa_LCDF4'), llaveComp('televisa lcdf 4'));
  assert.equal(llaveComp('VÍA VERDE'), llaveComp('via-verde'));
});

test('llaveComp de una fecha no depende de la zona de la computadora', () => {
  // String(Date) cambia con la zona; la llave es el día UTC AAAAMMDD.
  assert.equal(llaveComp(new Date('2026-08-01T00:00:00Z')), '20260801');
  assert.equal(llaveComp(new Date('no es fecha')), '');
});

// ------------------------------------------------------------
// Constantes
// ------------------------------------------------------------
test('unidades, etiqueta y medios', () => {
  assert.deepEqual([...UNIDADES_COMP], ['Ecovallas', 'Biobox', 'Vía Verde']);
  assert.equal(ETIQUETA_UNIDAD_COMP.Ecovallas, 'Ecovallas Digital');
  assert.equal(ETIQUETA_UNIDAD_COMP['Vía Verde'], 'Vía Verde');
  assert.deepEqual(MEDIOS_DE_UNIDAD.Ecovallas, ['Pantalla']);
  assert.deepEqual(MEDIOS_DE_UNIDAD.Biobox, ['Máquina']);
  assert.deepEqual(MEDIOS_DE_UNIDAD['Vía Verde'], ['Columna', 'Pórtico']);
  assert.equal(esUnidadComp('Vía Verde'), true);
  assert.equal(esUnidadComp('Via Verde'), false);
  assert.equal(esUnidadComp('Biobox Perú'), false);
});

// ------------------------------------------------------------
// Meta y %
// ------------------------------------------------------------
test('metaDe: meta_app gana sobre todo', () => {
  assert.equal(metaDe({ meta_app: 9, es_full: true, meta_full: 15, sitios_activos: 30 }), 9);
  // 0 es dato (el Supervisor la puso en 0), no "falta".
  assert.equal(metaDe({ meta_app: 0, sitios_activos: 20 }), 0);
});

test('metaDe: FULL usa meta_full; sin FULL se ignora', () => {
  assert.equal(metaDe({ es_full: true, meta_full: 15, sitios_activos: 0 }), 15);
  assert.equal(metaDe({ es_full: false, meta_full: 15, sitios_activos: 20 }), 20);
  // FULL sin meta propuesta cae a los sitios agregados.
  assert.equal(metaDe({ es_full: true, meta_full: null, sitios_activos: 4 }), 4);
});

test('metaDe es espejo exacto de la vista: coalesce(meta_app, meta_full si FULL, sitios_activos)', () => {
  // Revisión del núcleo (23-oct-2026): la vista ya no tiene «venta − cancelados».
  // Una venta que llegue en la fila se ignora: sitios_activos ya descuenta
  // los cancelados.
  assert.equal(metaDe({ venta: 17, cancelados: 2, sitios_activos: 12 }), 12);
  assert.equal(metaDe({ venta: 17 }), 0);
  assert.equal(metaDe({}), 0);
  assert.equal(metaDe({ sitios_activos: '12' }), 12); // texto de PostgREST
});

test('metaDe: un texto en blanco es "no hay", no 0', () => {
  // Number(' ') === 0: una meta_app en blanco tapaba a los sitios.
  assert.equal(metaDe({ meta_app: ' ', sitios_activos: 10 }), 10);
  assert.equal(metaDe({ meta_app: '', sitios_activos: '7' }), 7);
  assert.equal(metaDe({ es_full: true, meta_full: '\t', sitios_activos: 3 }), 3);
  assert.equal(pctAvance(' ', 4), 0);
});

test('pctAvance con un decimal; sin meta no hay %', () => {
  assert.equal(pctAvance(1, 8), 12.5);
  assert.equal(pctAvance(1, 3), 33.3);
  assert.equal(pctAvance(2, 3), 66.7);
  assert.equal(pctAvance(17, 17), 100);
  assert.equal(pctAvance(18, 17), 105.9);
  assert.equal(pctAvance(0, 5), 0);
  assert.equal(pctAvance(3, 0), null);
});

test('esCompleta = llegó a la meta (y la meta es mayor a 0)', () => {
  assert.equal(esCompleta(15, 15), true);
  assert.equal(esCompleta(16, 15), true);
  assert.equal(esCompleta(14, 15), false);
  assert.equal(esCompleta(0, 0), false);
});

test('semaforoLimite: verde si completa, rojo vencida, ámbar ≤2, gris lo demás', () => {
  assert.equal(semaforoLimite(-1, true, 'abierta'), 'verde');
  assert.equal(semaforoLimite(-1, false, 'abierta'), 'rojo');
  assert.equal(semaforoLimite(0, false, 'abierta'), 'ambar');
  assert.equal(semaforoLimite(2, false, 'abierta'), 'ambar');
  assert.equal(semaforoLimite(3, false, 'abierta'), 'gris');
  assert.equal(semaforoLimite(null, false, 'abierta'), 'gris');
  // Sin estatus (null/undefined) se trata como abierta.
  assert.equal(semaforoLimite(-1, false, undefined), 'rojo');
  assert.equal(semaforoLimite(1, false, null), 'ambar');
});

test('semaforoLimite: una campaña cerrada ya no corre contra la fecha', () => {
  // Cerrada abajo de la meta con motivo (P1): gris, no rojo para siempre;
  // así cuadra con «vencidas», que solo cuenta las abiertas.
  assert.equal(semaforoLimite(-2, false, 'cerrada'), 'gris');
  assert.equal(semaforoLimite(1, false, 'cerrada'), 'gris');
  assert.equal(semaforoLimite(-2, true, 'cerrada'), 'verde');
});

// ------------------------------------------------------------
// Días
// ------------------------------------------------------------
test('hoyCdmx usa la hora de México, no la UTC', () => {
  // 01:30 UTC del 24-oct = 19:30 del 23-oct en CDMX.
  assert.equal(hoyCdmx(new Date('2026-10-24T01:30:00Z')), '2026-10-23');
  assert.equal(hoyCdmx(new Date('2026-10-24T06:30:00Z')), '2026-10-24');
  assert.match(hoyCdmx(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(hoyCdmx(new Date('no es fecha')), '');
});

test('diasParaMarcar: hoy y 7 atrás, nunca antes del inicio del periodo', () => {
  const d = diasParaMarcar('2026-10-23', '2026-10-01');
  assert.equal(d.length, 8);
  assert.equal(d[0], '2026-10-23');
  assert.equal(d[7], '2026-10-16');
  assert.deepEqual(diasParaMarcar('2026-10-03', '2026-10-01'), ['2026-10-03', '2026-10-02', '2026-10-01']);
  // Cruza el mes.
  assert.equal(diasParaMarcar('2026-11-02', null)[7], '2026-10-26');
  // El periodo no ha empezado.
  assert.deepEqual(diasParaMarcar('2026-10-23', '2026-10-24'), []);
});

test('diasParaMarcar con entradas de la vida real', () => {
  // hoyCdmx da '' con una fecha inválida: lista vacía, no RangeError.
  assert.deepEqual(diasParaMarcar(''), []);
  assert.deepEqual(diasParaMarcar('23/10/2026', '2026-10-01'), []);
  assert.deepEqual(diasParaMarcar(null), []);
  // El inicio con hora no deja fuera el primer día del periodo.
  assert.deepEqual(diasParaMarcar('2026-10-22', '2026-10-20T00:00:00'), [
    '2026-10-22',
    '2026-10-21',
    '2026-10-20',
  ]);
  assert.deepEqual(diasParaMarcar('2026-10-22T08:00:00', '2026-10-21'), ['2026-10-22', '2026-10-21']);
});

// ------------------------------------------------------------
// Tabla diaria
// ------------------------------------------------------------
const DIAS = ['2026-08-01', '2026-08-02', '2026-08-03'];
const DIARIA = [
  { campana_id: 1, analista_email: 'b@x.mx', comprobado_por: 'a@x.mx', dia: '2026-08-01', sitios: 5 },
  { campana_id: 1, analista_email: 'b@x.mx', comprobado_por: 'B@x.mx', dia: '2026-08-03', sitios: 2 },
  { campana_id: 2, analista_email: 'b@x.mx', comprobado_por: 'b@x.mx', dia: '2026-08-03', sitios: 4 },
  { campana_id: 2, analista_email: 'b@x.mx', comprobado_por: 'b@x.mx', dia: '2026-08-09', sitios: 1 },
];

test('pivotDiaria por campaña: un día sin marcas vale 0', () => {
  const r = pivotDiaria(DIARIA, DIAS, 'campana');
  assert.deepEqual(
    r.map((x) => x.clave),
    ['1', '2']
  );
  assert.deepEqual(r[0].porDia, { '2026-08-01': 5, '2026-08-02': 0, '2026-08-03': 2 });
  assert.equal(r[0].total, 7);
  // El día 9 no está en la lista: va a "fuera", no al total.
  assert.equal(r[1].total, 4);
  assert.equal(r[1].fuera, 1);
});

test('pivotDiaria por analista: el crédito es de quien marcó, no de quien lleva la campaña', () => {
  const r = pivotDiaria(DIARIA, DIAS, 'analista');
  const a = r.find((x) => x.clave === 'a@x.mx');
  const b = r.find((x) => x.clave === 'b@x.mx');
  // A comprobó 5 de la campaña 1, que hoy lleva B (se la pasaron).
  assert.equal(a.total, 5);
  assert.equal(b.total, 6); // 2 (correo en mayúsculas, mismo) + 4
  assert.equal(r.length, 2);
});

test('pivotDiaria por analista: las marcas sin autor van a «(sin registro)», al final', () => {
  const filas = [
    ...DIARIA,
    { campana_id: 3, analista_email: 'a@x.mx', comprobado_por: null, dia: '2026-08-02', sitios: 40 },
    { campana_id: 3, analista_email: 'a@x.mx', comprobado_por: '  ', dia: '2026-08-02', sitios: 1 },
  ];
  const r = pivotDiaria(filas, DIAS, 'analista');
  const ultimo = r[r.length - 1];
  assert.equal(ultimo.clave, CLAVE_SIN_REGISTRO);
  assert.equal(ETIQUETA_SIN_REGISTRO, '(sin registro)');
  assert.equal(ultimo.total, 41); // aunque sea el mayor, va al final
  // Las dos hojas suman lo mismo (total + fuera).
  const suma = (rs) => rs.reduce((t, x) => t + x.total + x.fuera, 0);
  assert.equal(suma(r), suma(pivotDiaria(filas, DIAS, 'campana')));
});

test('pivotDiaria sin filas', () => {
  assert.deepEqual(pivotDiaria([], DIAS, 'analista'), []);
});

// ------------------------------------------------------------
// Carga por analista
// ------------------------------------------------------------
const camp = (id, analista_email, o = {}) => ({
  id,
  unidad: 'Vía Verde',
  medio: 'Columna',
  periodo_id: 1,
  campana: 'C' + id,
  version: '',
  analista_email,
  estatus: 'abierta',
  comprobados: 0,
  pendientes: 0,
  ...o,
});

test('cargaPorAnalista: la carga va por analista_email y el crédito por comprobado_por', () => {
  const campanas = [
    // Campaña 1: era de A, se la pasaron a B; A ya había comprobado 5.
    camp(1, 'b@x.mx', { venta: 10, comprobados: 7, pendientes: 3, meta: 10 }),
    camp(2, 'B@x.mx', { sitios_activos: 5, comprobados: 4, pendientes: 1 }), // sin meta: se calcula
    camp(3, null, { venta: 8, pendientes: 8, meta: 8 }),
    camp(4, 'c@x.mx', { venta: 4, comprobados: 4, estatus: 'cerrada', meta: 4 }),
  ];
  const creditos = [
    { comprobado_por: 'a@x.mx', dia: '2026-08-01', sitios: 5 },
    { comprobado_por: 'b@x.mx', dia: '2026-08-03', sitios: 2 },
    { comprobado_por: 'b@x.mx', dia: '2026-08-03', sitios: 4 },
    { comprobado_por: 'c@x.mx', dia: '2026-08-02', sitios: 4 },
  ];
  const r = cargaPorAnalista(campanas, creditos, '2026-08-03');
  const de = (e) => r.find((x) => x.email === e);

  const b = de('b@x.mx');
  assert.equal(b.campanas, 2);
  assert.equal(b.meta, 15);
  assert.equal(b.pendientes, 4);
  assert.equal(b.comprobadosCarga, 11);
  assert.equal(b.pct, 73.3);
  assert.equal(b.comprobados, 6); // solo lo que B marcó
  assert.equal(b.hoy, 6);

  const a = de('a@x.mx');
  assert.equal(a.campanas, 0); // ya no lleva nada…
  assert.equal(a.comprobados, 5); // …pero su crédito no se movió
  assert.equal(a.pct, null);

  const c = de('c@x.mx');
  assert.equal(c.abiertas, 0);
  assert.equal(c.pct, 100);

  // "Sin analista" al final; nunca recibe crédito.
  assert.equal(r[r.length - 1].email, null);
  assert.equal(r[r.length - 1].campanas, 1);
  assert.equal(r[r.length - 1].comprobados, 0);
  // Primero quien tiene más campañas abiertas.
  assert.equal(r[0].email, 'b@x.mx');
});

test('cargaPorAnalista: pendientes solo de las abiertas', () => {
  const r = cargaPorAnalista(
    [
      camp(1, 'a@x.mx', { meta: 10, comprobados: 7, pendientes: 3 }),
      // Cerrada abajo de la meta (P1): sus 40 pendientes ya no se marcan.
      camp(2, 'a@x.mx', { meta: 88, comprobados: 48, pendientes: 40, estatus: 'cerrada' }),
    ],
    []
  );
  assert.equal(r[0].pendientes, 3);
  assert.equal(r[0].abiertas, 1);
  assert.equal(r[0].campanas, 2);
  // La meta y el % siguen siendo de todas sus campañas.
  assert.equal(r[0].meta, 98);
  assert.equal(r[0].comprobadosCarga, 55);
});

test('cargaPorAnalista: el crédito sin autor va a «(sin registro)», no se pierde', () => {
  const r = cargaPorAnalista(
    [camp(1, null, { meta: 5, pendientes: 5 }), camp(2, 'a@x.mx', { meta: 3, comprobados: 3 })],
    [
      { comprobado_por: 'a@x.mx', dia: '2026-08-01', sitios: 3 },
      { comprobado_por: null, dia: '2026-08-01', sitios: 4 },
      { comprobado_por: ' ', dia: '2026-08-02', sitios: 1 },
    ],
    '2026-08-01'
  );
  assert.deepEqual(
    r.map((x) => x.email),
    ['a@x.mx', CLAVE_SIN_REGISTRO, null]
  );
  const sinRegistro = r[1];
  assert.equal(sinRegistro.comprobados, 5);
  assert.equal(sinRegistro.hoy, 4);
  assert.equal(sinRegistro.campanas, 0);
  // "Sin analista" (campañas sin asignar) es otro renglón y no recibe crédito.
  assert.equal(r[2].campanas, 1);
  assert.equal(r[2].comprobados, 0);
  // Mismo total de crédito que la tabla diaria por analista.
  assert.equal(r.reduce((t, x) => t + x.comprobados, 0), 8);
});

test('cargaPorAnalista sin datos', () => {
  assert.deepEqual(cargaPorAnalista([], []), []);
});

// ------------------------------------------------------------
// Plan de tomas (rediseño de Erik, 23-oct-2026)
// leerPlan, generarFechasPlan, ventanaToma y horarioDelDia son ESPEJO de
// comp_plan_normal / comp_generar_tomas. La tabla de abajo es JSON estricto
// entre las marcas CASOS_PLAN_INICIO / CASOS_PLAN_FIN: la pieza SQL la
// repite tal cual (se copia a plan_casos.json con nucleo2/casos_plan.mjs).
// "error": true = el plan es inválido: aquí generarFechasPlan da [] y
// validarPlan devuelve "mensaje"; en SQL, comp_generar_tomas lanza excepción
// con ese mismo texto.
// ------------------------------------------------------------
const {
  TIPOS_PLAN,
  ETIQUETA_PLAN,
  MAX_CADA_N,
  MENSAJES_PLAN,
  diaIso,
  leerPlan,
  normalizarPlan,
  validarPlan,
  describirPlan,
  generarFechasPlan,
  ventanaToma,
  ventanasToma,
  esFinDeSemana,
  horarioDelDia,
  HORARIO_24H,
  esMedio24h,
  horarioParaMostrar,
  observacionesToma,
  compararNatural,
  sitioEntraAlPlan,
  sitioRecibeTomasNuevas,
  campanaOmitidaDelPlan,
  generarRenglonesPlan,
  resumenPlan,
  diasEntre,
} = C;

// CASOS_PLAN_INICIO
const CASOS_PLAN = {
  "generarFechasPlan": [
    { "nombre": "al inicio", "plan": { "tipo": "inicio" }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": ["2026-08-01"] },
    { "nombre": "inicio y fin", "plan": { "tipo": "inicio_fin" }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": ["2026-08-01", "2026-08-31"] },
    { "nombre": "inicio y fin el mismo día: una sola", "plan": { "tipo": "inicio_fin" }, "inicio": "2026-08-10", "fin": "2026-08-10", "fechas": ["2026-08-10"] },
    { "nombre": "al inicio con ventana de un día", "plan": { "tipo": "inicio" }, "inicio": "2026-08-10", "fin": "2026-08-10", "fechas": ["2026-08-10"] },
    { "nombre": "cada 7 días: el fin no se agrega", "plan": { "tipo": "cada_n", "cada_n": 7 }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": ["2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22", "2026-08-29"] },
    { "nombre": "cada 3 días", "plan": { "tipo": "cada_n", "cada_n": 3 }, "inicio": "2026-08-03", "fin": "2026-08-10", "fechas": ["2026-08-03", "2026-08-06", "2026-08-09"] },
    { "nombre": "cada 3 días cayendo justo en el fin", "plan": { "tipo": "cada_n", "cada_n": 3 }, "inicio": "2026-08-03", "fin": "2026-08-09", "fechas": ["2026-08-03", "2026-08-06", "2026-08-09"] },
    { "nombre": "cada 1 día = diario, cruzando de mes", "plan": { "tipo": "cada_n", "cada_n": 1 }, "inicio": "2026-08-29", "fin": "2026-09-02", "fechas": ["2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"] },
    { "nombre": "cada 40 días en un mes: solo el inicio", "plan": { "tipo": "cada_n", "cada_n": 40 }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": ["2026-08-01"] },
    { "nombre": "cada 366 días (el máximo): solo el inicio", "plan": { "tipo": "cada_n", "cada_n": 366 }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": ["2026-08-01"] },
    { "nombre": "cada '10' como texto de dígitos: vale, como ::int", "plan": { "tipo": "cada_n", "cada_n": "10" }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": ["2026-08-01", "2026-08-11", "2026-08-21", "2026-08-31"] },
    { "nombre": "cada ' 4 ' con espacios: vale, como ::int", "plan": { "tipo": "cada_n", "cada_n": " 4 " }, "inicio": "2026-08-01", "fin": "2026-08-10", "fechas": ["2026-08-01", "2026-08-05", "2026-08-09"] },
    { "nombre": "cada 2 días cruzando de año", "plan": { "tipo": "cada_n", "cada_n": 2 }, "inicio": "2026-12-30", "fin": "2027-01-03", "fechas": ["2026-12-30", "2027-01-01", "2027-01-03"] },
    { "nombre": "diario en febrero normal", "plan": { "tipo": "diario" }, "inicio": "2026-02-26", "fin": "2026-03-02", "fechas": ["2026-02-26", "2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"] },
    { "nombre": "diario en febrero bisiesto", "plan": { "tipo": "diario" }, "inicio": "2028-02-27", "fin": "2028-03-01", "fechas": ["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"] },
    { "nombre": "diario en una catorcena (14 días)", "plan": { "tipo": "diario" }, "inicio": "2026-10-12", "fin": "2026-10-25", "fechas": ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"] },
    { "nombre": "diario con cada_n de sobra: se ignora", "plan": { "tipo": "diario", "cada_n": 3 }, "inicio": "2026-08-01", "fin": "2026-08-03", "fechas": ["2026-08-01", "2026-08-02", "2026-08-03"] },
    { "nombre": "fechas a mano: solo las de dentro, sin repetir y en orden", "plan": { "tipo": "fechas", "fechas": ["2026-08-15", "2026-08-01", "2026-08-15", "2026-09-02", "2026-07-31"] }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": ["2026-08-01", "2026-08-15"] },
    { "nombre": "fechas a mano en los bordes de la ventana", "plan": { "tipo": "fechas", "fechas": ["2026-08-10", "2026-08-20"] }, "inicio": "2026-08-10", "fin": "2026-08-20", "fechas": ["2026-08-10", "2026-08-20"] },
    { "nombre": "fechas a mano todas fuera", "plan": { "tipo": "fechas", "fechas": ["2026-07-30", "2026-09-01"] }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [] },
    { "nombre": "fechas a mano con hora: cuenta el día", "plan": { "tipo": "fechas", "fechas": ["2026-08-03T10:00:00", "2026-08-05 23:59"] }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": ["2026-08-03", "2026-08-05"] },
    { "nombre": "fechas a mano con vacías y espacios: las vacías se ignoran", "plan": { "tipo": "fechas", "fechas": [null, "", "   ", " 2026-08-03 "] }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": ["2026-08-03"] },
    { "nombre": "ventana al revés (el sitio no corre en el periodo)", "plan": { "tipo": "diario" }, "inicio": "2026-08-20", "fin": "2026-08-10", "fechas": [] },
    { "nombre": "ventana al revés con al inicio", "plan": { "tipo": "inicio" }, "inicio": "2026-08-20", "fin": "2026-08-10", "fechas": [] },
    { "nombre": "sin inicio", "plan": { "tipo": "inicio" }, "inicio": null, "fin": "2026-08-31", "fechas": [] },
    { "nombre": "cada 0 días: inválido", "plan": { "tipo": "cada_n", "cada_n": 0 }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «cada N días» escribe N (de 1 a 366)." },
    { "nombre": "cada N sin número: inválido", "plan": { "tipo": "cada_n", "cada_n": null }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «cada N días» escribe N (de 1 a 366)." },
    { "nombre": "cada -2 días: inválido", "plan": { "tipo": "cada_n", "cada_n": -2 }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «cada N días» escribe N (de 1 a 366)." },
    { "nombre": "cada 2.5 días: inválido", "plan": { "tipo": "cada_n", "cada_n": 2.5 }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «cada N días» escribe N (de 1 a 366)." },
    { "nombre": "cada 367 días: pasa del máximo", "plan": { "tipo": "cada_n", "cada_n": 367 }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «cada N días» escribe N (de 1 a 366)." },
    { "nombre": "cada 100000000 días: inválido, sin tronar", "plan": { "tipo": "cada_n", "cada_n": 100000000 }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «cada N días» escribe N (de 1 a 366)." },
    { "nombre": "cada true: no es entero para ::int", "plan": { "tipo": "cada_n", "cada_n": true }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «cada N días» escribe N (de 1 a 366)." },
    { "nombre": "cada '1e1': no es entero para ::int", "plan": { "tipo": "cada_n", "cada_n": "1e1" }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «cada N días» escribe N (de 1 a 366)." },
    { "nombre": "cada '3.0': no es entero para ::int", "plan": { "tipo": "cada_n", "cada_n": "3.0" }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «cada N días» escribe N (de 1 a 366)." },
    { "nombre": "fechas a mano vacías: inválido", "plan": { "tipo": "fechas", "fechas": [] }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «fechas a mano» elige al menos una fecha." },
    { "nombre": "fechas a mano solo en blanco: inválido", "plan": { "tipo": "fechas", "fechas": ["", null] }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «fechas a mano» elige al menos una fecha." },
    { "nombre": "fechas a mano que no es arreglo: inválido", "plan": { "tipo": "fechas", "fechas": "2026-08-03" }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Para «fechas a mano» elige al menos una fecha." },
    { "nombre": "una fecha imposible rechaza todo el plan", "plan": { "tipo": "fechas", "fechas": ["2026-02-30", "2026-08-03"] }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Hay una fecha del plan que no se entiende." },
    { "nombre": "una fecha como número rechaza el plan", "plan": { "tipo": "fechas", "fechas": [20260803] }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Hay una fecha del plan que no se entiende." },
    { "nombre": "3/8/2026 no se adivina (MDY lo leía 8 de marzo)", "plan": { "tipo": "fechas", "fechas": ["3/8/2026"] }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Hay una fecha del plan que no se entiende." },
    { "nombre": "fecha con zona: no se acepta", "plan": { "tipo": "fechas", "fechas": ["2026-08-03T23:30:00-06:00"] }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Hay una fecha del plan que no se entiende." },
    { "nombre": "tipo desconocido: inválido", "plan": { "tipo": "semanal" }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Plan de tomas no válido: elige «al inicio», «inicio y fin», «cada N días», «diario» o «fechas a mano»." },
    { "nombre": "tipo en mayúsculas: inválido", "plan": { "tipo": "INICIO" }, "inicio": "2026-08-01", "fin": "2026-08-31", "fechas": [], "error": true, "mensaje": "Plan de tomas no válido: elige «al inicio», «inicio y fin», «cada N días», «diario» o «fechas a mano»." }
  ],
  "ventanaToma": [
    { "nombre": "sin vigencia de sitio ni campaña: el periodo", "sitio": { "inicio": null, "fin": null }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventana": { "inicio": "2026-08-01", "fin": "2026-08-31" } },
    { "nombre": "el sitio empieza antes del periodo: se recorta", "sitio": { "inicio": "2026-07-25", "fin": "2026-08-10" }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventana": { "inicio": "2026-08-01", "fin": "2026-08-10" } },
    { "nombre": "el sitio solo trae fin: el inicio sale de la campaña", "sitio": { "inicio": null, "fin": "2026-08-20" }, "campana": { "inicio": "2026-08-05", "fin": "2026-08-25" }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventana": { "inicio": "2026-08-05", "fin": "2026-08-20" } },
    { "nombre": "el sitio solo trae inicio: el fin sale de la campaña", "sitio": { "inicio": "2026-08-12", "fin": null }, "campana": { "inicio": "2026-08-01", "fin": "2026-08-15" }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventana": { "inicio": "2026-08-12", "fin": "2026-08-15" } },
    { "nombre": "la campaña sigue en el mes siguiente: se recorta al periodo", "sitio": { "inicio": null, "fin": null }, "campana": { "inicio": "2026-08-10", "fin": "2026-09-15" }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventana": { "inicio": "2026-08-10", "fin": "2026-08-31" } },
    { "nombre": "el sitio corre en otro mes: sin ventana", "sitio": { "inicio": "2026-09-01", "fin": "2026-09-10" }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventana": null },
    { "nombre": "la vigencia del sitio gana a la de la campaña", "sitio": { "inicio": "2026-08-03", "fin": "2026-08-07" }, "campana": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventana": { "inicio": "2026-08-03", "fin": "2026-08-07" } },
    { "nombre": "catorcena: sitio que acaba el primer día", "sitio": { "inicio": "2026-10-01", "fin": "2026-10-12" }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-10-12", "fin": "2026-10-25" }, "ventana": { "inicio": "2026-10-12", "fin": "2026-10-12" } },
    { "nombre": "el sitio corre más allá de la campaña: se recorta a la campaña (intersección)", "sitio": { "inicio": "2026-07-25", "fin": "2026-08-31" }, "campana": { "inicio": "2026-08-05", "fin": "2026-08-20" }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventana": { "inicio": "2026-08-05", "fin": "2026-08-20" } },
    { "nombre": "campaña recortada en la app: el sitio también", "sitio": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "campana": { "inicio": "2026-08-10", "fin": "2026-08-12" }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventana": { "inicio": "2026-08-10", "fin": "2026-08-12" } },
    { "nombre": "la campaña acaba antes de que empiece el sitio: sin ventana", "sitio": { "inicio": "2026-08-20", "fin": "2026-08-31" }, "campana": { "inicio": "2026-08-01", "fin": "2026-08-15" }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventana": null },
    { "nombre": "sitio sin inicio y campaña sin fin que no se tocan: sin ventana", "sitio": { "inicio": null, "fin": "2026-08-20" }, "campana": { "inicio": "2026-08-25", "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventana": null }
  ],
  "ventanasToma": [
    { "nombre": "sin tramos: la intersección de siempre", "sitio": { "inicio": "2026-07-25", "fin": "2026-08-10", "tramos": null }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventanas": [{ "inicio": "2026-08-01", "fin": "2026-08-10" }] },
    { "nombre": "tramos vacíos = un solo tramo con inicio y fin del sitio", "sitio": { "inicio": "2026-08-03", "fin": "2026-08-04", "tramos": [] }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventanas": [{ "inicio": "2026-08-03", "fin": "2026-08-04" }] },
    { "nombre": "dos tramos separados: dos ventanas", "sitio": { "inicio": "2026-08-01", "fin": "2026-08-25", "tramos": [{ "inicio": "2026-08-01", "fin": "2026-08-05" }, { "inicio": "2026-08-20", "fin": "2026-08-25" }] }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventanas": [{ "inicio": "2026-08-01", "fin": "2026-08-05" }, { "inicio": "2026-08-20", "fin": "2026-08-25" }] },
    { "nombre": "tramos que se tocan se juntan (1-5 y 6-9)", "sitio": { "tramos": [{ "inicio": "2026-08-01", "fin": "2026-08-05" }, { "inicio": "2026-08-06", "fin": "2026-08-09" }] }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventanas": [{ "inicio": "2026-08-01", "fin": "2026-08-09" }] },
    { "nombre": "un día de hueco no se junta (1-5 y 7-9)", "sitio": { "tramos": [{ "inicio": "2026-08-01", "fin": "2026-08-05" }, { "inicio": "2026-08-07", "fin": "2026-08-09" }] }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventanas": [{ "inicio": "2026-08-01", "fin": "2026-08-05" }, { "inicio": "2026-08-07", "fin": "2026-08-09" }] },
    { "nombre": "tramos encimados y en desorden se juntan", "sitio": { "tramos": [{ "inicio": "2026-08-10", "fin": "2026-08-20" }, { "inicio": "2026-08-01", "fin": "2026-08-12" }] }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventanas": [{ "inicio": "2026-08-01", "fin": "2026-08-20" }] },
    { "nombre": "un tramo fuera del periodo se descarta, el otro se recorta", "sitio": { "tramos": [{ "inicio": "2026-07-01", "fin": "2026-07-10" }, { "inicio": "2026-08-28", "fin": "2026-09-05" }] }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventanas": [{ "inicio": "2026-08-28", "fin": "2026-08-31" }] },
    { "nombre": "los tramos también se recortan por la campaña", "sitio": { "tramos": [{ "inicio": "2026-08-01", "fin": "2026-08-05" }, { "inicio": "2026-08-20", "fin": "2026-08-25" }] }, "campana": { "inicio": "2026-08-03", "fin": "2026-08-21" }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventanas": [{ "inicio": "2026-08-03", "fin": "2026-08-05" }, { "inicio": "2026-08-20", "fin": "2026-08-21" }] },
    { "nombre": "con tramos, el inicio y fin del sitio no cuentan", "sitio": { "inicio": "2026-08-01", "fin": "2026-08-31", "tramos": [{ "inicio": "2026-08-10", "fin": "2026-08-12" }] }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventanas": [{ "inicio": "2026-08-10", "fin": "2026-08-12" }] },
    { "nombre": "un tramo con un extremo vacío toma el de la campaña", "sitio": { "tramos": [{ "inicio": null, "fin": "2026-08-05" }] }, "campana": { "inicio": "2026-08-02", "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventanas": [{ "inicio": "2026-08-02", "fin": "2026-08-05" }] },
    { "nombre": "ningún tramo cae en el periodo: sin ventanas", "sitio": { "tramos": [{ "inicio": "2026-09-01", "fin": "2026-09-05" }] }, "campana": { "inicio": null, "fin": null }, "periodo": { "inicio": "2026-08-01", "fin": "2026-08-31" }, "ventanas": [] }
  ],
  "horarioDelDia": [
    { "nombre": "lunes: el de lunes a viernes", "lv": "24 HRS", "sd": "07:00 - 22:00", "fecha": "2026-08-03", "horario": "24 HRS" },
    { "nombre": "viernes con espacios: se recortan", "lv": "  08:00 - 08:59 / 14:00 - 14:59  ", "sd": "24 HRS", "fecha": "2026-08-07", "horario": "08:00 - 08:59 / 14:00 - 14:59" },
    { "nombre": "sábado: el de sábado y domingo", "lv": "24 HRS", "sd": "07:00 - 22:00", "fecha": "2026-08-01", "horario": "07:00 - 22:00" },
    { "nombre": "domingo sin horario: null, no cae al de entre semana", "lv": "24 HRS", "sd": null, "fecha": "2026-08-02", "horario": null },
    { "nombre": "sábado en blanco: null", "lv": "24 HRS", "sd": "   ", "fecha": "2026-08-08", "horario": null },
    { "nombre": "martes sin horario de entre semana: null", "lv": null, "sd": "24 HRS", "fecha": "2026-08-04", "horario": null },
    { "nombre": "tabulador: btrim solo quita espacios", "lv": "\t24 HRS ", "sd": null, "fecha": "2026-08-04", "horario": "\t24 HRS" }
  ]
};
// CASOS_PLAN_FIN

test('generarFechasPlan: tabla compartida con comp_plan_normal / comp_generar_tomas', () => {
  for (const c of CASOS_PLAN.generarFechasPlan) {
    assert.deepEqual(generarFechasPlan(c.plan, c.inicio, c.fin), c.fechas, c.nombre);
    assert.equal(validarPlan(c.plan), c.error ? c.mensaje : null, 'validarPlan · ' + c.nombre);
    // Lo que guarda la base (normalizado) releído aquí da las mismas fechas.
    if (!c.error) assert.deepEqual(generarFechasPlan(normalizarPlan(c.plan), c.inicio, c.fin), c.fechas, 'releído · ' + c.nombre);
  }
});

test('ventanaToma: tabla compartida con comp_ventanas (intersección de sitio, campaña y periodo)', () => {
  for (const c of CASOS_PLAN.ventanaToma) {
    assert.deepEqual(ventanaToma(c.sitio, c.campana, c.periodo), c.ventana, c.nombre);
    // Sin tramos, ventanasToma es la misma ventana (o ninguna).
    assert.deepEqual(ventanasToma(c.sitio, c.campana, c.periodo), c.ventana ? [c.ventana] : [], 'ventanas · ' + c.nombre);
  }
});

test('ventanasToma: tabla compartida con comp_ventanas (tramos, R10)', () => {
  for (const c of CASOS_PLAN.ventanasToma) {
    assert.deepEqual(ventanasToma(c.sitio, c.campana, c.periodo), c.ventanas, c.nombre);
    // ventanaToma = del primer inicio al último fin.
    const env = c.ventanas.length ? { inicio: c.ventanas[0].inicio, fin: c.ventanas.at(-1).fin } : null;
    assert.deepEqual(ventanaToma(c.sitio, c.campana, c.periodo), env, 'envolvente · ' + c.nombre);
  }
});

test('ventanaToma: la intersección nunca se sale de la campaña ni del periodo (barrido)', () => {
  const D = [null, '2026-07-25', '2026-08-01', '2026-08-05', '2026-08-20', '2026-08-31', '2026-09-03'];
  const P = { inicio: '2026-08-01', fin: '2026-08-31' };
  const max = (...x) => x.filter(Boolean).sort().at(-1) ?? null;
  const min = (...x) => x.filter(Boolean).sort()[0] ?? null;
  let n = 0;
  for (const si of D) for (const sf of D) for (const ci of [null, '2026-08-05']) for (const cf of [null, '2026-08-25']) {
    if (si && sf && sf < si) continue;
    n++;
    const a = max(si, ci, P.inicio);
    const b = min(sf, cf, P.fin);
    const esperado = a && b && a <= b ? { inicio: a, fin: b } : null;
    assert.deepEqual(ventanaToma({ inicio: si, fin: sf }, { inicio: ci, fin: cf }, P), esperado, JSON.stringify({ si, sf, ci, cf }));
  }
  assert.equal(n, 136);
});

test('horarioDelDia: tabla compartida con comp_generar_tomas', () => {
  for (const c of CASOS_PLAN.horarioDelDia) {
    assert.equal(horarioDelDia(c.lv, c.sd, c.fecha), c.horario, c.nombre);
  }
});

test('la tabla del plan cubre los 5 tipos y es JSON puro', () => {
  const tipos = new Set(CASOS_PLAN.generarFechasPlan.filter((c) => !c.error).map((c) => c.plan.tipo));
  assert.deepEqual([...tipos].sort(), [...TIPOS_PLAN].sort());
  assert.deepEqual(JSON.parse(JSON.stringify(CASOS_PLAN)), CASOS_PLAN);
  for (const t of TIPOS_PLAN) assert.ok(ETIQUETA_PLAN[t]);
  // Cada caso con error dice con qué texto (el mismo de la base).
  const textos = new Set(Object.values(MENSAJES_PLAN));
  for (const c of CASOS_PLAN.generarFechasPlan.filter((x) => x.error)) assert.ok(textos.has(c.mensaje), c.nombre);
  assert.equal(MAX_CADA_N, 366);
});

test('diaIso: solo días de calendario reales', () => {
  assert.equal(diaIso('2026-08-01'), '2026-08-01');
  assert.equal(diaIso('2026-08-01T00:00:00'), '2026-08-01');
  assert.equal(diaIso(' 2026-08-01 '), '2026-08-01');
  assert.equal(diaIso('2026-02-30'), null);
  assert.equal(diaIso('2026-13-01'), null);
  assert.equal(diaIso('01/08/2026'), null);
  assert.equal(diaIso(''), null);
  assert.equal(diaIso(null), null);
  assert.equal(diaIso(46235), null);
});

test('generarFechasPlan con un N enorme no truena (antes RangeError en sumarDiasIso)', () => {
  for (const n of [1e8, 1e9, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(generarFechasPlan({ tipo: 'cada_n', cada_n: n }, '2026-08-01', '2026-08-31'), []);
    assert.deepEqual(generarRenglonesPlan({ tipo: 'cada_n', cada_n: n }, null, [{ sitio_clave: 'A' }], { inicio: '2026-08-01', fin: '2026-08-31' }), []);
  }
});

test('generarFechasPlan: nunca más de 400 días', () => {
  assert.equal(generarFechasPlan({ tipo: 'diario' }, '2026-01-01', '2028-12-31').length, 400);
  assert.equal(diasEntre('2026-08-01', '2026-08-31').length, 31);
  assert.deepEqual(diasEntre('2026-08-31', '2026-08-01'), []);
});

test('leerPlan / normalizarPlan: lo que guarda comp_plan_normal', () => {
  assert.deepEqual(normalizarPlan({ tipo: 'cada_n', cada_n: '3', fechas: ['2026-08-01'] }), {
    tipo: 'cada_n',
    cada_n: 3,
    fechas: null,
  });
  assert.deepEqual(normalizarPlan({ tipo: 'fechas', fechas: ['2026-08-15', '2026-08-01', '2026-08-15T08:00'] }), {
    tipo: 'fechas',
    cada_n: null,
    fechas: ['2026-08-01', '2026-08-15'],
  });
  assert.deepEqual(normalizarPlan({ tipo: 'diario', cada_n: 5 }), { tipo: 'diario', cada_n: null, fechas: null });
  // Un plan inválido ya no se "arregla" en silencio: null, y leerPlan dice por qué.
  assert.equal(normalizarPlan({ tipo: 'cada_n', cada_n: '' }), null);
  assert.equal(normalizarPlan({ tipo: 'fechas', fechas: ['x', '2026-08-01'] }), null);
  assert.deepEqual(leerPlan({ tipo: 'fechas', fechas: ['x', '2026-08-01'] }), { plan: null, error: MENSAJES_PLAN.fechaRara });
  assert.equal(normalizarPlan({ tipo: 'semanal' }), null);
  assert.equal(normalizarPlan(null), null);
  assert.equal(normalizarPlan('diario'), null);
  assert.equal(normalizarPlan([{ tipo: 'diario' }]), null);
});

test('validarPlan con los textos de la base, y describirPlan', () => {
  assert.equal(validarPlan({ tipo: 'diario' }), null);
  assert.equal(validarPlan({ tipo: 'cada_n', cada_n: 3 }), null);
  assert.equal(validarPlan({ tipo: 'cada_n', cada_n: 0 }), MENSAJES_PLAN.cada_n);
  assert.equal(validarPlan({ tipo: 'cada_n', cada_n: 367 }), MENSAJES_PLAN.cada_n);
  assert.equal(validarPlan({ tipo: 'fechas', fechas: ['2026-02-30'] }), MENSAJES_PLAN.fechaRara);
  assert.equal(validarPlan({ tipo: 'fechas', fechas: [] }), MENSAJES_PLAN.sinFechas);
  assert.equal(validarPlan(null), MENSAJES_PLAN.tipo);
  assert.equal(describirPlan({ tipo: 'inicio' }), 'Al inicio');
  assert.equal(describirPlan({ tipo: 'inicio_fin' }), 'Inicio y fin');
  assert.equal(describirPlan({ tipo: 'diario' }), 'Diario');
  assert.equal(describirPlan({ tipo: 'cada_n', cada_n: 1 }), 'Cada día');
  assert.equal(describirPlan({ tipo: 'cada_n', cada_n: '3' }), 'Cada 3 días');
  assert.equal(describirPlan({ tipo: 'cada_n', cada_n: null }), 'Cada N días (falta el número)');
  assert.equal(describirPlan({ tipo: 'cada_n', cada_n: 500 }), 'Cada N días (número no válido)');
  assert.equal(
    describirPlan({
      tipo: 'fechas',
      fechas: ['2026-08-10', '2026-08-03', '2026-08-17', '2026-08-24', '2026-08-31', '2026-08-03'],
    }),
    'Fechas: 3 ago, 10 ago, 17 ago, 24 ago y 1 más'
  );
  assert.equal(describirPlan({ tipo: 'fechas', fechas: [] }), 'Fechas a mano (ninguna)');
  assert.equal(describirPlan({ tipo: 'fechas', fechas: ['3/8/2026'] }), 'Fechas a mano (hay una que no se entiende)');
  assert.equal(describirPlan(null), 'Sin plan');
});

test('esFinDeSemana: sábado y domingo, sin moverse por la zona', () => {
  assert.equal(esFinDeSemana('2026-08-01'), true); // sábado
  assert.equal(esFinDeSemana('2026-08-02'), true); // domingo
  assert.equal(esFinDeSemana('2026-08-03'), false); // lunes
  assert.equal(esFinDeSemana('2026-08-07'), false); // viernes
  assert.equal(esFinDeSemana('no'), false);
  assert.equal(horarioDelDia('24 HRS', '24 HRS', 'no'), null);
});

test('observacionesToma: especificación de la campaña · observación, sin repetir', () => {
  const esp = 'DEL 01 AL 31 DE AGOSTO. TOMAS CORTAS, MEDIAS Y LARGAS';
  assert.equal(observacionesToma(esp, null), esp);
  assert.equal(observacionesToma(esp, '  '), esp);
  assert.equal(observacionesToma(null, ' TOMAS POR LADO '), 'TOMAS POR LADO');
  assert.equal(observacionesToma(esp, 'TOMAS POR LADO'), `${esp} · TOMAS POR LADO`);
  // Si la base ya guardó la concatenación, no se duplica.
  assert.equal(observacionesToma(esp, `${esp} · TOMAS POR LADO`), `${esp} · TOMAS POR LADO`);
  // La observación ya está dentro de la especificación (distinto formato).
  assert.equal(observacionesToma(esp, 'tomas cortas medias y largas'), esp);
  assert.equal(observacionesToma(null, null), null);
});

test('compararNatural: los números como números, sin depender del idioma', () => {
  const claves = ['MX_CM_VV_COL_1000', 'MX_CM_VV_COL_448', 'mx_cm_vv_col_491', 'POR_0008', 'POR_15', 'POR_8', 'MX_CM_VV_COL_606'];
  assert.deepEqual([...claves].sort(compararNatural), [
    'MX_CM_VV_COL_448',
    'mx_cm_vv_col_491',
    'MX_CM_VV_COL_606',
    'MX_CM_VV_COL_1000',
    'POR_8',
    'POR_0008',
    'POR_15',
  ]);
  assert.equal(compararNatural('A', 'A'), 0);
  assert.ok(compararNatural('', 'A') < 0);
  assert.ok(compararNatural(null, '1') < 0);
  assert.ok(compararNatural('R2', 'R10') < 0);
});

const PERIODO_AGO = { inicio: '2026-08-01', fin: '2026-08-31' };

test('generarRenglonesPlan: sitio × fecha dentro de la vigencia de cada sitio, con el horario del día', () => {
  const campana = { inicio: '2026-08-01', fin: '2026-08-14', especificacion: 'DEL 01 AL 14 DE AGOSTO. TOMAS MEDIAS' };
  const sitios = [
    { sitio_clave: 'MX_CM_BB_MED_0902', horario_lv: '24 HORAS', horario_sd: '10:00 - 18:00', observaciones: ' TOMAS POR LADO ' },
    { sitio_clave: 'MX_CM_BB_MED_901', inicio: '2026-08-08', fin: '2026-08-31', horario_lv: '24 HORAS', horario_sd: null },
    { sitio_clave: 'MX_CM_BB_MED_0903', inicio: '2026-09-01', fin: '2026-09-30', horario_lv: '24 HORAS' },
    { sitio_clave: 'MX_CM_BB_MED_0001', estado: 'cancelado' },
    { sitio_clave: 'MX_CM_BB_MED_0002', fuera_de_carga: true },
  ];
  const r = generarRenglonesPlan({ tipo: 'cada_n', cada_n: 7 }, campana, sitios, PERIODO_AGO);
  const esp = campana.especificacion;
  assert.deepEqual(r, [
    { sitio_clave: 'MX_CM_BB_MED_0902', fecha: '2026-08-01', horario: '10:00 - 18:00', horarioMostrar: '10:00 - 18:00', observaciones: 'TOMAS POR LADO', observacionesExcel: `${esp} · TOMAS POR LADO` },
    // Mismo día: orden natural (901 antes que 0902).
    { sitio_clave: 'MX_CM_BB_MED_901', fecha: '2026-08-08', horario: null, horarioMostrar: null, observaciones: null, observacionesExcel: esp },
    { sitio_clave: 'MX_CM_BB_MED_0902', fecha: '2026-08-08', horario: '10:00 - 18:00', horarioMostrar: '10:00 - 18:00', observaciones: 'TOMAS POR LADO', observacionesExcel: `${esp} · TOMAS POR LADO` },
    // El 901 corre hasta el 31, pero la campaña acaba el 14: la ventana es
    // la intersección (comp_ventanas, 23-oct-2026), así que ya no hay tomas
    // el 15, 22 y 29 (con coalesce sí las había y la base no las creaba).
  ]);
  assert.deepEqual(generarRenglonesPlan({ tipo: 'cada_n', cada_n: 0 }, campana, sitios, PERIODO_AGO), []);
  assert.deepEqual(generarRenglonesPlan({ tipo: 'inicio' }, campana, [], PERIODO_AGO), []);
  // El plan crudo de la pantalla (cada_n como texto) da lo mismo.
  assert.deepEqual(generarRenglonesPlan({ tipo: 'cada_n', cada_n: '7' }, campana, sitios, PERIODO_AGO), r);
});

test('sitioEntraAlPlan: el mismo filtro que comp_aplicar_plan', () => {
  assert.equal(sitioEntraAlPlan({}), true);
  assert.equal(sitioEntraAlPlan({ estado: 'comprobado' }), true);
  assert.equal(sitioEntraAlPlan({ estado: 'cancelado' }), false);
  assert.equal(sitioEntraAlPlan({ estado: 'pendiente', fuera_de_carga: true }), false);
});

test('resumenPlan: cuenta como la base y dice qué sitios se quedan sin toma', () => {
  // 30 sitios, 5 cancelados, plan diario en agosto: 25 × 31 = 775 (antes 930).
  const sitios = Array.from({ length: 30 }, (_, i) => ({
    sitio_clave: `MX_CM_VV_COL_${i + 1}`,
    estado: i < 5 ? 'cancelado' : 'pendiente',
  }));
  const r = resumenPlan({ tipo: 'diario' }, null, sitios, PERIODO_AGO);
  assert.equal(r.error, null);
  assert.equal(r.renglones, 775);
  assert.equal(r.sitiosConTomas, 25);
  assert.equal(r.sitiosExcluidos, 5);
  assert.deepEqual(r.sitiosSinVentana, []);
  // Un sitio que solo corre en julio y otro al que no le cae ninguna fecha a mano.
  const r2 = resumenPlan(
    { tipo: 'fechas', fechas: ['2026-08-03', '2026-08-20'] },
    null,
    [
      { sitio_clave: 'COL_10', inicio: '2026-07-01', fin: '2026-07-31' },
      { sitio_clave: 'COL_9', inicio: '2026-08-05', fin: '2026-08-10' },
      { sitio_clave: 'COL_2' },
    ],
    PERIODO_AGO
  );
  assert.deepEqual(r2.sitiosSinVentana, ['COL_10']);
  assert.deepEqual(r2.sitiosSinFechas, ['COL_9']);
  assert.equal(r2.renglones, 2);
  const malo = resumenPlan({ tipo: 'cada_n', cada_n: 400 }, null, sitios, PERIODO_AGO);
  assert.equal(malo.error, MENSAJES_PLAN.cada_n);
  assert.equal(malo.renglones, 0);
});

test('resumenPlan cuenta lo mismo que generarRenglonesPlan (todos los casos de la tabla)', () => {
  const sitios = [
    { sitio_clave: 'A' },
    { sitio_clave: 'B', inicio: '2026-08-05', fin: '2026-08-12' },
    { sitio_clave: 'C', inicio: '2026-07-20', fin: '2026-08-02' },
    { sitio_clave: 'D', fin: '2026-08-09' },
    { sitio_clave: 'E', estado: 'cancelado' },
  ];
  const periodos = [PERIODO_AGO, { inicio: '2026-10-12', fin: '2026-10-25' }, { inicio: '2026-12-28', fin: '2027-01-10' }];
  for (const c of CASOS_PLAN.generarFechasPlan) {
    for (const p of periodos) {
      const n = generarRenglonesPlan(c.plan, { inicio: c.inicio, fin: c.fin }, sitios, p).length;
      assert.equal(resumenPlan(c.plan, { inicio: c.inicio, fin: c.fin }, sitios, p).renglones, n, c.nombre);
    }
  }
});

// ------------------------------------------------------------
// Pendientes del núcleo tras la revisión de la SQL (23-oct-2026)
// ------------------------------------------------------------

test('leerPlan: incluir_comprobados solo si viene exactamente true (como comp_plan_normal)', () => {
  assert.deepEqual(normalizarPlan({ tipo: 'diario', incluir_comprobados: true }), {
    tipo: 'diario',
    cada_n: null,
    fechas: null,
    incluir_comprobados: true,
  });
  // 'true' como texto, 1 o false: no se guarda (la llave ni siquiera existe).
  for (const v of ['true', 1, false, null]) {
    const p = normalizarPlan({ tipo: 'inicio', incluir_comprobados: v });
    assert.deepEqual(p, { tipo: 'inicio', cada_n: null, fechas: null }, String(v));
    assert.equal('incluir_comprobados' in p, false);
  }
  assert.equal(describirPlan({ tipo: 'inicio', incluir_comprobados: true }), 'Al inicio (también comprobados)');
  assert.equal(describirPlan({ tipo: 'cada_n', cada_n: 3, incluir_comprobados: true }), 'Cada 3 días (también comprobados)');
  assert.equal(describirPlan({ tipo: 'inicio' }), 'Al inicio');
});

test('sitioRecibeTomasNuevas: un sitio comprobado no recibe tomas nuevas salvo incluir_comprobados (R11)', () => {
  assert.equal(sitioRecibeTomasNuevas({ estado: 'pendiente' }, { tipo: 'diario' }), true);
  assert.equal(sitioRecibeTomasNuevas({}, null), true);
  assert.equal(sitioRecibeTomasNuevas({ estado: 'comprobado' }, { tipo: 'diario' }), false);
  assert.equal(sitioRecibeTomasNuevas({ estado: 'comprobado' }, { tipo: 'diario', incluir_comprobados: true }), true);
  assert.equal(sitioRecibeTomasNuevas({ estado: 'cancelado' }, { tipo: 'diario', incluir_comprobados: true }), false);
  assert.equal(sitioRecibeTomasNuevas({ fuera_de_carga: true }, { tipo: 'diario', incluir_comprobados: true }), false);
});

test('generarRenglonesPlan y resumenPlan: por tramo, y sin tomas nuevas para los comprobados', () => {
  const sitios = [
    // Dos tramos separados: «al inicio» da una toma por tramo.
    { sitio_clave: 'MX_CM_VV_COL_448', tramos: [{ inicio: '2026-08-01', fin: '2026-08-05' }, { inicio: '2026-08-20', fin: '2026-08-25' }] },
    // Tramos que se tocan: uno solo.
    { sitio_clave: 'MX_CM_VV_COL_491', tramos: [{ inicio: '2026-08-03', fin: '2026-08-05' }, { inicio: '2026-08-06', fin: '2026-08-09' }] },
    { sitio_clave: 'MX_CM_VV_COL_606', estado: 'comprobado' },
  ];
  const r = generarRenglonesPlan({ tipo: 'inicio' }, null, sitios, PERIODO_AGO);
  assert.deepEqual(
    r.map((x) => [x.sitio_clave, x.fecha]),
    [
      ['MX_CM_VV_COL_448', '2026-08-01'],
      ['MX_CM_VV_COL_491', '2026-08-03'],
      ['MX_CM_VV_COL_448', '2026-08-20'],
    ]
  );
  const res = resumenPlan({ tipo: 'inicio' }, null, sitios, PERIODO_AGO);
  assert.equal(res.renglones, 3);
  assert.equal(res.sitiosConTomas, 2);
  assert.deepEqual(res.sitiosComprobados, ['MX_CM_VV_COL_606']);
  // Con incluir_comprobados el comprobado sí entra.
  const conComp = { tipo: 'inicio', incluir_comprobados: true };
  assert.equal(generarRenglonesPlan(conComp, null, sitios, PERIODO_AGO).length, 4);
  const res2 = resumenPlan(conComp, null, sitios, PERIODO_AGO);
  assert.deepEqual([res2.renglones, res2.sitiosComprobados], [4, []]);
  // Diario por tramos: 5 + 6 días del 448 y 7 del 491, sin los huecos.
  assert.equal(generarRenglonesPlan({ tipo: 'diario' }, null, sitios, PERIODO_AGO).length, 18);
  assert.equal(resumenPlan({ tipo: 'diario' }, null, sitios, PERIODO_AGO).renglones, 18);
  // La campaña recorta los tramos: el 448 queda del 3 al 5 y del 20 al 21.
  const camp = { inicio: '2026-08-03', fin: '2026-08-21' };
  assert.deepEqual(
    generarRenglonesPlan({ tipo: 'inicio_fin' }, camp, [sitios[0]], PERIODO_AGO).map((x) => x.fecha),
    ['2026-08-03', '2026-08-05', '2026-08-20', '2026-08-21']
  );
});

test('resumenPlan cuenta lo mismo que generarRenglonesPlan también con tramos y comprobados', () => {
  const sitios = [
    { sitio_clave: 'A', tramos: [{ inicio: '2026-08-01', fin: '2026-08-04' }, { inicio: '2026-08-15', fin: '2026-08-18' }] },
    { sitio_clave: 'B', tramos: [{ inicio: '2026-10-10', fin: '2026-10-14' }, { inicio: '2026-10-15', fin: '2026-10-30' }] },
    { sitio_clave: 'C', estado: 'comprobado', inicio: '2026-08-05', fin: '2026-08-12' },
    { sitio_clave: 'D', inicio: '2026-12-20', fin: '2027-01-05' },
  ];
  const periodos = [PERIODO_AGO, { inicio: '2026-10-12', fin: '2026-10-25' }, { inicio: '2026-12-28', fin: '2027-01-10' }];
  for (const c of CASOS_PLAN.generarFechasPlan) {
    for (const p of periodos) {
      for (const plan of [c.plan, c.plan && typeof c.plan === 'object' ? { ...c.plan, incluir_comprobados: true } : c.plan]) {
        const n = generarRenglonesPlan(plan, { inicio: c.inicio, fin: c.fin }, sitios, p).length;
        assert.equal(resumenPlan(plan, { inicio: c.inicio, fin: c.fin }, sitios, p).renglones, n, c.nombre);
      }
    }
  }
});

test('horario de 24 horas: Ecovallas Digital y Biobox sin franjas; Vía Verde con el del día', () => {
  assert.equal(HORARIO_24H, '24 HORAS');
  for (const m of ['Pantalla', 'Máquina', 'Ecovallas', 'Biobox']) assert.equal(esMedio24h(m), true, m);
  for (const m of ['Columna', 'Pórtico', 'Vía Verde', 'Via Verde', '', null, undefined, 'Pantallas', 'Biobox Perú']) assert.equal(esMedio24h(m), false, String(m));
  assert.equal(horarioParaMostrar('Pantalla', '24 HRS'), '24 HORAS');
  assert.equal(horarioParaMostrar('Máquina', null), '24 HORAS');
  // Con franja, la franja (Erik, 23-oct-2026: así van los Excel de hoy).
  assert.equal(horarioParaMostrar('Biobox', '10:00 - 18:00'), '10:00 - 18:00');
  assert.equal(horarioParaMostrar('Pantalla', '3 PM A 4 PM'), '3 PM A 4 PM');
  assert.equal(horarioParaMostrar('Máquina', ' PROGRAMMATIC '), 'PROGRAMMATIC');
  // 24 horas en cualquiera de sus formas, o vacío: «24 HORAS».
  for (const h of ['24 hrs', '24 HORAS.', '24hrs', '24 h', '00:00 - 23:59', '00:00-23:59 HRS', '  ', null, undefined])
    assert.equal(horarioParaMostrar('Pantalla', h), '24 HORAS', String(h));
  assert.equal(horarioParaMostrar('Columna', '  06:00 - 09:59 '), '06:00 - 09:59');
  assert.equal(horarioParaMostrar('Pórtico', '   '), null);
  assert.equal(horarioParaMostrar(null, '24 HRS'), '24 HRS');
});

// ---- Revisión 3 del núcleo (23-oct-2026) ----

test('esMedio24h acepta la etiqueta de la vista y no depende de acentos ni mayúsculas', () => {
  // vw_comp_campanas.unidad_etiqueta dice 'Ecovallas Digital' (comp_etiqueta_unidad).
  for (const m of ['Ecovallas Digital', 'ECOVALLAS DIGITAL', 'Maquina', 'BIOBOX', 'máquina', ' pantalla ']) {
    assert.equal(esMedio24h(m), true, m);
  }
  assert.equal(horarioParaMostrar('Ecovallas Digital', '24 HRS'), '24 HORAS');
  assert.equal(horarioParaMostrar('Via Verde', ' 06:00 - 09:59 '), '06:00 - 09:59');
});

test('ventanaToma / ventanasToma: sin periodo completo no hay ventana (la SQL nunca recibe uno así)', () => {
  const sitio = { inicio: '2026-01-01', fin: '2026-12-31' };
  assert.equal(ventanaToma(sitio, null, {}), null);
  assert.equal(ventanaToma(sitio, null, null), null);
  assert.equal(ventanaToma(sitio, { inicio: '2026-08-01', fin: '2026-08-31' }, { inicio: '2026-08-01', fin: null }), null);
  assert.equal(ventanaToma(sitio, null, { inicio: null, fin: '2026-08-31' }), null);
  // Periodo al revés o con una fecha que no existe.
  assert.deepEqual(ventanasToma(sitio, null, { inicio: '2026-08-31', fin: '2026-08-01' }), []);
  assert.deepEqual(ventanasToma(sitio, null, { inicio: '2026-02-30', fin: '2026-03-10' }), []);
  // Con tramos también.
  assert.deepEqual(ventanasToma({ tramos: [{ inicio: '2026-08-01', fin: '2026-08-05' }] }, null, {}), []);
  // La vista previa ya no ofrece tomas sin periodo: antes eran 365 por sitio.
  assert.deepEqual(generarRenglonesPlan({ tipo: 'diario' }, null, [{ sitio_clave: 'S1', ...sitio }], {}), []);
  const r = resumenPlan({ tipo: 'diario' }, null, [{ sitio_clave: 'S1', ...sitio }], {});
  assert.deepEqual([r.renglones, r.sitiosSinVentana], [0, ['S1']]);
  // Con periodo de un solo día sí hay ventana.
  assert.deepEqual(ventanaToma(sitio, null, { inicio: '2026-08-10', fin: '2026-08-10' }), { inicio: '2026-08-10', fin: '2026-08-10' });
});

test('campanaOmitidaDelPlan: cerrada o retirada no reciben tomas del plan (comp_ap_cam / comp_ap_sit)', () => {
  assert.equal(campanaOmitidaDelPlan(null), null);
  assert.equal(campanaOmitidaDelPlan(undefined), null);
  assert.equal(campanaOmitidaDelPlan({}), null);
  assert.equal(campanaOmitidaDelPlan({ estatus: 'abierta', retirada: false }), null);
  assert.equal(campanaOmitidaDelPlan({ estatus: 'cerrada' }), 'cerrada');
  assert.equal(campanaOmitidaDelPlan({ retirada: true }), 'retirada');
  // La base filtra primero por estatus.
  assert.equal(campanaOmitidaDelPlan({ estatus: 'cerrada', retirada: true }), 'cerrada');
  // Solo true cuenta (la columna es boolean not null).
  assert.equal(campanaOmitidaDelPlan({ retirada: 'true' }), null);
});

test('generarRenglonesPlan y resumenPlan: 0 en campañas cerradas o retiradas, y dicen por qué', () => {
  // El caso de la revisión: plan diario, 8 días; la base crea 0 en las dos.
  const per = { inicio: '2026-08-01', fin: '2026-08-08' };
  const sitios = [{ sitio_clave: 'MX_CM_BB_MED_0001' }];
  const plan = { tipo: 'diario' };
  assert.equal(generarRenglonesPlan(plan, { estatus: 'abierta' }, sitios, per).length, 8);
  assert.equal(resumenPlan(plan, { estatus: 'abierta' }, sitios, per).campanaOmitida, null);
  for (const [camp, motivo] of [
    [{ estatus: 'abierta', retirada: true }, 'retirada'],
    [{ estatus: 'cerrada', retirada: false }, 'cerrada'],
  ]) {
    assert.deepEqual(generarRenglonesPlan(plan, camp, sitios, per), [], motivo);
    const r = resumenPlan(plan, camp, sitios, per);
    assert.deepEqual(
      [r.error, r.renglones, r.sitiosConTomas, r.sitiosSinVentana, r.sitiosComprobados, r.campanaOmitida],
      [null, 0, 0, [], [], motivo]
    );
  }
  // Un plan malo sigue diciendo su error aunque la campaña esté cerrada (la base lo rechaza antes).
  const malo = resumenPlan({ tipo: 'cada_n', cada_n: 0 }, { estatus: 'cerrada' }, sitios, per);
  assert.deepEqual([malo.error, malo.campanaOmitida], [MENSAJES_PLAN.cada_n, null]);
});

test('generarRenglonesPlan: horarioMostrar «24 HORAS» en Biobox y Ecovallas; horario sigue siendo el de la base', () => {
  // 3 y 4 de oct de 2026 son sábado y domingo; la bitácora de Biobox solo trae una columna.
  const per = { inicio: '2026-10-02', fin: '2026-10-04' };
  const sitios = [{ sitio_clave: 'MX_CM_BB_MED_0001', horario_lv: '24 HRS', horario_sd: null }];
  for (const camp of [{ medio: 'Máquina' }, { unidad: 'Biobox' }, { unidad: 'Ecovallas Digital' }]) {
    const r = generarRenglonesPlan({ tipo: 'diario' }, camp, sitios, per);
    assert.deepEqual(r.map((x) => x.horario), ['24 HRS', null, null], JSON.stringify(camp));
    assert.deepEqual(r.map((x) => x.horarioMostrar), ['24 HORAS', '24 HORAS', '24 HORAS'], JSON.stringify(camp));
  }
  // Vía Verde: el del día, igual que horario.
  const vv = generarRenglonesPlan(
    { tipo: 'diario' },
    { medio: 'Columna' },
    [{ sitio_clave: 'MX_CM_VV_COL_448', horario_lv: '06:00 - 09:59', horario_sd: '24 HRS' }],
    per
  );
  assert.deepEqual(vv.map((x) => x.horarioMostrar), ['06:00 - 09:59', '24 HRS', '24 HRS']);
  assert.deepEqual(vv.map((x) => x.horarioMostrar), vv.map((x) => x.horario));
  // Sin medio: horarioMostrar = horario.
  const sin = generarRenglonesPlan({ tipo: 'diario' }, null, sitios, per);
  assert.deepEqual(sin.map((x) => x.horarioMostrar), sin.map((x) => x.horario));
});
