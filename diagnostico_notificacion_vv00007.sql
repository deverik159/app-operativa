-- Diagnóstico de VV00007. Ejecutar en Supabase > SQL Editor.
-- Solo lectura: no cambia roles, incidencias ni notificaciones.
-- Usuario del caso: alvarez.jonathan@gpovallas.com.
-- Devuelve el diagnóstico estructural y después la visibilidad con RLS.
-- El SQL Editor ve más que la sesión de Alejandro: esto NO prueba por sí
-- solo que la RLS le permita abrirla. El paso 2 comprueba esa diferencia.
-- Ejecutar TODO el archivo, incluido ROLLBACK al final del paso 2.

with objetivo as (
  select record_id, folio, unidad_negocio, estatus, nombre_incidencia,
         area_responsable, assigned_area, medio, tipo_medio, clave_sitio,
         clave_medio, captured_by, fecha_reporte
  from public.incidencias
  where folio = 'VV00007'
), avisos as (
  select n.id, n.record_id, n.para_email, n.evento, n.mensaje,
         n.unidad_negocio, n.leida, n.creado_en,
         i.folio as folio_vinculado,
         i.estatus as estatus_actual,
         i.unidad_negocio as unidad_actual,
         (i.record_id is null) as referencia_inexistente
  from public.notificaciones n
  left join public.incidencias i on i.record_id = n.record_id
  where lower(trim(n.para_email)) = 'alvarez.jonathan@gpovallas.com'
    and (n.record_id in (select record_id from objetivo)
      or n.mensaje ~ '(^|[^A-Z0-9])VV00007([^A-Z0-9]|$)')
), roles_destinatarios as (
  select ur.usuario_email, ur.rol, ur.unidad_negocio, ur.departamento, ur.medio
  from public.usuario_roles ur
  where lower(trim(ur.usuario_email)) = 'alvarez.jonathan@gpovallas.com'
), politicas as (
  select tablename, policyname, cmd, roles, qual, with_check
  from pg_policies
  where schemaname = 'public'
    and tablename in ('incidencias', 'usuario_roles', 'notificaciones')
    and cmd in ('SELECT', 'ALL')
), funciones as (
  select p.proname, pg_get_function_identity_arguments(p.oid) as argumentos,
         p.prosecdef as security_definer, pg_get_functiondef(p.oid) as definicion
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.prokind = 'f'
    and (
      p.proname in ('auth_email', 'tiene_rol', 'notificar_incidencia')
      -- Incluye helpers referenciados por las políticas reales.
      or exists (select 1 from politicas pp
        where strpos(coalesce(pp.qual, '') || coalesce(pp.with_check, ''), p.proname || '(') > 0)
    )
)
select jsonb_build_object(
  'folio', 'VV00007',
  'usuario', 'alvarez.jonathan@gpovallas.com',
  'incidencias', coalesce((select jsonb_agg(to_jsonb(o)) from objetivo o), '[]'::jsonb),
  'notificaciones', coalesce((select jsonb_agg(to_jsonb(a) order by a.creado_en desc) from avisos a), '[]'::jsonb),
  'roles_destinatarios', coalesce((select jsonb_agg(to_jsonb(r)) from roles_destinatarios r), '[]'::jsonb),
  'politicas_select', coalesce((select jsonb_agg(to_jsonb(p)) from politicas p), '[]'::jsonb),
  'funciones', coalesce((select jsonb_agg(to_jsonb(f)) from funciones f), '[]'::jsonb)
) as diagnostico;

-- 2) Prueba de RLS. Solo cambia el contexto de ESTA transacción del editor.
-- No cambia la sesión de la app ni asigna roles al usuario.
-- auth.users aporta el identificador real de la cuenta. No se emite un JWT.
begin read only;

do $$
declare
  usuario record;
begin
  select id, email, raw_app_meta_data, raw_user_meta_data into usuario
  from auth.users
  where lower(email) = 'alvarez.jonathan@gpovallas.com';
  if not found then
    raise exception 'No existe la cuenta alvarez.jonathan@gpovallas.com en auth.users';
  end if;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', usuario.id::text,
    'email', usuario.email,
    'role', 'authenticated',
    'app_metadata', usuario.raw_app_meta_data,
    'user_metadata', usuario.raw_user_meta_data
  )::text, true);
  perform set_config('request.jwt.claim.sub', usuario.id::text, true);
  perform set_config('request.jwt.claim.email', usuario.email, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end $$;

set local role authenticated;

select jsonb_build_object(
  'usuario_simulado', public.auth_email(),
  'incidencia_visible_con_rls', exists(
    select 1 from public.incidencias where folio = 'VV00007'
  ),
  'incidencia', coalesce((
    select jsonb_agg(jsonb_build_object(
      'record_id', i.record_id, 'folio', i.folio,
      'unidad_negocio', i.unidad_negocio, 'estatus', i.estatus
    )) from public.incidencias i where i.folio = 'VV00007'
  ), '[]'::jsonb),
  'notificaciones_visibles', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', n.id, 'record_id', n.record_id, 'mensaje', n.mensaje, 'leida', n.leida
    )) from public.notificaciones n
    where n.mensaje ~ '(^|[^A-Z0-9])VV00007([^A-Z0-9]|$)'
      and lower(trim(n.para_email)) = 'alvarez.jonathan@gpovallas.com'
  ), '[]'::jsonb)
) as prueba_rls;

rollback;

-- Lectura:
-- - visible=true: los permisos actuales sí permiten ver VV00007; refrescar
--   completamente la pestaña/app antigua y repetir la apertura.
-- - visible=false y sí existe en el paso 1: revisar políticas/roles y sesión.
-- - referencia_inexistente=true: el aviso apunta a un record_id que ya no existe.
-- - folio_vinculado diferente: el texto del aviso y su vínculo no coinciden.
