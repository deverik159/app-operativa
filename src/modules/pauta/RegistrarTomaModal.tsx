// ============================================================
// src/modules/pauta/RegistrarTomaModal.tsx
// Registro de la toma en campo: fotos de la cara + fecha.
//
// Homologado con el flujo de Incidencias a propósito: mismas clases
// (.overlay/.modal/.field), el mismo componente SubirArchivos con los botones
// de cámara y galería, el mismo bucket `evidencias`, y la evidencia como
// requisito. Quien ya sabe subir una foto en Incidencias no tiene que
// aprender nada nuevo aquí.
//
// Las fotos se suben EN EL MOMENTO (no al confirmar), igual que en
// RepararModal: así quedan guardadas aunque el usuario abandone el modal —
// importante en campo, donde la señal se cae.
// ============================================================
import { useState, useEffect } from 'react';
import { sb } from '../../lib/supabase';
import { caraLabel } from '../../lib/helpers';
import { reglaEspecToma } from '../../lib/especToma';
import { pintar } from '../../lib/tonos';
import { BUCKET_EVIDENCIAS, CACHE_INMUTABLE } from '../../lib/storage';
import SubirArchivos from '../../components/SubirArchivos';
import type { PautaRuta, TipoEvidencia } from '../../types/db';
import { vigilarRender } from '../../lib/vigia';

/** Fila de `pauta_evidencias`. */
type EvidenciaPauta = {
  id: number;
  tipo: string | null;
  url: string;
  path: string | null;
  referencia: string | null;
  subido_por: string | null;
};

/** Subcarpeta dentro del bucket, para no mezclar con las de incidencias. */
const CARPETA = 'pauta';

type Props = {
  fila: PautaRuta;
  email: string;
  onClose: () => void;
  /** Avisa al padre que la toma quedó registrada, para refrescar la lista. */
  onRegistrada: (vendorFaceId: string) => void;
  /**
   * coordinador/manager: puede COMPROBAR la toma (validarla) y también
   * regresarla con motivo. El botón vive AQUÍ y no en la lista a
   * propósito: comprobar sin haber visto las fotos no debe ser posible.
   */
  puedeComprobar?: boolean;
  /** Comprueba en la base y refleja en la lista. true = quedó. */
  onComprobar?: (fila: PautaRuta) => Promise<boolean>;
  /** La toma se regresó: el padre pone la cara en PENDIENTE con su motivo. */
  onRegresada?: (vendorFaceId: string, motivo: string) => void;
};

