-- ============================================================
-- bitacora_vv_artes.sql — los visuales de cada versión de la Bitácora VV
-- Correr una vez en Supabase → SQL Editor (después de bitacora_vv.sql).
--
-- POR QUÉ (Erik, 22-sep-2026): cada hoja del Excel traía los ARTES de la
-- campaña — HOMBRE-MEX_A.jpg, MATADOR_B.jpg, MUJER-MEX_PORT.jpg… Sin el
-- visual, "cambiar a R2_MUJER-MEX" es solo texto: pautas no sabe qué
-- debe quedar al aire. Aquí cada versión guarda sus imágenes, con
-- variantes por tipo de espacio (A, B, pórtico) como en el archivo.
--
-- Los archivos van al bucket `evidencias` (el único del proyecto), en la
-- carpeta bitacora-vv/, comprimidos por lib/comprimirImagen como todas
-- las fotos de la app. Esta tabla solo guarda la referencia.
-- ============================================================

create table if not exists vv_artes (
  id          bigserial primary key,
  campana_id  bigint not null references vv_campanas(id) on delete cascade,
  version     text not null,             -- a cuál versión pertenece el arte
  etiqueta    text,                      -- variante: A, B, PORT… (del nombre del archivo)
  url         text not null,
  subido_por  text not null,
  subido_en   timestamptz not null default now()
);

create index if not exists vv_artes_campana_idx on vv_artes (campana_id, version);

alter table vv_artes enable row level security;
grant select, insert, delete on vv_artes to authenticated;

drop policy if exists vva_sel on vv_artes;
create policy vva_sel on vv_artes for select to authenticated
  using (tiene_rol('comercial'::app_role) or tiene_rol('pautas'::app_role)
         or tiene_rol('manager'::app_role));

drop policy if exists vva_ins on vv_artes;
create policy vva_ins on vv_artes for insert to authenticated
  with check ((tiene_rol('comercial'::app_role) or tiene_rol('manager'::app_role))
              and lower(subido_por) = lower(auth_email()));

drop policy if exists vva_del on vv_artes;
create policy vva_del on vv_artes for delete to authenticated
  using (tiene_rol('comercial'::app_role) or tiene_rol('manager'::app_role));

-- Verificación: deben salir las tres políticas.
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'vv_artes';
