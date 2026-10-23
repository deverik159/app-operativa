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
// plan ya no la pisa. Se enseña lo que devuelve la base (cambiadas, sin
// cambio, si ocupó el lugar de una quitada).
// ============================================================

import { useMemo, useState } from 'react';
import CerrarModal from '../../components/CerrarModal';
import { esMedio24h, diasEntre, HORARIO_24H, ETIQUETA_UNIDAD_COMP, type UnidadComp } from '../../lib/comprobaciones';
import {
  editarTomas,
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
      if ((mon || null) !== (una.monitorista_email || null)) c.monitorista_email = mon || null;
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
  }, [una, fecha, fechaCambia, horario, obs, notas, comprobacion, mon, turno, es24, conTurno]);

  const hayCambios = Object.keys(cambios).length > 0;
  const puedeGuardar = hayCambios && !guardando && (!debeConfirmar || fueraOk);

  const guardar = async () => {
    if (!puedeGuardar) return;
    setErr('');
    setGuardando(true);
    const envio: CambiosToma = { ...cambios, ...(cambios.fecha && debeConfirmar && fueraOk ? { fuera_de_vigencia: true } : {}) };
    const r = await correr(una ? 'Guardando la toma…' : `Editando ${nTomas(tomas.length)}…`, () =>
      editarTomas(
        tomas.map((t) => t.id),
        envio
      )
    );
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
    if (d.cambiadas === 0) {
      setErr('No se cambió nada: solo se editan tomas pendientes de campañas abiertas. Recarga para ver cómo están.');
      return;
    }
    const partes = [una ? '✓ Toma guardada' : `✓ ${nTomas(d.cambiadas)} editadas`];
    if (d.sin_cambio > 0) partes.push(`${d.sin_cambio} sin cambio (ya no estaban pendientes)`);
    if (d.quitada_reemplazada) partes.push('ocupó el lugar de una toma quitada ese día');
    onListo(partes.join(' · '));
  };

  const cerrar = () => {
    if (!guardando) onCerrar();
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') cerrar();
      }}
    >
      <div className="modal" style={{ maxWidth: 520, margin: 'auto 0' }} role="dialog" aria-modal="true" aria-label="Editar toma">
        <CerrarModal onClick={cerrar} disabled={guardando} />
        <h2 style={{ margin: '0 0 3px', fontSize: 17 }}>{una ? 'Editar toma' : `Editar ${nTomas(tomas.length)}`}</h2>
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
            <select id="ft-mon" value={mon} onChange={(e) => setMon(e.target.value)}>
              {!una && <option value={IGUAL}>No cambiar</option>}
              <option value="">Sin monitorista</option>
              {opcionesMon.map((m) => (
                <option key={m.email} value={m.email}>
                  {m.nombre}
                </option>
              ))}
            </select>
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

        {err && <div className="err">{err}</div>}
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
