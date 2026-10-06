// ============================================================
// src/modules/rutas/AsignarMonitoristas.tsx
// Asignar monitoristas a una ruta desde Rutas (rutas, 5-oct-2026). Antes
// solo se podía desde Pauta, y por eso solo para Ecovallas Impreso: Biobox,
// Vía Verde y Ecovallas Digital no tenían cómo.
//
// Escribe en `ruta_asignaciones` (la misma tabla que usa Pauta); su
// trigger avisa al monitorista (campana + push, evento 'ruta').
//
// Quién se puede asignar (decisión de Erik, rutas, 5-oct-2026): SOLO los
// monitoristas que TIENEN la unidad de la ruta (fila de usuario_roles con
// rol 'monitorista' y unidad vacía = todas, o igual a la de la ruta sin
// distinguir mayúsculas). Antes salía cualquier monitorista y se podía dar
// una ruta de Ecovallas Impreso a quien no ve Pauta: la recibía y no tenía
// dónde verla. La lista sale de `usuarios_asignables_ruta(p_ruta_id)`; si la
// base todavía no tiene esa función (PGRST202), cae a `usuarios_asignables()`
// con un aviso. En cualquier caso un trigger de `ruta_asignaciones` lo hace
// cumplir y su mensaje se enseña tal cual.
//
// Biobox: una misma ruta geográfica vive en DOS filas (Digital e Impreso,
// mismo nombre) porque la base no deja mezclar medios en una ruta. Si
// existe la "gemela", se ofrece asignarla junto: asignar una sola dejaba
// la otra mitad sin dueño.
//
// Toda escritura se cuenta con .select(): la RLS niega en silencio.
// ============================================================
import { User } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sb } from '../../lib/supabase';
import { tope } from '../../lib/envios';
import { pareceSinRed } from '../../lib/enLinea';
import { haySesionReal } from '../../lib/datosLocales';
import { sinAcentos } from '../../lib/helpers';
import { colorTono, fondoTono } from '../../lib/tonos';
import { vigilarRender } from '../../lib/vigia';
import { correoDeSesion, esSegmentoDePauta, TOPE_LECTURA_MS, type Resumen } from './rutasComun';
import Ic from '../../components/Ic';

type Asig = { id: number; ruta_id: number; usuario_email: string };
type Persona = { email: string; nombre: string };
type Gemela = { id: number; numero: number; nombre: string | null; tipo_medio: string };

/** ¿La función RPC no existe en esta base? PGRST202 = PostgREST no la
 *  encontró (migración sin correr); 42883 = Postgres no la conoce. */
function esFuncionFaltante(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  return e.code === 'PGRST202' || e.code === '42883' || /could not find the function/i.test(e.message || '');
}

const normNombre = (s: string | null | undefined) =>
  sinAcentos(s || '').replace(/\s+/g, ' ').trim();

