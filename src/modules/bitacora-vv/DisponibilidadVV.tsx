// ============================================================
// src/modules/bitacora-vv/DisponibilidadVV.tsx
// Disponibilidad y ocupación de Vía Verde por slot (fase 1, 19-oct-2026).
//
// LA PREGUNTA QUE RESPONDE: "¿hay lugar en estas columnas, en estas
// fechas y horas, antes de crear la campaña?". Sale del plano de columnas
// que comercial arma cada mes (tabla vv_ocupacion, importada del Excel) y
// del método validado contra el archivo manual (lib/ocupacionVV.ts).
//
// Tres vistas:
//   · Libres: cada espacio con una tira de 24 horas pintada por cuántos
//     slots quedan libres en el rango, y sus franjas con lugar.
//   · Matriz: sitio · slot × 24 horas, con los filtros, el resumen y los
//     colores de la matriz del Occupancy calculator que Erik ya usaba
//     (19-oct-2026); tocar o pasar el cursor por una celda dice quién está.
//   · Ocupación: % del mes por espacio (mensual o por banda) y su Excel.
// Importar el plano: comercial y manager (RPC importar_plano_vv).
//
// La disponibilidad sale del plano más reciente; la ocupación, del plano
// del mes elegido. Reservar y vender desde aquí es la fase 2.
// ============================================================
import { ChevronDown, ChevronRight, LayoutGrid, Sheet, Upload } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { WorkBook } from 'xlsx';
import { sb } from '../../lib/supabase';
import { cargarXlsx } from '../../lib/xlsxDiferido';
import {
  BANDAS,
  diasDelRango,
  franjasTexto,
  leerPlano,
  matrizDeEspacio,
  ocupacionDelMes,
  slotsLibresPorHora,
  sumarDias,
  SLOTS_ESTANDAR,
  type Celda,
  type LineaOcup,
  type ResultadoPlano,
} from '../../lib/ocupacionVV';
import CerrarModal from '../../components/CerrarModal';
import Ic from '../../components/Ic';
import {
  esMes,
  etiquetaMes,
  faltaTabla,
  hayPlanoDe,
  lineasDelPlano,
  lineasDelRango,
  planoMasReciente,
  type LineasDelRango,
} from './planoDelDia';

export type EspacioVV = {
  clave: string;
  tipo_espacio: 'columna' | 'portico';
  tramo: string | null;
  sitio: string | null;
  nombre: string | null;
  slots?: number | null;
};

type Vista = 'libres' | 'matriz' | 'ocupacion';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Hoy en hora local (toISOString es UTC y de noche ya marca mañana). */
function hoyLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const nombreEspacio = (e: EspacioVV) => (e.tipo_espacio === 'portico' ? `${e.sitio} ${e.nombre}` : e.clave);

/**
 * Cómo se pinta una celda de la matriz: los colores del calculator (verde
 * libre, rojo por horario, morado convencional) más ámbar para lo apartado,
 * que en la app es una reserva (Erik, 19-oct-2026).
 * Lo ocupado va en tono sólido y lo libre en tinte suave: con los tintes
 * --st-*-borde, en oscuro lo ocupado casi no se distinguía de lo libre
 * (revisión del 19-oct-2026). Así queda a 3.4:1 o más contra lo libre en
 * los dos temas, y la diferencia no depende solo del color.
 */
type TipoCelda = 'libre' | 'ocupada' | 'convencional' | 'reservada';
const COLOR_CELDA: Record<TipoCelda, string> = {
  libre: 'var(--st-verde-fondo)',
  ocupada: 'var(--st-rojo)',
  convencional: 'var(--st-morado)',
  reservada: 'var(--st-ambar)',
};
const NOMBRE_TIPO: Record<TipoCelda, string> = {
  libre: 'Disponible',
  ocupada: 'Ocupado (por horario)',
  convencional: 'Convencional / anual',
  reservada: 'Apartado (reservado)',
};
const NOMBRE_ESTATUS: Record<LineaOcup['estatus'], string> = {
  vendida: 'Vendida',
  reservada: 'Reservada (apartada)',
  pautada: 'Pautada',
};
const NOMBRE_NEG: Record<LineaOcup['negociacion'], string> = {
  VENTA: 'Venta',
  BONIFICACION: 'Bonificación',
  INTERCAMBIO: 'Intercambio',
};

/** Manda lo más firme: una venta por horario, luego la convencional, luego lo apartado. */
function tipoCelda(c: Celda): TipoCelda {
  if (!c.lineas.length) return 'libre';
  if (c.lineas.some((l) => !l.convencional && l.estatus !== 'reservada')) return 'ocupada';
  if (c.lineas.some((l) => l.convencional)) return 'convencional';
  return 'reservada';
}

/** 'COL 414' o 'San Antonio Norte', como se lee en la matriz. */
const etiquetaMatriz = (e: EspacioVV) =>
  e.tipo_espacio === 'portico' ? `${e.sitio} ${e.nombre}` : `COL ${e.clave}`;
const dosDigitos = (h: number) => String(h).padStart(2, '0');

/** Filas de la matriz que se pintan de entrada con «Todos» (12 sitios de 8 slots). */
const FILAS_DE_ENTRADA = 96;

const LETRA_DIA = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

/** [0..4] → 'L-V', [4, 5, 6] → 'V-D', [0, 2, 4] → 'L, X, V'. */
function diasCortos(dias: number[]): string {
  const d = [...dias].sort((a, b) => a - b);
  const seguidos = d.length > 1 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return seguidos ? `${LETRA_DIA[d[0]]}-${LETRA_DIA[d[d.length - 1]]}` : d.map((x) => LETRA_DIA[x]).join(', ');
}

/** Texto de una línea para el detalle de una celda. */
function textoLinea(l: LineaOcup): string[] {
  const dias = l.dias?.length ? ` · ${diasCortos(l.dias)}` : '';
  return [
    `Campaña: ${l.campana}`,
    `Negociación: ${NOMBRE_NEG[l.negociacion]} · ${NOMBRE_ESTATUS[l.estatus]}`,
    `${l.inicio} a ${l.fin}${dias} · ${franjasTexto(l.horas)}`,
  ];
}

/** «Libres»: verde si hay lugar, ámbar si quedan pocos slots, rojo si está llena. */
type EstadoLibre = 'lugar' | 'pocos' | 'llena';
const ESTADOS_LIBRE: { k: EstadoLibre; texto: string; color: string }[] = [
  { k: 'lugar', texto: 'Hay lugar', color: 'var(--st-verde)' },
  { k: 'pocos', texto: 'Quedan pocos', color: 'var(--st-ambar)' },
  { k: 'llena', texto: 'Llena', color: 'var(--st-rojo)' },
];
function estadoLibre(libres: number, total: number): EstadoLibre {
  if (libres <= 0) return 'llena';
  if (libres / total < 0.34) return 'pocos';
  return 'lugar';
}
const colorLibres = (libres: number, total: number) =>
  ESTADOS_LIBRE.find((x) => x.k === estadoLibre(libres, total))!.color;

/**
 * La tira de 24 horas en palabras, para el lector de pantalla: horas
 * seguidas con los mismos slots libres se juntan ('07:00 a 21:59, 2 de 8').
 */