function RegistrarTomaModal({
  fila,
  email,
  onClose,
  onRegistrada,
  puedeComprobar = false,
  onComprobar,
  onRegresada,
}: Props) {
  vigilarRender('RegistrarTomaModal');
  const [evidencias, setEvidencias] = useState<EvidenciaPauta[]>([]);
  const [cargando, setCargando] = useState(true);
  const [subiendo, setSubiendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [ref, setRef] = useState('');
  const [err, setErr] = useState('');

  const yaRegistrada = !!fila.fecha_toma;

  // --- Revisión del coordinador (solo con toma registrada sin comprobar) ---
  const revisando =
    puedeComprobar && yaRegistrada && !fila.fecha_comprobacion;
  /** true = está escribiendo el motivo para regresar la toma. */
  const [regresando, setRegresando] = useState(false);
  const [motivoRegreso, setMotivoRegreso] = useState('');
  const [resolviendo, setResolviendo] = useState(false);

  const comprobarToma = async () => {
    if (!onComprobar) return;
    setResolviendo(true);
    const ok = await onComprobar(fila);
    setResolviendo(false);
    if (ok) onClose();
  };

  const regresarToma = async () => {
    if (!motivoRegreso.trim()) {
      setErr('Escribe el motivo del regreso: el monitorista lo va a leer.');
      return;
    }
    setResolviendo(true);
    setErr('');
    const { error } = await sb.rpc('rechazar_toma', {
      p_catorcena: fila.catorcena,
      p_vendor_face_id: fila.vendor_face_id,
      p_motivo: motivoRegreso.trim(),
    });
    setResolviendo(false);
    if (error) {
      setErr('No se pudo regresar: ' + error.message);
      return;
    }
    onRegresada?.(fila.vendor_face_id, motivoRegreso.trim());
    onClose();
  };

  /**
   * La especificación de toma manda cuántas fotos se exigen (3 si no hay).
   * Los videos suman evidencia pero no cuentan para el mínimo: la espec
   * habla de tomas fotográficas.
   */
  const regla = reglaEspecToma(fila.espec_toma);
  // El hex de la regla, en su tono legible del tema activo. null cuando la
  // regla trae una var() (estándar = --muted): ese recuadro va sin tinte ni
  // borde, como siempre (tema claro/oscuro, 24-sep-2026).
  const tonoRegla = pintar(regla.color);
  const fotosSubidas = evidencias.filter((e) => e.tipo !== 'video').length;
  const faltanFotos = Math.max(0, regla.fotos - fotosSubidas);

  const cargar = async () => {
    const { data, error } = await sb
      .from('pauta_evidencias')
      .select('*')
      .eq('catorcena', fila.catorcena)
      .eq('vendor_face_id', fila.vendor_face_id)
      .order('creado_en');
    if (error) setErr('No se pudo cargar la evidencia: ' + error.message);
    else setEvidencias((data as EvidenciaPauta[]) || []);
    setCargando(false);
  };

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subir = async (files: File[]) => {
    if (!files.length) return;
    setSubiendo(true);
    setErr('');

    for (const f of files) {
      const tipo: TipoEvidencia = f.type.startsWith('video') ? 'video' : 'foto';
      const ext = (
        f.name.split('.').pop() || (tipo === 'video' ? 'mp4' : 'jpg')
      ).toLowerCase();
      const fecha = new Date().toISOString().slice(0, 10);
      // La cara y la catorcena van en el nombre: así el archivo se identifica
      // en Storage sin abrir la app.
      const nombre =
        `${fila.vendor_face_id}_cat${fila.catorcena}_${fecha}_${Date.now()}.${ext}`.replace(
          /[^\w.\-]/g,
          '_'
        );
      const path = `${CARPETA}/${fila.catorcena}/${nombre}`;

      const { error: up } = await sb.storage
        .from(BUCKET_EVIDENCIAS)
        .upload(path, f, { upsert: false, cacheControl: CACHE_INMUTABLE });
      if (up) {
        setErr('Error al subir ' + f.name + ': ' + up.message);
        continue;
      }
      const url = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data
        .publicUrl;
      const { data, error } = await sb
        .from('pauta_evidencias')
        .insert({
          catorcena: fila.catorcena,
          vendor_face_id: fila.vendor_face_id,
          tipo,
          url,
          path,
          referencia: ref || null,
          subido_por: email,
        })
        .select()
        .single();
      if (error) {
        setErr('Se subió el archivo pero no se registró: ' + error.message);
        continue;
      }
      if (data) setEvidencias((prev) => [...prev, data as EvidenciaPauta]);
    }

    setSubiendo(false);
  };

  const borrar = async (ev: EvidenciaPauta) => {
    if (!confirm('¿Eliminar esta evidencia?')) return;
    // Primero el archivo, luego la fila: al revés quedaría un archivo
    // huérfano en Storage sin forma de encontrarlo.
    if (ev.path) await sb.storage.from(BUCKET_EVIDENCIAS).remove([ev.path]);
    const { error } = await sb.from('pauta_evidencias').delete().eq('id', ev.id);
    if (error) {
      setErr('No se pudo eliminar: ' + error.message);
      return;
    }
    setEvidencias((prev) => prev.filter((x) => x.id !== ev.id));
  };

  const confirmar = async () => {
    if (evidencias.length === 0) {
      setErr(
        'Adjunta al menos una foto o video. La toma ES la captura de la evidencia.'
      );
      return;
    }
    // La especificación es la condición: sin sus fotos, la toma no se
    // registra — es exactamente lo que el validador rechazaría después.
    if (faltanFotos > 0) {
      setErr(
        `La especificación pide ${regla.fotos} fotos (${regla.resumen}) y ` +
          `llevas ${fotosSubidas}. Faltan ${faltanFotos}.`
      );
      return;
    }
    setGuardando(true);
    setErr('');
    const { error } = await sb.rpc('registrar_toma', {
      p_catorcena: fila.catorcena,
      p_vendor_face_id: fila.vendor_face_id,
    });
    setGuardando(false);
    if (error) {
      setErr('No se pudo registrar la toma: ' + error.message);
      return;
    }
    onRegistrada(fila.vendor_face_id);
    onClose();
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        // Mientras sube fotos o guarda, un roce en el overlay no debe cerrar
        // el modal: dejaría la subida a medias sin confirmación.
        if (
          (e.target as HTMLElement).className === 'overlay' &&
          !subiendo &&
          !guardando
        )
          onClose();
      }}
    >
      <div className="modal">
        <h2 style={{ margin: '0 0 3px' }}>
          {yaRegistrada ? 'Evidencia de la toma' : 'Registrar toma'}
        </h2>
        <p className="phint">
          {fila.site_id} · cara {fila.cara || caraLabel(fila.vendor_face_id)} ·{' '}
          {fila.campana || '(sin campaña)'}
        </p>

        {err && <div className="err">{err}</div>}

        {/* Contexto: qué debe fotografiar y con qué especificación. */}
        <div
          style={{
            background: 'var(--panel2)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '11px 12px',
            marginBottom: 14,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
            📋 Qué se está monitoreando
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            {fila.direccion || '(sin dirección)'}
            <br />
            Campaña: <b style={{ color: 'var(--txt)' }}>{fila.campana || '—'}</b>
            {fila.version && (
              <>
                <br />
                Arte: {fila.version}
              </>
            )}
            {fila.campana_anterior && (
              <>
                <br />
                Antes: {fila.campana_anterior}
              </>
            )}
            <br />
            {fila.medio} · {fila.estatus}
            {fila.fecha_fijacion && ` · fijada ${fila.fecha_fijacion}`}
          </div>

          {/* La especificación de toma, al pie y con su color: es LA
              instrucción de trabajo — decide cuántas fotos van. El color
              lo pone la regla (lib/especToma); ámbar = texto que la app
              aún no homologa y hay que leer con cuidado. */}
          <div
            style={{
              marginTop: 10,
              paddingTop: 9,
              borderTop: '1px solid var(--line)',
              fontSize: 12,
              lineHeight: 1.55,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                padding: '4px 10px',
                borderRadius: 8,
                fontWeight: 700,
                background: tonoRegla?.background,
                color: tonoRegla?.color ?? regla.color,
                border: tonoRegla ? '1px solid ' + tonoRegla.borderColor : undefined,
                overflowWrap: 'anywhere',
              }}
            >
              📸 {fila.espec_toma?.trim() || 'Sin especificación de toma'}
            </span>
            <div style={{ color: 'var(--muted)', marginTop: 4 }}>
              Requiere <b style={{ color: tonoRegla?.color ?? regla.color }}>{regla.fotos} fotos</b>{' '}
              ({regla.resumen}).
            </div>
          </div>
        </div>

        {yaRegistrada && (
          <div className="banner" style={{ marginBottom: 14 }}>
            Esta cara ya tiene toma registrada
            {fila.toma_por ? ` por ${fila.toma_por.split('@')[0]}` : ''}. Puedes
            agregar más evidencia; la fecha original no cambia.
          </div>
        )}

        {/* Toma de reposición: el monitorista ve POR QUÉ se la regresaron
            antes de volver a disparar la cámara. */}
        {/* Era una copia en línea de .err (mismos colores y medidas): con la
            clase toma la pareja clara del tema (tema claro/oscuro,
            24-sep-2026). */}
        {!yaRegistrada && fila.rechazo_motivo && (
          <div className="err">
            ⛔ El coordinador regresó la toma anterior: “{fila.rechazo_motivo}”.
            Esta captura la repone.
          </div>
        )}

        <div className="field">
          <label>Referencia / ubicación (opcional)</label>
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="Ej. toma larga, cara norte, con obstrucción"
            disabled={subiendo}
          />
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Se etiqueta con este texto lo que subas a continuación.
          </div>
        </div>

        <div className="field">
          <label>
            Fotos de la cara —{' '}
            {faltanFotos === 0 ? (
              <span style={{ color: 'var(--ok)' }}>
                ✓ {fotosSubidas}/{regla.fotos}
              </span>
            ) : (
              // --accent-txt: el naranja como texto, con pareja legible en
              // el tema claro (tema claro/oscuro, 24-sep-2026).
              <span style={{ color: 'var(--accent-txt)' }}>
                {fotosSubidas}/{regla.fotos} · faltan {faltanFotos}
              </span>
            )}
          </label>

          {cargando ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Buscando evidencia ya subida…
            </div>
          ) : (
            <>
              {evidencias.length > 0 && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill,minmax(84px,1fr))',
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  {evidencias.map((ev) => (
                    <div key={ev.id}>
                      {ev.tipo === 'video' ? (
                        <a
                          href={ev.url}
                          target="_blank"
                          rel="noreferrer"
                          className="tag"
                          style={{
                            display: 'flex',
                            height: 84,
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 22,
                          }}
                        >
                          🎥
                        </a>
                      ) : (
                        <a href={ev.url} target="_blank" rel="noreferrer">
                          <img
                            src={ev.url}
                            alt={ev.referencia || 'Evidencia de la toma'}
                            style={{
                              width: '100%',
                              height: 84,
                              objectFit: 'cover',
                              borderRadius: 9,
                              border: '1px solid var(--line)',
                              display: 'block',
                            }}
                          />
                        </a>
                      )}
                      <div
                        style={{
                          fontSize: 10,
                          color: 'var(--muted)',
                          marginTop: 3,
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 4,
                        }}
                      >
                        {/* nowrap: sin él, text-overflow no hace nada (el
                            texto envuelve y se corta a media palabra bajo la
                            miniatura); el title conserva el texto completo. */}
                        <span
                          style={{
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={ev.referencia || ''}
                        >
                          {ev.referencia || ''}
                        </span>
                        <button
                          type="button"
                          className="btn-icono"
                          onClick={() => borrar(ev)}
                          aria-label="Eliminar evidencia"
                          title="Eliminar"
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <SubirArchivos
                onFiles={subir}
                disabled={subiendo}
                ayuda="Se suben en cuanto las eliges."
              />
              {subiendo && (
                <div
                  style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}
                >
                  <span className="spinner" />
                  Subiendo…
                </div>
              )}
            </>
          )}
        </div>

        {/* Regreso de la toma: el motivo es obligatorio — es lo que el
            monitorista va a leer en su notificación. */}
        {revisando && regresando && (
          <div className="field">
            <label>Motivo del regreso</label>
            <textarea
              rows={2}
              value={motivoRegreso}
              onChange={(e) => setMotivoRegreso(e.target.value)}
              placeholder="Ej. la foto salió movida; falta la toma larga…"
              disabled={resolviendo}
            />
          </div>
        )}

        <div className="modal-actions">
          <button
            className="btn ghost"
            onClick={() => (regresando ? setRegresando(false) : onClose())}
            disabled={subiendo || guardando || resolviendo}
          >
            {regresando ? 'Cancelar regreso' : yaRegistrada ? 'Cerrar' : 'Cancelar'}
          </button>
          {!yaRegistrada && (
            <button
              className="btn"
              onClick={confirmar}
              disabled={guardando || subiendo || cargando}
            >
              {guardando ? 'Registrando…' : '📷 Registrar toma'}
            </button>
          )}
          {revisando && !regresando && (
            <>
              <button
                className="btn hi"
                onClick={() => setRegresando(true)}
                disabled={resolviendo}
              >
                ⛔ Regresar
              </button>
              <button
                className="btn ok"
                onClick={comprobarToma}
                disabled={resolviendo}
              >
                {resolviendo && <span className="spinner" />}✓ Comprobar
              </button>
            </>
          )}
          {revisando && regresando && (
            <button
              className="btn hi"
              onClick={regresarToma}
              disabled={resolviendo}
            >
              {resolviendo && <span className="spinner" />}⛔ Confirmar regreso
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default RegistrarTomaModal;
