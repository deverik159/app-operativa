// ============================================================
// src/modules/inventario/DisponibilidadView.tsx
// Módulo «Inventario» (antes «Disponibilidad»; Erik, 19-oct-2026): aquí se
// revisa lo que QTM cuenta, cara por cara. Cada sitio enseña también el
// nombre con que se conoce hoy: la pantalla (nombres_pantallas), la máquina
// Biobox (site_legacy_id) o el pórtico (claveSitio.ts), y se puede buscar
// por él.
//
// LA PREGUNTA QUE RESPONDE: "¿puedo vender esta cara, en estas fechas?".
// Esto se abre cada que alguien arma una propuesta, porque devuelve una
// respuesta que hace falta en ese momento.
//
// Por unidad de negocio (Erik, 13-nov-2026): arriba, una tarjeta por unidad
// con cuántas caras tiene, cuántas activas y cuántas fuera de servicio; se
// filtra por unidad y por estatus, y los resultados salen agrupados por
// unidad. El coordinador con unidad asignada ve solo la suya
// (lib/inventarioUnidades.ts; candado solo de esta pantalla).
//
// El veredicto sale de tres datos que hasta esta semana no existían fuera de
// QTM:
//   · face_status         → si está fuera de servicio HOY
//   · fecha_retiro        → si desaparece durante la catorcena elegida
//   · pautas              → si ya está vendida a alguien más
//
// Y de un cuarto que la app construye sola: el historial de cambios, que
// permite decir "esta ubicación se ha caído tres veces este año" — riesgo
// real para una propuesta larga, invisible en cualquier otro sistema.
// ============================================================
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { sb } from '../../lib/supabase';
import { fondoTono } from '../../lib/tonos';
import { claveCatorcena, etiquetaCatorcena, leerClaveCatorcena } from '../../lib/catorcena';
import { nombrePortico, porticosPorNombre } from '../../lib/claveSitio';
import { patronNombreSinAcentos } from '../../lib/datosLocales';
import { UNIDADES_BIOBOX } from '../../lib/constants';
import {
  COLUMNAS_IDS_ANTERIORES,
  anterioresDe,
  armarIdsAnteriores,
  carasPorIdAnterior,
  type IdAnterior,
  type IdsAnteriores,
} from '../../lib/idsAnteriores';
import {
  GRUPOS_INVENTARIO,
  caraEnGrupos,
  grupoDe,
  gruposVisibles,
  unidadesDe,
  type GrupoInventario,
  type RolInventario,
} from '../../lib/inventarioUnidades';

type Estatus = '' | 'activas' | 'fuera';

/** Conteo de una tarjeta; null mientras carga o si la base no contestó. */
type Conteo = { total: number; activas: number } | null;

const numero = (n: number) => n.toLocaleString('es-MX');

/** Fila de `inventario` con las columnas de estatus. */
type Cara = {
  vendor_face_id: string;
  site_id: string | null;
  site_legacy_id: string | null;
  cara: string | null;
  direccion: string | null;
  municipio: string | null;
  estado: string | null;
  unidad_negocio: string | null;
  tipo_medio: string | null;
  tipo_mueble: string | null;
  face_status: string | null;
  fuera_servicio_motivo: string | null;
  fuera_servicio_notas: string | null;
  fecha_retiro: string | null;
};

type Catorcena = {
  numero: number;
  /** Año del calendario oficial (14-oct-2026): la catorcena es número + año. */
  anio: number;
  fecha_inicio: string;
  fecha_fin: string;
  cat_texto: string | null;
};

type PautaLigera = {
  vendor_face_id: string;
  catorcena: number;
  campana: string | null;
};

type Movimiento = {
  vendor_face_id: string;
  evento: string;
  status_anterior: string | null;
  status_nuevo: string | null;
  notas_nuevas: string | null;
  detectado_en: string;
};

/** Veredicto para una cara en una catorcena concreta. */
type Veredicto = {
  nivel: 'si' | 'parcial' | 'no' | 'ocupada';
  texto: string;
  detalle: string;
};

const LIMITE = 60;

