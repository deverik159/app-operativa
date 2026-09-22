-- ============================================================
-- pauta_comprobacion_coordinador.sql — comprobar es del coordinador
-- Correr en Supabase → SQL Editor.
--
-- LA REGLA (Erik, 21-sep-2026): la comprobación es la VALIDACIÓN del
-- coordinador, no un botón del monitorista — antes cualquiera con sesión
-- podía tomarse la foto y comprobarse a sí mismo en el mismo minuto.
--
-- QUÉ HACE ESTE SCRIPT:
--   1) `registrar_comprobacion` exige coordinador/manager.
--   2) Nueva RPC `rechazar_toma`: el coordinador revisa las fotos y, si
--      la toma no sirve, la REGRESA con motivo — la cara vuelve a
--      PENDIENTE, queda el rastro y al monitorista le llega la
--      notificación (evento 'pauta_toma') para reponerla.
--   3) `registrar_toma` limpia el rechazo cuando llega la toma nueva.
--   4) La vista expone motivo y quién regresó (columnas AL FINAL, como
--      exige create or replace view).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Rastro del rechazo en pauta_monitoreo.
-- ------------------------------------------------------------
alter table public.pauta_monitoreo
  add column if not exists rechazo_motivo text,
  add column if not exists rechazada_por  text,
  add column if not exists fecha_rechazo  timestamptz;

-- ------------------------------------------------------------
-- 2) Comprobar: solo coordinador/manager.
-- ------------------------------------------------------------
create or replace function registrar_comprobacion(
  p_catorcena int,
  p_vendor_face_id text
)
returns void
language plpgsql
security definer
as $$
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el coordinador puede comprobar una toma.';
  end if;
  insert into pauta_monitoreo (
    catorcena, vendor_face_id, fecha_comprobacion, comprobacion_por)
  values (p_catorcena, p_vendor_face_id, now(), lower(auth_email()))
  on conflict (catorcena, vendor_face_id) do update
    set fecha_comprobacion = now(),
        comprobacion_por   = lower(auth_email()),
        actualizado_en     = now();
end;
$$;

-- ------------------------------------------------------------
-- 3) Regresar la toma: vuelve a PENDIENTE, con motivo y notificación.
-- ------------------------------------------------------------
create or replace function rechazar_toma(
  p_catorcena int,
  p_vendor_face_id text,
  p_motivo text
)
returns void
language plpgsql
security definer
as $$
declare
  v_toma_por text;
  v_sitio record;
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
  where catorcena = p_catorcena and vendor_face_id = p_vendor_face_id;
  if v_toma_por is null then
    raise exception 'Esa cara no tiene toma registrada.';
  end if;

  -- La toma se anula (debe repetirse) pero el rastro queda. Las fotos NO
  -- se tocan: el coordinador puede borrar las malas desde el visor (la
  -- política de pauta_evidencias ya se lo permite) y el monitorista sube
  -- las de reposición.
  update pauta_monitoreo
     set fecha_toma     = null,
         toma_por       = null,
         rechazo_motivo = trim(p_motivo),
         rechazada_por  = lower(auth_email()),
         fecha_rechazo  = now(),
         actualizado_en = now()
   where catorcena = p_catorcena and vendor_face_id = p_vendor_face_id;

  -- Para el mensaje: qué sitio y cara son, en palabras del monitorista.
  select site_id, cara into v_sitio
  from pautas
  where catorcena = p_catorcena and vendor_face_id = p_vendor_face_id
  limit 1;

  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  values (
    null,
    lower(v_toma_por),
    'pauta_toma',
    'El coordinador regresó tu toma de ' ||
      coalesce(v_sitio.site_id, p_vendor_face_id) ||
      coalesce(' cara ' || v_sitio.cara, '') ||
      ' (catorcena ' || p_catorcena || '): "' || trim(p_motivo) ||
      '". Vuelve a tomarla.',
    'Ecovallas'
  );
end;
$$;

grant execute on function rechazar_toma(int, text, text) to authenticated;

-- ------------------------------------------------------------
-- 4) La toma nueva limpia el rechazo (el pendiente ya se atendió).
-- ------------------------------------------------------------
create or replace function registrar_toma(
  p_catorcena int,
  p_vendor_face_id text
)
returns void
language plpgsql
security definer
as $$
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;
  insert into pauta_monitoreo (catorcena, vendor_face_id, fecha_toma, toma_por)
  values (p_catorcena, p_vendor_face_id, now(), lower(auth_email()))
  on conflict (catorcena, vendor_face_id) do update
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
end;
$$;

-- ------------------------------------------------------------
-- 5) La vista, con el rechazo AL FINAL (después de espec_toma).
-- ------------------------------------------------------------
create or replace view vw_pauta_ruta as
select
  p.id,
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
    when m.fecha_comprobacion is not null then 'COMPROBADA'
    when m.fecha_toma          is not null then 'TOMADA'
    else 'PENDIENTE'
  end as avance,

  inv.latitud,
  inv.longitud,
  (inv.latitud is not null and inv.longitud is not null) as navegable,

  ru.ruta_id as ruta_monitoreo_id,

  coalesce(ev.n, 0) as fotos,

  p.espec_toma,

  -- COLUMNAS NUEVAS — al final.
  m.rechazo_motivo,
  m.rechazada_por

from pautas p
left join pauta_monitoreo m
       on m.catorcena = p.catorcena
      and m.vendor_face_id = p.vendor_face_id
left join lateral (
  select latitud, longitud
  from inventario
  where vendor_face_id = p.vendor_face_id
  limit 1
) inv on true
left join ruta_ubicaciones ru on ru.site_id = p.site_id
left join lateral (
  select count(*) as n
  from pauta_evidencias e
  where e.catorcena = p.catorcena
    and e.vendor_face_id = p.vendor_face_id
) ev on true;

-- ------------------------------------------------------------
-- 6) Verificación: regresa una toma de prueba desde la app y corre esto.
-- ------------------------------------------------------------
select para_email, evento, mensaje, creado_en
from notificaciones
where evento = 'pauta_toma'
order by creado_en desc
limit 10;
