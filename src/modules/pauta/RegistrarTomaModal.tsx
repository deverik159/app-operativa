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
import { Camera, ClipboardList, Trash } from 'lucide-react';
import { useState, useEffect } from 'react';
import { sb } from '../../lib/supabase';
import { caraLabel } from '../../lib/helpers';
import { reglaEspecToma } from '../../lib/especToma';
import { diaCdmx } from '../../lib/fechasCdmx';
import { pintar } from '../../lib/tonos';
import { BUCKET_EVIDENCIAS, CACHE_INMUTABLE } from '../../lib/storage';
import SubirArchivos from '../../components/SubirArchivos';
import type { PautaRuta, TipoEvidencia } from '../../types/db';
import { vigilarRender } from '../../lib/vigia';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';

/** Fila de `pauta_evidencias`. */
type EvidenciaPauta = {
  id: number;
  tipo: string | null;
  url: string;
  path: string | null;
  referencia: string | null;
  subido_por: string | null;
  /** De una toma que el coordinador regresó: ya no cuenta (14-oct-2026). */
  regresada_en?: string | null;
};

/** Subcarpeta dentro del bucket, para no mezclar con las de incidencias. */
const CARPETA = 'pauta';

type Props = {
  fila: PautaRuta;
  email: string;
  onClose: () => void;
  /** Avisa al padre que la toma quedó registrada, para refrescar la lista. */
  onRegistrada: (vendorFaceId: string) => void;
};

// Comprobar y regresar ya no viven aquí (22-oct-2026): el coordinador dejó
// de comprobar. Las tomas las revisa el analista foto por foto en la pestaña
// Analista (AnalistaPauta.tsx) y su revisión es la comprobación.
function RegistrarTomaModal({ fila, email, onClose, onRegistrada }: Props) {
  vigilarRender('RegistrarTomaModal');
  const [evidencias, setEvidencias] = useState<EvidenciaPauta[]>([]);
  const [cargando, setCargando] = useState(true);
  const [subiendo, setSubiendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [ref, setRef] = useState('');
  const [err, setErr] = useState('');

  const yaRegistrada = !!fila.fecha_toma;

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
  // Solo cuentan las vigentes: las de una toma regresada se quedan como
  // rastro, pero la toma nueva necesita sus propias fotos (14-oct-2026).
  const vigentes = evidencias.filter((e) => !e.regresada_en);
  const regresadas = evidencias.filter((e) => !!e.regresada_en);
  /** Comprobada: ya no se agregan ni se quitan fotos (la base lo impide). */
  const cerrada = !!fila.fecha_comprobacion;
  const fotosSubidas = vigentes.filter((e) => e.tipo !== 'video').length;
  const faltanFotos = Math.max(0, regla.fotos - fotosSubidas);

  const cargar = async () => {
    const { data, error } = await sb
      .from('pauta_evidencias')
      .select('*')
      // Número + año (14-oct-2026): la misma cara puede tener la Cat-1 de
      // dos años distintos.
      .eq('anio', fila.anio)
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
      // Día de CDMX: con el ISO, lo tomado después de las 18:00 salía con
      // la fecha de mañana (20-oct-2026).
      const fecha = diaCdmx(new Date());
      // La cara y la catorcena (año-número, 14-oct-2026) van en el nombre:
      // así el archivo se identifica en Storage sin abrir la app. Las de
      // antes quedaron en la carpeta con solo el número.
      const cat = `${fila.anio}-${fila.catorcena}`;
      const nombre =
        `${fila.vendor_face_id}_cat${cat}_${fecha}_${Date.now()}.${ext}`.replace(
          /[^\w.\-]/g,
          '_'
        );
      const path = `${CARPETA}/${cat}/${nombre}`;

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
          anio: fila.anio,
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
    // Primero la fila y se confirma que se borró: si la toma se comprobó
    // mientras el modal estaba abierto, la base ya no deja borrar (22-oct-2026)
    // y no debe irse el archivo de una foto que sigue registrada. Después el
    // archivo; si eso fallara, queda un huérfano en Storage, que es lo menos
    // malo.
    const { data, error } = await sb.from('pauta_evidencias').delete().eq('id', ev.id).select('id');
    if (error) {
      setErr('No se pudo eliminar: ' + error.message);
      return;
    }
    if (!data || data.length === 0) {
      setErr('No se pudo eliminar: la toma ya está comprobada o no tienes permiso.');
      return;
    }
    if (ev.path) await sb.storage.from(BUCKET_EVIDENCIAS).remove([ev.path]);
    setEvidencias((prev) => prev.filter((x) => x.id !== ev.id));
  };

  const confirmar = async () => {
    if (vigentes.length === 0) {
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
      p_anio: fila.anio,
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
        <CerrarModal onClick={onClose} disabled={subiendo || guardando} />
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
            <Ic i={ClipboardList} />Qué se está monitoreando
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
              <Ic i={Camera} />{fila.espec_toma?.trim() || 'Sin especificación de toma'}
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
              {vigentes.length > 0 && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill,minmax(84px,1fr))',
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  {vigentes.map((ev) => (
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
                        {!cerrada && (
                          <button
                            type="button"
                            className="btn-icono"
                            onClick={() => borrar(ev)}
                            aria-label="Eliminar evidencia"
                            title="Eliminar"
                          >
                            <Ic i={Trash} className="solo" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {regresadas.length > 0 && (
                <details style={{ marginBottom: 10, fontSize: 12, color: 'var(--muted)' }}>
                  <summary style={{ cursor: 'pointer' }}>
                    {regresadas.length} {regresadas.length === 1 ? 'archivo' : 'archivos'} de la toma
                    regresada (ya no cuentan)
                  </summary>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill,minmax(64px,1fr))',
                      gap: 6,
                      marginTop: 6,
                      opacity: 0.6,
                    }}
                  >
                    {regresadas.map((ev) => (
                      <a key={ev.id} href={ev.url} target="_blank" rel="noreferrer" className="tag" style={{ display: 'block', padding: 0 }}>
                        {ev.tipo === 'video' ? (
                          <span style={{ display: 'flex', height: 64, alignItems: 'center', justifyContent: 'center' }}>🎥</span>
                        ) : (
                          <img
                            src={ev.url}
                            alt="Evidencia de la toma regresada"
                            style={{ width: '100%', height: 64, objectFit: 'cover', borderRadius: 8, display: 'block' }}
                          />
                        )}
                      </a>
                    ))}
                  </div>
                </details>
              )}

              {cerrada ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Toma comprobada: ya no se agregan ni se quitan fotos.
                </div>
              ) : (
                <SubirArchivos
                  onFiles={subir}
                  disabled={subiendo}
                  ayuda="Se suben en cuanto las eliges."
                />
              )}
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

        <div className="modal-actions pie-fijo">
          <button className="btn ghost" onClick={onClose} disabled={subiendo || guardando}>
            {yaRegistrada ? 'Cerrar' : 'Cancelar'}
          </button>
          {!yaRegistrada && (
            <button
              className="btn"
              onClick={confirmar}
              disabled={guardando || subiendo || cargando}
            >
              {guardando ? 'Registrando…' : 'Registrar toma'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default RegistrarTomaModal;
