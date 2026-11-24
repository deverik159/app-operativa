/**
 * ============================================================
 * Botón «Actualizar» de Incidencias (Erik, 24-nov-2026)
 *
 * Trae a la hoja de trabajo de cada equipo los folios de la app desde la
 * base general: la pestaña «App» de Incidencias VV Gral (Vía Verde) o EV
 * Gral (Ecovallas Fijas y Digital), que la app llena sola cada 5 minutos
 * (función sync-sheets).
 *
 * QUÉ HACE
 *   - Cada folio de la app ocupa una fila con el folio del equipo en la
 *     columna FOLIO (el siguiente consecutivo, o el de una fila que ya
 *     estaba preparada) y el de la app en la columna «Folio App».
 *   - Las que el equipo ya había copiado a mano (folio de la app escrito
 *     en comentarios o tickets, desde el 11-nov-2026) se ligan: no se
 *     duplican.
 *   - Solo escribe las columnas que trae la app. NUNCA toca las columnas
 *     con fórmula ni las que se llenan a mano (evidencias, comentarios,
 *     tickets, seguimiento, ruta, medio…). Un dato vacío en la app no
 *     borra lo que el equipo escribió.
 *   - Los estatus van con las palabras de la hoja: Reparado, No reparado
 *     y En proceso (por validar, devuelta y reparado por aprobar). Las
 *     duplicadas no se copian.
 *   - «Actualizar» trae solo lo que cambió desde la última vez; «Actualizar
 *     todo» revisa todos los folios.
 *
 * INSTALACIÓN (una vez por archivo)
 *   1. Extensiones → Apps Script. Borra lo que haya en Código.gs y pega
 *      todo este archivo.
 *   2. En BASE_ID (abajo) pega el enlace del archivo GRAL de la unidad,
 *      copiado de la barra del navegador (o solo su id): «Incidencias VV
 *      Gral» para Vía Verde, «Incidencias EV Gral» para Ecovallas Fijas y
 *      Digital. Nunca el de este mismo archivo.
 *   3. Guarda y recarga la hoja: aparece el menú «Incidencias app».
 *   4. Botón (opcional): Insertar → Dibujo → un rectángulo «Actualizar» →
 *      en el dibujo, ⋮ → Asignar secuencia de comandos →
 *      actualizarIncidencias
 *   La primera vez Google pide permiso para leer la base y editar esta
 *   hoja. Quien lo use necesita permiso de lector en la base.
 *
 * El código vive en el repo (scripts/sheets/ActualizarIncidenciasApp.gs,
 * con pruebas en tests/botonSheets.test.mjs): un cambio se hace ahí y se
 * vuelve a pegar en los tres archivos.
 * ============================================================
 */

// ⇩ Pega aquí el enlace (o solo el id) del archivo GRAL de esta unidad,
//   NO el de este archivo:
//     Vía Verde                    → «Incidencias VV Gral»
//     Ecovallas Fijas y Digital    → «Incidencias EV Gral»
const BASE_ID = '';

/** Pestaña de la base que llena la app. */
const PESTANA_BASE = 'App';

/**
 * Las copiadas a mano se ligan solo desde aquí: el 11-nov-2026 los folios
 * de Ecovallas y Vía Verde volvieron a empezar en 00001, y los del piloto
 * de junio (VV00001–10, EVD00008–16) son otras incidencias.
 */
const LIGAR_DESDE = new Date(2026, 10, 11);

/** Margen al comparar con la última actualización (relojes distintos). */
const MARGEN_MS = 60 * 60 * 1000;

/**
 * Una fila copiada a mano se liga solo si su fecha de reporte está a lo más
 * a estos días de la de la app: un comentario que MENCIONA otro folio
 * («duplicada de EVD00040») no debe quedarse con sus datos.
 */
const DIAS_PARA_LIGAR = 3;

/** Llaves de la base que son fecha u hora (se escriben como fecha/hora de esta hoja). */
const CLAVES_FECHA = ['fechareporte', 'fechadereparacion'];
const CLAVES_HORA = ['horareporte', 'horadereparacion'];

/** Estatus de la app → palabras de la hoja del equipo. */
function estatusEquipo(noReparado) {
  return {
    Reparado: 'Reparado',
    'No reparado': noReparado,
    'En proceso': 'En proceso',
    'Por validar': 'En proceso',
    Devuelta: 'En proceso',
    'Reparado por aprobar': 'En proceso',
    Reportado: 'En proceso',
  };
}

/**
 * Una configuración por hoja de trabajo. `columnas`: encabezado de la hoja
 * del equipo (normalizado: sin acentos, espacios ni signos) → de dónde sale:
 *   'llave'                         la columna de la base con ese nombre
 *   { base, mapa, vacio }           con cambio de palabras; `vacio` es lo que
 *                                   se pone en una fila NUEVA si la app no trae nada
 *   { fijo }                        siempre ese valor
 */
