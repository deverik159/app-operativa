// ============================================================
// src/modules/mis-rutas/TarjetaSitioComp.tsx
// Una tarjeta de Mis rutas › Comprobaciones: UN sitio en el día que se ve,
// con sus tomas (campaña-versión) adentro (fase 3, incremento 1,
// 26-oct-2026; especificación §6.1).
//
// Dice dónde (ruta, parada y «¿Cómo te llevo?»), cuándo (la franja: verde
// «en franja», ámbar «fuera de franja»; solo avisa, nunca bloquea) y qué
// fotos pide cada versión según su plantilla, con lo que ya tiene.
//
// CAPTURA (incremento 2, 26-oct-2026): con `captura` (piloto abierto, día de
// hoy y unidad conocida) la tarjeta lleva CapturaSitio (Cámara, Galería,
// miniaturas, Guardar en Fotos y «Listo con este sitio») y las casillas
// cuentan con la cola: ✓ cuando el servidor ligó, gris «⬆» mientras sigue
// en el teléfono, y ámbar lo que la base dijo que falta. Sin `captura` es la
// misma tarjeta de solo lectura del incremento 1.
//
// MODO MIXTO (incremento 3, 29-oct-2026; spec §11): lo que la analista sube
// desde cámaras (por_camara) no se pide ni se cuenta; la tarjeta lo dice con
// texto («La foto Corta la sube la analista desde cámaras: tú no la tomas.»),
// una vez arriba si todas las versiones llevan lo mismo, o en cada versión.
//
// DEVUELTAS (incremento 3): la tarjeta va arriba con borde rojo, cada toma
// devuelta dice su motivo y las fotos que la analista rechazó salen con su
// miniatura tachada, la posición, «rechazada» y el motivo; la plantilla
// vuelve a pedir lo que falta (la base ya no las cuenta en `tiene`).
//
// Pensada primero para iPhone (375 px): todo envuelve (sin scroll
// horizontal), los textos largos se parten y el único botón (IrAqui) mide
// 44 px. Los colores salen de tonos.ts, que ya trae los del tema oscuro.
// ============================================================
import { memo, useState, type CSSProperties } from 'react';
import IrAqui from '../../components/IrAqui';
import { sb } from '../../lib/supabase';
import { BUCKET_EVIDENCIAS } from '../../lib/storage';
import { colorTono, fondoTono } from '../../lib/tonos';
import { estadoFranja } from '../../lib/franjaHorario';
import { etiquetaDePos, type FaltaPos } from '../../lib/plantillasComp';
import { textoFaltan, type EstadoVisita, type FinRegistro } from '../../lib/colaFotos/logicaComp';
import type { ResultadoCerrar } from '../../lib/colaFotos/adaptadorComp';
import { avanceCaptura, diaFilaSitio, fotosDeSitioCaptura } from '../../lib/capturaComp';
import CapturaSitio from './CapturaSitio';
import {
  diaCorto,
  esVencida,
  grupoDeToma,
  nombreToma,
  porCamaraDeTarjeta,
  porCamaraDeToma,
  posicionesDeVersion,
  textoRuta,
  vencidasDeOtroDia,
  type FotoRechazada,
  type TarjetaSitio,
  type TomaMia,
} from '../../lib/misTomasComp';

/** Texto solo para el lector de pantalla (no hay clase en el CSS; el mismo de PautaView). */
const SOLO_LECTOR: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

/** Una franja con su estado (solo HOY se pinta de color: otro día no se compara con la hora de ahora). */
function Franja({ texto, minuto, conColor }: { texto: string | null; minuto: number | null; conColor: boolean }) {
  const e = estadoFranja(texto, conColor ? minuto : null);
  if (e.estado === 'siempre') return <span style={{ color: 'var(--muted)' }}>24 horas</span>;
  if (e.estado === 'ilegible' || !conColor)
    return (
      <span style={{ overflowWrap: 'anywhere' }}>
        Horario: <b>{e.texto}</b>
      </span>
    );
  const dentro = e.estado === 'dentro';
  return (
    <span style={{ overflowWrap: 'anywhere' }}>
      <b>{e.texto}</b>{' '}
      <span
        className="pill"
        style={{
          background: fondoTono(dentro ? 'verde' : 'ambar'),
          color: colorTono(dentro ? 'verde' : 'ambar'),
          whiteSpace: 'normal',
        }}
      >
        {dentro ? '● en franja' : '● fuera de franja'}
      </span>
    </span>
  );
}

