-- ============================================================
-- fijacion_externa_vista_v2.sql — la vista expone lo que la tarjeta usa
-- Correr en Supabase → SQL Editor.
--
-- QUÉ AGREGA (Erik, 2-sep-2026): la tarjeta rediseñada del módulo de
-- Fijación Externa pinta el motivo de bloqueo, el blanqueo/limpieza y la
-- fecha real de fijación — pero la vista v1 no exponía esas columnas y
-- llegaban undefined. Esta v2 es LA MISMA vista (mismo cruce con
-- inventario, mismo filtro por sesión) con 4 columnas más AL FINAL:
-- notas_motivo_bloqueo, blanqueo_limpieza, fecha_fijacion_real y
-- fecha_terminado. Van al final a propósito: CREATE OR REPLACE VIEW solo
-- permite AGREGAR columnas al final, nunca reordenar las existentes.
--
-- Recordatorio de por qué el SQL Editor ve la vista "vacía": el WHERE
-- exige sesión (auth_email()) y en el editor no hay JWT de usuario. Para
-- explorar datos crudos, consultar externo.fijacion directo.
-- ============================================================

create or replace view public.vw_fijacion_externa as
select
  e.id,
  e.responsable_de_cuadrilla,
  e.operadores_cuadrilla,
  e.clave,
  e.catorcena,
  e.producto,
  e.zona,
  e.asignacion,
  e.supervisor,
  e.campana,
  e.version,
  e.direccion,
  e.estado,
  e.notas_observa,
  e.fecha_asignacion,
  e.fecha_limite,
  e.foto_tomada,
  e.foto_url,
  e.evidencia_url,
  i.latitud,
  i.longitud,
  i.municipio,
  i.vendor_face_id is null as sin_match_inventario,
  -- v2: lo nuevo, siempre al final.
  e.notas_motivo_bloqueo,
  e.blanqueo_limpieza,
  e.fecha_fijacion_real,
  e.fecha_terminado
from externo.fijacion e
left join inventario i on i.vendor_face_id = e.clave
where nullif(lower(coalesce(auth_email(), '')), '') is not null
  and (
    tiene_rol('manager'::app_role)
    or tiene_rol('coordinador'::app_role)
    or lower(coalesce(e.operadores_cuadrilla, '')) like
       '%' || lower(auth_email()) || '%'
  );

-- Verificar: deben aparecer las 4 columnas nuevas al final.
select column_name, ordinal_position
from information_schema.columns
where table_schema = 'public' and table_name = 'vw_fijacion_externa'
order by ordinal_position;
