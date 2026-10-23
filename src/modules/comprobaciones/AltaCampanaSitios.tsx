// ============================================================
// src/modules/comprobaciones/AltaCampanaSitios.tsx
// Escoger los sitios de una campaña dada de alta a mano (23-oct-2026).
//
// POR QUÉ. Erik: en Biobox sobre todo, Victor arma campañas que no vienen
// en la bitácora y hoy teclea las claves una por una. Aquí las escoge:
//   · por MODELO (inventario.tipo_mueble: M4, M4-R2, M5 OXXO…),
//   · por RUTA de monitoreo (rutas activas Digital o Combinada; la parada
//     guarda a veces el site_id y a veces el vendor_face_id: se cruza por
//     los dos, ver leerRutasComp),
//   · o pegando una LISTA (una o varias claves por renglón; «856, 857» y
//     «POR_0008» se entienden en Vía Verde).
// Las caras fuera de servicio no entran al escoger por modelo o ruta salvo
// que se pida; en la lista entran todas (se pegaron a propósito).
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { claveDeSitio, partirClaves } from '../../lib/bitacoraComp';
import { compararNatural, type MedioComp } from '../../lib/comprobaciones';
import { leerRutasComp, textoFallaComp, type CaraInventario, type RutaComp } from '../../lib/comprobacionesApi';
import type { PropsArmar } from './tiposComp';
import { caraActiva, caraDelMedio, fmt, type EstadoInventario } from './ArmarComun';
import { ListaPlegable } from './ArmarCarga';

type Modo = 'modelo' | 'ruta' | 'lista';

const ETIQUETA_MODO: Record<Modo, string> = { modelo: 'Por modelo', ruta: 'Por ruta', lista: 'Pegar lista' };

type Grupo = { clave: string; etiqueta: string; caras: CaraInventario[] };

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
  const [modo, setModo] = useState<Modo>('modelo');
  const [conFuera, setConFuera] = useState(false);
  const [rutas, setRutas] = useState<RutaComp[] | null>(null);
  const [errRutas, setErrRutas] = useState('');
  const [texto, setTexto] = useState('');
  const [nota, setNota] = useState<{ ok: string; mal: string[] } | null>(null);
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

  const caras = useMemo(
    () => (inventario.caras ?? []).filter((c) => caraDelMedio(c, ctx.unidad, medio)),
    [inventario.caras, ctx.unidad, medio]
  );
  const porClave = useMemo(() => new Map(caras.map((c) => [c.vendor_face_id.toUpperCase(), c])), [caras]);
  const sel = useMemo(() => new Set(seleccion), [seleccion]);
  const entra = (c: CaraInventario) => conFuera || caraActiva(c);

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

  const agregar = (claves: string[]) => onCambio([...new Set([...seleccion, ...claves])].sort(compararNatural));
  const quitar = (claves: string[]) => {
    const q = new Set(claves);
    onCambio(seleccion.filter((c) => !q.has(c)));
  };

  const filaGrupo = (g: Grupo) => {
    const elegibles = g.caras.filter(entra).map((c) => c.vendor_face_id);
    const fuera = g.caras.length - g.caras.filter(caraActiva).length;
    const ya = g.caras.filter((c) => sel.has(c.vendor_face_id)).length;
    return (
      <div
        key={g.clave}
        style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}
      >
        <div style={{ flex: '1 1 220px', fontSize: 13, overflowWrap: 'anywhere' }}>
          <b>{g.etiqueta}</b>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {fmt(g.caras.length)} sitio(s){fuera ? ` · ${fmt(fuera)} fuera de servicio` : ''} · {fmt(ya)} escogidos
          </div>
        </div>
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
      const k = claveDeSitio(p, ctx.unidad);
      if (!k.clave) mal.push(`«${p}» no se entiende como clave`);
      else if (k.edoMex && ctx.unidad === 'Vía Verde') mal.push(`${p}: es de EDO MEX (de baja)`);
      else if (k.medio && k.medio !== medio) mal.push(`${p}: es de ${k.medio}, no de ${medio}`);
      else {
        buenas.push(k.clave);
        if (inventario.caras && !porClave.has(k.clave.toUpperCase())) mal.push(`${k.clave}: no está en el inventario (se agrega igual)`);
      }
    }
    if (buenas.length) agregar(buenas);
    setNota({ ok: `Se agregaron ${fmt(new Set(buenas).size)} clave(s).`, mal });
    if (buenas.length) setTexto('');
  };

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <div className="rt-chips rt-segmento" role="group" aria-label="Cómo escoger los sitios">
          {(['modelo', 'ruta', 'lista'] as Modo[]).map((m) => (
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
      {inventario.error && <div className="err">{inventario.error}</div>}
      {modo !== 'lista' && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
          <input type="checkbox" checked={conFuera} onChange={(e) => setConFuera(e.target.checked)} />
          Incluir sitios fuera de servicio
        </label>
      )}
      {modo === 'modelo' &&
        (inventario.caras == null ? (
          <div className="phint">
            <span className="spinner" />
            Leyendo el inventario…
          </div>
        ) : modelos.length ? (
          <div className="lista-scroll" style={{ maxHeight: 300, overflowY: 'auto' }}>
            {modelos.map(filaGrupo)}
          </div>
        ) : (
          <div className="empty">El inventario no tiene sitios de {medio}.</div>
        ))}
      {modo === 'ruta' &&
        (errRutas ? (
          <div className="err">{errRutas}</div>
        ) : rutas == null || inventario.caras == null ? (
          <div className="phint">
            <span className="spinner" />
            Leyendo rutas…
          </div>
        ) : gruposRuta.length ? (
          <div className="lista-scroll" style={{ maxHeight: 300, overflowY: 'auto' }}>
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
