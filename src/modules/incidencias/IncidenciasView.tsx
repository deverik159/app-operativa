// ============================================================
// src/modules/incidencias/IncidenciasView.tsx
// Vista contenedora del módulo Incidencias: carga los datos, aplica filtros
// y orquesta los modales. Es el equivalente al cuerpo de App() del HTML,
// pero acotado a incidencias (App.tsx solo hace sesión y navegación).
//
// Modos:
//   'bandeja' — lo que le toca hacer al rol ahora mismo
//   'todas'   — todo lo que la RLS le deja ver, con filtros
// ============================================================
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { sb } from '../../lib/supabase';
import {
  UNIDADES,
  AREAS_RESP,
  EST_LABEL,
  AREAS_AUTORUTEO,
} from '../../lib/constants';
import {
  slaHoras,
  fueraHorarioValidador,
  areaEfectiva,
  idCorto,
} from '../../lib/helpers';
import { BUCKET_EVIDENCIAS } from '../../lib/storage';
import { duplicadasEnProceso } from '../../lib/duplicados';
import IncCard from '../../components/IncCard';
import NuevaInc from './NuevaInc';
import type { PresetNueva, GrupoReporte } from './NuevaInc';
import RepararModal from './RepararModal';
import type { DatosReparacion } from './RepararModal';
import EvidenciaModal from './EvidenciaModal';
import ChatModal from './ChatModal';
import ReasignModal from './ReasignModal';
import type { ModoReasign } from './ReasignModal';
import EditModal from './EditModal';
import CorreccionModal from './CorreccionModal';
import TablaIncidencias from './TablaIncidencias';
import MotivoModal from './MotivoModal';
import type {
  CanInc,
  Incidencia,
  IncidenciaNueva,
  EstatusInc,
  SlaMap,
  SlaArea,
  TipoEvidencia,
  UsuarioRol,
} from '../../types/db';

/** Tope de filas por consulta: el límite duro de Supabase es 1000. */
const LIMITE_INCIDENCIAS = 1000;

type ModoVista = 'bandeja' | 'todas';

/** Motivo pendiente de capturar: rechazar una reparación o descartar. */
type MotivoPend = { inc: Incidencia; kind: 'rechazo_rep' | 'descartar' };

type Props = {
  email: string;
  nombre: string;
  /** Roles distintos del usuario (de usuario_roles). */
  misRoles: string[];
  /** Departamentos del usuario; el primero se usa como area_reportante. */
  misDep: string[];
  /** Filas completas de usuario_roles: rol + unidad + departamento. */
  rolesDetalle: UsuarioRol[];
  modo: ModoVista;
  /** Rol principal (el de mayor prioridad). Lo usa IncCard. */
  role: string;
  chatCounts: Record<string, number>;
  onChatLeido: (recordId: string) => void;
  /** Refresca la campana tras una acción que dispara notificaciones. */
  onRecargarNotifs: () => void;
  /** record_id a enfocar al llegar desde una notificación. */
  focoRecordId?: string;
  /** Avisa que ya se aplicó el foco, para que el padre lo limpie. */
  onFocoAplicado?: () => void;
  /** Modal de alta, controlado por App (el botón vive en el menú). */
  nuevaAbierta?: boolean;
  onCerrarNueva?: () => void;
  /** Contador del botón ↻: al subir, recarga las incidencias. */
  recargarSignal?: number;
  /** Reporta cuántas incidencias accionables hay, para el badge del menú. */
  onBandejaCount?: (n: number) => void;
};

