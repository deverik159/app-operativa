-- ============================================================
-- duplicados_en_proceso — la regla de duplicidad ve TODO lo que está en
-- proceso, no solo lo que la RLS deja ver a quien captura (8-oct-2026).
-- Re-ejecutable.
--
-- Por qué: duplicadasEnProceso() (src/lib/duplicados.ts) consultaba
-- `incidencias` directo, y la RLS filtra: el monitorista solo ve lo que él
-- capturó y el reportante lo suyo y lo de su área de pertenencia. La
-- incidencia igual que capturó otra persona era invisible, la regla
-- contestaba "sin choques" y el duplicado entraba. Es el mismo problema que
-- Biobox ya resolvió con la RPC estado_maquina (30-ago-2026).
--
-- Qué hace: una función SECURITY DEFINER que devuelve solo lo que la regla
-- compara (folio, incidencia, cara, sitio, lado, unidad, medio) de las
-- incidencias en proceso con esas caras o sitios y esos nombres. No
-- devuelve observaciones, fotos, contactos ni quién capturó. La regla (qué
-- cuenta como igual) sigue en la app, sin cambios.
-- ============================================================
create or replace function public.incidencias_en_proceso_iguales(
  p_caras text[],
  p_sitios text[],
  p_nombres text[]
)
returns table (
  folio text,
  nombre_incidencia text,
  clave_medio text,
  clave_sitio text,
  lado text,
  unidad_negocio text,
  medio text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if auth_email() is null then
    raise exception 'Hay que iniciar sesión.' using errcode = '42501';
  end if;

  return query
  select i.folio, i.nombre_incidencia, i.clave_medio, i.clave_sitio, i.lado,
         i.unidad_negocio, i.medio
  from incidencias i
  where i.estatus = 'en_proceso'
    and i.nombre_incidencia = any(coalesce(p_nombres, '{}'))
    and (i.clave_medio = any(coalesce(p_caras, '{}'))
         or i.clave_sitio = any(coalesce(p_sitios, '{}')))
  limit 1000;
end $$;

revoke all on function public.incidencias_en_proceso_iguales(text[], text[], text[]) from public, anon;
grant execute on function public.incidencias_en_proceso_iguales(text[], text[], text[]) to authenticated;

-- Verificar: una fila, prosecdef = true.
select proname, prosecdef
from pg_proc
where proname = 'incidencias_en_proceso_iguales'
  and pronamespace = 'public'::regnamespace;
