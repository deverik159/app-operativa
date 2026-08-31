-- ============================================================
-- notificar_reasignacion_aprobada.sql
-- Correr en Supabase → SQL Editor.
--
-- PROBLEMA (equipo, 30-ago-2026): al aprobarse una reasignación, al área
-- NUEVA no le llega ninguna notificación — se entera hasta que alguien
-- abre la app y la ve en su bandeja.
--
-- POR QUÉ: aprobar cambia `area_responsable`, y ningún trigger reacciona
-- a eso. trg_notificar solo dispara cuando cambia el ESTATUS, y la función
-- notificar_reasignacion existente (sobre la tabla reasignaciones) no le
-- avisa al personal de reparación del área destino. Y el frontend no puede
-- insertar la notificación: la RLS de `notificaciones` no tiene política
-- de INSERT — solo nacen de triggers security definer.
--
-- QUÉ HACE ESTE SCRIPT:
--   1) Agrega `incidencias.reasignada_de`: el área anterior, para que el
--      técnico VEA que la incidencia fue reasignada (la escribe la app al
--      aprobar; el trigger la rellena también, por si acaso).
--   2) Trigger nuevo en `incidencias`: cuando una reasignación pendiente
--      se resuelve CAMBIANDO el área (= se aprobó), notifica al personal
--      de reparación del área nueva. Usa evento 'reasignacion', cuyo
--      título de push ("Reasignación aprobada") ya existe en enviar-push.
-- ============================================================

-- PASO 0 (diagnóstico) — qué hace hoy notificar_reasignacion, para
-- confirmar que no vamos a duplicar avisos al mismo destinatario:
select p.proname, pg_get_functiondef(p.oid)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'notificar_reasignacion';

-- PASO 1 — la marca de "antes era de otra área".
alter table public.incidencias
  add column if not exists reasignada_de text;

comment on column public.incidencias.reasignada_de is
  'Área responsable ANTERIOR cuando la incidencia llegó aquí por una reasignación aprobada. NULL = nunca fue reasignada.';

-- PASO 2 — el trigger.
create or replace function public.notificar_reasignacion_aprobada()
returns trigger
language plpgsql
security definer
as $$
declare
  msg text;
  n_insertadas int;
begin
  -- La firma exacta de una reasignación APROBADA: la bandera de pendiente
  -- se apaga Y el área cambió. Un rechazo apaga la bandera sin mover el
  -- área, y no entra aquí.
  if coalesce(old.reasignacion_pendiente, false)
     and not coalesce(new.reasignacion_pendiente, false)
     and new.area_responsable is distinct from old.area_responsable
     and new.area_responsable is not null then

    -- Deja el rastro aunque la app no lo haya mandado en el patch.
    if new.reasignada_de is null then
      new.reasignada_de := old.area_responsable;
    end if;

    msg := 'Incidencia reasignada a tu área (' || new.area_responsable ||
           '), antes de ' || coalesce(old.area_responsable, '—') || ': ' ||
           coalesce(new.folio, '') || ' · ' ||
           coalesce(new.nombre_incidencia, '');

    -- Destinatarios: reparación de esa unidad con el departamento del área
    -- nueva. Mismo criterio que notificar_area_asignada.
    insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
      select new.record_id, u.email, 'reasignacion', msg, new.unidad_negocio
      from (
        select distinct lower(usuario_email) as email
        from usuario_roles
        where rol = 'reparacion'
          and (new.unidad_negocio is null or unidad_negocio ilike new.unidad_negocio)
          and (departamento is null or departamento ilike new.area_responsable)
      ) u;

    get diagnostics n_insertadas = row_count;

    -- Red de seguridad: si nadie tiene ese departamento, avisar a todo el
    -- personal de reparación de la unidad antes que dejarlo en silencio.
    if n_insertadas = 0 then
      insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
        select new.record_id, u.email, 'reasignacion', msg, new.unidad_negocio
        from (
          select distinct lower(usuario_email) as email
          from usuario_roles
          where rol = 'reparacion'
            and (new.unidad_negocio is null or unidad_negocio ilike new.unidad_negocio)
        ) u;
    end if;

  end if;
  return new;
end
$$;

-- BEFORE y no AFTER: así puede rellenar new.reasignada_de en la misma
-- escritura. Los inserts a notificaciones funcionan igual en BEFORE.
drop trigger if exists trg_notificar_reasignacion_aprobada on public.incidencias;
create trigger trg_notificar_reasignacion_aprobada
  before update on public.incidencias
  for each row
  execute function public.notificar_reasignacion_aprobada();

-- PASO 3 — verificar: aprueba una reasignación desde la app y corre esto.
-- Deben salir filas con evento='reasignacion' para el personal del área
-- nueva, y la incidencia con reasignada_de lleno.
select id, record_id, para_email, evento, mensaje, creado_en
from notificaciones
where evento = 'reasignacion'
order by creado_en desc
limit 20;
