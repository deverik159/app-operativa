// ============================================================
// src/lib/colaFotos/adaptadorComp.ts
// La COLA DE FOTOS de Comprobaciones (fase 3, incremento 2, 26-oct-2026):
// el adaptador del núcleo (nucleo.ts) para las tomas de comp_tomas, y la API
// que usan Mis rutas › Comprobaciones, el aviso global (EnviosPendientes),
// el aviso breve y el cierre de sesión.
//
// POR QUÉ ASÍ (especificación §4.2 2c, §5.2, §6.1 y §7):
//   · Base IndexedDB y canal PROPIOS ('gpo-tomas-comp'), candados 'compt-' y
//     'compt-registro-', etiquetas 'tomasComp.*' y trabajos {tipo:'comp', v:1}:
//     la cola de Pauta ('gpo-tomas') nunca ve estos trabajos ni al revés.
//   · El trabajo es la VISITA correo|unidad|sitio_clave|día. Cada foto lleva
//     las tomas que eligió la hoja «¿de cuál?» (A1: el servidor liga
//     exactamente ésas) y su respuesta por toma.
//   · Ligar = comp_subir_foto, idempotente por cliente_id: un reintento
//     contesta `ya` y no duplica. La ruta de Storage se fija al encolar y
//     lleva el cliente_id (B4: la base la valida parte por parte).
//   · Quitar = comp_quitar_foto y DESPUÉS storage.remove con tope (la
//     política de Storage no deja borrar un objeto que una fila usa). Si la
//     base no deja quitarla entera (una toma ya enviada o revisada), la foto
//     vuelve a la tarjeta y se quita de cada toma abierta (seQuedaArriba).
//     Quitarla de su última liga borra la fila (borrada + path): la foto se
//     queda en la tarjeta «sin fila» (sinFila), igual que una foto nueva que
//     ninguna toma aceptó (la base no le creó fila), y «Usar también para…»
//     la puede ligar a otra. Su objeto se borra al soltar o descartar la
//     visita, o con «Quitar» entera.
//   · Registro automático (B11): cada toma se registra sola cuando su
//     plantilla está completa y sus fotos ligadas; «Listo con este sitio»
//     registra lo que se pueda y dice lo que falta. La base cuenta.
//   · Regreso sin reloj: antes de registrar se lee comp_estado_tomas; si
//     `regreso_n` no es el que vio la pantalla, la analista devolvió la toma
//     después de las fotos y se pide atención. Si una toma no vuelve, antes
//     de concluir «ya no es tuya» se valida la sesión con getUser.
//   · Transitorio (§5.2): sin red, {codigo:'ocupada'}, 55P03, 57014 y 40P01
//     → reintento con espera, sin atención. `sin_objeto` → subir otra vez.
//     `captura_cerrada` → atención. CP001 → sesión. CP002/CP003/CP005 →
//     atención y reportarError (no debe pasar). Nunca se lee el texto del error.
// ============================================================
import { sb } from '../supabase';
import { diaCdmx } from '../fechasCdmx';
import {
  ESPERA_SESION_INTERACTIVA_MS,
  SinRed,
  SinSesion,
  esFallaRedPg,
  exigirSesion,
  tope,
} from '../envios';
import type { UnidadComp } from '../unidadesComp';
import type { MomentoPos } from '../plantillasComp';
import { diaCorto, nombreToma, type TomaMia } from '../misTomasComp';
import {
  ESPERA_ESCRITURA_MS,
  ESPERA_LECTURA_MS,
  Ocupada,
  crearColaFotos,
  type AdaptadorCola,
  type AvisoCola,
  type Herramientas,
  type ResultadoLigar,
  type ResultadoRegistro,
} from './nucleo';
import { esFinal, extensionDe, gruposParaCompartir, porSubir, tipoDeArchivo } from './logica';
import {
  claveUsableEnRuta,
  claveVisita,
  cuentaEnToma,
  estadoDeVisita,
  extensionComp,
  firmaToma,
  leerEstadoTomas,
  leerRespQuitar,
  leerRespRegistrar,
  leerRespSubirFoto,
  nombreParaCompartirComp,
  ocupaCampana,
  pasarACamara,
  porLigar,
  reaplicarCamara,
  puedeSoltarVisita,
  razonNoLigada,
  resolverLiga,
  rutaFotoComp,
  slugUnidad,
  tomaAbierta,
  textoFaltan,
  textoLogroComp,
  textoNoLigada,
  tomasPorRegistrar,
  type ArchivoComp,
  type EstadoServidorToma,
  type EstadoVisita,
  type FinRegistro,
  type LogroComp,
  type TomaEnVisita,
  type TrabajoComp,
} from './logicaComp';

export type { ArchivoComp, EstadoVisita, LogroComp, TrabajoComp } from './logicaComp';
export type { AvisoCola, TipoAviso, ResumenAvisoCola, ResumenVueltaCola } from './nucleo';
export { textoLogroComp, gruposParaCompartir };

// ------------------------------------------------------------
// Nombres de infraestructura (§7): nunca los de Pauta
// ------------------------------------------------------------

export const BASE_COMP = 'gpo-tomas-comp';
export const CANAL_COMP = 'gpo-tomas-comp';
export const CANDADO_COMP = 'compt-';
export const CANDADO_REGISTRO_COMP = 'compt-registro-';

/** Tope de comp_registrar_tomas y comp_estado_tomas (§4.2 2c). */
const MAX_TOMAS_REGISTRO = 200;

/** Cuánto espera «Listo con este sitio» a la cola antes de contestar (como «Registrar toma» de Pauta). */
const ESPERA_CIERRE_MS = 8000;

/** §5.2: el texto de la captura cerrada (comp_piloto). */
export const TEXTO_CAPTURA_CERRADA = 'La captura aún no está abierta para tu cuenta.';
const TEXTO_FALTA_MIGRACION = 'La base todavía no acepta fotos de Comprobaciones (falta su migración). Avisa a Erik.';

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase();

// ------------------------------------------------------------
// Errores de la base (§5.2): por código, nunca por texto
// ------------------------------------------------------------

export type ClaseFallaComp = 'red' | 'ocupada' | 'sin_sesion' | 'datos' | 'falta_migracion' | 'otro';

type ErrPg = { code?: string; message?: string } | null | undefined;

/** Clase de una falla de PostgREST/Postgres por su código y su status. */
export function claseFallaComp(error: ErrPg, status: number): ClaseFallaComp {
  const code = error?.code || '';
  // Antes que la red: 57014 y 40P01 también son «transitorios» para
  // esFallaRedPg, pero son de la base ocupada (no cortan la vuelta).
  if (code === '55P03' || code === '57014' || code === '40P01') return 'ocupada';
  if (esFallaRedPg(error ?? null, status)) return 'red';
  if (code === 'CP001') return 'sin_sesion';
  if (code === 'CP002' || code === 'CP003' || code === 'CP005') return 'datos';
  if (code === 'PGRST202' || code === '42883' || code === 'PGRST205' || code === '42P01') return 'falta_migracion';
  return 'otro';
}

/**
 * ¿Se reintenta solo? (§5.2): sin red, {ok:false, codigo:'ocupada'},
 * 55P03, 57014 y 40P01. Lo demás pide atención o algo distinto.
 */
export function esTransitorioComp(r: { error?: ErrPg; status?: number; data?: unknown }): boolean {
  if (r.error) {
    const c = claseFallaComp(r.error, r.status ?? 0);
    return c === 'red' || c === 'ocupada';
  }
  const d = r.data as { ok?: unknown; codigo?: unknown } | null | undefined;
  return !!d && d.ok === false && d.codigo === 'ocupada';
}

type Llamada = { data: unknown } | { falla: Exclude<ClaseFallaComp, 'red' | 'ocupada' | 'sin_sesion'>; error: ErrPg };

/**
 * Una RPC con tope. Lo transitorio LANZA (SinRed, Ocupada) para que el
 * núcleo reintente; CP001 lanza SinSesion (si la sesión del teléfono es de
 * otra cuenta, OtraCuenta). Lo demás vuelve como `falla`.
 */
async function llamar(nombre: string, args: Record<string, unknown>, email: string, ms = ESPERA_ESCRITURA_MS): Promise<Llamada> {
  let r: { data: unknown; error: ErrPg; status: number };
  try {
    r = (await sb.rpc(nombre, args).abortSignal(tope(ms))) as unknown as typeof r;
  } catch (err) {
    throw err instanceof SinRed ? err : new SinRed(String((err as Error)?.message || err));
  }
  if (!r.error) return { data: r.data };
  const c = claseFallaComp(r.error, r.status);
  if (c === 'red') throw new SinRed(r.error.message || 'Sin señal');
  if (c === 'ocupada') throw new Ocupada();
  if (c === 'sin_sesion') {
    await exigirSesion(ESPERA_SESION_INTERACTIVA_MS, email);
    throw new SinSesion();
  }
  return { falla: c, error: r.error };
}

// ------------------------------------------------------------
// Ayudantes
// ------------------------------------------------------------

