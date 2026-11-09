-- 9-nov-2026 · Reportes de la app Biobox (ficha contexto/reportes-app-biobox.md)
--
-- Qué hace: trae a la app operativa los reportes que los usuarios finales
--   levantan en la app de Biobox (base del Webadmin, solo por VPN), en una
--   bandeja APARTE de incidencias. La validadora los clasifica con nuestro
--   catálogo (nace la incidencia ligada, ya validada, En proceso), los liga a
--   una incidencia abierta o los descarta. Los de puntos entran directo a TI
--   según la tabla de equivalencias. Cuando la incidencia se cierra (o, en lo
--   que resuelve el técnico, cuando la repara) se avisa a quien debe marcar
--   «Atendido» en el Webadmin; el siguiente sync que ve el estatus 3 limpia el
--   aviso solo.
--
-- Reglas (decisiones de Erik del 9-nov-2026):
--   · Se trae TODO por número de reporte, nunca filtrando por estatus 1: ~20 %
--     de los reportes ya están en 2 o 3 la primera vez que se consultan.
--   · Primera carga: solo los vivos (1 Abierto, 2 En atención). Después entra
--     todo lo nuevo; lo que llega ya Atendido (3) se guarda sin pedir acción.
--   · Sin nombre, teléfono ni correo del usuario final: eso se queda en el
--     Webadmin. Nunca se escribe en la base de Biobox.
--   · Un reporte que deja de aparecer queda «ausente», nunca cerrado.
--
-- Quién escribe: SOLO las funciones de abajo (security definer). La tabla de
--   equivalencias la edita el manager.
--
-- ORDEN: la app que usa la bandeja va DESPUÉS de esta migración. El sync de la
--   PC (reportes-monitor) se enciende al final, con --prueba primero.

set local lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Equivalencias: motivo de la app Biobox → falla de nuestro catálogo.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.biobox_app_equivalencias (
  id               bigint generated always as identity primary key,
  unidad_negocio   text    not null check (unidad_negocio in ('Biobox', 'Biobox Perú')),
  caso_id          integer not null,          -- cases.caseId de la base de Biobox
  motivo           text,                       -- cases.nameCase (solo referencia)
  catalogo_detalle text    not null,           -- catalogo_incidencias.detalle
  etiqueta         text,                       -- segundo nivel («Compuerta con fallas»)
  directo_al_area  boolean not null default false,
  marca_atendido   text    not null default 'validador'
                   check (marca_atendido in ('validador', 'tecnico')),
  activo           boolean not null default true,
  actualizado_en   timestamptz not null default now(),
  unique (unidad_negocio, caso_id)
);

-- La falla debe existir en el catálogo de ESA unidad (el catálogo escribe
-- «BioBox» y «Biobox»: se compara sin mayúsculas).
create or replace function public.biobox_app_equiv_valida()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not exists (
    select 1 from catalogo_incidencias c
     where lower(btrim(c.unidad_negocio)) = lower(new.unidad_negocio)
       and c.detalle = new.catalogo_detalle
  ) then
    raise exception 'La falla «%» no existe en el catálogo de %.', new.catalogo_detalle, new.unidad_negocio
      using errcode = '23514';
  end if;
  new.etiqueta := nullif(btrim(new.etiqueta), '');
  new.actualizado_en := now();
  return new;
end $function$;
revoke all on function public.biobox_app_equiv_valida() from public, anon, authenticated;

drop trigger if exists biobox_app_equiv_valida on public.biobox_app_equivalencias;
create trigger biobox_app_equiv_valida
  before insert or update on public.biobox_app_equivalencias
  for each row execute function public.biobox_app_equiv_valida();

alter table public.biobox_app_equivalencias enable row level security;
revoke all on public.biobox_app_equivalencias from public, anon, authenticated;
grant select, insert, update, delete on public.biobox_app_equivalencias to authenticated;

drop policy if exists biobox_app_equiv_sel on public.biobox_app_equivalencias;
create policy biobox_app_equiv_sel on public.biobox_app_equivalencias
  for select to authenticated
  using ((select auth_email()) is not null);

drop policy if exists biobox_app_equiv_manager on public.biobox_app_equivalencias;
create policy biobox_app_equiv_manager on public.biobox_app_equivalencias
  for all to authenticated
  using ((select tiene_rol('manager'::app_role)))
  with check ((select tiene_rol('manager'::app_role)));

-- Tabla de Erik del 9-nov-2026 (caseId de la base de Biobox; el catálogo de
-- motivos es el mismo para México y Perú). «La máquina está llena» →
-- Recolección de reciclaje / «Mueble lleno» queda pendiente: ese motivo aún no
-- aparece en la base y no se conoce su caseId.
insert into public.biobox_app_equivalencias
  (unidad_negocio, caso_id, motivo, catalogo_detalle, etiqueta, directo_al_area, marca_atendido)
