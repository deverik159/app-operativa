-- ============================================================
-- revisiones_schema.sql
-- Hoja de vida / checklist de revisión en campo.
--
-- Nace para Biobox (revisar máquinas por ruta), pero NO se amarra a Biobox:
-- la plantilla trae `unidad_negocio` y `tipo_medio`, así que mañana Ecovallas
-- o Vía Verde pueden tener la suya sin tocar el esquema.
--
-- CUATRO DECISIONES QUE CONVIENE ENTENDER ANTES DE MODIFICAR ESTO:
--
-- 1) El checklist es CATÁLOGO, no código.
--    Los puntos a revisar viven en `checklist_puntos` y se editan desde la
--    app. Si estuvieran hardcodeados, cada ajuste sería un despliegue.
--
-- 2) La respuesta guarda una COPIA del texto del punto.
--    `revision_respuestas.punto_texto` no es redundancia por descuido: el
--    checklist se va a editar con el tiempo, y una revisión de hace seis
--    meses tiene que seguir leyéndose tal como se contestó. Si solo
--    guardáramos el `punto_id`, renombrar un punto reescribiría el pasado.
--
-- 3) Una anomalía NO es una incidencia todavía.
--    Marcar un punto en anomalía deja constancia en la revisión. Convertirla
--    en incidencia es un acto aparte y explícito, y cuando pasa, la
--    respuesta se queda con el `record_id` para poder rastrear de dónde
--    salió. Así el historial de la máquina no se infla con incidencias
--    duplicadas por cada visita.
--
-- 4) La revisión se guarda de un jalón con una RPC.
--    En campo la señal se cae. Insertar el encabezado y luego 15 respuestas
--    en llamadas separadas deja revisiones a medias, que son peores que una
--    revisión que falló. `guardar_revision` es una sola transacción.
--
-- Es seguro re-ejecutar este archivo completo: todo es idempotente.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Plantillas de checklist
-- ------------------------------------------------------------
create table if not exists checklist_plantillas (
  id              bigserial primary key,
  nombre          text not null,
  unidad_negocio  text not null,
  -- NULL = aplica a cualquier tipo de medio de esa unidad.
  tipo_medio      text,
  descripcion     text,
  activa          boolean not null default true,
  creada_por      text,
  creada_en       timestamptz default now()
);

-- coalesce en el índice: en Postgres dos NULL no chocan, así que sin él se
-- podrían crear dos plantillas "General" para la misma unidad con tipo NULL.
create unique index if not exists chk_plant_unica
  on checklist_plantillas (unidad_negocio, coalesce(tipo_medio, ''), nombre);


-- ------------------------------------------------------------
-- 2) Puntos a revisar
-- ------------------------------------------------------------
create table if not exists checklist_puntos (
  id              bigserial primary key,
  plantilla_id    bigint not null
                    references checklist_plantillas (id) on delete cascade,

  -- `orden` decide cómo se ve en el celular. Deliberadamente SIN unique:
  -- reordenar una lista con un índice único obliga a hacer malabares con
  -- valores temporales. Los empates se rompen por id.
  orden           int not null default 0,
  -- Agrupa visualmente: 'Estructura', 'Publicidad', 'Operación'…
  grupo           text,
  texto           text not null,
  -- Ayuda para el revisor: qué cuenta como "bien".
  ayuda           text,

  -- Si este punto sale en anomalía, ésta es la incidencia que se propone.
  -- Empata con catalogo_incidencias.detalle. Puede quedar NULL: entonces el
  -- revisor elige del catálogo completo.
  incidencia_sugerida text,

  exige_foto_anomalia boolean not null default true,
  -- Un punto crítico en anomalía sugiere marcar la máquina fuera de servicio.
  critico         boolean not null default false,
  activo          boolean not null default true
);

create index if not exists chk_puntos_plant_idx
  on checklist_puntos (plantilla_id, orden);


