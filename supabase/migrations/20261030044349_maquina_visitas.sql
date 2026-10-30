-- ============================================================
-- Visita rápida a máquinas Biobox (Máquinas Biobox, 29-oct-2026)
--
-- POR QUÉ: en la capacitación del 29-oct-2026 los técnicos pidieron una
-- "visita" a la máquina para dejar constancia de que funciona sin llenar el
-- checklist completo cada vez. Erik lo aprobó como primera entrega:
--   · Un toque: ¿Funciona? Sí / No, foto obligatoria, GPS si se pudo y la
--     hora del teléfono. Si no funciona, una nota de qué tiene.
--   · Funciona SIN SEÑAL: el teléfono la guarda (lib/visitas.ts, la misma
--     cola de Mis rutas) y la manda sola. Por eso la base NUNCA rechaza una
--     visita por la distancia: solo la anota (distancia_m) para que el
--     coordinador vea las que se marcaron lejos de la máquina. El GPS del
--     teléfono no necesita internet; la coordenada viaja con la visita.
--   · Cualquier técnico puede visitar cualquier máquina: la visita cuenta
--     para la MÁQUINA, no para la ruta (las 20 rutas de Biobox no tienen a
--     nadie asignado al 29-oct-2026).
--
-- Una tabla aparte de ruta_visitas: aquélla exige la ruta asignada al
-- monitorista (puede_registrar_visita) y no lleva "funciona".
--
-- Quién: los mismos que ven el módulo Máquinas Biobox (App.tsx: manager, o
-- coordinador / reparacion / reportante / fijador con una fila de unidad
-- Biobox o Biobox Perú, o sin unidad). Leer: ellos más Consulta (viewer).
-- Sin update ni delete: una visita es un hecho registrado.
--
-- Fotos: 'evidencias/maquinas/<site_id>/<cliente_id>_<n>.<ext>'. Subir no
-- pide política nueva: ev_obj_upload deja subir a authenticated en todo el
-- bucket (verificado el 29-oct-2026) y la app sube con upsert apagado.
-- Borrar sí (PASO 5): solo el dueño de la foto o el manager, como en
-- pauta-analista/.
--
-- Revisado por revisor-rls el 29-oct-2026; se corrigió: permisos de tabla
-- solo select e insert por columnas (sin id), hora del teléfono en el
-- futuro, coordenadas fuera de rango, search_path con pg_temp, Consulta
-- solo de Biobox, foto obligatoria en la base y borrado de fotos.
--
-- Re-ejecutable.
-- ============================================================

-- ══ PASO 1 — ¿Puede marcar visitas a máquinas? ══
-- La misma regla del menú (App.tsx, enBiobox + roles del módulo). SECURITY
-- DEFINER para leer usuario_roles sin depender de su RLS.
create or replace function public.maquina_visita_puede()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from usuario_roles ur
     where lower(ur.usuario_email) = lower(auth_email())
       and (
             ur.rol = 'manager'::app_role
          or (ur.rol in ('coordinador'::app_role, 'reparacion'::app_role,
                         'reportante'::app_role, 'fijador'::app_role)
              and (ur.unidad_negocio is null or trim(ur.unidad_negocio) ilike 'biobox%'))
           )
  )
$function$;

revoke all on function public.maquina_visita_puede() from public, anon;
grant execute on function public.maquina_visita_puede() to authenticated;

-- Leer: los anteriores más Consulta (viewer) de Biobox o sin unidad. Un
-- viewer de otra unidad no ve correos, notas ni GPS de los técnicos.
create or replace function public.maquina_visita_puede_leer()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select maquina_visita_puede()
      or exists (
           select 1 from usuario_roles ur
            where lower(ur.usuario_email) = lower(auth_email())
              and ur.rol = 'viewer'::app_role
              and (ur.unidad_negocio is null or trim(ur.unidad_negocio) ilike 'biobox%')
         )
$function$;

revoke all on function public.maquina_visita_puede_leer() from public, anon;
grant execute on function public.maquina_visita_puede_leer() to authenticated;

-- ══ PASO 2 — La tabla ══
--   cliente_id   → la llave la genera el teléfono al tocar "Visita rápida";
--                  la cola reenvía con la MISMA llave y el segundo intento
--                  choca con el unique (no duplica).
--   visitado_en  → la hora del teléfono al abrir la visita (puede llegar
--                  horas después por la cola); registrado_en es la del
--                  servidor.
--   unidad_negocio, distancia_m → los pone el trigger con el inventario del
--                  momento en que LLEGA (el inventario se reemplaza cada
--                  noche; la distancia queda fija aunque cambie después).
--   fotos        → [{path, url}] en el bucket evidencias.
create table if not exists public.maquina_visitas (
  id             bigserial primary key,
  cliente_id     uuid not null unique,
  site_id        text not null,
  unidad_negocio text,
  usuario_email  text not null default lower(auth_email()),
  visitado_en    timestamptz not null,
  registrado_en  timestamptz not null default now(),
  funciona       boolean not null,
  lat            double precision,
  lng            double precision,
  precision_m    real,
  distancia_m    real,
  -- Al menos una foto: la cola nunca inserta sin fotos (lib/visitas.ts).
  fotos          jsonb not null default '[]'::jsonb
                   constraint maquina_visitas_fotos_arreglo
                   check (jsonb_typeof(fotos) = 'array' and jsonb_array_length(fotos) >= 1),
  nota           text,
  -- Si no funciona, que diga qué tiene (la app ya lo exige).
  constraint maquina_visitas_nota_si_falla
    check (funciona or nullif(trim(coalesce(nota, '')), '') is not null)
);

