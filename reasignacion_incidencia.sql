-- ============================================================
-- reasignacion_incidencia.sql — la reasignación propone una incidencia
-- Correr en Supabase → SQL Editor.
--
-- QUÉ CAMBIA (Erik, 30-ago-2026): al solicitar una reasignación ya no se
-- elige el área a mano — se elige del CATÁLOGO qué incidencia es en
-- realidad, y el área destino la trae esa entrada. Al aprobar, la
-- incidencia se reclasifica (nombre + nivel + origen + tipo + área).
--
-- Esta columna guarda el `detalle` de la entrada propuesta. Las
-- solicitudes viejas quedan en NULL y se aprueban como siempre (solo
-- mueven el área): el frontend distingue los dos casos.
-- ============================================================

alter table public.reasignaciones
  add column if not exists nueva_incidencia text;

comment on column public.reasignaciones.nueva_incidencia is
  'Entrada del catálogo (detalle) propuesta al solicitar; al aprobar, la incidencia se reclasifica con ella. NULL = solicitud vieja, solo mueve el área.';
