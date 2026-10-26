-- ============================================================
-- comp_f3_modelo — Comprobaciones, fase 3 («monitorista y analista»),
-- migración 1 de 3: el modelo (26-oct-2026).
--
-- QUÉ HACE
--   · Catálogo FIJO de plantillas de toma (comp_plantillas_toma), sembrado
--     aquí (12 plantillas; sin editor) y un selector por campaña
--     (comp_poner_plantilla). Erik, 26-oct-2026: Ecovallas «corta, media y
--     larga» = 3 fotos por campaña-versión; Vía Verde «TOMAS COMPLETAS» = 1
--     foto por versión; Biobox: copetes y laterales una vez por máquina y día
--     (valen para todas sus campañas) y el frontal es la foto de la campaña.
--   · La lista del monitorista (comp_mis_tomas, en Mis rutas › Comprobaciones)
--     sale de SUS tomas y se refresca sola con la asignación de rutas por RPC
--     (comp_refrescar_rutas), sin trigger en ruta_asignaciones: Pauta,
--     importar_rutas, eliminar_ruta y dar_baja_usuario no cambian.
--   · Nacen VACÍAS las tablas de fotos (comp_evidencias), ligas foto ↔ toma
--     (comp_evidencia_tomas) y revisiones (comp_revision_fotos), la bandera
--     de captura (comp_piloto) y todas las columnas nuevas. Nadie escribe en
--     ellas hasta la migración 2 (captura) y la 3 (revisión). Así cada
--     función viva de la fase 2 se reemplaza UNA sola vez, aquí.
--   · Reemplaza 6 funciones de la fase 2, con candado md5 (abajo). Con las
--     tablas nuevas vacías se comportan igual que hoy (lo prueba PGlite),
--     salvo comp_ruta_sitio, que ahora también encuentra rutas Impreso en
--     Biobox y Vía Verde (V1; hoy hay 0 monitoristas: no cambia ningún Excel).
--     OJO (revisión del 26-oct-2026, sql-2): en Biobox los números de ruta se
--     repiten entre Digital (1-10) e Impreso (1-9). Lo de «no cambia ningún
--     Excel» vale mientras Biobox no tenga campañas: la columna ruta del Excel
--     solo lleva el número. Por eso comp_mis_tomas manda también ruta_medio y
--     Formato filtra por ruta_id.
--
-- DECISIONES (Erik, 26-oct-2026; contexto/comprobaciones.md)
--   · Monitorista por ruta: Marco asigna en Rutas; Victor ajusta sueltas en
--     Formato (monitorista_manual = true) y eso no lo pisa nadie (M3).
--   · Solo un monitorista vigente de la unidad (o el manager) tiene tomas:
--     ni el Supervisor ni la analista pura capturan (comp_es_mi_toma).
--   · El sitio cuenta con su primera toma comprobada, el día de la foto
--     (comp_sitio_credito; con tablas vacías no hace nada). La marca a mano
--     sigue y manda.
--   · Nada de 'coordinador': los coordinadores no ven Comprobaciones (23-oct).
--
-- REGLAS COMUNES
--   · Todas: security definer, search_path fijo. Las que escriben: lock_timeout
--     3 s; comp_mis_tomas (lee y refresca): 1 s.
--   · Errores esperados en el RESULTADO ({ok:false, codigo:'ocupada'|…});
--     excepciones con código propio solo para lo que no debe pasar:
--     CP001 sin sesión, CP002 datos inválidos. Sin permiso en una RPC del
--     Supervisor: excepción 42501 con el texto para la pantalla.
--   · Orden de candados: tomas (order by id) → ligas/fotos/revisiones →
--     comp_sitios (solo comp_sitio_credito, for no key update). Las RPC
--     nuevas no bloquean comp_campanas, salvo comp_poner_plantilla, que
--     bloquea campañas y ninguna toma. comp_refrescar_rutas usa skip locked.
--   · «Hoy» = día de CDMX.
--
-- Re-ejecutable: el candado acepta el md5 de producción o el de esta
-- versión; tablas, columnas, índices y políticas usan if not exists / drop if
-- exists; la semilla del catálogo es on conflict do nothing.
-- Sin correos, llaves ni servidores (repo público).
-- ============================================================

-- Revisión del 26-oct-2026 (sql-7): los ALTER TABLE de abajo (comp_campanas,
-- comp_tomas, comp_sitios, comp_movimientos) toman ACCESS EXCLUSIVE. Si un
-- Armar o un lote los tiene ocupados, más vale fallar a los 5 s y volver a
-- correr (es re-ejecutable) que formarse sin límite y frenar todas las
-- lecturas de Comprobaciones mientras tanto. Igual que rutas_por_coordinador
-- y vv_ocupacion. «set local» (revisor-rls, 26-oct-2026): vale solo dentro de
-- esta migración y no se queda pegado en la conexión.
set local lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1a) Candado: si alguna de las 6 funciones que se reemplazan cambió en
--     producción desde el 26-oct-2026, no se aplica nada.
-- ------------------------------------------------------------
create or replace function pg_temp.md5_fn(p_nombre text, p_args text) returns text language sql as $$
  select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = p_nombre and pg_get_function_identity_arguments(p.oid) = p_args $$;
do $$ begin
  if coalesce(pg_temp.md5_fn('comp_aplicar_planes', 'p_ids bigint[], p_plan jsonb'), 'falta')
       not in ('035fbbdf98062718249a1f1e96053cca', 'cd952f95e0eb4dcee66e2c20e9e10040') then
    raise exception 'comp_aplicar_planes cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce(pg_temp.md5_fn('comp_campana_con_trabajo', 'p_id bigint'), 'falta')
       not in ('254c0d24e30542bf95a17cd859026736', '22e4e80affed6f4c044c8e3cc41fba0b') then
    raise exception 'comp_campana_con_trabajo cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce(pg_temp.md5_fn('comp_cargar_campanas', 'p_unidad text, p_medio text, p_periodo jsonb, p_campanas jsonb, p_solo_revisar boolean, p_completa boolean'), 'falta')
       not in ('7e6a63bc6bb748eecead4d8ad623e8f1', '55265030ab50e4fd1dce57d2fb6af96b') then
    raise exception 'comp_cargar_campanas cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce(pg_temp.md5_fn('comp_editar_tomas', 'p_toma_ids bigint[], p_cambios jsonb'), 'falta')
       not in ('1f3b63d54539ee6821ac7c99492e2093', '7f3cbed0fbe61a0f8673427514edc235') then
    raise exception 'comp_editar_tomas cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce(pg_temp.md5_fn('comp_ruta_sitio', 'p_unidad text, p_site_id text, p_clave text'), 'falta')
       not in ('a77ff93f62c31052dd7c08f3a448a029', '3d13087f46bfcffe3a418aaee1207a94') then
    raise exception 'comp_ruta_sitio cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce(pg_temp.md5_fn('comp_restaurar_sitios', 'p_sitio_ids bigint[]'), 'falta')
       not in ('2d64d43b3aaeaa6ef2bc50f21a162407', '97fd58702e3206ab1b403d61aae30741') then
    raise exception 'comp_restaurar_sitios cambió en producción: revisa antes de reemplazar.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1b) Catálogo FIJO de plantillas (M7, 26-oct-2026). Sin editor: una
--     plantilla nueva entra por migración. capa 'testigo' = la foto de la
--     campaña-versión (la elige el Supervisor por campaña; NULL = 'unica');
--     capa 'mueble' = fotos de la máquina de Biobox según inventario.tipo_mueble,
--     se suman solas. confirmada = false: sale de las hojas reales pero Victor
--     no la ha confirmado.
--     posiciones = [{pos, n, alcance, momento, etiqueta}]; alcance 'version'
--     (una por campaña-versión) o 'sitio' (una por sitio y día, vale para
--     todas sus campañas); momento NULL, 'dia' o 'noche'.
-- ------------------------------------------------------------
create table if not exists public.comp_plantillas_toma (
  codigo text primary key check (codigo ~ '^[a-z0-9_]{2,30}$'),
  nombre text not null,
  capa text not null check (capa in ('testigo', 'mueble')),
  unidad text check (unidad in ('Ecovallas', 'Biobox', 'Vía Verde')),   -- NULL = todas (solo testigo)
  mueble text,                                                         -- inventario.tipo_mueble exacto
  -- [{pos, n, alcance, momento, etiqueta}]; pos ∈ normal|corta|media|larga|con_periodico|panoramica|angulo|copete|lateral
  posiciones jsonb not null check (jsonb_typeof(posiciones) = 'array' and jsonb_array_length(posiciones) between 1 and 12),
  orden int not null default 100,
  activa boolean not null default true,
  confirmada boolean not null default false,
  notas text,
  check ((capa = 'mueble') = (mueble is not null)),
  check (capa = 'testigo' or unidad is not null));
-- B3: en capa mueble, unidad y mueble nunca son NULL (checks de arriba): el único parcial no deja pasar repetidos.
create unique index if not exists comp_plantillas_mueble on public.comp_plantillas_toma (unidad, mueble) where capa = 'mueble';

insert into public.comp_plantillas_toma (codigo, nombre, capa, unidad, mueble, posiciones, orden, confirmada, notas) values
 ('unica', 'Una toma', 'testigo', null, null,
   '[{"pos":"normal","n":1,"alcance":"version","momento":null,"etiqueta":"Toma"}]', 10, true,
   'Por omisión. VV «TOMAS COMPLETAS» (Erik, 26-oct); EV «1 toma / mejor vista»; Biobox: el frontal.'),
 ('cml', 'Corta, media y larga', 'testigo', null, null,
   '[{"pos":"corta","n":1,"alcance":"version","momento":null,"etiqueta":"Corta"},
     {"pos":"media","n":1,"alcance":"version","momento":null,"etiqueta":"Media"},
     {"pos":"larga","n":1,"alcance":"version","momento":null,"etiqueta":"Larga"}]', 20, true, '3 fotos por campaña-versión (Erik, 26-oct).'),
 ('cml_periodico', 'Corta con periódico, media y larga', 'testigo', null, null,
   '[{"pos":"con_periodico","n":1,"alcance":"version","momento":null,"etiqueta":"Corta con periódico"},
     {"pos":"media","n":1,"alcance":"version","momento":null,"etiqueta":"Media"},
     {"pos":"larga","n":1,"alcance":"version","momento":null,"etiqueta":"Larga"}]', 30, false, null),
 ('corta_media', 'Corta y media', 'testigo', null, null,
   '[{"pos":"corta","n":1,"alcance":"version","momento":null,"etiqueta":"Corta"},
     {"pos":"media","n":1,"alcance":"version","momento":null,"etiqueta":"Media"}]', 40, false, null),
 ('panoramica', 'Panorámica', 'testigo', null, null,
   '[{"pos":"panoramica","n":1,"alcance":"version","momento":null,"etiqueta":"Panorámica"}]', 50, false, null),
 ('angulos_3', '3 ángulos', 'testigo', null, null,
   '[{"pos":"angulo","n":3,"alcance":"version","momento":null,"etiqueta":"Ángulo"}]', 60, false, null),
 ('angulos_3_dia_noche', '3 ángulos de día y 3 de noche', 'testigo', null, null,
   '[{"pos":"angulo","n":3,"alcance":"version","momento":"dia","etiqueta":"Ángulo de día"},
     {"pos":"angulo","n":3,"alcance":"version","momento":"noche","etiqueta":"Ángulo de noche"}]', 70, false, null),
 ('bb_m4', 'Biobox M4', 'mueble', 'Biobox', 'M4',
   '[{"pos":"copete","n":3,"alcance":"sitio","momento":null,"etiqueta":"Copete"},
     {"pos":"lateral","n":2,"alcance":"sitio","momento":null,"etiqueta":"Lateral"}]', 110, true, 'Erik, 22-oct.'),
 ('bb_m4r2', 'Biobox M4-R2', 'mueble', 'Biobox', 'M4-R2',
   '[{"pos":"lateral","n":2,"alcance":"sitio","momento":null,"etiqueta":"Lateral"}]', 120, true, 'Erik, 22-oct.'),
 ('bb_m5', 'Biobox M5', 'mueble', 'Biobox', 'M5',
   '[{"pos":"lateral","n":2,"alcance":"sitio","momento":null,"etiqueta":"Lateral"}]', 130, false, 'Provisional (Erik, 26-oct): frontal + 2 laterales.'),
 ('bb_m5oxxo', 'Biobox M5 OXXO', 'mueble', 'Biobox', 'M5 OXXO',
   '[{"pos":"lateral","n":2,"alcance":"sitio","momento":null,"etiqueta":"Lateral"}]', 140, false, 'Provisional (Erik, 26-oct).'),
 ('bb_m4urbana', 'Biobox M4 URBANA', 'mueble', 'Biobox', 'M4 URBANA',
   '[{"pos":"lateral","n":2,"alcance":"sitio","momento":null,"etiqueta":"Lateral"}]', 150, false, 'Provisional (Erik, 26-oct).')
on conflict (codigo) do nothing;

-- ------------------------------------------------------------
-- 1c) Columnas nuevas, todas al final. vw_comp_tomas y vw_comp_campanas NO
--     cambian (M9): nombran sus columnas; la app lee lo nuevo de las tablas.
-- ------------------------------------------------------------
alter table public.comp_campanas
  add column if not exists plantilla_codigo text references public.comp_plantillas_toma(codigo),  -- NULL = 'unica'
  add column if not exists plantilla_por text,
  add column if not exists plantilla_en timestamptz;

-- M3: monitorista_manual = lo puso Victor en Formato. Revisión del 26-oct-2026
-- (regresiones-2): al nacer se rellena con las tomas cuyo monitorista se puso
-- a mano con la app de la fase 2 (el último editar_tomas que las nombra trae
-- ese mismo correo); si no, el primer refresco por rutas pisaría lo que Victor
-- puso. Solo cuando la columna nace: una segunda corrida no lo repite (después
-- de la fase 3, «el de la ruta» deja la columna en false a propósito).
-- No basta con origen = 'app': comp_agregar_tomas copia el de la ruta.
do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'comp_tomas' and column_name = 'monitorista_manual') then
    alter table public.comp_tomas add column monitorista_manual boolean not null default false;
    update public.comp_tomas t set monitorista_manual = true
     where t.monitorista_email is not null
       and (select lower(nullif(btrim(m.detalle->>'monitorista_email'), ''))
              from public.comp_movimientos m
             where m.accion = 'editar_tomas' and m.detalle ? 'monitorista_email'
               and m.detalle->'tomas' @> to_jsonb(t.id)
             order by m.id desc limit 1) = t.monitorista_email;
  end if;
