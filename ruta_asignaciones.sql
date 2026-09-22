-- ============================================================
-- ruta_asignaciones.sql — el coordinador asigna rutas a personas
-- Correr en Supabase → SQL Editor.
--
-- QUÉ HABILITA (Erik, 21-sep-2026):
--   · El coordinador, desde Pauta y Monitoreo, asigna una ruta a un
--     usuario (puede haber varios por ruta y varias rutas por usuario).
--   · Al monitorista le llega la notificación "se te asignó la ruta X"
--     (evento 'ruta' — su título de push, "Cambio en tu ruta", ya existe
--     en enviar-push) y también si se la retiran.
--   · Al abrir Pauta, la app le pre-filtra SU ruta.
--
-- El aviso de "tu incidencia cambió de estatus" NO va aquí: ya existe
-- (eventos reparado_reportante y cierre del trigger notificar_incidencia).
-- ============================================================

-- ------------------------------------------------------------
-- 1) La tabla. Una fila = "esta ruta es de esta persona".
-- ------------------------------------------------------------
create table if not exists public.ruta_asignaciones (
  id            bigserial primary key,
  ruta_id       bigint not null references rutas_monitoreo (id) on delete cascade,
  usuario_email text   not null,
  asignado_por  text,
  creado_en     timestamptz default now(),
  -- La misma persona no se asigna dos veces a la misma ruta.
  unique (ruta_id, usuario_email)
);

alter table public.ruta_asignaciones enable row level security;

-- Todos los autenticados LEEN: el monitorista necesita ver la suya y el
-- selector de rutas marca las asignadas. No hay nada sensible: es quién
-- recorre qué ruta.
drop policy if exists ra_sel on public.ruta_asignaciones;
create policy ra_sel on public.ruta_asignaciones
  for select to authenticated using (true);

-- Escriben solo coordinador y manager (mismo criterio que importar pauta).
drop policy if exists ra_ins on public.ruta_asignaciones;
create policy ra_ins on public.ruta_asignaciones
  for insert to authenticated
  with check (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role));

drop policy if exists ra_del on public.ruta_asignaciones;
create policy ra_del on public.ruta_asignaciones
  for delete to authenticated
  using (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role));

-- ------------------------------------------------------------
-- 2) Notificar la asignación (y el retiro). La RLS de `notificaciones`
--    no tiene INSERT: solo un trigger security definer puede avisar.
-- ------------------------------------------------------------
create or replace function public.notificar_ruta_asignada()
returns trigger
language plpgsql
security definer
as $$
declare
  r record;
  msg text;
begin
  select numero, nombre, unidad_negocio
    into r
    from rutas_monitoreo
   where id = coalesce(new.ruta_id, old.ruta_id);
  if not found then return coalesce(new, old); end if;

  if tg_op = 'INSERT' then
    msg := 'Se te asignó la ruta ' || r.numero ||
           coalesce(' · ' || nullif(r.nombre, ''), '') ||
           '. La encuentras en Pauta y Monitoreo.';
    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
    values (null, lower(new.usuario_email), 'ruta', msg, r.unidad_negocio);
    return new;
  else
    msg := 'Se te retiró la ruta ' || r.numero ||
           coalesce(' · ' || nullif(r.nombre, ''), '') || '.';
    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
    values (null, lower(old.usuario_email), 'ruta', msg, r.unidad_negocio);
    return old;
  end if;
end
$$;

drop trigger if exists trg_notificar_ruta_asignada on public.ruta_asignaciones;
create trigger trg_notificar_ruta_asignada
  after insert or delete on public.ruta_asignaciones
  for each row
  execute function public.notificar_ruta_asignada();

-- ------------------------------------------------------------
-- 3) La lista de personas asignables, para el selector del coordinador.
--    `usuarios` y `usuario_roles` son de lectura restringida (pantalla de
--    manager): esta RPC security definer regresa SOLO correo y nombre, y
--    SOLO a coordinador/manager — lo mínimo para llenar un <select>.
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
  order by 2;
$$;

grant execute on function public.usuarios_asignables() to authenticated;

-- ------------------------------------------------------------
-- 4) Verificación
-- ------------------------------------------------------------
-- a) Asigna una ruta desde la app y confirma la notificación:
select para_email, evento, mensaje, creado_en
from notificaciones
where evento = 'ruta'
order by creado_en desc
limit 10;

-- b) Asignaciones vigentes:
select ra.usuario_email, rm.numero, rm.nombre, ra.asignado_por, ra.creado_en
from ruta_asignaciones ra
join rutas_monitoreo rm on rm.id = ra.ruta_id
order by rm.numero, ra.usuario_email;
