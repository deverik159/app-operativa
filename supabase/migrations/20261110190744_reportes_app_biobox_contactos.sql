-- 10-nov-2026 · Contacto del usuario de la app Biobox, SOLO para el Excel
-- (ficha contexto/reportes-app-biobox.md; decisión de Erik del 10-nov-2026).
--
-- Cambia la regla del 9-nov-2026 («sin nombre, teléfono ni correo del usuario
-- final»): el correo y el teléfono sí entran, pero aislados.
--
--   · Viven en una tabla APARTE, `biobox_app_contactos`, con RLS y SIN
--     políticas: nadie la lee directo. No se copian a la incidencia ni a
--     `biobox_app_reportes` (esa la leen también Consulta y los técnicos de
--     TI), así que técnicos, chat y tarjetas no los ven.
--   · Los manda el monitor de la PC en una llamada aparte,
--     `sincronizar_biobox_app_contactos(datos)` (solo la llave de servicio),
--     después de la carga normal de reportes, que no cambia.
--   · La exportación de Incidencias los pide con
--     `contactos_app_biobox(record_ids)`: devuelve contactos SOLO a manager,
--     validador de la unidad del reporte y coordinador (de esa unidad o sin
--     unidad), como pidió Erik. Consulta y técnicos reciben cero filas.
--   · El nombre del usuario sigue sin entrar, ni los de Biobox Perú (en pausa).
--   · Refleja el origen: un reporte que llega SIN contacto borra el que había
--     (el usuario lo quitó en la app Biobox).
--
-- Re-ejecutable.

set local lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────
-- 1) La tabla
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.biobox_app_contactos (
  report_id      bigint primary key
                 references public.biobox_app_reportes (report_id) on delete cascade,
  correo         text,
  telefono       text,
  -- Por dónde prefiere el contacto el usuario (whatsapp / email).
  medio_contacto text,
  actualizado_en timestamptz not null default now()
);

comment on table public.biobox_app_contactos is
  'Correo y teléfono del usuario final de la app Biobox. Solo para la exportación (contactos_app_biobox). Sin lectura directa.';

