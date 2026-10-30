// ============================================================
// src/modules/comprobaciones/BloqueTomaComp.tsx
// Una toma (un sitio en un día) en la revisión de «Mis campañas» (fase 3,
// incremento 3; 29-oct-2026; spec §6.2 y §11). Patrón de BloqueCara de
// AnalistaPauta.
//
// Lo que se puede hacer (cada cosa por su RPC; la base vuelve a validar):
//   · Por foto de campo: Correcta (otra vez = quitar la marca), Editada, y
//     marcar para rechazar. Correcta y Editada van a todas las versiones de
//     esa foto que la persona revisa (M5).
//   · Por toma: «Todas correctas», «Rechazar las marcadas» y «Devolver al
//     monitorista» (con motivo), «Reabrir» (comprobada, con motivo) y
//     «Comprobar» (respaldo, cuando ya no falta nada).
//   · Parte de cámara (modo cámaras o mixto): subir la captura de cada
//     posición que falta, con el día que muestra la grabación, y quitarla
//     mientras la toma no esté comprobada.
// Nadie aprueba su propia toma: si la persona la envió o subió fotos de campo
// en ella, se ve en lectura con la razón.
// ============================================================

import { useId, useRef, useState } from 'react';
import { Camera, Check, RotateCcw, Undo2, X } from 'lucide-react';
import Ic from '../../components/Ic';
import { colorTono, fondoTono, type Tono } from '../../lib/tonos';
import { fechaHoraCdmx } from '../../lib/fechasCdmx';
import type { PosPlantilla } from '../../lib/plantillasComp';
import {
  comprobarToma,
  quitarCaptura,
  reabrirToma,
  rechazarFotos,
  regresarToma,
  revisarFotos,
  subirCaptura,
  subirEditada,
  type FallaRev,
} from '../../lib/revisionApi';
import {
  diasCaptura,
  nombreFoto,
  ordenarFotos,
  parteCamara,
  parteCampo,
  resumenToma,
  type FotoRev,
  type TomaRev,
} from '../../lib/revisionTomas';
import { fechaCorta } from './AvanceComun';
import TarjetaFotoComp from './TarjetaFotoComp';

type Props = {
  toma: TomaRev;
  /** La plantilla que cuenta para esta toma (plantillaDeToma). */
  plantilla: PosPlantilla[];
  /** undefined = leyendo. */
  fotos: FotoRev[] | undefined;
  sitioClave: string;
  unidad: string;
  hoy: string;
  /** Ventana de días de la captura (periodo recortado a la vigencia de la campaña). */
  ventana: { desde: string; hasta: string };
  /** La campaña deja revisar a esta persona (la base vuelve a validar). */
  puedeRevisar: boolean;
  /** La campaña deja subir capturas a esta persona. */
  puedeCapturar: boolean;
  email: string;
  nombreDe: (email: string | null | undefined) => string;
  ocupado: string | null;
  correr: <T>(etiqueta: string, fn: () => Promise<T>) => Promise<T | undefined>;
  /** Después de escribir: mensaje (o falla) y releer. */
  despues: (r: { hecho?: string; err?: string; sinRed?: boolean }) => void;
  /** ≤ 780 px: botones de 44 px. */
  telefono?: boolean;
};

const MOTIVOS_RECHAZO = ['Borrosa o movida', 'No se ve la versión', 'Sale otra versión en pantalla', 'Sitio equivocado', 'Falta luz'];
const MOTIVOS_DEVOLVER = ['Sitio equivocado', 'Otra campaña en pantalla', 'Faltan fotos de la lista', 'Fuera de la franja'];
const MOTIVOS_REABRIR = ['El cliente pidió otra foto', 'Me equivoqué al marcar'];

const ESTADO: Record<TomaRev['estado'], { texto: string; tono: Tono }> = {
  pendiente: { texto: 'Sin enviar', tono: 'gris' },
  por_revisar: { texto: 'Por revisar', tono: 'ambar' },
  comprobada: { texto: 'Comprobada', tono: 'verde' },
  regresada: { texto: 'Devuelta', tono: 'rojo' },
  cancelada: { texto: 'Cancelada', tono: 'gris' },
};

const DIAS_SEM = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const diaSemana = (d: string) => DIAS_SEM[new Date(d + 'T12:00:00Z').getUTCDay()];

/** Texto de una falla de revisión: el de la base o el del código. */
const textoFalla = (r: FallaRev) => r.error;

