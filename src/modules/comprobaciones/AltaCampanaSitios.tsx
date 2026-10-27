// ============================================================
// src/modules/comprobaciones/AltaCampanaSitios.tsx
// Escoger los sitios de una campaña dada de alta a mano (23-oct-2026).
//
// POR QUÉ. Erik: en Biobox sobre todo, Victor arma campañas que no vienen
// en la bitácora y hoy teclea las claves una por una. Aquí las escoge:
//   · UNO POR UNO (26-oct-2026): se busca por clave, por la forma corta
//     («679», «POR_0008» en Vía Verde), site_id, dirección o municipio y se
//     marca la casilla de cada sitio (buscarSitiosComp.ts),
//   · por MODELO (inventario.tipo_mueble: M4, M4-R2, M5 OXXO…),
//   · por RUTA de monitoreo (rutas activas; en Ecovallas solo Digital o
//     Combinada, en Biobox y Vía Verde también Impreso desde el 26-oct-2026,
//     como comp_ruta_sitio; la parada
//     guarda a veces el site_id y a veces el vendor_face_id: se cruza por
//     los dos, ver leerRutasComp),
//   · o pegando una LISTA (una o varias claves por renglón; «856, 857» y
//     «POR_0008» se entienden en Vía Verde).
// Las caras fuera de servicio no entran al escoger por modelo o ruta salvo
// que se pida; en la lista entran todas (se pegaron a propósito), y una por
// una también (se marcan a propósito).
//
// POR QUÉ «Uno por uno» (26-oct-2026). Erik, probando la vista previa: «me
// aparece agregar 50, pero no por sitio». Se atoró armando una campaña de
// Vía Verde Columna con 3 columnas sueltas. Ahora es el modo de omisión, y
// cada grupo de «Por modelo» y «Por ruta» tiene «Ver sitios» con una casilla
// por sitio. Vía Verde Columna pasa de mil caras: el índice se memoiza y
// nunca se pintan todas (tope de 50, «Ver 50 más» en los grupos).
//
// Revisión del 26-oct-2026: Enter agrega solo un sitio del inventario (la
// clave tecleada completa o el único resultado); la clave que no está en el
// inventario, solo con su botón. Las columnas de EDO MEX de Vía Verde (de
// baja) ya no entran a ningún modo, tampoco a «Ver sitios». El foco no se
// pierde: «Ver N más» lo pasa al primer sitio nuevo y «Agregar … (no está en
// el inventario)» lo regresa a «Buscar sitio». Lo que hace Enter se anuncia
// en una región viva que siempre está montada.
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { partirClaves } from '../../lib/bitacoraComp';
import { buscarSitios, indexarSitios, revisarClave, sitioDeBaja } from '../../lib/buscarSitiosComp';
import { compararNatural, type MedioComp } from '../../lib/comprobaciones';
import { leerRutasComp, textoFallaComp, type CaraInventario, type RutaComp } from '../../lib/comprobacionesApi';
import type { PropsArmar } from './tiposComp';
import { caraActiva, caraDelMedio, fmt, type EstadoInventario } from './ArmarComun';
import { ListaPlegable } from './ArmarCarga';

type Modo = 'uno' | 'modelo' | 'ruta' | 'lista';

const MODOS: Modo[] = ['uno', 'modelo', 'ruta', 'lista'];
const ETIQUETA_MODO: Record<Modo, string> = { uno: 'Uno por uno', modelo: 'Por modelo', ruta: 'Por ruta', lista: 'Pegar lista' };

/** Cuántos sitios se pintan a la vez (búsqueda y cada grupo abierto). */
const TOPE = 50;

type Grupo = { clave: string; etiqueta: string; caras: CaraInventario[] };

const PISTA = { fontSize: 12, color: 'var(--muted)', margin: '4px 0' } as const;

