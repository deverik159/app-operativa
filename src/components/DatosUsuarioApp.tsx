// ============================================================
// src/components/DatosUsuarioApp.tsx
// «Ver datos del usuario» en la tarjeta de una incidencia que vino de la app
// Biobox (Erik, 11-nov-2026, a pedido de TI: «para saber qué pasa» con un
// abono de puntos y casos así).
//
// Correo, teléfono y lo que escribió el usuario. No viajan con la lista ni
// con la copia del teléfono: se piden al tocar el botón. El botón lo ven el
// técnico de TI que la atiende, la validadora y el manager (coordinación los
// tiene en el Excel). La base (datos_usuario_app_incidencia) vuelve a
// revisar: al técnico de TI solo mientras la incidencia esté en TI y
// abierta; a cualquier otro le regresa vacío.
// ============================================================
import { useState } from 'react';
import { User } from 'lucide-react';
import { sb } from '../lib/supabase';
import Ic from './Ic';

type Fila = {
  folio_app: string | null;
  motivo: string | null;
  descripcion: string | null;
  correo: string | null;
  telefono: string | null;
  medio_contacto: string | null;
};

export default function DatosUsuarioApp({ recordId }: { recordId: string }) {
  const [estado, setEstado] = useState<'cerrado' | 'cargando' | 'listo' | 'error'>('cerrado');
  const [filas, setFilas] = useState<Fila[]>([]);

  const abrir = async () => {
    setEstado('cargando');
    const { data, error } = await sb.rpc('datos_usuario_app_incidencia', { p_record_id: recordId });
    if (error) {
      setEstado('error');
      return;
    }
    setFilas((data || []) as Fila[]);
    setEstado('listo');
  };

  if (estado === 'cerrado' || estado === 'cargando') {
    return (
      <div style={{ margin: '6px 0' }}>
        <button
          type="button"
          className="btn ghost sm"
          disabled={estado === 'cargando'}
          onClick={() => void abrir()}
        >
          <Ic i={User} />
          {estado === 'cargando' ? 'Buscando…' : 'Ver datos del usuario'}
        </button>
      </div>
    );
  }

  if (estado === 'error') {
    return (
      <div className="inc-contacto" role="status">
        No se pudieron traer los datos del usuario (¿sin señal?).{' '}
        <button type="button" className="btn ghost sm" onClick={() => void abrir()}>
          Reintentar
        </button>
      </div>
    );
  }

  if (!filas.length) {
    return (
      <div className="inc-contacto" role="status">
        Sin datos del usuario para esta incidencia.
      </div>
    );
  }

  return (
    <div className="inc-contacto" role="status" style={{ display: 'grid', gap: 6 }}>
      {filas.map((f, k) => (
        <div key={k}>
          <div>
            <Ic i={User} />
            <b>Usuario de la app</b>
            {f.folio_app ? ` · ${f.folio_app}` : ''}
            {f.medio_contacto ? ` · prefiere ${f.medio_contacto}` : ''}
          </div>
          {(f.correo || f.telefono) && (
            <div>{[f.correo, f.telefono].filter(Boolean).join(' · ')}</div>
          )}
          {f.descripcion && <div style={{ whiteSpace: 'pre-wrap' }}>“{f.descripcion}”</div>}
        </div>
      ))}
    </div>
  );
}
