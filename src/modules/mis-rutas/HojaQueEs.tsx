// ============================================================
// src/modules/mis-rutas/HojaQueEs.tsx
// La hoja «¿qué es? ¿de cuál?» de Mis rutas › Comprobaciones (fase 3,
// incremento 2, 26-oct-2026; especificación §6.1).
//
// POR QUÉ: en un sitio el monitorista toma varias versiones en el mismo loop
// y una foto de sitio (copete, lateral) vale para todas las del día. Tras
// cada foto la hoja pregunta qué es (las posiciones que faltan, o «Otra»,
// que se guarda como extra) y de cuál versión es. El teléfono manda al
// servidor EXACTAMENTE esas tomas (A1): el servidor nunca liga solo.
//   · Si solo falta una posición, viene marcada.
//   · Lo de sitio trae marcado «Todas las de hoy» (o «Todas las del <día>»
//     si la tarjeta solo trae tomas de un día anterior).
//   · Recuerda la última versión elegida en el sitio: en el loop de Vía
//     Verde solo se toca la versión que salió.
//   · Una foto vale para un solo día de cada campaña (A1): al prender una
//     versión se apaga la otra de la misma campaña.
//   · «Usar también para…» abre la misma hoja con la posición fija; una
//     versión que ya devolvió esa foto sale apagada con «Esta foto ya se
//     devolvió: toma otra» (B4).
//
// Ventana con role="dialog", foco en el título y Escape = Cancelar
// (useFocoModal). Pensada para 375 px: todo envuelve, botones de 44 px.
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import CerrarModal from '../../components/CerrarModal';
import { useFocoModal } from '../../lib/useFocoModal';
import { colorTono } from '../../lib/tonos';
import { diaCorto } from '../../lib/misTomasComp';
import type { MomentoPos } from '../../lib/plantillasComp';
import {
  alternarCual,
  POS_EXTRA,
  queEsPorOmision,
  seleccionPorOmision,
  todasLasDeHoy,
  type CandidataDeCual,
  type OpcionQueEs,
} from '../../lib/capturaComp';

export type EleccionHoja = { pos: string; momento: MomentoPos; toma_ids: number[] };

type Props = {
  /** 'nueva' = foto recién tomada (¿qué es? + ¿de cuál?); 'tambien' = «Usar también para…» (solo ¿de cuál?). */
  modo: 'nueva' | 'tambien';
  sitio_clave: string;
  /** Día de la visita (AAAA-MM-DD). */
  dia: string;
  /**
   * Día de la fila «Fotos del sitio» (capturaComp.diaFilaSitio; sin él, el de
   * la visita). Una tarjeta de Hoy con solo vencidas de ayer marca «Todas las
   * del <día>» para lo de sitio (26-oct-2026).
   */
  diaSitio?: string;
  /** La foto a la vista: un File del teléfono o la dirección pública. */
  archivo?: File | null;
  url?: string | null;
  tipo: 'foto' | 'video';
  /** «Foto 2 de 3» cuando se eligieron varias en Galería. */
  indice?: { i: number; n: number } | null;
  /** Lo que falta en la visita (modo 'nueva'). */
  opciones: OpcionQueEs[];
  /** Posición fija (modo 'tambien' o un video, que siempre es «Otra»). */
  posFija?: { pos: string; momento: MomentoPos; etiqueta: string } | null;
  /** Las versiones que se ofrecen para una posición. */
  candidatas: (pos: string, momento: MomentoPos) => CandidataDeCual[];
  /** La última versión elegida en este sitio (null = ninguna). */
  ultima: number | null;
  ocupado: boolean;
  /** Error de la última acción (se dice con role="alert"). */
  error: string;
  onListo: (e: EleccionHoja) => void;
  onCancelar: () => void;
};

const llave = (pos: string, momento: MomentoPos) => `${pos}|${momento ?? ''}`;

/** La miniatura de la foto (crea y libera su objectURL). */
function Vista({ archivo, url, tipo }: { archivo?: File | null; url?: string | null; tipo: 'foto' | 'video' }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!archivo) {
      setSrc(url ?? null);
      return;
    }
    const u = URL.createObjectURL(archivo);
    setSrc(u);
    return () => URL.revokeObjectURL(u);
  }, [archivo, url]);
  if (!src) return null;
  const estilo = { width: 96, height: 96, objectFit: 'cover' as const, borderRadius: 10, border: '1px solid var(--line)', flexShrink: 0 };
  return tipo === 'video' ? (
    <video src={src} muted playsInline preload="metadata" style={estilo} aria-label="Video elegido" />
  ) : (
    <img src={src} alt="Foto elegida" style={estilo} />
  );
}

