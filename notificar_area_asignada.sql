-- ============================================================
-- notificar_area_asignada.sql
--
-- PROBLEMA: asignar `assigned_area` NO genera ninguna notificación.
--
-- El trigger trg_notificar (función notificar_incidencia) sí corre en
-- AFTER UPDATE, pero su primera condición es:
--
--     if new.estatus is distinct from old.estatus then
--
-- Asignar el área de reparación no cambia el estatus (sigue en 'en_proceso'),
-- así que la función entra, evalúa esa condición, sale y no inserta nada.
-- Resultado: el área que recibe el trabajo nunca se entera.
--
-- Y el frontend NO puede insertar la notificación por su cuenta: la tabla
-- `notificaciones` tiene RLS activa con solo dos políticas, notif_sel
-- (SELECT) y notif_upd (UPDATE). Sin política de INSERT, cualquier insert
-- desde la app se bloquea. Las notificaciones SOLO pueden nacer de los
-- triggers security definer. Por eso el arreglo va aquí y no en TypeScript.
--
-- Revisa y aplica en el SQL Editor de Supabase.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Nuevo trigger: avisar cuando se dirige una incidencia a un área
-- ------------------------------------------------------------
create or replace function notificar_area_asignada()
returns trigger
language plpgsql
security definer
as $$
declare
  msg text;
  n_insertadas int;
begin
  -- Solo cuando assigned_area REALMENTE cambia y queda con valor.
  -- Quitar la redirección (poner null) no notifica a nadie: el área del
  -- catálogo ya sabía que era suya.
  if new.assigned_area is distinct from old.assigned_area
     and new.assigned_area is not null then

    msg := 'Incidencia dirigida a tu área (' || new.assigned_area ||
           ') para reparar: ' || coalesce(new.folio, '') || ' · ' ||
           coalesce(new.nombre_incidencia, '');

    -- Destinatarios: los de reparación de esa unidad cuyo departamento
    -- coincide con el área destino. Mismo criterio que usa
    -- notificar_incidencia, para no inventar una regla distinta.
    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      select new.record_id, u.email, 'asignacion_area', msg, new.unidad_negocio
      from (
        select distinct lower(usuario_email) as email
        from usuario_roles
        where rol = 'reparacion'
          -- unidad_negocio null en el rol = todas las unidades
          and (new.unidad_negocio is null or unidad_negocio ilike new.unidad_negocio)
          and (departamento is null or departamento ilike new.assigned_area)
      ) u;

    get diagnostics n_insertadas = row_count;

    -- Red de seguridad: si nadie tiene ese departamento asignado, la
    -- notificación se perdería en silencio. Mejor avisar a todo el personal
    -- de reparación de la unidad que dejar el trabajo sin dueño.
    -- (Es el mismo patrón que ya usa notificar_reasignacion.)
    if n_insertadas = 0 then
      insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
        select new.record_id, u.email, 'asignacion_area', msg, new.unidad_negocio
        from (
          select distinct lower(usuario_email) as email
          from usuario_roles
          where rol = 'reparacion'
            and (new.unidad_negocio is null or unidad_negocio ilike new.unidad_negocio)
        ) u;
    end if;

    -- Al técnico ya asignado por nombre, si lo hay: su trabajo cambió de área.
    if new.asignado_tecnico_email is not null then
      insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      values (new.record_id, lower(new.asignado_tecnico_email), 'asignacion_area',
              msg, new.unidad_negocio)
      on conflict do nothing;
    end if;

  end if;
  return new;
end
$$;

drop trigger if exists trg_notificar_area_asignada on incidencias;

create trigger trg_notificar_area_asignada
  after update on incidencias
  for each row
  execute function notificar_area_asignada();


-- ------------------------------------------------------------
-- 2) OPCIONAL (recomendado): que el chat también llegue al área que repara
-- ------------------------------------------------------------
-- notificar_chat hoy busca destinatarios con:
--     ur.departamento ilike inc.area_responsable
-- Si la incidencia se redirigió, el área que SÍ está trabajando no recibe
-- los mensajes del chat, y el área del catálogo recibe mensajes de algo que
-- ya no le toca. Esto usa el área efectiva.
--
-- Es el único cambio a una función que ya existía. Reviéwalo con calma antes
-- de aplicarlo; si prefieres, déjalo para después: el trigger de arriba
-- funciona solo.

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
      union all select ur.usuario_email
                from usuario_roles ur
                where ur.rol = 'reparacion'
                  and ur.unidad_negocio ilike inc.unidad_negocio
                  -- ÚNICO CAMBIO: área efectiva en vez de solo area_responsable.
                  and (ur.departamento is null
                       or ur.departamento ilike coalesce(inc.assigned_area, inc.area_responsable))
    ) s where x is not null
  ) r
  where r.e <> lower(new.autor_email);
  return new;
end
$$;


-- ------------------------------------------------------------
-- 3) Verificación
-- ------------------------------------------------------------
-- Después de aplicar: asigna un área desde la app y corre esto.
-- Deben aparecer filas con evento = 'asignacion_area'.
select id, record_id, para_email, evento, mensaje, leida, creado_en
from notificaciones
where evento = 'asignacion_area'
order by creado_en desc
limit 20;
