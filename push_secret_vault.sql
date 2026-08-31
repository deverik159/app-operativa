-- ============================================================
-- push_secret_vault.sql — guardar el PUSH_SECRET en el Vault de Supabase
--
-- POR QUÉ: push_suscripciones.sql guardaba el secreto con
--   alter database postgres set app.push_secret = '...'
-- y Supabase ya NO permite ALTER DATABASE en los proyectos actuales
-- (ERROR 42501: permission denied to set parameter). El reemplazo
-- soportado es el Vault: el secreto queda cifrado y solo lo leen los
-- roles privilegiados — la función del trigger es security definer
-- (corre como postgres), así que lo alcanza; un usuario de la app, no.
--
-- CÓMO CORRERLO (SQL Editor):
--   1) Cambia 'CAMBIA-ESTE-SECRETO' por tu secreto real — EL MISMO que
--      pusiste en `supabase secrets set PUSH_SECRET=...`.
--   2) Corre el archivo completo.
--   3) La verificación del final debe regresar `secreto_en_vault = t`.
--
-- Si marcara que el esquema vault no existe: Dashboard → Database →
-- Extensions → habilita "supabase_vault" y vuelve a correr.
-- ============================================================

-- 1) Guardar (o reemplazar) el secreto en el Vault.
do $$
begin
  -- Si ya existía de un intento anterior, fuera: create_secret no upserta.
  delete from vault.secrets where name = 'push_secret';
  perform vault.create_secret('CAMBIA-ESTE-SECRETO', 'push_secret');
end $$;

-- 2) El trigger, ahora leyendo del Vault en vez de current_setting().
create or replace function notificar_push()
returns trigger
language plpgsql
security definer
as $$
declare
  v_url    text := 'https://qztxpcfbbbmvgmtjnlxg.supabase.co/functions/v1/enviar-push';
  v_secret text;
begin
  -- El secreto vive en el Vault (ver push_secret_vault.sql). Esta función
  -- es security definer: puede leerlo; el rol authenticated, no.
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'push_secret';

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', v_secret
    ),
    body    := jsonb_build_object(
      'id',             new.id,
      'para_email',     new.para_email,
      'evento',         new.evento,
      'mensaje',        new.mensaje,
      'record_id',      new.record_id,
      'unidad_negocio', new.unidad_negocio
    )
  );
  return new;
end;
$$;

-- El trigger en sí no cambia; si push_suscripciones.sql ya lo creó, el
-- CREATE OR REPLACE de arriba basta. Por si se corre este archivo solo:
drop trigger if exists trg_notificar_push on notificaciones;
create trigger trg_notificar_push
  after insert on notificaciones
  for each row
  execute function notificar_push();

-- 3) Verificación.
select exists(
  select 1 from vault.decrypted_secrets where name = 'push_secret'
) as secreto_en_vault;
