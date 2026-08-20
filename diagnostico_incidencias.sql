-- ============================================================
-- diagnostico_incidencias.sql
-- Correr en el SQL Editor de Supabase y pegarme los resultados.
--
-- Objetivo: confirmar el esquema REAL antes de escribir los modales de
-- Incidencias, en vez de construir sobre supuestos (principio #3 del handoff).
-- Todas son SELECT: no modifican nada.
-- ============================================================


-- 1) Columnas exactas de `incidencias` (tipos y si aceptan null).
--    Confirma: nombre de la PK, nombres de campos de reparación,
--    reasignación y prevalidación.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'incidencias'
order by ordinal_position;


-- 2) ¿Dónde vive el CHAT? El handoff no lista una tabla de chat, pero
--    IncCard tiene onChat + contador de mensajes no leídos.
--    Esto encuentra cualquier tabla candidata.
select table_name
from information_schema.tables
where table_schema = 'public'
  and (table_name ilike '%chat%'
    or table_name ilike '%mensaje%'
    or table_name ilike '%comentario%'
    or table_name ilike '%bitacora%')
order by table_name;


-- 3) Inventario COMPLETO de tablas y vistas del esquema public.
--    Sirve para ver qué más existe que el handoff no documentó.
select table_name, table_type
from information_schema.tables
where table_schema = 'public'
order by table_type, table_name;


-- 4) Todas las funciones/RPC disponibles con su firma.
--    Confirma los nombres y parámetros exactos a llamar desde el frontend.
select p.proname as funcion,
       pg_get_function_arguments(p.oid) as argumentos,
       pg_get_function_result(p.oid)    as retorna,
       p.prosecdef                      as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname;


-- 5) Valores REALES en uso (no los que suponemos).
--    Confirma que EST_LABEL, AREAS_RESP y UNIDADES de constants.ts
--    coinciden con lo que hay en la base.
select 'estatus' as campo, estatus::text as valor, count(*) as n
from incidencias group by 1,2
union all
select 'area_responsable', area_responsable::text, count(*)
from incidencias group by 1,2
union all
select 'unidad_negocio', unidad_negocio::text, count(*)
from incidencias group by 1,2
union all
select 'nivel', nivel::text, count(*)
from incidencias group by 1,2
union all
select 'tipo', tipo::text, count(*)
from incidencias group by 1,2
union all
select 'origen', origen::text, count(*)
from incidencias group by 1,2
order by campo, n desc;


-- 6) ¿De dónde sale el slaMap (horas de SLA por área)?
--    IncCard espera Record<area_en_minusculas, horas>. Buscar su origen.
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and (column_name ilike '%sla%' or table_name ilike '%sla%')
order by table_name, column_name;


-- 7) Políticas RLS de incidencias: qué puede ver/hacer cada rol.
--    Necesario para que el frontend no ofrezca botones que la BD rechaza.
select tablename, policyname, cmd, roles,
       pg_get_expr(pol.polqual, pol.polrelid)      as using_expr,
       pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check_expr
from pg_policies pp
join pg_policy pol on pol.polname = pp.policyname
join pg_class c on c.oid = pol.polrelid and c.relname = pp.tablename
where pp.schemaname = 'public'
  and pp.tablename in ('incidencias','evidencias','fijacion_evidencias','usuarios','usuario_roles')
order by tablename, policyname;


-- 8) Valores del ENUM app_role, tal cual están en la base.
select enumlabel as rol
from pg_enum e
join pg_type t on t.oid = e.enumtypid
where t.typname = 'app_role'
order by e.enumsortorder;


-- 9) Columnas de evidencias y fijacion_evidencias (para el flujo de fotos).
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('evidencias','fijacion_evidencias')
order by table_name, ordinal_position;


-- 10) Columnas de cuadrillas y usuarios (para AsignarTecnicoModal:
--     ¿de dónde salen los técnicos asignables?).
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('cuadrillas','usuarios','usuario_roles')
order by table_name, ordinal_position;
