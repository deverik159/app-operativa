// ============================================================
// src/modules/rutas/ImportarKmlModal.tsx
// Importa las rutas desde el KML de un mapa de Google My Maps.
//
// Cada CAPA del mapa se vuelve una ruta; cada MARCADOR, una parada.
//
// POR QUÉ HAY VISTA PREVIA Y NO IMPORTACIÓN DIRECTA: los marcadores se
// empatan con `inventario` por el número que traen en el nombre
// ("Leibnitz - 116"), y ese nombre lo escribió gente distinta durante meses.
// Hay marcadores sin número, con el número pegado al nombre, o con un número
// que en realidad es parte de la calle ("OXXO Héroes de 47"). Empatar mal una
// máquina manda al monitorista a otra colonia, así que primero se muestra qué
// empató, con cuánta confianza y por qué, y la importación es una decisión.
//
// Mismo patrón que ImportarPautaModal: leer → previsualizar → confirmar.
// ============================================================
import { useState } from 'react';
import { sb } from '../../lib/supabase';
import { UNIDADES } from '../../lib/constants';
import { leerKml, empatarInventario } from '../../lib/kml';
import type { CapaKml, Empate, Confianza, FilaInventario } from '../../lib/kml';

type Props = {
  /** Sugerencia tomada de la pantalla. NO se usa sin confirmar. */
  unidad: string;
  onClose: () => void;
  onImportado: (resumen: string) => void;
};

type Resultado = {
  rutas_creadas: number;
  rutas_usadas: number;
  ubicaciones: number;
  movidas_de_ruta: number;
  omitidas: number;
  omitidos_ejemplo: string[];
  sobrantes: number;
  sobrantes_borradas: boolean;
};

const COLOR: Record<Confianza, string> = {
  alta: 'var(--ok)',
  media: '#f59e0b',
  baja: '#f97316',
  ninguna: 'var(--bad)',
};

const ETIQUETA: Record<Confianza, string> = {
  alta: 'Empate por ID',
  media: 'Empate por cercanía',
  baja: 'Revisar',
  ninguna: 'Sin empate',
};

