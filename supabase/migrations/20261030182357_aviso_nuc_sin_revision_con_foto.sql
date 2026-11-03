-- ============================================================
-- Aviso NUC sin «En revisión» y con foto al ponerlo en línea
-- (Erik, 30-oct-2026)
--
-- Todo el flujo lo hace una sola área (Digital), así que el paso «Estoy
-- revisándolo» sobra: el aviso queda en dos estados, Fuera de línea y En
-- línea. Para ponerlo en línea Digital elige UNA de tres respuestas (ya no
-- hay nota libre) y adjunta UNA foto obligatoria, que el tablero enseña solo
-- con «Ver imagen».
--
--   1. Los avisos en revisión regresan a fuera de línea; se conserva quién
--      lo tomó y el evento «tomado» del historial.
--   2. nuc_avisos solo acepta fuera_linea / en_linea. Los eventos conservan
--      en_revision y tomado: son historia.
--   3. Se quita nuc_aviso_tomar.
--   4. Columna foto_cierre (ruta en el bucket evidencias, nuc/<id>/…).
--   5. nuc_aviso_en_linea(p_id, p_respuesta, p_foto): respuesta de la lista
--      y foto que exista en storage, subida por quien cierra, en la carpeta
--      del aviso.
--   6. ev_obj_del: las fotos de nuc/ solo las borra quien las subió o el
--      manager, como las de maquinas/, y nunca la que ya cerró un aviso
--      (nuc_foto_en_uso, como comp_objeto_en_uso).
--
-- ORDEN (revisor-rls): aplicar justo antes de publicar el frontend que
-- llama nuc_aviso_en_linea(p_id, p_respuesta, p_foto); la app vieja deja
-- de poder cerrar avisos en cuanto esto entra.
-- ============================================================

-- Que nadie con la app vieja tome un aviso entre el UPDATE y el CHECK.
lock table public.nuc_avisos in share row exclusive mode;

-- 1. Los dos avisos en revisión al 30-oct-2026 vuelven a fuera de línea.
--    «Desde hace cuánto» cuenta desde que se abrió.
update public.nuc_avisos
   set estado = 'fuera_linea', actualizado_en = abierto_en
 where estado = 'en_revision';

-- 2. Solo dos estados en el aviso.
alter table public.nuc_avisos drop constraint nuc_avisos_estado_check;
alter table public.nuc_avisos
  add constraint nuc_avisos_estado_check check (estado in ('fuera_linea', 'en_linea'));

-- 3. Sin «Estoy revisándolo».
drop function if exists public.nuc_aviso_tomar(bigint);

-- 4. La foto del cierre: una ruta del bucket, en la carpeta del aviso.
alter table public.nuc_avisos add column foto_cierre text;
alter table public.nuc_avisos
  add constraint nuc_avisos_foto_cierre_check
  check (foto_cierre is null or foto_cierre ~ ('^nuc/' || id || '/[A-Za-z0-9._-]+$'));

-- 5. Poner en línea: respuesta de la lista + foto obligatoria.
drop function if exists public.nuc_aviso_en_linea(bigint, text);
create function public.nuc_aviso_en_linea(p_id bigint, p_respuesta text, p_foto text)
returns void
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_yo text := lower(auth_email());
  v_a nuc_avisos%rowtype;
  v_resp text := trim(coalesce(p_respuesta, ''));
  v_foto text := trim(coalesce(p_foto, ''));
begin
  if v_yo is null or not nuc_es_digital() then
    raise exception 'Solo Digital puede poner el NUC en línea.' using errcode = '42501';
  end if;
  -- Las mismas tres de la pantalla (RESPUESTAS_DIGITAL en src/lib/avisoNuc.ts).
  if v_resp not in ('Se reinició el NUC', 'Se restableció la red', 'VPN apagada') then
    raise exception 'Elige qué se hizo: Se reinició el NUC, Se restableció la red o VPN apagada.'
      using errcode = '22023';
  end if;
  if v_foto !~ ('^nuc/' || p_id || '/[A-Za-z0-9._-]+$') then
    raise exception 'Falta la foto.' using errcode = '22023';
  end if;
  -- La foto tiene que estar subida, y por quien cierra el aviso.
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'evidencias' and o.name = v_foto and o.owner_id = (auth.uid())::text
       and o.metadata->>'mimetype' like 'image/%'
  ) then
    raise exception 'La foto no se subió. Vuelve a intentarlo.' using errcode = '22023';
  end if;

  select * into v_a from nuc_avisos where id = p_id for update;
  if v_a.id is null then
    raise exception 'El aviso ya no existe.';
  end if;
  if v_a.estado = 'en_linea' then
    raise exception 'Este aviso ya está cerrado.';
  end if;

  update nuc_avisos
     set estado = 'en_linea', cerrado_por = v_yo, cerrado_en = now(), nota_cierre = v_resp,
         foto_cierre = v_foto, actualizado_en = now()
   where id = p_id;
  insert into nuc_avisos_eventos(aviso_id, accion, estado, por, nota)
  values (p_id, 'en_linea', 'en_linea', v_yo, v_resp);

  -- El aviso dice la clave del mueble, no el nombre (Erik, 29-oct-2026).
  perform nuc_avisar_tecnicos(
    v_a.unidad_negocio, 'nuc_en_linea',
    'El NUC de ' || v_a.site_id || ' ya está en línea: ' || v_resp || '.');
end;
$function$;

revoke all on function public.nuc_aviso_en_linea(bigint, text, text) from public, anon;
grant execute on function public.nuc_aviso_en_linea(bigint, text, text) to authenticated;

-- 6. La foto que ya cerró un aviso no se borra (ni quien la subió).
create or replace function public.nuc_foto_en_uso(p_name text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from nuc_avisos a where a.foto_cierre = p_name)
$$;
revoke all on function public.nuc_foto_en_uso(text) from public, anon;
grant execute on function public.nuc_foto_en_uso(text) to authenticated, service_role;

--    ev_obj_del copiada de producción (pg_policies, 30-oct-2026); el CAMBIO
--    es la última condición.
drop policy if exists ev_obj_del on storage.objects;
create policy ev_obj_del on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'evidencias'
    and name !~~ 'comp/%'
    and name !~~ 'comp-analista/%'
    and (name !~~ 'pauta-analista/%' or owner_id = (auth.uid())::text or tiene_rol('manager'::app_role))
    and (name !~~ 'maquinas/%' or owner_id = (auth.uid())::text or tiene_rol('manager'::app_role))
    -- CAMBIO (Aviso NUC con foto, 30-oct-2026)
    and (name !~~ 'nuc/%'
         or ((owner_id = (auth.uid())::text or tiene_rol('manager'::app_role)) and not nuc_foto_en_uso(name)))
  );

-- ══ Verificación (solo lectura) ══
-- select estado, count(*) from nuc_avisos group by estado;            -- sin en_revision
-- select proname from pg_proc where proname like 'nuc_aviso_%';       -- sin tomar
-- select pg_get_function_arguments('public.nuc_aviso_en_linea'::regproc);
