-- 3-nov-2026 · Inventario / Biobox
-- Qué hace: deja un solo ID por máquina Biobox (el vendor_face_id) y guarda el
--   ID viejo como alias en `inventario_ids_anteriores` para que la búsqueda lo encuentre.
-- Por qué: 15 máquinas traían de QTM un VendorSiteID viejo (p. ej. MX_EM_BB_IID_0002
--   para MX_EM_BB_UCL_0007) y salían con dos IDs. Desde el 3-nov-2026 el sync
--   nocturno (faces-api-bridge, sync_inventario_supabase.py) pone site_id =
--   vendor_face_id en Biobox; esta migración pasa al ID nuevo lo que la app ya
--   había guardado con el viejo (rutas, revisiones, visitas y avisos NUC).
-- ORDEN: aplicar DESPUÉS de subir el cambio del sync. Si no, el sync de esa noche
--   regresa el site_id viejo al inventario y las máquinas se caen de sus rutas.

set local lock_timeout = '5s';

-- 1. Alias: ID anterior -> ID vigente. Solo se escribe por migración.
create table if not exists public.inventario_ids_anteriores (
  id_anterior    text primary key,
  vendor_face_id text not null,
  nota           text,
  creado_en      timestamptz not null default now()
);
create index if not exists inventario_ids_anteriores_vfid
  on public.inventario_ids_anteriores (vendor_face_id);

alter table public.inventario_ids_anteriores enable row level security;
drop policy if exists inventario_ids_anteriores_sel on public.inventario_ids_anteriores;
create policy inventario_ids_anteriores_sel on public.inventario_ids_anteriores
  for select to authenticated
  using ((select auth_email()) is not null);
revoke all on public.inventario_ids_anteriores from public, anon, authenticated;
grant select on public.inventario_ids_anteriores to authenticated;

insert into public.inventario_ids_anteriores (id_anterior, vendor_face_id, nota) values
  ('MX_EM_BB_IID_0001', 'MX_EM_BB_UCL_0003', 'Biobox: VendorSiteID viejo en QTM'),
  ('MX_EM_BB_IID_0002', 'MX_EM_BB_UCL_0007', 'Biobox: VendorSiteID viejo en QTM'),
  ('MX_EM_BB_IID_0003', 'MX_EM_BB_UCL_0005', 'Biobox: VendorSiteID viejo en QTM'),
  ('MX_EM_BB_IED_0006', 'MX_EM_BB_UCL_0004', 'Biobox: VendorSiteID viejo en QTM'),
  ('MX_EM_BB_IED_0009', 'MX_EM_BB_UCL_0006', 'Biobox: VendorSiteID viejo en QTM'),
  ('MX_CM_BB_0115', 'MX_CM_BB_MEC_0115', 'Biobox: VendorSiteID sin código MEC en QTM'),
  ('MX_CM_BB_0200', 'MX_CM_BB_MEC_0200', 'Biobox: VendorSiteID sin código MEC en QTM'),
  ('MX_CM_BB_0201', 'MX_CM_BB_MEC_0201', 'Biobox: VendorSiteID sin código MEC en QTM'),
  ('MX_CM_BB_0202', 'MX_CM_BB_MEC_0202', 'Biobox: VendorSiteID sin código MEC en QTM'),
  ('MX_CM_BB_0203', 'MX_CM_BB_MEC_0203', 'Biobox: VendorSiteID sin código MEC en QTM'),
  ('MX_CM_BB_0204', 'MX_CM_BB_MEC_0204', 'Biobox: VendorSiteID sin código MEC en QTM'),
  ('MX_CM_BB_0205', 'MX_CM_BB_MEC_0205', 'Biobox: VendorSiteID sin código MEC en QTM'),
  ('MX_CM_BB_0206', 'MX_CM_BB_MEC_0206', 'Biobox: VendorSiteID sin código MEC en QTM'),
  ('MX_CM_BB_0207', 'MX_CM_BB_MEC_0207', 'Biobox: VendorSiteID sin código MEC en QTM'),
  ('MX_CM_BB_0208', 'MX_CM_BB_MEC_0208', 'Biobox: VendorSiteID sin código MEC en QTM')