export default function AltaCampanaSitios({
  ctx,
  medio,
  inventario,
  seleccion,
  onCambio,
  disabled,
}: {
  ctx: PropsArmar;
  medio: MedioComp;
  inventario: EstadoInventario;
  seleccion: string[];
  onCambio: (claves: string[]) => void;
  disabled: boolean;
}) {
  const [modo, setModo] = useState<Modo>('uno');
  const [conFuera, setConFuera] = useState(false);
  const [rutas, setRutas] = useState<RutaComp[] | null>(null);
  const [errRutas, setErrRutas] = useState('');
  const [texto, setTexto] = useState('');
  const [nota, setNota] = useState<{ ok: string; mal: string[] } | null>(null);
  const [consulta, setConsulta] = useState('');
  /** Grupos con «Ver sitios» abierto ('modo:clave') → cuántos se pintan. */
  const [abiertos, setAbiertos] = useState<Record<string, number>>({});
  /** Lo último que hizo Enter o el botón de la clave suelta, para el lector de pantalla. */
  const [anuncio, setAnuncio] = useState('');
  const buscarRef = useRef<HTMLInputElement>(null);
  /** '<grupo>|<clave>': la casilla que recibe el foco al pintarse (primer sitio de «Ver N más»). */
  const focoPendiente = useRef<string | null>(null);
  const { asegurar } = inventario;

  useEffect(() => {
    void asegurar();
  }, [asegurar]);

  useEffect(() => {
    if (modo !== 'ruta' || rutas) return;
    let vivo = true;
    void leerRutasComp(ctx.unidad).then((r) => {
      if (!vivo) return;
      if (r.ok) setRutas(r.data);
      else setErrRutas('No se pudieron leer las rutas: ' + textoFallaComp(r));
    });
    return () => {
      vivo = false;
    };
  }, [modo, rutas, ctx.unidad]);

  // En orden natural: así salen los sitios de cada modelo al «Ver sitios».
  // Sin las de baja (EDO MEX de Vía Verde): ningún modo las ofrece.
  const caras = useMemo(
    () =>
      (inventario.caras ?? [])
        .filter((c) => caraDelMedio(c, ctx.unidad, medio) && !sitioDeBaja(c.vendor_face_id, ctx.unidad))
        .sort((a, b) => compararNatural(a.vendor_face_id, b.vendor_face_id)),
    [inventario.caras, ctx.unidad, medio]
  );
  const porClave = useMemo(() => new Map(caras.map((c) => [c.vendor_face_id.toUpperCase(), c])), [caras]);
  const sel = useMemo(() => new Set(seleccion), [seleccion]);
  const entra = (c: CaraInventario) => conFuera || caraActiva(c);

  const indice = useMemo(() => indexarSitios(caras, ctx.unidad), [caras, ctx.unidad]);
  // Sin inventario no se busca: «no está en el inventario» sería falso.
  const hallado = useMemo(
    () =>
      inventario.caras == null ? null : buscarSitios(indice, consulta, { unidad: ctx.unidad, medio, limite: TOPE }),
    [inventario.caras, indice, consulta, ctx.unidad, medio]
  );

  const modelos: Grupo[] = useMemo(() => {
    const m = new Map<string, Grupo>();
    for (const c of caras) {
      const mueble = (c.tipo_mueble || 'Sin modelo').trim();
      // En Biobox el mismo modelo existe impreso y digital: se separan.
      const k = ctx.unidad === 'Biobox' ? `${mueble} · ${c.tipo_medio || '—'}` : mueble;
      if (!m.has(k)) m.set(k, { clave: k, etiqueta: k, caras: [] });
      m.get(k)!.caras.push(c);
    }
    return [...m.values()].sort((a, b) => compararNatural(a.etiqueta, b.etiqueta));
  }, [caras, ctx.unidad]);

  const gruposRuta: Grupo[] = useMemo(() => {
    if (!rutas) return [];
    const porSite = new Map<string, CaraInventario[]>();
    for (const c of caras) {
      for (const k of [c.vendor_face_id, c.site_id]) {
        if (!k) continue;
        const kk = k.trim().toUpperCase();
        const l = porSite.get(kk) ?? [];
        l.push(c);
        porSite.set(kk, l);
      }
    }
    return rutas
      .map((r) => {
        const vistas = new Set<string>();
        const cs: CaraInventario[] = [];
        for (const s of r.sitios) {
          for (const c of porSite.get(String(s).trim().toUpperCase()) ?? []) {
            if (vistas.has(c.vendor_face_id)) continue;
            vistas.add(c.vendor_face_id);
            cs.push(c);
          }
        }
        return { clave: String(r.id), etiqueta: `Ruta ${r.numero}${r.nombre ? ' · ' + r.nombre : ''} (${r.tipo_medio})`, caras: cs };
      })
      .filter((g) => g.caras.length > 0);
  }, [rutas, caras]);

  /** Agrega sin duplicar y en orden natural; regresa cuántos quedan escogidos. */
  const agregar = (claves: string[]) => {
    const nueva = [...new Set([...seleccion, ...claves])].sort(compararNatural);
    onCambio(nueva);
    return nueva.length;
  };
  const quitar = (claves: string[]) => {
    const q = new Set(claves);
    onCambio(seleccion.filter((c) => !q.has(c)));
  };

  /**
   * Un sitio con su casilla: marcada = escogido. Los fuera de servicio también
   * se pueden marcar. `grupo` (en «Ver sitios») permite pasarle el foco.
   */
  const filaSitio = (c: CaraInventario, grupo?: string) => {
    const k = c.vendor_face_id;
    const lugar = c.direccion || c.municipio || '';
    return (
      <label
        key={k}
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
          padding: '5px 0',
          borderBottom: '1px solid var(--line)',
          fontSize: 12,
          cursor: disabled ? 'default' : 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={sel.has(k)}
          disabled={disabled}
          onChange={(e) => (e.target.checked ? agregar([k]) : quitar([k]))}
          ref={
            grupo
              ? (el) => {
                  if (el && focoPendiente.current === `${grupo}|${k}`) {
                    focoPendiente.current = null;
                    el.focus();
                  }
                }
              : undefined
          }
          style={{ width: 'auto', marginTop: 2, flex: 'none' }}
        />
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
          <b>{k}</b>
          <span style={{ color: 'var(--muted)' }}>
            {lugar ? ` · ${lugar}` : ''}
            {c.tipo_mueble ? ` · ${c.tipo_mueble}` : ''}
          </span>
          {!caraActiva(c) && <span style={{ color: 'var(--warn)' }}> · fuera de servicio</span>}
        </span>
      </label>
    );
  };

  const filaGrupo = (g: Grupo, i: number) => {
    const elegibles = g.caras.filter(entra).map((c) => c.vendor_face_id);
    const fuera = g.caras.length - g.caras.filter(caraActiva).length;
    const ya = g.caras.filter((c) => sel.has(c.vendor_face_id)).length;
    const llave = `${modo}:${g.clave}`;
    const visibles = abiertos[llave];
    const idLista = `comp-alta-grupo-${modo}-${i}`;
    return (
      <div key={g.clave} style={{ borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px', fontSize: 13, overflowWrap: 'anywhere' }}>
            <b>{g.etiqueta}</b>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {fmt(g.caras.length)} sitio(s){fuera ? ` · ${fmt(fuera)} fuera de servicio` : ''} · {fmt(ya)} escogidos
            </div>
          </div>
          <button
            type="button"
            className="btn ghost sm"
            aria-expanded={visibles != null}
            aria-controls={visibles != null ? idLista : undefined}
            onClick={() =>
              setAbiertos((a) => {
                const n = { ...a };
                if (n[llave] != null) delete n[llave];
                else n[llave] = TOPE;
                return n;
              })
            }
          >
            {visibles != null ? 'Ocultar sitios' : 'Ver sitios'}
          </button>
          <button type="button" className="btn ghost sm" disabled={disabled || !elegibles.length} onClick={() => agregar(elegibles)}>
            Agregar {fmt(elegibles.length)}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            disabled={disabled || !ya}
            onClick={() => quitar(g.caras.map((c) => c.vendor_face_id))}
          >
            Quitar
          </button>
        </div>
        {visibles != null && (
          <div id={idLista} style={{ padding: '0 0 8px 10px' }}>
            {g.caras.slice(0, visibles).map((c) => filaSitio(c, llave))}
            {g.caras.length > visibles && (
              <button
                type="button"
                className="btn ghost sm"
                style={{ marginTop: 6 }}
                onClick={() => {
                  // El botón se va con el último tramo: el foco pasa al primer sitio nuevo.
                  focoPendiente.current = `${llave}|${g.caras[visibles].vendor_face_id}`;
                  setAbiertos((a) => ({ ...a, [llave]: visibles + TOPE }));
                }}
              >
                Ver {fmt(Math.min(TOPE, g.caras.length - visibles))} más (quedan {fmt(g.caras.length - visibles)})
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const agregarLista = () => {
    const piezas = texto
      .split(/\r?\n/)
      .flatMap((l) => (l.trim() ? partirClaves(l) : []))
      .map((x) => x.trim())
      .filter(Boolean);
    const buenas: string[] = [];
    const mal: string[] = [];
    for (const p of piezas) {
      const r = revisarClave(p, ctx.unidad, medio);
      if (r.tipo !== 'ok') mal.push(r.aviso);
      else {
        buenas.push(r.clave);
        if (inventario.caras && !porClave.has(r.clave.toUpperCase())) mal.push(`${r.clave}: no está en el inventario (se agrega igual)`);
      }
    }
    if (buenas.length) agregar(buenas);
    setNota({ ok: `Se agregaron ${fmt(new Set(buenas).size)} clave(s).`, mal });
    if (buenas.length) setTexto('');
  };

  /** Agrega una clave desde «Buscar sitio», limpia el campo y anuncia lo que hizo. */
  const agregarDeBusqueda = (k: string) => {
    if (sel.has(k)) setAnuncio(`${k} ya estaba entre los escogidos.`);
    else setAnuncio(`${k} agregado (${fmt(agregar([k]))} sitio(s) escogidos).`);
    setConsulta('');
  };

  /**
   * Enter en «Buscar sitio»: agrega la clave tecleada completa o el único
   * resultado, siempre del inventario. La clave suelta (no está en el
   * inventario) solo se agrega con su botón: Enter no la agrega sin verla.
   */
  const alEnter = () => {
    if (!hallado || disabled) return;
    const una = hallado.exacta ?? (hallado.total === 1 ? hallado.sitios[0] : null);
    if (una) agregarDeBusqueda(una.vendor_face_id);
  };

  const vivo =
    hallado == null
      ? ''
      : anuncio ||
        (consulta.trim()
          ? hallado.total
            ? `${fmt(hallado.total)} sitio(s) de ${medio} coinciden.`
            : `Ningún sitio de ${medio} coincide con «${consulta.trim()}».`
          : '');

  const ejemplo =
    ctx.unidad === 'Vía Verde'
      ? medio === 'Pórtico'
        ? 'POR_0008, calle…'
        : '679, calle, municipio…'
      : ctx.unidad === 'Biobox'
        ? 'MX_CM_BB_MED_0114, 0114, calle…'
        : 'MX_CM_EV_…, calle, municipio…';

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <div className="rt-chips rt-segmento" role="group" aria-label="Cómo escoger los sitios">
          {MODOS.map((m) => (
            <button
              key={m}
              type="button"
              className={'rt-chip' + (modo === m ? ' on' : '')}
              aria-pressed={modo === m}
              onClick={() => setModo(m)}
            >
              {ETIQUETA_MODO[m]}
            </button>
          ))}
        </div>
      </div>
      {inventario.error && <div className="err" role="alert">{inventario.error}</div>}
      {(modo === 'modelo' || modo === 'ruta') && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={conFuera} onChange={(e) => setConFuera(e.target.checked)} />
          Incluir sitios fuera de servicio
        </label>
      )}
      {modo === 'uno' && (
        <div>
          <div className="field" style={{ marginBottom: 6 }}>
            <label htmlFor="comp-alta-buscar">Buscar sitio</label>
            <input
              ref={buscarRef}
              id="comp-alta-buscar"
              type="search"
              value={consulta}
              disabled={disabled}
              autoComplete="off"
              placeholder={ejemplo}
              onChange={(e) => {
                setConsulta(e.target.value);
                setAnuncio('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  alEnter();
                }
              }}
              style={{ width: '100%' }}
            />
          </div>
          {/* Siempre montada: un lector no anuncia una región viva recién insertada. */}
          <div style={vivo ? PISTA : undefined} aria-live="polite">
            {vivo}
          </div>
          {hallado == null ? (
            !inventario.error && (
              <div style={PISTA}>
                <span className="spinner" />
                Leyendo el inventario…
              </div>
            )
          ) : !consulta.trim() ? (
            <div style={PISTA}>
              Escribe la clave{ctx.unidad === 'Vía Verde' ? ' (o solo el número: 679)' : ''}, el site_id, la calle o el municipio y
              marca cada sitio. Enter agrega la clave completa o el único resultado.
            </div>
          ) : (
            <>
              {hallado.sitios.length > 0 && (
                <div className="lista-scroll" style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {hallado.sitios.map((c) => filaSitio(c))}
                </div>
              )}
              {hallado.total > hallado.sitios.length && (
                <div style={PISTA}>
                  Hay {fmt(hallado.total - hallado.sitios.length)} más: escribe más para afinar.
                </div>
              )}
              {hallado.aviso && <div style={{ ...PISTA, color: 'var(--warn)' }}>{hallado.aviso}</div>}
              {hallado.suelta &&
                (sel.has(hallado.suelta) ? (
                  <div style={PISTA}>{hallado.suelta} ya está entre los escogidos (no está en el inventario).</div>
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm"
                    style={{ marginTop: 6, whiteSpace: 'normal', textAlign: 'left', overflowWrap: 'anywhere' }}
                    disabled={disabled}
                    onClick={() => {
                      // El botón se va al limpiar el campo: el foco regresa a «Buscar sitio».
                      agregarDeBusqueda(hallado.suelta!);
                      buscarRef.current?.focus();
                    }}
                  >
                    Agregar {hallado.suelta} (no está en el inventario)
                  </button>
                ))}
            </>
          )}
        </div>
      )}
      {modo === 'modelo' &&
        (inventario.caras == null ? (
          <div className="phint">
            <span className="spinner" />
            Leyendo el inventario…
          </div>
        ) : modelos.length ? (
          <div className="lista-scroll" style={{ maxHeight: 360, overflowY: 'auto' }}>
            {modelos.map(filaGrupo)}
          </div>
        ) : (
          <div className="empty">El inventario no tiene sitios de {medio}.</div>
        ))}
      {modo === 'ruta' &&
        (errRutas ? (
          <div className="err" role="alert">{errRutas}</div>
        ) : rutas == null || inventario.caras == null ? (
          <div className="phint">
            <span className="spinner" />
            Leyendo rutas…
          </div>
        ) : gruposRuta.length ? (
          <div className="lista-scroll" style={{ maxHeight: 360, overflowY: 'auto' }}>
            {gruposRuta.map(filaGrupo)}
          </div>
        ) : (
          <div className="empty">No hay rutas activas con sitios de {medio}.</div>
        ))}
      {modo === 'lista' && (
        <div className="field">
          <label htmlFor="comp-alta-lista">Claves (una o varias por renglón)</label>
          <textarea
            id="comp-alta-lista"
            rows={5}
            value={texto}
            disabled={disabled}
            onChange={(e) => setTexto(e.target.value)}
            placeholder={ctx.unidad === 'Vía Verde' ? '856\n857, 858\nPOR_0008' : ctx.unidad === 'Biobox' ? 'MX_CM_BB_MED_0114' : 'MX_CM_EV_...'}
            style={{ width: '100%', fontFamily: 'inherit' }}
          />
          <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} disabled={disabled || !texto.trim()} onClick={agregarLista}>
            Agregar claves
          </button>
          {nota && (
            <div style={{ fontSize: 12, marginTop: 6 }}>
              {nota.ok}
              <ListaPlegable tono="warn" abierta titulo={`${fmt(nota.mal.length)} con aviso`} items={nota.mal} />
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>{fmt(seleccion.length)} sitio(s) escogidos</b>
        {seleccion.length > 0 && (
          <button type="button" className="btn ghost sm" disabled={disabled} onClick={() => onCambio([])}>
            Quitar todos
          </button>
        )}
      </div>
      {seleccion.length > 0 && (
        <details style={{ marginTop: 6, fontSize: 12 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>Ver los escogidos</summary>
          <div className="lista-scroll" style={{ maxHeight: 220, overflowY: 'auto', marginTop: 4 }}>
            {seleccion.map((k) => {
              const c = porClave.get(k.toUpperCase());
              return (
                <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                  <span style={{ flex: 1, overflowWrap: 'anywhere' }}>
                    {k}
                    <span style={{ color: 'var(--muted)' }}>
                      {c ? ` · ${c.direccion || c.municipio || ''}` : ' · no está en el inventario'}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn ghost sm"
                    aria-label={`Quitar ${k}`}
                    disabled={disabled}
                    onClick={() => quitar([k])}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
