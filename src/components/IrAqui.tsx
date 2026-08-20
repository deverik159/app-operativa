// ============================================================
// src/components/IrAqui.tsx
// Botón que abre la navegación hacia una ubicación.
//
// Ofrece Google Maps y Waze porque en campo cada quien usa la suya, y
// obligar a una sola es fricción innecesaria. Apple Maps aparece solo en
// iPhone, donde puede ser la única instalada.
//
// Si la ubicación no tiene coordenadas, el botón NO se dibuja: es preferible
// su ausencia a un botón que manda al monitorista a un punto equivocado.
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

/** ¿El dispositivo es un iPhone/iPad? Solo ahí tiene sentido Apple Maps. */
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

  const clase = 'btn ghost' + (size === 'sm' ? ' sm' : '');
  const abrir = (url: string) => {
    // noopener: la app de mapas no debe poder tocar esta pestaña.
    window.open(url, '_blank', 'noopener,noreferrer');
    setAbierto(false);
  };

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        className={clase}
        onClick={(e) => {
          e.stopPropagation();
          setAbierto((v) => !v);
        }}
        title={`Navegar a ${destino.nombre || 'esta ubicación'}`}
      >
        🧭 Ir
      </button>

      {abierto && (
        <>
          {/* Capa para cerrar al tocar fuera, sin listeners globales. */}
          <div
            onClick={(e) => {
              e.stopPropagation();
              setAbierto(false);
            }}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
          />
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              right: 0,
              top: '110%',
              zIndex: 41,
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: 6,
              display: 'grid',
              gap: 4,
              minWidth: 172,
              boxShadow: '0 8px 24px rgba(0,0,0,.5)',
            }}
          >
            <button
              type="button"
              className="btn ghost sm"
              style={{ textAlign: 'left' }}
              onClick={() => abrir(urlGoogleMaps(d))}
            >
              🗺️ Google Maps
            </button>
            <button
              type="button"
              className="btn ghost sm"
              style={{ textAlign: 'left' }}
              onClick={() => abrir(urlWaze(d))}
            >
              🚗 Waze
            </button>
            {esApple() && (
              <button
                type="button"
                className="btn ghost sm"
                style={{ textAlign: 'left' }}
                onClick={() => abrir(urlAppleMaps(d))}
              >
                 Apple Maps
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default IrAqui;
