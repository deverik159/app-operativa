-- Pauta: el analista revisa cada toma y su revisión ES la comprobación
-- (22-oct-2026, decisión de Erik). Reemplaza el "Enviar al analista" por
-- campaña del 20-oct-2026.
--
--   · El monitorista registra la toma → le llega al analista (aviso
--     "Toma por revisar", evento pauta_revision). Ya no al coordinador.
--   · El analista marca cada foto Correcta o Editada (sube la editada). Cuando
--     ninguna foto vigente de la toma queda sin revisar, la cara queda
--     COMPROBADA sola (comprobacion_por = el analista).
--   · El analista rechaza fotos sueltas con motivo (esas dejan de contar y la
--     toma vuelve al monitorista para subir las que faltan) o regresa toda la
--     toma (rechazar_toma). También después de comprobada. En los dos casos
--     le llega aviso al monitorista.
--   · El coordinador ya no comprueba ni regresa: registrar_comprobacion y
--     rechazar_toma pasan a analista/manager.
--
-- La revisión vive por FOTO en pauta_revision_fotos (una fila por evidencia).
-- La editada no entra a pauta_evidencias y la original se conserva.
--
-- Las tablas del envío por campaña (pauta_envios_analista, pauta_envio_fotos)
-- se quedan como historial, sin uso: sus revisiones se copian aquí y sus
-- funciones se borran.

-- ------------------------------------------------------------
-- 0) Candados: las funciones que se reemplazan deben seguir como se revisaron.
-- ------------------------------------------------------------
do $$
declare
  v text;
begin
  select md5(replace(prosrc, E'\r', '')) into v from pg_proc
   where oid = 'public.registrar_toma(integer, text, integer)'::regprocedure;
  if v <> '61d76783809429dae56aff5a3cb3dc85' then
    raise exception 'registrar_toma cambió en producción; revisar antes de aplicar.';
  end if;
  select md5(replace(prosrc, E'\r', '')) into v from pg_proc
   where oid = 'public.registrar_comprobacion(integer, text, integer)'::regprocedure;
  if v <> 'dbf3fc1ff923f306884fa1fe4065d6b4' then
    raise exception 'registrar_comprobacion cambió en producción; revisar antes de aplicar.';
  end if;
  select md5(replace(prosrc, E'\r', '')) into v from pg_proc
   where oid = 'public.rechazar_toma(integer, text, text, integer)'::regprocedure;
  if v <> '8303f13a0739231363b0136392055723' then
    raise exception 'rechazar_toma cambió en producción; revisar antes de aplicar.';
  end if;
  select md5(replace(prosrc, E'\r', '')) into v from pg_proc
   where oid = 'public.pauta_evid_no_tras_comprobar()'::regprocedure;
  if v <> '7547aedc294b44cff24d44fa49f84732' then
    raise exception 'pauta_evid_no_tras_comprobar cambió en producción; revisar antes de aplicar.';
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 1) Revisión por foto.
-- ------------------------------------------------------------
create table if not exists public.pauta_revision_fotos (
  evidencia_id    bigint primary key references public.pauta_evidencias(id) on delete cascade,
  anio            integer not null,
  catorcena       integer not null,
  vendor_face_id  text    not null,
  estado          text    not null check (estado in ('correcta', 'editada', 'rechazada')),
  motivo          text,
  editada_path    text,
  editada_url     text,
  revisado_por    text    not null,
  revisado_en     timestamptz not null default now(),
  check (estado <> 'editada' or editada_url is not null),
  check (estado <> 'rechazada' or coalesce(trim(motivo), '') <> '')
);

create index if not exists pauta_revision_fotos_cara_idx
  on public.pauta_revision_fotos (anio, catorcena, vendor_face_id);

alter table public.pauta_revision_fotos enable row level security;
drop policy if exists prf_sel on public.pauta_revision_fotos;
create policy prf_sel on public.pauta_revision_fotos
  for select to authenticated using (auth_email() is not null);
