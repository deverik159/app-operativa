-- 9-nov-2026 · Reportes de la app Biobox: TI consulta y Consulta por unidad
--
-- Qué hace (decisiones de Erik del 9-nov-2026):
--   · Los técnicos de TI (rol reparacion, área TI) VEN la bandeja, solo para
--     consulta: Ricardo Estrada atiende los de puntos y quiere ver los
--     reportes. Clasificar, ligar y descartar siguen siendo solo de la
--     validadora de la unidad o del manager (biobox_app_exige_validador, sin
--     cambio).
--   · Consulta (viewer) se limita por unidad: con unidad Biobox o Biobox Perú
--     ve esa bandeja; sin unidad (= todas) ve todo. Antes cualquier viewer
--     la veía, también uno de Ecovallas.
--
-- Cómo: biobox_app_ve_bandeja() suma los dos casos (misma regla «unidad vacía
--   = todas» que el resto de la app) y la política de lectura de
--   biobox_app_reportes deja de tener la rama aparte de viewer.

set local lock_timeout = '5s';

create or replace function public.biobox_app_ve_bandeja(p_unidad text)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select (select tiene_rol('manager'::app_role))
      or exists (
        select 1 from usuario_roles ur
         where lower(ur.usuario_email) = lower((select auth_email()))
           and (
             -- Validador DE esa unidad (como inc_sel_validador).
             (ur.rol = 'validador'::app_role
              and lower(btrim(ur.unidad_negocio)) = lower(p_unidad))
             -- Coordinador y Consulta: de esa unidad o sin unidad (= todas).
             or (ur.rol in ('coordinador'::app_role, 'viewer'::app_role)
                 and (nullif(btrim(ur.unidad_negocio), '') is null
                      or lower(btrim(ur.unidad_negocio)) = lower(p_unidad)))
             -- Técnico de TI, solo consulta: de esa unidad o sin unidad.
             or (ur.rol = 'reparacion'::app_role
                 and lower(btrim(ur.departamento)) = 'ti'
                 and (nullif(btrim(ur.unidad_negocio), '') is null
                      or lower(btrim(ur.unidad_negocio)) = lower(p_unidad)))
           )
      );
$function$;
revoke all on function public.biobox_app_ve_bandeja(text) from public, anon;
grant execute on function public.biobox_app_ve_bandeja(text) to authenticated;

drop policy if exists biobox_app_reportes_sel on public.biobox_app_reportes;
create policy biobox_app_reportes_sel on public.biobox_app_reportes
  for select to authenticated
  using ((select biobox_app_ve_bandeja(biobox_app_reportes.unidad_negocio)));