end $$;

alter table public.comp_tomas
  add column if not exists tomada_por text,                                    -- quien la envió
  add column if not exists enviada_en timestamptz,                             -- hora del SERVIDOR
  add column if not exists plantilla_usada jsonb,                              -- A2: lo que se exigió al enviar
  add column if not exists regreso_n int not null default 0,                   -- la cola compara este número, nunca el reloj
  add column if not exists rechazo_motivo text,
  add column if not exists rechazada_por text,
  add column if not exists rechazada_en timestamptz,
  add column if not exists comprobada_en timestamptz,
  add column if not exists comprobada_por text,
  add column if not exists reabierta_motivo text,
  add column if not exists reabierta_por text,
  add column if not exists reabierta_en timestamptz;

alter table public.comp_sitios
  add column if not exists comprobado_toma_id bigint references public.comp_tomas(id) on delete set null;

-- Checks de estado de la toma (las 38 tomas de hoy, todas 'pendiente', los cumplen).
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.comp_tomas'::regclass and conname = 'comp_tomas_comprobada_chk') then
    alter table public.comp_tomas add constraint comp_tomas_comprobada_chk
      check ((estado = 'comprobada') = (comprobada_en is not null));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.comp_tomas'::regclass and conname = 'comp_tomas_regresada_chk') then
    alter table public.comp_tomas add constraint comp_tomas_regresada_chk
      check (estado <> 'regresada' or nullif(btrim(rechazo_motivo), '') is not null);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.comp_tomas'::regclass and conname = 'comp_tomas_enviada_chk') then
    alter table public.comp_tomas add constraint comp_tomas_enviada_chk
      check (estado not in ('por_revisar', 'comprobada') or (enviada_en is not null and plantilla_usada is not null));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.comp_tomas'::regclass and conname = 'comp_tomas_plantilla_chk') then
    alter table public.comp_tomas add constraint comp_tomas_plantilla_chk
      check (plantilla_usada is null or jsonb_typeof(plantilla_usada) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.comp_tomas'::regclass and conname = 'comp_tomas_regreso_chk') then
    alter table public.comp_tomas add constraint comp_tomas_regreso_chk check (regreso_n >= 0);
  end if;
end $$;

create index if not exists comp_tomas_revision on public.comp_tomas (campana_id, estado)
  where estado in ('por_revisar', 'regresada', 'comprobada');
create index if not exists comp_tomas_regresadas_por on public.comp_tomas (tomada_por) where estado = 'regresada';
-- V4: la FK on delete set null busca aquí por cada toma borrada (replan de VV, Armar, retirar).
create index if not exists comp_sitios_comprobado_toma on public.comp_sitios (comprobado_toma_id)
  where comprobado_toma_id is not null;

-- ------------------------------------------------------------
-- 1d) Fotos, ligas y revisiones: vacías hasta la migración 2.
-- ------------------------------------------------------------
create table if not exists public.comp_evidencias (
  id bigint generated always as identity primary key,
  cliente_id uuid not null unique,                 -- lo genera el teléfono; reintento = «ya»
  path text not null unique check (path like 'comp/%'),
  unidad text not null check (unidad in ('Ecovallas', 'Biobox', 'Vía Verde')),
  sitio_clave text not null,
  fecha date not null,                             -- día CDMX de la foto, lo pone el SERVIDOR (A1)
  tipo text not null check (tipo in ('foto', 'video')),
  pos text not null check (pos ~ '^[a-z_]{1,20}$'),  -- posición de la plantilla o 'extra'
  momento text check (momento in ('dia', 'noche')),
  tomada_en_tel timestamptz,                       -- solo se muestra y sugiere el día
  lat double precision, lng double precision, precision_m real,
  subido_por text not null check (subido_por = lower(subido_por)),
  creado_en timestamptz not null default now());
create index if not exists comp_evidencias_sitio_dia on public.comp_evidencias (unidad, sitio_clave, fecha);
create index if not exists comp_evidencias_subido on public.comp_evidencias (subido_por, creado_en desc);

-- A1 en la base (revisor-rls, 26-oct-2026): la campaña de la liga es la de su
-- toma; así el «una foto, un solo día de cada campaña» de abajo no depende de
-- que la función la copie bien. comp_tomas.id ya es único: esto solo permite
-- la llave foránea compuesta.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'comp_tomas_id_campana_key') then
    alter table public.comp_tomas add constraint comp_tomas_id_campana_key unique (id, campana_id);
  end if;
end $$;

create table if not exists public.comp_evidencia_tomas (
  evidencia_id bigint not null references public.comp_evidencias(id) on delete cascade,
  toma_id bigint not null,
  campana_id bigint not null,                      -- la de la toma (A1)
  ligada_por text not null, ligada_en timestamptz not null default now(),
  regresada_en timestamptz,                        -- ya no cuenta en esta toma (rechazada o devuelta); no se borra
  primary key (evidencia_id, toma_id),
  -- un replan nunca tira fotos (restrict); la campaña tiene que ser la de la toma
  foreign key (toma_id, campana_id) references public.comp_tomas (id, campana_id) on delete restrict,
  unique (evidencia_id, campana_id));              -- A1: una foto vale para un solo día de cada campaña
create index if not exists comp_evidencia_tomas_toma on public.comp_evidencia_tomas (toma_id);

create table if not exists public.comp_revision_fotos (
  evidencia_id bigint not null, toma_id bigint not null,
  primary key (evidencia_id, toma_id),
  foreign key (evidencia_id, toma_id) references public.comp_evidencia_tomas (evidencia_id, toma_id) on delete cascade,
  estado text not null check (estado in ('correcta', 'editada', 'rechazada')),
  motivo text, editada_path text,
  revisado_por text not null, revisado_en timestamptz not null default now(),
  check (estado <> 'rechazada' or nullif(btrim(motivo), '') is not null),
  check ((estado = 'editada') = (editada_path is not null)),
  check (editada_path is null or editada_path like 'comp-analista/%'));
create index if not exists comp_revision_fotos_toma on public.comp_revision_fotos (toma_id);
create index if not exists comp_revision_fotos_editada on public.comp_revision_fotos (editada_path) where editada_path is not null;

-- M6: bandera de captura. Sin grants: solo SQL (Erik, o Claude con su permiso). '*' = todos.
create table if not exists public.comp_piloto (
  email text primary key check (email = lower(btrim(email))),
  agregado_en timestamptz not null default now());

-- ------------------------------------------------------------
-- 1e) RLS de lo nuevo: solo lectura; nadie escribe directo (las RPC sí).
-- ------------------------------------------------------------
alter table public.comp_plantillas_toma enable row level security;
alter table public.comp_evidencias enable row level security;
alter table public.comp_evidencia_tomas enable row level security;
alter table public.comp_revision_fotos enable row level security;
alter table public.comp_piloto enable row level security;
revoke all on public.comp_plantillas_toma, public.comp_evidencias, public.comp_evidencia_tomas,
  public.comp_revision_fotos, public.comp_piloto from anon, authenticated;
grant select on public.comp_plantillas_toma, public.comp_evidencias, public.comp_evidencia_tomas,
  public.comp_revision_fotos to authenticated;

drop policy if exists comp_pla_sel on public.comp_plantillas_toma;
create policy comp_pla_sel on public.comp_plantillas_toma for select to authenticated using (true);

-- La liga y la revisión se ven si se ve la toma (comp_tom_sel: Supervisor de la unidad o la analista de la campaña).
drop policy if exists comp_evt_sel on public.comp_evidencia_tomas;
create policy comp_evt_sel on public.comp_evidencia_tomas for select to authenticated
  using (exists (select 1 from public.comp_tomas t where t.id = comp_evidencia_tomas.toma_id));
drop policy if exists comp_rev_sel on public.comp_revision_fotos;
create policy comp_rev_sel on public.comp_revision_fotos for select to authenticated
  using (exists (select 1 from public.comp_tomas t where t.id = comp_revision_fotos.toma_id));
-- La foto: Supervisor de la unidad, quien la subió, o una liga visible (la liga ya pasa por comp_evt_sel).
drop policy if exists comp_evi_sel on public.comp_evidencias;
create policy comp_evi_sel on public.comp_evidencias for select to authenticated
  using (unidad in (select comp_mis_unidades(array['supervisor']::app_role[]))
         or subido_por = (select lower(auth_email()))          -- B7: se evalúa una vez, no por fila
         or exists (select 1 from public.comp_evidencia_tomas et where et.evidencia_id = comp_evidencias.id));
-- comp_piloto: RLS sin políticas = nadie la lee con sesión.
-- Nada de 'coordinador' (23-oct) y ninguna política nueva en comp_tomas (B1):
-- el monitorista lee por comp_mis_tomas y comp_estado_tomas.

-- ------------------------------------------------------------
-- 1f) Bitácora: acciones de la fase 3.
-- ------------------------------------------------------------
alter table public.comp_movimientos drop constraint if exists comp_movimientos_accion_check;
alter table public.comp_movimientos add constraint comp_movimientos_accion_check check (accion in (
  'cargar','generar_tomas','editar_tomas','agregar_tomas','quitar_tomas','restaurar_tomas','asignar','pasar_pendiente',
  'marcar','desmarcar','cancelar','restaurar','cerrar','reabrir','editar','agregar_sitios','regla','retirar','regresar',
  'plantilla','refrescar_rutas','registrar_tomas','rechazar_fotos','regresar_toma','reabrir_toma','comprobar_toma'));
-- (Cada foto «correcta» no se registra: son miles.)

-- ------------------------------------------------------------
-- 1g) Internas (sin grant: solo las llaman otras funciones security definer).
-- ------------------------------------------------------------

-- ¿p_email es manager? (correo ya en minúsculas).
create or replace function public.comp_es_manager(p_email text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from usuario_roles ur where lower(ur.usuario_email) = lower(btrim(p_email)) and ur.rol = 'manager')
$$;

-- M6: ¿la captura está abierta para p_email? (lista comp_piloto o '*').
create or replace function public.comp_captura_abierta(p_email text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from comp_piloto p where p.email in (lower(btrim(p_email)), '*'))
$$;

-- ¿Es una toma de p_email? Manager, o monitorista VIGENTE de la unidad de la
-- toma que la tiene asignada, la envió o subió una foto vigente ligada a ella
-- (M2: reasignar una toma con fotos no atora la cola de quien las subió).
-- Nunca el Supervisor ni la analista pura (M4, 26-oct-2026).
create or replace function public.comp_es_mi_toma(p_toma_id bigint, p_email text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select comp_es_manager(p_email)
      or exists (select 1 from comp_tomas t
                  where t.id = p_toma_id
                    and comp_tiene_rol_en(p_email, 'monitorista', t.unidad)
                    and (t.monitorista_email = lower(btrim(p_email)) or t.tomada_por = lower(btrim(p_email))
                         or exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                                     where et.toma_id = t.id and et.regresada_en is null
                                       and e.subido_por = lower(btrim(p_email)))))
$$;

-- Plantilla VIGENTE de una toma: la de testigo de su campaña (NULL = 'unica')
-- ∪ la de mueble de su máquina (Biobox: inventario.tipo_mueble de la cara del
-- sitio, la Digital primero). Dos posiciones iguales (pos, momento) se juntan
-- con el n mayor y alcance 'sitio' si alguna lo es; la etiqueta es la de la
-- capa testigo. Orden: testigo primero, mueble al final. NULL si la toma no
-- existe. Una toma ya enviada se cuenta contra plantilla_usada (A2), no contra esta.
create or replace function public.comp_plantilla_toma(p_toma_id bigint) returns jsonb
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  with t as (
    select t.id, t.unidad, c.plantilla_codigo, s.vendor_face_id
      from comp_tomas t join comp_campanas c on c.id = t.campana_id join comp_sitios s on s.id = t.sitio_id
     where t.id = p_toma_id
  ), capas as (
    select 0 as capa_n, p.posiciones
      from t join comp_plantillas_toma p on p.codigo = coalesce(t.plantilla_codigo, 'unica')
    union all
    select 1, p.posiciones
      from t
      cross join lateral (select i.tipo_mueble from inventario i
                           where i.vendor_face_id = t.vendor_face_id and i.unidad_negocio = t.unidad
                           order by (i.tipo_medio = 'Digital') desc limit 1) i
      join comp_plantillas_toma p on p.capa = 'mueble' and p.activa and p.unidad = t.unidad and p.mueble = i.tipo_mueble
  ), pos as (
    select c.capa_n, e.ord, e.x from capas c cross join lateral jsonb_array_elements(c.posiciones) with ordinality e(x, ord)
  ), g as (
    select x->>'pos' as pos, nullif(x->>'momento', '') as momento, max((x->>'n')::int) as n,
           bool_or(x->>'alcance' = 'sitio') as de_sitio,
           (array_agg(x->>'etiqueta' order by capa_n, ord))[1] as etiqueta,
           min(capa_n * 1000 + ord) as orden
      from pos group by 1, 2
  )
  select coalesce((select jsonb_agg(jsonb_build_object('pos', g.pos, 'n', g.n,
                                                       'alcance', case when g.de_sitio then 'sitio' else 'version' end,
                                                       'momento', g.momento, 'etiqueta', g.etiqueta) order by g.orden)
                     from g), '[]'::jsonb)
   where exists (select 1 from t)
$$;

-- Lo que le falta a una toma contra p_plantilla: por posición, las fotos
-- (tipo 'foto') con liga vigente a la toma, misma pos y momento; con
-- p_solo_buenas, solo las que tienen revisión correcta o editada.
-- Devuelve [{pos, momento, etiqueta, n, tiene}] de las que faltan; '[]' = completa.
-- Espejo en la app: src/lib/plantillasComp.ts.
create or replace function public.comp_faltan(p_toma_id bigint, p_plantilla jsonb, p_solo_buenas boolean) returns jsonb
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select coalesce(jsonb_agg(jsonb_build_object('pos', x.pos, 'momento', x.momento, 'etiqueta', x.etiqueta,
                                               'n', x.n, 'tiene', x.tiene) order by x.ord), '[]'::jsonb)
    from (select p.ord, p.x->>'pos' as pos, nullif(p.x->>'momento', '') as momento, p.x->>'etiqueta' as etiqueta,
                 coalesce((p.x->>'n')::int, 1) as n,
                 (select count(*)::int
                    from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                   where et.toma_id = p_toma_id and et.regresada_en is null and e.tipo = 'foto'
                     and e.pos = p.x->>'pos' and e.momento is not distinct from nullif(p.x->>'momento', '')
                     and (not coalesce(p_solo_buenas, false)
                          or exists (select 1 from comp_revision_fotos r
                                      where r.evidencia_id = et.evidencia_id and r.toma_id = et.toma_id
                                        and r.estado in ('correcta', 'editada')))) as tiene
            from jsonb_array_elements(case when jsonb_typeof(p_plantilla) = 'array' then p_plantilla else '[]'::jsonb end)
                 with ordinality p(x, ord)) x
   where x.tiene < x.n