function IncidenciasView({
  email,
  nombre,
  misRoles,
  misDep,
  rolesDetalle,
  modo,
  role,
  chatCounts,
  onChatLeido,
  onRecargarNotifs,
  focoRecordId,
  onFocoAplicado,
  nuevaAbierta,
  onCerrarNueva,
  recargarSignal,
  onBandejaCount,
}: Props) {
  const [items, setItems] = useState<Incidencia[]>([]);
  /**
   * Fotos para la tarjeta, por record_id. La tarjeta enseña LA foto que
   * cuenta la historia del momento (ajuste de Erik, ago-2026):
   *   reporte    → la PRIMERA subida al reportar
   *   reparacion → la MÁS RECIENTE de la reparación (el resultado final)
   *   reasign    → la evidencia de la solicitud de reasignación pendiente
   */
  const [fotos, setFotos] = useState<{
    reporte: Record<string, string>;
    reparacion: Record<string, string>;
    reasign: Record<string, string>;
  }>({ reporte: {}, reparacion: {}, reasign: {} });

  /**
   * La foto que le toca a la tarjeta según su momento:
   *   - reasignación pendiente → la evidencia de la solicitud, que es lo
   *     que el validador está decidiendo;
   *   - reparado/cerrada → la foto de la reparación, con la del reporte de
   *     respaldo si la reparación no trajo foto;
   *   - todo lo demás → la primera foto del reporte.
   */
  const fotoDe = (i: Incidencia): string | undefined => {
    if (i.reasignacion_pendiente && fotos.reasign[i.record_id])
      return fotos.reasign[i.record_id];
    if (i.estatus === 'reparado' || i.estatus === 'cerrada')
      return fotos.reparacion[i.record_id] || fotos.reporte[i.record_id];
    return fotos.reporte[i.record_id];
  };
  /**
   * Tarjetas o tabla. La tabla es la trazabilidad completa (pliego
   * petitorio); solo se ofrece en modo 'todas' — en la bandeja lo que
   * importa es accionar, no barrer.
   */
  const [vista, setVista] = useState<'tarjetas' | 'tabla'>('tarjetas');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [slaMap, setSlaMap] = useState<SlaMap>({});

  // Filtros
  const [q, setQ] = useState('');
  const [fUN, setFUN] = useState('Todas');
  const [fEstado, setFEstado] = useState('Todos');
  const [fArea, setFArea] = useState('Todas');
  /** Rango de fechas de captura. Vacío = sin límite por ese lado. */
  const [fDesde, setFDesde] = useState('');
  const [fHasta, setFHasta] = useState('');

  /** record_id resaltado tras llegar desde una notificación. */
  const [resaltado, setResaltado] = useState('');
  /** Aviso cuando la notificación apunta a algo que este rol no puede ver. */
  const [avisoFoco, setAvisoFoco] = useState('');

  // Modales. El alta (NuevaInc) NO tiene estado propio: la controla App,
  // porque el botón que la abre vive en el menú lateral.
  const [presetNew, setPresetNew] = useState<PresetNueva | null>(null);
  const [repairing, setRepairing] = useState<Incidencia | null>(null);
  const [evidenceOf, setEvidenceOf] = useState<Incidencia | null>(null);
  const [chatOf, setChatOf] = useState<Incidencia | null>(null);
  const [reassignOf, setReassignOf] = useState<{
    inc: Incidencia;
    mode: ModoReasign;
  } | null>(null);
  const [editOf, setEditOf] = useState<Incidencia | null>(null);
  const [corrigiendo, setCorrigiendo] = useState<Incidencia | null>(null);
  const [motivoOf, setMotivoOf] = useState<MotivoPend | null>(null);

  // --- Permisos ---
  // manager puede todo: se trata como comodín en cada verificación.
  const has = useCallback(
    (r: string) => misRoles.includes(r) || misRoles.includes('manager'),
    [misRoles]
  );
  const esSoloViewer =
    misRoles.length > 0 && misRoles.every((r) => r === 'viewer');
  // `asignarArea` ya no existe. Se quitó junto con AsignarAreaModal: hacía lo
  // mismo que Reasignar —el área dice "esto no es mío, va para allá"— pero
  // sin motivo y sin pasar por el validador, escribiendo `assigned_area` de
  // frente. Dos botones que se leen igual acaban usándose al azar, y ahí los
  // indicadores de carga por área dejan de significar algo. El flujo único es
  // Reasignar. Las filas que ya traen `assigned_area` se siguen respetando:
  // `areaEfectiva` la lee y la tarjeta la enseña con el chip 🛠 Repara.
  /**
   * ¿Puede ESTE usuario reparar ESTA incidencia?
   *
   * `can.reparar` dice si trae la llave (rol); esto dice de qué puerta es
   * (departamento). Sin este filtro, un técnico de Instalaciones veía el
   * botón de reparar en TODO lo `en_proceso` que su RLS le dejara ver — y
   * con más de un rol (p. ej. técnico + validador) la RLS además deja pasar
   * el update aunque el área no sea la suya: las políticas se evalúan con OR.
   *
   * Reglas, las mismas que usan los triggers notificar_* de la base:
   *   - manager: todas las áreas.
   *   - fila de reparacion/coordinador con departamento null = todas las
   *     áreas; unidad_negocio null = todas las unidades.
   *   - se compara contra el área EFECTIVA (assigned_area manda).
   */
  const reparaEn = useCallback(
    (i: Incidencia) => {
      if (misRoles.includes('manager')) return true;
      const area = areaEfectiva(i).trim().toLowerCase();
      const unidad = (i.unidad_negocio || '').trim().toLowerCase();
      return rolesDetalle.some(
        (r) =>
          (r.rol === 'reparacion' || r.rol === 'coordinador') &&
          (!r.departamento || r.departamento.trim().toLowerCase() === area) &&
          (!r.unidad_negocio ||
            !unidad ||
            r.unidad_negocio.trim().toLowerCase() === unidad)
      );
    },
    [misRoles, rolesDetalle]
  );

  const can: CanInc = {
    crear: has('reportante'),
    validar: has('validador'),
    reparar: has('reparacion') || has('coordinador'),
    reparaEn,
    reasignar: has('reparacion') || has('coordinador'),
    aprobarReasign: has('validador'),
  };

  // --- Carga ---
  const cargar = useCallback(async () => {
    setLoading(true);
    setErr('');
    const { data, error } = await sb
      .from('incidencias')
      .select('*')
      .order('fecha_reporte', { ascending: false })
      .limit(LIMITE_INCIDENCIAS);
    if (error) setErr('incidencias: ' + error.message);
    setItems((data as Incidencia[]) || []);
    setLoading(false);

    // Las fotos de la tarjeta (pliego petitorio, ago-2026). Van DESPUÉS de
    // soltar el loading: la lista se usa igual sin fotos, y así no se le
    // cobra la espera.
    //
    // Una sola consulta para toda la lista, no una por tarjeta. Viene en
    // orden descendente y cada etapa elige distinto:
    //   - reporte: el mapa se SOBREESCRIBE al iterar → queda la más VIEJA,
    //     la primera que se subió al reportar;
    //   - reparación: solo la PRIMERA escritura por record_id → queda la
    //     más RECIENTE, que es el estado final del trabajo.
    // La evidencia de reasignación no vive en `evidencias`: viaja como URL
    // en `reasignaciones.evidencia`, y solo importa la solicitud abierta.
    const [{ data: evs }, { data: reasEv }] = await Promise.all([
      sb
        .from('evidencias')
        .select('record_id,url,etapa')
        .eq('tipo', 'foto')
        .in('etapa', ['reporte', 'reparacion'])
        .order('creado_en', { ascending: false })
        .limit(3000),
      sb
        .from('reasignaciones')
        .select('record_id,evidencia')
        .eq('estado', 'Solicitada')
        .not('evidencia', 'is', null)
        .limit(500),
    ]);
    const mReporte: Record<string, string> = {};
    const mReparacion: Record<string, string> = {};
    (
      (evs as { record_id: string | null; url: string; etapa: string }[]) ||
      []
    ).forEach((e) => {
      if (!e.record_id) return;
      if (e.etapa === 'reporte') mReporte[e.record_id] = e.url;
      else if (!mReparacion[e.record_id]) mReparacion[e.record_id] = e.url;
    });
    const mReasign: Record<string, string> = {};
    ((reasEv as { record_id: string; evidencia: string }[]) || []).forEach(
      (r) => {
        if (!mReasign[r.record_id]) mReasign[r.record_id] = r.evidencia;
      }
    );
    setFotos({ reporte: mReporte, reparacion: mReparacion, reasign: mReasign });
  }, []);

  useEffect(() => {
    cargar();
    (async () => {
      // slaMap: horas de SLA por área, en minúsculas (así lo espera IncCard).
      const { data } = await sb.from('sla_areas').select('area,sla_horas');
      const m: SlaMap = {};
      ((data as SlaArea[]) || []).forEach((r) => {
        if (r.area) {
          const h = slaHoras(r.sla_horas);
          if (h) m[r.area.trim().toLowerCase()] = h;
        }
      });
      setSlaMap(m);
    })();
  }, [cargar]);

  // Al llegar desde una notificación: se limpian los filtros y se busca por
  // folio. La notificación trae record_id, así que el folio se resuelve de la
  // lista ya cargada (el buscador no mira record_id).
  //
  // Al terminar se avisa al padre para que limpie focoRecordId. Si no, cada
  // vez que cambiara `items` (o se remontara la vista) se volvería a forzar
  // el folio viejo en el buscador, borrando lo que el usuario escribiera.
  useEffect(() => {
    if (!focoRecordId) return;
    // Mientras la lista no haya cargado, no se decide nada: se reintenta al
    // siguiente cambio de `items`. `loading` es la señal fiable; `length===0`
    // no lo es, porque una lista legítimamente vacía se veía igual que una
    // que todavía no llega.
    if (loading) return;

    const it = items.find((i) => i.record_id === focoRecordId);

    if (!it) {
      // ANTES: se hacía `setQ(it?.folio || '')`, o sea que se limpiaba el
      // buscador y no se avisaba nada. Desde afuera eso es idéntico a "el
      // clic no hizo nada", que es justo como se sentía.
      //
      // Que no aparezca casi siempre significa que la RLS no se la muestra
      // a este rol: te notifican de algo que no puedes abrir.
      setAvisoFoco(
        'La notificación apunta a una incidencia que tu rol no puede ver. ' +
          'Pídele a un manager que te dé acceso, o que te la reasigne.'
      );
      onFocoAplicado?.();
      return;
    }

    // Se limpia TODO lo que podría esconderla, incluidas las fechas.
    setAvisoFoco('');
    setQ(it.folio || '');
    setFUN('Todas');
    setFArea('Todas');
    setFEstado('Todos');
    setFDesde('');
    setFHasta('');
    setResaltado(focoRecordId);
    onFocoAplicado?.();
  }, [focoRecordId, items, loading, onFocoAplicado]);

  /**
   * Lleva la tarjeta resaltada a la vista y apaga el resalte a los 4 s.
   *
   * Sin esto, "ir a la incidencia" solo escribía el folio en el buscador.
   * Si la lista ya estaba filtrada por ese folio, la pantalla no cambiaba
   * ni un pixel y parecía que el clic se había perdido.
   */
  useEffect(() => {
    if (!resaltado) return;
    const el = document.getElementById('inc-' + resaltado);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setResaltado(''), 4000);
    return () => clearTimeout(t);
    // Solo depende de `resaltado`: los efectos corren después de que el DOM
    // ya se pintó, así que la tarjeta existe cuando esto se ejecuta.
  }, [resaltado]);

  // Botón ↻ de la barra superior. Se compara contra el valor previo para no
  // recargar de más en el montaje (ahí los datos ya vienen frescos).
  const recargaPrev = useRef(recargarSignal);
  useEffect(() => {
    if (recargarSignal !== undefined && recargarSignal !== recargaPrev.current) {
      recargaPrev.current = recargarSignal;
      cargar();
    }
  }, [recargarSignal, cargar]);

  // --- Filtrado ---
  /**
   * Lo accionable: qué le toca hacer ahora.
   *
   * OJO: esto mira `misRoles` (TODOS sus roles), no `role` (el principal).
   * Antes miraba solo `role`, y eso borraba a quien tiene dos.
   *
   * El caso que lo destapó: una persona con `reportante` + `reparacion`.
   * `ROLE_PRIORITY` pone `reparacion` por encima, así que su `role` era
   * 'reparacion', y la bandeja de reparación solo muestra `en_proceso`.
   * Capturaba una incidencia —que nace `por_validar`—, se guardaba bien,
   * y desaparecía de su pantalla sin ningún error. Parecía que no se
   * había guardado. Estaba guardada; su mitad reportante no tenía bandeja.
   *
   * Con varios roles las condiciones se SUMAN: le toca lo de todos.
   */
  const bandeja = useMemo(() => {
    const tiene = (r: string) => misRoles.includes(r);

    // Manager, coordinador y viewer no tienen bandeja acotada: ven todo.
    // Se conserva tal cual estaba.
    if (tiene('manager') || tiene('coordinador') || tiene('viewer'))
      return items;

    const yo = (email || '').toLowerCase();

    return items.filter((i) => {
      // Al validador le toca también REVISAR las reasignaciones pendientes:
      // viven en 'en_proceso' y sin esta condición jamás caían en su
      // bandeja, aunque el botón "Revisar reasignación" es suyo.
      if (
        tiene('validador') &&
        (i.estatus === 'por_validar' ||
          i.estatus === 'reparado' ||
          i.reasignacion_pendiente)
      )
        return true;

      if (tiene('reparacion') && i.estatus === 'en_proceso' && reparaEn(i))
        return true;

      // El reportante ve TODO lo suyo, en cualquier estatus. Antes solo veía
      // lo rechazado —lo accionable— y el efecto fue que capturaba y su
      // reporte desaparecía de su pantalla: no tenía DÓNDE ver en qué va
      // (pliego petitorio, ago-2026). El badge del menú sigue contando solo
      // lo accionable, para que no infle.
      if (tiene('reportante') && (i.captured_by || '').toLowerCase() === yo)
        return true;

      return false;
    });
  }, [items, misRoles, email, reparaEn]);

  // El badge de "Mi bandeja" cuenta solo lo ACCIONABLE, no lo visible. La
  // bandeja del reportante ahora enseña todas sus capturas; si el badge las
  // contara todas, marcaría "12" permanentes y dejaría de significar "te
  // toca hacer algo".
  const accionables = useMemo(() => {
    const tiene = (r: string) => misRoles.includes(r);
    if (tiene('manager') || tiene('coordinador') || tiene('viewer'))
      return bandeja.length;
    const yo = (email || '').toLowerCase();
    return items.filter(
      (i) =>
        (tiene('validador') &&
          (i.estatus === 'por_validar' ||
            i.estatus === 'reparado' ||
            i.reasignacion_pendiente)) ||
        (tiene('reparacion') && i.estatus === 'en_proceso' && reparaEn(i)) ||
        (tiene('reportante') &&
          (i.captured_by || '').toLowerCase() === yo &&
          i.estatus === 'rechazada')
    ).length;
  }, [items, bandeja.length, misRoles, email, reparaEn]);

  useEffect(() => {
    onBandejaCount?.(accionables);
  }, [accionables, onBandejaCount]);

  // Áreas elegibles al dirigir una incidencia: las del catálogo MÁS las que
  // ya existen en los datos (Urban, Imprenta, Op. Bio Box… no están en
  // AREAS_RESP, y sin esto no se podrían elegir).
  const areasElegibles = useMemo(() => {
    const set = new Set<string>(AREAS_RESP);
    items.forEach((i) => {
      if (i.area_responsable) set.add(i.area_responsable);
      if (i.assigned_area) set.add(i.assigned_area);
    });
    return [...set].sort();
  }, [items]);

  const visibles = useMemo(() => {
    const base = modo === 'bandeja' ? bandeja : items;
    return base.filter((i) => {
      if (fUN !== 'Todas' && i.unidad_negocio !== fUN) return false;
      // El filtro de área acepta las dos: las que le tocan por catálogo y
      // las que le redirigieron. Si no, el técnico filtra por su área y no
      // ve el trabajo que sí le asignaron.
      if (
        fArea !== 'Todas' &&
        i.area_responsable !== fArea &&
        i.assigned_area !== fArea
      )
        return false;
      if (fEstado !== 'Todos' && i.estatus !== fEstado) return false;
      // Rango de fechas de captura. `fecha_reporte` es un timestamp ISO en
      // UTC; los inputs date dan 'YYYY-MM-DD'. Comparar los primeros 10
      // caracteres evita convertir zonas horarias y que un reporte de las
      // 11 p.m. se cuente como del día siguiente.
      if (i.fecha_reporte) {
        const dia = i.fecha_reporte.slice(0, 10);
        if (fDesde && dia < fDesde) return false;
        if (fHasta && dia > fHasta) return false;
      } else if (fDesde || fHasta) {
        // Sin fecha no se puede afirmar que caiga en el rango.
        return false;
      }
      if (q) {
        const s =
          `${i.folio} ${i.nombre_incidencia} ${i.direccion} ${i.campania}`.toLowerCase();
        if (!s.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [
    items,
    bandeja,
    modo,
    q,
    fUN,
    fArea,
    fEstado,
    fDesde,
    fHasta,
  ]);

  // --- Acciones ---
  /** Aplica un patch en memoria para no recargar toda la lista. */
  const patchInc = (rid: string, patch: Partial<Incidencia>) =>
    setItems((prev) =>
      prev.map((i) => (i.record_id === rid ? { ...i, ...patch } : i))
    );

  const cambiarEstatus = async (rid: string, estatus: EstatusInc) => {
    const patch: Partial<Incidencia> = { estatus };
    // Se deja rastro de quién aprobó/reparó, además del estatus.
    if (estatus === 'en_proceso') {
      patch.validator_approved = true;
      patch.validator_email = email;
      patch.validator_at = new Date().toISOString();
    }
    if (estatus === 'reparado') {
      patch.repaired_by_email = email;
      patch.repaired_at = new Date().toISOString();
    }
    const { error } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', rid);
    if (error) {
      alert('No se pudo actualizar: ' + error.message);
      return;
    }
    patchInc(rid, patch);
    setTimeout(onRecargarNotifs, 400);
  };

  const guardarReparacion = async (
    inc: Incidencia,
    { diagnostico, detalle, causa, solucion }: DatosReparacion
  ) => {
    const patch: Partial<Incidencia> = {
      estatus: 'reparado',
      diagnostico: diagnostico || null,
      detalle_reparacion: detalle || null,
      causa_raiz: causa || null,
      solucion: solucion || null,
      repaired_by_email: email,
      repaired_at: new Date().toISOString(),
    };
    const { data, error } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id)
      .select('record_id');
    if (error) {
      alert('No se pudo guardar la reparación: ' + error.message);
      return;
    }
    // La RLS no lanza error cuando el update no te toca: afecta 0 filas y
    // regresa "éxito". Sin esta verificación la app pintaba la incidencia
    // como reparada aunque la base no hubiera guardado nada.
    if (!data || data.length === 0) {
      alert(
        'No se guardó: esta incidencia no pertenece a tu área, ' +
          'o tu rol no permite repararla.'
      );
      return;
    }
    patchInc(inc.record_id, patch);
    setRepairing(null);
    setTimeout(onRecargarNotifs, 400);
  };

  const rechazarReparacion = async (inc: Incidencia, motivo: string) => {
    const patch: Partial<Incidencia> = {
      estatus: 'en_proceso',
      motivo_rechazo_reparacion: motivo,
    };
    const { error } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id);
    if (error) {
      alert('No se pudo rechazar: ' + error.message);
      return;
    }
    patchInc(inc.record_id, patch);
    setMotivoOf(null);
    setTimeout(onRecargarNotifs, 400);
  };

  const prevalidar = async (inc: Incidencia) => {
    const { error } = await sb
      .from('incidencias')
      .update({ prevalidada: true })
      .eq('record_id', inc.record_id);
    if (error) {
      alert('No se pudo prevalidar: ' + error.message);
      return;
    }
    patchInc(inc.record_id, { prevalidada: true });
  };

  const descartarPrevalidacion = async (inc: Incidencia, motivo: string) => {
    const patch: Partial<Incidencia> = {
      estatus: 'rechazada',
      prevalidada: false,
      motivo_rechazo_reparacion: motivo,
    };
    const { error } = await sb
      .from('incidencias')
      .update(patch)
      .eq('record_id', inc.record_id);
    if (error) {
      alert('No se pudo descartar: ' + error.message);
      return;
    }
    patchInc(inc.record_id, patch);
    setMotivoOf(null);
  };

  /**
   * Inserta el reporte y liga la evidencia POR GRUPO.
   *
   * El record_id se genera aquí (crypto.randomUUID), antes del insert. Eso
   * permite saber de antemano qué filas pertenecen a qué grupo, sin depender
   * del orden en que Postgres devuelva el insert.
   */
  const crear = async (grupos: GrupoReporte[]) => {
    const base = {
      captured_by: email,
      area_reportante: misDep[0] || null,
      fecha_reporte: new Date().toISOString(),
    };

    // Se les pone id ANTES de insertar, conservando la agrupación.
    const gruposConId = grupos.map((g) => ({
      ...g,
      filas: g.filas.map((d) => {
        // Fuera del horario del validador, las áreas de auto-ruteo entran
        // directo a en_proceso y prevalidan al recibir.
        const auto =
          AREAS_AUTORUTEO.includes(d.area_responsable || '') &&
          fueraHorarioValidador();
        return {
          ...d,
          ...base,
          record_id: idCorto(),
          estatus: (auto ? 'en_proceso' : 'por_validar') as EstatusInc,
          requiere_prevalidacion: auto,
        };
      }),
    }));

    const rows = gruposConId.flatMap((g) => g.filas);

    // ══ REGLA DE DUPLICIDAD ══ La regla y su porqué viven en
    // lib/duplicados.ts, compartida con el flujo de Biobox (revisión →
    // levantar incidencia): antes ese flujo se la brincaba y duplicaba.
    const choques = await duplicadasEnProceso(rows);
    if (choques.length) {
      alert(
        'Esta incidencia ya se encuentra registrada y en proceso, no es ' +
          'necesario capturar una nueva.\n\n' +
          choques
            .map(
              (c) =>
                `• ${c.fila.nombre_incidencia} (cara ${c.fila.clave_medio}) → folio ${c.folio || '—'}`
            )
            .join('\n') +
          '\n\nQuita esa partida del reporte para guardar el resto.'
      );
      return;
    }

    const { data, error } = await sb.from('incidencias').insert(rows).select();
    if (error) {
      alert('No se pudo crear: ' + error.message);
      return;
    }
    // No basta con que no haya `error`. Si la RLS deja INSERTAR pero no
    // deja LEER de vuelta la fila recién creada, PostgREST responde 200 con
    // un arreglo vacío. El código anterior hacía `(data || rows)`, y como
    // `[]` es truthy en JS, se quedaba con el arreglo vacío: no se agregaba
    // nada a la lista y no se avisaba nada. Silencio total.
    const devueltas = (data as Incidencia[] | null) ?? [];
    if (devueltas.length !== rows.length) {
      alert(
        `Se guardaron ${devueltas.length} de ${rows.length} reportes. ` +
          'Refresca con ↻ y verifica en Incidencias antes de volver a capturar, ' +
          'para no duplicar.'
      );
    }
    // Si la base no devolvió nada legible, se muestran las filas locales:
    // más vale enseñar lo que se mandó que dejar la pantalla en blanco.
    const creadas = (
      devueltas.length ? devueltas : rows
    ) as Incidencia[];

    // Cada grupo sube SUS archivos y los liga SOLO a sus caras. Así, en un
    // sitio con varias fallas, se sabe qué foto corresponde a cuál.
    for (const g of gruposConId) {
      if (!g.files.length) continue;
      const ids = g.filas.map((f) => f.record_id);
      const sitio = g.filas[0]?.clave_sitio || 'reporte';
      const fecha = (g.filas[0]?.fecha_reporte || new Date().toISOString()).slice(
        0,
        10
      );
      // La cara va en el NOMBRE del archivo: así se identifica en Storage
      // sin abrir la app.
      const caraArchivo = (g.carasLabel || 'cara').replace(/[^\w-]/g, '_');

      for (const f of g.files) {
        const tipo: TipoEvidencia = f.type.startsWith('video')
          ? 'video'
          : 'foto';
        const ext = (
          f.name.split('.').pop() || (tipo === 'video' ? 'mp4' : 'jpg')
        ).toLowerCase();
        const path =
          `${ids[0]}/${sitio}_${caraArchivo}_${fecha}_reporte_${Date.now()}.${ext}`.replace(
            /[^\w/.\-]/g,
            '_'
          );
        const { error: up } = await sb.storage
          .from(BUCKET_EVIDENCIAS)
          .upload(path, f);
        if (up) {
          // Las incidencias ya existen: se avisa pero no se aborta el resto.
          alert('Se creó, pero falló subir evidencia: ' + up.message);
          continue;
        }
        const url = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data
          .publicUrl;
        // `referencia` guarda la cara: es lo que se lee en la galería.
        const evrows = ids.map((rid) => ({
          record_id: rid,
          etapa: 'reporte',
          tipo,
          url,
          path,
          subido_por: email,
          referencia: g.carasLabel || null,
        }));
        // Antes esta línea iba sin destructurar: el error se tiraba a la
        // basura. La foto quedaba en Storage, la fila no se creaba, y la
        // galería salía vacía sin explicación.
        const { error: evErr } = await sb.from('evidencias').insert(evrows);
        if (evErr) {
          alert(
            'La incidencia se creó, pero no se pudo registrar una evidencia: ' +
              evErr.message
          );
        }
      }
    }

    setItems((prev) => [...creadas, ...prev]);
    onCerrarNueva?.();
    setPresetNew(null);
    setTimeout(onRecargarNotifs, 400);
  };

  // --- Render ---
  if (loading) return <div className="loading">Cargando datos…</div>;

  return (
    <>
      {err && <div className="err">{err}</div>}
      {avisoFoco && (
        <div className="err" onClick={() => setAvisoFoco('')} role="alert">
          {avisoFoco} <span style={{ opacity: 0.7 }}>(clic para cerrar)</span>
        </div>
      )}

      <h2 className="page">{modo === 'bandeja' ? 'Mi bandeja' : 'Incidencias'}</h2>
      <p className="phint">
        {modo === 'bandeja' && role === 'validador'
          ? 'Por validar y reparaciones por aprobar.'
          : modo === 'bandeja' && role === 'reparacion'
            ? 'Asignadas a tu área.'
            : modo === 'bandeja'
              ? 'Aquí puedes consultar todo lo relacionado a tus incidencias reportadas. Lo rechazado es lo que te toca corregir.'
              : 'Todo lo que tu rol puede ver (filtrado por seguridad).'}
      </p>

      <div className="toolbar">
        <input
          className="search"
          placeholder="Buscar folio, sitio, campaña…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {/* Cada filtro dice QUÉ filtra en su primera opción: sin eso, tres
            selects que dicen "Todas / Todas / Todos" no se distinguen
            (pliego petitorio). El value se queda igual: es el que comparan
            los filtros. */}
        <select value={fUN} onChange={(e) => setFUN(e.target.value)}>
          <option value="Todas">Unidad: todas</option>
          {UNIDADES.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
        <select value={fArea} onChange={(e) => setFArea(e.target.value)}>
          <option value="Todas">Área: todas</option>
          {areasElegibles.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={fEstado} onChange={(e) => setFEstado(e.target.value)}>
          <option value="Todos">Estatus: todos</option>
          {/* `reportado` sale del selector: es un estatus heredado que ya
              no produce el flujo (todo nace en `por_validar` o, con
              auto-ruteo, en `en_proceso`). Se queda en EST_LABEL porque
              hay filas viejas que aún lo traen y deben seguir mostrando
              su etiqueta; lo que se quita es la OPCIÓN de filtrar por él,
              que solo servía para devolver una lista vacía. */}
          {Object.entries(EST_LABEL)
            .filter(([k]) => k !== 'reportado')
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
        </select>
        {/* Rango de fechas de captura. Etiqueta VISIBLE y no solo `title`:
            los tooltips no existen en táctil, y en iOS un input date vacío
            no pinta placeholder — eran dos pastillas en blanco idénticas. */}
        <label className="filtro-fecha">
          <span>Desde</span>
          <input
            type="date"
            className="fecha"
            value={fDesde}
            max={fHasta || undefined}
            onChange={(e) => setFDesde(e.target.value)}
            title="Capturadas desde"
          />
        </label>
        <label className="filtro-fecha">
          <span>Hasta</span>
          <input
            type="date"
            className="fecha"
            value={fHasta}
            min={fDesde || undefined}
            onChange={(e) => setFHasta(e.target.value)}
            title="Capturadas hasta"
          />
        </label>
        {(fDesde || fHasta) && (
          <button
            className="btn ghost sm"
            onClick={() => {
              setFDesde('');
              setFHasta('');
            }}
            title="Quitar el filtro de fechas"
          >
            ✕ fechas
          </button>
        )}
        {modo === 'todas' && (
          <button
            className="btn ghost sm"
            onClick={() =>
              setVista((v) => (v === 'tarjetas' ? 'tabla' : 'tarjetas'))
            }
            title="Cambiar entre tarjetas y tabla de trazabilidad"
          >
            {vista === 'tarjetas' ? '▦ Ver tabla' : '🗂 Ver tarjetas'}
          </button>
        )}
      </div>

      {visibles.length === 0 ? (
        <div className="empty">Sin incidencias para mostrar.</div>
      ) : modo === 'todas' && vista === 'tabla' ? (
        <TablaIncidencias
          items={visibles}
          puedeExportar={has('coordinador')}
        />
      ) : (
        <div className="inc-list">
          {visibles.map((i) => (
            // El id y el envoltorio son lo que permite hacer scroll hasta la
            // tarjeta y resaltarla al llegar desde una notificación.
            <div
              key={i.record_id}
              id={'inc-' + i.record_id}
              style={
                resaltado === i.record_id
                  ? {
                      outline: '2px solid var(--accent)',
                      outlineOffset: 3,
                      borderRadius: 14,
                      transition: 'outline-color .3s',
                    }
                  : undefined
              }
            >
            <IncCard
              i={i}
              can={can}
              email={email}
              foto={fotoDe(i)}
              onEstatus={cambiarEstatus}
              onRepair={setRepairing}
              onEvidence={setEvidenceOf}
              onChat={(inc) => {
                setChatOf(inc);
                onChatLeido(inc.record_id);
              }}
              onReassign={(inc, mode) => setReassignOf({ inc, mode })}
              onCorregir={setCorrigiendo}
              onEdit={setEditOf}
              onRechazarRep={(inc) =>
                setMotivoOf({ inc, kind: 'rechazo_rep' })
              }
              onPrevalidar={prevalidar}
              onDescartar={(inc) => setMotivoOf({ inc, kind: 'descartar' })}
              slaMap={slaMap}
              nChat={chatCounts[i.record_id] || 0}
            />
            </div>
          ))}
        </div>
      )}

      {/* --- Modales --- */}
      {(nuevaAbierta || presetNew) && (
        <NuevaInc
          preset={presetNew}
          onClose={() => {
            onCerrarNueva?.();
            setPresetNew(null);
          }}
          onSave={crear}
        />
      )}
      {repairing && (
        <RepararModal
          inc={repairing}
          email={email}
          onClose={() => setRepairing(null)}
          onSave={(p) => guardarReparacion(repairing, p)}
        />
      )}
      {chatOf && (
        <ChatModal
          inc={chatOf}
          email={email}
          nombre={nombre}
          onClose={() => {
            setChatOf(null);
            onRecargarNotifs();
          }}
        />
      )}
      {reassignOf && (
        <ReasignModal
          inc={reassignOf.inc}
          mode={reassignOf.mode}
          email={email}
          onClose={() => setReassignOf(null)}
          onDone={(rid, patch) => {
            patchInc(rid, patch);
            setReassignOf(null);
            setTimeout(onRecargarNotifs, 400);
          }}
        />
      )}
      {corrigiendo && (
        <CorreccionModal
          inc={corrigiendo}
          onClose={() => setCorrigiendo(null)}
          onDone={(rid, patch) => {
            patchInc(rid, patch);
            setCorrigiendo(null);
            setTimeout(onRecargarNotifs, 400);
          }}
        />
      )}
      {editOf && (
        <EditModal
          inc={editOf}
          onAbrirEvidencia={setEvidenceOf}
          onClose={() => setEditOf(null)}
          onDone={(rid, patch) => {
            patchInc(rid, patch);
            setEditOf(null);
            // Vuelve a `por_validar`: al validador le tiene que llegar.
            setTimeout(onRecargarNotifs, 400);
          }}
        />
      )}
      {/* LA EVIDENCIA VA HASTA EL FINAL A PROPÓSITO. Todos los modales usan
          la misma clase `.overlay` y por tanto el mismo z-index, así que
          manda el orden del DOM: el último se pinta encima. Como la galería
          se puede abrir DESDE la edición del reportante, tiene que quedar
          arriba — si se montara antes, se abriría por debajo y parecería que
          el botón no hizo nada. */}
      {evidenceOf && (
        <EvidenciaModal
          inc={evidenceOf}
          email={email}
          esValidador={has('validador')}
          esSoloViewer={esSoloViewer}
          onClose={() => setEvidenceOf(null)}
        />
      )}
      {motivoOf && (
        <MotivoModal
          titulo={
            motivoOf.kind === 'descartar'
              ? 'Descartar incidencia'
              : 'Rechazar reparación'
          }
          label={
            motivoOf.kind === 'descartar'
              ? 'Motivo (se regresa al reportante como no válida)'
              : 'Motivo del rechazo (regresa al área para volver a reparar)'
          }
          onClose={() => setMotivoOf(null)}
          onSubmit={(t) =>
            motivoOf.kind === 'descartar'
              ? descartarPrevalidacion(motivoOf.inc, t)
              : rechazarReparacion(motivoOf.inc, t)
          }
        />
      )}
    </>
  );
}

export default IncidenciasView;
