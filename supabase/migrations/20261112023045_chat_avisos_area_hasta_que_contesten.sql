-- ============================================================
-- 11-nov-2026 · Incidencias (chat)
-- Qué: menos avisos del chat a los técnicos del área. (1) Los técnicos del
--      área efectiva reciben cada mensaje solo MIENTRAS nadie de esa área ha
--      escrito en el folio; en cuanto uno contesta, al resto ya no le llegan
--      (al que escribe le siguen llegando como participante). (2) Un @área
--      avisa a sus técnicos en ESE mensaje ("📣 Mencionaron a …"), pero ya
--      no los vuelve destinatarios de todo lo que sigue; un @persona sí.
-- Por qué: en 14 días (28-oct → 11-nov) 684 mensajes generaron 7,486 avisos
--      (~11 por mensaje; mediana de 262 por persona). 59% fueron para
--      técnicos del área que nunca escribieron en ese folio y 26% para
--      "mencionados", casi todos por @área (185 contra 26 @persona). Con
--      esta regla se estiman ~3,100 (−58%). Erik eligió la opción A el
--      11-nov-2026 (pendiente del 3-nov, caso BBM00001).
-- No cambia: quién VE el folio o puede escribir (inc_sel_participante_chat
--      y msg_ins siguen leyendo chat_menciones completa), el aviso de la
--      mención en su mensaje, quien capturó, el técnico asignado, quien ya
--      escribió y el validador mientras está en su cancha.
-- Re-ejecutable (create or replace; el update de abajo no cambia nada la
-- segunda vez).
-- ============================================================

-- Menciones que llegaron primero por @área y después directo: con la regla
-- vieja la fila se quedaba como @área (on conflict do nothing). Con la nueva
-- eso las dejaría sin avisos; se marcan como directas (6 filas al 11-nov).
update chat_menciones cm
set por_area = null
where cm.por_area is not null
  and exists (
    select 1
    from mensajes m,
         jsonb_array_elements(case when jsonb_typeof(m.menciones) = 'array'
                                   then m.menciones else '[]'::jsonb end) e
    where m.record_id = cm.record_id
      and m.id <> cm.mensaje_id
      and e->>'tipo' = 'persona'
      and lower(trim(e->>'email')) = cm.email
  );

create or replace function public.notificar_chat()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  inc record;
  msg text;
  mencionados text[] := '{}';
  area_efectiva text;
  area_contesto boolean;
