// ============================================================
// src/modules/pauta/AnalistaPauta.tsx
// Pestaña Analista de Pauta y Monitoreo (Erik, 20-oct-2026).
//
// El coordinador manda al analista, por campaña, las fotos de las tomas
// comprobadas (Indicadores → Comprobaciones → "Enviar al analista"). Aquí el
// analista las ve en carpetas campaña → versión, cada una con el nombre
// <vendor_face_id>_<n>, y:
//   · si está bien, la marca "Correcta" (no se edita);
//   · si hay que editarla, la descarga, la edita y sube la editada.
// Cuando no queda ninguna pendiente, el envío queda revisado (lo cierra la
// base y avisa a quien lo mandó) y las descargas de comprobación usan las
// editadas. Todo el envío se puede bajar en un ZIP con las carpetas.
//
// La foto editada no entra a pauta_evidencias (la base no deja agregar
// fotos a una toma comprobada): vive en pauta_envio_fotos y la original se
// conserva.
// ============================================================
import { ArrowLeft, Check, Download, FolderOpen, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sb } from '../../lib/supabase';
import { BUCKET_EVIDENCIAS, CACHE_INMUTABLE } from '../../lib/storage';
import { etiquetaCatorcena } from '../../lib/catorcena';
import { fechaHoraCdmx } from '../../lib/fechasCdmx';
import { cargarNombres, nombreDe, type MapaNombres } from '../../lib/nombres';
import { paraArchivo } from '../../lib/indicadoresPauta';
import {
  carpetasAnalista,
  extension,
  nombreFoto,
  resumenEnvio,
  rutasZip,
  urlVigente,
  type FotoEnvio,
} from '../../lib/analistaPauta';
import { colorTono, fondoTono } from '../../lib/tonos';
import { bajarArchivo } from './descargasPauta';
import Ic from '../../components/Ic';

type Envio = {
  id: number;
  anio: number;
  catorcena: number;
  campana: string;
  enviado_por: string;
  enviado_en: string;
  fotos: number;
  caras: number;
  revisado_en: string | null;
  revisado_por: string | null;
};

type Props = {
  /** Analista (o manager): puede marcar y subir editadas. */
  puedeRevisar: boolean;
  /** Cambia cuando llega un aviso de envío nuevo: recarga la lista. */
  recargarSignal?: number;
};

const CARPETA_EDITADAS = 'pauta-analista';

/** Una descarga o subida a la vez en toda la pestaña. */
let ocupadoModulo = false;