-- ------------------------------------------------------------
-- 3) Revisiones (una por visita a una máquina)
-- ------------------------------------------------------------
create table if not exists revisiones (
  id              bigserial primary key,
  plantilla_id    bigint references checklist_plantillas (id),

  -- Identidad de la máquina. site_id es la llave que comparte con rutas;
  -- vendor_face_id se guarda cuando la máquina tiene una sola cara.
  site_id         text not null,
  vendor_face_id  text,
  unidad_negocio  text,
  -- Copia legible del nombre: si mañana cambia en inventario, la revisión
  -- sigue diciendo a qué máquina se fue.
  nombre_maquina  text,
  direccion       text,
  ruta_id         bigint references rutas_monitoreo (id),

  revisado_por    text,
  revisado_en     timestamptz default now(),

  -- Dónde estaba el revisor al guardar. Es la evidencia de que sí fue.
  -- Puede venir NULL: el GPS falla y no se va a bloquear el trabajo por eso.
  lat             double precision,
  lng             double precision,

  -- 'operando' | 'con_falla' | 'fuera_de_linea'
  estado_maquina  text,
  observaciones   text,

  puntos_ok        int default 0,
  puntos_anomalia  int default 0,
  puntos_na        int default 0,

  creado_en       timestamptz default now()
);

create index if not exists rev_site_idx on revisiones (site_id, revisado_en desc);
create index if not exists rev_ruta_idx on revisiones (ruta_id, revisado_en desc);
create index if not exists rev_por_idx  on revisiones (lower(revisado_por));


-- ------------------------------------------------------------
-- 4) Respuestas
-- ------------------------------------------------------------
create table if not exists revision_respuestas (
  id              bigserial primary key,
  revision_id     bigint not null
                    references revisiones (id) on delete cascade,

  -- Se conserva la referencia al punto, pero puede quedar NULL si el punto
  -- se borró del catálogo. El texto es la fuente de verdad histórica.
  punto_id        bigint references checklist_puntos (id) on delete set null,
  punto_texto     text not null,
  grupo           text,
  orden           int,

  valor           text not null
                    check (valor in ('ok', 'anomalia', 'na')),
  nota            text,

  -- Se llena cuando la anomalía se convirtió en incidencia.
  incidencia_record_id text references incidencias (record_id) on delete set null
);

create index if not exists rev_resp_rev_idx on revision_respuestas (revision_id);
create index if not exists rev_resp_inc_idx on revision_respuestas (incidencia_record_id);


-- ------------------------------------------------------------
-- 5) Evidencias
-- ------------------------------------------------------------
-- Una fila por archivo, igual que `evidencias` y `pauta_evidencias`. La foto
-- puede colgar de la revisión completa o de una respuesta concreta.
create table if not exists revision_evidencias (
  id              bigserial primary key,
  revision_id     bigint not null
                    references revisiones (id) on delete cascade,
  respuesta_id    bigint references revision_respuestas (id) on delete cascade,
  tipo            text,     -- 'foto' | 'video'
  url             text not null,
  path            text,     -- ruta en Storage, para poder borrar el archivo
  referencia      text,
  subido_por      text,
  creado_en       timestamptz default now()
);

create index if not exists rev_ev_rev_idx  on revision_evidencias (revision_id);
create index if not exists rev_ev_resp_idx on revision_evidencias (respuesta_id);


-- ------------------------------------------------------------
-- 6) RLS
-- ------------------------------------------------------------
alter table checklist_plantillas  enable row level security;
alter table checklist_puntos      enable row level security;
alter table revisiones            enable row level security;
alter table revision_respuestas   enable row level security;
alter table revision_evidencias   enable row level security;