/**
 * Una casilla de lo que pide: «Corta ☐», «Corta ✓», «Ángulo 1/3». Con la
 * cola (incremento 2): «⬆» gris si lo que falta ya está en el teléfono y
 * ámbar si la base dijo que falta («Listo con este sitio»).
 */
function Casilla({
  etiqueta,
  n,
  tiene,
  enTelefono = 0,
  falta = false,
}: {
  etiqueta: string;
  n: number;
  tiene: number;
  enTelefono?: number;
  falta?: boolean;
}) {
  const lista = tiene >= n;
  const enCamino = !lista && tiene + enTelefono >= n;
  const ambar = !lista && !enCamino && falta;
  // El ☐/✓ va oculto al lector (revisión del 26-oct-2026): ya está el texto
  // «(falta)/(ya está)» y VoiceOver leía las dos cosas con el nombre del símbolo.
  const glifo = lista ? '✓' : enCamino ? '⬆' : n === 1 ? '☐' : '';
  const texto = n === 1 ? etiqueta : `${etiqueta} ${tiene}/${n}`;
  return (
    <span
      className="tag"
      style={{
        fontSize: 12,
        color: lista ? colorTono('verde') : ambar ? colorTono('ambar') : enCamino ? 'var(--muted)' : 'var(--txt)',
        background: lista ? fondoTono('verde') : ambar ? fondoTono('ambar') : undefined,
        whiteSpace: 'normal',
      }}
    >
      {texto}
      {!lista && enTelefono > 0 && n > 1 ? ` (+${enTelefono})` : ''}
      {glifo && <span aria-hidden="true"> {glifo}</span>}
      <span style={SOLO_LECTOR}>{lista ? ' (ya está)' : enCamino ? ' (en el teléfono, subiendo)' : ' (falta)'}</span>
    </span>
  );
}

/** Lo que la cola sabe de la visita, para las casillas y el estado de cada toma. */
type CapFila = {
  estado: EstadoVisita | null;
  incluidas: ReadonlySet<string>;
  /** Por toma: lo que la base dijo que falta (cola o «Listo con este sitio»). */
  faltan: Map<number, FaltaPos[]>;
  /** Por toma: enviadas por la cola y las que ya no se envían, con la razón. */
  fin: Map<number, FinRegistro>;
  /**
   * Día de la fila «Fotos del sitio» (capturaComp.diaFilaSitio). Una toma de
   * otro día (una devuelta de ayer a la que le rechazaron un lateral) lleva
   * sus casillas de sitio en su propia fila (26-oct-2026).
   */
  diaSitio: string;
};

const TEXTO_FIN: Record<Exclude<FinRegistro, 'enviada'>, string> = {
  cerrada: 'Ya no se envía: comprobada, cancelada o su campaña se cerró',
  futura: 'Es de un día que aún no llega',
  ajena: 'Ya no es tuya (la reasignaron)',
  regresada: 'La analista la devolvió después de tus fotos: revisa el motivo',
};

function PillEstado({ t, hoy, fin }: { t: TomaMia; hoy: string; fin?: FinRegistro | null }) {
  let tono: 'rojo' | 'ambar' | 'verde' | 'gris' = 'gris';
  let texto = 'Por tomar';
  if (fin === 'enviada') {
    // La cola ya la registró aunque la lista todavía no se relea.
    tono = 'verde';
    texto = 'Enviada ✓';
  } else if (fin === 'regresada') {
    tono = 'rojo';
    texto = 'Devuelta';
  } else if (t.estado === 'regresada') {
    tono = 'rojo';
    texto = t.regreso_n > 1 ? `Devuelta (${t.regreso_n}.ª vez)` : 'Devuelta';
  } else if (t.estado === 'por_revisar') {
    tono = 'verde';
    texto = 'Enviada ✓';
  } else if (esVencida(t, hoy)) {
    tono = 'ambar';
    texto = `Vencida · era del ${diaCorto(t.fecha)}`;
  }
  return (
    <span
      className="pill"
      style={{
        background: fondoTono(tono),
        // --st-gris en oscuro da 3.2:1: el gris va con --muted (QA, 5-oct-2026).
        color: tono === 'gris' ? 'var(--muted)' : colorTono(tono),
        whiteSpace: 'normal',
      }}
    >
      {texto}
    </span>
  );
}

