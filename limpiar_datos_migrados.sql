-- ============================================================
-- limpiar_datos_migrados.sql — borrar todo rastro del 31-jul-2026 hacia atrás
-- Correr en Supabase → SQL Editor. AGOSTO SE QUEDA (datos de prueba).
--
-- QUÉ BORRA: los datos migrados de la base vieja y cualquier prueba con
-- fecha anterior al 1-ago-2026 00:00 hora de CDMX — incidencias con todos
-- sus hijos (evidencias, chat y adjuntos, reasignaciones, notificaciones),
-- revisiones de Biobox con sus respuestas y evidencias, y avance y
-- evidencias de pauta.
--
-- LOS ARCHIVOS DE STORAGE NO SE PUEDEN BORRAR POR SQL: Supabase lo bloquea
-- (trigger storage.protect_delete — "Use the Storage API instead"). Por eso
-- el PASO 2 deja las rutas en una tabla puente (_limpieza_paths) y los
-- archivos los borra el script scripts/limpiar-storage.mjs vía la Storage
-- API (PASO 3). El orden importa: primero este SQL, luego el script.
--
-- QUÉ NO TOCA: catálogos y configuración (inventario, catalogo_incidencias,
-- usuarios, usuario_roles, tecnicos, sla_areas, rutas y sus ubicaciones,
-- checklists, catorcenas, arbol_digital, pautas importadas,
-- push_suscripciones) ni la tabla externa de fijación (es de Mario, solo
-- lectura). Las incidencias SIN fecha_reporte tampoco se tocan: no hay
-- forma de saber de cuándo son — el diagnóstico te dice cuántas hay.
--
-- CÓMO CORRERLO:
--   1) Corre el PASO 1 solo. Revisa los conteos: eso y nada más se borrará.
--   2) Corre el PASO 2 completo (transacción: o entra todo, o nada).
--   3) Corre scripts/limpiar-storage.mjs (ver instrucciones en el script).
--   4) Corre el PASO 4 para verificar y tirar la tabla puente.
-- ============================================================

-- ══════════ PASO 1 — DIAGNÓSTICO (solo lectura, corre esto primero) ══════════

with corte as (select timestamptz '2026-08-01 00:00:00-06' as t),
viejas as (
  select record_id from public.incidencias, corte where fecha_reporte < corte.t
)
select 'incidencias a borrar' as que, count(*)::text as cuantas from viejas
union all
select 'incidencias SIN fecha (no se tocan)', count(*)::text
  from public.incidencias where fecha_reporte is null
union all
select 'evidencias', count(*)::text
  from public.evidencias where record_id in (select record_id from viejas)
union all
select 'mensajes de chat', count(*)::text
  from public.mensajes where record_id in (select record_id from viejas)
union all
select 'adjuntos de chat', count(*)::text
  from public.chat_adjuntos where record_id in (select record_id from viejas)
union all
select 'reasignaciones', count(*)::text
  from public.reasignaciones where record_id in (select record_id from viejas)
union all
select 'notificaciones', count(*)::text
  from public.notificaciones, corte
  where record_id in (select record_id from viejas) or creado_en < corte.t
union all
select 'revisiones biobox', count(*)::text
  from public.revisiones, corte where creado_en < corte.t
union all
select 'evidencias de revisiones', count(*)::text
  from public.revision_evidencias re
  join public.revisiones r on r.id = re.revision_id, corte
  where r.creado_en < corte.t
union all
select 'avance de pauta (tomas)', count(*)::text
  from public.pauta_monitoreo, corte
  where coalesce(fecha_toma, fecha_comprobacion) < corte.t
union all
select 'evidencias de pauta', count(*)::text
  from public.pauta_evidencias, corte where creado_en < corte.t
union all
select 'archivos en Storage (bucket evidencias)', count(*)::text
  from storage.objects o, corte
  where o.bucket_id = 'evidencias'
    and (
      exists (select 1 from viejas v where o.name like v.record_id || '/%')
      or exists
         (select 1 from public.chat_adjuntos c
          where c.path = o.name and c.record_id in (select record_id from viejas))
      or exists
         (select 1 from public.revision_evidencias re
          join public.revisiones r on r.id = re.revision_id
          where re.path = o.name and r.creado_en < corte.t)
      or exists
         (select 1 from public.pauta_evidencias pe
          where pe.path = o.name and pe.creado_en < corte.t)
    );

