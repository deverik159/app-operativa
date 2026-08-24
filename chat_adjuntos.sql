-- ============================================================
-- chat_adjuntos.sql
-- Adjuntos del chat de incidencias, con borrado automático al cerrar.
--
-- LA IDEA: el chat guarda su historial de texto PARA SIEMPRE. Los archivos
-- —fotos y videos cortos— viven solo mientras la incidencia está abierta.
-- Al cerrarse, un proceso diario los borra de Storage y deja el mensaje con
-- una marca de "archivo eliminado". La conversación se entiende igual; lo
-- que se va es el peso.
--
-- POR QUÉ NO SE BORRA CON UN TRIGGER AL CERRAR: borrar de Supabase Storage
-- requiere pasar por su API. Borrar la fila de `storage.objects` deja el
-- archivo huérfano ocupando espacio — que es exactamente lo que queremos
-- evitar. Por eso el borrado real lo hace una Edge Function, igual que el
-- push, y `pg_cron` la despierta una vez al día.
--
-- REQUISITO: correr DESPUÉS de push_1_base.sql, porque reutiliza la tabla
-- `app_config` y su secreto.
-- ============================================================


-- ------------------------------------------------------------
-- 1. La tabla
-- ------------------------------------------------------------
-- Tabla aparte y no una columna en `mensajes`, por dos razones: un mensaje
-- puede llevar varios archivos, y purgar es un `update` sobre esta tabla sin
-- tocar el historial de conversación.
create table if not exists chat_adjuntos (
  id           bigserial primary key,
  record_id    text not null,
  -- A qué mensaje pertenece. Si el mensaje se borra, el adjunto se va con él.
  mensaje_id   bigint not null references mensajes(id) on delete cascade,

  tipo         text not null check (tipo in ('foto', 'video')),
  url          text not null,
  -- `path` es lo que necesita la API de Storage para borrar. Sin esto no se
  -- puede purgar: la URL pública no sirve para eliminar.
  path         text not null,
  nombre       text,
  bytes        bigint,

  subido_por   text not null,
  creado_en    timestamptz not null default now(),

  -- Cuándo se borró el archivo de Storage. La FILA se queda: es lo que
  -- permite mostrar "📎 archivo eliminado" en vez de un hueco silencioso.
  purgado_en   timestamptz
);

create index if not exists chat_adj_record_idx on chat_adjuntos (record_id);
create index if not exists chat_adj_mensaje_idx on chat_adjuntos (mensaje_id);
-- Índice del purgador: solo le interesan los que aún tienen archivo.
create index if not exists chat_adj_pendientes_idx
  on chat_adjuntos (creado_en) where purgado_en is null;


-- ------------------------------------------------------------
-- 2. RLS
-- ------------------------------------------------------------
alter table chat_adjuntos enable row level security;

-- Lectura: igual que `mensajes` — quien tiene sesión ve el hilo.
drop policy if exists chat_adj_sel on chat_adjuntos;
create policy chat_adj_sel on chat_adjuntos for select to authenticated
  using (auth_email() is not null);

-- Escritura: solo sobre mensajes propios, y solo si la incidencia sigue
-- abierta. Sin la segunda condición se podrían colgar archivos de un hilo ya
-- cerrado, que el purgador borraría al día siguiente — basura con fecha de
-- caducidad inmediata.
drop policy if exists chat_adj_ins on chat_adjuntos;
create policy chat_adj_ins on chat_adjuntos for insert to authenticated
  with check (
    lower(subido_por) = lower(auth_email())
    and exists (
      select 1 from mensajes m
      where m.id = chat_adjuntos.mensaje_id
        and lower(m.autor_email) = lower(auth_email())
    )
    and exists (
      select 1 from incidencias i
      where i.record_id = chat_adjuntos.record_id
        and i.estatus <> 'cerrada'
    )
  );

-- Borrar a mano: el autor mientras esté abierta, o coordinación siempre.
drop policy if exists chat_adj_del on chat_adjuntos;
create policy chat_adj_del on chat_adjuntos for delete to authenticated
  using (
    lower(subido_por) = lower(auth_email())
    or tiene_rol('coordinador'::app_role)
    or tiene_rol('manager'::app_role)
  );

revoke all on chat_adjuntos from anon;


