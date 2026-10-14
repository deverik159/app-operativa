-- ============================================================
-- pauta_fotos_regresadas — las fotos de una toma regresada ya no cuentan
-- (Erik, 14-oct-2026). Re-ejecutable. Aplicada en producción el 14-oct-2026.
--
-- POR QUÉ: el PDF de comprobaciones que se manda al cliente juntaba TODAS
-- las fotos de la cara. Cuando el coordinador regresa una toma, sus fotos
-- se quedaban; al repetirla, las malas salían junto a las nuevas. Además,
-- nada impedía subir más fotos a una toma ya comprobada.
--
-- QUÉ HACE:
--   1. pauta_evidencias.regresada_en: cuándo se regresó la toma de esa foto
--      (null = vigente). Las fotos no se borran: queda el rastro.
--   2. rechazar_toma marca así las fotos vigentes de esa cara. Lo demás de
--      la función queda igual que en 20261014172034_catorcena_con_anio.
--   3. Trigger: no se pueden agregar fotos a una cara ya COMPROBADA.
--   4. vw_pauta_ruta.fotos cuenta solo las vigentes (mismas columnas).
-- La app (lista de la toma, mínimo de fotos y descargas) ignora las
-- regresadas desde el mismo cambio.
-- ============================================================

alter table public.pauta_evidencias add column if not exists regresada_en timestamptz;
comment on column public.pauta_evidencias.regresada_en is
  'Cuándo se regresó la toma de esta foto (null = vigente). Las regresadas no cuentan para el mínimo ni salen en las descargas.';

-- Lo ya regresado antes de hoy: las fotos subidas hasta el regreso de una
-- toma que sigue sin repetirse son de la toma regresada.
update public.pauta_evidencias e
   set regresada_en = m.fecha_rechazo
  from public.pauta_monitoreo m
 where m.anio = e.anio and m.catorcena = e.catorcena and m.vendor_face_id = e.vendor_face_id
   and m.fecha_toma is null and m.fecha_rechazo is not null
   and e.creado_en <= m.fecha_rechazo
   and e.regresada_en is null;

-- 2) Regresar la toma marca sus fotos.
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
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el coordinador puede regresar una toma.';
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

  -- La toma se anula (debe repetirse) pero el rastro queda.
  update pauta_monitoreo
     set fecha_toma     = null,
         toma_por       = null,
         rechazo_motivo = trim(p_motivo),
         rechazada_por  = lower(auth_email()),
         fecha_rechazo  = now(),
         actualizado_en = now()
   where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id;

  -- Sus fotos dejan de contar (14-oct-2026): no se borran, se marcan. La
  -- toma nueva necesita sus propias fotos y las viejas no salen en el PDF
  -- del cliente.
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
    'El coordinador regresó tu toma de ' ||
      coalesce(v_sitio.site_id, p_vendor_face_id) ||
      coalesce(' cara ' || v_sitio.cara, '') ||
      ' (Cat-' || p_catorcena || ' · ' || v_anio || '): "' || trim(p_motivo) ||
      '". Vuelve a tomarla.',
    'Ecovallas'
  );
end;
$function$;

-- 3) Nada de fotos nuevas en una cara ya comprobada.
create or replace function public.pauta_evid_no_tras_comprobar()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Los BEFORE corren por orden de nombre y este va antes que
  -- trg_pauta_fija_anio: el año puede no venir todavía.
  if exists (
    select 1 from pauta_monitoreo m
    where m.anio = coalesce(new.anio, anio_de_catorcena(new.catorcena)) and m.catorcena = new.catorcena
      and m.vendor_face_id = new.vendor_face_id
      and m.fecha_comprobacion is not null
  ) then
    raise exception 'Esta toma ya está comprobada: no se le pueden agregar fotos.';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_pauta_evid_no_tras_comprobar on public.pauta_evidencias;
create trigger trg_pauta_evid_no_tras_comprobar before insert on public.pauta_evidencias
  for each row execute function public.pauta_evid_no_tras_comprobar();

-- 4) La lista cuenta solo las fotos vigentes.
create or replace view public.vw_pauta_ruta as
 select p.id,
    p.catorcena,
    p.etiqueta,
    p.site_id,
    p.vendor_face_id,
    p.cara,
    p.direccion,
    p.estado,
    p.medio,
    p.ruta_clave,
    p.ruta_numero,
    p.secuencia,
    p.campana,
    p.version,
    p.campana_anterior,
    p.estatus,
    p.corte,
    p.contract_number,
    p.orden_fijacion,
    p.fecha_fijacion,
    m.fecha_toma,
    m.toma_por,
    m.fecha_comprobacion,
    m.comprobacion_por,
    p.fecha_toma_archivo,
    p.fecha_comprobacion_archivo,
        case
            when (m.fecha_comprobacion is not null) then 'COMPROBADA'::text
            when (m.fecha_toma is not null) then 'TOMADA'::text
            else 'PENDIENTE'::text
        end as avance,
    inv.latitud,
    inv.longitud,
    ((inv.latitud is not null) and (inv.longitud is not null)) as navegable,
    ru.ruta_id as ruta_monitoreo_id,
    coalesce(ev.n, (0)::bigint) as fotos,
    p.espec_toma,
    m.rechazo_motivo,
    m.rechazada_por,
    p.anio
   from ((((pautas p
     left join pauta_monitoreo m on (((m.anio = p.anio) and (m.catorcena = p.catorcena) and (m.vendor_face_id = p.vendor_face_id))))
     left join lateral ( select inventario.latitud,
            inventario.longitud
           from inventario
          where (inventario.vendor_face_id = p.vendor_face_id)
         limit 1) inv on (true))
     left join ruta_ubicaciones ru on ((ru.site_id = p.site_id)))
     left join lateral ( select count(*) as n
           from pauta_evidencias e
          where ((e.anio = p.anio) and (e.catorcena = p.catorcena) and (e.vendor_face_id = p.vendor_face_id)
            and (e.regresada_en is null))) ev on (true));