/** El motivo real vive en las notas: QTM deja vacío el campo de motivo. */
function motivoDe(c: Cara): string {
  return (
    (c.fuera_servicio_motivo || '').trim() ||
    (c.fuera_servicio_notas || '').trim() ||
    'sin razón registrada'
  );
}

function fechaCorta(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return `${Number(d)} ${meses[Number(m) - 1]} ${a}`;
}

/**
 * El corazón del módulo.
 *
 * El orden de las comprobaciones NO es arbitrario: primero lo que impide
 * vender del todo, y solo al final lo que la limita. Una cara fuera de
 * servicio y además ya pautada es, ante todo, una cara que no sirve.
 */
function evaluar(
  c: Cara,
  cat: Catorcena | null,
  pautaEncima: PautaLigera | undefined
): Veredicto {
  if ((c.face_status || '') !== 'Active') {
    return {
      nivel: 'no',
      texto: 'Fuera de servicio',
      detalle: motivoDe(c),
    };
  }

  if (cat && c.fecha_retiro) {
    const retiro = c.fecha_retiro.slice(0, 10);
    if (cat.fecha_inicio > retiro) {
      return {
        nivel: 'no',
        texto: 'Retirada antes de esa fecha',
        detalle: `Se retira el ${fechaCorta(retiro)}, antes de que empiece la catorcena.`,
      };
    }
    if (cat.fecha_fin > retiro) {
      return {
        nivel: 'parcial',
        texto: 'Se retira a media catorcena',
        detalle: `Activa hasta el ${fechaCorta(retiro)}. La catorcena termina el ${fechaCorta(cat.fecha_fin)}.`,
      };
    }
  }

  if (pautaEncima) {
    return {
      nivel: 'ocupada',
      texto: 'Ya pautada',
      detalle: pautaEncima.campana || 'campaña sin nombre',
    };
  }

  if (c.fecha_retiro) {
    return {
      nivel: 'si',
      texto: 'Activa',
      detalle: `Ojo: tiene retiro programado el ${fechaCorta(c.fecha_retiro)}.`,
    };
  }

  return { nivel: 'si', texto: 'Activa', detalle: '' };
}

/** Nombre con que se conoce hoy el SITIO: la máquina Biobox o el pórtico. */
function nombreDelSitio(c: Cara): string | null {
  if (UNIDADES_BIOBOX.includes(c.unidad_negocio || '')) {
    return (c.site_legacy_id || '').trim() || null;
  }
  return nombrePortico(c.site_id);
}

// Los fondos eran tintes oscuros escritos a mano: en el tema claro quedaban
// manchas negras bajo texto oscuro. Ahora son el tinte del tono, con su
// pareja clara (tema claro/oscuro, 24-sep-2026). `fg` ya seguía al tema.
const COLOR: Record<Veredicto['nivel'], { bg: string; fg: string }> = {
  si:      { bg: fondoTono('verde'), fg: 'var(--ok)' },
  parcial: { bg: fondoTono('ambar'), fg: 'var(--warn)' },
  no:      { bg: fondoTono('rojo'),  fg: 'var(--bad)' },
  ocupada: { bg: fondoTono('azul'),  fg: 'var(--accent2)' },
};

/** Cuenta caras de una tarjeta (solo el número: no baja filas). */
async function contarGrupo(g: GrupoInventario, soloActivas: boolean): Promise<number | null> {
  let qb = sb
    .from('inventario')
    .select('vendor_face_id', { count: 'exact', head: true })
    .eq('unidad_negocio', g.unidad);
  if (g.medio === 'Digital') qb = qb.eq('tipo_medio', 'Digital');
  else if (g.medio) qb = qb.neq('tipo_medio', 'Digital');
  if (soloActivas) qb = qb.eq('face_status', 'Active');
  const { count, error } = await qb;
  return error ? null : count ?? 0;
}

