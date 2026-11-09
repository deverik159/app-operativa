// ============================================================
// src/components/AvisoPush.tsx
// Aviso bajo la barra superior cuando este dispositivo no recibe push
// (9-nov-2026). Las reglas (cuándo sale y qué dice) viven en
// lib/avisoPush.ts; el botón abre la misma ventana de BotonPush, que ya
// explica cada caso (iPhone sin instalar, bloqueado, caído).
// ============================================================
import { useState } from 'react';
import { BellOff } from 'lucide-react';
import { usePush, abrirPanelPush } from '../lib/usePush';
import { decidirAvisoPush, CLAVE_POSPUESTO, POSPONER_MS } from '../lib/avisoPush';
import { esCelular } from '../lib/plataforma';
import Ic from './Ic';

function leerPospuesto(): number | null {
  try {
    const v = Number(localStorage.getItem(CLAVE_POSPUESTO));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export default function AvisoPush({ email }: { email: string }) {
  const revision = usePush(email);
  const [pospuestoHasta, setPospuestoHasta] = useState(leerPospuesto);

  const aviso = decidirAvisoPush({
    estado: revision?.estado ?? null,
    dispositivosActivos: revision?.dispositivosActivos ?? null,
    esCelular: esCelular(),
    pospuestoHasta,
    ahora: Date.now(),
  });
  if (!aviso) return null;

  const posponer = () => {
    const hasta = Date.now() + POSPONER_MS;
    try {
      localStorage.setItem(CLAVE_POSPUESTO, String(hasta));
    } catch {
      // Sin almacenamiento se esconde solo hasta recargar.
    }
    setPospuestoHasta(hasta);
  };

  return (
    <div
      className="banner"
      role="status"
      style={{
        margin: '10px 16px 0',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <span style={{ flex: '1 1 220px' }}>
        <Ic i={BellOff} />
        {aviso.texto}
      </span>
      <span style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button className="btn sm" onClick={abrirPanelPush}>
          {aviso.boton}
        </button>
        <button className="btn ghost sm" onClick={posponer}>
          Ahora no
        </button>
      </span>
    </div>
  );
}
