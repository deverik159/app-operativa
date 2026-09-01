-- ============================================================
-- notificar_chat_participantes.sql — el chat notifica también a quien
-- participa en el hilo. Correr en Supabase → SQL Editor.
--
-- PROBLEMA (Erik, 31-ago-2026): notificar_chat avisaba solo a
-- captured_by + técnico asignado + técnicos del área. El VALIDADOR (o un
-- manager, o cualquiera que hubiera escrito en el hilo sin ser de esos
-- grupos) nunca se enteraba de las respuestas: Alejandro escribía
-- "Ponle uju" y la respuesta de Ana no le sonaba ni le pintaba globito.
--
-- EL CAMBIO: se suma a los destinatarios a los PARTICIPANTES del hilo —
-- todo el que ya escribió en el chat de esa incidencia espera respuesta,
-- sea cual sea su rol. El autor del mensaje nuevo queda fuera, como
-- siempre. Conserva el comodín NULL de unidad/departamento
-- (fix_notificaciones_unidad_null.sql).
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
      -- respuesta — validador, manager o quien sea. El mensaje recién
      -- insertado también aparece (trigger AFTER), pero su autor se
      -- excluye al final.
      union all select m.autor_email
                from mensajes m
                where m.record_id = new.record_id
      union all select ur.usuario_email
                from usuario_roles ur
                where ur.rol = 'reparacion'
                  and (ur.unidad_negocio is null
                       or inc.unidad_negocio is null
                       or ur.unidad_negocio ilike inc.unidad_negocio)
                  and (ur.departamento is null
                       or ur.departamento ilike coalesce(inc.assigned_area, inc.area_responsable))
    ) s where x is not null
  ) r
  where r.e <> lower(coalesce(new.autor_email, ''));
  return new;
end
$$;

-- El trigger trg_notificar_chat ya apunta a esta función: el
-- create or replace basta, no hay que recrearlo.

-- ------------------------------------------------------------
-- Verificación: responde un chat donde ya haya escrito alguien de otro
-- rol (p. ej. contesta el hilo de EV00000, donde escribió el validador)
-- y ese participante debe aparecer aquí:
-- ------------------------------------------------------------
select para_email, left(mensaje, 60) as mensaje, creado_en
from notificaciones
where evento = 'chat'
order by creado_en desc
limit 8;
