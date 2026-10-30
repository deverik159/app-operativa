-- ============================================================
-- aviso_nuc_validador — 30-oct-2026 · Biobox (módulo Aviso NUC)
--
-- Qué cambia: el Validador de la unidad también se entera (Erik,
-- 29-oct-2026: «podríamos incluir al Validador de Biobox, para que también
-- esté enterada»).
--   - Recibe los mismos dos avisos que los técnicos: fuera de línea y en
--     línea. Se suma a quien reciba la cascada (técnicos → coordinadores
--     → managers); no la reemplaza.
--   - Puede abrir el tablero (nuc_puede_ver), para que el aviso la lleve a
--     algo que sí ve. Solo lee: no tiene botones.
-- Solo cuenta el validador con ESA unidad exacta: uno sin unidad no recibe
-- avisos de NUC (hoy no hay ninguno). Al 29-oct-2026 hay 1 validadora de
-- Biobox y ninguno de Biobox Perú.
--
-- Re-ejecutable.
-- ============================================================

-- Avisos: la cascada de siempre más el validador de la unidad.
create or replace function public.nuc_avisar_tecnicos(p_unidad text, p_evento text, p_msg text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_para text[];
begin
  -- Técnicos de Op. Bio Box de la unidad; si no hay, coordinadores de la
  -- unidad; si tampoco, los managers.
  select array_agg(distinct lower(ur.usuario_email)) into v_para
    from usuario_roles ur
   where ur.rol = 'reparacion'::app_role
     and trim(ur.departamento) ilike 'op. bio box'
     and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad));
  if v_para is null then
    select array_agg(distinct lower(ur.usuario_email)) into v_para
      from usuario_roles ur
     where ur.rol = 'coordinador'::app_role
       and lower(ur.unidad_negocio) = lower(p_unidad)
       and (ur.departamento is null or trim(ur.departamento) ilike 'op. bio box');
  end if;
  if v_para is null then
    select array_agg(distinct lower(ur.usuario_email)) into v_para
      from usuario_roles ur
     where ur.rol = 'manager'::app_role;
  end if;
  -- Más el validador de la unidad (Erik, 29-oct-2026), sin repetir a nadie.
  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  select null, e, p_evento, p_msg, p_unidad
    from (
      select unnest(coalesce(v_para, '{}'::text[])) as e
      union
      select lower(ur.usuario_email)
        from usuario_roles ur
       where ur.rol = 'validador'::app_role
         and lower(ur.unidad_negocio) = lower(p_unidad)
    ) destinatarios
   where e is distinct from lower(auth_email());
end;
$function$;

revoke all on function public.nuc_avisar_tecnicos(text, text, text) from public, anon, authenticated;

-- El validador de la unidad también ve el tablero.
create or replace function public.nuc_puede_ver(p_unidad text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select nuc_es_digital()
      or nuc_es_tecnico(p_unidad)
      or tiene_rol('viewer'::app_role)
      or exists (
           select 1 from usuario_roles ur
            where lower(ur.usuario_email) = lower(auth_email())
              and (
                    (ur.rol = 'coordinador'::app_role
                     and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad)))
                 or (ur.rol = 'validador'::app_role
                     and lower(ur.unidad_negocio) = lower(p_unidad))
              ));
$function$;

revoke all on function public.nuc_puede_ver(text) from public, anon;
grant execute on function public.nuc_puede_ver(text) to authenticated;

-- Verificar: nuc_avisar_tecnicos cerrada; nuc_puede_ver solo para authenticated.
select proname,
       has_function_privilege('authenticated', p.oid, 'execute') as auth,
       has_function_privilege('anon', p.oid, 'execute') as anon
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and proname in ('nuc_avisar_tecnicos', 'nuc_puede_ver');
