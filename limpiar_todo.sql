-- ============================================================
-- limpiar_todo.sql — BORRAR TODOS los datos operativos, para arrancar
-- el flujo canónico de roles con la base en cero (Erik, 31-ago-2026).
--
-- Es la versión sin fecha de corte de limpiar_datos_migrados.sql: borra
-- TODO lo operativo — incidencias con todos sus hijos (evidencias, chat y
-- adjuntos, reasignaciones, notificaciones), revisiones de Biobox con sus
-- respuestas y evidencias, y TODO el avance de pauta (tomas y sus fotos).
-- También caen las ~80 solicitudes de reasignación viejas en "Solicitada".
--
-- QUÉ NO TOCA: catálogos y configuración (inventario, catalogo_incidencias,
-- usuarios, usuario_roles, tecnicos, sla_areas, rutas y sus ubicaciones,
-- checklists, catorcenas, arbol_digital, PAUTAS IMPORTADAS,
-- push_suscripciones) ni la tabla externa de fijación (es de Mario).
-- `pautas` y `pauta_monitoreo` son tablas separadas a propósito: se vacía
-- el avance sin perder la pauta del Excel.
--
-- LOS ARCHIVOS DE STORAGE NO SE BORRAN POR SQL (trigger protect_delete):
-- el PASO 2 deja las rutas en public._limpieza_paths y el PASO 3 las borra
-- con scripts/limpiar-storage.mjs vía la Storage API.
--
-- CÓMO CORRERLO:
--   1) PASO 1 solo. Revisa los conteos: eso y nada más se borrará.
--   2) PASO 2 completo (transacción: o entra todo, o nada).
--   3) node scripts/limpiar-storage.mjs   (instrucciones dentro del script)
--   4) PASO 4 para verificar y tirar la tabla puente.
-- ============================================================

-- ══════════ PASO 1 — DIAGNÓSTICO (solo lectura, corre esto primero) ══════════

select 'incidencias' as que, count(*)::text as cuantas from public.incidencias
union all
select 'evidencias', count(*)::text from public.evidencias
union all
select 'mensajes de chat', count(*)::text from public.mensajes
union all
select 'adjuntos de chat', count(*)::text from public.chat_adjuntos
union all
select 'reasignaciones', count(*)::text from public.reasignaciones
union all
select 'notificaciones', count(*)::text from public.notificaciones
union all
select 'revisiones biobox', count(*)::text from public.revisiones
union all
select 'avance de pauta (tomas)', count(*)::text from public.pauta_monitoreo
union all
select 'evidencias de pauta', count(*)::text from public.pauta_evidencias
union all
select 'archivos en Storage (bucket evidencias)', count(*)::text
  from storage.objects where bucket_id = 'evidencias'
union all
select 'PAUTA IMPORTADA (no se toca)', count(*)::text from public.pautas;

-- ══════════ PASO 2 — BORRADO DE FILAS (correr tras revisar el paso 1) ══════════

begin;

-- Tabla puente con los archivos del bucket A BORRAR. Es tabla real (no
-- temporal) porque la lee el script del PASO 3, en otra sesión.
--
-- EXCEPTO fijacion-externa/: esas fotos las referencia la BASE DE MARIO
-- (externo.fijacion.foto_url/evidencia_url), que esta limpieza no toca.
-- La corrida del 31-ago-2026 sí las barrió y los registros COMPLETO de
-- las pruebas quedaron con su evidencia en 404 — huérfanos al revés.
drop table if exists public._limpieza_paths;
create table public._limpieza_paths as
  select o.name as path
  from storage.objects o
  where o.bucket_id = 'evidencias'
    and o.name not like 'fijacion-externa/%';

-- Sin políticas y con RLS: nadie la ve desde la app; el script entra con
-- la service key, que brinca la RLS.
alter table public._limpieza_paths enable row level security;

-- Hijos de las incidencias, de abajo hacia arriba.
delete from public.chat_adjuntos;
delete from public.mensajes;
delete from public.evidencias;
delete from public.reasignaciones;
delete from public.notificaciones;

-- Revisiones de Biobox: respuestas y evidencias caen solas (ON DELETE
-- CASCADE); el vínculo respuesta→incidencia es SET NULL.
delete from public.revisiones;

-- Pauta: solo el AVANCE y sus evidencias; la pauta importada queda.
delete from public.pauta_evidencias;
delete from public.pauta_monitoreo;

-- Las incidencias, al final.
delete from public.incidencias;

commit;

-- Cuántos archivos quedaron pendientes para el script:
select count(*) as archivos_para_el_script from public._limpieza_paths;

-- ══════════ PASO 3 — ARCHIVOS DE STORAGE ══════════
-- En tu terminal, dentro del proyecto (instrucciones dentro del script):
--   node scripts/limpiar-storage.mjs

-- ══════════ PASO 4 — VERIFICAR Y LIMPIAR (después del script) ══════════
-- Todo debe dar cero, menos la pauta importada.
select
  (select count(*) from public.incidencias)      as incidencias,
  (select count(*) from public.revisiones)       as revisiones,
  (select count(*) from public.notificaciones)   as notificaciones,
  (select count(*) from public.pauta_monitoreo)  as avance_pauta,
  (select count(*) from public._limpieza_paths)  as archivos_pendientes,
  (select count(*) from public.pautas)           as pauta_importada_intacta;

-- Y al final, fuera la tabla puente:
-- drop table if exists public._limpieza_paths;