create index if not exists maquina_visitas_site_idx
  on public.maquina_visitas (site_id, visitado_en desc);
create index if not exists maquina_visitas_usuario_idx
  on public.maquina_visitas (lower(usuario_email), visitado_en desc);

alter table public.maquina_visitas enable row level security;

drop policy if exists mvis_sel on public.maquina_visitas;
create policy mvis_sel on public.maquina_visitas
  for select to authenticated
  using ((select maquina_visita_puede_leer()));

drop policy if exists mvis_ins on public.maquina_visitas;
create policy mvis_ins on public.maquina_visitas
  for insert to authenticated
  with check (
    lower(usuario_email) = (select lower(auth_email()))
    and (select maquina_visita_puede())
  );

-- Los permisos por omisión del esquema le dan TODO a authenticated: se
-- quitan y se da solo leer e insertar las columnas que manda la app. Sin
-- `id`: uno escogido a mano chocaría después con la secuencia y la cola
-- tomaría ese 23505 como "ya entró", perdiendo la visita de otro.
revoke all on public.maquina_visitas from public, anon, authenticated;
grant select on public.maquina_visitas to authenticated;
grant insert (cliente_id, site_id, usuario_email, visitado_en, funciona,
              lat, lng, precision_m, fotos, nota)
  on public.maquina_visitas to authenticated;
grant usage, select on sequence public.maquina_visitas_id_seq to authenticated;

-- ══ PASO 3 — Trigger: correo, hora del servidor, unidad y distancia ══
-- La distancia es a la cara con coordenadas de esa clave (haversine, metros).
-- Si la máquina ya no está en el inventario, o no tiene coordenadas, o la
-- visita no trae GPS, queda en null: la visita entra igual.
create or replace function public.maquina_visita_completar()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_lat double precision;
  v_lng double precision;
  v_unidad text;
begin
  new.usuario_email := lower(new.usuario_email);
  new.registrado_en := now();
  new.nota := nullif(trim(coalesce(new.nota, '')), '');
  -- Un reloj de teléfono adelantado dejaría esa visita como "la última" para
  -- siempre: se recorta a la hora del servidor (no se rechaza).
  if new.visitado_en > now() then
    new.visitado_en := now();
  end if;
  -- Coordenadas imposibles: la visita entra sin GPS (asin fallaría).
  if new.lat is not null and new.lng is not null
     and (abs(new.lat) > 90 or abs(new.lng) > 180) then
    new.lat := null;
    new.lng := null;
  end if;
  select i.latitud::double precision, i.longitud::double precision, i.unidad_negocio
    into v_lat, v_lng, v_unidad
    from inventario i
   where i.site_id = new.site_id
   order by (i.latitud is null or i.longitud is null), i.vendor_face_id
   limit 1;
  new.unidad_negocio := v_unidad;
  if new.lat is not null and new.lng is not null and v_lat is not null and v_lng is not null then
    -- least/greatest: el redondeo puede dar 1.0000000000000002 y asin fallaría.
    new.distancia_m := round((2 * 6371000 * asin(sqrt(least(1, greatest(0,
        power(sin(radians(v_lat - new.lat) / 2), 2)
      + cos(radians(new.lat)) * cos(radians(v_lat)) * power(sin(radians(v_lng - new.lng) / 2), 2)
    )))))::numeric, 0);
  else
    new.distancia_m := null;
  end if;
  return new;
end
$function$;

revoke all on function public.maquina_visita_completar() from public, anon, authenticated;

drop trigger if exists trg_maquina_visita_completar on public.maquina_visitas;
create trigger trg_maquina_visita_completar
  before insert on public.maquina_visitas
  for each row execute function public.maquina_visita_completar();

-- ══ PASO 4 — La última visita de cada máquina ══
-- security_invoker: respeta la RLS de maquina_visitas de quien consulta.
create or replace view public.vw_maquina_ultima_visita
with (security_invoker = true) as
select distinct on (v.site_id)
       v.site_id,
       v.visitado_en,
       v.usuario_email,
       v.funciona,
       v.distancia_m,
       v.precision_m,
       v.nota
  from public.maquina_visitas v
 order by v.site_id, v.visitado_en desc, v.id desc;

revoke all on public.vw_maquina_ultima_visita from public, anon, authenticated;
grant select on public.vw_maquina_ultima_visita to authenticated;

-- ══ PASO 5 — Las fotos de visita solo las borra su dueño o el manager ══
-- ev_obj_del se copió de producción (pg_policies, 29-oct-2026) y conserva
-- todo; el CAMBIO es la última condición, igual a la de pauta-analista/.
drop policy if exists ev_obj_del on storage.objects;
create policy ev_obj_del on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'evidencias'
    and name !~~ 'comp/%'
    and name !~~ 'comp-analista/%'
    and (name !~~ 'pauta-analista/%' or owner_id = (auth.uid())::text or tiene_rol('manager'::app_role))
    -- CAMBIO (visita rápida, 29-oct-2026)
    and (name !~~ 'maquinas/%' or owner_id = (auth.uid())::text or tiene_rol('manager'::app_role))
  );

-- ══ Verificación (solo lectura) ══
-- select maquina_visita_puede();
-- select * from pg_policies where tablename = 'maquina_visitas';
-- select count(*) from vw_maquina_ultima_visita;
