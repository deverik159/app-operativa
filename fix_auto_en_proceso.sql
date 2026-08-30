-- ============================================================
-- fix_auto_en_proceso.sql — quitar el trigger que pisa el estatus
-- Correr en Supabase → SQL Editor, paso por paso.
--
-- EL BUG (Erik, 30-ago-2026): capturando en fin de semana, TODAS las
-- incidencias caían directo en 'en_proceso' sin pasar por el validador.
-- La regla real es: solo las de área Digital se auto-rutean fuera del
-- horario del validador; el resto SIEMPRE pasa por 'por_validar'.
--
-- LA CAUSA: el trigger inc_auto_en_proceso (BEFORE INSERT en incidencias)
-- cambia el estatus del lado del servidor y le gana a lo que manda la app.
-- El frontend YA implementa la regla completa y correcta:
--   · Nueva incidencia  → 'en_proceso' SOLO si area_responsable='Digital'
--                         Y fuera de horario (AREAS_AUTORUTEO en
--                         src/lib/constants.ts + fueraHorarioValidador).
--   · Revisión Biobox   → SIEMPRE 'por_validar' (decisión del 30-ago-2026:
--                         lo que nace de un checklist valida primero).
-- Con el trigger vivo, esa lógica de la app es letra muerta: el trigger
-- la pisa. Dos lugares decidiendo lo mismo terminan contradiciéndose —
-- se queda UNO (el frontend, que ya distingue los dos flujos) y el
-- trigger se va.
-- ============================================================

-- PASO 1 — Ver qué hace hoy el trigger, antes de tocarlo.
-- (Guarda el resultado por si algún día se quiere restaurar.)
select pg_get_triggerdef(t.oid) as trigger_def,
       pg_get_functiondef(p.oid) as function_def
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
where t.tgrelid = 'public.incidencias'::regclass
  and not t.tgisinternal
  and t.tgname ilike '%en_proceso%';

-- PASO 2 — Quitar el trigger (y su función si nada más la usa).
drop trigger if exists inc_auto_en_proceso on public.incidencias;
drop function if exists public.inc_auto_en_proceso();

-- PASO 3 — Diagnóstico de las filas que el trigger ya afectó:
-- capturadas recientemente, en 'en_proceso' sin haber pasado por
-- validación y SIN ser el auto-ruteo legítimo de Digital
-- (el legítimo lo marca la app con requiere_prevalidacion = true).
select record_id, folio, nombre_incidencia, area_responsable,
       estatus, requiere_prevalidacion, fecha_reporte, captured_by
from public.incidencias
where estatus = 'en_proceso'
  and coalesce(requiere_prevalidacion, false) = false
  and validator_email is null          -- nadie la validó de verdad
  and repaired_by_email is null        -- y nadie la ha trabajado
  and fecha_reporte >= now() - interval '7 days'
order by fecha_reporte desc;

-- PASO 4 (OPCIONAL) — Regresar esas filas a la cola del validador.
-- REVISA el resultado del paso 3 antes de descomentar: si alguna ya la
-- está atendiendo un técnico aunque no haya campos llenos, mejor dejarla.
--
-- update public.incidencias
-- set estatus = 'por_validar'
-- where estatus = 'en_proceso'
--   and coalesce(requiere_prevalidacion, false) = false
--   and validator_email is null
--   and repaired_by_email is null
--   and fecha_reporte >= now() - interval '7 days';