-- Lectura: cualquier autenticado. El estado de las máquinas lo consulta
-- tanto quien va a campo como quien coordina.
do $$
declare t text;
begin
  foreach t in array array[
    'checklist_plantillas', 'checklist_puntos',
    'revisiones', 'revision_respuestas', 'revision_evidencias'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_sel', t);
    execute format(
      'create policy %I on %I for select using (auth_email() is not null)',
      t || '_sel', t
    );
  end loop;
end $$;

-- El catálogo lo edita coordinación. Si cualquiera pudiera cambiar los
-- puntos, el checklist deja de ser comparable entre revisiones.
do $$
declare t text;
begin
  foreach t in array array['checklist_plantillas', 'checklist_puntos'] loop
    execute format('drop policy if exists %I on %I', t || '_wr', t);
    execute format($f$
      create policy %I on %I for all
        using (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role))
        with check (tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role))
    $f$, t || '_wr', t);
  end loop;
end $$;

-- Revisar: cualquier autenticado. Quien recorre la ruta es quien revisa.
drop policy if exists rev_ins on revisiones;
create policy rev_ins on revisiones for insert
  with check (auth_email() is not null);

-- Corregir una revisión: solo quien la hizo, y solo el mismo día. Después de
-- eso es un registro histórico; si algo quedó mal, se hace otra revisión.
drop policy if exists rev_upd on revisiones;
create policy rev_upd on revisiones for update
  using (
    (lower(coalesce(revisado_por, '')) = lower(auth_email())
      and revisado_en > now() - interval '1 day')
    or tiene_rol('coordinador'::app_role)
    or tiene_rol('manager'::app_role)
  );

drop policy if exists rev_del on revisiones;
create policy rev_del on revisiones for delete
  using (tiene_rol('manager'::app_role));

drop policy if exists rev_resp_ins on revision_respuestas;
create policy rev_resp_ins on revision_respuestas for insert
  with check (auth_email() is not null);

-- UPDATE existe para UN SOLO CASO: sellar la respuesta con el record_id de
-- la incidencia que se levantó desde ella.
--
-- La política sola no alcanza. Con `using (auth_email() is not null)` y el
-- GRANT de tabla completa, cualquier sesión podría mandar
-- `PATCH /revision_respuestas?id=eq.123` con {"valor":"ok"} y borrar una
-- anomalía de una revisión de hace dos años, sin dejar rastro. Eso rompe la
-- promesa de la nota 2 de este archivo.
--
-- Por eso el permiso se acota A NIVEL DE COLUMNA: solo `incidencia_record_id`
-- es escribible. `valor`, `nota` y `punto_texto` quedan inmutables desde la
-- app; se corrigen haciendo otra revisión.
drop policy if exists rev_resp_upd on revision_respuestas;
create policy rev_resp_upd on revision_respuestas for update
  using (auth_email() is not null);

revoke update on revision_respuestas from authenticated;
grant update (incidencia_record_id) on revision_respuestas to authenticated;

drop policy if exists rev_ev_ins on revision_evidencias;
create policy rev_ev_ins on revision_evidencias for insert
  with check (auth_email() is not null);

drop policy if exists rev_ev_del on revision_evidencias;
create policy rev_ev_del on revision_evidencias for delete
  using (
    lower(coalesce(subido_por, '')) = lower(auth_email())
    or tiene_rol('coordinador'::app_role)
    or tiene_rol('manager'::app_role)
  );