export default function HojaQueEs({
  modo,
  sitio_clave,
  dia,
  diaSitio = dia,
  archivo,
  url,
  tipo,
  indice,
  opciones,
  posFija,
  candidatas,
  ultima,
  ocupado,
  error,
  onListo,
  onCancelar,
}: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  const titRef = useRef<HTMLHeadingElement>(null);
  const cancelar = () => {
    if (!ocupado) onCancelar();
  };
  useFocoModal(modalRef, titRef, cancelar);

  // ---- ¿Qué es? ----
  const fija = posFija ?? (tipo === 'video' ? { pos: POS_EXTRA, momento: null, etiqueta: 'Otra' } : null);
  // Sin nada que falte, «Otra» viene marcada (es lo único que hay y el texto
  // de abajo lo promete; revisión del 26-oct-2026).
  const [queEs, setQueEs] = useState<string | null>(() => {
    const o = queEsPorOmision(fija, opciones);
    return o ? llave(o.pos, o.momento) : null;
  });
  const opcion = useMemo(() => {
    if (fija) return { pos: fija.pos, momento: fija.momento, etiqueta: fija.etiqueta, alcance: 'version' as const };
    if (queEs === llave(POS_EXTRA, null)) return { pos: POS_EXTRA, momento: null, etiqueta: 'Otra', alcance: 'version' as const };
    const o = opciones.find((x) => llave(x.pos, x.momento) === queEs);
    return o ? { pos: o.pos, momento: o.momento, etiqueta: o.etiqueta, alcance: o.alcance } : null;
  }, [fija, queEs, opciones]);

  // ---- ¿De cuál? ----
  const cands = useMemo(() => (opcion ? candidatas(opcion.pos, opcion.momento) : []), [opcion, candidatas]);
  const [sel, setSel] = useState<number[]>([]);
  // Al cambiar qué es, vuelve lo que viene marcado por omisión.
  const firmaOpcion = opcion ? llave(opcion.pos, opcion.momento) : '';
  useEffect(() => {
    setSel(opcion ? seleccionPorOmision(cands, opcion.alcance, diaSitio, ultima) : []);
    // Solo al cambiar de posición (las candidatas se recalculan en cada render del padre).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firmaOpcion]);

  const deHoy = opcion?.alcance === 'sitio' ? todasLasDeHoy(cands, diaSitio) : [];
  const todasHoyOn = deHoy.length > 0 && deHoy.every((id) => sel.includes(id)) && sel.length === deHoy.length;
  const validas = sel.filter((id) => cands.some((c) => c.id === id && !c.devuelta));
  const listo = !!opcion && validas.length > 0 && !ocupado;

  const titulo =
    modo === 'tambien' ? 'Usar también para…' : indice && indice.n > 1 ? `Foto ${indice.i} de ${indice.n}` : '¿Qué foto es?';

  return (
    <div
      className="overlay"
      onClick={(e) => {
        // Un roce en el fondo no cierra mientras se guarda en el teléfono.
        if (e.target === e.currentTarget) cancelar();
      }}
    >
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hoja-quees-tit"
        style={{ maxWidth: 520, margin: 'auto 0' }}
      >
        <CerrarModal onClick={cancelar} disabled={ocupado} />
        <h2 id="hoja-quees-tit" ref={titRef} tabIndex={-1} style={{ margin: '0 0 3px', fontSize: 17, outline: 'none' }}>
          {titulo}
        </h2>
        <p className="phint" style={{ marginBottom: 10, overflowWrap: 'anywhere' }}>
          {sitio_clave} · {diaCorto(dia)}
        </p>

        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12, minWidth: 0 }}>
          <Vista archivo={archivo} url={url} tipo={tipo} />
          <div style={{ fontSize: 13, color: 'var(--muted)', minWidth: 0, overflowWrap: 'anywhere' }}>
            {tipo === 'video'
              ? 'Un video se sube como «Otra»: la analista lo ve, pero nunca cuenta para lo que pide la campaña.'
              : modo === 'tambien'
                ? `La misma foto (${posFija?.etiqueta ?? 'Otra'}) cuenta también en las versiones que elijas.`
                : 'Elige qué es y de cuál versión. La foto se guarda en el teléfono y se sube sola.'}
          </div>
        </div>

        {error && (
          <div className="err" role="alert">
            {error}
          </div>
        )}

        {!fija && (
          <div className="field">
            <div className="etiqueta" id="hoja-quees-que">
              ¿Qué es?
            </div>
            <div className="rt-chips" role="group" aria-labelledby="hoja-quees-que">
              {opciones.map((o) => {
                const k = llave(o.pos, o.momento);
                const on = queEs === k;
                return (
                  <button
                    key={k}
                    type="button"
                    className={'rt-chip' + (on ? ' on' : '')}
                    aria-pressed={on}
                    disabled={ocupado}
                    onClick={() => setQueEs(k)}
                    style={{ minHeight: 44, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                  >
                    {on ? '✓ ' : ''}
                    {o.etiqueta}
                    {o.faltan > 1 ? ` (faltan ${o.faltan})` : ''}
                    {o.alcance === 'sitio' ? ' · del sitio' : ''}
                  </button>
                );
              })}
              <button
                type="button"
                className={'rt-chip' + (queEs === llave(POS_EXTRA, null) ? ' on' : '')}
                aria-pressed={queEs === llave(POS_EXTRA, null)}
                disabled={ocupado}
                onClick={() => setQueEs(llave(POS_EXTRA, null))}
                style={{ minHeight: 44 }}
              >
                {queEs === llave(POS_EXTRA, null) ? '✓ ' : ''}Otra
              </button>
            </div>
            {!opciones.length && (
              <div className="phint" style={{ marginTop: 6 }}>
                Ya no falta nada en este sitio: la foto se guarda como «Otra» y la analista la ve.
              </div>
            )}
          </div>
        )}

        {opcion && (
          <div className="field">
            <div className="etiqueta" id="hoja-quees-cual">
              ¿De cuál?
            </div>
            {cands.length === 0 ? (
              <div className="phint" style={{ marginTop: 0 }}>
                {modo === 'tambien'
                  ? 'No hay otra versión abierta en este sitio que pida esta foto.'
                  : 'Ninguna versión abierta de este sitio pide esta foto. Elige «Otra» o revisa la lista.'}
              </div>
            ) : (
              <>
                {deHoy.length > 1 && (
                  <div className="rt-chips" style={{ marginBottom: 6 }}>
                    <button
                      type="button"
                      className={'rt-chip' + (todasHoyOn ? ' on' : '')}
                      aria-pressed={todasHoyOn}
                      disabled={ocupado}
                      onClick={() => setSel(todasHoyOn ? [] : deHoy)}
                      style={{ minHeight: 44, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                    >
                      {todasHoyOn ? '✓ ' : ''}
                      {diaSitio === dia ? 'Todas las de hoy' : `Todas las del ${diaCorto(diaSitio)}`} ({deHoy.length})
                    </button>
                  </div>
                )}
                <div className="rt-chips" role="group" aria-labelledby="hoja-quees-cual">
                  {cands.map((c) => {
                    const on = sel.includes(c.id) && !c.devuelta;
                    const nota =
                      c.estado === 'regresada' ? ' · devuelta' : c.fecha !== dia ? ` · del ${diaCorto(c.fecha)}` : '';
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={'rt-chip' + (on ? ' on' : '')}
                        aria-pressed={on}
                        disabled={ocupado || c.devuelta}
                        onClick={() => setSel((s) => alternarCual(s, c, cands))}
                        style={{
                          minHeight: 44,
                          maxWidth: '100%',
                          whiteSpace: 'normal',
                          overflowWrap: 'anywhere',
                          textAlign: 'left',
                          color: c.estado === 'regresada' && !on ? colorTono('rojo') : undefined,
                        }}
                      >
                        {on ? '✓ ' : ''}
                        {c.nombre}
                        {nota}
                        {!c.falta && !c.devuelta ? ' · ya la tiene' : ''}
                      </button>
                    );
                  })}
                </div>
                {cands.some((c) => c.devuelta) && (
                  <div style={{ fontSize: 13, color: colorTono('rojo'), marginTop: 6 }}>
                    Esta foto ya se devolvió en{' '}
                    {cands
                      .filter((c) => c.devuelta)
                      .map((c) => c.nombre)
                      .join(', ')}
                    : toma otra.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="modal-actions pie-fijo">
          <button type="button" className="btn ghost" onClick={cancelar} disabled={ocupado} style={{ minHeight: 44 }}>
            {modo === 'tambien' ? 'Cancelar' : indice && indice.n > 1 ? 'Saltar esta' : 'Descartar'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!listo}
            onClick={() => opcion && onListo({ pos: opcion.pos, momento: opcion.momento, toma_ids: validas })}
            style={{ minHeight: 44 }}
          >
            {ocupado ? (
              <>
                <span className="spinner" /> Guardando…
              </>
            ) : modo === 'tambien' ? (
              'Usar aquí'
            ) : (
              'Listo'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
