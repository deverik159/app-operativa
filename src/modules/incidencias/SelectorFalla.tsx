// ============================================================
// src/modules/incidencias/SelectorFalla.tsx
// Elegir QUÉ incidencia es, del catálogo. Lo comparten la corrección del
// validador (CorreccionModal) y la del reportante (EditModal, 13-oct-2026):
// una sola regla para los dos.
//
// Solo se elige la ENTRADA DEL CATÁLOGO; nivel, origen, tipo y área los
// deriva quien guarda a partir de ella (ver CorreccionModal: dejar
// escogerlos a mano producía combinaciones que el catálogo nunca daría).
//
// El catálogo se filtra por unidad y se RESTRINGE al mueble de la cara: ahí
// cada incidencia existe una sola vez y el área ya viene decidida.
//
// SIN SEÑAL (modo sin señal, 24-sep-2026): el catálogo sale de la red con
// tope corto o de la copia del teléfono (lib/datosLocales.ts). Guardar sí
// necesita señal; eso lo dice quien guarda.
// ============================================================
import { WifiOff } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import { sb } from '../../lib/supabase';
import { catalogoLocal, motivoSinRed, redOLocal } from '../../lib/datosLocales';
import { catalogoParaMuebles, llaveCatalogo, filtrarCatalogo } from '../../lib/catalogo';
import type { OpcionesCatalogo } from '../../lib/catalogo';
import type { CatalogoIncidencia } from '../../types/db';
import Ic from '../../components/Ic';

type Props = {
  /** Unidad de la incidencia (el catálogo es por unidad). */
  unidad: string | null;
  /** Mueble de la cara: restringe la lista. */
  mueble: string | null;
  /** Lo que dice hoy la incidencia: se preselecciona si existe. */
  actual: string | null;
  /** La entrada elegida (null mientras no hay ninguna). */
  onElegir: (sel: CatalogoIncidencia | null) => void;
  /** Texto de la etiqueta. Por omisión, "Incidencia". */
  etiqueta?: string;
};

/** Fila de solo lectura: lo que el catálogo decide y aquí no se discute. */
export function Derivado({ label, valor }: { label: string; valor: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div
        style={{
          background: 'var(--panel2)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: '10px 12px',
          fontSize: 14,
          color: valor ? 'var(--txt)' : 'var(--muted)',
        }}
      >
        {valor || '—'}
      </div>
    </div>
  );
}

