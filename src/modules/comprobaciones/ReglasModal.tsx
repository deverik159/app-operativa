// ============================================================
// src/modules/comprobaciones/ReglasModal.tsx
// Reglas de la unidad como DATOS editables (comp_reglas), 23-oct-2026.
//
// Las reglas que hoy viven escritas en los Excel (FULL por minutos, avances
// según sitios, fecha límite según sitios, pendientes N días antes, tomas
// especiales por cliente) siguen SIN CONFIRMAR con el Supervisor: Erik se
// las pregunta a Victor. Por eso aquí solo se guardan y se enseñan, cada una
// con su etiqueta «sin confirmar», y nada se aplica solo… salvo una cosa que
// conviene que el Supervisor sepa: la fecha límite que la app propone (la de
// vw_comp_campanas cuando nadie puso una) sale de «Fecha límite por sitios».
//
// Lo abre quien lee toda la unidad (Supervisor, manager, Coordinador). Edita
// el Supervisor de la unidad o el manager; las generales («todas las
// unidades») solo el manager: la base lo valida (comp_guardar_regla) y aquí
// se enseña su mensaje tal cual. Una escritura a la vez (ctx.correr).
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, Plus, Trash } from 'lucide-react';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';
import { ETIQUETA_UNIDAD_COMP } from '../../lib/comprobaciones';
import {
  borrarRegla,
  guardarRegla,
  leerReglas,
  textoFallaComp,
  textoFallaEscrituraComp,
  type ReglaComp,
  type ReglaEnvio,
  type TipoRegla,
} from '../../lib/comprobacionesApi';
import { colorTono, fondoTono } from '../../lib/tonos';
import { nf } from './AvanceComun';
import type { ContextoComp } from './tiposComp';

type Props = ContextoComp & {
  /** Puede guardar y borrar (Supervisor de la unidad o manager). */
  editable: boolean;
  onCerrar: () => void;
};

/** Cómo se lee cada tipo: qué significan desde/hasta y valor. */
const TIPOS: Record<
  TipoRegla,
  { titulo: string; ayuda: string; rango: 'min' | 'sitios' | null; valor: 'pct' | 'sitios' | 'dias' | null; texto: boolean; cliente: boolean }
> = {
  full_porcentaje: {
    titulo: 'FULL por minutos',
    ayuda: 'Según los minutos comprados, qué % de las columnas activas de CDMX se comprueba. Propone la meta de un FULL.',
    rango: 'min',
    valor: 'pct',
    texto: false,
    cliente: false,
  },
  avances_por_sitios: {
    titulo: 'Avances según sitios',
    ayuda: 'Cuántos sitios van en el avance según los sitios de la campaña («TODAS» si van todos).',
    rango: 'sitios',
    valor: 'sitios',
    texto: true,
    cliente: false,
  },
  dias_limite_por_sitios: {
    titulo: 'Fecha límite según sitios',
    ayuda: 'Días después del inicio para tener la carpeta, según los sitios. La app propone con esto la fecha límite de las campañas que no tienen una puesta a mano.',
    rango: 'sitios',
    valor: 'dias',
    texto: false,
    cliente: false,
  },
  pendientes_dias_antes: {
    titulo: 'Pendientes antes del fin',
    ayuda: 'Cuántos días antes del fin se manda la lista de pendientes.',
    rango: null,
    valor: 'dias',
    texto: false,
    cliente: false,
  },
  toma_especial_cliente: {
    titulo: 'Tomas especiales por cliente',
    ayuda: 'Lo que pide un cliente en particular (tomas cortas, medias y largas, etc.). Escribe parte del nombre del cliente.',
    rango: null,
    valor: null,
    texto: true,
    cliente: true,
  },
  texto_general: {
    titulo: 'Reglas generales',
    ayuda: 'Indicaciones que aplican a todas las campañas de la unidad.',
    rango: null,
    valor: null,
    texto: true,
    cliente: false,
  },
};

const ORDEN_TIPOS = Object.keys(TIPOS) as TipoRegla[];

