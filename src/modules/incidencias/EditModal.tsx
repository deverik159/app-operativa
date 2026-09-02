// ============================================================
// src/modules/incidencias/EditModal.tsx
// Corrección del REPORTANTE sobre su propio reporte.
//
// QUÉ CAMBIÓ Y POR QUÉ (ago-2026):
//
// Antes este modal servía para dos personas a la vez: el validador editaba
// nivel/origen/tipo/área a mano, y el reportante lo mismo. Ahora están
// separados, porque no corrigen lo mismo:
//
//   Validador   → CorreccionModal. Corrige QUÉ incidencia es, y los campos
//                 derivados los pone el catálogo. Ver ese archivo.
//   Reportante  → este modal. Corrige lo que él capturó y solo puede haber
//                 equivocado él: la observación, y sobre todo el SITIO y la
//                 CARA. Un reporte con la clave equivocada manda al técnico a
//                 la valla de junto.
//
// LA EVIDENCIA NO SE EDITA AQUÍ, a propósito. `EvidenciaModal` ya deja al
// reportante subir y borrar LO SUYO mientras la incidencia esté en
// `por_validar` o `rechazada`, y su función `puedeBorrar` es un espejo exacto
// de la política `ev_del` de la base. Duplicar esa lógica aquí sería tener dos
// reglas de permiso que con el tiempo se separan: la de la base seguiría
// mandando y el botón de acá mentiría. Por eso este modal manda a ese.
//
// AL GUARDAR REGRESA A `por_validar`. Si la incidencia venía `rechazada`, el
// reportante la corrige y vuelve a entrar al flujo normal de validación; no
// hace falta un botón aparte de "reenviar". Si ya estaba en `por_validar`, el
// estatus no se mueve.
//
// LÍMITE DE LA BASE: la política `inc_upd_reportante` solo permite UPDATE en
// `por_validar` y `rechazada`. IncCard no ofrece el botón fuera de eso, y si
// alguien lo forzara, el UPDATE afectaría 0 filas — por eso se cuenta lo
// devuelto en vez de confiar en que no haya `error`.
//
// ══ QUIÉN DERIVA LA UBICACIÓN: EL FRONTEND, NO UN TRIGGER ══
//
// Esto se verificó contra la base el 26-ago-2026 y contradice lo que decía el
// comentario de `types/db.ts`. `set_derivados` NO toca la ubicación: lo único
// que hace es rellenar `semana` y `catorcena` a partir de `fecha_reporte`, y
// solo cuando vienen en null.
//
// `direccion`, `municipio`, `plaza`, `medio`, `tipo_mueble` y `nombre_biobox`
// los manda NuevaInc desde el navegador al capturar, leyéndolos de
// `inventario`. No hay nada del lado del servidor que los recalcule.
//
// Consecuencia directa para este modal: al cambiar el sitio o la cara hay que
// mandar TODOS esos campos otra vez. Mandar solo `clave_sitio` dejaría la
// fila con la clave nueva y la dirección, el municipio y la plaza del sitio
// anterior — y el técnico llegaría a la dirección equivocada leyendo una
// clave correcta. Por eso `derivarUbicacion()` existe y no es duplicación:
// es el mismo camino que ya usa el alta.
// ============================================================
import { useState, useEffect } from 'react';
import { sb } from '../../lib/supabase';
import { caraLabel } from '../../lib/helpers';
import {
  UNIDADES_BIOBOX,
  LADOS,
  UNIDADES_CON_LADO,
} from '../../lib/constants';
import type { Incidencia, InventarioItem } from '../../types/db';

type Sitio = { site_id: string; direccion: string | null };

type EditModalProps = {
  inc: Incidencia;
  /** Abre la galería de evidencia de esta misma incidencia. */
  onAbrirEvidencia: (i: Incidencia) => void;
  onClose: () => void;
  onDone: (recordId: string, patch: Partial<Incidencia>) => void;
};

