// ============================================================
// src/modules/rutas/AvanceVisitas.tsx
// Avance de visitas de una ruta por catorcena (rutas, 5-oct-2026).
//
// El monitorista marca la visita desde «Mis rutas» (foto obligatoria, GPS
// si se puede y la hora del teléfono; funciona sin señal con cola) y cae en
// `ruta_visitas`. Aquí el coordinador ve, por catorcena, cuántas paradas
// se visitaron y la ÚLTIMA visita de cada una (si se visitó dos veces,
// cuenta la última): quién, cuándo, la foto y dónde estaba.
//
// Se cuenta por SITIO y no por ruta_id: si un sitio cambió de ruta a media
// catorcena, la visita que ya tenía sigue valiendo para la parada.
// El periodo se mide con `visitado_en` (la hora en que se tocó en campo),
// no con `registrado_en` (la hora en que llegó, que sin señal es después).
// ============================================================
import { CircleCheck, MapPin } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sb } from '../../lib/supabase';
import { tope } from '../../lib/envios';
import { pareceSinRed } from '../../lib/enLinea';
import { urlMiniatura, alFallarMiniatura } from '../../lib/storage';
import { nombreDesdeCorreo } from '../../lib/nombres';
import { metros } from '../../lib/haversine';
import { colorTono, fondoTono } from '../../lib/tonos';
import { vigilarRender } from '../../lib/vigia';
import Ic from '../../components/Ic';
import {
  catorcenaActual,
  direccionElegida,
  inicioDelDia,
  rangoCorto,
  textoFalla,
  traerPaginado,
  trozos,
  TOPE_LECTURA_MS,
  type Catorcena,
  type Resumen,
  type Ubic,
} from './rutasComun';

type Foto = { path?: string; url?: string };
type Visita = {
  id: number;
  site_id: string;
  ruta_id: number | null;
  usuario_email: string;
  visitado_en: string;
  lat: number | null;
  lng: number | null;
  precision_m: number | null;
  fotos: Foto[] | null;
  nota: string | null;
};

