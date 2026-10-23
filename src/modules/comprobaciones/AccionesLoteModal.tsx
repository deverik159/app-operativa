// ============================================================
// src/modules/comprobaciones/AccionesLoteModal.tsx
// Acciones en lote de la pestaña Campañas (23-oct-2026): asignar o quitar
// analista, cerrar o reabrir, fecha límite, meta, retirar o regresar y FULL
// (solo Vía Verde). Una acción a la vez, por las RPC de comprobacionesApi.
//
// Por qué así:
//   · La RLS niega en silencio: el «✓» sale de lo que DEVUELVE la RPC
//     (asignadas, cambiadas, omitidas), nunca de lo que se pidió.
//   · Antes de mandar se dice qué se va a tocar con los datos que ya hay
//     en pantalla («3 no llegan a la meta: escribe el motivo»), porque la
//     base rechaza el lote entero si falta el motivo (P1).
//   · Las cerradas se saltan al asignar y al editar (la base las cuenta en
//     cerradas_omitidas); se avisa antes y después.
//   · Retirar BORRA las campañas que nadie trabajó (comp_retirar): se dice
//     con todas sus letras antes de confirmar.
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import CerrarModal from '../../components/CerrarModal';
import {
  asignarAnalista,
  cerrarCampanas,
  editarCampanas,
  retirarCampanas,
  textoFallaEscrituraComp,
  type CambiosCampana,
  type ResultadoComp,
  type VwCampana,
} from '../../lib/comprobacionesApi';
import type { ContextoComp } from './tiposComp';
import { fmtDia, fmtN, opcionesAnalista, textoTomas, tituloCampana, cajaLista } from './CampanasPiezas';

export type AccionLote =
  | 'asignar'
  | 'quitar'
  | 'cerrar'
  | 'reabrir'
  | 'limite'
  | 'meta'
  | 'retirar'
  | 'regresar'
  | 'full';

const ETIQUETA_ACCION: Record<AccionLote, string> = {
  asignar: 'Asignar a',
  quitar: 'Quitar analista',
  cerrar: 'Cerrar',
  reabrir: 'Reabrir',
  limite: 'Fecha límite',
  meta: 'Meta',
  retirar: 'Retirar',
  // «Regresar» decía otra cosa en el detalle y en los reportes (23-oct-2026).
  regresar: 'Quitar retiro',
  full: 'FULL',
};

type Props = ContextoComp & {
  elegidas: VwCampana[];
  /** Cuántas de las elegidas no se ven con el filtro de ahora (se avisa). */
  ocultas?: number;
  /** Acción con la que abre (la barra o un atajo). */
  inicial?: AccionLote;
  onCerrar: () => void;
  /** Terminó bien: el padre cierra, avisa y relee. */
  onHecho: (texto: string) => void;
};

