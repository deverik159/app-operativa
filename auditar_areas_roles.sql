-- ============================================================
-- Auditoría de áreas en usuario_roles — SOLO LECTURA
--
-- Separa dos conceptos que comparten la columna `departamento`:
--   Reportante / Validador  → área de pertenencia del usuario.
--   Técnico / Coordinador   → área técnica que puede atender incidencias.
--
-- No modifica ningún permiso. Sirve para localizar los roles históricos que
-- fueron creados cuando ambos catálogos aparecían mezclados en la app.
-- ============================================================

-- 1) Todos los roles actuales, agrupados por usuario para revisión humana.
select
  lower(usuario_email) as correo,
  rol,
  coalesce(unidad_negocio, 'Todas las unidades') as unidad,
  coalesce(departamento, 'SIN ÁREA') as area,
  coalesce(medio, '—') as medio
from usuario_roles
order by lower(usuario_email), rol, unidad, area;


-- 2) Reportantes y validadores con un área técnica o sin área de pertenencia.
-- Áreas válidas de pertenencia: Monitoreo, Operaciones, SRD y PPD.
select
  'Usuario/validador con área incorrecta o faltante' as hallazgo,
  lower(usuario_email) as correo,
  rol,
  unidad_negocio,
  departamento
from usuario_roles
where rol in ('reportante', 'validador')
  and (
    departamento is null
    or lower(trim(departamento)) not in ('monitoreo', 'operaciones', 'srd', 'ppd')
  )
order by rol, lower(usuario_email);


-- 3) Roles técnicos con un área de usuario o un área ajena a su unidad.
-- Un Coordinador sin área puede ser intencional: conserva acceso a todas las
-- áreas de SU unidad. Se muestra como alcance amplio, no como configuración
-- incorrecta. Un Técnico sin área sí requiere revisión prioritaria.
with areas_tecnicas(unidad, area) as (
  values
    ('biobox', 'op. bio box'),
    ('biobox', 'ti'),
    ('biobox', 'implementaciones'),
    ('biobox', 'digital'),
    ('biobox', 'iluminación'),
    ('digital', 'digital'),
    ('digital', 'ti'),
    ('digital', 'iluminación'),
    ('urban', 'mantenimiento'),
    ('ecovallas', 'mantenimiento'),
    ('ecovallas', 'fijación'),
    ('ecovallas', 'digital'),
    ('ecovallas', 'implementaciones'),
    ('ecovallas', 'instalaciones'),
    ('ecovallas', 'iluminación'),
    ('vía verde', 'mantenimiento'),
    ('vía verde', 'fijación'),
    ('vía verde', 'digital'),
    ('vía verde', 'implementaciones'),
    ('vía verde', 'instalaciones'),
    ('vía verde', 'iluminación'),
    ('verde vertical', 'mantenimiento'),
    ('verde vertical', 'fijación'),
    ('verde vertical', 'digital'),
    ('verde vertical', 'implementaciones'),
    ('verde vertical', 'instalaciones'),
    ('verde vertical', 'iluminación'),
    ('biobox perú', 'op. bio box'),
    ('biobox perú', 'ti'),
    ('biobox perú', 'implementaciones'),
    ('biobox perú', 'digital'),
    ('biobox perú', 'iluminación')
)
select
  case
    when ur.rol = 'coordinador' and ur.departamento is null
      then 'Coordinador con alcance amplio (revisar si es intencional)'
    else 'Técnico/coordinador con área incorrecta o faltante'
  end as hallazgo,
  lower(ur.usuario_email) as correo,
  ur.rol,
  ur.unidad_negocio,
  ur.departamento,
  case
    when ur.rol = 'coordinador' and ur.departamento is null
      then 'Sin área: coordina todas las áreas de su unidad'
    when ur.departamento is null then 'Sin área: puede atender todas las áreas de su unidad'
    when ur.unidad_negocio is null then 'Sin unidad: revisar alcance global'
    else 'El área no corresponde a la unidad técnica'
  end as motivo
from usuario_roles ur
where ur.rol in ('reparacion', 'coordinador')
  and (
    ur.departamento is null
    or ur.unidad_negocio is null
    or not exists (
      select 1
      from areas_tecnicas a
      where a.unidad = lower(trim(ur.unidad_negocio))
        and a.area = lower(trim(ur.departamento))
    )
  )
order by ur.rol, lower(ur.usuario_email);


-- 4) Áreas efectivas de incidencias sin técnico configurado que pueda
-- atenderlas. Aquí sí hay riesgo de que un trabajo quede inaccesible.
with tecnicos as (
  select distinct
    lower(trim(coalesce(unidad_negocio, ''))) as unidad,
    lower(trim(coalesce(departamento, ''))) as area
  from usuario_roles
  where rol in ('reparacion', 'coordinador')
), abiertas as (
  select distinct
    unidad_negocio,
    coalesce(assigned_area, area_responsable) as area_efectiva
  from incidencias
  where estatus in ('en_proceso', 'reparado')
)
select
  a.unidad_negocio,
  a.area_efectiva,
  'No hay técnico/coordinador con este alcance' as hallazgo
from abiertas a
where a.area_efectiva is not null
  and not exists (
    select 1
    from tecnicos t
    where (t.unidad = '' or lower(trim(a.unidad_negocio)) = t.unidad)
      and (t.area = '' or lower(trim(a.area_efectiva)) = t.area)
  )
order by a.unidad_negocio, a.area_efectiva;