const fmtCuando = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export default function AvanceVisitas({ ruta, paradas }: { ruta: Resumen; paradas: Ubic[] }) {
  vigilarRender('AvanceVisitas');
  const [cats, setCats] = useState<Catorcena[]>([]);
  const [catSel, setCatSel] = useState<number | null>(null);
  const [errCats, setErrCats] = useState('');
  const [visitas, setVisitas] = useState<Visita[]>([]);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [visor, setVisor] = useState<{ fotos: string[]; i: number } | null>(null);
  const [intento, setIntento] = useState(0);

  // Solo las paradas vigentes cuentan (una RETIRADA ya no existe).
  const vigentes = useMemo(
    () => paradas.filter((u) => (u.estatus_archivo || '').toUpperCase() !== 'RETIRADA'),
    [paradas]
  );
  const claveSitios = vigentes.map((u) => u.site_id).join('|');

  // Catorcenas (una vez) + nombres de los monitoristas.
  const catsListas = useRef(false);
  useEffect(() => {
    let activo = true;
    (async () => {
      const [c, p] = await Promise.all([
        sb
          .from('catorcenas')
          .select('numero,fecha_inicio,fecha_fin')
          .order('numero', { ascending: false })
          .limit(60)
          .abortSignal(tope(TOPE_LECTURA_MS)),
        sb.rpc('usuarios_asignables').abortSignal(tope(TOPE_LECTURA_MS)),
      ]);
      if (!activo) return;
      if (c.error || c.status === 0) {
        setErrCats(textoFalla(c.error?.message || null, pareceSinRed(c.error, c.status)));
        setCargando(false);
        return;
      }
      const lista = (c.data as Catorcena[] | null) || [];
      const m: Record<string, string> = {};
      ((p.data as { email: string; nombre: string }[] | null) || []).forEach((x) => {
        m[x.email.toLowerCase()] = x.nombre;
      });
      setNombres(m);
      setCats(lista);
      if (!catsListas.current) {
        catsListas.current = true;
        setCatSel(catorcenaActual(lista)?.numero ?? null);
      }
      if (lista.length === 0) setCargando(false);
    })();
    return () => {
      activo = false;
    };
  }, [intento]);

  const cat = cats.find((c) => c.numero === catSel) || null;
  const desdeIso = cat?.fecha_inicio ? inicioDelDia(cat.fecha_inicio)?.toISOString() ?? null : null;
  const hastaIso = (() => {
    const d = cat?.fecha_fin ? inicioDelDia(cat.fecha_fin) : null;
    return d ? new Date(d.getTime() + 86400000).toISOString() : null;
  })();

  // Visitas del periodo (por sitio, en trozos, paginadas).
  useEffect(() => {
    if (!desdeIso || !hastaIso) {
      // Catorcena sin fechas (o aún sin elegir): nada que leer, pero sin
      // dejar el "…" girando para siempre.
      if (catSel != null) setCargando(false);
      return;
    }
    let activo = true;
    setCargando(true);
    setErr('');
    (async () => {
      const ids = claveSitios ? claveSitios.split('|') : [];
      const todas: Visita[] = [];
      for (const t of trozos(ids, 100)) {
        const r = await traerPaginado<Visita>((desde, hasta, senal) =>
          sb
            .from('ruta_visitas')
            .select('id,site_id,ruta_id,usuario_email,visitado_en,lat,lng,precision_m,fotos,nota')
            .in('site_id', t)
            .gte('visitado_en', desdeIso)
            .lt('visitado_en', hastaIso)
            .order('visitado_en', { ascending: false })
            .order('id', { ascending: false })
            .range(desde, hasta)
            .abortSignal(senal)
        );
        if (!activo) return;
        if (r.error) {
          setErr('No se pudieron leer las visitas. ' + textoFalla(r.error, r.sinRed));
          setCargando(false);
          return;
        }
        todas.push(...r.filas);
      }
      if (!activo) return;
      setVisitas(todas);
      setCargando(false);
    })();
    return () => {
      activo = false;
    };
  }, [claveSitios, desdeIso, hastaIso, intento, catSel]);

  /** site_id → su ÚLTIMA visita del periodo. */
  const ultima = useMemo(() => {
    const m = new Map<string, Visita>();
    for (const v of visitas) {
      const a = m.get(v.site_id);
      if (!a || v.visitado_en > a.visitado_en) m.set(v.site_id, v);
    }
    return m;
  }, [visitas]);

  const visitadas = vigentes.filter((u) => ultima.has(u.site_id)).length;
  const pct = vigentes.length ? Math.round((visitadas / vigentes.length) * 100) : 0;
  const quien = (c: string) => nombres[c.toLowerCase()] || nombreDesdeCorreo(c);

  // Visor: Escape cierra.
  useEffect(() => {
    if (!visor) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVisor(null);
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [visor]);

  return (
    <div className="rt-seccion">
      <div className="rt-seccion-tit" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ flex: '1 1 auto' }}><Ic i={CircleCheck} />Avance de visitas</span>
        {cats.length > 0 && (
          <select
            value={catSel ?? ''}
            onChange={(e) => setCatSel(e.target.value === '' ? null : Number(e.target.value))}
            style={{ width: 'auto', fontSize: 13, padding: '6px 8px' }}
            aria-label="Catorcena"
          >
            {cats.map((c) => (
              <option key={c.numero} value={c.numero}>
                Catorcena {c.numero} · {rangoCorto(c)}
              </option>
            ))}
          </select>
        )}
      </div>

      {errCats && (
        <div className="err" style={{ marginBottom: 0 }}>
          No se pudieron leer las catorcenas. {errCats}{' '}
          <button type="button" className="btn sm ghost" onClick={() => setIntento((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}
      {!errCats && cats.length === 0 && !cargando && (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>No hay catorcenas dadas de alta.</div>
      )}

      {cat && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '4px 0 6px' }}>
            <b style={{ fontSize: 18 }}>
              {cargando ? '…' : visitadas} de {vigentes.length}
            </b>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>paradas visitadas en la catorcena {cat.numero}</span>
          </div>
          <div className="rt-barra" aria-hidden="true">
            <div style={{ width: `${cargando ? 0 : pct}%` }} />
          </div>
        </>
      )}

      {err && (
        <div className="err" style={{ marginTop: 8, marginBottom: 0 }}>
          {err}{' '}
          <button type="button" className="btn sm ghost" onClick={() => setIntento((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}

      {cat && (!desdeIso || !hastaIso) && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
          La catorcena {cat.numero} no tiene fechas de inicio y fin: no se puede medir su avance.
        </div>
      )}

      {cat && desdeIso && hastaIso && !cargando && !err && (
        <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
          {vigentes.map((u) => {
            const v = ultima.get(u.site_id);
            const fotos = (v?.fotos || []).map((f) => f.url || '').filter(Boolean);
            const dist =
              v && v.lat != null && v.lng != null && u.latitud != null && u.longitud != null
                ? metros({ lat: v.lat, lng: v.lng }, { lat: Number(u.latitud), lng: Number(u.longitud) })
                : null;
            return (
              <div key={u.ubicacion_id} className="rt-visita">
                <span className="rt-num-neutro">{u.secuencia ?? '—'}</span>
                <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                  <div className="rt-fila-tit">{u.site_id}</div>
                  <div className="rt-fila-sub">{direccionElegida(u) || '(sin dirección)'}</div>
                  {v ? (
                    <div style={{ fontSize: 12, marginTop: 3, lineHeight: 1.5 }}>
                      <span style={{ color: colorTono('verde'), fontWeight: 700 }}>✓ {quien(v.usuario_email)}</span>
                      {' · '}
                      {fmtCuando(v.visitado_en)}
                      {v.lat != null && v.lng != null && (
                        <>
                          {' · '}
                          {/* Solo la distancia al sitio, sin enlace a un mapa
                              externo: la posición del monitorista no sale de
                              la app en una URL. */}
                          <span>
                            <Ic i={MapPin} />
                            {dist != null
                              ? `a ${dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : dist + ' m'} del sitio`
                              : 'con GPS'}
                          </span>
                          {v.precision_m != null && (
                            <span style={{ color: 'var(--muted)' }}> (±{Math.round(v.precision_m)} m)</span>
                          )}
                        </>
                      )}
                      {v.lat == null && <span style={{ color: 'var(--muted)' }}> · sin GPS</span>}
                      {v.nota && <div style={{ color: 'var(--muted)' }}>“{v.nota}”</div>}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, marginTop: 3 }}>
                      <span className="pill" style={{ background: fondoTono('gris'), color: 'var(--muted)' /* --st-gris en oscuro da 3.2:1 (QA, 5-oct-2026) */ }}>
                        Sin visita en esta catorcena
                      </span>
                    </div>
                  )}
                </div>
                {fotos.length > 0 && (
                  <button
                    type="button"
                    className="rt-mini"
                    onClick={() => setVisor({ fotos, i: 0 })}
                    aria-label={`Ver la foto de la visita a ${u.site_id}`}
                  >
                    <img src={urlMiniatura(fotos[0])} onError={alFallarMiniatura(fotos[0])} alt="" loading="lazy" />
                    {fotos.length > 1 && <span className="rt-mini-n">+{fotos.length - 1}</span>}
                  </button>
                )}
              </div>
            );
          })}
          {vigentes.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>La Ruta {ruta.numero} no tiene paradas vigentes.</div>
          )}
        </div>
      )}

      {visor && (
        <div
          className="overlay rt-visor"
          onClick={(e) => {
            if (e.target === e.currentTarget) setVisor(null);
          }}
        >
          <div className="rt-visor-caja">
            <div className="rt-visor-barra">
              <span>
                Foto {visor.i + 1} de {visor.fotos.length}
              </span>
              <a href={visor.fotos[visor.i]} target="_blank" rel="noopener noreferrer" className="btn sm ghost">
                Abrir original
              </a>
              <button type="button" className="btn sm" onClick={() => setVisor(null)} aria-label="Cerrar la foto">
                ✕ Cerrar
              </button>
            </div>
            <img src={visor.fotos[visor.i]} alt="Foto de la visita" />
            {visor.fotos.length > 1 && (
              <div className="rt-visor-barra">
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={visor.i === 0}
                  onClick={() => setVisor({ ...visor, i: visor.i - 1 })}
                >
                  ← Anterior
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={visor.i === visor.fotos.length - 1}
                  onClick={() => setVisor({ ...visor, i: visor.i + 1 })}
                >
                  Siguiente →
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
