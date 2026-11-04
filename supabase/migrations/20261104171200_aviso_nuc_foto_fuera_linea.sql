-- ============================================================
-- Aviso NUC: foto obligatoria también al marcarlo fuera de línea
-- (Erik, 4-nov-2026 · sección Biobox)
--
-- Igual que al ponerlo en línea, Digital adjunta UNA foto obligatoria al
-- marcar el NUC fuera de línea. La nota sigue siendo libre y opcional. El
-- tablero no pinta la foto: solo «Ver imagen».
--
-- El aviso todavía no existe cuando se sube la foto, así que va en su propia
-- carpeta: nuc/fuera/<archivo>.
--
--   1. Columna foto_abierto (ruta en el bucket evidencias), con su formato y
--      sin repetirse entre avisos. Los avisos abiertos antes de esto se
--      quedan sin foto.
--   2. nuc_aviso_abrir(p_site_id, p_nota, p_foto): la foto debe existir en
--      storage, ser imagen y haberla subido quien marca el aviso.
--   3. nuc_foto_en_uso también protege la foto de fuera de línea: ev_obj_del
--      ya la usa para nuc/, así que la política no cambia.
--
-- ORDEN: aplicar justo antes de publicar el frontend que llama
-- nuc_aviso_abrir con p_foto; la app vieja deja de poder marcar fuera de
-- línea en cuanto esto entra (cerrar avisos sigue igual).
-- ============================================================

-- 1. La foto de cuando se marcó fuera de línea.
alter table public.nuc_avisos add column if not exists foto_abierto text;
alter table public.nuc_avisos drop constraint if exists nuc_avisos_foto_abierto_check;
alter table public.nuc_avisos
  add constraint nuc_avisos_foto_abierto_check
  check (foto_abierto is null or foto_abierto ~ '^nuc/fuera/[A-Za-z0-9._-]+$');
create unique index if not exists nuc_avisos_foto_abierto_uniq
  on public.nuc_avisos (foto_abierto) where foto_abierto is not null;

-- 2. Marcar fuera de línea: nota opcional + foto obligatoria.
--    Cuerpo copiado de producción (md5 a94a7f6a…, 4-nov-2026); lo nuevo va
--    marcado con CAMBIO.
drop function if exists public.nuc_aviso_abrir(text, text);
drop function if exists public.nuc_aviso_abrir(text, text, text);
create function public.nuc_aviso_abrir(p_site_id text, p_nota text, p_foto text)
returns bigint
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_yo text := lower(auth_email());
  v_inv record;
  v_id bigint;
  v_nota text := nullif(left(trim(coalesce(p_nota, '')), 500), '');
  v_foto text := trim(coalesce(p_foto, ''));
  v_choque text;
begin
  if v_yo is null or not nuc_es_digital() then
    raise exception 'Solo Digital puede marcar un NUC fuera de línea.' using errcode = '42501';
  end if;
  -- CAMBIO (4-nov-2026): la foto es obligatoria, subida por quien marca.
  if v_foto !~ '^nuc/fuera/[A-Za-z0-9._-]+$' then
    raise exception 'Falta la foto.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'evidencias' and o.name = v_foto and o.owner_id = ((select auth.uid()))::text
       and o.metadata->>'mimetype' like 'image/%'
  ) then
    raise exception 'La foto no se subió. Vuelve a intentarlo.' using errcode = '22023';
  end if;
  if exists (select 1 from nuc_avisos a where a.foto_abierto = v_foto or a.foto_cierre = v_foto) then
    raise exception 'Esa foto ya es de otro aviso.' using errcode = '22023';
  end if;

  -- La máquina debe existir en el inventario de una unidad Biobox. Se
  -- prefiere la cara digital para el nombre visible.
  select i.site_id, i.unidad_negocio, coalesce(i.site_legacy_id, i.site_id) as maquina
    into v_inv
    from inventario i
   where i.site_id = p_site_id
     and (i.unidad_negocio ilike 'biobox' or i.unidad_negocio ilike 'biobox perú')
   order by (i.tipo_medio = 'Digital') desc nulls last, i.vendor_face_id
   limit 1;
  if not found then
    raise exception 'La máquina % no está en el inventario de Biobox.', p_site_id;
  end if;
  if exists (select 1 from nuc_avisos a where a.site_id = p_site_id and a.estado <> 'en_linea') then
    raise exception 'Esta máquina ya tiene un aviso abierto.' using errcode = '23505';
  end if;

  -- Dos personas a la vez: el índice único detiene a la segunda.
  begin
    insert into nuc_avisos(site_id, unidad_negocio, maquina, nota_digital, abierto_por, foto_abierto)
    values (v_inv.site_id, v_inv.unidad_negocio, v_inv.maquina, v_nota, v_yo, v_foto)
    returning id into v_id;
  exception when unique_violation then
    -- CAMBIO (4-nov-2026): el choque puede ser de la foto (doble toque).
    get stacked diagnostics v_choque = constraint_name;
    if v_choque = 'nuc_avisos_foto_abierto_uniq' then
      raise exception 'Esa foto ya es de otro aviso.' using errcode = '23505';
    end if;
    raise exception 'Esta máquina ya tiene un aviso abierto.' using errcode = '23505';
  end;

  insert into nuc_avisos_eventos(aviso_id, accion, estado, por, nota)
  values (v_id, 'abierto', 'fuera_linea', v_yo, v_nota);

  -- El aviso dice la clave del mueble, no el nombre (Erik, 29-oct-2026).
  perform nuc_avisar_tecnicos(
    v_inv.unidad_negocio, 'nuc_fuera_linea',
    'NUC fuera de línea en ' || v_inv.site_id || coalesce(': ' || v_nota, '') ||
    '. Digital lo atiende a distancia y te avisa cuando vuelva a estar en línea.');
  return v_id;
end;
$function$;

revoke all on function public.nuc_aviso_abrir(text, text, text) from public, anon;
grant execute on function public.nuc_aviso_abrir(text, text, text) to authenticated;

-- 3. La foto que ya abrió o cerró un aviso no se borra (ni quien la subió).
create or replace function public.nuc_foto_en_uso(p_name text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from nuc_avisos a where a.foto_cierre = p_name or a.foto_abierto = p_name)
$$;
revoke all on function public.nuc_foto_en_uso(text) from public, anon;
grant execute on function public.nuc_foto_en_uso(text) to authenticated, service_role;

-- ══ Verificación (solo lectura) ══
-- select pg_get_function_arguments('public.nuc_aviso_abrir'::regproc);   -- p_site_id text, p_nota text, p_foto text
-- select column_name from information_schema.columns where table_name = 'nuc_avisos' and column_name = 'foto_abierto';