$$;

-- A4/M2/M3 (26-oct-2026): recalcula ruta y monitorista de las tomas
-- PENDIENTES sin monitorista puesto a mano (monitorista_manual = false; de
-- origen 'plan' o 'app'), de campañas abiertas no retiradas, con
-- comp_ruta_sitio una vez por sitio, no por toma. Nunca toca una toma con
-- fotos ligadas (M2) ni espera un candado: las tomas que otra sesión tiene
-- tomadas se saltan (skip locked) y se corrigen la siguiente vez.
--   p_email NULL = todas las del rango (Supervisor, al abrir Formato/Excel);
--   con correo = solo las de ese monitorista y las de sitios de sus rutas
--   (comp_mis_tomas). Devuelve cuántas tomas cambiaron.
-- Si alguien pierde la ruta, sus tomas sin fotos pasan al nuevo asignado o a
-- «sin monitorista»; con importar_rutas (ids nuevos) el ruta_id se corrige aquí.
-- Revisión del 26-oct-2026 (sql-3): «una vez por sitio» no lo aseguraba un
-- CTE (Postgres 12+ lo mete en la consulta y, sin estadísticas, como pasa con
-- el primer Armar grande, llamaba comp_ruta_sitio una vez POR TOMA: 99,200
-- veces en un plan diario de VV). Ahora la ruta de cada sitio se calcula
-- primero y se fija en arreglos; el UPDATE entra a comp_tomas por sitio_id.
create or replace function public.comp_refrescar_rutas(p_email text, p_unidades text[], p_desde date, p_hasta date)
returns int language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_email text := lower(nullif(btrim(p_email), ''));
  v_n int := 0;
  v_s bigint[]; v_r bigint[]; v_num int[]; v_m text[];
begin
  if coalesce(cardinality(p_unidades), 0) = 0 or p_desde is null or p_hasta is null then
    return 0;
  end if;
  -- 1) La ruta de cada sitio (~1,000 sitios en VV), una vez.
  select array_agg(x.sitio_id), array_agg(r.ruta_id), array_agg(r.ruta_numero), array_agg(r.monitorista_email)
    into v_s, v_r, v_num, v_m
    from (select distinct s.id as sitio_id, s.unidad, s.site_id, s.sitio_clave
            from comp_tomas t join comp_sitios s on s.id = t.sitio_id join comp_campanas c on c.id = t.campana_id
           where t.estado = 'pendiente' and not t.monitorista_manual and c.estatus = 'abierta' and not c.retirada
             and t.unidad = any (p_unidades) and t.fecha between p_desde and p_hasta
             and (v_email is null or t.monitorista_email = v_email
                  or s.site_id in (select ru.site_id from ruta_ubicaciones ru join ruta_asignaciones a on a.ruta_id = ru.ruta_id
                                    where lower(a.usuario_email) = v_email)
                  or s.sitio_clave in (select ru.site_id from ruta_ubicaciones ru join ruta_asignaciones a on a.ruta_id = ru.ruta_id
                                        where lower(a.usuario_email) = v_email))) x
    left join lateral comp_ruta_sitio(x.unidad, x.site_id, x.sitio_clave) r on true;
  if v_s is null then
    return 0;
  end if;
  -- 2) Sus tomas que cambian (por comp_tomas_sitio).
  with cand as (
    select t.id, n.ruta_id, n.ruta_numero, n.monitorista_email
      from unnest(v_s, v_r, v_num, v_m) n(sitio_id, ruta_id, ruta_numero, monitorista_email)
      join comp_tomas t on t.sitio_id = n.sitio_id
     where t.estado = 'pendiente' and not t.monitorista_manual and t.fecha between p_desde and p_hasta
       and not exists (select 1 from comp_evidencia_tomas et where et.toma_id = t.id)          -- M2
       and (t.ruta_id, t.ruta_numero, t.monitorista_email) is distinct from (n.ruta_id, n.ruta_numero, n.monitorista_email)
       for update of t skip locked                                                             -- nunca espera
  )
  update comp_tomas t set ruta_id = cand.ruta_id, ruta_numero = cand.ruta_numero, monitorista_email = cand.monitorista_email
    from cand where t.id = cand.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Crédito del sitio por revisión (§4.3; Erik, 26-oct-2026: el sitio cuenta
-- con su primera toma comprobada, el día de la foto). Nace aquí para que
-- comp_cargar_campanas y comp_restaurar_sitios la llamen (V3); con las tablas
-- nuevas vacías no hace nada. Orden de candados: SIEMPRE después de las tomas.
--   · Sitio cancelado o marcado a mano (comprobado_via 'marca'): no se toca.
--   · Primera toma 'comprobada' (comprobada_en, id): si el sitio ya contaba
--     por revisión, o sigue en la carga de una campaña no retirada →
--     comprobado por revisión; día = el más reciente de sus fotos buenas
--     (nunca antes de la fecha de la toma ni después del día de la revisión).
--   · Sin toma comprobada y el sitio contaba por revisión → vuelve a pendiente.
create or replace function public.comp_sitio_credito(p_sitio_id bigint) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_s record; v_t record; v_dia date;
begin
  select s.id, s.estado, s.comprobado_via, s.fuera_de_carga, s.campana_id into v_s
    from comp_sitios s where s.id = p_sitio_id
    for no key update;                                   -- B8: no cambia ninguna llave de comp_sitios
  if v_s.id is null or v_s.estado = 'cancelado'
     or (v_s.estado = 'comprobado' and v_s.comprobado_via is distinct from 'revision') then
    return;                                              -- la marca manda
  end if;
  select t.id, t.fecha, t.comprobada_en, t.comprobada_por into v_t
    from comp_tomas t
   where t.sitio_id = p_sitio_id and t.estado = 'comprobada'
   order by t.comprobada_en, t.id
   limit 1;
  if v_t.id is not null
     and (v_s.estado = 'comprobado'
          or (not v_s.fuera_de_carga and not exists (select 1 from comp_campanas c where c.id = v_s.campana_id and c.retirada))) then
    select greatest(v_t.fecha, max(e.fecha)) into v_dia
      from comp_evidencia_tomas et
      join comp_evidencias e on e.id = et.evidencia_id
      join comp_revision_fotos r on r.evidencia_id = et.evidencia_id and r.toma_id = et.toma_id
     where et.toma_id = v_t.id and et.regresada_en is null and r.estado in ('correcta', 'editada');
    v_dia := least(coalesce(v_dia, v_t.fecha), (v_t.comprobada_en at time zone 'America/Mexico_City')::date);
    update comp_sitios s
       set estado = 'comprobado', comprobado_via = 'revision', comprobado_toma_id = v_t.id,
           comprobado_por = v_t.comprobada_por, comprobado_dia = v_dia, comprobado_en = v_t.comprobada_en,
           actualizado_en = now()
     where s.id = p_sitio_id
       and (s.estado, s.comprobado_via, s.comprobado_toma_id, s.comprobado_por, s.comprobado_dia, s.comprobado_en)
           is distinct from ('comprobado', 'revision', v_t.id, v_t.comprobada_por, v_dia, v_t.comprobada_en);
  elsif v_t.id is null and v_s.estado = 'comprobado' then   -- aquí ya es por revisión
    update comp_sitios s
       set estado = 'pendiente', comprobado_via = null, comprobado_toma_id = null, comprobado_por = null,
           comprobado_dia = null, comprobado_en = null, actualizado_en = now()
     where s.id = p_sitio_id;
  end if;
end $$;

revoke all on function public.comp_es_manager(text), public.comp_captura_abierta(text),
  public.comp_es_mi_toma(bigint, text), public.comp_plantilla_toma(bigint), public.comp_faltan(bigint, jsonb, boolean),
  public.comp_refrescar_rutas(text, text[], date, date), public.comp_sitio_credito(bigint)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 1h) Reemplazos de la fase 2. El cuerpo de cada una es el de producción
--     (pg_get_functiondef del 26-oct-2026, md5 del candado de arriba) con
--     SOLO los cambios que se marcan con «Fase 3» o con su hallazgo (V1, V3,
--     M1, M2, M3, B5, R9, V6). create or replace conserva sus grants.
-- ------------------------------------------------------------

-- comp_ruta_sitio — V1 (26-oct-2026): las máquinas de Biobox de Impreso
-- (M4 URBANA incluida, ~61) viven en rutas Impreso; en Biobox y Vía Verde
-- vale una ruta de cualquier medio. En Ecovallas, solo Digital o Combinada
-- (su Impreso es Pauta). Si un sitio estuviera en dos rutas, gana la que no
-- es Impreso. Firma, columnas y regla del monitorista, idénticas.
create or replace function public.comp_ruta_sitio(p_unidad text, p_site_id text, p_clave text)
returns table (ruta_id bigint, ruta_numero int, monitorista_email text)
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select r.id, r.numero,
         (select lower(btrim(a.usuario_email)) from ruta_asignaciones a
           where a.ruta_id = r.id and comp_tiene_rol_en(a.usuario_email, 'monitorista', p_unidad)
           order by a.creado_en nulls last, lower(a.usuario_email) limit 1)
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id
   where ru.site_id in (p_site_id, p_clave)
     and r.unidad_negocio = p_unidad and (r.tipo_medio in ('Digital', 'Combinada') or p_unidad <> 'Ecovallas') and r.activa
   order by (ru.site_id = p_site_id) desc nulls last, (r.tipo_medio <> 'Impreso') desc, r.id
   limit 1
$$;

-- comp_campana_con_trabajo — Fase 3 (26-oct-2026): una foto ligada a una
-- toma de la campaña también es trabajo (borrarla tiraría la foto).
create or replace function public.comp_campana_con_trabajo(p_id bigint) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from comp_campanas c
                  where c.id = p_id
                    and (c.asignacion_origen = 'app' or cardinality(c.editado_app) > 0 or c.meta_app is not null
                         or c.fecha_limite is not null or c.entrega_tipo <> 'enviar'))
      or exists (select 1 from comp_sitios s where s.campana_id = p_id and (s.estado <> 'pendiente' or s.origen = 'app'))
      or exists (select 1 from comp_tomas t where t.campana_id = p_id and (t.origen = 'app' or t.estado <> 'pendiente'))
      -- Fase 3 (26-oct-2026): una foto ligada a una de sus tomas también es trabajo.
      or exists (select 1 from comp_evidencia_tomas et join comp_tomas t on t.id = et.toma_id where t.campana_id = p_id)
$$;

-- comp_aplicar_planes — M2/B5 (26-oct-2026): una toma del plan con fotos
-- ligadas no se borra ni se actualiza (ni su monitorista); si el plan ya no la
-- quiere se queda pendiente y sale en con_fotos_fuera_del_plan para que el
-- Supervisor decida. sql-6 (revisión del 26-oct-2026): a una toma del plan con
-- monitorista puesto a mano (monitorista_manual) no le cambia ruta ni
-- monitorista. Lo demás, idéntico.
create or replace function public.comp_aplicar_planes(p_ids bigint[], p_plan jsonb) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_can int := 0; v_reg int := 0; v_nue int := 0; v_bor int := 0; v_act int := 0; v_cons int := 0; v_omit int := 0;
  v_sin bigint[]; v_fuera bigint[]; v_fotos bigint[];
