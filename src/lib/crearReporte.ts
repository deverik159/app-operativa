// ============================================================
// src/lib/crearReporte.ts
// EL guardado de un reporte de incidencias, en un solo lugar.
//
// Vivía dentro de IncidenciasView.crear(). Se extrajo (21-sep-2026) porque
// Pauta y Monitoreo ahora también levanta reportes — al terminar una toma,
// el monitorista puede abrir NuevaInc con el sitio ya ligado — y duplicar
// esta lógica habría creado el gemelo que con el tiempo diverge: la regla
// de duplicidad, el manejo de RLS silenciosa y la liga de evidencia POR
// GRUPO tienen que ser idénticos se capture desde donde se capture.
//
// A PRUEBA DE MALA SEÑAL (auditoría primer mes, 24-sep-2026). Antes el
// record_id y las rutas de archivo se generaban en cada intento: si el
// insert llegaba pero la respuesta se perdía, el siguiente Guardar creaba
// un DUPLICADO; y sin red, el reporte con sus fotos solo vivía en memoria.
// Ahora aquí solo se ARMA el envío —ids, fecha, estatus y rutas fijados una
// vez— y se entrega a la cola (lib/envios.ts), que lo guarda en el teléfono
// antes de mandar nada y lo procesa de forma repetible. Con red, el usuario
// ve EXACTAMENTE lo de siempre: mismos pasos, mismos alerts, mismo orden.
//
// Contrato con quien llama (Incidencias y Pauta cierran el modal con
// cualquier arreglo):
//   · Incidencia[] con filas → creado (como siempre).
//   · []                     → no hubo red: el reporte quedó en la cola del
//                              teléfono y se enviará solo (aviso arriba).
//   · null                   → abortado por algo que hay que corregir
//                              (duplicado en proceso, error definitivo):
//                              el modal se queda abierto.
// ============================================================
import { AREAS_AUTORUTEO } from './constants';
import { fueraHorarioValidador, idCorto } from './helpers';
import {
  claveArchivoEnvio,
  guardarEnvioNuevo,
  nuevoIdEnvio,
  procesarEnvio,
  rutaArchivo,
  type ArchivoEnvio,
  type Envio,
  type FilaEnvio,
  type GrupoEnvio,
} from './envios';
import { claveYaGuardada, sellarBorrador } from './borrador';
import type { GrupoReporte } from '../modules/incidencias/NuevaInc';
import type { EstatusInc, Incidencia, TipoEvidencia } from '../types/db';

/**
 * Arma el envío: TODO lo que distingue un reintento de un reporte nuevo
 * queda fijado aquí, una sola vez — record_id, fecha_reporte, autor, área
 * reportante, estatus y prevalidación de cada fila, y la ruta de Storage de
 * cada archivo. Los File se entregan aparte (la cola los guarda como Blob).
 *
 * Un archivo que el borrador del alta ya dejó en el teléfono se REUSA con
 * su clave 'b:' en vez de copiarse otra vez (revisión primer mes,
 * 24-sep-2026): la doble copia era la que llenaba el espacio en el Guardar.
 * La cola cierra ese borrador cuando el envío termina (lib/borrador.ts).
 */
function armarEnvio(
  grupos: GrupoReporte[],
  ctx: { email: string; misDep: string[] }
): { envio: Envio; archivos: Map<string, File> } {
  const base = {
    captured_by: ctx.email,
    area_reportante: ctx.misDep[0] || null,
    fecha_reporte: new Date().toISOString(),
  };
  const origen = grupos.find((g) => g.borrador)?.borrador ?? null;
  const id = nuevoIdEnvio();
  // Una marca por envío (no Date.now() por archivo): con el consecutivo `n`
  // da nombres únicos Y estables entre reintentos.
  const marca = Date.now();
  const archivos = new Map<string, File>();
  const usados = new Set<string>();
  let n = 0;

  // Se les pone id ANTES de insertar, conservando la agrupación: así se
  // sabe qué filas pertenecen a qué grupo sin depender del orden en que
  // Postgres devuelva el insert.
  const gruposEnvio: GrupoEnvio[] = grupos.map((g) => {
    const filas: FilaEnvio[] = g.filas.map((d) => {
      // Fuera del horario del validador, las áreas de auto-ruteo entran
      // directo a en_proceso y prevalidan al recibir.
      const auto =
        AREAS_AUTORUTEO.includes(d.area_responsable || '') &&
        fueraHorarioValidador();
      let rid = idCorto();
      while (usados.has(rid)) rid = idCorto();
      usados.add(rid);
      return {
        ...d,
        ...base,
        record_id: rid,
        estatus: (auto ? 'en_proceso' : 'por_validar') as EstatusInc,
        requiere_prevalidacion: auto,
      };
    });
    const ge: GrupoEnvio = { filas, archivos: [], carasLabel: g.carasLabel };
    ge.archivos = g.files.map((f): ArchivoEnvio => {
      const tipo: TipoEvidencia = f.type.startsWith('video') ? 'video' : 'foto';
      const ext = (
        f.name.split('.').pop() || (tipo === 'video' ? 'mp4' : 'jpg')
      ).toLowerCase();
      const delBorrador = origen ? claveYaGuardada(origen.sesion, f) : null;
      const clave = delBorrador ?? claveArchivoEnvio(id, n);
      archivos.set(clave, f);
      const a: ArchivoEnvio = {
        // La cara va en el NOMBRE del archivo (rutaArchivo): así se
        // identifica en Storage sin abrir la app.
        path: rutaArchivo(ge, marca, n, ext),
        clave,
        n,
        ext,
        nombre: f.name,
        mime: f.type,
        bytes: f.size,
        tipo,
        ...(delBorrador ? { enBorrador: true } : {}),
      };
      n++;
      return a;
    });
    return ge;
  });

  const ahora = new Date().toISOString();
  return {
    envio: {
      v: 1,
      id,
      email: ctx.email,
      creado_en: base.fecha_reporte,
      actualizado_en: ahora,
      marca,
      grupos: gruposEnvio,
      estado: {
        insertadas: [],
        insertSinRespuesta: false,
        subidos: [],
        ligados: [],
        ligando: [],
        fallidos: [],
      },
      intentos: 0,
      ultimoError: null,
      borrador: origen,
      fueraDelTelefono: [],
    },
    archivos,
  };
}

