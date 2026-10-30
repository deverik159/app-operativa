// ============================================================
// src/modules/comprobaciones/RevisionCampana.tsx
// Revisión de tomas DENTRO de una campaña de «Mis campañas» (fase 3,
// incremento 3; 29-oct-2026; spec §6.2, decisión 3 de Erik del 26-oct:
// sin pestaña nueva). Lo abre DetalleCampana con «Fotos».
//
// Arriba, las bandejas (Por revisar · Devueltas · Comprobadas · Por
// capturar · Todas) con su conteo y el filtro de días. Debajo, los sitios
// con tomas en esa bandeja; al abrir un sitio (no antes: una versión de Vía
// Verde trae hasta 50 columnas) se leen sus fotos y salen sus tomas por día
// (BloqueTomaComp).
//
// «Por capturar» solo sale en campañas con parte de cámara (modo cámaras o
// mixto): tomas de hoy o antes, sin comprobar, a las que les falta una
// captura. Para contarlas sin bajar todas las fotos se leen solo las
// capturas de esas tomas (leerCapturasTomas).
//
// Quién puede qué lo decide la base (comp_puede_revisar, comp_puede_capturar);
// aquí solo se esconden botones: la analista de la campaña y quien la
// gestiona ven las acciones, y si la base dice que no, se enseña la razón.
// Después de cada escritura se relee (la RLS niega en silencio) y el detalle
// relee sus sitios (el crédito pudo cambiar).
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import Ic from '../../components/Ic';
import { compararNatural, hoyCdmx } from '../../lib/comprobaciones';
import { leerCatalogoPlantillas, type SitioComp, type VwCampana } from '../../lib/comprobacionesApi';
import { faltan, PLANTILLA_POR_OMISION, type PlantillaToma, type TienePos } from '../../lib/plantillasComp';
import { leerCapturasTomas, leerFotosTomas, leerModoCampanas, leerTomasRevision } from '../../lib/revisionApi';
import {
  bandejasDe,
  conVia,
  enFiltroDia,
  parteCamara,
  plantillaDeToma,
  type Bandeja,
  type CampanaModo,
  type FiltroDia,
  type FotoRev,
  type TomaRev,
} from '../../lib/revisionTomas';
import { colorTono } from '../../lib/tonos';
import { nf } from './AvanceComun';
import BloqueTomaComp from './BloqueTomaComp';
import type { ContextoComp } from './tiposComp';

type Props = Pick<ContextoComp, 'email' | 'permisos' | 'nombreDe' | 'correr' | 'ocupado' | 'telefono'> & {
  camp: VwCampana;
  sitios: SitioComp[];
  /** Releer sitios y campaña del detalle (el crédito pudo cambiar). */
  onCambio: () => void;
  bandejaInicial?: Bandeja;
};

type Vista = Bandeja | 'todas';

const BANDEJAS: { k: Vista; t: string }[] = [
  { k: 'por_revisar', t: 'Por revisar' },
  { k: 'devueltas', t: 'Devueltas' },
  { k: 'comprobadas', t: 'Comprobadas' },
  { k: 'por_capturar', t: 'Por capturar' },
  { k: 'todas', t: 'Todas' },
];
const DIAS: { k: FiltroDia; t: string }[] = [
  { k: 'hoy', t: 'Hoy' },
  { k: 'ayer', t: 'Ayer' },
  { k: '7', t: '7 días' },
  { k: 'todo', t: 'Todo' },
];

/** Sitios que se pintan de inicio. */
const LIMITE = 60;

