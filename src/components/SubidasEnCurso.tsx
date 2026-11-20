// ============================================================
// src/components/SubidasEnCurso.tsx
// La leyenda chica de las fotos que suben solas después de guardar un
// reporte (20-nov-2026, Erik): «Subiendo fotos de BBMM00012 · 3 de 6».
//
// Desde ese día Nueva incidencia se cierra en cuanto se crean los folios y
// las fotos siguen desde la cola (lib/envios.ts, `enSegundoPlano`). Esta
// leyenda va en dos lugares:
//   · flotando abajo, en cualquier pestaña (la pone EnviosPendientes);
//   · dentro de Nueva incidencia (`enLinea`), para quien ya está levantando
//     el siguiente reporte y no ve la de abajo (la ventana la tapa).
// Al terminar, el logro «✓ BBMM00012 guardado con sus 6 fotos» sale con
// AvisoBreve. Si se queda sin red, la subida pasa al aviso normal de
// pendientes con «Reintentar» y aquí deja de verse.
// ============================================================
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { emailActivo, subidasEnCurso, suscribirEnvios } from '../lib/envios';
import { textoSubida } from '../lib/subidaEnvios';

export default function SubidasEnCurso({ email, enLinea }: { email?: string; enLinea?: boolean }) {
  const [texto, setTexto] = useState('');

  useEffect(() => {
    const leer = () => setTexto(textoSubida(subidasEnCurso(email || emailActivo())));
    leer();
    return suscribirEnvios(leer);
  }, [email]);

  if (!texto) return null;
  if (enLinea) {
    return (
      <div className="subida-en-linea" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        {texto}
      </div>
    );
  }
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="aviso-subida" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {texto}
    </div>,
    document.body
  );
}