const CONFIGS = [
  {
    nombre: 'Vía Verde',
    pestana: '1ER TRIMESTRE 2026',
    filaEncabezados: 1,
    folioApp: /^VV\d{5}$/,
    buscarEnTexto: /\bVV\d{5}\b/,
    folioEquipo: { columna: 1, prefijo: 'VV', digitos: 4 },
    fecha: 'fechadereporte',
    columnas: {
      plaza: 'plaza',
      id: 'clavedesitio',
      cantidaddecolumnas: { fijo: 1 },
      lado: 'lado',
      // Semana ISO, como la de sus 970 filas (Erik, 24-nov-2026: «no puso la semana»).
      semana: { semanaIso: 'fechareporte' },
      fechadereporte: 'fechareporte',
      horadereporte: 'horareporte',
      // Su lista: Monitoreo, Comercial, Operación Digital, Programación
      // Digital, Soporte Digital, Digital (Erik, 24-nov-2026: SRD → Digital).
      areaquereporta: { base: 'areareportante', mapa: { SRD: 'Digital' } },
      incidencia: 'incidencia',
      campana: { base: 'campana', vacio: 'N/A' },
      detalledelaincidencia: 'detalledeincidencia',
      estatus1: { fijo: 'Reportado' },
      arearesponsabledereparacion: 'arearesponsable',
      arearesponsablederespuesta: { fijo: 'Digital' },
      detalledereparacion: 'detalledereparacion',
      estatusfinal: { base: 'estatusfinal', mapa: estatusEquipo('No Reparado') },
      fechadesolucion: 'fechadereparacion',
      horadesolucion: 'horadereparacion',
      clasificacion: 'afectacion',
      origendeincidencia: 'origendeincidencia',
      impactodeincidencia: 'niveldeincidencia',
      tipodeincidencia: 'causa',
    },
  },
  {
    nombre: 'Ecovallas Fijas',
    pestana: 'Ecovallas Fijas 2026',
    filaEncabezados: 1,
    // EV + 5 dígitos, sin EVD. El equipo usa EV10000 en adelante en FOLIO;
    // los de la app empiezan con 0 (EV00036) y van en «Folio App».
    folioApp: /^EV\d{5}$/,
    buscarEnTexto: /\bEV0\d{4}\b/,
    folioEquipo: { columna: 1, prefijo: 'EV', digitos: 4 },
    fecha: 'fechadereporte',
    columnas: {
      clavedesitio: 'clavedesitio',
      clavedevalla: 'clavedemedio',
      direccion: 'direccion',
      alcaldiamunicipio: 'alcaldia',
      plaza: { base: 'plaza', mapa: { México: 'Estado de México' } },
      cara: 'cara',
      catorcena: 'catorcena',
      fechadereporte: 'fechareporte',
      horadereporte: 'horareporte',
      // Erik, 24-nov-2026: «Operaciones» no tiene equivalente en esta hoja;
      // se deja para que la escriba el equipo.
      areaquereporta: { base: 'areareportante', mapa: { Operaciones: null } },
      viadereporte: 'viadereporte',
      incidencia: 'incidencia',
      detalledelaincidencia: 'detalledeincidencia',
      campana: 'campana',
      estatusinicial: { fijo: 'Reportado' },
      arearesponsable: 'arearesponsable',
      detalledereparacion: 'detalledereparacion',
      estatusfinal: { base: 'estatusfinal', mapa: estatusEquipo('No reparado') },
      fechadereparacion: 'fechadereparacion',
      horasdereparacion: 'horadereparacion',
      clasificacion: 'afectacion',
      niveldeincidencia: 'niveldeincidencia',
      origendeincidencia: 'origendeincidencia',
      tipodeincidencia1: 'causa',
    },
  },
  {
    nombre: 'Ecovallas Digital',
    pestana: 'Ecovallas Digitales 2026',
    filaEncabezados: 1,
    folioApp: /^EVD\d{5}$/,
    buscarEnTexto: /\bEVD\d{5}\b/,
    folioEquipo: { columna: 1, prefijo: 'EVD', digitos: 4 },
    fecha: 'fechadereporte',
    columnas: {
      clavedesitio: 'clavedesitio',
      clavedepantalla: 'clavedemedio',
      direccion: 'direccion',
      alcaldiaomunicipio: 'alcaldia',
      plaza: { base: 'plaza', mapa: { 'Ciudad de México': 'CDMX', México: 'Estado de México' } },
      catorcena: 'catorcena',
      fechadereporte: 'fechareporte',
      horadereporte: 'horareporte',
      // Erik, 24-nov-2026: SRD y Operaciones → Digital.
      areareportante: { base: 'areareportante', mapa: { SRD: 'Digital', Operaciones: 'Digital' } },
      viadereporte: 'viadereporte',
      // En esta hoja «Tipo de incidencia» guarda el nombre de la falla. Erik,
      // 24-nov-2026: las dos fallas de la app que no están en su lista se
      // quedan como las escribió el equipo (en fila nueva, vacías).
      tipodeincidencia: {
        base: 'incidencia',
        mapa: { 'Estructura con grafiti': null, 'Estructura dañada': null },
      },
      campana: { base: 'campana', vacio: 'N/A' },
      arearesponsablederespuesta: { fijo: 'Digital' },
      detalledelaincidencia: 'detalledeincidencia',
      estatusinicial: { fijo: 'Reportado' },
      arearesponsabledereparacion: 'arearesponsable',
      detalledereparacion: 'detalledereparacion',
      estatusfinal: { base: 'estatusfinal', mapa: estatusEquipo('No Reparado') },
      fechadereparacion: 'fechadereparacion',
      horadereparacion: 'horadereparacion',
      clasificacion: 'afectacion',
      niveldeincidencia: 'niveldeincidencia',
      origendeincidencia: 'origendeincidencia',
      tipodeincidencia1: 'causa',
      // Semana ISO, como la que llenaban hasta junio.
      semana: { semanaIso: 'fechareporte' },
    },
  },
];

// ------------------------------------------------------------
// Lógica pura (sin servicios de Google): se prueba con node --test.
// ------------------------------------------------------------

