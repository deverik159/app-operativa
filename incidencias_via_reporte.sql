-- ============================================================
-- incidencias_via_reporte.sql — por dónde llegó la solicitud (MKT)
-- Correr una vez en Supabase → SQL Editor. Re-ejecutable.
--
-- Completa el flujo de incidencias_contacto_mkt.sql (Erik, 22-sep-2026):
-- además del contacto del solicitante, se guarda la VÍA por la que pidió
-- el reporte. El CHECK acepta solo las cuatro vías reales o NULL (todo lo
-- capturado fuera del flujo de MKT, y lo histórico, va en NULL) — mismo
-- criterio que el CHECK de `lado`.
-- ============================================================

alter table public.incidencias
  add column if not exists via_reporte text;

alter table public.incidencias
  drop constraint if exists incidencias_via_reporte_check;

alter table public.incidencias
  add constraint incidencias_via_reporte_check
  check (via_reporte is null
         or via_reporte in ('WhatsApp', 'Instagram', 'Facebook', 'Correo'));

comment on column public.incidencias.via_reporte is
  'Vía por la que llegó la solicitud del reporte (captura MKT): WhatsApp, Instagram, Facebook o Correo. Null fuera de ese flujo.';

-- Verificar: la columna y su CHECK.
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'incidencias'
  and column_name = 'via_reporte';
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname = 'incidencias_via_reporte_check';
