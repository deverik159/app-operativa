-- ============================================================
-- pauta_schema.sql
-- Pauta por catorcena: qué campaña va en cada cara, y el avance de monitoreo.
--
-- DECISIÓN DE DISEÑO CENTRAL — dos tablas, no una:
--
--   `pautas`            → lo que viene DEL ARCHIVO. Se reemplaza completo al
--                         reimportar una catorcena.
--   `pauta_monitoreo`   → lo que genera LA APP (fecha de toma, comprobación,
--                         quién y cuándo). NO se toca al reimportar.
--
-- Si todo viviera en una sola tabla, volver a subir el Excel —cosa que pasa
-- seguido, por correcciones y cortes— borraría el trabajo de campo ya
-- registrado. Separarlas hace que reimportar sea una operación segura.
--
-- Aplicar en el SQL Editor de Supabase.
-- ============================================================


-- ------------------------------------------------------------
-- 1) pautas — datos del archivo
-- ------------------------------------------------------------
create table if not exists pautas (
  id                bigserial primary key,

  -- Periodo. `catorcena` es el número (16); `etiqueta` el texto de la hoja
  -- ('CAT 16 (15) 21JUL-03AGO'), útil para mostrar y para rastrear el origen.
  catorcena         int  not null,
  etiqueta          text,

  -- Identidad de la valla. Las dos llaves que ya usa el resto del sistema:
  -- site_id cruza con ruta_ubicaciones, vendor_face_id con inventario.
  site_id           text not null,
  vendor_face_id    text not null,
  clave             text,
  cara              text,

  -- Ubicación según el archivo. La dirección se guarda porque para las
  -- plazas que no están en inventario es el ÚNICO dato de ubicación que hay.
  direccion         text,
  id_estado         text,
  estado            text,
  id_medio          text,
  medio             text,

  -- Ruta. `ruta_clave` guarda el valor tal cual del archivo ('1'..'8',
  -- 'PLAZA', 'EDOMEX'); `ruta_numero` solo se llena cuando es numérico.
  -- Las foráneas quedan con ruta_numero NULL: se ven en búsquedas y reportes,
  -- pero no entran al recorrido del monitorista.
  ruta_clave        text,
  ruta_numero       int,
  secuencia         int,

  -- Comercial y operativo
  contract_number   text,
  orden_fijacion    text,
  campana           text,   -- Campaign Version de ESTA catorcena
  version           text,   -- VERSIÓN (nombre del arte)
  campana_anterior  text,   -- Campaign Version de la catorcena previa
  estatus           text,   -- NUEVO | REPITE
  corte             text,
  sales_person      text,
  espec_fijacion    text,
  espec_toma        text,

  -- Fechas DEL ARCHIVO. Se conservan como referencia histórica; el avance
  -- real lo lleva `pauta_monitoreo`.
  fecha_fijacion              date,
  fecha_toma_archivo          date,
  fecha_comprobacion_archivo  date,
  fecha_modificacion          date,

  observaciones_campo     text,
  observaciones_analista  text,
  detalle_observaciones   text,
  comentarios             text,

  importado_en      timestamptz default now(),
  importado_por     text
);

-- Llave natural de una fila de pauta.
--
-- No basta vendor_face_id: una misma cara puede aparecer legítimamente varias
-- veces —dos campañas distintas, o REPITE + NUEVO por un corte a media
-- catorcena—. Con contrato y corte se distinguen esos casos reales y, de
-- paso, se colapsan los duplicados exactos que trae el archivo (hay caras
-- repetidas hasta 12 veces con el mismo contrato).
--
-- coalesce: en Postgres dos NULL no chocan en un UNIQUE, así que sin esto los
-- duplicados con corte vacío se colarían.
create unique index if not exists pautas_llave_uk
  on pautas (catorcena, vendor_face_id,
             coalesce(contract_number,''), coalesce(corte,''));

create index if not exists pautas_site_idx      on pautas (site_id);
create index if not exists pautas_catorcena_idx on pautas (catorcena);
create index if not exists pautas_campana_idx   on pautas (catorcena, campana);
create index if not exists pautas_ruta_idx      on pautas (catorcena, ruta_numero);


-- ------------------------------------------------------------
-- 2) pauta_monitoreo — lo que registra la app
-- ------------------------------------------------------------
-- Sobrevive a las reimportaciones. Se liga por (catorcena, vendor_face_id):
-- a nivel cara, aunque haya varios contratos, el trabajo físico es uno solo
-- —se toma la foto de esa cara una vez, no una por contrato—.
create table if not exists pauta_monitoreo (
  id                  bigserial primary key,
  catorcena           int  not null,
  vendor_face_id      text not null,

  -- Toma: el monitorista está en el sitio y captura las fotos.
  fecha_toma          timestamptz,
  toma_por            text,

  -- Comprobación: se entrega el trabajo.
  fecha_comprobacion  timestamptz,
  comprobacion_por    text,

  notas               text,
  actualizado_en      timestamptz default now(),

  unique (catorcena, vendor_face_id)
);