/** UUID v4 con guiones (la base compara el cliente_id en texto dentro de la ruta). */
export function nuevoClienteId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID().toLowerCase();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x: number) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const hoyTelefono = () => diaCdmx(new Date());

function esTrabajoComp(x: unknown): x is TrabajoComp {
  const t = x as TrabajoComp | null;
  return !!t && t.tipo === 'comp' && t.v === 1 && typeof t.id === 'string' && Array.isArray(t.archivos) && Array.isArray(t.tomas);
}

const nombreDe = (t: TrabajoComp, id: number) => t.tomas.find((x) => x.id === id)?.nombre ?? `la toma ${id}`;

/** Cambios a las tomas de la visita (en una transacción). */
function cambiarTomas(t: TrabajoComp, cambios: Map<number, Partial<TomaEnVisita>>): TrabajoComp {
  for (const x of t.tomas) {
    const c = cambios.get(x.id);
    if (c) Object.assign(x, c);
  }
  return t;
}

// ------------------------------------------------------------
// El adaptador
// ------------------------------------------------------------

/** Resultado del último «Listo con este sitio» por visita (lo lee cerrarVisita). */
const cierres = new Map<string, { enviadas: number[]; faltan: FaltanToma[]; sinEnviar: { toma_id: number; razon: FinRegistro }[] }>();
/** Visitas cuyo cierre el monitorista está viendo en pantalla: su «Falta…» no va al buzón. */
const cierreEnPantalla = new Set<string>();

export type FaltanToma = { toma_id: number; nombre: string; texto: string; faltan: { pos: string; momento: MomentoPos; etiqueta: string; n: number; tiene: number }[] };

/** comp_estado_tomas(p_ids): null si la base no la tiene o contestó algo raro. */
async function leerEstado(ids: number[], email: string, h: Herramientas<TrabajoComp>): Promise<EstadoServidorToma[] | null> {
  const r = await llamar('comp_estado_tomas', { p_ids: ids }, email, ESPERA_LECTURA_MS);
  if ('falla' in r) {
    h.reportar('estado', r.error, { code: r.error?.code });
    return null;
  }
  return leerEstadoTomas(r.data);
}

/** Ligas que el servidor ya quitó (foto entera o de una toma): el aviso global relee la lista al cambiar. */
let quitadas = 0;
export function quitadasHastaAhora(): number {
  return quitadas;
}

/**
 * cliente_id de las fotos que de verdad se quitaron en esta sesión de la app
 * («Quitar» entera ya confirmada por la base, o que nunca llegó al servidor).
 * POR QUÉ (27-oct-2026): la pantalla saca la copia de cámara de «Guardar en
 * Fotos» al ver la lápida firme, pero si la visita se suelta en la misma
 * corrida (lee la cola 250 ms después del último aviso) ya no la ve: lo
 * consulta aquí (capturaComp.camaraPorSacar).
 */
const quitadasDeVerdad = new Set<string>();
export function fotosQuitadasDeVerdad(): ReadonlySet<string> {
  return quitadasDeVerdad;
}

/**
 * comp_quitar_foto SIN toma no dejó quitar la foto entera (`enviada`,
 * `revisada`, `sin_permiso`, otro código, o `falla` = null).
 *
 * POR QUÉ (26-oct-2026): antes el archivo se quedaba como 'quitado' (fuera de
 * la tarjeta) pero sus ligas seguían vivas: un copete ligado a Tecate (ya
 * enviada) y a Suburbia (abierta) desaparecía de la vista, la casilla de
 * Suburbia salía con ✓ sin foto y la cola registraba Suburbia con la foto
 * equivocada. Ahora la foto vuelve a la tarjeta ('ligado') y se quita toma
 * por toma de las que siguen abiertas (pasoExtra con p_toma_id); solo la
 * enviada o revisada se queda con ella, y el aviso dice cuál.
 */
async function seQuedaArriba(t: TrabajoComp, a: ArchivoComp, codigo: string | null, h: Herramientas<TrabajoComp>): Promise<void> {
  const ligadas = [...new Set([...a.toma_ids.filter((id) => cuentaEnToma(a, id)), ...(a.desligar ?? [])])];
  const por =
    codigo === 'revisada'
      ? 'la analista ya la revisó'
      : codigo === 'enviada'
        ? 'ya se envió'
        : codigo === 'sin_permiso'
          ? 'no la subiste tú'
          : 'el servidor no dejó';
  if (!ligadas.length) {
    // Sin tomas conocidas (un registro remoto de una visita ya cerrada): nada que mostrar ni que desligar.
    h.avisar(t.email, {
      tipo: codigo === null ? 'error' : 'info',
      clave: t.clave,
      texto: `${t.sitio_clave}: la foto ${a.n} no se pudo quitar del servidor: ${por}.`,
    });
    await h.actualizar(t.id, (x) => {
      const y = x.archivos.find((z) => z.fid === a.fid);
      if (!y) return null;
      delete y.limpiar;
      return x;
    });
    return;
  }
  // Las que esta visita ve abiertas se intentan quitar una por una (la base
  // decide); las demás (enviadas, cerradas…) se quedan con la foto.
  const abierta = (id: number) => {
    const x = t.tomas.find((y) => y.id === id);
    return !x || tomaAbierta(x);
  };
  const quitarDe = ligadas.filter(abierta);
  const quedaEn = ligadas.filter((id) => !quitarDe.includes(id));
  await h.actualizar(t.id, (x) => {
    const y = x.archivos.find((z) => z.fid === a.fid);
    if (!y || y.estado !== 'quitado') return null;
    delete y.limpiar;
    y.estado = 'ligado';
    y.arriba = true;
    // Solo las que el servidor ya contestó (lo que no se alcanzó a ligar ya no se liga).
    y.toma_ids = y.toma_ids.filter((id) => !!y.resueltas[String(id)] && !quitarDe.includes(id));
    for (const id of quedaEn) {
      if (!y.toma_ids.includes(id)) y.toma_ids.push(id);
      y.resueltas[String(id)] = 'ligada';
    }
    if (quitarDe.length) y.desligar = quitarDe;
    else delete y.desligar;
    return x;
  });
  if (quedaEn.length)
    h.avisar(t.email, {
      tipo: 'info',
      clave: t.clave,
      texto: `${t.sitio_clave}: la foto ${a.n} se queda en ${quedaEn.map((id) => nombreDe(t, id)).join(', ')}: ${por}${
        quitarDe.length ? '; de las demás se quita' : ''
      }.`,
    });
  else if (codigo === null)
    h.avisar(t.email, {
      tipo: 'error',
      clave: t.clave,
      texto: `${t.sitio_clave}: la foto ${a.n} no se pudo quitar entera del servidor; se intenta quitarla de cada toma.`,
    });
}

/**
 * Foto sin fila en la base (`sinFila`), ya sin nada por
 * ligar ni por desligar y sin contar en ninguna toma: su objeto está suelto.
 */
function sueltaSinFila(a: ArchivoComp): boolean {
  return (
    a.estado === 'ligado' &&
    !!a.sinFila &&
    !a.desligar?.length &&
    !porLigar(a).length &&
    !a.toma_ids.some((id) => cuentaEnToma(a, id))
  );
}

/**
 * La foto suelta que hay que volver lápida porque la visita ya se suelta
 * (cerrada, de otro día o sin tomas abiertas). POR QUÉ (26-oct-2026): «Quitar
 * de A» de su última liga ya no la borra en ese momento (el monitorista pidió
 * quitarla SOLO de A y podía usarla para otra versión), pero al soltar la
 * visita nadie más borraría su objeto.
 */
const sueltaAlSoltar = (t: TrabajoComp) => (puedeSoltarVisita(t, hoyTelefono()) ? t.archivos.find(sueltaSinFila) : undefined);