begin
  -- 1) Editadas a mano de sitios que salieron (o volvieron).
  update comp_tomas t set estado = 'cancelada', baja_auto = true
    from comp_sitios s, comp_campanas c
   where t.campana_id = any (p_ids) and s.id = t.sitio_id and c.id = t.campana_id and c.estatus = 'abierta'
     and t.origen = 'app' and t.estado = 'pendiente'
     and (s.estado = 'cancelado' or s.fuera_de_carga or c.retirada);
  get diagnostics v_can = row_count;
  update comp_tomas t set estado = 'pendiente', baja_auto = false
    from comp_sitios s, comp_campanas c
   where t.campana_id = any (p_ids) and s.id = t.sitio_id and c.id = t.campana_id and c.estatus = 'abierta'
     and t.baja_auto and t.estado = 'cancelada'
     and s.estado <> 'cancelado' and not s.fuera_de_carga and not c.retirada;
  get diagnostics v_reg = row_count;

  -- 2) Campañas con plan y lo deseado.
  drop table if exists pg_temp.comp_ap_cam;
  create temp table comp_ap_cam on commit drop as
  select c.id, c.unidad, c.inicio, c.fin, c.retirada, p.fecha_inicio as p_ini, p.fecha_fin as p_fin,
         coalesce(p_plan, c.plan_tomas) as plan
    from comp_campanas c join comp_periodos p on p.id = c.periodo_id
   where c.id = any (p_ids) and c.estatus = 'abierta' and coalesce(p_plan, c.plan_tomas) is not null;

  drop table if exists pg_temp.comp_ap_sit;
  create temp table comp_ap_sit on commit drop as
  select s.id as sitio_id, c.id as campana_id, c.unidad, s.inicio, s.fin, s.tramos, c.inicio as c_ini, c.fin as c_fin,
         c.p_ini, c.p_fin, c.plan, s.horario_lv, s.horario_sd, s.observaciones,
         (s.estado <> 'comprobado' or coalesce(c.plan->'incluir_comprobados' = 'true'::jsonb, false)) as crea,
         r.ruta_id, r.ruta_numero, r.monitorista_email
    from pg_temp.comp_ap_cam c
    join comp_sitios s on s.campana_id = c.id and s.estado <> 'cancelado' and not s.fuera_de_carga
    left join lateral comp_ruta_sitio(c.unidad, s.site_id, s.sitio_clave) r on true
   where not c.retirada;

  drop table if exists pg_temp.comp_ap_des;
  create temp table comp_ap_des on commit drop as
  select distinct on (x.sitio_id, f.fecha)
         x.sitio_id, x.campana_id, x.unidad, f.fecha, x.crea,
         nullif(btrim(case when extract(isodow from f.fecha) <= 5 then x.horario_lv else x.horario_sd end), '') as horario_texto,
         x.observaciones, x.ruta_id, x.ruta_numero, x.monitorista_email
    from pg_temp.comp_ap_sit x
    cross join lateral comp_ventanas(x.inicio, x.fin, x.tramos, x.c_ini, x.c_fin, x.p_ini, x.p_fin) w
    cross join lateral comp_fechas_plan(x.plan, w.ini, w.fin) as f(fecha)
   order by x.sitio_id, f.fecha;
  create index on pg_temp.comp_ap_des (sitio_id, fecha);
  analyze pg_temp.comp_ap_des;

  -- 3) Borrar, actualizar e insertar (una sentencia cada uno para todo el lote).
  delete from comp_tomas t using pg_temp.comp_ap_cam c
   where t.campana_id = c.id and t.origen = 'plan' and t.estado = 'pendiente'
     and not exists (select 1 from pg_temp.comp_ap_des d where d.sitio_id = t.sitio_id and d.fecha = t.fecha)
     -- M2/B5 (26-oct-2026): una toma con fotos ligadas no se borra.
     and not exists (select 1 from comp_evidencia_tomas et where et.toma_id = t.id);
  get diagnostics v_bor = row_count;

  -- Revisión del 26-oct-2026 (sql-6): poner el monitorista a mano ya no
  -- vuelve 'app' la toma; sigue siendo del plan, pero su ruta y su monitorista
  -- (monitorista_manual) no los toca el plan, igual que comp_refrescar_rutas.
  update comp_tomas t
     set horario_texto = d.horario_texto, observaciones = d.observaciones,
         ruta_id = case when t.monitorista_manual then t.ruta_id else d.ruta_id end,
         ruta_numero = case when t.monitorista_manual then t.ruta_numero else d.ruta_numero end,
         monitorista_email = case when t.monitorista_manual then t.monitorista_email else d.monitorista_email end
    from pg_temp.comp_ap_des d
   where t.sitio_id = d.sitio_id and t.fecha = d.fecha and t.campana_id = d.campana_id
     and t.origen = 'plan' and t.estado = 'pendiente'
     and (t.horario_texto, t.observaciones, t.ruta_id, t.ruta_numero, t.monitorista_email)
         is distinct from (d.horario_texto, d.observaciones,
                           case when t.monitorista_manual then t.ruta_id else d.ruta_id end,
                           case when t.monitorista_manual then t.ruta_numero else d.ruta_numero end,
                           case when t.monitorista_manual then t.monitorista_email else d.monitorista_email end)
     -- M2 (26-oct-2026): ni cambia de monitorista.
     and not exists (select 1 from comp_evidencia_tomas et where et.toma_id = t.id);
  get diagnostics v_act = row_count;

  insert into comp_tomas (campana_id, sitio_id, unidad, fecha, fecha_plan, horario_texto, observaciones,
                          ruta_id, ruta_numero, monitorista_email, origen)
  select d.campana_id, d.sitio_id, d.unidad, d.fecha, d.fecha, d.horario_texto, d.observaciones,
         d.ruta_id, d.ruta_numero, d.monitorista_email, 'plan'
    from pg_temp.comp_ap_des d
   where d.crea
     and not exists (select 1 from comp_tomas t
                      where t.sitio_id = d.sitio_id and t.origen = 'app' and t.fecha_plan = d.fecha)
  on conflict (campana_id, sitio_id, fecha) do nothing;
  get diagnostics v_nue = row_count;

  -- 4) Reporte.
  select count(*) into v_omit from pg_temp.comp_ap_des d
   where not d.crea and not exists (select 1 from comp_tomas t where t.sitio_id = d.sitio_id and t.fecha = d.fecha);
  select count(*) into v_cons from comp_tomas t join pg_temp.comp_ap_cam c on c.id = t.campana_id
   where t.origen = 'app' or t.estado <> 'pendiente';
  select array_agg(c.id order by c.id) into v_sin from pg_temp.comp_ap_cam c
   where not exists (select 1 from pg_temp.comp_ap_des d where d.campana_id = c.id);
  select array_agg(t.id order by t.id) into v_fuera
    from comp_tomas t
    join comp_sitios s on s.id = t.sitio_id
    join comp_campanas c on c.id = t.campana_id
    join comp_periodos p on p.id = c.periodo_id
   where t.campana_id = any (p_ids) and c.estatus = 'abierta' and t.origen = 'app' and t.estado = 'pendiente'
     and not exists (select 1 from comp_ventanas(s.inicio, s.fin, s.tramos, c.inicio, c.fin, p.fecha_inicio, p.fecha_fin) w
                      where t.fecha between w.ini and w.fin);
  -- B5 (26-oct-2026): tomas del plan con fotos que el plan ya no quiere; se
  -- quedan pendientes (no baja_auto) para que el Supervisor decida.
  select array_agg(t.id order by t.id) into v_fotos
    from comp_tomas t join pg_temp.comp_ap_cam c on c.id = t.campana_id
   where t.origen = 'plan' and t.estado = 'pendiente'
     and exists (select 1 from comp_evidencia_tomas et where et.toma_id = t.id)
     and not exists (select 1 from pg_temp.comp_ap_des d where d.sitio_id = t.sitio_id and d.fecha = t.fecha);

  update comp_campanas c set plan_tomas = x.plan, actualizado_en = now()
    from pg_temp.comp_ap_cam x
   where c.id = x.id and c.plan_tomas is distinct from x.plan;

  return jsonb_build_object('nuevas', v_nue, 'borradas', v_bor, 'actualizadas', v_act, 'conservadas', v_cons,
                            'canceladas_auto', v_can, 'regresadas_auto', v_reg, 'omitidas_comprobados', v_omit,
                            'sin_tomas', to_jsonb(coalesce(v_sin, '{}')),
                            'app_fuera_de_vigencia', to_jsonb(coalesce(v_fuera, '{}')),
                            'con_fotos_fuera_del_plan', to_jsonb(coalesce(v_fotos, '{}')));
end $$;

