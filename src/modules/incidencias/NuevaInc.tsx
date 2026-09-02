// ============================================================
// src/modules/incidencias/NuevaInc.tsx
// Alta de un REPORTE de sitio: se elige el sitio una sola vez y se agregan
// N incidencias, cada una aplicada a las caras que correspondan.
//
// Cada par (incidencia × cara) se convierte en una fila de `incidencias`.
//
// La evidencia va POR PARTIDA, no por reporte: cada falla lleva sus propias
// fotos y se ligan solo a las caras de esa falla. Así, en un sitio con varias
// incidencias, se sabe qué foto corresponde a qué cara.
// ============================================================
import { useState, useEffect, useMemo } from 'react';
import { sb } from '../../lib/supabase';
import {
  UNIDADES,
  NIVEL_COLOR,
  LADOS,
  UNIDADES_CON_LADO,
} from '../../lib/constants';
import { caraLabel, distKm } from '../../lib/helpers';
import {
  catalogoParaMuebles,
  llaveCatalogo,
  filtrarCatalogo,
} from '../../lib/catalogo';
import SubirArchivos from '../../components/SubirArchivos';
import type {
  CatalogoIncidencia,
  IncidenciaNueva,
  InventarioItem,
} from '../../types/db';

/** Preset opcional (la bitácora abre el alta con el sitio ya elegido). */
export type PresetNueva = { un?: string; siteId?: string };

/** Sitio elegido (agregado del inventario por site_id). */
type Sitio = {
  site_id: string;
  direccion?: string | null;
  estado?: string | null;
  municipio?: string | null;
};

/** Opción del buscador "cerca de mí", con su distancia calculada. */
type SitioCercano = {
  site_id: string;
  direccion: string | null;
  dist: number;
};

/**
 * Una partida del reporte: una incidencia del catálogo × N caras, CON SUS
 * PROPIAS FOTOS. Las fotos viajan con la partida para que la evidencia quede
 * ligada solo a las caras que muestra, y no a todas las del sitio.
 */
type Linea = {
  id: number;
  cat: CatalogoIncidencia;
  caras: string[];
  campania: string;
  obs: string;
  files: File[];
};

/**
 * Lo que se entrega al padre: un grupo por partida, con las filas que va a
 * insertar y los archivos que le corresponden. El padre sube cada grupo por
 * separado, así cada foto se liga únicamente a las caras de su partida.
 */
export type GrupoReporte = {
  filas: Partial<IncidenciaNueva>[];
  files: File[];
  /** Caras en formato legible, para nombrar el archivo y la referencia. */
  carasLabel: string;
};

/** Radio de búsqueda geográfica en grados (~6 km). */
const DELTA_GRADOS = 0.06;

type Props = {
  onClose: () => void;
  /** El padre inserta las filas de cada grupo y sube sus archivos. */
  onSave: (grupos: GrupoReporte[]) => Promise<void>;
  preset?: PresetNueva | null;
  /**
   * Unidades que este usuario puede reportar (de sus filas de rol; null =
   * todas). El selector solo ofrece estas: quien reporta únicamente en
   * Ecovallas no tiene por qué capturar en Biobox (Erik, ago-2026).
   */
  unidades?: string[];
};