const adaptador: AdaptadorCola<TrabajoComp, ArchivoComp, LogroComp> = {
  nombreBase: BASE_COMP,
  canal: CANAL_COMP,
  prefijoCandado: CANDADO_COMP,
  prefijoRegistro: CANDADO_REGISTRO_COMP,
  etiqueta: 'tomasComp',
  riesgo: 'una foto de comprobación',
  esTrabajo: esTrabajoComp,
  donde: (t) => `${t.sitio_clave} · ${diaCorto(t.fecha)}`,

  async ligar(t, a, h): Promise<ResultadoLigar<ArchivoComp>> {
    const pedidas = porLigar(a);
    if (!pedidas.length) return { tipo: 'ok', cambio: (x) => porLigar(x).length === 0 };
    const r = await llamar(
      'comp_subir_foto',
      {
        p_cliente_id: a.cliente_id,
        p_path: a.path,
        p_toma_ids: pedidas,
        p_tipo: a.tipo,
        p_pos: a.pos,
        p_momento: a.momento,
        p_tomada_en: a.tomada_en_tel,
        p_lat: a.lat,
        p_lng: a.lng,
        p_precision: a.precision_m,
      },
      t.email
    );
    if ('falla' in r) {
      h.reportar('ligar', r.error, { code: r.error?.code }, a.path);
      if (r.falla === 'falta_migracion') return { tipo: 'atencion', mensaje: TEXTO_FALTA_MIGRACION };
      return {
        tipo: 'definitivo',
        mensaje: `La foto ${a.n} no se pudo ligar: el servidor la rechazó${r.error?.code ? ` (${r.error.code})` : ''}. Avisa a Erik`,
      };
    }
    const d = leerRespSubirFoto(r.data);
    if (!d) {
      h.reportar('ligar', new Error('respuesta que no se entiende'), undefined, a.path);
      return { tipo: 'definitivo', mensaje: `La foto ${a.n} no se pudo ligar: la base contestó algo que esta versión no entiende. Actualiza la app` };
    }
    if (!d.ok) {
      switch (d.codigo) {
        case 'ocupada':
          throw new Ocupada();
        case 'sin_objeto': {
          if (a.remoto) {
            // POR QUÉ (27-oct-2026): un registro remoto («Usar también para…»
            // de una foto cuya visita ya salió de la cola) no tiene copia que
            // volver a subir: sin fila y sin objeto, la foto ya se quitó del
            // servidor (la cola la borró al soltar la visita, o se quitó en otra
            // pestaña). Antes quedaba 'fallido' con «vuelve a tomarla» y la
            // visita pedía atención en cada vuelta. Se quita el registro (el
            // núcleo ya no lo encuentra y no aplica `cambio`) y se avisa.
            await h.actualizar(t.id, (x) => {
              const quedan = x.archivos.filter((z) => z.fid !== a.fid);
              if (quedan.length === x.archivos.length) return null;
              x.archivos = quedan;
              return x;
            });
            return {
              tipo: 'ok',
              cambio: () => true,
              avisos: [
                {
                  tipo: 'info',
                  clave: t.clave,
                  texto: `${t.sitio_clave}: no se pudo usar la foto en ${pedidas.map((id) => nombreDe(t, id)).join(', ')}. ${TEXTO_FOTO_YA_QUITADA}`,
                },
              ],
            };
          }
          // El archivo no está en Storage a nombre de quien llama. Con
          // `sin_objeto` la base NO creó la fila (§4.2 2c, paso 5), así que
          // es seguro estrenar cliente_id y ruta: subir a la MISMA ruta no
          // serviría (lib/envios recuerda en la pestaña lo que ya subió y
          // contestaría «ya está» sin subir nada).
          const n = (a.sinObjeto || 0) + 1;
          if (n > 2) return { tipo: 'definitivo', mensaje: `El archivo de la foto ${a.n} no llegó al servidor; vuelve a tomarla` };
          const nuevo = nuevoClienteId();
          return {
            tipo: 'subirOtraVez',
            cambio: (x) => {
              x.sinObjeto = n;
              x.path = x.path.replace(x.cliente_id, nuevo);
              x.cliente_id = nuevo;
            },
          };
        }
        case 'captura_cerrada':
          return { tipo: 'atencion', mensaje: TEXTO_CAPTURA_CERRADA };
        default:
          h.reportar('ligar', new Error(`codigo ${d.codigo}`), undefined, a.path);
          return { tipo: 'definitivo', mensaje: `La foto ${a.n} no se pudo ligar (${d.codigo})` };
      }
    }
    // Una posición que en esa toma va por cámara también llega en
    // `duplicadas` (29-oct-2026): resolverLiga la separa ('por_camara').
    const resol = resolverLiga(pedidas, d, (id) => !!t.tomas.find((x) => x.id === id)?.por_camara?.includes(a.pos));
    // Lo que no se ligó: se avisa una vez por foto y toma. Un reintento de
    // una liga vigente llega en `ligadas`; una 'duplicada' (devuelta, B4, u
    // otro día de la campaña, A1) nunca cuenta y siempre se avisa.
    const avisos: AvisoCola[] = [];
    const avisadas: number[] = [];
    const cambiosTomas = new Map<number, Partial<TomaEnVisita>>();
    for (const id of pedidas) {
      const que = resol[String(id)];
      if (que === 'ligada') continue;
      if (que === 'ajena' || que === 'cerrada' || que === 'futura') cambiosTomas.set(id, { reg: que });
      if (a.avisadas?.includes(id)) continue;
      avisadas.push(id);
      avisos.push({
        tipo: 'info',
        clave: t.clave,
        texto: `${t.sitio_clave}: la foto ${a.n} no cuenta para ${nombreDe(t, id)}: ${textoNoLigada(
          razonNoLigada(que, t.tomas.find((x) => x.id === id), a.pos)
        )}.`,
      });
    }
    if (cambiosTomas.size) await h.actualizar(t.id, (x) => cambiarTomas(x, cambiosTomas));
    // Por cámara (29-oct-2026): esa posición ya no se pide en esa toma; lo
    // demás de campo sigue y la toma se registra sola al completarlo.
    const aCamara = pedidas.filter((id) => resol[String(id)] === 'por_camara');
    if (aCamara.length)
      await h.actualizar(t.id, (x) => {
        let cambio = false;
        for (const y of x.tomas) if (aCamara.includes(y.id)) cambio = pasarACamara(y, a.pos) || cambio;
        return cambio ? x : null;
      });
    return {
      tipo: 'ok',
      avisos,
      cambio: (x) => {
        for (const [k, v] of Object.entries(resol)) {
          x.resueltas[k] = v;
          // La quitaron de esa toma mientras se ligaba: que la cola la desligue.
          if (!x.toma_ids.includes(Number(k)) && v === 'ligada')
            x.desligar = [...new Set([...(x.desligar ?? []), Number(k)])];
        }
        x.ya = x.ya || d.ya;
        // Con fila otra vez (o nunca se borró): ya no es una foto sin fila.
        // POR QUÉ también se PONE (27-oct-2026): una foto NUEVA que ninguna
        // toma aceptó (todas cerradas, futuras o ajenas) tampoco tiene fila: la
        // base no la crea y su objeto queda suelto. Sin la marca nadie lo
        // borraba al soltar o descartar la visita. Con una fila ya conocida
        // (`x.evidencia_id`) y evidencia_id null («ninguna toma existe ya») no.
        if (d.evidencia_id != null) delete x.sinFila;
        else if (x.evidencia_id == null) x.sinFila = true;
        x.evidencia_id = d.evidencia_id ?? x.evidencia_id ?? null;
        x.fecha_servidor = d.fecha ?? x.fecha_servidor ?? null;
        delete x.sinObjeto;
        if (avisadas.length) x.avisadas = [...new Set([...(x.avisadas ?? []), ...avisadas])];
        return porLigar(x).length === 0;
      },
    };
  },

  async limpiar(t, a, h): Promise<void> {
    await exigirSesion(undefined, t.email);
    // Con un token a medio renovar la RPC diría CP001 y Storage no borraría
    // nada sin error: primero la sesión real.
    await h.sesionValida(t.email);
    const listo = () =>
      h.actualizar(t.id, (x) => {
        const y = x.archivos.find((z) => z.fid === a.fid);
        if (!y) return null;
        delete y.limpiar;
        return x;
      });
    if (a.limpiar === 'objeto') {
      // Descartado: la política solo deja borrar el objeto si ninguna fila lo usa.
      if (a.sinFila) {
        // POR QUÉ (26-oct-2026): mientras no se empiece a borrar, «Usar
        // también para…» puede revivir esta lápida (ver usarTambienPara). Se
        // anota ANTES de borrar, en la misma transacción que comprueba que
        // sigue siendo lápida: o la revive la hoja, o la borra la cola.
        let sigue = false;
        await h.actualizar(t.id, (x) => {
          const y = x.archivos.find((z) => z.fid === a.fid);
          if (!y || y.estado !== 'quitado' || y.limpiar !== 'objeto') return null;
          sigue = true;
          if (y.borrando) return null;
          y.borrando = true;
          return x;
        });
        if (!sigue) return;
      }
      await h.quitarObjeto(a.path);
      await listo();
      return;
    }
    const r = await llamar('comp_quitar_foto', { p_cliente_id: a.cliente_id, p_toma_id: null }, t.email);
    if ('falla' in r) {
      h.reportar('quitar', r.error, { code: r.error?.code }, a.path);
      await seQuedaArriba(t, a, null, h);
      return;
    }
    const d = leerRespQuitar(r.data);
    if (d && !d.ok && d.codigo === 'ocupada') throw new Ocupada();
    if (!d || !d.ok) {
      await seQuedaArriba(t, a, d?.codigo ?? 'otro', h);
      return;
    }
    // Ya no hay fila (borrada ahora o nunca entró): el objeto se borra.
    await h.quitarObjeto(d.path || a.path);
    // Lo que contaba en cada toma ya no está: la pantalla lo descuenta
    // (quitadaDe) hasta releer la lista, y el aviso global pide releerla.
    const quitada = [...a.toma_ids.filter((id) => cuentaEnToma(a, id)), ...(a.desligar ?? [])];
    await h.actualizar(t.id, (x) => {
      const y = x.archivos.find((z) => z.fid === a.fid);
      if (!y) return null;
      delete y.limpiar;
      // La quitó entera el monitorista: es su lápida (no una que la cola deja
      // al soltar la visita) y ya no se revive.
      delete y.sinFila;
      if (quitada.length) y.quitadaDe = [...new Set([...(y.quitadaDe ?? []), ...quitada])];
      delete y.desligar;
      return x;
    });
    if (quitada.length) quitadas++;
    quitadasDeVerdad.add(a.cliente_id);
  },

  hayExtra: (t) => t.archivos.some((a) => a.estado !== 'quitado' && !!a.desligar?.length) || !!sueltaAlSoltar(t),

  /**
   * Quitar una foto de UNA toma (comp_quitar_foto con p_toma_id), o, al
   * soltar la visita, dejar como lápida la foto sin fila que no cuenta en
   * ninguna toma (la cola borra su objeto en la siguiente pasada).
   */
  async pasoExtra(t, h): Promise<boolean> {
    const suelta = sueltaAlSoltar(t);
    if (suelta) {
      await h.actualizar(t.id, (x) => {
        const y = x.archivos.find((z) => z.fid === suelta.fid);
        if (!y || !sueltaSinFila(y) || !puedeSoltarVisita(x, hoyTelefono())) return null;
        y.estado = 'quitado';
        y.limpiar = 'objeto';
        return x;
      });
      return true;
    }
    const a = t.archivos.find((x) => x.estado !== 'quitado' && !!x.desligar?.length);
    if (!a || !a.desligar?.length) return false;
    const tomaId = a.desligar[0];
    await exigirSesion(undefined, t.email);
    const r = await llamar('comp_quitar_foto', { p_cliente_id: a.cliente_id, p_toma_id: tomaId }, t.email);
    let seQueda: string | null = null;
    /** La base ya no tiene la fila: la ruta del objeto que queda suelto. */
    let sinFila: string | null = null;
    if ('falla' in r) {
      h.reportar('desligar', r.error, { code: r.error?.code }, a.path);
      seQueda = 'el servidor no dejó';
    } else {
      const d = leerRespQuitar(r.data);
      if (d && !d.ok && d.codigo === 'ocupada') throw new Ocupada();
      if (!d || !d.ok)
        seQueda = d?.codigo === 'revisada' ? 'la analista ya la revisó' : d?.codigo === 'enviada' ? 'la toma ya se envió' : 'el servidor no dejó';
      // POR QUÉ (26-oct-2026): al quitarle su última liga (p. ej. ligada a A y
      // en B ajena, cerrada o futura), la base borra la fila entera y contesta
      // borrada + path. Un reintento (se perdió esa respuesta) contesta `ya`
      // sin `quedan`: la fila ya no existe. En los dos casos el objeto quedó
      // suelto y se borra.
      else if (d.borrada || (d.ya && d.quedan === null)) sinFila = d.path || a.path;
    }
    if (seQueda)
      h.avisar(t.email, {
        tipo: 'info',
        clave: t.clave,
        texto: `${t.sitio_clave}: la foto ${a.n} sigue en ${nombreDe(t, tomaId)}: ${seQueda}.`,
      });
    await h.actualizar(t.id, (x) => {
      const y = x.archivos.find((z) => z.fid === a.fid);
      if (!y) return null;
      y.desligar = (y.desligar ?? []).filter((id) => id !== tomaId);
      if (!y.desligar.length) delete y.desligar;
      if (seQueda) {
        // Sigue ligada: vuelve a contar ahí.
        if (!y.toma_ids.includes(tomaId)) y.toma_ids.push(tomaId);
        y.resueltas[String(tomaId)] = 'ligada';
      } else {
        delete y.resueltas[String(tomaId)];
        if (y.toma_ids.includes(tomaId)) {
          // POR QUÉ (26-oct-2026): mientras la RPC iba en camino, «Usar
          // también para…» la volvió a pedir en esa toma (agregar la sacó de
          // `desligar`): la base ya la desligó, así que se vuelve a ligar.
          if (y.estado === 'ligado') y.estado = 'subido';
        } else if (!y.quitadaDe?.includes(tomaId)) {
          // La lista leída antes todavía la cuenta en esa toma (ver retiradasDe).
          y.quitadaDe = [...(y.quitadaDe ?? []), tomaId];
        }
        // POR QUÉ (26-oct-2026): sin fila en el servidor la foto NO se vuelve
        // lápida aquí. El monitorista la quitó solo de esa toma: se queda en
        // la tarjeta («arriba, pero no cuenta en ninguna versión»), con su
        // objeto y su copia de cámara, y «Usar también para…» (o una toma que
        // espera ligarse) vuelve a crear la fila con el mismo objeto. La marca
        // `sinFila` hace que su objeto se borre al soltar o descartar la
        // visita (sueltaAlSoltar, alDescartar). Una lápida no se toca: la
        // quitaron entera mientras tanto y su `limpiar` hace la limpieza.
        if (sinFila && y.estado !== 'quitado') {
          y.sinFila = true;
          y.path = sinFila;
        }
      }
      return x;
    });
    if (!seQueda) quitadas++;
    return true;
  },

  registroPendiente: (t) => tomasPorRegistrar(t).length > 0,
  // Un regreso vigente sigue pidiendo atención aunque otra toma se registre.
  errorDeRegistroResuelto: (t) => !t.tomas.some((x) => x.reg === 'regresada'),
  puedeSoltar: (t) => puedeSoltarVisita(t, hoyTelefono()),
  conservarAlDescartar: (a) => (a.estado === 'ligado' && !!a.desligar?.length) || sueltaSinFila(a),
  alDescartar: (t) => {
    // Lo que queda es solo limpieza: ya no se registra nada.
    t.tomas = [];
    t.cerrar = false;
    for (const a of t.archivos) {
      // POR QUÉ (27-oct-2026): el núcleo vuelve lápida 'objeto' lo que está
      // arriba ('subido', o 'fallido' ya en Storage) ANTES de llegar aquí; una
      // con «Quitar de A» pendiente (le quedaba otra toma por ligar) perdía el
      // desligue: la liga de A seguía en el servidor y A volvía a contar con
      // ella. Vuelve a ser 'ligado' solo con lo que el servidor ya contestó (lo
      // demás ya no se liga): pasoExtra la desliga y, si queda sin fila,
      // sueltaAlSoltar borra su objeto. Como la 'ligado' que conservarAlDescartar guarda.
      if (a.estado === 'quitado' && a.limpiar === 'objeto' && a.desligar?.length) {
        delete a.limpiar;
        a.estado = 'ligado';
        a.arriba = true;
        a.toma_ids = a.toma_ids.filter((id) => !!a.resueltas[String(id)]);
      }
      // POR QUÉ (26-oct-2026): la foto suelta sin fila no está «arriba» para
      // el núcleo (es 'ligado') y se descartaba sin que nadie borrara su
      // objeto. Como lo que subió sin ligar: lápida y la cola borra el objeto.
      if (sueltaSinFila(a)) {
        a.estado = 'quitado';
        a.limpiar = 'objeto';
      }
      // Una visita descartada no se revive con «Usar también para…».
      delete a.sinFila;
    }
  },
  // Sin ninguna toma que la aceptara (comp_subir_foto contestó evidencia_id
  // null: ni fila hay) no es «foto arriba».
  cuentaEnLogro: (a) => a.toma_ids.some((id) => cuentaEnToma(a, id)),
  logro: (t, d) => ({ llave: t.clave, sitio_clave: t.sitio_clave, fotos: d.fotos, tomas: d.registradas, en: Date.now() }),

  async registrar(t, h): Promise<ResultadoRegistro> {
    // Integración (26-oct-2026): comp_estado_tomas y comp_registrar_tomas
    // aceptan hasta 200 ids (si no, CP002 y la visita se quedaría atorada).
    // Las que sobren siguen pendientes y van en la siguiente vuelta.
    const ids = tomasPorRegistrar(t).slice(0, MAX_TOMAS_REGISTRO);
    if (!ids.length) return 'nada';
    await exigirSesion(undefined, t.email);
    // 1) Cómo están en el servidor (regreso_n sin reloj, B12).
    let filas = await leerEstado(ids, t.email, h);
    if (!filas) return { error: 'No se pudo leer el estado de las tomas; se reintenta en la siguiente vuelta.' };
    if (ids.some((id) => !filas!.some((f) => f.id === id))) {
      // Una toma que no vuelve es ajena o se borró… o la sesión salió
      // anónima: antes de concluirlo, la sesión real y otra lectura.
      await h.sesionValida(t.email);
      filas = await leerEstado(ids, t.email, h);
      if (!filas) return { error: 'No se pudo leer el estado de las tomas; se reintenta en la siguiente vuelta.' };
    }
    const porId = new Map(filas.map((f) => [f.id, f]));
    const cambios = new Map<number, Partial<TomaEnVisita>>();
    const avisos: AvisoCola[] = [];
    const regresos: string[] = [];
    const aRegistrar: number[] = [];
    for (const id of ids) {
      const x = t.tomas.find((y) => y.id === id)!;
      const f = porId.get(id);
      if (!f) {
        cambios.set(id, { reg: 'ajena' });
        avisos.push({ tipo: 'info', clave: t.clave, texto: `${t.sitio_clave}: ${x.nombre} ya no es tuya; las fotos que subiste se quedan en ella.` });
      } else if (f.estado === 'por_revisar' || f.estado === 'comprobada') {
        cambios.set(id, { reg: 'enviada', regEstado: f.estado });
      } else if (f.estado === 'cancelada') {
        cambios.set(id, { reg: 'cerrada' });
      } else if (f.regreso_n !== x.regreso_n) {
        cambios.set(id, { reg: 'regresada' });
        regresos.push(`${x.nombre}${f.rechazo_motivo ? ` («${f.rechazo_motivo.trim()}»)` : ''}`);
      } else aRegistrar.push(id);
    }
    // 2) El registro: la base cuenta (comp_faltan) y contesta por toma.
    let registradas = 0;
    let errorRegistro: string | null = null;
    if (aRegistrar.length) {
      const r = await llamar('comp_registrar_tomas', { p_toma_ids: aRegistrar }, t.email);
      const d = 'falla' in r ? null : leerRespRegistrar(r.data);
      if ('falla' in r || !d) {
        h.reportar('registrar', 'falla' in r ? r.error : new Error('respuesta que no se entiende'), 'falla' in r ? { code: r.error?.code } : undefined, t.clave);
        errorRegistro =
          'falla' in r && r.falla === 'falta_migracion'
            ? TEXTO_FALTA_MIGRACION
            : 'No se pudieron enviar las tomas: el servidor las rechazó. Avisa a Erik.';
      } else if (!d.ok) {
        if (d.codigo === 'ocupada') throw new Ocupada();
        errorRegistro = d.codigo === 'captura_cerrada' ? TEXTO_CAPTURA_CERRADA : `No se pudieron enviar las tomas (${d.codigo}).`;
      } else {
        for (const id of aRegistrar) {
          const x = t.tomas.find((y) => y.id === id)!;
          const y = d.tomas.find((z) => z.id === id);
          const firma = firmaToma(x, t.archivos);
          if (!y) {
            // No vino (no debe pasar): no se repite hasta que cambien sus fotos.
            cambios.set(id, { faltanFirma: firma });
          } else if (y.estado === 'por_revisar' || y.estado === 'comprobada' || y.ya) {
            cambios.set(id, { reg: 'enviada', regEstado: y.estado === 'comprobada' ? 'comprobada' : 'por_revisar', faltan: null });
            if (!y.ya) registradas++;
          } else if (y.codigo === 'ajena' || y.codigo === 'cerrada' || y.codigo === 'futura') {
            cambios.set(id, { reg: y.codigo });
          } else {
            // 'faltan' (o un código que no se conoce): se guarda lo que dijo la base.
            cambios.set(id, { faltan: y.faltan, faltanFirma: firma });
          }
        }
      }
    }
    // 3) Se anota todo en la visita. El rojo del regreso lo pone el núcleo
    // (lo avisa una vez, con tipo 'regreso').
    const regresoTxt = regresos.length
      ? `La analista devolvió ${regresos.join(', ')} después de que tomaste las fotos: ábrela, revisa el motivo y vuelve a tomar lo que pide.`
      : null;
    const quedo = await h.actualizar(t.id, (x) => cambiarTomas(x, cambios));
    // 4) «Listo con este sitio»: lo que falta se dice (en pantalla o en el buzón).
    const v = quedo ?? t;
    if (t.cerrar) {
      const faltan: FaltanToma[] = [];
      for (const x of v.tomas)
        if (!x.reg && x.faltan?.length)
          faltan.push({ toma_id: x.id, nombre: x.nombre, faltan: x.faltan, texto: textoFaltan(x.nombre, x.faltan) });
      cierres.set(t.clave, {
        enviadas: v.tomas.filter((x) => x.reg === 'enviada').map((x) => x.id),
        faltan,
        sinEnviar: v.tomas.filter((x) => x.reg && x.reg !== 'enviada').map((x) => ({ toma_id: x.id, razon: x.reg! })),
      });
      if (faltan.length && !cierreEnPantalla.has(t.clave))
        avisos.push({ tipo: 'faltan', clave: t.clave, texto: `${t.sitio_clave}: ${faltan.map((f) => f.texto).join(' · ')}.` });
    }
    if (errorRegistro)
      return { error: regresoTxt ? `${errorRegistro} ${regresoTxt}` : errorRegistro, tipo: 'error', registradas, avisos };
    if (regresoTxt) return { error: regresoTxt, tipo: 'regreso', registradas, avisos };
    return { registradas, avisos };
  },
};

