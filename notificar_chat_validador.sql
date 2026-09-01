-- ============================================================
-- notificar_chat_validador.sql — el chat también notifica al validador,
-- pero SOLO mientras la incidencia está en su cancha.
-- Correr en Supabase → SQL Editor.
--
-- PROBLEMA (Erik, 1-sep-2026): el validador es el dueño del ciclo
-- (valida la captura, aprueba la reparación, revisa reasignaciones),
-- pero el chat solo le llegaba si ya había escrito en el hilo. Una
-- conversación entre reportante y técnico sobre una incidencia que él
-- tendrá que aprobar pasaba completa a sus espaldas.
--
-- LA REGLA ELEGIDA (la fina, no la de "siempre"): el validador de la
-- unidad+medio recibe los chats SOLO cuando la incidencia está en un
-- estatus donde él es el actor —
--     por_validar            (le toca validar la captura)
--     reparado               (le toca aprobar o rechazar la reparación)
--     reasignación pendiente (le toca resolver la solicitud)
-- En 'en_proceso' sin reasignación pendiente el trabajo es del técnico
-- y el validador no se satura; si le interesa un hilo, con escribir una
-- vez queda como participante y recibe todo lo que siga.
--
-- El alcance del validador es el mismo de su RLS: unidad_negocio ilike y
-- medio que no la excluya, con NULL como comodín en ambos lados.
-- Conserva todo lo anterior: captured_by, técnico asignado, técnicos del
-- área efectiva y participantes del hilo; el autor siempre queda fuera.
-- ============================================================

create or replace function notificar_chat()
returns trigger
language plpgsql
security definer
as $$
declare inc record; msg text;
begin
  select * into inc from incidencias where record_id = new.record_id;
  if not found then return new; end if;
  msg := 'Nuevo mensaje en '||coalesce(inc.folio,'')||': '||left(coalesce(new.texto,''),80);
  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  select new.record_id, r.e, 'chat', msg, inc.unidad_negocio
  from (
    select distinct lower(x) e from (
      select inc.captured_by            as x
      union all select inc.asignado_tecnico_email
      -- Los participantes del hilo: quien ya escribió aquí espera la
      -- respuesta, sea cual sea su rol.
      union all select m.autor_email
                from mensajes m
                where m.record_id = new.record_id
      -- Los técnicos del área efectiva.
      union all select ur.usuario_email
                from usuario_roles ur
                where ur.rol = 'reparacion'
                  and (ur.unidad_negocio is null
                       or inc.unidad_negocio is null
                       or ur.unidad_negocio ilike inc.unidad_negocio)
                  and (ur.departamento is null
                       or ur.departamento ilike coalesce(inc.assigned_area, inc.area_responsable))
      -- El validador, SOLO mientras la incidencia está en su cancha.
      union all select ur.usuario_email
                from usuario_roles ur
                where ur.rol = 'validador'
                  and (inc.estatus in ('por_validar', 'reparado')
                       or coalesce(inc.reasignacion_pendiente, false))
                  and (ur.unidad_negocio is null
                       or inc.unidad_negocio is null
                       or ur.unidad_negocio ilike inc.unidad_negocio)
                  and (ur.medio is null
                       or inc.medio is null
                       or ur.medio ilike inc.medio)
    ) s where x is not null
  ) r
  where r.e <> lower(coalesce(new.autor_email, ''));
  return new;
end
$$;

-- El trigger trg_notificar_chat ya apunta a esta función: no hay que
-- recrearlo.

-- ------------------------------------------------------------
-- Verificación: escribe un chat en una incidencia 'por_validar' o
-- 'reparado' (sin que el validador haya participado) y debe aparecer su
-- correo aquí; escribe en una 'en_proceso' sin reasignación pendiente y
-- NO debe aparecer.
-- ------------------------------------------------------------
select para_email, left(mensaje, 60) as mensaje, creado_en
from notificaciones
where evento = 'chat'
order by creado_en desc
limit 8;
