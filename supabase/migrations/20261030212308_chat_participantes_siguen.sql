-- ============================================================
-- 30-oct-2026 · Incidencias (chat)
-- Qué: quien ya escribió en el chat de un folio lo sigue viendo y puede seguir
--      escribiendo hasta que se cierre, aunque la incidencia pase a otra área;
--      y nadie escribe en un folio cerrado.
-- Por qué: los técnicos reportaron que, al reasignarse una incidencia, el área
--      anterior perdía el folio y ya no podía seguir la conversación. Les
--      seguía llegando el push del chat (notificar_chat avisa a todos los que
--      escribieron), pero al tocarlo la app decía "ya no está disponible":
--      inc_sel_reparacion solo deja ver lo del área, y msg_ins solo dejaba
--      escribir al técnico del área responsable (Erik, 30-oct-2026).
-- Además (pendiente anotado el 29-oct-2026 por revisor-rls): msg_ins no
--      impedía escribir en folios cerrados desde fuera de la app; solo la
--      pantalla lo bloqueaba. Ahora la base también, igual que
--      msg_ins_coordinador y msg_upd_autor.
-- Re-ejecutable.
-- ============================================================

-- 1) Ver la incidencia: quien escribió en su chat, mientras no esté cerrada.
--    Es una política MÁS (permisiva, se suma con OR a las de cada rol): no
--    quita nada a nadie. No da botones: reparar, reasignar y validar siguen
--    sus propias reglas (blindaje de reparación, reparaEn en la app).
--    Termina en los dos estatus terminales de la app (cerrada y no_reparado)
--    y exige que el usuario conserve algún rol: a quien se le quitan todos
--    sus roles no le queda acceso por haber escrito (revisor-rls, 30-oct).
drop policy if exists inc_sel_participante_chat on public.incidencias;
create policy inc_sel_participante_chat on public.incidencias
  for select
  to authenticated
  using (
    estatus not in ('cerrada'::estatus_incidencia, 'no_reparado'::estatus_incidencia)
    and exists (
      select 1
      from public.usuario_roles ur
      where lower(ur.usuario_email) = lower((select auth_email()))
    )
    and exists (
      select 1
      from public.mensajes m
      where m.record_id = incidencias.record_id
        and lower(m.autor_email) = lower((select auth_email()))
    )
  );

-- 2) Escribir en el chat. Las mismas reglas de antes, más:
--    - el folio no puede estar cerrado (para todos, también el manager);
--    - el técnico también escribe si la incidencia está dirigida a su área
--      (assigned_area), que es la que repara (inc_sel_reparacion ya la dejaba
--      ver, pero msg_ins solo miraba area_responsable);
--    - quien ya escribió en ese folio sigue escribiendo.
drop policy if exists msg_ins on public.mensajes;
create policy msg_ins on public.mensajes
  for insert
  to authenticated
  with check (
    lower(autor_email) = lower((select auth_email()))
    and exists (
      select 1
      from public.incidencias i
      where i.record_id = mensajes.record_id
        and i.estatus <> 'cerrada'::estatus_incidencia
        and (
          (select tiene_rol('manager'::app_role))
          or lower(i.captured_by) = lower((select auth_email()))
          or ((select tiene_rol('validador'::app_role))
              and i.unidad_negocio in (select mis_unidades()))
          or ((select tiene_rol('reparacion'::app_role))
              and (i.area_responsable in (select mis_departamentos())
                   or i.assigned_area in (select mis_departamentos())))
          or exists (
            select 1
            from public.mensajes previo
            where previo.record_id = i.record_id
              and lower(previo.autor_email) = lower((select auth_email()))
          )
        )
    )
  );

-- 3) Índice para las dos reglas de arriba ("¿escribió este usuario en este
--    folio?"), para cuando el chat crezca.
create index if not exists idx_msg_record_autor
  on public.mensajes (record_id, lower(autor_email));
