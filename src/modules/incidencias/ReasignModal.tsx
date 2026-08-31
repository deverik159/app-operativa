// ============================================================
// src/modules/incidencias/ReasignModal.tsx
// Reasignación de área responsable. Dos modos en un mismo modal:
//   'solicitar' — el área actual pide moverla a otra (deja la incidencia
//                 con reasignacion_pendiente=true).
//   'aprobar'   — el validador revisa la solicitud abierta y la resuelve.
//
// CÓMO SE PIDE (Erik, 30-ago-2026): eligiendo del CATÁLOGO qué incidencia
// es en realidad — no eligiendo el área a mano. El área destino la decide
// el catálogo con la entrada elegida, igual que en el alta y en la
// corrección del validador: así nunca se pide mover "Apagado" a un área
// que el catálogo jamás produciría. Al aprobar, la incidencia se
// reclasifica (nombre + nivel + origen + tipo + área) y hasta entonces le
// llega al técnico del área nueva. Requiere la columna
// `reasignaciones.nueva_incidencia` (ver reasignacion_incidencia.sql).
// ============================================================
import { useState, useEffect, useMemo } from 'react';
import { sb } from '../../lib/supabase';
import { idCorto } from '../../lib/helpers';
import {
  catalogoParaMuebles,
  llaveCatalogo,
  filtrarCatalogo,
} from '../../lib/catalogo';
import type { OpcionesCatalogo } from '../../lib/catalogo';
import type { CatalogoIncidencia } from '../../types/db';
import { BUCKET_EVIDENCIAS } from '../../lib/storage';
import SubirArchivos from '../../components/SubirArchivos';
import type { Incidencia, Reasignacion } from '../../types/db';

export type ModoReasign = 'solicitar' | 'aprobar';

type Props = {
  inc: Incidencia;
  mode: ModoReasign;
  email: string;
  onClose: () => void;
  onDone: (recordId: string, patch: Partial<Incidencia>) => void;
};

