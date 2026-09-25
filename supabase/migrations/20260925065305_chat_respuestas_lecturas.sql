-- ============================================================
-- chat_respuestas_lecturas — el chat de incidencias estilo WhatsApp
-- (Erik, 25-sep-2026): responder a un mensaje concreto, saber quién leyó
-- el chat y cuándo, y medidas de los adjuntos.
--
-- Va ANTES del push de la app: la app manda `responde_a` al insertar una
-- respuesta, `ancho`/`alto` al ligar una foto o video, y registra lecturas
-- con marcar_chat_leido(). (Si el push se adelanta, los mensajes sueltos y
-- los adjuntos siguen funcionando: la app reintenta sin las medidas y el
-- "visto" simplemente no aparece.) Re-ejecutable: "if not exists" /
-- "or replace".
--
-- MODELO: el mensaje que responde guarda el id del original en
-- `responde_a`. La cita (autor + texto) NO se copia: la burbuja la arma
-- con el original, así una edición del original se refleja en la cita.
-- ============================================================

-- `add column … references` toma un candado exclusivo sobre mensajes: si
-- algo lo tiene ocupado (un dump, otra pestaña con un begin abierto), mejor
-- fallar en 5 s y volver a correr que congelar el chat de todos esperando.
set lock_timeout = '5s';

-- 1) La columna. `on delete set null`: los mensajes no se borran desde la
--    app, pero los scripts de limpieza (limpiar_todo.sql y cía.) sí borran
--    en bloque; así no se traban con la referencia.
alter table public.mensajes
  add column if not exists responde_a bigint
    references public.mensajes(id) on delete set null;

-- Índice parcial: solo lo usan los borrados (la llave foránea revisa quién
-- apunta a cada fila borrada). La mayoría de los mensajes no responden a
-- nada y no ocupan lugar aquí.
create index if not exists msg_responde_a_idx
  on public.mensajes (responde_a)
  where responde_a is not null;

-- 2) Permiso de INSERT sobre la columna nueva. Si `authenticated` ya tiene
--    INSERT sobre toda la tabla esto no cambia nada; si el permiso estaba
--    acotado por columnas, sin esta línea enviar daría "permission denied".
grant insert (responde_a) on public.mensajes to authenticated;

-- 3) Solo se responde a un mensaje de LA MISMA incidencia. Una referencia
--    a otro hilo (o a un id que no existe) se descarta en silencio: el
--    mensaje se guarda igual, sin cita, en vez de perderse por un detalle.
--    security definer: la validación no depende de lo que la RLS deje ver.
--    Sin grant execute: una función de trigger no se puede llamar suelta.
create or replace function public.msg_valida_respuesta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.responde_a is not null and not exists (
    select 1 from public.mensajes m
    where m.id = new.responde_a
      and m.record_id = new.record_id
  ) then
    new.responde_a := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_msg_valida_respuesta on public.mensajes;
create trigger trg_msg_valida_respuesta
  before insert on public.mensajes
  for each row execute function public.msg_valida_respuesta();

-- 4) La edición (chat_editar_mensajes.sql) solo cambia el TEXTO: se
--    recrea su trigger para que tampoco se pueda reescribir a qué mensaje
--    se respondía. Idéntico al original salvo por el bloque de responde_a.
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
  -- Ni a qué mensaje responde… salvo el null de la llave foránea: su
  -- `on delete set null` llega como un UPDATE que también pasa por este
  -- trigger, y si se le regresara el id viejo la respuesta quedaría
  -- apuntando a un mensaje borrado (sin revisión posterior: la llave "no
  -- cambió"). Ese UPDATE corre DENTRO del trigger de la llave, así que aquí
  -- la profundidad es 2 o más; un PATCH directo por la API es 1 y no puede
  -- quitar la cita sin dejar rastro.
  if new.responde_a is not null or pg_trigger_depth() < 2 then
    new.responde_a := old.responde_a;
  end if;
  return new;
end $$;

-- 5) Medidas de cada foto/video del chat (mismo bloque de cambios del
--    chat, 25-sep-2026). La burbuja reserva ESA proporción antes de que
--    el archivo cargue: sin ella el hilo brincaba al llegar cada imagen y
--    una caja de proporción fija recortaba o encogía las verticales. Nulas
--    en los adjuntos viejos (se pintan 4:3) — y como el chat purga sus
--    archivos al cerrar la incidencia, esos desaparecen solos.
alter table public.chat_adjuntos
  add column if not exists ancho integer check (ancho > 0),
  add column if not exists alto integer check (alto > 0);