const cola = crearColaFotos<TrabajoComp, ArchivoComp, LogroComp>(adaptador);

// ------------------------------------------------------------
// Visitas (lo que manda la pantalla)
// ------------------------------------------------------------

/** Lo que la tarjeta sabe de cada toma (una TomaMia de comp_mis_tomas sirve tal cual). */
export type TomaParaVisita = Pick<TomaMia, 'id' | 'campana_id' | 'campana' | 'version' | 'fecha' | 'estado' | 'regreso_n' | 'plantilla' | 'tiene'> &
  Partial<Pick<TomaMia, 'por_camara'>>;

/** La visita: un sitio en un día, con sus tomas (las de la tarjeta). */
export type VisitaComp = {
  unidad: UnidadComp;
  sitio_clave: string;
  /** Día de la visita (AAAA-MM-DD): el de la tarjeta, que para capturar es hoy. */
  fecha: string;
  tomas: readonly TomaParaVisita[];
  /**
   * Ligas (cliente_id|toma_id) que ya vienen contadas en `tiene` (las que la
   * cola tenía al EMPEZAR la lectura de la lista): no se suman otra vez.
   */
  incluidas?: ReadonlySet<string>;
};

/** Lo que eligió la hoja «¿qué es? ¿de cuál?». */
export type HojaFoto = { pos: string; momento: MomentoPos; toma_ids: number[] };

