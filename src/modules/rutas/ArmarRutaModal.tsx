// ============================================================
// src/modules/rutas/ArmarRutaModal.tsx
// Armar (o editar) las paradas de una ruta desde el inventario (rutas,
// 5-oct-2026). Antes "+ Nueva ruta" dejaba la ruta vacía y la única forma
// de llenarla era un archivo.
//
// QUÉ HACE: carga el inventario de la unidad + medio de la ruta (paginado,
// agrupado por sitio), deja elegir sitios en la lista o tocándolos en el
// mapa, ordenarlos (automático por cercanía y luego a mano con ↑↓) y guarda
// TODO de un golpe con la RPC `guardar_paradas_ruta` (una transacción). Si
// un sitio ya está en otra ruta, la RPC no cambia nada y contesta cuáles y
// de qué ruta salen; aquí se enseñan y solo con "Sí, moverlos" se reintenta
// con p_mover=true. El archivo (Excel/KML) sigue como segunda opción.
//
// No se usa en Ecovallas Impreso: ahí manda la pauta (Pauta → Sincronizar
// rutas) y la RPC también lo rechaza.
//
// REGLAS QUE CUIDA (congelamiento del 24-sep): los efectos dependen de
// claves de texto (nunca del arreglo que reconstruye un updater); el
// dibujo del mapa lee lo último por refs; toda lectura lleva tope.
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { sb } from '../../lib/supabase';
import { tope } from '../../lib/envios';
import { pareceSinRed } from '../../lib/enLinea';
import { haySesionReal } from '../../lib/datosLocales';
import { candadoTactil } from '../../lib/mapaTactil';
import { escHtml, sinAcentos } from '../../lib/helpers';
import { colorTono, fondoTono } from '../../lib/tonos';
import { vigilarRender } from '../../lib/vigia';
import { haversine, ordenarPorCercania, type Punto } from '../../lib/haversine';
import {
  colorSeguro,
  esSegmentoDePauta,
  textoSobre,
  traerPaginado,
  trozos,
  textoFalla,
  TOPE_RPC_MS,
  type Resumen,
  type Ubic,
} from './rutasComun';

/** Un sitio del inventario (todas sus caras juntas). */
type Sitio = {
  site_id: string;
  nombre: string | null;
  direccion: string | null;
  municipio: string | null;
  lat: number | null;
  lng: number | null;
  /** Para los chips: categoría en Ecovallas (Mega Pantalla / Pantalla
   *  Sencilla), tipo de mueble en el resto (Columna / Pórticos, M4 / M5…). */
  tipo: string;
  caras: number;
};

type FilaInv = {
  vendor_face_id: string;
  site_id: string | null;
  site_legacy_id: string | null;
  categoria: string | null;
  tipo_mueble: string | null;
  latitud: number | null;
  longitud: number | null;
  direccion: string | null;
  municipio: string | null;
};

type EnOtra = {
  ruta_id: number;
  numero: number;
  nombre: string | null;
  color: string;
  unidad: string;
  tipo: string;
  /** Vive en una ruta de OTRA unidad o medio (p. ej. un sitio con caras
   *  Digital e Impreso que está en una ruta de Pauta): no se mueve desde
   *  aquí; guardar_paradas_ruta también lo rechaza (revisión, 5-oct-2026). */
  otroSegmento: boolean;
};

/** Fila de vw_rutas_con_coords que se relee al abrir (revisión, 5-oct-2026). */
type FilaRutaHoy = {
  ubicacion_id: number;
  ruta_id: number;
  ruta_numero: number;
  ruta_nombre: string | null;
  ruta_color: string;
  ruta_unidad: string;
  ruta_tipo: string;
  site_id: string;
  secuencia: number | null;
};

/**
 * Mete sitios nuevos en una lista ya ordenada en el lugar que MENOS alarga
 * el recorrido (inserción más barata), sin mover el orden de los que ya
 * estaban. Los que no tienen coordenadas van al final (rutas, 5-oct-2026,
 * revisión: antes todo nuevo iba al final, en el orden de los toques).
 */
function insertarCerca(lista: string[], nuevos: string[], coordDe: (k: string) => Punto | null): string[] {
  const out = lista.slice();
  const sinCoord: string[] = [];
  for (const k of nuevos) {
    const p = coordDe(k);
    if (!p) {
      sinCoord.push(k);
      continue;
    }
    let mejor = out.length;
    let costo = Infinity;
    for (let i = 0; i <= out.length; i++) {
      const a = i > 0 ? coordDe(out[i - 1]) : null;
      const b = i < out.length ? coordDe(out[i]) : null;
      let c: number;
      if (a && b) c = haversine(a, p) + haversine(p, b) - haversine(a, b);
      else if (a) c = haversine(a, p);
      else if (b) c = haversine(p, b);
      else continue; // vecinos sin coordenadas: no dicen nada
      if (c < costo) {
        costo = c;
        mejor = i;
      }
    }
    out.splice(mejor, 0, k);
  }
  return [...out, ...sinCoord];
}

type RespGuardar = {
  ok?: boolean;
  requiere_confirmar?: boolean;
  en_otra_ruta?: { site_id: string; ruta_id: number; ruta_numero: number; ruta_nombre: string | null }[];
  total?: number;
  agregadas?: number;
  quitadas?: number;
  movidas?: { site_id: string; ruta_origen_id: number; ruta_origen_numero: number }[];
  rechazadas?: { site_id: string; motivo: string }[];
  mensaje?: string;
  error?: string;
};

