-- ============================================================
-- biobox_causas.sql — causas y prioridades por punto del checklist Biobox
-- Correr en Supabase → SQL Editor. Re-ejecutable: el PASO 1 no duplica y
-- el PASO 3 re-siembra completo (la tabla es de este archivo).
--
-- Viene del Excel BIOBOX-CAUSAS-Y-PRIORIDAD corregido (Erik, 17-sep-2026):
-- al marcar ANOMALÍA en la revisión, el revisor ya no escribe texto libre —
-- elige la causa de una LISTA CERRADA, y la causa trae su prioridad, la
-- incidencia del catálogo que se levanta sola y una nota de acción que se
-- suma a las observaciones. Sin causas para un punto, el flujo libre de
-- siempre sigue funcionando.
--
-- El ÁREA de cada incidencia NO viaja en las causas: la decide el catálogo,
-- como en todo el sistema. Las áreas de los 10 detalles NUEVOS del PASO 1
-- las decidió Erik (17-sep): Teltonika dañado y revisión remota → TI;
-- Apagado parcial y Falta arte → Digital; Falla en apertura → Op. Bio Box
-- ("Biotech" del Excel no existe como área); el resto → Op. Bio Box.
-- ============================================================

-- ══ PASO 1 — Detalles NUEVOS del catálogo (no duplica si ya existen) ══
insert into public.catalogo_incidencias
  (detalle, area, impacto, origen, tipo, tipo_mueble, unidad_negocio)
