-- ============================================================
-- Reparaciones Digital que quedaron "Sin clasificar"
--
-- Sirve para diagnosticar y recuperar reparaciones hechas antes de guardar
-- incidencia_srd/arbol_digital_id. Solo completa una fila cuando la
-- combinación visible + causa + diagnóstico + solución encuentra UNA fila
-- inequívoca en arbol_digital. Las ambiguas no se tocan.
-- ============================================================

-- PASO 1 — Diagnóstico. `coincidencias = 1` se puede recuperar con seguridad.
with candidatas as (
  select
    i.record_id,
    i.folio,
    i.nombre_incidencia,
    i.causa_raiz,
    i.diagnostico,
    i.solucion,
    count(a.id) as coincidencias,
    min(a.id::text) as arbol_digital_id,
    min(a.incidencia_srd) as incidencia_srd
  from public.incidencias i
  left join public.arbol_digital a
    on lower(trim(a.incidencia)) = lower(trim(i.nombre_incidencia))
   and a.causa_raiz is not distinct from i.causa_raiz
   and a.diagnostico is not distinct from i.diagnostico
   and a.solucion is not distinct from i.solucion
  where lower(trim(coalesce(i.assigned_area, i.area_responsable, ''))) = 'digital'
    and i.incidencia_srd is null
    and i.causa_raiz is not null
    and i.solucion is not null
  group by i.record_id, i.folio, i.nombre_incidencia,
           i.causa_raiz, i.diagnostico, i.solucion
)
select *
from candidatas
order by coincidencias, folio;

-- PASO 2 — Completar únicamente las coincidencias exactas y únicas.
with unicas as (
  select
    i.record_id,
    (array_agg(a.id))[1] as arbol_id,
    min(a.incidencia_srd) as incidencia_srd
  from public.incidencias i
  join public.arbol_digital a
    on lower(trim(a.incidencia)) = lower(trim(i.nombre_incidencia))
   and a.causa_raiz is not distinct from i.causa_raiz
   and a.diagnostico is not distinct from i.diagnostico
   and a.solucion is not distinct from i.solucion
  where lower(trim(coalesce(i.assigned_area, i.area_responsable, ''))) = 'digital'
    and i.incidencia_srd is null
    and i.causa_raiz is not null
    and i.solucion is not null
  group by i.record_id
  having count(a.id) = 1
)
update public.incidencias i
set incidencia_srd = u.incidencia_srd,
    arbol_digital_id = u.arbol_id
from unicas u
where i.record_id = u.record_id
returning i.record_id, i.folio, i.nombre_incidencia,
          i.incidencia_srd, i.arbol_digital_id;

-- PASO 3 — Lo que siga aquí requiere clasificación manual; el SQL no adivina.
select record_id, folio, nombre_incidencia, causa_raiz, diagnostico, solucion
from public.incidencias
where lower(trim(coalesce(assigned_area, area_responsable, ''))) = 'digital'
  and incidencia_srd is null
order by fecha_reporte desc;
