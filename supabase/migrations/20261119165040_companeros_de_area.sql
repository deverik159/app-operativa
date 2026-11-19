-- ============================================================
-- 19-nov-2026 · Incidencias · Indicadores › Técnicos
-- Qué: companeros_de_area() — la lista de técnicos (rol reparacion) que
--      comparten área y unidad con quien llama, para que cada técnico vea
--      el ranking de su área con su fila resaltada.
-- Por qué: Erik (19-nov-2026): «que el técnico vea el ranking de su área…
--      si esto genera competencia». Antes cada técnico veía solo lo suyo;
--      la lista de compañeros solo la daba actividad_equipo (manager y
--      coordinadores) y usuario_roles solo deja ver las filas propias.
-- Qué devuelve: correo, nombre y SOLO las filas de reparación que empatan
--      (unidad, área). Nada de actividad, teléfono ni otros roles. Los
--      números (reparaciones, rutas, visitas) ya los lee el técnico por la
--      RLS de cada tabla; esto no abre datos nuevos fuera de la lista.
-- Reglas de empate: el área debe coincidir (sin mayúsculas ni espacios).
--      Si la fila de quien llama tiene unidad, solo salen técnicos con esa
--      MISMA unidad: un técnico de Digital «de todas» no sale en el ranking
--      de Vía Verde, porque desde ahí solo se ven sus reparaciones de Vía
--      Verde y aparecería en 0 (revisor-rls, 19-nov-2026). Si quien llama no
--      tiene unidad (todas), salen los de cualquier unidad. Una fila de
--      reparación sin área no trae a nadie. Los managers no salen en la
--      lista (igual que en actividad_equipo).
-- ============================================================

create or replace function public.companeros_de_area()
returns table (email text, nombre text, roles jsonb)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with yo as (
    select lower(auth_email()) as e
  ),
  mias as (
    select nullif(btrim(ur.unidad_negocio), '') as u,
           lower(btrim(ur.departamento))        as d
      from usuario_roles ur, yo
     where lower(ur.usuario_email) = yo.e
       and ur.rol = 'reparacion'::app_role
       and nullif(btrim(ur.departamento), '') is not null
  ),
  managers as (
    select distinct lower(usuario_email) as e
      from usuario_roles
     where rol = 'manager'::app_role
  ),
  filas as (
    select lower(t.usuario_email)                as email,
           nullif(btrim(t.unidad_negocio), '')   as unidad,
           btrim(t.departamento)                 as area
      from usuario_roles t
     where t.rol = 'reparacion'::app_role
       and nullif(btrim(t.departamento), '') is not null
       and lower(t.usuario_email) not in (select e from managers)
       and exists (
             select 1 from mias m
              where lower(btrim(t.departamento)) = m.d
                and (m.u is null
                     or lower(btrim(t.unidad_negocio)) = lower(m.u)))
  )
  select f.email,
         (select us.nombre from usuarios us where lower(us.email) = f.email limit 1),
         jsonb_agg(distinct jsonb_build_object('unidad', f.unidad, 'area', f.area, 'rol', 'reparacion'))
    from filas f
   group by f.email
   order by f.email
$$;

revoke all on function public.companeros_de_area() from public, anon;
grant execute on function public.companeros_de_area() to authenticated;