select v.detalle, v.area, v.impacto, v.origen, v.tipo, v.tipo_mueble, v.unidad
from (values
  ('SD300 fuera de línea', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M4', 'Biobox'),
  ('SD300 fuera de línea', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M4-R2', 'Biobox'),
  ('SD300 fuera de línea', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M5', 'Biobox'),
  ('SD300 fuera de línea', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M4 URBANA', 'Biobox'),
  ('SD300 fuera de línea', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M5 OXXO', 'Biobox'),
  ('Chapa dañada', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M4', 'Biobox'),
  ('Chapa dañada', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M4-R2', 'Biobox'),
  ('Chapa dañada', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M5', 'Biobox'),
  ('Chapa dañada', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M4 URBANA', 'Biobox'),
  ('Chapa dañada', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M5 OXXO', 'Biobox'),
  ('Pérdida de juego de llaves', 'Op. Bio Box', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M4', 'Biobox'),
  ('Pérdida de juego de llaves', 'Op. Bio Box', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M4-R2', 'Biobox'),
  ('Pérdida de juego de llaves', 'Op. Bio Box', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M5', 'Biobox'),
  ('Pérdida de juego de llaves', 'Op. Bio Box', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M4 URBANA', 'Biobox'),
  ('Pérdida de juego de llaves', 'Op. Bio Box', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M5 OXXO', 'Biobox'),
  ('Soldadura dañada', 'Op. Bio Box', 'Alto', 'Externo', 'Vandalismo', 'M4', 'Biobox'),
  ('Soldadura dañada', 'Op. Bio Box', 'Alto', 'Externo', 'Vandalismo', 'M4-R2', 'Biobox'),
  ('Soldadura dañada', 'Op. Bio Box', 'Alto', 'Externo', 'Vandalismo', 'M5', 'Biobox'),
  ('Soldadura dañada', 'Op. Bio Box', 'Alto', 'Externo', 'Vandalismo', 'M4 URBANA', 'Biobox'),
  ('Soldadura dañada', 'Op. Bio Box', 'Alto', 'Externo', 'Vandalismo', 'M5 OXXO', 'Biobox'),
  ('Falla en apertura de Biobox', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M4', 'Biobox'),
  ('Falla en apertura de Biobox', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M4-R2', 'Biobox'),
  ('Falla en apertura de Biobox', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M5', 'Biobox'),
  ('Falla en apertura de Biobox', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M4 URBANA', 'Biobox'),
  ('Falla en apertura de Biobox', 'Op. Bio Box', 'Alto', 'Externo', 'Imponderable', 'M5 OXXO', 'Biobox'),
  ('Teltonika dañado', 'TI', 'Medio', 'Externo', 'Imponderable', 'M4', 'Biobox'),
  ('Teltonika dañado', 'TI', 'Medio', 'Externo', 'Imponderable', 'M4-R2', 'Biobox'),
  ('Teltonika dañado', 'TI', 'Medio', 'Externo', 'Imponderable', 'M5', 'Biobox'),
  ('Teltonika dañado', 'TI', 'Medio', 'Externo', 'Imponderable', 'M4 URBANA', 'Biobox'),
  ('Teltonika dañado', 'TI', 'Medio', 'Externo', 'Imponderable', 'M5 OXXO', 'Biobox'),
  ('Teltonika revisión remota', 'TI', 'Medio', 'Externo', 'Imponderable', 'M4', 'Biobox'),
  ('Teltonika revisión remota', 'TI', 'Medio', 'Externo', 'Imponderable', 'M4-R2', 'Biobox'),
  ('Teltonika revisión remota', 'TI', 'Medio', 'Externo', 'Imponderable', 'M5', 'Biobox'),
  ('Teltonika revisión remota', 'TI', 'Medio', 'Externo', 'Imponderable', 'M4 URBANA', 'Biobox'),
  ('Teltonika revisión remota', 'TI', 'Medio', 'Externo', 'Imponderable', 'M5 OXXO', 'Biobox'),
  ('Apagado parcial', 'Digital', 'Alto', 'Externo', 'Imponderable', 'M4', 'Biobox'),
  ('Apagado parcial', 'Digital', 'Alto', 'Externo', 'Imponderable', 'M4-R2', 'Biobox'),
  ('Apagado parcial', 'Digital', 'Alto', 'Externo', 'Imponderable', 'M5', 'Biobox'),
  ('Apagado parcial', 'Digital', 'Alto', 'Externo', 'Imponderable', 'M4 URBANA', 'Biobox'),
  ('Apagado parcial', 'Digital', 'Alto', 'Externo', 'Imponderable', 'M5 OXXO', 'Biobox'),
  ('Falta arte', 'Digital', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M4', 'Biobox'),
  ('Falta arte', 'Digital', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M4-R2', 'Biobox'),
  ('Falta arte', 'Digital', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M5', 'Biobox'),
  ('Falta arte', 'Digital', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M4 URBANA', 'Biobox'),
  ('Falta arte', 'Digital', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M5 OXXO', 'Biobox'),
  ('Arte institucional', 'Op. Bio Box', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M4', 'Biobox'),
  ('Arte institucional', 'Op. Bio Box', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M4-R2', 'Biobox'),
  ('Arte institucional', 'Op. Bio Box', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M5', 'Biobox'),
  ('Arte institucional', 'Op. Bio Box', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M4 URBANA', 'Biobox'),
  ('Arte institucional', 'Op. Bio Box', 'Alto', 'Interno', 'Desviaciones de Procedimiento', 'M5 OXXO', 'Biobox')
) as v(detalle, area, impacto, origen, tipo, tipo_mueble, unidad)
where not exists (
  select 1 from public.catalogo_incidencias c
  where c.detalle = v.detalle
    and coalesce(c.area, '') = v.area
    and coalesce(c.tipo_mueble, '') = v.tipo_mueble
    and coalesce(c.unidad_negocio, '') ilike v.unidad
);

-- ══ PASO 2 — Tabla de causas por punto ══
create table if not exists public.checklist_causas (
  id             bigserial primary key,
  -- 'Ambas' | 'Impresa' | 'Digital': a qué medio de máquina aplica.
  medio          text not null check (medio in ('Ambas', 'Impresa', 'Digital')),
  grupo          text,
  -- Empata por TEXTO con checklist_puntos.texto (igual que
  -- incidencia_sugerida empata por detalle): editar el texto de un punto
  -- desliga sus causas — el PASO 4 lo detecta.
  punto_texto    text not null,
  causa          text not null,
  prioridad      text check (prioridad in ('Alta', 'Media', 'Baja')),
  genera_orden   boolean not null default true,
  -- detalle de catalogo_incidencias que se levanta (null = solo registro).
  incidencia_detalle text,
  -- Acción sugerida: se suma a las observaciones de la incidencia.
  nota           text,
  tipo_mueble    text not null,
  creado_en      timestamptz not null default now()
);

alter table public.checklist_causas enable row level security;
grant select on public.checklist_causas to authenticated;
drop policy if exists checklist_causas_sel on public.checklist_causas;
create policy checklist_causas_sel on public.checklist_causas
  for select to authenticated
  using (nullif(lower(coalesce(auth_email(), '')), '') is not null);
-- Sin política de escritura: las causas se cargan por aquí, no desde la app.

-- ══ PASO 3 — Siembra (re-siembra completa; textos ya corregidos) ══
delete from public.checklist_causas;

insert into public.checklist_causas
  (medio, grupo, punto_texto, causa, prioridad, genera_orden,
   incidencia_detalle, nota, tipo_mueble)
values
  ('Ambas', 'Energía y conexión', 'La máquina tiene energía', 'Biobox apagado', 'Alta', true, 'UPS fuera de línea', null, 'M4'),
  ('Ambas', 'Energía y conexión', 'La máquina tiene energía', 'Biobox apagado', 'Alta', true, 'UPS fuera de línea', null, 'M4-R2'),
  ('Ambas', 'Energía y conexión', 'La máquina tiene energía', 'Biobox apagado', 'Alta', true, 'UPS fuera de línea', null, 'M5'),
  ('Ambas', 'Energía y conexión', 'La máquina tiene energía', 'Biobox apagado', 'Alta', true, 'SD300 fuera de línea', null, 'M4'),
  ('Ambas', 'Energía y conexión', 'La máquina tiene energía', 'Biobox apagado', 'Alta', true, 'SD300 fuera de línea', null, 'M4-R2'),
  ('Ambas', 'Energía y conexión', 'La máquina tiene energía', 'Biobox apagado', 'Alta', true, 'SD300 fuera de línea', null, 'M5'),
  ('Ambas', 'Energía y conexión', 'La máquina tiene energía', 'AR Totalplay', 'Alta', true, 'Modem con fallas', null, 'M4'),
  ('Ambas', 'Energía y conexión', 'La máquina tiene energía', 'AR Totalplay', 'Alta', true, 'Modem con fallas', null, 'M4-R2'),
  ('Ambas', 'Energía y conexión', 'La máquina tiene energía', 'AR Totalplay', 'Alta', true, 'Modem con fallas', null, 'M5'),
  ('Ambas', 'Energía y conexión', 'El Teltonika está en línea', 'Fallas con Arduino', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M4'),
  ('Ambas', 'Energía y conexión', 'El Teltonika está en línea', 'Fallas con Arduino', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M4-R2'),
  ('Ambas', 'Energía y conexión', 'El Teltonika está en línea', 'Fallas con Arduino', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M5'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Fallas con Cilindro', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M4'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Fallas con Cilindro', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M4-R2'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Fallas con Cilindro', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M5'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Falla en Placa PCB de Arduino', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M4'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Falla en Placa PCB de Arduino', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M4-R2'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Falla en Placa PCB de Arduino', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M5'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Fallas en Cortina', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M4'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Fallas en Cortina', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M4-R2'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Fallas en Cortina', 'Alta', true, 'Falla en el proceso de reciclaje', null, 'M5'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Abono de puntos', 'Alta', true, 'Fallas con la aplicación', null, 'M4'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Abono de puntos', 'Alta', true, 'Fallas con la aplicación', null, 'M4-R2'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Abono de puntos', 'Alta', true, 'Fallas con la aplicación', null, 'M5'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Suciedad', 'Alta', true, 'Suciedad', null, 'M4'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Suciedad', 'Alta', true, 'Suciedad', null, 'M4-R2'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Suciedad', 'Alta', true, 'Suciedad', null, 'M5'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Sensor de mano', 'Alta', true, 'Falla en el sensor de mano', null, 'M4'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Sensor de mano', 'Alta', true, 'Falla en el sensor de mano', null, 'M4-R2'),
  ('Ambas', 'Energía y conexión', 'Robot', 'Sensor de mano', 'Alta', true, 'Falla en el sensor de mano', null, 'M5'),
  ('Ambas', 'Llaves/Chapa', 'Llave frontal inferior', 'No cierra o marca error de cierre', 'Alta', true, 'Chapa dañada', 'Revisión remota de cierre y validación en sitio; Validación física, cierre ejecutado y validado; Cambio de chapas en caso de no ejecutar el cierre al 100%', 'M4-R2'),
  ('Ambas', 'Llaves/Chapa', 'Llave frontal inferior', 'Daño en las Chapas', 'Alta', true, 'Chapa dañada', 'Cambio de chapa física por daño', 'M4'),
  ('Ambas', 'Llaves/Chapa', 'Llave frontal inferior', 'Daño en las Chapas', 'Alta', true, 'Chapa dañada', 'Cambio de chapa física por daño', 'M5'),
  ('Ambas', 'Llaves/Chapa', 'Llave de gabinete', 'Daño en las Chapas', 'Alta', true, 'Chapa dañada', 'Cambio de chapa física por daño', 'M4'),
  ('Ambas', 'Llaves/Chapa', 'Llave de gabinete', 'Daño en las Chapas', 'Alta', true, 'Chapa dañada', 'Cambio de chapa física por daño', 'M5'),
  ('Ambas', 'Llaves/Chapa', 'Hay copias de las llaves en el COV', 'Llaves Perdidas', 'Alta', true, 'Pérdida de juego de llaves', 'Reporte para reposición de juego de llaves', 'M4'),
  ('Ambas', 'Llaves/Chapa', 'Hay copias de las llaves en el COV', 'Llaves Perdidas', 'Alta', true, 'Pérdida de juego de llaves', 'Reporte para reposición de juego de llaves', 'M5'),
  ('Ambas', 'Seguridad', 'Puertas cerradas y soldaduras íntegras', 'Puertas abiertas o daño en soldaduras', 'Alta', true, 'Puertas / copetes abiertos', 'Cierre de puertas físicamente; Reporte de envío de equipo de Op. Biobox para cierre de daño o cambio físico', 'M4'),
  ('Ambas', 'Seguridad', 'Puertas cerradas y soldaduras íntegras', 'Puertas abiertas o daño en soldaduras', 'Alta', true, 'Puertas / copetes abiertos', 'Cierre de puertas físicamente; Reporte de envío de equipo de Op. Biobox para cierre de daño o cambio físico', 'M5'),
  ('Ambas', 'Seguridad', 'Puertas cerradas y soldaduras íntegras', 'Puertas abiertas o daño en soldaduras', 'Alta', true, 'Soldadura dañada', 'Reporte de envío de soldador', 'M4'),
  ('Ambas', 'Seguridad', 'Puertas cerradas y soldaduras íntegras', 'Puertas abiertas o daño en soldaduras', 'Alta', true, 'Soldadura dañada', 'Reporte de envío de soldador', 'M5'),
  ('Ambas', 'Seguridad', 'El NUC está en su lugar y asegurado', 'NUC no asegurado con soldadura', 'Alta', true, 'Soldadura dañada', 'Reporte de envío de soldador para asegurar el NUC', 'M4'),
  ('Ambas', 'Seguridad', 'El NUC está en su lugar y asegurado', 'NUC no asegurado con soldadura', 'Alta', true, 'Soldadura dañada', 'Reporte de envío de soldador para asegurar el NUC', 'M5'),
  ('Ambas', 'Seguridad', 'El NUC está en su lugar y asegurado', 'NUC dañado', 'Alta', true, 'NUC con fallas', 'Cambio físico de NUC', 'M4'),
  ('Ambas', 'Seguridad', 'El NUC está en su lugar y asegurado', 'NUC dañado', 'Alta', true, 'NUC con fallas', 'Cambio físico de NUC', 'M5'),
  ('Ambas', 'Seguridad', 'El NUC está en su lugar y asegurado', 'NUC dañado', 'Alta', true, 'NUC con fallas', 'Cambio físico de NUC', 'M4-R2'),
  ('Ambas', 'Seguridad', 'El NUC está en su lugar y asegurado', 'NUC en R2 dentro de Bioguard', 'Alta', true, 'NUC fuera de línea', 'Revisión con SRD', 'M4-R2'),
  ('Ambas', 'Seguridad', 'Bioguard presente y en su lugar', 'Daño en aperturas de Biobox', 'Alta', true, 'Falla en apertura de Biobox', 'Cambio de placa o tarjeta lógica', 'M4-R2'),
  ('Ambas', 'Seguridad', 'Bioguard presente y en su lugar', 'Daño en GPS', 'Media', true, 'Teltonika dañado', 'Cambio físico de placa o tarjeta lógica', 'M4-R2'),
  ('Ambas', 'Seguridad', 'Bioguard presente y en su lugar', 'Falta de registros de GPS', 'Media', true, 'Teltonika revisión remota', 'Cambio físico o revisión con SRD para diagnóstico', 'M4-R2'),
  ('Ambas', 'Seguridad', 'Bioguard presente y en su lugar', 'Falta de registros de GPS', 'Media', true, 'Teltonika revisión remota', 'Cambio físico o revisión con SRD para diagnóstico', 'M5'),
  ('Ambas', 'Seguridad', 'Bioguard presente y en su lugar', 'Falta de registros de GPS', 'Media', true, 'Teltonika revisión remota', 'Cambio físico o revisión con SRD para diagnóstico', 'M4'),
  ('Ambas', 'Estado general', 'Gabinete sin golpes ni piezas faltantes', 'Biobox con siniestro', 'Alta', true, 'Daños estructurales', 'Cambio de equipo y reporte a aseguradora', 'M4'),
  ('Ambas', 'Estado general', 'Gabinete sin golpes ni piezas faltantes', 'Biobox con siniestro', 'Alta', true, 'Daños estructurales', 'Cambio de equipo y reporte a aseguradora', 'M4-R2'),
  ('Ambas', 'Estado general', 'Gabinete sin golpes ni piezas faltantes', 'Biobox con siniestro', 'Alta', true, 'Daños estructurales', 'Cambio de equipo y reporte a aseguradora', 'M5'),
  ('Ambas', 'Estado general', 'Gabinete sin golpes ni piezas faltantes', 'Biobox robado', 'Alta', true, 'Robo parcial estructura', 'Identificar faltantes, soldado de máquina', 'M4'),
  ('Ambas', 'Estado general', 'Gabinete sin golpes ni piezas faltantes', 'Biobox robado', 'Alta', true, 'Robo parcial estructura', 'Identificar faltantes, soldado de máquina', 'M4-R2'),
  ('Ambas', 'Estado general', 'Gabinete sin golpes ni piezas faltantes', 'Biobox robado', 'Alta', true, 'Robo parcial estructura', 'Identificar faltantes, soldado de máquina', 'M5'),
  ('Ambas', 'Estado general', 'Gabinete sin golpes ni piezas faltantes', 'Biobox vandalizado', 'Alta', true, 'Brandeo con grafiti', 'Reporte por grafitis, vidrios rotos, brandeo dañado, implementación dañada', 'M4'),
  ('Ambas', 'Estado general', 'Gabinete sin golpes ni piezas faltantes', 'Biobox vandalizado', 'Alta', true, 'Brandeo con grafiti', 'Reporte por grafitis, vidrios rotos, brandeo dañado, implementación dañada', 'M4-R2'),
  ('Ambas', 'Estado general', 'Gabinete sin golpes ni piezas faltantes', 'Biobox vandalizado', 'Alta', true, 'Brandeo con grafiti', 'Reporte por grafitis, vidrios rotos, brandeo dañado, implementación dañada', 'M5'),
  ('Ambas', 'Estado general', 'Sin grafiti, calcomanías ni rayones', 'Biobox con artes dañados', 'Alta', true, 'Arte dañado', 'Reporte de cambio de artes según campaña o institucionales', 'M4'),
  ('Ambas', 'Estado general', 'Sin grafiti, calcomanías ni rayones', 'Biobox con artes dañados', 'Alta', true, 'Arte dañado', 'Reporte de cambio de artes según campaña o institucionales', 'M4-R2'),
  ('Ambas', 'Estado general', 'Sin grafiti, calcomanías ni rayones', 'Biobox con artes dañados', 'Alta', true, 'Arte dañado', 'Reporte de cambio de artes según campaña o institucionales', 'M5'),
  ('Ambas', 'Estado general', 'Máquina limpia y área alrededor despejada', 'Biobox incidencia en el entorno', 'Media', true, 'Obstrucción al mueble', 'Reporte de Biobox con basura, vegetación, camiones y construcciones', 'M4'),
  ('Ambas', 'Estado general', 'Máquina limpia y área alrededor despejada', 'Biobox incidencia en el entorno', 'Media', true, 'Obstrucción al mueble', 'Reporte de Biobox con basura, vegetación, camiones y construcciones', 'M4-R2'),
  ('Ambas', 'Estado general', 'Máquina limpia y área alrededor despejada', 'Biobox incidencia en el entorno', 'Media', true, 'Obstrucción al mueble', 'Reporte de Biobox con basura, vegetación, camiones y construcciones', 'M5'),
  ('Impresa', 'Publicidad', 'Arte / lona completo, sin roturas ni desprendimientos', 'Biobox Artes Campañas', 'Alta', true, 'Arte dañado', 'Reporte de arte dañado, falta de arte, arte descontinuado', 'M4'),
  ('Impresa', 'Publicidad', 'Arte / lona completo, sin roturas ni desprendimientos', 'Biobox Artes Campañas', 'Alta', true, 'Arte dañado', 'Reporte de arte dañado, falta de arte, arte descontinuado', 'M4-R2'),
  ('Impresa', 'Publicidad', 'Arte / lona completo, sin roturas ni desprendimientos', 'Biobox Artes Campañas', 'Alta', true, 'Arte dañado', 'Reporte de arte dañado, falta de arte, arte descontinuado', 'M5'),
  ('Impresa', 'Publicidad', 'Arte / lona completo, sin roturas ni desprendimientos', 'Biobox Artes Campañas', 'Alta', true, 'Arte con versión incorrecta', 'Versión incorrecta', 'M4'),
  ('Impresa', 'Publicidad', 'Arte / lona completo, sin roturas ni desprendimientos', 'Biobox Artes Campañas', 'Alta', true, 'Arte con versión incorrecta', 'Versión incorrecta', 'M4-R2'),
  ('Impresa', 'Publicidad', 'Arte / lona completo, sin roturas ni desprendimientos', 'Biobox Artes Campañas', 'Alta', true, 'Arte con versión incorrecta', 'Versión incorrecta', 'M5'),
  ('Impresa', 'Publicidad', 'Arte / lona completo, sin roturas ni desprendimientos', 'Biobox Artes Campañas', 'Alta', true, 'Arte institucional', 'Falta de arte, dañado, arte descontinuado', 'M4'),
  ('Impresa', 'Publicidad', 'Arte / lona completo, sin roturas ni desprendimientos', 'Biobox Artes Campañas', 'Alta', true, 'Arte institucional', 'Falta de arte, dañado, arte descontinuado', 'M4-R2'),
  ('Impresa', 'Publicidad', 'Arte / lona completo, sin roturas ni desprendimientos', 'Biobox Artes Campañas', 'Alta', true, 'Arte institucional', 'Falta de arte, dañado, arte descontinuado', 'M5'),
  ('Impresa', 'Publicidad', 'La iluminación del panel enciende y alumbra completa', 'Biobox con Back apagado', 'Media', true, 'Apagado', 'Reporte de revisión de configuración SRD, reporte de revisión física', 'M4'),
  ('Impresa', 'Publicidad', 'La iluminación del panel enciende y alumbra completa', 'Biobox con Back apagado', 'Media', true, 'Apagado', 'Reporte de revisión de configuración SRD, reporte de revisión física', 'M4-R2'),
  ('Impresa', 'Publicidad', 'La iluminación del panel enciende y alumbra completa', 'Biobox con Back apagado', 'Media', true, 'Apagado', 'Reporte de revisión de configuración SRD, reporte de revisión física', 'M5'),
  ('Impresa', 'Publicidad', 'La iluminación del panel enciende y alumbra completa', 'Biobox con Back apagado parcial', 'Media', true, 'Apagado parcial', 'Reporte de revisión de configuración SRD, reporte de revisión física', 'M4'),
  ('Impresa', 'Publicidad', 'La iluminación del panel enciende y alumbra completa', 'Biobox con Back apagado parcial', 'Media', true, 'Apagado parcial', 'Reporte de revisión de configuración SRD, reporte de revisión física', 'M4-R2'),
  ('Impresa', 'Publicidad', 'La iluminación del panel enciende y alumbra completa', 'Biobox con Back apagado parcial', 'Media', true, 'Apagado parcial', 'Reporte de revisión de configuración SRD, reporte de revisión física', 'M5'),
  ('Digital', 'Pantalla', 'La pantalla enciende y se ve completa', 'Biobox con pantalla apagada', 'Alta', true, 'Apagado', 'Reporte de revisión de configuración SRD, reporte de revisión física a Iluminación', 'M4'),
  ('Digital', 'Pantalla', 'La pantalla enciende y se ve completa', 'Biobox con pantalla apagada', 'Alta', true, 'Apagado', 'Reporte de revisión de configuración SRD, reporte de revisión física a Iluminación', 'M4-R2'),
  ('Digital', 'Pantalla', 'La pantalla enciende y se ve completa', 'Biobox con pantalla apagada', 'Alta', true, 'Apagado', 'Reporte de revisión de configuración SRD, reporte de revisión física a Iluminación', 'M5'),
  ('Digital', 'Pantalla', 'La pantalla enciende y se ve completa', 'Biobox con pantalla apagado parcial', 'Alta', true, 'Apagado parcial', 'Reporte de revisión de configuración SRD, reporte de revisión física', 'M4'),
  ('Digital', 'Pantalla', 'La pantalla enciende y se ve completa', 'Biobox con pantalla apagado parcial', 'Alta', true, 'Apagado parcial', 'Reporte de revisión de configuración SRD, reporte de revisión física', 'M4-R2'),
  ('Digital', 'Pantalla', 'La pantalla enciende y se ve completa', 'Biobox con pantalla apagado parcial', 'Alta', true, 'Apagado parcial', 'Reporte de revisión de configuración SRD, reporte de revisión física', 'M5'),
  ('Digital', 'Pantalla', 'La pantalla enciende y se ve completa', 'Biobox con pantalla sin artes', 'Alta', true, 'Falta arte', 'reporte a SRD para check de artes', 'M4'),
  ('Digital', 'Pantalla', 'La pantalla enciende y se ve completa', 'Biobox con pantalla sin artes', 'Alta', true, 'Falta arte', 'reporte a SRD para check de artes', 'M4-R2'),
  ('Digital', 'Pantalla', 'La pantalla enciende y se ve completa', 'Biobox con pantalla sin artes', 'Alta', true, 'Falta arte', 'reporte a SRD para check de artes', 'M5'),
  ('Digital', 'Contenido', 'Está reproduciendo el loop, no una pantalla de error', 'Biobox artes Campañas digitales', 'Alta', true, 'Falta arte', 'Reporte de arte dañado, imagen, arte descontinuado, arte con versión incorrecta', 'M4'),
  ('Digital', 'Contenido', 'Está reproduciendo el loop, no una pantalla de error', 'Biobox artes Campañas digitales', 'Alta', true, 'Falta arte', 'Reporte de arte dañado, imagen, arte descontinuado, arte con versión incorrecta', 'M4-R2'),
  ('Digital', 'Contenido', 'Está reproduciendo el loop, no una pantalla de error', 'Biobox artes Campañas digitales', 'Alta', true, 'Falta arte', 'Reporte de arte dañado, imagen, arte descontinuado, arte con versión incorrecta', 'M5');

-- ══ PASO 4 — VERIFICAR ══

-- a) Causas cuyo punto NO existe en el checklist actual (0 filas = todo
--    liga; si sale algo, o el punto se renombró o el Excel lo escribió
--    distinto — pásame el resultado).
select distinct c.punto_texto
from public.checklist_causas c
where not exists (
  select 1 from public.checklist_puntos p
  where lower(trim(p.texto)) = lower(trim(c.punto_texto))
);

-- b) Causas cuya incidencia NO existe en el catálogo de Biobox para su
--    mueble (0 filas = el PASO 1 cubrió todo).
select distinct c.incidencia_detalle, c.tipo_mueble
from public.checklist_causas c
where c.incidencia_detalle is not null
  and not exists (
    select 1 from public.catalogo_incidencias k
    where k.detalle = c.incidencia_detalle
      and coalesce(k.tipo_mueble, '') = c.tipo_mueble
      and coalesce(k.unidad_negocio, '') ilike 'Biobox%'
  );

-- c) Conteos por medio y grupo, para ojear.
select medio, grupo, count(*) as causas
from public.checklist_causas
group by medio, grupo
order by medio, grupo;
