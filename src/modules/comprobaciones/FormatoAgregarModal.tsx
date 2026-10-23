// ============================================================
// src/modules/comprobaciones/FormatoAgregarModal.tsx
// Formato general · agregar tomas a mano (Erik, 23-oct-2026).
//
// Victor elige una campaña, sus sitios y los días; la base
// (comp_agregar_tomas) crea un renglón por sitio × día con origen 'app'
// (el plan ya no lo toca), con el horario del día y la ruta y el
// monitorista del sitio. Se salta lo que cae fuera del periodo, lo que ya
// estaba y lo que cae fuera de la vigencia del sitio; esto último se puede
// agregar de todos modos si Victor lo confirma (p_fuera_de_vigencia).
// Siempre se enseñan los conteos que devuelve la base.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import CerrarModal from '../../components/CerrarModal';
import { compararNatural, diasEntre, llaveComp } from '../../lib/comprobaciones';
import {
  agregarTomas,
  leerSitios,
  textoFallaComp,
  textoFallaEscrituraComp,
  type PeriodoCargado,
  type ResAgregarTomas,
  type SitioComp,
  type VwCampana,
} from '../../lib/comprobacionesApi';
import { dentroDe, esFinde, fechaCorta, nombreCampana, nTomas, textoVentanas, ventanasDe } from './FormatoComun';

type Props = {
  /** Campañas a las que se puede agregar (abiertas y no retiradas). */
  campanas: VwCampana[];
  campanaInicial?: number | null;
  sitiosIniciales?: number[];
  diasIniciales?: string[];
  periodo: PeriodoCargado;
  correr: <T>(etiqueta: string, fn: () => Promise<T>) => Promise<T | undefined>;
  telefono: boolean;
  onCerrar: () => void;
  /** Agregó algo: el texto va al aviso breve y la pestaña relee. */
  onListo: (texto: string) => void;
};

/** Tope de la base por lote (sitios × días). */
const TOPE_LOTE = 20000;

function textoResultado(d: ResAgregarTomas, forzado: boolean): string {
  const partes = [`✓ ${nTomas(d.agregadas)} ${d.agregadas === 1 ? 'agregada' : 'agregadas'}`];
  if (d.ya_estaban > 0) partes.push(`${d.ya_estaban} ya estaban`);
  if (d.fuera_del_periodo > 0) partes.push(`${d.fuera_del_periodo} fuera del periodo`);
  if (!forzado && d.fuera_de_vigencia > 0) partes.push(`${d.fuera_de_vigencia} fuera de la vigencia (no se agregaron)`);
  return partes.join(' · ');
}

