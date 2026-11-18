-- ============================================================
-- 18-nov-2026 · Incidencias · Historial
-- Qué: el historial anota quién y cuándo PREVALIDÓ una incidencia que
--      entró directo al área fuera del horario del validador (evento
--      'prevalidada'). La tarjeta lo enseña bajo «Capturada».
-- Por qué: Erik (18-nov-2026) pidió que el validador vea lo que se
--      prevalidó fuera de horario (filtro en Incidencias) y quién y cuándo.
--      La base solo guardaba prevalidada = true, sin persona ni hora.
--      Descartar ya se anotaba ('descartada', cambia el estatus).
-- Cómo: la misma inc_registrar_historial de 20261117153833 con un bloque
--      más (prevalidada pasa de no a sí), y el trigger también escucha la
--      columna prevalidada. Si el registro fallara, avisa en el log y no
--      frena la prevalidación (igual que antes). Sin relleno: lo anterior
--      no guardaba quién ni cuándo.
-- Revisada por revisor-rls (18-nov-2026); sus ajustes van incluidos.
-- Re-ejecutable: or replace.
-- ============================================================

create or replace function public.inc_registrar_historial()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_quien  text := lower(nullif(trim((select auth_email())), ''));
  v_evento text;
begin
  if tg_op = 'INSERT' then
    -- Nace ya validada (clasificada desde la app Biobox): se anota.
    insert into incidencias_historial (record_id, evento, estatus_nuevo, por_email, en)
    values (new.record_id, 'validada', new.estatus::text,
            coalesce(lower(nullif(trim(new.validator_email), '')), v_quien), now());
    return null;
  end if;

  if new.estatus is distinct from old.estatus then
    v_evento := case
      when new.estatus = 'en_proceso' and old.estatus in ('por_validar', 'reportado') then 'validada'
      when new.estatus = 'en_proceso' and old.estatus = 'reparado'   then 'reparacion_rechazada'
      when new.estatus = 'en_proceso' and old.estatus in ('cerrada', 'no_reparado') then 'reabierta'
      -- El técnico descarta en la prevalidación (auto-ruteo): no es una
      -- devolución del validador.
      when new.estatus = 'rechazada'  and old.estatus = 'en_proceso' then 'descartada'
      when new.estatus = 'rechazada'                                 then 'devuelta'
      when new.estatus = 'por_validar' and old.estatus = 'rechazada' then 'corregida'
      when new.estatus = 'reparado'                                  then 'reparada'
      when new.estatus = 'cerrada'                                   then 'cerrada'
      when new.estatus = 'no_reparado'                               then 'no_reparado'
      else 'estatus'
    end;
    insert into incidencias_historial
      (record_id, evento, estatus_antes, estatus_nuevo, por_email, en, detalle)
    values
      (new.record_id, v_evento, old.estatus::text, new.estatus::text, v_quien, now(),
       -- Devolver, descartar y rechazar reparación guardan su motivo aquí.
       case when v_evento in ('reparacion_rechazada', 'devuelta', 'descartada')
            then nullif(trim(new.motivo_rechazo_reparacion), '') end);
  end if;

  -- NUEVO (18-nov-2026): el área prevalidó lo que entró fuera de horario.
  -- Solo si de verdad requería prevalidación: la columna se puede escribir
  -- por la API en otras, y ahí no es una prevalidación del área.
  if coalesce(new.requiere_prevalidacion, false)
     and coalesce(new.prevalidada, false) and not coalesce(old.prevalidada, false) then
    insert into incidencias_historial (record_id, evento, estatus_nuevo, por_email, en)
    values (new.record_id, 'prevalidada', new.estatus::text, v_quien, now());
  end if;

  -- Cambio de área fuera de una reasignación aprobada (esa la anota
  -- reasignaciones): «Pasar a Op. Bio Box» o la corrección del validador.
  if new.area_responsable is distinct from old.area_responsable
     and not (coalesce(old.reasignacion_pendiente, false)
              and not coalesce(new.reasignacion_pendiente, false)) then
    insert into incidencias_historial (record_id, evento, por_email, en, detalle)
    values (
      new.record_id,
      case when current_setting('app.paso_op_biobox', true) = 'on'
           then 'pasada_op_biobox' else 'area_corregida' end,
      v_quien,
      now(),
      nullif(concat_ws(' → ', nullif(trim(old.area_responsable), ''),
                              nullif(trim(new.area_responsable), '')), '')
    );
  end if;
  return null;
exception when others then
  -- El historial no debe frenar una reparación, validación o prevalidación.
  raise warning 'inc_registrar_historial (%): %', new.record_id, sqlerrm;
  return null;
end
$$;

revoke execute on function public.inc_registrar_historial() from public, anon, authenticated;

-- or replace (no drop + create): sin un instante sin trigger, mismo nombre
-- y mismo orden con los demás AFTER.
create or replace trigger trg_inc_historial
  after update of estatus, area_responsable, prevalidada on public.incidencias
  for each row
  execute function public.inc_registrar_historial();