-- ------------------------------------------------------------
-- 7) Vista: máquinas de ruta con su última revisión
-- ------------------------------------------------------------
-- Es la que lee la app: qué hay que visitar, dónde está, cuándo se revisó
-- por última vez y cómo quedó.
--
-- Sirve para cualquier unidad, no solo Biobox: el frontend filtra por
-- `unidad_negocio`. Un `where` aquí obligaría a una vista nueva por unidad.
create or replace view vw_revision_ubicaciones as
select
  ru.id              as ubicacion_id,
  r.id               as ruta_id,
  r.numero           as ruta_numero,
  r.nombre           as ruta_nombre,
  r.color            as ruta_color,
  r.unidad_negocio,
  -- OJO: DOS tipos de medio, y no son lo mismo.
  --   `tipo_medio` es el del SEGMENTO de la ruta. Existe porque el trigger
  --      `ruta_ubic_valida_segmento` obliga a que la ruta y sus ubicaciones
  --      coincidan, y Biobox mezcla Digital e Impreso en un mismo recorrido
  --      geográfico: por dentro esa ruta queda partida en dos filas con el
  --      mismo nombre (ver importar_rutas_capas.sql).
  --   `medio` es el de la MÁQUINA, de inventario. Es el que hay que usar
  --      para elegir el checklist y para llenar la incidencia; una máquina
  --      digital no se revisa igual que una impresa.
  r.tipo_medio,
  r.activa           as ruta_activa,
  ru.site_id,
  ru.secuencia,

  inv.vendor_face_id,
  inv.site_legacy_id,
  inv.direccion,
  inv.municipio,
  inv.estado,
  inv.tipo_mueble,
  inv.medio,
  inv.latitud,
  inv.longitud,
  (inv.latitud is not null and inv.longitud is not null) as navegable,

  ult.id             as revision_id,
  ult.revisado_en    as ultima_revision,
  ult.revisado_por   as ultimo_revisor,
  ult.estado_maquina,
  ult.puntos_anomalia,

  -- Días desde la última revisión. NULL = nunca se ha revisado, que en la
  -- lista es justo lo que hay que ver primero.
  case
    when ult.revisado_en is null then null
    else floor(extract(epoch from (now() - ult.revisado_en)) / 86400)::int
  end as dias_sin_revision

from ruta_ubicaciones ru
join rutas_monitoreo r on r.id = ru.ruta_id
left join lateral (
  select vendor_face_id, site_legacy_id, direccion, municipio, estado,
         tipo_mueble, tipo_medio as medio, latitud, longitud
  from inventario
  where site_id = ru.site_id
  order by vendor_face_id
  limit 1
) inv on true
left join lateral (
  select id, revisado_en, revisado_por, estado_maquina, puntos_anomalia
  from revisiones
  where site_id = ru.site_id
  order by revisado_en desc
  limit 1
) ult on true;


