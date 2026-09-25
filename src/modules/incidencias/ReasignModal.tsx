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
//
// SIN SEÑAL (modo sin señal, 24-sep-2026): el catálogo sale de la red con
// tope corto o de la copia del teléfono (lib/datosLocales.ts). Solicitar y
// resolver SÍ necesitan señal (no se encolan); sin red se dice claro. Y al
// revisar, una consulta que falla por red ya no se hace pasar por "No hay
// una solicitud pendiente".
// ============================================================
import { useState, useEffect, useMemo } from 'react';
import { sb } from '../../lib/supabase';
import { catalogoLocal, haySenal, motivoSinRed, redOLocal } from '../../lib/datosLocales';
import { idCorto } from '../../lib/helpers';
import {
  catalogoParaMuebles,
  llaveCatalogo,
  filtrarCatalogo,
} from '../../lib/catalogo';
import type { OpcionesCatalogo } from '../../lib/catalogo';
import type { CatalogoIncidencia } from '../../types/db';
import {
  BUCKET_EVIDENCIAS,
  CACHE_INMUTABLE,
  subirMiniatura,
} from '../../lib/storage';
import SubirArchivos from '../../components/SubirArchivos';
import { vigilarRender } from '../../lib/vigia';
import type { Incidencia, Reasignacion } from '../../types/db';

export type ModoReasign = 'solicitar' | 'aprobar';

type Props = {
  inc: Incidencia;
  mode: ModoReasign;
  email: string;
  onClose: () => void;
  onDone: (recordId: string, patch: Partial<Incidencia>) => void;
};

const SIN_SENAL = 'Necesitas señal para esto.';

/**
 * ¿Hay sesión real? (modo sin señal, 24-sep-2026). En la ventana en que
 * auth-js aún no renueva el token las peticiones salen como anónimas: una
 * lectura da 0 filas y una subida a Storage, 400/403. Tope de 3 s: sin red y
 * con el token vencido, getSession espera la renovación.
 */
function haySesionReal(): Promise<boolean> {
  return Promise.race([
    sb.auth.getSession().then(
      ({ data }) => !!data.session,
      () => false
    ),
    new Promise<boolean>((res) => setTimeout(() => res(false), 3000)),
  ]);
}

/** ¿El error de postgrest-js es de red? status 0 = sin respuesta; 401/5xx = de paso. */
function esRedPg(status: number | undefined): boolean {
  return !haySenal() || !status || status === 401 || status >= 500;
}

/** ¿El error de storage-js es de red? Sin red llega StorageUnknownError sin status. */
function esRedStorage(err: unknown): boolean {
  const e = (err || {}) as { name?: string; status?: number };
  return !haySenal() || e.name === 'StorageUnknownError' || !e.status || e.status >= 500;
}

