// ============================================================
// src/modules/incidencias/EvidenciaModal.tsx
// Galería de evidencias (fotos y videos) de una incidencia, con subida y
// borrado según la etapa del flujo.
//
// Etapa según el estatus:
//   por_validar / rechazada → 'reporte'
//   en_proceso              → 'reparacion'
//   cerrada / no_reparado   → ninguna (solo lectura, salvo validador)
// Estas reglas espejean la RLS ev_del, para no ofrecer un 🗑 que la base
// va a rechazar.
//
// SIN SEÑAL (modo sin señal, 24-sep-2026): la evidencia no tiene copia en
// el teléfono. Si la consulta falla por red se dice eso —antes salía el
// falso "Sin evidencia todavía."— y se vuelve a pedir sola al regresar la
// señal. Subir y borrar necesitan señal.
// ============================================================
import { useState, useEffect } from 'react';
import { sb } from '../../lib/supabase';
import { haySenal, redOLocal } from '../../lib/datosLocales';
import { codigoCara } from '../../lib/helpers';
import { ETAPA_LABEL } from '../../lib/constants';
import {
  BUCKET_EVIDENCIAS,
  CACHE_INMUTABLE,
  rutaMiniatura,
  subirMiniatura,
} from '../../lib/storage';
import { reportarError } from '../../lib/reportarError';
import SubirArchivos from '../../components/SubirArchivos';
import type {
  Evidencia,
  EtapaEvidencia,
  Incidencia,
  TipoEvidencia,
} from '../../types/db';

type Props = {
  inc: Incidencia;
  email: string;
  onClose: () => void;
  esValidador?: boolean;
  esSoloViewer?: boolean;
};

const SIN_SENAL = 'Necesitas señal para esto.';

/**
 * ¿Hay sesión real? (modo sin señal, 24-sep-2026). En la ventana en que
 * auth-js aún no renueva el token las peticiones salen como anónimas: la
 * lectura da 0 filas (parecería que no hay evidencia) y la subida a Storage,
 * 400/403. Tope de 3 s: sin red y con el token vencido, getSession espera
 * la renovación.
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

/** ¿El error de storage-js es de red? Sin red llega StorageUnknownError sin status. */
function esRedStorage(err: unknown): boolean {
  const e = (err || {}) as { name?: string; status?: number };
  return !haySenal() || e.name === 'StorageUnknownError' || !e.status || e.status >= 500;
}

/** ¿El error de postgrest-js es de red? status 0 = sin respuesta; 401/5xx = de paso. */
function esRedPg(status: number | undefined): boolean {
  return !haySenal() || !status || status === 401 || status >= 500;
}

/**
 * Pie de una evidencia: etapa siempre, referencia y autor solo si existen.
 * Se construye por partes y se une con separadores, en vez de concatenar
 * con "·" fijos — así nunca queda un separador suelto cuando el usuario no
 * escribió referencia.
 */
