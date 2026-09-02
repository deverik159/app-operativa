-- ============================================================
-- fijacion_limpiar_urls_muertas.sql — quitar evidencias que ya no existen
-- Correr en Supabase → SQL Editor: PASO 1 para ver, PASO 2 para limpiar.
--
-- QUÉ RESUELVE (Erik, 2-sep-2026, acordado con Mario: son pruebas de la
-- comunicación entre las dos bases): la limpieza total del 31-ago barrió
-- el bucket completo, incluida fijacion-externa/, y los registros
-- COMPLETO de prueba quedaron con foto_url/evidencia_url apuntando a
-- archivos borrados — el link 📎 de la tarjeta abría un 404.
--
-- QUÉ HACE: pone en NULL foto_url y evidencia_url SOLO en las filas donde
-- NINGUNO de sus archivos existe ya en Storage. Si al menos uno vive, la
-- fila no se toca. `foto_tomada` y `estado` se dejan como están: son
-- semántica del flujo de Mario y no nos toca moverla.
--
-- El campo guarda un ARREGLO JSON de URLs ('["https://…"]'); también se
-- tolera una URL suelta. La ruta en Storage es lo que sigue de
-- /object/public/evidencias/ en cada URL.
-- ============================================================

-- PASO 1 — VER qué filas se limpiarían (ninguna URL viva).
with filas as (
  select id, clave, estado,
         coalesce(nullif(evidencia_url, ''), nullif(foto_url, '')) as crudo
  from externo.fijacion
  where coalesce(nullif(evidencia_url, ''), nullif(foto_url, '')) is not null
),
urls as (
  select id, clave, estado,
         jsonb_array_elements_text(
           case when crudo ~ '^\s*\[.*\]\s*$' then crudo::jsonb
                else jsonb_build_array(crudo) end
         ) as url
  from filas
),
rutas as (
  select id, clave, estado, url,
         nullif(split_part(url, '/object/public/evidencias/', 2), '') as path
  from urls
),
chequeo as (
  select r.id, r.clave, r.estado,
         count(*) as archivos_referidos,
         count(o.name) as archivos_vivos
  from rutas r
  left join storage.objects o
    on o.bucket_id = 'evidencias' and o.name = r.path
  group by r.id, r.clave, r.estado
)
select * from chequeo order by archivos_vivos, clave;

-- PASO 2 — LIMPIAR las filas cuyo conteo de vivos fue 0.
-- (Misma condición del paso 1; revisa el resultado de arriba antes.)
with filas as (
  select id,
         coalesce(nullif(evidencia_url, ''), nullif(foto_url, '')) as crudo
  from externo.fijacion
  where coalesce(nullif(evidencia_url, ''), nullif(foto_url, '')) is not null
),
urls as (
  select id,
         jsonb_array_elements_text(
           case when crudo ~ '^\s*\[.*\]\s*$' then crudo::jsonb
                else jsonb_build_array(crudo) end
         ) as url
  from filas
),
rutas as (
  select id,
         nullif(split_part(url, '/object/public/evidencias/', 2), '') as path
  from urls
),
muertas as (
  select r.id
  from rutas r
  left join storage.objects o
    on o.bucket_id = 'evidencias' and o.name = r.path
  group by r.id
  having count(o.name) = 0
)
update externo.fijacion f
set evidencia_url = null,
    foto_url = null
where f.id in (select id from muertas);

-- PASO 3 — Verificar: el paso 1 re-corrido ya no debe listar filas con
-- archivos_vivos = 0.