function NuevaInc({ onClose, onSave, preset, unidades }: Props) {
  const misUnidades = unidades && unidades.length ? unidades : UNIDADES;
  const [un, setUn] = useState(preset?.un || misUnidades[0]);
  const [siteQuery, setSiteQuery] = useState('');
  const [siteOpts, setSiteOpts] = useState<Sitio[]>([]);
  const [site, setSite] = useState<Sitio | null>(null);
  const [caras, setCaras] = useState<InventarioItem[]>([]);
  const [selCaras, setSelCaras] = useState<string[]>([]);
  /** El catálogo TAL CUAL viene de la base, con todas sus copias. */
  const [catCrudo, setCatCrudo] = useState<CatalogoIncidencia[]>([]);
  const [catSel, setCatSel] = useState<CatalogoIncidencia | null>(null);
  const [catBusca, setCatBusca] = useState('');
  /** Lado de la cara. Solo aplica en las unidades de UNIDADES_CON_LADO. */
  const [lado, setLado] = useState('');
  const [campania, setCampania] = useState('');
  const [obs, setObs] = useState('');
  const [nombreBiobox, setNombreBiobox] = useState('');
  // Fotos de la partida que se está editando ahora. Al agregarla al reporte
  // se guardan dentro de la línea y este arreglo se vacía para la siguiente.
  const [filesLinea, setFilesLinea] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingSites, setLoadingSites] = useState(false);
  const [nearOpts, setNearOpts] = useState<SitioCercano[]>([]);
  const [geoBusy, setGeoBusy] = useState(false);
  const [lineas, setLineas] = useState<Linea[]>([]);
  // id de la partida que se está editando. null = se está capturando una nueva.
  // La partida NO se saca de la lista mientras se edita: si el usuario cierra
  // el modal a media edición, no pierde lo que ya había capturado.
  const [editandoId, setEditandoId] = useState<number | null>(null);

  const esBiobox = un.toLowerCase().startsWith('biobox');

  /** Carga las caras del sitio y precarga lo que se deriva de ellas. */
  const pickSite = async (o: Sitio) => {
    setSiteQuery(o.site_id);
    setSiteOpts([]);
    const { data } = await sb
      .from('inventario')
      .select(
        'vendor_face_id,cara,tipo_medio,tipo_mueble,direccion,site_legacy_id,estado,municipio,categoria'
      )
      .eq('site_id', o.site_id);
    const filas = (data as InventarioItem[]) || [];
    const first = filas[0] || ({} as InventarioItem);
    setSite({ ...o, estado: first.estado || null, municipio: first.municipio || null });
    setCaras(filas);
    // Si el sitio tiene una sola cara, se preselecciona: no hay nada que elegir.
    setSelCaras(filas.length === 1 ? [filas[0].vendor_face_id] : []);
    setNearOpts([]);
    const lg = filas.map((c) => c.site_legacy_id).find(Boolean);
    setNombreBiobox(lg || '');
  };

  const buscarCerca = () => {
    if (!navigator.geolocation) {
      alert('Tu dispositivo no permite geolocalización.');
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const d = DELTA_GRADOS;
        // Se acota con un cuadro en la query (barato para Postgres) y luego
        // se ordena por distancia real en el cliente.
        const { data, error } = await sb
          .from('inventario')
          .select('site_id,direccion,latitud,longitud')
          .eq('unidad_negocio', un)
          .gte('latitud', lat - d)
          .lte('latitud', lat + d)
          .gte('longitud', lon - d)
          .lte('longitud', lon + d)
          .limit(600);
        setGeoBusy(false);
        if (error) {
          alert('Error consultando inventario: ' + error.message);
          return;
        }
        const seen = new Set<string>();
        const opts: SitioCercano[] = [];
        ((data as InventarioItem[]) || []).forEach((r) => {
          if (r.site_id && !seen.has(r.site_id) && r.latitud && r.longitud) {
            seen.add(r.site_id);
            opts.push({
              site_id: r.site_id,
              direccion: r.direccion,
              dist: distKm(lat, lon, +r.latitud, +r.longitud),
            });
          }
        });
        opts.sort((a, b) => a.dist - b.dist);
        setSite(null);
        setSiteQuery('');
        setSiteOpts([]);
        setNearOpts(opts.slice(0, 15));
        if (opts.length === 0)
          alert('No hay sitios de esta unidad en ~6 km de tu ubicación.');
      },
      (err) => {
        setGeoBusy(false);
        // El navegador solo da geolocalización en "orígenes seguros". Al
        // entrar por http://IP-de-red el permiso se niega siempre, y el
        // mensaje crudo del navegador no dice qué hacer.
        const inseguro =
          !window.isSecureContext ||
          /secure origin/i.test(err.message || '');
        alert(
          inseguro
            ? 'El GPS solo funciona en conexiones seguras (https:// o localhost).\n\n' +
                'Estás entrando por ' + window.location.protocol + '//' +
                window.location.host + '.\n' +
                'Abre la app con https:// (o desde localhost) y vuelve a intentar.\n\n' +
                'Mientras tanto puedes buscar el sitio por su clave.'
            : 'No se pudo obtener tu ubicación: ' + err.message
        );
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Cambiar de unidad invalida el sitio: las claves no se cruzan entre unidades.
  useEffect(() => {
    setSite(null);
    setSiteQuery('');
    setSiteOpts([]);
    setCaras([]);
    setSelCaras([]);
    setNombreBiobox('');
  }, [un]);

  // Buscador de clave de sitio, con debounce de 250 ms.
  useEffect(() => {
    if (site) return; // ya hay sitio elegido
    if (siteQuery.trim().length < 1) {
      setSiteOpts([]);
      return;
    }
    let active = true;
    setLoadingSites(true);
    const t = setTimeout(async () => {
      // Espacios como comodín, igual que en EditModal: "eva 03" encuentra
      // MX_EM_EV_EVA_03_0009 sin conocer los guiones bajos del formato.
      const patron = '%' + siteQuery.trim().replace(/\s+/g, '%') + '%';
      const { data } = await sb
        .from('inventario')
        .select('site_id,direccion')
        .eq('unidad_negocio', un)
        .ilike('site_id', patron)
        .limit(80);
      if (!active) return; // el usuario ya escribió otra cosa
      const seen = new Set<string>();
      const opts: Sitio[] = [];
      ((data as InventarioItem[]) || []).forEach((r) => {
        if (r.site_id && !seen.has(r.site_id)) {
          seen.add(r.site_id);
          opts.push({ site_id: r.site_id, direccion: r.direccion });
        }
      });
      setSiteOpts(opts.slice(0, 12));
      setLoadingSites(false);
    }, 250);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [siteQuery, un, site]);

  // Catálogo de incidencias por unidad (ilike: la unidad puede venir con
  // mayúsculas distintas entre tablas).
  useEffect(() => {
    let active = true;
    setCatSel(null);
    setCatBusca('');
    setLado('');
    (async () => {
      // ANTES: aquí se colapsaba por `detalle` con un Set y se conservaba LA
      // PRIMERA fila que devolviera Postgres. Como el catálogo repite la
      // misma incidencia con distinta área según el medio, el área con la que
      // nacía el reporte dependía del orden de la consulta — "Arte con
      // grafiti" podía salir a Digital estando en una cara impresa.
      //
      // Ahora se guarda el catálogo COMPLETO y el colapso se hace abajo, ya
      // sabiendo qué caras se marcaron. `select('*')` porque `tipo_medio`
      // puede o no existir en la tabla y pedirla por nombre daría 400.
      const { data } = await sb
        .from('catalogo_incidencias')
        .select('*')
        .ilike('unidad_negocio', un)
        .limit(1000);
      if (!active) return;
      setCatCrudo((data as CatalogoIncidencia[]) || []);
    })();
    return () => {
      active = false;
    };
  }, [un]);

  // Precarga del sitio si el alta vino desde la bitácora.
  useEffect(() => {
    if (!preset?.siteId) return;
    (async () => {
      const { data } = await sb
        .from('inventario')
        .select('site_id,direccion')
        .eq('site_id', preset.siteId)
        .limit(1);
      const fila = ((data as InventarioItem[]) || [])[0];
      await pickSite(
        fila
          ? { site_id: fila.site_id as string, direccion: fila.direccion }
          : { site_id: preset.siteId as string, direccion: '' }
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const limpiarSitio = () => {
    setSite(null);
    setSiteQuery('');
    setCaras([]);
    setSelCaras([]);
  };
  const toggleCara = (vf: string) =>
    setSelCaras((s) => (s.includes(vf) ? s.filter((x) => x !== vf) : [...s, vf]));
  const todas = () =>
    setSelCaras(
      selCaras.length === caras.length ? [] : caras.map((c) => c.vendor_face_id)
    );

  /** Deja el editor en blanco para capturar la siguiente falla del sitio. */
  const limpiarEditor = () => {
    setCatSel(null);
    setSelCaras(caras.length === 1 ? [caras[0].vendor_face_id] : []);
    setCampania('');
    setObs('');
    setFilesLinea([]);
    setEditandoId(null);
  };

  /** Guarda la partida en edición: la agrega, o reemplaza la que se editaba. */
  const guardarPartida = () => {
    if (!catSel) {
      alert('Elige la incidencia del catálogo.');
      return;
    }
    if (selCaras.length === 0) {
      alert('Marca al menos una cara para esta incidencia.');
      return;
    }
    if (filesLinea.length === 0) {
      alert('Adjunta al menos una foto o video de esta incidencia.');
      return;
    }
    const datos = {
      cat: catSel,
      caras: [...selCaras],
      campania,
      obs,
      files: filesLinea,
    };
    if (editandoId != null) {
      // Se reemplaza EN SU POSICIÓN: el orden del reporte no debe cambiar
      // solo porque se corrigió un dato.
      setLineas((prev) =>
        prev.map((l) => (l.id === editandoId ? { ...l, ...datos } : l))
      );
    } else {
      setLineas((prev) => [...prev, { id: Date.now() + Math.random(), ...datos }]);
    }
    limpiarEditor();
  };

  /** Carga una partida ya agregada de vuelta al editor para corregirla. */
  const editarLinea = (l: Linea) => {
    setCatSel(l.cat);
    setSelCaras([...l.caras]);
    setCampania(l.campania);
    setObs(l.obs);
    setFilesLinea([...l.files]);
    setEditandoId(l.id);
  };

  const quitarLinea = (id: number) => {
    setLineas(lineas.filter((l) => l.id !== id));
    // Si se borró justo la que se estaba editando, el editor queda huérfano.
    if (editandoId === id) limpiarEditor();
  };

  /**
   * El catálogo ya colapsado para ESTAS caras.
   *
   * El medio sale de las caras marcadas; si todavía no hay ninguna marcada,
   * del sitio (todas las caras de un sitio suelen compartir medio). Cuando el
   * sitio mezcla impreso y digital y hay caras de los dos marcadas, se deja
   * sin preferencia de medio a propósito: no hay una respuesta correcta, y
   * elegir una al azar sería peor que mostrar las dos entradas del catálogo
   * y dejar que quien captura escoja. Por eso la etiqueta trae el área.
   */
  /**
   * Las opciones que le tocan a las caras marcadas.
   *
   * El mueble sale de las caras marcadas; si todavía no hay ninguna, de todas
   * las del sitio. Se RESTRINGE, no se prefiere: dentro de un mueble cada
   * incidencia existe una sola vez, así que el área ya viene decidida y no
   * hay nada que adivinar. Ver lib/catalogo.ts.
   */
  const cat = useMemo(() => {
    const marcadas = caras.filter((c) => selCaras.includes(c.vendor_face_id));
    const base = marcadas.length ? marcadas : caras;
    return catalogoParaMuebles(
      catCrudo,
      base.map((c) => c.tipo_mueble)
    );
  }, [catCrudo, caras, selCaras]);

  const catOpts = cat.opciones;

  /** Lo que se ve en el desplegable tras aplicar el buscador. */
  const catVisibles = useMemo(() => {
    const base = filtrarCatalogo(catOpts, catBusca);
    // La opción elegida nunca desaparece de la lista: si el buscador la
    // filtrara, el <select> mostraría otra como seleccionada y se guardaría
    // una incidencia distinta de la que se está viendo.
    if (catSel && !base.some((o) => llaveCatalogo(o) === llaveCatalogo(catSel)))
      return [catSel, ...base];
    return base;
  }, [catOpts, catBusca, catSel]);

  /** ¿La partida mezcla muebles? Entonces una misma falla puede ir a dos áreas. */
  const mezclaMuebles = useMemo(() => {
    const marcadas = caras.filter((c) => selCaras.includes(c.vendor_face_id));
    const base = marcadas.length ? marcadas : caras;
    return new Set(base.map((c) => c.tipo_mueble).filter(Boolean)).size > 1;
  }, [caras, selCaras]);

  /** ¿Esta unidad tiene dos caras por estructura? */
  const pideLado = UNIDADES_CON_LADO.includes(un);

  const totalRows = lineas.reduce((s, l) => s + l.caras.length, 0);
  const unaCara = caras.length === 1;
  // Con una sola cara no se usan partidas: la incidencia elegida es el reporte.
  const nGuardar = unaCara ? (catSel ? 1 : 0) : totalRows;
  // Con una sola cara la evidencia se valida aquí; con varias, cada partida
  // ya la exigió al agregarse.
  const faltaEvidencia = unaCara && filesLinea.length === 0;

  const guardar = async () => {
    if (!site) {
      alert('Elige una clave de sitio.');
      return;
    }
    let partidas: Omit<Linea, 'id'>[] = lineas;
    if (unaCara) {
      if (!catSel) {
        alert('Elige la incidencia.');
        return;
      }
      if (filesLinea.length === 0) {
        alert('Adjunta al menos una evidencia (foto o video) para reportar.');
        return;
      }
      partidas = [
        {
          cat: catSel,
          caras: [caras[0].vendor_face_id],
          campania,
          obs,
          files: filesLinea,
        },
      ];
    } else if (lineas.length === 0) {
      alert('Agrega al menos una incidencia al reporte.');
      return;
    } else if (editandoId != null) {
      // Guardar con una edición a medias descartaría silenciosamente los
      // cambios que el usuario ya escribió en el editor.
      alert(
        'Tienes una incidencia abierta en edición.\n\n' +
          'Guarda los cambios o cancela la edición antes de guardar el reporte.'
      );
      return;
    }

    // El lado va con el REPORTE completo, no con cada partida: se captura una
    // vez arriba y baja a todas las filas. Si estuviera por partida habría que
    // repetirlo en cada falla del mismo sitio, que es la forma más rápida de
    // que alguien lo deje mal en la tercera.
    if (pideLado && !lado) {
      alert('En ' + un + ' hay que indicar la cara afectada: Norte, Sur o Ambas.');
      return;
    }

    setBusy(true);
    // Un grupo por partida. Dentro de cada grupo, producto partida × cara →
    // una fila de incidencias por cara, todas compartiendo las mismas fotos.
    const grupos: GrupoReporte[] = partidas.map((l) => ({
      files: l.files,
      carasLabel: l.caras.map(caraLabel).join(', '),
      filas: l.caras.map((vf) => {
        const c =
          caras.find((x) => x.vendor_face_id === vf) || ({} as InventarioItem);
        return {
          unidad_negocio: un,
          clave_sitio: site.site_id,
          direccion: site.direccion,
          municipio: site.municipio || null,
          plaza: site.estado || null,
          clave_medio: vf,
          medio: c.tipo_medio || null,
          tipo_mueble: c.tipo_mueble || null,
          nombre_biobox: esBiobox ? nombreBiobox || null : null,
          nombre_incidencia: l.cat.detalle,
          area_responsable: l.cat.area,
          // impacto del catálogo viene con espacios de sobra.
          nivel: (l.cat.impacto || '').trim(),
          origen: l.cat.origen,
          tipo: l.cat.tipo,
          campania: l.campania || null,
          observaciones: l.obs || null,
          lado: pideLado ? lado : null,
        };
      }),
    }));
    await onSave(grupos);
    setBusy(false);
  };

  /** ¿Hay captura que se perdería al cerrar? */
  const hayCaptura =
    lineas.length > 0 || filesLinea.length > 0 || !!catSel || !!obs.trim();

  /**
   * Cierre con seguro. En celular el overlay deja franjas de unos 8px a los
   * lados del modal: un roce ahí tiraba un reporte con N partidas y fotos
   * tomadas en campo, sin preguntar. Y mientras guarda, no se cierra.
   */
  const cerrarSeguro = () => {
    if (busy) return;
    if (
      hayCaptura &&
      !confirm('Tienes un reporte a medio capturar. ¿Descartarlo?')
    )
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
        <h2 style={{ margin: '0 0 3px' }}>Reporte de incidencias del sitio</h2>
        <p className="phint">
          Elige el sitio una vez y agrega todas las fallas: cada una a las caras
          que apliquen.
        </p>

        <div className="field">
          <label>Unidad de negocio</label>
          <select
            value={un}
            onChange={(e) => setUn(e.target.value)}
            disabled={lineas.length > 0}
          >
            {misUnidades.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>

        <div className="field" style={{ position: 'relative' }}>
          <label>Clave de sitio</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              value={siteQuery}
              onChange={(e) => {
                setSite(null);
                setNearOpts([]);
                setSiteQuery(e.target.value);
              }}
              placeholder="Escribe para buscar (ej. eva 03)…"
              disabled={lineas.length > 0}
              style={{ flex: '1 1 160px', minWidth: 0, width: 'auto' }}
            />
            {site && lineas.length === 0 && (
              <button
                className="btn ghost sm"
                type="button"
                onClick={limpiarSitio}
              >
                ✕
              </button>
            )}
          </div>
          {lineas.length === 0 && !site && (
            <button
              className="btn ghost sm"
              type="button"
              style={{ marginTop: 8 }}
              onClick={buscarCerca}
              disabled={geoBusy}
            >
              {geoBusy ? '📍 Ubicando…' : '📍 Sitios cerca de mí'}
            </button>
          )}
          {loadingSites && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Buscando…
            </div>
          )}
          {siteOpts.length > 0 && !site && (
            <div
              style={{
                position: 'absolute',
                zIndex: 5,
                left: 0,
                right: 0,
                background: 'var(--panel2)',
                border: '1px solid var(--line)',
                borderRadius: 9,
                marginTop: 4,
                maxHeight: 220,
                overflow: 'auto',
              }}
            >
              {siteOpts.map((o) => (
                <div
                  key={o.site_id}
                  onClick={() => pickSite(o)}
                  style={{
                    padding: '9px 11px',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{o.site_id}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {o.direccion}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {nearOpts.length > 0 && !site && (
          <div className="field">
            <label>📍 Sitios cerca de ti ({nearOpts.length})</label>
            <div style={{ display: 'grid', gap: 6, maxHeight: 220, overflow: 'auto' }}>
              {nearOpts.map((o) => (
                <div
                  key={o.site_id}
                  onClick={() => pickSite(o)}
                  style={{
                    background: 'var(--panel2)',
                    border: '1px solid var(--line)',
                    borderRadius: 9,
                    padding: '9px 11px',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                >
                  {/* minWidth:0: sin él, una dirección larga no deja encoger
                      al bloque y estruja la píldora de distancia. */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {o.site_id}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {o.direccion}
                    </div>
                  </div>
                  <span
                    className="pill"
                    style={{
                      background: '#4f8cff22',
                      color: '#4f8cff',
                      alignSelf: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {o.dist < 1
                      ? Math.round(o.dist * 1000) + ' m'
                      : o.dist.toFixed(1) + ' km'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {site && (
          <div className="banner" style={{ marginBottom: 12 }}>
            📍 {site.direccion || '(sin dirección)'}
            <br />
            Municipio: {site.municipio || '—'} · Plaza: {site.estado || '—'} ·{' '}
            {caras.length} caras en este sitio
          </div>
        )}

        {/* El lado (Norte/Sur/Ambas) ya NO se pregunta aquí arriba: se
            pregunta abajo con la etiqueta "Cara afectada", que es como lo
            nombra quien captura (Erik, sep-2026). Sigue siendo UN dato por
            reporte —baja a todas las filas—, solo cambió de lugar. */}

        {site && esBiobox && (
          <div className="field">
            <label>Nombre del Biobox (del inventario)</label>
            <input
              value={nombreBiobox || '(sin nombre en inventario)'}
              readOnly
              style={{ opacity: 0.75, cursor: 'default' }}
            />
          </div>
        )}

        {lineas.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <label>
              Incidencias en el reporte ({lineas.length} · {totalRows} caras en
              total)
            </label>
            <div style={{ display: 'grid', gap: 7 }}>
              {lineas.map((l) => (
                <div
                  key={l.id}
                  style={{
                    background: 'var(--panel2)',
                    // La que se está editando se resalta: si no, no se sabe a
                    // cuál corresponde lo que hay abajo en el editor.
                    border:
                      '1px solid ' +
                      (editandoId === l.id ? 'var(--accent)' : 'var(--line)'),
                    borderRadius: 9,
                    padding: '9px 11px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                >
                  {/* minWidth:0 para que el detalle largo encoja en vez de
                      empujar los botones ✏️ 🗑 fuera de la tarjeta. */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {l.cat.detalle}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--muted)',
                        marginTop: 2,
                      }}
                    >
                      → {l.cat.area} · Nivel {(l.cat.impacto || '').trim()} ·
                      caras: {l.caras.map(caraLabel).join(', ')}
                      <br />
                      <span style={{ color: 'var(--ok)' }}>
                        📎 {l.files.length} archivo
                        {l.files.length > 1 ? 's' : ''} para{' '}
                        {l.caras.length > 1 ? 'estas caras' : 'esta cara'}
                      </span>
                      {editandoId === l.id && (
                        <>
                          {' · '}
                          <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
                            editando abajo
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn ghost sm"
                      title="Editar esta incidencia"
                      onClick={() => editarLinea(l)}
                    >
                      ✏️
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      title="Quitar del reporte"
                      onClick={() => quitarLinea(l.id)}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {site && (
          <div
            style={{
              border: '1px dashed var(--line)',
              borderRadius: 12,
              padding: '12px 12px 4px',
              marginBottom: 14,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>
              {editandoId != null
                ? '✏️ Editando una incidencia del reporte'
                : '➕ Agregar una incidencia'}
            </div>

            <div className="field">
              <label>
                Incidencia (catálogo · {catVisibles.length} de {catOpts.length})
              </label>
              <input
                placeholder="Buscar por incidencia o por área…"
                value={catBusca}
                onChange={(e) => setCatBusca(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <select
                value={catSel ? llaveCatalogo(catSel) : ''}
                onChange={(e) =>
                  setCatSel(
                    catOpts.find((o) => llaveCatalogo(o) === e.target.value) ||
                      null
                  )
                }
              >
                <option value="">— Selecciona —</option>
                {catVisibles.map((o) => (
                  <option key={llaveCatalogo(o)} value={llaveCatalogo(o)}>
                    {o.detalle}
                    {o.area ? ` (${o.area})` : ''}
                  </option>
                ))}
              </select>
              {catBusca && catVisibles.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
                  Nada coincide con “{catBusca}”.
                </div>
              )}
              {cat.sinCatalogo.length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
                  ⚠️ El catálogo no tiene entradas para el mueble{' '}
                  <b>{cat.sinCatalogo.join(', ')}</b>, así que abajo salen
                  TODAS las incidencias y el área no viene decidida. Revisa el
                  área que trae la opción entre paréntesis antes de guardar.
                </div>
              )}
              {mezclaMuebles && cat.restringido && (
                <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
                  ⚠️ Marcaste caras de muebles distintos. Una misma falla puede
                  tocarle a áreas diferentes según el mueble — por eso hay
                  opciones repetidas con distinta área entre paréntesis. Si es
                  el caso, conviene capturarlas como dos partidas.
                </div>
              )}
            </div>

            {catSel && (
              <div className="chips" style={{ marginBottom: 12 }}>
                <span className="tag">
                  Área: <b>{catSel.area || '—'}</b>
                </span>
                <span
                  className="pill"
                  style={{
                    background:
                      (NIVEL_COLOR[(catSel.impacto || '').trim()] || '#555') + '22',
                    color: NIVEL_COLOR[(catSel.impacto || '').trim()] || '#aaa',
                  }}
                >
                  Nivel {(catSel.impacto || '').trim() || '—'}
                </span>
                {/* Origen y tipo (Imponderable…) se derivan y guardan igual,
                    pero ya no se enseñan junto al nivel (Erik, 30-ago-2026). */}
              </div>
            )}

            {caras.length > 1 && (
              <div className="field">
                <label>
                  Caras afectadas ({selCaras.length}/{caras.length}){' '}
                  <button
                    type="button"
                    className="btn ghost sm"
                    style={{ marginLeft: 8 }}
                    onClick={todas}
                  >
                    {selCaras.length === caras.length ? 'Ninguna' : 'Todas'}
                  </button>
                </label>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))',
                    gap: 6,
                    /* 260 y no 150: en 360px el grid queda en 2 columnas y
                       un sitio de 8 caras necesita 4 filas (~180px); con 150
                       la cara buscada quedaba oculta tras un scroll interno
                       anidado dentro del scroll del modal. */
                    maxHeight: 260,
                    overflow: 'auto',
                  }}
                >
                  {caras.map((c) => (
                    <label
                      key={c.vendor_face_id}
                      style={{
                        display: 'flex',
                        gap: 7,
                        alignItems: 'center',
                        background: 'var(--panel)',
                        border:
                          '1px solid ' +
                          (selCaras.includes(c.vendor_face_id)
                            ? 'var(--accent)'
                            : 'var(--line)'),
                        borderRadius: 8,
                        padding: '6px 8px',
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={selCaras.includes(c.vendor_face_id)}
                        onChange={() => toggleCara(c.vendor_face_id)}
                      />
                      <span>
                        <b>{caraLabel(c.vendor_face_id)}</b> ·{' '}
                        {c.categoria || c.tipo_medio}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* En las unidades con lado, la "cara afectada" que entiende el
                que captura es Norte/Sur/Ambas — la cara física del
                inventario es la columna ("COL") y no dice nada. El selector
                escribe `lado` (un dato por reporte, baja a todas las filas)
                y la cara física se asigna sola. */}
            {pideLado && caras.length > 0 && (
              <div className="field">
                <label>Cara afectada</label>
                <select value={lado} onChange={(e) => setLado(e.target.value)}>
                  <option value="">— Selecciona —</option>
                  {LADOS.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                  En {un} la estructura tiene dos caras. Sin esto el técnico
                  llega sin saber a cuál va.
                </div>
              </div>
            )}
            {caras.length === 1 && !pideLado && (
              <div className="field">
                <label>Cara afectada</label>
                <div
                  className="tag"
                  style={{ display: 'inline-block', padding: '6px 10px' }}
                >
                  {caraLabel(caras[0].vendor_face_id)} ·{' '}
                  {caras[0].categoria || caras[0].tipo_medio}
                </div>
              </div>
            )}

            <div className="row2">
              <div className="field">
                <label>Campaña</label>
                <input
                  value={campania}
                  onChange={(e) => setCampania(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Observaciones</label>
                <input value={obs} onChange={(e) => setObs(e.target.value)} />
              </div>
            </div>

            <div className="field">
              <label>
                Evidencia de ESTA incidencia (foto/video) —{' '}
                <span style={{ color: 'var(--accent)' }}>obligatoria</span>
              </label>
              <SubirArchivos
                archivos={filesLinea}
                onFiles={(nuevos) => setFilesLinea((f) => [...f, ...nuevos])}
                onQuitar={(i) =>
                  setFilesLinea((f) => f.filter((_, idx) => idx !== i))
                }
              />
              <div
                style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}
              >
                {filesLinea.length > 0 ? (
                  <>
                    {filesLinea.length} archivo(s) ·{' '}
                    {selCaras.length > 0 ? (
                      <span style={{ color: 'var(--ok)' }}>
                        se ligarán a {selCaras.map(caraLabel).join(', ')}
                      </span>
                    ) : (
                      'marca las caras afectadas'
                    )}
                  </>
                ) : (
                  'Estas fotos quedan ligadas solo a las caras que marques arriba.'
                )}
              </div>
            </div>

            {caras.length > 1 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <button
                  type="button"
                  className={editandoId != null ? 'btn sm' : 'btn ghost sm'}
                  onClick={guardarPartida}
                >
                  {editandoId != null
                    ? '💾 Guardar cambios'
                    : '➕ Agregar esta incidencia al reporte'}
                </button>
                {editandoId != null && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={limpiarEditor}
                  >
                    Cancelar edición
                  </button>
                )}
              </div>
            )}
            {caras.length === 1 && (
              <div
                style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}
              >
                Se agregará automáticamente al guardar.
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          {/* Mismo seguro que el fondo: Cancelar junto a Guardar en un
              teléfono se toca por error, y tira las fotos de campo. */}
          <button className="btn ghost" onClick={cerrarSeguro}>
            Cancelar
          </button>
          <button
            className="btn"
            onClick={guardar}
            disabled={busy || nGuardar === 0 || faltaEvidencia}
          >
            {busy && <span className="spinner" />}
            {busy ? 'Guardando…' : `Guardar reporte (${nGuardar})`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default NuevaInc;
