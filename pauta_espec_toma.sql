-- ============================================================
-- pauta_espec_toma.sql — la especificación de toma llega a la app
-- Correr en Supabase → SQL Editor.
--
-- QUÉ CAMBIA (Erik, 21-sep-2026): al registrar una toma, el monitorista
-- debe ver la ESPEC TOMA del archivo de pauta ("TOMA CORTA, MEDIA Y
-- LARGA", "TOMAS DE DÍA Y DE NOCHE"…) y la app exige el número de fotos
-- que esa especificación implica (3 por defecto). La columna ya existe en
-- `pautas` y el importador ya la guarda — lo único que faltaba era
-- exponerla en la vista que lee la app.
--
-- MISMA REGLA DE SIEMPRE con `create or replace view`: las columnas
-- existentes conservan nombre, tipo y POSICIÓN; las nuevas van AL FINAL
-- (después de `fotos`). El frontend consulta por nombre.
-- ============================================================

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

  -- COLUMNA NUEVA — al final (create or replace view no permite en medio).
  p.espec_toma

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

-- Verificación: qué especificaciones distintas trae la catorcena cargada.
-- Sirve también para HOMOLOGAR: cada texto distinto de esta lista debería
-- caer en una regla de src/lib/especToma.ts.
select espec_toma, count(*) as caras
from pautas
group by espec_toma
order by caras desc;