/** El aviso de "sin red" según lo que alcanzó a quedar en el teléfono. */
function avisoSinRed(
  fase: 'insertar' | 'archivos',
  guardado: { enTelefono: boolean; fueraDelTelefono: number }
): string {
  if (!guardado.enTelefono) {
    return fase === 'insertar'
      ? 'Sin conexión: tu reporte quedó pendiente en esta pantalla, pero este teléfono no ' +
          'dejó guardarlo (modo privado o sin espacio).\n\nNO cierres la app: se enviará solo ' +
          'cuando vuelva la señal. Verás el aviso arriba.'
      : 'Tu reporte se creó, pero sin señal no se terminaron de subir las fotos y este ' +
          'teléfono no dejó guardarlas.\n\nNO cierres la app: se subirán solas cuando vuelva ' +
          'la señal. Verás el aviso arriba.';
  }
  const ojo =
    guardado.fueraDelTelefono > 0
      ? `\n\nOjo: ${guardado.fueraDelTelefono} archivo(s) no cupieron en el teléfono. ` +
        'No cierres la app hasta que se envíe, o habrá que subirlos de nuevo.'
      : '';
  return fase === 'insertar'
    ? 'Sin conexión: tu reporte quedó guardado en este teléfono y se enviará solo cuando ' +
        'vuelva la señal. Verás el aviso arriba.' + ojo
    : 'Tu reporte se creó, pero sin señal no se terminaron de subir las fotos. Quedaron ' +
        'guardadas en este teléfono y se subirán solas cuando vuelva la señal. Verás el ' +
        'aviso arriba.' + ojo;
}

export async function crearReporte(
  grupos: GrupoReporte[],
  ctx: { email: string; misDep: string[] }
): Promise<Incidencia[] | null> {
  const { envio, archivos } = armarEnvio(grupos, ctx);
  const origen = envio.borrador;

  // A la cola ANTES de mandar nada: si la app se cierra a medio envío, el
  // reporte sobrevive y se retoma donde se quedó. Si el teléfono no deja
  // guardarlo, se sigue en memoria — nunca se bloquea el guardado.
  const guardado = await guardarEnvioNuevo(envio, archivos, { interactivo: true });
  const r = await procesarEnvio(envio, { interactivo: true });

  // Con arreglo (vacío o no) el modal se cierra. El borrador ya NO se borra
  // aquí (revisión primer mes, 24-sep-2026): sin red se borraba aunque el
  // envío no hubiera cabido entero en el teléfono —la única copia de ese
  // video— y el envío usa sus archivos. Lo cierra la cola cuando el envío
  // queda completo (ya pasó, si 'completo') o se descarta; aquí solo se
  // SELLA, para que la escritura de salida del formulario no lo resucite.
  const entregado = <T>(x: T): T => {
    if (origen) sellarBorrador(origen.sesion);
    return x;
  };

  switch (r.tipo) {
    case 'completo':
      return entregado(r.creadas);

    case 'duplicado':
      // ══ REGLA DE DUPLICIDAD ══ La regla y su porqué viven en duplicados.ts.
      alert(
        'Esta incidencia ya se encuentra registrada y en proceso, no es ' +
          'necesario capturar una nueva.\n\n' +
          r.choques
            .map(
              (c) =>
                `• ${c.fila.nombre_incidencia} (cara ${c.fila.clave_medio}) → folio ${c.folio || '—'}`
            )
            .join('\n') +
          '\n\nQuita esa partida del reporte para guardar el resto.'
      );
      return null;

    case 'error':
      alert('No se pudo crear: ' + r.mensaje);
      return null;

    case 'sinRed': {
      // Si las filas YA se insertaron, la incidencia existe: se devuelven
      // para que la tarjeta aparezca; solo faltan fotos, que suben solas.
      // Se sella ANTES del alert: mientras está abierto, otra pestaña puede
      // terminar el envío y cerrar el borrador.
      const creadas = entregado(r.fase === 'insertar' ? [] : r.creadas);
      alert(avisoSinRed(r.fase, guardado));
      return creadas;
    }

    default:
      // 'ocupado' / 'yaEnviado' / 'vacio' no pasan con un envío recién
      // armado; si pasaran, el envío sigue a cargo de la cola.
      return entregado([]);
  }
}
