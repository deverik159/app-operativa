-- ============================================================
-- prelanzamiento_300.sql — lo de base de datos del bloque "antes de abrir
-- a 300 usuarios" (auditoría del 24-sep-2026).
--
-- Correr COMPLETO en Supabase → SQL Editor. Es re-ejecutable: todo usa
-- if not exists / or replace / drop if exists.
--
-- Lo que hace, por pasos:
--   1. Índices para las consultas que corren en cada tick o recarga.
--   2. Purga diaria de notificaciones YA LEÍDAS de más de 90 días.
--   3. Tabla errores_cliente (el ErrorBoundary y las subidas fallidas
--      reportan ahí) con su purga a 60 días.
--   4. Seguridad: el rol anónimo (la llave pública que viaja en la app) deja
--      de poder leer CUALQUIER tabla o vista; app_config (donde vive el
--      secreto del push en texto plano) queda cerrada; y pauta_monitoreo ya
--      no se puede escribir directo por la API, solo por sus funciones.
--   5. dar_baja_usuario(): la baja que de verdad quita el acceso.
--   6. Verificaciones.
--
-- Lo que NO toca: ningún dato operativo (salvo las notificaciones viejas del
-- paso 2), ni las funciones de RLS, ni las políticas de incidencias.
--
-- CÓMO CORRERLO: en horario muerto (noche o fin de semana). El SQL Editor lo
-- corre como UNA transacción: los índices retienen su candado hasta el
-- final. Con el lock_timeout de abajo, si algo está ocupado el script falla
-- rápido en vez de quedarse colgado — y como TODO es re-ejecutable, basta
-- volver a correrlo. IMPORTANTE: correrlo ANTES de publicar el frontend de
-- este bloque (la baja de usuarios llama a funciones que se crean aquí).
-- ============================================================

set lock_timeout = '5s';


-- ══ PASO 1 — Índices ══
-- Crearlos toma un candado breve sobre la tabla; con el tamaño actual es
-- instantáneo. Si alguno ya existía con otro nombre, el paso 6 lo enseña.

-- La campana: lo NO leído de cada usuario, del más nuevo al más viejo. La
-- RLS compara lower(para_email) = lower(auth_email()): el índice va sobre
-- la misma expresión para que se use.
create index if not exists notif_pendientes_idx
  on public.notificaciones (lower(para_email), creado_en desc)
  where leida = false;

-- Marcar leídos los avisos de una incidencia al accionarla.
create index if not exists notif_record_pend_idx
  on public.notificaciones (record_id)
  where leida = false;

-- Lista de incidencias (orden por fecha) y filtros por estatus.
create index if not exists inc_fecha_reporte_idx
  on public.incidencias (fecha_reporte desc);
create index if not exists inc_estatus_idx
  on public.incidencias (estatus);
-- Regla de duplicados: en_proceso + cara + incidencia.
create index if not exists inc_dup_idx
  on public.incidencias (clave_medio, nombre_incidencia)
  where estatus = 'en_proceso';

-- Fotos de las tarjetas y galerías.
create index if not exists evid_record_idx
  on public.evidencias (record_id);
create index if not exists evid_tarjetas_idx
  on public.evidencias (tipo, etapa, creado_en desc);

-- Chat y reasignaciones.
create index if not exists msg_record_idx
  on public.mensajes (record_id, creado_en);
create index if not exists reas_record_idx
  on public.reasignaciones (record_id);
create index if not exists reas_solicitadas_idx
  on public.reasignaciones (record_id)
  where estado = 'Solicitada';

-- Las funciones de RLS (tiene_rol, mis_departamentos) consultan roles por
-- correo en CADA consulta de cada usuario.
create index if not exists uroles_email_idx
  on public.usuario_roles (lower(usuario_email));