function SelectorFalla({ unidad, mueble, actual, onElegir, etiqueta = 'Incidencia' }: Props) {
  const [cat, setCat] = useState<OpcionesCatalogo>({
    opciones: [],
    restringido: false,
    sinCatalogo: [],
  });
  const [loading, setLoading] = useState(true);
  const [errCat, setErrCat] = useState('');
  /** El catálogo salió de la copia del teléfono (modo sin señal, 24-sep-2026). */
  const [deCopia, setDeCopia] = useState(false);
  /** Sube con "Reintentar" cuando no llegó el catálogo (revisión sin señal, 24-sep-2026). */
  const [reintento, setReintento] = useState(0);
  const [llave, setLlave] = useState('');
  const [busca, setBusca] = useState('');

  // El catálogo se filtra por unidad, igual que en el alta. `ilike` porque la
  // unidad viene escrita distinto entre tablas ('Biobox' vs 'BIOBOX').
  useEffect(() => {
    let vivo = true;
    setLoading(true);
    setErrCat('');
    (async () => {
      // `select('*')` y no la lista de columnas: si el catálogo tiene
      // `tipo_medio`, viene; y si no la tiene, no truena. Pedirla por nombre
      // daría 400 y el modal se quedaría vacío sin decir por qué.
      //
      // Sin señal o si la red falla, el de la copia del teléfono (modo sin
      // señal, 24-sep-2026). OJO con la copia: el filtro de la red es
      // IGUALDAD sin mayúsculas (`ilike` sin comodín); el '%' solo entra si
      // la incidencia no trae unidad. Con prefijo, 'Biobox' se traería
      // también el catálogo de 'Biobox Perú'.
      const u = unidad || '';
      const r = await redOLocal<CatalogoIncidencia[]>(
        (senal) =>
          sb
            .from('catalogo_incidencias')
            .select('*')
            .ilike('unidad_negocio', unidad || '%')
            .limit(1000)
            .retry(false)
            .abortSignal(senal),
        () => catalogoLocal(u, { prefijo: !u })
      ).catch(() => ({ datos: [] as CatalogoIncidencia[], origen: 'local' as const }));
      if (!vivo) return;
      setDeCopia(r.origen === 'local');
      // Sin señal no es lo mismo que una red que tardó (revisión sin señal,
      // 24-sep-2026): con 3G lenta lo que sirve es Reintentar.
      if (r.origen === 'local' && r.datos.length === 0)
        setErrCat(
          motivoSinRed() === 'Sin señal'
            ? 'Sin señal, y este teléfono no tiene copia del catálogo. Abre la app una vez con señal.'
            : 'La red tardó demasiado, y este teléfono no tiene copia del catálogo.'
        );
      // Se RESTRINGE al mueble de esta cara. Ahí cada incidencia existe una
      // sola vez y el área ya viene decidida: es lo que evita que "Adicional
      // dañado" en una cara impresa salga dirigida a Digital.
      setCat(catalogoParaMuebles(r.datos, [mueble]));
      setLoading(false);
    })();
    return () => {
      vivo = false;
    };
  }, [unidad, mueble, reintento]);

  // Preselección: si el nombre actual existe en el catálogo, se marca solo.
  // Si no existe (incidencia vieja, o texto capturado a mano), se deja en
  // blanco a propósito — eso ES el motivo por el que hay que corregirla.
  useEffect(() => {
    if (!cat.opciones.length || llave) return;
    const enCatalogo = cat.opciones.find((c) => c.detalle === actual);
    if (enCatalogo) setLlave(llaveCatalogo(enCatalogo));
  }, [cat, actual, llave]);

  const sel = useMemo(
    () => cat.opciones.find((c) => llaveCatalogo(c) === llave) || null,
    [cat, llave]
  );
  useEffect(() => {
    onElegir(sel);
    // onElegir viene de un setState del padre: estable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // La opción elegida se conserva siempre en la lista, aunque el texto del
  // buscador ya no la encuentre. Si no, escribir después de elegir la haría
  // desaparecer del `select` y el navegador mostraría otra cosa como
  // seleccionada — se guardaría una incidencia distinta de la que se ve.
  const visibles = useMemo(() => {
    const base = filtrarCatalogo(cat.opciones, busca);
    if (sel && !base.some((c) => llaveCatalogo(c) === llave)) return [sel, ...base];
    return base;
  }, [cat, busca, sel, llave]);

  return (
    <div className="field">
      <label>
        {etiqueta} (del catálogo · {visibles.length} de {cat.opciones.length}
        {cat.restringido && mueble ? ` · ${mueble}` : ''})
      </label>
      {errCat && (
        <div className="err">
          {errCat}{' '}
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setReintento((n) => n + 1)}
            disabled={loading}
          >
            Reintentar
          </button>
        </div>
      )}
      {loading ? (
        <div className="loading">Cargando catálogo…</div>
      ) : (
        <>
          <input
            placeholder="Buscar por incidencia o por área…"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <select value={llave} onChange={(e) => setLlave(e.target.value)}>
            <option value="">— Selecciona —</option>
            {visibles.map((c) => (
              <option key={llaveCatalogo(c)} value={llaveCatalogo(c)}>
                {c.detalle}
                {c.area ? ` (${c.area})` : ''}
              </option>
            ))}
          </select>
          {cat.sinCatalogo.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
              ⚠️ El catálogo no tiene entradas para el mueble{' '}
              <b>{cat.sinCatalogo.join(', ')}</b>: salen todas las incidencias y
              el área no viene decidida. Fíjate en el área entre paréntesis.
            </div>
          )}
          {busca && visibles.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 6 }}>
              Nada coincide con “{busca}”.
            </div>
          )}
        </>
      )}
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
        Ahora dice: “{actual || '—'}”
      </div>
      {deCopia && !errCat && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }} role="status">
          <Ic i={WifiOff} />Catálogo de la copia del teléfono. Para guardar necesitas señal.
        </div>
      )}
    </div>
  );
}

export default SelectorFalla;