/** Una foto recién elegida (cámara de la app o galería). */
export type FotoNueva = {
  file: File;
  origen: 'camara' | 'galeria';
  /** Hora de la foto (ISO). Sin ella: cámara = ahora; galería = lastModified del archivo. */
  tomada_en?: string | null;
  lat?: number | null;
  lng?: number | null;
  precision_m?: number | null;
};

/** Una foto que ya está en el servidor (de la visita o de la sesión), para «Usar también para…» y «Quitar». */
export type FotoRef = {
  cliente_id: string;
  path: string;
  pos: string;
  momento: MomentoPos;
  tipo: 'foto' | 'video';
  /** Si sigue en la cola: su trabajo y fid (de estadoVisita().fotos). */
  trabajo?: string;
  fid?: string;
};

export function claveDeVisita(email: string, v: Pick<VisitaComp, 'unidad' | 'sitio_clave' | 'fecha'>): string {
  return claveVisita(email, v.unidad, v.sitio_clave, v.fecha);
}

function tomaEnVisita(x: TomaParaVisita): Omit<TomaEnVisita, 'reg' | 'regEstado' | 'faltan' | 'faltanFirma'> {
  return {
    id: x.id,
    campana_id: x.campana_id,
    nombre: nombreToma(x),
    fecha: x.fecha,
    estado: x.estado,
    regreso_n: x.regreso_n,
    plantilla: x.plantilla.map((p) => ({ ...p })),
    por_camara: (x.por_camara ?? []).map((p) => p.pos),
    tiene: x.tiene.map((p) => ({ ...p })),
  };
}

/**
 * Pone al día las tomas de la visita con lo que ve la pantalla. Una toma que
 * la cola dejó como «devuelta después» o «futura» vuelve a evaluarse (la
 * pantalla ya la ve como es); una enviada que volvió a devolverse
 * (regreso_n distinto), también.
 */
function fundirTomas(t: TrabajoComp, v: Pick<VisitaComp, 'tomas' | 'incluidas'>): void {
  // Las ligas que ya vienen en `tiene`, por toma (sin el dato, ninguna: contar
  // de más solo adelanta un registro que la base contesta con `faltan`).
  const incl = new Map<number, string[]>();
  for (const k of v.incluidas ?? []) {
    const i = k.lastIndexOf('|');
    const id = Number(k.slice(i + 1));
    if (i <= 0 || !Number.isFinite(id)) continue;
    incl.set(id, [...(incl.get(id) ?? []), k.slice(0, i)]);
  }
  for (const n of v.tomas) {
    const e = t.tomas.find((x) => x.id === n.id);
    const base = { ...tomaEnVisita(n), incluidas: incl.get(n.id) ?? [] };
    if (!e) {
      t.tomas.push({ ...base, reg: null });
      continue;
    }
    const volvio = n.regreso_n !== e.regreso_n;
    Object.assign(e, base);
    // Lo que la base ya dijo que va por cámara (29-oct-2026) no se vuelve a
    // pedir aunque la pantalla siga con la lista de antes.
    reaplicarCamara(e);
    if (e.reg === 'regresada' || e.reg === 'futura' || (volvio && e.reg === 'enviada')) {
      e.reg = null;
      e.regEstado = null;
      e.faltan = null;
      e.faltanFirma = null;
    }
  }
  if (t.conError && !t.archivos.some((a) => a.estado === 'fallido') && !t.tomas.some((x) => x.reg === 'regresada')) {
    t.conError = false;
    t.ultimoError = null;
  }
}