-- ══ PASO 2 — Purga de notificaciones viejas ══
-- La tabla crecía sin límite: cada evento genera varias filas (una por
-- destinatario). Se borra lo LEÍDO de más de 90 días, y también lo NO leído
-- de más de 180: los avisos con varios destinatarios (p. ej. "toma por
-- comprobar" a todos los coordinadores) solo los atiende uno y las copias de
-- los demás se quedaban sin leer para siempre. 08:30 UTC = 02:30 CDMX.
select cron.unschedule('purgar-notificaciones')
where exists (select 1 from cron.job where jobname = 'purgar-notificaciones');

select cron.schedule(
  'purgar-notificaciones',
  '30 8 * * *',
  $$delete from public.notificaciones
     where (leida = true and creado_en < now() - interval '90 days')
        or (leida = false and creado_en < now() - interval '180 days')$$
);


-- ══ PASO 3 — Registro de errores del cliente ══
create table if not exists public.errores_cliente (
  id            bigserial primary key,
  creado_en     timestamptz not null default now(),
  -- Lo pone la BASE, no el cliente: nadie puede reportar a nombre de otro.
  usuario_email text default lower(auth_email()),
  modulo        text,
  mensaje       text,
  stack         text,
  ruta          text,
  version       text,
  user_agent    text,
  en_linea      boolean,
  extra         jsonb
);

create index if not exists errcli_creado_idx
  on public.errores_cliente (creado_en desc);

-- Topes de tamaño EN LA BASE: los recortes del cliente no protegen de
-- alguien que escriba directo por la API con su sesión.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'errcli_tamanos_chk') then
    alter table public.errores_cliente add constraint errcli_tamanos_chk check (
      coalesce(char_length(modulo), 0) <= 120
      and coalesce(char_length(mensaje), 0) <= 1000
      and coalesce(char_length(stack), 0) <= 4000
      and coalesce(char_length(ruta), 0) <= 200
      and coalesce(char_length(version), 0) <= 80
      and coalesce(char_length(user_agent), 0) <= 300
      and coalesce(pg_column_size(extra), 0) <= 4096
    );
  end if;
end $$;

alter table public.errores_cliente enable row level security;

grant insert on public.errores_cliente to authenticated;
grant usage, select on sequence public.errores_cliente_id_seq to authenticated;

-- Escribir: cualquiera con sesión, solo a su propio nombre.
drop policy if exists errcli_ins on public.errores_cliente;
create policy errcli_ins on public.errores_cliente
  for insert to authenticated
  with check (usuario_email = lower(auth_email()));

-- Leer: solo manager (desde el SQL Editor o una pantalla futura).
grant select on public.errores_cliente to authenticated;
drop policy if exists errcli_sel on public.errores_cliente;
create policy errcli_sel on public.errores_cliente
  for select to authenticated
  using (tiene_rol('manager'));

-- Retención: 60 días. 08:40 UTC = 02:40 CDMX.
select cron.unschedule('purgar-errores-cliente')
where exists (select 1 from cron.job where jobname = 'purgar-errores-cliente');

select cron.schedule(
  'purgar-errores-cliente',
  '40 8 * * *',
  $$delete from public.errores_cliente where creado_en < now() - interval '60 days'$$
);


-- ══ PASO 4 — Seguridad ══

-- 4a. La llave pública (rol anon) viaja dentro de la app: cualquiera puede
-- usarla sin iniciar sesión. Las TABLAS ya estaban protegidas por la RLS,
-- pero varias VISTAS (vw_pauta_ruta, vw_revision_ubicaciones…) corren con
-- los permisos de su dueño y se saltan la RLS. La app no consulta NADA sin
-- sesión (el login solo usa Auth), así que anon se queda sin ningún
-- permiso. "all tables" incluye vistas y tablas foráneas.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
-- …y lo que se cree después en el SQL Editor tampoco nace abierto a anon.
alter default privileges for role postgres in schema public
  revoke all on tables from anon;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon;
-- Lo mismo para las FUNCIONES futuras (el bloque 4d solo alcanza a las que
-- ya existen). EXECUTE a PUBLIC es un default GLOBAL de Postgres: por
-- esquema no se puede quitar, por eso la segunda línea no lleva "in schema".
-- authenticated y service_role siguen recibiendo EXECUTE por los defaults
-- de Supabase en public.
alter default privileges for role postgres in schema public
  revoke execute on functions from anon;
alter default privileges for role postgres
  revoke execute on functions from public;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'externo') then
    execute 'revoke all on all tables in schema externo from anon';
  end if;
end $$;

-- 4b. app_config guarda el secreto del push y de la limpieza EN TEXTO
-- PLANO. La app nunca la lee: solo la leen funciones SECURITY DEFINER que
-- corre pg_cron. Queda cerrada para anon y para cualquier sesión.
do $$
begin
  if to_regclass('public.app_config') is not null then
    execute 'alter table public.app_config enable row level security';
    execute 'revoke all on public.app_config from anon, authenticated';
  end if;