function ReasignModal({ inc, mode, email, onClose, onDone }: Props) {
  // Ciclo de renders que no suelta el hilo → error del módulo (app pasmada
  // sin señal, 24-sep-2026; ver lib/vigia.ts).
  vigilarRender('ReasignModal');
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
  /** Sube con "Reintentar" cuando no llegó el catálogo (revisión sin señal, 24-sep-2026). */
  const [reintentoCat, setReintentoCat] = useState(0);
  const [llave, setLlave] = useState('');
  const [busca, setBusca] = useState('');
  const [motivo, setMotivo] = useState('');
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (mode !== 'solicitar') return;
    let vivo = true;
    setCargandoCat(true);
    setErrCat('');
    (async () => {
      // Sin señal o si la red falla, el de la copia del teléfono (modo sin
      // señal, 24-sep-2026). Igualdad sin mayúsculas, como el `ilike` sin
      // comodín de la red; el '%' solo aplica si la incidencia no trae
      // unidad (con prefijo, 'Biobox' se traería también 'Biobox Perú').
      const unidad = inc.unidad_negocio || '';
      const r = await redOLocal<CatalogoIncidencia[]>(
        (senal) =>
          sb
            .from('catalogo_incidencias')
            .select('*')
            .ilike('unidad_negocio', inc.unidad_negocio || '%')
            .limit(1000)
            .retry(false)
            .abortSignal(senal),
        () => catalogoLocal(unidad, { prefijo: !unidad })
      ).catch(() => ({ datos: [] as CatalogoIncidencia[], origen: 'local' as const }));
      if (!vivo) return;
      // Sin señal no es lo mismo que una red que tardó (revisión sin señal,
      // 24-sep-2026): con 3G lenta lo que sirve es Reintentar.
      if (r.origen === 'local' && r.datos.length === 0)
        setErrCat(
          motivoSinRed() === 'Sin señal'
            ? 'Sin señal, y este teléfono no tiene copia del catálogo. Abre la app una vez con señal.'
            : 'La red tardó demasiado, y este teléfono no tiene copia del catálogo.'
        );
      // Restringido al mueble de esta cara, como en el alta: ahí cada
      // incidencia existe una vez y el área ya viene decidida.
      setCat(catalogoParaMuebles(r.datos, [inc.tipo_mueble]));
      setCargandoCat(false);
    })();
    return () => {
      vivo = false;
    };
  }, [mode, inc.unidad_negocio, inc.tipo_mueble, reintentoCat]);

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
  /** La solicitud no se pudo leer por falta de señal (modo sin señal, 24-sep-2026). */
  const [sinRed, setSinRed] = useState(false);
  const [comentario, setComentario] = useState('');

  const cargarSolicitud = async () => {
    setLoading(true);
    setSinRed(false);
    // La más reciente que siga abierta. Puede no haber ninguna si otro
    // validador ya la resolvió mientras este usuario tenía la lista vieja.
    //
    // No hay copia en el teléfono: si la red falla (o no hay señal), el
    // respaldo devuelve null y se dice que falta señal, en vez del falso
    // "No hay una solicitud pendiente" de antes (modo sin señal, 24-sep-2026).
    const r = await redOLocal<Reasignacion[] | null>(
      (senal) =>
        sb
          .from('reasignaciones')
          .select('*')
          .eq('record_id', inc.record_id)
          .eq('estado', 'Solicitada')
          .order('fecha_solicitud', { ascending: false })
          .limit(1)
          .abortSignal(senal),
      async () => null,
      { topeMs: 10000 }
    ).catch(() => ({ datos: null, origen: 'local' as const }));
    // redOLocal solo da 'red' con sesión real: un [] pedido como anónimo
    // (la RLS da 0 filas) cae al respaldo y aquí cuenta como "sin señal",
    // no como "ya la resolvieron".
    const filas = r.origen === 'red' ? r.datos : null;
    if (!filas) {
      setSinRed(true);
      setReq(null);
    } else {
      setReq(filas[0] || null);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (mode !== 'aprobar') return;
    cargarSolicitud();
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
    if (!file) {
      alert('Adjunta la foto de evidencia de la reasignación.');
      return;
    }
    // La solicitud no se encola (modo sin señal, 24-sep-2026): sin señal se
    // dice claro y lo capturado sigue en el modal para intentarlo luego. Sin
    // sesión real la subida saldría como anónima y Storage la rechazaría.
    if (!haySenal()) {
      alert(SIN_SENAL);
      return;
    }
    setBusy(true);
    if (!(await haySesionReal())) {
      setBusy(false);
      alert(SIN_SENAL);
      return;
    }

    // La evidencia es obligatoria (misma regla que el alta): si la subida
    // falla, la solicitud NO se envía — sin foto el validador decide a ciegas.
    const path = `${inc.record_id}/reasignacion_${Date.now()}_${file.name.replace(
      /[^\w.\-]/g,
      '_'
    )}`;
    const { error: upErr } = await sb.storage
      .from(BUCKET_EVIDENCIAS)
      .upload(path, file, { cacheControl: CACHE_INMUTABLE });
    if (upErr) {
      setBusy(false);
      alert(
        esRedStorage(upErr)
          ? SIN_SENAL
          : 'No se pudo subir la foto: ' + upErr.message + '. Inténtalo de nuevo.'
      );
      return;
    }
    // La tarjeta pinta esta foto mientras la solicitud está pendiente.
    if (file.type.startsWith('image/')) await subirMiniatura(path, file);
    const evidenciaUrl = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path)
      .data.publicUrl;

    const rid = idCorto();
    const { error, status } = await sb.from('reasignaciones').insert({
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
      alert(esRedPg(status) ? SIN_SENAL : 'No se pudo solicitar: ' + error.message);
      return;
    }

    const { error: e2, status: s2 } = await sb
      .from('incidencias')
      .update({ reasignacion_pendiente: true })
      .eq('record_id', inc.record_id);
    setBusy(false);
    if (e2) {
      // La solicitud SÍ quedó registrada; solo falló marcar la incidencia.
      alert(
        esRedPg(s2)
          ? 'Se registró la solicitud, pero se cortó la señal antes de marcar la incidencia como pendiente.'
          : 'Se registró, pero no se marcó pendiente: ' + e2.message
      );
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
    // Resolver no se encola (modo sin señal, 24-sep-2026).
    if (!haySenal()) {
      alert(SIN_SENAL);
      return;
    }
    setBusy(true);
    if (!(await haySesionReal())) {
      setBusy(false);
      alert(SIN_SENAL);
      return;
    }

    const { error, status } = await sb
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
      alert(esRedPg(status) ? SIN_SENAL : 'No se pudo resolver: ' + error.message);
      return;
    }

    // Aprobar mueve el área; rechazar solo quita la bandera. `reasignada_de`
    // deja el rastro visible de que antes era de otra área (el trigger de la
    // base también lo rellena, pero mandarlo aquí actualiza la lista local
    // al instante vía onDone).
    const patch: Partial<Incidencia> = aprobar
      ? {
          area_responsable: req.area_destino,
          reasignacion_pendiente: false,
          reasignada_de: req.area_origen || null,
        }
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

    const { error: e2, status: s2 } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id);
    setBusy(false);
    if (e2) {
      alert(
        esRedPg(s2)
          ? 'Se resolvió la solicitud, pero se cortó la señal antes de actualizar la incidencia.'
          : 'Se resolvió, pero no se actualizó la incidencia: ' + e2.message
      );
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
            {errCat && (
              <div className="err">
                {errCat}{' '}
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setReintentoCat((n) => n + 1)}
                  disabled={cargandoCat}
                >
                  Reintentar
                </button>
              </div>
            )}
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
              <label>
                Evidencia (foto) —{' '}
                <span style={{ color: 'var(--accent)' }}>obligatoria</span>
              </label>
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
          // Con Cerrar también mientras carga (app pasmada sin señal,
          // 24-sep-2026): en el teléfono el fondo que cierra es una franja
          // de unos 8 px, y la consulta puede tardar hasta su tope.
          <>
            <div className="loading">Cargando…</div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>
                Cerrar
              </button>
            </div>
          </>
        ) : sinRed ? (
          <>
            <div className="empty">
              {/* Con 3G lenta no es "sin señal" (revisión sin señal, 24-sep-2026). */}
              {motivoSinRed() === 'Sin señal'
                ? '📴 Necesitas señal para revisar esta solicitud.'
                : 'La red tardó demasiado en traer esta solicitud.'}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>
                Cerrar
              </button>
              <button className="btn" onClick={cargarSolicitud}>
                Reintentar
              </button>
            </div>
          </>
        ) : !req ? (
          <>
            <div className="empty">No hay una solicitud pendiente.</div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>
                Cerrar
              </button>
            </div>
          </>
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
                      /* El validador decide aprobar/rechazar mirando esta
                         foto: a 120px no se distinguía nada y en táctil no
                         hay hover ni zoom (el <a> abre el original). */
                      width: '100%',
                      maxWidth: 220,
                      height: 'auto',
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