function visitaNueva(email: string, v: VisitaComp): TrabajoComp {
  const ahora = new Date().toISOString();
  const t: TrabajoComp = {
    v: 1,
    tipo: 'comp',
    id: nuevoClienteId(),
    clave: claveDeVisita(email, v),
    email: norm(email),
    unidad: v.unidad,
    sitio_clave: v.sitio_clave,
    fecha: v.fecha,
    tomas: [],
    cerrar: false,
    cerrarPedidoEn: null,
    archivos: [],
    ultimoError: null,
    conError: false,
    creado_en: ahora,
    actualizado_en: ahora,
  };
  fundirTomas(t, v);
  return t;
}

/** El número de foto dentro de la visita (para «foto 3» y el nombre para compartir). */
const contadores = new Map<string, number>();
async function siguienteN(clave: string, t: TrabajoComp): Promise<number> {
  let n = contadores.get(clave) ?? 0;
  for (const x of await cola.deClave(clave)) for (const a of x.archivos) n = Math.max(n, a.n);
  for (const a of t.archivos) n = Math.max(n, a.n);
  return n;
}

/** Validación de la visita y de la hoja; null = bien. */
function revisarHoja(v: VisitaComp, hoja: HojaFoto): string | null {
  if (!slugUnidad(v.unidad)) return 'Unidad desconocida para Comprobaciones.';
  if (!claveUsableEnRuta(v.sitio_clave))
    return 'La clave de este sitio trae caracteres que no se pueden usar en la ruta de la foto. Avisa a Erik.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.fecha)) return 'Falta el día de la visita.';
  if (!/^[a-z_]{1,20}$/.test(hoja.pos)) return 'Elige qué es la foto.';
  if (hoja.momento !== null && hoja.momento !== 'dia' && hoja.momento !== 'noche') return 'Momento desconocido.';
  if (!hoja.toma_ids.length) return 'Elige de qué versión es la foto.';
  if (hoja.toma_ids.length > 60) return 'Son demasiadas versiones para una foto (máximo 60).';
  const campanas = new Set<number>();
  for (const id of hoja.toma_ids) {
    const x = v.tomas.find((y) => y.id === id);
    if (!x) return 'Esa versión no es de este sitio.';
    if (x.fecha > v.fecha) return 'Esa toma es de un día que aún no llega: solo se puede ver.';
    // A1: una foto vale para un solo día de cada campaña (la base contestaría CP005).
    if (campanas.has(x.campana_id)) return 'Una foto vale para un solo día de cada campaña: elige solo una de esa campaña.';
    campanas.add(x.campana_id);
  }
  return null;
}

export type ResultadoEncolarComp =
  | {
      tipo: 'ok';
      /** Id del trabajo (la visita). */
      id: string;
      /** Los archivos tal como quedaron en la cola, en el orden recibido. */
      archivos: (ArchivoComp & { trabajo: string })[];
      /** false = ninguno cupo en el teléfono: si se cierra la app, se pierden. */
      enTelefono: boolean;
      fueraDelTelefono: number;
    }
  | { tipo: 'error'; mensaje: string };

/**
 * Las fotos recién elegidas de una visita con lo que dijo la hoja: se
 * guardan en el teléfono (en el orden recibido) y la cola las sube y las
 * liga sola. Un video va siempre como 'extra' (B6: nunca cuenta).
 */
export async function encolarFotosComp(
  email: string,
  visita: VisitaComp,
  nuevos: FotoNueva[],
  hoja: HojaFoto
): Promise<ResultadoEncolarComp> {
  const em = norm(email);
  if (!em) return { tipo: 'error', mensaje: 'Sin sesión: vuelve a entrar a la app.' };
  if (!nuevos.length) return { tipo: 'error', mensaje: 'No hay fotos que guardar.' };
  const mal = revisarHoja(visita, hoja);
  if (mal) return { tipo: 'error', mensaje: mal };
  const clave = claveDeVisita(em, visita);
  const ajustar = (t: TrabajoComp) => {
    fundirTomas(t, visita);
    t.cerrar = false;
    return t;
  };
  let t: TrabajoComp;
  try {
    t = await cola.obtenerTrabajo(clave, () => visitaNueva(em, visita), ajustar);
  } catch (err) {
    return { tipo: 'error', mensaje: 'No se pudo guardar en el teléfono: ' + String((err as Error)?.message || err) };
  }
  let id = t.id;
  let n = await siguienteN(clave, t);
  const dia = hoyTelefono();
  const ahora = new Date().toISOString();
  const salida: (ArchivoComp & { trabajo: string })[] = [];
  let fuera = 0;
  for (const nf of nuevos) {
    n++;
    contadores.set(clave, n);
    const f = nf.file;
    const tipo = tipoDeArchivo(f.type, f.name);
    const ext = extensionComp(extensionDe(f.name, f.type, tipo), tipo);
    const cliente_id = nuevoClienteId();
    const tomada =
      nf.tomada_en ??
      (nf.origen === 'galeria' && f.lastModified ? new Date(f.lastModified).toISOString() : ahora);
    const a: ArchivoComp = {
      fid: `${n}-${cliente_id.slice(0, 6)}`,
      n,
      path: rutaFotoComp({ unidad: visita.unidad, sitio_clave: visita.sitio_clave, dia, cliente_id, ext }),
      nombre: nombreParaCompartirComp(visita.sitio_clave, visita.fecha, n, ext),
      mime: f.type || (tipo === 'video' ? 'video/mp4' : 'image/jpeg'),
      tipo,
      bytes: f.size,
      encolado_en: ahora,
      origen: nf.origen,
      estado: 'local',
      cliente_id,
      pos: tipo === 'video' ? 'extra' : hoja.pos,
      momento: tipo === 'video' ? null : hoja.momento,
      tomada_en_tel: tomada,
      lat: nf.lat ?? null,
      lng: nf.lng ?? null,
      precision_m: nf.precision_m ?? null,
      toma_ids: [...new Set(hoja.toma_ids)],
      resueltas: {},
    };
    let donde = await cola.agregarArchivo(id, a, f, (x) => void ajustar(x));
    if (donde === 'sinTrabajo') {
      // La cola cerró la visita justo entre la lectura y esta foto: va a una nueva.
      const nuevo = visitaNueva(em, visita);
      await cola.crear(nuevo);
      id = nuevo.id;
      donde = await cola.agregarArchivo(id, a, f, (x) => void ajustar(x));
    }
    if (donde !== 'telefono') fuera++;
    salida.push({ ...a, trabajo: id });
  }
  void cola.procesar(id);
  return { tipo: 'ok', id, archivos: salida, enTelefono: fuera < nuevos.length, fueraDelTelefono: fuera };
}

/**
 * La foto en la cola de la visita (por trabajo y fid, o por cliente_id): la
 * viva o, si no hay, su lápida ('quitado'). null = no está en la cola.
 */
async function buscarFoto(clave: string, f: FotoRef): Promise<{ t: TrabajoComp; a: ArchivoComp } | null> {
  let lapida: { t: TrabajoComp; a: ArchivoComp } | null = null;
  for (const t of await cola.deClave(clave))
    for (const a of t.archivos) {
      if (!((f.trabajo && f.fid && t.id === f.trabajo && a.fid === f.fid) || a.cliente_id === f.cliente_id)) continue;
      if (a.estado !== 'quitado') return { t, a };
      lapida ??= { t, a };
    }
  return lapida;
}

/**
 * ¿La lápida todavía se puede revivir? Solo la de una foto sin fila que la
 * cola dejó al soltar la visita, mientras no empiece a borrar su objeto.
 */
const revivible = (a: ArchivoComp) => a.estado === 'quitado' && !!a.sinFila && a.limpiar === 'objeto' && !a.borrando;

const TEXTO_FOTO_YA_QUITADA = 'Esa foto ya se quitó del servidor; si la necesitas, vuelve a tomarla.';

/** Un registro de una foto que ya está arriba y no tiene trabajo (sin copia en el teléfono). */
function archivoRemoto(f: FotoRef, n: number, sitio_clave: string, fecha: string): ArchivoComp {
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(f.path)?.[1] || 'jpg').toLowerCase();
  return {
    fid: `${n}-${f.cliente_id.slice(0, 6)}`,
    n,
    path: f.path,
    nombre: nombreParaCompartirComp(sitio_clave, fecha, n, ext),
    mime: f.tipo === 'video' ? 'video/mp4' : 'image/jpeg',
    tipo: f.tipo,
    bytes: 0,
    encolado_en: new Date().toISOString(),
    origen: 'galeria',
    estado: 'subido',
    arriba: true,
    remoto: true,
    cliente_id: f.cliente_id,
    pos: f.pos,
    momento: f.momento,
    tomada_en_tel: null,
    lat: null,
    lng: null,
    precision_m: null,
    toma_ids: [],
    resueltas: {},
  };
}

