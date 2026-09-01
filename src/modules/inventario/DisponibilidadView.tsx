// ============================================================
// src/modules/inventario/DisponibilidadView.tsx
// Buscador de disponibilidad de caras, para comercial.
//
// LA PREGUNTA QUE RESPONDE, y es UNA sola: "¿puedo vender esta cara, en
// estas fechas?". Deliberadamente NO es un tablero de indicadores. Un
// panorama se ve una vez y se abandona; esto se abre cada que alguien arma
// una propuesta, porque devuelve una respuesta que hace falta en ese momento.
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
import { useState, useEffect, useMemo, useCallback } from 'react';
import { sb } from '../../lib/supabase';

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
        detalle: `Disponible hasta el ${fechaCorta(retiro)}. La catorcena termina el ${fechaCorta(cat.fecha_fin)}.`,
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
      texto: 'Disponible',
      detalle: `Ojo: tiene retiro programado el ${fechaCorta(c.fecha_retiro)}.`,
    };
  }

  return { nivel: 'si', texto: 'Disponible', detalle: '' };
}

const COLOR: Record<Veredicto['nivel'], { bg: string; fg: string }> = {
  si:      { bg: '#12291c', fg: 'var(--ok)' },
  parcial: { bg: '#2e2413', fg: 'var(--warn)' },
  no:      { bg: '#33191a', fg: 'var(--bad)' },
  ocupada: { bg: '#1b2536', fg: 'var(--accent2)' },
};

function DisponibilidadView() {
  const [q, setQ] = useState('');
  const [caras, setCaras] = useState<Cara[]>([]);
  const [cats, setCats] = useState<Catorcena[]>([]);
  const [catSel, setCatSel] = useState<number | ''>('');
  const [pautas, setPautas] = useState<PautaLigera[]>([]);
  const [historial, setHistorial] = useState<Record<string, Movimiento[]>>({});
  const [abierta, setAbierta] = useState<string>('');
  const [buscando, setBuscando] = useState(false);
  const [err, setErr] = useState('');
  const [buscado, setBuscado] = useState(false);

  // Catorcenas desde hoy en adelante: son las que se pueden vender.
  useEffect(() => {
    (async () => {
      const hoy = new Date().toISOString().slice(0, 10);
      const { data, error } = await sb
        .from('catorcenas')
        .select('numero,fecha_inicio,fecha_fin,cat_texto')
        .gte('fecha_fin', hoy)
        .order('numero')
        .limit(12);
      if (error) {
        setErr('No se pudieron cargar las catorcenas: ' + error.message);
        return;
      }
      const lista = (data as Catorcena[]) || [];
      setCats(lista);
      // La primera que sigue viva es la opción por defecto.
      if (lista.length) setCatSel(lista[0].numero);
    })();
  }, []);

  const catActual = useMemo(
    () => cats.find((c) => c.numero === catSel) || null,
    [cats, catSel]
  );

  const buscar = useCallback(async () => {
    const t = q.trim();
    if (t.length < 3) {
      setErr('Escribe al menos 3 caracteres: una clave, parte de una dirección o el nombre del sitio.');
      return;
    }
    setBuscando(true);
    setErr('');
    setAbierta('');

    // Se busca por clave, por clave de sitio, por el nombre legacy y por
    // dirección. Comercial no siempre tiene la clave a la mano; muchas veces
    // solo recuerda la calle.
    const patron = `%${t}%`;
    const { data, error } = await sb
      .from('inventario')
      .select(
        'vendor_face_id,site_id,site_legacy_id,cara,direccion,municipio,estado,unidad_negocio,tipo_medio,tipo_mueble,face_status,fuera_servicio_motivo,fuera_servicio_notas,fecha_retiro'
      )
      .or(
        `vendor_face_id.ilike.${patron},site_id.ilike.${patron},site_legacy_id.ilike.${patron},direccion.ilike.${patron}`
      )
      .order('site_id')
      .order('vendor_face_id')
      .limit(LIMITE);

    if (error) {
      setErr('La búsqueda falló: ' + error.message);
      setBuscando(false);
      return;
    }

    const filas = (data as Cara[]) || [];
    setCaras(filas);
    setBuscado(true);

    // Pautas de esas caras, solo de la catorcena elegida.
    if (filas.length && catSel !== '') {
      const ids = filas.map((f) => f.vendor_face_id);
      const { data: pd } = await sb
        .from('pautas')
        .select('vendor_face_id,catorcena,campana')
        .in('vendor_face_id', ids)
        .eq('catorcena', catSel);
      setPautas((pd as PautaLigera[]) || []);
    } else {
      setPautas([]);
    }
    setBuscando(false);
  }, [q, catSel]);

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

  const resumen = useMemo(() => {
    const r = { si: 0, parcial: 0, no: 0, ocupada: 0 };
    caras.forEach((c) => {
      r[evaluar(c, catActual, porPauta[c.vendor_face_id]).nivel]++;
    });
    return r;
  }, [caras, catActual, porPauta]);

  return (
    <>
      <h2 className="page">Disponibilidad</h2>
      <p className="phint">
        Busca una cara y comprueba si se puede vender en la catorcena que
        elijas. El estatus viene de QTM y se actualiza cada noche.
      </p>

      {err && (
        <div className="err" onClick={() => setErr('')}>
          {err}
        </div>
      )}

      <div className="toolbar">
        <input
          className="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') buscar();
          }}
          placeholder="Clave, sitio o dirección…"
        />
        <select
          value={catSel}
          onChange={(e) =>
            setCatSel(e.target.value === '' ? '' : Number(e.target.value))
          }
          title="Catorcena que se quiere vender"
        >
          {cats.map((c) => (
            <option key={c.numero} value={c.numero}>
              Cat {c.numero} · {fechaCorta(c.fecha_inicio)} a{' '}
              {fechaCorta(c.fecha_fin)}
            </option>
          ))}
        </select>
        <button className="btn" onClick={buscar} disabled={buscando}>
          {buscando ? 'Buscando…' : 'Buscar'}
        </button>
      </div>

      {buscado && !buscando && caras.length === 0 && (
        <div className="empty">
          Sin resultados para «{q}». Prueba con parte de la clave o de la calle.
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
                {resumen.si} disponible{resumen.si === 1 ? '' : 's'}
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
            {caras.length === LIMITE && (
              <span className="tag" title="Acota la búsqueda para verlas todas">
                ⚠️ tope de {LIMITE}: puede haber más
              </span>
            )}
          </div>

          <div className="inc-list">
            {sitios.map(([siteId, lista]) => {
              const primera = lista[0];
              return (
                <div className="inc" key={siteId}>
                  <div style={{ marginBottom: 10 }}>
                    <div className="folio">{siteId}</div>
                    <div className="titulo">
                      {primera.direccion || '(sin dirección)'}
                    </div>
                    <div className="meta">
                      {[primera.municipio, primera.estado, primera.unidad_negocio]
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
                                {c.cara || c.vendor_face_id}
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
                              {open ? 'Ocultar' : '🕓 Historial'}
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
        </>
      )}

      {!buscado && (
        <div className="empty">
          Escribe una clave —<code>MX_CM_EV_3380</code>— o parte de una calle
          para empezar.
        </div>
      )}
    </>
  );
}

export default DisponibilidadView;
