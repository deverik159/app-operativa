-- ============================================================
-- La limpieza nocturna del chat lee el secreto del Vault (Erik, 31-oct-2026)
--
-- disparar_limpieza_chat() leía el secreto de app_config.push_secret, pero
-- desde el cambio de llaves del 31-ago-2026 el secreto vigente vive en el
-- Vault (push_secret_vault.sql) y la copia de app_config quedó vieja. La
-- función limpiar-chat respondía 401 y pg_cron marcaba la corrida como
-- "succeeded" (la llamada sí salía), así que nadie lo vio: ningún adjunto
-- del chat se ha purgado nunca.
--
--   1. La función lee el secreto del Vault, igual que notificar_push. Si
--      no está, avisa en el log y no llama a la función.
--   2. Se borra app_config.push_secret: era una copia vieja y ya nadie la
--      lee. limpieza_url y push_auth se quedan.
--   3. Solo el cron (postgres) la ejecuta. Antes cualquier usuario con
--      sesión podía llamarla por RPC; con el secreto ya bueno, eso le
--      permitiría adelantar la purga y despertar limpiar-chat a voluntad.
-- ============================================================

-- 1. Copia de producción (pg_get_functiondef, 31-oct-2026); el CAMBIO es de
--    dónde sale v_secret y el aviso si falta.
create or replace function public.disparar_limpieza_chat()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_url text; v_secret text; v_auth text; v_n int;
begin
  select count(*) into v_n from vw_chat_adjuntos_purgables;
  if v_n = 0 then
    raise notice '[limpieza] nada que purgar';
    return;
  end if;

  select valor into v_url  from app_config where clave = 'limpieza_url';
  select valor into v_auth from app_config where clave = 'push_auth';

  -- El secreto vive en el Vault, el mismo que usa notificar_push. Esta
  -- función es security definer: puede leerlo; el rol authenticated, no.
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'push_secret';

  -- Se valida la FORMA, no un texto concreto: cualquier cosa que no sea una
  -- URL https es configuración pendiente. Antes se comparaba contra el
  -- placeholder, y un buscar-y-reemplazar sobre el archivo invertía la
  -- condición sin que nada se quejara.
  if v_url is null or v_url !~ '^https://' then
    raise warning '[limpieza] limpieza_url sin configurar; % archivos esperando', v_n;
    return;
  end if;

  if v_secret is null or v_secret = '' then
    raise warning '[limpieza] push_secret no está en el Vault; % archivos esperando', v_n;
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || coalesce(v_auth, ''),
      'x-push-secret', v_secret
    ),
    body    := jsonb_build_object('origen', 'cron')
  );
  raise notice '[limpieza] solicitados % archivos', v_n;
end;
$function$;

-- 2. La copia vieja del secreto.
delete from public.app_config where clave = 'push_secret';

-- 3. Nadie más que el cron. create or replace conserva los grants: se
--    quitan a mano.
revoke execute on function public.disparar_limpieza_chat() from public, anon, authenticated;