/** «Área que reporta» → «areaquereporta», igual que la app. */
function normalizar(h) {
  return String(h == null ? '' : h)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function vacio(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/** La configuración cuya pestaña existe en este archivo. */
function elegirConfig(nombresPestanas) {
  for (const c of CONFIGS) if (nombresPestanas.indexOf(c.pestana) >= 0) return c;
  return null;
}

/**
 * Filas de la base como objetos por encabezado normalizado. `convertir`
 * deja fechas como 'AAAA-MM-DD' y horas como 'HH:mm' (lo hace quien llama,
 * con la zona horaria de la base); `mostrados` son los textos tal como se
 * ven (getDisplayValues), para las horas.
 */
function leerBase(valores, convertir, mostrados) {
  if (!valores.length) return [];
  const claves = valores[0].map(normalizar);
  const filas = [];
  for (let i = 1; i < valores.length; i++) {
    const o = {};
    claves.forEach((k, j) => {
      const m = mostrados && mostrados[i] ? mostrados[i][j] : undefined;
      if (k) o[k] = convertir ? convertir(k, valores[i][j], m) : valores[i][j];
    });
    o.folio = String(o.folio == null ? '' : o.folio).trim();
    if (o.folio) filas.push(o);
  }
  return filas;
}

function tipoDe(llave, valor) {
  if (CLAVES_FECHA.indexOf(llave) >= 0) return 'fecha';
  if (CLAVES_HORA.indexOf(llave) >= 0) return 'hora';
  return typeof valor === 'number' ? 'numero' : 'texto';
}

/**
 * Qué escribir en una celda. null = no tocarla (la app no trae nada y no es
 * fila nueva con valor por omisión).
 */
function valorDe(fuente, b, esNueva) {
  if (fuente && typeof fuente === 'object' && 'fijo' in fuente) {
    return { valor: fuente.fijo, tipo: typeof fuente.fijo === 'number' ? 'numero' : 'texto' };
  }
  if (fuente && typeof fuente === 'object' && fuente.semanaIso) {
    const s = semanaIso(b[fuente.semanaIso]);
    return s === null ? null : { valor: s, tipo: 'numero' };
  }
  const llave = typeof fuente === 'string' ? fuente : fuente.base;
  const v = b[llave];
  if (vacio(v)) {
    if (esNueva && typeof fuente === 'object' && fuente.vacio !== undefined) {
      return { valor: fuente.vacio, tipo: 'texto' };
    }
    return null;
  }
  let valor = v;
  if (typeof fuente === 'object' && fuente.mapa && Object.prototype.hasOwnProperty.call(fuente.mapa, v)) {
    valor = fuente.mapa[v];
    // null en el mapa: ese valor no se escribe y la celda la llena el equipo.
    if (valor === null) return null;
  }
  return { valor, tipo: tipoDe(llave, valor) };
}

function relleno(n, digitos) {
  let s = String(n);
  while (s.length < digitos) s = '0' + s;
  return s;
}

/**
 * 'AAAA-MM-DD' → número de día de Sheets (días desde el 30-dic-1899). Se
 * escribe como número con el formato de fecha de la columna: así no
 * depende de zonas horarias.
 */
function serialFecha(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texto == null ? '' : texto).trim());
  if (!m) return null;
  return (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(1899, 11, 30)) / 86400000;
}

/**
 * Semana ISO (lunes a domingo; la semana 1 es la del primer jueves), la
 * que usan las hojas de los equipos (= ISOWEEKNUM). La de la app cuenta
 * distinto, por eso no se copia. 'AAAA-MM-DD' → número; null si no es fecha.
 */
function semanaIso(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texto == null ? '' : texto).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const dia = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dia); // el jueves de esa semana
  const inicio = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - inicio) / 86400000 + 1) / 7);
}

/** '9:03' o '09:03' (o '9:03:00') → 'HH:mm'; null si no es una hora. */
function horaDeTexto(texto) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(texto == null ? '' : texto).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return relleno(Number(m[1]), 2) + ':' + m[2];
}

/**
 * 'HH:mm' → fracción del día (9:03 → 0.377…). Con una fecha de 1899 Apps
 * Script recorre las horas unos minutos en la zona de México (horario
 * local de antes de 1922); como número, no.
 */
function fraccionHora(texto) {
  const h = horaDeTexto(texto);
  if (!h) return null;
  return (Number(h.slice(0, 2)) * 60 + Number(h.slice(3))) / 1440;
}

/** ¿La fecha de la fila (Date) está cerca de la de la app ('AAAA-MM-DD')? */
function fechaCercana(fechaFila, textoApp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(textoApp || ''));
  if (!(fechaFila instanceof Date) || !m) return false;
  const app = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const fila = new Date(fechaFila.getFullYear(), fechaFila.getMonth(), fechaFila.getDate());
  return Math.abs(fila - app) <= DIAS_PARA_LIGAR * 86400000;
}

/** Bloques de columnas seguidas ([desde, cuántas], base 0) a partir de { col: true }. */
function bloques(cols) {
  const lista = Object.keys(cols).map(Number).sort((a, b) => a - b);
  const salida = [];
  lista.forEach((c) => {
    const ult = salida[salida.length - 1];
    if (ult && c === ult[0] + ult[1]) ult[1]++;
    else salida.push([c, 1]);
  });
  return salida;
}

/** Índice (en `datos`) de la última fila con fecha de reporte; -1 si ninguna. */
function ultimaFilaReal(datos, colFecha) {
  for (let i = datos.length - 1; i >= 0; i--) if (!vacio(datos[i][colFecha])) return i;
  return -1;
}

/**
 * Decide qué escribir. No toca la hoja.
 *   encabezados   fila de encabezados de la hoja del equipo
 *   datos         filas debajo de los encabezados (valores)
 *   formulasCols  { índiceDeColumna: true } con fórmula en la última fila real
 *   base          leerBase(…)
 *   desde         ms: solo lo que la app cambió desde entonces (null = todo)
 */