-- ══════════ PASO 2 — BORRADO DE FILAS (correr tras revisar el paso 1) ══════════

begin;

create temp table _corte on commit drop as
  select timestamptz '2026-08-01 00:00:00-06' as t;

-- Las incidencias condenadas, una sola vez.
create temp table _viejas on commit drop as
  select record_id from public.incidencias
  where fecha_reporte < (select t from _corte);

-- Tabla puente con TODOS los archivos a borrar del bucket. Es tabla real
-- (no temporal) porque la lee el script del PASO 3, en otra sesión.
-- LEER storage.objects sí está permitido; lo bloqueado es el DELETE.
-- Al barrer por carpeta de record_id caen también las evidencias de
-- reasignación, que solo guardaban URL y no ruta.
drop table if exists public._limpieza_paths;
create table public._limpieza_paths as
  select distinct o.name as path
  from storage.objects o
  where o.bucket_id = 'evidencias'
    and exists (select 1 from _viejas v where o.name like v.record_id || '/%')
  union
  select path from public.chat_adjuntos
    where record_id in (select record_id from _viejas) and path is not null
  union
  select re.path from public.revision_evidencias re
    join public.revisiones r on r.id = re.revision_id
    where r.creado_en < (select t from _corte) and re.path is not null
  union
  select path from public.pauta_evidencias
    where creado_en < (select t from _corte) and path is not null;

-- Sin políticas y con RLS: nadie la ve desde la app; el script entra con
-- la service key, que brinca la RLS.
alter table public._limpieza_paths enable row level security;

-- Hijos de las incidencias, de abajo hacia arriba.
delete from public.chat_adjuntos
  where record_id in (select record_id from _viejas);
delete from public.mensajes
  where record_id in (select record_id from _viejas);
delete from public.evidencias
  where record_id in (select record_id from _viejas);
delete from public.reasignaciones
  where record_id in (select record_id from _viejas);
delete from public.notificaciones
  where record_id in (select record_id from _viejas)
     or creado_en < (select t from _corte);

-- Revisiones de Biobox: respuestas y evidencias caen solas (ON DELETE
-- CASCADE); el vínculo respuesta→incidencia es SET NULL.
delete from public.revisiones where creado_en < (select t from _corte);

-- Pauta: solo el AVANCE (tomas) y sus evidencias; la pauta importada queda.
delete from public.pauta_evidencias
  where creado_en < (select t from _corte);
delete from public.pauta_monitoreo
  where coalesce(fecha_toma, fecha_comprobacion) < (select t from _corte);

-- Las incidencias, al final.
delete from public.incidencias
  where record_id in (select record_id from _viejas);

commit;

-- Cuántos archivos quedaron pendientes para el script:
select count(*) as archivos_para_el_script from public._limpieza_paths;

-- ══════════ PASO 3 — ARCHIVOS DE STORAGE ══════════
-- En tu terminal, dentro del proyecto (instrucciones dentro del script):
--   node scripts/limpiar-storage.mjs
-- Va vaciando public._limpieza_paths conforme borra; se puede re-correr
-- si se interrumpe.

-- ══════════ PASO 4 — VERIFICAR Y LIMPIAR (después del script) ══════════
-- Todo debe dar cero.
select
  (select count(*) from public.incidencias
    where fecha_reporte < timestamptz '2026-08-01 00:00:00-06') as incidencias,
  (select count(*) from public.revisiones
    where creado_en < timestamptz '2026-08-01 00:00:00-06') as revisiones,
  (select count(*) from public.notificaciones
    where creado_en < timestamptz '2026-08-01 00:00:00-06') as notificaciones,
  (select count(*) from public._limpieza_paths) as archivos_pendientes;

-- Y al final, fuera la tabla puente:
-- drop table if exists public._limpieza_paths;