function ImportarKmlModal({ unidad: sugerida, onClose, onImportado }: Props) {
  /**
   * Unidad de negocio destino. EMPIEZA VACÍA A PROPÓSITO.
   *
   * Antes se heredaba del selector de la pantalla de Rutas, y eso costó caro:
   * con el selector en Ecovallas se importó el mapa de Biobox contra el
   * inventario de Ecovallas. Como el empate cae a cercanía cuando el nombre
   * no coincide, cada máquina "empató" con la valla que tenía a 40 metros; se
   * crearon rutas con nombre de Biobox llenas de vallas y 16 ubicaciones
   * reales de Ecovallas salieron de su ruta.
   *
   * Un mapa pertenece a UNA unidad, y quien importa lo sabe. Que lo diga.
   */
  const [unidad, setUnidad] = useState('');
  const [invCount, setInvCount] = useState<number | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [importando, setImportando] = useState(false);
  const [err, setErr] = useState('');
  const [avisos, setAvisos] = useState<string[]>([]);
  const [capas, setCapas] = useState<CapaKml[] | null>(null);
  const [empates, setEmpates] = useState<Empate[]>([]);
  const [excluidos, setExcluidos] = useState<Set<string>>(new Set());
  const [quitarFaltantes, setQuitarFaltantes] = useState(false);
  const [verTodo, setVerTodo] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  /**
   * Llave estable de un marcador. Es el índice que asignó el empatador, NO el
   * nombre: en el mapa real hay marcadores homónimos —incluso dentro de la
   * misma capa— y una llave por nombre haría que desmarcar uno desmarcara al
   * otro. Ver la nota de `idx` en lib/kml.ts.
   */
  const llave = (e: Empate) => String(e.idx);

  const onArchivo = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0];
    // Se limpia el input para poder volver a elegir el MISMO archivo después
    // de corregirlo: si no, el navegador no dispara onChange otra vez.
    ev.target.value = '';
    if (!f) return;
    if (!unidad) {
      setErr('Primero elige a qué unidad de negocio pertenece este mapa.');
      return;
    }

    setErr('');
    setAvisos([]);
    setCapas(null);
    setEmpates([]);
    setResultado(null);
    setLeyendo(true);

    try {
      if (/\.kmz$/i.test(f.name)) {
        setErr(
          'Es un .kmz (archivo comprimido). En My Maps, al descargar, marca ' +
            '"Exportar a un archivo .KML" para que salga sin comprimir.'
        );
        setLeyendo(false);
        return;
      }

      const xml = await f.text();
      const { capas: cs, errores } = leerKml(xml);
      if (!cs.length) {
        setErr(errores[0] || 'El archivo no trae capas con marcadores.');
        setLeyendo(false);
        return;
      }

      // Inventario de TODA la unidad, no de un tipo de medio.
      //
      // Las capas del mapa son geográficas y mezclan Digital con Impreso. Si
      // se filtrara por tipo, la mitad de los marcadores no empataría con
      // nada y la vista previa diría "no está en inventario" de máquinas que
      // sí existen. Cada parada entra después a la ruta de SU segmento; de
      // eso se encarga la función de importación.
      const { data, error } = await sb
        .from('inventario')
        .select(
          'site_id,site_legacy_id,vendor_face_id,direccion,tipo_medio,latitud,longitud'
        )
        .eq('unidad_negocio', unidad);
      if (error) {
        setErr('No se pudo leer el inventario: ' + error.message);
        setLeyendo(false);
        return;
      }
      const inv = (data as FilaInventario[]) || [];
      setInvCount(inv.length);
      if (inv.length === 0) {
        setErr(
          `No hay nada en inventario para ${unidad}. Revisa que la unidad de ` +
            'negocio de arriba sea la correcta antes de importar.'
        );
        setLeyendo(false);
        return;
      }

      const emp = empatarInventario(cs, inv);
      setCapas(cs);
      setEmpates(emp);
      // Los que no empataron se excluyen solos: no hay nada que importar de
      // ellos, y así el conteo del botón dice la verdad.
      setExcluidos(
        new Set(
          emp.filter((e) => !e.site_id || e.duplicado).map((e) => llave(e))
        )
      );
      setAvisos(errores);
    } catch (e) {
      setErr('No se pudo leer el archivo: ' + (e as Error).message);
    }
    setLeyendo(false);
  };

  const alternar = (e: Empate) => {
    if (!e.site_id) return; // sin site_id no hay nada que importar
    const k = llave(e);
    // Al INCLUIR hay que verificar que nadie más reclame ya esa máquina:
    // `ruta_ubicaciones` tiene UNIQUE(site_id), así que dos marcadores
    // apuntando al mismo site_id no crean dos paradas, sino que el segundo
    // mueve al primero de ruta sin avisar.
    if (excluidos.has(k)) {
      const yaTomada = empates.some(
        (o) => o.idx !== e.idx && o.site_id === e.site_id && !excluidos.has(llave(o))
      );
      if (yaTomada) {
        setErr(
          `"${e.parada.nombre}" apunta a la misma máquina (${e.site_id}) que ` +
            'otro marcador ya incluido. Solo una parada puede quedarse con ' +
            'ella: desmarca la otra primero.'
        );
        return;
      }
      setErr('');
    }
    setExcluidos((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };

  const incluidos = empates.filter((e) => e.site_id && !excluidos.has(llave(e)));

  const conteo = (c: Confianza) => empates.filter((e) => e.confianza === c).length;

  const importar = async () => {
    if (!capas || incluidos.length === 0) return;
    setImportando(true);
    setErr('');

    // Se reagrupan los empates incluidos por capa, renumerando la secuencia:
    // si se excluyó la parada 3, las siguientes deben correrse, no dejar un
    // hueco que en el mapa se vería como una parada perdida.
    const porCapa = new Map<string, { site_id: string; secuencia: number }[]>();
    capas.forEach((c) => porCapa.set(c.nombre, []));
    // Red de seguridad: aunque `alternar` ya impide incluir dos marcadores
    // con el mismo site_id, aquí se vuelve a garantizar. Un duplicado que se
    // colara no crearía una parada extra: movería la máquina de ruta.
    const usados = new Set<string>();
    incluidos.forEach((e) => {
      const sid = e.site_id as string;
      if (usados.has(sid)) return;
      usados.add(sid);
      const arr = porCapa.get(e.capa) || [];
      arr.push({ site_id: sid, secuencia: arr.length + 1 });
      porCapa.set(e.capa, arr);
    });

    const payload = [...porCapa.entries()]
      .filter(([, paradas]) => paradas.length > 0)
      .map(([nombre, paradas]) => ({ nombre, paradas }));

    // Las máquinas que SÍ venían en el mapa pero no se importaron (se
    // desmarcaron, o su clave no está en este segmento). Se mandan aparte
    // para que la limpieza NO las saque de su ruta: no están fuera del mapa,
    // solo fuera de esta importación.
    const conservar = [
      ...new Set(
        empates
          .filter((e) => e.site_id && !usados.has(e.site_id))
          .map((e) => e.site_id as string)
      ),
    ];

    const { data, error } = await sb.rpc('importar_rutas_capas', {
      p_unidad: unidad,
      p_capas: payload,
      p_quitar_faltantes: quitarFaltantes,
      p_conservar: conservar,
    });
    setImportando(false);

    if (error) {
      setErr('No se pudo importar: ' + error.message);
      return;
    }
    const r = data as Resultado;
    setResultado(r);
    onImportado(
      `${r.ubicaciones} máquinas en ${r.rutas_usadas} rutas ` +
        `(${r.rutas_creadas} nuevas)` +
        (r.movidas_de_ruta ? `, ${r.movidas_de_ruta} cambiaron de ruta` : '') +
        (r.omitidas ? `, ${r.omitidas} omitidas` : '') +
        '.'
    );
  };

  // --- Pantalla de resultado ---
  if (resultado) {
    return (
      <div className="overlay">
        <div className="modal">
          <h2 style={{ margin: '0 0 3px' }}>Importación lista</h2>
          <p className="phint">{unidad}</p>

          <div style={{ display: 'grid', gap: 8, margin: '14px 0' }}>
            {[
              ['Máquinas asignadas a ruta', resultado.ubicaciones],
              ['Rutas usadas', resultado.rutas_usadas],
              ['De ésas, nuevas', resultado.rutas_creadas],
              ['Cambiaron de ruta', resultado.movidas_de_ruta],
              ['Omitidas', resultado.omitidas],
            ].map(([t, n]) => (
              <div
                key={t as string}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}
              >
                <span style={{ fontSize: 13, color: 'var(--muted)', minWidth: 0 }}>
                  {t}
                </span>
                <b>{n}</b>
              </div>
            ))}
          </div>

          {resultado.omitidas > 0 && resultado.omitidos_ejemplo?.length > 0 && (
            <div className="banner" style={{ marginBottom: 12 }}>
              Omitidas porque su clave no existe en el inventario de {unidad}:{' '}
              {resultado.omitidos_ejemplo.join(', ')}
              {resultado.omitidas > resultado.omitidos_ejemplo.length && '…'}
            </div>
          )}

          {resultado.sobrantes > 0 && !resultado.sobrantes_borradas && (
            <div className="banner" style={{ marginBottom: 12 }}>
              Hay {resultado.sobrantes} máquinas asignadas a rutas de{' '}
              {unidad} que no venían en este mapa. Se quedaron donde
              estaban. Si el mapa ya es la única fuente, vuelve a importar
              marcando la casilla de limpieza.
            </div>
          )}

          <div className="modal-actions">
            <button className="btn" onClick={onClose} style={{ width: '100%' }}>
              Cerrar
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).className === 'overlay') onClose();
      }}
    >
      <div className="modal" style={{ maxWidth: 760 }}>
        <h2 style={{ margin: '0 0 3px' }}>Importar rutas desde el mapa</h2>
        <p className="phint">
          Cada capa del mapa se vuelve una ruta. Se importan Digital e Impreso
          juntos: cada máquina entra a la ruta de su segmento.
        </p>

        {err && <div className="err">{err}</div>}

        {!capas && (
          <>
            {/* La unidad se elige AQUÍ, no se hereda de la pantalla. Ver la
                nota del estado `unidad`. */}
            <div className="field" style={{ marginTop: 14 }}>
              <label>¿De qué unidad de negocio es este mapa?</label>
              <select
                value={unidad}
                onChange={(e) => {
                  setUnidad(e.target.value);
                  setErr('');
                  setInvCount(null);
                }}
                disabled={leyendo}
              >
                <option value="">— elige la unidad —</option>
                {UNIDADES.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
                Los marcadores se empatan contra el inventario de esta unidad.
                Si te equivocas, empatarán por cercanía con lo que haya cerca —
                que es exactamente como se ensucian las rutas de otra unidad.
                {sugerida && unidad && unidad !== sugerida && (
                  <>
                    {' '}
                    <b style={{ color: '#f59e0b' }}>
                      La pantalla está viendo {sugerida}; vas a importar a{' '}
                      {unidad}.
                    </b>
                  </>
                )}
              </div>
            </div>

            <div
              style={{
                background: 'var(--panel2)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '11px 12px',
                margin: '14px 0',
                fontSize: 12,
                color: 'var(--muted)',
                lineHeight: 1.7,
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  fontSize: 12,
                  marginBottom: 6,
                  color: 'var(--txt)',
                }}
              >
                Cómo sacar el archivo de My Maps
              </div>
              1. Abre el mapa y entra al menú <b>⋮</b> junto al título.
              <br />
              2. <b>Descargar KML</b>.
              <br />
              3. Marca <b>“Exportar a un archivo .KML”</b> y descarga.
              <br />
              4. Súbelo aquí.
              <br />
              <br />
              Cada capa del mapa se convierte en una ruta. Las capas que ya
              existan con el mismo nombre conservan su número y su color.
            </div>

            <label
              className={'btn' + (unidad ? '' : ' ghost')}
              style={{
                display: 'block',
                textAlign: 'center',
                cursor: leyendo || !unidad ? 'default' : 'pointer',
                opacity: unidad ? 1 : 0.5,
              }}
            >
              {leyendo
                ? 'Leyendo…'
                : unidad
                  ? `📄 Elegir archivo .kml para ${unidad}`
                  : '📄 Elige primero la unidad'}
              <input
                type="file"
                accept=".kml,.xml,application/vnd.google-earth.kml+xml"
                style={{ display: 'none' }}
                onChange={onArchivo}
                disabled={leyendo || !unidad}
              />
            </label>
          </>
        )}

        {capas && (
          <>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <span className="tag">
                {capas.length} capas · {empates.length} marcadores
              </span>
              {(['Digital', 'Impreso'] as const).map((m) => {
                const n = empates.filter((e) => e.tipo_medio === m).length;
                return n > 0 ? (
                  <span key={m} className="tag">
                    {n} {m}
                  </span>
                ) : null;
              })}
              {(['alta', 'media', 'baja', 'ninguna'] as Confianza[]).map(
                (c) =>
                  conteo(c) > 0 && (
                    <span
                      key={c}
                      className="tag"
                      style={{ color: COLOR[c], borderColor: COLOR[c] }}
                    >
                      {conteo(c)} {ETIQUETA[c].toLowerCase()}
                    </span>
                  )
              )}
            </div>

            {/* Señal de que se eligió la unidad equivocada.
                Un empate `alta` exige que el número o el nombre coincidan con
                inventario. Los `media` y `baja` salen casi siempre de la
                cercanía, y la cercanía empata CUALQUIER cosa que esté al lado
                —incluido el inventario de otra unidad—. Si casi nada empató
                por identidad, lo más probable no es que el mapa esté sucio:
                es que se está comparando contra el inventario equivocado. */}
            {empates.length > 0 &&
              conteo('alta') / empates.length < 0.4 && (
                <div
                  className="banner"
                  style={{
                    marginTop: 10,
                    borderColor: 'var(--bad)',
                    color: 'var(--bad)',
                  }}
                >
                  <b>Revisa la unidad antes de importar.</b> Solo{' '}
                  {conteo('alta')} de {empates.length} marcadores empataron por
                  número o por nombre con el inventario de <b>{unidad}</b>
                  {invCount != null && ` (${invCount} registros)`}. El resto
                  empató por pura cercanía, que no identifica nada. Si este mapa
                  no es de {unidad}, cierra y vuelve a empezar eligiendo la
                  unidad correcta.
                </div>
              )}

            {avisos.length > 0 && (
              <div className="banner" style={{ marginTop: 10 }}>
                {avisos.slice(0, 3).join(' ')}
                {avisos.length > 3 && ` (+${avisos.length - 3} más)`}
              </div>
            )}

            <p className="phint" style={{ marginTop: 12 }}>
              Se importan las marcadas. Desmarca lo que no debas subir. Lo que
              no empató con inventario no se puede importar: hay que darlo de
              alta primero o corregir el nombre en el mapa.
            </p>

            <div
              style={{
                maxHeight: '46vh',
                overflowY: 'auto',
                border: '1px solid var(--line)',
                borderRadius: 10,
                marginTop: 10,
              }}
            >
              {capas.map((capa, ci) => {
                // Se filtra por posición de capa, no por nombre: el mapa
                // puede tener dos capas llamadas igual.
                const filas = empates.filter((e) => e.capaIdx === ci);
                const visibles = verTodo
                  ? filas
                  : filas.filter((e) => e.confianza !== 'alta');
                const ocultas = filas.length - visibles.length;

                return (
                  <div key={ci}>
                    <div
                      style={{
                        position: 'sticky',
                        top: 0,
                        background: 'var(--panel2)',
                        borderBottom: '1px solid var(--line)',
                        padding: '7px 11px',
                        fontWeight: 700,
                        fontSize: 12,
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <span style={{ minWidth: 0 }}>{capa.nombre}</span>
                      <span
                        style={{
                          color: 'var(--muted)',
                          fontWeight: 400,
                          flexShrink: 0,
                        }}
                      >
                        {filas.filter((e) => e.site_id && !excluidos.has(llave(e)))
                          .length}
                        /{filas.length}
                      </span>
                    </div>

                    {visibles.map((e) => {
                      const k = llave(e);
                      const puede = !!e.site_id;
                      const activo = puede && !excluidos.has(k);
                      return (
                        <div
                          key={k}
                          onClick={() => alternar(e)}
                          style={{
                            display: 'flex',
                            gap: 10,
                            alignItems: 'flex-start',
                            padding: '8px 11px',
                            borderBottom: '1px solid var(--line)',
                            cursor: puede ? 'pointer' : 'default',
                            opacity: puede ? 1 : 0.55,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={activo}
                            disabled={!puede}
                            onChange={() => alternar(e)}
                            onClick={(ev) => ev.stopPropagation()}
                            style={{ marginTop: 3, flexShrink: 0, width: 'auto' }}
                          />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>
                              {e.parada.nombre}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: COLOR[e.confianza],
                                marginTop: 2,
                              }}
                            >
                              {e.motivo}
                              {e.duplicado && ' · ⚠ otra parada apunta a la misma máquina'}
                            </div>
                            {e.site_id && (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: 'var(--muted)',
                                  marginTop: 2,
                                }}
                              >
                                {e.site_id}
                                {e.direccion ? ' · ' + e.direccion : ''}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {ocultas > 0 && (
                      <div
                        style={{
                          padding: '7px 11px',
                          fontSize: 11,
                          color: 'var(--muted)',
                          borderBottom: '1px solid var(--line)',
                        }}
                      >
                        {ocultas} más empataron por ID sin observaciones.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                marginTop: 10,
                fontSize: 12,
              }}
            >
              <input
                type="checkbox"
                checked={verTodo}
                onChange={(e) => setVerTodo(e.target.checked)}
                style={{ width: 'auto' }}
              />
              Ver también los que empataron limpio por ID
            </label>

            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                marginTop: 8,
                fontSize: 12,
              }}
            >
              <input
                type="checkbox"
                checked={quitarFaltantes}
                onChange={(e) => setQuitarFaltantes(e.target.checked)}
                style={{ width: 'auto', marginTop: 3 }}
              />
              <span>
                Quitar de las rutas las máquinas que ya no están en el mapa.
                <span style={{ color: 'var(--muted)' }}>
                  {' '}
                  Úsalo solo si el mapa es la lista completa y definitiva.
                </span>
              </span>
            </label>

            <div className="modal-actions" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={onClose} disabled={importando}>
                Cancelar
              </button>
              <button
                className="btn"
                onClick={importar}
                disabled={importando || incluidos.length === 0}
              >
                {importando
                  ? 'Importando…'
                  : `Importar ${incluidos.length} máquinas`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default ImportarKmlModal;
