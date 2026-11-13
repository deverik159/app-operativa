-- ============================================================
-- 13-nov-2026 · Usuarios (pestaña Actividad)
-- Qué: perfil de actividad de cada usuario: si ya entró, la última vez que
--      usó la app, los días de uso de los últimos 30 días y qué hizo por
--      módulo (visitas a máquinas, reparaciones, fotos, chat, rutas,
--      comprobaciones, Aviso NUC).
-- Por qué: muchos usuarios con acceso todavía no usan la app y hoy solo se
--      sabía consultando la base a mano (Erik, 13-nov-2026).
-- Quién lo ve (Erik, 13-nov-2026): el manager, a todos; el coordinador, a la
--      gente de su unidad y su área (las de sus filas de coordinador; vacío =
--      todas), sin los managers.
-- Cómo:
--   1) `actividad_dias`: un renglón por persona y día (hora de CDMX). Lo
--      escribe solo `marcar_actividad()`, que la app llama al abrir y cada
--      15 minutos mientras está a la vista. Solo guarda el día y la primera
--      y la última hora: ni ubicación ni pantallas.
--   2) `actividad_equipo(p_dias)`: lo que pinta la pestaña. Security definer
--      porque lee auth.users y auth.sessions; filtra por quién pregunta.
-- El historial de días empieza el día que se publica; la última vez y el
-- «nunca entró» salen completos desde el principio (auth).
-- Re-ejecutable.
-- ============================================================

-- 1) Días de uso.
create table if not exists public.actividad_dias (
  usuario_email text not null check (usuario_email = lower(usuario_email)),
  dia           date not null,
  primera       timestamptz not null default now(),
  ultima        timestamptz not null default now(),
  marcas        integer not null default 1,
  primary key (usuario_email, dia)
);

create index if not exists actividad_dias_dia_idx on public.actividad_dias (dia);

alter table public.actividad_dias enable row level security;
-- Sin políticas: nadie la lee ni la escribe directo; solo las dos funciones.
revoke all on public.actividad_dias from public, anon, authenticated;

create or replace function public.marcar_actividad()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(auth_email());
begin
  -- Solo quien tiene rol en la app; una cuenta sin rol no deja rastro.
  if v_email is null or not exists (
    select 1 from usuario_roles ur where lower(ur.usuario_email) = v_email
  ) then
    return;
  end if;

  insert into actividad_dias (usuario_email, dia)
  values (v_email, (now() at time zone 'America/Mexico_City')::date)
  on conflict (usuario_email, dia) do update
    set ultima = now(),
        marcas = actividad_dias.marcas + 1
    -- Aunque la app la llame de más, cuenta a lo mucho una marca cada 5 min.
    where actividad_dias.ultima < now() - interval '5 minutes';
end;
$$;

revoke all on function public.marcar_actividad() from public, anon;
grant execute on function public.marcar_actividad() to authenticated;