export default function AnalistaPauta({ puedeRevisar, recargarSignal }: Props) {
  const [envios, setEnvios] = useState<Envio[]>([]);
  const [filtro, setFiltro] = useState<'pendientes' | 'revisados'>('pendientes');
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');
  const [abierto, setAbierto] = useState<Envio | null>(null);
  const [nombres, setNombres] = useState<MapaNombres>({});

  useEffect(() => {
    let vivo = true;
    cargarNombres().then((m) => vivo && setNombres(m));
    return () => {
      vivo = false;
    };
  }, []);

  const cargar = useCallback(async () => {
    setErr('');
    const { data, error } = await sb
      .from('pauta_envios_analista')
      .select('*')
      .order('enviado_en', { ascending: false })
      .limit(200);
    if (error) setErr('No se pudieron leer los envíos: ' + error.message);
    else setEnvios((data as Envio[]) || []);
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar, recargarSignal]);

  const pendientes = envios.filter((e) => !e.revisado_en);
  const visibles = filtro === 'pendientes' ? pendientes : envios.filter((e) => !!e.revisado_en);

  if (abierto)
    return (
      <DetalleEnvio
        envio={abierto}
        puedeRevisar={puedeRevisar}
        nombres={nombres}
        onVolver={() => {
          setAbierto(null);
          cargar();
        }}
      />
    );

  return (
    <>
      <div className="toolbar">
        <div className="rt-chips rt-segmento" role="group" aria-label="Envíos">
          {(['pendientes', 'revisados'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={'rt-chip' + (filtro === k ? ' on' : '')}
              aria-pressed={filtro === k}
              onClick={() => setFiltro(k)}
            >
              {k === 'pendientes' ? `Por revisar (${pendientes.length})` : 'Revisados'}
            </button>
          ))}
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      {cargando ? (
        <div className="loading">Leyendo los envíos…</div>
      ) : visibles.length === 0 ? (
        <div className="empty">
          {filtro === 'pendientes'
            ? 'No hay campañas por revisar. Te llega un aviso cuando el coordinador te envíe una.'
            : 'Todavía no hay campañas revisadas.'}
        </div>
      ) : (
        <div className="inc-list">
          {visibles.map((e) => (
            <button
              key={e.id}
              type="button"
              className="inc"
              onClick={() => setAbierto(e)}
              style={{ textAlign: 'left', font: 'inherit', color: 'var(--txt)', cursor: 'pointer', width: '100%' }}
            >
              <div className="folio">
                {etiquetaCatorcena(e.catorcena, e.anio)} · enviado {fechaHoraCdmx(e.enviado_en)} por{' '}
                {nombreDe(nombres, e.enviado_por)}
              </div>
              <div className="titulo">
                <Ic i={FolderOpen} />
                {e.campana}
              </div>
              <div className="meta">
                {e.fotos} {e.fotos === 1 ? 'foto' : 'fotos'} de {e.caras} {e.caras === 1 ? 'cara' : 'caras'}
                {e.revisado_en && ` · revisada ${fechaHoraCdmx(e.revisado_en)} por ${nombreDe(nombres, e.revisado_por || '')}`}
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function DetalleEnvio({
  envio,
  puedeRevisar,
  nombres,
  onVolver,
}: {
  envio: Envio;
  puedeRevisar: boolean;
  nombres: MapaNombres;
  onVolver: () => void;
}) {
  const [fotos, setFotos] = useState<FotoEnvio[]>([]);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');
  const [aviso, setAviso] = useState('');
  /** Qué se está haciendo ahora (id de foto o 'zip'): una cosa a la vez. */
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [revisado, setRevisado] = useState(!!envio.revisado_en);
  // Se prende al montar: con StrictMode (desarrollo) el desmontaje de prueba
  // lo dejaba en false y la pantalla no salía de "procesando".
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const cargar = useCallback(async () => {
    const { data, error } = await sb
      .from('pauta_envio_fotos')
      .select('id,envio_id,campana,version,vendor_face_id,site_id,tipo,original_url,n,estado,editada_url')
      .eq('envio_id', envio.id)
      .order('vendor_face_id')
      .order('n');
    if (!vivo.current) return;
    if (error) setErr('No se pudieron leer las fotos: ' + error.message);
    else setFotos((data as FotoEnvio[]) || []);
    setCargando(false);
  }, [envio.id]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const grupos = useMemo(() => carpetasAnalista(fotos), [fotos]);
  const r = resumenEnvio(fotos);

  /** Corre una tarea con el candado de la pestaña; los errores se muestran. */
  const correr = async (clave: string, fn: () => Promise<void>) => {
    if (ocupadoModulo) {
      setErr('Espera a que termine lo que se está haciendo.');
      return;
    }
    ocupadoModulo = true;
    setErr('');
    setAviso('');
    setTrabajando(clave);
    try {
      await fn();
    } catch (e) {
      if (vivo.current) setErr((e as Error).message || 'No se pudo completar.');
    } finally {
      ocupadoModulo = false;
      if (vivo.current) setTrabajando(null);
    }
  };

  /** Llama a la RPC y aplica el cambio en pantalla. */
  const marcar = async (f: FotoEnvio, estado: 'correcta' | 'editada', path?: string, url?: string) => {
    const { data, error } = await sb.rpc('revisar_foto_analista', {
      p_foto_id: f.id,
      p_estado: estado,
      p_path: path ?? null,
      p_url: url ?? null,
    });
    if (error) throw new Error('No se guardó: ' + error.message);
    if (!vivo.current) return;
    // La liga de la editada la arma la base desde el archivo en Storage.
    const res = data as { pendientes: number; revisado: boolean; url: string | null } | null;
    setFotos((prev) =>
      prev.map((x) =>
        x.id === f.id ? { ...x, estado, editada_url: estado === 'editada' ? res?.url ?? url ?? null : null } : x
      )
    );
    if (res?.revisado && !revisado) {
      setRevisado(true);
      setAviso('Campaña revisada: se avisó al coordinador y las descargas de comprobación ya usan las editadas.');
    }
  };

  const correcta = (f: FotoEnvio) => correr('f' + f.id, () => marcar(f, 'correcta'));

  const todasCorrectas = (fs: FotoEnvio[], clave: string) =>
    correr(clave, async () => {
      for (const f of fs.filter((x) => x.estado === 'pendiente')) await marcar(f, 'correcta');
    });

  const subirEditada = (f: FotoEnvio, archivo: File) =>
    correr('f' + f.id, async () => {
      const ext = (archivo.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${CARPETA_EDITADAS}/${envio.anio}-${envio.catorcena}/${envio.id}/${f.vendor_face_id}_${f.n}_editada_${Date.now()}.${ext}`.replace(
        /[^\w.\-/]/g,
        '_'
      );
      const { error: up } = await sb.storage
        .from(BUCKET_EVIDENCIAS)
        .upload(path, archivo, { upsert: false, cacheControl: CACHE_INMUTABLE });
      if (up) throw new Error('No se pudo subir la editada: ' + up.message);
      const url = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data.publicUrl;
      try {
        await marcar(f, 'editada', path, url);
      } catch (e) {
        // Sin registro, el archivo quedaría huérfano en Storage.
        await sb.storage.from(BUCKET_EVIDENCIAS).remove([path]);
        throw e;
      }
    });

  const bajarUna = (f: FotoEnvio) =>
    correr('d' + f.id, async () => {
      const resp = await fetch(urlVigente(f));
      if (!resp.ok) throw new Error('No se pudo bajar la foto (' + resp.status + ').');
      bajarArchivo(await resp.blob(), nombreFoto(f));
    });

  const bajarZip = () =>
    correr('zip', async () => {
      const { zip } = await import('fflate');
      const lista = rutasZip(grupos);
      const archivos: Record<string, [Uint8Array, { level: 0 }]> = {};
      let i = 0;
      for (const { ruta, foto } of lista) {
        i++;
        if (vivo.current) setAviso(`Bajando fotos ${i} de ${lista.length}…`);
        const resp = await fetch(urlVigente(foto));
        if (!resp.ok) throw new Error(`No se pudo bajar ${nombreFoto(foto)} (${resp.status}).`);
        // Las fotos ya vienen comprimidas: se guardan tal cual (nivel 0).
        archivos[ruta] = [new Uint8Array(await resp.arrayBuffer()), { level: 0 }];
      }
      if (vivo.current) setAviso('Armando el ZIP…');
      const bytes = await new Promise<Uint8Array>((ok, mal) =>
        zip(archivos, (e, d) => (e ? mal(e) : ok(d)))
      );
      bajarArchivo(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
        `${paraArchivo(envio.campana)}_${paraArchivo(etiquetaCatorcena(envio.catorcena, envio.anio))}_envio${envio.id}.zip`
      );
      if (vivo.current) setAviso('');
    });

  const ocupado = !!trabajando;

  return (
    <>
      <div className="toolbar" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn ghost sm" onClick={onVolver} disabled={ocupado}>
          <Ic i={ArrowLeft} />
          Envíos
        </button>
        <button type="button" className="btn ghost sm" onClick={bajarZip} disabled={ocupado || fotos.length === 0}>
          {trabajando === 'zip' && <span className="spinner" />}
          <Ic i={Download} />
          Bajar ZIP con carpetas
        </button>
      </div>
      <h3 style={{ margin: '6px 0 2px' }}>{envio.campana}</h3>
      <p className="phint" style={{ marginTop: 0 }}>
        {etiquetaCatorcena(envio.catorcena, envio.anio)} · enviado {fechaHoraCdmx(envio.enviado_en)} por{' '}
        {nombreDe(nombres, envio.enviado_por)} · {r.total} fotos: {r.pendientes} por revisar, {r.correctas} correctas,{' '}
        {r.editadas} editadas
        {revisado && ' · revisada'}
      </p>
      {!puedeRevisar && (
        <p className="phint">Solo el analista marca las fotos y sube las editadas.</p>
      )}
      {err && <div className="err">{err}</div>}
      {aviso && (
        <div role="status" className="phint">
          {trabajando && <span className="spinner" />}
          {aviso}
        </div>
      )}
      {cargando ? (
        <div className="loading">Leyendo las fotos…</div>
      ) : (
        grupos.map((g) => (
          <section key={g.campana} className="card" style={{ marginBottom: 12 }}>
            {g.versiones.map((v) => {
              const pend = v.fotos.filter((f) => f.estado === 'pendiente').length;
              const clave = 'v' + v.version;
              return (
                <div key={v.version} style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                    <b style={{ flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere' }}>
                      <Ic i={FolderOpen} />
                      {g.campana} / {v.version}
                    </b>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {v.fotos.length} {v.fotos.length === 1 ? 'foto' : 'fotos'}
                    </span>
                    {puedeRevisar && pend > 0 && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={ocupado}
                        onClick={() => todasCorrectas(v.fotos, clave)}
                      >
                        {trabajando === clave && <span className="spinner" />}
                        <Ic i={Check} />
                        Las {pend} por revisar: correctas
                      </button>
                    )}
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                      gap: 10,
                    }}
                  >
                    {v.fotos.map((f) => (
                      <TarjetaFoto
                        key={f.id}
                        f={f}
                        puedeRevisar={puedeRevisar}
                        ocupado={ocupado}
                        trabajando={trabajando}
                        onCorrecta={() => correcta(f)}
                        onBajar={() => bajarUna(f)}
                        onEditada={(a) => subirEditada(f, a)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        ))
      )}
    </>
  );
}

const TONO_ESTADO = { pendiente: 'ambar', correcta: 'verde', editada: 'azul' } as const;
const TXT_ESTADO = { pendiente: 'Por revisar', correcta: 'Correcta', editada: 'Editada' };

function TarjetaFoto({
  f,
  puedeRevisar,
  ocupado,
  trabajando,
  onCorrecta,
  onBajar,
  onEditada,
}: {
  f: FotoEnvio;
  puedeRevisar: boolean;
  ocupado: boolean;
  trabajando: string | null;
  onCorrecta: () => void;
  onBajar: () => void;
  onEditada: (a: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const url = urlVigente(f);
  const esVideo = extension(url, f.tipo) === 'mp4' || f.tipo === 'video';
  const tono = TONO_ESTADO[f.estado];
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 9, overflow: 'hidden', background: 'var(--panel2)' }}>
      <a href={url} target="_blank" rel="noreferrer" style={{ display: 'block', background: 'var(--panel)' }}>
        {esVideo ? (
          <video src={url} preload="metadata" style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }} />
        ) : (
          <img src={url} alt={nombreFoto(f)} loading="lazy" style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }} />
        )}
      </a>
      <div style={{ padding: '7px 8px', display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, overflowWrap: 'anywhere' }}>{nombreFoto(f)}</div>
        <span
          className="pill"
          style={{ justifySelf: 'start', background: fondoTono(tono), color: colorTono(tono) }}
        >
          {TXT_ESTADO[f.estado]}
        </span>
        {f.estado === 'editada' && (
          <a href={f.original_url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
            Ver original
          </a>
        )}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          <button type="button" className="btn ghost sm" disabled={ocupado} onClick={onBajar} title="Descargar con su nombre">
            {trabajando === 'd' + f.id && <span className="spinner" />}
            <Ic i={Download} />
          </button>
          {puedeRevisar && f.estado !== 'correcta' && (
            <button type="button" className="btn ghost sm" disabled={ocupado} onClick={onCorrecta}>
              {trabajando === 'f' + f.id && <span className="spinner" />}
              <Ic i={Check} />
              Correcta
            </button>
          )}
          {puedeRevisar && (
            <>
              <button
                type="button"
                className="btn ghost sm"
                disabled={ocupado}
                onClick={() => input.current?.click()}
                title="Subir la foto editada"
              >
                <Ic i={Upload} />
                {f.estado === 'editada' ? 'Otra editada' : 'Editada'}
              </button>
              <input
                ref={input}
                type="file"
                accept="image/*,video/*"
                hidden
                onChange={(e) => {
                  const a = e.target.files?.[0];
                  e.target.value = '';
                  if (a) onEditada(a);
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
