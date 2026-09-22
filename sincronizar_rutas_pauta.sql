-- ============================================================
-- sincronizar_rutas_pauta.sql — las rutas de la pauta pueblan Rutas
-- Correr en Supabase → SQL Editor.
--
-- EL HUECO (Erik, 22-sep-2026): el archivo de pauta YA trae la ruta y la
-- secuencia de cada sitio, pero el módulo de Rutas se alimentaba de OTRO
-- Excel aparte. Consecuencias: doble captura, y los sitios cuya ruta no
-- existe en rutas_monitoreo quedan sin ruta_monitoreo_id — o sea, sin
-- poder asignarse a un monitorista.
--
-- QUÉ HACE: sincronizar_rutas_desde_pauta(catorcena) toma los sitios de
-- esa catorcena con ruta NUMÉRICA (las foráneas PLAZA/EDOMEX no son rutas
-- de monitoreo y se omiten), arma las filas y las pasa por la RPC
-- importar_rutas de siempre — el mismo pipeline del Excel de rutas, con
-- sus mismas validaciones contra inventario. Re-ejecutarla es seguro:
-- actualiza secuencias y solo crea las rutas que falten.
-- ============================================================

-- PASO 0 (diagnóstico) — la firma exacta de importar_rutas, por si el
-- parámetro de filas fuera `json` en vez de `jsonb` (entonces en la
-- función de abajo se cambia `v_filas` por `v_filas::json`):
select p.proname, pg_get_function_arguments(p.oid) as firma
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'importar_rutas';

-- PASO 1 — la sincronización.
create or replace function public.sincronizar_rutas_desde_pauta(
  p_catorcena int
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_filas    jsonb;
  v_sitios   int;
  v_foraneos int;
  v_res      jsonb;
begin
  if not (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo coordinador o manager pueden sincronizar rutas.';
  end if;

  -- Un renglón por SITIO: la secuencia más chica de sus caras (todas
  -- traen la misma en el archivo, pero por si acaso), estatus ACTIVA
  -- (está en la pauta vigente) y la dirección del archivo.
  select jsonb_agg(fila), count(*)
    into v_filas, v_sitios
  from (
    select jsonb_build_object(
             'site_id',   site_id,
             'ruta',      (ruta_clave)::int,
             'secuencia', min(secuencia),
             'estatus',   'ACTIVA',
             'vallas',    null,
             'direccion', coalesce(max(direccion), '')
           ) as fila
    from pautas
    where catorcena = p_catorcena
      and ruta_clave ~ '^\d+$'
    group by site_id, ruta_clave
  ) s;

  select count(distinct site_id) into v_foraneos
  from pautas
  where catorcena = p_catorcena
    and (ruta_clave is null or ruta_clave !~ '^\d+$');

  if v_sitios is null or v_sitios = 0 then
    raise exception 'La catorcena % no tiene sitios con ruta numérica.', p_catorcena;
  end if;

  -- El pipeline de siempre: crea rutas faltantes, actualiza secuencias y
  -- valida contra inventario. Pauta es Ecovallas Impreso.
  v_res := importar_rutas('Ecovallas', 'Impreso', v_filas);

  return v_res || jsonb_build_object(
    'sitios_en_pauta', v_sitios,
    'foraneos_omitidos', v_foraneos
  );
end;
$$;

grant execute on function public.sincronizar_rutas_desde_pauta(int) to authenticated;

-- PASO 2 — verificación: sincroniza desde la app (botón 🗺️ en Pauta) o a
-- mano y confirma que ya no queden sitios de la catorcena sin ruta del
-- módulo (fuera de los foráneos):
--   select count(*) from vw_pauta_ruta
--   where catorcena = <N> and ruta_clave ~ '^\d+$' and ruta_monitoreo_id is null;