-- ------------------------------------------------------------
-- 8) RPC: guardar la revisión completa en una transacción
-- ------------------------------------------------------------
-- p_respuestas: [{ punto_id, punto_texto, grupo, orden, valor, nota }]
--
-- Devuelve { revision_id, ok, anomalia, na } — el frontend necesita el id
-- para colgarle las fotos y para sellar las respuestas con la incidencia.
create or replace function guardar_revision(
  p_cabecera   jsonb,
  p_respuestas jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_email  text := lower(coalesce(auth_email(), ''));
  v_id     bigint;
  v_ok     int := 0;
  v_anom   int := 0;
  v_na     int := 0;
begin
  if v_email = '' then
    raise exception 'Sesión no válida.';
  end if;
  if p_cabecera->>'site_id' is null then
    raise exception 'Falta la máquina (site_id).';
  end if;
  if p_respuestas is null or jsonb_array_length(p_respuestas) = 0 then
    raise exception 'La revisión no trae respuestas.';
  end if;

  select
    count(*) filter (where x->>'valor' = 'ok'),
    count(*) filter (where x->>'valor' = 'anomalia'),
    count(*) filter (where x->>'valor' = 'na')
  into v_ok, v_anom, v_na
  from jsonb_array_elements(p_respuestas) x;

  insert into revisiones (
    plantilla_id, site_id, vendor_face_id, unidad_negocio, nombre_maquina,
    direccion, ruta_id, revisado_por, revisado_en, lat, lng,
    estado_maquina, observaciones, puntos_ok, puntos_anomalia, puntos_na
  ) values (
    nullif(p_cabecera->>'plantilla_id', '')::bigint,
    p_cabecera->>'site_id',
    nullif(p_cabecera->>'vendor_face_id', ''),
    nullif(p_cabecera->>'unidad_negocio', ''),
    nullif(p_cabecera->>'nombre_maquina', ''),
    nullif(p_cabecera->>'direccion', ''),
    nullif(p_cabecera->>'ruta_id', '')::bigint,
    v_email,
    now(),
    nullif(p_cabecera->>'lat', '')::double precision,
    nullif(p_cabecera->>'lng', '')::double precision,
    nullif(p_cabecera->>'estado_maquina', ''),
    nullif(p_cabecera->>'observaciones', ''),
    v_ok, v_anom, v_na
  )
  returning id into v_id;

  insert into revision_respuestas (
    revision_id, punto_id, punto_texto, grupo, orden, valor, nota
  )
  select
    v_id,
    nullif(x->>'punto_id', '')::bigint,
    coalesce(nullif(x->>'punto_texto', ''), '(sin texto)'),
    nullif(x->>'grupo', ''),
    nullif(x->>'orden', '')::int,
    x->>'valor',
    nullif(x->>'nota', '')
  from jsonb_array_elements(p_respuestas) x;

  return jsonb_build_object(
    'revision_id', v_id,
    'ok', v_ok,
    'anomalia', v_anom,
    'na', v_na
  );
end $$;

revoke all on function guardar_revision(jsonb, jsonb) from public;
grant execute on function guardar_revision(jsonb, jsonb) to authenticated;


-- ------------------------------------------------------------
-- 9) Plantilla inicial de Biobox
-- ------------------------------------------------------------
-- PUNTO DE PARTIDA, NO VERDAD REVELADA. Está armada con lo que se puede
-- revisar a simple vista en una máquina con panel publicitario. Los puntos
-- se editan, se borran y se agregan desde la app sin tocar SQL — es
-- justamente el motivo de que el checklist sea catálogo.
--
-- `incidencia_sugerida` va en NULL a propósito: se llena desde la app
-- eligiendo del catálogo real de Biobox (lo devuelve diagnostico_biobox.sql
-- §6). Ponerle nombres inventados haría que el botón de levantar incidencia
-- fallara en silencio.
-- DOS plantillas, no una: de las 202 máquinas, 125 son Digital y 77 Impreso,
-- y no se revisan igual. En una impresa se mira la lona y el arte; en una
-- digital, la pantalla, el contenido en reproducción y la conectividad. Un
-- checklist común obligaría a marcar N/A la mitad de los puntos en cada
-- visita, y un punto que casi siempre es N/A deja de leerse.
--
-- `RevisionModal` elige la plantilla por el medio REAL de la máquina, no por
-- el de la ruta.
insert into checklist_plantillas (nombre, unidad_negocio, tipo_medio, descripcion)
values
  ('Revisión de máquina impresa', 'Biobox', 'Impreso',
   'Hoja de vida de la máquina. Se llena en cada visita de ruta.'),
  ('Revisión de máquina digital', 'Biobox', 'Digital',
   'Hoja de vida de la máquina. Se llena en cada visita de ruta.')
on conflict (unidad_negocio, coalesce(tipo_medio, ''), nombre) do nothing;

-- Puntos comunes a las dos. Solo se siembran si la plantilla está vacía, así
-- que re-ejecutar el archivo no revive puntos que ya se borraron a propósito.
insert into checklist_puntos (plantilla_id, orden, grupo, texto, ayuda, critico)
select p.id, v.orden, v.grupo, v.texto, v.ayuda, v.critico
from checklist_plantillas p
cross join (values
  (10, 'Estructura',  'Gabinete sin golpes, abolladuras ni piezas faltantes', null, false),
  (20, 'Estructura',  'Puertas y cerraduras cierran y aseguran bien',          'Probar la chapa, no solo verla', true),
  (30, 'Estructura',  'Máquina nivelada y anclada al piso',                    null, true),
  (40, 'Estructura',  'Sin grafiti, calcomanías ni rayones',                   null, false),
  (50, 'Estructura',  'Máquina limpia por fuera',                              null, false),
  (140,'Operación',   'Máquina energizada y encendida',                        null, true),
  (150,'Operación',   'Recepción de material libre y sin obstrucciones',       null, true),
  (160,'Operación',   'Contenedor con espacio disponible',                     'Si está lleno, se reporta para recolección', false),
  (170,'Operación',   'Sin fugas, olores ni derrames',                         null, false),
  (200,'Entorno',     'Acceso libre: sin vehículos, puestos ni obstáculos',    null, false),
  (210,'Entorno',     'Señalización e instructivo visibles y legibles',        null, false),
  (220,'Entorno',     'Área alrededor de la máquina limpia',                   null, false)
) as v(orden, grupo, texto, ayuda, critico)
where p.unidad_negocio = 'Biobox'
  and p.tipo_medio in ('Impreso', 'Digital')
  and not exists (
    select 1 from checklist_puntos cp where cp.plantilla_id = p.id
  );

