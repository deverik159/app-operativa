-- ============================================================
-- fotos_tarjetas_video — la tarjeta de una incidencia reportada SOLO con
-- video también tiene previa (Erik, 25-sep-2026).
--
-- ANTES: fotos_tarjetas (primer_mes.sql) solo buscaba evidencias con
-- tipo = 'foto'. Una incidencia cuyo reporte fue un video salía sin nada en
-- la lista, y parecía que no se había adjuntado nada.
--
-- AHORA: igual que antes para las fotos (misma semántica, mismo orden). Solo
-- cuando una etapa NO tiene foto, se agrega su video en una llave aparte:
--   reporte_video    → el video MÁS VIEJO de la etapa 'reporte'
--   reparacion_video → el video MÁS RECIENTE de la etapa 'reparacion'
-- Llaves aparte y no dentro de reporte/reparacion: una versión anterior de
-- la app (PWA en caché) pintaría la URL del video en un <img> roto; así la
-- ignora y se queda como estaba. La app nueva pinta el cuadro que se guarda
-- al subir el video (mini/…jpg, lib/storage.ts), o "🎬 Video" si es uno
-- viejo sin cuadro. Las llaves en null ya no viajan (jsonb_strip_nulls):
-- la app trata igual una llave ausente que una nula.
--
-- Costo: la subconsulta de video corre SOLO para las etapas sin foto (el
-- CASE no la evalúa si ya hubo foto), sobre el mismo índice de
-- evidencias(record_id). Nada cambia de permisos: create or replace
-- conserva los grants; se repiten igual por si acaso (regla del README).
-- Re-ejecutable.
-- ============================================================

set lock_timeout = '5s';

create or replace function public.fotos_tarjetas(p_ids text[])
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
           jsonb_object_agg(
             t.rid,
             jsonb_strip_nulls(jsonb_build_object(
               'reporte', t.reporte,
               'reparacion', t.reparacion,
               'reporte_video', t.reporte_video,
               'reparacion_video', t.reparacion_video
             ))
           ),
           '{}'::jsonb
         )
  from (
    select f.rid,
           f.reporte,
           f.reparacion,
           case when f.reporte is null then
             (select e.url
                from public.evidencias e
               where e.record_id = f.rid
                 and e.tipo = 'video'
                 and e.etapa = 'reporte'
               order by e.creado_en asc nulls last, e.id asc
               limit 1)
           end as reporte_video,
           case when f.reparacion is null then
             (select e.url
                from public.evidencias e
               where e.record_id = f.rid
                 and e.tipo = 'video'
                 and e.etapa = 'reparacion'
               order by e.creado_en desc nulls last, e.id desc
               limit 1)
           end as reparacion_video
      from (
        select ids.rid,
               (select e.url
                  from public.evidencias e
                 where e.record_id = ids.rid
                   and e.tipo = 'foto'
                   and e.etapa = 'reporte'
                 order by e.creado_en asc nulls last, e.id asc
                 limit 1) as reporte,
               (select e.url
                  from public.evidencias e
                 where e.record_id = ids.rid
                   and e.tipo = 'foto'
                   and e.etapa = 'reparacion'
                 order by e.creado_en desc nulls last, e.id desc
                 limit 1) as reparacion
          from (select distinct u.rid
                  from unnest((p_ids)[1:1000]) as u(rid)
                 where u.rid is not null and u.rid <> '') as ids
      ) f
  ) t
  where t.reporte is not null
     or t.reparacion is not null
     or t.reporte_video is not null
     or t.reparacion_video is not null
$$;

comment on function public.fotos_tarjetas(text[]) is
  'Previa de tarjeta de Incidencias por record_id: {rid: {reporte, reparacion, reporte_video, reparacion_video}}. '
  'reporte = la foto más vieja de la etapa reporte; reparacion = la más reciente; '
  '*_video solo si la etapa no tiene foto. SECURITY INVOKER (aplica la RLS de '
  'evidencias). Máx. 1000 ids por llamada. Ver primer_mes.sql y la migración '
  'fotos_tarjetas_video (25-sep-2026).';

revoke all on function public.fotos_tarjetas(text[]) from public, anon;
grant execute on function public.fotos_tarjetas(text[]) to authenticated, service_role;

reset lock_timeout;

-- Verificar (a mano): sigue siendo SECURITY INVOKER y responde.
--   select not p.prosecdef as security_invoker
--   from pg_proc p where p.oid = to_regprocedure('public.fotos_tarjetas(text[])');
--   select public.fotos_tarjetas(array(
--     select distinct record_id from public.evidencias
--     where tipo = 'video' order by record_id desc limit 5));