/** Lo que se teclea (todo texto, como lo dan los input). */
type Borrador = {
  id: number | null;
  unidad: ReglaComp['unidad'];
  tipo: TipoRegla;
  desde: string;
  hasta: string;
  valor: string;
  valor_texto: string;
  cliente_patron: string;
  notas: string;
  confirmada: boolean;
};

const aTexto = (n: number | null | undefined) => (n == null ? '' : String(n));

function borradorDe(r: ReglaComp): Borrador {
  const t = TIPOS[r.tipo];
  return {
    id: r.id,
    unidad: r.unidad,
    tipo: r.tipo,
    desde: aTexto(r.desde),
    hasta: aTexto(r.hasta),
    // El % se guarda como fracción (0.30) y se teclea como 30.
    valor: r.valor == null ? '' : t?.valor === 'pct' ? String(Math.round(Number(r.valor) * 1000) / 10) : String(r.valor),
    valor_texto: r.valor_texto ?? '',
    cliente_patron: r.cliente_patron ?? '',
    notas: r.notas ?? '',
    confirmada: !!r.confirmada,
  };
}

/** Tope de «desde», «hasta» y de un valor en sitios o minutos. */
const TOPE_RANGO = 100000;
/** Tope de un valor en días (unos 10 años). */
const TOPE_DIAS = 3650;

/** Entero ≥ 0 o null; NaN si no se entiende. */
function entero(s: string): number | null {
  const x = s.trim();
  if (!x) return null;
  return /^\d+$/.test(x) ? Number(x) : NaN;
}