function planear(p) {
  const cfg = p.cfg;
  const claves = p.encabezados.map(normalizar);
  const colFolioEq = cfg.folioEquipo.columna - 1;
  const colFecha = claves.indexOf(cfg.fecha);
  if (colFecha < 0) throw new Error('No encontré la columna de fecha de reporte en la fila de encabezados.');

  let colFolioApp = claves.indexOf('folioapp');
  const crearFolioApp = colFolioApp < 0;
  if (crearFolioApp) {
    let ult = claves.length - 1;
    while (ult >= 0 && vacio(p.encabezados[ult])) ult--;
    colFolioApp = ult + 1;
  }
  const filaHoja = (i) => p.filaEncabezados + 1 + i;

  // Columnas que llena la app (las de fórmula se respetan).
  const mapeo = [];
  const sinColumna = [];
  const calculadas = [];
  Object.keys(cfg.columnas).forEach((clave) => {
    const col = claves.indexOf(clave);
    if (col < 0) sinColumna.push(clave);
    else if (p.formulasCols[col]) calculadas.push(String(p.encabezados[col]).trim());
    else mapeo.push({ col, fuente: cfg.columnas[clave] });
  });

  // Lo que ya hay en la hoja.
  const reFolioEq = new RegExp('^' + cfg.folioEquipo.prefijo + '(\\d+)$');
  const porFolioApp = {};
  let ultimaReal = -1;
  let maxFolio = 0;
  p.datos.forEach((fila, i) => {
    if (!crearFolioApp) {
      const fa = String(fila[colFolioApp] == null ? '' : fila[colFolioApp]).trim();
      if (fa && porFolioApp[fa] === undefined) porFolioApp[fa] = i;
    }
    if (!vacio(fila[colFecha])) ultimaReal = i;
    const m = reFolioEq.exec(String(fila[colFolioEq] == null ? '' : fila[colFolioEq]).trim());
    if (m) maxFolio = Math.max(maxFolio, Number(m[1]));
  });

  // Copiadas a mano: el folio de la app escrito en cualquier otra celda.
  // Un folio puede aparecer en varias filas (una reasignación anotada como
  // fila nueva, o una fila que solo lo menciona). Solo se liga una fila
  // con PRUEBA de que es la misma incidencia: misma clave de pantalla/valla
  // o misma falla. Caso real (24-nov-2026): VV00005 estaba en VV0921
  // («Cámara desconectada», la buena) y en VV0923 («Falla en el medidor»,
  // otra del mismo sitio); con «la más reciente» se sobrescribió VV0923.
  const porTexto = {};
  p.datos.forEach((fila, i) => {
    if (!crearFolioApp && !vacio(fila[colFolioApp])) return;
    const f = fila[colFecha];
    if (!(f instanceof Date) || f.getTime() < LIGAR_DESDE.getTime()) return;
    for (let j = 0; j < fila.length; j++) {
      if (j === colFolioEq || j === colFolioApp || fila[j] instanceof Date) continue;
      const re = new RegExp(cfg.buscarEnTexto.source, 'g');
      const s = String(fila[j] == null ? '' : fila[j]);
      let m;
      while ((m = re.exec(s))) {
        const lista = (porTexto[m[0]] = porTexto[m[0]] || []);
        if (lista.indexOf(i) < 0) lista.push(i);
      }
    }
  });

  // Filas libres después de la última con datos (las preparadas con folio
  // o fórmulas); luego, filas nuevas al final.
  const libres = [];
  for (let i = ultimaReal + 1; i < p.datos.length; i++) if (vacio(p.datos[i][colFecha])) libres.push(i);

  const enBase = {};
  const procesar = p.base
    .filter((b) => cfg.folioApp.test(b.folio))
    .sort((a, b) => String(a.fechareporte || '').localeCompare(String(b.fechareporte || '')) || a.folio.localeCompare(b.folio));

  const escrituras = [];
  const nuevas = [];
  const ligadasLista = [];
  const coincidencias = [];
  const tambienEn = [];
  const revisar = [];
  const folioEqDe = (k) => String(p.datos[k][colFolioEq] == null ? '' : p.datos[k][colFolioEq]).trim();

  // Columnas de la hoja que dicen si una fila copiada a mano es la misma
  // incidencia: la clave de pantalla/valla y la falla.
  const colDe = (llaveBase) => {
    const k = Object.keys(cfg.columnas).find((c) => {
      const f = cfg.columnas[c];
      return f === llaveBase || (f && typeof f === 'object' && f.base === llaveBase);
    });
    return k ? claves.indexOf(k) : -1;
  };
  const colMedio = colDe('clavedemedio');
  const colIncidencia = colDe('incidencia');
  const igual = (a, b) => !vacio(a) && !vacio(b) && normalizar(a) === normalizar(b);
  const mismaIncidencia = (k, b) =>
    (colMedio >= 0 && igual(p.datos[k][colMedio], b.clavedemedio)) ||
    (colIncidencia >= 0 && igual(p.datos[k][colIncidencia], b.incidencia));
  // Filas que ya tienen dueño: las de «Folio App» desde el principio.
  const usadas = {};
  Object.keys(porFolioApp).forEach((f) => {
    usadas[porFolioApp[f]] = true;
  });
  const cuenta = { actualizadas: 0, ligadas: 0, nuevas: 0, duplicadas: 0, iguales: 0 };
  let siguiente = 0;
  let masAlla = p.datos.length;

  const escribirFila = (i, b, esNueva) => {
    mapeo.forEach((m) => {
      const v = valorDe(m.fuente, b, esNueva);
      if (v) escrituras.push({ fila: filaHoja(i), col: m.col, valor: v.valor, tipo: v.tipo });
    });
  };

  // A qué fila va cada folio, en pasadas, para que una forma de ligar no le
  // gane la fila a otra: 1) «Folio App»; 2) el folio escrito a mano;
  // 3) coincidencia de valla/sitio + falla + fecha; 4) lo demás, fila nueva.
  const destino = {};
  procesar.forEach((b) => {
    if (porFolioApp[b.folio] !== undefined) destino[b.folio] = { i: porFolioApp[b.folio], modo: 'folioapp' };
  });

  // 2) Escrito a mano.
  procesar.forEach((b) => {
    if (destino[b.folio]) return;
    const candidatas = (porTexto[b.folio] || []).filter(
      (k) => !usadas[k] && fechaCercana(p.datos[k][colFecha], b.fechareporte)
    );
    const buenas = candidatas.filter((k) => mismaIncidencia(k, b));
    if (buenas.length) {
      const i = buenas[buenas.length - 1];
      usadas[i] = true;
      destino[b.folio] = { i, modo: 'mencion' };
      candidatas.filter((k) => k !== i).forEach((k) => tambienEn.push(`${b.folio} también está en ${folioEqDe(k)}`));
    } else if (candidatas.length) {
      // Está escrito a mano, pero nada prueba que sea la misma incidencia:
      // ni se liga ni se crea otra fila. Lo decide el equipo.
      revisar.push(
        `${b.folio} («${b.incidencia || 'sin falla'}») está escrito en ${candidatas.map(folioEqDe).join(', ')}, ` +
          'pero no coincide la falla ni la clave'
      );
      destino[b.folio] = { revisar: true };
    }
  });

  // 3) Capturada a mano SIN el folio de la app (así trabaja Ecovallas Fijas;
  // 24-nov-2026 el botón duplicó 23 así): misma falla, fecha a un día o
  // menos, y misma valla/pantalla; si no, mismo sitio (los adicionales no
  // tienen valla). Solo filas desde el 11-nov, sin «Folio App» y que no
  // mencionen otro folio de la app.
  const colSitio = colDe('clavedesitio');
  const diaDe = (f) =>
    f instanceof Date ? Math.round((Date.UTC(f.getFullYear(), f.getMonth(), f.getDate()) - Date.UTC(1899, 11, 30)) / 86400000) : null;
  const diaDesde = diaDe(LIGAR_DESDE);
  const conMencion = {};
  Object.keys(porTexto).forEach((f) => porTexto[f].forEach((k) => (conMencion[k] = true)));
  const elegibles = [];
  for (let k = 0; k <= ultimaReal; k++) {
    if (usadas[k] || conMencion[k]) continue;
    const d = diaDe(p.datos[k][colFecha]);
    if (d !== null && d >= diaDesde) elegibles.push({ k, d });
  }
  ['medio', 'sitio'].forEach((pasada) => {
    procesar.forEach((b) => {
      if (destino[b.folio] || colIncidencia < 0) return;
      const d = serialFecha(b.fechareporte);
      if (d === null) return;
      const llave = pasada === 'medio' ? colMedio : colSitio;
      const valorApp = pasada === 'medio' ? b.clavedemedio : b.clavedesitio;
      if (llave < 0 || vacio(valorApp)) return;
      const cand = elegibles.filter(
        (x) =>
          !usadas[x.k] &&
          Math.abs(x.d - d) <= 1 &&
          igual(p.datos[x.k][colIncidencia], b.incidencia) &&
          igual(p.datos[x.k][llave], valorApp)
      );
      if (!cand.length) return;
      cand.sort((x, y) => Math.abs(x.d - d) - Math.abs(y.d - d) || x.k - y.k);
      usadas[cand[0].k] = true;
      destino[b.folio] = { i: cand[0].k, modo: 'coincidencia' };
    });
  });

  procesar.forEach((b) => {
    enBase[b.folio] = true;
    const duplicada = b.estatusfinal === 'Duplicada';
    const dest = destino[b.folio];
    if (dest && dest.revisar) return;

    if (dest) {
      const i = dest.i;
      usadas[i] = true;
      if (duplicada) {
        cuenta.duplicadas++;
        return;
      }
      const ligada = dest.modo !== 'folioapp';
      const cambio =
        ligada || p.desde == null || (b.actualizadoutc && Date.parse(b.actualizadoutc) >= p.desde);
      if (!cambio) {
        cuenta.iguales++;
        return;
      }
      if (ligada) {
        escrituras.push({ fila: filaHoja(i), col: colFolioApp, valor: b.folio, tipo: 'texto' });
        (dest.modo === 'mencion' ? ligadasLista : coincidencias).push(folioEqDe(i) + ' = ' + b.folio);
        cuenta.ligadas++;
      } else {
        cuenta.actualizadas++;
      }
      escribirFila(i, b, false);
      return;
    }

    if (duplicada) {
      cuenta.duplicadas++;
      return;
    }

    // Nueva: una fila preparada o una más al final.
    const idx = siguiente < libres.length ? libres[siguiente++] : masAlla++;
    const actual = idx < p.datos.length ? String(p.datos[idx][colFolioEq] == null ? '' : p.datos[idx][colFolioEq]).trim() : '';
    let folioEquipo = actual;
    if (!actual) {
      maxFolio++;
      folioEquipo = cfg.folioEquipo.prefijo + relleno(maxFolio, cfg.folioEquipo.digitos);
      escrituras.push({ fila: filaHoja(idx), col: colFolioEq, valor: folioEquipo, tipo: 'texto' });
    }
    escrituras.push({ fila: filaHoja(idx), col: colFolioApp, valor: b.folio, tipo: 'texto' });
    escribirFila(idx, b, true);
    usadas[idx] = true;
    nuevas.push({ fila: filaHoja(idx), folioEquipo, folioApp: b.folio, masAllaDeLosDatos: idx >= p.datos.length });
    cuenta.nuevas++;
  });

  const noEstan = Object.keys(porFolioApp).filter((f) => cfg.folioApp.test(f) && !enBase[f]);

  return {
    escrituras,
    nuevas,
    ligadasLista,
    coincidencias,
    tambienEn,
    revisar,
    enLaBase: p.base.length,
    deEstaHoja: procesar.length,
    crearFolioApp,
    colFolioApp,
    ultimaReal: ultimaReal >= 0 ? filaHoja(ultimaReal) : null,
    cuenta,
    sinColumna,
    calculadas,
    noEstan,
  };
}