export default function AccionesLoteModal(props: Props) {
  const { elegidas, equipo, nombreDe, unidad, correr, ocupado, onCerrar, onHecho } = props;
  const esVV = unidad === 'Vía Verde';
  const acciones = useMemo<AccionLote[]>(
    () =>
      (['asignar', 'quitar', 'cerrar', 'reabrir', 'limite', 'meta', 'retirar', 'regresar', 'full'] as AccionLote[]).filter(
        (a) => a !== 'full' || esVV
      ),
    [esVV]
  );
  const [accion, setAccion] = useState<AccionLote>(props.inicial && acciones.includes(props.inicial) ? props.inicial : 'asignar');
  const [analista, setAnalista] = useState('');
  const [motivo, setMotivo] = useState('');
  const [fecha, setFecha] = useState('');
  const [meta, setMeta] = useState('');
  const [full, setFull] = useState<'si' | 'no' | 'carga'>('si');
  const [err, setErr] = useState('');
  const trabajando = !!ocupado;
  // Al abrir, el foco va al título (VoiceOver y teclado empiezan aquí).
  const titRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titRef.current?.focus();
  }, []);

  // Lo que hay en pantalla, para decir antes qué se va a tocar.
  const cuenta = useMemo(() => {
    const abiertas = elegidas.filter((c) => c.estatus === 'abierta');
    return {
      total: elegidas.length,
      abiertas: abiertas.length,
      cerradas: elegidas.length - abiertas.length,
      incompletas: abiertas.filter((c) => !c.completa),
      conAnalista: abiertas.filter((c) => !!c.analista_email).length,
      vivas: abiertas.filter((c) => !c.retirada),
      retiradas: abiertas.filter((c) => c.retirada),
      sinTrabajo: abiertas.filter(
        (c) => !c.retirada && !c.comprobados && !c.cancelados && !c.tomas_editadas && !c.analista_email && !c.editado_app?.length
      ).length,
    };
  }, [elegidas]);

  const opciones = useMemo(() => opcionesAnalista(equipo, null, nombreDe), [equipo, nombreDe]);

  /** Corre la RPC con el candado y traduce el resultado. */
  async function lanzar<T>(etiqueta: string, fn: () => Promise<ResultadoComp<T>>, exito: (d: T) => string | null) {
    setErr('');
    const r = await correr(etiqueta, fn);
    if (!r) {
      setErr('Hay otra acción guardando. Espera a que termine.');
      return;
    }
    if (!r.ok) {
      setErr(textoFallaEscrituraComp(r));
      // Sin respuesta no se sabe si se guardó: se relee igual (el padre).
      if (r.sinRed) props.recargar();
      return;
    }
    const t = exito(r.data);
    if (t === null) return;
    onHecho(t);
  }

  const ids = elegidas.map((c) => c.id);
  const omitCerr = (n: number | undefined) => (n ? ` · ${fmtN(n)} cerrada${n === 1 ? '' : 's'} sin tocar` : '');

  // ---- Qué se manda y qué dice cada acción --------------------------------
  let resumen = '';
  let aviso = '';
  let puede = true;
  let boton = '';
  let ejecutar: () => void = () => {};

  if (accion === 'asignar' || accion === 'quitar') {
    const a = accion === 'asignar' ? analista : '';
    resumen =
      accion === 'asignar'
        ? `${fmtN(cuenta.abiertas)} abierta${cuenta.abiertas === 1 ? '' : 's'} pasan a ${a ? nombreDe(a) : '…'}. Lo ya comprobado conserva quién lo marcó.`
        : `Se quita la analista de ${fmtN(cuenta.conAnalista)} campaña${cuenta.conAnalista === 1 ? '' : 's'} abierta${cuenta.conAnalista === 1 ? '' : 's'}.`;
    if (cuenta.cerradas) aviso = `${fmtN(cuenta.cerradas)} cerrada${cuenta.cerradas === 1 ? '' : 's'} no se toca${cuenta.cerradas === 1 ? '' : 'n'}: reábrelas antes si hace falta.`;
    // La analista elegida debe seguir en la lista (si el equipo no se pudo
    // leer, el select se queda sin opciones y no se asigna a ciegas).
    puede = cuenta.abiertas > 0 && (accion === 'quitar' || (!!a && opciones.some((o) => o.email === a)));
    boton = accion === 'asignar' ? `Asignar ${fmtN(cuenta.abiertas)}` : 'Quitar analista';
    ejecutar = () =>
      lanzar(accion === 'asignar' ? 'Asignando…' : 'Quitando analista…', () => asignarAnalista(ids, a || null), (d) => {
        const quien = a ? nombreDe(a) : 'nadie';
        if (!d.asignadas) return `Sin cambios: ya estaban con ${quien}${omitCerr(d.cerradas_omitidas)}.`;
        return a
          ? `✓ ${fmtN(d.asignadas)} asignada${d.asignadas === 1 ? '' : 's'} a ${quien}${omitCerr(d.cerradas_omitidas)}`
          : `✓ Analista quitada de ${fmtN(d.asignadas)}${omitCerr(d.cerradas_omitidas)}`;
      });
  } else if (accion === 'cerrar') {
    const inc = cuenta.incompletas.length;
    resumen = `Se cierran ${fmtN(cuenta.abiertas)} campaña${cuenta.abiertas === 1 ? '' : 's'} abierta${cuenta.abiertas === 1 ? '' : 's'}. La analista ya no podrá marcar en ellas.`;
    if (inc) aviso = `${fmtN(inc)} no llega${inc === 1 ? '' : 'n'} a la meta: escribe el motivo para cerrarla${inc === 1 ? '' : 's'}.`;
    puede = cuenta.abiertas > 0 && (!inc || motivo.trim().length > 0);
    boton = `Cerrar ${fmtN(cuenta.abiertas)}`;
    ejecutar = () =>
      lanzar('Cerrando…', () => cerrarCampanas(ids, true, motivo.trim() || null), (d) =>
        d.cambiadas
          ? `✓ ${fmtN(d.cambiadas)} cerrada${d.cambiadas === 1 ? '' : 's'}${d.incompletas ? ` (${fmtN(d.incompletas)} abajo de la meta)` : ''}`
          : 'Sin cambios: ya estaban cerradas.'
      );
  } else if (accion === 'reabrir') {
    resumen = `Se reabren ${fmtN(cuenta.cerradas)} campaña${cuenta.cerradas === 1 ? '' : 's'} cerrada${cuenta.cerradas === 1 ? '' : 's'}; la analista podrá volver a marcar.`;
    puede = cuenta.cerradas > 0;
    boton = `Reabrir ${fmtN(cuenta.cerradas)}`;
    ejecutar = () =>
      lanzar('Reabriendo…', () => cerrarCampanas(ids, false, motivo.trim() || null), (d) =>
        d.cambiadas ? `✓ ${fmtN(d.cambiadas)} reabierta${d.cambiadas === 1 ? '' : 's'}` : 'Sin cambios: ya estaban abiertas.'
      );
  } else if (accion === 'limite' || accion === 'meta' || accion === 'full') {
    let cambios: CambiosCampana | null = null;
    if (accion === 'limite') {
      resumen = fecha
        ? `Fecha límite ${fmtDia(fecha)} en ${fmtN(cuenta.abiertas)} abierta${cuenta.abiertas === 1 ? '' : 's'}.`
        : 'Sin fecha: cada una vuelve a la de la regla o al fin de la campaña.';
      cambios = { fecha_limite: fecha || null };
    } else if (accion === 'meta') {
      const n = meta.trim() === '' ? null : Number(meta);
      const ok = n === null || (Number.isInteger(n) && n >= 0);
      resumen =
        n === null
          ? 'Sin meta escrita: cada una vuelve a contar sus sitios activos (o la meta FULL).'
          : `Meta de ${fmtN(n)} sitios en ${fmtN(cuenta.abiertas)} abierta${cuenta.abiertas === 1 ? '' : 's'}.`;
      if (!ok) aviso = 'La meta es un número entero de 0 en adelante.';
      cambios = ok ? { meta_app: n } : null;
    } else {
      resumen =
        full === 'carga'
          ? 'FULL vuelve a lo que diga la próxima carga de Pauta VV o del plano.'
          : full === 'si'
            ? 'Se marcan como FULL: la meta se propone por la regla de minutos (sin confirmar) y la analista puede agregar columnas.'
            : 'Dejan de ser FULL: la meta vuelve a contar sus sitios.';
      cambios = { es_full: full === 'carga' ? null : full === 'si' };
    }
    if (cuenta.cerradas) aviso = (aviso ? aviso + ' ' : '') + `${fmtN(cuenta.cerradas)} cerrada${cuenta.cerradas === 1 ? '' : 's'} no se toca${cuenta.cerradas === 1 ? '' : 'n'}.`;
    puede = cuenta.abiertas > 0 && !!cambios;
    boton = `Guardar en ${fmtN(cuenta.abiertas)}`;
    const etiqueta = accion === 'limite' ? 'Cambiando la fecha límite…' : accion === 'meta' ? 'Cambiando la meta…' : 'Cambiando FULL…';
    ejecutar = () =>
      cambios &&
      lanzar(etiqueta, () => editarCampanas(ids, cambios as CambiosCampana), (d) => {
        if (!d.cambiadas) return `Sin cambios${omitCerr(d.cerradas_omitidas)}.`;
        const tom = textoTomas(d);
        return `✓ ${fmtN(d.cambiadas)} cambiada${d.cambiadas === 1 ? '' : 's'}${omitCerr(d.cerradas_omitidas)}${tom ? ' · ' + tom : ''}`;
      });
  } else if (accion === 'retirar') {
    const n = cuenta.vivas.length;
    resumen = `Se retiran ${fmtN(n)} campaña${n === 1 ? '' : 's'}: dejan de contar en la meta y sus tomas pendientes salen del plan. Úsalo para la versión repetida o la campaña que ya no va.`;
    aviso =
      `Las que nadie ha trabajado (sin analista, sin marcas, sin cambios en la app) se BORRAN con sus sitios y tomas` +
      (cuenta.sinTrabajo ? `; parecen ser ${fmtN(cuenta.sinTrabajo)}.` : '.') +
      (cuenta.cerradas ? ` ${fmtN(cuenta.cerradas)} cerrada${cuenta.cerradas === 1 ? '' : 's'} no se toca${cuenta.cerradas === 1 ? '' : 'n'}.` : '');
    puede = n > 0;
    boton = `Retirar ${fmtN(n)}`;
    ejecutar = () => {
      if (!window.confirm(`¿Retirar ${n} campaña${n === 1 ? '' : 's'}? Las que nadie ha trabajado se borran.`)) return;
      lanzar('Retirando…', () => retirarCampanas(ids, true), (d) => {
        if (!d.cambiadas) return 'Sin cambios: ya estaban retiradas o cerradas.';
        // Lo que hubo, con lo que contestó la base: retiradas y/o borradas.
        const tom = textoTomas(d);
        const partes: string[] = [];
        if (d.retiradas) partes.push(`${fmtN(d.retiradas)} retirada${d.retiradas === 1 ? '' : 's'}`);
        if (d.borradas) partes.push(`${fmtN(d.borradas)} borrada${d.borradas === 1 ? '' : 's'} (nadie las había trabajado)`);
        if (tom) partes.push(tom);
        return '✓ ' + partes.join(' · ');
      });
    };
  } else if (accion === 'regresar') {
    const n = cuenta.retiradas.length;
    resumen = `Se quita el retiro a ${fmtN(n)} campaña${n === 1 ? '' : 's'}: vuelven a contar y su plan de tomas se aplica otra vez.`;
    puede = n > 0;
    boton = `Quitar retiro a ${fmtN(n)}`;
    ejecutar = () =>
      lanzar('Quitando el retiro…', () => retirarCampanas(ids, false), (d) => {
        if (!d.regresadas) return 'Sin cambios: ninguna estaba retirada.';
        const tom = textoTomas(d);
        return `✓ ${fmtN(d.regresadas)} ya no ${d.regresadas === 1 ? 'está retirada' : 'están retiradas'}${tom ? ' · ' + tom : ''}`;
      });
  }

  const cerrar = () => {
    if (!trabajando) onCerrar();
  };

  return (
    <div className="overlay" onClick={cerrar}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="comp-acc-tit" onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
        <CerrarModal onClick={cerrar} disabled={trabajando} />
        <h2 id="comp-acc-tit" ref={titRef} tabIndex={-1} style={{ marginTop: 0, outline: 'none' }}>
          {fmtN(elegidas.length)} campaña{elegidas.length === 1 ? '' : 's'} elegida{elegidas.length === 1 ? '' : 's'}
        </h2>
        {/* Cuáles van en el lote, antes de confirmar (revisión de pantallas,
            23-oct-2026): la selección sobrevive a los filtros y antes solo
            se veía la cifra. */}
        {!!props.ocultas && (
          <div className="banner">
            {fmtN(props.ocultas)} de las elegidas no se {props.ocultas === 1 ? 've' : 'ven'} con el filtro de ahora. Revisa la lista antes de confirmar.
          </div>
        )}
        <details style={{ marginBottom: 10 }} open={!!props.ocultas && elegidas.length <= 30}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>Ver cuáles</summary>
          <div className="lista-scroll" style={{ ...cajaLista, marginTop: 6 }}>
            {elegidas.slice(0, 200).map((c) => (
              <div key={c.id}>
                {tituloCampana(c)}
                {c.analista_email ? ` · ${nombreDe(c.analista_email)}` : ' · sin analista'}
                {c.estatus === 'cerrada' ? ' · cerrada' : ''}
                {c.retirada ? ' · retirada' : ''}
              </div>
            ))}
            {elegidas.length > 200 && <div>y {fmtN(elegidas.length - 200)} más</div>}
          </div>
        </details>

        <div className="rt-chips rt-segmento" role="group" aria-label="Acción">
          {acciones.map((a) => (
            <button
              key={a}
              type="button"
              className={'rt-chip' + (accion === a ? ' on' : '')}
              aria-pressed={accion === a}
              disabled={trabajando}
              onClick={() => {
                setAccion(a);
                setErr('');
              }}
            >
              {accion === a ? '✓ ' : ''}
              {ETIQUETA_ACCION[a]}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 14 }}>
          {accion === 'asignar' && (
            <div className="field">
              <label htmlFor="comp-acc-analista">Analista</label>
              <select id="comp-acc-analista" value={analista} disabled={trabajando} onChange={(e) => setAnalista(e.target.value)}>
                <option value="">Elige a quién…</option>
                {opciones.map((o) => (
                  <option key={o.email} value={o.email}>
                    {o.nombre}
                  </option>
                ))}
              </select>
              {!opciones.length && (
                <div className="phint" style={{ marginTop: 6 }}>
                  No hay analistas con rol en esta unidad. Se dan de alta en Usuarios.
                </div>
              )}
            </div>
          )}
          {(accion === 'cerrar' || accion === 'reabrir') && (
            <div className="field">
              <label htmlFor="comp-acc-motivo">
                Motivo{accion === 'cerrar' && cuenta.incompletas.length ? ' (obligatorio)' : ' (opcional)'}
              </label>
              <textarea
                id="comp-acc-motivo"
                rows={2}
                value={motivo}
                disabled={trabajando}
                placeholder={accion === 'cerrar' ? 'Ej.: el cliente bajó la campaña antes' : ''}
                onChange={(e) => setMotivo(e.target.value)}
              />
            </div>
          )}
          {accion === 'cerrar' && cuenta.incompletas.length > 0 && (
            <div className="lista-scroll" style={{ ...cajaLista, marginBottom: 12 }}>
              {cuenta.incompletas.slice(0, 60).map((c) => (
                <div key={c.id}>
                  {tituloCampana(c)} · {fmtN(c.comprobados)}/{fmtN(c.meta)}
                </div>
              ))}
              {cuenta.incompletas.length > 60 && <div>y {fmtN(cuenta.incompletas.length - 60)} más</div>}
            </div>
          )}
          {accion === 'limite' && (
            <div className="field">
              <label htmlFor="comp-acc-fecha">Fecha límite</label>
              <input id="comp-acc-fecha" type="date" value={fecha} disabled={trabajando} onChange={(e) => setFecha(e.target.value)} />
              <div className="phint" style={{ marginTop: 6 }}>
                Déjala vacía para volver a la fecha de la regla o al fin de la campaña.
              </div>
            </div>
          )}
          {accion === 'meta' && (
            <div className="field">
              <label htmlFor="comp-acc-meta">Meta (sitios por comprobar)</label>
              <input
                id="comp-acc-meta"
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={meta}
                disabled={trabajando}
                onChange={(e) => setMeta(e.target.value)}
              />
              <div className="phint" style={{ marginTop: 6 }}>
                Vacía = cada campaña cuenta sus sitios activos (o la meta FULL).
              </div>
            </div>
          )}
          {accion === 'full' && (
            <div className="rt-chips rt-segmento" role="group" aria-label="FULL">
              {(
                [
                  ['si', 'Sí es FULL'],
                  ['no', 'No es FULL'],
                  ['carga', 'Lo que diga la carga'],
                ] as const
              ).map(([v, t]) => (
                <button
                  key={v}
                  type="button"
                  className={'rt-chip' + (full === v ? ' on' : '')}
                  aria-pressed={full === v}
                  disabled={trabajando}
                  onClick={() => setFull(v)}
                >
                  {full === v ? '✓ ' : ''}
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <p className="phint" style={{ marginTop: 10 }}>
          {resumen}
        </p>
        {aviso && <div className="banner">{aviso}</div>}
        {err && (
          <div className="err" role="alert">
            {err}
          </div>
        )}

        <div className="modal-actions pie-fijo">
          <button type="button" className="btn ghost" onClick={cerrar} disabled={trabajando}>
            Cancelar
          </button>
          <button type="button" className={accion === 'retirar' ? 'btn warn' : 'btn'} disabled={!puede || trabajando} onClick={ejecutar}>
            {trabajando && <span className="spinner" />}
            {trabajando ? ocupado : boton}
          </button>
        </div>
      </div>
    </div>
  );
}
