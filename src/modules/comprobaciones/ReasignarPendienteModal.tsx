// ============================================================
// src/modules/comprobaciones/ReasignarPendienteModal.tsx
// «Pasar lo pendiente de X a Y» (23-oct-2026): cuando una analista se
// enferma o se satura, Victor pasa sus campañas abiertas a otra. Llama a
// comp_pasar_pendiente: primero con p_solo_contar (la previa con las cifras
// del SERVIDOR) y luego de verdad. Lo ya comprobado conserva quién lo marcó
// (comprobado_por): el crédito no se mueve.
//
// La lista de abajo es solo de este periodo y sale de lo que ya hay en
// pantalla, para que Victor vea cuáles son; la cifra que manda es la del
// servidor, que además puede abarcar todos los periodos de la unidad.
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import CerrarModal from '../../components/CerrarModal';
import { useFocoModal } from '../../lib/useFocoModal';
import {
  pasarPendiente,
  textoFallaComp,
  textoFallaEscrituraComp,
  type PeriodoCargado,
  type ResPasarPendiente,
  type VwCampana,
} from '../../lib/comprobacionesApi';
import { compararNatural } from '../../lib/comprobaciones';
import type { ContextoComp } from './tiposComp';
import { cajaLista, fmtN, opcionesAnalista, tituloCampana } from './CampanasPiezas';

type Props = ContextoComp & {
  periodo: PeriodoCargado;
  campanas: VwCampana[];
  /** Analista con la que abre (si se tocó su chip de carga). */
  deInicial?: string | null;
  onCerrar: () => void;
  onHecho: (texto: string) => void;
};

