-- ============================================================
-- aviso_nuc_clave_en_aviso — 30-oct-2026 · Biobox (módulo Aviso NUC)
--
-- Qué cambia: el texto de los avisos de NUC (fuera de línea y en línea)
-- dice la clave del mueble (site_id, p. ej. MX_CM_BB_MED_0087) en vez del
-- nombre de la máquina («INSURGENTES Y LA PAZ»). Erik, 29-oct-2026: «el
-- técnico debe adaptarse a la nomenclatura del mueble».
--
-- Solo cambia el mensaje. Todo lo demás de nuc_aviso_abrir y
-- nuc_aviso_en_linea queda como en 20261030010610_aviso_nuc_digital_repara
-- (comparado con producción por md5 antes de escribir esto). La columna
-- nuc_avisos.maquina se sigue llenando: el tablero la enseña.
--
-- Re-ejecutable.
-- ============================================================

create or replace function public.nuc_aviso_abrir(p_site_id text, p_nota text default null)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_yo text := lower(auth_email());
  v_inv record;
  v_id bigint;
  v_nota text := nullif(left(trim(coalesce(p_nota, '')), 500), '');
begin
  if v_yo is null or not nuc_es_digital() then
    raise exception 'Solo Digital puede marcar un NUC fuera de línea.' using errcode = '42501';
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
    insert into nuc_avisos(site_id, unidad_negocio, maquina, nota_digital, abierto_por)
    values (v_inv.site_id, v_inv.unidad_negocio, v_inv.maquina, v_nota, v_yo)
    returning id into v_id;
  exception when unique_violation then
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

create or replace function public.nuc_aviso_en_linea(p_id bigint, p_nota text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_yo text := lower(auth_email());
  v_a nuc_avisos%rowtype;
  v_nota text := nullif(left(trim(coalesce(p_nota, '')), 500), '');
begin
  if v_yo is null or not nuc_es_digital() then
    raise exception 'Solo Digital puede poner el NUC en línea.' using errcode = '42501';
  end if;
  select * into v_a from nuc_avisos where id = p_id for update;
  if v_a.id is null then
    raise exception 'El aviso ya no existe.';
  end if;
  if v_a.estado = 'en_linea' then
    raise exception 'Este aviso ya está cerrado.';
  end if;

  update nuc_avisos
     set estado = 'en_linea', cerrado_por = v_yo, cerrado_en = now(), nota_cierre = v_nota,
         actualizado_en = now()
   where id = p_id;
  insert into nuc_avisos_eventos(aviso_id, accion, estado, por, nota)
  values (p_id, 'en_linea', 'en_linea', v_yo, v_nota);

  -- El aviso dice la clave del mueble, no el nombre (Erik, 29-oct-2026).
  perform nuc_avisar_tecnicos(
    v_a.unidad_negocio, 'nuc_en_linea',
    'El NUC de ' || v_a.site_id || ' ya está en línea' ||
    coalesce(': ' || v_nota, '') || '.');
end;
$function$;

revoke all on function public.nuc_aviso_abrir(text, text) from public, anon;
revoke all on function public.nuc_aviso_en_linea(bigint, text) from public, anon;
grant execute on function public.nuc_aviso_abrir(text, text) to authenticated;
grant execute on function public.nuc_aviso_en_linea(bigint, text) to authenticated;

-- Verificar: los dos avisos ya usan site_id y los permisos no cambian.
select proname,
       prosrc like '%en '' || v_inv.site_id%' or prosrc like '%de '' || v_a.site_id%' as usa_clave,
       has_function_privilege('authenticated', p.oid, 'execute') as auth,
       has_function_privilege('anon', p.oid, 'execute') as anon
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and proname in ('nuc_aviso_abrir', 'nuc_aviso_en_linea');