function EditModal({ inc, onAbrirEvidencia, onClose, onDone }: EditModalProps) {
  const [observaciones, setObservaciones] = useState(inc.observaciones || '');
  const [lado, setLado] = useState(inc.lado || '');
  const pideLado = UNIDADES_CON_LADO.includes(inc.unidad_negocio || '');

  // --- Sitio ---
  // Arranca con el sitio que ya tiene. Cambiarlo es la razón principal de
  // este modal, así que se muestra siempre, no escondido tras un "cambiar".
  const [siteQuery, setSiteQuery] = useState('');
  const [siteOpts, setSiteOpts] = useState<Sitio[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [sitio, setSitio] = useState<string>(inc.clave_sitio || '');
  const [direccion, setDireccion] = useState<string | null>(inc.direccion);

  // --- Caras del sitio ---
  const [caras, setCaras] = useState<InventarioItem[]>([]);
  const [cara, setCara] = useState<string>(inc.clave_medio || '');
  const [cargandoCaras, setCargandoCaras] = useState(false);

  const [busy, setBusy] = useState(false);

  /** Carga las caras del sitio elegido. */
  const cargarCaras = async (siteId: string, conservarCara: boolean) => {
    if (!siteId) {
      setCaras([]);
      return;
    }
    setCargandoCaras(true);
    const { data } = await sb
      .from('inventario')
      .select(
        'vendor_face_id,cara,tipo_medio,tipo_mueble,direccion,site_legacy_id,municipio,estado'
      )
      .eq('site_id', siteId);
    const filas = (data as InventarioItem[]) || [];
    setCaras(filas);
    setCargandoCaras(false);
    if (!conservarCara) {
      // Sitio nuevo: si trae una sola cara no hay nada que elegir.
      setCara(filas.length === 1 ? filas[0].vendor_face_id : '');
      setDireccion(filas[0]?.direccion ?? null);
    }
  };

  // Caras del sitio actual, al abrir.
  useEffect(() => {
    cargarCaras(inc.clave_sitio || '', true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Buscador de clave, con la misma espera de 250 ms que el alta: sin ella
  // cada tecla dispara una consulta y las respuestas se pisan entre sí.
  useEffect(() => {
    const t = siteQuery.trim();
    // Desde 1 carácter: la búsqueda es por subcadena y la consulta ya viene
    // acotada por unidad de negocio, así que un solo carácter alcanza para
    // empezar a acotar (pedían escribir 2 y estorbaba más de lo que cuidaba).
    if (t.length < 1) {
      setSiteOpts([]);
      return;
    }
    let vivo = true;
    setBuscando(true);
    const timer = setTimeout(async () => {
      // Los espacios se vuelven comodín: la clave real trae guiones bajos
      // (MX_EM_EV_EVA_03_0009) y nadie los escribe — así "eva 03" y hasta
      // "eva 0009" encuentran la cara sin conocer el formato exacto.
      const patron = '%' + t.replace(/\s+/g, '%') + '%';
      const { data } = await sb
        .from('inventario')
        .select('site_id,direccion')
        .eq('unidad_negocio', inc.unidad_negocio || '')
        .ilike('site_id', patron)
        .limit(80);
      if (!vivo) return;
      const vistos = new Set<string>();
      const opts: Sitio[] = [];
      ((data as InventarioItem[]) || []).forEach((r) => {
        if (r.site_id && !vistos.has(r.site_id)) {
          vistos.add(r.site_id);
          opts.push({ site_id: r.site_id, direccion: r.direccion });
        }
      });
      setSiteOpts(opts.slice(0, 12));
      setBuscando(false);
    }, 250);
    return () => {
      vivo = false;
      clearTimeout(timer);
    };
  }, [siteQuery, inc.unidad_negocio]);

  const elegirSitio = async (o: Sitio) => {
    setSitio(o.site_id);
    setDireccion(o.direccion);
    setSiteQuery('');
    setSiteOpts([]);
    await cargarCaras(o.site_id, false);
  };

  const cambioSitio = sitio !== (inc.clave_sitio || '');
  const cambioCara = cara !== (inc.clave_medio || '');

  /**
   * Los campos de ubicación que se copian de `inventario`, exactamente los
   * mismos que NuevaInc escribe al capturar.
   *
   * `medio`, `tipo_mueble` y `nombre_biobox` son de la CARA; `direccion`,
   * `municipio` y `plaza` son del SITIO, así que si no hay cara elegida se
   * toman del primer renglón —cualquiera sirve, en un sitio son iguales—.
   *
   * `latitud` y `longitud` NO se tocan: hoy nada las escribe en `incidencias`
   * y nada las lee (la navegación sale de `inventario`). Ponerlas aquí sería
   * inventar un dato que después alguien creería.
   */
  const derivarUbicacion = (): Partial<Incidencia> => {
    const delSitio = caras[0];
    const laCara = caras.find((c) => c.vendor_face_id === cara) || delSitio;
    const esBiobox = UNIDADES_BIOBOX.includes(inc.unidad_negocio || '');
    return {
      direccion: laCara?.direccion ?? delSitio?.direccion ?? direccion,
      municipio: delSitio?.municipio ?? null,
      // En `inventario` la plaza se llama `estado`. Así lo mapea el alta.
      plaza: delSitio?.estado ?? null,
      medio: laCara?.tipo_medio ?? null,
      tipo_mueble: laCara?.tipo_mueble ?? null,
      nombre_biobox: esBiobox ? laCara?.site_legacy_id || null : null,
    };
  };

  const guardar = async () => {
    if (!sitio) {
      alert('La incidencia tiene que quedar con una clave de sitio.');
      return;
    }
    if (caras.length > 1 && !cara) {
      alert('Este sitio tiene varias caras: elige a cuál corresponde.');
      return;
    }
    setBusy(true);

    const patch: Partial<Incidencia> = {
      observaciones: observaciones.trim() || null,
      clave_sitio: sitio,
      clave_medio: cara || null,
      // Se manda solo donde aplica. En las demás unidades siempre null: si se
      // mandara la cadena vacía, el CHECK de la base la rechazaría.
      lado: pideLado ? lado || null : null,
      // Vuelve a la cola del validador. Si ya estaba ahí, no cambia nada.
      estatus: 'por_validar',
    };
    // Si se movió el sitio o la cara, se rederiva la ubicación completa. Ver
    // la nota de la cabecera: aquí no hay trigger que lo haga por nosotros.
    if (cambioSitio || cambioCara) Object.assign(patch, derivarUbicacion());

    const { data, error } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id)
      .select();
    setBusy(false);

    if (error) {
      alert('No se pudo guardar: ' + error.message);
      return;
    }
    // Sin `error` pero sin filas = la RLS dejó pasar la llamada y no la fila.
    // Pasa si la incidencia ya salió de `por_validar`/`rechazada` mientras
    // este modal estaba abierto: el validador la aprobó en ese rato.
    if (!((data as Incidencia[] | null) || []).length) {
      alert(
        'No se guardó ningún cambio. Lo más probable es que el validador ya ' +
          'haya movido esta incidencia mientras la editabas. Refresca con ↻ y ' +
          'revisa cómo quedó antes de volver a capturar.'
      );
      return;
    }
    onDone(inc.record_id, patch);
  };

  /** ¿Hay cambios sin guardar respecto a lo que trae la incidencia? */
  const hayCambios =
    observaciones !== (inc.observaciones || '') ||
    lado !== (inc.lado || '') ||
    sitio !== (inc.clave_sitio || '') ||
    cara !== (inc.clave_medio || '');

  /**
   * En celular quedan franjas de overlay a los lados del modal: un roce ahí
   * tiraba la corrección a medias sin preguntar. Y mientras guarda, no se
   * cierra.
   */
  const cerrarSeguro = () => {
    if (busy) return;
    if (hayCambios && !confirm('Tienes cambios sin guardar. ¿Descartarlos?'))
      return;
    onClose();
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') cerrarSeguro();
      }}
    >
      <div className="modal">
        <h2 style={{ margin: '0 0 3px' }}>Corregir mi reporte</h2>
        <p className="phint">
          {inc.folio} · {inc.nombre_incidencia}
        </p>

        <div className="banner" style={{ marginBottom: 14 }}>
          Al guardar, la incidencia vuelve a la cola del validador.
          {inc.estatus === 'rechazada' && (
            <>
              <br />
              Está <b>rechazada</b>: con esto se corrige y se manda de nuevo.
            </>
          )}
        </div>

        {inc.estatus === 'rechazada' && inc.motivo_rechazo_reparacion && (
          <div
            className="obs"
            style={{
              background: '#3a1a1a',
              border: '1px solid #5a2a2a',
              borderRadius: 9,
              padding: '9px 11px',
              marginBottom: 12,
              color: '#ffb4b4',
            }}
          >
            Motivo del rechazo: “{inc.motivo_rechazo_reparacion}”
          </div>
        )}

        {/* --- Sitio --- */}
        <div className="field">
          <label>Clave de sitio</label>
          <div
            style={{
              background: 'var(--panel2)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '10px 12px',
              marginBottom: 8,
              fontSize: 14,
            }}
          >
            <b style={{ color: cambioSitio ? 'var(--warn)' : 'var(--txt)' }}>
              {sitio || '—'}
            </b>
            {cambioSitio && (
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                {' '}
                (antes {inc.clave_sitio || '—'})
              </span>
            )}
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>
              {direccion || 'sin dirección'}
            </div>
          </div>
          <input
            placeholder="Buscar otra clave… (ej. eva 03)"
            value={siteQuery}
            onChange={(e) => setSiteQuery(e.target.value)}
          />
          {buscando && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
              Buscando…
            </div>
          )}
          {siteOpts.length > 0 && (
            <div
              style={{
                border: '1px solid var(--line)',
                borderRadius: 10,
                marginTop: 6,
                /* 280 y no 190: cada resultado mide ~62px y con 190 solo se
                   veían 2.5 dentro de un scroll anidado en el del modal. */
                maxHeight: 280,
                overflowY: 'auto',
              }}
            >
              {siteOpts.map((o) => (
                <button
                  key={o.site_id}
                  className="btn ghost"
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    borderRadius: 0,
                    border: 'none',
                  }}
                  onClick={() => elegirSitio(o)}
                >
                  <b>{o.site_id}</b>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {o.direccion || 'sin dirección'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* --- Cara física del inventario ---
            En las unidades con lado y sitio de una sola cara se esconde:
            la cara física es la columna ("COL"), se asigna sola, y la cara
            que el usuario entiende es Norte/Sur/Ambas (el campo de abajo). */}
        {!(pideLado && caras.length <= 1) && (
        <div className="field">
          <label>Cara</label>
          {cargandoCaras ? (
            <div className="loading">Cargando caras…</div>
          ) : caras.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Este sitio no tiene caras en inventario. Se guarda sin cara.
            </div>
          ) : (
            <select value={cara} onChange={(e) => setCara(e.target.value)}>
              <option value="">— Sin cara —</option>
              {caras.map((c) => (
                <option key={c.vendor_face_id} value={c.vendor_face_id}>
                  {caraLabel(c.vendor_face_id)}
                  {c.tipo_medio ? ` · ${c.tipo_medio}` : ''}
                </option>
              ))}
            </select>
          )}
          {cambioCara && (
            <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
              Antes: {caraLabel(inc.clave_medio) || '—'}
            </div>
          )}
        </div>
        )}

        {(cambioSitio || cambioCara) && (
          <div
            style={{
              background: '#3a2e12',
              border: '1px solid #6a5520',
              borderRadius: 10,
              padding: '10px 12px',
              marginBottom: 12,
              fontSize: 13,
              color: '#ffdf9e',
            }}
          >
            ⚠️ Al guardar se actualizan también la dirección, el municipio, la
            plaza y el tipo de medio, para que empaten con la clave nueva.
          </div>
        )}

        {pideLado && (
          <div className="field">
            {/* "Cara afectada" y no "Lado": es como lo nombra quien captura,
                y es el mismo texto que usa el alta (NuevaInc). */}
            <label>Cara afectada</label>
            <select value={lado} onChange={(e) => setLado(e.target.value)}>
              <option value="">— Sin especificar —</option>
              {LADOS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
        )}

        {/* --- Observaciones --- */}
        <div className="field">
          <label>Observaciones</label>
          <textarea
            rows={3}
            value={observaciones}
            onChange={(e) => setObservaciones(e.target.value)}
            placeholder="Lo que viste en campo…"
          />
        </div>

        {/* --- Evidencia: se edita en su propia pantalla --- */}
        <div className="field">
          <label>Evidencia</label>
          {/* NO llama a onClose(). Antes sí lo hacía, y por eso al cerrar la
              ventana de archivos se perdía toda la edición: lo que se cerraba
              no era la galería, era este modal, que se había cerrado desde
              antes. La galería se abre ENCIMA y al cerrarla esto sigue aquí,
              con lo que se llevaba escrito. IncidenciasView monta la
              evidencia después que esta edición justamente para que quede
              arriba. */}
          <button
            className="btn ghost"
            style={{ width: '100%' }}
            onClick={() => onAbrirEvidencia(inc)}
          >
            📎 Abrir evidencia — agregar o quitar fotos
          </button>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            Puedes quitar solo las que tú subiste, y mientras la incidencia no
            esté aprobada.
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={cerrarSeguro}>
            Cancelar
          </button>
          <button className="btn" onClick={guardar} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar y enviar a validar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default EditModal;