/**
 * El valor como lo escribe la lista desplegable de la celda: sin importar
 * mayúsculas, acentos ni espacios («No reparado» → «No Reparado»). null =
 * no está en la lista.
 */
function ajustarALista(valor, lista) {
  const buscado = normalizar(valor);
  if (!buscado) return null;
  for (const item of lista) if (normalizar(item) === buscado) return item;
  return null;
}

/** Escrituras agrupadas por columna en tramos de filas seguidas (pocas llamadas). */
function tramos(escrituras) {
  const porCol = {};
  escrituras.forEach((e) => {
    (porCol[e.col] = porCol[e.col] || {})[e.fila] = e;
  });
  const salida = [];
  Object.keys(porCol).forEach((c) => {
    const filas = Object.keys(porCol[c]).map(Number).sort((a, b) => a - b);
    let tramo = null;
    filas.forEach((f) => {
      if (tramo && f === tramo.desde + tramo.celdas.length) tramo.celdas.push(porCol[c][f]);
      else {
        tramo = { col: Number(c), desde: f, celdas: [porCol[c][f]] };
        salida.push(tramo);
      }
    });
  });
  return salida;
}

/** El id de un enlace de Sheets («…/d/<id>/edit…») o el id tal cual. */
function idDeBase(texto) {
  const s = String(texto == null ? '' : texto).trim();
  const m = /\/d\/([A-Za-z0-9_-]+)/.exec(s);
  return m ? m[1] : s;
}