-- comp_cargar_campanas — (a) M1 (26-oct-2026): un sitio que sale de la carga
-- y tiene una toma con fotos ligadas no se borra: queda fuera_de_carga.
-- (b) V3: un sitio fuera_de_carga que vuelve recalcula su crédito por
-- revisión (comp_sitio_credito). Lo demás (y el comentario largo de
-- 20261023193250_comp_base.sql), idéntico.
create or replace function public.comp_cargar_campanas(p_unidad text, p_medio text, p_periodo jsonb,
  p_campanas jsonb, p_solo_revisar boolean default false, p_completa boolean default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_revisar boolean := coalesce(p_solo_revisar, false);
  v_tipo text := p_periodo->>'tipo';
  v_anio int; v_num int; v_ini date; v_fin date; v_etq text; v_pid bigint;
  v_ncam int; v_nsit int; v_mal int; v_mal_txt text; v_todas_vv boolean; v_completa boolean;
  v_rep jsonb; v_tom jsonb; v_lista jsonb; v_ids bigint[]; v_cambio bigint[]; v_x bigint[]; v_ret_ids bigint[];
  v_ret jsonb := jsonb_build_object('borradas', 0, 'lista', '[]'::jsonb, 'marcadas', '[]'::jsonb);
  v_c_nue int := 0; v_c_act int := 0; v_c_dup int := 0; v_app_cons int := 0; v_sin_analista int := 0;
  v_s_nue int := 0; v_s_act int := 0; v_s_baja int := 0; v_s_fuera int := 0;
  v_cerradas jsonb; v_sin_inv jsonb; v_edomex jsonb; v_inactivas jsonb; v_otro_medio jsonb; v_no_rec jsonb;
  v_fuera_per jsonb; v_repetidos jsonb; v_dups jsonb; v_adoptadas jsonb;
  v_vuelven bigint[];
begin
  -- 1) Validación y permiso (antes de tocar nada)
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.';
  end if;
  if not ((p_unidad = 'Ecovallas' and p_medio = 'Pantalla') or (p_unidad = 'Biobox' and p_medio = 'Máquina')
       or (p_unidad = 'Vía Verde' and p_medio in ('Columna', 'Pórtico'))) then
    raise exception 'Unidad o medio no válidos: % / %.', p_unidad, p_medio;
  end if;
  if not comp_gestiona(p_unidad) then
    raise exception 'Solo el Supervisor (o el Admin) carga campañas de %.', comp_etiqueta_unidad(p_unidad);
  end if;
  if jsonb_typeof(p_campanas) is distinct from 'array' or jsonb_array_length(p_campanas) = 0 then
    raise exception 'No hay campañas que cargar.';
  end if;
  v_ncam := jsonb_array_length(p_campanas);
  select count(*) into v_mal from jsonb_array_elements(p_campanas) e where jsonb_typeof(e) <> 'object';
  if v_mal > 0 then
    raise exception 'La lista de campañas viene mal armada. No se cargó nada.';
  end if;
  select coalesce(sum(case when jsonb_typeof(e->'sitios') = 'array' then jsonb_array_length(e->'sitios') else 0 end), 0)
    into v_nsit from jsonb_array_elements(p_campanas) e;
  -- Vía Verde completo son ~250 campañas-versión y ~3,200 sitios.
  if v_ncam > 1000 or v_nsit > 20000 then
    raise exception 'Demasiado para una carga (% campañas, % sitios). Revisa que sea de un solo periodo.', v_ncam, v_nsit;
  end if;

  select count(*), string_agg(n::text, ', ' order by n) into v_mal, v_mal_txt
    from (select o.n from jsonb_array_elements(p_campanas) with ordinality o(e, n)
           where nullif(btrim(o.e->>'campana'), '') is null
              or coalesce(o.e->>'fuente', '') not in ('bitacora', 'pauta_vv', 'plano', 'manual')
              or (o.e->>'fuente' in ('pauta_vv', 'plano') and p_unidad <> 'Vía Verde')
              or coalesce(jsonb_typeof(o.e->'sitios'), 'null') not in ('array', 'null')
           limit 20) x;
  if v_mal > 0 then
    raise exception 'Hay campañas sin nombre, sin fuente válida o con los sitios mal armados (posiciones %). No se cargó nada.', v_mal_txt;
  end if;
  -- Un sitio sin clave rechaza la carga (#8): nunca se convierte en otra cosa.
  select count(*) into v_mal
    from jsonb_array_elements(p_campanas) e
    cross join lateral jsonb_array_elements(case when jsonb_typeof(e->'sitios') = 'array' then e->'sitios' else '[]'::jsonb end) s
   where jsonb_typeof(s) <> 'object' or comp_clave_sitio(s->>'sitio_clave') is null;
  if v_mal > 0 then
    raise exception '% sitio(s) vienen sin clave. No se cargó nada.', v_mal;
  end if;
  -- Fechas solo 'AAAA-MM-DD' (R6). La forma se revisa aquí; un día que no
  -- existe ('2026-13-45') lo rechaza la conversión más abajo.
  select count(*), string_agg(n::text, ', ' order by n) into v_mal, v_mal_txt
    from (select o.n from jsonb_array_elements(p_campanas) with ordinality o(e, n)
           where exists (
                   select 1
                     from (select o.e->'inicio' as x union all select o.e->'fin'
                           union all
                           select s->'inicio' from jsonb_array_elements(case when jsonb_typeof(o.e->'sitios') = 'array'
                                                                             then o.e->'sitios' else '[]'::jsonb end) s
                           union all
                           select s->'fin' from jsonb_array_elements(case when jsonb_typeof(o.e->'sitios') = 'array'
                                                                          then o.e->'sitios' else '[]'::jsonb end) s) f
                    where f.x is not null and jsonb_typeof(f.x) <> 'null'
                      and (jsonb_typeof(f.x) <> 'string' or (f.x #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
           limit 20) x;
  if v_mal > 0 then
    raise exception 'Hay fechas que no vienen como AAAA-MM-DD (campañas en las posiciones %). No se cargó nada.', v_mal_txt;
  end if;

  -- ¿Foto completa? (R1/R2)
  select bool_and(e->>'fuente' in ('pauta_vv', 'plano')) into v_todas_vv from jsonb_array_elements(p_campanas) e;
  if p_completa and not v_todas_vv then
    raise exception 'Solo una carga de Pauta VV o del plano es la foto completa del periodo; la bitácora y el alta manual no.';
  end if;
  v_completa := coalesce(p_completa, v_todas_vv);

  -- 2) Periodo
  begin
    v_anio := (p_periodo->>'anio')::int;
    v_num := (p_periodo->>'numero')::int;
  exception when others then
    raise exception 'Periodo no válido: %.', p_periodo;
  end;
  if v_anio is null or v_num is null then
    raise exception 'Periodo no válido: %.', p_periodo;
  end if;
  if (p_unidad = 'Ecovallas') <> (v_tipo is not distinct from 'catorcena') then
    raise exception 'Ecovallas Digital va por catorcena; Biobox y Vía Verde, por mes.';
  end if;
  if v_tipo = 'catorcena' then
    select fecha_inicio, fecha_fin into v_ini, v_fin from catorcenas where anio = v_anio and numero = v_num;
    if not found then
      raise exception 'La Cat-% de % no está en el calendario.', v_num, v_anio;
    end if;
    if v_ini is null or v_fin is null or v_fin < v_ini then   -- #26
      raise exception 'La Cat-% de % no tiene fechas válidas en el calendario.', v_num, v_anio;
    end if;
    v_etq := 'Cat-' || v_num || ' · ' || v_anio;
  elsif v_tipo = 'mes' and v_num between 1 and 12 and v_anio between 2020 and 2100 then
    v_ini := make_date(v_anio, v_num, 1);
    v_fin := (v_ini + interval '1 month')::date - 1;
    v_etq := (array['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre',
                    'Octubre', 'Noviembre', 'Diciembre'])[v_num] || ' ' || v_anio;
  else
    raise exception 'Periodo no válido: %.', p_periodo;
  end if;

  -- Una carga a la vez por unidad y periodo (Columnas y Pórticos comparten periodo).
  perform pg_advisory_xact_lock(hashtext('comp_cargar_campanas'),
                                hashtext(p_unidad || '|' || v_tipo || '|' || v_anio || '|' || v_num));

  begin  -- ===== todo lo de este bloque se deshace en modo «solo revisar» =====
    insert into comp_periodos (unidad, tipo, anio, numero, fecha_inicio, fecha_fin, etiqueta, creado_por)
    values (p_unidad, v_tipo, v_anio, v_num, v_ini, v_fin, v_etq, v_email)
    on conflict (unidad, tipo, anio, numero) do update
      set fecha_inicio = excluded.fecha_inicio, fecha_fin = excluded.fecha_fin, etiqueta = excluded.etiqueta
    returning id into v_pid;

    -- Entrada → tablas temporales. Un tipo que no se entiende (fecha,
    -- número, sí/no) rechaza la carga con un mensaje claro.
    begin
      drop table if exists pg_temp.comp_car_cam;
      create temp table comp_car_cam on commit drop as
      select (o.n - 1)::int as i, x.*,
             comp_llave(x.campana) as cl, comp_llave(coalesce(x.version, '')) as vl,
             lower(nullif(btrim(x.analista_email), '')) as analista_in,
             coalesce(comp_es_analista_de(nullif(btrim(x.analista_email), ''), p_unidad), false) as analista_ok,
             jsonb_typeof(o.e->'sitios') = 'array' as trae_sitios,
             o.e->'sitios' as sitios_json
        from jsonb_array_elements(p_campanas) with ordinality o(e, n),
             jsonb_to_record(o.e) as x(fuente text, origen_ref text, cliente text, campana text, version text,
               vendedor text, administrador text, quantum text, mediamonitor boolean, especificacion text,
               arte text, inicio date, fin date, es_full boolean, full_minutos int, analista_email text);

      drop table if exists pg_temp.comp_car_sit0;
      create temp table comp_car_sit0 on commit drop as
      select t.i, (o.n - 1)::int as j, y.*
        from pg_temp.comp_car_cam t
        cross join lateral jsonb_array_elements(case when t.trae_sitios then t.sitios_json else '[]'::jsonb end)
             with ordinality o(e, n)
        cross join lateral jsonb_to_record(o.e) as y(sitio_clave text, sitio_original text, espacio_vv text,
               inicio date, fin date, horario_lv text, horario_sd text, tipo_venta text, testigos boolean,
               observaciones text);
    exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation
                   or numeric_value_out_of_range or invalid_parameter_value then
      raise exception 'Hay una fecha, un número o un sí/no que no se entiende (%). No se cargó nada.', sqlerrm;
    end;

    select string_agg(distinct t.campana, ', ') into v_mal_txt
      from pg_temp.comp_car_cam t where t.fin < t.inicio;
    if v_mal_txt is not null then
      raise exception 'La vigencia termina antes de empezar en: %. No se cargó nada.', v_mal_txt;
    end if;
    select string_agg(distinct t.campana || ' · ' || x.sitio_clave, ', ') into v_mal_txt
      from pg_temp.comp_car_sit0 x join pg_temp.comp_car_cam t on t.i = x.i where x.fin < x.inicio;
    if v_mal_txt is not null then
      raise exception 'La vigencia del sitio termina antes de empezar en: %. No se cargó nada.', v_mal_txt;
    end if;

    select count(*) - count(distinct (cl, vl)) into v_c_dup from pg_temp.comp_car_cam;

    -- Plano → Pauta VV (23-oct-2026): la fila del plano (versión '') se
    -- adopta cuando llega la misma campaña con UNA versión. Va antes de
    -- comp_car_antes para que la adoptada cuente como campaña que ya
    -- existía (no nueva) y el upsert de abajo la encuentre por su llave
    -- nueva y la actualice con los datos de Pauta VV.
    -- Revisión del 23-oct-2026: (a) cuenta TODA entrada con versión, venga
    -- de Pauta VV o del plano (desdePautaVV manda lo del plano con la
    -- versión única de la campaña aunque esa versión esté en el otro
    -- medio; antes eso no adoptaba y la campaña quedaba partida); (b) exige
    -- que alguna sea de Pauta VV o del plano: la bitácora y el alta manual
    -- no adoptan, porque el plano seguiría mandando la '' y la siguiente
    -- foto crearía otra fila con los mismos sitios; (c) nunca una fila
    -- retirada: revivirla dejaría retirada la versión que la reemplazó.
    drop table if exists pg_temp.comp_car_adop;
    create temp table comp_car_adop on commit drop as
    with una as (   -- campañas que llegan con UNA sola versión no vacía
      select t.cl, min(t.vl) as vl
        from pg_temp.comp_car_cam t
       where t.vl <> ''
       group by t.cl
      having count(distinct t.vl) = 1 and bool_or(t.fuente in ('pauta_vv', 'plano')))
    select c.id, u.cl, u.vl,
           (select btrim(coalesce(t.version, '')) from pg_temp.comp_car_cam t
             where t.cl = u.cl and t.vl = u.vl order by (t.fuente = 'pauta_vv') desc, t.i limit 1) as version
      from una u
      join comp_campanas c on c.periodo_id = v_pid and c.medio = p_medio and c.campana_llave = u.cl
                          and c.version_llave = '' and c.fuente = 'plano' and c.estatus = 'abierta'
                          and not c.retirada
     where not exists (select 1 from pg_temp.comp_car_cam t where t.cl = u.cl and t.vl = '')
       and not exists (select 1 from comp_campanas c2
                        where c2.periodo_id = v_pid and c2.medio = p_medio
                          and c2.campana_llave = u.cl and c2.version_llave = u.vl);
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'campana', c.campana, 'version_antes', c.version,
                                                 'version', a.version) order by c.campana), '[]')
      into v_adoptadas
      from pg_temp.comp_car_adop a join comp_campanas c on c.id = a.id;
    update comp_campanas c set version = a.version, version_llave = a.vl, actualizado_en = now()
      from pg_temp.comp_car_adop a
     where c.id = a.id;

    -- Analista puesta en la app que la carga habría cambiado (se reporta).
    -- Va DESPUÉS de la adopción (revisión del 23-oct-2026): la fila adoptada
    -- ya tiene su llave nueva y también cuenta.
    select count(*) into v_app_cons
      from (select distinct on (t.cl, t.vl) t.* from pg_temp.comp_car_cam t order by t.cl, t.vl, t.i) t
      join comp_campanas c on c.periodo_id = v_pid and c.medio = p_medio
                          and c.campana_llave = t.cl and c.version_llave = t.vl
     where c.estatus = 'abierta' and c.asignacion_origen = 'app' and t.analista_ok
       and c.analista_email is distinct from t.analista_in;

    -- Cómo estaban las campañas que vienen (para saber si cambió su vigencia
    -- o si regresan de estar retiradas).
    drop table if exists pg_temp.comp_car_antes;
    create temp table comp_car_antes on commit drop as
    select c.id, c.inicio, c.fin, c.retirada
      from comp_campanas c
     where c.periodo_id = v_pid and c.medio = p_medio
       and (c.campana_llave, c.version_llave) in (select t.cl, t.vl from pg_temp.comp_car_cam t);

    -- 3) Campañas. Las cerradas no se tocan (#7): el WHERE del do update las
    --    salta. La analista de la app y lo editado en la app (#5) no se pisan.
    --    Una retirada que vuelve a venir deja de estar retirada.
    drop table if exists pg_temp.comp_car_up;
    create temp table comp_car_up (id bigint, nueva boolean) on commit drop;
    with src as (
      select distinct on (t.cl, t.vl) t.*,
             -- REPITE: quien llevó la misma campaña en otro periodo (sugerencia).
             case when not t.analista_ok then
               (select c2.analista_email from comp_campanas c2 join comp_periodos p2 on p2.id = c2.periodo_id
                 where c2.unidad = p_unidad and c2.campana_llave = t.cl and c2.periodo_id <> v_pid
                   and c2.analista_email is not null
                 order by p2.fecha_inicio desc, c2.id desc limit 1) end as sugerido
        from pg_temp.comp_car_cam t
       order by t.cl, t.vl, t.i
    ), up as (
      insert into comp_campanas as c (periodo_id, unidad, medio, fuente, origen_ref, cliente, campana, version,
             campana_llave, version_llave, vendedor, administrador, quantum, mediamonitor, especificacion, arte,
             inicio, fin, es_full, full_minutos, meta_full, analista_email, asignacion_origen, sugerido_email,
             cargado_por, cargado_en)
      select v_pid, p_unidad, p_medio, s.fuente, nullif(btrim(s.origen_ref), ''), nullif(btrim(s.cliente), ''),
             btrim(s.campana), btrim(coalesce(s.version, '')), s.cl, s.vl,
             nullif(btrim(s.vendedor), ''), nullif(btrim(s.administrador), ''), nullif(btrim(s.quantum), ''),
             s.mediamonitor, nullif(btrim(s.especificacion), ''),
             case when upper(btrim(s.arte)) in ('NUEVO', 'REPITE') then upper(btrim(s.arte)) end,
             -- FULL solo en Vía Verde (Erik, 23-oct-2026); fuera, un es_full
             -- de la carga se ignora.
             s.inicio, s.fin, coalesce(s.es_full, false) and p_unidad = 'Vía Verde',
             case when s.full_minutos >= 0 then s.full_minutos end,
             case when coalesce(s.es_full, false) and p_unidad = 'Vía Verde'
                  then comp_meta_full_propuesta(p_medio, s.full_minutos) end,
             case when s.analista_ok then s.analista_in end,
             case when s.analista_ok then 'archivo' end,
             s.sugerido, v_email, now()
        from src s
      on conflict (periodo_id, medio, campana_llave, version_llave) do update set
        fuente = excluded.fuente, origen_ref = excluded.origen_ref,
        campana = excluded.campana, version = excluded.version,
        -- es_full corregido en la app no lo pisa la recarga (23-oct-2026,
        -- hallazgo #9: el FULL con rotación que la app no reconoce).
        es_full = case when 'es_full' = any (c.editado_app) then c.es_full else excluded.es_full end,
        cliente = case when 'cliente' = any (c.editado_app) then c.cliente else excluded.cliente end,
        vendedor = case when 'vendedor' = any (c.editado_app) then c.vendedor else excluded.vendedor end,
        administrador = case when 'administrador' = any (c.editado_app) then c.administrador else excluded.administrador end,
        quantum = case when 'quantum' = any (c.editado_app) then c.quantum else excluded.quantum end,
        mediamonitor = case when 'mediamonitor' = any (c.editado_app) then c.mediamonitor else excluded.mediamonitor end,
        especificacion = case when 'especificacion' = any (c.editado_app) then c.especificacion else excluded.especificacion end,
        arte = case when 'arte' = any (c.editado_app) then c.arte else excluded.arte end,
        inicio = case when 'inicio' = any (c.editado_app) then c.inicio else excluded.inicio end,
        fin = case when 'fin' = any (c.editado_app) then c.fin else excluded.fin end,
        full_minutos = case when 'full_minutos' = any (c.editado_app) then c.full_minutos else excluded.full_minutos end,
        meta_full = case when 'meta_full' = any (c.editado_app) then c.meta_full
                         when case when 'es_full' = any (c.editado_app) then c.es_full else excluded.es_full end
                              and c.unidad = 'Vía Verde'
                           then comp_meta_full_propuesta(c.medio, case when 'full_minutos' = any (c.editado_app)
                                                                       then c.full_minutos else excluded.full_minutos end)
                         else null end,
        analista_email = case when c.asignacion_origen = 'app' or excluded.analista_email is null
                              then c.analista_email else excluded.analista_email end,
        asignacion_origen = case when c.asignacion_origen = 'app' or excluded.analista_email is null
                                 then c.asignacion_origen else excluded.asignacion_origen end,
        sugerido_email = excluded.sugerido_email,
        retirada = false, retirada_en = null, reemplazada_por = null,
        cargado_por = excluded.cargado_por, cargado_en = now(), actualizado_en = now()
      where c.estatus = 'abierta'
      returning c.id, (xmax = 0) as nueva)
    insert into pg_temp.comp_car_up select u.id, u.nueva from up u;
    select count(*) filter (where nueva), count(*) filter (where not nueva) into v_c_nue, v_c_act from pg_temp.comp_car_up;

    -- Mapa entrada → campaña (también las cerradas, para el reporte).
    drop table if exists pg_temp.comp_car_map;
    create temp table comp_car_map on commit drop as
    select t.i, c.id as campana_id, c.estatus, c.campana, c.version, coalesce(t.trae_sitios, false) as trae_sitios
      from pg_temp.comp_car_cam t
      join comp_campanas c on c.periodo_id = v_pid and c.medio = p_medio
                          and c.campana_llave = t.cl and c.version_llave = t.vl;

    select coalesce(jsonb_agg(distinct m.campana || case when m.version <> '' then ' / ' || m.version else '' end), '[]')
      into v_cerradas from pg_temp.comp_car_map m where m.estatus = 'cerrada';

    -- Campañas que cambiaron: nuevas, con otra vigencia o que regresan.
    select array_agg(u.id) into v_cambio
      from pg_temp.comp_car_up u
      join comp_campanas c on c.id = u.id
      left join pg_temp.comp_car_antes a on a.id = u.id
     where u.nueva or a.id is null or a.retirada
        or (a.inicio, a.fin) is distinct from (c.inicio, c.fin);

    -- 4) Sitios de las campañas ABIERTAS, cruzados con inventario de la
    --    unidad (#11; Ecovallas: solo caras Digital) y, en Vía Verde, con
    --    vv_espacios: EDO MEX (#2), inactivas y del otro medio no entran.
    --    Una clave sin inventario entra con en_inventario = false.
    drop table if exists pg_temp.comp_car_sit1;
    create temp table comp_car_sit1 on commit drop as
    select m.campana_id, x.i, x.j, k.clave, k.esp, i.vendor_face_id as inv_vfid, i.site_id,
           coalesce(nullif(btrim(x.sitio_original), ''), btrim(x.sitio_clave)) as sitio_original,
           x.inicio, x.fin, nullif(btrim(x.horario_lv), '') as horario_lv, nullif(btrim(x.horario_sd), '') as horario_sd,
           case when upper(btrim(x.tipo_venta)) in ('VENTA', 'BONUS') then upper(btrim(x.tipo_venta)) end as tipo_venta,
           x.testigos, nullif(btrim(x.observaciones), '') as observaciones,
           case when p_unidad = 'Vía Verde'
                     and (k.clave ~ '^MX_EM_' or coalesce(ve.tramo, '') ilike 'EDO MEX%') then 'edo_mex'
                when ve.clave is not null and not ve.activo then 'inactiva'
                when p_unidad = 'Vía Verde'
                     and coalesce(ve.tipo_espacio = 'portico', k.esp ~ '^POR_') <> (p_medio = 'Pórtico') then 'otro_medio'
           end as omitida
      from pg_temp.comp_car_sit0 x
      join pg_temp.comp_car_map m on m.i = x.i and m.estatus = 'abierta'
      cross join lateral (
        select comp_clave_sitio(x.sitio_clave) as clave,
               case when p_unidad = 'Vía Verde'
                    then coalesce(comp_clave_sitio(x.espacio_vv), comp_espacio_vv(x.sitio_clave)) end as esp) k
      left join inventario i on i.vendor_face_id = k.clave and i.unidad_negocio = p_unidad
                            and (p_unidad <> 'Ecovallas' or i.tipo_medio = 'Digital')
      left join vv_espacios ve on p_unidad = 'Vía Verde' and ve.clave = k.esp;

    -- Un renglón por (campaña, sitio), como juntarSitio() del TS, con tramos.
    drop table if exists pg_temp.comp_car_sit;
    create temp table comp_car_sit on commit drop as
    with g as (
      select x.campana_id, x.clave, count(*)::int as renglones,
             (array_agg(x.sitio_original order by x.i, x.j))[1] as sitio_original,
             (array_agg(x.esp order by x.i, x.j))[1] as espacio_vv,
             (array_agg(x.inv_vfid order by x.i, x.j))[1] as inv_vfid,
             (array_agg(x.site_id order by x.i, x.j))[1] as site_id,
             case when bool_and(x.inicio is not null) then min(x.inicio) end as inicio,
             case when bool_and(x.fin is not null) then max(x.fin) end as fin,
             array_agg(x.inicio order by x.i, x.j) as inis, array_agg(x.fin order by x.i, x.j) as fins,
             (array_agg(x.horario_lv order by x.i, x.j) filter (where x.horario_lv is not null))[1] as horario_lv,
             (array_agg(x.horario_sd order by x.i, x.j) filter (where x.horario_sd is not null))[1] as horario_sd,
             case when bool_or(x.tipo_venta = 'VENTA') then 'VENTA'
                  else (array_agg(x.tipo_venta order by x.i, x.j) filter (where x.tipo_venta is not null))[1] end as tipo_venta,
             bool_or(x.testigos) as testigos,
             array_agg(x.observaciones order by x.i, x.j) filter (where x.observaciones is not null) as obs,
             (array_agg(x.omitida order by x.i, x.j))[1] as omitida
        from pg_temp.comp_car_sit1 x
       group by x.campana_id, x.clave)
    select g.campana_id, g.clave as sitio_clave, g.renglones, g.sitio_original, g.espacio_vv, g.inv_vfid, g.site_id,
           g.inicio, g.fin,
           case when (select count(distinct (a, b)) from unnest(g.inis, g.fins) u(a, b)) > 1 then
             (select jsonb_agg(jsonb_build_object('inicio', z.a, 'fin', z.b) order by z.a nulls first, z.b nulls last)
                from (select distinct a, b from unnest(g.inis, g.fins) u(a, b)) z) end as tramos,
           g.horario_lv, g.horario_sd, g.tipo_venta, g.testigos,
           (select string_agg(z.o, ' · ' order by z.p)
              from (select o, min(p) as p from unnest(g.obs) with ordinality u(o, p) group by o) z) as observaciones,
           g.omitida
      from g;

    -- Fuera del periodo (R5): ningún tramo toca la vigencia de la campaña y
    -- el periodo. No entra (si ya estaba, se va como cualquier baja).
    update pg_temp.comp_car_sit t set omitida = 'fuera_periodo'
      from comp_campanas c
     where c.id = t.campana_id and t.omitida is null
       and not exists (select 1 from comp_ventanas(t.inicio, t.fin, t.tramos, c.inicio, c.fin, v_ini, v_fin));

    select coalesce(jsonb_agg(distinct sitio_clave) filter (where omitida = 'edo_mex'), '[]'),
           coalesce(jsonb_agg(distinct sitio_clave) filter (where omitida = 'inactiva'), '[]'),
           coalesce(jsonb_agg(distinct sitio_clave) filter (where omitida = 'otro_medio'), '[]'),
           coalesce(jsonb_agg(distinct sitio_clave) filter (where omitida is null and inv_vfid is null), '[]'),
           coalesce(jsonb_agg(distinct sitio_clave) filter (where omitida = 'fuera_periodo'), '[]')
      into v_edomex, v_inactivas, v_otro_medio, v_sin_inv, v_fuera_per
      from pg_temp.comp_car_sit;
    select coalesce(jsonb_agg(jsonb_build_object('campana', c.campana, 'version', c.version, 'sitio_clave', t.sitio_clave,
                                                 'renglones', t.renglones, 'tramos', t.tramos)
                              order by c.campana, c.version, t.sitio_clave), '[]')
      into v_repetidos
      from pg_temp.comp_car_sit t join comp_campanas c on c.id = t.campana_id
     where t.renglones > 1 and t.omitida is null;

    -- Nuevos: insert ... do nothing (no bloquea las filas que ya existen).
    with ins as (
      insert into comp_sitios (campana_id, unidad, sitio_clave, sitio_original, vendor_face_id, site_id, espacio_vv,
                               en_inventario, inicio, fin, tramos, horario_lv, horario_sd, tipo_venta, testigos,
                               observaciones, origen)
      select t.campana_id, p_unidad, t.sitio_clave, t.sitio_original, t.inv_vfid, t.site_id, t.espacio_vv,
             t.inv_vfid is not null, t.inicio, t.fin, t.tramos, t.horario_lv, t.horario_sd, t.tipo_venta, t.testigos,
             t.observaciones, 'carga'
        from pg_temp.comp_car_sit t
       where t.omitida is null
      on conflict (campana_id, sitio_clave) do nothing
      returning campana_id)
    select count(*), array_agg(distinct campana_id) into v_s_nue, v_x from ins;
    v_cambio := coalesce(v_cambio, '{}') || coalesce(v_x, '{}');

    -- V3 (26-oct-2026): los sitios fuera_de_carga que vuelven en esta carga;
    -- después del UPDATE se les recalcula el crédito por revisión.
    select array_agg(s.id order by s.id) into v_vuelven
      from comp_sitios s
      join pg_temp.comp_car_sit t on t.campana_id = s.campana_id and t.sitio_clave = s.sitio_clave
     where t.omitida is null and s.fuera_de_carga;
    -- Existentes: solo se tocan las filas que cambian (#12). NUNCA estado,
    -- comprobado_* ni cancelado_*.
    with upd as (
      update comp_sitios s
         set sitio_original = t.sitio_original, vendor_face_id = t.inv_vfid, site_id = t.site_id,
             espacio_vv = t.espacio_vv, en_inventario = (t.inv_vfid is not null),
             inicio = t.inicio, fin = t.fin, tramos = t.tramos, horario_lv = t.horario_lv, horario_sd = t.horario_sd,
             tipo_venta = t.tipo_venta, testigos = t.testigos, observaciones = t.observaciones,
             fuera_de_carga = false, actualizado_en = now()
        from pg_temp.comp_car_sit t
       where t.omitida is null and s.campana_id = t.campana_id and s.sitio_clave = t.sitio_clave
         and (s.sitio_original, s.vendor_face_id, s.site_id, s.espacio_vv, s.en_inventario, s.inicio, s.fin, s.tramos,
              s.horario_lv, s.horario_sd, s.tipo_venta, s.testigos, s.observaciones, s.fuera_de_carga)
             is distinct from
             (t.sitio_original, t.inv_vfid, t.site_id, t.espacio_vv, t.inv_vfid is not null, t.inicio, t.fin, t.tramos,
              t.horario_lv, t.horario_sd, t.tipo_venta, t.testigos, t.observaciones, false)
      returning s.campana_id)
    select count(*), array_agg(distinct campana_id) into v_s_act, v_x from upd;
    v_cambio := v_cambio || coalesce(v_x, '{}');
    perform comp_sitio_credito(x) from unnest(v_vuelven) x;   -- V3

    -- 5) Bajas, solo en campañas abiertas que trajeron su lista de sitios y
    --    solo de sitios de la carga (los agregados en la app se quedan).
    --    Anti-join contra lo que llegó (#12). Se borra solo lo pendiente sin
    --    tomas editadas ni trabajadas; lo demás queda fuera_de_carga.
    drop table if exists pg_temp.comp_car_baja;
    create temp table comp_car_baja on commit drop as
    select s.id, s.campana_id, s.fuera_de_carga as ya_fuera,
           (s.estado = 'pendiente'
            and not exists (select 1 from comp_tomas t
                             where t.sitio_id = s.id and (t.origen = 'app' or t.estado <> 'pendiente'))
            -- M1 (26-oct-2026): con una foto ligada a una de sus tomas no se borra: queda fuera_de_carga.
            and not exists (select 1 from comp_tomas t join comp_evidencia_tomas et on et.toma_id = t.id
                             where t.sitio_id = s.id)) as borrar
      from comp_sitios s
      join (select distinct mm.campana_id from pg_temp.comp_car_map mm
             where mm.estatus = 'abierta' and mm.trae_sitios) m on m.campana_id = s.campana_id
     where s.origen = 'carga'
       and not exists (select 1 from pg_temp.comp_car_sit t
                        where t.omitida is null and t.campana_id = s.campana_id and t.sitio_clave = s.sitio_clave);
    delete from comp_sitios s using pg_temp.comp_car_baja b where s.id = b.id and b.borrar;
    get diagnostics v_s_baja = row_count;
    update comp_sitios s set fuera_de_carga = true, actualizado_en = now()
      from pg_temp.comp_car_baja b
     where s.id = b.id and not b.borrar and not s.fuera_de_carga;
    select count(*) into v_s_fuera from pg_temp.comp_car_baja b where not b.borrar;
    select v_cambio || coalesce(array_agg(distinct b.campana_id), '{}') into v_cambio
      from pg_temp.comp_car_baja b where b.borrar or not b.ya_fuera;

    -- 5b) Foto completa (R1/R2): las campañas abiertas de Pauta VV / plano
    --     del periodo y medio que ya no vienen se retiran.
    if v_completa then
      select array_agg(c.id order by c.id) into v_ret_ids
        from comp_campanas c
       where c.periodo_id = v_pid and c.medio = p_medio and c.estatus = 'abierta' and not c.retirada
         and c.fuente in ('pauta_vv', 'plano')
         and not exists (select 1 from pg_temp.comp_car_map m where m.campana_id = c.id);
      if v_ret_ids is not null then
        v_ret := comp_retirar(v_ret_ids);
        select v_cambio || coalesce(array_agg(x::bigint), '{}') into v_cambio
          from jsonb_array_elements_text(v_ret->'marcadas') x;
      end if;
    end if;
    -- Posibles duplicados: la misma campaña abierta con OTRA versión que no
    -- vino (p. ej. «V1» y «VERSION 1» en dos bitácoras). No se tocan.
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'campana', c.campana, 'version', c.version,
                                                 'fuente', c.fuente) order by c.campana, c.version), '[]')
      into v_dups
      from comp_campanas c
     where c.periodo_id = v_pid and c.medio = p_medio and c.estatus = 'abierta' and not c.retirada
       and c.campana_llave in (select t.cl from pg_temp.comp_car_cam t)
       and not exists (select 1 from pg_temp.comp_car_map m where m.campana_id = c.id);

    -- 6) Plan: solo las campañas que cambiaron y lo tienen (o tienen tomas a
    --    mano que sincronizar). Lo editado a mano no se toca.
    select array_agg(distinct x) into v_cambio from unnest(v_cambio) x
     where exists (select 1 from comp_campanas c where c.id = x and c.estatus = 'abierta');
    v_tom := comp_reaplicar_planes(coalesce(v_cambio, '{}'));

    select array_agg(distinct m.campana_id) into v_ids from pg_temp.comp_car_map m where m.estatus = 'abierta';
    select coalesce(jsonb_agg(distinct t.analista_in), '[]') into v_no_rec
      from pg_temp.comp_car_cam t where t.analista_in is not null and not t.analista_ok;
    select count(*) into v_sin_analista
      from comp_campanas c where c.id = any (coalesce(v_ids, '{}')) and c.analista_email is null;
    select coalesce(jsonb_agg(jsonb_build_object(
             'i', m.i, 'id', case when v_revisar then null else m.campana_id end,
             'campana', m.campana, 'version', m.version, 'estatus', m.estatus,
             'nueva', coalesce(u.nueva, false)) order by m.i), '[]')
      into v_lista
      from pg_temp.comp_car_map m left join pg_temp.comp_car_up u on u.id = m.campana_id;

    v_rep := jsonb_build_object(
      'periodo_id', case when v_revisar then null else v_pid end, 'periodo', v_etq,
      'periodo_inicio', v_ini, 'periodo_fin', v_fin, 'unidad', p_unidad, 'medio', p_medio,
      'completa', v_completa,
      'campanas_recibidas', v_ncam, 'campanas_duplicadas', v_c_dup,
      'campanas_nuevas', v_c_nue, 'campanas_actualizadas', v_c_act, 'cerradas_sin_tocar', v_cerradas,
      'campanas_retiradas', case when v_revisar
                                 then (select coalesce(jsonb_agg(e || jsonb_build_object('reemplazada_por', null)), '[]')
                                         from jsonb_array_elements(v_ret->'lista') e)
                                 else v_ret->'lista' end,
      'campanas_borradas', (v_ret->>'borradas')::int,
      'posibles_duplicados', v_dups,
      'campanas_adoptadas', v_adoptadas,
      'analista_de_la_app_conservada', v_app_cons,
      'sitios_recibidos', v_nsit, 'sitios_nuevos', v_s_nue, 'sitios_actualizados', v_s_act,
      'sitios_baja', v_s_baja, 'sitios_fuera_de_carga', v_s_fuera,
      'sin_inventario', v_sin_inv, 'edo_mex_omitidas', v_edomex, 'inactivas_omitidas', v_inactivas,
      'otro_medio_omitidas', v_otro_medio, 'sitios_fuera_del_periodo', v_fuera_per,
      'sitios_repetidos', v_repetidos,
      'campanas_replanificadas', coalesce(cardinality(v_cambio), 0),
      'tomas_nuevas', (v_tom->>'tomas_nuevas')::int, 'tomas_borradas', (v_tom->>'tomas_borradas')::int,
      'tomas_actualizadas', (v_tom->>'tomas_actualizadas')::int,
      'tomas_canceladas', (v_tom->>'tomas_canceladas')::int, 'tomas_regresadas', (v_tom->>'tomas_regresadas')::int,
      'tomas_app_fuera_de_vigencia', v_tom->'tomas_app_fuera_de_vigencia',
      'analistas_no_reconocidos', v_no_rec, 'sin_analista', v_sin_analista,
      'campanas', v_lista);

    insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
    values ('cargar', p_unidad, v_pid, v_ids, v_ncam, v_rep - 'campanas', v_email);

    if v_revisar then
      raise exception using errcode = 'P0C01', message = 'solo revisar';
    end if;
  exception when sqlstate 'P0C01' then
    null;  -- Postgres deshizo el bloque; v_rep (variable) conserva el reporte
  end;
  return v_rep || jsonb_build_object('solo_revisar', v_revisar);
