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
// El comportamiento es EXACTAMENTE el que tenía IncidenciasView: mismos
// alerts, mismos mensajes, mismo orden. Quien llama decide qué hacer con
// las filas creadas (Incidencias las mete a su lista; Pauta refresca su
// distintivo de abiertas).
//
// Devuelve las incidencias creadas, o null si se abortó (duplicado o el
// insert falló) — en ese caso el modal debe seguir abierto para corregir.
// ============================================================
import { sb } from './supabase';
import { BUCKET_EVIDENCIAS, CACHE_INMUTABLE, subirMiniatura } from './storage';
import { reportarError } from './reportarError';
import { AREAS_AUTORUTEO } from './constants';
import { fueraHorarioValidador, idCorto } from './helpers';
import { duplicadasEnProceso } from './duplicados';
import type { GrupoReporte } from '../modules/incidencias/NuevaInc';
import type { EstatusInc, Incidencia, TipoEvidencia } from '../types/db';

export async function crearReporte(
  grupos: GrupoReporte[],
  ctx: { email: string; misDep: string[] }
): Promise<Incidencia[] | null> {
  const base = {
    captured_by: ctx.email,
    area_reportante: ctx.misDep[0] || null,
    fecha_reporte: new Date().toISOString(),
  };

  // Se les pone id ANTES de insertar, conservando la agrupación: así se
  // sabe qué filas pertenecen a qué grupo sin depender del orden en que
  // Postgres devuelva el insert.
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

  // ══ REGLA DE DUPLICIDAD ══ La regla y su porqué viven en duplicados.ts.
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
    return null;
  }

  const { data, error } = await sb.from('incidencias').insert(rows).select();
  if (error) {
    alert('No se pudo crear: ' + error.message);
    return null;
  }
  // No basta con que no haya `error`. Si la RLS deja INSERTAR pero no deja
  // LEER de vuelta la fila recién creada, PostgREST responde 200 con un
  // arreglo vacío — y `[]` es truthy, así que hay que CONTAR.
  const devueltas = (data as Incidencia[] | null) ?? [];
  if (devueltas.length !== rows.length) {
    alert(
      `Se guardaron ${devueltas.length} de ${rows.length} reportes. ` +
        'Refresca con ↻ y verifica en Incidencias antes de volver a capturar, ' +
        'para no duplicar.'
    );
  }
  // Si la base no devolvió nada legible, se regresan las filas locales:
  // más vale enseñar lo que se mandó que dejar la pantalla en blanco.
  const creadas = (devueltas.length ? devueltas : rows) as Incidencia[];

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
        .upload(path, f, { cacheControl: CACHE_INMUTABLE });
      if (up) {
        // Las incidencias ya existen: se avisa pero no se aborta el resto.
        // Y queda registrado: con mala señal esto pasa en campo y, sin
        // telemetría, nadie sabía cuántos reportes quedaban sin foto.
        reportarError('crearReporte.subida', up, { path, tipo, bytes: f.size }, path);
        alert('Se creó, pero falló subir evidencia: ' + up.message);
        continue;
      }
      // La miniatura es la que pintan las tarjetas (de mejor esfuerzo).
      if (tipo === 'foto') await subirMiniatura(path, f);
      const url = sb.storage.from(BUCKET_EVIDENCIAS).getPublicUrl(path).data
        .publicUrl;
      // `referencia` guarda la cara: es lo que se lee en la galería.
      const evrows = ids.map((rid) => ({
        record_id: rid,
        etapa: 'reporte',
        tipo,
        url,
        path,
        subido_por: ctx.email,
        referencia: g.carasLabel || null,
      }));
      const { error: evErr } = await sb.from('evidencias').insert(evrows);
      if (evErr) {
        alert(
          'La incidencia se creó, pero no se pudo registrar una evidencia: ' +
            evErr.message
        );
      }
    }
  }

  return creadas;
}
