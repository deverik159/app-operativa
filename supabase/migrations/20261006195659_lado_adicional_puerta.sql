-- ============================================================
-- lado_adicional_puerta — la "cara afectada" (incidencias.lado) acepta
-- 'Adicional' y 'Puerta' (Erik, 6-oct-2026). Re-ejecutable.
--
-- Por qué: si la incidencia es del Adicional ("Adicional dañado") o de la
-- Puerta ("Puertas / copetes abiertos"), en Nueva incidencia ya no se eligen
-- caras: se guarda UNA fila con el elemento en `lado` (sin clave de medio si
-- el sitio tiene varias caras), que tarjeta, reparación, indicadores y Excel
-- ya enseñan como la cara.
-- Hasta ahora el CHECK solo dejaba Norte, Sur, Ambas y los pórticos.
--
-- Va en UN solo bloque: el SQL Editor no garantiza la misma conexión entre
-- sentencias. Tira el CHECK de `lado` (sea cual sea su nombre, como
-- incidencias_lado_porticos.sql) y lo vuelve a crear con los 7 valores.
-- `lado` se busca como PALABRA: con '%lado%' caería también un CHECK que
-- mencione, p. ej., 'cancelado'.
-- ============================================================
do $$
declare
  r record;
begin
  perform set_config('lock_timeout', '5s', true);
  for r in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.incidencias'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ~* '\mlado\M'
  loop
    execute format('alter table public.incidencias drop constraint %I', r.conname);
  end loop;

  alter table public.incidencias
    add constraint incidencias_lado_check
    check (lado is null or lado in
      ('Norte', 'Sur', 'Ambas', 'Norte a Sur', 'Sur a Norte', 'Adicional', 'Puerta'));
end $$;

-- Verificar: una sola fila con los 7 valores.
select con.conname, pg_get_constraintdef(con.oid) as definicion
from pg_constraint con
where con.conrelid = 'public.incidencias'::regclass
  and con.conname = 'incidencias_lado_check';