end $$;

-- comp_editar_tomas — (a) M3 (26-oct-2026): poner un monitorista lo deja
-- monitorista_manual (el refresco por rutas ya no lo pisa); dejarlo vacío
-- vuelve a «el de la ruta». Si el cambio es solo el monitorista (y notas), la
-- toma conserva su origen: la del plan sigue siendo 'plan' (sql-6). (b) R9: si la toma quitada de ese día tiene fotos
-- no se borra y el cambio se rechaza con un mensaje claro. (c) V6: una toma
-- devuelta (regresada) solo se reasigna: si el cambio es únicamente el
-- monitorista (y notas) también aplica a las regresadas; si trae otra llave,
-- las regresadas se omiten y se cuentan en regresadas_omitidas. En una
-- regresada, el vacío («el de la ruta») se resuelve en el momento con
-- comp_ruta_sitio (revisión del 26-oct-2026, sql-1).
create or replace function public.comp_editar_tomas(p_toma_ids bigint[], p_cambios jsonb)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_permitidas text[] := array['fecha', 'horario_texto', 'observaciones', 'notas', 'monitorista_email', 'turno',
                               'comprobacion', 'fuera_de_vigencia'];
  v_otras text; v_ids bigint[]; v_n int; v_fecha date; v_mon text; v_u text; v_cambiadas int := 0;
  v_forzar boolean := false; v_c jsonb; v_vig text; v_reemplazo int := 0;
  v_solo_mon boolean := false; v_reg_cam int := 0; v_reg_omit int := 0;