select u.unidad, e.caso_id, e.motivo, e.detalle, e.etiqueta, e.directo, e.marca
from (values ('Biobox'), ('Biobox Perú')) as u(unidad)
cross join (values
  (2, 'Abono de puntos',                              'Fallas con la aplicación',         'Error de abono de punto',       true,  'tecnico'),
  (7, 'Compuerta atorada',                            'Falla en el proceso de reciclaje', 'Compuerta con fallas',          false, 'validador'),
  (5, 'Detección del código de barras del producto',  'Fallas con la aplicación',         'Error en el canjeo de puntos',  true,  'tecnico')
) as e(caso_id, motivo, detalle, etiqueta, directo, marca)
on conflict (unidad_negocio, caso_id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Los reportes (espejo) y el estado del sync.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.biobox_app_reportes (
  report_id           bigint primary key,      -- reports.reportId (Biobox)
  folio_app           text,
  unidad_negocio      text not null check (unidad_negocio in ('Biobox', 'Biobox Perú')),
  pais                text,
  caso_id             integer,
  motivo              text,
  tipo                text,                    -- machine / app / other (tal cual)
  descripcion         text,
  codigo_maquina      text,                    -- bioboxId tal cual
  nombre_maquina      text,                    -- alias de la máquina
  clave_inventario    text,                    -- vendor_face_id nuestro, si empata
  evidencia_url       text,
  fecha_reporte_core  text,                    -- tal como viene de Core (sin zona)
  estatus_core        smallint,                -- 1 Abierto · 2 En atención · 3 Atendido
  estatus_core_nombre text,
  etiqueta            text,                    -- de la equivalencia, al entrar
  presente            boolean not null default true,
  primera_vez         timestamptz not null default now(),
  visto_en            timestamptz not null default now(),
  estatus_cambio_en   timestamptz,
  atendido_core_en    timestamptz,
  -- De nuestro lado. decision null = pendiente de clasificar.
  decision            text check (decision in
                        ('clasificado', 'ligado', 'directo', 'descartado', 'atendido_en_webadmin')),
  record_id           text references public.incidencias(record_id) on delete set null,
  marca_atendido      text check (marca_atendido in ('validador', 'tecnico')),
  decidido_por        text,
  decidido_en         timestamptz,
  motivo_descarte     text
);
create index if not exists biobox_app_reportes_record_idx
  on public.biobox_app_reportes (record_id) where record_id is not null;
create index if not exists biobox_app_reportes_pendientes_idx
  on public.biobox_app_reportes (unidad_negocio) where decision is null;

create table if not exists public.biobox_app_sync_estado (
  id               smallint primary key default 1 check (id = 1),
  corte_report_id  bigint,          -- el mayor reportId de la primera carga
  primera_carga    timestamptz,
  ultima_carga     timestamptz,
  ultimo_resultado jsonb
);

alter table public.biobox_app_reportes enable row level security;
alter table public.biobox_app_sync_estado enable row level security;
revoke all on public.biobox_app_reportes from public, anon, authenticated;
revoke all on public.biobox_app_sync_estado from public, anon, authenticated;
grant select on public.biobox_app_reportes to authenticated;
grant select on public.biobox_app_sync_estado to authenticated;

-- ¿Puede VER la bandeja de esa unidad? Validador DE esa unidad (como
-- inc_sel_validador), coordinador de la unidad o sin unidad (= todas), o manager.
create or replace function public.biobox_app_ve_bandeja(p_unidad text)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select (select tiene_rol('manager'::app_role))
      or exists (
        select 1 from usuario_roles ur
         where lower(ur.usuario_email) = lower((select auth_email()))
           and ((ur.rol = 'validador'::app_role
                 and lower(btrim(ur.unidad_negocio)) = lower(p_unidad))
                or (ur.rol = 'coordinador'::app_role
                    and (nullif(btrim(ur.unidad_negocio), '') is null
                         or lower(btrim(ur.unidad_negocio)) = lower(p_unidad))))
      );
$function$;
revoke all on function public.biobox_app_ve_bandeja(text) from public, anon;
grant execute on function public.biobox_app_ve_bandeja(text) to authenticated;

-- Leer: quien atiende la bandeja de la unidad, Consulta (viewer), o quien
-- puede ver la incidencia ligada (la RLS de incidencias decide en el exists).
drop policy if exists biobox_app_reportes_sel on public.biobox_app_reportes;
create policy biobox_app_reportes_sel on public.biobox_app_reportes
  for select to authenticated
  using (
    (select biobox_app_ve_bandeja(biobox_app_reportes.unidad_negocio))
    or (select tiene_rol('viewer'::app_role))
    or (record_id is not null
        and exists (select 1 from incidencias i where i.record_id = biobox_app_reportes.record_id))
  );

drop policy if exists biobox_app_sync_estado_sel on public.biobox_app_sync_estado;
create policy biobox_app_sync_estado_sel on public.biobox_app_sync_estado
  for select to authenticated
  using ((select auth_email()) is not null);

-- Código de Biobox → clave de nuestro inventario. Perú: BI-57 / BI-057 →
-- PE_LM_BB_IID_0057. México: el mismo código, o su ID vigente si es uno viejo.
-- Devuelve null si la máquina no está en el inventario de la unidad.
create or replace function public.biobox_app_clave_inventario(p_codigo text, p_unidad text)
returns text
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with c as (
    select case
             when upper(btrim(p_codigo)) ~ '^BI-[0-9]+$'
               then 'PE_LM_BB_IID_' || lpad(substring(upper(btrim(p_codigo)) from 4)::int::text, 4, '0')
             else coalesce((select a.vendor_face_id from inventario_ids_anteriores a
                             where a.id_anterior = upper(btrim(p_codigo))),
                           upper(btrim(p_codigo)))
           end as clave
  )
  select i.vendor_face_id
    from c join inventario i on i.vendor_face_id = c.clave
   where lower(i.unidad_negocio) = lower(p_unidad)
   limit 1;
$function$;
revoke all on function public.biobox_app_clave_inventario(text, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Crear la incidencia ligada (uso interno de las funciones de abajo).
--    p_falla: {detalle, area, impacto, origen, tipo}, igual que la fila que
--    arma NuevaInc con SelectorFalla. El área la vuelve a revisar el trigger
--    inc_valida_datos (debe existir en el catálogo).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.biobox_app_crear_incidencia(
  p_report_id bigint, p_falla jsonb, p_clave text, p_validador text, p_obs text)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r    biobox_app_reportes%rowtype;
  inv  inventario%rowtype;
  cat  catalogo_incidencias%rowtype;
  v_id text;
  v_obs text;
begin
  select * into r from biobox_app_reportes where report_id = p_report_id;
  if not found then
    raise exception 'No existe el reporte % de la app Biobox.', p_report_id;
  end if;
  if nullif(btrim(p_falla ->> 'detalle'), '') is null
     or nullif(btrim(p_falla ->> 'area'), '') is null then
    raise exception 'Falta la falla del catálogo (detalle y área).' using errcode = '23514';
  end if;
  -- Nivel, origen y tipo salen del catálogo DE LA UNIDAD, no de quien llama
  -- (revisor-rls, 9-nov-2026): inc_valida_datos solo revisa que el área exista
  -- en algún catálogo.
  select * into cat from catalogo_incidencias c
   where lower(btrim(c.unidad_negocio)) = lower(r.unidad_negocio)
     and c.detalle = btrim(p_falla ->> 'detalle')
     and c.area = btrim(p_falla ->> 'area')
   order by c.id
   limit 1;
  if not found then
    raise exception 'La falla «%» (%) no está en el catálogo de %.',
      btrim(p_falla ->> 'detalle'), btrim(p_falla ->> 'area'), r.unidad_negocio
      using errcode = '23514';
  end if;

  if p_clave is not null and p_clave <> 'SIN-MAQUINA' then
    select * into inv from inventario
     where vendor_face_id = p_clave and lower(unidad_negocio) = lower(r.unidad_negocio)
     limit 1;
    if not found then
      raise exception 'La máquina % no está en el inventario de %.', p_clave, r.unidad_negocio
        using errcode = '23514';
    end if;
  end if;

  loop
    v_id := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    exit when not exists (select 1 from incidencias where record_id = v_id);
  end loop;

  -- Lo que escribió el usuario final NO se copia (puede traer su teléfono o
  -- correo): se queda en biobox_app_reportes, con su propia RLS.
  v_obs := 'App Biobox · reporte ' || coalesce(r.folio_app, r.report_id::text)
        || coalesce(' · ' || r.motivo, '')
        || coalesce(' · «' || r.etiqueta || '»', '')
        || coalesce(E'\n' || nullif(btrim(p_obs), ''), '');

  insert into incidencias (
    record_id, unidad_negocio, clave_sitio, clave_medio, direccion, municipio, plaza,
    medio, tipo_mueble, nombre_biobox, nombre_incidencia, area_responsable, nivel,
    origen, tipo, observaciones, area_reportante, captured_by, fecha_reporte,
    estatus, requiere_prevalidacion, validator_approved, validator_email, validator_at)
  values (
    v_id, r.unidad_negocio,
    case when inv.vendor_face_id is null then 'SIN-MAQUINA' else inv.site_id end,
    inv.vendor_face_id, inv.direccion, inv.municipio, inv.estado,
    inv.tipo_medio, inv.tipo_mueble, inv.site_legacy_id,
    cat.detalle, cat.area, nullif(btrim(cat.impacto), ''),
    nullif(btrim(cat.origen), ''), nullif(btrim(cat.tipo), ''),
    v_obs, 'App Biobox', null, now(),
    'en_proceso', false,
    case when p_validador is not null then true end,
    p_validador,
    case when p_validador is not null then now() end);

  return v_id;
end $function$;
revoke all on function public.biobox_app_crear_incidencia(bigint, jsonb, text, text, text)
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. El sync: lo llama la tarea de la PC con la llave de servicio.
--    datos: arreglo con reportId, folio, fecha_reporte, caseId,
--    motivo_reportado, tipo_incidencia, descripcion_usuario, statusId,
--    estatus, codigo_maquina, maquina, pais_usuario, evidencia_imagen.
--    Todo lo que traiga de más (contacto del usuario) se IGNORA.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.sincronizar_biobox_app_reportes(datos jsonb, p_forzar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_jwt_rol    text;
  v_corte      bigint;
  v_primera    boolean;
  n_recibidos  int;
  n_presentes  int;
  n_nuevos     int := 0;
  n_cambios    int := 0;
  n_ausentes   int := 0;
  n_directos   int := 0;
  n_atendidos  int := 0;
  v_dup        jsonb;
  v_res        jsonb;
  nv           record;
  v_rec        text;
  v_falla      jsonb;
begin
  v_jwt_rol := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if session_user not in ('postgres', 'supabase_admin')
     and v_jwt_rol <> 'service_role'
     and not tiene_rol('manager'::app_role)
  then
    raise exception 'No tienes permiso para cargar los reportes de la app Biobox (se requiere manager o el proceso de sincronización).';
  end if;

  perform pg_advisory_xact_lock(hashtext('biobox_app_reportes'));

  n_recibidos := jsonb_array_length(coalesce(datos, '[]'::jsonb));
  if n_recibidos = 0 then
    raise exception 'ABORTADO: no llegó ningún reporte (una lectura fallida no es «cero reportes»).';
  end if;
  if n_recibidos > 20000 then
    raise exception 'ABORTADO: llegaron % reportes; el tope es 20,000.', n_recibidos;
  end if;

  drop table if exists pg_temp._bar_entrantes;
  create temp table _bar_entrantes on commit drop as
  select (x ->> 'reportId')::bigint                         as report_id,
         nullif(btrim(x ->> 'folio'), '')                   as folio,
         nullif(btrim(x ->> 'fecha_reporte'), '')           as fecha,
         nullif(x ->> 'caseId', '')::int                    as caso_id,
         nullif(btrim(x ->> 'motivo_reportado'), '')        as motivo,
         nullif(btrim(x ->> 'tipo_incidencia'), '')         as tipo,
         left(nullif(btrim(x ->> 'descripcion_usuario'), ''), 4000) as descripcion,
         nullif(x ->> 'statusId', '')::smallint             as estatus,
         nullif(btrim(x ->> 'estatus'), '')                 as estatus_nombre,
         nullif(upper(btrim(x ->> 'codigo_maquina')), '')   as codigo,
         nullif(btrim(x ->> 'maquina'), '')                 as nombre_maquina,
         nullif(btrim(x ->> 'pais_usuario'), '')            as pais,
         nullif(btrim(x ->> 'evidencia_imagen'), '')        as evidencia
    from jsonb_array_elements(datos) x;

  if exists (select 1 from _bar_entrantes where report_id is null) then
    raise exception 'ABORTADO: hay reportes sin reportId.';
  end if;
  select jsonb_agg(report_id) into v_dup from (
    select report_id from _bar_entrantes group by report_id having count(*) > 1 limit 20) d;
  if v_dup is not null then
    raise exception 'ABORTADO: reportes repetidos en la carga: %', v_dup;
  end if;

  -- Unidad: por la máquina (BI- = Perú, MX_ = México) y, sin máquina, por el
  -- país del usuario.
  alter table _bar_entrantes add column unidad text;
  update _bar_entrantes set unidad = case
    when codigo ~ '^BI-'                    then 'Biobox Perú'
    when codigo ~ '^MX_'                    then 'Biobox'
    when lower(coalesce(pais, '')) like 'per%' then 'Biobox Perú'
    else 'Biobox' end;

  select count(*) into n_presentes from biobox_app_reportes where presente;
  if not p_forzar and n_presentes >= 10 and n_recibidos < n_presentes * 0.8 then
    raise exception 'ABORTADO: llegaron % reportes y hay % presentes. Revisa la consulta o carga con p_forzar.',
      n_recibidos, n_presentes;
  end if;

  insert into biobox_app_sync_estado (id) values (1) on conflict (id) do nothing;
  select corte_report_id into v_corte from biobox_app_sync_estado where id = 1 for update;
  v_primera := v_corte is null;
  if v_primera then
    select max(report_id) into v_corte from _bar_entrantes;
    update biobox_app_sync_estado
       set corte_report_id = v_corte, primera_carga = now()
     where id = 1;
  end if;

  -- a) Los que ya teníamos: estatus de Biobox y datos al día. Los cambios de
  --    estatus se cuentan ANTES (RETURNING ya ve el valor nuevo).
  select count(*) into n_cambios
    from biobox_app_reportes r join _bar_entrantes t on t.report_id = r.report_id
   where r.estatus_core is distinct from t.estatus;

  update biobox_app_reportes r
       set folio_app           = t.folio,
           caso_id             = t.caso_id,
           motivo              = t.motivo,
           tipo                = t.tipo,
           descripcion         = t.descripcion,
           codigo_maquina      = t.codigo,
           nombre_maquina      = t.nombre_maquina,
           clave_inventario    = coalesce(biobox_app_clave_inventario(t.codigo, r.unidad_negocio), r.clave_inventario),
           evidencia_url       = t.evidencia,
           fecha_reporte_core  = t.fecha,
           pais                = t.pais,
           estatus_core_nombre = t.estatus_nombre,
           estatus_core        = t.estatus,
           estatus_cambio_en   = case when r.estatus_core is distinct from t.estatus
                                      then now() else r.estatus_cambio_en end,
           atendido_core_en    = case when t.estatus = 3 then coalesce(r.atendido_core_en, now()) end,
           -- Pendiente que el Webadmin ya atendió: no se le pide nada a la validadora.
           decision            = case when r.decision is null and t.estatus = 3
                                      then 'atendido_en_webadmin' else r.decision end,
           presente            = true,
           visto_en            = now()
      from _bar_entrantes t
     where t.report_id = r.report_id;

  -- b) Los nuevos. Primera carga: solo los vivos (1 y 2). Después: todo lo
  --    nuevo (report_id mayor al corte) y cualquier viejo que vuelva a vivir.
  for nv in
    select x.*, q.catalogo_detalle, q.etiqueta, q.directo_al_area, q.marca_atendido
      from _bar_entrantes x
      left join biobox_app_equivalencias q
        on q.unidad_negocio = x.unidad and q.caso_id = x.caso_id and q.activo
     where not exists (select 1 from biobox_app_reportes r where r.report_id = x.report_id)
       and (coalesce(x.estatus, 1) in (1, 2) or (not v_primera and x.report_id > v_corte))
     order by x.report_id
  loop
    insert into biobox_app_reportes (
      report_id, folio_app, unidad_negocio, pais, caso_id, motivo, tipo, descripcion,
      codigo_maquina, nombre_maquina, clave_inventario, evidencia_url, fecha_reporte_core,
      estatus_core, estatus_core_nombre, etiqueta, estatus_cambio_en, atendido_core_en,
      decision, marca_atendido)
    values (
      nv.report_id, nv.folio, nv.unidad, nv.pais, nv.caso_id, nv.motivo, nv.tipo, nv.descripcion,
      nv.codigo, nv.nombre_maquina, biobox_app_clave_inventario(nv.codigo, nv.unidad), nv.evidencia,
      nv.fecha, nv.estatus, nv.estatus_nombre, nv.etiqueta, now(),
      case when nv.estatus = 3 then now() end,
      case when nv.estatus = 3 then 'atendido_en_webadmin' end,
      nv.marca_atendido);
    n_nuevos := n_nuevos + 1;

    -- Directo al área (puntos → TI): nace la incidencia sin pasar por la
    -- validadora. Sin sesión de usuario, inc_valida_datos no aplica la regla
    -- de unidad; el área sí se revisa.
    v_rec := null;
    v_falla := null;
    if nv.directo_al_area and coalesce(nv.estatus, 1) in (1, 2) then
      -- Primero la fila del catálogo y DESPUÉS la incidencia: con la función
      -- dentro del SELECT, Postgres podía evaluarla en cada fila (una por
      -- mueble) antes del LIMIT y crear varias incidencias.
      select jsonb_build_object('detalle', c.detalle, 'area', c.area, 'impacto', c.impacto,
                                'origen', c.origen, 'tipo', c.tipo)
        into v_falla
        from catalogo_incidencias c
       where lower(btrim(c.unidad_negocio)) = lower(nv.unidad)
         and c.detalle = nv.catalogo_detalle
       order by c.id
       limit 1;
      if v_falla is not null then
        v_rec := biobox_app_crear_incidencia(
                   nv.report_id, v_falla, biobox_app_clave_inventario(nv.codigo, nv.unidad), null, null);
      end if;
      if v_rec is not null then
        update biobox_app_reportes
           set decision = 'directo', record_id = v_rec, decidido_en = now()
         where report_id = nv.report_id;
        n_directos := n_directos + 1;
      end if;
    end if;
  end loop;

  -- c) Los que ya no vienen: ausentes, nunca cerrados.
  with aus as (
    update biobox_app_reportes r set presente = false
     where r.presente
       and not exists (select 1 from _bar_entrantes e where e.report_id = r.report_id)
    returning 1
  )
  select count(*) into n_ausentes from aus;

  -- d) El aviso «marca Atendido» se retira cuando ya no queda ningún reporte
  --    de esa incidencia sin Atendido en el Webadmin.
  with hechos as (
    update notificaciones n set leida = true
     where n.evento = 'webadmin_atendido' and not coalesce(n.leida, false)
       and not exists (
         select 1 from biobox_app_reportes r
          where r.record_id = n.record_id
            and r.decision in ('clasificado', 'ligado', 'directo')
            and coalesce(r.estatus_core, 0) <> 3)
    returning 1
  )
  select count(*) into n_atendidos from hechos;

  v_res := jsonb_build_object(
    'recibidos', n_recibidos, 'nuevos', n_nuevos, 'cambios_estatus', n_cambios,
    'directos', n_directos, 'ausentes', n_ausentes, 'avisos_retirados', n_atendidos,
    'primera_carga', v_primera, 'corte_report_id', v_corte,
    'pendientes', (select count(*) from biobox_app_reportes where decision is null));
  update biobox_app_sync_estado
     set ultima_carga = now(), ultimo_resultado = v_res
   where id = 1;
  return v_res;
