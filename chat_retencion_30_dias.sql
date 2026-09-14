-- ============================================================
-- chat_retencion_30_dias.sql — los archivos del chat viven 30 días
-- Correr una vez en Supabase → SQL Editor.
--
-- ANTES: al cerrar la incidencia, sus archivos se purgaban a los 2 días.
-- AHORA (Erik, 14-sep-2026): todo archivo del chat vive MÍNIMO 30 días
-- desde que se subió, aunque la incidencia cierre — y la válvula de los
-- 60 días absolutos se queda (una incidencia que nadie cierra no guarda
-- archivos para siempre).
--
-- El criterio vive en la VISTA a propósito (ver chat_adjuntos.sql): la
-- Edge Function de limpieza la consulta tal cual, así que este cambio no
-- necesita redesplegar nada. Los días se miden DESDE EL ARCHIVO porque
-- `incidencias` no guarda fecha de cierre.
--
-- ¿CABE EN EL PLAN GRATIS? El límite de Storage es 1 GB. Los topes del
-- chat son 5 MB por foto (y la app la comprime a ~0.3-0.5 MB antes de
-- validar) y 50 MB / 90 s por video. El riesgo son los videos: 20 videos
-- grandes vivos = 1 GB. El monitor de abajo dice el "peso vivo" real —
-- si se acerca a ~700 MB, se baja la retención de videos (se puede
-- distinguir por a.tipo en esta misma vista) o se pasa a plan de pago.
-- ============================================================

create or replace view vw_chat_adjuntos_purgables as
select a.id,
       a.record_id,
       a.path,
       a.creado_en,
       i.estatus,
       case
         when i.estatus = 'cerrada' then 'cerrada y con más de 30 días'
         else 'más de 60 días'
       end as motivo
from chat_adjuntos a
join incidencias i on i.record_id = a.record_id
where a.purgado_en is null
  and (
    (i.estatus = 'cerrada' and a.creado_en < now() - interval '30 days')
    or a.creado_en < now() - interval '60 days'
  );

-- MONITOR — correr de vez en cuando (o cuando algo se sienta lento):
-- cuánto pesa lo VIVO del chat contra el 1 GB del plan.
select count(*) filter (where purgado_en is null) as archivos_vivos,
       count(*) filter (where purgado_en is null and tipo = 'video') as videos_vivos,
       pg_size_pretty(coalesce(sum(bytes) filter (where purgado_en is null), 0)) as peso_vivo,
       pg_size_pretty(coalesce(sum(bytes) filter (where purgado_en is null and tipo = 'video'), 0)) as peso_videos
from chat_adjuntos;

-- Verificar el criterio nuevo: qué purgaría la próxima corrida y por qué.
select * from vw_chat_adjuntos_purgables order by creado_en limit 20;