type Filtro = 'todas' | 'sin' | 'otra';

/** Sitios de prueba que viven en inventario ("Pruebas Via Verde"): nunca
 *  se ofrecen para una ruta real (Erik, 5-oct-2026). */
const RE_PRUEBA = /prueba/i;

export default function ArmarRutaModal({
  ruta,
  ubicsSegmento,
  esNueva,
  onClose,
  onGuardado,
}: {
  ruta: Resumen;
  /** Todas las paradas del segmento (unidad + medio), para saber qué sitio
   *  está en otra ruta y con qué orden arranca ésta. */
  ubicsSegmento: Ubic[];
  /** Recién creada desde "+ Nueva ruta": cambia el texto de bienvenida. */
  esNueva?: boolean;
  onClose: () => void;
  /** Se guardó: el padre recarga y enseña el resumen. */
  onGuardado: (resumen: string) => void;
}) {
  vigilarRender('ArmarRutaModal');
  const unidad = ruta.unidad_negocio;
  const tipo = ruta.tipo_medio;
  const color = colorSeguro(ruta.color);

  // --- Datos ---
  const [cargando, setCargando] = useState(true);
  const [errCarga, setErrCarga] = useState('');
  const [sitios, setSitios] = useState<Sitio[]>([]);
  /** Se reintenta la carga cambiando esta cuenta (botón "Reintentar"). */
  const [intento, setIntento] = useState(0);

  // --- Lo que se elige (orden = secuencia) ---
  const inicial = useMemo(
    () =>
      ubicsSegmento
        .filter((u) => u.ruta_id === ruta.id)
        .sort((a, b) => (a.secuencia ?? 99999) - (b.secuencia ?? 99999) || a.ubicacion_id - b.ubicacion_id)
        .map((u) => u.site_id),
    // Solo al abrir: la lista del padre puede recargarse detrás sin que se
    // pierda lo que el coordinador está armando.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const claveInicial = inicial.join('|');
  const [elegidos, setElegidos] = useState<string[]>(inicial);
  const claveElegidos = elegidos.join('|');
  const claveElegidosRef = useRef(claveElegidos);
  claveElegidosRef.current = claveElegidos;
  /** Lo último que quedó en la base (al abrir, o tras guardar). */
  const [claveBase, setClaveBase] = useState(claveInicial);
  const sucio = claveElegidos !== claveBase;
  /** Todos los sitios que esta pantalla SABE que están (o estuvieron) en
   *  la ruta. Al guardar, si la base trae alguno que no está aquí, alguien
   *  lo agregó después de abrir y se pregunta antes de quitarlo (revisión,
   *  5-oct-2026: antes se borraba sin aviso). */
  const vistosRef = useRef<Set<string>>(new Set(inicial));
  /** Orden automático por cercanía (Erik, 5-oct-2026): mientras nadie lo
   *  ajuste a mano, cada alta reordena la ruta completa. Una ruta que ya
   *  traía paradas conserva su orden y lo nuevo entra donde menos alarga. */
  const ordenManualRef = useRef(inicial.length > 0);

  // --- Filtros ---
  const [q, setQ] = useState('');
  const [filtro, setFiltro] = useState<Filtro>('todas');
  /** Tipos APAGADOS (vacío = todos visibles). Texto, no Set: es la llave. */
  const [tiposFuera, setTiposFuera] = useState<string[]>([]);
  const [pestana, setPestana] = useState<'sitios' | 'paradas'>(inicial.length ? 'paradas' : 'sitios');

  // --- Guardado ---
  const [guardando, setGuardando] = useState(false);
  const [errGuardar, setErrGuardar] = useState('');
  const [confirmar, setConfirmar] = useState<RespGuardar['en_otra_ruta'] | null>(null);
  const [resultado, setResultado] = useState<RespGuardar | null>(null);

  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  // ---------------------------------------------------------
  // Carga del inventario del segmento (paginada) + nombres
  // ---------------------------------------------------------
  useEffect(() => {
    let activo = true;
    setCargando(true);
    setErrCarga('');
    (async () => {
      const r = await traerPaginado<FilaInv>((desde, hasta, senal) =>
        sb
          .from('inventario')
          .select(
            'vendor_face_id,site_id,site_legacy_id,categoria,tipo_mueble,latitud,longitud,direccion,municipio'
          )
          .eq('unidad_negocio', unidad)
          .eq('tipo_medio', tipo)
          .order('vendor_face_id')
          .range(desde, hasta)
          .abortSignal(senal)
      );
      if (!activo) return;
      if (r.error) {
        setErrCarga('No se pudo cargar el inventario. ' + textoFalla(r.error, r.sinRed));
        setCargando(false);
        return;
      }
      // Nombres de pantalla (solo Ecovallas los tiene). Si falla, se sigue
      // sin ellos: son una ayuda para reconocer el sitio, no un requisito.
      const nombrePorCara = new Map<string, string>();
      if (unidad === 'Ecovallas') {
        const ids = r.filas.map((f) => f.vendor_face_id);
        for (const t of trozos(ids, 150)) {
          const { data } = await sb
            .from('nombres_pantallas')
            .select('vendor_face_id,nombre')
            .in('vendor_face_id', t)
            .abortSignal(tope(12000));
          if (!activo) return;
          ((data as { vendor_face_id: string; nombre: string }[] | null) || []).forEach((n) =>
            nombrePorCara.set(n.vendor_face_id, n.nombre)
          );
        }
      }
      // Agrupar por sitio. La dirección es la de la PRIMERA cara (orden por
      // vendor_face_id), la misma regla que la vista vw_rutas_con_coords.
      const por = new Map<string, Sitio>();
      for (const f of r.filas) {
        const sid = (f.site_id || '').trim();
        if (!sid || RE_PRUEBA.test(sid)) continue;
        const tipoChip =
          (unidad === 'Ecovallas' ? f.categoria : f.tipo_mueble)?.trim() || 'Otro';
        let s = por.get(sid);
        if (!s) {
          s = {
            site_id: sid,
            nombre: null,
            direccion: f.direccion,
            municipio: f.municipio,
            lat: null,
            lng: null,
            tipo: tipoChip,
            caras: 0,
          };
          por.set(sid, s);
        }
        s.caras++;
        if (s.lat == null && f.latitud != null && f.longitud != null) {
          s.lat = Number(f.latitud);
          s.lng = Number(f.longitud);
        }
        if (!s.nombre) {
          const n = nombrePorCara.get(f.vendor_face_id) || (unidad.startsWith('Biobox') ? f.site_legacy_id : null);
          if (n) s.nombre = n;
        }
      }
      // (revisión, 5-oct-2026) Dónde está HOY cada sitio, en TODAS las
      // rutas (no solo las del segmento, que es lo que Rutas tenía en
      // memoria, quizá de hace horas), y las paradas actuales de ESTA ruta.
      // Si no se puede leer se sigue con la foto: guardar vuelve a revisar.
      const fresca = new Map<string, EnOtra>();
      let frescaOk = true;
      for (const t of trozos([...por.keys()], 150)) {
        const { data, error } = await sb
          .from('vw_rutas_con_coords')
          .select('ubicacion_id,ruta_id,ruta_numero,ruta_nombre,ruta_color,ruta_unidad,ruta_tipo,site_id,secuencia')
          .in('site_id', t)
          .abortSignal(tope(12000));
        if (!activo) return;
        if (error) {
          frescaOk = false;
          break;
        }
        for (const u of (data as FilaRutaHoy[] | null) || []) {
          if (u.ruta_id === ruta.id) continue;
          fresca.set(u.site_id, {
            ruta_id: u.ruta_id,
            numero: u.ruta_numero,
            nombre: u.ruta_nombre,
            color: u.ruta_color,
            unidad: u.ruta_unidad,
            tipo: u.ruta_tipo,
            otroSegmento: u.ruta_unidad !== unidad || u.ruta_tipo !== tipo,
          });
        }
      }
      let propias: string[] | null = null;
      if (frescaOk) {
        const rp = await traerPaginado<FilaRutaHoy>((desde, hasta, senal) =>
          sb
            .from('vw_rutas_con_coords')
            .select('ubicacion_id,ruta_id,ruta_numero,ruta_nombre,ruta_color,ruta_unidad,ruta_tipo,site_id,secuencia')
            .eq('ruta_id', ruta.id)
            .order('secuencia', { ascending: true, nullsFirst: false })
            .order('ubicacion_id', { ascending: true })
            .range(desde, hasta)
            .abortSignal(senal)
        );
        if (!activo) return;
        if (!rp.error) propias = rp.filas.map((u) => u.site_id);
      }
      if (frescaOk) setEnOtra(fresca);
      if (propias) {
        propias.forEach((x) => vistosRef.current.add(x));
        const clave = propias.join('|');
        // Solo si el coordinador no ha tocado nada: lo suyo no se pisa.
        if (claveElegidosRef.current === claveInicial && clave !== claveInicial) {
          setElegidos(propias);
          setClaveBase(clave);
          if (propias.length) ordenManualRef.current = true;
        }
      }
      setSitios([...por.values()].sort((a, b) => (a.site_id < b.site_id ? -1 : 1)));
      setCargando(false);
    })();
    return () => {
      activo = false;
    };
    // claveInicial y ruta.id no cambian mientras el modal vive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unidad, tipo, intento]);

  const porId = useMemo(() => new Map(sitios.map((s) => [s.site_id, s] as [string, Sitio])), [sitios]);

  /** site_id → la OTRA ruta donde está hoy (no ésta). Arranca con la foto
   *  del segmento que tenía Rutas y se cambia por la lectura fresca de la
   *  carga (que además ve las rutas de OTROS segmentos). */
  const [enOtra, setEnOtra] = useState<Map<string, EnOtra>>(() => {
    const m = new Map<string, EnOtra>();
    for (const u of ubicsSegmento) {
      if (u.ruta_id === ruta.id) continue;
      m.set(u.site_id, {
        ruta_id: u.ruta_id,
        numero: u.ruta_numero,
        nombre: u.ruta_nombre,
        color: u.ruta_color,
        unidad: u.ruta_unidad,
        tipo: u.ruta_tipo,
        otroSegmento: false,
      });
    }
    return m;
  });
  /** Llave de texto de enOtra para el efecto del mapa (regla del 24-sep). */
  const firmaEnOtra = [...enOtra.entries()].map(([k, v]) => `${k}:${v.ruta_id}`).join('|');

  /** Tipos presentes, con cuántos sitios hay de cada uno. */
  const tipos = useMemo(() => {
    const m = new Map<string, number>();
    sitios.forEach((s) => m.set(s.tipo, (m.get(s.tipo) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [sitios]);

  const elegidosSet = useMemo(() => new Set(claveElegidos ? claveElegidos.split('|') : []), [claveElegidos]);

  /** Sitios que pasan los filtros (la lista y los puntos del mapa). */
  const filtrados = useMemo(() => {
    const t = sinAcentos(q.trim());
    const fuera = new Set(tiposFuera);
    return sitios.filter((s) => {
      if (fuera.has(s.tipo)) return false;
      const otra = enOtra.has(s.site_id);
      if (filtro === 'sin' && otra) return false;
      if (filtro === 'otra' && !otra) return false;
      if (!t) return true;
      return (
        sinAcentos(s.site_id).includes(t) ||
        sinAcentos(s.nombre).includes(t) ||
        sinAcentos(s.direccion).includes(t) ||
        sinAcentos(s.municipio).includes(t)
      );
    });
  }, [sitios, q, filtro, tiposFuera, enOtra]);
  const claveFiltrados = filtrados.map((s) => s.site_id).join('|');

  // ---------------------------------------------------------
  // Acciones sobre la lista de paradas
  // ---------------------------------------------------------
  const coordDe = (k: string): Punto | null => {
    const s = porId.get(k);
    return s && s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null;
  };
  /** Agrega con el orden automático (ver ordenManualRef). */
  const conNuevos = (prev: string[], nuevos: string[]): string[] => {
    const n = nuevos.filter((id) => !prev.includes(id));
    if (!n.length) return prev;
    return ordenManualRef.current ? insertarCerca(prev, n, coordDe) : ordenarPorCercania([...prev, ...n], coordDe);
  };

  const alternar = (sid: string) => {
    const otra = enOtra.get(sid);
    if (otra?.otroSegmento && !elegidos.includes(sid)) {
      alert(
        `${sid} ya está en la Ruta ${otra.numero} de ${otra.unidad} ${otra.tipo}` +
          (esSegmentoDePauta(otra.unidad, otra.tipo) ? ' (la manda la pauta)' : '') +
          '. Un sitio no se mueve entre unidades o medios desde aquí.'
      );
      return;
    }
    setResultado(null);
    setConfirmar(null);
    setElegidos((prev) => (prev.includes(sid) ? prev.filter((x) => x !== sid) : conNuevos(prev, [sid])));
  };
  /** El mapa llama SIEMPRE a la última versión (sus handlers se crean una vez por dibujo). */
  const alternarRef = useRef(alternar);
  alternarRef.current = alternar;

  const mover = (i: number, d: -1 | 1) => {
    // Ajuste a mano: desde aquí lo nuevo ya no reordena toda la ruta.
    ordenManualRef.current = true;
    setResultado(null);
    setElegidos((prev) => {
      const j = i + d;
      if (j < 0 || j >= prev.length) return prev;
      const n = prev.slice();
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  };

  const ordenarCercania = () => {
    // Pidió el orden por cercanía: lo que agregue después lo sigue.
    ordenManualRef.current = false;
    setResultado(null);
    setElegidos((prev) => ordenarPorCercania(prev, coordDe));
  };

  const agregarFiltrados = () => {
    // Los de otra unidad o medio no se ofrecen (ver EnOtra.otroSegmento).
    const nuevos = filtrados
      .map((s) => s.site_id)
      .filter((id) => !elegidosSet.has(id) && !enOtra.get(id)?.otroSegmento);
    if (nuevos.length === 0) return;
    const deOtra = nuevos.filter((id) => enOtra.has(id)).length;
    if (
      deOtra > 0 &&
      !confirm(
        `Vas a agregar ${nuevos.length} sitios; ${deOtra} ya están en otra ruta y, al guardar, ` +
          `te preguntaré si los mueves. ¿Agregar todos?`
      )
    )
      return;
    setResultado(null);
    setElegidos((prev) => conNuevos(prev, nuevos));
  };

  const quitarTodas = () => {
    if (!elegidos.length) return;
    if (!confirm(`¿Quitar las ${elegidos.length} paradas de la lista? (No se guarda hasta que toques Guardar.)`)) return;
    setResultado(null);
    // Lista en blanco: vuelve el orden automático.
    ordenManualRef.current = false;
    setElegidos([]);
  };

  const cerrar = () => {
    if (guardando) return;
    if (sucio && !confirm('Tienes cambios sin guardar en las paradas. ¿Salir sin guardar?')) return;
    onClose();
  };

  // ---------------------------------------------------------
  // Guardar (una transacción en la base)
  // ---------------------------------------------------------
  const guardandoRef = useRef(false);
  const guardar = async (moverOtras: boolean) => {
    if (guardandoRef.current) return;
    guardandoRef.current = true;
    setGuardando(true);
    setErrGuardar('');
    // Lo que se manda, tal cual: si el coordinador sigue tocando la lista
    // mientras guarda, "sin guardar" se compara contra esto.
    const enviados = elegidos.slice();
    try {
      // Al volver la señal hay ~60 s en que auth-js aún no tiene sesión:
      // sin ella la RPC sale como anónimo y la base la rechaza por permiso.
      if (!(await haySesionReal())) {
        if (vivo.current)
          setErrGuardar(
            'Tu sesión se está reconectando. Espera unos segundos y vuelve a tocar Guardar (tus cambios siguen aquí).'
          );
        return;
      }
      // (revisión, 5-oct-2026) La base borra de la ruta todo lo que no venga
      // en la lista. Si desde que se abrió esta pantalla alguien (otro
      // coordinador, un Excel/KML) agregó paradas, se pregunta antes.
      if (!moverOtras) {
        const hoy = await traerPaginado<{ site_id: string }>((desde, hasta, senal) =>
          sb
            .from('ruta_ubicaciones')
            .select('site_id')
            .eq('ruta_id', ruta.id)
            .order('site_id')
            .range(desde, hasta)
            .abortSignal(senal)
        );
        if (!vivo.current) return;
        if (hoy.error) {
          setErrGuardar(
            'No se guardó: no pude revisar la ruta antes de guardar. ' +
              textoFalla(hoy.error, hoy.sinRed) +
              ' Tus cambios siguen aquí.'
          );
          return;
        }
        const enviadosSet = new Set(enviados);
        const ajenas = hoy.filas
          .map((x) => x.site_id)
          .filter((x) => !enviadosSet.has(x) && !vistosRef.current.has(x));
        if (ajenas.length) {
          const lista = ajenas.slice(0, 8).join(', ') + (ajenas.length > 8 ? '…' : '');
          const cuantas = ajenas.length === 1 ? '1 parada' : `${ajenas.length} paradas`;
          ajenas.forEach((x) => vistosRef.current.add(x));
          if (
            !confirm(
              `Desde que abriste esta pantalla alguien agregó ${cuantas} a la Ruta ${ruta.numero}: ${lista}.\n\n` +
                'Aceptar = guardar tu lista y QUITARLAS.\nCancelar = no guardar todavía y agregarlas a tu lista para revisarlas.'
            )
          ) {
            setElegidos((prev) => conNuevos(prev, ajenas));
            setErrGuardar(
              `Agregué a tu lista ${ajenas.length === 1 ? 'la parada nueva' : `las ${ajenas.length} paradas nuevas`}. ` +
                'Revísala(s) y vuelve a tocar Guardar.'
            );
            return;
          }
        }
      }
      const { data, error, status } = await sb
        .rpc('guardar_paradas_ruta', {
          p_ruta_id: ruta.id,
          p_site_ids: enviados,
          p_mover: moverOtras,
        })
        .abortSignal(tope(TOPE_RPC_MS));
      if (!vivo.current) return;
      if (error || status === 0) {
        const sinRed = status === 0 || pareceSinRed(error, status);
        setErrGuardar(
          sinRed
            ? 'No se guardó: sin señal o la red tardó demasiado. Tus cambios siguen aquí; vuelve a tocar Guardar cuando tengas señal.'
            : 'No se guardó: ' + (error?.message || 'error desconocido')
        );
        return;
      }
      const r = (data || {}) as RespGuardar;
      if (r.ok === false && r.requiere_confirmar) {
        setConfirmar(r.en_otra_ruta || []);
        return;
      }
      if (r.ok === false) {
        setErrGuardar('No se guardó: ' + (r.mensaje || r.error || 'la base no aceptó los cambios.'));
        return;
      }
      setConfirmar(null);
      setResultado(r);
      enviados.forEach((x) => vistosRef.current.add(x));
      // (QA, 5-oct-2026) Las que se movieron ya son de ESTA ruta: fuera la
      // etiqueta "Sale de Ruta N".
      if (r.movidas?.length) {
        const n = new Map(enOtra);
        r.movidas.forEach((x) => n.delete(x.site_id));
        setEnOtra(n);
      }
      // Las rechazadas no quedaron en la base: se quitan también de la
      // lista, para que lo que se ve sea lo que quedó guardado.
      const rech = new Set((r.rechazadas || []).map((x) => x.site_id));
      if (rech.size) setElegidos((prev) => prev.filter((x) => !rech.has(x)));
      setClaveBase(enviados.filter((x) => !rech.has(x)).join('|'));
      const partes = [
        `Ruta ${ruta.numero}: ${r.total ?? enviados.length} paradas guardadas`,
        r.agregadas ? `${r.agregadas} agregadas` : '',
        r.quitadas ? `${r.quitadas} quitadas` : '',
        r.movidas?.length ? `${r.movidas.length} movidas de otra ruta` : '',
        r.rechazadas?.length ? `${r.rechazadas.length} rechazadas` : '',
      ].filter(Boolean);
      onGuardado(partes.join(', ') + '.');
    } finally {
      guardandoRef.current = false;
      if (vivo.current) setGuardando(false);
    }
  };

  // ---------------------------------------------------------
  // Mapa
  // ---------------------------------------------------------
  const mapaDiv = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const capa = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!mapaDiv.current || mapa.current) return;
    const m = L.map(mapaDiv.current, { zoomControl: true }).setView([19.43, -99.13], 11);
    candadoTactil(m);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(m);
    mapa.current = m;
    // El modal acaba de abrir: el contenedor puede no tener su tamaño final.
    const t = setTimeout(() => m.invalidateSize(), 200);
    return () => {
      clearTimeout(t);
      m.remove();
      mapa.current = null;
      capa.current = null;
    };
  }, []);

  // Dibujo. Depende SOLO de claves de texto (ver cabecera).
  useEffect(() => {
    const m = mapa.current;
    if (!m) return;
    if (capa.current) m.removeLayer(capa.current);
    const grp = L.layerGroup();
    const orden = claveElegidos ? claveElegidos.split('|') : [];
    const enRuta = new Set(orden);

    // Candidatos (no elegidos): un toque los agrega al final.
    for (const s of filtrados) {
      if (enRuta.has(s.site_id) || s.lat == null || s.lng == null) continue;
      const otra = enOtra.get(s.site_id);
      const c = L.circleMarker([s.lat, s.lng], {
        radius: 7,
        weight: otra ? 2 : 1,
        color: otra ? colorSeguro(otra.color) : '#151515',
        fillColor: otra ? colorSeguro(otra.color) : '#9ca3af',
        fillOpacity: otra ? 0.35 : 0.85,
        dashArray: otra ? '3 3' : undefined,
        // La clase pinta el sitio libre con las variables del tema (un
        // atributo SVG no entiende var()).
        className: otra ? 'rt-cand-otra' : 'rt-cand-libre',
      });
      c.bindTooltip(
        `${escHtml(s.nombre || s.site_id)}${otra ? ` · en Ruta ${escHtml(otra.numero)}` : ''}`,
        { direction: 'top' }
      );
      c.on('click', () => alternarRef.current(s.site_id));
      c.addTo(grp);
    }

    // Recorrido elegido: línea en orden + número de parada.
    const linea: [number, number][] = [];
    orden.forEach((sid, i) => {
      const s = porId.get(sid);
      if (!s || s.lat == null || s.lng == null) return;
      linea.push([s.lat, s.lng]);
      const icono = L.divIcon({
        className: '',
        html: `<div class="rt-pin" style="background:${color};color:${textoSobre(color)}">${i + 1}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      const mk = L.marker([s.lat, s.lng], { icon: icono, zIndexOffset: 1000 });
      // Quitar va en un botón del globo y no en el toque directo: quitar
      // por error una parada la manda al final al volver a agregarla.
      const caja = document.createElement('div');
      caja.innerHTML =
        `<b>Parada ${i + 1}</b> · ${escHtml(s.nombre || s.site_id)}<br>` +
        `<small>${escHtml(s.site_id)}</small><br><small>${escHtml(s.direccion || '')}</small><br>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      // Sin ghost: el globo de Leaflet es blanco en los dos temas y el
      // texto de .ghost (var(--txt)) es claro en el tema oscuro.
      btn.className = 'btn sm';
      btn.style.marginTop = '6px';
      btn.textContent = 'Quitar de la ruta';
      btn.onclick = () => {
        m.closePopup();
        alternarRef.current(sid);
      };
      caja.appendChild(btn);
      mk.bindPopup(caja);
      mk.addTo(grp);
    });
    if (linea.length > 1) {
      L.polyline(linea, { color, weight: 3, opacity: 0.85 }).addTo(grp);
    }
    grp.addTo(m);
    capa.current = grp;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveElegidos, claveFiltrados, cargando, firmaEnOtra]);

  // Encuadre: solo al cargar y al cambiar de filtros, NO en cada toque (el
  // mapa saltaría cada vez que se agrega un punto).
  useEffect(() => {
    const m = mapa.current;
    if (!m || cargando) return;
    const pts: [number, number][] = [];
    for (const s of filtrados) if (s.lat != null && s.lng != null) pts.push([s.lat, s.lng]);
    for (const sid of elegidos) {
      const s = porId.get(sid);
      if (s && s.lat != null && s.lng != null) pts.push([s.lat, s.lng]);
    }
    m.invalidateSize();
    if (pts.length === 1) m.setView(pts[0], 15);
    else if (pts.length > 1) m.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveFiltrados, cargando]);

  // ---------------------------------------------------------
  // Render
  // ---------------------------------------------------------
  const sinCoords = elegidos.filter((sid) => {
    const s = porId.get(sid);
    return !s || s.lat == null;
  }).length;
  const deOtraElegidos = elegidos.filter((sid) => enOtra.has(sid) && !enOtra.get(sid)?.otroSegmento).length;
  const fueraDeInventario = cargando ? 0 : elegidos.filter((sid) => !porId.has(sid)).length;

  return (
    <div
      className="overlay rt-overlay-full"
      onClick={(e) => {
        if (e.target === e.currentTarget) cerrar();
      }}
    >
      <div className="modal rt-armado" onClick={(e) => e.stopPropagation()}>
        <div className="rt-armado-cab">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span className="rt-color" style={{ background: color }} />
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0 }}>
                Paradas de la Ruta {ruta.numero}
                {ruta.nombre ? ` · ${ruta.nombre}` : ''}
              </h3>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {unidad} · {tipo} · {elegidos.length} paradas elegidas
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn-icono"
            onClick={cerrar}
            disabled={guardando}
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        <p className="phint" style={{ margin: '6px 0 10px' }}>
          {esNueva ? 'Ruta creada. Ahora elige sus sitios: ' : ''}
          Toca un punto gris del mapa (o ＋ en la lista) para agregarlo. Se acomoda solo por
          cercanía; ajusta con ↑ ↓ si hace falta.
        </p>

        {errCarga && (
          <div className="err">
            {errCarga}{' '}
            <button type="button" className="btn sm ghost" onClick={() => setIntento((n) => n + 1)}>
              Reintentar
            </button>
          </div>
        )}

        <div className="rt-armado-cuerpo">
          <div className="rt-armado-mapa-col">
            <div ref={mapaDiv} className="rt-mapa" />
            <div className="rt-leyenda">
              <span>
                <i className="rt-punto rt-punto-libre" /> sin ruta
              </span>
              <span>
                <i className="rt-punto rt-punto-otra" /> en otra ruta
              </span>
              <span>
                <i className="rt-punto" style={{ background: color }} /> en esta ruta (número = orden)
              </span>
            </div>
          </div>

          <div className="rt-armado-lista-col">
            <div className="rt-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={pestana === 'sitios'}
                className={'rt-tab' + (pestana === 'sitios' ? ' on' : '')}
                onClick={() => setPestana('sitios')}
              >
                Sitios del inventario ({cargando ? '…' : filtrados.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={pestana === 'paradas'}
                className={'rt-tab' + (pestana === 'paradas' ? ' on' : '')}
                onClick={() => setPestana('paradas')}
              >
                Paradas elegidas ({elegidos.length})
              </button>
            </div>

            {pestana === 'sitios' && (
              <>
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar por clave, nombre o dirección"
                  style={{ marginBottom: 8 }}
                />
                {tipos.length > 1 && (
                  <div className="rt-chips">
                    {tipos.map(([t, n]) => {
                      const on = !tiposFuera.includes(t);
                      return (
                        <button
                          key={t}
                          type="button"
                          className={'rt-chip' + (on ? ' on' : '')}
                          aria-pressed={on}
                          onClick={() =>
                            setTiposFuera((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
                          }
                        >
                          {t} · {n}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="rt-chips">
                  {(
                    [
                      ['todas', 'Todas'],
                      ['sin', 'Sin ruta'],
                      ['otra', 'En otra ruta'],
                    ] as [Filtro, string][]
                  ).map(([f, et]) => (
                    <button
                      key={f}
                      type="button"
                      className={'rt-chip' + (filtro === f ? ' on' : '')}
                      aria-pressed={filtro === f}
                      onClick={() => setFiltro(f)}
                    >
                      {et}
                    </button>
                  ))}
                  {filtrados.some((s) => !elegidosSet.has(s.site_id)) && (
                    <button type="button" className="btn sm ghost" onClick={agregarFiltrados}>
                      ＋ Agregar los {filtrados.filter((s) => !elegidosSet.has(s.site_id)).length} de la lista
                    </button>
                  )}
                </div>

                {cargando && (
                  <div className="loading" style={{ padding: 24 }}>
                    <span className="spinner" />
                    Cargando inventario de {unidad} {tipo}…
                  </div>
                )}
                {!cargando && !errCarga && filtrados.length === 0 && (
                  <div className="empty" style={{ padding: 20 }}>
                    {sitios.length === 0
                      ? `No hay sitios de ${unidad} ${tipo} en el inventario.`
                      : 'Ningún sitio con estos filtros.'}
                  </div>
                )}
                <div className="rt-lista">
                  {filtrados.map((s) => {
                    const ya = elegidosSet.has(s.site_id);
                    const otra = enOtra.get(s.site_id);
                    return (
                      <div
                        key={s.site_id}
                        className={'rt-fila' + (ya ? ' elegida' : '')}
                        onClick={() => alternar(s.site_id)}
                      >
                        <button
                          type="button"
                          className="btn-icono rt-fila-btn"
                          aria-label={ya ? `Quitar ${s.site_id} de la ruta` : `Agregar ${s.site_id} a la ruta`}
                          onClick={(e) => {
                            e.stopPropagation();
                            alternar(s.site_id);
                          }}
                        >
                          {ya ? '✓' : '＋'}
                        </button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="rt-fila-tit">
                            {s.nombre ? `${s.nombre} · ` : ''}
                            {s.site_id}
                          </div>
                          <div className="rt-fila-sub">
                            {s.direccion || '(sin dirección en QTM)'}
                            {s.municipio ? ` · ${s.municipio}` : ''}
                          </div>
                          <div className="rt-fila-tags">
                            <span className="tag">{s.tipo}</span>
                            {otra && (
                              <span className="pill" style={{ background: fondoTono('ambar'), color: colorTono('ambar') }}>
                                En Ruta {otra.numero}
                                {otra.nombre ? ` · ${otra.nombre}` : ''}
                                {otra.otroSegmento ? ` (${otra.unidad} ${otra.tipo}: no se mueve desde aquí)` : ''}
                              </span>
                            )}
                            {s.lat == null && (
                              <span className="pill" style={{ background: fondoTono('gris'), color: colorTono('gris') }}>
                                sin coordenadas
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {pestana === 'paradas' && (
              <>
                <div className="rt-chips">
                  <button
                    type="button"
                    className="btn sm"
                    onClick={ordenarCercania}
                    disabled={elegidos.length < 2 || cargando}
                  >
                    🧭 Ordenar por cercanía
                  </button>
                  {elegidos.length > 0 && (
                    <button type="button" className="btn sm ghost" onClick={quitarTodas}>
                      Quitar todas
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', margin: '2px 0 8px', lineHeight: 1.5 }}>
                  {ordenManualRef.current
                    ? 'Lo nuevo entra donde menos alarga el recorrido. «Ordenar por cercanía» reacomoda toda la ruta desde la parada más al norte.'
                    : 'Se ordena sola por cercanía, desde la parada más al norte, mientras no muevas nada a mano.'}
                  {sinCoords > 0 && ` ${sinCoords} sin coordenadas van al final.`}
                </div>
                {elegidos.length === 0 && (
                  <div className="empty" style={{ padding: 20 }}>
                    Todavía no hay paradas. Agrégalas desde «Sitios del inventario» o tocando el mapa.
                  </div>
                )}
                <div className="rt-lista">
                  {elegidos.map((sid, i) => {
                    const s = porId.get(sid);
                    const otra = enOtra.get(sid);
                    return (
                      <div key={sid} className="rt-fila elegida">
                        <span className="rt-num" style={{ background: color, color: textoSobre(color) }}>
                          {i + 1}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="rt-fila-tit">
                            {s?.nombre ? `${s.nombre} · ` : ''}
                            {sid}
                          </div>
                          <div className="rt-fila-sub">{s?.direccion || ''}</div>
                          <div className="rt-fila-tags">
                            {otra && (
                              <span className="pill" style={{ background: fondoTono('ambar'), color: colorTono('ambar') }}>
                                Sale de Ruta {otra.numero}
                              </span>
                            )}
                            {!cargando && !s && (
                              <span className="pill" style={{ background: fondoTono('rojo'), color: colorTono('rojo') }}>
                                No está en el inventario de {unidad} {tipo}
                              </span>
                            )}
                            {s && s.lat == null && (
                              <span className="pill" style={{ background: fondoTono('gris'), color: colorTono('gris') }}>
                                sin coordenadas
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="rt-fila-acc">
                          <button
                            type="button"
                            className="btn-icono"
                            onClick={() => mover(i, -1)}
                            disabled={i === 0}
                            aria-label={`Subir la parada ${i + 1}`}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="btn-icono"
                            onClick={() => mover(i, 1)}
                            disabled={i === elegidos.length - 1}
                            aria-label={`Bajar la parada ${i + 1}`}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="btn-icono"
                            onClick={() => alternar(sid)}
                            aria-label={`Quitar ${sid} de la ruta`}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Confirmación de mover: la base no cambió nada todavía. */}
        {confirmar && (
          <div className="rt-aviso">
            <b>
              {confirmar.length === 1
                ? 'Este sitio ya está en otra ruta:'
                : `Estos ${confirmar.length} sitios ya están en otra ruta:`}
            </b>
            <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
              {confirmar.slice(0, 12).map((c) => (
                <li key={c.site_id}>
                  {c.site_id} (Ruta {c.ruta_numero}
                  {c.ruta_nombre ? ` · ${c.ruta_nombre}` : ''})
                </li>
              ))}
              {confirmar.length > 12 && <li>y {confirmar.length - 12} más</li>}
            </ul>
            <div>Si continúas, salen de esa ruta y quedan solo en la Ruta {ruta.numero}.</div>
            <div className="rt-aviso-acc">
              <button type="button" className="btn sm ghost" onClick={() => setConfirmar(null)} disabled={guardando}>
                No, déjame revisar
              </button>
              <button type="button" className="btn sm warn" onClick={() => guardar(true)} disabled={guardando}>
                {guardando ? 'Guardando…' : 'Sí, moverlos a esta ruta'}
              </button>
            </div>
          </div>
        )}

        {resultado && (
          <div className="ok-msg" style={{ marginTop: 10 }}>
            Guardado: {resultado.total ?? elegidos.length} paradas
            {resultado.agregadas ? ` · ${resultado.agregadas} agregadas` : ''}
            {resultado.quitadas ? ` · ${resultado.quitadas} quitadas` : ''}
            {resultado.movidas?.length
              ? ` · ${resultado.movidas.length} movidas (${resultado.movidas
                  .slice(0, 6)
                  .map((m) => `${m.site_id} de la Ruta ${m.ruta_origen_numero}`)
                  .join(', ')}${resultado.movidas.length > 6 ? '…' : ''})`
              : ''}
            .
          </div>
        )}
        {resultado?.rechazadas && resultado.rechazadas.length > 0 && (
          <div className="err">
            <b>No se agregaron {resultado.rechazadas.length}:</b>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {resultado.rechazadas.slice(0, 15).map((r) => (
                <li key={r.site_id}>
                  {r.site_id}: {r.motivo}
                </li>
              ))}
              {resultado.rechazadas.length > 15 && <li>y {resultado.rechazadas.length - 15} más</li>}
            </ul>
          </div>
        )}
        {errGuardar && <div className="err" style={{ marginTop: 10 }}>{errGuardar}</div>}

        <div className="rt-pie">
          <div style={{ fontSize: 12, color: 'var(--muted)', flex: '1 1 160px' }}>
            {sucio ? 'Cambios sin guardar. ' : ''}
            {deOtraElegidos > 0 && !resultado ? `${deOtraElegidos} vienen de otra ruta. ` : ''}
            {fueraDeInventario > 0 ? `${fueraDeInventario} no están en inventario. ` : ''}
            {/* La base no guarda una ruta vacía (casi siempre es un error de
                pantalla, no una decisión). */}
            {elegidos.length === 0 && !cargando ? 'Una ruta no se guarda vacía: agrega al menos una parada.' : ''}
          </div>
          <button type="button" className="btn ghost sm" onClick={cerrar} disabled={guardando}>
            {sucio ? 'Cancelar' : 'Cerrar'}
          </button>
          <button
            type="button"
            className="btn ok"
            onClick={() => guardar(false)}
            disabled={guardando || cargando || !!errCarga || elegidos.length === 0 || (!sucio && !!resultado)}
          >
            {guardando ? 'Guardando…' : 'Guardar paradas'}
          </button>
        </div>
      </div>
    </div>
  );
}