function resumenTira(porHora: number[], total: number, horas: number[]): string {
  const partes: string[] = [];
  let ini = 0;
  for (let i = 1; i <= horas.length; i++) {
    const corte = i === horas.length || horas[i] !== horas[i - 1] + 1 || porHora[horas[i]] !== porHora[horas[ini]];
    if (!corte) continue;
    partes.push(
      `${dosDigitos(horas[ini])}:00 a ${dosDigitos(horas[i - 1])}:59, ${porHora[horas[ini]]} de ${total} libres`
    );
    ini = i;
  }
  return 'Slots libres por hora: ' + partes.join('; ');
}

/** Horas de una franja del filtro; si el fin es antes del inicio, cruza la medianoche. */
function horasDeFranja(ini: number, fin: number): number[] {
  const r = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  return ini <= fin ? r(ini, fin) : [...r(ini, 23), ...r(0, fin)];
}

export default function DisponibilidadVV({
  espacios,
  puedeImportar,
  onCatalogo,
}: {
  espacios: EspacioVV[];
  /** Comercial y manager: importar el plano y ajustar slots. */
  puedeImportar: boolean;
  /** Recarga el catálogo de la Bitácora (los slots cambian al importar o ajustar). */
  onCatalogo?: () => void;
}) {
  const [vista, setVista] = useState<Vista>('libres');
  /** ¿Hay algún plano importado? null = todavía no se sabe. */
  const [hayPlanos, setHayPlanos] = useState<boolean | null>(null);
  const [err, setErr] = useState('');
  /** Sube al importar un plano: vuelve a leer todo. */
  const [recarga, setRecarga] = useState(0);

  // Ocupación: el plano de UN mes, el elegido. El selector guarda lo que se
  // escribe (en Safari de escritorio es texto libre) y solo un mes válido
  // se carga; una respuesta vieja nunca pisa a la última pedida.
  const [mesElegido, setMesElegido] = useState('');
  const [mes, setMes] = useState('');
  const [lineasMes, setLineasMes] = useState<LineaOcup[] | null>(null);
  const [mesSinPlano, setMesSinPlano] = useState(false);
  const [cargandoMes, setCargandoMes] = useState(false);
  const pedidoMes = useRef(0);

  // Libres y Matriz: el plano que vale para CADA mes del rango.
  const [rango, setRango] = useState<LineasDelRango | null>(null);
  const [cargandoRango, setCargandoRango] = useState(false);
  const pedidoRango = useRef(0);
  const lineas = rango ? rango.lineas : null;

  const hoy = hoyLocal();
  const [desde, setDesde] = useState(hoy);
  const [hasta, setHasta] = useState(sumarDias(hoy, 6));
  // Filtros de la matriz, los mismos del calculator.
  const [fSitio, setFSitio] = useState('');
  const [fNeg, setFNeg] = useState('');
  const [fEst, setFEst] = useState('');
  const [ocultarPasadas, setOcultarPasadas] = useState(true);
  const [soloLibres, setSoloLibres] = useState(false);
  const [ocultarConv, setOcultarConv] = useState(false);
  const [mostrar912, setMostrar912] = useState(true);
  const [sel, setSel] = useState<{ espacio: string; slot: number; hora: number } | null>(null);
  const [banda, setBanda] = useState('mensual');
  const [importando, setImportando] = useState(false);
  // En el iPhone había ~930 px de filtros antes de la tabla: Negociación,
  // Estatus y las casillas van plegados en «Más filtros» (revisión 19-oct-2026).
  const [masFiltros, setMasFiltros] = useState(false);
  const filtrosActivos =
    (fNeg ? 1 : 0) +
    (fEst ? 1 : 0) +
    (ocultarPasadas ? 0 : 1) +
    (soloLibres ? 1 : 0) +
    (ocultarConv ? 1 : 0) +
    (mostrar912 ? 0 : 1);
  // Con «Todos» la matriz pasa de 600 filas × 24 horas (~0.5 s en un
  // iPhone): de entrada se pintan las primeras; con un sitio, todas.
  const [todasLasFilas, setTodasLasFilas] = useState(false);
  useEffect(() => {
    if (vista !== 'matriz') setTodasLasFilas(false);
  }, [vista]);
  const uid = useId();

  // Pórticos primero y luego columnas, como en «Hoy al aire».
  const lista = useMemo(
    () =>
      [...espacios].sort(
        (a, b) =>
          (a.tipo_espacio === 'portico' ? 0 : 1) - (b.tipo_espacio === 'portico' ? 0 : 1) ||
          a.clave.localeCompare(b.clave, 'es', { numeric: true })
      ),
    [espacios]
  );
  const slotsDe = useMemo(() => {
    const m: Record<string, number> = {};
    espacios.forEach((e) => (m[e.clave] = e.slots || SLOTS_ESTANDAR));
    return m;
  }, [espacios]);

  // ¿Hay planos? y, de entrada, Ocupación muestra el más reciente.
  useEffect(() => {
    let vigente = true;
    planoMasReciente().then((r) => {
      if (!vigente) return;
      if (r.error) {
        setErr(
          faltaTabla(r.error)
            ? 'La disponibilidad todavía no está lista en la base (falta aplicar su migración).'
            : 'No se pudo cargar la disponibilidad: ' + r.error.message
        );
        return;
      }
      setErr('');
      setHayPlanos(!!r.mes);
      if (r.mes) setMesElegido((m) => m || r.mes!);
    });
    return () => {
      vigente = false;
    };
  }, [recarga]);

  // Ocupación: el plano del mes elegido (si ese mes no tiene, se dice).
  useEffect(() => {
    if (!esMes(mesElegido)) return;
    const id = ++pedidoMes.current;
    setCargandoMes(true);
    (async () => {
      const h = await hayPlanoDe(mesElegido);
      if (id !== pedidoMes.current) return;
      const r = h.hay ? await lineasDelPlano(mesElegido) : { lineas: [] as LineaOcup[] };
      if (id !== pedidoMes.current) return;
      const fallo = h.error || ('error' in r ? r.error : undefined);
      if (fallo) {
        // Se conserva lo que ya estaba: vaciar la vista con mala señal confunde.
        setErr('No se pudo cargar el plano: ' + fallo);
      } else {
        setMes(mesElegido);
        setLineasMes(r.lineas);
        setMesSinPlano(!h.hay);
      }
      setCargandoMes(false);
    })();
  }, [mesElegido, recarga]);

  // Rango válido: hasta no antes de desde y no más de 400 días (más largo
  // se cortaría sin avisar).
  const diasRangoTotal =
    desde && hasta ? Math.round((Date.parse(hasta + 'T12:00:00Z') - Date.parse(desde + 'T12:00:00Z')) / 864e5) + 1 : 0;
  const rangoOk = !!desde && !!hasta && hasta >= desde && diasRangoTotal <= 400;

  // Libres y Matriz: el plano de cada mes del rango.
  useEffect(() => {
    if (!rangoOk || !hayPlanos) return;
    const id = ++pedidoRango.current;
    setCargandoRango(true);
    lineasDelRango(desde, hasta).then((r) => {
      if (id !== pedidoRango.current) return;
      if (r.error) setErr('No se pudo cargar la disponibilidad: ' + r.error);
      else {
        setErr('');
        setRango(r);
      }
      setCargandoRango(false);
    });
  }, [desde, hasta, rangoOk, hayPlanos, recarga]);

  // "Ahora" se fija en cada carga: una reserva que vence mientras se ve la
  // pantalla se libera al recargar, no a media lectura.
  const ahora = useMemo(() => new Date(), [rango, lineasMes]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Libres ----------
  // Filtros (Erik, 19-oct-2026): sitio, horario y los colores de la leyenda.
  // Cada espacio toma el color de su hora MÁS LLENA dentro del horario:
  // «hay lugar» quiere decir que se puede vender el horario completo.
  const [lSitio, setLSitio] = useState('');
  const [lIni, setLIni] = useState(0);
  const [lFin, setLFin] = useState(23);
  const [lEstados, setLEstados] = useState<Set<EstadoLibre>>(new Set(['lugar', 'pocos', 'llena']));
  const horasFiltro = useMemo(() => horasDeFranja(lIni, lFin), [lIni, lFin]);
  const todoElDia = horasFiltro.length === 24;
  const libres = useMemo(() => {
    if (!lineas || !rangoOk) return [];
    return lista
      .filter((e) => !lSitio || e.clave === lSitio)
      .map((e) => {
        const m = matrizDeEspacio(lineas, e.clave, slotsDe[e.clave], desde, hasta, ahora);
        const n = m.length; // los del catálogo, o más si alguna línea usa un slot más alto
        const porHora = slotsLibresPorHora(m);
        const estado = estadoLibre(Math.min(...horasFiltro.map((h) => porHora[h])), n);
        // Por slot, sus horas libres dentro del horario (se ve con un sitio elegido).
        const porSlot = m.map((fila, i) => ({
          slot: i + 1,
          horas: horasFiltro.filter((h) => fila[h].estado === 'libre'),
        }));
        return { e, n, porHora, estado, porSlot };
      });
  }, [lineas, lista, slotsDe, desde, hasta, rangoOk, ahora, lSitio, horasFiltro]);
  const libresVisibles = libres.filter((x) => lEstados.has(x.estado));
  const cuentaEstado = (k: EstadoLibre) => libres.filter((x) => x.estado === k).length;

  // ---------- Matriz (como la del calculator) ----------
  const yaPaso = ocultarPasadas && rangoOk && hasta < hoy;
  const diasRango = rangoOk ? diasDelRango(desde, hasta).length : 0;
  const lineasFiltradas = useMemo(
    () => (lineas || []).filter((l) => (!fNeg || l.negociacion === fNeg) && (!fEst || l.estatus === fEst)),
    [lineas, fNeg, fEst]
  );
  const matriz = useMemo(() => {
    if (!lineas || !rangoOk || yaPaso) return null;
    const filas: { e: EspacioVV; slot: number; celdas: Celda[]; ocupadas: number }[] = [];
    for (const e of lista) {
      if (fSitio && e.clave !== fSitio) continue;
      matrizDeEspacio(lineasFiltradas, e.clave, slotsDe[e.clave], desde, hasta, ahora).forEach((celdas, i) => {
        const slot = i + 1;
        if (!mostrar912 && slot > SLOTS_ESTANDAR) return;
        // Como el calculator: ocultar convencionales esconde la fila entera.
        if (ocultarConv && celdas.some((c) => c.lineas.some((l) => l.convencional))) return;
        const ocupadas = celdas.filter((c) => c.lineas.length > 0).length;
        if (soloLibres && ocupadas >= 24) return;
        filas.push({ e, slot, celdas, ocupadas });
      });
    }
    const total = filas.length * 24;
    const ocupadas = filas.reduce((a, f) => a + f.ocupadas, 0);
    return {
      filas,
      conLibres: filas.filter((f) => f.ocupadas < 24).length,
      ocupadas,
      pctLibre: total ? Math.round((100 * (total - ocupadas)) / total) : 0,
    };
  }, [lineas, lineasFiltradas, lista, slotsDe, desde, hasta, rangoOk, yaPaso, ahora, fSitio, mostrar912, ocultarConv, soloLibres]);

  const filaSel = sel && matriz ? matriz.filas.find((f) => f.e.clave === sel.espacio && f.slot === sel.slot) : null;
  const celda = sel && filaSel ? filaSel.celdas[sel.hora] : null;

  // Detalle al pasar el cursor (solo con mouse): se pinta a mano, sin
  // volver a dibujar las miles de celdas en cada movimiento.
  const tipRef = useRef<HTMLDivElement>(null);
  const conCursor = useMemo(() => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover)').matches, []);
  const celdaDeEvento = (ev: { target: EventTarget }) => {
    const td = (ev.target as HTMLElement).closest?.('td[data-h]') as HTMLElement | null;
    if (!td || !matriz) return null;
    const f = matriz.filas[Number(td.dataset.f)];
    const hora = Number(td.dataset.h);
    return f ? { f, hora, c: f.celdas[hora] } : null;
  };
  const moverTip = (ev: React.MouseEvent) => {
    const tip = tipRef.current;
    if (!tip || !conCursor) return;
    const x = celdaDeEvento(ev);
    if (!x || !x.c.lineas.length) {
      tip.style.display = 'none';
      return;
    }
    const titulo = `${etiquetaMatriz(x.f.e)} · slot ${x.f.slot} · ${dosDigitos(x.hora)}:00`;
    const extra = x.c.lineas.length > 1 ? [`y ${x.c.lineas.length - 1} más`] : [];
    tip.textContent = [titulo, ...textoLinea(x.c.lineas[0]), ...extra].join('\n');
    tip.style.display = 'block';
    tip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - 300)}px`;
    // Cerca del borde de abajo se pone arriba del cursor, para que no se corte.
    const alto = tip.offsetHeight;
    const abajo = ev.clientY + 14;
    tip.style.top = `${abajo + alto > window.innerHeight - 8 ? Math.max(8, ev.clientY - alto - 10) : abajo}px`;
  };
  const ocultarTip = () => {
    if (tipRef.current) tipRef.current.style.display = 'none';
  };

  const filasVisibles = !matriz
    ? 0
    : fSitio || todasLasFilas
      ? matriz.filas.length
      : Math.min(FILAS_DE_ENTRADA, matriz.filas.length);

  // La tabla se arma solo cuando cambia la matriz: tocar una celda o mover
  // el cursor no la vuelve a dibujar (con «Todos» son cientos de filas × 24 horas).
  const tablaMatriz = useMemo(() => {
    if (!matriz) return null;
    const pegadoArriba: React.CSSProperties = { position: 'sticky', top: 0, background: 'var(--panel2)', zIndex: 2 };
    const pegadoIzq: React.CSSProperties = {
      position: 'sticky',
      left: 0,
      background: 'var(--panel2)',
      zIndex: 1,
      textAlign: 'left',
      padding: '4px 8px',
      whiteSpace: 'nowrap',
      borderRight: '1px solid var(--line)',
      borderBottom: '1px solid var(--line)',
    };
    return (
      <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12, width: 'max-content', minWidth: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...pegadoArriba, ...pegadoIzq, zIndex: 3, color: 'var(--muted)' }}>Sitio · Slot</th>
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} style={{ ...pegadoArriba, color: 'var(--muted)', fontWeight: 700, padding: '6px 0', minWidth: 26 }}>
                {dosDigitos(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matriz.filas.slice(0, filasVisibles).map((f, i) => (
            <tr key={`${f.e.clave}-${f.slot}`}>
              <td style={pegadoIzq}>
                <b>{etiquetaMatriz(f.e)}</b> · slot {f.slot}
              </td>
              {f.celdas.map((c, h) => (
                <td
                  key={h}
                  data-f={i}
                  data-h={h}
                  style={{
                    width: 26,
                    minWidth: 26,
                    height: 26,
                    background: COLOR_CELDA[tipoCelda(c)],
                    borderRight: '1px solid var(--line)',
                    borderBottom: '1px solid var(--line)',
                    cursor: 'pointer',
                  }}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }, [matriz, filasVisibles]);

  // Al tocar una celda, su detalle queda a la vista (en el celular no hay cursor).
  const detalleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sel) detalleRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [sel]);

  // La celda tocada se marca a mano, como el tooltip: con estado React
  // habría que redibujar las miles de celdas. Se vuelve a buscar cada vez
  // que la tabla cambia, porque React reusa las celdas de otra fila. El
  // anillo doble (texto y fondo) se ve sobre cualquier color.
  const tablaRef = useRef<HTMLDivElement>(null);
  const marcadaRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (marcadaRef.current) marcadaRef.current.style.boxShadow = '';
    marcadaRef.current = null;
    if (!sel || !matriz) return;
    const i = matriz.filas.findIndex((f) => f.e.clave === sel.espacio && f.slot === sel.slot);
    const td = i < 0 ? null : tablaRef.current?.querySelector<HTMLElement>(`td[data-f="${i}"][data-h="${sel.hora}"]`);
    if (!td) return;
    td.style.boxShadow = 'inset 0 0 0 2px var(--txt), inset 0 0 0 4px var(--bg)';
    marcadaRef.current = td;
  }, [sel, matriz, tablaMatriz]);

  // Columnas y pórticos trabajan con 8 o 12 slots (Erik, 19-oct-2026).
  const [ajustando, setAjustando] = useState(false);
  const ajustarSlots = async (clave: string, n: number) => {
    if (n === slotsDe[clave]) return;
    const e = lista.find((x) => x.clave === clave);
    if (!confirm(`¿Dejar ${e ? nombreEspacio(e) : clave} con ${n} slots? Cambia su disponibilidad y su % de ocupación.`))
      return;
    setAjustando(true);
    // La función truena si no aplica (sin permiso, slot ocupado más arriba,
    // espacio inactivo): un error aquí nunca se ve como éxito.
    const { error } = await sb.rpc('ajustar_slots_vv', { p_clave: clave, p_slots: n });
    setAjustando(false);
    if (error) {
      alert('No se pudo cambiar: ' + error.message);
      return;
    }
    setSel(null);
    onCatalogo?.();
  };

  // ---------- Ocupación ----------
  // Ocupación del mes elegido: solo si ese mes tiene plano (sin plano no
  // se inventa un 0 %).
  const ocupacion = useMemo(
    () =>
      lineasMes && esMes(mes) && !mesSinPlano
        ? ocupacionDelMes(
            lineasMes,
            lista.map((e) => e.clave),
            slotsDe,
            mes,
            ahora
          )
        : [],
    [lineasMes, lista, slotsDe, mes, mesSinPlano, ahora]
  );
  const bloqueDe = (f: (typeof ocupacion)[number]) => (banda === 'mensual' ? f.mensual : f.bandas[banda]);
  const promedio = (k: 'pOcupado' | 'pVenta' | 'pBonificacion') =>
    ocupacion.length ? ocupacion.reduce((a, f) => a + bloqueDe(f)[k], 0) / ocupacion.length : 0;
  const hayIntercambio = ocupacion.some((f) => f.mensual.intercambio > 0);
  const porClave = useMemo(() => new Map(lista.map((e) => [e.clave, e])), [lista]);

  const exportarOcupacion = async () => {
    let XLSX: typeof import('xlsx');
    try {
      XLSX = await cargarXlsx();
    } catch {
      alert('No se pudo preparar el Excel. Revisa tu conexión e inténtalo de nuevo.');
      return;
    }
    const nombre = (clave: string) => {
      const e = porClave.get(clave);
      return e ? nombreEspacio(e) : clave;
    };
    const mensual = [
      [`VÍA VERDE · OCUPACIÓN ${etiquetaMes(mes).toUpperCase()}`],
      [],
      ['ESPACIO', 'SLOTS', 'CAPACIDAD', 'OCUPADO', 'VENTA', 'BONIFICACIÓN', 'INTERCAMBIO', '% OCUPACIÓN', '% VENTA', '% BONIFICACIÓN', '% INTERCAMBIO'],
      ...ocupacion.map((f) => [
        nombre(f.espacio),
        f.slots,
        f.mensual.capacidad,
        f.mensual.ocupado,
        f.mensual.venta,
        f.mensual.bonificacion,
        f.mensual.intercambio,
        +(f.mensual.pOcupado * 100).toFixed(1),
        +(f.mensual.pVenta * 100).toFixed(1),
        +(f.mensual.pBonificacion * 100).toFixed(1),
        +(f.mensual.pIntercambio * 100).toFixed(1),
      ]),
    ];
    const porBanda = [
      [`VÍA VERDE · % DE OCUPACIÓN POR HORARIO · ${etiquetaMes(mes).toUpperCase()}`],
      [],
      ['ESPACIO', ...BANDAS.map((b) => b.etiqueta)],
      ...ocupacion.map((f) => [nombre(f.espacio), ...BANDAS.map((b) => +(f.bandas[b.clave].pOcupado * 100).toFixed(1))]),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mensual), 'OCUPACION MENSUAL');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(porBanda), 'HORARIO X ESPACIO');
    XLSX.writeFile(wb, `OCUPACION_VIA_VERDE_${mes}.xlsx`);
  };

  // ------------------------------------------------------------
  /** Las horas fuera del horario del filtro se ven apagadas (y el lector de pantalla no las lee). */
  const tira = (porHora: number[], total: number, activas?: number[]) => (
    <div
      role="img"
      aria-label={resumenTira(porHora, total, activas || porHora.map((_, h) => h))}
      style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 1, marginTop: 4 }}
    >
      {porHora.map((x, h) => (
        <div
          key={h}
          style={{
            height: 14,
            borderRadius: 2,
            background: colorLibres(x, total),
            opacity: !activas || activas.includes(h) ? 1 : 0.2,
          }}
        />
      ))}
    </div>
  );

  /** Tarjeta de resumen, como las del calculator. */
  const kpi = (n: string, texto: string, color: string) => (
    <div className="inc" style={{ margin: 0, padding: '10px 12px' }}>
      <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1.1 }}>{n}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{texto}</div>
    </div>
  );

  // 11 px (antes 9, ilegible en el teléfono). minmax(0, 1fr): el número
  // puede salirse a la columna vacía de al lado sin ensanchar la suya, y la
  // regla sigue alineada con las tiras.
  const reglaHoras = (
    <div
      aria-hidden="true"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(24, minmax(0, 1fr))', fontSize: 11, color: 'var(--muted)' }}
    >
      {Array.from({ length: 24 }, (_, h) => (
        <span key={h} style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>
          {h % 6 === 0 ? h : ''}
        </span>
      ))}
    </div>
  );

  return (
    <div>
      <div className="toolbar filtros-pildora" style={{ marginBottom: 10 }}>
        <div className="segmento" role="group" aria-label="Disponibilidad">
          <button type="button" aria-pressed={vista === 'libres'} onClick={() => setVista('libres')}>
            Libres
          </button>
          <button type="button" aria-pressed={vista === 'matriz'} onClick={() => setVista('matriz')}>
            Matriz
          </button>
          <button type="button" aria-pressed={vista === 'ocupacion'} onClick={() => setVista('ocupacion')}>
            Ocupación
          </button>
        </div>
        {puedeImportar && (
          <button type="button" className="btn ghost sm" onClick={() => setImportando(true)}>
            <Ic i={Upload} />Importar plano
          </button>
        )}
      </div>

      {err && (
        <div className="inc" style={{ color: 'var(--st-rojo)', marginBottom: 10 }}>
          {err}
        </div>
      )}

      {hayPlanos === null ? (
        !err && <div style={{ color: 'var(--muted)' }}>Cargando…</div>
      ) : !hayPlanos ? (
        <div className="inc">
          Todavía no hay un plano de columnas cargado.
          {puedeImportar ? ' Toca «Importar plano» y elige el Excel del mes.' : ' Comercial lo importa desde aquí.'}
        </div>
      ) : (
        <>
          {vista === 'ocupacion' ? (
            <div className="chips" style={{ marginBottom: 12, alignItems: 'center' }}>
              <input
                type="month"
                value={mesElegido}
                onChange={(e) => setMesElegido(e.target.value)}
                style={{ width: 'auto' }}
                aria-label="Mes del plano"
                placeholder="AAAA-MM"
              />
              <span className="tag">
                {cargandoMes
                  ? 'Cargando…'
                  : !esMes(mesElegido)
                    ? 'Escribe el mes como AAAA-MM'
                    : mesSinPlano
                      ? `No hay plano de ${etiquetaMes(mes)}`
                      : `Plano de ${etiquetaMes(mes)}`}
              </span>
            </div>
          ) : (
            rango && (
              <div className="chips" style={{ marginBottom: 12, alignItems: 'center' }}>
                {(() => {
                  const usados = [...new Set(rango.planos.map((p) => p.plano).filter((p): p is string => !!p))];
                  const prestados = rango.planos.filter((p) => p.plano && p.plano !== p.mes);
                  const sinNada = rango.planos.filter((p) => !p.plano);
                  return (
                    <>
                      <span className="tag">
                        {usados.length
                          ? `Plano${usados.length > 1 ? 's' : ''} de ${usados.map(etiquetaMes).join(' y ')}`
                          : 'Sin plano para estas fechas'}
                      </span>
                      {prestados.length > 0 && (
                        <span className="tag" style={{ color: 'var(--st-ambar)' }}>
                          {prestados.map((p) => etiquetaMes(p.mes)).join(', ')} sin plano propio: se usa el de{' '}
                          {[...new Set(prestados.map((p) => etiquetaMes(p.plano!)))].join(', ')}
                        </span>
                      )}
                      {sinNada.length > 0 && usados.length > 0 && (
                        <span className="tag" style={{ color: 'var(--st-ambar)' }}>
                          Sin plano: {sinNada.map((p) => etiquetaMes(p.mes)).join(', ')}
                        </span>
                      )}
                      {cargandoRango && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Cargando…</span>}
                    </>
                  );
                })()}
              </div>
            )
          )}

          {vista !== 'ocupacion' && (
            <div className="row2" style={{ marginBottom: 10 }}>
              <div className="field">
                <label htmlFor={uid + 'desde'}>Desde</label>
                <input id={uid + 'desde'} type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor={uid + 'hasta'}>Hasta</label>
                <input
                  id={uid + 'hasta'}
                  type="date"
                  value={hasta}
                  min={desde}
                  onChange={(e) => setHasta(e.target.value)}
                />
              </div>
            </div>
          )}
          {vista !== 'ocupacion' && !rangoOk && (
            <div className="phint">
              Elige un rango: «hasta» no puede ser antes de «desde», y de hasta 400 días.
            </div>
          )}
          {vista !== 'ocupacion' && rangoOk && !rango && <div className="phint">Cargando…</div>}
          {vista !== 'ocupacion' && rangoOk && rango && rango.lineas.length === 0 && (
            <div className="phint">El plano no tiene nada en estas fechas: todo sale libre.</div>
          )}

          {/* ---------- Libres ---------- */}
          {vista === 'libres' && rangoOk && (
            <>
              <div className="row2">
                <div className="field">
                  <label htmlFor={uid + 'lsitio'}>Sitio</label>
                  <select id={uid + 'lsitio'} value={lSitio} onChange={(e) => setLSitio(e.target.value)}>
                    <option value="">Todos</option>
                    {lista.map((e) => (
                      <option key={e.clave} value={e.clave}>
                        {etiquetaMatriz(e)} · {slotsDe[e.clave]} slots
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={uid + 'lini'}>Horario</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select
                      id={uid + 'lini'}
                      value={lIni}
                      onChange={(e) => setLIni(Number(e.target.value))}
                      aria-label="Desde la hora"
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>
                          {dosDigitos(h)}:00
                        </option>
                      ))}
                    </select>
                    <span style={{ color: 'var(--muted)' }}>a</span>
                    <select value={lFin} onChange={(e) => setLFin(Number(e.target.value))} aria-label="Hasta la hora">
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>
                          {dosDigitos(h)}:59
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              {/* La leyenda también filtra: toca un color para mostrarlo u ocultarlo.
                  Con salto de línea: en el celular la fila deslizable cortaba «Llena». */}
              <div className="toolbar filtros-pildora" style={{ marginBottom: 8, flexWrap: 'wrap', overflowX: 'visible' }}>
                {ESTADOS_LIBRE.map(({ k, texto, color }) => {
                  const on = lEstados.has(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      className={'btn ghost sm' + (on ? ' on' : '')}
                      aria-pressed={on}
                      onClick={() =>
                        setLEstados((s) => {
                          const n = new Set(s);
                          if (n.has(k)) n.delete(k);
                          else n.add(k);
                          return n;
                        })
                      }
                    >
                      <span
                        style={{
                          display: 'inline-block',
                          width: 12,
                          height: 12,
                          borderRadius: 3,
                          marginRight: 6,
                          background: color,
                          opacity: on ? 1 : 0.35,
                        }}
                      />
                      {texto} · {cuentaEstado(k)}
                    </button>
                  );
                })}
                {!todoElDia && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => {
                      setLIni(0);
                      setLFin(23);
                    }}
                  >
                    Todo el día
                  </button>
                )}
              </div>
              <p className="phint" style={{ marginTop: 0 }}>
                Una hora está libre si algún slot está libre <b>todos</b> los días del rango. Cada espacio toma el color
                de su hora más llena {todoElDia ? 'del día' : 'dentro del horario'}: verde, hay lugar; ámbar, quedan
                pocos slots; rojo, llena. Toca un espacio para ver su matriz.
              </p>
              {reglaHoras}
              {libresVisibles.length === 0 && (
                <div className="inc" style={{ marginTop: 6 }}>
                  Ningún espacio con esos filtros.
                </div>
              )}
              <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
                {libresVisibles.map(({ e, n, porHora, porSlot }) => (
                  <button
                    key={e.clave}
                    type="button"
                    className="inc"
                    style={{ textAlign: 'left', width: '100%', cursor: 'pointer', margin: 0 }}
                    onClick={() => {
                      setFSitio(e.clave);
                      setSel(null);
                      setVista('matriz');
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                      <b>{nombreEspacio(e)}</b>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{n} slots</span>
                    </div>
                    {tira(porHora, n, todoElDia ? undefined : horasFiltro)}
                    {/* Con un sitio elegido: una barra por slot SOLO con lo libre
                        (Erik, 19-oct-2026: el texto «Con lugar» y las líneas de
                        «ocupado» confundían). Verde = libre en el horario. */}
                    {lSitio && (
                      <div
                        style={{ display: 'grid', gridTemplateColumns: '52px 1fr', gap: 4, alignItems: 'center', marginTop: 10 }}
                      >
                        <span />
                        {reglaHoras}
                        {porSlot
                          .filter(({ horas }) => horas.length > 0)
                          .map(({ slot, horas }) => (
                            <div key={slot} style={{ display: 'contents' }}>
                              <span style={{ fontSize: 12, fontWeight: 700 }} aria-hidden="true">
                                Slot {slot}
                              </span>
                              <div
                                role="img"
                                aria-label={`Slot ${slot}, libre ${franjasTexto(horas)}`}
                                style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 1 }}
                              >
                                {Array.from({ length: 24 }, (_, h) => (
                                  <div
                                    key={h}
                                    style={{
                                      height: 12,
                                      borderRadius: 2,
                                      background: horas.includes(h) ? 'var(--st-verde)' : 'var(--fill)',
                                    }}
                                  />
                                ))}
                              </div>
                            </div>
                          ))}
                      </div>
                    )}
                    {lSitio && porSlot.some(({ horas }) => horas.length === 0) && (
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                        No salen los slots sin horas libres {todoElDia ? 'en el rango' : 'en ese horario'}.
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* ---------- Matriz ---------- */}
          {vista === 'matriz' && rangoOk && (
            <>
              <div className="row2">
                <div className="field">
                  <label htmlFor={uid + 'msitio'}>Sitio</label>
                  <select
                    id={uid + 'msitio'}
                    value={fSitio}
                    onChange={(e) => {
                      setFSitio(e.target.value);
                      setSel(null);
                    }}
                  >
                    <option value="">Todos</option>
                    {lista.map((e) => (
                      <option key={e.clave} value={e.clave}>
                        {etiquetaMatriz(e)} · {slotsDe[e.clave]} slots
                      </option>
                    ))}
                  </select>
                </div>
                {puedeImportar && fSitio && (
                  <div className="field">
                    <label htmlFor={uid + 'mslots'}>Slots de este sitio</label>
                    <select
                      id={uid + 'mslots'}
                      value={slotsDe[fSitio]}
                      disabled={ajustando}
                      onChange={(e) => ajustarSlots(fSitio, Number(e.target.value))}
                    >
                      {[...new Set([8, 12, slotsDe[fSitio]])]
                        .sort((a, b) => a - b)
                        .map((n) => (
                          <option key={n} value={n}>
                            {n} slots
                          </option>
                        ))}
                    </select>
                  </div>
                )}
              </div>
              <button
                type="button"
                className={'btn ghost sm' + (filtrosActivos ? ' on' : '')}
                aria-expanded={masFiltros}
                aria-controls={uid + 'masfiltros'}
                onClick={() => setMasFiltros((v) => !v)}
                style={{ marginBottom: 10 }}
              >
                <Ic i={masFiltros ? ChevronDown : ChevronRight} />
                Más filtros
                {filtrosActivos > 0 && ` · ${filtrosActivos} activo${filtrosActivos === 1 ? '' : 's'}`}
              </button>
              {masFiltros && (
                <div id={uid + 'masfiltros'}>
                  <div className="row2">
                    <div className="field">
                      <label htmlFor={uid + 'mneg'}>Negociación</label>
                      <select
                        id={uid + 'mneg'}
                        value={fNeg}
                        onChange={(e) => {
                          setFNeg(e.target.value);
                          setSel(null);
                        }}
                      >
                        <option value="">Todas</option>
                        <option value="VENTA">Venta</option>
                        <option value="BONIFICACION">Bonificación</option>
                        <option value="INTERCAMBIO">Intercambio</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor={uid + 'mest'}>Estatus</label>
                      <select
                        id={uid + 'mest'}
                        value={fEst}
                        onChange={(e) => {
                          setFEst(e.target.value);
                          setSel(null);
                        }}
                      >
                        <option value="">Todos</option>
                        <option value="vendida">Vendida</option>
                        <option value="reservada">Reservada (apartada)</option>
                        <option value="pautada">Pautada</option>
                      </select>
                    </div>
                  </div>
                  {/* Casillas en .pildora-check: 34–38 px de alto, a tamaño de dedo (antes .tag, ~18 px). */}
                  <div className="chips" style={{ marginTop: 0, marginBottom: 10 }}>
                    {(
                      [
                        ['Ocultar fechas pasadas', ocultarPasadas, setOcultarPasadas],
                        ['Solo con horas libres', soloLibres, setSoloLibres],
                        ['Ocultar convencionales', ocultarConv, setOcultarConv],
                        ['Mostrar slots 9–12', mostrar912, setMostrar912],
                      ] as const
                    ).map(([texto, valor, poner]) => (
                      <label key={texto} className="pildora-check">
                        <input
                          type="checkbox"
                          checked={valor}
                          onChange={(e) => {
                            poner(e.target.checked);
                            setSel(null);
                          }}
                        />
                        {texto}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {yaPaso ? (
                <div className="inc">
                  Ese rango ya pasó. Elige fechas de hoy en adelante, o quita «Ocultar fechas pasadas» (en «Más
                  filtros») para revisar lo que hubo.
                </div>
              ) : (
                matriz && (
                  <>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                        gap: 8,
                        marginBottom: 10,
                      }}
                    >
                      {kpi(matriz.filas.length.toLocaleString('es-MX'), 'Slots con esos filtros', 'var(--st-azul)')}
                      {kpi(matriz.conLibres.toLocaleString('es-MX'), 'Slots con horas libres', 'var(--st-verde)')}
                      {kpi(
                        matriz.ocupadas.toLocaleString('es-MX'),
                        diasRango > 1 ? 'Horas·slot ocupadas (rango)' : 'Horas·slot ocupadas',
                        'var(--st-rojo)'
                      )}
                      {kpi(
                        `${matriz.pctLibre}%`,
                        diasRango > 1 ? `Disponible en ${diasRango} días` : 'Disponibilidad global',
                        'var(--st-ambar)'
                      )}
                    </div>
                    <div className="chips" style={{ marginBottom: 6 }}>
                      {(Object.keys(COLOR_CELDA) as TipoCelda[]).map((k) => (
                        <span key={k} className="tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span
                            style={{
                              width: 12,
                              height: 12,
                              borderRadius: 3,
                              background: COLOR_CELDA[k],
                              border: '1px solid var(--line)',
                            }}
                          />
                          {NOMBRE_TIPO[k]}
                        </span>
                      ))}
                    </div>
                    <p className="phint" style={{ marginTop: 0 }}>
                      {conCursor
                        ? 'Pasa el cursor sobre una celda ocupada para ver la campaña, o tócala para fijar el detalle. '
                        : 'Toca una celda para ver qué campaña está ahí. '}
                      En un rango, una hora se marca ocupada si lo está en cualquier día; solo queda verde lo libre en
                      todo el rango.
                    </p>
                    {matriz.filas.length === 0 ? (
                      <div className="inc">Ningún slot con esos filtros.</div>
                    ) : (
                      <div
                        ref={tablaRef}
                        style={{ overflow: 'auto', maxHeight: '65vh', border: '1px solid var(--line)', borderRadius: 12 }}
                        onClick={(ev) => {
                          const x = celdaDeEvento(ev);
                          if (x) setSel({ espacio: x.f.e.clave, slot: x.f.slot, hora: x.hora });
                        }}
                        onMouseMove={moverTip}
                        onMouseLeave={ocultarTip}
                      >
                        {tablaMatriz}
                      </div>
                    )}
                    {filasVisibles < matriz.filas.length && (
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}
                      >
                        <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                          Se ven los primeros {filasVisibles} de {matriz.filas.length.toLocaleString('es-MX')} slots.
                          Elige un sitio para ver solo los suyos.
                        </span>
                        <button type="button" className="btn ghost sm" onClick={() => setTodasLasFilas(true)}>
                          Mostrar todas
                        </button>
                      </div>
                    )}
                    {sel && filaSel && celda && (
                      <div ref={detalleRef} className="inc" style={{ marginTop: 12 }}>
                        <div className="folio">
                          {etiquetaMatriz(filaSel.e)} · slot {sel.slot} · {dosDigitos(sel.hora)}:00 –{' '}
                          {dosDigitos(sel.hora)}:59 · {NOMBRE_TIPO[tipoCelda(celda)]}
                        </div>
                        {celda.lineas.length === 0 ? (
                          <div style={{ fontSize: 13, marginTop: 6 }}>
                            Libre {diasRango > 1 ? 'todos los días del rango' : 'ese día'}.
                          </div>
                        ) : (
                          celda.lineas.map((l, k) => {
                            const [camp, neg, cuando] = textoLinea(l);
                            return (
                              <div key={k} style={{ fontSize: 13, marginTop: 8, lineHeight: 1.45 }}>
                                <b>{camp}</b>
                                <div style={{ color: 'var(--muted)', fontSize: 12 }}>{neg}</div>
                                <div style={{ color: 'var(--muted)', fontSize: 12 }}>{cuando}</div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                    {/* Detalle flotante con el cursor (lo mueve moverTip, sin redibujar la tabla). */}
                    <div
                      ref={tipRef}
                      style={{
                        position: 'fixed',
                        display: 'none',
                        zIndex: 99,
                        pointerEvents: 'none',
                        maxWidth: 280,
                        whiteSpace: 'pre-line',
                        fontSize: 12,
                        lineHeight: 1.45,
                        background: 'var(--panel2)',
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        padding: '8px 11px',
                        boxShadow: '0 6px 24px rgba(0,0,0,.35)',
                      }}
                    />
                  </>
                )
              )}
            </>
          )}

          {/* ---------- Ocupación ---------- */}
          {vista === 'ocupacion' && esMes(mes) && mesSinPlano && (
            <div className="inc">
              No hay plano de {etiquetaMes(mes)}.
              {puedeImportar ? ' Importa el Excel de ese mes para ver su ocupación.' : ' Comercial lo importa desde aquí.'}
            </div>
          )}
          {vista === 'ocupacion' && ocupacion.length > 0 && (
            <>
              <div className="toolbar" style={{ marginBottom: 10 }}>
                <select value={banda} onChange={(e) => setBanda(e.target.value)} aria-label="Horario" style={{ width: 'auto' }}>
                  <option value="mensual">Todo el día</option>
                  {BANDAS.map((b) => (
                    <option key={b.clave} value={b.clave}>
                      {b.etiqueta}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn ghost sm" onClick={exportarOcupacion} disabled={!ocupacion.length}>
                  <Ic i={Sheet} />Excel
                </button>
              </div>
              <div className="chips" style={{ marginBottom: 10 }}>
                <span className="tag">Ocupación {pct(promedio('pOcupado'))}</span>
                <span className="tag">Venta {pct(promedio('pVenta'))}</span>
                <span className="tag">Bonificación {pct(promedio('pBonificacion'))}</span>
              </div>
              <p className="phint" style={{ marginTop: 0 }}>
                Promedio de {ocupacion.length} espacios en {etiquetaMes(mes)}. Capacidad: 180 jugadas por hora; cada línea
                cuenta aunque comparta slot y hora (como el archivo manual). Las reservas vigentes cuentan.
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ color: 'var(--muted)', textAlign: 'right' }}>
                      <th style={{ textAlign: 'left', padding: '4px 6px' }}>Espacio</th>
                      <th style={{ padding: '4px 6px' }}>Ocup.</th>
                      <th style={{ padding: '4px 6px' }}>Venta</th>
                      <th style={{ padding: '4px 6px' }}>Bonif.</th>
                      {hayIntercambio && <th style={{ padding: '4px 6px' }}>Interc.</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {ocupacion.map((f) => {
                      const b = bloqueDe(f);
                      const e = porClave.get(f.espacio);
                      return (
                        <tr key={f.espacio} style={{ borderTop: '1px solid var(--line)', textAlign: 'right' }}>
                          <td style={{ textAlign: 'left', padding: '6px' }}>
                            {e ? nombreEspacio(e) : f.espacio}
                            <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {f.slots}</span>
                          </td>
                          <td style={{ padding: '6px', fontWeight: 700 }}>{pct(b.pOcupado)}</td>
                          <td style={{ padding: '6px' }}>{pct(b.pVenta)}</td>
                          <td style={{ padding: '6px' }}>{pct(b.pBonificacion)}</td>
                          {hayIntercambio && <td style={{ padding: '6px' }}>{pct(b.pIntercambio)}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {importando && (
        <ImportarPlano
          espacios={espacios}
          onClose={() => setImportando(false)}
          onImportado={(m) => {
            setImportando(false);
            setMesElegido(m);
            setRecarga((x) => x + 1); // vuelve a leer el rango y el mes
            onCatalogo?.(); // el plano pudo cambiar los slots
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Importar el plano de columnas (Excel)
// ------------------------------------------------------------
function ImportarPlano({
  espacios,
  onClose,
  onImportado,
}: {
  espacios: EspacioVV[];
  onClose: () => void;
  onImportado: (mes: string) => void;
}) {
  const [wb, setWb] = useState<WorkBook | null>(null);
  const [hoja, setHoja] = useState('');
  const [res, setRes] = useState<ResultadoPlano | null>(null);
  const [mes, setMes] = useState('');
  const [leyendo, setLeyendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [xlsx, setXlsx] = useState<typeof import('xlsx') | null>(null);
  const uid = useId();

  const activos = useMemo(() => new Set(espacios.map((e) => e.clave)), [espacios]);

  const analizar = (x: typeof import('xlsx'), libro: WorkBook, nombre: string) => {
    setHoja(nombre);
    try {
      const ws = libro.Sheets[nombre];
      const filas = x.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: false });
      const r = leerPlano(filas, nombre);
      setRes(r);
      setMes(r.mes || '');
    } catch (e) {
      // Sin esto, al cambiar de hoja quedaba el análisis de la anterior.
      setRes(null);
      setMes('');
      alert(`No se pudo leer la hoja «${nombre}»: ` + (e as Error).message);
    }
  };

  const elegirArchivo = async (archivo: File | undefined) => {
    if (!archivo) return;
    // Lo del archivo anterior se olvida antes de leer el nuevo: si el nuevo
    // falla, «Importar» no debe subir el viejo.
    setWb(null);
    setRes(null);
    setMes('');
    setHoja('');
    setLeyendo(true);
    try {
      const x = await cargarXlsx();
      // cellDates: sin esto las fechas llegan como número serial de Excel.
      const libro = x.read(await archivo.arrayBuffer(), { cellDates: true });
      setXlsx(x);
      setWb(libro);
      const preferida = libro.SheetNames.find((n) => /^\s*PAUTA/i.test(n)) || libro.SheetNames[0];
      analizar(x, libro, preferida);
    } catch (e) {
      alert('No se pudo leer el archivo: ' + (e as Error).message);
    } finally {
      setLeyendo(false);
    }
  };

  // Lo que el catálogo no tiene activo no se manda: la base rechazaría todo.
  const fuera = useMemo(() => {
    const m = new Map<string, number>();
    res?.lineas.forEach((l) => {
      if (!activos.has(l.espacio)) m.set(l.espacio, (m.get(l.espacio) || 0) + 1);
    });
    return m;
  }, [res, activos]);
  const validas = useMemo(() => (res ? res.lineas.filter((l) => activos.has(l.espacio)) : []), [res, activos]);
  const espaciosPlano = new Set(validas.map((l) => l.espacio)).size;
  // Lo que NO entra, a la vista (antes solo en un aviso cerrado): esas
  // horas saldrían libres aunque en el Excel estén vendidas.
  const descartadas = res ? res.avisos.filter((a) => a.includes('no se tomó')).length : 0;
  const lineasFuera = [...fuera.values()].reduce((a, n) => a + n, 0);

  const importar = async () => {
    if (!res || !validas.length) return;
    if (!esMes(mes)) return alert('Elige el mes del plano.');
    // Cuántas líneas tenía ya ese mes (se reemplazan) y si las fechas
    // cuadran con el mes elegido (el mes sale de la hoja y se puede editar).
    const { count: yaHabia } = await sb
      .from('vv_ocupacion')
      .select('id', { count: 'exact', head: true })
      .eq('origen', 'plano')
      .eq('plano_mes', mes);
    const tocanMes = validas.filter((l) => l.inicio.slice(0, 7) <= mes && l.fin.slice(0, 7) >= mes).length;
    const avisos = [
      yaHabia ? `Reemplaza las ${yaHabia} líneas que ya tenía ${etiquetaMes(mes)}.` : `${etiquetaMes(mes)} no tenía plano.`,
      descartadas || lineasFuera
        ? `OJO: ${descartadas + lineasFuera} fila(s) no se toman y esas horas saldrán libres.`
        : '',
      tocanMes < validas.length / 2
        ? `OJO: solo ${tocanMes} de ${validas.length} líneas tocan ${etiquetaMes(mes)}; revisa que sea el mes correcto.`
        : '',
    ].filter(Boolean);
    if (!confirm(`¿Importar ${validas.length} líneas como el plano de ${etiquetaMes(mes)}?\n\n${avisos.join('\n')}`))
      return;
    setGuardando(true);
    const slots: Record<string, number> = {};
    Object.entries(res.slotsVistos).forEach(([k, v]) => {
      if (activos.has(k)) slots[k] = v;
    });
    const { data, error } = await sb.rpc('importar_plano_vv', {
      p_mes: mes,
      p_lineas: validas.map((l) => ({
        fila: l.fila, // si la base rechaza una línea, el error dice su renglón del Excel
        espacio: l.espacio,
        slot: l.slot,
        campana: l.campana,
        negociacion: l.negociacion,
        convencional: l.convencional,
        inicio: l.inicio,
        fin: l.fin,
        dias: l.dias,
        horas: l.horas,
        estatus: l.estatus,
      })),
      p_slots: slots,
    });
    setGuardando(false);
    if (error) {
      // Si se cayó la señal, la base pudo aplicarlo: decirlo. Reintentar es
      // seguro porque importar reemplaza el mes completo.
      const red = /fetch|network|load failed|timeout/i.test(error.message);
      alert(
        red
          ? `No se pudo confirmar la importación (señal). Revisa si ya aparece el plano de ${etiquetaMes(mes)}; volver a importar es seguro.`
          : 'No se pudo importar: ' + error.message
      );
      return;
    }
    const r = (data || {}) as { nuevas?: number; borradas?: number; slots_cambiados?: number };
    // Un "éxito" que no guardó nada no es éxito.
    if (!r.nuevas) {
      alert('La base no guardó ninguna línea. Revisa tu rol (comercial o manager) e inténtalo de nuevo.');
      return;
    }
    alert(
      `Listo: ${r.nuevas} líneas del plano de ${etiquetaMes(mes)}` +
        (r.borradas ? ` (reemplazó ${r.borradas} que había)` : '') +
        (r.slots_cambiados ? `; ${r.slots_cambiados} espacios cambiaron de número de slots` : '') +
        '.'
    );
    onImportado(mes);
  };

  return (
    <div className="overlay" onClick={() => !guardando && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <CerrarModal onClick={onClose} disabled={guardando} />
        <h3 style={{ marginTop: 0 }}>
          <Ic i={LayoutGrid} />Importar plano de columnas
        </h3>
        <p className="phint">
          El Excel del mes («PAUTA JUNIO»…). Se leen las columnas por su nombre: Columna, Slots, Tipo Pauta, Campaña,
          Negociación, Fecha Inicio, Fecha Fin, Estatus, Días Proyección y Horarios. Primero ves qué se leyó; nada se
          guarda hasta que confirmes.
        </p>
        <div className="field">
          <input
            type="file"
            aria-label="Excel del plano"
            accept=".xlsx,.xls"
            disabled={leyendo || guardando}
            onChange={(e) => elegirArchivo(e.target.files?.[0])}
          />
        </div>
        {leyendo && <div className="phint">Leyendo el archivo…</div>}

        {wb && xlsx && wb.SheetNames.length > 1 && (
          <div className="field">
            <label htmlFor={uid + 'hoja'}>Hoja</label>
            <select
              id={uid + 'hoja'}
              value={hoja}
              onChange={(e) => analizar(xlsx, wb, e.target.value)}
              disabled={guardando}
            >
              {wb.SheetNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        )}

        {res && res.faltan.length > 0 && (
          <div className="inc" style={{ color: 'var(--st-rojo)' }}>
            No encontré estas columnas en la hoja «{hoja}»: {res.faltan.join(', ')}. Revisa que sea el plano de columnas.
          </div>
        )}

        {res && !res.faltan.length && (
          <>
            <div className="field">
              <label htmlFor={uid + 'mes'}>Mes del plano</label>
              <input
                id={uid + 'mes'}
                type="month"
                value={mes}
                onChange={(e) => setMes(e.target.value)}
                disabled={guardando}
              />
            </div>
            <div className="chips" style={{ marginBottom: 8 }}>
              <span className="tag">{validas.length} líneas</span>
              <span className="tag">{espaciosPlano} espacios</span>
              <span className="tag">{validas.filter((l) => l.estatus === 'reservada').length} apartadas</span>
            </div>
            {(descartadas > 0 || lineasFuera > 0) && (
              <div className="inc" style={{ marginBottom: 8, color: 'var(--st-ambar)' }}>
                <b>
                  {descartadas + lineasFuera} fila(s) no se toman: esas horas saldrán libres aunque en el Excel estén
                  ocupadas.
                </b>{' '}
                Revisa los avisos de abajo y corrige el Excel si son ventas reales.
              </div>
            )}
            {fuera.size > 0 && (
              <div className="inc" style={{ marginBottom: 8 }}>
                <b>No se importan</b> (no están activos en el catálogo de Vía Verde):{' '}
                {[...fuera.entries()].map(([k, n]) => `${k} (${n})`).join(', ')}.
              </div>
            )}
            {res.avisos.length > 0 && (
              <details className="inc" style={{ marginBottom: 8 }} open={descartadas > 0}>
                <summary>{res.avisos.length} aviso(s) al leer</summary>
                <div style={{ fontSize: 12, marginTop: 6, display: 'grid', gap: 4 }}>
                  {res.avisos.slice(0, 40).map((a, i) => (
                    <div key={i}>{a}</div>
                  ))}
                  {res.avisos.length > 40 && <div>… y {res.avisos.length - 40} más.</div>}
                </div>
              </details>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={guardando}>
            Cancelar
          </button>
          <button className="btn" onClick={importar} disabled={guardando || !validas.length}>
            {guardando ? 'Importando…' : 'Importar'}
          </button>
        </div>
      </div>
    </div>
  );
}