revoke all on public.pauta_revision_fotos from anon, authenticated;
grant select on public.pauta_revision_fotos to authenticated;

-- Lo ya revisado en los envíos por campaña (20 y 21-oct-2026) se conserva,
-- en particular las editadas. Si una foto se revisó en dos campañas, vale la
-- revisión más reciente.
insert into public.pauta_revision_fotos (
  evidencia_id, anio, catorcena, vendor_face_id, estado, editada_path, editada_url,
  revisado_por, revisado_en)
select distinct on (f.evidencia_id)
       f.evidencia_id, f.anio, f.catorcena, f.vendor_face_id, f.estado,
       f.editada_path, f.editada_url, f.revisado_por, f.revisado_en
from public.pauta_envio_fotos f
join public.pauta_evidencias e on e.id = f.evidencia_id
where f.estado in ('correcta', 'editada') and f.revisado_por is not null
order by f.evidencia_id, f.revisado_en desc
on conflict (evidencia_id) do nothing;

-- El envío por campaña queda sin uso.
drop function if exists public.enviar_al_analista(integer, integer, text);
drop function if exists public.revisar_foto_analista(bigint, text, text, text);

-- ------------------------------------------------------------
-- 2) Si ya no queda foto vigente sin revisar, la toma se comprueba sola.
--    Uso interno de las RPC de abajo (no se expone).
-- ------------------------------------------------------------
--    `p_por` es quien queda como comprobador: el analista que revisó.
--    Los videos no cuentan: se revisan solo fotos (revisor-rls, 22-oct-2026).
create or replace function public.pauta_comprobar_si_revisada(
  p_anio integer, p_catorcena integer, p_vendor_face_id text, p_por text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_mon pauta_monitoreo%rowtype;
begin
  select * into v_mon from pauta_monitoreo
   where anio = p_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id
   for update;
  if not found or v_mon.fecha_toma is null or v_mon.fecha_comprobacion is not null
     or coalesce(p_por, '') = '' then
    return false;
  end if;
  -- Debe haber al menos una foto vigente y ninguna sin revisar como buena.
  if not exists (
       select 1 from pauta_evidencias e
        where e.anio = p_anio and e.catorcena = p_catorcena and e.vendor_face_id = p_vendor_face_id
          and e.regresada_en is null and coalesce(e.tipo, 'foto') <> 'video')
     or exists (
       select 1 from pauta_evidencias e
        left join pauta_revision_fotos r on r.evidencia_id = e.id
        where e.anio = p_anio and e.catorcena = p_catorcena and e.vendor_face_id = p_vendor_face_id
          and e.regresada_en is null and coalesce(e.tipo, 'foto') <> 'video'
          and coalesce(r.estado, '') not in ('correcta', 'editada')) then
    return false;
  end if;
  update pauta_monitoreo
     set fecha_comprobacion = now(),
         comprobacion_por   = lower(p_por),
         actualizado_en     = now()
   where id = v_mon.id;
  return true;
end;
$function$;

revoke all on function public.pauta_comprobar_si_revisada(integer, integer, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3) El analista marca una foto Correcta o Editada.
-- ------------------------------------------------------------
create or replace function public.revisar_foto_pauta(p_evidencia_id bigint, p_estado text, p_path text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(auth_email());
  v_ev    pauta_evidencias%rowtype;
  v_url   text;
  v_ok    boolean;
begin
  if v_email is null then
    raise exception 'Sesión no válida.';
  end if;
  if not (tiene_rol('analista'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el analista revisa las fotos de las tomas.';
  end if;
  if p_estado not in ('correcta', 'editada') then
    raise exception 'Estado no válido: %.', p_estado;
  end if;

  select * into v_ev from pauta_evidencias where id = p_evidencia_id;
  if not found then
    raise exception 'Esa foto no existe.';
  end if;
  -- Primero se bloquea la toma (mismo orden que rechazar_fotos_pauta: dos
  -- analistas a la vez no se traban) y luego se vuelve a leer la foto.
  perform 1 from pauta_monitoreo m
   where m.anio = v_ev.anio and m.catorcena = v_ev.catorcena
     and m.vendor_face_id = v_ev.vendor_face_id and m.fecha_toma is not null
   for update;
  if not found then
    raise exception 'Esa toma no está registrada: el monitorista todavía no la entrega.';
  end if;
  select * into v_ev from pauta_evidencias where id = p_evidencia_id;
  if v_ev.regresada_en is not null then
    raise exception 'Esa foto ya fue rechazada o su toma se regresó.';
  end if;

  -- La liga de la editada la arma la base desde el archivo que de verdad está
  -- en Storage y que subió quien la marca (revisor-rls, 20-oct-2026).
  if p_estado = 'editada' then
    if coalesce(p_path, '') not like 'pauta-analista/%'
       or not exists (select 1 from storage.objects o
                      where o.bucket_id = 'evidencias' and o.name = p_path
                        and o.owner_id = auth.uid()::text) then
      raise exception 'Falta la foto editada.';
    end if;
    v_url := 'https://qztxpcfbbbmvgmtjnlxg.supabase.co/storage/v1/object/public/evidencias/' || p_path;
  end if;

  insert into pauta_revision_fotos (
    evidencia_id, anio, catorcena, vendor_face_id, estado, motivo, editada_path, editada_url,
    revisado_por, revisado_en)
  values (
    v_ev.id, v_ev.anio, v_ev.catorcena, v_ev.vendor_face_id, p_estado, null,
    case when p_estado = 'editada' then p_path end, v_url, v_email, now())
  on conflict (evidencia_id) do update
    set estado       = excluded.estado,
        motivo       = null,
        editada_path = excluded.editada_path,
        editada_url  = excluded.editada_url,
        revisado_por = excluded.revisado_por,
        revisado_en  = excluded.revisado_en;

  v_ok := pauta_comprobar_si_revisada(v_ev.anio, v_ev.catorcena, v_ev.vendor_face_id, v_email);
  return jsonb_build_object('comprobada', v_ok, 'url', v_url);
end;
$function$;

-- ------------------------------------------------------------
-- 4) El analista rechaza fotos sueltas: dejan de contar, la toma vuelve al
--    monitorista con el motivo y sube las que faltan. Si la toma ya estaba
--    comprobada, se des-comprueba. Un solo aviso por llamada.
-- ------------------------------------------------------------
create or replace function public.rechazar_fotos_pauta(p_evidencia_ids bigint[], p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email   text := lower(auth_email());
  v_cara    record;
  v_n       int;
  v_toma_por text;
  v_sitio   record;
  v_motivo  text := trim(coalesce(p_motivo, ''));
begin
  if v_email is null then
    raise exception 'Sesión no válida.';
  end if;
  if not (tiene_rol('analista'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el analista rechaza fotos de las tomas.';
  end if;
  if v_motivo = '' then
    raise exception 'Escribe el motivo del rechazo: el monitorista lo va a leer.';
  end if;
  if coalesce(array_length(p_evidencia_ids, 1), 0) = 0 then
    raise exception 'Elige al menos una foto.';
  end if;

  -- Todas deben ser de la misma cara y seguir vigentes.
  select count(distinct (anio, catorcena, vendor_face_id)) as caras, count(*) as n,
         min(anio) as anio, min(catorcena) as catorcena, min(vendor_face_id) as vendor_face_id
    into v_cara
    from pauta_evidencias
   where id = any(p_evidencia_ids) and regresada_en is null;
  if v_cara.n <> (select count(distinct x) from unnest(p_evidencia_ids) x) then
    raise exception 'Alguna foto ya no existe o ya estaba rechazada.';
  end if;
  if v_cara.caras <> 1 then
    raise exception 'Rechaza fotos de una sola cara a la vez.';
  end if;

  -- Solo sobre una toma entregada: si ya se regresó, se espera la nueva.
  select toma_por into v_toma_por from pauta_monitoreo
   where anio = v_cara.anio and catorcena = v_cara.catorcena and vendor_face_id = v_cara.vendor_face_id
     and fecha_toma is not null
   for update;
  if v_toma_por is null then
    raise exception 'Esa toma no está registrada: el monitorista todavía no la entrega.';
  end if;

  update pauta_evidencias set regresada_en = now()
   where id = any(p_evidencia_ids) and regresada_en is null;
  get diagnostics v_n = row_count;
  if v_n <> v_cara.n then
    raise exception 'Alguna foto cambió mientras la rechazabas; recarga.';
  end if;

  insert into pauta_revision_fotos (
    evidencia_id, anio, catorcena, vendor_face_id, estado, motivo, revisado_por, revisado_en)
  select e.id, e.anio, e.catorcena, e.vendor_face_id, 'rechazada', v_motivo, v_email, now()
    from pauta_evidencias e where e.id = any(p_evidencia_ids)
  on conflict (evidencia_id) do update
    set estado = 'rechazada', motivo = excluded.motivo, editada_path = null, editada_url = null,
        revisado_por = excluded.revisado_por, revisado_en = excluded.revisado_en;

  -- La toma vuelve al monitorista (también si ya estaba comprobada).
  update pauta_monitoreo
     set fecha_toma         = null,
         toma_por           = null,
         fecha_comprobacion = null,
         comprobacion_por   = null,
         rechazo_motivo     = 'Fotos rechazadas (' || v_n || '): ' || v_motivo,
         rechazada_por      = v_email,
         fecha_rechazo      = now(),
         actualizado_en     = now()
   where anio = v_cara.anio and catorcena = v_cara.catorcena and vendor_face_id = v_cara.vendor_face_id;

  select site_id, cara into v_sitio from pautas
   where anio = v_cara.anio and catorcena = v_cara.catorcena and vendor_face_id = v_cara.vendor_face_id
   limit 1;
  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  values (
    null, lower(v_toma_por), 'pauta_toma',
    'El analista rechazó ' || v_n || ' foto' || case when v_n = 1 then '' else 's' end ||
      ' de tu toma de ' || coalesce(v_sitio.site_id, v_cara.vendor_face_id) ||
      coalesce(' cara ' || v_sitio.cara, '') ||
      ' (Cat-' || v_cara.catorcena || ' · ' || v_cara.anio || '): "' || v_motivo ||
      '". Sube las que faltan y vuelve a registrar la toma.',
    'Ecovallas');

  return jsonb_build_object('rechazadas', v_n);
end;
$function$;

-- ------------------------------------------------------------
-- 5) Regresar toda la toma: ahora del analista (o el manager), también si ya
--    estaba comprobada. Cuerpo del 14-oct-2026 con esos dos cambios.
-- ------------------------------------------------------------
create or replace function public.rechazar_toma(p_catorcena integer, p_vendor_face_id text, p_motivo text, p_anio integer default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_toma_por text;
  v_sitio record;
  v_anio int := coalesce(p_anio, anio_de_catorcena(p_catorcena));
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;
  -- Desde el 22-oct-2026 regresa el analista; el coordinador ya no.
  if not (tiene_rol('analista'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el analista puede regresar una toma.';
  end if;
  if coalesce(trim(p_motivo), '') = '' then
    raise exception 'Escribe el motivo del regreso.';
  end if;

  select toma_por into v_toma_por
  from pauta_monitoreo
  where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id;
  if v_toma_por is null then
    raise exception 'Esa cara no tiene toma registrada.';
  end if;

  -- La toma se anula (debe repetirse) pero el rastro queda. Si ya estaba
  -- comprobada, deja de estarlo (22-oct-2026).
  update pauta_monitoreo
     set fecha_toma         = null,
         toma_por           = null,
         fecha_comprobacion = null,
         comprobacion_por   = null,
         rechazo_motivo     = trim(p_motivo),
         rechazada_por      = lower(auth_email()),
         fecha_rechazo      = now(),
         actualizado_en     = now()
   where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id;

  -- Sus fotos dejan de contar (14-oct-2026): no se borran, se marcan. La
  -- toma nueva necesita sus propias fotos y las viejas no salen en las
  -- descargas del cliente.
  update pauta_evidencias
     set regresada_en = now()
   where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id
     and regresada_en is null;

  -- Para el mensaje: qué sitio y cara son, en palabras del monitorista.
  select site_id, cara into v_sitio
  from pautas
  where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id
  limit 1;

  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  values (
    null,
    lower(v_toma_por),
    'pauta_toma',
    'El analista regresó tu toma de ' ||
      coalesce(v_sitio.site_id, p_vendor_face_id) ||
      coalesce(' cara ' || v_sitio.cara, '') ||
      ' (Cat-' || p_catorcena || ' · ' || v_anio || '): "' || trim(p_motivo) ||
      '". Vuelve a tomarla.',
    'Ecovallas'
  );
end;
$function$;

-- ------------------------------------------------------------
-- 6) Comprobar a mano: ya no es del coordinador. Queda para el analista y el
--    manager (la app comprueba sola al revisar; esto es respaldo).
-- ------------------------------------------------------------
create or replace function public.registrar_comprobacion(p_catorcena integer, p_vendor_face_id text, p_anio integer default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_anio int := coalesce(p_anio, anio_de_catorcena(p_catorcena));
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;
  if not (tiene_rol('analista'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el analista puede comprobar una toma.';
  end if;
  -- Solo una toma entregada (revisor-rls, 22-oct-2026).
  if not exists (select 1 from pauta_monitoreo
                  where anio = v_anio and catorcena = p_catorcena
                    and vendor_face_id = p_vendor_face_id and fecha_toma is not null) then
    raise exception 'Esa toma no está registrada: el monitorista todavía no la entrega.';
  end if;
  insert into pauta_monitoreo (
    anio, catorcena, vendor_face_id, fecha_comprobacion, comprobacion_por)
  values (v_anio, p_catorcena, p_vendor_face_id, now(), lower(auth_email()))
  on conflict (anio, catorcena, vendor_face_id) do update
    set fecha_comprobacion = now(),
        comprobacion_por   = lower(auth_email()),
        actualizado_en     = now();
end;
$function$;

-- ------------------------------------------------------------
-- 7) La toma registrada avisa a los analistas, ya no a los coordinadores.
--    Cuerpo del 14-oct-2026 con ese cambio.
-- ------------------------------------------------------------
create or replace function public.registrar_toma(p_catorcena integer, p_vendor_face_id text, p_anio integer default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_previa timestamptz;
  v_sitio record;
  v_anio int := coalesce(p_anio, anio_de_catorcena(p_catorcena));
  v_revisor text;
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;

  -- ¿Ya había toma vigente? Entonces esto es evidencia extra, no una toma
  -- nueva, y no se re-avisa al analista.
  select fecha_toma into v_previa
  from pauta_monitoreo
  where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id;

  insert into pauta_monitoreo (anio, catorcena, vendor_face_id, fecha_toma, toma_por)
  values (v_anio, p_catorcena, p_vendor_face_id, now(), lower(auth_email()))
  on conflict (anio, catorcena, vendor_face_id) do update
    -- No se pisa una toma anterior VIGENTE; tras un rechazo fecha_toma es
    -- null y la toma nueva entra, limpiando el motivo del regreso.
    set fecha_toma = coalesce(pauta_monitoreo.fecha_toma, excluded.fecha_toma),
        toma_por   = coalesce(pauta_monitoreo.toma_por,   excluded.toma_por),
        rechazo_motivo = case
          when pauta_monitoreo.fecha_toma is null then null
          else pauta_monitoreo.rechazo_motivo end,
        rechazada_por = case
          when pauta_monitoreo.fecha_toma is null then null
          else pauta_monitoreo.rechazada_por end,
        fecha_rechazo = case
          when pauta_monitoreo.fecha_toma is null then null
          else pauta_monitoreo.fecha_rechazo end,
        actualizado_en = now();

  if v_previa is null then
    -- Tras un rechazo de fotos sueltas, si el monitorista vuelve a entregar
    -- sin subir nada nuevo (las que quedan ya estaban revisadas como buenas),
    -- la toma no debe quedar atorada: se comprueba a nombre del analista que
    -- las revisó, y no hace falta avisar (revisor-rls, 22-oct-2026).
    select r.revisado_por into v_revisor
      from pauta_revision_fotos r
      join pauta_evidencias e on e.id = r.evidencia_id
     where e.anio = v_anio and e.catorcena = p_catorcena and e.vendor_face_id = p_vendor_face_id
       and e.regresada_en is null and r.estado in ('correcta', 'editada')
     order by r.revisado_en desc
     limit 1;
    if v_revisor is not null
       and pauta_comprobar_si_revisada(v_anio, p_catorcena, p_vendor_face_id, v_revisor) then
      return;
    end if;

    select site_id, cara into v_sitio
    from pautas
    where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id
    limit 1;

    -- Desde el 22-oct-2026 la revisa el analista (antes, el coordinador).
    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
    select null, u.email, 'pauta_revision',
           'Toma por revisar: ' ||
             coalesce(v_sitio.site_id, p_vendor_face_id) ||
             coalesce(' cara ' || v_sitio.cara, '') ||
             ' (Cat-' || p_catorcena || ' · ' || v_anio || '), registrada por ' ||
             split_part(lower(auth_email()), '@', 1) ||
             '. Revísala en Pauta y Monitoreo, pestaña Analista.',
           'Ecovallas'
    from (
      select distinct lower(usuario_email) as email
      from usuario_roles
      where rol = 'analista'
        and (unidad_negocio is null or unidad_negocio ilike 'Ecovallas')
    ) u
    -- Quien registra no se auto-avisa.
    where u.email <> lower(auth_email());
  end if;
end;
$function$;

-- ------------------------------------------------------------
-- 8) Fotos de una toma comprobada: no se cuelan ni se borran.
-- ------------------------------------------------------------
-- El trigger bloquea la fila de la toma (for share): una foto subida justo
-- mientras el analista comprueba ya no entra sin revisar (revisor-rls).
create or replace function public.pauta_evid_no_tras_comprobar()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_fc timestamptz;
begin
  -- Los BEFORE corren por orden de nombre y este va antes que
  -- trg_pauta_fija_anio: el año puede no venir todavía.
  -- Se bloquea la fila SIEMPRE y se revisa el valor después: con la
  -- condición dentro del where, una toma a punto de comprobarse no se
  -- bloqueaba y la foto se colaba (revisor-rls, 22-oct-2026).
  select m.fecha_comprobacion into v_fc from pauta_monitoreo m
   where m.anio = coalesce(new.anio, anio_de_catorcena(new.catorcena)) and m.catorcena = new.catorcena
     and m.vendor_face_id = new.vendor_face_id
   for share;
  if v_fc is not null then
    raise exception 'Esta toma ya está comprobada: no se le pueden agregar fotos.';
  end if;
  return new;
end
$function$;

-- Borrar: como antes (quien la subió, coordinador o manager), pero no si la
-- toma ya está comprobada; con la foto se perdería su revisión y la editada.
drop policy if exists pev_del on public.pauta_evidencias;
create policy pev_del on public.pauta_evidencias for delete
  using (
    ((lower(coalesce(subido_por, '')) = lower(auth_email()))
      or tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role))
    and not exists (
      select 1 from pauta_monitoreo m
       where m.anio = pauta_evidencias.anio and m.catorcena = pauta_evidencias.catorcena
         and m.vendor_face_id = pauta_evidencias.vendor_face_id
         and m.fecha_comprobacion is not null)
  );

revoke all on function public.revisar_foto_pauta(bigint, text, text) from public, anon;
revoke all on function public.rechazar_fotos_pauta(bigint[], text) from public, anon;
grant execute on function public.revisar_foto_pauta(bigint, text, text) to authenticated, service_role;
grant execute on function public.rechazar_fotos_pauta(bigint[], text) to authenticated, service_role;
