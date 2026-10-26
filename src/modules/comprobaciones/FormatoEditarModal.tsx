// ============================================================
// src/modules/comprobaciones/FormatoEditarModal.tsx
// Formato general · editar una toma o varias a la vez (Erik, 23-oct-2026).
//
// Una toma: fecha (dentro del periodo; si cae fuera de la vigencia del
// sitio se pide confirmarlo, como exige comp_editar_tomas con
// fuera_de_vigencia), horario (solo Vía Verde: Ecovallas Digital y Biobox
// son 24 HORAS), observaciones, notas, monitorista, turno y comprobación.
// Varias: lo mismo SIN la fecha (la base la cambia de una en una); un campo
// de texto vacío no cambia nada.
//
// Solo se manda lo que cambió. La toma editada queda con origen 'app' y el
// plan ya no la pisa, SALVO si solo cambió el monitorista (y notas): con la
// fase 3 (sql-6, 26-oct-2026) sigue siendo del plan y monitorista_manual
// protege al monitorista puesto a mano. Se enseña lo que devuelve la base
// (cambiadas, sin cambio, si ocupó el lugar de una quitada).
//
// MONITORISTA (fase 3, 26-oct-2026; M3): vacío = «el de la ruta». La toma
// sigue al monitorista que el coordinador asigna en Rutas y se recalcula
// sola. Si Victor elige a alguien, la base lo marca como puesto a mano
// (comp_tomas.monitorista_manual) y el cambio de ruta ya no lo mueve; volver
// a «el de la ruta» lo suelta. Para saber cuál es cuál se lee
// monitorista_manual al abrir; sin la migración de la fase 3 esa columna no
// existe y el campo se porta como antes («Sin monitorista»).
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import CerrarModal from '../../components/CerrarModal';
import { useFocoModal } from '../../lib/useFocoModal';
import { esMedio24h, diasEntre, HORARIO_24H, ETIQUETA_UNIDAD_COMP, type UnidadComp } from '../../lib/comprobaciones';
import {
  editarTomas,
  leerMonitoristaManual,
  refrescarMonitoristas,
  textoFallaEscrituraComp,
  type CambiosToma,
  type MonitoristaComp,
  type PeriodoCargado,
  type TurnoToma,
  type VwCampana,
  type VwToma,
} from '../../lib/comprobacionesApi';
import { dentroDe, ddmm, fechaCorta, nombreCampana, nTomas, textoVentanas, ventanasDeToma } from './FormatoComun';

type Props = {
  tomas: VwToma[];
  unidad: UnidadComp;
  periodo: PeriodoCargado;
  campanaDe: (id: number) => VwCampana | undefined;
  monitoristas: MonitoristaComp[];
  nombreDe: (email: string | null | undefined) => string;
  correr: <T>(etiqueta: string, fn: () => Promise<T>) => Promise<T | undefined>;
  onCerrar: () => void;
  /** Guardó: el texto va al aviso breve y la pestaña relee. */
  onListo: (texto: string) => void;
  /**
   * Sin respuesta de la base (sin red): no se sabe si se guardó, así que la
   * pestaña relee sin cerrar la ventana (revisión de pantallas, 23-oct-2026).
   */
  onSinRespuesta?: () => void;
};

const IGUAL = '__igual';
const TURNOS: { v: TurnoToma; l: string }[] = [
  { v: 'matutino', l: 'Matutino' },
  { v: 'vespertino', l: 'Vespertino' },
  { v: 'campo', l: 'Campo' },
];

