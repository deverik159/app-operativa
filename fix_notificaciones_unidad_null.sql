-- ============================================================
-- fix_notificaciones_unidad_null.sql
-- Correr en Supabase → SQL Editor. Reemplaza funciones ya aplicadas.
--
-- BUG (comprobado con la aprobación de EV00250, 31-ago-2026): un técnico
-- con unidad_negocio NULL en usuario_roles —que significa "todas las
-- unidades"— NUNCA recibe los avisos de área. La condición era:
--
--     (new.unidad_negocio is null or unidad_negocio ilike new.unidad_negocio)
--
-- y en SQL `NULL ilike 'Ecovallas'` no es verdadero: la fila del técnico
-- se descarta. Lo que pasó en la práctica: el aviso "reasignada a tu área
-- (Instalaciones)" les llegó a los técnicos de Implementaciones y Fijación
-- (por la red de seguridad, al quedar 0 destinatarios por área) y NO a la
-- técnico de Instalaciones, que tiene unidad NULL.
--
-- EL ARREGLO: el NULL de la FILA también es comodín, igual que ya lo es el
-- departamento NULL:
--
--     (unidad_negocio is null
--      or new.unidad_negocio is null
--      or unidad_negocio ilike new.unidad_negocio)
--
-- Es el mismo criterio que usa el frontend (reparaEn, IncidenciasView).
-- Se corrigen las tres funciones que compartían el patrón.
-- ============================================================


-- ------------------------------------------------------------
-- 1) notificar_reasignacion_aprobada — el aviso al área nueva al aprobar.
-- ------------------------------------------------------------
create or replace function public.notificar_reasignacion_aprobada()
returns trigger
language plpgsql
security definer
as $$
declare
  msg text;
  n_insertadas int;
begin
  if coalesce(old.reasignacion_pendiente, false)
     and not coalesce(new.reasignacion_pendiente, false)
     and new.area_responsable is distinct from old.area_responsable
     and new.area_responsable is not null then

    if new.reasignada_de is null then
      new.reasignada_de := old.area_responsable;
    end if;

    msg := 'Incidencia reasignada a tu área (' || new.area_responsable ||
           '), antes de ' || coalesce(old.area_responsable, '—') || ': ' ||
           coalesce(new.folio, '') || ' · ' ||
           coalesce(new.nombre_incidencia, '');

    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      select new.record_id, u.email, 'reasignacion', msg, new.unidad_negocio
      from (
        select distinct lower(usuario_email) as email
        from usuario_roles
        where rol = 'reparacion'
          -- NULL en cualquiera de los dos lados = comodín.
          and (unidad_negocio is null
               or new.unidad_negocio is null
               or unidad_negocio ilike new.unidad_negocio)
          and (departamento is null or departamento ilike new.area_responsable)
      ) u;

    get diagnostics n_insertadas = row_count;

    if n_insertadas = 0 then
      insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
        select new.record_id, u.email, 'reasignacion', msg, new.unidad_negocio
        from (
          select distinct lower(usuario_email) as email
          from usuario_roles
          where rol = 'reparacion'
            and (unidad_negocio is null
                 or new.unidad_negocio is null
                 or unidad_negocio ilike new.unidad_negocio)
        ) u;
    end if;

  end if;
  return new;
end
$$;


-- ------------------------------------------------------------
-- 2) notificar_area_asignada — el aviso al asignar assigned_area.
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
  if new.assigned_area is distinct from old.assigned_area
     and new.assigned_area is not null then

    msg := 'Incidencia dirigida a tu área (' || new.assigned_area ||
           ') para reparar: ' || coalesce(new.folio, '') || ' · ' ||
           coalesce(new.nombre_incidencia, '');

    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      select new.record_id, u.email, 'asignacion_area', msg, new.unidad_negocio
      from (
        select distinct lower(usuario_email) as email
        from usuario_roles
        where rol = 'reparacion'
          and (unidad_negocio is null
               or new.unidad_negocio is null
               or unidad_negocio ilike new.unidad_negocio)
          and (departamento is null or departamento ilike new.assigned_area)
      ) u;

    get diagnostics n_insertadas = row_count;

    if n_insertadas = 0 then
      insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
        select new.record_id, u.email, 'asignacion_area', msg, new.unidad_negocio
        from (
          select distinct lower(usuario_email) as email
          from usuario_roles
          where rol = 'reparacion'
            and (unidad_negocio is null
                 or new.unidad_negocio is null
                 or unidad_negocio ilike new.unidad_negocio)
        ) u;
    end if;

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


-- ------------------------------------------------------------
-- 3) notificar_chat — solo si aplicaste la parte 2 (opcional) de
--    notificar_area_asignada.sql. El mismo NULL dejaba fuera del chat a
--    los técnicos de "todas las unidades".
-- ------------------------------------------------------------
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
                  and (ur.unidad_negocio is null
                       or inc.unidad_negocio is null
                       or ur.unidad_negocio ilike inc.unidad_negocio)
                  and (ur.departamento is null
                       or ur.departamento ilike coalesce(inc.assigned_area, inc.area_responsable))
    ) s where x is not null
  ) r
  where r.e <> lower(new.autor_email);
  return new;
end
$$;


-- ------------------------------------------------------------
-- 4) Verificación: vuelve a aprobar una reasignación (o corre un UPDATE de
--    prueba) y confirma que ahora sale UNA fila para el técnico del área,
--    no la red de seguridad completa:
-- ------------------------------------------------------------
select para_email, evento, mensaje, creado_en
from notificaciones
where evento in ('reasignacion','asignacion_area')
order by creado_en desc
limit 10;
