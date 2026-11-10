-- 10-nov-2026 · Reportes de la app Biobox: se borran las 5 incidencias de Perú
--
-- Qué hace (decisión de Erik del 10-nov-2026, con Biobox Perú en pausa): borra
--   las 5 incidencias de Biobox Perú que nacieron directas a TI desde la app
--   Biobox (BBP00001-BBP00005) y reinicia el contador de folio BBP en 1.
--   · Sus 15 avisos se borran (notificaciones no tiene llave foránea).
--   · No tenían chat, menciones, evidencias, archivos ni reasignaciones (se
--     verificó antes; si apareciera algo, el candado detiene la migración).
--   · Los 5 reportes de la bandeja que las crearon (45, 72, 99, 126 y 372)
--     regresan a pendiente («Atendidos en la app» si Biobox ya los atendió),
--     escondidos mientras Perú esté en pausa.
--   Candado: solo procede si las incidencias de Perú son EXACTAMENTE esas 5,
--   todas de la app Biobox, y el contador BBP no ha pasado de 6.

set local lock_timeout = '5s';

do $$
declare
  v_folios text;
  v_otras int;
  v_seq int;
begin
  select string_agg(folio, ',' order by folio) into v_folios
    from incidencias where unidad_negocio = 'Biobox Perú';
  if v_folios is distinct from 'BBP00001,BBP00002,BBP00003,BBP00004,BBP00005' then
    raise exception 'Las incidencias de Perú ya no son las 5 esperadas (%): revisar antes.', v_folios;
  end if;
  if exists (select 1 from incidencias where unidad_negocio = 'Biobox Perú'
              and coalesce(area_reportante, '') <> 'App Biobox') then
    raise exception 'Hay una incidencia de Perú que no viene de la app Biobox: revisar antes.';
  end if;
  select (select count(*) from mensajes m join incidencias i using (record_id) where i.unidad_negocio = 'Biobox Perú')
       + (select count(*) from evidencias e join incidencias i using (record_id) where i.unidad_negocio = 'Biobox Perú')
       + (select count(*) from reasignaciones r join incidencias i using (record_id) where i.unidad_negocio = 'Biobox Perú')
       + (select count(*) from chat_menciones c join incidencias i using (record_id) where i.unidad_negocio = 'Biobox Perú')
    into v_otras;
  if v_otras > 0 then
    raise exception 'Las incidencias de Perú ya tienen chat, evidencias, menciones o reasignaciones (%): revisar antes.', v_otras;
  end if;
  select next_seq into v_seq from folio_counters where prefijo = 'BBP';
  if v_seq is distinct from 6 then
    raise exception 'El contador BBP está en % (se esperaba 6): revisar antes.', v_seq;
  end if;
end;
$$;

-- Los reportes de la bandeja vuelven a pendiente (o a «Atendidos en la app»).
update public.biobox_app_reportes r
   set decision       = case when r.estatus_core = 3 then 'atendido_en_webadmin' end,
       record_id      = null,
       marca_atendido = null,
       decidido_por   = null,
       decidido_en    = null
 where r.record_id in (select record_id from public.incidencias where unidad_negocio = 'Biobox Perú');

delete from public.notificaciones
 where record_id in (select record_id from public.incidencias where unidad_negocio = 'Biobox Perú');

delete from public.incidencias
 where unidad_negocio = 'Biobox Perú'
   and area_reportante = 'App Biobox'
   and folio in ('BBP00001', 'BBP00002', 'BBP00003', 'BBP00004', 'BBP00005');

update public.folio_counters
   set next_seq = 1
 where prefijo = 'BBP';
