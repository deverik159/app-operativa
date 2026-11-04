-- ============================================================
-- Aviso NUC para Ecovallas Digital y Vía Verde
-- (Erik, 4-nov-2026 · sección Aviso NUC)
--
-- El mismo proceso de Biobox (Digital marca fuera de línea y lo pone en
-- línea, con foto) se abre a:
--   · Ecovallas: solo las pantallas digitales (tipo_medio Digital), un
--     aviso por sitio.
--   · Vía Verde: solo columnas y pórticos (el sitio «Pruebas Via Verde»,
--     mueble «Otro», queda fuera).
--
-- Quién recibe el push en Ecovallas y Vía Verde: los coordinadores de la
-- unidad (sin área o de Digital), su validador de Digital o de todos los
-- medios (el de Impreso no, Erik) y los de Digital de la unidad o de todas.
-- En Biobox no cambia nada.
-- Además, en cualquier unidad, las personas que el manager agregue a mano
-- (Erik: «3 correos que son de campo»). Se guardan en nuc_avisos_extra y se
-- agregan desde la app, para que ningún correo quede en el repositorio.
--
--   1. Tabla nuc_avisos_extra (solo lectura por RLS: el manager todo, cada
--      quien su fila) y las funciones nuc_extra_agregar / nuc_extra_quitar,
--      solo del manager; la persona debe tener cuenta en la app.
--   2. nuc_puede_ver: quien está en nuc_avisos_extra de una unidad ve su
--      tablero.
--   3. nuc_avisar_tecnicos: los destinatarios de Ecovallas y Vía Verde, y
--      los agregados a mano.
--   4. nuc_aviso_abrir acepta las pantallas de Ecovallas y las columnas y
--      pórticos de Vía Verde.
--
-- ORDEN: puede ir antes que el frontend: la app de hoy solo enseña Biobox y
-- nada de lo que ya hace cambia.
-- ============================================================

-- 1. Personas agregadas a mano a los avisos de una unidad.
create table if not exists public.nuc_avisos_extra (
  unidad_negocio text not null
    check (unidad_negocio in ('Biobox', 'Biobox Perú', 'Ecovallas', 'Vía Verde')),
  usuario_email text not null check (usuario_email = lower(btrim(usuario_email)) and usuario_email <> ''),
  agregado_por text not null,
  agregado_en timestamptz not null default now(),
  primary key (unidad_negocio, usuario_email)
);
alter table public.nuc_avisos_extra enable row level security;
revoke all on table public.nuc_avisos_extra from public, anon, authenticated;
grant select on table public.nuc_avisos_extra to authenticated;

drop policy if exists nuc_avisos_extra_sel on public.nuc_avisos_extra;
create policy nuc_avisos_extra_sel on public.nuc_avisos_extra
  for select to authenticated
  using ((select tiene_rol('manager'::app_role))
         or usuario_email = (select lower(auth_email())));

create or replace function public.nuc_extra_agregar(p_unidad text, p_email text)
returns void
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_yo text := lower(auth_email());
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if v_yo is null or not tiene_rol('manager'::app_role) then
    raise exception 'Solo el manager puede cambiar quién recibe los avisos.' using errcode = '42501';
  end if;
  if p_unidad is null or p_unidad not in ('Biobox', 'Biobox Perú', 'Ecovallas', 'Vía Verde') then
    raise exception 'Unidad no válida.' using errcode = '22023';
  end if;
  -- Debe tener cuenta: sin ella no puede abrir la app ni recibir el push.
  if not exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'Ese correo no tiene cuenta en la app.' using errcode = '22023';
  end if;
  insert into nuc_avisos_extra(unidad_negocio, usuario_email, agregado_por)
  values (p_unidad, v_email, v_yo)
  on conflict (unidad_negocio, usuario_email) do nothing;
end;
$function$;

create or replace function public.nuc_extra_quitar(p_unidad text, p_email text)
returns void
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
begin
  if auth_email() is null or not tiene_rol('manager'::app_role) then
    raise exception 'Solo el manager puede cambiar quién recibe los avisos.' using errcode = '42501';
  end if;
  delete from nuc_avisos_extra
   where unidad_negocio = p_unidad and usuario_email = lower(btrim(coalesce(p_email, '')));
  if not found then
    raise exception 'Esa persona ya no estaba en la lista.';
  end if;
end;
$function$;

revoke all on function public.nuc_extra_agregar(text, text) from public, anon;
revoke all on function public.nuc_extra_quitar(text, text) from public, anon;
grant execute on function public.nuc_extra_agregar(text, text) to authenticated;
grant execute on function public.nuc_extra_quitar(text, text) to authenticated;

