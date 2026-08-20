// ============================================================
// src/components/IrAqui.tsx
// Botón que abre la navegación hacia una ubicación.
//
// El menú se abre como OVERLAY FIJO, no como desplegable absoluto.
//
// El motivo: este botón vive dentro de tarjetas y de listas con
// `overflow-y: auto` (el detalle de ruta, la lista de campo). Un menú
// `position: absolute` queda recortado por el contenedor con scroll, y en
// celular —donde el botón suele estar cerca del borde— se veía cortado o no
// se veía. Un overlay `position: fixed` no lo recorta nada.
//
// De paso queda homologado con el resto de la app: mismas clases .overlay y
// .modal que los modales de Incidencias.
//
// Ofrece Google Maps y Waze porque en campo cada quien usa la suya. Apple Maps
// aparece solo en iPhone, donde puede ser la única instalada.
//
// Si la ubicación no tiene coordenadas, el botón NO se dibuja: es preferible
// su ausencia a mandar al monitorista a un punto equivocado.
// ============================================================
import { useState } from 'react';
import {
  urlGoogleMaps,
  urlWaze,
  urlAppleMaps,
  esNavegable,
} from '../lib/navegacion';
import type { Destino } from '../lib/navegacion';

type Props = {
  destino: { lat?: number | null; lng?: number | null; nombre?: string | null };
  /** 'sm' para listas densas. */
  size?: 'sm' | 'md';
};

/** ¿Es iPhone/iPad? Solo ahí tiene sentido ofrecer Apple Maps. */
function esApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function IrAqui({ destino, size = 'sm' }: Props) {
  const [abierto, setAbierto] = useState(false);

  if (!esNavegable(destino)) return null;
  const d: Destino = {
    lat: destino.lat as number,
    lng: destino.lng as number,
    nombre: destino.nombre,
  };

  const abrir = (url: string) => {
    // noopener: la app de mapas no debe poder tocar esta pestaña.
    window.open(url, '_blank', 'noopener,noreferrer');
    setAbierto(false);
  };

  /** Fila del menú: icono grande y área táctil amplia. */
  const opcion = (
    icono: React.ReactNode,
    texto: string,
    sub: string,
    url: string
  ) => (
    <button
      type="button"
      className="btn ghost"
      onClick={() => abrir(url)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        textAlign: 'left',
        minHeight: 54,
        padding: '10px 14px',
      }}
    >
      <span style={{ fontSize: 22, flexShrink: 0 }}>{icono}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 700 }}>{texto}</span>
        <span
          style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}
        >
          {sub}
        </span>
      </span>
    </button>
  );

  return (
    <>
      <button
        type="button"
        className={'btn ghost' + (size === 'sm' ? ' sm' : '')}
        onClick={(e) => {
          // stopPropagation: la tarjeta contenedora puede tener su propio
          // onClick (abrir detalle, enfocar la ruta).
          e.stopPropagation();
          setAbierto(true);
        }}
        title={`Navegar a ${destino.nombre || 'esta ubicación'}`}
        style={{ flexShrink: 0 }}
      >
        🧭 Ir
      </button>

      {abierto && (
        <div
          className="overlay"
          style={{ alignItems: 'center' }}
          onClick={(e) => {
            e.stopPropagation();
            if ((e.target as HTMLElement).className.includes('overlay'))
              setAbierto(false);
          }}
        >
          <div
            className="modal"
            style={{ maxWidth: 380 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ margin: '0 0 3px', fontSize: 18 }}>¿Cómo te llevo?</h2>
            <p className="phint" style={{ marginBottom: 14 }}>
              {destino.nombre || 'Ubicación'}
            </p>

            <div style={{ display: 'grid', gap: 8 }}>
              {opcion(
                '🗺️',
                'Google Maps',
                'Desde tu ubicación actual',
                urlGoogleMaps(d)
              )}
              {opcion('🚗', 'Waze', 'Con alertas de tráfico', urlWaze(d))}
              {esApple() &&
                opcion(
                  '',
                  'Apple Maps',
                  'App de mapas del iPhone',
                  urlAppleMaps(d)
                )}
            </div>

            <div className="modal-actions" style={{ marginTop: 14 }}>
              <button
                className="btn ghost"
                onClick={() => setAbierto(false)}
                style={{ width: '100%' }}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default IrAqui;
