-- ============================================================
-- chat_coordinador_escribe — 29-oct-2026 · Incidencias (chat)
--
-- Qué hace: deja que el Coordinador escriba en el chat de las incidencias
-- que ya ve como coordinador (su unidad y, si tiene área, su área).
--
-- Por qué: msg_ins solo deja escribir al manager, a quien capturó, al
-- validador de la unidad y al técnico del área. Un Coordinador de Op. Bio
-- Box veía los folios pero al escribir la base lo rechazaba con error de
-- regla. Erik decidió el 29-oct-2026 que el Coordinador sí escriba.
--
-- Es una política PERMISSIVE aparte: se suma (OR) a msg_ins sin tocarla.
-- El alcance repite el de inc_sel_coordinador: coordinador sin unidad ve
-- todo; con unidad, la incidencia debe ser de esa unidad y de su
-- departamento (o el renglón no tiene departamento). En folios cerrados
-- no deja escribir, como chat_adj_ins y msg_upd_autor. Re-ejecutable.
-- ============================================================
drop policy if exists msg_ins_coordinador on public.mensajes;

create policy msg_ins_coordinador on public.mensajes
  for insert to authenticated
  with check (
    lower(autor_email) = lower((select auth_email()))
    and (select tiene_rol('coordinador'::app_role))
    and exists (
      select 1
      from public.incidencias i
      where i.record_id = mensajes.record_id
        and i.estatus <> 'cerrada'::estatus_incidencia
        and (
          not exists (
            select 1 from public.usuario_roles ur
            where lower(ur.usuario_email) = lower((select auth_email()))
              and ur.rol = 'coordinador'::app_role
              and ur.unidad_negocio is not null
          )
          or exists (
            select 1 from public.usuario_roles ur
            where lower(ur.usuario_email) = lower((select auth_email()))
              and ur.rol = 'coordinador'::app_role
              and ur.unidad_negocio ilike i.unidad_negocio
              and (ur.departamento is null or ur.departamento ilike i.area_responsable)
          )
        )
    )
  );

-- Verificar: debe salir msg_ins_coordinador junto a msg_ins.
select policyname, cmd, roles from pg_policies
where schemaname = 'public' and tablename = 'mensajes' and cmd = 'INSERT';
