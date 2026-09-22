// ============================================================
// src/modules/bitacora-vv/BitacoraVVView.tsx
// Bitácora de Vía Verde: campañas, pautas y versiones.
//
// SUSTITUYE AL EXCEL "BITACORA <MES>": cada hoja de campaña de ese archivo
// es aquí una campaña con sus renglones de pauta. La diferencia de fondo no
// es la captura — es que un CAMBIO DE VERSIÓN deja de ser un correo: cierra
// la vigencia anterior, abre la nueva, y el historial (que escribe un
// trigger, no esta vista) guarda quién y cuándo. Fase 2: notificar a pautas.
//
// Reglas que el Excel no podía validar y aquí sí:
//   · La vigencia de una pauta vive DENTRO de las fechas de la campaña.
//   · Empalmes: si un espacio ya está pautado en esas fechas se avisa con
//     lista, pero se deja continuar — comercial revisa disponibilidad entre
//     ellos y hay bonus legítimos encimados (Erik, 22-sep-2026).
// ============================================================
import { useState, useEffect, useMemo, useCallback } from 'react';
import { sb } from '../../lib/supabase';
import { prepararArchivos } from '../../lib/comprimirImagen';
import {
  aFotosLocales,
  revocarPreviews,
  subirFotos,
  type FotoLocal,
} from '../../lib/storage';

type Espacio = {
  clave: string;
  tipo_espacio: 'columna' | 'portico';
  tramo: string | null;
  tipo: string | null;
  sitio: string | null;
  nombre: string | null;
  activo: boolean;
};

type Campana = {
  id: number;
  cliente: string;
  nombre: string;
  vendedor: string | null;
  administrador: string | null;
  quantum: string | null;
  fecha_inicio: string;
  fecha_fin: string;
  mediamonitor: boolean;
  espec_tomas: string | null;
  estatus: string;
  creada_por: string;
};

type Pauta = {
  id: number;
  campana_id: number;
  espacio_clave: string;
  tipo_venta: string;
  version: string;
  inicio: string;
  fin: string;
  horario_lv: string;
  horario_sd: string;
  testigos: boolean;
  observaciones: string | null;
  estatus: string;
};

type Hist = {
  id: number;
  accion: string;
  detalle: string | null;
  hecho_por: string;
  hecho_en: string;
};

/** Un visual de una versión: HOMBRE-MEX_A.jpg, MATADOR_PORT.jpg… */
type Arte = {
  id: number;
  campana_id: number;
  version: string;
  etiqueta: string | null;
  url: string;
  subido_por: string;
};

const EST_PAUTA: Record<string, { l: string; c: string; bg: string }> = {
  por_programar: { l: 'Por programar', c: 'var(--warn)', bg: '#2e2413' },
  programada: { l: 'Programada', c: 'var(--ok)', bg: '#12291c' },
  cerrada: { l: 'Cerrada', c: 'var(--muted)', bg: '#252b35' },
};

const HORARIO_FULL = '00:00 - 23:59HRS';

function fechaCorta(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return `${Number(d)} ${meses[Number(m) - 1]} ${a}`;
}

