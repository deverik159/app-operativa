-- ============================================================
-- chat_editar_mensajes.sql — editar mensajes del chat, estilo WhatsApp
-- Correr una vez en Supabase → SQL Editor.
--
-- QUÉ PERMITE (Erik, 11-sep-2026): el AUTOR corrige su propio mensaje
-- durante 15 minutos (la misma ventana de WhatsApp), mientras la
-- incidencia no esté cerrada. El chat es registro operativo — se usa en
-- rechazos y disputas — así que la edición deja rastro:
--   editado_en      → cuándo se editó (la burbuja enseña "(editado)")
--   texto_original  → lo que decía ANTES de la primera edición
-- Los dos los escribe el TRIGGER, no el cliente: como inc_cuenta_rechazo,
-- lo que mande la app en esas columnas se ignora. Borrar mensajes sigue
-- prohibido, igual que siempre.
-- ============================================================

-- 1) Columnas nuevas.
alter table public.mensajes
  add column if not exists editado_en timestamptz,
  add column if not exists texto_original text;

-- 2) Trigger de auditoría: fecha y texto original los decide el servidor,
--    y las columnas de identidad no se pueden reescribir por API.
create or replace function public.msg_marca_edicion()
returns trigger
language plpgsql
as $$
begin
  if new.texto is distinct from old.texto then
    new.texto_original := coalesce(old.texto_original, old.texto);
    new.editado_en := now();
  else
    new.texto_original := old.texto_original;
    new.editado_en := old.editado_en;
  end if;
  -- Nada más se mueve: ni autor, ni fecha, ni de qué incidencia es.
  new.record_id := old.record_id;
  new.autor_email := old.autor_email;
  new.autor_nombre := old.autor_nombre;
  new.creado_en := old.creado_en;
  return new;
end $$;

drop trigger if exists trg_msg_marca_edicion on public.mensajes;
create trigger trg_msg_marca_edicion
  before update on public.mensajes
  for each row execute function public.msg_marca_edicion();

-- 3) Permiso de UPDATE acotado A LA COLUMNA texto (patrón de
--    revision_respuestas): aunque exista un grant más amplio, el trigger
--    de arriba revierte cualquier otra columna.
grant update (texto) on public.mensajes to authenticated;

-- 4) La política: solo el autor, solo 15 minutos, solo incidencia abierta.
drop policy if exists msg_upd_autor on public.mensajes;
create policy msg_upd_autor on public.mensajes
  for update to authenticated
  using (
    lower(coalesce(autor_email, '')) = lower(coalesce(auth_email(), ''))
    and creado_en > now() - interval '15 minutes'
    and exists (
      select 1 from public.incidencias i
      where i.record_id = mensajes.record_id
        and i.estatus <> 'cerrada'
    )
  )
  with check (
    lower(coalesce(autor_email, '')) = lower(coalesce(auth_email(), ''))
  );

-- 5) Verificar: columnas, trigger y política.
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'mensajes'
  and column_name in ('editado_en', 'texto_original');

select tgname from pg_trigger
where tgrelid = 'public.mensajes'::regclass and tgname = 'trg_msg_marca_edicion';

select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'mensajes';