begin
  if jsonb_typeof(p_cambios) is distinct from 'object' or (p_cambios - 'fuera_de_vigencia') = '{}'::jsonb then
    raise exception 'No hay cambios.';
  end if;
  select string_agg(k, ', ') into v_otras from jsonb_object_keys(p_cambios) k where k <> all (v_permitidas);
  if v_otras is not null then
    raise exception 'No se puede editar: %. Solo fecha, horario, observaciones, notas, monitorista, turno y comprobación.', v_otras;
  end if;
  if p_cambios ? 'fuera_de_vigencia' then
    if jsonb_typeof(p_cambios->'fuera_de_vigencia') <> 'boolean' then
      raise exception 'fuera_de_vigencia es sí o no.';
    end if;
    v_forzar := (p_cambios->>'fuera_de_vigencia')::boolean;
  end if;
  v_c := p_cambios - 'fuera_de_vigencia';
  select array_agg(distinct x) into v_ids from unnest(p_toma_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste tomas.';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'Demasiadas tomas en un lote (%).', cardinality(v_ids);
  end if;
  select cardinality(v_ids) - count(*) into v_n from comp_tomas where id = any (v_ids);
  if v_n > 0 then
    raise exception '% toma(s) ya no existen. Recarga la lista; no se cambió nada.', v_n;
  end if;
  v_n := comp_tomas_ajenas(v_ids);
  if v_n > 0 then
    raise exception '% toma(s) son de campañas cerradas o que no llevas. No se cambió nada.', v_n;
  end if;

  if v_c ? 'fecha' then
    if cardinality(v_ids) <> 1 then
      raise exception 'La fecha se cambia de una toma a la vez.';
    end if;
    begin
      v_fecha := (v_c->>'fecha')::date;
    exception when others then
      raise exception 'La fecha no se entiende.';
    end;
    if v_fecha is null then
      raise exception 'La fecha no puede quedar vacía.';
    end if;
    select count(*) into v_n
      from comp_tomas t join comp_campanas c on c.id = t.campana_id join comp_periodos p on p.id = c.periodo_id
     where t.id = any (v_ids) and v_fecha not between p.fecha_inicio and p.fecha_fin;
    if v_n > 0 then
      raise exception 'El % no cae en el periodo de la campaña.', to_char(v_fecha, 'DD/MM/YYYY');
    end if;
    if not v_forzar then
      select string_agg('del ' || to_char(w.ini, 'DD/MM') || ' al ' || to_char(w.fin, 'DD/MM'), ', ' order by w.ini),
             count(*) filter (where v_fecha between w.ini and w.fin)
        into v_vig, v_n
        from comp_tomas t join comp_sitios s on s.id = t.sitio_id join comp_campanas c on c.id = t.campana_id
        join comp_periodos p on p.id = c.periodo_id
        cross join lateral comp_ventanas(s.inicio, s.fin, s.tramos, c.inicio, c.fin, p.fecha_inicio, p.fecha_fin) w
       where t.id = v_ids[1];
      if coalesce(v_n, 0) = 0 then
        raise exception 'El % no está en la vigencia del sitio (%). Si de todos modos va, confírmalo.',
          to_char(v_fecha, 'DD/MM/YYYY'), coalesce(v_vig, 'no corre en el periodo');
      end if;
    end if;
  end if;
  if v_c ? 'turno' and v_c->>'turno' is not null
     and v_c->>'turno' not in ('matutino', 'vespertino', 'campo') then
    raise exception 'Turno no válido: %.', v_c->>'turno';
  end if;
  if v_c ? 'monitorista_email' then
    v_mon := lower(nullif(btrim(v_c->>'monitorista_email'), ''));
    if v_mon is not null then
      for v_u in select distinct t.unidad from comp_tomas t where t.id = any (v_ids) loop
        if not comp_tiene_rol_en(v_mon, 'monitorista', v_u) then
          raise exception '% no es monitorista de %. No se cambió nada.', v_mon, comp_etiqueta_unidad(v_u);
        end if;
      end loop;
    end if;
  end if;

  -- V6 (26-oct-2026): una toma devuelta (regresada) solo se reasigna. Si el
  -- cambio es únicamente el monitorista (y, si acaso, notas), también aplica a
  -- las regresadas; con cualquier otra llave se omiten y se cuentan.
  v_solo_mon := v_c ? 'monitorista_email'
                and not exists (select 1 from jsonb_object_keys(v_c) k where k not in ('monitorista_email', 'notas'));
  if not v_solo_mon then
    select count(*) into v_reg_omit from comp_tomas t where t.id = any (v_ids) and t.estado = 'regresada';
  end if;

  begin
    -- R9: una toma quitada ese día del mismo sitio deja su lugar a la movida.
    if v_c ? 'fecha' then
      -- Fase 3 (26-oct-2026): salvo que tenga fotos ligadas (la liga no deja borrarla).
      if exists (select 1 from comp_tomas q join comp_tomas t on q.campana_id = t.campana_id and q.sitio_id = t.sitio_id
                  where t.id = v_ids[1] and t.estado = 'pendiente' and t.fecha <> v_fecha
                    and q.fecha = v_fecha and q.estado = 'cancelada' and q.id <> t.id
                    and exists (select 1 from comp_evidencia_tomas et where et.toma_id = q.id)) then
        raise exception 'Ese día hay una toma quitada con fotos: regrésala en vez de mover esta.';
      end if;
      delete from comp_tomas q using comp_tomas t
       where t.id = v_ids[1] and t.estado = 'pendiente' and t.fecha <> v_fecha
         and q.campana_id = t.campana_id and q.sitio_id = t.sitio_id and q.fecha = v_fecha
         and q.estado = 'cancelada' and q.id <> t.id
         and not exists (select 1 from comp_evidencia_tomas et where et.toma_id = q.id);
      get diagnostics v_reemplazo = row_count;
    end if;
    with upd as (
      update comp_tomas t set
        fecha = case when v_c ? 'fecha' then v_fecha else t.fecha end,
        horario_texto = case when v_c ? 'horario_texto' then nullif(btrim(v_c->>'horario_texto'), '')
                             when v_c ? 'fecha' and v_fecha is distinct from t.fecha
                               then nullif(btrim(case when extract(isodow from v_fecha) <= 5
                                                      then s.horario_lv else s.horario_sd end), '')
                             else t.horario_texto end,
        observaciones = case when v_c ? 'observaciones' then nullif(btrim(v_c->>'observaciones'), '')
                             else t.observaciones end,
        notas = case when v_c ? 'notas' then nullif(btrim(v_c->>'notas'), '') else t.notas end,
        monitorista_email = case when v_c ? 'monitorista_email' then v_mon else t.monitorista_email end,
        -- M3 (26-oct-2026): puesto a mano = manual; vacío = «el de la ruta».
        monitorista_manual = case when v_c ? 'monitorista_email' then v_mon is not null else t.monitorista_manual end,
        turno = case when v_c ? 'turno' then v_c->>'turno' else t.turno end,
        comprobacion = case when v_c ? 'comprobacion'
                            then coalesce(nullif(btrim(v_c->>'comprobacion'), ''), 'FOTO') else t.comprobacion end,
        -- Revisión del 26-oct-2026 (sql-6): solo el monitorista (y notas) no
        -- cambia el origen: una toma del plan sigue siendo del plan (no se
        -- vuelve «trabajo» de la campaña) y monitorista_manual protege lo
        -- puesto a mano. Cualquier otro cambio la vuelve 'app', como en la fase 2.
        origen = case when v_solo_mon then t.origen else 'app' end,
        editado_por = v_email, editado_en = now()
        from comp_sitios s
       where s.id = t.sitio_id and t.id = any (v_ids) and t.estado = 'pendiente'
      returning t.id, t.unidad, t.campana_id
    ), mov as (
      insert into comp_movimientos (accion, unidad, campana_ids, n, detalle, por)
      select 'editar_tomas', u.unidad, array_agg(distinct u.campana_id), count(*),
             p_cambios || jsonb_build_object('tomas', array_agg(u.id order by u.id), 'quitada_reemplazada', v_reemplazo > 0),
             v_email
        from upd u group by u.unidad
    )
    select count(*) into v_cambiadas from upd;
    -- V6: reasignar regresadas (monitorista y notas; no cambia origen, fecha ni estado).
    -- Revisión del 26-oct-2026 (sql-1): «El de la ruta» (vacío) en una
    -- devuelta toma AQUÍ la ruta y el monitorista de Rutas. El refresco por
    -- rutas solo mira pendientes (y nunca tomas con fotos), así que dejarla
    -- en NULL la dejaba huérfana: justo el atoramiento que V6 quería quitar.
    if v_solo_mon then
      with upd as (
        update comp_tomas t set
          monitorista_email = case when v_mon is not null then v_mon else r.monitorista_email end,
          ruta_id = case when v_mon is not null then t.ruta_id else r.ruta_id end,
          ruta_numero = case when v_mon is not null then t.ruta_numero else r.ruta_numero end,
          monitorista_manual = v_mon is not null,
          notas = case when v_c ? 'notas' then nullif(btrim(v_c->>'notas'), '') else t.notas end,
          editado_por = v_email, editado_en = now()
          from comp_sitios s
          left join lateral comp_ruta_sitio(s.unidad, s.site_id, s.sitio_clave) r on true
         where s.id = t.sitio_id and t.id = any (v_ids) and t.estado = 'regresada'
        returning t.id, t.unidad, t.campana_id
      ), mov as (
        insert into comp_movimientos (accion, unidad, campana_ids, n, detalle, por)
        select 'editar_tomas', u.unidad, array_agg(distinct u.campana_id), count(*),
               p_cambios || jsonb_build_object('tomas', array_agg(u.id order by u.id), 'regresadas', true),
               v_email
          from upd u group by u.unidad
      )
      select count(*) into v_reg_cam from upd;
    end if;
  exception when unique_violation then
    raise exception 'Ese sitio ya tiene una toma el %.', to_char(v_fecha, 'DD/MM/YYYY');
  end;
  return jsonb_build_object('cambiadas', v_cambiadas + v_reg_cam,
                            'sin_cambio', cardinality(v_ids) - v_cambiadas - v_reg_cam,
                            'quitada_reemplazada', v_reemplazo > 0, 'regresadas_omitidas', v_reg_omit);
end $$;

-- comp_restaurar_sitios — V3 (26-oct-2026): un sitio restaurado con una toma
-- comprobada recupera su crédito por revisión (comp_sitio_credito) antes de
-- volver a aplicar el plan. Lo demás, idéntico.
create or replace function public.comp_restaurar_sitios(p_sitio_ids bigint[])
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_ids bigint[]; v_n int; v_cambiados int := 0; v_cams bigint[]; v_tom jsonb;
  v_restaurados bigint[];
begin
  select array_agg(distinct x) into v_ids from unnest(p_sitio_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste sitios.';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'Demasiados sitios en un lote (%).', cardinality(v_ids);
  end if;
  v_n := comp_sitios_ajenos(v_ids);
  if v_n > 0 then
    raise exception '% sitio(s) son de campañas cerradas o que no llevas. No se restauró nada.', v_n;
  end if;
  with upd as (
    update comp_sitios s
       set estado = 'pendiente', cancelado_motivo = null, cancelado_por = null, cancelado_en = null,
           actualizado_en = now()
     where s.id = any (v_ids) and s.estado = 'cancelado'
    returning s.id, s.unidad, s.campana_id
  ), mov as (
    insert into comp_movimientos (accion, unidad, campana_ids, sitio_ids, n, por)
    select 'restaurar', u.unidad, array_agg(distinct u.campana_id), array_agg(u.id order by u.id), count(*), v_email
      from upd u group by u.unidad
  )
  select count(*), array_agg(distinct campana_id), array_agg(id order by id) into v_cambiados, v_cams, v_restaurados from upd;
  -- V3 (26-oct-2026): un sitio restaurado con una toma comprobada vuelve a contar por revisión.
  perform comp_sitio_credito(x) from unnest(v_restaurados) x;
  v_tom := comp_reaplicar_planes(coalesce(v_cams, '{}'));
  return jsonb_build_object('cambiados', v_cambiados, 'sin_cambio', cardinality(v_ids) - v_cambiados) || v_tom;
end $$;

-- ------------------------------------------------------------
-- 1i) RPC nuevas.
-- ------------------------------------------------------------

-- Lista del monitorista (Mis rutas › Comprobaciones). Primero refresca la
-- ruta y el monitorista de sus tomas y de los sitios de sus rutas (A4), luego
-- devuelve SUS tomas: asignadas a él, devueltas que él envió, o con una foto
-- vigente suya (pendiente o devuelta); de sus unidades de monitorista, de
-- campañas abiertas no retiradas, pendiente | regresada | por_revisar, del
-- rango pedido o (pendiente o regresada) vencidas de los últimos 31 días.
-- Tope 1,500 con orden escrito (B1): devueltas, hoy, el resto del rango (por
-- día), vencidas de la más reciente a la más vieja; si se corta, cortada:true.
-- Sin vendedor, analista ni cliente. Por toma también va su unidad (para
-- rotular y separar sitios; la app la usa si viene), la parada como la
-- numera Mis rutas y el medio de la ruta (revisión del 26-oct-2026).
create or replace function public.comp_mis_tomas(p_desde date, p_hasta date)
returns jsonb language plpgsql volatile security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '1s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_hoy date := (now() at time zone 'America/Mexico_City')::date;
  v_unidades text[]; v_tomas jsonb; v_n int;
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  if p_desde is null or p_hasta is null or p_hasta - p_desde not between 0 and 45 then
    raise exception 'El rango de días no es válido (de 1 a 46 días).' using errcode = 'CP002';
  end if;
  select coalesce(array_agg(u order by u), '{}') into v_unidades
    from comp_mis_unidades(array['monitorista']::app_role[]) u;
  if cardinality(v_unidades) = 0 then
    return jsonb_build_object('hoy', v_hoy, 'captura', false, 'unidades', '[]'::jsonb, 'cortada', false,
                              'tomas', '[]'::jsonb);
  end if;

  begin
    perform comp_refrescar_rutas(v_email, v_unidades, least(p_desde, v_hoy - 31), p_hasta);
  exception when lock_not_available then
    null;                                  -- la lista sale igual; el refresco va la siguiente vez
  end;

  with sel as (
    select t.id, t.campana_id, t.sitio_id, t.unidad, t.estado, t.fecha, t.horario_texto, t.turno, t.observaciones,
           t.notas, t.regreso_n, t.rechazo_motivo, t.ruta_id, t.ruta_numero, t.plantilla_usada,
           row_number() over (order by (t.estado = 'regresada') desc, (t.fecha = v_hoy) desc,
                                       (t.fecha between p_desde and p_hasta) desc,
                                       case when t.fecha between p_desde and p_hasta then t.fecha end,
                                       t.fecha desc, t.id) as n
      from comp_tomas t join comp_campanas c on c.id = t.campana_id
     where t.unidad = any (v_unidades) and c.estatus = 'abierta' and not c.retirada
       and t.estado in ('pendiente', 'regresada', 'por_revisar')
       and (t.monitorista_email = v_email
            or (t.estado = 'regresada' and t.tomada_por = v_email)
            or (t.estado in ('pendiente', 'regresada')
                and exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                             where et.toma_id = t.id and et.regresada_en is null and e.subido_por = v_email)))
       and (t.fecha between p_desde and p_hasta
            or (t.estado in ('pendiente', 'regresada') and t.fecha between v_hoy - 31 and v_hoy))
  ), lim as (
    select * from sel where n <= 1500
  ), tiene as (                            -- una consulta agrupada para todas
    select y.toma_id, jsonb_agg(jsonb_build_object('pos', y.pos, 'momento', y.momento, 'n', y.n)
                                order by y.pos, y.momento) as tiene
      from (select et.toma_id, e.pos, e.momento, count(*)::int as n
              from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
             where et.toma_id in (select id from lim) and et.regresada_en is null and e.tipo = 'foto'
               and not exists (select 1 from comp_revision_fotos r
                                where r.evidencia_id = et.evidencia_id and r.toma_id = et.toma_id and r.estado = 'rechazada')
             group by 1, 2, 3) y
     group by y.toma_id
  ), par as (
    -- Revisión del 26-oct-2026 (monitorista-2): la parada como la numera Mis
    -- rutas («Parada i+1», por secuencia nulls last y luego site_id). En
    -- Ecovallas casi ninguna ubicación trae secuencia (122 de 124 en Digital):
    -- con la secuencia sola la tarjeta salía sin parada y en otro orden.
    select ru.ruta_id, ru.site_id, ru.secuencia,
           row_number() over (partition by ru.ruta_id order by ru.secuencia nulls last, ru.site_id)::int as parada
      from ruta_ubicaciones ru
     where ru.ruta_id in (select ruta_id from lim where ruta_id is not null)
  ), rech as (                             -- B2: el monitorista no lee comp_revision_fotos
    select r.toma_id, jsonb_agg(jsonb_build_object('evidencia_id', e.id, 'path', e.path, 'pos', e.pos, 'motivo', r.motivo)
                                order by e.id) as rechazadas
      from comp_revision_fotos r join comp_evidencias e on e.id = r.evidencia_id
     where r.toma_id in (select id from lim where estado = 'regresada') and r.estado = 'rechazada'
     group by r.toma_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'unidad', x.unidad, 'estado', x.estado, 'fecha', x.fecha, 'horario_texto', x.horario_texto, 'turno', x.turno,
           'observaciones', x.observaciones, 'notas', x.notas, 'regreso_n', x.regreso_n,
           'rechazo_motivo', x.rechazo_motivo, 'campana_id', x.campana_id, 'campana', c.campana, 'version', c.version,
           'especificacion', left(c.especificacion, 300), 'plantilla_codigo', coalesce(c.plantilla_codigo, 'unica'),
           'sitio_id', s.id, 'sitio_clave', s.sitio_clave, 'site_id', s.site_id, 'vendor_face_id', s.vendor_face_id,
           'espacio_vv', s.espacio_vv, 'mueble', i.tipo_mueble,
           'lat', i.latitud::double precision, 'lng', i.longitud::double precision,
           'ruta_id', x.ruta_id, 'ruta_numero', x.ruta_numero, 'secuencia', ru.secuencia, 'parada', ru.parada,
           -- sql-2 (26-oct-2026): en Biobox «Ruta 3» puede ser Digital o Impreso.
           'ruta_medio', rm.tipo_medio,
           'plantilla', coalesce(x.plantilla_usada, comp_plantilla_toma(x.id)),
           'tiene', coalesce(ti.tiene, '[]'::jsonb))
           || case when x.estado = 'regresada'
                   then jsonb_build_object('rechazadas', coalesce(re.rechazadas, '[]'::jsonb))
                   else '{}'::jsonb end
           order by x.n), '[]'::jsonb),
         (select count(*)::int from sel where n <= 1501)
    into v_tomas, v_n
    from lim x
    join comp_campanas c on c.id = x.campana_id
    join comp_sitios s on s.id = x.sitio_id
    left join lateral (select i.tipo_mueble, i.latitud, i.longitud from inventario i
                        where i.vendor_face_id = s.vendor_face_id and i.unidad_negocio = x.unidad
                        order by (i.tipo_medio = 'Digital') desc limit 1) i on true
    left join lateral (select p.secuencia, p.parada from par p
                        where p.ruta_id = x.ruta_id and p.site_id in (s.site_id, s.sitio_clave)
                        order by (p.site_id = s.site_id) desc limit 1) ru on true
    left join rutas_monitoreo rm on rm.id = x.ruta_id
    left join tiene ti on ti.toma_id = x.id
    left join rech re on re.toma_id = x.id;

  return jsonb_build_object('hoy', v_hoy, 'captura', comp_captura_abierta(v_email), 'unidades', to_jsonb(v_unidades),
                            'cortada', coalesce(v_n, 0) > 1500, 'tomas', v_tomas);