-- 2) Lo que ve la pestaña Actividad.
create or replace function public.actividad_equipo(p_dias integer default 30)
returns table (
  email          text,
  nombre         text,
  telefono       text,
  roles          jsonb,
  tiene_cuenta   boolean,
  entra_con      text,
  alta           timestamptz,
  ultimo_login   timestamptz,
  ultima_vez     timestamptz,
  dias_uso       date[],
  push           boolean,
  errores        integer,
  maquinas       integer,
  reparaciones   integer,
  fotos          integer,
  chat           integer,
  rutas          integer,
  comprobaciones integer,
  nuc            integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with yo as (
    select lower(auth_email()) as e
  ),
  soy_manager as (
    select exists (
      select 1 from usuario_roles ur, yo
       where lower(ur.usuario_email) = yo.e and ur.rol = 'manager'::app_role
    ) as v
  ),
  -- Filas de coordinador de quien pregunta: unidad y área (vacío = todas).
  alcance as (
    select nullif(btrim(ur.unidad_negocio), '') as u,
           nullif(btrim(ur.departamento), '')   as d
      from usuario_roles ur, yo
     where lower(ur.usuario_email) = yo.e and ur.rol = 'coordinador'::app_role
  ),
  -- Roles como lista {unidad, area, rol} (vacío = null = todas / sin área),
  -- para que la app los escriba con sus nombres (revisor-rls).
  gente as (
    select lower(ur.usuario_email) as email,
           jsonb_agg(distinct jsonb_build_object(
             'unidad', nullif(btrim(ur.unidad_negocio), ''),
             'area',   nullif(btrim(ur.departamento), ''),
             'rol',    ur.rol::text)) as roles,
           bool_or(ur.rol = 'manager'::app_role) as es_manager
      from usuario_roles ur
     group by 1
  ),
  -- Unidad vacía = todas, en las dos puntas (como mi_area_en_unidad,
  -- 12-nov-2026): un técnico de Digital sin unidad también es del equipo
  -- del coordinador de Digital de Biobox. Área vacía de la persona solo
  -- entra con un coordinador sin área.
  visibles as (
    select g.email, g.roles
      from gente g, soy_manager
     where soy_manager.v
        or (not g.es_manager and exists (
              select 1
                from usuario_roles t
                join alcance a
                  on (a.u is null
                      or nullif(btrim(t.unidad_negocio), '') is null
                      or lower(btrim(t.unidad_negocio)) = lower(a.u))
                 and (a.d is null or lower(btrim(t.departamento)) = lower(a.d))
               where lower(t.usuario_email) = g.email))
  ),
  rango as (
    select greatest(1, least(coalesce(p_dias, 30), 90)) as n
  ),
  -- La misma ventana para todo: desde la medianoche de CDMX de hace n-1 días.
  desde as (
    select d.dia, (d.dia::timestamp at time zone 'America/Mexico_City') as t
      from (
        select (now() at time zone 'America/Mexico_City')::date - (rango.n - 1) as dia
          from rango
      ) d
  ),
  -- Cada tabla se agrupa una sola vez (no una subconsulta por persona).
  c_maquinas as (
    select lower(x.usuario_email) as email, count(*)::int as n
      from maquina_visitas x, desde where x.visitado_en >= desde.t group by 1
  ),
  c_reparaciones as (
    select lower(x.repaired_by_email) as email, count(*)::int as n
      from incidencias x, desde where x.fecha_reparacion >= desde.t group by 1
  ),
  c_fotos as (
    select lower(x.subido_por) as email, count(*)::int as n
      from evidencias x, desde where x.creado_en >= desde.t group by 1
  ),
  c_chat as (
    select lower(x.autor_email) as email, count(*)::int as n
      from mensajes x, desde where x.creado_en >= desde.t group by 1
  ),
  c_rutas as (
    select lower(x.usuario_email) as email, count(*)::int as n
      from ruta_visitas x, desde where x.visitado_en >= desde.t group by 1
  ),
  c_comprobaciones as (
    select email, count(*)::int as n from (
      select lower(x.tomada_por) as email from comp_tomas x, desde where x.enviada_en >= desde.t
      union all
      select lower(x.comprobada_por) from comp_tomas x, desde where x.comprobada_en >= desde.t
    ) z group by 1
  ),
  c_nuc as (
    select email, count(*)::int as n from (
      select lower(x.abierto_por) as email from nuc_avisos x, desde where x.abierto_en >= desde.t
      union all
      select lower(x.tomado_por) from nuc_avisos x, desde where x.tomado_en >= desde.t
      union all
      select lower(x.cerrado_por) from nuc_avisos x, desde where x.cerrado_en >= desde.t
    ) z group by 1
  ),
  c_errores as (
    select lower(x.usuario_email) as email, count(*)::int as n
      from errores_cliente x, desde where x.creado_en >= desde.t group by 1
  ),
  c_dias as (
    select x.usuario_email as email, array_agg(x.dia order by x.dia) as dias,
           max(x.ultima) as ultima
      from actividad_dias x, desde where x.dia >= desde.dia group by 1
  ),
  c_push as (
    select distinct lower(x.usuario_email) as email from push_suscripciones x
  ),
  -- auth.users puede tener el correo con mayúsculas; una cuenta por correo.
  cuentas as (
    select distinct on (lower(a.email)) lower(a.email) as email, a.id,
           a.raw_app_meta_data ->> 'provider' as entra_con,
           a.created_at, a.last_sign_in_at
      from auth.users a
     order by lower(a.email), a.last_sign_in_at desc nulls last
  ),
  sesiones as (
    -- refreshed_at viene sin zona (UTC).
    select s.user_id,
           max(greatest(s.updated_at, s.refreshed_at at time zone 'UTC')) as ultima
      from auth.sessions s group by 1
  )
  select v.email,
         u.nombre,
         u.telefono,
         v.roles,
         c.id is not null,
         c.entra_con,
         c.created_at,
         c.last_sign_in_at,
         nullif(greatest(coalesce(s.ultima, '-infinity'),
                         coalesce(cd.ultima, '-infinity'),
                         coalesce(c.last_sign_in_at, '-infinity')), '-infinity'),
         coalesce(cd.dias, '{}'::date[]),
         p.email is not null,
         coalesce(ce.n, 0),
         coalesce(cm.n, 0),
         coalesce(cr.n, 0),
         coalesce(cf.n, 0),
         coalesce(cc.n, 0),
         coalesce(cru.n, 0),
         coalesce(cco.n, 0),
         coalesce(cn.n, 0)
    from visibles v
    left join lateral (
      select us.nombre, us.telefono from usuarios us
       where lower(us.email) = v.email limit 1
    ) u on true
    left join cuentas c            on c.email = v.email
    left join sesiones s           on s.user_id = c.id
    left join c_dias cd            on cd.email = v.email
    left join c_push p             on p.email = v.email
    left join c_errores ce         on ce.email = v.email
    left join c_maquinas cm        on cm.email = v.email
    left join c_reparaciones cr    on cr.email = v.email
    left join c_fotos cf           on cf.email = v.email
    left join c_chat cc            on cc.email = v.email
    left join c_rutas cru          on cru.email = v.email
    left join c_comprobaciones cco on cco.email = v.email
    left join c_nuc cn             on cn.email = v.email
   order by v.email
$$;

revoke all on function public.actividad_equipo(integer) from public, anon;
grant execute on function public.actividad_equipo(integer) to authenticated;