export default function AsignarMonitoristas({ ruta }: { ruta: Resumen }) {
  vigilarRender('AsignarMonitoristas');
  const [asig, setAsig] = useState<Asig[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [gemela, setGemela] = useState<Gemela | null>(null);
  const [conGemela, setConGemela] = useState(true);
  const [cargando, setCargando] = useState(true);
  /** Error de la CARGA (lo limpia cada recarga). */
  const [err, setErr] = useState('');
  /** Error de Asignar/Quitar, aparte del de carga (QA, 5-oct-2026): el
   *  setRecarga que sigue a asignar corría la carga, su setErr('') borraba
   *  el mensaje del trigger en el mismo ciclo y el coordinador no veía
   *  nada. Este solo lo limpia la siguiente acción. */
  const [errAccion, setErrAccion] = useState('');
  const [aviso, setAviso] = useState('');
  /** true = la base aún no tiene usuarios_asignables_ruta y la lista no
   *  está filtrada por unidad (rutas, 5-oct-2026). */
  const [sinFiltroUnidad, setSinFiltroUnidad] = useState(false);
  const [q, setQ] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const esBiobox = ruta.unidad_negocio.startsWith('Biobox');
  /** Dónde la ve el monitorista: Ecovallas Impreso vive en Pauta; el resto
   *  en «Mis rutas». */
  const dondeLaVe = esSegmentoDePauta(ruta.unidad_negocio, ruta.tipo_medio) ? 'Pauta y Monitoreo' : 'Mis rutas';

  // Carga: gemela (Biobox), personas asignables y asignaciones vigentes.
  useEffect(() => {
    let activo = true;
    setCargando(true);
    setErr('');
    (async () => {
      let gem: Gemela | null = null;
      if (esBiobox && ruta.nombre) {
        const { data } = await sb
          .from('rutas_monitoreo')
          .select('id,numero,nombre,tipo_medio')
          .eq('unidad_negocio', ruta.unidad_negocio)
          .neq('tipo_medio', ruta.tipo_medio)
          .abortSignal(tope(TOPE_LECTURA_MS));
        if (!activo) return;
        const n = normNombre(ruta.nombre);
        gem = ((data as Gemela[] | null) || []).find((r) => normNombre(r.nombre) === n) || null;
      }
      const ids = gem ? [ruta.id, gem.id] : [ruta.id];
      const [a, pRuta] = await Promise.all([
        sb
          .from('ruta_asignaciones')
          .select('id,ruta_id,usuario_email')
          .in('ruta_id', ids)
          .abortSignal(tope(TOPE_LECTURA_MS)),
        sb.rpc('usuarios_asignables_ruta', { p_ruta_id: ruta.id }).abortSignal(tope(TOPE_LECTURA_MS)),
      ]);
      if (!activo) return;
      // La gemela de Biobox es de la misma unidad: los que sirven para esta
      // sirven para ella, no hace falta pedir otra lista.
      let p = pRuta;
      let sinFiltro = false;
      if (pRuta.error && esFuncionFaltante(pRuta.error)) {
        // La migración nueva aún no corre en esta base: la lista de antes,
        // con aviso (la base, sin el trigger, tampoco lo exige todavía).
        p = await sb.rpc('usuarios_asignables').abortSignal(tope(TOPE_LECTURA_MS));
        if (!activo) return;
        sinFiltro = !p.error;
      }
      if (a.error || a.status === 0) {
        setErr(
          pareceSinRed(a.error, a.status)
            ? 'Sin señal: no se pudieron leer los asignados.'
            : 'No se pudieron leer los asignados: ' + (a.error?.message || '')
        );
      }
      if (p.error || p.status === 0) {
        // Antes la lista vacía decía solo "no hay monitoristas"; ahora se
        // distingue de un error de lectura (rutas, 5-oct-2026).
        const msg = pareceSinRed(p.error, p.status)
          ? 'Sin señal: no se pudo leer la lista de monitoristas.'
          : 'No se pudo leer la lista de monitoristas: ' + (p.error?.message || '');
        setErr((e) => (e ? e + ' ' : '') + msg);
      }
      setGemela(gem);
      setAsig((a.data as Asig[] | null) || []);
      // (corrector, 5-oct-2026) Se normaliza la forma: una versión de
      // prueba de usuarios_asignables_ruta regresaba `correo` en vez de
      // `email` y `p.email.toLowerCase()` tumbaba todo Rutas. Fila sin
      // correo = fuera.
      const filas = (p.data as { email?: string | null; correo?: string | null; nombre?: string | null }[] | null) || [];
      setPersonas(
        filas
          .map((x) => {
            const email = String(x.email ?? x.correo ?? '').trim().toLowerCase();
            return { email, nombre: String(x.nombre || '').trim() || email.split('@')[0] };
          })
          .filter((x) => x.email !== '')
      );
      setSinFiltroUnidad(sinFiltro);
      setCargando(false);
    })();
    return () => {
      activo = false;
    };
  }, [ruta.id, ruta.nombre, ruta.unidad_negocio, ruta.tipo_medio, esBiobox, recarga]);

  const deEsta = asig.filter((a) => a.ruta_id === ruta.id);
  const deGemela = gemela ? asig.filter((a) => a.ruta_id === gemela.id) : [];
  const nombreDe = useMemo(() => {
    const m = new Map(personas.map((p) => [p.email.toLowerCase(), p.nombre] as [string, string]));
    return (correo: string) => m.get(correo.toLowerCase()) || correo.split('@')[0];
  }, [personas]);

  const candidatos = useMemo(() => {
    const ya = new Set(deEsta.map((a) => a.usuario_email.toLowerCase()));
    const t = sinAcentos(q.trim());
    return personas
      .filter((p) => !ya.has(p.email.toLowerCase()))
      .filter((p) => !t || sinAcentos(p.nombre).includes(t) || sinAcentos(p.email).includes(t));
  }, [personas, deEsta, q]);

  const asignar = async (p: Persona) => {
    if (ocupado) return;
    setOcupado(true);
    setErrAccion('');
    setAviso('');
    try {
      if (!(await haySesionReal())) {
        if (vivo.current) setErrAccion('Tu sesión se está reconectando. Espera unos segundos y vuelve a intentar.');
        return;
      }
      const yo = await correoDeSesion();
      const rutas = [ruta.id];
      if (gemela && conGemela && !deGemela.some((a) => a.usuario_email.toLowerCase() === p.email.toLowerCase()))
        rutas.push(gemela.id);
      let hechas = 0;
      for (const rid of rutas) {
        const { data, error, status } = await sb
          .from('ruta_asignaciones')
          .insert({ ruta_id: rid, usuario_email: p.email.toLowerCase(), asignado_por: yo || null })
          .select('id')
          .abortSignal(tope(TOPE_LECTURA_MS));
        if (!vivo.current) return;
        if (error || status === 0) {
          // 23505 = ya estaba asignada: no es un error para el coordinador.
          if (error?.code === '23505' || /duplicate/i.test(error?.message || '')) continue;
          // El trigger de la base rechaza a quien no tiene la unidad de la
          // ruta (rutas, 5-oct-2026): su mensaje ya está escrito para el
          // coordinador, se enseña tal cual.
          const deLaGemela = rid !== ruta.id && gemela ? ` (Ruta ${gemela.numero} de ${gemela.tipo_medio})` : '';
          setErrAccion(
            pareceSinRed(error, status)
              ? 'Sin señal: no se pudo asignar. Vuelve a intentar.'
              : `No se asignó a ${p.nombre}${deLaGemela}: ` + (error?.message || 'la base lo rechazó.')
          );
          break;
        }
        if (!data || (data as unknown[]).length === 0) {
          setErrAccion('La base no aceptó la asignación (¿sin permiso de coordinador?).');
          break;
        }
        hechas++;
      }
      if (hechas > 0)
        setAviso(
          `${p.nombre} recibirá una notificación y verá la ruta en «${dondeLaVe}»` +
            (hechas > 1 ? ` (también la Ruta ${gemela?.numero} de ${gemela?.tipo_medio}).` : '.')
        );
      setQ('');
      setRecarga((n) => n + 1);
    } finally {
      if (vivo.current) setOcupado(false);
    }
  };

  const quitar = async (a: Asig) => {
    if (ocupado) return;
    const gem = gemela
      ? deGemela.find((g) => g.usuario_email.toLowerCase() === a.usuario_email.toLowerCase())
      : undefined;
    const quien = nombreDe(a.usuario_email);
    if (
      !confirm(
        `¿Quitarle la Ruta ${ruta.numero} a ${quien}?` +
          (gem ? ` También se le quita la Ruta ${gemela!.numero} de ${gemela!.tipo_medio}.` : '') +
          ' Le llegará un aviso.'
      )
    )
      return;
    setOcupado(true);
    setErrAccion('');
    setAviso('');
    try {
      if (!(await haySesionReal())) {
        if (vivo.current) setErrAccion('Tu sesión se está reconectando. Espera unos segundos y vuelve a intentar.');
        return;
      }
      const ids = gem ? [a.id, gem.id] : [a.id];
      const { data, error, status } = await sb
        .from('ruta_asignaciones')
        .delete()
        .in('id', ids)
        .select('id')
        .abortSignal(tope(TOPE_LECTURA_MS));
      if (!vivo.current) return;
      if (error || status === 0) {
        setErrAccion(
          pareceSinRed(error, status)
            ? 'Sin señal: no se pudo quitar. Vuelve a intentar.'
            : 'No se pudo quitar: ' + (error?.message || '')
        );
        return;
      }
      if (!data || (data as unknown[]).length === 0) {
        setErrAccion('La base no quitó la asignación (¿sin permiso de coordinador?).');
        return;
      }
      setRecarga((n) => n + 1);
    } finally {
      if (vivo.current) setOcupado(false);
    }
  };

  return (
    <div className="rt-seccion">
      <div className="rt-seccion-tit"><Ic i={User} />Monitoristas asignados</div>
      {cargando && (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          <span className="spinner" />
          Cargando…
        </div>
      )}
      {!cargando && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {deEsta.length === 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Nadie todavía.</span>}
            {deEsta.map((a) => (
              <span key={a.id} className="pill" style={{ background: fondoTono('azul'), color: colorTono('azul') }}>
                {nombreDe(a.usuario_email)}
                <button
                  type="button"
                  className="btn-icono"
                  onClick={() => quitar(a)}
                  disabled={ocupado}
                  aria-label={`Quitar la ruta a ${a.usuario_email}`}
                  style={{ minWidth: 32, minHeight: 32, margin: '-8px 0 -8px 2px', fontSize: 13, fontWeight: 800, color: 'inherit' }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>

          {gemela && (
            <label className="rt-check">
              <input type="checkbox" checked={conGemela} onChange={(e) => setConGemela(e.target.checked)} />
              Asignar también la Ruta {gemela.numero} de {gemela.tipo_medio} (mismo nombre: es la otra mitad de las
              máquinas)
              {deGemela.length > 0 && ` · ya la tienen: ${deGemela.map((g) => nombreDe(g.usuario_email)).join(', ')}`}
            </label>
          )}

          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar monitorista por nombre o correo"
            style={{ marginTop: 8 }}
            disabled={ocupado}
          />
          {q.trim() !== '' && (
            <div className="rt-lista" style={{ maxHeight: 220, marginTop: 6 }}>
              {candidatos.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--muted)', padding: 8 }}>Nadie con ese nombre.</div>
              )}
              {candidatos.slice(0, 30).map((p) => (
                <div key={p.email} className="rt-fila">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="rt-fila-tit">{p.nombre}</div>
                    <div className="rt-fila-sub">{p.email}</div>
                  </div>
                  <button type="button" className="btn sm" onClick={() => asignar(p)} disabled={ocupado}>
                    Asignar
                  </button>
                </div>
              ))}
            </div>
          )}
          {personas.length === 0 && !err && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
              {sinFiltroUnidad
                ? 'No hay monitoristas para asignar.'
                : `No hay monitoristas con la unidad ${ruta.unidad_negocio}. Dásela desde Usuarios para poder asignarle la ruta.`}
            </div>
          )}
          {sinFiltroUnidad && (
            <div style={{ fontSize: 11, color: colorTono('ambar'), marginTop: 6 }}>
              ⚠ La base todavía no filtra por unidad: la lista trae a todos los monitoristas. Asigna solo a quien
              tenga {ruta.unidad_negocio}; si no la tiene, no verá la ruta.
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
            Al asignar, al monitorista le llega una notificación y la ruta aparece en su sección «{dondeLaVe}».
          </div>
        </>
      )}
      {aviso && <div className="ok-msg" style={{ marginTop: 8, marginBottom: 0 }}>{aviso}</div>}
      {err && <div className="err" style={{ marginTop: 8, marginBottom: 0 }}>{err}</div>}
      {errAccion && <div className="err" style={{ marginTop: 8, marginBottom: 0 }}>{errAccion}</div>}
    </div>
  );
}
