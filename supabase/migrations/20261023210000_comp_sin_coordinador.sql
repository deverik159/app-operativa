-- ============================================================
-- comp_sin_coordinador — Comprobaciones: solo Supervisor, Manager y la
-- analista con lo suyo (Erik, 23-oct-2026).
--
-- QUÉ CAMBIA. comp_base (20261023193250) dejaba al coordinador de la unidad
-- leer todo Comprobaciones en solo lectura (P3, valor por omisión de
-- Claude). Erik lo decidió distinto:
--   «El Módulo nuevo de Comprobaciones, solo el Supervisor y el Manager.»
--   La pestaña del analista (Mis campañas) la ven la analista, el Supervisor
--   y el Manager; el coordinador (de rutas o de Pauta y Monitoreo) no.
-- La app ya no le enseña el módulo al coordinador; esto hace que la base
-- tampoco se lo entregue por la API:
--   · comp_lee(): solo Supervisor (o manager). La usan comp_equipo y
--     comp_monitoristas.
--   · Políticas de SELECT: se quita 'coordinador' de comp_periodos,
--     comp_campanas, comp_sitios, comp_tomas y comp_reglas. La analista
--     sigue viendo sus campañas (y sus sitios y tomas) y los periodos y
--     reglas de su unidad; comp_movimientos ya era solo del Supervisor.
-- De paso (revisor-rls, 23-oct-2026):
--   · comp_reglas: cada quien lee las generales (unidad NULL) y las de SUS
--     unidades; antes una analista de Biobox leía las de Vía Verde.
--   · comp_movimientos: el manager ve también los de unidad NULL (reglas
--     generales), que antes no veía nadie.
--   · (select lower(auth_email())) se evalúa una vez por consulta.
-- Nada de lo demás cambia: las RPC que escriben ya pedían Supervisor o la
-- analista de la campaña. Las vistas son security_invoker y siguen a las
-- políticas. Sin datos que migrar (en producción aún no hay campañas).
-- Re-ejecutable.
-- ============================================================

-- Lee toda la unidad: solo el Supervisor de esa unidad (o el manager).
create or replace function public.comp_lee(p_unidad text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select coalesce(p_unidad in (select comp_mis_unidades(array['supervisor']::app_role[])), false)
$$;

drop policy if exists comp_per_sel on public.comp_periodos;
create policy comp_per_sel on public.comp_periodos for select to authenticated
  using (unidad in (select comp_mis_unidades(array['supervisor', 'analista']::app_role[])));

-- La analista ve sus campañas mientras siga teniendo el rol en esa unidad.
drop policy if exists comp_cam_sel on public.comp_campanas;
create policy comp_cam_sel on public.comp_campanas for select to authenticated
  using (unidad in (select comp_mis_unidades(array['supervisor']::app_role[]))
         or (analista_email = (select lower(auth_email()))
             and unidad in (select comp_mis_unidades(array['analista']::app_role[]))));

drop policy if exists comp_sit_sel on public.comp_sitios;
create policy comp_sit_sel on public.comp_sitios for select to authenticated
  using (unidad in (select comp_mis_unidades(array['supervisor']::app_role[]))
         or campana_id in (select c.id from public.comp_campanas c where c.analista_email = (select lower(auth_email()))));

drop policy if exists comp_tom_sel on public.comp_tomas;
create policy comp_tom_sel on public.comp_tomas for select to authenticated
  using (unidad in (select comp_mis_unidades(array['supervisor']::app_role[]))
         or campana_id in (select c.id from public.comp_campanas c where c.analista_email = (select lower(auth_email()))));

drop policy if exists comp_reg_sel on public.comp_reglas;
create policy comp_reg_sel on public.comp_reglas for select to authenticated
  using (exists (select 1 from comp_mis_unidades(array['supervisor', 'analista']::app_role[]))
         and (unidad is null or unidad in (select comp_mis_unidades(array['supervisor', 'analista']::app_role[]))));

drop policy if exists comp_mov_sel on public.comp_movimientos;
create policy comp_mov_sel on public.comp_movimientos for select to authenticated
  using (unidad in (select comp_mis_unidades(array['supervisor']::app_role[]))
         or (unidad is null and (select tiene_rol('manager'))));
