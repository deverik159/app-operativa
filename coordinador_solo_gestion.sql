-- ============================================================
-- coordinador_solo_gestion.sql — amarres del coordinador y del selector
-- Correr en Supabase → SQL Editor.
--
-- DOS AJUSTES (Erik, 21-sep-2026):
--
-- 1) El selector "Asignar ruta a…" cargaba TODOS los usuarios; las rutas
--    se asignan a MONITORISTAS — la RPC ahora regresa solo ese rol.
--
-- 2) El coordinador GESTIONA, no repara: en la app pierde los botones de
--    reparar/reasignar (queda de consulta en Incidencias, con su tabla y
--    export). Las notificaciones de trabajo (área, reasignación, chat de
--    reparación) apuntan al rol 'reparacion' — al coordinador solo le
--    llegan si su CUENTA además trae ese rol: eso se limpia en Usuarios,
--    no aquí. El diagnóstico de abajo confirma si algún trigger de la
--    base le notifica al rol coordinador directamente.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Asignables = solo monitoristas.
-- ------------------------------------------------------------
create or replace function public.usuarios_asignables()
returns table (email text, nombre text)
language sql
security definer
as $$
  select distinct lower(ur.usuario_email) as email,
         coalesce(u.nombre, split_part(ur.usuario_email, '@', 1)) as nombre
  from usuario_roles ur
  left join usuarios u on lower(u.email) = lower(ur.usuario_email)
  where (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role))
    -- Las rutas de monitoreo son del monitorista: nadie más sale aquí.
    and ur.rol = 'monitorista'
  order by 2;
$$;

-- ------------------------------------------------------------
-- 2) Diagnóstico: ¿algún trigger de notificaciones apunta al rol
--    coordinador? Si esto regresa filas, mándame el nombre de la función
--    para quitarle ese destinatario; si regresa vacío, las notificaciones
--    que le llegan a un coordinador vienen de OTROS roles en su cuenta
--    (se limpian desde Usuarios) o de ser destinatario directo (capturó,
--    es técnico asignado).
-- ------------------------------------------------------------
select p.proname as funcion
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosrc ilike '%notificaciones%'
  and p.prosrc ilike '%coordinador%';

-- ------------------------------------------------------------
-- 3) Verificación del selector: debe listar SOLO monitoristas.
-- ------------------------------------------------------------
select usuario_email, rol from usuario_roles where rol = 'monitorista';