function ReasignModal({ inc, mode, email, onClose, onDone }: Props) {
  const [busy, setBusy] = useState(false);

  // --- modo solicitar: la incidencia nueva se elige del catálogo, con el
  // mismo picker del alta y de la corrección; el área destino la trae la
  // entrada elegida, no se escoge a mano. ---
  const [cat, setCat] = useState<OpcionesCatalogo>({
    opciones: [],
    restringido: false,
    sinCatalogo: [],
  });
  const [cargandoCat, setCargandoCat] = useState(mode === 'solicitar');
  const [errCat, setErrCat] = useState('');
  const [llave, setLlave] = useState('');
  const [busca, setBusca] = useState('');
  const [motivo, setMotivo] = useState('');
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (mode !== 'solicitar') return;
    let vivo = true;
    (async () => {
      const { data, error } = await sb
        .from('catalogo_incidencias')
        .select('*')
        .ilike('unidad_negocio', inc.unidad_negocio || '%')
        .limit(1000);
      if (!vivo) return;
      if (error) setErrCat('No se pudo cargar el catálogo: ' + error.message);
      // Restringido al mueble de esta cara, como en el alta: ahí cada
      // incidencia existe una vez y el área ya viene decidida.
      setCat(
        catalogoParaMuebles((data as CatalogoIncidencia[]) || [], [
          inc.tipo_mueble,
        ])
      );
      setCargandoCat(false);
    })();
    return () => {
      vivo = false;
    };
  }, [mode, inc.unidad_negocio, inc.tipo_mueble]);

  const sel = useMemo(
    () => cat.opciones.find((c) => llaveCatalogo(c) === llave) || null,
    [cat, llave]
  );

  // La opción elegida nunca desaparece de la lista aunque el buscador ya no
  // la encuentre: si no, el select mostraría otra como seleccionada.
  const visibles = useMemo(() => {
    const base = filtrarCatalogo(cat.opciones, busca);
    if (sel && !base.some((c) => llaveCatalogo(c) === llave))
      return [sel, ...base];
    return base;
  }, [cat, busca, sel, llave]);

  const areaDestino = (sel?.area || '').trim();

  // --- modo aprobar ---
  const [req, setReq] = useState<Reasignacion | null>(null);
  const [loading, setLoading] = useState(mode === 'aprobar');
  const [comentario, setComentario] = useState('');

  useEffect(() => {
    if (mode !== 'aprobar') return;
    (async () => {
      // La más reciente que siga abierta. Puede no haber ninguna si otro
      // validador ya la resolvió mientras este usuario tenía la lista vieja.
      const { data } = await sb
        .from('reasignaciones')
        .select('*')
        .eq('record_id', inc.record_id)
        .eq('estado', 'Solicitada')
        .order('fecha_solicitud', { ascending: false })
        .limit(1);
      setReq(((data as Reasignacion[]) || [])[0] || null);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const solicitar = async () => {
    if (!sel) {
      alert('Elige del catálogo qué incidencia es en realidad.');
      return;
    }
    if (areaDestino && areaDestino === (inc.area_responsable || '')) {
      alert(
        'Esa incidencia pertenece a la misma área actual (' +
          areaDestino +
          '): no hay nada que reasignar. Si solo está mal clasificada ' +
          'dentro de tu área, pídele la corrección al validador.'
      );
      return;
    }
    if (!motivo.trim()) {
      alert('Escribe el motivo de la reasignación.');
      return;
    }
    setBusy(true);

    // La evidencia es opcional: si la subida falla, se sigue sin ella en vez
    // de bloquear la solicitud.
    let evidenciaUrl: string | null = null;
    if (file) {
      const path = `${inc.record_id}/reasignacion_${Date.now()}_${file.name.replace(
        /[^\w.\-]/g,
        '_'
      )}`;
      const { error: upErr } = await sb.storage
        .from(BUCKET_EVIDENCIAS)
        .upload(path, file);
      if (!upErr) {
        evidenciaUrl = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path)
          .data.publicUrl;
      }
    }

    const rid = idCorto();
    const { error } = await sb.from('reasignaciones').insert({
      reassign_id: rid,
      record_id: inc.record_id,
      folio: inc.folio,
      unidad_negocio: inc.unidad_negocio,
      area_origen: inc.area_responsable,
      area_destino: areaDestino,
      // La entrada del catálogo que se propone: al aprobar, la incidencia
      // se reclasifica con ella (nombre + nivel + origen + tipo + área).
      nueva_incidencia: sel!.detalle,
      motivo,
      evidencia: evidenciaUrl,
      solicitado_por: email,
      fecha_solicitud: new Date().toISOString(),
      estado: 'Solicitada',
    });
    if (error) {
      setBusy(false);
      alert('No se pudo solicitar: ' + error.message);
      return;
    }

    const { error: e2 } = await sb
      .from('incidencias')
      .update({ reasignacion_pendiente: true })
      .eq('record_id', inc.record_id);
    setBusy(false);
    if (e2) {
      // La solicitud SÍ quedó registrada; solo falló marcar la incidencia.
      alert('Se registró, pero no se marcó pendiente: ' + e2.message);
      return;
    }
    onDone(inc.record_id, { reasignacion_pendiente: true });
  };

  const resolver = async (aprobar: boolean) => {
    if (!req) return;
    if (!aprobar && !comentario.trim()) {
      alert('Escribe el motivo del rechazo.');
      return;
    }
    setBusy(true);

    const { error } = await sb
      .from('reasignaciones')
      .update({
        estado: aprobar ? 'Aprobada' : 'Rechazada',
        resuelta_por: email,
        fecha_resolucion: new Date().toISOString(),
        comentario: comentario || null,
      })
      .eq('reassign_id', req.reassign_id);
    if (error) {
      setBusy(false);
      alert('No se pudo resolver: ' + error.message);
      return;
    }

    // Aprobar mueve el área; rechazar solo quita la bandera.
    const patch: Partial<Incidencia> = aprobar
      ? { area_responsable: req.area_destino, reasignacion_pendiente: false }
      : { reasignacion_pendiente: false };

    // Si la solicitud trae la incidencia nueva, aprobar RECLASIFICA: el
    // nombre viaja en la solicitud y los derivados (nivel/origen/tipo) se
    // leen del catálogo AL APROBAR — la misma regla de CorreccionModal: los
    // campos derivados nunca se escriben a mano. Si la entrada ya no existe
    // en el catálogo, se aplican solo nombre y área, sin inventar el resto.
    if (aprobar && req.nueva_incidencia) {
      patch.nombre_incidencia = req.nueva_incidencia;
      const { data: catRows } = await sb
        .from('catalogo_incidencias')
        .select('*')
        .eq('detalle', req.nueva_incidencia)
        .eq('area', req.area_destino)
        .ilike('unidad_negocio', req.unidad_negocio || '%')
        .limit(1);
      const entrada = ((catRows as CatalogoIncidencia[]) || [])[0];
      if (entrada) {
        patch.nivel = (entrada.impacto || '').trim() || null;
        patch.origen = (entrada.origen || '').trim() || null;
        patch.tipo = (entrada.tipo || '').trim() || null;
      }
    }

    const { error: e2 } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id);
    setBusy(false);
    if (e2) {
      alert('Se resolvió, pero no se actualizó la incidencia: ' + e2.message);
      return;
    }
    onDone(inc.record_id, patch);
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onClose();
      }}
    >
      <div className="modal">
        <h2 style={{ margin: '0 0 3px' }}>
          {mode === 'aprobar' ? 'Revisar reasignación' : 'Solicitar reasignación'}
        </h2>
        <p className="phint">
          {inc.folio} · {inc.nombre_incidencia} · Área actual:{' '}
          <b>{inc.area_responsable || '—'}</b>
        </p>

        {mode === 'solicitar' ? (
          <>
            {errCat && <div className="err">{errCat}</div>}
            <div className="banner" style={{ marginBottom: 14 }}>
              Elige <b>qué incidencia es en realidad</b>: el área a la que se
              reasigna la decide el catálogo con esa entrada. El validador
              tiene que aprobarla — hasta entonces le llega al técnico del
              área nueva.
            </div>
            <div className="field">
              <label>
                Incidencia (del catálogo · {visibles.length} de{' '}
                {cat.opciones.length}
                {cat.restringido ? ` · ${inc.tipo_mueble}` : ''})
              </label>
              {cargandoCat ? (
                <div className="loading">Cargando catálogo…</div>
              ) : (
                <>
                  <input
                    placeholder="Buscar por incidencia o por área…"
                    value={busca}
                    onChange={(e) => setBusca(e.target.value)}
                    style={{ marginBottom: 8 }}
                  />
                  <select
                    value={llave}
                    onChange={(e) => setLlave(e.target.value)}
                  >
                    <option value="">— Selecciona —</option>
                    {visibles.map((c) => (
                      <option key={llaveCatalogo(c)} value={llaveCatalogo(c)}>
                        {c.detalle}
                        {c.area ? ` (${c.area})` : ''}
                      </option>
                    ))}
                  </select>
                  {busca && visibles.length === 0 && (
                    <div
                      style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}
                    >
                      Nada coincide con “{busca}”.
                    </div>
                  )}
                </>
              )}
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                Ahora dice: “{inc.nombre_incidencia || '—'}”
              </div>
            </div>

            {sel && (
              <div
                className="banner"
                style={{
                  marginBottom: 12,
                  ...(areaDestino === (inc.area_responsable || '')
                    ? { background: '#3a2e12', borderColor: '#6a5520', color: '#ffdf9e' }
                    : {}),
                }}
              >
                {areaDestino === (inc.area_responsable || '') ? (
                  <>
                    ⚠️ Esa incidencia pertenece a <b>{areaDestino || '—'}</b>,
                    la misma área actual: no hay nada que reasignar.
                  </>
                ) : (
                  <>
                    Se reasignará a: <b>{areaDestino || '—'}</b> (lo decide el
                    catálogo).
                  </>
                )}
              </div>
            )}
            <div className="field">
              <label>Motivo</label>
              <textarea
                rows={3}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Por qué debe ir a otra área…"
              />
            </div>
            <div className="field">
              <label>Evidencia (opcional)</label>
              <SubirArchivos
                accept="image/*"
                multiple={false}
                archivos={file ? [file] : []}
                onFiles={(f) => setFile(f[0] || null)}
                onQuitar={() => setFile(null)}
              />
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>
                Cancelar
              </button>
              <button className="btn" onClick={solicitar} disabled={busy}>
                {busy ? 'Enviando…' : 'Solicitar reasignación'}
              </button>
            </div>
          </>
        ) : loading ? (
          <div className="loading">Cargando…</div>
        ) : !req ? (
          <div className="empty">No hay una solicitud pendiente.</div>
        ) : (
          <>
            <div
              style={{
                background: 'var(--panel2)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '11px 12px',
                marginBottom: 12,
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              <div>
                <b>{req.area_origen || '—'}</b> →{' '}
                <b style={{ color: '#a78bfa' }}>{req.area_destino}</b>
              </div>
              {req.nueva_incidencia && (
                <div>
                  Se reclasificará como:{' '}
                  <b>{req.nueva_incidencia}</b>
                  <span style={{ color: 'var(--muted)' }}>
                    {' '}
                    (hoy dice “{inc.nombre_incidencia || '—'}”)
                  </span>
                </div>
              )}
              <div style={{ color: 'var(--muted)' }}>
                Solicita: {req.solicitado_por}
              </div>
              <div style={{ marginTop: 6 }}>Motivo: “{req.motivo || '—'}”</div>
              {req.evidencia && (
                <a
                  href={req.evidencia}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-block', marginTop: 8 }}
                >
                  <img
                    src={req.evidencia}
                    alt="Evidencia de la reasignación"
                    style={{
                      width: 120,
                      borderRadius: 8,
                      border: '1px solid var(--line)',
                    }}
                  />
                </a>
              )}
            </div>
            <div className="field">
              <label>Comentario (obligatorio si rechazas)</label>
              <input
                value={comentario}
                onChange={(e) => setComentario(e.target.value)}
              />
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>
                Cerrar
              </button>
              <button
                className="btn hi"
                onClick={() => resolver(false)}
                disabled={busy}
              >
                ✕ Rechazar
              </button>
              <button
                className="btn ok"
                onClick={() => resolver(true)}
                disabled={busy}
              >
                ✓ Aprobar y reasignar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default ReasignModal;