function PieEvidencia({
  ev,
  conAutor = false,
  onBorrar,
}: {
  ev: Evidencia;
  conAutor?: boolean;
  onBorrar?: () => void;
}) {
  const partes: string[] = [];
  if (ev.referencia) partes.push(ev.referencia);
  // Solo el usuario del correo: el dominio es siempre el mismo y estorba.
  if (conAutor && ev.subido_por) partes.push(ev.subido_por.split('@')[0]);

  return (
    <div
      style={{
        fontSize: 10,
        color: 'var(--muted)',
        marginTop: 4,
        lineHeight: 1.35,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <span
          style={{
            background: 'var(--panel2)',
            borderRadius: 5,
            padding: '1px 5px',
            fontWeight: 600,
          }}
        >
          {ETAPA_LABEL[ev.etapa] || ev.etapa}
        </span>
        {partes.length > 0 && <> {partes.join(' · ')}</>}
      </span>
      {onBorrar && (
        <button
          type="button"
          className="btn-icono"
          onClick={onBorrar}
          aria-label="Eliminar evidencia"
          title="Eliminar"
        >
          🗑
        </button>
      )}
    </div>
  );
}

function EvidenciaModal({
  inc,
  email,
  onClose,
  esValidador = false,
  esSoloViewer = false,
}: Props) {
  // Etapa que corresponde al estatus actual. null = fuera de ventana.
  const etapaAuto: EtapaEvidencia | null = ['por_validar', 'rechazada'].includes(
    inc.estatus
  )
    ? 'reporte'
    : inc.estatus === 'en_proceso'
      ? 'reparacion'
      : null;

  // El validador puede subir siempre (control); los demás solo en su ventana.
  const puedeSubir = !esSoloViewer && (esValidador || etapaAuto !== null);

  const [items, setItems] = useState<Evidencia[]>([]);
  const [loading, setLoading] = useState(true);
  /** La última consulta falló por falta de señal (modo sin señal, 24-sep-2026). */
  const [sinRed, setSinRed] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const [etapa, setEtapa] = useState<EtapaEvidencia>(etapaAuto || 'reporte');
  const [ref, setRef] = useState('');

  // El validador elige etapa a mano; el resto la tiene fijada por el estatus.
  const etapaUsar: EtapaEvidencia = esValidador ? etapa : etapaAuto || 'reporte';

  /** Espeja la política ev_del: validador/manager, o el dueño en su ventana. */
  const puedeBorrar = (f: Evidencia) =>
    esValidador ||
    (inc.estatus !== 'cerrada' &&
      (f.subido_por || '').toLowerCase() === (email || '').toLowerCase() &&
      ((f.etapa === 'reporte' &&
        ['por_validar', 'rechazada'].includes(inc.estatus)) ||
        (f.etapa === 'reparacion' &&
          ['en_proceso', 'reparado'].includes(inc.estatus))));

  const cargar = async () => {
    setLoading(true);
    // Sin copia en el teléfono: si no hay señal o la red falla, el respaldo
    // devuelve null y se avisa, conservando lo que ya se veía (modo sin
    // señal, 24-sep-2026). Con los reintentos de postgrest-js, pero con tope.
    const r = await redOLocal<Evidencia[] | null>(
      (senal) =>
        sb
          .from('evidencias')
          .select('*')
          .eq('record_id', inc.record_id)
          .order('creado_en', { ascending: false })
          .abortSignal(senal),
      async () => null,
      { topeMs: 12000 }
    ).catch(() => ({ datos: null, origen: 'local' as const }));
    // redOLocal solo da 'red' con sesión real: un [] pedido como anónimo
    // (la RLS da 0 filas) cae al respaldo y cuenta como "sin señal", no
    // como "sin evidencia".
    const filas = r.origen === 'red' ? r.datos : null;
    if (!filas) {
      setSinRed(true);
    } else {
      setSinRed(false);
      setItems(filas);
    }
    setLoading(false);
  };

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Al volver la señal se vuelve a pedir sola (modo sin señal, 24-sep-2026).
  useEffect(() => {
    if (!sinRed) return;
    const alVolver = () => cargar();
    window.addEventListener('online', alVolver);
    return () => window.removeEventListener('online', alVolver);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinRed]);

  const subir = async (files: File[]) => {
    if (files.length === 0) return;
    // Subir no se encola (modo sin señal, 24-sep-2026): sin señal se dice
    // claro. Sin sesión real la subida saldría como anónima y Storage la
    // rechazaría como si fuera un error de permisos.
    if (!haySenal()) {
      alert(SIN_SENAL);
      return;
    }
    setSubiendo(true);
    if (!(await haySesionReal())) {
      setSubiendo(false);
      alert(SIN_SENAL);
      return;
    }

    for (const f of files) {
      const tipo: TipoEvidencia = f.type.startsWith('video') ? 'video' : 'foto';
      // Renombrado automático: folio + cara + fecha + etapa. Así el archivo
      // es legible en Storage y su URL dice de qué incidencia es sin abrir
      // la app.
      const folio = (inc.folio || '').trim();
      const cara = codigoCara(inc.clave_medio) || inc.clave_sitio || 'sitio';
      const baseFecha =
        (etapaUsar === 'reparacion'
          ? inc.repaired_at || inc.fecha_reparacion
          : inc.fecha_reporte) || new Date().toISOString();
      const fechaStr = String(baseFecha).slice(0, 10);
      const ext = (
        f.name.split('.').pop() || (tipo === 'video' ? 'mp4' : 'jpg')
      ).toLowerCase();
      const nombre =
        `${folio ? folio + '_' : ''}${cara}_${fechaStr}_${etapaUsar}_${Date.now()}.${ext}`.replace(
          /[^\w.\-]/g,
          '_'
        );
      const path = `${inc.record_id}/${nombre}`;

      const { error: upErr } = await sb.storage
        .from(BUCKET_EVIDENCIAS)
        .upload(path, f, { upsert: false, cacheControl: CACHE_INMUTABLE });
      if (upErr) {
        // Sin red no tiene caso seguir con los demás ni reportarlo como
        // error de la app (modo sin señal, 24-sep-2026).
        if (esRedStorage(upErr)) {
          alert(SIN_SENAL);
          break;
        }
        reportarError('EvidenciaModal.subida', upErr, { path, tipo, bytes: f.size }, path);
        alert('Error al subir ' + f.name + ': ' + upErr.message);
        continue;
      }
      if (tipo === 'foto') await subirMiniatura(path, f);
      const { data: pub } = sb.storage
        .from(BUCKET_EVIDENCIAS)
        .getPublicUrl(path);
      // El error del insert se avisa: si la fila no se crea, el archivo
      // queda en Storage pero la galería sale vacía y el usuario resube.
      const { error: insErr, status: insStatus } = await sb.from('evidencias').insert({
        record_id: inc.record_id,
        etapa: etapaUsar,
        tipo,
        url: pub.publicUrl,
        path,
        subido_por: email,
        referencia: ref || null,
      });
      if (insErr) {
        if (esRedPg(insStatus)) {
          // Pudo haber llegado y perderse la respuesta: antes de resubir, que
          // revise la galería (resubir a ciegas la duplicaría).
          alert(
            f.name + ' se subió, pero se cortó la señal al registrarla. Cuando ' +
              'vuelva la señal revisa aquí si aparece antes de adjuntarla otra vez.'
          );
          break;
        }
        alert(
          f.name + ' se subió pero no se pudo registrar: ' + insErr.message
        );
      }
    }

    setSubiendo(false);
    cargar();
  };

  const borrar = async (item: Evidencia) => {
    // Borrar no se encola (modo sin señal, 24-sep-2026): se avisa ANTES de
    // preguntar, para no confirmar algo que no se puede hacer.
    if (!haySenal()) {
      alert(SIN_SENAL);
      return;
    }
    if (!confirm('¿Eliminar esta evidencia?')) return;
    if (!(await haySesionReal())) {
      alert(SIN_SENAL);
      return;
    }
    // Primero el archivo, luego la fila: si falla el archivo, la fila queda
    // y se puede reintentar. Al revés quedaría un archivo sin referencia.
    // La miniatura va en la misma llamada; si no existe, Storage la ignora.
    if (item.path) {
      const { error: rmErr } = await sb.storage
        .from(BUCKET_EVIDENCIAS)
        .remove([item.path, rutaMiniatura(item.path)]);
      // Solo la falla de red detiene: otros errores siguen como antes (la
      // fila se borra igual).
      if (rmErr && esRedStorage(rmErr)) {
        alert(SIN_SENAL);
        return;
      }
    }
    const { error, status } = await sb.from('evidencias').delete().eq('id', item.id);
    if (error) {
      alert(esRedPg(status) ? SIN_SENAL : 'No se pudo eliminar: ' + error.message);
      return;
    }
    cargar();
  };

  const fotos = items.filter((x) => x.tipo === 'foto');
  const videos = items.filter((x) => x.tipo === 'video');

  return (
    <div
      className="overlay"
      onClick={(e) => {
        // Mientras sube archivos, un roce en el fondo no debe cerrar.
        if ((e.target as HTMLElement).className === 'overlay' && !subiendo)
          onClose();
      }}
    >
      <div className="modal">
        <h2 style={{ margin: '0 0 3px' }}>Evidencia</h2>
        <p className="phint">
          {inc.folio} · {inc.nombre_incidencia}
          {inc.clave_medio ? ` · ${inc.clave_medio}` : ''}
        </p>

        {inc.estatus === 'cerrada' && !puedeSubir && (
          <div className="banner" style={{ marginBottom: 12 }}>
            🔒 Incidencia cerrada — evidencia en solo lectura.
          </div>
        )}

        {puedeSubir && (
          <>
            <div className="row2">
              <div className="field">
                <label>Etapa</label>
                {esValidador ? (
                  <select
                    value={etapa}
                    onChange={(e) =>
                      setEtapa(e.target.value as EtapaEvidencia)
                    }
                  >
                    <option value="reporte">Reporte</option>
                    <option value="reparacion">Reparación</option>
                  </select>
                ) : (
                  <input
                    value={ETAPA_LABEL[etapaUsar]}
                    readOnly
                    style={{ opacity: 0.7, cursor: 'default' }}
                  />
                )}
              </div>
              <div className="field">
                <label>Referencia / ubicación</label>
                <input
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="Ej. esquina superior, cara norte, poste"
                />
              </div>
            </div>
            <div className="field">
              <label>
                Agregar fotos o video (se etiquetan con la referencia de arriba)
              </label>
              <SubirArchivos onFiles={subir} disabled={subiendo} />
            </div>
            {subiendo && (
              <div className="banner" style={{ marginBottom: 12 }}>
                <span className="spinner" />
                Subiendo…
              </div>
            )}
          </>
        )}

        {/* Sin señal (modo sin señal, 24-sep-2026): lo que ya se veía se
            conserva; si no había nada, se dice por qué. */}
        {!loading && sinRed && (
          <div
            className="banner"
            style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
            role="status"
          >
            <span style={{ flex: '1 1 180px' }}>
              📴 Sin señal: la evidencia se verá al volver la red.
            </span>
            <button type="button" className="btn ghost sm" onClick={cargar}>
              Reintentar
            </button>
          </div>
        )}

        {loading ? (
          <div className="loading">Cargando…</div>
        ) : items.length === 0 ? (
          sinRed ? null : <div className="empty">Sin evidencia todavía.</div>
        ) : (
          <>
            {fotos.length > 0 && (
              <>
                <label>Fotos ({fotos.length})</label>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill,minmax(96px,1fr))',
                    gap: 8,
                    marginBottom: 14,
                  }}
                >
                  {fotos.map((f) => (
                    <div key={f.id}>
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        title={f.etapa}
                      >
                        <img
                          src={f.url}
                          alt={f.referencia || `Evidencia de ${f.etapa}`}
                          style={{
                            width: '100%',
                            height: 90,
                            objectFit: 'cover',
                            borderRadius: 9,
                            border: '1px solid var(--line)',
                          }}
                        />
                      </a>
                      <PieEvidencia
                        ev={f}
                        onBorrar={puedeBorrar(f) ? () => borrar(f) : undefined}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}

            {videos.length > 0 && (
              <>
                <label>Videos ({videos.length})</label>
                <div style={{ display: 'grid', gap: 8 }}>
                  {videos.map((v) => (
                    <div key={v.id}>
                      <video
                        src={v.url}
                        controls
                        style={{ width: '100%', borderRadius: 9, maxHeight: 220 }}
                      />
                      <PieEvidencia
                        ev={v}
                        conAutor
                        onBorrar={puedeBorrar(v) ? () => borrar(v) : undefined}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

export default EvidenciaModal;
