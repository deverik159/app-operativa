// ============================================================
// src/modules/incidencias/CampoCampania.tsx
// Campo «Campaña» al corregir una incidencia (Erik, 24-nov-2026): lo usan el
// ✏️ Editar del reportante (EditModal) y la Corrección del validador
// (CorreccionModal).
//
// Texto libre, como en el alta sin pauta. En Ecovallas sugiere (datalist)
// las campañas que QTM tiene pautadas en esa cara dos semanas antes y
// después del reporte, desde `qtm_pautas`, la misma fuente que precarga la
// campaña en Nueva incidencia. Sin señal, o si la base no deja leerla, queda
// como texto libre sin aviso: la sugerencia es ayuda, no requisito.
// ============================================================
import { useEffect, useId, useState } from 'react';
import { sb } from '../../lib/supabase';
import { haySenal } from '../../lib/datosLocales';
import { tope } from '../../lib/envios';

type Props = {
  valor: string;
  onCambio: (v: string) => void;
  unidad: string | null;
  /** vendor_face_id de la cara (clave_medio). Sin cara, sin sugerencias. */
  cara: string | null;
  /** fecha_reporte de la incidencia: centro de la ventana de la pauta. */
  fechaReporte: string | null;
};

const DIA_MS = 86400000;

export default function CampoCampania({ valor, onCambio, unidad, cara, fechaReporte }: Props) {
  const id = useId();
  const [pautadas, setPautadas] = useState<string[]>([]);

  useEffect(() => {
    const vf = (cara || '').trim();
    if ((unidad || '') !== 'Ecovallas' || !vf || !haySenal()) {
      setPautadas([]);
      return;
    }
    let activo = true;
    const base = fechaReporte ? new Date(fechaReporte).getTime() : Date.now();
    const dia = (d: number) => new Date(base + d * DIA_MS).toISOString().slice(0, 10);
    (async () => {
      const { data } = await sb
        .from('qtm_pautas')
        .select('campaign')
        .eq('vendor_face_id', vf)
        // Traslape con dos semanas antes y después del reporte.
        .lte('fecha_inicio', dia(14))
        .gte('fecha_fin', dia(-14))
        .retry(false)
        .abortSignal(tope(8000));
      if (!activo) return;
      const nombres = [
        ...new Set(
          ((data as { campaign: string | null }[] | null) || [])
            .map((r) => (r.campaign || '').trim())
            .filter(Boolean)
        ),
      ];
      setPautadas(nombres);
    })().catch(() => {
      if (activo) setPautadas([]);
    });
    return () => {
      activo = false;
    };
  }, [cara, unidad, fechaReporte]);

  return (
    <div className="field">
      <label htmlFor={`${id}-campania`}>Campaña</label>
      <input
        id={`${id}-campania`}
        value={valor}
        onChange={(e) => onCambio(e.target.value)}
        list={pautadas.length ? `${id}-pauta` : undefined}
        placeholder="Escribe la campaña…"
        autoComplete="off"
      />
      {pautadas.length > 0 && (
        <>
          <datalist id={`${id}-pauta`}>
            {pautadas.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            Pautada en esa cara: {pautadas.join(' · ')}
          </div>
        </>
      )}
    </div>
  );
}