/** Aviso si BASE_ID es este mismo archivo (pasó el 24-nov-2026). null = está bien. */
function revisarMismoArchivo(cfg, idBase, idEste, nombreEste) {
  if (idBase !== idEste) return null;
  const gral = cfg.nombre === 'Vía Verde' ? 'Incidencias VV Gral' : 'Incidencias EV Gral';
  return (
    `BASE_ID es el de este mismo archivo («${nombreEste}»). Debe ser el de «${gral}», ` +
    'donde la app escribe sus folios. Corrígelo en Extensiones → Apps Script. No se cambió nada en esta hoja.'
  );
}

/**
 * ¿La base es la de esta hoja? null = sí; si no, el aviso para quien aprieta.
 * Caso real (24-nov-2026): con el BASE_ID de otra unidad el botón decía
 * «No había nada nuevo» y no se notaba por qué.
 */
function revisarBase(cfg, base, nombreBase) {
  if (!base.length) {
    return `La pestaña «App» de «${nombreBase}» no tiene folios todavía. La app la llena cada 5 minutos.`;
  }
  if (!base.some((b) => cfg.folioApp.test(b.folio))) {
    const ejemplo = base[0].folio;
    return (
      `«${nombreBase}» no tiene folios de ${cfg.nombre} (trae, por ejemplo, ${ejemplo}).\n` +
      'Revisa BASE_ID en Extensiones → Apps Script: Vía Verde lee «Incidencias VV Gral»; ' +
      'Ecovallas Fijas y Digital leen «Incidencias EV Gral». No se cambió nada en esta hoja.'
    );
  }
  return null;
}

/** El aviso final, en palabras. `extra`: { nombreBase, fallas: [{ columna, fila, mensaje }] }. */
function resumenTexto(cfg, plan, extra) {
  const c = plan.cuenta;
  const partes = [];
  if (c.nuevas) {
    const f = plan.nuevas.map((n) => n.folioEquipo);
    partes.push(`${c.nuevas} nueva(s): ${f.length > 1 ? f[0] + ' a ' + f[f.length - 1] : f[0]}`);
  }
  if (c.ligadas) partes.push(`${c.ligadas} ya copiada(s) a mano, ahora ligada(s) con su Folio App`);
  if (c.actualizadas) partes.push(`${c.actualizadas} actualizada(s)`);
  if (!partes.length) partes.push('No había nada nuevo');
  let t = `${cfg.nombre}: ${partes.join(' · ')}.`;
  const ex = extra || {};
  if (ex.nombreBase) {
    t += `\nBase: «${ex.nombreBase}», ${plan.deEstaHoja} folio(s) de esta hoja de ${plan.enLaBase} en «App».`;
  }
  if (plan.ligadasLista.length) {
    const muestra = plan.ligadasLista.slice(0, 15).join(', ');
    t += `\nLigadas (folio del equipo = folio de la app): ${muestra}${plan.ligadasLista.length > 15 ? '…' : ''}.`;
  }
  if (plan.coincidencias.length) {
    const muestra = plan.coincidencias.slice(0, 30).join(', ');
    t +=
      `\nLigadas por misma valla o sitio, falla y fecha (no tenían el folio de la app escrito; revísalas): ` +
      `${muestra}${plan.coincidencias.length > 30 ? '…' : ''}.`;
  }
  if (plan.tambienEn.length) t += `\nSin tocar: ${plan.tambienEn.join('; ')}.`;
  if (plan.revisar.length) {
    t +=
      `\nRevisar a mano (no se tocaron): ${plan.revisar.join('; ')}.` +
      '\n  Si es la misma incidencia, escribe el folio de la app en «Folio App» de esa fila; si no, bórralo de esa fila.';
  }
  if (ex.fallas && ex.fallas.length) {
    const grupos = {};
    ex.fallas.forEach((f) => {
      const clave = f.columna + '\u0000' + f.mensaje;
      const g = (grupos[clave] = grupos[clave] || { columna: f.columna, mensaje: f.mensaje, filas: [] });
      g.filas.push(f.fila);
    });
    t += '\nNo se escribió (lista desplegable o celda protegida); lo demás sí:';
    Object.keys(grupos).forEach((k) => {
      const g = grupos[k];
      t += `\n  · ${g.columna}: filas ${g.filas.slice(0, 10).join(', ')}${g.filas.length > 10 ? '…' : ''} — ${g.mensaje}`;
    });
    t += '\nSe vuelve a intentar en el siguiente «Actualizar».';
  }
  if (c.duplicadas) t += `\n${c.duplicadas} duplicada(s) en la app no se copian.`;
  if (plan.noEstan.length) t += `\nYa no están en la app (no se borraron aquí): ${plan.noEstan.join(', ')}.`;
  if (plan.sinColumna.length) t += `\nColumnas que no encontré: ${plan.sinColumna.join(', ')}.`;
  return t;
}