-- 2. Quién ve el tablero de una unidad. Cuerpo copiado de producción (md5
--    3fdcce57…, 4-nov-2026); lo nuevo va marcado con CAMBIO.
create or replace function public.nuc_puede_ver(p_unidad text)
returns boolean
language sql
stable
security definer
set search_path = 'public', 'pg_temp'
as $function$
  select nuc_es_digital()
      or nuc_es_tecnico(p_unidad)
      or tiene_rol('viewer'::app_role)
      or exists (
           select 1 from usuario_roles ur
            where lower(ur.usuario_email) = lower(auth_email())
              and (
                    (ur.rol = 'coordinador'::app_role
                     and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad)))
                 or (ur.rol = 'validador'::app_role
                     and lower(ur.unidad_negocio) = lower(p_unidad)
                     -- CAMBIO (4-nov-2026): fuera de Biobox, solo el de
                     -- Digital o de todos los medios (no el de Impreso).
                     and (lower(p_unidad) in ('biobox', 'biobox perú')
                          or ur.medio is null or ur.medio ilike 'digital'))
              ))
      -- CAMBIO (4-nov-2026): los agregados a mano a esa unidad.
      or exists (
           select 1 from nuc_avisos_extra x
            where x.usuario_email = lower(auth_email())
              and lower(x.unidad_negocio) = lower(p_unidad));
$function$;

-- 3. A quién le llega el push. Cuerpo copiado de producción (md5
--    0bc36230…, 4-nov-2026); lo nuevo va marcado con CAMBIO.
create or replace function public.nuc_avisar_tecnicos(p_unidad text, p_evento text, p_msg text)
returns void
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_para text[];
  -- CAMBIO (4-nov-2026): Ecovallas y Vía Verde no tienen área Op. Bio Box.
  v_bio boolean := lower(p_unidad) in ('biobox', 'biobox perú');
begin
  select array_agg(distinct t.e) into v_para
    from (
      select lower(ur.usuario_email) as e
        from usuario_roles ur
       where (v_bio
              and ur.rol = 'reparacion'::app_role
              and trim(ur.departamento) ilike 'op. bio box'
              and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad)))
          -- Los coordinadores de la unidad: sin área, o de Op. Bio Box (Biobox)
          -- o de Digital (las demás).
          or (ur.rol = 'coordinador'::app_role
              and lower(ur.unidad_negocio) = lower(p_unidad)
              and (ur.departamento is null
                   or (v_bio and trim(ur.departamento) ilike 'op. bio box')
                   or (not v_bio and trim(ur.departamento) ilike 'digital')))
          -- El validador de la unidad (Erik, 29-oct-2026). CAMBIO
          -- (4-nov-2026): fuera de Biobox, solo el de Digital o de todos
          -- los medios; el de Impreso de Ecovallas no.
          or (ur.rol = 'validador'::app_role
              and lower(ur.unidad_negocio) = lower(p_unidad)
              and (v_bio or ur.medio is null or ur.medio ilike 'digital'))
          -- CAMBIO (4-nov-2026): en Ecovallas y Vía Verde, Digital de la
          -- unidad o de todas.
          or (not v_bio
              and ur.rol in ('reparacion'::app_role, 'coordinador'::app_role)
              and trim(ur.departamento) ilike 'digital'
              and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad)))
      -- CAMBIO (4-nov-2026): los agregados a mano a esa unidad.
      union
      select x.usuario_email
        from nuc_avisos_extra x
       where lower(x.unidad_negocio) = lower(p_unidad)
    ) t;
  if v_para is null then
    select array_agg(distinct lower(ur.usuario_email)) into v_para
      from usuario_roles ur
     where ur.rol = 'manager'::app_role;
  end if;

  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  select null, e, p_evento, p_msg, p_unidad
    from unnest(coalesce(v_para, '{}'::text[])) as e
   where e is distinct from lower(auth_email());
end;
$function$;

revoke all on function public.nuc_avisar_tecnicos(text, text, text) from public, anon, authenticated;

-- 4. Marcar fuera de línea también en Ecovallas y Vía Verde. Cuerpo copiado
--    de producción (md5 01d22652…, aplicado el 4-nov-2026 en
--    20261104171200); lo nuevo va marcado con CAMBIO.
create or replace function public.nuc_aviso_abrir(p_site_id text, p_nota text, p_foto text)
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

  -- El sitio debe existir en el inventario de una unidad del tablero. Se
  -- prefiere la cara digital para el nombre visible.
  select i.site_id, i.unidad_negocio, coalesce(i.site_legacy_id, i.site_id) as maquina
    into v_inv
    from inventario i
   where i.site_id = p_site_id
     and (i.unidad_negocio ilike 'biobox' or i.unidad_negocio ilike 'biobox perú'
          -- CAMBIO (4-nov-2026): pantallas de Ecovallas; columnas y pórticos de Vía Verde.
          or (i.unidad_negocio ilike 'ecovallas' and i.tipo_medio = 'Digital')
          or (i.unidad_negocio ilike 'vía verde' and i.tipo_mueble in ('Columna', 'Pórticos')))
   order by (i.tipo_medio = 'Digital') desc nulls last, i.vendor_face_id
   limit 1;
  if not found then
    -- CAMBIO (4-nov-2026): ya no es solo Biobox.
    raise exception 'El sitio % no está en el tablero de Aviso NUC.', p_site_id;
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

-- ══ Verificación (solo lectura) ══
-- select count(*) from nuc_avisos_extra;                                  -- 0 al aplicar
-- select pg_get_function_arguments('public.nuc_extra_agregar'::regproc);