/**
 * «Usar también para…»: liga la MISMA foto a otras versiones (misma RPC,
 * mismo cliente_id). Si la foto ya no está en la cola, se agrega su registro
 * (sin archivo) y la cola la liga.
 */
export async function usarTambienPara(
  email: string,
  visita: VisitaComp,
  foto: FotoRef,
  toma_ids: number[]
): Promise<'ok' | { error: string }> {
  const em = norm(email);
  if (!em) return { error: 'Sin sesión: vuelve a entrar a la app.' };
  const mal = revisarHoja(visita, { pos: foto.pos, momento: foto.momento, toma_ids });
  if (mal) return { error: mal };
  const clave = claveDeVisita(em, visita);
  const campanaDe = (id: number) => visita.tomas.find((x) => x.id === id)?.campana_id;
  const encontrada = await buscarFoto(clave, foto);
  // A1: la foto ya cuenta en otro día de esa campaña.
  // (También las que esperan desligarse: hasta que la base lo confirme, ahí
  // sigue. Una cerrada, futura o ajena no: ahí la base no la ligó.)
  const yaTiene = encontrada
    ? [...encontrada.a.toma_ids.filter((id) => ocupaCampana(encontrada.a, id)), ...(encontrada.a.desligar ?? [])]
    : [];
  for (const id of toma_ids) {
    const c = campanaDe(id);
    const choca = yaTiene.find((y) => y !== id && (campanaDe(y) ?? encontrada?.t.tomas.find((z) => z.id === y)?.campana_id) === c);
    if (choca !== undefined) return { error: 'Esa foto ya cuenta en otro día de esa campaña.' };
  }
  const agregar = (a: ArchivoComp) => {
    for (const id of toma_ids) if (!a.toma_ids.includes(id)) a.toma_ids.push(id);
    // POR QUÉ (26-oct-2026): «Quitar de A» sin señal y en seguida «Usar
    // también para… A»: se cancela el desligue pendiente y la liga vigente
    // (resueltas 'ligada') se queda. Antes la cola la quitaba de A al volver
    // la señal y, si era su última liga, la base borraba la foto.
    if (a.desligar) {
      a.desligar = a.desligar.filter((id) => !toma_ids.includes(id));
      if (!a.desligar.length) delete a.desligar;
    }
    // Vuelve a contar ahí: ya no es una liga quitada.
    if (a.quitadaDe) {
      a.quitadaDe = a.quitadaDe.filter((id) => !toma_ids.includes(id));
      if (!a.quitadaDe.length) delete a.quitadaDe;
    }
    if (a.estado === 'ligado' && porLigar(a).length) a.estado = 'subido';
  };
  let id: string | null = null;
  if (encontrada) {
    let hecho = false;
    let quitada = false;
    const r = await cola
      .actualizar(encontrada.t.id, (t) => {
        const a = t.archivos.find((x) => x.fid === encontrada.a.fid);
        if (!a) return null;
        if (a.estado === 'quitado') {
          // POR QUÉ (26 y 27-oct-2026): la hoja se abrió con la foto viva y,
          // mientras tanto, se volvió lápida: la cola al soltar la visita (sin
          // fila, sueltaAlSoltar) o «Quitar» entera en otra pestaña o el
          // descarte. Un registro remoto con el mismo cliente_id y la misma
          // ruta la perdía: la limpieza borraba fila y objeto y ligar recibía
          // sin_objeto («vuelve a tomarla», visita con error). La lápida sin
          // fila revive si la cola no empezó a borrar su objeto (en esta misma
          // transacción) y ligar vuelve a crear la fila; cualquier otra, se dice.
          if (!revivible(a)) {
            quitada = true;
            return null;
          }
          delete a.limpiar;
          delete a.sinObjeto;
          a.estado = 'subido';
          a.arriba = true;
        }
        agregar(a);
        fundirTomas(t, visita);
        t.cerrar = false;
        hecho = true;
        return t;
      })
      .catch(() => undefined);
    if (quitada) return { error: TEXTO_FOTO_YA_QUITADA };
    if (r && hecho) id = r.id;
  }
  if (!id) {
    const t = await cola.obtenerTrabajo(clave, () => visitaNueva(em, visita), (x) => {
      fundirTomas(x, visita);
      x.cerrar = false;
      return x;
    });
    const n = (await siguienteN(clave, t)) + 1;
    contadores.set(clave, n);
    const a = archivoRemoto(foto, n, visita.sitio_clave, visita.fecha);
    agregar(a);
    const donde = await cola.agregarArchivo(t.id, a, null);
    if (donde === 'sinTrabajo') return { error: 'No se pudo guardar en el teléfono; intenta de nuevo.' };
    id = t.id;
  }
  void cola.procesar(id);
  return 'ok';
}

/**
 * «Quitar» entera de una foto en la cola. Lo que nunca llegó al servidor (sin
 * `limpiar`) ya se fue: se anota en quitadasDeVerdad. Si el trabajo ya no
 * está, la cola lo soltó sin nada pendiente: también se fue.
 */
async function quitarEntera(trabajo: string, fid: string, cliente_id: string): Promise<'ok' | 'no-estaba'> {
  const r = await cola.quitarArchivo(trabajo, fid);
  if (r !== 'ok') return r;
  const t = await cola.leer(trabajo).catch(() => undefined);
  if (t === undefined) return r;
  const a = t?.archivos.find((x) => x.fid === fid);
  if (!a || (a.estado === 'quitado' && !a.limpiar)) quitadasDeVerdad.add(cliente_id);
  return r;
}

/**
 * Quitar una foto: de toda la visita (sin `toma_id`) o solo de una toma.
 * Lo que no ha subido se quita en el teléfono; lo que ya está arriba lo
 * limpia la cola (comp_quitar_foto y luego el objeto), con reintento. Una
 * foto de una toma ya enviada o revisada se queda (la base lo dice).
 */
export async function quitarFotoComp(
  email: string,
  visita: VisitaComp,
  foto: FotoRef,
  toma_id?: number
): Promise<'ok' | 'no-estaba' | { error: string }> {
  const em = norm(email);
  if (!em) return { error: 'Sin sesión: vuelve a entrar a la app.' };
  const clave = claveDeVisita(em, visita);
  const encontrada = await buscarFoto(clave, foto);
  // Ya es lápida: se quitó entera (o se descartó) y la cola la limpia.
  if (encontrada?.a.estado === 'quitado') return 'no-estaba';
  if (encontrada && toma_id === undefined) return quitarEntera(encontrada.t.id, encontrada.a.fid, encontrada.a.cliente_id);
  if (encontrada && toma_id !== undefined) {
    let todaLaFoto = false;
    const r = await cola
      .actualizar(encontrada.t.id, (t) => {
        const a = t.archivos.find((x) => x.fid === encontrada.a.fid);
        if (!a || a.estado === 'quitado' || !a.toma_ids.includes(toma_id)) return null;
        // Era su única toma: es quitar la foto entera (la base no acepta una
        // foto sin tomas y comp_quitar_foto sin toma borra sus ligas). Con más
        // tomas se desliga solo ésa; si era su última liga (las otras salieron
        // ajenas, cerradas o futuras), la base borra la fila y la foto se
        // queda sin fila en la tarjeta, sin aviso de «sigue en…» (pasoExtra).
        if (a.toma_ids.length === 1) {
          todaLaFoto = true;
          return null;
        }
        const ligada = cuentaEnToma(a, toma_id);
        a.toma_ids = a.toma_ids.filter((x) => x !== toma_id);
        if (ligada) a.desligar = [...new Set([...(a.desligar ?? []), toma_id])];
        else delete a.resueltas[String(toma_id)];
        if (a.estado === 'subido' && !porLigar(a).length) a.estado = 'ligado';
        return t;
      })
      .catch(() => undefined);
    if (todaLaFoto) return quitarEntera(encontrada.t.id, encontrada.a.fid, encontrada.a.cliente_id);
    if (!r) return 'no-estaba';
    void cola.procesar(r.id);
    return 'ok';
  }
  // Ya no está en la cola (su visita se cerró): un registro sin archivo
  // para que la cola haga la limpieza con reintento.
  const t = await cola.obtenerTrabajo(clave, () => visitaNueva(em, visita), (x) => {
    fundirTomas(x, visita);
    return x;
  });
  const n = (await siguienteN(clave, t)) + 1;
  contadores.set(clave, n);
  const a = archivoRemoto(foto, n, visita.sitio_clave, visita.fecha);
  if (toma_id === undefined) {
    a.estado = 'quitado';
    a.limpiar = true;
  } else {
    a.estado = 'ligado';
    a.desligar = [toma_id];
  }
  const donde = await cola.agregarArchivo(t.id, a, null);
  if (donde === 'sinTrabajo') return { error: 'No se pudo guardar en el teléfono; intenta de nuevo.' };
  void cola.procesar(t.id);
  return 'ok';
}