// ------------------------------------------------------------
// Lo que corre en Google Sheets.
// ------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Incidencias app')
    .addItem('Actualizar', 'actualizarIncidencias')
    .addItem('Actualizar todo (revisa todas)', 'actualizarTodo')
    .addToUi();
}

function actualizarIncidencias() {
  correr_(false);
}

function actualizarTodo() {
  correr_(true);
}

/**
 * Fechas y horas de la base. Las fechas se ven en la zona horaria de la
 * base; las horas se toman tal como se ven en la celda (con una fecha de
 * 1899, formatDate las recorre unos minutos en la zona de México).
 */
function convertirBase_(clave, v, tz, mostrado) {
  if (CLAVES_HORA.indexOf(clave) >= 0) {
    const h = horaDeTexto(mostrado);
    if (h) return h;
  }
  if (v instanceof Date) {
    if (CLAVES_FECHA.indexOf(clave) >= 0) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    if (CLAVES_HORA.indexOf(clave) >= 0) return Utilities.formatDate(v, tz, 'HH:mm');
    return Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ss");
  }
  return v;
}

/** Los valores que acepta una regla de lista desplegable; null si la regla es de otro tipo. */
function listaDe_(regla, cache) {
  const C = SpreadsheetApp.DataValidationCriteria;
  const tipo = regla.getCriteriaType();
  const valores = regla.getCriteriaValues();
  if (tipo === C.VALUE_IN_LIST) return (valores[0] || []).map(String);
  if (tipo === C.VALUE_IN_RANGE) {
    const r = valores[0];
    const clave = r.getSheet().getName() + '!' + r.getA1Notation();
    if (!cache[clave]) {
      cache[clave] = r
        .getValues()
        .reduce((a, fila) => a.concat(fila), [])
        .filter((x) => !vacio(x))
        .map(String);
    }
    return cache[clave];
  }
  return null;
}

/**
 * Valor para la celda de esta hoja. Fecha y hora van como número (la
 * columna les da su formato); el texto va con apóstrofo: nunca fórmula,
 * número ni fecha.
 */
function celda(e) {
  if (e.tipo === 'fecha') {
    const n = serialFecha(e.valor);
    if (n !== null) return n;
  }
  if (e.tipo === 'hora') {
    const n = fraccionHora(e.valor);
    if (n !== null) return n;
  }
  if (e.tipo === 'numero') return e.valor;
  const s = String(e.valor == null ? '' : e.valor);
  return s === '' ? '' : "'" + s;
}

/**
 * Formato de número para una columna de fecha u hora: el de esa columna en
 * la última fila real; si no tiene, uno de México.
 */
function formatoPara(tipo, formatoModelo) {
  const f = String(formatoModelo || '').trim();
  const sinFormato = !f || f === 'General' || f === '@' || f === '0' || /^0(\.0+)?$/.test(f);
  if (!sinFormato) return f;
  return tipo === 'hora' ? 'H:mm' : 'd/M/yyyy';
}

