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
import { esIOS } from '../lib/plataforma';

type Props = {
  destino: { lat?: number | null; lng?: number | null; nombre?: string | null };
  /** 'sm' para listas densas. */
  size?: 'sm' | 'md';
};

/** ¿Es iPhone/iPad? Solo ahí tiene sentido ofrecer Apple Maps. */
const esApple = esIOS;

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
      {/* Solo se reserva el espacio si de verdad hay algo que dibujar: un
          icono vacío dejaría una sangría fantasma en la fila. */}
      {icono ? (
        <span style={{ fontSize: 22, flexShrink: 0, lineHeight: 1 }}>
          {icono}
        </span>
      ) : null}
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
          onClick={(e) => {
            e.stopPropagation();
            if ((e.target as HTMLElement).className.includes('overlay'))
              setAbierto(false);
          }}
        >
          {/* margin:auto y no alignItems:center en el overlay: centra igual
              pero deja scrollear si el menú creciera más que la pantalla. */}
          <div
            className="modal"
            style={{ maxWidth: 380, margin: 'auto 0' }}
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
                  // Emoji, NO el carácter del logo de Apple (U+F8FF): ese es
                  // de "Área de Uso Privado" y solo tiene glifo con la fuente
                  // de Apple. En el navegador se dibuja vacío.
                  '🍎',
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