/**
 * «La foto Corta la sube la analista desde cámaras: tú no la tomas.» Con
 * texto (no solo color) y como nota: no es algo que falte.
 */
function NotaCamara({ texto }: { texto: string }) {
  return (
    <div
      role="note"
      style={{
        fontSize: 13,
        marginTop: 6,
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px dashed var(--line)',
        color: 'var(--muted)',
        overflowWrap: 'anywhere',
      }}
    >
      <b style={{ color: 'var(--txt)' }}>Por cámara:</b> {texto}
    </div>
  );
}

/** La dirección pública de una foto (null si no se puede armar). */
function urlFoto(path: string): string | null {
  if (!path) return null;
  try {
    return sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data.publicUrl || null;
  } catch {
    return null;
  }
}

/**
 * Una foto que la analista rechazó (comp_mis_tomas `rechazadas`, B2):
 * miniatura tachada, posición, «rechazada» y el motivo. El tachado no va
 * solo por color: la palabra «rechazada» y el motivo lo dicen.
 */
function FotoRechazadaFila({ r, etiqueta }: { r: FotoRechazada; etiqueta: string }) {
  const [src, setSrc] = useState(() => urlFoto(r.path));
  const caja: CSSProperties = {
    width: 56,
    height: 56,
    borderRadius: 8,
    border: `2px solid ${colorTono('rojo')}`,
    flexShrink: 0,
    position: 'relative',
    overflow: 'hidden',
    background: 'var(--panel2)',
  };
  return (
    <li style={{ display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 0 }}>
      <div style={caja} aria-hidden="true">
        {src && (
          <img
            src={src}
            alt=""
            loading="lazy"
            onError={() => setSrc(null)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.45 }}
          />
        )}
        {/* La «X» del tachado sobre la miniatura (adorno: el texto lo dice). */}
        <svg viewBox="0 0 56 56" width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
          <line x1="4" y1="4" x2="52" y2="52" stroke={colorTono('rojo')} strokeWidth="3" />
          <line x1="52" y1="4" x2="4" y2="52" stroke={colorTono('rojo')} strokeWidth="3" />
        </svg>
      </div>
      <div style={{ minWidth: 0, fontSize: 13, overflowWrap: 'anywhere' }}>
        <s>{etiqueta}</s> <b style={{ color: colorTono('rojo') }}>· rechazada</b>
        {r.motivo ? <div style={{ color: 'var(--txt)' }}>Motivo: {r.motivo}</div> : null}
      </div>
    </li>
  );
}