function correr_(todo) {
  const ui = SpreadsheetApp.getUi();
  if (!BASE_ID) {
    ui.alert('Falta pegar el id de la base en BASE_ID (Extensiones → Apps Script, arriba del código).');
    return;
  }
  const candado = LockService.getDocumentLock();
  if (!candado.tryLock(30000)) {
    ui.alert('Alguien más está actualizando esta hoja. Intenta en un minuto.');
    return;
  }
  try {
    const ss = SpreadsheetApp.getActive();
    const cfg = elegirConfig(ss.getSheets().map((s) => s.getName()));
    if (!cfg) {
      ui.alert('Este archivo no tiene ninguna de las pestañas configuradas: ' + CONFIGS.map((c) => c.pestana).join(', ') + '.');
      return;
    }
    const hoja = ss.getSheetByName(cfg.pestana);
    const inicio = Date.now();
    const props = PropertiesService.getDocumentProperties();
    const ultima = Number(props.getProperty('ultimaActualizacion') || 0);
    const desde = todo || !ultima ? null : ultima - MARGEN_MS;

    const idBase = idDeBase(BASE_ID);
    const mismo = revisarMismoArchivo(cfg, idBase, ss.getId(), ss.getName());
    if (mismo) {
      ui.alert(mismo);
      return;
    }

    ss.toast('Leyendo la base…', 'Incidencias app', 10);
    const libroBase = SpreadsheetApp.openById(idBase);
    const hojaBase = libroBase.getSheetByName(PESTANA_BASE);
    if (!hojaBase) {
      ui.alert(
        `«${libroBase.getName()}» no tiene la pestaña «${PESTANA_BASE}». BASE_ID debe ser el de ` +
          '«Incidencias VV Gral» (Vía Verde) o «Incidencias EV Gral» (Ecovallas).'
      );
      return;
    }
    const tzBase = libroBase.getSpreadsheetTimeZone();
    const nombreBase = libroBase.getName();
    const rangoBase = hojaBase.getDataRange();
    const base = leerBase(
      rangoBase.getValues(),
      (k, v, mostrado) => convertirBase_(k, v, tzBase, mostrado),
      rangoBase.getDisplayValues()
    );

    // Antes de tocar nada: que la base sea la de esta hoja.
    const problemaBase = revisarBase(cfg, base, nombreBase);
    if (problemaBase) {
      ui.alert(problemaBase);
      return;
    }

    const filaEnc = cfg.filaEncabezados;
    const ultimaFila = hoja.getLastRow();
    const ultimaCol = Math.max(hoja.getLastColumn(), 1);
    const encabezados = hoja.getRange(filaEnc, 1, 1, ultimaCol).getValues()[0];
    const datos = ultimaFila > filaEnc ? hoja.getRange(filaEnc + 1, 1, ultimaFila - filaEnc, ultimaCol).getValues() : [];

    const colFecha = encabezados.map(normalizar).indexOf(cfg.fecha);
    const ultimaReal = ultimaFilaReal(datos, colFecha);
    const formulasCols = {};
    let formulasModelo = [];
    // El formato de número de cada columna en la última fila real: las
    // fechas y horas nuevas se ven igual que las de arriba.
    let formatosModelo = [];
    if (ultimaReal >= 0) {
      formatosModelo = hoja.getRange(filaEnc + 1 + ultimaReal, 1, 1, ultimaCol).getNumberFormats()[0];
      formulasModelo = hoja.getRange(filaEnc + 1 + ultimaReal, 1, 1, ultimaCol).getFormulas()[0];
      formulasModelo.forEach((f, j) => {
        if (f) formulasCols[j] = true;
      });
    }

    const plan = planear({ cfg, encabezados, datos, formulasCols, base, desde, filaEncabezados: filaEnc });

    // Columna «Folio App».
    if (plan.crearFolioApp) {
      if (plan.colFolioApp + 1 > hoja.getMaxColumns()) hoja.insertColumnsAfter(hoja.getMaxColumns(), plan.colFolioApp + 1 - hoja.getMaxColumns());
      const celdaEnc = hoja.getRange(filaEnc, plan.colFolioApp + 1);
      if (plan.colFolioApp > 0) hoja.getRange(filaEnc, plan.colFolioApp).copyTo(celdaEnc, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      celdaEnc.setValue('Folio App');
    }

    // Filas nuevas: que existan, con el formato y las fórmulas de la última fila real.
    if (plan.nuevas.length) {
      const maxFila = Math.max(...plan.nuevas.map((n) => n.fila));
      if (maxFila > hoja.getMaxRows()) hoja.insertRowsAfter(hoja.getMaxRows(), maxFila - hoja.getMaxRows());
      if (plan.ultimaReal) {
        const modelo = hoja.getRange(plan.ultimaReal, 1, 1, ultimaCol);
        const grupos = bloques(formulasCols);
        plan.nuevas.forEach((n) => {
          const destino = hoja.getRange(n.fila, 1, 1, ultimaCol);
          if (n.masAllaDeLosDatos) modelo.copyTo(destino, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
          // Las preparadas ya traen sus fórmulas; si les falta alguna, se copian todas.
          const actuales = n.masAllaDeLosDatos ? [] : destino.getFormulas()[0];
          const falta = Object.keys(formulasCols).some((j) => !actuales[j]);
          if (!falta) return;
          grupos.forEach(([desde, cuantas]) => {
            hoja
              .getRange(plan.ultimaReal, desde + 1, 1, cuantas)
              .copyTo(hoja.getRange(n.fila, desde + 1, 1, cuantas), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
          });
        });
      }
    }

    const fallas = [];
    const nombreCol = (col) => (col === plan.colFolioApp ? 'Folio App' : String(encabezados[col] || '').trim() || 'columna ' + (col + 1));

    // Antes de escribir: las celdas con lista desplegable. Si el valor de
    // la app está en la lista (sin importar mayúsculas ni acentos) se
    // escribe como lo dice la lista; si no está y la lista rechaza otros
    // valores, esa celda no se escribe y se avisa. Caso real (24-nov-2026):
    // «SRD» en «ÁREA QUE REPORTA» de Vía Verde.
    const listas = {};
    const aEscribir = [];
    tramos(plan.escrituras).forEach((t) => {
      let reglas = [];
      try {
        reglas = hoja.getRange(t.desde, t.col + 1, t.celdas.length, 1).getDataValidations();
      } catch (err) {
        reglas = [];
      }
      t.celdas.forEach((e, k) => {
        const regla = reglas[k] && reglas[k][0];
        const lista = regla && (e.tipo === 'texto' || e.tipo === 'numero') ? listaDe_(regla, listas) : null;
        if (!lista) {
          aEscribir.push(e);
          return;
        }
        const ajustado = ajustarALista(e.valor, lista);
        if (ajustado !== null) aEscribir.push({ ...e, valor: ajustado, tipo: 'texto' });
        else if (regla.getAllowInvalid()) aEscribir.push(e);
        else {
          fallas.push({
            columna: nombreCol(e.col),
            fila: e.fila,
            // Sin la lista entera: en Digital son ~150 opciones y tapaban el aviso.
            mensaje: `«${e.valor}» no está en su lista desplegable (${lista.length} opciones)`,
          });
        }
      });
    });

    // Escrituras, por tramos de filas seguidas. Sheets guarda los cambios y
    // los aplica después: sin flush(), un error saldría hasta el final del
    // script, fuera de este try. Si un tramo falla, se intenta celda por celda.
    tramos(aEscribir).forEach((t) => {
      const valores = t.celdas.map((e) => [celda(e)]);
      const tipo = t.celdas[0].tipo;
      // Fecha y hora van como número: sin su formato se verían como 46350
      // o 0.7069 (pasó en «HORAS DE REPARACIÓN» de Fijas). Se pone el
      // formato después de escribir, también en el camino celda por celda.
      const formato = tipo === 'fecha' || tipo === 'hora' ? formatoPara(tipo, formatosModelo[t.col]) : null;
      try {
        const rango = hoja.getRange(t.desde, t.col + 1, t.celdas.length, 1);
        rango.setValues(valores);
        if (formato) rango.setNumberFormat(formato);
        SpreadsheetApp.flush();
      } catch (err) {
        valores.forEach((v, k) => {
          try {
            const una = hoja.getRange(t.desde + k, t.col + 1);
            una.setValue(v[0]);
            if (formato) una.setNumberFormat(formato);
            SpreadsheetApp.flush();
          } catch (err2) {
            fallas.push({ columna: nombreCol(t.col), fila: t.desde + k, mensaje: String((err2 && err2.message) || err2) });
          }
        });
      }
    });

    // Con celdas que no entraron no se marca la hora: el siguiente
    // «Actualizar» vuelve a intentarlas.
    if (!fallas.length) props.setProperty('ultimaActualizacion', String(inicio));
    ui.alert(resumenTexto(cfg, plan, { nombreBase, fallas }));
  } finally {
    candado.releaseLock();
  }
}
