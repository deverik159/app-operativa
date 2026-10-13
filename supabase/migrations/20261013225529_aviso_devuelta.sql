-- ============================================================
-- aviso_devuelta — el aviso al reportante dice "devuelta para corregir" en
-- vez de "rechazada" (Erik, 13-oct-2026). Re-ejecutable.
--
-- Desde el botón "↩ Devolver al reportante" (47ecce9) el reporte no se
-- rechaza: se le regresa a quien lo capturó para que lo corrija y lo vuelva
-- a mandar. El texto ahora lo dice así:
--   antes:  Tu incidencia fue rechazada: BB00001 · Arte dañado · Motivo: …
--   ahora:  Tu incidencia fue devuelta para corregir: BB00001 · Arte dañado · Motivo: …
-- Solo cambia ese texto. El evento sigue siendo 'rechazada' (el push y la
-- campana agrupan por evento) y el estatus sigue siendo `rechazada`.
-- La foto supabase/referencia/avisos_incidencias.sql se actualiza igual.
-- ============================================================
create or replace function public.notificar_incidencia()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare msg text;
begin
  if TG_OP = 'INSERT' then
    if new.estatus = 'por_validar' then
      msg := 'Nueva incidencia por validar: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'')||' ('||coalesce(new.unidad_negocio,'')||')';
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'captura', msg, new.unidad_negocio
        from destinatarios_notif('validador'::app_role, new.unidad_negocio, null, new.medio) d;

    elsif new.estatus = 'en_proceso' then
      msg := 'Incidencia directa a tu área ('||coalesce(new.area_responsable,'')||') para prevalidar y reparar: '||coalesce(new.folio,'');
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'asignacion', msg, new.unidad_negocio
        from destinatarios_notif('reparacion'::app_role, new.unidad_negocio, new.area_responsable) d;
    end if;
    return new;
  end if;

  if new.estatus is distinct from old.estatus then
    if new.estatus = 'en_proceso' then
      msg := 'Incidencia asignada al área '||coalesce(new.area_responsable,'')||': '||coalesce(new.folio,'');
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'asignacion', msg, new.unidad_negocio
        from destinatarios_notif('reparacion'::app_role, new.unidad_negocio, new.area_responsable) d;

      -- si viene de 'reparado', es un rechazo de reparación -> avisar al reportante
      if old.estatus = 'reparado' and new.captured_by is not null then
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        values (new.record_id, lower(new.captured_by), 'reabierta',
          'La reparación de tu incidencia fue rechazada y regresó al área para corregirse: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,''),
          new.unidad_negocio);
      end if;

    elsif new.estatus = 'reparado' then
      msg := 'Reparación por aprobar: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'');
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'reparado', msg, new.unidad_negocio
        from destinatarios_notif('validador'::app_role, new.unidad_negocio, null, new.medio) d;

      -- avisar al reportante que su incidencia fue reparada (en revisión)
      if new.captured_by is not null then
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        values (new.record_id, lower(new.captured_by), 'reparado_reportante',
          'Tu incidencia fue reparada y está en revisión: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,''),
          new.unidad_negocio);
      end if;

    elsif new.estatus = 'cerrada' then
      if new.captured_by is not null then
        msg := 'Tu incidencia fue cerrada: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'');
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
          values (new.record_id, lower(new.captured_by), 'cierre', msg, new.unidad_negocio);
      end if;

    -- La devolución del validador (↩ Devolver al reportante, o Descartar de
    -- Digital): el reportante es el único que puede arreglarlo, así que es
    -- el único a quien tiene sentido avisarle. Dice "devuelta" y no
    -- "rechazada" (Erik, 13-oct-2026): se le pide corregir, no se descarta.
    elsif new.estatus = 'rechazada' then
      if new.captured_by is not null then
        msg := 'Tu incidencia fue devuelta para corregir: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'')
               ||coalesce(' · Motivo: '||nullif(btrim(new.motivo_rechazo_reparacion),''), '');
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
          values (new.record_id, lower(new.captured_by), 'rechazada', msg, new.unidad_negocio);
      end if;

    -- El reenvío tras corregir. Solo cuando VIENE de 'rechazada': si llegara
    -- a `por_validar` desde otro lado sería una corrección administrativa, y
    -- avisar ahí solo sumaría ruido a la campana.
    elsif new.estatus = 'por_validar' and old.estatus = 'rechazada' then
      msg := 'Incidencia corregida y reenviada a validar: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'')||' ('||coalesce(new.unidad_negocio,'')||')';
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'captura', msg, new.unidad_negocio
        from destinatarios_notif('validador'::app_role, new.unidad_negocio, null, new.medio) d;
    end if;
  end if;
  return new;
end $function$;

-- Verificar: true.
select position('devuelta para corregir' in prosrc) > 0 as dice_devuelta
from pg_proc where proname = 'notificar_incidencia' and pronamespace = 'public'::regnamespace;