/** Suma días a una fecha ISO sin pelearse con zonas horarias. */
function sumarDias(iso: string, dias: number): string {
  const d = new Date(iso.slice(0, 10) + 'T12:00:00');
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Nombre presentable de un espacio: '414 (A)' o 'San Antonio Norte'. */
function nombreEspacio(e: Espacio): string {
  if (e.tipo_espacio === 'portico') return `${e.sitio} ${e.nombre}`;
  return e.clave;
}

/**
 * Grupo de renglones que comparten versión y vigencia: es la unidad con la
 * que se piensa la bitácora ("esta versión, en estas columnas, estas
 * fechas") y sobre la que operan los botones.
 */
type Grupo = {
  key: string;
  version: string;
  tipo_venta: string;
  inicio: string;
  fin: string;
  horario_lv: string;
  horario_sd: string;
  testigos: boolean;
  observaciones: string | null;
  filas: Pauta[];
  estatus: string; // el común, o 'mixto'
};

function agrupar(pautas: Pauta[]): Grupo[] {
  const m = new Map<string, Grupo>();
  pautas.forEach((p) => {
    const key = [p.version, p.tipo_venta, p.inicio, p.fin, p.horario_lv, p.horario_sd].join('|');
    const g = m.get(key);
    if (g) {
      g.filas.push(p);
      if (g.estatus !== p.estatus) g.estatus = 'mixto';
    } else {
      m.set(key, {
        key,
        version: p.version,
        tipo_venta: p.tipo_venta,
        inicio: p.inicio,
        fin: p.fin,
        horario_lv: p.horario_lv,
        horario_sd: p.horario_sd,
        testigos: p.testigos,
        observaciones: p.observaciones,
        filas: [p],
        estatus: p.estatus,
      });
    }
  });
  // Vigencia más reciente arriba; a igual inicio, VENTA antes que BONUS.
  return [...m.values()].sort(
    (a, b) => b.inicio.localeCompare(a.inicio) || a.tipo_venta.localeCompare(b.tipo_venta)
  );
}

// ------------------------------------------------------------
// Formulario de campaña (alta y edición comparten el mismo modal)
// ------------------------------------------------------------
type CampForm = {
  cliente: string;
  nombre: string;
  vendedor: string;
  administrador: string;
  quantum: string;
  fecha_inicio: string;
  fecha_fin: string;
  mediamonitor: boolean;
  espec_tomas: string;
};

const CAMP_VACIA: CampForm = {
  cliente: '', nombre: '', vendedor: '', administrador: '', quantum: '',
  fecha_inicio: '', fecha_fin: '', mediamonitor: false, espec_tomas: '',
};

function BitacoraVVView({
  email,
  puedeCapturar,
  puedeProgramar,
}: {
  email: string;
  puedeCapturar: boolean;
  puedeProgramar: boolean;
}) {
  const [espacios, setEspacios] = useState<Espacio[]>([]);
  const [campanas, setCampanas] = useState<Campana[]>([]);
  const [pautas, setPautas] = useState<Pauta[]>([]);
  const [artes, setArtes] = useState<Arte[]>([]);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');

  const [q, setQ] = useState('');
  const [verCerradas, setVerCerradas] = useState(false);
  const [campSel, setCampSel] = useState<Campana | null>(null);

  // Modales
  const [formCamp, setFormCamp] = useState<CampForm | null>(null);
  const [editando, setEditando] = useState<number | null>(null); // id si es edición
  const [addPauta, setAddPauta] = useState(false);
  const [cambioDe, setCambioDe] = useState<Grupo | null>(null);
  const [guardando, setGuardando] = useState(false);

  // Historial de la campaña abierta (se pide al desplegarlo, no antes)
  const [histAbierto, setHistAbierto] = useState(false);
  const [hist, setHist] = useState<Hist[] | null>(null);

  const cargar = useCallback(async () => {
    setErr('');
    const [re, rc, rp, ra] = await Promise.all([
      sb.from('vv_espacios').select('*').eq('activo', true).order('clave'),
      sb.from('vv_campanas').select('*').order('fecha_inicio', { ascending: false }),
      sb.from('vv_pautas').select('*').order('inicio'),
      sb.from('vv_artes').select('*').order('version').order('etiqueta'),
    ]);
    const e = re.error || rc.error || rp.error || ra.error;
    if (e) setErr('No se pudo cargar la bitácora: ' + e.message);
    setEspacios((re.data as Espacio[]) || []);
    setCampanas((rc.data as Campana[]) || []);
    setPautas((rp.data as Pauta[]) || []);
    setArtes((ra.data as Arte[]) || []);
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const porClave = useMemo(() => {
    const m: Record<string, Espacio> = {};
    espacios.forEach((e) => (m[e.clave] = e));
    return m;
  }, [espacios]);

  const pautasDe = useMemo(() => {
    const m = new Map<number, Pauta[]>();
    pautas.forEach((p) => {
      const arr = m.get(p.campana_id) || [];
      arr.push(p);
      m.set(p.campana_id, arr);
    });
    return m;
  }, [pautas]);

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return campanas.filter((c) => {
      if (!verCerradas && c.estatus === 'cerrada') return false;
      if (!t) return true;
      return (
        c.cliente.toLowerCase().includes(t) ||
        c.nombre.toLowerCase().includes(t) ||
        (c.quantum || '').toLowerCase().includes(t)
      );
    });
  }, [campanas, q, verCerradas]);

  // La seleccionada, siempre fresca tras recargar.
  const campana = useMemo(
    () => (campSel ? campanas.find((c) => c.id === campSel.id) || null : null),
    [campSel, campanas]
  );
  const grupos = useMemo(
    () => (campana ? agrupar(pautasDe.get(campana.id) || []) : []),
    [campana, pautasDe]
  );

  const abrirCampana = (c: Campana) => {
    setCampSel(c);
    setHistAbierto(false);
    setHist(null);
  };

  // ------------------------------------------------------------
  // Campaña: guardar (alta o edición) y cerrar
  // ------------------------------------------------------------
  const guardarCampana = async () => {
    if (!formCamp) return;
    const f = formCamp;
    if (!f.cliente.trim() || !f.nombre.trim() || !f.fecha_inicio || !f.fecha_fin) {
      alert('Cliente, campaña y las dos fechas son obligatorios.');
      return;
    }
    if (f.fecha_fin < f.fecha_inicio) {
      alert('La fecha fin no puede ser antes del inicio.');
      return;
    }
    setGuardando(true);
    const datos = {
      cliente: f.cliente.trim(),
      nombre: f.nombre.trim(),
      vendedor: f.vendedor.trim() || null,
      administrador: f.administrador.trim() || null,
      quantum: f.quantum.trim() || null,
      fecha_inicio: f.fecha_inicio,
      fecha_fin: f.fecha_fin,
      mediamonitor: f.mediamonitor,
      espec_tomas: f.espec_tomas.trim() || null,
    };
    if (editando) {
      const { error } = await sb.from('vv_campanas').update(datos).eq('id', editando);
      if (error) alert('No se pudo guardar: ' + error.message);
    } else {
      const { data, error } = await sb
        .from('vv_campanas')
        .insert({ ...datos, creada_por: email })
        .select()
        .single();
      if (error) alert('No se pudo crear la campaña: ' + error.message);
      else if (data) setCampSel(data as Campana);
    }
    setGuardando(false);
    setFormCamp(null);
    setEditando(null);
    cargar();
  };

  const cerrarCampana = async (c: Campana) => {
    if (!confirm(`¿Cerrar la campaña "${c.nombre}"? Sus pautas dejan de contar como vigentes.`)) return;
    const { error } = await sb.from('vv_campanas').update({ estatus: 'cerrada' }).eq('id', c.id);
    if (error) alert('No se pudo cerrar: ' + error.message);
    cargar();
  };

  // ------------------------------------------------------------
  // Empalmes: mismas fechas, mismo espacio, en cualquier campaña no
  // cerrada. Devuelve las líneas del aviso, o [] si está libre.
  // ------------------------------------------------------------
  const buscarEmpalmes = async (
    claves: string[],
    inicio: string,
    fin: string,
    exceptoIds: number[]
  ): Promise<string[]> => {
    const { data } = await sb
      .from('vv_pautas')
      .select('id,espacio_clave,version,inicio,fin,campana_id,vv_campanas(cliente,nombre)')
      .in('espacio_clave', claves)
      .neq('estatus', 'cerrada')
      .lte('inicio', fin)
      .gte('fin', inicio);
    return ((data as unknown as (Pauta & { vv_campanas: { cliente: string; nombre: string } | null })[]) || [])
      .filter((p) => !exceptoIds.includes(p.id))
      .map(
        (p) =>
          `· ${p.espacio_clave}: ${p.vv_campanas?.nombre || 'otra campaña'} (${p.version}) ${fechaCorta(p.inicio)}–${fechaCorta(p.fin)}`
      );
  };

  // ------------------------------------------------------------
  // Alta de pauta (un renglón por espacio elegido)
  // ------------------------------------------------------------
  const [nf, setNf] = useState({
    version: '',
    tipo_venta: 'VENTA',
    inicio: '',
    fin: '',
    horario_lv: HORARIO_FULL,
    horario_sd: HORARIO_FULL,
    testigos: false,
    observaciones: '',
    claves: [] as string[],
  });

  const abrirAddPauta = () => {
    if (!campana) return;
    setNf({
      version: '',
      tipo_venta: 'VENTA',
      inicio: campana.fecha_inicio,
      fin: campana.fecha_fin,
      horario_lv: HORARIO_FULL,
      horario_sd: HORARIO_FULL,
      testigos: false,
      observaciones: '',
      claves: [],
    });
    setAddPauta(true);
  };

  const guardarPauta = async () => {
    if (!campana) return;
    if (!nf.version.trim()) return alert('Falta la versión (nombre del arte).');
    if (!nf.claves.length) return alert('Elige al menos un espacio.');
    if (!nf.inicio || !nf.fin || nf.fin < nf.inicio)
      return alert('Revisa la vigencia: fin no puede ser antes del inicio.');
    if (nf.inicio < campana.fecha_inicio || nf.fin > campana.fecha_fin)
      return alert(
        `La vigencia debe caer dentro de la campaña (${fechaCorta(campana.fecha_inicio)} – ${fechaCorta(campana.fecha_fin)}).`
      );
    if (!nf.horario_lv.trim() || !nf.horario_sd.trim())
      return alert('Los horarios no pueden quedar vacíos: el formato exige cubrir el día completo o la franja explícita.');

    setGuardando(true);
    const empalmes = await buscarEmpalmes(nf.claves, nf.inicio, nf.fin, []);
    if (empalmes.length) {
      const sigue = confirm(
        `OJO — ${empalmes.length} empalme(s) en esas fechas:\n\n${empalmes.slice(0, 12).join('\n')}${empalmes.length > 12 ? '\n…' : ''}\n\n¿Continuar de todos modos?`
      );
      if (!sigue) {
        setGuardando(false);
        return;
      }
    }
    const filas = nf.claves.map((clave) => ({
      campana_id: campana.id,
      espacio_clave: clave,
      tipo_venta: nf.tipo_venta,
      version: nf.version.trim(),
      inicio: nf.inicio,
      fin: nf.fin,
      horario_lv: nf.horario_lv.trim(),
      horario_sd: nf.horario_sd.trim(),
      testigos: nf.testigos,
      observaciones: nf.observaciones.trim() || null,
      creada_por: email,
    }));
    const { error } = await sb.from('vv_pautas').insert(filas);
    if (error) alert('No se pudo guardar la pauta: ' + error.message);
    else setAddPauta(false);
    setGuardando(false);
    cargar();
  };

  // ------------------------------------------------------------
  // Cambio de versión: cierra la vigencia anterior y abre la nueva.
  // Los mismos espacios, mismo horario; solo cambian versión y fechas.
  // ------------------------------------------------------------
  const [cv, setCv] = useState({ version: '', desde: '' });

  const guardarCambioVersion = async () => {
    if (!campana || !cambioDe) return;
    const g = cambioDe;
    if (!cv.version.trim()) return alert('Falta la versión nueva.');
    if (!cv.desde || cv.desde <= g.inicio || cv.desde > g.fin)
      return alert(
        `La fecha de cambio debe caer dentro de la vigencia actual (después del ${fechaCorta(g.inicio)} y hasta el ${fechaCorta(g.fin)}).`
      );
    setGuardando(true);
    const ids = g.filas.map((f) => f.id);
    // 1) La vigencia vieja termina el día ANTERIOR al cambio.
    const { error: e1 } = await sb
      .from('vv_pautas')
      .update({ fin: sumarDias(cv.desde, -1) })
      .in('id', ids);
    if (e1) {
      alert('No se pudo cerrar la vigencia anterior: ' + e1.message);
      setGuardando(false);
      return;
    }
    // 2) Nace la nueva, por programar. El historial lo firma el trigger.
    const filas = g.filas.map((f) => ({
      campana_id: campana.id,
      espacio_clave: f.espacio_clave,
      tipo_venta: f.tipo_venta,
      version: cv.version.trim(),
      inicio: cv.desde,
      fin: g.fin,
      horario_lv: f.horario_lv,
      horario_sd: f.horario_sd,
      testigos: f.testigos,
      observaciones: f.observaciones,
      creada_por: email,
    }));
    const { error: e2 } = await sb.from('vv_pautas').insert(filas);
    if (e2) alert('La vigencia anterior se cerró pero la nueva no se pudo crear: ' + e2.message);
    else setCambioDe(null);
    setGuardando(false);
    cargar();
  };

  const marcarProgramada = async (g: Grupo) => {
    const ids = g.filas.filter((f) => f.estatus === 'por_programar').map((f) => f.id);
    if (!ids.length) return;
    const { error } = await sb.from('vv_pautas').update({ estatus: 'programada' }).in('id', ids);
    if (error) alert('No se pudo marcar: ' + error.message);
    cargar();
  };

  const quitarGrupo = async (g: Grupo) => {
    if (
      !confirm(
        `¿Quitar "${g.version}" (${g.filas.length} espacio${g.filas.length === 1 ? '' : 's'}, ${fechaCorta(g.inicio)}–${fechaCorta(g.fin)})? Quedará registrado en el historial.`
      )
    )
      return;
    const { error } = await sb
      .from('vv_pautas')
      .delete()
      .in('id', g.filas.map((f) => f.id));
    if (error) alert('No se pudo quitar: ' + error.message);
    cargar();
  };

  const abrirHistorial = async () => {
    if (histAbierto) {
      setHistAbierto(false);
      return;
    }
    setHistAbierto(true);
    if (hist || !campana) return;
    const { data } = await sb
      .from('vv_pauta_historial')
      .select('id,accion,detalle,hecho_por,hecho_en')
      .eq('campana_id', campana.id)
      .order('hecho_en', { ascending: false })
      .limit(120);
    setHist((data as Hist[]) || []);
  };

  // ------------------------------------------------------------
  // Artes: los visuales de cada versión (como venían pegados en el Excel)
  // ------------------------------------------------------------
  const artesDe = useMemo(() => {
    const m = new Map<number, Arte[]>();
    artes.forEach((a) => {
      const arr = m.get(a.campana_id) || [];
      arr.push(a);
      m.set(a.campana_id, arr);
    });
    return m;
  }, [artes]);

  /**
   * Artes que ilustran una versión de pauta. Primero el empate exacto; si
   * no hay, por contención en ambos sentidos: la pauta de Amazon decía
   * "R1_HOMBRE-MEX / R1_MATADOR / R1_MUJER-MEX" y los artes se registran
   * de uno en uno.
   */
  const artesParaVersion = (campanaId: number, version: string): Arte[] => {
    const lista = artesDe.get(campanaId) || [];
    const v = version.trim().toUpperCase();
    const exactos = lista.filter((a) => a.version.trim().toUpperCase() === v);
    if (exactos.length) return exactos;
    return lista.filter((a) => {
      const av = a.version.trim().toUpperCase();
      return av.length >= 3 && (v.includes(av) || av.includes(v));
    });
  };

  const [verArte, setVerArte] = useState<Arte | null>(null);
  const [subiendoArtes, setSubiendoArtes] = useState(false);
  const [sa, setSa] = useState<{ version: string; fotos: FotoLocal[] } | null>(null);

  const cerrarSubirArtes = () => {
    if (sa) revocarPreviews(sa.fotos);
    setSa(null);
  };

  const guardarArtes = async () => {
    if (!campana || !sa) return;
    if (!sa.version.trim()) return alert('Falta a qué versión pertenecen estos artes.');
    if (!sa.fotos.length) return alert('Elige al menos una imagen.');
    setSubiendoArtes(true);
    try {
      const { listos, rechazos } = await prepararArchivos(sa.fotos.map((f) => f.file));
      if (rechazos.length) alert(rechazos.join('\n'));
      if (!listos.length) return;
      const urls = await subirFotos(
        listos.map((file) => ({ file, preview: '' })),
        'bitacora-vv',
        `c${campana.id}_${sa.version}`
      );
      const filas = urls.map((url, i) => ({
        campana_id: campana.id,
        version: sa.version.trim(),
        // La variante viene del nombre del archivo: HOMBRE-MEX_A.jpg → HOMBRE-MEX_A
        etiqueta: (listos[i].name || '').replace(/\.[^.]+$/, '') || null,
        url,
        subido_por: email,
      }));
      const { error } = await sb.from('vv_artes').insert(filas);
      if (error) alert('Las imágenes subieron pero no se pudieron registrar: ' + error.message);
      else cerrarSubirArtes();
      cargar();
    } catch (e) {
      alert('No se pudieron subir los artes: ' + (e as Error).message);
    } finally {
      setSubiendoArtes(false);
    }
  };

  const quitarArte = async (a: Arte) => {
    if (!confirm(`¿Quitar el arte "${a.etiqueta || a.version}"?`)) return;
    const { error } = await sb.from('vv_artes').delete().eq('id', a.id);
    if (error) alert('No se pudo quitar: ' + error.message);
    cargar();
  };

  // ------------------------------------------------------------
  // Selector de espacios del modal de pauta
  // ------------------------------------------------------------
  const toggleClave = (clave: string) =>
    setNf((f) => ({
      ...f,
      claves: f.claves.includes(clave)
        ? f.claves.filter((c) => c !== clave)
        : [...f.claves, clave],
    }));

  const setClaves = (claves: string[]) => setNf((f) => ({ ...f, claves }));

  const columnasCDMX = espacios.filter((e) => e.tipo_espacio === 'columna' && e.tramo === 'CDMX');
  const columnasEdoMex = espacios.filter(
    (e) => e.tipo_espacio === 'columna' && e.tramo !== 'CDMX'
  );
  const porticos = espacios.filter((e) => e.tipo_espacio === 'portico');

  const chipEspacio = (e: Espacio) => {
    const activo = nf.claves.includes(e.clave);
    return (
      <button
        key={e.clave}
        type="button"
        onClick={() => toggleClave(e.clave)}
        title={e.tipo_espacio === 'portico' ? `${e.sitio} ${e.nombre} · ${e.clave}` : `Tipo ${e.tipo}`}
        style={{
          padding: '5px 9px',
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
          border: '1px solid ' + (activo ? 'var(--accent)' : 'var(--line)'),
          background: activo ? 'var(--accent)' : 'var(--panel2)',
          color: activo ? '#151515' : 'var(--txt)',
        }}
      >
        {nombreEspacio(e)}
      </button>
    );
  };

  // ------------------------------------------------------------
  // Render
  // ------------------------------------------------------------
  if (cargando) return <div className="loading">Cargando la bitácora…</div>;

  // ---------- Detalle de una campaña ----------
  if (campana) {
    const totalEspacios = new Set((pautasDe.get(campana.id) || []).map((p) => p.espacio_clave)).size;
    return (
      <>
        <div className="toolbar" style={{ alignItems: 'center' }}>
          <button className="btn ghost sm" onClick={() => setCampSel(null)}>
            ← Campañas
          </button>
          <span className="tag">{campana.cliente}</span>
          {campana.quantum && <span className="tag">QTM {campana.quantum}</span>}
          {campana.estatus === 'cerrada' && (
            <span className="pill" style={{ background: '#252b35', color: 'var(--muted)' }}>
              Cerrada
            </span>
          )}
        </div>

        <h2 className="page" style={{ marginTop: 4 }}>
          {campana.nombre}
        </h2>
        <p className="phint">
          {fechaCorta(campana.fecha_inicio)} – {fechaCorta(campana.fecha_fin)}
          {campana.vendedor && <> · Vendedor: {campana.vendedor}</>}
          {campana.administrador && <> · Admin: {campana.administrador}</>}
          {' · '}Mediamonitor: {campana.mediamonitor ? 'SÍ' : 'NO'}
          {totalEspacios > 0 && <> · {totalEspacios} espacio{totalEspacios === 1 ? '' : 's'}</>}
        </p>
        {campana.espec_tomas && (
          <p className="phint" style={{ marginTop: -6 }}>
            📸 {campana.espec_tomas}
          </p>
        )}

        {err && (
          <div className="err" onClick={() => setErr('')}>
            {err}
          </div>
        )}

        <div className="toolbar">
          {puedeCapturar && campana.estatus === 'activa' && (
            <button className="btn" onClick={abrirAddPauta}>
              ➕ Agregar pauta
            </button>
          )}
          {puedeCapturar && (
            <button
              className="btn ghost"
              onClick={() => {
                setEditando(campana.id);
                setFormCamp({
                  cliente: campana.cliente,
                  nombre: campana.nombre,
                  vendedor: campana.vendedor || '',
                  administrador: campana.administrador || '',
                  quantum: campana.quantum || '',
                  fecha_inicio: campana.fecha_inicio,
                  fecha_fin: campana.fecha_fin,
                  mediamonitor: campana.mediamonitor,
                  espec_tomas: campana.espec_tomas || '',
                });
              }}
            >
              ✏️ Editar datos
            </button>
          )}
          <button className="btn ghost" onClick={abrirHistorial}>
            {histAbierto ? 'Ocultar historial' : '🕓 Historial'}
          </button>
          {puedeCapturar && campana.estatus === 'activa' && (
            <button className="btn ghost" onClick={() => cerrarCampana(campana)}>
              Cerrar campaña
            </button>
          )}
        </div>

        {histAbierto && (
          <div className="inc" style={{ marginBottom: 14 }}>
            <div className="folio">HISTORIAL — todo lo que ha pasado en esta campaña</div>
            {!hist ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Cargando…</div>
            ) : hist.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                Sin movimientos todavía.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                {hist.map((h) => (
                  <div key={h.id} style={{ fontSize: 12, lineHeight: 1.5 }}>
                    <span style={{ color: 'var(--muted)' }}>
                      {fechaCorta(h.hecho_en)}{' '}
                      {new Date(h.hecho_en).toLocaleTimeString('es-MX', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>{' '}
                    · <b>{h.accion}</b> — {h.detalle}
                    <span style={{ color: 'var(--muted)' }}> · {h.hecho_por.split('@')[0]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(() => {
          // Galería de artes agrupada por versión — el equivalente a los
          // visuales pegados en cada hoja del Excel.
          const deCampana = artesDe.get(campana.id) || [];
          const porVersion = new Map<string, Arte[]>();
          deCampana.forEach((a) => {
            const arr = porVersion.get(a.version) || [];
            arr.push(a);
            porVersion.set(a.version, arr);
          });
          return (
            <div className="inc" style={{ marginBottom: 14 }}>
              <div className="inc-top">
                <div className="folio">🎨 ARTES POR VERSIÓN</div>
                {puedeCapturar && campana.estatus === 'activa' && (
                  <button
                    className="btn ghost sm"
                    onClick={() => setSa({ version: '', fotos: [] })}
                  >
                    ➕ Subir artes
                  </button>
                )}
              </div>
              {deCampana.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                  Sin visuales todavía. Sube aquí las imágenes de cada versión
                  (como venían pegadas en el Excel) para que pautas sepa qué
                  debe quedar al aire.
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
                  {[...porVersion.entries()].map(([v, lista]) => (
                    <div key={v}>
                      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                        {v}{' '}
                        <span style={{ color: 'var(--muted)', fontWeight: 400 }}>
                          · {lista.length} arte{lista.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {lista.map((a) => (
                          <div key={a.id} style={{ width: 74, textAlign: 'center' }}>
                            <img
                              src={a.url}
                              alt={a.etiqueta || a.version}
                              onClick={() => setVerArte(a)}
                              style={{
                                width: 74,
                                height: 104,
                                objectFit: 'cover',
                                borderRadius: 8,
                                border: '1px solid var(--line)',
                                cursor: 'pointer',
                                display: 'block',
                              }}
                            />
                            <div
                              style={{
                                fontSize: 10,
                                color: 'var(--muted)',
                                marginTop: 3,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={a.etiqueta || ''}
                            >
                              {a.etiqueta || '—'}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {grupos.length === 0 ? (
          <div className="empty">
            Sin pautas todavía. {puedeCapturar ? 'Agrega la primera con "➕ Agregar pauta".' : ''}
          </div>
        ) : (
          <div className="inc-list">
            {grupos.map((g) => {
              const est = EST_PAUTA[g.estatus] || {
                l: 'Mixto',
                c: 'var(--accent2)',
                bg: '#1b2536',
              };
              const puedeCambiar =
                puedeCapturar && campana.estatus === 'activa' && g.estatus !== 'cerrada';
              return (
                <div className="inc" key={g.key}>
                  <div className="inc-top">
                    <div style={{ minWidth: 0 }}>
                      <div className="titulo">{g.version}</div>
                      <div className="meta">
                        {fechaCorta(g.inicio)} – {fechaCorta(g.fin)} · {g.tipo_venta}
                        {' · '}L-V {g.horario_lv} · S-D {g.horario_sd}
                        {g.testigos && ' · con testigos'}
                      </div>
                    </div>
                    <span className="pill" style={{ background: est.bg, color: est.c }}>
                      {est.l}
                    </span>
                  </div>

                  <div className="chips">
                    {g.filas
                      .slice()
                      .sort((a, b) => a.espacio_clave.localeCompare(b.espacio_clave))
                      .map((p) => {
                        const e = porClave[p.espacio_clave];
                        return (
                          <span key={p.id} className="tag" title={p.espacio_clave}>
                            {e ? nombreEspacio(e) : p.espacio_clave}
                          </span>
                        );
                      })}
                    <span className="tag" style={{ color: 'var(--accent2)' }}>
                      {g.filas.length} espacio{g.filas.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  {g.observaciones && <div className="obs">{g.observaciones}</div>}

                  {(() => {
                    // El visual junto a la versión: pautas ve QUÉ debe estar
                    // al aire, no solo cómo se llama.
                    const suyos = artesParaVersion(campana.id, g.version);
                    if (!suyos.length) return null;
                    return (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
                        {suyos.slice(0, 8).map((a) => (
                          <img
                            key={a.id}
                            src={a.url}
                            alt={a.etiqueta || a.version}
                            title={a.etiqueta || a.version}
                            onClick={() => setVerArte(a)}
                            style={{
                              width: 46,
                              height: 66,
                              objectFit: 'cover',
                              borderRadius: 6,
                              border: '1px solid var(--line)',
                              cursor: 'pointer',
                            }}
                          />
                        ))}
                      </div>
                    );
                  })()}

                  {(puedeCambiar || puedeProgramar) && (
                    <div className="inc-actions">
                      {puedeCambiar && (
                        <button
                          className="btn sm"
                          onClick={() => {
                            setCambioDe(g);
                            setCv({ version: '', desde: '' });
                          }}
                        >
                          🔁 Cambiar versión
                        </button>
                      )}
                      {puedeProgramar && g.estatus === 'por_programar' && (
                        <button className="btn ok sm" onClick={() => marcarProgramada(g)}>
                          ✓ Marcar programada
                        </button>
                      )}
                      {puedeCambiar && (
                        <button className="btn ghost sm" onClick={() => quitarGrupo(g)}>
                          🗑 Quitar
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ---------- Modal: agregar pauta ---------- */}
        {addPauta && (
          <div className="overlay" onClick={() => setAddPauta(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3 style={{ marginTop: 0 }}>Agregar pauta — {campana.nombre}</h3>

              <div className="row2">
                <div className="field">
                  <label>Versión (nombre del arte)</label>
                  <input
                    list="vv-versiones"
                    value={nf.version}
                    onChange={(e) => setNf({ ...nf, version: e.target.value })}
                    placeholder="R1_HOMBRE-MEX"
                  />
                </div>
                <div className="field">
                  <label>Tipo</label>
                  <select
                    value={nf.tipo_venta}
                    onChange={(e) => setNf({ ...nf, tipo_venta: e.target.value })}
                  >
                    <option>VENTA</option>
                    <option>BONUS</option>
                  </select>
                </div>
              </div>

              <div className="row2">
                <div className="field">
                  <label>Inicio</label>
                  <input
                    type="date"
                    value={nf.inicio}
                    min={campana.fecha_inicio}
                    max={campana.fecha_fin}
                    onChange={(e) => setNf({ ...nf, inicio: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Fin</label>
                  <input
                    type="date"
                    value={nf.fin}
                    min={campana.fecha_inicio}
                    max={campana.fecha_fin}
                    onChange={(e) => setNf({ ...nf, fin: e.target.value })}
                  />
                </div>
              </div>

              <div className="row2">
                <div className="field">
                  <label>Horario lunes a viernes</label>
                  <input
                    value={nf.horario_lv}
                    onChange={(e) => setNf({ ...nf, horario_lv: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Horario sábado y domingo</label>
                  <input
                    value={nf.horario_sd}
                    onChange={(e) => setNf({ ...nf, horario_sd: e.target.value })}
                  />
                </div>
              </div>

              <div className="field">
                <label>
                  Espacios ({nf.claves.length} elegido{nf.claves.length === 1 ? '' : 's'})
                </label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setClaves(espacios.map((e) => e.clave))}
                  >
                    FULL (todo)
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setClaves(columnasCDMX.map((e) => e.clave))}
                  >
                    Columnas CDMX
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setClaves(columnasEdoMex.map((e) => e.clave))}
                  >
                    Columnas EDO MEX
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setClaves(porticos.map((e) => e.clave))}
                  >
                    Pórticos
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => setClaves([])}>
                    Ninguno
                  </button>
                </div>

                {porticos.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 4px' }}>
                      PÓRTICOS
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {porticos.map(chipEspacio)}
                    </div>
                  </>
                )}
                <div style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 4px' }}>
                  COLUMNAS CDMX
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {columnasCDMX.map(chipEspacio)}
                </div>
                {columnasEdoMex.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 4px' }}>
                      COLUMNAS EDO MEX
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {columnasEdoMex.map(chipEspacio)}
                    </div>
                  </>
                )}
              </div>

              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={nf.testigos}
                    onChange={(e) => setNf({ ...nf, testigos: e.target.checked })}
                    style={{ width: 'auto' }}
                  />
                  Requiere testigos
                </label>
              </div>

              <div className="field">
                <label>Observaciones</label>
                <textarea
                  rows={2}
                  value={nf.observaciones}
                  onChange={(e) => setNf({ ...nf, observaciones: e.target.value })}
                  placeholder="Testigos completos al inicio y fin de mes…"
                />
              </div>

              <div className="modal-actions">
                <button className="btn ghost" onClick={() => setAddPauta(false)}>
                  Cancelar
                </button>
                <button className="btn" onClick={guardarPauta} disabled={guardando}>
                  {guardando ? 'Guardando…' : 'Guardar pauta'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---------- Modal: cambio de versión ---------- */}
        {cambioDe && (
          <div className="overlay" onClick={() => setCambioDe(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3 style={{ marginTop: 0 }}>🔁 Cambio de versión</h3>
              <p className="phint">
                Hoy: <b>{cambioDe.version}</b> en {cambioDe.filas.length} espacio
                {cambioDe.filas.length === 1 ? '' : 's'}, vigente{' '}
                {fechaCorta(cambioDe.inicio)} – {fechaCorta(cambioDe.fin)}. La vigencia
                actual se cierra el día anterior al cambio y la versión nueva queda{' '}
                <b>por programar</b>.
              </p>
              <div className="field">
                <label>Versión nueva</label>
                <input
                  list="vv-versiones"
                  value={cv.version}
                  onChange={(e) => setCv({ ...cv, version: e.target.value })}
                  placeholder="R2_MUJER-MEX"
                />
              </div>
              <div className="field">
                <label>Cambia a partir del</label>
                <input
                  type="date"
                  value={cv.desde}
                  min={sumarDias(cambioDe.inicio, 1)}
                  max={cambioDe.fin}
                  onChange={(e) => setCv({ ...cv, desde: e.target.value })}
                />
              </div>
              <div className="modal-actions">
                <button className="btn ghost" onClick={() => setCambioDe(null)}>
                  Cancelar
                </button>
                <button className="btn" onClick={guardarCambioVersion} disabled={guardando}>
                  {guardando ? 'Aplicando…' : 'Aplicar cambio'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---------- Modal: subir artes ---------- */}
        {sa && (
          <div className="overlay" onClick={() => !subiendoArtes && cerrarSubirArtes()}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3 style={{ marginTop: 0 }}>🎨 Subir artes — {campana.nombre}</h3>
              <div className="field">
                <label>Versión a la que pertenecen</label>
                <input
                  list="vv-versiones"
                  value={sa.version}
                  onChange={(e) => setSa({ ...sa, version: e.target.value })}
                  placeholder="R1_HOMBRE-MEX"
                />
              </div>
              <div className="field">
                <label>Imágenes (la variante se toma del nombre: HOMBRE-MEX_A.jpg)</label>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) =>
                    setSa({ ...sa, fotos: [...sa.fotos, ...aFotosLocales(e.target.files)] })
                  }
                />
              </div>
              {sa.fotos.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  {sa.fotos.map((f, i) => (
                    <div key={i} style={{ position: 'relative' }}>
                      <img
                        src={f.preview}
                        alt=""
                        style={{
                          width: 64,
                          height: 90,
                          objectFit: 'cover',
                          borderRadius: 8,
                          border: '1px solid var(--line)',
                          display: 'block',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setSa({ ...sa, fotos: sa.fotos.filter((_, j) => j !== i) })
                        }
                        style={{
                          position: 'absolute',
                          top: -6,
                          right: -6,
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          border: 'none',
                          background: 'var(--bad)',
                          color: '#fff',
                          fontSize: 12,
                          cursor: 'pointer',
                          lineHeight: 1,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="modal-actions">
                <button className="btn ghost" onClick={cerrarSubirArtes} disabled={subiendoArtes}>
                  Cancelar
                </button>
                <button className="btn" onClick={guardarArtes} disabled={subiendoArtes}>
                  {subiendoArtes ? (
                    <>
                      <span className="spinner" /> Subiendo…
                    </>
                  ) : (
                    'Subir'
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---------- Visor de arte ---------- */}
        {verArte && (
          <div className="overlay" onClick={() => setVerArte(null)}>
            <div
              className="modal"
              style={{ maxWidth: 420, textAlign: 'center' }}
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={verArte.url}
                alt={verArte.etiqueta || verArte.version}
                style={{
                  maxWidth: '100%',
                  maxHeight: '65vh',
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                }}
              />
              <div style={{ fontSize: 13, marginTop: 8 }}>
                <b>{verArte.version}</b>
                {verArte.etiqueta && (
                  <span style={{ color: 'var(--muted)' }}> · {verArte.etiqueta}</span>
                )}
              </div>
              <div className="modal-actions" style={{ justifyContent: 'center' }}>
                {puedeCapturar && (
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      setVerArte(null);
                      quitarArte(verArte);
                    }}
                  >
                    🗑 Quitar arte
                  </button>
                )}
                <button className="btn sm" onClick={() => setVerArte(null)}>
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Versiones conocidas de esta campaña, para autocompletar. */}
        <datalist id="vv-versiones">
          {[
            ...new Set([
              ...(artesDe.get(campana.id) || []).map((a) => a.version),
              ...grupos.map((g) => g.version),
            ]),
          ].map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>

        {formCamp && modalCampana()}
      </>
    );
  }

  // ---------- Lista de campañas ----------
  function modalCampana() {
    if (!formCamp) return null;
    const f = formCamp;
    return (
      <div
        className="overlay"
        onClick={() => {
          setFormCamp(null);
          setEditando(null);
        }}
      >
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3 style={{ marginTop: 0 }}>{editando ? 'Editar campaña' : 'Nueva campaña'}</h3>
          <div className="row2">
            <div className="field">
              <label>Cliente</label>
              <input
                value={f.cliente}
                onChange={(e) => setFormCamp({ ...f, cliente: e.target.value })}
                placeholder="AMAZON"
              />
            </div>
            <div className="field">
              <label>Campaña</label>
              <input
                value={f.nombre}
                onChange={(e) => setFormCamp({ ...f, nombre: e.target.value })}
                placeholder="AMAZON MUNDIAL"
              />
            </div>
          </div>
          <div className="row2">
            <div className="field">
              <label>Vendedor</label>
              <input
                value={f.vendedor}
                onChange={(e) => setFormCamp({ ...f, vendedor: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Administrador</label>
              <input
                value={f.administrador}
                onChange={(e) => setFormCamp({ ...f, administrador: e.target.value })}
              />
            </div>
          </div>
          <div className="row2">
            <div className="field">
              <label>Fecha inicio</label>
              <input
                type="date"
                value={f.fecha_inicio}
                onChange={(e) => setFormCamp({ ...f, fecha_inicio: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Fecha fin</label>
              <input
                type="date"
                value={f.fecha_fin}
                onChange={(e) => setFormCamp({ ...f, fecha_fin: e.target.value })}
              />
            </div>
          </div>
          <div className="row2">
            <div className="field">
              <label>Quantum (opcional)</label>
              <input
                value={f.quantum}
                onChange={(e) => setFormCamp({ ...f, quantum: e.target.value })}
                placeholder="P537897"
              />
            </div>
            <div className="field">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 22 }}>
                <input
                  type="checkbox"
                  checked={f.mediamonitor}
                  onChange={(e) => setFormCamp({ ...f, mediamonitor: e.target.checked })}
                  style={{ width: 'auto' }}
                />
                Mediamonitor
              </label>
            </div>
          </div>
          <div className="field">
            <label>Especificaciones de tomas</label>
            <textarea
              rows={2}
              value={f.espec_tomas}
              onChange={(e) => setFormCamp({ ...f, espec_tomas: e.target.value })}
              placeholder="Testigos completos de todas las columnas al inicio y fin de mes…"
            />
          </div>
          <div className="modal-actions">
            <button
              className="btn ghost"
              onClick={() => {
                setFormCamp(null);
                setEditando(null);
              }}
            >
              Cancelar
            </button>
            <button className="btn" onClick={guardarCampana} disabled={guardando}>
              {guardando ? 'Guardando…' : editando ? 'Guardar cambios' : 'Crear campaña'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <h2 className="page">Bitácora VV</h2>
      <p className="phint">
        Campañas y versiones de Vía Verde. Cada cambio de versión queda registrado con
        quién y cuándo — lo que antes se perdía en el correo.
      </p>

      {err && (
        <div className="err" onClick={() => setErr('')}>
          {err}
        </div>
      )}

      <div className="toolbar">
        <input
          className="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Cliente, campaña o Quantum…"
        />
        <button className="btn ghost sm" onClick={() => setVerCerradas((v) => !v)}>
          {verCerradas ? 'Ocultar cerradas' : 'Ver cerradas'}
        </button>
        {puedeCapturar && (
          <button
            className="btn"
            onClick={() => {
              setEditando(null);
              setFormCamp({ ...CAMP_VACIA });
            }}
          >
            ➕ Nueva campaña
          </button>
        )}
      </div>

      {visibles.length === 0 ? (
        <div className="empty">
          {campanas.length === 0
            ? 'Todavía no hay campañas. Crea la primera con "➕ Nueva campaña".'
            : 'Nada coincide con ese filtro.'}
        </div>
      ) : (
        <div className="inc-list">
          {visibles.map((c) => {
            const suyas = pautasDe.get(c.id) || [];
            const porProg = suyas.filter((p) => p.estatus === 'por_programar').length;
            const nEspacios = new Set(suyas.map((p) => p.espacio_clave)).size;
            const versiones = new Set(suyas.map((p) => p.version)).size;
            return (
              <div
                className="inc"
                key={c.id}
                style={{ cursor: 'pointer' }}
                onClick={() => abrirCampana(c)}
              >
                <div className="inc-top">
                  <div style={{ minWidth: 0 }}>
                    <div className="folio">{c.cliente}</div>
                    <div className="titulo">{c.nombre}</div>
                    <div className="meta">
                      {fechaCorta(c.fecha_inicio)} – {fechaCorta(c.fecha_fin)}
                      {c.administrador && <> · Admin: {c.administrador}</>}
                    </div>
                  </div>
                  {c.estatus === 'cerrada' ? (
                    <span className="pill" style={{ background: '#252b35', color: 'var(--muted)' }}>
                      Cerrada
                    </span>
                  ) : porProg > 0 ? (
                    <span className="pill" style={{ background: '#2e2413', color: 'var(--warn)' }}>
                      {porProg} por programar
                    </span>
                  ) : suyas.length > 0 ? (
                    <span className="pill" style={{ background: '#12291c', color: 'var(--ok)' }}>
                      Al día
                    </span>
                  ) : (
                    <span className="pill" style={{ background: '#1b2536', color: 'var(--accent2)' }}>
                      Sin pauta
                    </span>
                  )}
                </div>
                <div className="chips">
                  {nEspacios > 0 && (
                    <span className="tag">
                      {nEspacios} espacio{nEspacios === 1 ? '' : 's'}
                    </span>
                  )}
                  {versiones > 0 && (
                    <span className="tag">
                      {versiones} versi{versiones === 1 ? 'ón' : 'ones'}
                    </span>
                  )}
                  {c.mediamonitor && <span className="tag">Mediamonitor</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {formCamp && modalCampana()}
    </>
  );
}

export default BitacoraVVView;
