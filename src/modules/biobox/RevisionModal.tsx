// ============================================================
// src/modules/biobox/RevisionModal.tsx
// Hoja de vida: el checklist que se llena frente a la máquina.
//
// Tres decisiones que explican la forma de este archivo:
//
// 1) LOS ARCHIVOS SE SUBEN ANTES DE GUARDAR LA REVISIÓN.
//    Al revés que en RegistrarTomaModal, y a propósito. Aquí la revisión se
//    escribe de un jalón con una RPC transaccional; si las fotos se subieran
//    después y se cayera la señal, quedaría una revisión con anomalías sin
//    respaldo fotográfico —justo lo que se va a discutir con el proveedor—.
//    Subiendo primero, lo peor que pasa es un archivo huérfano en Storage.
//
// 2) UNA ANOMALÍA NO ES UNA INCIDENCIA HASTA QUE ALGUIEN LO DICE.
//    Marcar un punto en anomalía deja constancia en la revisión. Levantar la
//    incidencia es una casilla aparte. Si fuera automático, una máquina
//    grafiteada visitada cuatro veces generaría cuatro incidencias abiertas
//    del mismo problema.
//
// 3) LA INCIDENCIA SE CREA CON EL MISMO CÓDIGO QUE EN "NUEVA".
//    Mismos campos, mismo catálogo, mismo auto-ruteo fuera de horario. Así
//    hereda gratis el folio, el SLA por área, las notificaciones y todo el
//    flujo de validación que ya está probado.
// ============================================================
import { useState, useEffect, useMemo } from 'react';
import { sb } from '../../lib/supabase';
import { BUCKET_EVIDENCIAS } from '../../lib/storage';
import { AREAS_AUTORUTEO } from '../../lib/constants';
import { fueraHorarioValidador, idCorto } from '../../lib/helpers';
import SubirArchivos from '../../components/SubirArchivos';
import { catalogoParaMuebles, llaveCatalogo } from '../../lib/catalogo';
import EstadoMaquinaPanel from './EstadoMaquinaPanel';
import type {
  UbicacionRevision,
  ChecklistPlantilla,
  ChecklistPunto,
  CatalogoIncidencia,
  ValorRespuesta,
  EstadoMaquina,
  TipoEvidencia,
  EstatusInc,
} from '../../types/db';

/** Subcarpeta en el bucket, para no mezclar con incidencias ni pauta. */
const CARPETA = 'revisiones';

const ESTADOS: { v: EstadoMaquina; t: string; c: string }[] = [
  { v: 'operando', t: 'Operando', c: 'var(--ok)' },
  { v: 'con_falla', t: 'Con falla', c: '#f59e0b' },
  { v: 'fuera_de_linea', t: 'Fuera de línea', c: 'var(--bad)' },
];

/** Lo que el revisor contestó para un punto, antes de guardar. */
type Marca = {
  valor: ValorRespuesta;
  nota: string;
  files: File[];
  /** Convertir esta anomalía en incidencia al guardar. */
  levantar: boolean;
  /** `detalle` del catálogo elegido. */
  incidencia: string;
};

type Props = {
  ubic: UbicacionRevision;
  email: string;
  /** Departamentos del usuario: alimentan `area_reportante`. */
  misDep: string[];
  onClose: () => void;
  onGuardada: (siteId: string) => void;
};

