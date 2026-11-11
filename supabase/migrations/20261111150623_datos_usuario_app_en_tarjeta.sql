-- 11-nov-2026 · Datos del usuario de la app Biobox en la tarjeta, para TI
-- (ficha contexto/reportes-app-biobox.md; decisión de Erik del 11-nov-2026).
--
-- TI pidió ver quién reportó (correo, teléfono y lo que escribió) para
-- resolver casos como el abono de puntos. Amplía la regla del 10-nov-2026
-- («solo para el Excel; técnicos, chat y tarjetas no los ven») SOLO para los
-- técnicos de TI, y solo mientras la incidencia esté en TI:
--
--   · `datos_usuario_app_incidencia(record_id)`: los reportes de la app
--     ligados a esa incidencia, con su contacto (biobox_app_contactos) y la
--     descripción del usuario. Responde SOLO a:
--       - manager;
--       - validador de la unidad de la incidencia;
--       - coordinador de esa unidad o sin unidad;
--       - técnico (reparacion) del departamento TI, de esa unidad o sin
--         unidad, si el área efectiva de la incidencia (assigned_area o, si
--         no, area_responsable) es TI y sigue abierta (no cerrada ni «no
--         reparado»). Si se reasigna a otra área o se cierra, deja de verlo.
--     A cualquier otro le regresa cero filas.
--   · La tarjeta lo pide al tocar «Ver datos del usuario»: no viaja con la
--     lista ni con la copia del teléfono.
--
-- Re-ejecutable.

create or replace function public.datos_usuario_app_incidencia(p_record_id text)
returns table (
  folio_app      text,
  motivo         text,
  descripcion    text,
  correo         text,
  telefono       text,
  medio_contacto text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_unidad  text;
  v_area    text;
  v_estatus text;
begin
  if p_record_id is null then
    return;
  end if;

  select i.unidad_negocio,
         coalesce(nullif(btrim(i.assigned_area), ''), i.area_responsable),
         i.estatus::text
    into v_unidad, v_area, v_estatus
    from incidencias i
   where i.record_id = p_record_id;
  if not found then
    return;
  end if;

  if not (
    (select tiene_rol('manager'::app_role))
    or exists (
      select 1 from usuario_roles ur
       where lower(ur.usuario_email) = lower((select auth_email()))
         and (
           (ur.rol = 'validador'::app_role
            and lower(btrim(ur.unidad_negocio)) = lower(btrim(v_unidad)))
           or (ur.rol = 'coordinador'::app_role
               and (nullif(btrim(ur.unidad_negocio), '') is null
                    or lower(btrim(ur.unidad_negocio)) = lower(btrim(v_unidad))))
           -- Técnico de TI, solo mientras la atiende: hoy en TI y abierta.
           or (ur.rol = 'reparacion'::app_role
               and lower(btrim(ur.departamento)) = 'ti'
               and lower(btrim(coalesce(v_area, ''))) = 'ti'
               and v_estatus not in ('cerrada', 'no_reparado')
               and (nullif(btrim(ur.unidad_negocio), '') is null
                    or lower(btrim(ur.unidad_negocio)) = lower(btrim(v_unidad))))
         )
    )
  ) then
    return;
  end if;

  return query
  select r.folio_app, r.motivo, r.descripcion, c.correo, c.telefono, c.medio_contacto
    from biobox_app_reportes r
    left join biobox_app_contactos c on c.report_id = r.report_id
   where r.record_id = p_record_id
   order by r.report_id;
end
$function$;

revoke all on function public.datos_usuario_app_incidencia(text) from public, anon;
grant execute on function public.datos_usuario_app_incidencia(text) to authenticated;