/** Una toma (campaña-versión) dentro de la tarjeta. */
function FilaToma({
  x,
  hoy,
  minuto,
  esHoy,
  unHorario,
  cap,
  camaraTarjeta,
}: {
  x: TomaMia;
  hoy: string;
  minuto: number | null;
  esHoy: boolean;
  unHorario: boolean;
  cap: CapFila | null;
  /** El aviso de cámara que ya dice la tarjeta (null = cada versión dice el suyo). */
  camaraTarjeta: string | null;
}) {
  const fin = cap?.fin.get(x.id) ?? null;
  // Lo que faltaba deja de decirse si la toma ya se envió (por la cola o
  // porque la lista ya la trae por revisar).
  const faltan = !fin && x.estado !== 'por_revisar' ? cap?.faltan.get(x.id) ?? null : null;
  const llavesFaltan = new Set((faltan ?? []).map((f) => `${f.pos}|${f.momento ?? ''}`));
  const pos = cap
    ? avanceCaptura(x, cap.estado, cap.incluidas).filter((q) => q.alcance === 'version' || x.fecha !== cap.diaSitio)
    : posicionesDeVersion(x).map((q) => ({ ...q, enTelefono: 0 }));
  const enviada = x.estado === 'por_revisar' || fin === 'enviada';
  const camara = enviada ? '' : porCamaraDeToma(x, camaraTarjeta);
  const etiquetaRechazada = (pos: string) =>
    x.plantilla.find((q) => q.pos === pos)?.etiqueta ??
    (x.por_camara ?? []).find((q) => q.pos === pos)?.etiqueta ??
    etiquetaDePos(pos);
  return (
    <li
      style={{
        borderTop: '1px solid var(--line)',
        paddingTop: 8,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <b style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{nombreToma(x)}</b>
        <PillEstado t={x} hoy={hoy} fin={fin} />
        {x.turno && <span className="tag">{x.turno === 'matutino' ? 'Mañana' : x.turno === 'vespertino' ? 'Tarde' : 'Campo'}</span>}
      </div>
      {!unHorario && (
        <div className="meta" style={{ marginTop: 2 }}>
          <Franja texto={x.horario_texto} minuto={minuto} conColor={esHoy} />
        </div>
      )}
      {x.estado === 'regresada' && x.rechazo_motivo && (
        <div style={{ color: colorTono('rojo'), fontSize: 13, marginTop: 4, overflowWrap: 'anywhere' }} role="note">
          <b>Motivo de la devolución:</b> {x.rechazo_motivo}
        </div>
      )}
      {!enviada && pos.length > 0 && (
        // role="group" (revisión del 26-oct-2026): un aria-label en un div
        // sin rol no vale en ARIA y Safari lo ignoraba.
        <div role="group" aria-label="Fotos que pide" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {pos.map((q) => (
            <Casilla
              key={`${q.pos}|${q.momento ?? ''}`}
              etiqueta={q.etiqueta}
              n={q.n}
              tiene={q.tiene}
              enTelefono={q.enTelefono}
              falta={llavesFaltan.has(`${q.pos}|${q.momento ?? ''}`)}
            />
          ))}
        </div>
      )}
      {camara && <NotaCamara texto={camara} />}
      {faltan && faltan.length > 0 && (
        <div style={{ color: colorTono('ambar'), fontSize: 13, marginTop: 4, overflowWrap: 'anywhere' }}>
          {textoFaltan(nombreToma(x), faltan)}
        </div>
      )}
      {fin && fin !== 'enviada' && (
        <div style={{ color: fin === 'regresada' ? colorTono('rojo') : 'var(--muted)', fontSize: 13, marginTop: 4 }}>
          {TEXTO_FIN[fin]}
        </div>
      )}
      {x.estado === 'regresada' && x.rechazadas.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>
            {x.rechazadas.length === 1
              ? 'Foto rechazada: ya no cuenta, vuelve a tomarla'
              : `Fotos rechazadas (${x.rechazadas.length}): ya no cuentan, vuelve a tomarlas`}
          </div>
          <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gap: 6 }}>
            {x.rechazadas.map((r) => (
              <FotoRechazadaFila key={r.evidencia_id} r={r} etiqueta={etiquetaRechazada(r.pos)} />
            ))}
          </ul>
        </div>
      )}
      {x.observaciones && <div className="obs">{x.observaciones}</div>}
      {x.especificacion && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)', padding: '10px 0', minHeight: 44 }}>
            Especificación de la campaña
          </summary>
          <div className="obs" style={{ overflowWrap: 'anywhere' }}>
            {x.especificacion}
          </div>
        </details>
      )}
    </li>
  );
}

const LISTA: CSSProperties = { listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gap: 8 };

/** Lo que la lista le pasa a la tarjeta para capturar (null = solo lectura). */
export type CapturaTarjeta = {
  email: string;
  estado: EstadoVisita | null;
  incluidas: ReadonlySet<string>;
  onListaCambio: () => void;
  /**
   * La tarjeta del sitio SIN el filtro del chip (null = la misma): la captura
   * trabaja con todas las tomas del sitio aunque solo se pinten las del chip.
   */
  completa?: TarjetaSitio | null;
};

