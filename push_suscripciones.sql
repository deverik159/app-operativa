-- ============================================================
-- push_suscripciones.sql
-- Suscripciones de Web Push: a qué dispositivos hay que avisarle.
--
-- Cómo funciona el flujo completo:
--
--   1. El usuario da permiso en la app → el navegador devuelve una
--      "suscripción" (endpoint + dos llaves). Se guarda en esta tabla.
--   2. Un trigger sobre `notificaciones` llama a la Edge Function
--      `enviar-push` con la fila recién insertada.
--   3. La función busca las suscripciones de ese `para_email` y le manda el
--      push a cada dispositivo.
--
-- El navegador puede darle a UN MISMO usuario varias suscripciones (celular,
-- laptop, tablet). Por eso la llave es el `endpoint`, no el correo.
--
-- Aplicar en el SQL Editor de Supabase.
-- ============================================================

create table if not exists push_suscripciones (
  id            bigserial primary key,

  -- A quién pertenece. Se cruza con notificaciones.para_email.
  usuario_email text not null,

  -- El endpoint ES la identidad de la suscripción: una URL única que el
  -- navegador genera por dispositivo y por instalación.
  endpoint      text not null unique,
  -- Llaves de cifrado del payload. Sin ellas el push no se puede entregar.
  p256dh        text not null,
  auth          text not null,

  -- Para saber de qué aparato es cuando haya que depurar.
  user_agent    text,
  creado_en     timestamptz default now(),
  -- Última vez que se logró entregar algo. Sirve para limpiar las muertas.
  ultimo_envio  timestamptz,
  -- El navegador puede revocar una suscripción (borrar datos, desinstalar).
  -- Cuando el servicio de push responde 404/410, se marca aquí en vez de
  -- borrarla, para poder ver el historial.
  invalida      boolean not null default false
);

create index if not exists push_susc_email_idx
  on push_suscripciones (lower(usuario_email)) where not invalida;


-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table push_suscripciones enable row level security;

-- Cada quien ve y administra SOLO sus propias suscripciones. Una suscripción
-- ajena permitiría mandarle notificaciones al dispositivo de otro.
drop policy if exists push_sel on push_suscripciones;
create policy push_sel on push_suscripciones for select
  using (lower(usuario_email) = lower(auth_email()));

drop policy if exists push_ins on push_suscripciones;
create policy push_ins on push_suscripciones for insert
  with check (lower(usuario_email) = lower(auth_email()));

drop policy if exists push_upd on push_suscripciones;
create policy push_upd on push_suscripciones for update
  using (lower(usuario_email) = lower(auth_email()));

drop policy if exists push_del on push_suscripciones;
create policy push_del on push_suscripciones for delete
  using (lower(usuario_email) = lower(auth_email()));


-- ------------------------------------------------------------
-- Trigger: avisar a la Edge Function en cada notificación nueva
-- ------------------------------------------------------------
-- OJO: ya existe un trigger llamado `notificaciones` sobre esta misma tabla
-- que llama a `dynamic-worker` (el de WhatsApp). Este es OTRO trigger, con
-- otro nombre, y ambos pueden coexistir: Postgres los dispara a los dos.
--
-- Se usa pg_net (extensión de Supabase) para no bloquear el INSERT esperando
-- la respuesta HTTP. Si el push falla, la notificación ya quedó guardada y el
-- usuario la verá en la campana igual.
create extension if not exists pg_net;

create or replace function notificar_push()
returns trigger
language plpgsql
security definer
as $$
declare
  v_url text := 'https://qztxpcfbbbmvgmtjnlxg.supabase.co/functions/v1/enviar-push';
begin
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- La función valida este secreto para que nadie más pueda invocarla.
      -- Hay que crearlo con:  select set_config(...)  o dejarlo fijo aquí.
      'x-push-secret', current_setting('app.push_secret', true)
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

drop trigger if exists trg_notificar_push on notificaciones;

create trigger trg_notificar_push
  after insert on notificaciones
  for each row
  execute function notificar_push();


-- ------------------------------------------------------------
-- Secreto compartido entre el trigger y la Edge Function
-- ------------------------------------------------------------
-- Cambia 'CAMBIA-ESTE-SECRETO' por una cadena larga y aleatoria, y pon LA
-- MISMA como variable de entorno PUSH_SECRET de la Edge Function.
-- Sin esto, cualquiera que conozca la URL podría disparar notificaciones.
alter database postgres
  set app.push_secret = 'CAMBIA-ESTE-SECRETO';

-- El cambio de arriba aplica a conexiones NUEVAS. Para esta sesión:
select set_config('app.push_secret', 'CAMBIA-ESTE-SECRETO', false);


-- ------------------------------------------------------------
-- Verificación
-- ------------------------------------------------------------
select count(*) as suscripciones from push_suscripciones;
select current_setting('app.push_secret', true) as secreto_configurado;