export default function FormatoAgregarModal({
  campanas,
  campanaInicial,
  sitiosIniciales,
  diasIniciales,
  periodo,
  correr,
  telefono,
  onCerrar,
  onListo,
}: Props) {
  const ordenadas = useMemo(
    () => [...campanas].sort((a, b) => nombreCampana(a).localeCompare(nombreCampana(b), 'es')),
    [campanas]
  );
  const [campanaId, setCampanaId] = useState<number | null>(
    campanaInicial != null && campanas.some((c) => c.id === campanaInicial) ? campanaInicial : null
  );
  const campana = campanas.find((c) => c.id === campanaId) ?? null;

  const [sitios, setSitios] = useState<SitioComp[] | null>(null);
  const [errSitios, setErrSitios] = useState('');
  const [sel, setSel] = useState<Set<number>>(() => new Set(sitiosIniciales ?? []));
  const [fechas, setFechas] = useState<Set<string>>(() => new Set(diasIniciales ?? []));
  const [buscar, setBuscar] = useState('');
  const [forzar, setForzar] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState('');
  /** Lo que contestó la base la primera vez, si dejó fuera de vigencia. */
  const [pendienteVig, setPendienteVig] = useState<ResAgregarTomas | null>(null);

  // Sitios de la campaña elegida (comp_sitios, paginado).
  useEffect(() => {
    setSitios(null);
    setErrSitios('');
    setPendienteVig(null);
    if (campanaId == null) return;
    let vivo = true;
    leerSitios({ campanaIds: [campanaId] }).then((r) => {
      if (!vivo) return;
      if (!r.ok) {
        setErrSitios('No se pudieron leer los sitios: ' + textoFallaComp(r));
        setSitios([]);
        return;
      }
      setSitios([...r.data].sort((a, b) => compararNatural(a.sitio_clave, b.sitio_clave)));
      // Al cambiar de campaña, solo quedan elegidos los sitios que son suyos.
      setSel((s) => new Set([...s].filter((id) => r.data.some((x) => x.id === id))));
    });
    return () => {
      vivo = false;
    };
  }, [campanaId]);

  const dias = useMemo(() => diasEntre(periodo.inicio, periodo.fin), [periodo.inicio, periodo.fin]);

  /** No recibe tomas: cancelado, fuera de la carga (la base los rechaza). */
  const motivoNo = (s: SitioComp): string | null =>
    s.estado === 'cancelado' ? 'cancelado' : s.fuera_de_carga ? 'ya no viene en la carga' : null;

  const ventanasSitio = useMemo(() => {
    const m = new Map<number, ReturnType<typeof ventanasDe>>();
    for (const s of sitios ?? []) m.set(s.id, ventanasDe(s, campana, periodo));
    return m;
  }, [sitios, campana, periodo]);

  const visibles = useMemo(() => {
    const k = llaveComp(buscar);
    return (sitios ?? []).filter(
      (s) => !k || llaveComp(s.sitio_clave).includes(k) || llaveComp(s.sitio_original).includes(k)
    );
  }, [sitios, buscar]);

  const elegidos = (sitios ?? []).filter((s) => sel.has(s.id) && !motivoNo(s));
  const listaFechas = [...fechas].sort();
  const combinaciones = elegidos.length * listaFechas.length;
  // Cuántas caen fuera de la vigencia de su sitio (la misma cuenta que la base).
  let fueraVig = 0;
  for (const s of elegidos) {
    const vs = ventanasSitio.get(s.id) ?? [];
    for (const f of listaFechas) if (!dentroDe(f, vs)) fueraVig++;
  }

  const alternarSitio = (id: number) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const alternarDia = (d: string) =>
    setFechas((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });

  const enviar = async (conFuera: boolean) => {
    if (!elegidos.length || !listaFechas.length || guardando) return;
    setErr('');
    setGuardando(true);
    const r = await correr(`Agregando ${nTomas(combinaciones)}…`, () =>
      agregarTomas(
        elegidos.map((s) => s.id),
        listaFechas,
        conFuera
      )
    );
    setGuardando(false);
    if (r === undefined) {
      setErr('Hay otra acción guardando. Espera a que termine y vuelve a intentar.');
      return;
    }
    if (!r.ok) {
      setErr(textoFallaEscrituraComp(r));
      return;
    }
    const d = r.data;
    // Quedaron fuera de vigencia y no se pidió forzar: se pregunta aquí,
    // sin cerrar, para que Victor decida con el número de la base.
    if (!conFuera && d.fuera_de_vigencia > 0) {
      setPendienteVig(d);
      return;
    }
    const previo = pendienteVig;
    const texto = previo
      ? textoResultado(
          {
            agregadas: previo.agregadas + d.agregadas,
            ya_estaban: Math.max(0, d.ya_estaban - previo.agregadas),
            fuera_del_periodo: d.fuera_del_periodo,
            fuera_de_vigencia: 0,
          },
          true
        )
      : textoResultado(d, conFuera);
    if (!previo && d.agregadas === 0) {
      const motivos: string[] = [];
      if (d.ya_estaban > 0) motivos.push(`${d.ya_estaban} ya estaban`);
      if (d.fuera_del_periodo > 0) motivos.push(`${d.fuera_del_periodo} caen fuera del periodo`);
      setErr('No se agregó ninguna' + (motivos.length ? ': ' + motivos.join(' · ') + '.' : '.'));
      return;
    }
    onListo(texto);
  };

  const cerrar = () => {
    if (!guardando) {
      // Si ya se agregó algo en la primera vuelta, que la pestaña relea.
      if (pendienteVig && pendienteVig.agregadas > 0) onListo(textoResultado(pendienteVig, false));
      else onCerrar();
    }
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') cerrar();
      }}
    >
      <div className="modal" style={{ maxWidth: 640, margin: 'auto 0' }} role="dialog" aria-modal="true" aria-label="Agregar tomas">
        <CerrarModal onClick={cerrar} disabled={guardando} />
        <h2 style={{ margin: '0 0 3px', fontSize: 17 }}>Agregar tomas</h2>
        <p className="phint" style={{ marginBottom: 12 }}>
          Un renglón por sitio y día, con el horario del día y el monitorista de la ruta del sitio. El plan de la campaña ya no
          los toca.
        </p>

        <div className="field">
          <label htmlFor="fa-camp">Campaña</label>
          <select
            id="fa-camp"
            value={campanaId ?? ''}
            disabled={guardando || !!pendienteVig}
            onChange={(e) => setCampanaId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Elige una campaña…</option>
            {ordenadas.map((c) => (
              <option key={c.id} value={c.id}>
                {nombreCampana(c)}
              </option>
            ))}
          </select>
          {!ordenadas.length && (
            <div className="phint" style={{ margin: '4px 0 0' }}>
              No hay campañas abiertas en este periodo.
            </div>
          )}
        </div>

        {campanaId != null && (
          <div className="field">
            <label>
              Sitios {sitios ? `(${sel.size ? `${elegidos.length} de ` : ''}${sitios.length})` : ''}
            </label>
            {errSitios && <div className="err">{errSitios}</div>}
            {sitios === null ? (
              <div className="phint">
                <span className="spinner" />
                Leyendo los sitios…
              </div>
            ) : sitios.length === 0 ? (
              <div className="phint">Esta campaña no tiene sitios. Agrégalos en Campañas.</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                  {sitios.length > 8 && (
                    <input
                      value={buscar}
                      placeholder="Buscar sitio"
                      aria-label="Buscar sitio"
                      onChange={(e) => setBuscar(e.target.value)}
                      style={{ flex: '1 1 160px' }}
                    />
                  )}
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={guardando || !!pendienteVig}
                    onClick={() => setSel(new Set(visibles.filter((s) => !motivoNo(s)).map((s) => s.id)))}
                  >
                    Elegir {buscar ? 'los que se ven' : 'todos'}
                  </button>
                  {sel.size > 0 && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={guardando || !!pendienteVig}
                      onClick={() => setSel(new Set())}
                    >
                      Ninguno
                    </button>
                  )}
                </div>
                <div className="rt-lista" style={{ maxHeight: telefono ? 260 : 300 }}>
                  {visibles.map((s) => {
                    const no = motivoNo(s);
                    const on = sel.has(s.id) && !no;
                    return (
                      <label
                        key={s.id}
                        className={'rt-fila' + (on ? ' elegida' : '')}
                        style={{ alignItems: 'center', opacity: no ? 0.55 : 1, cursor: no ? 'default' : 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          style={{ width: 'auto', margin: 0 }}
                          checked={on}
                          disabled={!!no || guardando || !!pendienteVig}
                          onChange={() => alternarSitio(s.id)}
                        />
                        <span style={{ minWidth: 0 }}>
                          <span className="rt-fila-tit">{s.sitio_clave}</span>
                          <span className="rt-fila-sub" style={{ display: 'block' }}>
                            {no ? `No recibe tomas: ${no}` : `Vigencia: ${textoVentanas(ventanasSitio.get(s.id) ?? [])}`}
                            {s.estado === 'comprobado' ? ' · ya comprobado' : ''}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                  {!visibles.length && <div className="phint">Ningún sitio con «{buscar}».</div>}
                </div>
              </>
            )}
          </div>
        )}

        {campanaId != null && (
          <div className="field">
            <label>Días {listaFechas.length ? `(${listaFechas.length})` : ''}</label>
            <div className="rt-chips" role="group" aria-label="Días">
              {dias.map((d) => {
                const on = fechas.has(d);
                return (
                  <button
                    key={d}
                    type="button"
                    className={'rt-chip' + (on ? ' on' : '')}
                    aria-pressed={on}
                    disabled={guardando || !!pendienteVig}
                    style={{ minWidth: 74, fontWeight: esFinde(d) ? 500 : 700 }}
                    onClick={() => alternarDia(d)}
                  >
                    {fechaCorta(d)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {combinaciones > 0 && !pendienteVig && (
          <div className="phint" style={{ marginBottom: 10 }}>
            {nTomas(combinaciones)} por agregar ({elegidos.length} sitio{elegidos.length === 1 ? '' : 's'} ×{' '}
            {listaFechas.length} día{listaFechas.length === 1 ? '' : 's'}).
            {fueraVig > 0 && (
              <>
                {' '}
                {fueraVig} {fueraVig === 1 ? 'cae' : 'caen'} fuera de la vigencia de su sitio.
                <label className="rt-check">
                  <input type="checkbox" checked={forzar} onChange={(e) => setForzar(e.target.checked)} />
                  Agregarlas también (van fuera de la vigencia).
                </label>
              </>
            )}
            {combinaciones > TOPE_LOTE && (
              <div className="err" style={{ marginTop: 8 }}>
                Son demasiadas para un solo lote (máximo {TOPE_LOTE.toLocaleString('es-MX')}). Elige menos sitios o días.
              </div>
            )}
          </div>
        )}

        {pendienteVig && (
          <div className="rt-aviso" style={{ marginBottom: 10 }}>
            {textoResultado(pendienteVig, false)}.
            <br />
            ¿Agrego también {pendienteVig.fuera_de_vigencia === 1 ? 'la que cae' : `las ${pendienteVig.fuera_de_vigencia} que caen`}{' '}
            fuera de la vigencia del sitio?
            <div className="rt-aviso-acc">
              <button type="button" className="btn ghost sm" disabled={guardando} onClick={cerrar}>
                No, así está bien
              </button>
              <button type="button" className="btn sm" disabled={guardando} onClick={() => enviar(true)}>
                {guardando && <span className="spinner" />}
                Sí, agregarlas
              </button>
            </div>
          </div>
        )}

        {err && <div className="err">{err}</div>}
        {!pendienteVig && (
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={cerrar} disabled={guardando}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn"
              disabled={guardando || combinaciones === 0 || combinaciones > TOPE_LOTE}
              onClick={() => enviar(forzar)}
            >
              {guardando && <span className="spinner" />}
              {guardando ? 'Agregando…' : combinaciones ? `Agregar ${nTomas(combinaciones)}` : 'Agregar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
