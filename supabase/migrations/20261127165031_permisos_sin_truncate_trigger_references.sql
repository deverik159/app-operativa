-- ============================================================
-- 27-nov-2026 · Plataforma (permisos de la base)
-- Qué: los usuarios con sesión (authenticated) y sin sesión (anon) pierden
--      TRUNCATE, TRIGGER, REFERENCES y MAINTAIN en todas las tablas y vistas
--      de public, y las tablas nuevas que cree postgres ya no los reciben.
--      MAINTAIN (Postgres 17) deja hacer VACUUM, REINDEX o LOCK TABLE en modo
--      exclusivo: el mismo riesgo de bloquear una tabla entera.
-- Por qué: revisor-rls lo señaló al revisar el catálogo (27-nov-2026). De
--      86 tablas, 46 tenían TRUNCATE para authenticated (49 con alguno de
--      los tres), incluidas incidencias, mensajes, usuario_roles y usuarios
--      (los da Supabase por omisión). La RLS no frena un TRUNCATE. Hoy la API de la app no ofrece
--      esas operaciones, así que es un candado de más, no un hueco abierto.
-- No cambia: SELECT, INSERT, UPDATE y DELETE (los sigue decidiendo la RLS);
--      service_role y postgres (funciones de la base, Edge Functions, SQL
--      Editor); reemplazar_inventario, la única función que hace TRUNCATE,
--      es SECURITY DEFINER y corre como su dueño (igual comp_aplicar_planes,
--      la única con LOCK/REFRESH, y sincronizar_biobox_app_reportes, con DDL).
-- Revisada por revisor-rls: se agregaron las vistas, MAINTAIN y el filtro por
--      dueño (una tabla de otro dueño haría fallar el revoke).
-- Re-ejecutable: revocar un permiso que ya no está no hace nada.
-- ============================================================

do $$
declare
  t regclass;
begin
  for t in
    select c.oid::regclass
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and c.relowner = 'postgres'::regrole
  loop
    execute format('revoke truncate, trigger, references, maintain on table %s from anon, authenticated', t);
  end loop;
end
$$;

-- Tablas nuevas que cree postgres en public: sin esos cuatro permisos.
-- (Las reglas por omisión de supabase_admin no se pueden tocar desde aquí,
-- pero las tablas de la app las crea postgres.)
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references, maintain on tables from anon, authenticated;