create index if not exists pauta_monit_cat_idx on pauta_monitoreo (catorcena);


-- ------------------------------------------------------------
-- 3) Vista: pauta + avance + coordenadas + ruta
-- ------------------------------------------------------------
-- Es lo que consume el frontend. Trae `navegable` ya resuelto para que la
-- app no tenga que adivinar si puede ofrecer el botón de navegación.
create or replace view vw_pauta_ruta as
select
  p.id,
  p.catorcena,
  p.etiqueta,
  p.site_id,
  p.vendor_face_id,
  p.cara,
  p.direccion,
  p.estado,
  p.medio,
  p.ruta_clave,
  p.ruta_numero,
  p.secuencia,
  p.campana,
  p.version,
  p.campana_anterior,
  p.estatus,
  p.corte,
  p.contract_number,
  p.orden_fijacion,
  p.fecha_fijacion,

  -- Avance real (de la app), con la fecha del archivo como respaldo.
  m.fecha_toma,
  m.toma_por,
  m.fecha_comprobacion,
  m.comprobacion_por,
  p.fecha_toma_archivo,
  p.fecha_comprobacion_archivo,

  -- Estado de avance, ya calculado: es el que ordena la vista del monitorista.
  case
    when m.fecha_comprobacion is not null then 'COMPROBADA'
    when m.fecha_toma          is not null then 'TOMADA'
    else 'PENDIENTE'
  end as avance,

  -- Coordenadas del inventario. La pauta NO trae lat/lng: es la única fuente.
  inv.latitud,
  inv.longitud,
  (inv.latitud is not null and inv.longitud is not null) as navegable,

  -- ¿El sitio ya está asignado a una ruta de monitoreo del sistema?
  ru.ruta_id as ruta_monitoreo_id

from pautas p
left join pauta_monitoreo m
       on m.catorcena = p.catorcena
      and m.vendor_face_id = p.vendor_face_id
left join lateral (
  select latitud, longitud
  from inventario
  where vendor_face_id = p.vendor_face_id
  limit 1
) inv on true
left join ruta_ubicaciones ru on ru.site_id = p.site_id;


-- ------------------------------------------------------------
-- 4) Vista de resumen por ruta y campaña
-- ------------------------------------------------------------
-- Responde de un jalón: "¿qué campañas hay en la ruta 3 y cómo van?"
create or replace view vw_pauta_resumen as
select
  catorcena,
  ruta_clave,
  campana,
  count(*)                                            as caras,
  count(distinct site_id)                             as sitios,
  count(*) filter (where estatus = 'NUEVO')           as nuevas,
  count(*) filter (where estatus = 'REPITE')          as repiten,
  count(*) filter (where avance = 'PENDIENTE')        as pendientes,
  count(*) filter (where avance = 'TOMADA')           as tomadas,
  count(*) filter (where avance = 'COMPROBADA')       as comprobadas,
  count(*) filter (where not navegable)               as sin_coordenadas
from vw_pauta_ruta
group by catorcena, ruta_clave, campana;


-- ------------------------------------------------------------
-- 5) RLS
-- ------------------------------------------------------------
alter table pautas          enable row level security;
alter table pauta_monitoreo enable row level security;

-- Lectura: cualquier usuario autenticado. La pauta no es dato sensible y
-- todos los roles necesitan consultarla.
drop policy if exists pauta_sel on pautas;
create policy pauta_sel on pautas for select
  using (auth_email() is not null);

-- Escritura de la pauta: solo quien coordina. Se usan las funciones que ya
-- existen (tiene_rol), NUNCA una función nueva redundante.
drop policy if exists pauta_ins on pautas;
create policy pauta_ins on pautas for insert
  with check (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role));

drop policy if exists pauta_upd on pautas;
create policy pauta_upd on pautas for update
  using (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role));

drop policy if exists pauta_del on pautas;
create policy pauta_del on pautas for delete
  using (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role));

-- Avance de monitoreo: lo escribe quien va a campo (reparacion/fijador),
-- además de coordinación. Por eso es más abierto que la pauta.
drop policy if exists pmon_sel on pauta_monitoreo;
create policy pmon_sel on pauta_monitoreo for select
  using (auth_email() is not null);

drop policy if exists pmon_ins on pauta_monitoreo;
create policy pmon_ins on pauta_monitoreo for insert
  with check (auth_email() is not null);

drop policy if exists pmon_upd on pauta_monitoreo;
create policy pmon_upd on pauta_monitoreo for update
  using (auth_email() is not null);


-- ------------------------------------------------------------
-- 6) Verificación
-- ------------------------------------------------------------
-- Después de aplicar, esto debe correr sin error y devolver 0 filas.
select count(*) as filas_pauta from pautas;
select count(*) as filas_avance from pauta_monitoreo;
select * from vw_pauta_resumen limit 5;
