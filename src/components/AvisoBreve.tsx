// ============================================================
// src/components/AvisoBreve.tsx
// El aviso pequeño y no invasivo de "tus tomas quedaron arriba" (fase 1 de
// comprobaciones; lo pidió Erik el 22-oct-2026).
//
//   · Una píldora abajo, unos segundos, que se quita sola o con un toque.
//     No es una notificación del sistema: la cola solo avanza con la app
//     abierta, así que el usuario está mirando la pantalla.
//   · Con una ventana abierta no se ve (quedaría debajo): espera a que se
//     cierre. Varios logros juntos salen en un solo aviso.
//   · Va en un portal a <body>: un fijo dentro de algo sticky no recibe
//     toques en iOS (ver index.css). Colores del tema (--ok-*), con pareja
//     clara y oscura.
// ============================================================
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { textoLogro, type Logro } from '../lib/tomasPautaLogica';
import { logrosPorMostrar } from '../lib/tomasPauta';

/** Cuánto se queda a la vista. */
const VISIBLE_MS = 4500;
/** Cada cuánto revisa si ya se cerró la ventana que lo taparía. */
const REVISAR_MS = 700;

export default function AvisoBreve({
  logros,
  onMostrados,
}: {
  /** Lo que terminó y aún no se ha mostrado. */
  logros: Logro[];
  /** Ya se mostraron los primeros `n` (el padre los quita). */
  onMostrados: (n: number) => void;
}) {
  const [texto, setTexto] = useState('');
  const ocultar = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!logros.length) return;
    let t: number | undefined;
    const intentar = () => {
      if (document.querySelector('.overlay')) {
        t = window.setTimeout(intentar, REVISAR_MS);
        return;
      }
      onMostrados(logros.length);
      // Se filtra AL MOSTRAR: las fotos sueltas de una cara que el
      // monitorista vio registrarse en pantalla mientras esperaban ya no se
      // repiten (eran dos avisos seguidos de la misma toma).
      const vigentes = logrosPorMostrar(logros);
      if (!vigentes.length) return;
      setTexto(textoLogro(vigentes));
      window.clearTimeout(ocultar.current);
      ocultar.current = window.setTimeout(() => setTexto(''), VISIBLE_MS);
    };
    intentar();
    return () => window.clearTimeout(t);
  }, [logros, onMostrados]);

  useEffect(() => () => window.clearTimeout(ocultar.current), []);

  if (!texto || typeof document === 'undefined') return null;
  return createPortal(
    <div className="aviso-breve" role="status" aria-live="polite" onClick={() => setTexto('')}>
      {texto}
    </div>,
    document.body
  );
}
