-- 23-nov-2026 · Plataforma (rendimiento)
-- Qué hace: las políticas inc_sel_reparacion, inc_sel_reportante, inc_upd_reparacion e
-- inc_sel_manager_viewer de incidencias dejan de llamar mi_area_en_unidad() y
-- viewer_de() por cada renglón. En su lugar, dos funciones nuevas devuelven UNA vez por
-- consulta las áreas y unidades de la persona, y cada renglón solo se compara contra
-- esa lista (Postgres la arma como tabla hash).
--   · mis_areas_por_unidad(): (área, unidad) de las filas de usuario_roles de la persona
--     que tienen área; unidad en minúsculas y sin espacios, NULL = todas las unidades.
--   · mis_unidades_viewer(): unidades de sus filas de viewer, igual; NULL = todas.
-- Por qué: mi_area_en_unidad() y viewer_de() son security definer con SET search_path,
-- así que no se inlinean. Se llamaban hasta 4 veces por cada una de las 249 incidencias,
-- sobre todo en las que la persona NO ve, donde se evalúan todas las políticas. Las dos
-- listas de incidencias costaban ~255 ms cada una en la base contra ~5 ms sin RLS, y
-- 570–714 ms para los técnicos de Digital/SRD y los técnicos con viewer de Biobox
-- (auditoría de rendimiento del 23-nov-2026; idea de revisor-rls del 20-nov-2026).
-- No cambia quién ve qué. Cada llamada se reemplaza por su equivalente exacto:
--   mi_area_en_unidad(A, U)  ≡  A is not null and (
--       A in (áreas con unidad NULL)
--       or (A, lower(btrim(U))) in (pares área/unidad con unidad no NULL))
--     · el área se compara igual que antes: exacta, con mayúsculas y sin recortar;
--     · la unidad, como antes: lower(btrim()) en las dos puntas, y la vacía o NULL de
--       usuario_roles cuenta como todas;
--     · no filtra por rol, igual que mi_area_en_unidad (cualquier fila con ese área).
--   viewer_de(U)  ≡  exists (unidad de viewer NULL)
--                    or lower(btrim(U)) in (unidades de viewer no NULL)
--     · p_medio no se usa en esta política (viewer_de se llamaba con un solo argumento).
-- Un NULL en la comparación da NULL, que la RLS trata como falso, igual que el falso
-- de antes; por eso se deja el «A is not null and» al frente.
-- mi_area_en_unidad() y viewer_de() se quedan: otras políticas y funciones las usan.
-- Las funciones nuevas no dan nada que no dé ya usuario_roles: solo devuelven filas de
-- la propia persona (ur_self_read ya le deja leerlas).
-- Se puede volver a correr.

set local lock_timeout = '3s';

-- ── Funciones: una vez por consulta ──────────────────────────────────────────

create or replace function public.mis_areas_por_unidad()
returns table (area text, unidad text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct ur.departamento,
         nullif(lower(btrim(ur.unidad_negocio)), '')
    from usuario_roles ur
   where lower(ur.usuario_email) = lower((select auth_email()))
     and ur.departamento is not null;
$$;

comment on function public.mis_areas_por_unidad() is
  'Áreas de la persona con su unidad (minúsculas, sin espacios; NULL = todas). Para las políticas de incidencias: se calcula una vez por consulta en lugar de mi_area_en_unidad() por renglón (23-nov-2026).';

create or replace function public.mis_unidades_viewer()
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct nullif(lower(btrim(ur.unidad_negocio)), '')
    from usuario_roles ur
   where lower(ur.usuario_email) = lower((select auth_email()))
     and ur.rol = 'viewer'::app_role;
$$;

comment on function public.mis_unidades_viewer() is
  'Unidades de las filas de viewer de la persona (minúsculas, sin espacios; NULL = todas). Equivale a viewer_de(unidad) sin medio, calculado una vez por consulta (23-nov-2026).';

revoke all on function public.mis_areas_por_unidad() from public, anon;
revoke all on function public.mis_unidades_viewer() from public, anon;
grant execute on function public.mis_areas_por_unidad() to authenticated, service_role;
grant execute on function public.mis_unidades_viewer() to authenticated, service_role;

-- ── incidencias: lectura ──────────────────────────────────────────────────────

alter policy inc_sel_reparacion on public.incidencias
  using ((select tiene_rol('reparacion'::app_role))
         and ((not (exists (select 1 from mis_departamentos() mis_departamentos(mis_departamentos))))
              or (area_responsable is not null
                  and (area_responsable in (select m.area from mis_areas_por_unidad() m where m.unidad is null)
                       or (area_responsable, lower(btrim(unidad_negocio)))
                          in (select m.area, m.unidad from mis_areas_por_unidad() m where m.unidad is not null)))
              or (assigned_area is not null
                  and (assigned_area in (select m.area from mis_areas_por_unidad() m where m.unidad is null)
                       or (assigned_area, lower(btrim(unidad_negocio)))
                          in (select m.area, m.unidad from mis_areas_por_unidad() m where m.unidad is not null)))));

alter policy inc_sel_reportante on public.incidencias
  using ((select tiene_rol('reportante'::app_role))
         and ((lower(captured_by) = lower((select auth_email())))
              or (area_reportante is not null
                  and (area_reportante in (select m.area from mis_areas_por_unidad() m where m.unidad is null)
                       or (area_reportante, lower(btrim(unidad_negocio)))
                          in (select m.area, m.unidad from mis_areas_por_unidad() m where m.unidad is not null)))));

alter policy inc_sel_manager_viewer on public.incidencias
  using ((select tiene_rol('manager'::app_role))
         or ((select tiene_rol('viewer'::app_role))
             and ((exists (select 1 from mis_unidades_viewer() v(unidad) where v.unidad is null))
                  or lower(btrim(unidad_negocio))
                     in (select v.unidad from mis_unidades_viewer() v(unidad) where v.unidad is not null))));

-- ── incidencias: escritura ────────────────────────────────────────────────────
-- Sin WITH CHECK propio: Postgres usa este mismo USING para revisar la fila nueva,
-- como antes.

alter policy inc_upd_reparacion on public.incidencias
  using ((select tiene_rol('reparacion'::app_role))
         and ((area_responsable is not null
               and (area_responsable in (select m.area from mis_areas_por_unidad() m where m.unidad is null)
                    or (area_responsable, lower(btrim(unidad_negocio)))
                       in (select m.area, m.unidad from mis_areas_por_unidad() m where m.unidad is not null)))
              or (assigned_area is not null
                  and (assigned_area in (select m.area from mis_areas_por_unidad() m where m.unidad is null)
                       or (assigned_area, lower(btrim(unidad_negocio)))
                          in (select m.area, m.unidad from mis_areas_por_unidad() m where m.unidad is not null)))));
