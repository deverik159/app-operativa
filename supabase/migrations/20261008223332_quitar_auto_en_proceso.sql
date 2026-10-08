-- ============================================================
-- quitar_auto_en_proceso — ahora sí se elimina el trigger que pisa el
-- estatus inicial (Erik lo decidió el 30-ago-2026). Re-ejecutable.
--
-- Por qué: fix_auto_en_proceso.sql (30-ago-2026) hacía
-- `drop trigger if exists inc_auto_en_proceso`, pero el trigger se llama
-- trg_inc_auto_en_proceso. El "if exists" no encontró nada y no avisó, así
-- que el trigger siguió vivo hasta el 8-oct-2026 (el HANDOFF lo daba por
-- eliminado). Hace lo contrario de la regla de Erik:
--   · manda a 'en_proceso', sin validador y sin prevalidación, TODA
--     incidencia de medio Digital fuera de L-V 9:00-18:00, de cualquier
--     área (la regla es: solo el área Digital, y con prevalidación);
--   · usa 9:00-18:00, y el horario del validador es 9:30-18:30;
--   · se guía por fecha_reporte, que pone el reloj del teléfono.
-- Visto en la base: BBMM00014 (Op. Bio Box, domingo) se cerró sin pasar por
-- validador, y BBM500004 (jueves 18:13, dentro del horario del validador)
-- entró en proceso sin prevalidación.
--
-- El estatus inicial lo decide solo la app (crearReporte.ts:
-- AREAS_AUTORUTEO + fueraHorarioValidador), como dice el HANDOFF §3.1.
-- ============================================================
drop trigger if exists trg_inc_auto_en_proceso on public.incidencias;
drop trigger if exists inc_auto_en_proceso on public.incidencias;
drop function if exists public.inc_auto_en_proceso();

-- Verificar: cero filas.
select t.tgname
from pg_trigger t
where t.tgrelid = 'public.incidencias'::regclass
  and not t.tgisinternal
  and t.tgname ilike '%auto_en_proceso%';
