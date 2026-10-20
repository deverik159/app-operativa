-- Pauta: envíos de fotos comprobadas al analista (20-oct-2026, decisión de Erik).
--
-- El coordinador da "Enviar al analista" por campaña (Indicadores →
-- Comprobaciones). Se manda lo comprobado que aún no se había enviado de
-- esa campaña; si después se comprueban más tomas, un envío nuevo lleva solo
-- las nuevas. El analista ve las fotos en carpetas campaña → versión, con el
-- vendor_face_id como nombre, y marca cada una "correcta" o sube la editada.
-- Cuando no queda ninguna pendiente, el envío queda revisado y se avisa a
-- quien lo mandó. Las descargas de comprobación usan la editada.
--
-- La editada vive en esta tabla y no en pauta_evidencias: la base no deja
-- agregar fotos a una toma comprobada (pauta_evid_no_tras_comprobar), y así
-- la original se conserva.
--
-- Requiere 20261020172933_rol_analista.sql (valor 'analista' de app_role).

create table if not exists public.pauta_envios_analista (
  id            bigint generated always as identity primary key,
  anio          integer not null,
  catorcena     integer not null,
  campana       text    not null,
  enviado_por   text    not null,
  enviado_en    timestamptz not null default now(),
  fotos         integer not null,
  caras         integer not null,
  revisado_en   timestamptz,
  revisado_por  text
);

create index if not exists pauta_envios_analista_cat_idx
  on public.pauta_envios_analista (anio, catorcena, campana);

create table if not exists public.pauta_envio_fotos (
  id              bigint generated always as identity primary key,
  envio_id        bigint not null references public.pauta_envios_analista(id) on delete cascade,
  -- Copias de la campaña y la catorcena: con ellas se sabe qué foto ya se
  -- envió de esa campaña sin pasar por el envío.
  anio            integer not null,
  catorcena       integer not null,
  campana         text    not null,
  version         text,
  vendor_face_id  text    not null,
  site_id         text,
  -- La evidencia original. Si alguien la borra, queda la copia de su liga.
  evidencia_id    bigint references public.pauta_evidencias(id) on delete set null,
  tipo            text,
  original_path   text,
  original_url    text not null,
  -- Número de la foto dentro de su cara: el archivo se llama
  -- <vendor_face_id>_<n>. Sigue contando entre envíos de la misma campaña.
  n               integer not null,
  estado          text not null default 'pendiente'
                  check (estado in ('pendiente', 'correcta', 'editada')),
  editada_path    text,
  editada_url     text,
  revisado_por    text,
  revisado_en     timestamptz,
  check (estado <> 'editada' or editada_url is not null)
);

create index if not exists pauta_envio_fotos_envio_idx on public.pauta_envio_fotos (envio_id);
-- Una foto se manda una sola vez por campaña.
create unique index if not exists pauta_envio_fotos_unica
  on public.pauta_envio_fotos (anio, catorcena, campana, evidencia_id);
create index if not exists pauta_envio_fotos_evid_idx on public.pauta_envio_fotos (evidencia_id);
-- Respaldo del candado de enviar_al_analista: el número no se repite por cara.
create unique index if not exists pauta_envio_fotos_n_uk
  on public.pauta_envio_fotos (anio, catorcena, campana, vendor_face_id, n);

-- Lectura: como pauta_evidencias, cualquiera con sesión (las descargas del
-- monitorista también deben llevar la editada). Escritura: solo por las RPC.
alter table public.pauta_envios_analista enable row level security;
alter table public.pauta_envio_fotos     enable row level security;

drop policy if exists pea_sel on public.pauta_envios_analista;
create policy pea_sel on public.pauta_envios_analista
  for select to authenticated using (auth_email() is not null);

drop policy if exists pef_sel on public.pauta_envio_fotos;
create policy pef_sel on public.pauta_envio_fotos
  for select to authenticated using (auth_email() is not null);

revoke all on public.pauta_envios_analista from anon, authenticated;
revoke all on public.pauta_envio_fotos     from anon, authenticated;
grant select on public.pauta_envios_analista to authenticated;
grant select on public.pauta_envio_fotos     to authenticated;