end $function$;
revoke all on function public.sincronizar_biobox_app_reportes(jsonb, boolean) from public, anon;
grant execute on function public.sincronizar_biobox_app_reportes(jsonb, boolean) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Acciones de la bandeja (validadora de la unidad o manager).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.biobox_app_exige_validador(p_unidad text)
returns text
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_yo text := lower((select auth_email()));
begin
  if v_yo is null then
    raise exception 'Sin sesión.' using errcode = '42501';
  end if;
  if not (select tiene_rol('manager'::app_role)) and not exists (
    select 1 from usuario_roles ur
     where lower(ur.usuario_email) = v_yo
       and ur.rol = 'validador'::app_role
       and lower(btrim(ur.unidad_negocio)) = lower(p_unidad)
  ) then
    raise exception 'Solo la validadora de % (o el manager) atiende esta bandeja.', p_unidad
      using errcode = '42501';
  end if;
  return v_yo;
end $function$;
revoke all on function public.biobox_app_exige_validador(text) from public, anon, authenticated;

-- Clasificar: nace la incidencia ligada, ya validada, En proceso.
-- p_clave_medio: la máquina elegida (null = la del reporte; 'SIN-MAQUINA' si no
-- se sabe). Devuelve el folio. Si la misma falla ya está abierta en esa
-- máquina, avisa con DUPLICADO para que la app ofrezca «Ligar».
create or replace function public.clasificar_reporte_biobox_app(
  p_report_id bigint, p_falla jsonb, p_clave_medio text default null, p_observaciones text default null)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r       biobox_app_reportes%rowtype;
  v_yo    text;
  v_clave text;
  v_dup   text;
  v_rec   text;
  v_folio text;
  v_marca text;
