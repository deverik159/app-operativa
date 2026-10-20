// ============================================================
// src/modules/rutas/AvisoGemelasVacias.tsx
// Aviso del resumen de importación (KML y Excel de operación de Biobox).
//
// Desde las rutas combinadas (19-oct-2026), una capa cuyo nombre coincide
// con una ruta Combinada manda TODAS sus máquinas a esa Combinada. Las rutas
// Impreso y Digital que tenían ese mismo nombre (las "gemelas") se quedan
// sin paradas, pero conservan a sus monitoristas, que verían una ruta vacía
// en Mis rutas (también si la ruta está inactiva: ahí se enseña con la marca
// "inactiva"). La base solo lo informa en `gemelas_vacias` del resultado de
// importar_rutas_capas (migración rutas_combinadas_seguimiento); quitar a los
// monitoristas o desactivar la ruta lo decide el coordinador.
//
// Si la llave no viene (migración sin aplicar), no se pinta nada: el resumen
// queda igual que antes.
// ============================================================
import { textoMedio } from './rutasComun';

/** Una fila de `gemelas_vacias` tal como la devuelve importar_rutas_capas. */
export type GemelaVacia = {
  ruta_id: number;
  numero: number;
  tipo: string;
  nombre: string | null;
  activa: boolean;
  monitoristas: number;
};

type Props = {
  gemelas?: GemelaVacia[];
};

function textoMonitoristas(n: number): string {
  if (n === 0) return 'sin monitoristas';
  return n === 1 ? '1 monitorista asignado' : `${n} monitoristas asignados`;
}

function AvisoGemelasVacias({ gemelas }: Props) {
  if (!gemelas || gemelas.length === 0) return null;

  const conMonitoristas = gemelas.some((g) => g.monitoristas > 0);
  const varias = gemelas.length > 1;

  return (
    <div className="banner" style={{ marginBottom: 12 }}>
      <b>
        {varias
          ? `${gemelas.length} rutas quedaron sin paradas`
          : 'Una ruta quedó sin paradas'}
      </b>
      : sus máquinas ahora están en la ruta Combinada del mismo nombre.
      <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
        {gemelas.map((g) => (
          <li key={g.ruta_id}>
            Ruta {g.numero} · {textoMedio(g.tipo)}
            {g.nombre ? ` · ${g.nombre}` : ''}
            {!g.activa ? ' (inactiva)' : ''} · {textoMonitoristas(g.monitoristas)}
          </li>
        ))}
      </ul>
      {conMonitoristas
        ? 'Sus monitoristas verían una ruta vacía en Mis rutas: desde el detalle ' +
          'de cada ruta quítalos o reasígnalos a la Combinada, y desactívala ' +
          '(«Ruta activa» al editarla) si ya no sirve.'
        : 'Si ya no sirven, desactívalas desde el detalle de cada ruta ' +
          '(«Ruta activa» al editarla).'}
    </div>
  );
}

export default AvisoGemelasVacias;