export default function FormatoEditarModal({
  tomas,
  unidad,
  periodo,
  campanaDe,
  monitoristas,
  nombreDe,
  correr,
  onCerrar,
  onListo,
  onSinRespuesta,
}: Props) {
  const una = tomas.length === 1 ? tomas[0] : null;
  const es24 = esMedio24h(unidad);
  const conTurno = unidad === 'Vía Verde' || tomas.some((t) => t.turno);

  const [fecha, setFecha] = useState(una?.fecha.slice(0, 10) ?? '');
  const [horario, setHorario] = useState(una?.horario_texto ?? '');
  const [obs, setObs] = useState(una?.observaciones ?? '');
  const [notas, setNotas] = useState(una?.notas ?? '');
  const [comprobacion, setComprobacion] = useState(una?.comprobacion ?? '');
  const [mon, setMon] = useState<string>(una ? una.monitorista_email ?? '' : IGUAL);
  const [turno, setTurno] = useState<string>(una ? una.turno ?? '' : IGUAL);

  // ¿Monitorista puesto a mano? (fase 3). null = aún no se sabe o la base no
  // tiene la columna: entonces '' es «Sin monitorista», como en la fase 2.
  const [manual, setManual] = useState<Map<number, boolean> | null>(null);
  const tocoMon = useRef(false);
  useEffect(() => {
    let vivo = true;
    leerMonitoristaManual(tomas.map((t) => t.id)).then((r) => {
      if (!vivo || !r.ok) return;
      setManual(r.data);
      // Una toma que sigue a su ruta abre en «el de la ruta» (si no la tocaron ya).
      if (una && r.data.get(una.id) === false && !tocoMon.current) setMon('');
    });
    return () => {
      vivo = false;
    };
    // Una vez al abrir: las tomas de la ventana no cambian mientras está abierta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const conRuta = manual !== null;
  const manualUna = una && manual ? manual.get(una.id) : undefined;
  /** Lo que el select enseña al abrir: con eso se compara para saber si cambió. */
  const monInicial = una ? (conRuta && manualUna === false ? '' : una.monitorista_email ?? '') : IGUAL;
  const [fueraOk, setFueraOk] = useState(false);
  const [pideConfirmar, setPideConfirmar] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState('');

  // Los días del periodo; si la toma trae otro (no debería: la base lo
  // impide), también, para que el selector no la mueva sin querer.
  const dias = useMemo(() => {
    const l = diasEntre(periodo.inicio, periodo.fin);
    const f = una?.fecha.slice(0, 10);
    return f && !l.includes(f) ? [...l, f].sort() : l;
  }, [periodo.inicio, periodo.fin, una]);

  // Vigencia del sitio (una sola toma): la misma cuenta que hace la base.
  const ventanas = useMemo(
    () => (una ? ventanasDeToma(una, campanaDe(una.campana_id), periodo) : []),
    [una, campanaDe, periodo]
  );
  const fechaCambia = !!una && fecha !== una.fecha.slice(0, 10);
  const fueraDeVigencia = fechaCambia && !!fecha && !dentroDe(fecha, ventanas);
  const debeConfirmar = (fueraDeVigencia || pideConfirmar) && fechaCambia;

  // Monitoristas: la lista de la unidad y, si la toma trae a alguien que ya
  // no está en ella, también (para no borrarlo sin querer).
  const opcionesMon = useMemo(() => {
    const l = monitoristas.map((m) => ({ email: m.email.toLowerCase(), nombre: m.nombre }));
    for (const t of tomas) {
      const e = (t.monitorista_email || '').toLowerCase();
      if (e && !l.some((m) => m.email === e)) l.push({ email: e, nombre: `${nombreDe(e)} (ya no es monitorista)` });
    }
    return l.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }, [monitoristas, tomas, nombreDe]);

  /** Lo que cambió, como lo pide comp_editar_tomas. */
  const cambios = useMemo<CambiosToma>(() => {
    const c: CambiosToma = {};
    const limpio = (s: string) => (s.trim() === '' ? null : s.trim());
    if (una) {
      if (fechaCambia && fecha) c.fecha = fecha;
      if (!es24 && (limpio(horario) ?? null) !== (una.horario_texto ?? null)) c.horario_texto = limpio(horario);
      if (limpio(obs) !== (una.observaciones ?? null)) c.observaciones = limpio(obs);
      if (limpio(notas) !== (una.notas ?? null)) c.notas = limpio(notas);
      if (comprobacion.trim() && comprobacion.trim() !== una.comprobacion) c.comprobacion = comprobacion.trim();
      // Elegir a alguien lo fija (aunque sea el mismo de la ruta); vacío lo
      // devuelve a la ruta. Sin la columna (conRuta false), como antes.
      if (mon !== monInicial) c.monitorista_email = mon || null;
      if (conTurno && (turno || null) !== (una.turno || null)) c.turno = (turno || null) as TurnoToma | null;
    } else {
      if (!es24 && horario.trim()) c.horario_texto = horario.trim();
      if (obs.trim()) c.observaciones = obs.trim();
      if (notas.trim()) c.notas = notas.trim();
      if (comprobacion.trim()) c.comprobacion = comprobacion.trim();
      if (mon !== IGUAL) c.monitorista_email = mon || null;
      if (conTurno && turno !== IGUAL) c.turno = (turno || null) as TurnoToma | null;
    }
    return c;
  }, [una, fecha, fechaCambia, horario, obs, notas, comprobacion, mon, monInicial, turno, es24, conTurno]);

  const hayCambios = Object.keys(cambios).length > 0;
  const puedeGuardar = hayCambios && !guardando && (!debeConfirmar || fueraOk);

  const guardar = async () => {
    if (!puedeGuardar) return;
    setErr('');
    setGuardando(true);
    const envio: CambiosToma = { ...cambios, ...(cambios.fecha && debeConfirmar && fueraOk ? { fuera_de_vigencia: true } : {}) };
    const r = await correr(una ? 'Guardando la toma…' : `Editando ${nTomas(tomas.length)}…`, async () => {
      const e = await editarTomas(
        tomas.map((t) => t.id),
        envio
      );
      // Devuelta a «el de la ruta»: se toma de Rutas ya, sin esperar a que
      // alguien abra Formato o la lista del monitorista. Si falla, se hará
      // en el próximo refresco: lo guardado ya está.
      if (e.ok && e.data.cambiadas > 0 && conRuta && 'monitorista_email' in envio && envio.monitorista_email === null)
        await refrescarMonitoristas(periodo.id);
      return e;
    });
    setGuardando(false);
    if (r === undefined) {
      setErr('Hay otra acción guardando. Espera a que termine y vuelve a intentar.');
      return;
    }
    if (!r.ok) {
      // La base calcula la vigencia con los tramos guardados: si dice que
      // la fecha no está en la vigencia, se pide la confirmación aquí.
      if (/vigencia del sitio/i.test(r.error)) setPideConfirmar(true);
      setErr(textoFallaEscrituraComp(r));
      if (r.sinRed) onSinRespuesta?.();
      return;
    }
    const d = r.data;
    // V6 (comp_f3_modelo, 26-oct-2026): de una toma devuelta solo se cambia
    // el monitorista (y las notas); con otro cambio la base la salta y la cuenta.
    const omitidas = Number(d.regresadas_omitidas) || 0;
    const textoOmitidas = `${omitidas === 1 ? '1 devuelta se omitió' : `${omitidas} devueltas se omitieron`} (de una devuelta solo se cambia el monitorista)`;
    if (d.cambiadas === 0) {
      setErr(
        omitidas > 0
          ? `No se cambió nada: ${textoOmitidas}.`
          : 'No se cambió nada: solo se editan tomas pendientes de campañas abiertas. Recarga para ver cómo están.'
      );
      return;
    }
    const partes = [una ? '✓ Toma guardada' : `✓ ${nTomas(d.cambiadas)} editadas`];
    if (omitidas > 0) partes.push(textoOmitidas);
    // sin_cambio de la base ya incluye las devueltas omitidas: no se cuentan dos veces.
    const sinCambio = Math.max(0, d.sin_cambio - omitidas);
    if (sinCambio > 0) partes.push(`${sinCambio} sin cambio (ya no estaban pendientes)`);
    if (d.quitada_reemplazada) partes.push('ocupó el lugar de una toma quitada ese día');
    onListo(partes.join(' · '));
  };

  const cerrar = () => {
    if (!guardando) onCerrar();
  };
  // Foco, Tab y Escape de la ventana: ver useFocoModal.
  const titRef = useRef<HTMLHeadingElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocoModal(modalRef, titRef, cerrar);

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') cerrar();
      }}
    >
      <div
        ref={modalRef}
        className="modal"
        style={{ maxWidth: 520, margin: 'auto 0' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="comp-editar-tit"
      >
        <CerrarModal onClick={cerrar} disabled={guardando} />
        <h2 id="comp-editar-tit" ref={titRef} tabIndex={-1} style={{ margin: '0 0 3px', fontSize: 17, outline: 'none' }}>
          {una ? 'Editar toma' : `Editar ${nTomas(tomas.length)}`}
        </h2>
        {una ? (
          <p className="phint" style={{ marginBottom: 12, overflowWrap: 'anywhere' }}>
            <b>{una.sitio_clave}</b> · {nombreCampana(una)} · {fechaCorta(una.fecha)}
            <br />
            Vigencia del sitio: {textoVentanas(ventanas)}
          </p>
        ) : (
          <p className="phint" style={{ marginBottom: 12 }}>
            Lo que dejes vacío o en «No cambiar» se queda como está en cada toma. La fecha se cambia de una en una.
          </p>
        )}

        {una && (
          <div className="field">
            <label htmlFor="ft-fecha">Fecha</label>
            <select id="ft-fecha" value={fecha} onChange={(e) => (setFecha(e.target.value), setFueraOk(false))}>
              {dias.map((d) => (
                <option key={d} value={d}>
                  {fechaCorta(d)}
                  {dentroDe(d, ventanas) ? '' : ' · fuera de vigencia'}
                </option>
              ))}
            </select>
            {debeConfirmar && (
              <div className="rt-aviso">
                El {ddmm(fecha)} no está en la vigencia del sitio ({textoVentanas(ventanas)}).
                <label className="rt-check">
                  <input type="checkbox" checked={fueraOk} onChange={(e) => setFueraOk(e.target.checked)} />
                  Sí, esta toma va fuera de la vigencia.
                </label>
              </div>
            )}
          </div>
        )}

        <div className="field">
          <label htmlFor="ft-horario">Horario</label>
          {es24 ? (
            <div className="phint" style={{ margin: 0 }}>
              {HORARIO_24H}: en {ETIQUETA_UNIDAD_COMP[unidad]} no hay franjas.
            </div>
          ) : (
            <>
              <input
                id="ft-horario"
                value={horario}
                placeholder={una ? 'Sin horario' : 'No cambiar'}
                onChange={(e) => setHorario(e.target.value)}
              />
              {fechaCambia && !cambios.horario_texto && (
                <div className="phint" style={{ margin: '4px 0 0' }}>
                  Al mover la fecha, la base pone el horario de ese día (lunes a viernes o fin de semana) si no lo cambias aquí.
                </div>
              )}
            </>
          )}
        </div>

        <div className="row2">
          <div className="field">
            <label htmlFor="ft-mon">Monitorista</label>
            <select
              id="ft-mon"
              value={mon}
              aria-describedby={conRuta ? 'ft-mon-ayuda' : undefined}
              onChange={(e) => {
                tocoMon.current = true;
                setMon(e.target.value);
              }}
            >
              {!una && <option value={IGUAL}>No cambiar</option>}
              <option value="">
                {!conRuta
                  ? 'Sin monitorista'
                  : una && manualUna === false
                    ? `El de la ruta${una.monitorista_email ? ` (hoy: ${nombreDe(una.monitorista_email)})` : ' (la ruta no tiene)'}`
                    : 'El de la ruta (automático)'}
              </option>
              {opcionesMon.map((m) => (
                <option key={m.email} value={m.email}>
                  {m.nombre}
                </option>
              ))}
            </select>
            {conRuta && (
              <div id="ft-mon-ayuda" className="phint" style={{ margin: '4px 0 0' }}>
                Vacío = el de la ruta: sigue a quien el coordinador asigna en Rutas. Si eliges a alguien, queda fijo y el
                cambio de ruta ya no lo mueve.
                {una && manualUna === true ? ' Hoy está puesto a mano.' : ''}
              </div>
            )}
          </div>
          {conTurno ? (
            <div className="field">
              <label htmlFor="ft-turno">Turno</label>
              <select id="ft-turno" value={turno} onChange={(e) => setTurno(e.target.value)}>
                {!una && <option value={IGUAL}>No cambiar</option>}
                <option value="">Sin turno</option>
                {TURNOS.map((t) => (
                  <option key={t.v} value={t.v}>
                    {t.l}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="ft-comp">Comprobación</label>
              <input
                id="ft-comp"
                value={comprobacion}
                placeholder={una ? 'FOTO' : 'No cambiar'}
                onChange={(e) => setComprobacion(e.target.value)}
              />
            </div>
          )}
        </div>
        {conTurno && (
          <div className="field">
            <label htmlFor="ft-comp">Comprobación</label>
            <input
              id="ft-comp"
              value={comprobacion}
              placeholder={una ? 'FOTO' : 'No cambiar'}
              onChange={(e) => setComprobacion(e.target.value)}
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="ft-obs">Observaciones (las lee el monitorista)</label>
          <textarea
            id="ft-obs"
            rows={2}
            value={obs}
            placeholder={una ? '' : 'No cambiar'}
            onChange={(e) => setObs(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ft-notas">Notas internas</label>
          <textarea
            id="ft-notas"
            rows={2}
            value={notas}
            placeholder={una ? '' : 'No cambiar'}
            onChange={(e) => setNotas(e.target.value)}
          />
        </div>

        {err && <div className="err" role="alert">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={cerrar} disabled={guardando}>
            Cancelar
          </button>
          <button type="button" className="btn" onClick={guardar} disabled={!puedeGuardar}>
            {guardando && <span className="spinner" />}
            {guardando ? 'Guardando…' : hayCambios ? 'Guardar' : 'Sin cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}
