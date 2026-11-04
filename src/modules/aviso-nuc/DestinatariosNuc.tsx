// ============================================================
// src/modules/aviso-nuc/DestinatariosNuc.tsx
// «Quién más recibe» (Erik, 4-nov-2026): el manager agrega a mano, por
// unidad, a personas que deben recibir los avisos de NUC aunque su rol no
// lo dé (la gente de campo). Se guardan en nuc_avisos_extra con
// nuc_extra_agregar / nuc_extra_quitar, que solo acepta el manager y solo
// correos con cuenta en la app. Así ningún correo vive en el repositorio.
// ============================================================
import { Trash2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { sb } from '../../lib/supabase';
import { nombreDe, type MapaNombres } from '../../lib/nombres';
import { UNIDADES_AVISO_NUC } from '../../lib/avisoNuc';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';

type Extra = { unidad_negocio: string; usuario_email: string };

function DestinatariosNuc({ nombres, onCerrar }: { nombres: MapaNombres; onCerrar: () => void }) {
  const [lista, setLista] = useState<Extra[] | null>(null);
  const [err, setErr] = useState('');
  const [unidad, setUnidad] = useState(UNIDADES_AVISO_NUC[0]);
  const [correo, setCorreo] = useState('');
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    const { data, error } = await sb.from('nuc_avisos_extra').select('unidad_negocio,usuario_email')
      .order('unidad_negocio').order('usuario_email');
    if (error) { setErr('No se pudo cargar la lista: ' + error.message); setLista([]); return; }
    setLista((data || []) as Extra[]);
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  const agregar = async () => {
    const e = correo.trim().toLowerCase();
    if (!e) { setErr('Escribe el correo.'); return; }
    setGuardando(true); setErr('');
    const { error } = await sb.rpc('nuc_extra_agregar', { p_unidad: unidad, p_email: e });
    setGuardando(false);
    if (error) { setErr(error.message); return; }
    setCorreo('');
    await cargar();
  };

  const quitar = async (x: Extra) => {
    setGuardando(true); setErr('');
    const { error } = await sb.rpc('nuc_extra_quitar', { p_unidad: x.unidad_negocio, p_email: x.usuario_email });
    setGuardando(false);
    if (error) { setErr(error.message); return; }
    await cargar();
  };

  // Sugerencias del campo de correo: las personas que ya conoce la app.
  const sugerencias = Object.keys(nombres).sort();

  return createPortal(
    <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !guardando) onCerrar(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="nuc-dest-titulo" style={{ maxWidth: 560 }}>
        <CerrarModal onClick={onCerrar} disabled={guardando} />
        <h2 id="nuc-dest-titulo">Quién más recibe los avisos</h2>
        <p className="phint">
          Además de los roles de cada unidad (técnicos de Op. Bio Box en Biobox; coordinador, validador y
          Digital en Ecovallas y Vía Verde), reciben el aviso y ven el tablero de esa unidad:
        </p>
        {!lista && <p>Cargando…</p>}
        {lista && UNIDADES_AVISO_NUC.map((u) => {
          const deU = lista.filter((x) => x.unidad_negocio === u);
          return (
            <div key={u} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{u}</div>
              {!deU.length && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Nadie agregado.</div>}
              {deU.map((x) => (
                <div key={x.usuario_email} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '3px 0', overflowWrap: 'anywhere' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {nombreDe(nombres, x.usuario_email)} <span style={{ color: 'var(--muted)', fontSize: 12 }}>{x.usuario_email}</span>
                  </span>
                  <button type="button" className="btn ghost sm" disabled={guardando} onClick={() => void quitar(x)} aria-label={'Quitar a ' + x.usuario_email + ' de ' + u}>
                    <Ic i={Trash2} />Quitar
                  </button>
                </div>
              ))}
            </div>
          );
        })}
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 6 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>Agregar a alguien</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <select aria-label="Unidad" value={unidad} onChange={(e) => setUnidad(e.target.value)} style={{ fontSize: 16 }}>
              {UNIDADES_AVISO_NUC.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <input aria-label="Correo" type="email" list="nuc-dest-correos" value={correo} placeholder="correo de la persona"
              onChange={(e) => { setCorreo(e.target.value); setErr(''); }} style={{ flex: '1 1 200px', minWidth: 0, fontSize: 16 }} />
            <datalist id="nuc-dest-correos">
              {sugerencias.map((c) => <option key={c} value={c}>{nombres[c]}</option>)}
            </datalist>
            <button type="button" className="btn sm" disabled={guardando || !correo.trim()} onClick={() => void agregar()}>
              <Ic i={UserPlus} />{guardando ? 'Guardando…' : 'Agregar'}
            </button>
          </div>
        </div>
        {err && <div className="err" role="alert" style={{ marginTop: 8 }}>{err}</div>}
        <div className="modal-actions pie-fijo" style={{ marginTop: 12 }}>
          <button className="btn ghost" onClick={onCerrar} disabled={guardando}>Cerrar</button>
        </div>
      </section>
    </div>,
    document.body
  );
}

export default DestinatariosNuc;