begin
  select * into r from biobox_app_reportes where report_id = p_report_id for update;
  if not found then
    raise exception 'No existe el reporte % de la app Biobox.', p_report_id;
  end if;
  v_yo := biobox_app_exige_validador(r.unidad_negocio);
  if r.decision is not null then
    raise exception 'Este reporte ya se atendió (%).', r.decision using errcode = '23514';
  end if;

  v_clave := coalesce(nullif(btrim(p_clave_medio), ''), r.clave_inventario, 'SIN-MAQUINA');

  if v_clave <> 'SIN-MAQUINA' then
    select i.folio into v_dup from incidencias i
     where i.clave_medio = v_clave
       and lower(i.nombre_incidencia) = lower(btrim(p_falla ->> 'detalle'))
       and i.estatus in ('por_validar', 'en_proceso', 'reparado', 'rechazada')
     order by i.creado_en desc
     limit 1;
    if v_dup is not null then
      raise exception 'DUPLICADO:%', v_dup using errcode = '23505';
    end if;
  end if;

  v_rec := biobox_app_crear_incidencia(p_report_id, p_falla, v_clave, v_yo, p_observaciones);

  select q.marca_atendido into v_marca from biobox_app_equivalencias q
   where q.unidad_negocio = r.unidad_negocio and q.caso_id = r.caso_id and q.activo;
  update biobox_app_reportes
     set decision = 'clasificado', record_id = v_rec, decidido_por = v_yo, decidido_en = now(),
         marca_atendido = coalesce(v_marca,
                                   case when lower(btrim(p_falla ->> 'area')) = 'ti'
                                        then 'tecnico' else 'validador' end)
   where report_id = p_report_id;

  select folio into v_folio from incidencias where record_id = v_rec;
  return v_folio;