function DisponibilidadView({ roles }: { roles: readonly RolInventario[] }) {
  /** Tarjetas que ve este usuario; el coordinador con unidad, solo la suya. */
  const visibles = useMemo(() => gruposVisibles(roles), [roles]);
  /** '' = todas las visibles. */
  const [grupoSel, setGrupoSel] = useState('');
  const [estatusSel, setEstatusSel] = useState<Estatus>('');
  const [conteos, setConteos] = useState<Record<string, Conteo>>({});
  const [q, setQ] = useState('');
  const [caras, setCaras] = useState<Cara[]>([]);
  const [cats, setCats] = useState<Catorcena[]>([]);
  /** Llave "2026-21" (lib/catorcena.ts), o '' sin elegir. */
  const [catSel, setCatSel] = useState<string>('');
  const [pautas, setPautas] = useState<PautaLigera[]>([]);
  const [historial, setHistorial] = useState<Record<string, Movimiento[]>>({});
  /** Nombre de pantalla por cara (solo Ecovallas digital lo tiene). */
  const [nombrePantalla, setNombrePantalla] = useState<Record<string, string>>({});
  const [abierta, setAbierta] = useState<string>('');
  const [buscando, setBuscando] = useState(false);
  const [err, setErr] = useState('');
  const [buscado, setBuscado] = useState(false);
  /** Cuántas caras trae la búsqueda en total (para «Ver más»). */
  const [total, setTotal] = useState<number | null>(null);
  /** La búsqueda hecha y cuántas filas se han traído de ella. */
  const ultimaRef = useRef<{ t: string; grupo: string; estatus: Estatus; leidas: number } | null>(null);
  /** IDs viejos de máquinas Biobox (3-nov-2026). Si no contestan, se busca sin ellos. */
  const [idsAnteriores, setIdsAnteriores] = useState<IdsAnteriores>(new Map());

  useEffect(() => {
    void sb
      .from('inventario_ids_anteriores')
      .select(COLUMNAS_IDS_ANTERIORES)
      .limit(1000)
      .then(({ data }) => setIdsAnteriores(armarIdsAnteriores(data as IdAnterior[] | null)));
  }, []);

  // Indicadores de cada tarjeta: dos conteos por unidad, sin bajar filas.
  useEffect(() => {
    let vivo = true;
    setConteos({});
    visibles.forEach(async (g) => {
      const [total, activas] = await Promise.all([contarGrupo(g, false), contarGrupo(g, true)]);
      if (!vivo) return;
      setConteos((c) => ({
        ...c,
        [g.clave]: total === null || activas === null ? null : { total, activas },
      }));
    });
    return () => {
      vivo = false;
    };
  }, [visibles]);

  // Catorcenas desde hoy en adelante: son las que se pueden vender.
  useEffect(() => {
    (async () => {
      const hoy = new Date().toISOString().slice(0, 10);
      const { data, error } = await sb
        .from('catorcenas')
        .select('numero,anio,fecha_inicio,fecha_fin,cat_texto')
        .gte('fecha_fin', hoy)
        // Por fecha (14-oct-2026): por número, con 2027 cargado, la primera
        // opción en octubre habría sido la Cat-1 de 2027.
        .order('fecha_inicio')
        .limit(12);
      if (error) {
        setErr('No se pudieron cargar las catorcenas: ' + error.message);
        return;
      }
      const lista = (data as Catorcena[]) || [];
      setCats(lista);
      // La primera que sigue viva es la opción por defecto.
      if (lista.length) setCatSel(claveCatorcena(lista[0].anio, lista[0].numero));
    })();
  }, []);

  const catActual = useMemo(
    () => cats.find((c) => claveCatorcena(c.anio, c.numero) === catSel) || null,
    [cats, catSel]
  );

  /**
   * Busca con el texto y los filtros. `cambio` trae el filtro que se acaba de
   * tocar (el estado aún no se actualiza en ese render): tocar un filtro sin
   * texto no regaña.
   */
  const buscar = useCallback(async (cambio?: { grupo?: string; estatus?: Estatus }, mas = false) => {
    // «Ver más» (Erik, 13-nov-2026) sigue la búsqueda que se hizo, aunque el
    // cuadro de texto ya diga otra cosa: trae la siguiente tanda y la suma.
    const u = mas ? ultimaRef.current : null;
    if (mas && !u) return;
    const grupo = u ? u.grupo : cambio?.grupo ?? grupoSel;
    const estatus = u ? u.estatus : cambio?.estatus ?? estatusSel;
    const t = u ? u.t : q.trim();
    const desde = u ? u.leidas : 0;
    const sinTexto = t.length < 3;
    if (!visibles.length) return;
    // Sin texto se lista si hay una tarjeta elegida (su inventario, con el
    // estatus que esté marcado; Erik, 13-nov-2026) o «Fuera de servicio».
    if (!mas && sinTexto && !grupo && estatus !== 'fuera') {
      if (!cambio) {
        setErr('Escribe al menos 3 caracteres: una clave, parte de una dirección o el nombre del sitio.');
      } else if (buscado) {
        // Se quitó la tarjeta o «Fuera de servicio» sin texto: la lista anterior ya no aplica.
        setCaras([]);
        setBuscado(false);
        setTotal(null);
        ultimaRef.current = null;
      }
      return;
    }
    setBuscando(true);
    setErr('');
    if (!mas) setAbierta('');
    const enFiltro = grupo ? visibles.filter((g) => g.clave === grupo) : visibles;

    // Se busca por clave, por clave de sitio, por el nombre legacy (el de la
    // máquina en Biobox), por dirección y por el nombre con que se conoce
    // hoy la pantalla o el pórtico. Comercial no siempre tiene la clave a la
    // mano; muchas veces solo recuerda la calle o el nombre.
    let qb = sb
      .from('inventario')
      .select(
        'vendor_face_id,site_id,site_legacy_id,cara,direccion,municipio,estado,unidad_negocio,tipo_medio,tipo_mueble,face_status,fuera_servicio_motivo,fuera_servicio_notas,fecha_retiro',
        { count: 'exact' }
      );
    if (!sinTexto) {
      const patron = `%${t}%`;
      const { data: np } = await sb
        .from('nombres_pantallas')
        .select('vendor_face_id')
        .filter('nombre', 'imatch', patronNombreSinAcentos(t))
        .limit(50);
      const idsPorNombre = ((np as { vendor_face_id: string }[]) || []).map((x) =>
        JSON.stringify(x.vendor_face_id)
      );
      const porNombre = idsPorNombre.length
        ? [`vendor_face_id.in.(${idsPorNombre.join(',')})`]
        : [];
      const porPortico = porticosPorNombre(t).map((n) => `site_id.ilike.%_POR_${n}`);
      // ID viejo de una máquina Biobox: «IID_0002» encuentra MX_EM_BB_UCL_0007.
      const viejas = carasPorIdAnterior(idsAnteriores, t).map((v) => JSON.stringify(v));
      const porIdAnterior = viejas.length ? [`vendor_face_id.in.(${viejas.join(',')})`] : [];
      qb = qb.or(
        [
          `vendor_face_id.ilike.${patron}`,
          `site_id.ilike.${patron}`,
          `site_legacy_id.ilike.${patron}`,
          `direccion.ilike.${patron}`,
          ...porNombre,
          ...porPortico,
          ...porIdAnterior,
        ].join(',')
      );
    }
    // Unidad: la base ya acota por unidad_negocio; el medio de Ecovallas
    // (Impreso / Digital) solo cuando se eligió una de esas dos tarjetas. Lo
    // demás lo termina de filtrar caraEnGrupos abajo.
    qb = qb.in('unidad_negocio', unidadesDe(enFiltro));
    if (enFiltro.length === 1 && enFiltro[0].medio === 'Digital') qb = qb.eq('tipo_medio', 'Digital');
    else if (enFiltro.length === 1 && enFiltro[0].medio) qb = qb.neq('tipo_medio', 'Digital');
    if (estatus === 'activas') qb = qb.eq('face_status', 'Active');
    if (estatus === 'fuera') qb = qb.neq('face_status', 'Active');
    const { data, error, count } = await qb
      .order('site_id')
      .order('vendor_face_id')
      .range(desde, desde + LIMITE - 1);

    if (error) {
      setErr('La búsqueda falló: ' + error.message);
      setBuscando(false);
      return;
    }

    const leidas = (data as Cara[]) || [];
    ultimaRef.current = { t, grupo, estatus, leidas: desde + leidas.length };
    setTotal(count ?? null);
    const filas = leidas.filter((c) => caraEnGrupos(c, enFiltro));

    // Nombres de pantalla de las caras encontradas. Si no contestan, se
    // enseña la cara como antes: el nombre es ayuda, no requisito.
    const eco = filas.filter((f) => f.unidad_negocio === 'Ecovallas').map((f) => f.vendor_face_id);
    const nombres: Record<string, string> = {};
    if (eco.length) {
      const { data: nd } = await sb
        .from('nombres_pantallas')
        .select('vendor_face_id,nombre')
        .in('vendor_face_id', eco);
      ((nd as { vendor_face_id: string; nombre: string }[]) || []).forEach((x) => {
        if (x.nombre?.trim()) nombres[x.vendor_face_id] = x.nombre.trim();
      });
    }
    setNombrePantalla((n) => (mas ? { ...n, ...nombres } : nombres));
    setCaras((c) => {
      if (!mas) return filas;
      const ya = new Set(c.map((x) => x.vendor_face_id));
      return [...c, ...filas.filter((f) => !ya.has(f.vendor_face_id))];
    });
    setBuscado(true);

    // Pautas de esas caras, solo de la catorcena elegida.
    const sel = leerClaveCatorcena(catSel);
    if (filas.length && sel) {
      const ids = filas.map((f) => f.vendor_face_id);
      const { data: pd } = await sb
        .from('pautas')
        .select('vendor_face_id,catorcena,campana')
        .in('vendor_face_id', ids)
        .eq('anio', sel.anio)
        .eq('catorcena', sel.numero);
      const nuevas = (pd as PautaLigera[]) || [];
      setPautas((p) => (mas ? [...p, ...nuevas] : nuevas));
    } else if (!mas) {
      setPautas([]);
    }
    setBuscando(false);
  }, [q, catSel, idsAnteriores, grupoSel, estatusSel, visibles, buscado]);

  /** Cuántas filas de la búsqueda faltan por traer (0 si no se sabe). */
  const faltan =
    total !== null && ultimaRef.current ? Math.max(0, total - ultimaRef.current.leidas) : 0;

  const elegirGrupo = (clave: string) => {
    const nuevo = grupoSel === clave ? '' : clave;
    setGrupoSel(nuevo);
    void buscar({ grupo: nuevo });
  };
  const elegirEstatus = (e: Estatus) => {
    setEstatusSel(e);
    void buscar({ estatus: e });
  };

  /** Historial de una cara. Se pide al abrirla, no antes. */
  const abrir = async (vfid: string) => {
    if (abierta === vfid) {
      setAbierta('');
      return;
    }
    setAbierta(vfid);
    if (historial[vfid]) return;
    const { data } = await sb
      .from('inventario_estatus_historial')
      .select('vendor_face_id,evento,status_anterior,status_nuevo,notas_nuevas,detectado_en')
      .eq('vendor_face_id', vfid)
      .order('detectado_en', { ascending: false })
      .limit(12);
    setHistorial((h) => ({ ...h, [vfid]: (data as Movimiento[]) || [] }));
  };

  const porPauta = useMemo(() => {
    const m: Record<string, PautaLigera> = {};
    pautas.forEach((p) => {
      m[p.vendor_face_id] = p;
    });
    return m;
  }, [pautas]);

  /**
   * Se agrupa por SITIO, no por cara.
   *
   * Es la lección de los datos: cuando una ubicación se cae, se caen TODAS
   * sus caras a la vez. El sitio 3353 tenía siete caras abajo con seis
   * campañas encima. Listar cara por cara esconde ese patrón; agrupar por
   * sitio lo hace obvio de un vistazo.
   */
  const sitios = useMemo(() => {
    const m = new Map<string, Cara[]>();
    caras.forEach((c) => {
      const k = c.site_id || c.vendor_face_id;
      const arr = m.get(k) || [];
      arr.push(c);
      m.set(k, arr);
    });
    return [...m.entries()];
  }, [caras]);

  /** Los sitios, partidos por unidad, en el orden de las tarjetas. */
  const porUnidad = useMemo(() => {
    const m = new Map<string, { g: GrupoInventario; sitios: [string, Cara[]][]; caras: number }>();
    sitios.forEach(([k, lista]) => {
      const g = grupoDe(lista[0]);
      const e = m.get(g.clave) || { g, sitios: [], caras: 0 };
      e.sitios.push([k, lista]);
      e.caras += lista.length;
      m.set(g.clave, e);
    });
    const orden = (clave: string) => {
      const i = visibles.findIndex((g) => g.clave === clave);
      return i < 0 ? visibles.length : i;
    };
    return [...m.values()].sort((a, b) => orden(a.g.clave) - orden(b.g.clave));
  }, [sitios, visibles]);

  const resumen = useMemo(() => {
    const r = { si: 0, parcial: 0, no: 0, ocupada: 0 };
    caras.forEach((c) => {
      r[evaluar(c, catActual, porPauta[c.vendor_face_id]).nivel]++;
    });
    return r;
  }, [caras, catActual, porPauta]);

  return (
    <>
      <h2 className="page">Inventario</h2>
      <p className="phint">
        Busca una cara o sitio y comprueba si está activa. El estatus viene de
        QTM y se actualiza cada noche.
        {visibles.length > 0 && visibles.length < GRUPOS_INVENTARIO.length && (
          <> Ves el inventario de {visibles.map((g) => g.titulo).join(' y ')}.</>
        )}
      </p>

      {err && (
        <div className="err" onClick={() => setErr('')}>
          {err}
        </div>
      )}

      {visibles.length === 0 && (
        <div className="empty">
          Tu rol de coordinador no tiene una unidad con inventario de QTM. Si
          debería verla, pide que revisen la unidad de tu rol.
        </div>
      )}

      {visibles.length > 0 && (
      <>
      {/* Una tarjeta por unidad: tocarla filtra por esa unidad. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
          gap: 9,
          margin: '4px 0 12px',
        }}
      >
        {visibles.map((g) => {
          const c = conteos[g.clave];
          const activo = grupoSel === g.clave;
          return (
            <button
              key={g.clave}
              type="button"
              className="card"
              aria-pressed={activo}
              onClick={() => elegirGrupo(g.clave)}
              title={activo ? 'Quitar el filtro de unidad' : `Ver solo ${g.titulo}`}
              style={{
                minWidth: 0,
                textAlign: 'left',
                cursor: 'pointer',
                font: 'inherit',
                color: 'inherit',
                borderColor: activo ? 'var(--accent)' : undefined,
              }}
            >
              <div className="l" style={{ fontWeight: 700 }}>{g.titulo}</div>
              <div className="n">{c ? numero(c.total) : c === null ? '?' : '–'}</div>
              <div className="l">caras</div>
              {c && (
                <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.4 }}>
                  <span style={{ color: 'var(--ok)' }}>{numero(c.activas)} activas</span>
                  {c.total - c.activas > 0 && (
                    <>
                      {' · '}
                      <span style={{ color: 'var(--bad)' }}>
                        {numero(c.total - c.activas)} fuera
                      </span>
                    </>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="chips" style={{ marginTop: 0, marginBottom: 10 }}>
        {(
          [
            ['', 'Todas'],
            ['activas', 'Activas'],
            ['fuera', 'Fuera de servicio'],
          ] as [Estatus, string][]
        ).map(([e, t]) => (
          <button
            key={e || 'todas'}
            type="button"
            className="btn ghost sm"
            aria-pressed={estatusSel === e}
            onClick={() => elegirEstatus(e)}
            style={{
              borderColor: estatusSel === e ? 'var(--accent)' : undefined,
              fontWeight: estatusSel === e ? 700 : undefined,
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="toolbar">
        <input
          className="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') buscar();
          }}
          placeholder="Clave, nombre o dirección…"
        />
        <select
          value={catSel}
          onChange={(e) => setCatSel(e.target.value)}
          title="Catorcena que se quiere vender"
        >
          {cats.map((c) => (
            <option key={claveCatorcena(c.anio, c.numero)} value={claveCatorcena(c.anio, c.numero)}>
              {etiquetaCatorcena(c.numero, c.anio)} · {fechaCorta(c.fecha_inicio)} a{' '}
              {fechaCorta(c.fecha_fin)}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => buscar()} disabled={buscando}>
          {buscando ? 'Buscando…' : 'Buscar'}
        </button>
      </div>
      </>
      )}

      {buscado && !buscando && caras.length === 0 && (
        <div className="empty">
          {q.trim().length >= 3
            ? `Sin resultados para «${q.trim()}» con estos filtros. Prueba con parte de la clave o de la calle, o quita un filtro.`
            : 'No hay caras con estos filtros.'}
        </div>
      )}

      {caras.length > 0 && (
        <>
          <div className="chips" style={{ marginBottom: 14 }}>
            <span className="tag">
              {caras.length} cara{caras.length === 1 ? '' : 's'} en{' '}
              {sitios.length} sitio{sitios.length === 1 ? '' : 's'}
            </span>
            {resumen.si > 0 && (
              <span className="tag" style={{ color: 'var(--ok)' }}>
                {resumen.si} activa{resumen.si === 1 ? '' : 's'}
              </span>
            )}
            {resumen.ocupada > 0 && (
              <span className="tag" style={{ color: 'var(--accent2)' }}>
                {resumen.ocupada} ya pautada{resumen.ocupada === 1 ? '' : 's'}
              </span>
            )}
            {resumen.parcial > 0 && (
              <span className="tag" style={{ color: 'var(--warn)' }}>
                {resumen.parcial} parcial{resumen.parcial === 1 ? '' : 'es'}
              </span>
            )}
            {resumen.no > 0 && (
              <span className="tag" style={{ color: 'var(--bad)' }}>
                {resumen.no} no vendible{resumen.no === 1 ? '' : 's'}
              </span>
            )}
            {faltan > 0 && total !== null && (
              <span className="tag" title="Abajo está «Ver más»">
                viendo {numero(caras.length)} de {numero(total)}
              </span>
            )}
          </div>

          {porUnidad.map(({ g, sitios: deUnidad, caras: nCaras }) => (
          <section key={g.clave} style={{ marginBottom: 18 }}>
          <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>
            {g.titulo}{' '}
            <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 13 }}>
              · {numero(nCaras)} cara{nCaras === 1 ? '' : 's'} en {numero(deUnidad.length)} sitio
              {deUnidad.length === 1 ? '' : 's'}
            </span>
          </h3>
          <div className="inc-list agrupada">
            {deUnidad.map(([siteId, lista]) => {
              const primera = lista[0];
              const nombre = nombreDelSitio(primera);
              const antes = [...new Set(lista.flatMap((c) => anterioresDe(idsAnteriores, c.vendor_face_id)))];
              return (
                <div className="inc" key={siteId}>
                  <div style={{ marginBottom: 10 }}>
                    <div className="folio">{siteId}</div>
                    {antes.length > 0 && (
                      <div className="meta" title="ID con que se conocía antes esta máquina">
                        Antes: {antes.join(', ')}
                      </div>
                    )}
                    <div className="titulo">
                      {nombre || primera.direccion || '(sin dirección)'}
                    </div>
                    <div className="meta">
                      {[
                        nombre ? primera.direccion : null,
                        primera.municipio,
                        primera.estado,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      {lista.length > 1 && ` · ${lista.length} caras`}
                    </div>
                  </div>

                  <div style={{ display: 'grid', gap: 8 }}>
                    {lista.map((c) => {
                      const v = evaluar(c, catActual, porPauta[c.vendor_face_id]);
                      const col = COLOR[v.nivel];
                      const open = abierta === c.vendor_face_id;
                      const movs = historial[c.vendor_face_id];
                      return (
                        <div
                          key={c.vendor_face_id}
                          style={{
                            border: '1px solid var(--line)',
                            borderLeft: `3px solid ${col.fg}`,
                            borderRadius: 8,
                            padding: '10px 12px',
                            background: 'var(--panel2)',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: 10,
                              alignItems: 'baseline',
                            }}
                          >
                            <div style={{ flex: '1 1 190px', minWidth: 0 }}>
                              <div style={{ fontWeight: 700, fontSize: 13 }}>
                                {nombrePantalla[c.vendor_face_id] || c.cara || c.vendor_face_id}
                              </div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: 'var(--muted)',
                                  overflowWrap: 'anywhere',
                                }}
                              >
                                {c.vendor_face_id}
                                {c.tipo_medio ? ` · ${c.tipo_medio}` : ''}
                                {c.tipo_mueble ? ` · ${c.tipo_mueble}` : ''}
                              </div>
                            </div>

                            {/* multilinea: es el único .pill con frase
                                ("Se retira a media catorcena"); en nowrap
                                acaparaba un renglón entero en celular. */}
                            <span
                              className="pill multilinea"
                              style={{ background: col.bg, color: col.fg }}
                            >
                              {v.texto}
                            </span>

                            <button
                              className="btn ghost sm"
                              onClick={() => abrir(c.vendor_face_id)}
                              title="Ver cómo ha cambiado su estatus"
                            >
                              {open ? 'Ocultar' : 'Historial'}
                            </button>
                          </div>

                          {v.detalle && (
                            <div
                              style={{
                                fontSize: 12,
                                color: 'var(--muted)',
                                marginTop: 6,
                              }}
                            >
                              {v.detalle}
                            </div>
                          )}

                          {open && (
                            <div
                              style={{
                                marginTop: 10,
                                paddingTop: 10,
                                borderTop: '1px solid var(--line)',
                              }}
                            >
                              {!movs ? (
                                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                                  Cargando…
                                </div>
                              ) : movs.length === 0 ? (
                                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                                  Sin movimientos registrados. El historial
                                  empezó a guardarse el 25 de agosto de 2026:
                                  antes de esa fecha no hay datos.
                                </div>
                              ) : (
                                <div style={{ display: 'grid', gap: 6 }}>
                                  {movs.map((m, i) => (
                                    <div
                                      key={i}
                                      style={{ fontSize: 12, lineHeight: 1.45 }}
                                    >
                                      <span style={{ color: 'var(--muted)' }}>
                                        {fechaCorta(m.detectado_en)}
                                      </span>{' '}
                                      ·{' '}
                                      {m.status_anterior && m.status_nuevo &&
                                      m.status_anterior !== m.status_nuevo ? (
                                        <>
                                          {m.status_anterior} →{' '}
                                          <b>{m.status_nuevo}</b>
                                        </>
                                      ) : (
                                        <b>{m.status_nuevo || m.evento}</b>
                                      )}
                                      {m.notas_nuevas && (
                                        <span style={{ color: 'var(--muted)' }}>
                                          {' '}
                                          — {m.notas_nuevas}
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          </section>
          ))}

          {faltan > 0 && (
            <div style={{ textAlign: 'center', margin: '4px 0 18px' }}>
              <button
                type="button"
                className="btn ghost"
                disabled={buscando}
                onClick={() => buscar(undefined, true)}
              >
                {buscando
                  ? 'Cargando…'
                  : `Ver ${numero(Math.min(faltan, LIMITE))} más (faltan ${numero(faltan)})`}
              </button>
            </div>
          )}
        </>
      )}

      {!buscado && visibles.length > 0 && (
        <div className="empty">
          Escribe una clave —<code>MX_CM_EV_3380</code>—, parte de una calle o
          el nombre de una pantalla, máquina o pórtico. O toca una tarjeta para
          ver el inventario de esa unidad, o «Fuera de servicio» para ver lo
          que no se puede vender.
        </div>
      )}
    </>
  );
}

export default DisponibilidadView;
