-- ============================================================
-- diagnostico_catalogo_biobox.sql — cómo queda el desplegable de Biobox
-- con la unión "árbol de Digital + catálogo sin el área Digital"
-- (Erik, 27-sep-2026). Solo LECTURA: no modifica nada.
--
-- Correr en Supabase → SQL Editor. Sale UNA sola tabla, por secciones:
--   1 · Muebles de las máquinas y si el catálogo los conoce.
--   2 · Filas Digital del catálogo que DEJAN de salir (su nombre no está
--       en el árbol). Si alguna hace falta, se agrega al árbol con ese
--       mismo texto.
--   3 · Nombres que están en el árbol Y en el catálogo con otra área:
--       salen UNA vez, con el área y el texto del catálogo.
--   4 · Nombres que se verían repetidos en el desplegable de una máquina
--       (varias áreas, o la misma escrita de dos formas). Lo normal: vacío.
--   5 · Nombres que el árbol escribe de varias formas (salen repetidos).
--       Lo normal: vacío.
--   6 · Mismo nombre en el árbol y en una fila Digital del catálogo pero
--       escrito distinto (mayúsculas, acentos, espacios). La app guarda el
--       texto del árbol y la revisión de Biobox el del catálogo: la regla
--       de duplicados compara texto exacto y no los empata, y lo que
--       levanta la revisión se repara sin clasificación guiada. Arreglo:
--       dejar el detalle del catálogo IGUAL al del árbol. Lo normal: vacío.
--   7 · Cuántas opciones verá cada tipo de máquina.
--
-- Mismas reglas que la app (src/lib/catalogo.ts → catalogoBiobox): el
-- catálogo se acota al mueble de la máquina y los nombres se comparan sin
-- acentos, mayúsculas ni espacios de sobra (incluidos saltos de línea y
-- espacios duros que llegan pegados de Excel).
-- ============================================================
with
cat0 as (
  select c.unidad_negocio, c.tipo_mueble, c.detalle, c.area,
         -- Como String.trim() de JS: también saltos de línea, tabuladores
         -- y espacios duros, no solo ' '.
         regexp_replace(c.tipo_mueble,
           '^[\s   -     　﻿]+|[\s   -     　﻿]+$',
           '', 'g') as mueble_t,
         regexp_replace(coalesce(c.area, ''),
           '^[\s   -     　﻿]+|[\s   -     　﻿]+$',
           '', 'g') as area_t,
         -- Llave de nombre, como llaveNombre() de la app: sin acentos
         -- (NFD y fuera las marcas), en minúsculas, espacios colapsados.
         lower(regexp_replace(regexp_replace(regexp_replace(
           normalize(c.detalle, NFD),
           '[̀-ͯ]', '', 'g'),
           '[\s   -     　﻿]+', ' ', 'g'),
           '^ | $', '', 'g')) as k
  from public.catalogo_incidencias c
  where (c.unidad_negocio ilike 'biobox' or c.unidad_negocio ilike 'biobox perú')
    and coalesce(c.detalle, '') <> ''
),
cat as (
  select trim(unidad_negocio) as unidad,
         lower(trim(unidad_negocio)) as unidad_k,
         nullif(mueble_t, '') as mueble,
         lower(nullif(mueble_t, '')) as mueble_k,
         detalle, area,
         lower(area_t) = 'digital' as es_digital,
         k
  from cat0
),
arbol as (
  select distinct nombre,
         lower(regexp_replace(regexp_replace(regexp_replace(
           normalize(nombre, NFD),
           '[̀-ͯ]', '', 'g'),
           '[\s   -     　﻿]+', ' ', 'g'),
           '^ | $', '', 'g')) as k
  from (
    select regexp_replace(a.incidencia,
             '^[\s   -     　﻿]+|[\s   -     　﻿]+$',
             '', 'g') as nombre
    from public.arbol_digital a
  ) x
  where coalesce(nombre, '') <> ''
),
maq as (
  select trim(i.unidad_negocio) as unidad,
         lower(trim(i.unidad_negocio)) as unidad_k,
         coalesce(min(trim(i.tipo_mueble)), '(sin mueble)') as mueble,
         lower(nullif(trim(i.tipo_mueble), '')) as mueble_k,
         count(distinct i.site_id) as maquinas,
         count(*) filter (where lower(trim(i.tipo_medio)) = 'digital') as digitales,
         count(*) filter (where lower(trim(i.tipo_medio)) like 'impres%') as impresas
  from public.inventario i
  where i.unidad_negocio ilike 'biobox' or i.unidad_negocio ilike 'biobox perú'
  group by trim(i.unidad_negocio), lower(trim(i.unidad_negocio)),
           lower(nullif(trim(i.tipo_mueble), ''))
)
select * from (

  -- 1 · Muebles de las máquinas
  select '1 · Muebles de las máquinas'::text as seccion,
         m.unidad, m.mueble, null::text as detalle, null::text as area,
         m.maquinas || ' máquinas (' || m.digitales || ' caras digitales, '
           || m.impresas || ' impresas) · '
           || case
                when exists (select 1 from cat c
                             where c.unidad_k = m.unidad_k and c.mueble_k = m.mueble_k)
                then (select count(*) from cat c
                      where c.unidad_k = m.unidad_k and c.mueble_k = m.mueble_k)
                     || ' filas en el catálogo'
                else '⚠️ el catálogo no tiene este mueble: la app enseña todo el catálogo de la unidad'
              end as nota
  from maq m

  union all

  -- 2 · Dejan de salir
  select '2 · Dejan de salir (Digital del catálogo, no está en el árbol)',
         c.unidad, string_agg(distinct c.mueble, ', '), c.detalle, c.area,
         'Si hace falta: agregarla al árbol con este mismo texto'
  from cat c
  where c.es_digital
    and not exists (select 1 from arbol a where a.k = c.k)
  group by c.unidad, c.detalle, c.area

  union all

  -- 3 · En el árbol y en el catálogo con otra área
  select '3 · En el árbol y con otra área en el catálogo: sale una vez, con esa área',
         c.unidad, string_agg(distinct c.mueble, ', '), c.detalle, c.area,
         'En el árbol: ' || (select string_agg(distinct a.nombre, ' / ')
                             from arbol a where a.k = c.k)
  from cat c
  where not c.es_digital
    and exists (select 1 from arbol a where a.k = c.k)
    and not exists (select 1 from cat d
                    where d.es_digital
                      and d.unidad_k = c.unidad_k
                      and d.mueble_k is not distinct from c.mueble_k
                      and d.k = c.k)
  group by c.unidad, c.detalle, c.area, c.k

  union all

  -- 4 · Se verían repetidos en una máquina
  select '4 · Se verían repetidos en el desplegable de una máquina',
         min(c.unidad), min(c.mueble), min(c.detalle),
         string_agg(distinct coalesce(c.area, '(sin área)'), ' + '),
         'Formas: ' || string_agg(distinct c.detalle || ' [' || coalesce(c.area, '') || ']', ' / ')
           || case when bool_or(c.es_digital)
                   then ' · la de Digital solo sale si el árbol trae el nombre'
                   else '' end
  from cat c
  group by c.unidad_k, c.mueble_k, c.k
  having count(distinct c.detalle || '||' || coalesce(c.area, ''))
           filter (where not c.es_digital) > 1
      or (bool_or(c.es_digital) and bool_or(not c.es_digital))

  union all

  -- 5 · El árbol escribe un nombre de varias formas
  select '5 · El árbol escribe el mismo nombre de varias formas: salen repetidos',
         null, null, string_agg(a.nombre, ' / ' order by a.nombre), 'Digital',
         'Conviene dejar una sola forma en el árbol'
  from arbol a
  group by a.k
  having count(*) > 1

  union all

  -- 6 · Fila Digital del catálogo escrita distinto que el árbol
  select '6 · Digital: el catálogo lo escribe distinto que el árbol',
         c.unidad, string_agg(distinct c.mueble, ', '), c.detalle, c.area,
         'En el árbol: ' || (select string_agg(distinct a.nombre, ' / ')
                             from arbol a where a.k = c.k)
           || ' · dejar el detalle del catálogo igual al del árbol'
  from cat c
  where c.es_digital
    and exists (select 1 from arbol a where a.k = c.k)
    and not exists (select 1 from arbol a where a.nombre = c.detalle)
  group by c.unidad, c.detalle, c.area, c.k

  union all

  -- 7 · Opciones que verá cada tipo de máquina
  select '7 · Opciones que verá cada tipo de máquina',
         m.unidad, m.mueble, null, null,
         n.del_arbol || ' del árbol − ' || n.absorbidos
           || ' que el catálogo da a otra área + ' || n.otras
           || ' del catálogo sin Digital = ' || (n.del_arbol - n.absorbidos + n.otras)
           || ' opciones'
  from maq m
  cross join lateral (
    select
      (select count(*) from arbol) as del_arbol,
      (select count(*) from arbol a
        where exists (select 1 from cat c
                      where not c.es_digital and c.unidad_k = m.unidad_k
                        and c.mueble_k = m.mueble_k and c.k = a.k)
          and not exists (select 1 from cat c
                          where c.es_digital and c.unidad_k = m.unidad_k
                            and c.mueble_k = m.mueble_k and c.k = a.k)) as absorbidos,
      (select count(distinct c.detalle || '||' || coalesce(c.area, ''))
        from cat c
        where not c.es_digital and c.unidad_k = m.unidad_k
          and c.mueble_k = m.mueble_k) as otras
  ) n
  where exists (select 1 from cat c
                where c.unidad_k = m.unidad_k and c.mueble_k = m.mueble_k)

) t
order by seccion, unidad nulls first, mueble nulls first, detalle;