end $function$;
revoke all on function public.clasificar_reporte_biobox_app(bigint, jsonb, text, text) from public, anon;
grant execute on function public.clasificar_reporte_biobox_app(bigint, jsonb, text, text) to authenticated;

-- Ligar a una incidencia abierta de la misma unidad (varios usuarios
-- reportan la misma máquina llena: una sola incidencia).
create or replace function public.ligar_reporte_biobox_app(p_report_id bigint, p_record_id text)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r      biobox_app_reportes%rowtype;
  i      incidencias%rowtype;
  v_yo   text;
  v_marca text;
begin
  select * into r from biobox_app_reportes where report_id = p_report_id for update;
  if not found then
    raise exception 'No existe el reporte % de la app Biobox.', p_report_id;
  end if;
  v_yo := biobox_app_exige_validador(r.unidad_negocio);
  if r.decision is not null then
    raise exception 'Este reporte ya se atendió (%).', r.decision using errcode = '23514';
  end if;
  select * into i from incidencias where record_id = p_record_id;
  if not found or lower(i.unidad_negocio) <> lower(r.unidad_negocio) then
    raise exception 'La incidencia no existe o es de otra unidad.' using errcode = '23514';
  end if;
  if i.estatus in ('cerrada', 'no_reparado') then
    raise exception 'La incidencia % ya está cerrada: clasifica el reporte como nuevo.', i.folio
      using errcode = '23514';
  end if;

  select q.marca_atendido into v_marca from biobox_app_equivalencias q
   where q.unidad_negocio = r.unidad_negocio and q.caso_id = r.caso_id and q.activo;
  update biobox_app_reportes
     set decision = 'ligado', record_id = i.record_id, decidido_por = v_yo, decidido_en = now(),
         marca_atendido = coalesce(v_marca,
                                   case when lower(coalesce(i.assigned_area, i.area_responsable)) = 'ti'
                                        then 'tecnico' else 'validador' end)
   where report_id = p_report_id;
  return i.folio;
