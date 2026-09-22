-- ============================================================
-- medir_almacenamiento.sql — cuánto Storage consume cada módulo
-- Correr en Supabase → SQL Editor. SOLO LECTURA: no borra ni toca nada.
--
-- PARA QUÉ (Erik, 22-sep-2026): dimensionar el riesgo de almacenamiento
-- de las reglas de comprobación (3/9 fotos por cara) con números reales,
-- y decidir con datos la política de retención (cuántas catorcenas de
-- evidencia conservar antes de purgar).
--
-- El tamaño vive en storage.objects.metadata->>'size' (bytes). Leer esa
-- tabla sí está permitido; lo bloqueado es el DELETE.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Total por bucket: la foto general.
-- ------------------------------------------------------------
select bucket_id,
       count(*)                                               as archivos,
       pg_size_pretty(sum((metadata->>'size')::bigint))       as total,
       pg_size_pretty(avg((metadata->>'size')::bigint)::bigint) as promedio_por_archivo
from storage.objects
where metadata ? 'size'
group by bucket_id
order by sum((metadata->>'size')::bigint) desc;

-- ------------------------------------------------------------
-- 2) Por módulo, dentro del bucket 'evidencias'. Las carpetas de primer
--    nivel identifican el flujo; lo que no empata con un prefijo conocido
--    es evidencia de incidencias (carpetas por record_id) o reasignación.
-- ------------------------------------------------------------
select case
         when name like 'pauta/%'             then 'Pauta (tomas)'
         when name like 'chat/%'              then 'Chat (se purga solo)'
         when name like 'revisiones/%'        then 'Revisiones Biobox'
         when name like 'fijacion-externa/%'  then 'Fijación externa'
         else 'Incidencias (evidencias + reasignaciones)'
       end                                                    as modulo,
       count(*)                                               as archivos,
       pg_size_pretty(sum((metadata->>'size')::bigint))       as total,
       pg_size_pretty(avg((metadata->>'size')::bigint)::bigint) as promedio
from storage.objects
where bucket_id = 'evidencias' and metadata ? 'size'
group by 1
order by sum((metadata->>'size')::bigint) desc;

-- ------------------------------------------------------------
-- 3) LA CLAVE PARA LA RETENCIÓN: pauta por catorcena. Cuánto pesa cada
--    una y cuánto se libera por cada catorcena vieja que se purgue.
--    (La ruta es pauta/<catorcena>/<archivo>.)
-- ------------------------------------------------------------
select split_part(name, '/', 2)                               as catorcena,
       count(*)                                               as archivos,
       pg_size_pretty(sum((metadata->>'size')::bigint))       as total,
       pg_size_pretty(avg((metadata->>'size')::bigint)::bigint) as promedio_por_foto
from storage.objects
where bucket_id = 'evidencias'
  and name like 'pauta/%'
  and metadata ? 'size'
group by 1
order by 1 desc;

-- ------------------------------------------------------------
-- 4) Foto vs video: el video es el comodín pesado (hasta 50 MB por clip).
--    Si esta fila pesa de más, conviene capar el video en pauta.
-- ------------------------------------------------------------
select case
         when lower(name) ~ '\.(mp4|mov|webm|avi|3gp)$' then 'video'
         else 'foto'
       end                                                    as tipo,
       count(*)                                               as archivos,
       pg_size_pretty(sum((metadata->>'size')::bigint))       as total,
       pg_size_pretty(avg((metadata->>'size')::bigint)::bigint) as promedio
from storage.objects
where bucket_id = 'evidencias' and metadata ? 'size'
group by 1
order by sum((metadata->>'size')::bigint) desc;

-- ------------------------------------------------------------
-- 5) Los 20 archivos más pesados: para cazar lo anómalo (un video de
--    50 MB, una foto que se escapó sin comprimir desde escritorio…).
-- ------------------------------------------------------------
select name,
       pg_size_pretty((metadata->>'size')::bigint) as tamano,
       created_at::date                            as subido
from storage.objects
where bucket_id = 'evidencias' and metadata ? 'size'
order by (metadata->>'size')::bigint desc
limit 20;

-- ------------------------------------------------------------
-- 6) Velocidad de crecimiento: GB subidos por semana, últimas 8. Con dos
--    o tres catorcenas reales, esta serie dice cuánto vivirá el plan.
-- ------------------------------------------------------------
select date_trunc('week', created_at)::date                   as semana,
       count(*)                                               as archivos,
       pg_size_pretty(sum((metadata->>'size')::bigint))       as subido
from storage.objects
where bucket_id = 'evidencias'
  and metadata ? 'size'
  and created_at > now() - interval '8 weeks'
group by 1
order by 1 desc;