-- Propios de la máquina IMPRESA: lo que se revisa es material físico.
insert into checklist_puntos (plantilla_id, orden, grupo, texto, ayuda, critico)
select p.id, v.orden, v.grupo, v.texto, v.ayuda, v.critico
from checklist_plantillas p
cross join (values
  (60, 'Publicidad', 'Arte / lona completo, sin roturas ni desprendimientos', null, false),
  (70, 'Publicidad', 'Campaña en exhibición es la que corresponde',           'Cotejar contra la pauta de la catorcena', false),
  (80, 'Publicidad', 'Vitrina o acrílico sin quebraduras y transparente',     null, false),
  (90, 'Publicidad', 'Iluminación del panel enciende y alumbra completa',     'De día no se puede comprobar: márcalo N/A', false),
  (100,'Publicidad', 'Faldón y molduras en buen estado',                      null, false)
) as v(orden, grupo, texto, ayuda, critico)
where p.unidad_negocio = 'Biobox'
  and p.tipo_medio = 'Impreso'
  and (select count(*) from checklist_puntos cp where cp.plantilla_id = p.id) <= 12;

-- Propios de la máquina DIGITAL: lo que se revisa es la pantalla y lo que
-- está reproduciendo.
insert into checklist_puntos (plantilla_id, orden, grupo, texto, ayuda, critico)
select p.id, v.orden, v.grupo, v.texto, v.ayuda, v.critico
from checklist_plantillas p
cross join (values
  (60, 'Pantalla', 'Pantalla enciende y se ve completa',                    'Sin franjas, píxeles muertos ni zonas apagadas', true),
  (70, 'Pantalla', 'Brillo adecuado y contenido legible a distancia',       null, false),
  (80, 'Pantalla', 'Cristal sin quebraduras, rayones ni humedad adentro',   null, false),
  (90, 'Contenido','Está reproduciendo el loop, no una pantalla de error',  'Quedarse a ver un ciclo completo', true),
  (100,'Contenido','Las campañas del loop son las que corresponden',        'Cotejar contra la pauta de la catorcena', false),
  (110,'Contenido','Video sin cortes, congelamientos ni audio ausente',     null, false),
  (120,'Conectividad','El equipo reporta en línea',                         'Si no reporta, es incidencia de TI', true),
  (130,'Conectividad','Gabinete de equipo cerrado y sin cables sueltos',    null, false)
) as v(orden, grupo, texto, ayuda, critico)
where p.unidad_negocio = 'Biobox'
  and p.tipo_medio = 'Digital'
  and (select count(*) from checklist_puntos cp where cp.plantilla_id = p.id) <= 12;


-- ------------------------------------------------------------
-- 10) Verificación
-- ------------------------------------------------------------
select p.id, p.nombre, p.unidad_negocio, count(cp.id) as puntos
from checklist_plantillas p
left join checklist_puntos cp on cp.plantilla_id = p.id
group by 1, 2, 3
order by p.id;

select pl.tipo_medio, cp.grupo, cp.orden, cp.texto, cp.critico
from checklist_puntos cp
join checklist_plantillas pl on pl.id = cp.plantilla_id
order by pl.tipo_medio, cp.orden;

-- Debe devolver 0 filas mientras no haya rutas de Biobox importadas.
select count(*) as ubicaciones_biobox
from vw_revision_ubicaciones
where unidad_negocio ilike '%biobox%';