-- ------------------------------------------------------------
-- 3. Qué está listo para purgar
-- ------------------------------------------------------------
-- Vista que usa la Edge Function. Tener el criterio aquí y no dentro del
-- código de la función permite ajustarlo sin volver a desplegar nada.
--
-- DOS CRITERIOS, y el segundo es una válvula de seguridad:
--
--   a) La incidencia está cerrada. Es lo que pediste.
--
--   b) El archivo tiene más de 60 días, esté cerrada o no. Sin esto, una
--      incidencia que nadie cierra guarda archivos para siempre — y en un
--      sistema real siempre hay incidencias olvidadas. 60 días es holgado:
--      si algo lleva dos meses abierto, el video de aquel día ya no es lo
--      que va a resolverlo.
--
-- LOS DOS DÍAS DE GRACIA SE MIDEN DESDE EL ARCHIVO, NO DESDE EL CIERRE.
--
-- La razón es que `incidencias` NO guarda cuándo se cerró: sus columnas de
-- fecha son `fecha_reporte`, `asignado_en`, `fecha_reparacion` y `creado_en`.
-- No hay `fecha_cierre`.
--
-- Medir desde el archivo da un comportamiento ligeramente distinto pero
-- razonable: un archivo subido hoy sobrevive dos días aunque la incidencia
-- cierre en la tarde; uno de hace un mes se purga en la siguiente corrida
-- después del cierre. Que es justo lo que se quiere — lo viejo ya no le
-- sirve a nadie.
--
-- Si algún día hace falta la fecha real de cierre (para reportes de SLA, por
-- ejemplo), se agrega la columna y se cambia esta vista. Por eso el criterio
-- vive aquí y no dentro del código de la Edge Function.
create or replace view vw_chat_adjuntos_purgables as
select a.id,
       a.record_id,
       a.path,
       a.creado_en,
       i.estatus,
       case
         when i.estatus = 'cerrada' then 'incidencia cerrada'
         else 'más de 60 días'
       end as motivo
from chat_adjuntos a
join incidencias i on i.record_id = a.record_id
where a.purgado_en is null
  and (
    (i.estatus = 'cerrada' and a.creado_en < now() - interval '2 days')
    or a.creado_en < now() - interval '60 days'
  );

revoke all on vw_chat_adjuntos_purgables from anon;
grant select on vw_chat_adjuntos_purgables to authenticated;


-- ------------------------------------------------------------
-- 4. Disparador diario
-- ------------------------------------------------------------
-- Reutiliza `app_config` y el MISMO secreto que el push. Es a propósito:
-- cada secreto nuevo es otra oportunidad de que no coincida y pasarse una
-- noche persiguiendo un 401. Un solo secreto compartido entre las funciones
-- internas del proyecto, bien guardado, es más seguro en la práctica que
-- tres mal configurados.
insert into app_config (clave, valor, nota)
values (
  'limpieza_url',
  'PEGA-AQUI-LA-URL-DEL-PANEL',
  'URL de la Edge Function limpiar-chat. Copiada del panel de Supabase, no deducida.'
)
on conflict (clave) do update
  set valor = excluded.valor, actualizado_en = now();


create or replace function public.disparar_limpieza_chat()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_url    text;
  v_secret text;
  v_auth   text;
  v_n      int;
begin
  select count(*) into v_n from vw_chat_adjuntos_purgables;
  if v_n = 0 then
    raise notice '[limpieza] nada que purgar';
    return;
  end if;

  select valor into v_url    from app_config where clave = 'limpieza_url';
  select valor into v_secret from app_config where clave = 'push_secret';
  select valor into v_auth   from app_config where clave = 'push_auth';

  if v_url is null or v_url like 'PEGA-AQUI%' then
    raise warning '[limpieza] limpieza_url sin configurar; % archivos esperando', v_n;
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
$$;

revoke execute on function public.disparar_limpieza_chat() from anon, public;


-- Una vez al día, 9:00 UTC = 3:00 a.m. en CDMX. A esa hora no hay nadie en
-- campo, así que nadie ve desaparecer un archivo mientras lo está mirando.
create extension if not exists pg_cron;

select cron.unschedule('limpiar-chat-diario')
where exists (select 1 from cron.job where jobname = 'limpiar-chat-diario');

select cron.schedule(
  'limpiar-chat-diario',
  '0 9 * * *',
  $$ select public.disparar_limpieza_chat(); $$
);


-- ------------------------------------------------------------
-- 5. Verificación
-- ------------------------------------------------------------
select jobname, schedule, active from cron.job where jobname = 'limpiar-chat-diario';

select clave,
       case when valor like 'PEGA-AQUI%' then '⚠️ PENDIENTE' else 'listo' end as estado
from app_config where clave in ('limpieza_url', 'push_secret', 'push_auth')
order by clave;

-- Cuántos archivos hay y cuántos esperan turno.
select count(*) filter (where purgado_en is null) as vivos,
       count(*) filter (where purgado_en is not null) as ya_purgados,
       pg_size_pretty(coalesce(sum(bytes) filter (where purgado_en is null), 0)) as peso_vivo
from chat_adjuntos;

select * from vw_chat_adjuntos_purgables limit 20;

-- Para probar sin esperar al cron:
--   select public.disparar_limpieza_chat();
-- y luego revisar la respuesta:
--   select status_code, left(content,300), created
--   from net._http_response order by created desc limit 5;