on conflict (id_anterior) do update
  set vendor_face_id = excluded.vendor_face_id
  where inventario_ids_anteriores.vendor_face_id is distinct from excluded.vendor_face_id;

-- 2. Pasar al ID nuevo lo guardado con el viejo. Se turna con el sync nocturno
--    y con sincronizar_biobox_peru (mismo candado que reemplazar_inventario).
--    El inventario va primero: el trigger de ruta_ubicaciones valida contra él.
select pg_advisory_xact_lock(hashtext('inventario'));

update public.inventario i
   set site_id = a.vendor_face_id
  from public.inventario_ids_anteriores a
 where i.site_id = a.id_anterior
   and i.vendor_face_id = a.vendor_face_id;

update public.ruta_ubicaciones r
   set site_id = a.vendor_face_id
  from public.inventario_ids_anteriores a
 where r.site_id = a.id_anterior;

update public.revisiones r
   set site_id = a.vendor_face_id
  from public.inventario_ids_anteriores a
 where r.site_id = a.id_anterior;

update public.maquina_visitas v
   set site_id = a.vendor_face_id
  from public.inventario_ids_anteriores a
 where v.site_id = a.id_anterior;

update public.nuc_avisos n
   set site_id = a.vendor_face_id
  from public.inventario_ids_anteriores a
 where n.site_id = a.id_anterior;

-- 3. Una visita que un teléfono tenía en cola sin señal puede llegar todavía con
--    el ID viejo: se traduce al nuevo antes de guardarla. Lo demás, igual que antes.
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
  v_nuevo text;
begin
  new.usuario_email := lower(new.usuario_email);
  new.registrado_en := now();
  new.nota := nullif(trim(coalesce(new.nota, '')), '');
  -- ID viejo de una máquina (inventario_ids_anteriores, 3-nov-2026).
  select a.vendor_face_id into v_nuevo
    from inventario_ids_anteriores a
   where a.id_anterior = new.site_id;
  if v_nuevo is not null then
    new.site_id := v_nuevo;
  end if;
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

-- 3b. Igual para una revisión abierta antes de la migración y guardada después
--     (guardar_revision guarda el site_id tal cual) y para una visita de ruta en cola.
create or replace function public.site_id_vigente()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_nuevo text;
begin
  select a.vendor_face_id into v_nuevo
    from inventario_ids_anteriores a
   where a.id_anterior = new.site_id;
  if v_nuevo is not null then
    new.site_id := v_nuevo;
  end if;
  return new;
end
$function$;
revoke execute on function public.site_id_vigente() from public, anon, authenticated;

drop trigger if exists trg_revisiones_site_id_vigente on public.revisiones;
create trigger trg_revisiones_site_id_vigente
  before insert on public.revisiones
  for each row execute function public.site_id_vigente();

drop trigger if exists trg_ruta_visitas_site_id_vigente on public.ruta_visitas;
create trigger trg_ruta_visitas_site_id_vigente
  before insert on public.ruta_visitas
  for each row execute function public.site_id_vigente();

-- 4. Comprobación: nada debe quedar con un ID viejo.
do $$
declare
  n int;
begin
  select (select count(*) from inventario i join inventario_ids_anteriores a on a.id_anterior = i.site_id)
       + (select count(*) from ruta_ubicaciones r join inventario_ids_anteriores a on a.id_anterior = r.site_id)
       + (select count(*) from revisiones r join inventario_ids_anteriores a on a.id_anterior = r.site_id)
       + (select count(*) from maquina_visitas v join inventario_ids_anteriores a on a.id_anterior = v.site_id)
       + (select count(*) from nuc_avisos x join inventario_ids_anteriores a on a.id_anterior = x.site_id)
    into n;
  if n > 0 then
    raise exception 'Quedaron % filas con un ID viejo de Biobox; no se aplica.', n;
  end if;
end $$;
