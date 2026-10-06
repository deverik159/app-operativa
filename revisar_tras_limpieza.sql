-- ============================================================
-- revisar_tras_limpieza.sql — los primeros días del piloto, después de
-- limpiar_todo.sql (Erik, 27-sep-2026). Supabase → SQL Editor.
--
-- Un reporte de prueba que se quedó en la cola de algún teléfono se manda
-- solo cuando esa cuenta vuelve a abrir la app, ya con la base limpia: entra
-- con la fecha de la prueba, toma un folio real y sube sus fotos. Este
-- archivo los encuentra (PASO A, solo lectura) y, si hay, los borra
-- completos con sus archivos y reacomoda los folios (PASO B).
--
-- La hora de la limpieza la dejó limpiar_todo.sql en app_config
-- ('limpieza_piloto'): lo reportado ANTES de esa hora es de prueba.
-- ============================================================


-- ══════════ PASO A — ¿REVIVIÓ ALGO? (solo lectura) ══════════
-- Lo normal: vacío. Si sale algo, copia sus record_id al PASO B.
with corte as (
  select valor::timestamptz as hora
  from public.app_config
  where clave = 'limpieza_piloto'
)
select que, record_id, detalle from (

  -- 1 · Incidencias con fecha anterior a la limpieza
  select 1 as o, '1 · reporte de prueba revivido' as que, i.record_id,
         coalesce(i.folio, '(sin folio)') || ' · ' || coalesce(i.captured_by, '?') || ' · reportado '
           || to_char(i.fecha_reporte at time zone 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') as detalle
  from public.incidencias i, corte
  where i.fecha_reporte < corte.hora

  union all
  -- 2 · Evidencias cuya incidencia ya no existe (envío a medias que terminó
  --     de subir fotos después de limpiar)
  select 2, '2 · evidencia sin incidencia', e.record_id, count(*) || ' evidencia(s)'
  from public.evidencias e
  where e.record_id is not null
    and not exists (select 1 from public.incidencias i where i.record_id = e.record_id)
  group by e.record_id

  union all
  -- 3 · Carpetas de archivos de una incidencia que ya no existe
  select 3, '3 · archivos sin incidencia', x.rid, count(*) || ' archivo(s)'
  from (
    select case when o.name like 'chat/%' then split_part(o.name, '/', 2)
                else split_part(o.name, '/', 1) end as rid
    from storage.objects o
    where o.bucket_id = 'evidencias'
      and o.name like '%/%'
      and o.name not like 'fijacion-externa/%'
      and o.name not like 'bitacora-vv/%'
      and o.name not like 'revisiones/%'
      and o.name not like 'pauta/%'
      and o.name not like 'rutas/%'
  ) x
  where not exists (select 1 from public.incidencias i where i.record_id = x.rid)
  group by x.rid

  union all
  -- 4 · Si no sale la hora, limpiar_todo.sql no pudo guardarla
  select 4, '4 · hora de la limpieza', null,
         coalesce((select to_char(hora at time zone 'America/Mexico_City', 'YYYY-MM-DD HH24:MI')
                   from corte), '(no está guardada: revisa app_config)')

) r
order by o, record_id;


-- ══════════ PASO B — BORRAR LO REVIVIDO (solo si el PASO A sacó algo) ══════════
-- Pon los record_id del PASO A en el arreglo de abajo y corre el bloque
-- completo. Con el arreglo vacío no hace nada. Borra la incidencia con su
-- chat, evidencias, reasignaciones y avisos, deja sus archivos en la tabla
-- puente para scripts/limpiar-storage.mjs, y reacomoda los folios: cada
-- prefijo sigue en el mayor folio vivo + 1 (sin nada vivo, en 00001).
begin;

create temp table _revividos on commit drop as
select unnest(array[
  -- 'a1b2c3d4', 'e5f6a7b8'   ← aquí los record_id
  null
]::text[]) as record_id;
delete from _revividos where record_id is null;

delete from public.chat_adjuntos  where record_id in (select record_id from _revividos);
delete from public.mensajes       where record_id in (select record_id from _revividos);
delete from public.chat_lecturas  where record_id in (select record_id from _revividos);
delete from public.evidencias     where record_id in (select record_id from _revividos);
delete from public.reasignaciones where record_id in (select record_id from _revividos);
delete from public.notificaciones where record_id in (select record_id from _revividos);
delete from public.incidencias    where record_id in (select record_id from _revividos);

-- Sus archivos, para el script (misma tabla puente que limpiar_todo.sql).
create table if not exists public._limpieza_paths (path text primary key);
alter table public._limpieza_paths enable row level security;
revoke all on public._limpieza_paths from anon, authenticated;
insert into public._limpieza_paths (path)
select o.name
from storage.objects o
where o.bucket_id = 'evidencias'
  and o.name not like 'fijacion-externa/%'
  and (split_part(o.name, '/', 1) in (select record_id from _revividos)
       or (o.name like 'chat/%' and split_part(o.name, '/', 2) in (select record_id from _revividos)))
on conflict do nothing;

-- Folios: el mayor vivo + 1 por prefijo, SOLO si se borró algo (con el
-- arreglo vacío no se tocan: si después se borra una incidencia real, su
-- folio no se reusa). Exige exactamente 5 dígitos después del prefijo: así
-- 'BBM500001' cuenta para BBM5 y no para BBM.
do $$
begin
  if to_regclass('public.folio_counters') is not null
     and exists (select 1 from _revividos) then
    update public.folio_counters fc
    set next_seq = 1 + coalesce((
      select max(right(i.folio, 5)::int)
      from public.incidencias i
      where i.folio ~ ('^' || fc.prefijo || '[0-9]{5}$')
    ), 0);
  end if;
end $$;

commit;

notify pgrst, 'reload schema';

-- Qué quedó: si hay archivos para el script, corre
--   node scripts/limpiar-storage.mjs
-- y luego tira la tabla puente con el PASO 5 de limpiar_todo.sql.
select (select count(*) from public._limpieza_paths) as archivos_para_el_script,
       (select string_agg(prefijo || '=' || next_seq, ', ' order by prefijo)
        from public.folio_counters) as siguiente_folio_por_prefijo;
