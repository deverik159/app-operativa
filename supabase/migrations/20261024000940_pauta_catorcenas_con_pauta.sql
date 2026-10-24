-- ============================================================
-- pauta_catorcenas_con_pauta — las catorcenas que tienen pauta, en un viaje
-- (pendiente técnico de Pauta, 24-oct-2026).
--
-- POR QUÉ. El selector de Pauta se armaba con una consulta POR catorcena
-- (hasta 120 en serie), cada una con un OR que no usa el índice como rango
-- y recorre otra vez las ~1,200 filas de cada catorcena más nueva: costo
-- cuadrático y N idas y vueltas. Con 2 catorcenas no se nota; con 26 al año
-- sí.
--
-- QUÉ CAMBIA. Una función SQL estable, security INVOKER (respeta pauta_sel:
-- cualquiera con sesión), que devuelve distinct (anio, catorcena) de pautas
-- de la más nueva a la más vieja usando el índice pautas_catorcena_idx. La
-- app la llama en lugar del bucle (PautaView, leerCatorcenasPauta).
-- Re-ejecutable.
-- ============================================================

create or replace function public.pauta_catorcenas_con_pauta()
returns table (anio integer, catorcena integer)
language sql
stable
security invoker
set search_path to 'public'
as $function$
  select distinct p.anio::integer, p.catorcena::integer
    from public.pautas p
   order by 1 desc, 2 desc
$function$;

revoke all on function public.pauta_catorcenas_con_pauta() from public, anon;
grant execute on function public.pauta_catorcenas_con_pauta() to authenticated, service_role;
