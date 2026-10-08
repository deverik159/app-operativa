-- ============================================================
-- derivados_dia_cdmx — la semana y la catorcena de una incidencia nueva se
-- calculan con el día de la Ciudad de México, no el de UTC (8-oct-2026).
-- Re-ejecutable.
--
-- Por qué: la base corre en UTC y set_derivados tomaba
-- `fecha_reporte::date`. Lo reportado después de las 18:00 de México caía
-- en el día siguiente: un domingo en la noche contaba en la semana que
-- sigue, y el último día de una catorcena, en la catorcena siguiente (que
-- además decide la campaña). La app ya filtra y agrupa por día de CDMX
-- (src/lib/fechasCdmx.ts); la base dice lo mismo.
--
-- Solo cambia el día que se usa; la fórmula de la semana y la búsqueda de
-- la catorcena quedan igual. No toca filas existentes: al 8-oct-2026 había
-- 7 incidencias con distinto día UTC y CDMX, ninguna con distinta semana, y
-- la limpieza del piloto las borra.
-- ============================================================
create or replace function public.set_derivados()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare d date;
begin
  d := coalesce(
    (new.fecha_reporte at time zone 'America/Mexico_City')::date,
    (now() at time zone 'America/Mexico_City')::date
  );
  if new.semana is null then
    new.semana := (floor((d - date '2026-01-05') / 7.0) + 1)::int::text;
  end if;
  if new.catorcena is null then
    select numero into new.catorcena from catorcenas
    where d between fecha_inicio and fecha_fin
    limit 1;
  end if;
  return new;
end $$;

-- Verificar: debe decir "America/Mexico_City".
select position('America/Mexico_City' in pg_get_functiondef('public.set_derivados'::regproc)) > 0
  as usa_cdmx;