export type ResultadoCerrar =
  /** La base ya contestó: lo enviado, lo que falta (ámbar) y lo que ya no se envía. */
  | { tipo: 'listo'; enviadas: number[]; faltan: FaltanToma[]; sinEnviar: { toma_id: number; razon: FinRegistro }[] }
  /** Sigue en la cola (sin señal o fotos subiendo): se registra sola. */
  | { tipo: 'enCola'; mensaje: string | null; porSubir: number }
  | { tipo: 'error'; mensaje: string };

/**
 * «Listo con este sitio» (B11): cierra la visita. La cola registra lo
 * completo (la base cuenta) y dice lo que falta («Falta: Larga de
 * Suburbia V1»). Espera hasta 8 s: con señal contesta 'listo'; si no,
 * 'enCola' y lo que falte llega después al buzón (tipo 'faltan').
 * `enPantalla`: ¿sigue a la vista la tarjeta? Si no, el aviso breve sí lo dice.
 */
export async function cerrarVisita(
  email: string,
  visita: VisitaComp,
  op: { enPantalla?: () => boolean } = {}
): Promise<ResultadoCerrar> {
  const em = norm(email);
  if (!em) return { tipo: 'error', mensaje: 'Sin sesión: vuelve a entrar a la app.' };
  if (!slugUnidad(visita.unidad)) return { tipo: 'error', mensaje: 'Unidad desconocida para Comprobaciones.' };
  const clave = claveDeVisita(em, visita);
  const ahora = new Date().toISOString();
  const marcar = (t: TrabajoComp) => {
    fundirTomas(t, visita);
    t.cerrar = true;
    t.cerrarPedidoEn = ahora;
    // Que la base vuelva a contestar lo que falta de cada toma abierta.
    for (const x of t.tomas) if (!x.reg) x.faltanFirma = null;
    return t;
  };
  let t: TrabajoComp;
  try {
    t = await cola.obtenerTrabajo(
      clave,
      () => marcar(visitaNueva(em, visita)),
      marcar
    );
  } catch (err) {
    return { tipo: 'error', mensaje: 'No se pudo guardar en el teléfono: ' + String((err as Error)?.message || err) };
  }
  cierres.delete(clave);
  cierreEnPantalla.add(clave);
  let error: string | null = null;
  try {
    error = (await cola.correrYEsperar(t.id, ESPERA_CIERRE_MS)).error;
  } finally {
    cierreEnPantalla.delete(clave);
  }
  const visible = op.enPantalla ? op.enPantalla() : true;
  if (visible) cola.marcarVisto(clave);
  const c = cierres.get(clave);
  if (c) {
    cierres.delete(clave);
    return { tipo: 'listo', ...c };
  }
  const quedan = await cola.deClave(clave);
  const fresco = quedan.find((x) => x.id === t.id) ?? null;
  if (fresco?.conError && fresco.ultimoError) return { tipo: 'error', mensaje: fresco.ultimoError };
  if (!fresco && error) return { tipo: 'error', mensaje: error };
  // La visita se cerró sin nada que registrar (todo ya estaba enviado o sin
  // toma abierta): lo que se sabía de cada toma.
  if (!fresco)
    return {
      tipo: 'listo',
      enviadas: t.tomas.filter((x) => x.reg === 'enviada' || x.estado === 'por_revisar').map((x) => x.id),
      faltan: [],
      sinEnviar: t.tomas.filter((x) => x.reg && x.reg !== 'enviada').map((x) => ({ toma_id: x.id, razon: x.reg! })),
    };
  return { tipo: 'enCola', mensaje: fresco?.ultimoError ?? null, porSubir: quedan.reduce((s, x) => s + porSubir(x), 0) };
}

/**
 * La pantalla volvió a leer comp_mis_tomas: pone al día las tomas de una
 * visita que sigue en la cola (sin crearla). Así la cola cuenta con lo que
 * ya ve la pantalla y una toma «devuelta después» se vuelve a evaluar.
 */
export async function actualizarVisita(email: string, visita: VisitaComp): Promise<void> {
  const clave = claveDeVisita(email, visita);
  for (const t of await cola.deClave(clave)) {
    await cola
      .actualizar(t.id, (x) => {
        fundirTomas(x, visita);
        return x;
      })
      .catch(() => undefined);
    void cola.procesar(t.id);
  }
}

// ------------------------------------------------------------
// Lo que lee la pantalla
// ------------------------------------------------------------

/** El estado de cada visita en la cola de este correo (clave → estado), para pintar «en el teléfono». */
export async function estadoVisitas(email: string): Promise<Map<string, EstadoVisita>> {
  const porClave = new Map<string, TrabajoComp[]>();
  for (const t of await cola.listar(email)) {
    const l = porClave.get(t.clave);
    if (l) l.push(t);
    else porClave.set(t.clave, [t]);
  }
  const out = new Map<string, EstadoVisita>();
  porClave.forEach((ts, clave) =>
    out.set(clave, estadoDeVisita(clave, ts, { enviando: cola.estaEnviando, hayCopia: cola.hayCopia }))
  );
  return out;
}

/** El estado de UNA visita (null = nada en la cola). */
export async function estadoVisita(email: string, visita: Pick<VisitaComp, 'unidad' | 'sitio_clave' | 'fecha'>): Promise<EstadoVisita | null> {
  const clave = claveDeVisita(email, visita);
  const ts = await cola.deClave(clave);
  return ts.length ? estadoDeVisita(clave, ts, { enviando: cola.estaEnviando, hayCopia: cola.hayCopia }) : null;
}

/** Archivos de este correo que siguen en el teléfono (la píldora «⬆ N»). */
export async function fotosPendientesComp(email: string): Promise<number> {
  try {
    return (await cola.listar(email)).reduce((s, t) => s + porSubir(t), 0);
  } catch {
    return 0;
  }
}

/** ¿Hay algo de este correo que se perdería o quedaría a medias al salir? (cierre de sesión) */
export function hayTomasCompPendientes(email: string): Promise<number> {
  return cola.pendientes(email);
}

/**
 * Los archivos de la visita que siguen en el teléfono, ya con su nombre
 * único (<sitio_clave>_<DDMM>_<n>.<ext>), para «Guardar en Fotos». Se
 * prepara ANTES del toque: navigator.share({files}) tiene que llamarse
 * dentro del mismo toque, sin ningún await antes (lib/guardarEnFotos).
 */
export async function archivosParaGuardar(email: string, visita: Pick<VisitaComp, 'unidad' | 'sitio_clave' | 'fecha'>): Promise<File[]> {
  const out: File[] = [];
  const vistos = new Set<string>();
  for (const t of await cola.deClave(claveDeVisita(email, visita)))
    for (const a of t.archivos) {
      if (a.estado === 'quitado' || a.estado === 'perdido' || a.remoto || vistos.has(a.cliente_id)) continue;
      const f = await cola.archivoLocal(t.id, a.fid);
      if (!f) continue;
      vistos.add(a.cliente_id);
      try {
        out.push(new File([f], a.nombre, { type: a.mime || f.type, lastModified: f.lastModified }));
      } catch {
        out.push(f);
      }
    }
  return out;
}

/** El File de un archivo en cola (miniatura). */
export function archivoLocalComp(trabajo: string, fid: string): Promise<File | null> {
  return cola.archivoLocal(trabajo, fid);
}

// ------------------------------------------------------------
// Aviso global, aviso breve y suscripción
// ------------------------------------------------------------

export const suscribirTomasComp = cola.suscribir;
export const listarTomasCompAviso = cola.listarAviso;
export const procesarTomasCompPendientes = cola.procesarPendientes;
export const descartarTomaComp = cola.descartar;
/** Quitar desde el aviso o la miniatura por trabajo y fid. */
export const quitarArchivoComp = cola.quitarArchivo;
/** Avisos del buzón con su TIPO (la pantalla decide con el tipo, nunca con el texto). Se entregan una vez. */
export const tomarAvisosTomasComp = cola.tomarAvisos;
/** Lo que terminó, para el aviso breve (se entrega una vez). */
export const tomarLogrosTomasComp = cola.tomarLogros;
/** Suelta los logros de visitas que el monitorista ya vio en pantalla (para AvisoBreve por props). */
export const logrosPorMostrarComp = cola.logrosPorMostrar;
/** La tarjeta mostró el resultado de la visita: sus logros previos ya no salen en el aviso breve. */
export function marcarVisitaVista(email: string, visita: Pick<VisitaComp, 'unidad' | 'sitio_clave' | 'fecha'>): void {
  cola.marcarVisto(claveDeVisita(email, visita));
}

/** ¿Algún archivo de la visita sigue sin terminar? (pura sobre el estado). */
export function visitaConPendientes(e: EstadoVisita | null | undefined): boolean {
  return !!e && e.fotos.some((f) => !esFinal(f.estado));
}