-- 6) Lecturas: quién vio el chat de cada incidencia, hasta qué mensaje y
--    cuándo fue la última vez. Una fila por persona y chat (no por
--    mensaje): alcanza para el ✓✓ de cada mensaje propio (visto si
--    ultimo_id >= su id; los ids crecen en orden) y para "visto hace 5
--    min", sin multiplicar filas por cada mensaje de cada hilo.
create table if not exists public.chat_lecturas (
  record_id      text not null,
  usuario_email  text not null,
  usuario_nombre text,
  -- El mensaje más reciente que esa persona tuvo a la vista.
  ultimo_id      bigint not null,
  -- La última vez que abrió o siguió el chat.
  visto_en       timestamptz not null default now(),
  primary key (record_id, usuario_email)
);

alter table public.chat_lecturas enable row level security;

-- Lectura: igual que `mensajes` — quien tiene sesión ve el hilo.
drop policy if exists chat_lect_sel on public.chat_lecturas;
create policy chat_lect_sel on public.chat_lecturas
  for select to authenticated
  using (auth_email() is not null);

-- Escritura: NINGUNA política de insert/update a propósito. Solo se
-- escribe con marcar_chat_leido(), que toma el correo de la sesión: nadie
-- puede marcar "visto" a nombre de otro.
revoke all on public.chat_lecturas from anon;

create or replace function public.marcar_chat_leido(
  p_record_id text,
  p_ultimo_id bigint,
  p_nombre text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth_email());
begin
  if v_email is null or p_record_id is null or p_ultimo_id is null then
    return;
  end if;
  -- Solo ids reales de ese hilo: no se puede "adelantar" la lectura.
  if not exists (
    select 1 from public.mensajes
    where id = p_ultimo_id and record_id = p_record_id
  ) then
    return;
  end if;
  insert into public.chat_lecturas
    (record_id, usuario_email, usuario_nombre, ultimo_id, visto_en)
  values (p_record_id, v_email, p_nombre, p_ultimo_id, now())
  on conflict (record_id, usuario_email) do update
    -- greatest: una pestaña vieja que marca tarde no regresa la lectura.
    set ultimo_id = greatest(public.chat_lecturas.ultimo_id, excluded.ultimo_id),
        visto_en = now(),
        usuario_nombre = coalesce(excluded.usuario_nombre,
                                  public.chat_lecturas.usuario_nombre);
end $$;

-- Regla del README: EXECUTE explícito (a PUBLIC ya no se le da por omisión).
revoke all on function public.marcar_chat_leido(text, bigint, text) from public, anon;
grant execute on function public.marcar_chat_leido(text, bigint, text) to authenticated;

-- El ✓✓ se pinta en vivo: la tabla entra a la publicación de Realtime.
-- (En un bloque, porque "add table" truena si ya estaba.)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'chat_lecturas'
     ) then
    alter publication supabase_realtime add table public.chat_lecturas;
  end if;
end $$;

reset lock_timeout;

-- 7) Verificar (a mano, después de correrla): las columnas, el índice,
--    los dos triggers, la tabla de lecturas en Realtime y la función.
--   select tablename from pg_publication_tables
--   where pubname = 'supabase_realtime' and tablename = 'chat_lecturas';
--   select has_function_privilege('authenticated',
--     'public.marcar_chat_leido(text, bigint, text)', 'execute');
--   select table_name, column_name, data_type from information_schema.columns
--   where table_schema = 'public'
--     and ((table_name = 'mensajes' and column_name = 'responde_a')
--       or (table_name = 'chat_adjuntos' and column_name in ('ancho', 'alto')));
--   select indexname from pg_indexes
--   where schemaname = 'public' and indexname = 'msg_responde_a_idx';
--   select tgname from pg_trigger
--   where tgrelid = 'public.mensajes'::regclass
--     and tgname in ('trg_msg_valida_respuesta', 'trg_msg_marca_edicion');
