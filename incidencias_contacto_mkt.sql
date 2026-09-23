-- ============================================================
-- incidencias_contacto_mkt.sql — contacto de quien pide el reporte (MKT)
-- Correr una vez en Supabase → SQL Editor. Re-ejecutable.
--
-- MKT reporta incidencias EN NOMBRE de terceros (Erik, 22-sep-2026): el
-- alta les pide correo y teléfono del solicitante para poder regresarle
-- respuesta. Solo el flujo de MKT los captura; en las demás áreas van null.
-- El área que reporta ya viaja en `area_reportante` (misDep[0] al crear):
-- de ahí salen el filtro "Reporta" y los indicadores de MKT, sin columnas
-- nuevas para eso.
-- ============================================================

alter table public.incidencias
  add column if not exists contacto_correo text,
  add column if not exists contacto_telefono text;

comment on column public.incidencias.contacto_correo is
  'Correo de quien pidió el reporte (captura MKT). Null fuera de ese flujo.';
comment on column public.incidencias.contacto_telefono is
  'Teléfono de quien pidió el reporte (captura MKT). Null fuera de ese flujo.';

-- Verificar:
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'incidencias'
  and column_name in ('contacto_correo', 'contacto_telefono');