export default function BloqueTomaComp(p: Props) {
  const { toma: t } = p;
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [pidiendo, setPidiendo] = useState<'rechazar' | 'devolver' | 'reabrir' | null>(null);
  const [motivo, setMotivo] = useState('');
  const [diaCap, setDiaCap] = useState(t.fecha <= p.hoy ? t.fecha : p.hoy);
  const idMotivo = useId();
  const idDia = useId();
  const ocupado = p.ocupado != null;
  // La etiqueta del candado se ve en el título de la pantalla: legible, y
  // única por toma (sitio y día) para saber cuál está guardando.
  const etiqueta = `Guardando ${p.sitioClave} del ${fechaCorta(t.fecha)}…`;
  const tactil = p.telefono ? { minHeight: 44 } : undefined;
  /** Captura que quedó sin respuesta, por posición y día: el reintento reusa su cliente_id y ruta. */
  const pendientesCaptura = useRef(new Map<string, { cid: string; path: string }>());
  const inputsCaptura = useRef(new Map<string, HTMLInputElement | null>());

  const fotos = p.fotos ?? [];
  const lista = ordenarFotos(fotos, p.plantilla);
  const r = resumenToma(p.plantilla, fotos);
  const camara = parteCamara(p.plantilla);
  const campo = parteCampo(p.plantilla);
  const esDeCamaras = campo.length === 0 && camara.length > 0;
  const propia =
    (t.tomada_por || '').toLowerCase() === p.email ||
    fotos.some((f) => !f.devuelta && f.origen === 'campo' && f.subido_por.toLowerCase() === p.email);
  const enRevision = t.estado === 'por_revisar' || t.estado === 'comprobada';
  const revisa = p.puedeRevisar && enRevision && !propia && !esDeCamaras;
  // Una toma de cámaras comprobada también se reabre: es la única forma de
  // cambiar una captura equivocada (no se quitan de una comprobada).
  const reabre = p.puedeRevisar && t.estado === 'comprobada' && !propia;
  const capturable =
    p.puedeCapturar && (t.estado === 'pendiente' || t.estado === 'por_revisar' || t.estado === 'regresada') && t.fecha <= p.hoy;
  const dias = diasCaptura(p.hoy, p.ventana.desde, p.ventana.hasta, t.fecha);
  const diaSel = dias.includes(diaCap) ? diaCap : dias[0] ?? '';
  const sinMarcar = lista.filter((f) => !f.devuelta && f.origen === 'campo' && !f.revision && !sel.has(f.evidencia_id));
  const elegidas = [...sel].filter((id) => lista.some((f) => f.evidencia_id === id && !f.devuelta && f.origen === 'campo'));

  // ---- Escrituras (todas por ctx.correr: una a la vez en el módulo) ----
  /** hecho devuelve el mensaje; { err } si la base contestó pero no se hizo. */
  const ejecutar = async (
    fn: () => Promise<{ ok: true; data: unknown } | FallaRev>,
    hecho: (d: never) => string | { err: string },
    alFallar?: (r: FallaRev) => void
  ) => {
    const res = await p.correr(etiqueta, fn);
    if (!res) return;
    if (!res.ok) {
      alFallar?.(res);
      p.despues({ err: textoFalla(res), sinRed: res.sinRed });
      return;
    }
    const h = hecho(res.data as never);
    p.despues(typeof h === 'string' ? { hecho: h } : { err: h.err });
  };

  const textoComprobadas = (c: number[]) =>
    c.includes(t.id) ? ` La toma de ${p.sitioClave} del ${fechaCorta(t.fecha)} quedó comprobada.` : c.length ? ` ${c.length} tomas quedaron comprobadas.` : '';

  const correcta = (ids: number[]) =>
    ejecutar(() => revisarFotos(t.id, ids, 'correcta'), (d: { aplicadas: number; comprobadas: number[] }) =>
      `✓ ${ids.length === 1 ? 'Foto correcta' : `${ids.length} fotos correctas`}${d.aplicadas > ids.length ? ' (también en sus otras versiones)' : ''}.${textoComprobadas(d.comprobadas)}`
    );
  const quitarMarca = (id: number) =>
    ejecutar(() => revisarFotos(t.id, [id], 'quitar'), () => 'Se quitó la marca: la foto vuelve a Sin revisar.');
  const editada = (id: number, a: File) =>
    ejecutar(
      () => subirEditada({ unidad: p.unidad, tomaId: t.id, evidenciaId: id, archivo: a, hoy: p.hoy }),
      (d: { comprobadas: number[] }) => `✓ Editada lista: se entrega en lugar de la original.${textoComprobadas(d.comprobadas)}`
    );
  const confirmarMotivo = async () => {
    const m = motivo.trim();
    if (!m || !pidiendo) return;
    const que = pidiendo;
    setPidiendo(null);
    setMotivo('');
    if (que === 'rechazar') {
      const ids = elegidas;
      setSel(new Set());
      await ejecutar(() => rechazarFotos(t.id, ids, m), () =>
        `✓ ${ids.length === 1 ? 'Foto rechazada' : `${ids.length} fotos rechazadas`}: la toma regresa al monitorista con el aviso.`
      );
    } else if (que === 'devolver') {
      await ejecutar(() => regresarToma(t.id, m), () => '✓ Toma devuelta completa al monitorista.');
    } else {
      await ejecutar(() => reabrirToma(t.id, m), () => '✓ Toma reabierta: está en Por revisar y el sitio deja de contar con ella hasta comprobarla.');
    }
  };
  const comprobar = async () => {
    const res = await p.correr(etiqueta, () => comprobarToma(t.id));
    if (!res) return;
    if (!res.ok) {
      const faltan = Array.isArray(res.detalle?.faltan) ? (res.detalle?.faltan as { etiqueta?: string }[]) : [];
      const sinRev = Number(res.detalle?.sin_revisar) || 0;
      p.despues({
        err:
          res.codigoRev === 'incompleta'
            ? `Todavía no se puede comprobar:${sinRev ? ` ${sinRev} sin marcar como correcta;` : ''}${
                faltan.length ? ` falta ${faltan.map((f) => f.etiqueta).filter(Boolean).join(', ')}.` : ''
              }`
            : textoFalla(res),
        sinRed: res.sinRed,
      });
      return;
    }
    p.despues({ hecho: '✓ Toma comprobada.' });
  };
  const subir = (q: PosPlantilla, a: File) => {
    const llave = `${q.pos}|${q.momento ?? ''}|${diaSel}`;
    return ejecutar(
      () =>
        subirCaptura({
          unidad: p.unidad,
          sitioClave: p.sitioClave,
          tomaIds: [t.id],
          pos: q.pos,
          momento: q.momento,
          dia: diaSel,
          archivo: a,
          reintento: pendientesCaptura.current.get(llave) ?? null,
        }),
      (d: { ligadas: number[]; comprobadas: number[]; no_camara: number[]; fuera_periodo: number[]; cerradas: number[]; ajenas: number[] }) => {
        pendientesCaptura.current.delete(llave);
        return d.ligadas.length
          ? `✓ ${q.etiqueta} de cámaras lista (${fechaCorta(diaSel)}).${textoComprobadas(d.comprobadas)}`
          : {
              err: d.no_camara.length
                ? `No se subió: la ${q.etiqueta} ya no va por cámara en esta toma. Recarga.`
                : d.fuera_periodo.length
                  ? 'No se subió: ese día queda fuera de la campaña.'
                  : d.ajenas.length
                    ? 'No se subió: ya no puedes subir capturas en esta campaña.'
                    : 'No se subió: la toma cambió (ya está comprobada o cerrada). Recarga.',
            };
      },
      (r) => {
        if (r.reintento) pendientesCaptura.current.set(llave, r.reintento);
        else pendientesCaptura.current.delete(llave);
      }
    );
  };
  const quitarCap = (f: FotoRev) => ejecutar(() => quitarCaptura(f.cliente_id, t.id), () => '✓ Captura quitada.');

  const e = ESTADO[t.estado];
  const motivos = pidiendo === 'rechazar' ? MOTIVOS_RECHAZO : pidiendo === 'devolver' ? MOTIVOS_DEVOLVER : MOTIVOS_REABRIR;
  const enCurso = p.ocupado === etiqueta;
  // «Reabierta» solo si se reabrió después del último envío (reabierta_* no se limpia).
  const reabiertaVigente = !!t.reabierta_en && (!t.enviada_en || t.reabierta_en > t.enviada_en);

  return (
    <article
      aria-label={`Toma del ${fechaCorta(t.fecha)}`}
      style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 10 }}
      aria-busy={enCurso}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14 }}>
          {diaSemana(t.fecha)} {fechaCorta(t.fecha)}
        </b>
        <span className="pill" style={{ background: fondoTono(e.tono), color: colorTono(e.tono) }}>
          {t.estado === 'por_revisar' && reabiertaVigente ? 'Reabierta' : e.texto}
        </span>
        {enCurso && <span className="spinner" />}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, overflowWrap: 'anywhere' }}>
        {t.enviada_en
          ? `Envió ${p.nombreDe(t.tomada_por) || t.tomada_por || 'cámaras'} · ${fechaHoraCdmx(t.enviada_en)}`
          : `Monitorista: ${p.nombreDe(t.monitorista_email) || 'sin asignar'}`}
        {t.comprobada_en && ` · comprobó ${p.nombreDe(t.comprobada_por) || t.comprobada_por} ${fechaHoraCdmx(t.comprobada_en)}`}
      </div>
      {t.estado === 'regresada' && t.rechazo_motivo && (
        <div style={{ fontSize: 12, color: colorTono('rojo'), marginTop: 4 }}>
          Devuelta{t.rechazada_por ? ` por ${p.nombreDe(t.rechazada_por)}` : ''}: {t.rechazo_motivo}. Vuelve aquí cuando el monitorista la tome otra vez.
        </div>
      )}
      {t.reabierta_motivo && t.estado === 'por_revisar' && reabiertaVigente && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          Reabierta por {p.nombreDe(t.reabierta_por)}
          {t.reabierta_en ? ` ${fechaHoraCdmx(t.reabierta_en)}` : ''}: {t.reabierta_motivo}
        </div>
      )}
      {camara.length > 0 && t.estado !== 'cancelada' && (
        <div style={{ fontSize: 12, marginTop: 4, color: r.faltaCamara.length ? colorTono('ambar') : colorTono('verde') }}>
          {esDeCamaras ? 'Toma de cámaras' : 'Parte de cámara'}:{' '}
          {p.fotos === undefined
            ? '…'
            : r.faltaCamara.length
              ? `falta ${r.faltaCamara.map((f) => (f.n > 1 ? `${f.etiqueta} (${f.tiene} de ${f.n})` : f.etiqueta)).join(', ')}`
              : 'completa'}
        </div>
      )}
      {p.puedeRevisar && enRevision && propia && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          Tú tomaste esta toma o subiste fotos de campo en ella: la revisa otra persona.
        </div>
      )}

      {p.fotos === undefined ? (
        <div className="phint" style={{ marginTop: 6 }}>
          <span className="spinner" />
          Leyendo fotos…
        </div>
      ) : lista.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Todavía no tiene fotos.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 170px), 1fr))', gap: 10, marginTop: 8 }}>
          {lista.map((f) => (
            <TarjetaFotoComp
              key={f.evidencia_id}
              f={f}
              nombre={nombreFoto(p.sitioClave, t.fecha, f.n)}
              revisable={revisa && !f.devuelta && f.origen === 'campo' && f.tipo === 'foto'}
              rechazable={revisa && !f.devuelta && f.origen === 'campo'}
              quitable={p.puedeCapturar && f.origen === 'camara' && !f.devuelta && t.estado !== 'comprobada'}
              // Quitar la marca solo con la toma por revisar (en una comprobada la base lo niega).
              marcaQuitable={t.estado === 'por_revisar'}
              telefono={p.telefono}
              elegida={sel.has(f.evidencia_id)}
              ocupado={ocupado}
              trabajando={enCurso}
              nombreDe={p.nombreDe}
              onElegir={() =>
                setSel((prev) => {
                  const s = new Set(prev);
                  if (s.has(f.evidencia_id)) s.delete(f.evidencia_id);
                  else s.add(f.evidencia_id);
                  return s;
                })
              }
              onCorrecta={() => correcta([f.evidencia_id])}
              onQuitarMarca={() => quitarMarca(f.evidencia_id)}
              onEditada={(a) => editada(f.evidencia_id, a)}
              onQuitarCaptura={() => quitarCap(f)}
            />
          ))}
        </div>
      )}

      {capturable && p.fotos !== undefined && r.faltaCamara.length > 0 && (
        <div className="rt-seccion" style={{ marginTop: 8 }}>
          <div className="rt-seccion-tit">Subir de cámaras</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label htmlFor={idDia} style={{ fontSize: 12, color: 'var(--muted)' }}>
              Día que muestra la grabación
            </label>
            <select id={idDia} value={diaSel} onChange={(ev) => setDiaCap(ev.target.value)} disabled={ocupado || !dias.length} style={{ fontSize: 16, width: 'auto' }}>
              {dias.map((d) => (
                <option key={d} value={d}>
                  {diaSemana(d)} {fechaCorta(d)}
                  {d === t.fecha ? ' (día de la toma)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {r.faltaCamara.map((q) => {
              const pos = camara.find((x) => x.pos === q.pos && x.momento === q.momento) ?? { ...q, alcance: 'version' as const };
              const id = `cap-${t.id}-${q.pos}-${q.momento ?? ''}`;
              // Botón real (se enfoca con teclado) que abre el selector de archivo.
              return (
                <span key={id}>
                  <button
                    type="button"
                    className="btn sm"
                    style={tactil}
                    disabled={ocupado || !diaSel}
                    onClick={() => inputsCaptura.current.get(id)?.click()}
                  >
                    <Ic i={Camera} />
                    Subir {q.etiqueta}
                    {q.n > 1 ? ` (${q.tiene + 1} de ${q.n})` : ''}
                  </button>
                  <input
                    ref={(el) => {
                      inputsCaptura.current.set(id, el);
                    }}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(ev) => {
                      const a = ev.target.files?.[0];
                      ev.target.value = '';
                      if (a) subir(pos as PosPlantilla, a);
                    }}
                  />
                </span>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
            Las capturas de cámara cuentan solas, sin revisión. Se comprimen a 1600 px como las de campo.
          </div>
        </div>
      )}

      {(revisa || reabre) && p.fotos !== undefined && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
          {revisa && t.estado === 'por_revisar' && sinMarcar.length > 0 && (
            <button type="button" className="btn ok sm" style={tactil} disabled={ocupado} onClick={() => correcta(sinMarcar.map((f) => f.evidencia_id))}>
              <Ic i={Check} />
              {sinMarcar.length === 1 ? 'Correcta' : `Las ${sinMarcar.length} sin revisar: correctas`}
            </button>
          )}
          {/* Respaldo: también para una toma de cámaras reabierta, que sin esto quedaba atorada. */}
          {t.estado === 'por_revisar' &&
            r.sinRevisar === 0 &&
            r.faltaCamara.length === 0 &&
            ((revisa && r.campo > 0) || (esDeCamaras && p.puedeRevisar && !propia && r.camara > 0)) && (
              <button type="button" className="btn sm" style={tactil} disabled={ocupado} onClick={comprobar}>
                <Ic i={Check} />
                Comprobar
              </button>
            )}
          {elegidas.length > 0 && (
            <button type="button" className="btn hi sm" style={tactil} disabled={ocupado} onClick={() => setPidiendo('rechazar')}>
              <Ic i={X} />
              Rechazar {elegidas.length === 1 ? 'la marcada' : `las ${elegidas.length} marcadas`}
            </button>
          )}
          {reabre && (
            <button type="button" className="btn ghost sm" style={tactil} disabled={ocupado} onClick={() => setPidiendo('reabrir')}>
              <Ic i={RotateCcw} />
              Reabrir
            </button>
          )}
          {revisa && (
            <button type="button" className="btn ghost sm" style={tactil} disabled={ocupado} onClick={() => setPidiendo('devolver')}>
              <Ic i={Undo2} />
              Devolver al monitorista
            </button>
          )}
          {revisa && t.estado === 'por_revisar' && r.faltaCamara.length > 0 && r.sinRevisar === 0 && (
            <span style={{ fontSize: 12, color: colorTono('ambar') }}>Se comprueba sola en cuanto esté la parte de cámara.</span>
          )}
        </div>
      )}

      {pidiendo && (
        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor={idMotivo}>
            {pidiendo === 'rechazar'
              ? `Motivo del rechazo de ${elegidas.length} ${elegidas.length === 1 ? 'foto' : 'fotos'} (la toma regresa al monitorista; las demás fotos se quedan como están)`
              : pidiendo === 'devolver'
                ? 'Motivo para devolver toda la toma (ninguna foto de campo cuenta ya y el monitorista la vuelve a tomar; la parte de cámara se queda)'
                : 'Motivo para reabrir (las fotos y sus marcas se quedan; al cambiar una marca se vuelve a comprobar sola)'}
          </label>
          <div className="rt-chips" style={{ margin: '4px 0 6px' }}>
            {motivos.map((m) => (
              <button key={m} type="button" className={'rt-chip' + (motivo === m ? ' on' : '')} aria-pressed={motivo === m} onClick={() => setMotivo(m)}>
                {m}
              </button>
            ))}
          </div>
          <textarea id={idMotivo} rows={2} autoFocus maxLength={500} value={motivo} onChange={(ev) => setMotivo(ev.target.value)} style={{ fontSize: 16 }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setPidiendo(null);
                setMotivo('');
              }}
            >
              Cancelar
            </button>
            <button
              type="button"
              className={pidiendo === 'reabrir' ? 'btn sm' : 'btn hi sm'}
              disabled={ocupado || !motivo.trim() || (pidiendo === 'rechazar' && !elegidas.length)}
              onClick={confirmarMotivo}
            >
              {pidiendo === 'rechazar' ? 'Rechazar y avisar al monitorista' : pidiendo === 'devolver' ? 'Devolver y avisar al monitorista' : 'Reabrir'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