begin
  select * into inc from incidencias where record_id = new.record_id;
  if not found then return new; end if;
  msg := 'Nuevo mensaje en '||coalesce(inc.folio,'')||': '||left(coalesce(new.texto,''),80);
  area_efectiva := coalesce(inc.assigned_area, inc.area_responsable);

  -- ¿Ya escribió en este folio algún técnico del área efectiva (este mismo
  -- mensaje incluido: el trigger es AFTER INSERT)? Desde ese momento el
  -- folio "ya lo tomó alguien" y al resto del área no se le avisa más.
  area_contesto := exists (
    select 1
    from mensajes m
    join usuario_roles ur
      on lower(ur.usuario_email) = lower(m.autor_email)
     and ur.rol = 'reparacion'
     and lower(trim(ur.departamento)) = lower(trim(area_efectiva))
     and (ur.unidad_negocio is null
          or inc.unidad_negocio is null
          or lower(ur.unidad_negocio) = lower(inc.unidad_negocio))
    where m.record_id = new.record_id
  );

  -- Menciones de este mensaje (solo si la app las mandó y el folio tiene
  -- unidad: sin ella no hay "misma unidad" contra la cual validar).
  if jsonb_typeof(new.menciones) = 'array'
     and nullif(trim(inc.unidad_negocio), '') is not null then
    with pedidas as (
      select e->>'tipo' as tipo,
             lower(trim(e->>'email')) as email,
             trim(e->>'area') as area
      from jsonb_array_elements(new.menciones) with ordinality as x(e, n)
      where x.n <= 20
    ),
    validas as (
      -- @persona: con algún rol (menos Consulta) en la unidad, o sin unidad.
      select p.email, null::text as por_area
      from pedidas p
      where p.tipo = 'persona'
        and exists (
          select 1 from usuario_roles ur
          where lower(ur.usuario_email) = p.email
            and ur.rol <> 'viewer'::app_role
            and (ur.unidad_negocio is null
                 or lower(ur.unidad_negocio) = lower(inc.unidad_negocio))
        )
      union all
      -- @área: sus técnicos de la unidad. Igualdad y no ilike: el área llega
      -- del cliente y "%" mencionaría a todos los técnicos (revisor-rls).
      select lower(ur.usuario_email), p.area
      from pedidas p
      join usuario_roles ur
        on ur.rol = 'reparacion'::app_role
       and lower(trim(ur.departamento)) = lower(p.area)
       and (ur.unidad_negocio is null
            or lower(ur.unidad_negocio) = lower(inc.unidad_negocio))
      where p.tipo = 'area'
        and coalesce(p.area, '') <> ''
    ),
    -- Uno por persona; si llegó directo y por área, cuenta lo directo.
    unicas as (
      select distinct on (v.email) v.email, v.por_area
      from validas v
      where v.email is not null
        and v.email <> lower(coalesce(new.autor_email, ''))
      order by v.email, (v.por_area is not null)
    ),
    -- Un CTE que escribe corre completo aunque nadie lea su resultado.
    guardadas as (
      insert into chat_menciones (record_id, email, por_area, mensaje_id, mencionado_por)
      select new.record_id, u.email, u.por_area, new.id, lower(new.autor_email)
      from unicas u
      -- Una fila por persona y folio: si antes llegó por @área y ahora la
      -- mencionan directo, pasa a mención directa (revisor-rls, 11-nov-2026).
      on conflict (record_id, email) do update set por_area = null
        where chat_menciones.por_area is not null and excluded.por_area is null
    ),
    avisos as (
      insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      select new.record_id, u.email, 'chat',
             'Nuevo mensaje en '||coalesce(inc.folio,'')||': 📣 '||
             case when u.por_area is null then 'Te mencionaron'
                  else 'Mencionaron a '||u.por_area end||
             ' — '||left(coalesce(new.texto,''),70),
             inc.unidad_negocio
      from unicas u
      returning para_email
    )
    select coalesce(array_agg(para_email), '{}') into mencionados
    from avisos;
  end if;

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
      -- Quien fue mencionado DIRECTAMENTE antes en este folio (4-nov-2026).
      -- CAMBIO (11-nov-2026): un @área ya no deja a todos sus técnicos
      -- recibiendo el hilo; solo se les avisó en el mensaje que los mencionó.
      union all select cm.email
                from chat_menciones cm
                where cm.record_id = new.record_id
                  and cm.por_area is null
      -- Los técnicos del área efectiva, SOLO mientras nadie del área ha
      -- escrito en el folio (CAMBIO 11-nov-2026).
      -- Igualdad sin mayúsculas, no ilike (4-nov-2026).
      union all select ur.usuario_email
                from usuario_roles ur
                where not area_contesto
                  and ur.rol = 'reparacion'
                  and (ur.unidad_negocio is null
                       or inc.unidad_negocio is null
                       or lower(ur.unidad_negocio) = lower(inc.unidad_negocio))
                  and (ur.departamento is null
                       or lower(trim(ur.departamento)) = lower(trim(area_efectiva)))
      -- El validador, SOLO mientras la incidencia está en su cancha.
      union all select ur.usuario_email
                from usuario_roles ur
                where ur.rol = 'validador'
                  and (inc.estatus in ('por_validar', 'reparado')
                       or coalesce(inc.reasignacion_pendiente, false))
                  and (ur.unidad_negocio is null
                       or inc.unidad_negocio is null
                       or lower(ur.unidad_negocio) = lower(inc.unidad_negocio))
                  and (ur.medio is null
                       or inc.medio is null
                       or lower(ur.medio) = lower(inc.medio))
    ) s where x is not null
  ) r
  where r.e <> lower(coalesce(new.autor_email, ''))
    -- Ya les llegó el aviso de la mención: no dos por el mismo mensaje.
    and r.e <> all (mencionados);
  return new;
end
$function$;
