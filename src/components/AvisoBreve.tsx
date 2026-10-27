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
//
// POR QUÉ RECIBE porMostrar Y texto POR PROPS (fase 3 de Comprobaciones,
// incremento 2, 26-oct-2026; especificación B9): sirve a dos colas, la de
// Pauta (lib/tomasPauta: «✓ Toma de …») y la de Comprobaciones
// (lib/colaFotos: «✓ COL_551 · 6 fotos arriba · 3 tomas enviadas»). Antes
// importaba logrosPorMostrar de tomasPauta; ahora cada cola pasa el suyo y
// Pauta se ve igual. Si las dos tienen algo a la vez, la segunda espera a que
// se quite la primera (no se enciman).
// POR QUÉ UN CANDADO DE MÓDULO Y NO EL DOM (26-oct-2026): cuando las dos colas
// terminan en la misma vuelta, React junta los dos setState en un render y
// los efectos de las dos píldoras corren antes de pintar: buscar
// '.aviso-breve' no encontraba ninguna y salían encimadas. El candado se toma
// ANTES de setTexto y se suelta al ocultarse o al desmontarse.
// ============================================================
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Cuánto se queda a la vista. */
const VISIBLE_MS = 4500;
/** Cada cuánto revisa si ya se cerró la ventana que lo taparía. */
const REVISAR_MS = 700;

/** Qué píldora está a la vista (null = ninguna). */
let mostrando: symbol | null = null;

export default function AvisoBreve<L>({
  logros,
  onMostrados,
  porMostrar,
  texto: textoDe,
}: {
  /** Lo que terminó y aún no se ha mostrado. */
  logros: L[];
  /** Ya se mostraron los primeros `n` (el padre los quita). */
  onMostrados: (n: number) => void;
  /** Suelta lo que el usuario ya vio en pantalla (la cola de cada uno lo sabe). */
  porMostrar: (lista: L[]) => L[];
  /** El texto de la píldora. */
  texto: (lista: L[]) => string;
}) {
  const [texto, setTexto] = useState('');
  const ocultar = useRef<number | undefined>(undefined);
  const yo = useRef<symbol>(Symbol('aviso-breve'));
  // Las funciones pueden llegar nuevas en cada render: con ref no se
  // reinicia el intento.
  const porMostrarRef = useRef(porMostrar);
  porMostrarRef.current = porMostrar;
  const textoRef = useRef(textoDe);
  textoRef.current = textoDe;

  useEffect(() => {
    if (!logros.length) return;
    let t: number | undefined;
    const intentar = () => {
      // Una ventana abierta, u otra píldora a la vista (la de la otra cola).
      if (document.querySelector('.overlay') || (mostrando !== null && mostrando !== yo.current)) {
        t = window.setTimeout(intentar, REVISAR_MS);
        return;
      }
      onMostrados(logros.length);
      // Se filtra AL MOSTRAR: las fotos sueltas de una cara que el
      // monitorista vio registrarse en pantalla mientras esperaban ya no se
      // repiten (eran dos avisos seguidos de la misma toma).
      const vigentes = porMostrarRef.current(logros);
      if (!vigentes.length) return;
      const x = textoRef.current(vigentes);
      if (!x) return;
      mostrando = yo.current;
      setTexto(x);
      window.clearTimeout(ocultar.current);
      ocultar.current = window.setTimeout(() => setTexto(''), VISIBLE_MS);
    };
    intentar();
    return () => window.clearTimeout(t);
  }, [logros, onMostrados]);

  // Se ocultó (estuvo a la vista y ya no): suelta el candado para la otra
  // cola. Solo en esa transición: al montar (texto vacío) este efecto corre
  // en el mismo flush que el intento que acaba de tomar el candado.
  const visto = useRef(false);
  useEffect(() => {
    if (texto) visto.current = true;
    else if (visto.current) {
      visto.current = false;
      if (mostrando === yo.current) mostrando = null;
    }
  }, [texto]);

  useEffect(
    () => () => {
      window.clearTimeout(ocultar.current);
      if (mostrando === yo.current) mostrando = null;
    },
    []
  );

  if (!texto || typeof document === 'undefined') return null;
  return createPortal(
    <div className="aviso-breve" role="status" aria-live="polite" onClick={() => setTexto('')}>
      {texto}
    </div>,
    document.body
  );
}
