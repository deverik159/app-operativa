// ============================================================
// src/modules/mis-rutas/TarjetaSitioComp.tsx
// Una tarjeta de Mis rutas › Comprobaciones: UN sitio en el día que se ve,
// con sus tomas (campaña-versión) adentro (fase 3, incremento 1,
// 26-oct-2026; especificación §6.1).
//
// SOLO LECTURA en este incremento: dice dónde (ruta, parada y «¿Cómo te
// llevo?»), cuándo (la franja: verde «en franja», ámbar «fuera de franja»;
// solo avisa, nunca bloquea) y qué fotos pide cada versión según su
// plantilla, con lo que ya tiene. La cámara y la hoja «¿qué es? ¿de cuál?»
// llegan en el incremento 2.
//
// Pensada primero para iPhone (375 px): todo envuelve (sin scroll
// horizontal), los textos largos se parten y el único botón (IrAqui) mide
// 44 px. Los colores salen de tonos.ts, que ya trae los del tema oscuro.
// ============================================================
import { memo, type CSSProperties } from 'react';
import IrAqui from '../../components/IrAqui';
import { colorTono, fondoTono } from '../../lib/tonos';
import { estadoFranja } from '../../lib/franjaHorario';
import {
  diaCorto,
  esVencida,
  grupoDeToma,
  nombreToma,
  posicionesDeVersion,
  textoRuta,
  vencidasDeOtroDia,
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

/** Una casilla de lo que pide: «Corta ☐», «Corta ✓», «Ángulo 1/3». */
function Casilla({ etiqueta, n, tiene }: { etiqueta: string; n: number; tiene: number }) {
  const lista = tiene >= n;
  // El ☐/✓ va oculto al lector (revisión del 26-oct-2026): ya está el texto
  // «(falta)/(ya está)» y VoiceOver leía las dos cosas con el nombre del símbolo.
  const glifo = n === 1 ? (lista ? '✓' : '☐') : lista ? '✓' : '';
  const texto = n === 1 ? etiqueta : `${etiqueta} ${tiene}/${n}`;
  return (
    <span
      className="tag"
      style={{
        fontSize: 12,
        color: lista ? colorTono('verde') : 'var(--txt)',
        background: lista ? fondoTono('verde') : undefined,
        whiteSpace: 'normal',
      }}
    >
      {texto}
      {glifo && <span aria-hidden="true"> {glifo}</span>}
      <span style={SOLO_LECTOR}>{lista ? ' (ya está)' : ' (falta)'}</span>
    </span>
  );
}

function PillEstado({ t, hoy }: { t: TomaMia; hoy: string }) {
  let tono: 'rojo' | 'ambar' | 'verde' | 'gris' = 'gris';
  let texto = 'Por tomar';
  if (t.estado === 'regresada') {
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

/** Una toma (campaña-versión) dentro de la tarjeta. */
function FilaToma({
  x,
  hoy,
  minuto,
  esHoy,
  unHorario,
}: {
  x: TomaMia;
  hoy: string;
  minuto: number | null;
  esHoy: boolean;
  unHorario: boolean;
}) {
  const pos = posicionesDeVersion(x);
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
        <PillEstado t={x} hoy={hoy} />
        {x.turno && <span className="tag">{x.turno === 'matutino' ? 'Mañana' : x.turno === 'vespertino' ? 'Tarde' : 'Campo'}</span>}
      </div>
      {!unHorario && (
        <div className="meta" style={{ marginTop: 2 }}>
          <Franja texto={x.horario_texto} minuto={minuto} conColor={esHoy} />
        </div>
      )}
      {x.estado === 'regresada' && x.rechazo_motivo && (
        <div style={{ color: colorTono('rojo'), fontSize: 13, marginTop: 4, overflowWrap: 'anywhere' }} role="note">
          {x.rechazo_motivo}
        </div>
      )}
      {x.estado !== 'por_revisar' && pos.length > 0 && (
        // role="group" (revisión del 26-oct-2026): un aria-label en un div
        // sin rol no vale en ARIA y Safari lo ignoraba.
        <div role="group" aria-label="Fotos que pide" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {pos.map((q) => (
            <Casilla key={`${q.pos}|${q.momento ?? ''}`} etiqueta={q.etiqueta} n={q.n} tiene={q.tiene} />
          ))}
        </div>
      )}
      {x.rechazadas.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 6 }}>
          {x.rechazadas.map((r) => (
            <div key={r.evidencia_id} style={{ color: 'var(--muted)', overflowWrap: 'anywhere' }}>
              <s>Foto rechazada</s>
              {r.motivo ? `: ${r.motivo}` : ''}
            </div>
          ))}
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

function TarjetaSitioComp({ t, hoy, minuto }: { t: TarjetaSitio; hoy: string; minuto: number | null }) {
  const esHoy = t.dia === hoy;
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
  const fila = (x: TomaMia) => (
    <FilaToma key={x.id} x={x} hoy={hoy} minuto={minuto} esHoy={esHoy} unHorario={unHorario} />
  );

  return (
    <article
      className="inc"
      aria-label={`${t.sitio_clave}, ${textoRuta(t)}`}
      style={{ borderColor: t.devuelta ? colorTono('rojo') : undefined, borderWidth: t.devuelta ? 2 : undefined }}
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

      {t.fotosSitio.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>
            Fotos del sitio{t.mueble ? ` (${t.mueble})` : ''} · valen para todas las campañas del día
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {t.fotosSitio.map((f) => (
              <Casilla key={`${f.pos}|${f.momento ?? ''}`} etiqueta={f.etiqueta} n={f.n} tiene={f.tiene} />
            ))}
          </div>
        </div>
      )}

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
    </article>
  );
}

export default memo(TarjetaSitioComp);
