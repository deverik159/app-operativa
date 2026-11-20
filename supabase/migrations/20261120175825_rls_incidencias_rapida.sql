-- 20-nov-2026 · Plataforma (rendimiento)
-- Qué hace: envuelve en (select …) las llamadas a tiene_rol() y auth_email() que no
-- dependen del renglón, en las políticas de usuario_roles e incidencias. Así se
-- calculan una vez por consulta y no una vez por renglón.
-- Por qué: la lista de incidencias tardaba de 2 a 6 s con la sesión de un usuario
-- (5 ms sin RLS) y 87 cargas se cortaron a los 8 s el 20-nov-2026. Las políticas de
-- incidencias leen usuario_roles dentro de un EXISTS por cada incidencia, y cada
-- renglón de usuario_roles volvía a llamar tiene_rol('manager') y auth_email().
-- No cambia quién ve qué: mismas condiciones, mismos roles y mismos comandos.
-- La única reescritura es inc_sel_manager_viewer: viewer_de() solo puede ser
-- verdadero si la persona tiene una fila de viewer, así que antes se pregunta
-- (select tiene_rol('viewer')) para no llamar viewer_de() por renglón a quien no lo es.
-- ALTER POLICY conserva roles y comando, y se puede volver a correr.
-- Las políticas del validador llevan al frente (select tiene_rol('validador')): su
-- EXISTS solo encuentra la fila propia de validador, así que es equivalente y quien
-- no es validador ya no recorre usuario_roles por cada incidencia (revisor-rls).

-- Cada ALTER POLICY bloquea la tabla hasta el final; si una lista lenta la tiene,
-- mejor fallar a los 3 s (sin dejar nada a medias) que congelar la app detrás.
set local lock_timeout = '3s';

-- ── usuario_roles ─────────────────────────────────────────────────────────────

alter policy ur_self_read on public.usuario_roles
  using ((lower(usuario_email) = lower((select auth_email())))
         or (select tiene_rol('manager'::app_role)));

alter policy ur_manager_all on public.usuario_roles
  using ((select tiene_rol('manager'::app_role)))
  with check ((select tiene_rol('manager'::app_role)));

alter policy ur_coord_ve_tecnicos on public.usuario_roles
  using ((select tiene_rol('coordinador'::app_role))
         and (rol = 'reparacion'::app_role)
         and ((not (exists (select 1 from mis_unidades() mis_unidades(mis_unidades))))
              or (unidad_negocio in (select mis_unidades() as mis_unidades))));

-- ── incidencias: lectura ──────────────────────────────────────────────────────

alter policy inc_sel_manager_viewer on public.incidencias
  using ((select tiene_rol('manager'::app_role))
         or ((select tiene_rol('viewer'::app_role)) and viewer_de(unidad_negocio)));

alter policy inc_sel_monitorista on public.incidencias
  using ((select tiene_rol('monitorista'::app_role))
         and (lower(coalesce(captured_by, ''::text)) = lower((select auth_email()))));

alter policy inc_sel_validador on public.incidencias
  using ((select tiene_rol('validador'::app_role))
         and (exists (select 1 from usuario_roles ur
                       where lower(ur.usuario_email) = lower((select auth_email()))
                         and ur.rol = 'validador'::app_role
                         and lower(ur.unidad_negocio) = lower(incidencias.unidad_negocio)
                         and (ur.medio is null or lower(ur.medio) = lower(incidencias.medio)))));

-- ── mensajes (lo lee inc_sel_participante_chat por cada incidencia) ──────────

alter policy msg_sel on public.mensajes
  using ((select auth_email()) is not null);

-- ── incidencias: escritura ────────────────────────────────────────────────────

alter policy inc_del_manager on public.incidencias
  using ((select tiene_rol('manager'::app_role)));

alter policy inc_ins_monitorista on public.incidencias
  with check ((select tiene_rol('monitorista'::app_role))
              and (lower(captured_by) = lower((select auth_email()))));

alter policy inc_ins_reportante on public.incidencias
  with check (((select tiene_rol('reportante'::app_role))
               or (select tiene_rol('manager'::app_role)))
              and (lower(captured_by) = lower((select auth_email()))));

alter policy inc_upd_manager on public.incidencias
  using ((select tiene_rol('manager'::app_role)))
  with check (true);

alter policy inc_upd_validador on public.incidencias
  using ((select tiene_rol('validador'::app_role))
         and (exists (select 1 from usuario_roles ur
                       where lower(ur.usuario_email) = lower((select auth_email()))
                         and ur.rol = 'validador'::app_role
                         and lower(ur.unidad_negocio) = lower(incidencias.unidad_negocio)
                         and (ur.medio is null or lower(ur.medio) = lower(incidencias.medio)))))
  with check ((select tiene_rol('validador'::app_role))
              and (exists (select 1 from usuario_roles ur
                            where lower(ur.usuario_email) = lower((select auth_email()))
                              and ur.rol = 'validador'::app_role
                              and lower(ur.unidad_negocio) = lower(incidencias.unidad_negocio)
                              and (ur.medio is null or lower(ur.medio) = lower(incidencias.medio)))));

alter policy inc_upd_reportante on public.incidencias
  using ((select tiene_rol('reportante'::app_role))
         and (lower(captured_by) = lower((select auth_email())))
         and (estatus = any (array['por_validar'::estatus_incidencia, 'rechazada'::estatus_incidencia])))
  with check ((lower(captured_by) = lower((select auth_email())))
              and (estatus = any (array['por_validar'::estatus_incidencia, 'rechazada'::estatus_incidencia])));