-- ------------------------------------------------------------
-- Enviar al analista lo comprobado de una campaña que no se había enviado.
-- ------------------------------------------------------------
create or replace function public.enviar_al_analista(p_anio integer, p_catorcena integer, p_campana text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email  text := lower(auth_email());
  v_envio  bigint;
  v_fotos  int;
  v_caras  int;
begin
  if v_email is null then
    raise exception 'Sesión no válida.';
  end if;
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el coordinador puede enviar fotos al analista.';
  end if;
  if coalesce(trim(p_campana), '') = '' then
    raise exception 'Falta la campaña.';
  end if;

  -- Un envío a la vez por campaña: dos toques seguidos no duplican.
  perform pg_advisory_xact_lock(hashtext('enviar_al_analista'), hashtext(p_anio || '-' || p_catorcena || '-' || p_campana));

  -- El envío nace con 0 y se completa al final; si no hay nada nuevo, la
  -- excepción deshace todo, envío incluido.
  insert into pauta_envios_analista (anio, catorcena, campana, enviado_por, fotos, caras)
  values (p_anio, p_catorcena, p_campana, v_email, 0, 0)
  returning id into v_envio;

  with caras as (
    -- Una fila por cara de la campaña; si la cara trae dos versiones, manda
    -- la NUEVA y, entre iguales, la de fijación más reciente.
    select distinct on (p.vendor_face_id)
           p.vendor_face_id, p.site_id, p.version
    from pautas p
    join pauta_monitoreo m
      on m.anio = p.anio and m.catorcena = p.catorcena and m.vendor_face_id = p.vendor_face_id
    where p.anio = p_anio and p.catorcena = p_catorcena and p.campana = p_campana
      and m.fecha_toma is not null and m.fecha_comprobacion is not null
    order by p.vendor_face_id, (p.estatus = 'NUEVO') desc nulls last,
             p.fecha_fijacion desc nulls last, p.id
  ),
  nuevas as (
    select c.version, c.vendor_face_id, c.site_id, e.id as evidencia_id,
           e.tipo, e.path, e.url, e.creado_en
    from caras c
    join pauta_evidencias e
      on e.anio = p_anio and e.catorcena = p_catorcena and e.vendor_face_id = c.vendor_face_id
    where e.regresada_en is null
      and e.url is not null
      -- Solo fotos: los videos tampoco van en el PDF de comprobación.
      and coalesce(e.tipo, 'foto') <> 'video'
      and not exists (
        select 1 from pauta_envio_fotos f
        where f.anio = p_anio and f.catorcena = p_catorcena and f.campana = p_campana
          and f.evidencia_id = e.id)
  )
  insert into pauta_envio_fotos (
    envio_id, anio, catorcena, campana, version, vendor_face_id, site_id,
    evidencia_id, tipo, original_path, original_url, n)
  select v_envio, p_anio, p_catorcena, p_campana, nv.version, nv.vendor_face_id, nv.site_id,
         nv.evidencia_id, nv.tipo, nv.path, nv.url,
         coalesce((select max(f.n) from pauta_envio_fotos f
                   where f.anio = p_anio and f.catorcena = p_catorcena and f.campana = p_campana
                     and f.vendor_face_id = nv.vendor_face_id), 0)
         + row_number() over (partition by nv.vendor_face_id order by nv.creado_en, nv.evidencia_id)
  from nuevas nv;

  select count(*), count(distinct vendor_face_id) into v_fotos, v_caras
    from pauta_envio_fotos where envio_id = v_envio;
  if v_fotos = 0 then
    raise exception 'No hay fotos nuevas de % por enviar: todo lo comprobado ya se envió.', p_campana;
  end if;

  update pauta_envios_analista set fotos = v_fotos, caras = v_caras where id = v_envio;

  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  select null, u.email, 'pauta_analista',
         'Campaña por revisar: ' || p_campana || ' (Cat-' || p_catorcena || ' · ' || p_anio ||
           '), ' || v_fotos || ' foto' || case when v_fotos = 1 then '' else 's' end ||
           ' de ' || v_caras || ' cara' || case when v_caras = 1 then '' else 's' end ||
           '. Revísala en Pauta y Monitoreo, pestaña Analista.',
         'Ecovallas'
  from (
    select distinct lower(usuario_email) as email
    from usuario_roles
    where rol = 'analista'
      and (unidad_negocio is null or unidad_negocio ilike 'Ecovallas')
  ) u
  where u.email <> v_email;

  return jsonb_build_object('envio_id', v_envio, 'fotos', v_fotos, 'caras', v_caras);
end;
$function$;

-- ------------------------------------------------------------
-- El analista marca una foto como correcta o le pone la editada.
-- ------------------------------------------------------------
create or replace function public.revisar_foto_analista(
  p_foto_id bigint, p_estado text, p_path text default null, p_url text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email  text := lower(auth_email());
  v_foto   pauta_envio_fotos%rowtype;
  v_envio  pauta_envios_analista%rowtype;
  v_pend   int;
  v_cerro  boolean := false;
begin
  if v_email is null then
    raise exception 'Sesión no válida.';
  end if;
  if not (tiene_rol('analista'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el analista puede revisar estas fotos.';
  end if;
  if p_estado not in ('correcta', 'editada') then
    raise exception 'Estado no válido: %.', p_estado;
  end if;
  -- La liga de la editada la arma la base a partir del archivo que de verdad
  -- está en Storage: no se acepta la que mande la app (revisor-rls). Esa
  -- liga reemplaza a la original en lo que se entrega al cliente.
  if p_estado = 'editada' then
    if coalesce(p_path, '') not like 'pauta-analista/%'
       or not exists (select 1 from storage.objects o
                      where o.bucket_id = 'evidencias' and o.name = p_path
                        and o.owner_id = auth.uid()::text) then
      raise exception 'Falta la foto editada.';
    end if;
    p_url := 'https://qztxpcfbbbmvgmtjnlxg.supabase.co/storage/v1/object/public/evidencias/' || p_path;
  end if;

  select * into v_foto from pauta_envio_fotos where id = p_foto_id for update;
  if not found then
    raise exception 'Esa foto no existe.';
  end if;

  update pauta_envio_fotos
     set estado       = p_estado,
         editada_path = case when p_estado = 'editada' then p_path end,
         editada_url  = case when p_estado = 'editada' then p_url end,
         revisado_por = v_email,
         revisado_en  = now()
   where id = p_foto_id;

  select * into v_envio from pauta_envios_analista where id = v_foto.envio_id for update;
  select count(*) into v_pend from pauta_envio_fotos
   where envio_id = v_foto.envio_id and estado = 'pendiente';

  if v_pend = 0 and v_envio.revisado_en is null then
    update pauta_envios_analista
       set revisado_en = now(), revisado_por = v_email
     where id = v_envio.id;
    v_cerro := true;

    if lower(v_envio.enviado_por) <> v_email then
      insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      values (
        null, lower(v_envio.enviado_por), 'pauta_analista_revisado',
        'Campaña revisada por el analista: ' || v_envio.campana ||
          ' (Cat-' || v_envio.catorcena || ' · ' || v_envio.anio || '), ' ||
          (select count(*) from pauta_envio_fotos where envio_id = v_envio.id and estado = 'editada') ||
          ' foto(s) editada(s). Las descargas de comprobación ya las usan.',
        'Ecovallas');
    end if;
  end if;

  return jsonb_build_object('pendientes', v_pend, 'revisado', v_cerro or v_envio.revisado_en is not null,
                            'url', case when p_estado = 'editada' then p_url end);
end;
$function$;

-- ------------------------------------------------------------
-- Storage: la editada es la única copia. Cualquiera con sesión podía borrar
-- cualquier archivo del bucket (ev_obj_del); en pauta-analista/ solo el
-- manager o quien la subió (revisor-rls, 20-oct-2026). Lo demás, igual.
-- ------------------------------------------------------------
drop policy if exists ev_obj_del on storage.objects;
create policy ev_obj_del on storage.objects for delete to authenticated
  using (
    bucket_id = 'evidencias'
    and (
      name not like 'pauta-analista/%'
      or owner_id = auth.uid()::text
      or tiene_rol('manager'::app_role)
    )
  );

revoke all on function public.enviar_al_analista(integer, integer, text) from public, anon;
revoke all on function public.revisar_foto_analista(bigint, text, text, text) from public, anon;
grant execute on function public.enviar_al_analista(integer, integer, text) to authenticated, service_role;
grant execute on function public.revisar_foto_analista(bigint, text, text, text) to authenticated, service_role;