end $function$;
revoke all on function public.ligar_reporte_biobox_app(bigint, text) from public, anon;
grant execute on function public.ligar_reporte_biobox_app(bigint, text) to authenticated;

-- Descartar (pruebas, repetidos, no es falla) con motivo obligatorio.
create or replace function public.descartar_reporte_biobox_app(p_report_id bigint, p_motivo text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r    biobox_app_reportes%rowtype;
  v_yo text;
begin
  select * into r from biobox_app_reportes where report_id = p_report_id for update;
  if not found then
    raise exception 'No existe el reporte % de la app Biobox.', p_report_id;
  end if;
  v_yo := biobox_app_exige_validador(r.unidad_negocio);
  if r.decision is not null then
    raise exception 'Este reporte ya se atendió (%).', r.decision using errcode = '23514';
  end if;
  if length(btrim(coalesce(p_motivo, ''))) < 3 then
    raise exception 'Escribe el motivo del descarte.' using errcode = '23514';
  end if;
  update biobox_app_reportes
     set decision = 'descartado', motivo_descarte = left(btrim(p_motivo), 500),
         decidido_por = v_yo, decidido_en = now()
   where report_id = p_report_id;
end $function$;
revoke all on function public.descartar_reporte_biobox_app(bigint, text) from public, anon;
grant execute on function public.descartar_reporte_biobox_app(bigint, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Aviso «Marca Atendido en el Webadmin».
--    · marca_atendido = 'validador': al CERRAR, a los validadores de la unidad
--      (destinatarios_notif, con su cascada).
--    · marca_atendido = 'tecnico': al quedar REPARADO, a quien reparó (TI
--      resuelve puntos y marca él mismo).
--    Lo retira el sync cuando ve el estatus 3.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.notificar_webadmin_atendido()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_folios text;
  v_msg    text;
begin
  if new.estatus is not distinct from old.estatus
     or new.estatus not in ('cerrada', 'reparado') then
    return new;
  end if;

  select string_agg(coalesce(r.folio_app, r.report_id::text), ', ' order by r.report_id)
    into v_folios
    from biobox_app_reportes r
   where r.record_id = new.record_id
     and r.decision in ('clasificado', 'ligado', 'directo')
     and coalesce(r.estatus_core, 0) <> 3
     and r.marca_atendido = case when new.estatus = 'cerrada' then 'validador' else 'tecnico' end;
  if v_folios is null then
    return new;
  end if;

  v_msg := 'Marca «Atendido» en el Webadmin: app Biobox ' || v_folios
        || ' · ' || coalesce(new.folio, '') || ' · ' || coalesce(new.nombre_incidencia, '');

  if new.estatus = 'cerrada' then
    insert into notificaciones (record_id, para_email, evento, mensaje, unidad_negocio)
    select new.record_id, d, 'webadmin_atendido', v_msg, new.unidad_negocio
      from destinatarios_notif('validador'::app_role, new.unidad_negocio, null, new.medio) d;
  elsif new.repaired_by_email is not null then
    insert into notificaciones (record_id, para_email, evento, mensaje, unidad_negocio)
    values (new.record_id, lower(new.repaired_by_email), 'webadmin_atendido', v_msg, new.unidad_negocio);
  end if;
  return new;
end $function$;
revoke all on function public.notificar_webadmin_atendido() from public, anon, authenticated;

drop trigger if exists trg_notificar_webadmin_atendido on public.incidencias;
create trigger trg_notificar_webadmin_atendido
  after update of estatus on public.incidencias
  for each row execute function public.notificar_webadmin_atendido();

-- ─────────────────────────────────────────────────────────────────────────
-- 7. notificar_incidencia: una incidencia que NACE En proceso sin
--    prevalidación (la clasificó la validadora o entró directo desde la app
--    Biobox) avisa «asignada a tu área», no «para prevalidar». Lo demás queda
--    IGUAL que en producción al 9-nov-2026.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.notificar_incidencia()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare msg text;
begin
  if TG_OP = 'INSERT' then
    if new.estatus = 'por_validar' then
      msg := 'Nueva incidencia por validar: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'')||' ('||coalesce(new.unidad_negocio,'')||')';
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'captura', msg, new.unidad_negocio
        from destinatarios_notif('validador'::app_role, new.unidad_negocio, null, new.medio) d;

    elsif new.estatus = 'en_proceso' then
      if new.requiere_prevalidacion then
        msg := 'Incidencia directa a tu área ('||coalesce(new.area_responsable,'')||') para prevalidar y reparar: '||coalesce(new.folio,'');
      else
        msg := 'Incidencia asignada al área '||coalesce(new.area_responsable,'')||': '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'');
      end if;
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'asignacion', msg, new.unidad_negocio
        from destinatarios_notif('reparacion'::app_role, new.unidad_negocio, new.area_responsable) d;
    end if;
    return new;
  end if;

  if new.estatus is distinct from old.estatus then
    if new.estatus = 'en_proceso' then
      msg := 'Incidencia asignada al área '||coalesce(new.area_responsable,'')||': '||coalesce(new.folio,'');
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'asignacion', msg, new.unidad_negocio
        from destinatarios_notif('reparacion'::app_role, new.unidad_negocio, new.area_responsable) d;

      -- si viene de 'reparado', es un rechazo de reparación -> avisar al reportante
      if old.estatus = 'reparado' and new.captured_by is not null then
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        values (new.record_id, lower(new.captured_by), 'reabierta',
          'La reparación de tu incidencia fue rechazada y regresó al área para corregirse: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,''),
          new.unidad_negocio);
      end if;

    elsif new.estatus = 'reparado' then
      msg := 'Reparación por aprobar: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'');
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'reparado', msg, new.unidad_negocio
        from destinatarios_notif('validador'::app_role, new.unidad_negocio, null, new.medio) d;

      -- avisar al reportante que su incidencia fue reparada (en revisión)
      if new.captured_by is not null then
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        values (new.record_id, lower(new.captured_by), 'reparado_reportante',
          'Tu incidencia fue reparada y está en revisión: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,''),
          new.unidad_negocio);
      end if;

    elsif new.estatus = 'cerrada' then
      if new.captured_by is not null then
        msg := 'Tu incidencia fue cerrada: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'');
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
          values (new.record_id, lower(new.captured_by), 'cierre', msg, new.unidad_negocio);
      end if;

    -- La devolución del validador (↩ Devolver al reportante, o Descartar de
    -- Digital): el reportante es el único que puede arreglarlo, así que es
    -- el único a quien tiene sentido avisarle. Dice "devuelta" y no
    -- "rechazada" (Erik, 13-oct-2026): se le pide corregir, no se descarta.
    elsif new.estatus = 'rechazada' then
      if new.captured_by is not null then
        msg := 'Tu incidencia fue devuelta para corregir: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'')
               ||coalesce(' · Motivo: '||nullif(btrim(new.motivo_rechazo_reparacion),''), '');
        insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
          values (new.record_id, lower(new.captured_by), 'rechazada', msg, new.unidad_negocio);
      end if;

    -- El reenvío tras corregir. Solo cuando VIENE de 'rechazada': si llegara
    -- a `por_validar` desde otro lado sería una corrección administrativa, y
    -- avisar ahí solo sumaría ruido a la campana.
    elsif new.estatus = 'por_validar' and old.estatus = 'rechazada' then
      msg := 'Incidencia corregida y reenviada a validar: '||coalesce(new.folio,'')||' · '||coalesce(new.nombre_incidencia,'')||' ('||coalesce(new.unidad_negocio,'')||')';
      insert into notificaciones(record_id,para_email,evento,mensaje,unidad_negocio)
        select new.record_id, d, 'captura', msg, new.unidad_negocio
        from destinatarios_notif('validador'::app_role, new.unidad_negocio, null, new.medio) d;
    end if;
  end if;
  return new;
end $function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. notificar_maquina_otra_area: «SIN-MAQUINA» no es una máquina; no hay a
--    quién mandar a revisarla (revisor-rls, 9-nov-2026: sin esto, cada reporte
--    de puntos o de app que entra a TI o Digital avisaba «pasa a revisar la
--    máquina SIN-MAQUINA» a los coordinadores; también le pasaba a MKT). Lo
--    demás queda IGUAL que en producción al 9-nov-2026.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.notificar_maquina_otra_area()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_area text := btrim(coalesce(new.assigned_area, new.area_responsable, ''));
  v_para text[];
  v_rutas text;
  v_msg text;
begin
  if coalesce(btrim(new.unidad_negocio), '') !~* '^biobox' then return new; end if;
  if new.estatus is distinct from 'en_proceso' then return new; end if;
  if lower(v_area) not in ('digital', 'ti') then return new; end if;
  if nullif(btrim(new.clave_sitio), '') is null then return new; end if;
  if upper(btrim(new.clave_sitio)) = 'SIN-MAQUINA' then return new; end if;
  if tg_op = 'UPDATE' and old.estatus = 'en_proceso'
     and lower(btrim(coalesce(old.assigned_area, old.area_responsable, ''))) = lower(v_area) then
    return new;
  end if;

  select array_agg(distinct lower(rt.usuario_email)),
         string_agg(distinct coalesce(nullif(btrim(r.nombre), ''), 'Ruta ' || r.numero), ', ')
    into v_para, v_rutas
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id and r.activa
    join ruta_tecnicos rt on rt.ruta_id = ru.ruta_id
   where ru.site_id = new.clave_sitio
     and exists (
       select 1 from usuario_roles ur
        where lower(btrim(ur.usuario_email)) = rt.usuario_email
          and ur.rol = 'reparacion'::app_role
          and btrim(ur.departamento) ilike 'op. bio box'
          and (nullif(btrim(ur.unidad_negocio), '') is null
               or lower(btrim(ur.unidad_negocio)) = lower(btrim(new.unidad_negocio))))
     and not exists (
       select 1 from usuario_roles ur
        where lower(btrim(ur.usuario_email)) = rt.usuario_email
          and ur.rol = 'reparacion'::app_role
          and (nullif(btrim(ur.departamento), '') is null or btrim(ur.departamento) ilike v_area));
  if v_para is null then
    v_rutas := null;
    select array_agg(distinct lower(ur.usuario_email)) into v_para
      from usuario_roles ur
     where ur.rol = 'coordinador'::app_role
       and lower(btrim(ur.unidad_negocio)) = lower(btrim(new.unidad_negocio))
       and (ur.departamento is null or btrim(ur.departamento) ilike 'op. bio box');
  end if;
  if v_para is null then return new; end if;

  v_msg := 'Incidencia ' || coalesce(new.folio, '') || ' · ' || coalesce(new.nombre_incidencia, '')
           || ' en ' || new.clave_sitio || coalesce(' (' || v_rutas || ')', '')
           || '. La atiende ' || v_area || '; pasa a revisar la máquina.';
  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  select null, e, 'maquina_incidencia', v_msg, new.unidad_negocio
    from unnest(v_para) as e
   where e is distinct from lower(auth_email());
  return new;
end
$function$;