function RevisionModal({ ubic, email, misDep, onClose, onGuardada }: Props) {
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState('');
  const [aviso, setAviso] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [paso, setPaso] = useState('');
  /** Ya se escribió en la base. Impide guardar dos veces la misma visita. */
  const [guardado, setGuardado] = useState(false);

  const [plantilla, setPlantilla] = useState<ChecklistPlantilla | null>(null);
  const [puntos, setPuntos] = useState<ChecklistPunto[]>([]);
  const [catalogo, setCatalogo] = useState<CatalogoIncidencia[]>([]);

  const [marcas, setMarcas] = useState<Record<number, Marca>>({});
  const [estado, setEstado] = useState<EstadoMaquina | ''>('');
  const [obs, setObs] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsMsg, setGpsMsg] = useState('');

  const unidad = ubic.unidad_negocio;
  // El medio de la MÁQUINA, no el de la ruta: una ruta de Biobox mezcla
  // Digital e Impreso, y no se revisan igual. De aquí sale el checklist y
  // también el campo `medio` de la incidencia.
  const medio = ubic.medio || ubic.tipo_medio;

  // --- Carga del checklist y del catálogo ---
  useEffect(() => {
    (async () => {
      // La plantilla del tipo de medio exacto gana sobre la genérica
      // (tipo_medio NULL). `order` con nullsFirst:false deja arriba la
      // específica.
      const [pl, cat] = await Promise.all([
        sb
          .from('checklist_plantillas')
          .select('*')
          .eq('unidad_negocio', unidad)
          .eq('activa', true)
          .or(`tipo_medio.eq.${medio},tipo_medio.is.null`)
          // La específica del tipo de medio gana sobre la genérica (NULL al
          // final). `id` desempata: el índice único permite varias plantillas
          // genéricas con distinto nombre, y sin desempate Postgres puede
          // devolver una distinta en cada carga — la app de campo y el editor
          // acabarían viendo checklists diferentes.
          .order('tipo_medio', { nullsFirst: false })
          .order('id')
          .limit(1),
        sb
          .from('catalogo_incidencias')
          .select('detalle,area,impacto,origen,tipo,tipo_mueble')
          .ilike('unidad_negocio', unidad)
          .order('detalle'),
      ]);

      if (pl.error) {
        setErr('No se pudo cargar el checklist: ' + pl.error.message);
        setCargando(false);
        return;
      }
      const p = ((pl.data as ChecklistPlantilla[]) || [])[0] || null;
      if (!p) {
        setErr(
          `No hay checklist configurado para ${unidad}. Un coordinador puede ` +
            'crearlo desde el botón "Checklist" de esta pantalla.'
        );
        setCargando(false);
        return;
      }
      setPlantilla(p);

      const { data: pts, error: ePts } = await sb
        .from('checklist_puntos')
        .select('*')
        .eq('plantilla_id', p.id)
        .eq('activo', true)
        .order('orden')
        .order('id');
      if (ePts) {
        setErr('No se pudieron cargar los puntos: ' + ePts.message);
        setCargando(false);
        return;
      }
      const lista = (pts as ChecklistPunto[]) || [];
      setPuntos(lista);

      // Todo arranca en "sin contestar": nada se presupone bien.
      const ini: Record<number, Marca> = {};
      lista.forEach((pt) => {
        ini[pt.id] = {
          valor: 'ok',
          nota: '',
          files: [],
          levantar: false,
          incidencia: pt.incidencia_sugerida || '',
        };
      });
      // Se arranca vacío de verdad: el objeto queda, pero `contestados` mide
      // sobre `tocados`, no sobre esto.
      setMarcas(ini);

      if (cat.error) setAviso('No se pudo cargar el catálogo de incidencias.');
      else
        // Una fila por incidencia, ACOTADA al mueble de esta máquina. Es de
        // donde salen el área y el nivel con los que nacería la incidencia,
        // y el mismo `detalle` cambia de área según el mueble: "Adicional
        // dañado" en Ecovallas Fijas es Mantenimiento y en Ecovallas Digital
        // es Digital. Ver lib/catalogo.ts.
        setCatalogo(
          catalogoParaMuebles((cat.data as CatalogoIncidencia[]) || [], [
            ubic.tipo_mueble,
          ]).opciones
        );

      setCargando(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Qué puntos ya tocó el revisor. Un Set aparte porque el valor por default
  // de `marcas` es 'ok', y "no lo he revisado" no es lo mismo que "está bien".
  const [tocados, setTocados] = useState<Set<number>>(new Set());

  const marcar = (id: number, valor: ValorRespuesta) => {
    setMarcas((prev) => {
      const m = prev[id];
      // Al dejar de ser anomalía se sueltan las fotos y la incidencia: el
      // ciclo de subida solo recorre las anomalías, así que si se quedaran
      // en el estado se perderían en silencio y el usuario creería que las
      // mandó.
      const limpiar = m.valor === 'anomalia' && valor !== 'anomalia';
      return {
        ...prev,
        [id]: limpiar
          ? { ...m, valor, files: [], levantar: false, nota: '' }
          : { ...m, valor },
      };
    });
    setTocados((prev) => new Set(prev).add(id));
  };
  const editar = (id: number, campo: keyof Marca, v: unknown) =>
    setMarcas((prev) => ({ ...prev, [id]: { ...prev[id], [campo]: v } }));

  const grupos = useMemo(() => {
    const m = new Map<string, ChecklistPunto[]>();
    puntos.forEach((p) => {
      const g = p.grupo || 'General';
      m.set(g, [...(m.get(g) || []), p]);
    });
    return [...m.entries()];
  }, [puntos]);

  const anomalias = puntos.filter((p) => marcas[p.id]?.valor === 'anomalia');
  const criticoEnFalla = anomalias.some((p) => p.critico);
  const faltanFotos = anomalias.filter(
    (p) => p.exige_foto_anomalia && !(marcas[p.id]?.files.length > 0)
  );
  // Se exige que la incidencia elegida EXISTA en el catálogo cargado. Si solo
  // se comprobara que el texto no está vacío, un `incidencia_sugerida` que ya
  // se renombró en `catalogo_incidencias` —o un catálogo que no cargó— haría
  // que el chip dijera "1 incidencia por levantar" y no se levantara ninguna,
  // sin un solo mensaje.
  const aLevantar = anomalias.filter(
    (p) =>
      marcas[p.id]?.levantar &&
      marcas[p.id]?.incidencia &&
      catalogo.some((c) => c.detalle === marcas[p.id].incidencia)
  );
  /** Marcadas para levantar pero con una incidencia que el catálogo no tiene. */
  const levantarRoto = anomalias.filter(
    (p) =>
      marcas[p.id]?.levantar &&
      !!marcas[p.id]?.incidencia &&
      !catalogo.some((c) => c.detalle === marcas[p.id].incidencia)
  );

  const pedirGps = () => {
    setGpsMsg('Buscando tu ubicación…');
    if (!navigator.geolocation) {
      setGpsMsg('Este navegador no expone la ubicación.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setCoords({ lat: p.coords.latitude, lng: p.coords.longitude });
        setGpsMsg('');
      },
      (e) => setGpsMsg('No se pudo obtener tu ubicación: ' + e.message),
      { enableHighAccuracy: true, timeout: 12000 }
    );
  };

  /** Sube un archivo y devuelve {url, path} o null. */
  const subirUno = async (f: File, etiqueta: string) => {
    const tipo: TipoEvidencia = f.type.startsWith('video') ? 'video' : 'foto';
    const ext = (
      f.name.split('.').pop() || (tipo === 'video' ? 'mp4' : 'jpg')
    ).toLowerCase();
    const fecha = new Date().toISOString().slice(0, 10);
    const nombre =
      `${ubic.site_id}_${etiqueta}_${fecha}_${Date.now()}.${ext}`.replace(
        /[^\w.\-]/g,
        '_'
      );
    const path = `${CARPETA}/${ubic.site_id}/${nombre}`;
    const { error } = await sb.storage
      .from(BUCKET_EVIDENCIAS)
      .upload(path, f, { upsert: false });
    // El motivo real importa: "Payload too large" no se arregla con señal.
    if (error) throw new Error(`${f.name}: ${error.message}`);
    return {
      tipo,
      path,
      url: sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data.publicUrl,
    };
  };

  const guardar = async () => {
    if (tocados.size === 0) {
      setErr('Contesta al menos un punto antes de guardar.');
      return;
    }
    if (!estado) {
      setErr('Indica cómo quedó la máquina: operando, con falla o fuera de línea.');
      return;
    }
    if (levantarRoto.length > 0) {
      setErr(
        'La incidencia elegida ya no existe en el catálogo de ' +
          `${unidad} para ${levantarRoto.length} anomalía(s). Vuelve a ` +
          'elegirla, o desmarca "Levantar incidencia".'
      );
      return;
    }
    if (faltanFotos.length > 0) {
      setErr(
        `Falta foto en ${faltanFotos.length} anomalía(s): ` +
          faltanFotos.map((p) => p.texto).slice(0, 2).join('; ') +
          (faltanFotos.length > 2 ? '…' : '')
      );
      return;
    }

    setGuardando(true);
    setErr('');

    // 1) Archivos primero (ver la nota del encabezado).
    setPaso('Subiendo archivos…');
    const subidos: {
      punto_id: number;
      tipo: string;
      url: string;
      path: string;
    }[] = [];
    for (const p of anomalias) {
      for (const f of marcas[p.id].files) {
        try {
          const r = await subirUno(f, 'anomalia');
          subidos.push({ punto_id: p.id, ...r });
        } catch (ex: any) {
          setGuardando(false);
          setPaso('');
          // Se dice CUÁL archivo y POR QUÉ: el mensaje anterior culpaba a la
          // señal siempre, y con un archivo demasiado grande el usuario
          // reintentaba en vano lo mismo.
          setErr(
            'No se pudo subir una foto (' +
              (ex?.message || ex) +
              '). No se guardó nada: revisa el archivo o la señal e intenta de nuevo.'
          );
          return;
        }
      }
    }

    // 2) La revisión, en una sola transacción.
    setPaso('Guardando la revisión…');
    const respuestas = puntos
      .filter((p) => tocados.has(p.id))
      .map((p) => ({
        punto_id: p.id,
        punto_texto: p.texto,
        grupo: p.grupo,
        orden: p.orden,
        valor: marcas[p.id].valor,
        nota: marcas[p.id].nota || null,
      }));

    const { data, error } = await sb.rpc('guardar_revision', {
      p_cabecera: {
        plantilla_id: plantilla?.id ?? null,
        site_id: ubic.site_id,
        vendor_face_id: ubic.vendor_face_id,
        unidad_negocio: unidad,
        nombre_maquina: ubic.site_legacy_id,
        direccion: ubic.direccion,
        ruta_id: ubic.ruta_id,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        estado_maquina: estado,
        observaciones: obs || null,
      },
      p_respuestas: respuestas,
    });

    if (error) {
      setGuardando(false);
      setPaso('');
      setErr('No se pudo guardar la revisión: ' + error.message);
      return;
    }
    const revisionId = (data as { revision_id: number }).revision_id;

    // 3) Índice punto_id → respuesta_id. La RPC no devuelve los ids de las
    //    respuestas, así que se releen una sola vez: hay una respuesta por
    //    punto, y este índice lo necesitan tanto la evidencia como el sellado
    //    de las incidencias.
    const { data: resp } = await sb
      .from('revision_respuestas')
      .select('id,punto_id')
      .eq('revision_id', revisionId);
    const porPunto = new Map<number, number>();
    ((resp as { id: number; punto_id: number | null }[]) || []).forEach((r) => {
      if (r.punto_id != null) porPunto.set(r.punto_id, r.id);
    });

    // Lo que salió mal DESPUÉS de que la revisión ya quedó guardada. No se
    // puede deshacer, pero tampoco se puede callar: si el modal se cerrara
    // solo, el revisor se iría creyendo que subió la foto de la anomalía.
    const problemas: string[] = [];

    // 4) Evidencia de la revisión.
    if (subidos.length > 0) {
      setPaso('Registrando evidencia…');
      const { error: eEv } = await sb.from('revision_evidencias').insert(
        subidos.map((s) => ({
          revision_id: revisionId,
          respuesta_id: porPunto.get(s.punto_id) ?? null,
          tipo: s.tipo,
          url: s.url,
          path: s.path,
          referencia:
            puntos.find((p) => p.id === s.punto_id)?.texto.slice(0, 120) || null,
          subido_por: email,
        }))
      );
      if (eEv)
        problemas.push('La evidencia no se registró: ' + eEv.message);
    }

    // 5) Incidencias de las anomalías marcadas para levantar.
    let creadas = 0;
    if (aLevantar.length > 0) {
      setPaso('Levantando incidencias…');
      const base = {
        captured_by: email,
        area_reportante: misDep[0] || null,
        fecha_reporte: new Date().toISOString(),
      };

      const filas = aLevantar
        .map((p) => {
          const cat = catalogo.find((c) => c.detalle === marcas[p.id].incidencia);
          if (!cat) return null;
          // Fuera del horario del validador, las áreas de auto-ruteo entran
          // directo a en_proceso. Mismo criterio que en Nueva incidencia.
          const auto =
            AREAS_AUTORUTEO.includes(cat.area || '') && fueraHorarioValidador();
          return {
            ...base,
            record_id: idCorto(),
            estatus: (auto ? 'en_proceso' : 'por_validar') as EstatusInc,
            requiere_prevalidacion: auto,

            unidad_negocio: unidad,
            clave_sitio: ubic.site_id,
            clave_medio: ubic.vendor_face_id,
            direccion: ubic.direccion,
            municipio: ubic.municipio,
            plaza: ubic.estado,
            // `medio` va porque varias listas de Incidencias lo muestran; sin
            // él las incidencias nacidas de una revisión se ven incompletas
            // junto a las capturadas desde "Nueva".
            medio,
            tipo_mueble: ubic.tipo_mueble,
            nombre_biobox: ubic.site_legacy_id,

            nombre_incidencia: cat.detalle,
            area_responsable: cat.area,
            nivel: (cat.impacto || '').trim(),
            origen: cat.origen,
            tipo: cat.tipo,
            // El punto del checklist queda escrito en la incidencia: quien la
            // atienda ve de qué revisión salió sin tener que buscarla.
            observaciones:
              `Detectado en revisión de máquina: ${p.texto}` +
              (marcas[p.id].nota ? ` — ${marcas[p.id].nota}` : ''),
            punto_id: p.id,
          };
        })
        .filter(Boolean) as (Record<string, unknown> & {
        punto_id: number;
        record_id: string;
      })[];

      if (filas.length > 0) {
        // `punto_id` no es columna de incidencias: solo sirve aquí para
        // volver a coser la respuesta con su incidencia.
        const rows = filas.map(({ punto_id: _p, ...resto }) => resto);
        const { error: eInc } = await sb.from('incidencias').insert(rows);
        if (eInc) {
          problemas.push(
            'No se pudieron levantar las incidencias: ' + eInc.message
          );
        } else {
          creadas = filas.length;

          // La MISMA foto entra también a `evidencias` con etapa 'reporte'.
          // Sin esto, quien atiende la incidencia por el flujo normal la ve
          // sin un solo archivo, aunque el revisor sí tomó la foto
          // obligatoria: la evidencia se habría quedado colgada de la
          // revisión, que él no consulta.
          const evInc = filas.flatMap((f) =>
            subidos
              .filter((s) => s.punto_id === f.punto_id)
              .map((s) => ({
                record_id: f.record_id,
                etapa: 'reporte',
                tipo: s.tipo,
                url: s.url,
                path: s.path,
                subido_por: email,
                referencia: 'Revisión de máquina',
              }))
          );
          if (evInc.length > 0) {
            const { error: eEvInc } = await sb.from('evidencias').insert(evInc);
            if (eEvInc)
              problemas.push(
                'Las incidencias se crearon sin su foto: ' + eEvInc.message
              );
          }

          // Sellar cada respuesta con su incidencia.
          for (const f of filas) {
            const rid = porPunto.get(f.punto_id);
            if (rid)
              await sb
                .from('revision_respuestas')
                .update({ incidencia_record_id: f.record_id })
                .eq('id', rid);
          }
        }
      }
    }

    setGuardando(false);
    setPaso('');
    setGuardado(true);
    onGuardada(ubic.site_id);

    if (problemas.length > 0) {
      // NO se cierra: el modal es el único lugar donde el revisor puede leer
      // esto. Cerrar aquí haría que el aviso se pintara y se destruyera en el
      // mismo ciclo, o sea nunca.
      setAviso(
        'La revisión SÍ quedó guardada, pero: ' +
          problemas.join(' ') +
          ' Avísale a coordinación.'
      );
      return;
    }

    if (creadas > 0)
      alert(
        `Revisión guardada. Se levantaron ${creadas} incidencia(s), ya están ` +
          'en el flujo normal de validación.'
      );
    onClose();
  };

  // --- Render ---
  const btnValor = (id: number, v: ValorRespuesta, texto: string, color: string) => {
    const activo = tocados.has(id) && marcas[id]?.valor === v;
    return (
      <button
        type="button"
        onClick={() => marcar(id, v)}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 40,
          padding: '6px 4px',
          fontSize: 12,
          fontWeight: 700,
          borderRadius: 8,
          cursor: 'pointer',
          border: '1px solid ' + (activo ? color : 'var(--line)'),
          background: activo ? color : 'transparent',
          color: activo ? '#0b1220' : 'var(--muted)',
        }}
      >
        {texto}
      </button>
    );
  };

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay' && !guardando)
          onClose();
      }}
    >
      <div className="modal" style={{ maxWidth: 720 }}>
        <h2 style={{ margin: '0 0 3px' }}>Revisión de máquina</h2>
        <p className="phint">
          {ubic.site_legacy_id ? `${ubic.site_legacy_id} · ` : ''}
          {ubic.direccion || ubic.site_id}
          {ubic.ruta_nombre ? ` · ${ubic.ruta_nombre}` : ''}
        </p>

        {/* Ficha: características de la máquina que NO se preguntan en cada
            visita, pero que el revisor necesita tener a la vista para saber
            qué tiene enfrente. Ver la nota de checklist_biobox.sql. */}
        <div
          style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}
        >
          <span className="tag">{ubic.site_id}</span>
          {medio && <span className="tag">{medio}</span>}
          {ubic.tipo_mueble && <span className="tag">{ubic.tipo_mueble}</span>}
          {ubic.municipio && <span className="tag">{ubic.municipio}</span>}
        </div>

        {/* QUÉ TRAE ABIERTO ESTA MÁQUINA. Va ANTES del checklist a propósito:
            si el operador se entera después de contestar los 23 puntos, ya
            volvió a levantar la incidencia que llevaba dos meses reportada.
            No depende de que el checklist cargue — se pinta aparte. */}
        <EstadoMaquinaPanel siteId={ubic.site_id} />

        {err && <div className="err">{err}</div>}
        {aviso && <div className="banner">{aviso}</div>}

        {cargando ? (
          <div style={{ padding: '20px 0', color: 'var(--muted)', fontSize: 13 }}>
            Cargando el checklist…
          </div>
        ) : (
          <>
            {ubic.ultima_revision && (
              <div className="banner" style={{ marginBottom: 12 }}>
                Última revisión:{' '}
                {new Date(ubic.ultima_revision).toLocaleDateString('es-MX')}
                {ubic.ultimo_revisor ? ` por ${ubic.ultimo_revisor.split('@')[0]}` : ''}
                {ubic.puntos_anomalia
                  ? ` · quedó con ${ubic.puntos_anomalia} anomalía(s)`
                  : ''}
                .
              </div>
            )}

            <div
              style={{
                maxHeight: '48vh',
                overflowY: 'auto',
                border: '1px solid var(--line)',
                borderRadius: 10,
              }}
            >
              {grupos.map(([grupo, pts]) => (
                <div key={grupo}>
                  <div
                    style={{
                      position: 'sticky',
                      top: 0,
                      background: 'var(--panel2)',
                      borderBottom: '1px solid var(--line)',
                      padding: '7px 11px',
                      fontWeight: 700,
                      fontSize: 12,
                    }}
                  >
                    {grupo}
                  </div>

                  {pts.map((p) => {
                    const m = marcas[p.id];
                    const esAnomalia = tocados.has(p.id) && m?.valor === 'anomalia';
                    return (
                      <div
                        key={p.id}
                        style={{
                          padding: '10px 11px',
                          borderBottom: '1px solid var(--line)',
                          background: !tocados.has(p.id)
                            ? 'transparent'
                            : esAnomalia
                              ? 'rgba(239,68,68,.07)'
                              : 'transparent',
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 600 }}>
                          {p.texto}
                          {p.critico && (
                            <span
                              className="tag"
                              style={{
                                marginLeft: 6,
                                fontSize: 10,
                                color: '#f59e0b',
                                borderColor: '#f59e0b',
                              }}
                            >
                              crítico
                            </span>
                          )}
                        </div>
                        {p.ayuda && (
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--muted)',
                              marginTop: 2,
                            }}
                          >
                            {p.ayuda}
                          </div>
                        )}

                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                          {btnValor(p.id, 'ok', '✓ Bien', 'var(--ok)')}
                          {btnValor(p.id, 'anomalia', '⚠ Anomalía', '#ef4444')}
                          {btnValor(p.id, 'na', '— N/A', '#64748b')}
                        </div>

                        {esAnomalia && (
                          <div style={{ marginTop: 9 }}>
                            <input
                              value={m.nota}
                              onChange={(e) => editar(p.id, 'nota', e.target.value)}
                              placeholder="¿Qué tiene? (opcional)"
                            />

                            <div style={{ marginTop: 8 }}>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: p.exige_foto_anomalia
                                    ? m.files.length
                                      ? 'var(--ok)'
                                      : 'var(--accent)'
                                    : 'var(--muted)',
                                  marginBottom: 5,
                                }}
                              >
                                {m.files.length
                                  ? `✓ ${m.files.length} archivo(s)`
                                  : p.exige_foto_anomalia
                                    ? 'Foto obligatoria'
                                    : 'Foto opcional'}
                              </div>
                              <SubirArchivos
                                onFiles={(fs) =>
                                  editar(p.id, 'files', [...m.files, ...fs])
                                }
                                archivos={m.files}
                                onQuitar={(i) =>
                                  editar(
                                    p.id,
                                    'files',
                                    m.files.filter((_, j) => j !== i)
                                  )
                                }
                                disabled={guardando}
                                ayuda="Se suben al guardar la revisión."
                              />
                            </div>

                            <label
                              style={{
                                display: 'flex',
                                gap: 8,
                                alignItems: 'center',
                                marginTop: 9,
                                fontSize: 12,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={m.levantar}
                                onChange={(e) =>
                                  editar(p.id, 'levantar', e.target.checked)
                                }
                                style={{ width: 'auto' }}
                              />
                              Levantar incidencia
                            </label>

                            {m.levantar && (
                              <select
                                value={m.incidencia}
                                onChange={(e) =>
                                  editar(p.id, 'incidencia', e.target.value)
                                }
                                style={{ marginTop: 6 }}
                              >
                                <option value="">
                                  ¿Qué incidencia del catálogo es?
                                </option>
                                {catalogo.map((c) => (
                                  <option key={llaveCatalogo(c)} value={c.detalle}>
                                    {c.detalle}
                                    {c.area ? ` — ${c.area}` : ''}
                                  </option>
                                ))}
                              </select>
                            )}
                            {m.levantar && !m.incidencia && (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: 'var(--accent)',
                                  marginTop: 4,
                                }}
                              >
                                Elige la incidencia del catálogo o esta anomalía
                                solo queda registrada en la revisión.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="field" style={{ marginTop: 14 }}>
              <label>¿Cómo quedó la máquina?</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {ESTADOS.map((e) => (
                  <button
                    key={e.v}
                    type="button"
                    onClick={() => setEstado(e.v)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: 42,
                      fontSize: 12,
                      fontWeight: 700,
                      borderRadius: 8,
                      cursor: 'pointer',
                      border: '1px solid ' + (estado === e.v ? e.c : 'var(--line)'),
                      background: estado === e.v ? e.c : 'transparent',
                      color: estado === e.v ? '#0b1220' : 'var(--muted)',
                    }}
                  >
                    {e.t}
                  </button>
                ))}
              </div>
              {criticoEnFalla && estado === 'operando' && (
                <div
                  style={{ fontSize: 11, color: '#f59e0b', marginTop: 6 }}
                >
                  Hay un punto crítico en anomalía y la marcaste como operando.
                  Si de verdad no está funcionando, cámbialo.
                </div>
              )}
            </div>

            <div className="field">
              <label>Observaciones (opcional)</label>
              <textarea
                value={obs}
                onChange={(e) => setObs(e.target.value)}
                rows={2}
                placeholder="Lo que no cabe en el checklist"
              />
            </div>

            <div className="field">
              <label>Ubicación del revisor (opcional)</label>
              {coords ? (
                <div style={{ fontSize: 12, color: 'var(--ok)' }}>
                  ✓ {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
                </div>
              ) : (
                <button className="btn ghost sm" type="button" onClick={pedirGps}>
                  📍 Capturar mi ubicación
                </button>
              )}
              {gpsMsg && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
                  {gpsMsg}
                </div>
              )}
            </div>

            <div
              className="toolbar"
              style={{ marginTop: 4, marginBottom: 4 }}
            >
              <span className="tag">
                {tocados.size}/{puntos.length} contestados
              </span>
              {anomalias.length > 0 && (
                <span
                  className="tag"
                  style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}
                >
                  {anomalias.length} anomalía(s)
                </span>
              )}
              {aLevantar.length > 0 && (
                <span
                  className="tag"
                  style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}
                >
                  {aLevantar.length} incidencia(s) por levantar
                </span>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose} disabled={guardando}>
                {guardado ? 'Cerrar' : 'Cancelar'}
              </button>
              {!guardado && (
                <button className="btn" onClick={guardar} disabled={guardando}>
                  {guardando ? paso || 'Guardando…' : '💾 Guardar revisión'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default RevisionModal;