alter table public.biobox_app_contactos enable row level security;
-- Sin políticas a propósito: solo las funciones de abajo (security definer).
revoke all on public.biobox_app_contactos from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) Carga (la llama el monitor con la llave de servicio)
--    datos: [{reportId, correo, telefono, medio_contacto}]
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.sincronizar_biobox_app_contactos(datos jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_jwt_rol   text;
  n_recibidos int;
  n_guardados int;
  n_borrados  int;
  v_dup       jsonb;
begin
  v_jwt_rol := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if session_user not in ('postgres', 'supabase_admin') and v_jwt_rol <> 'service_role' then
    raise exception 'Solo el proceso de sincronización carga los contactos de la app Biobox.';
  end if;

  -- Se turna con la carga de reportes (la llave foránea mira esa tabla).
  perform pg_advisory_xact_lock(hashtext('biobox_app_reportes'));

  n_recibidos := jsonb_array_length(coalesce(datos, '[]'::jsonb));
  if n_recibidos = 0 then
    raise exception 'ABORTADO: no llegó ningún contacto.';
  end if;
  if n_recibidos > 20000 then
    raise exception 'ABORTADO: llegaron % contactos; el tope es 20,000.', n_recibidos;
  end if;

  drop table if exists pg_temp._bac_entrantes;
  create temp table _bac_entrantes on commit drop as
  select nullif(x ->> 'reportId', '')::bigint                 as rid,
         left(nullif(btrim(x ->> 'correo'), ''), 320)        as correo,
         left(nullif(btrim(x ->> 'telefono'), ''), 40)       as telefono,
         left(nullif(btrim(x ->> 'medio_contacto'), ''), 30) as medio
    from jsonb_array_elements(datos) x;

  if exists (select 1 from _bac_entrantes where rid is null) then
    raise exception 'ABORTADO: hay contactos sin reportId.';
  end if;
  -- Como la carga de reportes: un repetido aborta (no se elige uno al azar).
  select jsonb_agg(rid) into v_dup from (
    select rid from _bac_entrantes group by rid having count(*) > 1 limit 20) d;
  if v_dup is not null then
    raise exception 'ABORTADO: contactos repetidos en la carga: %', v_dup;
  end if;

  -- El usuario quitó su contacto en la app Biobox: aquí también se borra.
  with fuera as (
    delete from biobox_app_contactos c
     using _bac_entrantes e
     where c.report_id = e.rid
       and e.correo is null and e.telefono is null
    returning 1
  )
  select count(*) into n_borrados from fuera;

  with validos as (
    -- Solo de reportes que ya tenemos: un contacto suelto no se guarda.
    select e.* from _bac_entrantes e
     where (e.correo is not null or e.telefono is not null)
       and exists (select 1 from biobox_app_reportes r where r.report_id = e.rid)
  ),
  ins as (
    insert into biobox_app_contactos as c (report_id, correo, telefono, medio_contacto)
    select rid, correo, telefono, medio from validos
    on conflict (report_id) do update
       set correo = excluded.correo,
           telefono = excluded.telefono,
           medio_contacto = excluded.medio_contacto,
           actualizado_en = now()
     where (c.correo, c.telefono, c.medio_contacto)
           is distinct from (excluded.correo, excluded.telefono, excluded.medio_contacto)
    returning 1
  )
  select count(*) into n_guardados from ins;

  return jsonb_build_object(
    'recibidos', n_recibidos,
    'guardados_o_cambiados', n_guardados,
    'borrados', n_borrados,
    'con_contacto', (select count(*) from biobox_app_contactos));
end
$function$;

revoke all on function public.sincronizar_biobox_app_contactos(jsonb) from public, anon, authenticated;
grant execute on function public.sincronizar_biobox_app_contactos(jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) Lectura para la exportación de Incidencias
--    Un renglón por incidencia: si varios reportes se ligaron a la misma,
--    sus contactos van juntos, separados por « / ».
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.contactos_app_biobox(p_record_ids text[])
returns table (record_id text, correo text, telefono text, medio_contacto text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Un error claro y no cero filas en silencio (el Excel saldría sin
  -- contactos sin avisar). La pantalla manda grupos de 1,000.
  if p_record_ids is null then
    raise exception 'contactos_app_biobox: falta la lista de incidencias.';
  end if;
  if cardinality(p_record_ids) > 5000 then
    raise exception 'contactos_app_biobox: máximo 5,000 incidencias por llamada (llegaron %).',
      cardinality(p_record_ids);
  end if;

  return query
  select r.record_id,
         -- Mismo orden (por reporte) en las tres columnas: el correo de un
         -- reporte queda junto a SU teléfono cuando son varios.
         string_agg(coalesce(c.correo, '—'), ' / ' order by c.report_id),
         string_agg(coalesce(c.telefono, '—'), ' / ' order by c.report_id),
         string_agg(coalesce(c.medio_contacto, '—'), ' / ' order by c.report_id)
    from biobox_app_reportes r
    join biobox_app_contactos c on c.report_id = r.report_id
   where r.record_id = any (p_record_ids)
     and (
       (select tiene_rol('manager'::app_role))
       or exists (
         select 1 from usuario_roles ur
          where lower(ur.usuario_email) = lower((select auth_email()))
            and (
              -- Validador DE la unidad del reporte.
              (ur.rol = 'validador'::app_role
               and lower(btrim(ur.unidad_negocio)) = lower(r.unidad_negocio))
              -- Coordinador de esa unidad o sin unidad (= todas).
              or (ur.rol = 'coordinador'::app_role
                  and (nullif(btrim(ur.unidad_negocio), '') is null
                       or lower(btrim(ur.unidad_negocio)) = lower(r.unidad_negocio)))
            )
       )
     )
   group by r.record_id;
end
$function$;

revoke all on function public.contactos_app_biobox(text[]) from public, anon;
grant execute on function public.contactos_app_biobox(text[]) to authenticated;