function numero(s: string): number | null {
  const x = s.trim().replace(',', '.');
  if (!x) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

/** Valida y arma lo que se manda; o el error en palabras de campo. */
function armarEnvio(b: Borrador): { ok: true; envio: ReglaEnvio } | { ok: false; error: string } {
  const t = TIPOS[b.tipo];
  const desde = t.rango ? entero(b.desde) : null;
  const hasta = t.rango ? entero(b.hasta) : null;
  if (Number.isNaN(desde) || Number.isNaN(hasta)) return { ok: false, error: '«Desde» y «hasta» van en números enteros.' };
  if (desde != null && hasta != null && hasta < desde) return { ok: false, error: '«Hasta» no puede ser menor que «desde».' };
  // Topes (revisión 2, contrato-7): la base hace ::int sin atrapar el
  // desbordamiento y salía «out of range for type integer» en inglés; y un
  // valor de días enorme se guardaba (valor es numeric) y rompía después la
  // lectura de TODAS las campañas de la unidad (fecha fuera de rango).
  if ((desde != null && desde > TOPE_RANGO) || (hasta != null && hasta > TOPE_RANGO))
    return { ok: false, error: `«Desde» y «hasta» van de 0 a ${nf(TOPE_RANGO)}.` };
  let valor = t.valor ? numero(b.valor) : null;
  if (Number.isNaN(valor)) return { ok: false, error: 'El valor va en número.' };
  if (valor != null && valor < 0) return { ok: false, error: 'El valor no puede ser negativo.' };
  if (t.valor === 'dias' && valor != null && valor > TOPE_DIAS)
    return { ok: false, error: `Los días van de 0 a ${nf(TOPE_DIAS)}.` };
  if (t.valor !== 'pct' && t.valor !== 'dias' && valor != null && valor > TOPE_RANGO)
    return { ok: false, error: `El valor va de 0 a ${nf(TOPE_RANGO)}.` };
  if (t.valor === 'pct' && valor != null) {
    if (valor > 100) return { ok: false, error: 'El % va de 0 a 100.' };
    valor = Math.round(valor * 10) / 1000;
  }
  if (t.valor === 'dias' && valor != null && !Number.isInteger(valor)) return { ok: false, error: 'Los días van en número entero.' };
  if (t.cliente && !b.cliente_patron.trim()) return { ok: false, error: 'Escribe el cliente.' };
  if (valor == null && !b.valor_texto.trim() && !b.notas.trim())
    return { ok: false, error: 'La regla está vacía: escribe el valor o el texto.' };
  return {
    ok: true,
    envio: {
      ...(b.id != null ? { id: b.id } : {}),
      unidad: b.unidad,
      tipo: b.tipo,
      desde,
      hasta,
      valor,
      valor_texto: t.texto ? b.valor_texto.trim() || null : null,
      cliente_patron: t.cliente ? b.cliente_patron.trim() || null : null,
      notas: b.notas.trim() || null,
      confirmada: b.confirmada,
    },
  };
}

function textoRango(r: ReglaComp): string {
  const t = TIPOS[r.tipo];
  if (!t?.rango) return '';
  const u = t.rango === 'min' ? 'min' : 'sitios';
  if (r.desde != null && r.hasta != null) return r.desde === r.hasta ? `${r.desde} ${u}` : `De ${r.desde} a ${r.hasta} ${u}`;
  if (r.desde != null) return `${r.desde} ${u} o más`;
  if (r.hasta != null) return `Hasta ${r.hasta} ${u}`;
  return 'Cualquier cantidad';
}

function textoValor(r: ReglaComp): string {
  const t = TIPOS[r.tipo];
  const partes: string[] = [];
  if (r.valor != null && t?.valor) {
    const v = Number(r.valor);
    if (t.valor === 'pct') partes.push(`${Math.round(v * 1000) / 10} %`);
    else if (t.valor === 'dias') partes.push(`${nf(v)} ${v === 1 ? 'día' : 'días'}`);
    else partes.push(`${nf(v)} ${v === 1 ? 'sitio' : 'sitios'}`);
  }
  if (r.valor_texto) partes.push(r.valor_texto);
  return partes.join(' · ');
}

export default function ReglasModal(props: Props) {
  const { unidad, editable, onCerrar, correr, ocupado, avisar, recargar } = props;
  const [reglas, setReglas] = useState<ReglaComp[]>([]);
  const [leido, setLeido] = useState(false);
  const [errLeer, setErrLeer] = useState('');
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<Borrador | null>(null);
  const [porBorrar, setPorBorrar] = useState<number | null>(null);
  const pide = useRef(0);

  const leer = async () => {
    const n = ++pide.current;
    const r = await leerReglas(unidad);
    if (n !== pide.current) return;
    if (!r.ok) {
      setErrLeer('No se pudieron leer las reglas: ' + textoFallaComp(r));
      return;
    }
    setErrLeer('');
    setReglas(r.data);
    setLeido(true);
  };

  useEffect(() => {
    leer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unidad]);

  const guardando = ocupado != null;
  const cerrar = () => {
    if (guardando) return;
    if (edit && !window.confirm('Tienes una regla a medio editar. ¿Cerrar sin guardar?')) return;
    onCerrar();
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cerrar();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const porTipo = useMemo(() => {
    const m = new Map<TipoRegla, ReglaComp[]>();
    for (const t of ORDEN_TIPOS) m.set(t, []);
    for (const r of reglas) (m.get(r.tipo) ?? m.set(r.tipo, []).get(r.tipo)!).push(r);
    return m;
  }, [reglas]);
  const sinConfirmar = reglas.filter((r) => !r.confirmada).length;

  const guardar = async () => {
    if (!edit) return;
    const a = armarEnvio(edit);
    if (!a.ok) {
      setErr(a.error);
      return;
    }
    setErr('');
    const r = await correr('Guardando regla…', () => guardarRegla(a.envio));
    if (!r) return;
    if (!r.ok) {
      setErr(textoFallaEscrituraComp(r));
      // Sin respuesta no se sabe si se guardó: se relee (23-oct-2026).
      if (r.sinRed) {
        void leer();
        recargar();
      }
      return;
    }
    setEdit(null);
    avisar(edit.id != null ? '✓ Regla guardada' : '✓ Regla agregada');
    await leer();
    // La fecha límite propuesta de las campañas sale de estas reglas.
    recargar();
  };

  const borrar = async (id: number) => {
    setErr('');
    const r = await correr('Borrando regla…', () => borrarRegla(id));
    setPorBorrar(null);
    if (!r) return;
    if (!r.ok) {
      setErr(textoFallaEscrituraComp(r));
      if (r.sinRed) {
        void leer();
        recargar();
      }
      return;
    }
    avisar(r.data ? '✓ Regla borrada' : 'Esa regla ya no existía');
    await leer();
    recargar();
  };

  const nueva = (tipo: TipoRegla) => {
    setErr('');
    setPorBorrar(null);
    setEdit({
      id: null,
      unidad,
      tipo,
      desde: '',
      hasta: '',
      valor: '',
      valor_texto: '',
      cliente_patron: '',
      notas: '',
      confirmada: false,
    });
  };

  const campo = (
    etiqueta: string,
    k: keyof Pick<Borrador, 'desde' | 'hasta' | 'valor' | 'valor_texto' | 'cliente_patron' | 'notas'>,
    tipoInput: 'num' | 'texto' | 'area' = 'texto'
  ) => (
    <div className="field" style={{ marginBottom: 8, minWidth: 0 }}>
      <label>{etiqueta}</label>
      {tipoInput === 'area' ? (
        <textarea rows={2} value={edit?.[k] ?? ''} onChange={(e) => setEdit((b) => (b ? { ...b, [k]: e.target.value } : b))} />
      ) : (
        <input
          inputMode={tipoInput === 'num' ? 'decimal' : undefined}
          value={edit?.[k] ?? ''}
          onChange={(e) => setEdit((b) => (b ? { ...b, [k]: e.target.value } : b))}
          // 16 px: iOS no hace zoom al enfocar.
          style={{ fontSize: 16 }}
        />
      )}
    </div>
  );

  const formulario = (b: Borrador) => {
    const t = TIPOS[b.tipo];
    return (
      <div style={{ border: '2px solid var(--accent)', borderRadius: 10, padding: 10, background: 'var(--panel)', marginTop: 6 }}>
        {b.unidad == null && (
          <div className="banner" style={{ marginBottom: 8 }}>
            Esta regla es de todas las unidades: solo el manager la puede cambiar.
          </div>
        )}
        {t.rango && (
          <div className="row2">
            {campo(t.rango === 'min' ? 'Desde (minutos)' : 'Desde (sitios)', 'desde', 'num')}
            {campo(t.rango === 'min' ? 'Hasta (minutos, vacío = o más)' : 'Hasta (sitios, vacío = o más)', 'hasta', 'num')}
          </div>
        )}
        {t.cliente && campo('Cliente (parte del nombre)', 'cliente_patron')}
        {t.valor && campo(t.valor === 'pct' ? '% de columnas' : t.valor === 'dias' ? 'Días' : 'Sitios en el avance', 'valor', 'num')}
        {t.texto && campo(b.tipo === 'avances_por_sitios' ? 'Texto (p. ej. TODAS)' : 'Qué dice la regla', 'valor_texto', b.tipo === 'avances_por_sitios' ? 'texto' : 'area')}
        {campo('Notas', 'notas', 'area')}
        <label className="rt-check" style={{ marginTop: 0, marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={b.confirmada}
            onChange={(e) => setEdit((x) => (x ? { ...x, confirmada: e.target.checked } : x))}
          />
          <span>Ya la confirmó el Supervisor</span>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost sm" onClick={() => (setEdit(null), setErr(''))} disabled={guardando}>
            Cancelar
          </button>
          <button type="button" className="btn sm" onClick={guardar} disabled={guardando}>
            {ocupado === 'Guardando regla…' && <span className="spinner" />}
            Guardar
          </button>
        </div>
      </div>
    );
  };

  const etiquetaConfirmada = (r: ReglaComp) =>
    r.confirmada ? (
      <span className="pill" style={{ color: colorTono('verde'), background: fondoTono('verde') }}>
        confirmada
      </span>
    ) : (
      <span className="pill" style={{ color: colorTono('ambar'), background: fondoTono('ambar') }}>
        sin confirmar
      </span>
    );

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) cerrar();
      }}
    >
      <div className="modal" style={{ maxWidth: 720, position: 'relative' }} role="dialog" aria-modal="true" aria-label="Reglas">
        <CerrarModal onClick={cerrar} disabled={guardando} />
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Reglas de {ETIQUETA_UNIDAD_COMP[unidad]}</h2>
        <div className="banner">
          Están <b>sin confirmar</b> con el Supervisor: se guardan como datos y la app no las aplica sola. La única que ya se usa
          es «Fecha límite según sitios», para proponer la fecha límite de las campañas que no tienen una puesta a mano.
          {sinConfirmar ? ` Faltan ${sinConfirmar} por confirmar.` : ''}
        </div>
        {errLeer && (
          <div className="err">
            {errLeer}{' '}
            <button type="button" className="btn ghost sm" onClick={leer}>
              Reintentar
            </button>
          </div>
        )}
        {err && <div className="err">{err}</div>}
        {!leido && !errLeer && (
          <div className="phint">
            <span className="spinner" />
            Leyendo reglas…
          </div>
        )}
        {leido &&
          ORDEN_TIPOS.map((tipo) => {
            const t = TIPOS[tipo];
            const lista = porTipo.get(tipo) ?? [];
            const nuevaAqui = edit && edit.id == null && edit.tipo === tipo;
            return (
              <section key={tipo} className="rt-seccion">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div className="rt-seccion-tit" style={{ flex: '1 1 auto', marginBottom: 0 }}>
                    {t.titulo}
                  </div>
                  {editable && !edit && (
                    <button type="button" className="btn ghost sm" onClick={() => nueva(tipo)} disabled={guardando}>
                      <Ic i={Plus} />
                      Agregar
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px', lineHeight: 1.4 }}>{t.ayuda}</div>
                {lista.length === 0 && !nuevaAqui && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Sin reglas.</div>}
                <div style={{ display: 'grid', gap: 6 }}>
                  {lista.map((r) =>
                    edit && edit.id === r.id ? (
                      <div key={r.id}>{formulario(edit)}</div>
                    ) : (
                      <div
                        key={r.id}
                        style={{
                          display: 'flex',
                          gap: 8,
                          alignItems: 'flex-start',
                          background: 'var(--panel)',
                          border: '1px solid var(--line)',
                          borderRadius: 9,
                          padding: '8px 10px',
                        }}
                      >
                        <div style={{ flex: '1 1 auto', minWidth: 0, fontSize: 13 }}>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                            {r.cliente_patron && <b>{r.cliente_patron}</b>}
                            {textoRango(r) && <span>{textoRango(r)}</span>}
                            {textoValor(r) && (
                              <b style={{ overflowWrap: 'anywhere' }}>
                                {textoRango(r) || r.cliente_patron ? '→ ' : ''}
                                {textoValor(r)}
                              </b>
                            )}
                            {etiquetaConfirmada(r)}
                            {r.unidad == null && <span className="tag">todas las unidades</span>}
                          </div>
                          {r.notas && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, overflowWrap: 'anywhere' }}>{r.notas}</div>}
                          {porBorrar === r.id && (
                            <div className="rt-aviso" style={{ marginTop: 8 }}>
                              ¿Borrar esta regla?
                              <div className="rt-aviso-acc">
                                <button type="button" className="btn ghost sm" onClick={() => setPorBorrar(null)} disabled={guardando}>
                                  No
                                </button>
                                <button type="button" className="btn sm warn" onClick={() => borrar(r.id)} disabled={guardando}>
                                  {ocupado === 'Borrando regla…' && <span className="spinner" />}
                                  Sí, borrar
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                        {editable && !edit && porBorrar !== r.id && (
                          <div className="rt-fila-acc">
                            <button
                              type="button"
                              className="btn-icono"
                              aria-label="Editar regla"
                              title="Editar"
                              disabled={guardando}
                              onClick={() => (setErr(''), setEdit(borradorDe(r)))}
                            >
                              <Ic i={Pencil} />
                            </button>
                            <button
                              type="button"
                              className="btn-icono"
                              aria-label="Borrar regla"
                              title="Borrar"
                              disabled={guardando}
                              onClick={() => (setErr(''), setPorBorrar(r.id))}
                            >
                              <Ic i={Trash} />
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  )}
                  {nuevaAqui && edit && formulario(edit)}
                </div>
              </section>
            );
          })}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={cerrar} disabled={guardando}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
