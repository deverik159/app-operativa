-- ============================================================
-- diagnostico_biobox.sql
-- Solo LECTURA. No modifica nada. Ejecutar en el SQL Editor y pegarme
-- los resultados.
--
-- Para qué: el mapa de My Maps trae 10 capas y ~210 marcadores con nombres
-- como "Leibnitz - 116", "Palmas - 46", "OXXO Apolonia". Para convertir esas
-- capas en rutas necesito saber POR QUÉ COLUMNA empatan esos marcadores con
-- la tabla `inventario`. El número del final huele a `site_legacy_id`, pero
-- hay que comprobarlo antes de escribir nada.
--
-- Ojo con estos casos que ya detecté en el mapa y que pueden engañar a
-- cualquier empate automático:
--   "OXXO Héroes de 47"   → el 47 es parte del nombre de la calle, no un ID
--   "Masaryk Taine 34"    → sin guion
--   "Nicolas Romero - UCL0002" → el ID no es numérico
--   "OXXO Apolonia"       → sin ID
-- ============================================================

-- ------------------------------------------------------------
-- 1. ¿Cuántas máquinas hay y cómo están segmentadas?
-- ------------------------------------------------------------
select unidad_negocio,
       tipo_medio,
       tipo_mueble,
       count(*) as caras,
       count(distinct site_id) as ubicaciones,
       count(latitud) as con_coordenadas
from inventario
where unidad_negocio ilike '%biobox%'
group by 1, 2, 3
order by caras desc;


-- ------------------------------------------------------------
-- 2. Diez filas de muestra: quiero ver la FORMA de cada clave
-- ------------------------------------------------------------
select vendor_face_id,
       site_id,
       site_legacy_id,
       cara,
       tipo_medio,
       tipo_mueble,
       direccion,
       municipio,
       estado,
       latitud,
       longitud
from inventario
where unidad_negocio ilike '%biobox%'
order by site_legacy_id nulls last
limit 10;


-- ------------------------------------------------------------
-- 3. ¿site_legacy_id es el número del mapa?
--    Busco directamente algunos de los IDs que vi en las capas.
-- ------------------------------------------------------------
select site_legacy_id, site_id, vendor_face_id, direccion, latitud, longitud
from inventario
where unidad_negocio ilike '%biobox%'
  and (
    site_legacy_id in ('116','105','97','46','19','2','75','89','23','UCL0002')
    or site_legacy_id in ('116.0','105.0')          -- por si viene como número
    or site_id        in ('116','105','97','46')
  )
order by site_legacy_id;


-- ------------------------------------------------------------
-- 4. ¿Hay una ubicación por máquina o varias caras por máquina?
--    Esto decide si la ruta se arma por site_id (como Ecovallas) o por cara.
-- ------------------------------------------------------------
select caras_por_sitio, count(*) as sitios
from (
  select site_id, count(*) as caras_por_sitio
  from inventario
  where unidad_negocio ilike '%biobox%'
  group by site_id
) t
group by 1
order by 1;


-- ------------------------------------------------------------
-- 5. ¿Ya hay rutas de Biobox creadas? (deberían ser 0)
-- ------------------------------------------------------------
select r.id, r.numero, r.nombre, r.unidad_negocio, r.tipo_medio, r.activa,
       count(ru.id) as ubicaciones
from rutas_monitoreo r
left join ruta_ubicaciones ru on ru.ruta_id = r.id
where r.unidad_negocio ilike '%biobox%'
group by 1, 2, 3, 4, 5
order by r.numero;

-- Y el número más alto ocupado en TODAS las unidades, para no chocar.
select unidad_negocio, tipo_medio, max(numero) as numero_max
from rutas_monitoreo
group by 1, 2
order by 1, 2;


-- ------------------------------------------------------------
-- 6. El catálogo de incidencias de Biobox
--    De aquí sale el checklist: cada punto de revisión debería poder
--    levantar una incidencia que ya traiga su área, impacto y tipo.
-- ------------------------------------------------------------
select detalle, area, trim(impacto) as impacto, origen, tipo, tipo_mueble
from catalogo_incidencias
where unidad_negocio ilike '%biobox%'
order by area, detalle;

-- Cuántas hay por área, para dimensionar.
select coalesce(area,'(sin área)') as area, count(*)
from catalogo_incidencias
where unidad_negocio ilike '%biobox%'
group by 1
order by 2 desc;


-- ------------------------------------------------------------
-- 7. ¿Cómo se ven las incidencias de Biobox que YA existen?
--    Sirve para saber qué campos llena hoy la gente y respetarlos.
-- ------------------------------------------------------------
select nombre_biobox, clave_sitio, clave_medio, tipo_mueble, tipo_medio,
       nombre_incidencia, area_responsable, nivel, estatus
from incidencias
where unidad_negocio ilike '%biobox%'
order by creado_en desc nulls last
limit 8;

-- ¿nombre_biobox coincide con site_legacy_id o con el nombre del mapa?
select i.nombre_biobox,
       i.clave_sitio,
       inv.site_legacy_id,
       inv.direccion
from incidencias i
left join inventario inv on inv.site_id = i.clave_sitio
where i.unidad_negocio ilike '%biobox%'
  and i.nombre_biobox is not null
limit 10;


-- ------------------------------------------------------------
-- 8. ¿Existe algo de "hoja de vida" o checklist ya en la base?
--    No quiero duplicar una tabla que ya esté hecha.
-- ------------------------------------------------------------
select table_name
from information_schema.tables
where table_schema = 'public'
  and (table_name ilike '%revis%'
    or table_name ilike '%check%'
    or table_name ilike '%hoja%'
    or table_name ilike '%bitac%'
    or table_name ilike '%mant%')
order by table_name;

-- Si existe `bitacoras`, ¿qué guarda?
-- (Sin `select count(*) from bitacoras`: si la tabla no existiera, ese
--  statement aborta el lote completo y este diagnóstico no devolvería NADA.)
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'bitacoras'
order by ordinal_position;


-- ------------------------------------------------------------
-- 9. La restricción única de ruta_ubicaciones
-- ------------------------------------------------------------
-- `importar_rutas_capas` usa `on conflict (site_id)`. Si la restricción real
-- fuera UNIQUE(ruta_id, site_id), la importación fallaría en la primera
-- parada con "there is no unique or exclusion constraint matching the ON
-- CONFLICT specification". Mejor comprobarlo antes de correrla.
select indexname, indexdef
from pg_indexes
where tablename in ('ruta_ubicaciones', 'rutas_monitoreo')
order by tablename, indexname;
