-- ============================================================
-- blindaje_campos_reparacion — solo el técnico del área (o el manager)
-- escribe los campos de una reparación (Erik, 8-oct-2026). Re-ejecutable.
--
-- Por qué: la RLS es por FILA, no por columna. La política inc_upd_validador
-- deja al validador escribir CUALQUIER columna de las incidencias de su
-- unidad, y inc_upd_reportante deja al reportante escribir cualquiera de las
-- suyas mientras estén por validar o rechazadas. Por API (sin pasar por la
-- app) cualquiera de los dos podía "reparar": poner el estatus en reparado,
-- llenar diagnóstico, causa, solución o firmar repaired_by_email. Un usuario
-- con varios roles (validador + técnico de otra área) también.
--
-- Qué hace: un trigger BEFORE UPDATE que, si cambia algún campo de
-- reparación o la incidencia PASA a 'reparado', exige que quien escribe sea
--   · manager, o
--   · técnico (rol 'reparacion') con una fila cuya área sea la responsable o
--     la asignada de la incidencia (como antes del cambio) y cuya unidad sea
--     la de la incidencia o vacía (= todas).
-- Si no, rechaza con 42501 (la app ya lo muestra como "tu rol o tu área no
-- permiten este cambio en esta incidencia").
--
-- Lo que NO toca: validar, aprobar o rechazar una reparación, prevalidar,
-- descartar, reasignar, corregir y editar siguen igual (ninguna escribe estos
-- campos). Los SQL que corre Erik en el SQL Editor no llevan sesión de la
-- app (auth_email() vacío) y pasan sin revisión, igual que la limpieza del
-- piloto. El nombre empieza con "inc_" para correr ANTES que trg_set_sla
-- (los BEFORE corren en orden alfabético).
-- ============================================================
create or replace function public.inc_blindaje_reparacion()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  em text := lower(coalesce(auth_email(), ''));
begin
  -- Sin sesión de la app: SQL Editor, triggers de sistema, service role.
  if em = '' then
    return new;
  end if;

  -- ¿Se está tocando algo de la reparación?
  if not (
       (new.estatus = 'reparado' and old.estatus is distinct from 'reparado')
    or new.diagnostico         is distinct from old.diagnostico
    or new.detalle_reparacion  is distinct from old.detalle_reparacion
    or new.causa_raiz          is distinct from old.causa_raiz
    or new.solucion            is distinct from old.solucion
    or new.incidencia_srd      is distinct from old.incidencia_srd
    or new.arbol_digital_id    is distinct from old.arbol_digital_id
    or new.repaired_by_email   is distinct from old.repaired_by_email
    or new.repaired_at         is distinct from old.repaired_at
    or new.fecha_reparacion    is distinct from old.fecha_reparacion
  ) then
    return new;
  end if;

  if exists (
    select 1 from usuario_roles ur
    where lower(ur.usuario_email) = em
      and (
        ur.rol = 'manager'
        or (
          ur.rol = 'reparacion'
          and ur.departamento is not null
          and (ur.departamento = old.area_responsable or ur.departamento = old.assigned_area)
          and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(old.unidad_negocio))
        )
      )
  ) then
    return new;
  end if;

  raise exception 'Solo el técnico del área % puede registrar la reparación de %',
    coalesce(old.area_responsable, '(sin área)'), coalesce(old.folio, old.record_id)
    using errcode = '42501';
end $$;

drop trigger if exists inc_blindaje_reparacion on public.incidencias;
create trigger inc_blindaje_reparacion
  before update on public.incidencias
  for each row execute function public.inc_blindaje_reparacion();

-- Verificar: una fila, inc_blindaje_reparacion, BEFORE UPDATE.
select t.tgname, pg_get_triggerdef(t.oid) as definicion
from pg_trigger t
where t.tgrelid = 'public.incidencias'::regclass
  and t.tgname = 'inc_blindaje_reparacion';