export default function RevisionCampana(p: Props) {
  const { camp, email, permisos } = p;
  const hoy = hoyCdmx();

  // ---- Lectura ------------------------------------------------------------
  const [modo, setModo] = useState<CampanaModo | null>(null);
  const [sinMigracion, setSinMigracion] = useState(false);
  const [catalogo, setCatalogo] = useState<PlantillaToma[]>([]);
  const [tomas, setTomas] = useState<TomaRev[]>([]);
  const [capturas, setCapturas] = useState<Map<number, TienePos[]>>(new Map());
  const [leido, setLeido] = useState(false);
  const [leyendo, setLeyendo] = useState(false);
  const [errLeer, setErrLeer] = useState('');
  const pide = useRef(0);

  /** Fotos por toma, de los sitios abiertos (undefined = leyendo). */
  const [fotos, setFotos] = useState<Map<number, FotoRev[]>>(new Map());
  const [abiertos, setAbiertos] = useState<Set<number>>(new Set());

  const vigenteDe = (m: CampanaModo | null, cat: PlantillaToma[]) => {
    const codigo = m?.plantilla_codigo || PLANTILLA_POR_OMISION;
    const t = cat.find((x) => x.codigo === codigo && x.capa === 'testigo') ?? cat.find((x) => x.codigo === PLANTILLA_POR_OMISION);
    return conVia(t?.posiciones ?? [], m ?? { modo_toma: 'campo', pos_camara: [] });
  };

  const releer = async () => {
    const n = ++pide.current;
    setLeyendo(true);
    const [m, c, t] = await Promise.all([leerModoCampanas([camp.id]), catalogo.length ? Promise.resolve(null) : leerCatalogoPlantillas(), leerTomasRevision(camp.id)]);
    if (n !== pide.current) return;
    if (!t.ok) {
      setLeyendo(false);
      if (t.codigo === 'falta_migracion') setSinMigracion(true);
      setErrLeer(t.codigo === 'falta_migracion' ? '' : 'No se pudieron leer las tomas: ' + t.error);
      setLeido(true);
      return;
    }
    let md: CampanaModo | null = null;
    const avisos: string[] = [];
    if (m.ok) md = m.data.get(camp.id) ?? null;
    else if (m.codigo === 'falta_migracion') setSinMigracion(true);
    // Sin modo, una campaña mixta se pintaría como de campo: se dice.
    else avisos.push('No se pudo leer el modo de la campaña (campo, cámaras o mixto): ' + m.error);
    const cat = c && c.ok ? c.data : catalogo;
    if (c && c.ok) setCatalogo(c.data);
    else if (c && !c.ok) avisos.push('No se pudo leer el catálogo de plantillas: ' + c.error);
    const vig = vigenteDe(md, cat);
    // Capturas solo de las candidatas a «Por capturar».
    const cand = t.data.filter(
      (x) => (x.estado === 'pendiente' || x.estado === 'por_revisar' || x.estado === 'regresada') && x.fecha <= hoy && parteCamara(plantillaDeToma(x, vig)).length > 0
    );
    const cap = cand.length ? await leerCapturasTomas(cand.map((x) => x.id)) : { ok: true as const, data: new Map<number, TienePos[]>() };
    if (n !== pide.current) return;
    setLeyendo(false);
    setModo(md);
    setTomas(t.data);
    if (cap.ok) setCapturas(cap.data);
    else avisos.push('No se pudieron leer las capturas: ' + cap.error);
    setErrLeer(avisos.join(' '));
    setLeido(true);
  };

  useEffect(() => {
    releer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camp.id]);

  const vigente = useMemo(() => vigenteDe(modo, catalogo), [modo, catalogo]);
  const tieneCamara = modo != null && modo.modo_toma !== 'campo';

  /**
   * La última lectura pedida de cada toma (revisión adversarial, 29-oct-2026):
   * una lectura vieja que llega después de una nueva no pisa sus fotos.
   */
  const genFotos = useRef(new Map<number, number>());
  const nGen = useRef(0);
  /** Lee las fotos de las tomas de unos sitios (al abrirlos y después de escribir). */
  const leerFotosDe = async (sitioIds: number[]) => {
    const ids = tomas.filter((t) => sitioIds.includes(t.sitio_id)).map((t) => t.id);
    if (!ids.length) return;
    const g = ++nGen.current;
    for (const id of ids) genFotos.current.set(id, g);
    const r = await leerFotosTomas(ids);
    if (!r.ok) {
      setErrLeer('No se pudieron leer las fotos: ' + r.error);
      return;
    }
    const vigentes = ids.filter((id) => genFotos.current.get(id) === g);
    if (!vigentes.length) return;
    setFotos((prev) => {
      const m = new Map(prev);
      for (const id of vigentes) m.set(id, []);
      for (const f of r.data) if (vigentes.includes(f.toma_id)) m.get(f.toma_id)?.push(f);
      return m;
    });
  };

  // Al releer las tomas, las fotos de los sitios abiertos también.
  useEffect(() => {
    if (leido && abiertos.size) leerFotosDe([...abiertos]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tomas]);

  // ---- Bandejas y filtro --------------------------------------------------
  const [vista, setVista] = useState<Vista>(p.bandejaInicial ?? 'por_revisar');
  const [dia, setDia] = useState<FiltroDia>('todo');
  const [limite, setLimite] = useState(LIMITE);

  const conBandejas = useMemo(
    () =>
      tomas.map((t) => {
        const pl = plantillaDeToma(t, vigente);
        const cam = parteCamara(pl);
        const falta = cam.length ? faltan(cam, capturas.get(t.id) ?? []).length : 0;
        return { t, pl, bandejas: bandejasDe(t, { tieneCamara: cam.length > 0, faltaCamara: falta }, hoy) };
      }),
    [tomas, vigente, capturas, hoy]
  );
  const enVista = (b: Bandeja[], v: Vista) => (v === 'todas' ? true : b.includes(v));
  const conteo = useMemo(() => {
    const c: Record<Vista, number> = { por_revisar: 0, devueltas: 0, comprobadas: 0, por_capturar: 0, todas: 0 };
    for (const x of conBandejas) {
      if (!enFiltroDia(x.t.fecha, dia, hoy)) continue;
      // Igual que la lista: «Todas» no cuenta pendientes sin nada que hacer.
      if (!(x.t.estado === 'pendiente' && !x.bandejas.length)) c.todas++;
      for (const b of x.bandejas) c[b]++;
    }
    return c;
  }, [conBandejas, dia, hoy]);

  const porSitio = useMemo(() => {
    const m = new Map<number, typeof conBandejas>();
    for (const x of conBandejas) {
      if (!enFiltroDia(x.t.fecha, dia, hoy) || !enVista(x.bandejas, vista)) continue;
      // «Todas» no enseña lo que todavía no pasa (pendientes sin nada que hacer, a futuro).
      if (vista === 'todas' && x.t.estado === 'pendiente' && !x.bandejas.length) continue;
      const l = m.get(x.t.sitio_id) ?? [];
      l.push(x);
      m.set(x.t.sitio_id, l);
    }
    const porId = new Map(p.sitios.map((s) => [s.id, s]));
    return [...m.entries()]
      .map(([sid, l]) => ({ sitio: porId.get(sid), sid, tomas: l.sort((a, b) => (a.t.fecha < b.t.fecha ? 1 : a.t.fecha > b.t.fecha ? -1 : b.t.id - a.t.id)) }))
      .sort((a, b) => compararNatural(a.sitio?.sitio_clave ?? '', b.sitio?.sitio_clave ?? ''));
  }, [conBandejas, dia, vista, hoy, p.sitios]);

  const alternarSitio = (sid: number) => {
    const abrir = !abiertos.has(sid);
    setAbiertos((prev) => {
      const s = new Set(prev);
      if (abrir) s.add(sid);
      else s.delete(sid);
      return s;
    });
    if (abrir) leerFotosDe([sid]);
  };

  // ---- Permisos de la campaña (la base vuelve a validar todo) ----------------
  const esMia = permisos.esAnalista && (camp.analista_email || '').toLowerCase() === email;
  const abierta = camp.estatus === 'abierta';
  // Como comp_puede_revisar: la analista de la campaña, un Supervisor que
  // también es analista de la unidad, o el manager. Un Supervisor que no es
  // analista solo ve (y sí sube capturas).
  const puedeRevisar = abierta && (esMia || (permisos.gestiona && permisos.esAnalista) || !!permisos.esManager);
  const puedeCapturar = abierta && !camp.retirada && (esMia || permisos.gestiona);
  const ventana = {
    desde: camp.inicio && camp.inicio > camp.periodo_inicio ? camp.inicio : camp.periodo_inicio,
    hasta: camp.fin && camp.fin < camp.periodo_fin ? camp.fin : camp.periodo_fin,
  };

  // ---- Después de escribir -------------------------------------------------
  const [hecho, setHecho] = useState('');
  const [err, setErr] = useState('');
  const despues = (r: { hecho?: string; err?: string; sinRed?: boolean }) => {
    setErr(r.err || '');
    setHecho(r.hecho || '');
    // Sin red no se sabe si se guardó: se relee igual para enseñar cómo quedó.
    releer();
    p.onCambio();
  };

  const vacio =
    vista === 'por_revisar'
      ? 'No te queda nada por revisar aquí. Cuando un monitorista envíe una toma de esta campaña, aparece en esta bandeja y te llega el aviso.'
      : vista === 'devueltas'
        ? 'No hay tomas devueltas: las que regreses al monitorista se quedan aquí hasta que las vuelva a tomar.'
        : vista === 'comprobadas'
          ? 'Todavía no hay tomas comprobadas en estos días.'
          : vista === 'por_capturar'
            ? 'No falta ninguna captura de cámara en estos días.'
            : 'No hay tomas en estos días.';

  if (sinMigracion)
    return (
      <div className="banner">
        La revisión de fotos todavía no está lista en la base (falta aplicar su migración). Mientras, marca los sitios en «Sitios».
      </div>
    );

  return (
    <div>
      <div className="rt-chips rt-segmento" role="group" aria-label="Bandeja de tomas" style={{ marginBottom: 6 }}>
        {BANDEJAS.filter((b) => b.k !== 'por_capturar' || tieneCamara || conteo.por_capturar > 0).map((b) => (
          <button
            key={b.k}
            type="button"
            className={'rt-chip' + (vista === b.k ? ' on' : '')}
            aria-pressed={vista === b.k}
            onClick={() => {
              setVista(b.k);
              setLimite(LIMITE);
            }}
            style={b.k === 'por_revisar' && conteo.por_revisar > 0 && vista !== b.k ? { color: colorTono('ambar') } : undefined}
          >
            {b.t} {leido ? `(${nf(conteo[b.k])})` : ''}
          </button>
        ))}
      </div>
      <div className="rt-chips" role="group" aria-label="Días" style={{ marginBottom: 8 }}>
        {DIAS.map((d) => (
          <button key={d.k} type="button" className={'rt-chip' + (dia === d.k ? ' on' : '')} aria-pressed={dia === d.k} onClick={() => setDia(d.k)}>
            {d.t}
          </button>
        ))}
      </div>
      {modo && modo.modo_toma !== 'campo' && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
          {modo.modo_toma === 'camaras'
            ? 'Campaña de cámaras: tú subes las capturas y cuentan solas, sin revisión.'
            : modo.pos_camara.length
              ? `Mixta: ${parteCamara(vigente).map((q) => q.etiqueta).join(', ')} va${parteCamara(vigente).length === 1 ? '' : 'n'} por cámara (la subes tú y cuenta sola); lo demás lo toma el monitorista y lo revisas.`
              : 'Mixta sin fotos por cámara: se comporta como campo. El Supervisor elige cuáles en Campañas.'}
        </div>
      )}
      {!puedeRevisar && abierta && (
        <div className="banner">
          Solo ves las fotos: revisa la analista de la campaña{puedeCapturar ? '. Sí puedes subir las capturas de cámara.' : '.'}
        </div>
      )}
      {err && (
        <div className="err" role="alert">
          {err}
        </div>
      )}
      {hecho && !err && (
        <div className="ok-msg" role="status">
          {hecho}
        </div>
      )}
      {errLeer && (
        <div className="err" role="alert">
          {errLeer}{' '}
          <button type="button" className="btn ghost sm" onClick={releer}>
            <Ic i={RotateCcw} />
            Reintentar
          </button>
        </div>
      )}

      {!leido ? (
        <div className="phint">
          <span className="spinner" />
          Leyendo tomas…
        </div>
      ) : (
        <div className={leyendo ? 'recargando' : undefined} style={{ display: 'grid', gap: 6 }}>
          {porSitio.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13, padding: '14px 4px', textAlign: 'center' }}>{vacio}</div>}
          {porSitio.slice(0, limite).map(({ sitio, sid, tomas: ts }) => {
            const abierto = abiertos.has(sid);
            const clave = sitio?.sitio_clave ?? `Sitio ${sid}`;
            const n = (b: Bandeja) => ts.filter((x) => x.bandejas.includes(b)).length;
            const resumen = [
              n('por_revisar') && `${n('por_revisar')} por revisar`,
              n('devueltas') && `${n('devueltas')} devuelta${n('devueltas') === 1 ? '' : 's'}`,
              n('por_capturar') && `${n('por_capturar')} sin captura`,
              n('comprobadas') && `${n('comprobadas')} comprobada${n('comprobadas') === 1 ? '' : 's'}`,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <div key={sid} className="rt-seccion" style={{ margin: 0 }}>
                <button
                  type="button"
                  aria-expanded={abierto}
                  onClick={() => alternarSitio(sid)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 44,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: 'inherit',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <Ic i={abierto ? ChevronDown : ChevronRight} />
                  <span style={{ minWidth: 0, flex: '1 1 auto' }}>
                    <b style={{ overflowWrap: 'anywhere' }}>{clave}</b>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>
                      {resumen || `${ts.length} ${ts.length === 1 ? 'toma' : 'tomas'}`}
                      {sitio?.estado === 'comprobado' ? ' · el sitio ya cuenta' : ''}
                    </span>
                  </span>
                </button>
                {abierto &&
                  ts.map((x) => (
                    <BloqueTomaComp
                      key={x.t.id}
                      toma={x.t}
                      plantilla={x.pl}
                      fotos={fotos.get(x.t.id)}
                      sitioClave={clave}
                      unidad={camp.unidad}
                      hoy={hoy}
                      ventana={ventana}
                      puedeRevisar={puedeRevisar}
                      // Sin la clave del sitio la ruta de la captura saldría mal (la base la rechaza).
                      puedeCapturar={puedeCapturar && !!sitio}
                      telefono={p.telefono}
                      email={email}
                      nombreDe={p.nombreDe}
                      ocupado={p.ocupado}
                      correr={p.correr}
                      despues={despues}
                    />
                  ))}
              </div>
            );
          })}
          {porSitio.length > limite && (
            <button type="button" className="btn ghost" onClick={() => setLimite((x) => x + LIMITE)}>
              Ver {nf(Math.min(LIMITE, porSitio.length - limite))} sitios más (faltan {nf(porSitio.length - limite)})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