end $$;

-- 4c. pauta_monitoreo se podía escribir directo por la API con solo tener
-- sesión: un PATCH a fecha_comprobacion y cualquiera "comprobaba" su propia
-- toma, saltándose que eso es del coordinador. La app NUNCA escribe esa
-- tabla directo: todo pasa por registrar_toma, registrar_comprobacion y
-- rechazar_toma, que son SECURITY DEFINER y no dependen de estas políticas.
-- La lectura (pmon_sel) se queda igual.
drop policy if exists pmon_ins on public.pauta_monitoreo;
drop policy if exists pmon_upd on public.pauta_monitoreo;

-- 4d. Las funciones SECURITY DEFINER (las RPC que se saltan la RLS a
-- propósito) nacen ejecutables por PUBLIC, y por lo tanto por anon: el
-- revoke de 4a no las alcanza. Se dejan solo para sesiones reales
-- (authenticated) y el servidor (service_role). Quitarle EXECUTE a PUBLIC
-- no afecta a los triggers (el permiso se revisa al crear el trigger, no al
-- dispararlo) ni a pg_cron (corre como el dueño). No hay hooks de Auth.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as firma
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prokind = 'f'
  loop
    execute format('grant execute on function %s to authenticated, service_role', f.firma);
    execute format('revoke execute on function %s from public, anon', f.firma);
  end loop;
end $$;


