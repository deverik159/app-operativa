-- ============================================================
-- 17-nov-2026 · Incidencias · Chat
-- Qué: (1) los técnicos de Op. Bio Box pueden escribir en el chat de
--      cualquier incidencia abierta de Biobox QUE YA PUEDAN VER, sea del
--      área que sea (la función es invoker: no se escribe donde no se lee;
--      ver las de Digital/TI hoy lo da el rol de consulta de Biobox);
--      (2) la regla de quién escribe vive en UNA función,
--      puede_escribir_chat(record_id), que usan la política y la app (para
--      avisar «Solo lectura» antes de que alguien escriba).
-- Por qué: Erik (17-nov-2026). calles.ivan y serralde.christopher (técnicos
--      de Op. Bio Box con consulta de Biobox) veían el chat de BBMM00065
--      (Digital) y al escribir «Sin fallas en sitio» la base lo rechazaba.
--      Op. Bio Box va a las máquinas y lo que encuentra le sirve a Digital y
--      a TI. Además la app no sabía que no podían: dejaba escribir y
--      rechazaba al enviar.
-- Cómo:
--   · puede_escribir_chat: SECURITY INVOKER (corre con la RLS de quien
--     pregunta, igual que la política). Es exactamente msg_ins +
--     msg_ins_coordinador de antes, más la rama nueva de Op. Bio Box.
--   · msg_ins: autor = quien escribe Y puede_escribir_chat(record_id).
--     msg_ins_coordinador se retira: su condición ya va en la función.
--   · No cambia quién LEE (políticas de select intactas) ni los avisos.
--   · Revisada por revisor-rls (17-nov-2026): 13 de 14 técnicos de Op. Bio
--     Box ganan permiso en al menos una incidencia (103 pares nuevos).
-- Re-ejecutable: or replace / drop if exists.
-- ============================================================

create or replace function public.puede_escribir_chat(p_record_id text)
returns boolean
language sql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1
    from incidencias i
    where i.record_id = p_record_id
      and i.estatus <> 'cerrada'
      and (
        (select tiene_rol('manager'))
        or lower(i.captured_by) = lower((select auth_email()))
        or ((select tiene_rol('validador')) and i.unidad_negocio in (select mis_unidades()))
        or ((select tiene_rol('reparacion'))
            and (mi_area_en_unidad(i.area_responsable, i.unidad_negocio)
                 or mi_area_en_unidad(i.assigned_area, i.unidad_negocio)))
        -- NUEVO (17-nov-2026): técnico de Op. Bio Box, en cualquier
        -- incidencia de Biobox que pueda ver.
        or (lower(btrim(i.unidad_negocio)) = 'biobox'
            and exists (
              select 1 from usuario_roles ur
              where lower(ur.usuario_email) = lower((select auth_email()))
                and ur.rol = 'reparacion'
                and ur.departamento = 'Op. Bio Box'
                and (nullif(btrim(ur.unidad_negocio), '') is null
                     or lower(btrim(ur.unidad_negocio)) = lower(btrim(i.unidad_negocio)))))
        or exists (
          select 1 from mensajes previo
          where previo.record_id = i.record_id
            and lower(previo.autor_email) = lower((select auth_email())))
        or exists (
          select 1 from chat_menciones cm
          where cm.record_id = i.record_id
            and cm.email = lower((select auth_email())))
        -- Antes msg_ins_coordinador (misma condición).
        or ((select tiene_rol('coordinador'))
            and (not exists (
                   select 1 from usuario_roles ur
                   where lower(ur.usuario_email) = lower((select auth_email()))
                     and ur.rol = 'coordinador'
                     and ur.unidad_negocio is not null)
                 or exists (
                   select 1 from usuario_roles ur
                   where lower(ur.usuario_email) = lower((select auth_email()))
                     and ur.rol = 'coordinador'
                     and lower(ur.unidad_negocio) = lower(i.unidad_negocio)
                     and (ur.departamento is null
                          or lower(ur.departamento) = lower(i.area_responsable)))))
      )
  );
$$;

revoke all on function public.puede_escribir_chat(text) from public, anon;
grant execute on function public.puede_escribir_chat(text) to authenticated;

drop policy if exists msg_ins on public.mensajes;
create policy msg_ins on public.mensajes
  for insert
  to authenticated
  with check (
    lower(autor_email) = lower((select auth_email()))
    and public.puede_escribir_chat(record_id)
  );

drop policy if exists msg_ins_coordinador on public.mensajes;