end $$;

-- B12: estado ligero de unas tomas para la cola del teléfono. Solo devuelve
-- las que son de quien llama (comp_es_mi_toma); las que no vuelven son ajenas
-- o se borraron (la cola valida la sesión con getUser antes de concluirlo).
create or replace function public.comp_estado_tomas(p_ids bigint[])
returns table (id bigint, estado text, regreso_n int, rechazo_motivo text)
language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  if coalesce(cardinality(p_ids), 0) > 200 then
    raise exception 'Demasiadas tomas en una consulta (%).', cardinality(p_ids) using errcode = 'CP002';
  end if;
  return query
    select t.id, t.estado, t.regreso_n, t.rechazo_motivo
      from comp_tomas t
     where t.id = any (coalesce(p_ids, '{}')) and comp_es_mi_toma(t.id, v_email)
     order by t.id;
end $$;

-- Plantilla de un lote de campañas (Campañas › «Plantilla…»). Solo el
-- Supervisor de la unidad (o el manager). p_codigo NULL = 'unica' (por
-- omisión) o una de capa testigo y activa; si no, CP002. Bloquea las campañas
-- abiertas (order by id) y ninguna toma (M8). Las cerradas se omiten. Las
-- tomas ya enviadas (por_revisar, comprobada) conservan la plantilla con que
-- se enviaron (A2): se cuentan en enviadas_conservan para que la pantalla lo diga.
create or replace function public.comp_poner_plantilla(p_campana_ids bigint[], p_codigo text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  -- sql-9 (26-oct-2026): 'unica' explícito = NULL (la de omisión): una sola
  -- forma de lo mismo, sin cambios ni movimientos de más.
  v_codigo text := nullif(nullif(btrim(p_codigo), ''), 'unica');
  v_ids bigint[]; v_n int; v_u text; v_cambiadas int := 0; v_cerradas int := 0; v_enviadas int := 0;
  v_camb bigint[];
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  select array_agg(distinct x) into v_ids from unnest(p_campana_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste campañas.' using errcode = 'CP002';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'Demasiadas campañas en un lote (%).', cardinality(v_ids) using errcode = 'CP002';
  end if;
  if v_codigo is not null
     and not exists (select 1 from comp_plantillas_toma p where p.codigo = v_codigo and p.capa = 'testigo' and p.activa) then
    raise exception 'Esa plantilla no existe o no se puede elegir por campaña: %.', v_codigo using errcode = 'CP002';
  end if;
  select cardinality(v_ids) - count(*) into v_n from comp_campanas where id = any (v_ids);
  if v_n > 0 then
    raise exception '% campaña(s) ya no existen. Recarga la lista; no se cambió nada.', v_n using errcode = 'CP002';
  end if;
  for v_u in select distinct c.unidad from comp_campanas c where c.id = any (v_ids) loop
    if not comp_gestiona(v_u) then
      raise exception 'Solo el Supervisor (o el Admin) cambia la plantilla de %.', comp_etiqueta_unidad(v_u)
        using errcode = '42501';
    end if;
  end loop;

  begin
    perform 1 from comp_campanas c where c.id = any (v_ids) and c.estatus = 'abierta' order by c.id for update;
  exception when lock_not_available then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;

  select count(*) into v_cerradas from comp_campanas c where c.id = any (v_ids) and c.estatus <> 'abierta';
  with upd as (
    update comp_campanas c
       set plantilla_codigo = v_codigo, plantilla_por = v_email, plantilla_en = now(), actualizado_en = now()
     where c.id = any (v_ids) and c.estatus = 'abierta' and c.plantilla_codigo is distinct from v_codigo
    returning c.id, c.unidad, c.periodo_id
  ), mov as (
    insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
    select 'plantilla', u.unidad, u.periodo_id, array_agg(u.id order by u.id), count(*),
           jsonb_build_object('plantilla', coalesce(v_codigo, 'unica')), v_email
      from upd u group by u.unidad, u.periodo_id
  )
  select count(*), array_agg(id) into v_cambiadas, v_camb from upd;
  select count(*) into v_enviadas
    from comp_tomas t where t.campana_id = any (coalesce(v_camb, '{}')) and t.estado in ('por_revisar', 'comprobada');

  return jsonb_build_object('ok', true, 'plantilla', v_codigo, 'cambiadas', v_cambiadas,
                            'sin_cambio', cardinality(v_ids) - v_cerradas - v_cambiadas,
                            'cerradas_omitidas', v_cerradas, 'enviadas_conservan', v_enviadas);
end $$;

-- «Actualizar ruta y monitorista» de un periodo (Formato y Excel, en silencio
-- al abrir y con el botón). Solo el Supervisor de la unidad (o el manager).
-- Recalcula con comp_refrescar_rutas todas las tomas pendientes del periodo
-- que no se pusieron a mano ni tienen fotos. Movimiento solo si cambió algo.
create or replace function public.comp_refrescar_monitoristas(p_periodo_id bigint)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_p record; v_n int;
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  select p.id, p.unidad, p.fecha_inicio, p.fecha_fin into v_p from comp_periodos p where p.id = p_periodo_id;
  if v_p.id is null then
    raise exception 'Ese periodo no existe.' using errcode = 'CP002';
  end if;
  if not comp_gestiona(v_p.unidad) then
    raise exception 'Solo el Supervisor (o el Admin) actualiza rutas y monitoristas de %.', comp_etiqueta_unidad(v_p.unidad)
      using errcode = '42501';
  end if;
  v_n := comp_refrescar_rutas(null, array[v_p.unidad], v_p.fecha_inicio, v_p.fecha_fin);
  if v_n > 0 then
    insert into comp_movimientos (accion, unidad, periodo_id, n, por)
    values ('refrescar_rutas', v_p.unidad, v_p.id, v_n, v_email);
  end if;
  return jsonb_build_object('ok', true, 'actualizadas', v_n);
end $$;

revoke all on function public.comp_mis_tomas(date, date), public.comp_estado_tomas(bigint[]),
  public.comp_poner_plantilla(bigint[], text), public.comp_refrescar_monitoristas(bigint)
  from public, anon;
grant execute on function public.comp_mis_tomas(date, date), public.comp_estado_tomas(bigint[]),
  public.comp_poner_plantilla(bigint[], text), public.comp_refrescar_monitoristas(bigint)
  to authenticated, service_role;