/** Lo que la base dijo que falta y cómo terminó cada toma (cola + último «Listo»). */
function capDeFila(
  estado: EstadoVisita | null,
  incluidas: ReadonlySet<string>,
  cierre: ResultadoCerrar | null,
  diaSitio: string
): CapFila {
  const faltan = new Map<number, FaltaPos[]>();
  const fin = new Map<number, FinRegistro>();
  if (cierre?.tipo === 'listo') {
    for (const f of cierre.faltan) faltan.set(f.toma_id, f.faltan);
    for (const id of cierre.enviadas) fin.set(id, 'enviada');
    for (const s of cierre.sinEnviar) fin.set(s.toma_id, s.razon);
  }
  if (estado) {
    for (const [k, v] of Object.entries(estado.faltan)) faltan.set(Number(k), v);
    for (const id of estado.enviadas) fin.set(id, 'enviada');
    for (const s of estado.sinEnviar) fin.set(s.toma_id, s.razon);
  }
  return { estado, incluidas, faltan, fin, diaSitio };
}

function TarjetaSitioComp({
  t,
  hoy,
  minuto,
  captura = null,
}: {
  t: TarjetaSitio;
  hoy: string;
  minuto: number | null;
  captura?: CapturaTarjeta | null;
}) {
  const esHoy = t.dia === hoy;
  // Lo que contestó «Listo con este sitio» (se queda hasta el siguiente).
  const [cierre, setCierre] = useState<ResultadoCerrar | null>(null);
  // POR QUÉ la tarjeta completa (26-oct-2026): con el chip «Vencidas» o
  // «Devueltas» la fila de sitio contaba solo lo filtrado; y el día de la fila
  // es el de armarTarjetas (si no hay toma de hoy, el más reciente).
  const todas = captura?.completa ?? t;
  const diaSitio = diaFilaSitio(todas.tomas, t.dia);
  const cap = captura ? capDeFila(captura.estado, captura.incluidas, cierre, diaSitio) : null;
  const fotosSitio = captura
    ? fotosDeSitioCaptura(todas.tomas, t.dia, captura.estado, captura.incluidas)
    : t.fotosSitio.map((f) => ({ ...f, enTelefono: 0 }));
  // Un mismo horario para todo el sitio (lo normal) va arriba; si las
  // campañas traen franjas distintas, cada toma lleva la suya.
  const horarios = [...new Set(t.tomas.map((x) => (x.horario_texto || '').trim()))];
  const unHorario = horarios.length === 1;
  // Revisión del 26-oct-2026 (monitorista-5): las vencidas de otros días que
  // Hoy junta van aparte y plegadas; con plan diario eran 25 por sitio y lo de
  // hoy quedaba hasta abajo. «Por tomar» ya no las cuenta.
  // Si la tarjeta solo trae vencidas (p. ej. con el chip «Vencidas»), no se pliega.
  const otras = vencidasDeOtroDia(t, hoy);
  const vencidas = otras.length < t.tomas.length ? otras : [];
  const idsVencidas = new Set(vencidas.map((x) => x.id));
  const principales = t.tomas.filter((x) => !idsVencidas.has(x.id));
  // Los mismos grupos que los chips de arriba.
  const cuenta = { por_tomar: 0, vencidas: 0, devueltas: 0, enviadas: 0 };
  for (const x of t.tomas) cuenta[grupoDeToma(x, hoy)]++;
  const porTomar = cuenta.por_tomar + cuenta.devueltas;
  const enviadas = cuenta.enviadas;
  // Lo que va por cámara (29-oct-2026): una vez arriba si todas las versiones
  // que todavía piden fotos llevan lo mismo.
  const camaraTarjeta = porCamaraDeTarjeta(t.tomas);
  const fila = (x: TomaMia) => (
    <FilaToma
      key={x.id}
      x={x}
      hoy={hoy}
      minuto={minuto}
      esHoy={esHoy}
      unHorario={unHorario}
      cap={cap}
      camaraTarjeta={camaraTarjeta}
    />
  );
  // Una toma con algo en ámbar marca el borde de la tarjeta.
  const sigueAbierta = (id: number) =>
    !!cap && !cap.fin.has(id) && t.tomas.some((x) => x.id === id && x.estado !== 'por_revisar');
  const conFaltan = !!cap && [...cap.faltan.keys()].some(sigueAbierta);
  // El ámbar de la fila de sitio: solo lo que falta a las tomas de su día
  // (las de otro día lo pintan en su propia fila).
  const faltaSitio = (pos: string, momento: string | null) =>
    !!cap &&
    [...cap.faltan.entries()].some(
      ([id, l]) =>
        sigueAbierta(id) &&
        todas.tomas.some((x) => x.id === id && x.fecha === diaSitio) &&
        l.some((y) => y.pos === pos && y.momento === momento)
    );

  return (
    <article
      className="inc"
      aria-label={`${t.sitio_clave}, ${textoRuta(t)}`}
      style={{
        borderColor: t.devuelta ? colorTono('rojo') : conFaltan ? colorTono('ambar') : undefined,
        borderWidth: t.devuelta || conFaltan ? 2 : undefined,
      }}
    >
      <div className="inc-top">
        <div style={{ minWidth: 0 }}>
          <div className="folio">
            {textoRuta(t)}
            {t.unidad ? ` · ${t.unidad}` : ''}
          </div>
          <div className="titulo" style={{ overflowWrap: 'anywhere' }}>
            {t.sitio_clave}
            {t.espacio_vv && t.espacio_vv !== t.sitio_clave ? (
              <span style={{ fontWeight: 400, color: 'var(--muted)' }}> · {t.espacio_vv}</span>
            ) : null}
          </div>
        </div>
        {/* El «¿Cómo te llevo?» de Mis rutas (Google Maps, Waze y, en
            iPhone, Mapas). Sin coordenadas no se dibuja. */}
        <IrAqui destino={{ lat: t.lat, lng: t.lng, nombre: t.sitio_clave }} size="md" />
      </div>

      {unHorario && (
        <div className="meta" style={{ marginTop: 4 }}>
          <Franja texto={horarios[0] || null} minuto={minuto} conColor={esHoy} />
        </div>
      )}

      {fotosSitio.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>
            Fotos del sitio{t.mueble ? ` (${t.mueble})` : ''}
            {captura && diaSitio !== t.dia ? ` · del ${diaCorto(diaSitio)}` : ''} · valen para todas las campañas del día
          </div>
          <div role="group" aria-label="Fotos del sitio" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {fotosSitio.map((f) => (
              <Casilla
                key={`${f.pos}|${f.momento ?? ''}`}
                etiqueta={f.etiqueta}
                n={f.n}
                tiene={f.tiene}
                enTelefono={f.enTelefono}
                falta={faltaSitio(f.pos, f.momento)}
              />
            ))}
          </div>
        </div>
      )}

      {camaraTarjeta && <NotaCamara texto={camaraTarjeta} />}

      <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700, marginTop: 10 }}>
        {porTomar > 0 ? `Por tomar (${porTomar})` : 'Nada por tomar'}
        {cuenta.vencidas > 0 ? ` · Vencidas (${cuenta.vencidas})` : ''}
        {enviadas > 0 ? ` · Enviadas (${enviadas}) ✓` : ''}
      </div>
      {principales.length > 0 && <ul style={LISTA}>{principales.map(fila)}</ul>}
      {vencidas.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 700,
              color: colorTono('ambar'),
              padding: '10px 0',
              minHeight: 44,
            }}
          >
            {vencidas.length === 1 ? '1 vencida' : `${vencidas.length} vencidas`} (de días anteriores)
          </summary>
          <ul style={LISTA}>{vencidas.map(fila)}</ul>
        </details>
      )}
      {captura && (
        <CapturaSitio
          email={captura.email}
          t={captura.completa ?? t}
          hoy={hoy}
          estado={captura.estado}
          incluidas={captura.incluidas}
          onListaCambio={captura.onListaCambio}
          onCierre={setCierre}
        />
      )}
    </article>
  );
}

export default memo(TarjetaSitioComp);