export default function ReasignarPendienteModal(props: Props) {
  const { periodo, campanas, equipo, nombreDe, unidad, correr, ocupado, onCerrar, onHecho } = props;
  const [de, setDe] = useState((props.deInicial || '').toLowerCase());
  const [a, setA] = useState('');
  const [soloSinAvance, setSoloSinAvance] = useState(false);
  const [todosPeriodos, setTodosPeriodos] = useState(false);
  const [previa, setPrevia] = useState<ResPasarPendiente | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [errPrevia, setErrPrevia] = useState('');
  const [err, setErr] = useState('');
  const pide = useRef(0);
  const trabajando = !!ocupado;

  // «De»: quien lleva campañas en este periodo y cualquiera del equipo.
  const opcionesDe = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of campanas) if (c.analista_email) m.set(c.analista_email, nombreDe(c.analista_email));
    for (const e of equipo) if (e.asignable) m.set(e.email, e.nombre || e.email);
    return [...m.entries()].map(([email, nombre]) => ({ email, nombre })).sort((x, y) => compararNatural(x.nombre, y.nombre));
  }, [campanas, equipo, nombreDe]);
  const opcionesA = useMemo(() => opcionesAnalista(equipo, null, nombreDe).filter((o) => o.email !== de), [equipo, nombreDe, de]);

  // Las de este periodo que entrarían (mismo criterio que la base:
  // abiertas de esa analista, con pendientes o sin avance; o solo sin avance).
  const locales = useMemo(
    () =>
      de
        ? campanas
            .filter(
              (c) =>
                c.estatus === 'abierta' &&
                c.analista_email === de &&
                (soloSinAvance ? c.comprobados === 0 : c.pendientes > 0 || c.comprobados === 0)
            )
            .sort((x, y) => compararNatural(tituloCampana(x), tituloCampana(y)))
        : [],
    [campanas, de, soloSinAvance]
  );

  // Previa del servidor: cada vez que cambia De, el alcance o el periodo.
  useEffect(() => {
    if (!de) {
      setPrevia(null);
      setErrPrevia('');
      return;
    }
    const n = ++pide.current;
    setLeyendo(true);
    setErrPrevia('');
    pasarPendiente({
      de,
      a: null,
      unidad,
      periodoId: todosPeriodos ? null : periodo.id,
      soloSinAvance,
      soloContar: true,
    }).then((r) => {
      if (n !== pide.current) return;
      setLeyendo(false);
      if (r.ok) setPrevia(r.data);
      else {
        setPrevia(null);
        setErrPrevia('No se pudo contar lo pendiente: ' + textoFallaComp(r));
      }
    });
  }, [de, soloSinAvance, todosPeriodos, unidad, periodo.id]);

  const n = previa?.campanas ?? 0;
  const puede = !!de && !!a && a !== de && !leyendo && !!previa && n > 0;

  async function pasar() {
    setErr('');
    const r = await correr('Pasando lo pendiente…', () =>
      pasarPendiente({ de, a, unidad, periodoId: todosPeriodos ? null : periodo.id, soloSinAvance, soloContar: false })
    );
    if (!r) {
      setErr('Hay otra acción guardando. Espera a que termine.');
      return;
    }
    if (!r.ok) {
      setErr(textoFallaEscrituraComp(r));
      if (r.sinRed) props.recargar();
      return;
    }
    const d = r.data;
    if (!d.campanas) {
      onHecho('No había nada pendiente que pasar.');
      return;
    }
    // La base contó campañas pero no pasó ninguna: se dice por qué, con lo
    // que contestó (revisión de pantallas, 23-oct-2026).
    if (!d.asignadas) {
      const motivos: string[] = [];
      if (d.cerradas_omitidas) motivos.push(`${fmtN(d.cerradas_omitidas)} se cerraron mientras tanto`);
      if (d.sin_cambio) motivos.push(`${fmtN(d.sin_cambio)} ya estaban con ${nombreDe(a)}`);
      onHecho(
        `${fmtN(d.campanas)} campaña${d.campanas === 1 ? '' : 's'} se saltaron` + (motivos.length ? ': ' + motivos.join(' · ') : '') + '.'
      );
      return;
    }
    onHecho(
      `✓ ${fmtN(d.asignadas)} campaña${d.asignadas === 1 ? '' : 's'} de ${nombreDe(de)} pasaron a ${nombreDe(a)}` +
        ` (${fmtN(d.sitios_pendientes)} sitios pendientes)` +
        (d.cerradas_omitidas ? ` · ${fmtN(d.cerradas_omitidas)} se cerraron mientras tanto` : '')
    );
  }

  const cerrar = () => {
    if (!trabajando) onCerrar();
  };
  // Foco, Tab y Escape de la ventana: ver useFocoModal.
  const titRef = useRef<HTMLHeadingElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocoModal(modalRef, titRef, cerrar);

  return (
    <div className="overlay" onClick={cerrar}>
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="comp-pasar-tit"
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'relative' }}
      >
        <CerrarModal onClick={cerrar} disabled={trabajando} />
        <h2 id="comp-pasar-tit" ref={titRef} tabIndex={-1} style={{ marginTop: 0, outline: 'none' }}>
          Pasar lo pendiente
        </h2>
        <p className="phint">Las campañas abiertas pasan a otra analista. Lo ya comprobado sigue contando para quien lo marcó.</p>

        <div className="field">
          <label htmlFor="comp-pasar-de">De</label>
          <select id="comp-pasar-de" value={de} disabled={trabajando} onChange={(e) => setDe(e.target.value)}>
            <option value="">Elige de quién…</option>
            {opcionesDe.map((o) => (
              <option key={o.email} value={o.email}>
                {o.nombre}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="comp-pasar-a">A</label>
          <select id="comp-pasar-a" value={a} disabled={trabajando} onChange={(e) => setA(e.target.value)}>
            <option value="">Elige a quién…</option>
            {opcionesA.map((o) => (
              <option key={o.email} value={o.email}>
                {o.nombre}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <div className="etiqueta">Qué campañas</div>
          <div className="rt-chips rt-segmento" role="group" aria-label="Qué campañas">
            {(
              [
                [false, 'Todas sus abiertas'],
                [true, 'Solo las que no ha empezado'],
              ] as const
            ).map(([v, t]) => (
              <button
                key={t}
                type="button"
                className={'rt-chip' + (soloSinAvance === v ? ' on' : '')}
                aria-pressed={soloSinAvance === v}
                disabled={trabajando}
                onClick={() => setSoloSinAvance(v)}
              >
                {soloSinAvance === v ? '✓ ' : ''}
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <div className="etiqueta">De qué periodo</div>
          <div className="rt-chips rt-segmento" role="group" aria-label="De qué periodo">
            {(
              [
                [false, `Solo ${periodo.etiqueta}`],
                [true, 'Todos los periodos'],
              ] as const
            ).map(([v, t]) => (
              <button
                key={t}
                type="button"
                className={'rt-chip' + (todosPeriodos === v ? ' on' : '')}
                aria-pressed={todosPeriodos === v}
                disabled={trabajando}
                onClick={() => setTodosPeriodos(v)}
              >
                {todosPeriodos === v ? '✓ ' : ''}
                {t}
              </button>
            ))}
          </div>
        </div>

        {de && (
          <div className="ok-msg" role="status" style={{ background: 'var(--panel2)', borderColor: 'var(--line)', color: 'var(--txt)' }}>
            {leyendo ? (
              <>
                <span className="spinner" />
                Contando…
              </>
            ) : previa ? (
              n ? (
                <>
                  <b>
                    {fmtN(n)} campaña{n === 1 ? '' : 's'} · {fmtN(previa.sitios_pendientes)} sitios pendientes
                  </b>{' '}
                  de {nombreDe(de)}
                  {todosPeriodos ? ' en todos los periodos' : ` en ${periodo.etiqueta}`}.
                </>
              ) : (
                <>{nombreDe(de)} no tiene nada pendiente con este alcance.</>
              )
            ) : null}
          </div>
        )}
        {errPrevia && <div className="err" role="alert">{errPrevia}</div>}

        {locales.length > 0 && (
          <details open={locales.length <= 12} style={{ marginBottom: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700, minHeight: 32 }}>
              Cuáles son en {periodo.etiqueta} ({fmtN(locales.length)})
            </summary>
            <div className="lista-scroll" style={{ ...cajaLista, marginTop: 6 }}>
              {locales.map((c) => (
                <div key={c.id}>
                  {tituloCampana(c)} · faltan {fmtN(c.pendientes)} de {fmtN(c.meta)}
                </div>
              ))}
            </div>
          </details>
        )}

        {err && (
          <div className="err" role="alert">
            {err}
          </div>
        )}

        <div className="modal-actions pie-fijo">
          <button type="button" className="btn ghost" onClick={cerrar} disabled={trabajando}>
            Cancelar
          </button>
          <button type="button" className="btn" disabled={!puede || trabajando} onClick={pasar}>
            {trabajando && <span className="spinner" />}
            {trabajando ? ocupado : a ? `Pasar ${fmtN(n)} a ${nombreDe(a)}` : 'Pasar'}
          </button>
        </div>
      </div>
    </div>
  );
}