-- ══ PASO 5 — Baja real de usuarios ══
-- Antes, "Eliminar" solo borraba la fila de `usuarios`: la cuenta de
-- Supabase Auth y su sesión seguían vivas, y un exempleado podía seguir
-- leyendo por la API todo lo abierto a "cualquiera con sesión".
--
-- Ahora, en una sola llamada y solo para managers: quita sus roles y su
-- ficha, desactiva su push, BLOQUEA su cuenta de Auth (banned_until) y
-- cierra sus sesiones. El bloqueo impide renovar la sesión, así que a más
-- tardar al vencer su token actual (~1 h) queda fuera.
--
-- Si Supabase no deja tocar auth.users desde aquí, la función NO falla:
-- devuelve acceso_bloqueado=false con el motivo, y la app le dice al
-- manager que termine la baja en Authentication → Users.
create or replace function public.dar_baja_usuario(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email     text := lower(trim(coalesce(p_email, '')));
  v_roles     int := 0;
  v_push      int := 0;
  v_uid       uuid;
  v_bloqueado boolean := false;
  v_detalle   text;
begin
  if not tiene_rol('manager') then
    raise exception 'Solo un manager puede dar de baja usuarios.';
  end if;
  if v_email = '' then
    raise exception 'Falta el correo.';
  end if;
  if v_email = lower(coalesce(auth_email(), '')) then
    raise exception 'No puedes darte de baja a ti mismo.';
  end if;

  delete from usuario_roles where lower(usuario_email) = v_email;
  get diagnostics v_roles = row_count;

  update push_suscripciones
     set invalida = true
   where lower(usuario_email) = v_email and not invalida;
  get diagnostics v_push = row_count;

  -- Sus rutas de monitoreo quedan libres: si no, la ruta seguía viéndose
  -- "cubierta" por alguien que ya no está.
  delete from ruta_asignaciones where lower(usuario_email) = v_email;

  delete from usuarios where lower(email) = v_email;

  -- Bloqueo de la cuenta de Auth, en su propio bloque: si falla, lo de
  -- arriba ya quedó hecho y se informa el motivo.
  begin
    select id into v_uid from auth.users where lower(email) = v_email;
    if v_uid is null then
      v_bloqueado := true;
      v_detalle := 'no tenía cuenta de acceso';
    else
      -- Fecha lejana y no 'infinity': el servicio de Auth la lee como
      -- fecha normal y 'infinity' puede romperle el listado de usuarios.
      update auth.users
         set banned_until = now() + interval '100 years'
       where id = v_uid;
      v_bloqueado := found;
    end if;
  exception when others then
    v_detalle := sqlerrm;
  end;

  -- Cerrar sesiones abiertas (sus refresh tokens caen en cascada). Es un
  -- extra: con el bloqueo basta para que no pueda renovar.
  if v_uid is not null and v_bloqueado then
    begin
      delete from auth.sessions where user_id = v_uid;
    exception when others then
      null;
    end;
  end if;

  return jsonb_build_object(
    'roles_quitados', v_roles,
    'push_desactivado', v_push,
    'acceso_bloqueado', v_bloqueado,
    'detalle', v_detalle
  );
end $$;

revoke all on function public.dar_baja_usuario(text) from public, anon;
grant execute on function public.dar_baja_usuario(text) to authenticated;

-- La reversa: volver a dar de alta el correo en Usuarios y roles llama a
-- esta función. Sin ella, un recontratado seguía bloqueado 100 años y el
-- panel de Supabase no tiene botón para quitar un bloqueo.
create or replace function public.reactivar_usuario(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_ok      boolean := false;
  v_detalle text;
begin
  if not tiene_rol('manager') then
    raise exception 'Solo un manager puede reactivar usuarios.';
  end if;
  begin
    update auth.users
       set banned_until = null
     where lower(email) = v_email
       and banned_until is not null
       and banned_until > now();
    v_ok := found;
  exception when others then
    v_detalle := sqlerrm;
  end;
  -- Su push vuelve a valer: si entra desde el mismo celular, el navegador
  -- ve la suscripción "activa" y nunca la re-registra, así que se quedaba
  -- sin avisos. Si ya no sirve, enviar-push la invalida sola (404/410).
  if v_ok then
    update push_suscripciones
       set invalida = false
     where lower(usuario_email) = v_email and invalida;
  end if;
  return jsonb_build_object('reactivado', v_ok, 'detalle', v_detalle);
end $$;

revoke all on function public.reactivar_usuario(text) from public, anon;
grant execute on function public.reactivar_usuario(text) to authenticated;


-- ══ PASO 6 — Verificar ══
-- UNA sola consulta a propósito: el SQL Editor solo enseña el resultado de
-- la ÚLTIMA sentencia, y verificaciones sueltas se perdían sin verse.
-- Lo esperado:
--   anon_permisos_tablas = 0 y anon_puede_ejecutar = [] (4a y 4d)
--   politicas_pauta_monitoreo = solo pmon_sel (4c)
--   tareas = incluye purgar-notificaciones y purgar-errores-cliente
--   indices = los del PASO 1 (si ves dos sobre lo mismo, uno sobra)
--   cuentas_vivas_sin_ficha = personas "eliminadas" con el botón anterior
--     (que no tocaba su cuenta) y que siguen pudiendo usar la API. OJO:
--     también salen altas recientes que aún no tienen rol. Para cada
--     exempleado, corre aparte (seleccionando solo esa línea):
--       update auth.users set banned_until = now() + interval '100 years'
--        where lower(email) = 'correo.del.exempleado@gpovallas.com';
select jsonb_build_object(
  'anon_permisos_tablas',
    (select count(*) from information_schema.role_table_grants
      where grantee = 'anon' and table_schema = 'public'),
  'anon_puede_ejecutar',
    (select coalesce(jsonb_agg(p.oid::regprocedure::text), '[]'::jsonb)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and has_function_privilege('anon', p.oid, 'execute')),
  'politicas_pauta_monitoreo',
    (select coalesce(jsonb_agg(policyname || ' (' || cmd || ')'), '[]'::jsonb)
       from pg_policies
      where schemaname = 'public' and tablename = 'pauta_monitoreo'),
  'tareas',
    (select coalesce(jsonb_agg(jobname || ' ' || schedule || case when active then '' else ' (INACTIVA)' end order by jobname), '[]'::jsonb)
       from cron.job),
  'indices',
    (select coalesce(jsonb_agg(tablename || '.' || indexname order by tablename, indexname), '[]'::jsonb)
       from pg_indexes
      where schemaname = 'public'
        and tablename in ('notificaciones', 'incidencias', 'evidencias', 'mensajes',
                          'reasignaciones', 'usuario_roles', 'errores_cliente')),
  'cuentas_vivas_sin_ficha',
    (select coalesce(jsonb_agg(jsonb_build_object(
              'email', u.email,
              'ultimo_acceso', u.last_sign_in_at)
            order by u.last_sign_in_at desc nulls last), '[]'::jsonb)
       from auth.users u
      where (u.banned_until is null or u.banned_until < now())
        and not exists (select 1 from public.usuarios x
                         where lower(x.email) = lower(u.email))
        and not exists (select 1 from public.usuario_roles r
                         where lower(r.usuario_email) = lower(u.email)))
) as verificacion;
