-- ============================================================
-- Aviso NUC: los coordinadores de la unidad también reciben los avisos
-- (Erik, 30-oct-2026)
--
-- Antes los coordinadores solo recibían si la unidad no tenía ningún técnico
-- de Op. Bio Box, y Biobox tiene 17: nunca les llegaba. Ahora reciben SIEMPRE
-- los dos avisos (fuera de línea y en línea), igual que el validador:
--
--   técnicos de Op. Bio Box de la unidad (o sin unidad)
--   + coordinadores de esa unidad exacta, sin área o de Op. Bio Box (el
--     tablero lo ven más coordinadores; el aviso, solo estos)
--   + validador de la unidad
--   y solo si no hay NADIE de los tres, los managers.
--
-- Cada persona una sola vez aunque tenga varios roles, y nunca quien hizo
-- el cambio. Mismos permisos: solo la llaman nuc_aviso_abrir y
-- nuc_aviso_en_linea (SECURITY DEFINER).
-- ============================================================

create or replace function public.nuc_avisar_tecnicos(p_unidad text, p_evento text, p_msg text)
returns void
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_para text[];
begin
  select array_agg(distinct lower(ur.usuario_email)) into v_para
    from usuario_roles ur
   where (ur.rol = 'reparacion'::app_role
          and trim(ur.departamento) ilike 'op. bio box'
          and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad)))
      -- CAMBIO (30-oct-2026): los coordinadores siempre, no solo sin técnicos.
      or (ur.rol = 'coordinador'::app_role
          and lower(ur.unidad_negocio) = lower(p_unidad)
          and (ur.departamento is null or trim(ur.departamento) ilike 'op. bio box'))
      -- El validador de la unidad (Erik, 29-oct-2026).
      or (ur.rol = 'validador'::app_role
          and lower(ur.unidad_negocio) = lower(p_unidad));
  if v_para is null then
    select array_agg(distinct lower(ur.usuario_email)) into v_para
      from usuario_roles ur
     where ur.rol = 'manager'::app_role;
  end if;

  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  select null, e, p_evento, p_msg, p_unidad
    from unnest(coalesce(v_para, '{}'::text[])) as e
   where e is distinct from lower(auth_email());
end;
$function$;

revoke all on function public.nuc_avisar_tecnicos(text, text, text) from public, anon, authenticated;

-- ══ Verificación (solo lectura) ══
-- Quiénes recibirían en Biobox (cuenta por rol):
-- select ur.rol, ur.departamento, count(distinct ur.usuario_email)
--   from usuario_roles ur
--  where lower(ur.unidad_negocio) = 'biobox' and ur.rol in ('coordinador','validador')
--  group by 1, 2;
