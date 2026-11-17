// ============================================================
// src/components/ElegirMaquina.tsx
// Buscador de máquina (sitio + cara) para una incidencia reportada sin
// máquina. Salió de RepararModal (Erik, 28-sep-2026) para usarlo también al
// asignarla antes de reparar (AsignarMaquinaModal, 17-nov-2026).
//
// Busca por clave o por nombre, primero en la copia del teléfono y luego en
// la red (sin señal funciona con la copia). Al elegir el sitio carga sus
// caras; con una sola, queda elegida. Avisa cada cambio con `onCambio`.
// ============================================================
import { useEffect, useRef, useState } from 'react';
import { sb } from '../lib/supabase';
import {
  buscarSitiosEnRed,
  buscarSitiosLocal,
  carasDeSitioLocal,
  fechaCopia,
  redOLocal,
  type SitioLocal,
} from '../lib/datosLocales';
import type { InventarioItem } from '../types/db';

export type MaquinaElegida = { sitio: SitioLocal | null; cara: InventarioItem | null };

export default function ElegirMaquina({
  unidad,
  disabled,
  onCambio,
}: {
  unidad: string;
  disabled?: boolean;
  onCambio: (m: MaquinaElegida) => void;
}) {
  const [maqQuery, setMaqQuery] = useState('');
  const [maqOpts, setMaqOpts] = useState<SitioLocal[]>([]);
  const [maqBuscando, setMaqBuscando] = useState(false);
  const [maqSitio, setMaqSitio] = useState<SitioLocal | null>(null);
  const [maqCaras, setMaqCaras] = useState<InventarioItem[]>([]);
  const [maqCara, setMaqCara] = useState('');
  const [maqCargando, setMaqCargando] = useState(false);
  const maqSeq = useRef(0);
  const onCambioRef = useRef(onCambio);
  onCambioRef.current = onCambio;

  // Lo elegido, hacia quien lo usa (solo cuando cambia de verdad).
  const caraItem = maqCaras.find((c) => c.vendor_face_id === maqCara) || null;
  useEffect(() => {
    onCambioRef.current({ sitio: maqSitio, cara: caraItem });
    // caraItem cambia con maqCaras/maqCara.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maqSitio, maqCaras, maqCara]);

  useEffect(() => {
    const q = maqQuery.trim();
    if (maqSitio || !q) {
      setMaqOpts([]);
      setMaqBuscando(false);
      return;
    }
    let vivo = true;
    setMaqBuscando(true);
    const t = setTimeout(async () => {
      try {
        const locales = await buscarSitiosLocal(unidad, q, 12).catch(() => [] as SitioLocal[]);
        if (!vivo) return;
        setMaqOpts(locales);
        const hayCopia = !!(await fechaCopia('inventario').catch(() => null));
        const r = await redOLocal<SitioLocal[]>(
          (senal) => buscarSitiosEnRed(unidad, q, senal, { topeNombresMs: hayCopia ? 3000 : 15000 }),
          async () => locales,
          hayCopia ? { topeSinCopiaMs: 0 } : undefined
        );
        if (!vivo) return;
        const opts: SitioLocal[] = [...locales];
        if (r.origen === 'red')
          (r.datos || []).forEach((x) => {
            if (!opts.some((o) => o.site_id === x.site_id)) opts.push(x);
          });
        setMaqOpts(opts.slice(0, 12));
      } finally {
        if (vivo) setMaqBuscando(false);
      }
    }, 250);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [maqQuery, maqSitio, unidad]);

  const elegirMaquina = async (o: SitioLocal) => {
    const seq = ++maqSeq.current;
    setMaqSitio(o);
    setMaqCaras([]);
    setMaqCara('');
    setMaqCargando(true);
    const r = await redOLocal<InventarioItem[]>(
      (senal) =>
        sb
          .from('inventario')
          .select(
            'vendor_face_id,site_id,site_legacy_id,cara,categoria,unidad_negocio,tipo_medio,tipo_mueble,latitud,longitud,direccion,municipio,estado'
          )
          .eq('site_id', o.site_id)
          .retry(false)
          .abortSignal(senal),
      () => carasDeSitioLocal(o.site_id)
    ).catch(() => ({ datos: [] as InventarioItem[], origen: 'local' as const }));
    if (seq !== maqSeq.current) return;
    setMaqCargando(false);
    setMaqCaras(r.datos);
    if (r.datos.length === 1) setMaqCara(r.datos[0].vendor_face_id);
  };

  if (!maqSitio) {
    return (
      <>
        <input
          value={maqQuery}
          onChange={(e) => setMaqQuery(e.target.value)}
          placeholder="Escribe para buscar…"
          disabled={disabled}
        />
        {maqBuscando && maqOpts.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Buscando…</div>
        )}
        {!maqBuscando && !!maqQuery.trim() && maqOpts.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Sin resultados</div>
        )}
        {maqOpts.length > 0 && (
          <div
            className="lista-scroll"
            style={{
              border: '1px solid var(--line)',
              borderRadius: 9,
              marginTop: 4,
              maxHeight: 220,
              overflow: 'auto',
            }}
          >
            {maqOpts.map((o) => (
              <button
                key={o.site_id}
                type="button"
                className="btn ghost"
                style={{ display: 'block', width: '100%', textAlign: 'left', borderRadius: 0, border: 'none' }}
                onClick={() => elegirMaquina(o)}
              >
                <b>{o.site_id}</b>
                {o.nombre && <span style={{ color: 'var(--muted)' }}> · {o.nombre}</span>}
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{o.direccion || 'sin dirección'}</div>
              </button>
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="banner" style={{ marginBottom: 0 }}>
      <b>{maqSitio.site_id}</b>
      {maqSitio.nombre ? ` · ${maqSitio.nombre}` : ''}
      {maqSitio.direccion ? ` · ${maqSitio.direccion}` : ''}{' '}
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => {
          maqSeq.current++;
          setMaqSitio(null);
          setMaqCaras([]);
          setMaqCara('');
          setMaqCargando(false);
        }}
        disabled={disabled}
      >
        Cambiar
      </button>
      {maqCargando && <div style={{ marginTop: 6 }}>Cargando sus caras…</div>}
      {!maqCargando && maqCaras.length === 0 && (
        <div style={{ marginTop: 6, color: 'var(--warn)' }}>
          No se pudieron cargar sus caras. Toca Cambiar y vuelve a elegirla.
        </div>
      )}
      {maqCaras.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {maqCaras.map((c) => (
            <button
              key={c.vendor_face_id}
              type="button"
              className={'btn sm' + (maqCara === c.vendor_face_id ? '' : ' ghost')}
              onClick={() => setMaqCara(c.vendor_face_id)}
              disabled={disabled}
            >
              {c.tipo_medio || c.cara || c.vendor_face_id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
