-- ============================================================
-- pauta_evidencias.sql
-- Fotos y videos que el monitorista sube al registrar la toma.
--
-- Resuelve el pendiente §9.3 del handoff: hasta ahora `pauta_monitoreo` solo
-- guardaba la FECHA de la toma, no la evidencia.
--
-- Tabla aparte (no un JSON dentro de pauta_monitoreo) por consistencia con
-- `evidencias` y `fijacion_evidencias`, que ya son así: una fila por archivo.
-- Eso permite borrar una foto suelta, contarlas y auditar quién subió qué.
--
-- Igual que pauta_monitoreo, NO se toca al reimportar la catorcena: es trabajo
-- de campo, no dato del archivo.
--
-- Aplicar después de pauta_schema.sql.
-- ============================================================

create table if not exists pauta_evidencias (
  id              bigserial primary key,

  -- Misma llave que pauta_monitoreo: el trabajo físico es por cara.
  catorcena       int  not null,
  vendor_face_id  text not null,

  tipo            text,          -- 'foto' | 'video'
  url             text not null,
  path            text,          -- ruta en Storage, para poder borrar el archivo
  /** Texto libre del monitorista: "toma larga", "cara norte"… */
  referencia      text,
  subido_por      text,
  creado_en       timestamptz default now()
);

create index if not exists pauta_ev_cara_idx
  on pauta_evidencias (catorcena, vendor_face_id);


-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table pauta_evidencias enable row level security;

-- Lectura: cualquier autenticado. La evidencia es el respaldo del trabajo y
-- la revisa tanto quien va a campo como quien valida.
drop policy if exists pev_sel on pauta_evidencias;
create policy pev_sel on pauta_evidencias for select
  using (auth_email() is not null);

-- Subir: cualquier autenticado. Quien recorre la ruta es quien sube.
drop policy if exists pev_ins on pauta_evidencias;
create policy pev_ins on pauta_evidencias for insert
  with check (auth_email() is not null);

-- Borrar: solo el que la subió, o coordinación. Espeja el criterio de
-- `evidencias`: nadie borra el respaldo de otro.
drop policy if exists pev_del on pauta_evidencias;
create policy pev_del on pauta_evidencias for delete
  using (
    lower(coalesce(subido_por,'')) = lower(auth_email())
    or tiene_rol('coordinador'::app_role)
    or tiene_rol('manager'::app_role)
  );


-- ------------------------------------------------------------
-- Vista actualizada: agrega el conteo de fotos
-- ------------------------------------------------------------
-- Se reemplaza vw_pauta_ruta para incluir `fotos`, y así la lista de campo
-- puede mostrar cuánta evidencia lleva cada cara sin una consulta extra.
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

  -- Cuántos archivos de evidencia lleva esta cara en esta catorcena.
  coalesce(ev.n, 0) as fotos,

  inv.latitud,
  inv.longitud,
  (inv.latitud is not null and inv.longitud is not null) as navegable,

  ru.ruta_id as ruta_monitoreo_id

from pautas p
left join pauta_monitoreo m
       on m.catorcena = p.catorcena
      and m.vendor_face_id = p.vendor_face_id
left join lateral (
  select count(*) as n
  from pauta_evidencias e
  where e.catorcena = p.catorcena
    and e.vendor_face_id = p.vendor_face_id
) ev on true
left join lateral (
  select latitud, longitud
  from inventario
  where vendor_face_id = p.vendor_face_id
  limit 1
) inv on true
left join ruta_ubicaciones ru on ru.site_id = p.site_id;


-- ------------------------------------------------------------
-- Verificación
-- ------------------------------------------------------------
select count(*) as evidencias_pauta from pauta_evidencias;
select vendor_face_id, avance, fotos from vw_pauta_ruta limit 5;
