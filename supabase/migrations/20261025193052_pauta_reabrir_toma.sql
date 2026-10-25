-- ============================================================
-- pauta_reabrir_toma — deshacer una comprobación sin regresar la toma
-- (propuesta de Claude del 24-oct-2026; Erik la aprobó el 25-oct-2026).
--
-- POR QUÉ. Una toma comprobada no admite fotos y la única salida era
-- «Regresar toda la toma» (rechazar_toma), que marca todas las fotos como
-- regresadas y obliga al monitorista a tomar de nuevo. Si el analista se
-- equivocó al comprobar, o el cliente pide otra cosa, hacía falta volver a
-- revisar lo que ya hay sin tirar las fotos.
--
-- QUÉ CAMBIA.
--   1. pauta_monitoreo: reabierta_motivo, reabierta_por, reabierta_en. Es el
--      rastro de la ÚLTIMA reapertura; no se limpia al volver a comprobar.
--   2. reabrir_toma(p_catorcena, p_vendor_face_id, p_motivo, p_anio): solo
--      analista o manager, con motivo obligatorio y solo sobre una toma
--      comprobada. Quita fecha_comprobacion y comprobacion_por; las fotos y
--      sus revisiones se quedan tal cual, así que la toma vuelve a «Por
--      revisar» y el analista decide: rechazar fotos sueltas, subir una
--      editada o comprobar de nuevo (registrar_comprobacion, o
--      revisar_foto_pauta si marca algo). No avisa al monitorista: no tiene
--      nada que hacer.
--   3. vw_pauta_ruta: las tres columnas nuevas AL FINAL (regla de Pauta:
--      solo se agregan columnas al final) y con security_invoker explícito,
--      porque create or replace view sin WITH borra las opciones
--      (20261024064321 se lo había puesto). vw_pauta_resumen depende de ella
--      y no cambia; los grants de la vista se conservan.
--
-- LO QUE NO PASA. El aviso de campaña cerrada no se repite al volver a
-- comprobar: pauta_avisar_campana_cerrada solo corre cuando la cara PASA a
-- comprobada y pauta_campanas_cerradas tiene «on conflict do nothing». Al
-- reabrir (fecha_comprobacion → null) el trigger no hace nada. La campaña
-- queda «cerrada» en esa tabla aunque tenga una cara reabierta: es
-- historial, no estado.
--
--   4. pev_del (revisor-rls, 25-oct-2026): con la toma reabierta, las fotos
--      que ya había al reabrir (las que se dieron por buenas) NO se pueden
--      borrar: solo salen si el analista las rechaza. Las que suban después
--      sí se borran como siempre. Sin esto, el monitorista, un coordinador o
--      el manager podían borrar fotos ya comprobadas, y el archivo se va de
--      Storage sin vuelta. La pantalla del monitorista esconde el botón de
--      quitar en esas fotos (RegistrarTomaModal).
--
-- PERMISOS. security definer con search_path fijo, como las demás RPC de
-- Pauta; revoke a public y anon, grant a authenticated y service_role.
-- Re-ejecutable: el candado de la vista solo se revisa cuando todavía no
-- tiene reabierta_en.
-- ============================================================

-- Candado: la vista debe ser la de producción al 25-oct-2026 (revisor-rls).
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'vw_pauta_ruta'
                    and column_name = 'reabierta_en')
     and md5(pg_get_viewdef('public.vw_pauta_ruta'::regclass)) <> 'c737788bee6007d144ae12fda06dad58' then
    raise exception 'vw_pauta_ruta cambió en producción; revisar antes de aplicar.';
  end if;
end;
$$;

alter table public.pauta_monitoreo
  add column if not exists reabierta_motivo text,
  add column if not exists reabierta_por text,
  add column if not exists reabierta_en timestamptz;

create or replace view public.vw_pauta_ruta with (security_invoker = on) as
 select p.id,
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
    m.fecha_toma,
    m.toma_por,
    m.fecha_comprobacion,
    m.comprobacion_por,
    p.fecha_toma_archivo,
    p.fecha_comprobacion_archivo,
        case
            when (m.fecha_comprobacion is not null) then 'COMPROBADA'::text
            when (m.fecha_toma is not null) then 'TOMADA'::text
            else 'PENDIENTE'::text
        end as avance,
    inv.latitud,
    inv.longitud,
    ((inv.latitud is not null) and (inv.longitud is not null)) as navegable,
    ru.ruta_id as ruta_monitoreo_id,
    coalesce(ev.n, (0)::bigint) as fotos,
    p.espec_toma,
    m.rechazo_motivo,
    m.rechazada_por,
    p.anio,
    m.reabierta_motivo,
    m.reabierta_por,
    m.reabierta_en
   from ((((pautas p
     left join pauta_monitoreo m on (((m.anio = p.anio) and (m.catorcena = p.catorcena) and (m.vendor_face_id = p.vendor_face_id))))
     left join lateral ( select inventario.latitud,
            inventario.longitud
           from inventario
          where (inventario.vendor_face_id = p.vendor_face_id)
         limit 1) inv on (true))
     left join ruta_ubicaciones ru on ((ru.site_id = p.site_id)))
     left join lateral ( select count(*) as n
           from pauta_evidencias e
          where ((e.anio = p.anio) and (e.catorcena = p.catorcena) and (e.vendor_face_id = p.vendor_face_id)
            and (e.regresada_en is null))) ev on (true));

create or replace function public.reabrir_toma(p_catorcena integer, p_vendor_face_id text, p_motivo text, p_anio integer default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_anio int := coalesce(p_anio, anio_de_catorcena(p_catorcena));
  v_mon pauta_monitoreo%rowtype;
begin
  if auth_email() is null then
    raise exception 'Sesión no válida.';
  end if;
  if not (tiene_rol('analista'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el analista puede reabrir una toma.';
  end if;
  if coalesce(trim(p_motivo), '') = '' then
    raise exception 'Escribe el motivo para reabrir la toma.';
  end if;

  -- Mismo candado que las demás RPC: primero la fila de la toma.
  select * into v_mon from pauta_monitoreo
   where anio = v_anio and catorcena = p_catorcena and vendor_face_id = p_vendor_face_id
   for update;
  if not found or v_mon.fecha_toma is null then
    raise exception 'Esa cara no tiene toma registrada.';
  end if;
  if v_mon.fecha_comprobacion is null then
    raise exception 'Esa toma no está comprobada: no hay nada que reabrir.';
  end if;

  update pauta_monitoreo
     set fecha_comprobacion = null,
         comprobacion_por   = null,
         reabierta_motivo   = trim(p_motivo),
         reabierta_por      = lower(auth_email()),
         reabierta_en       = now(),
         actualizado_en     = now()
   where id = v_mon.id;
end;
$function$;

revoke all on function public.reabrir_toma(integer, text, text, integer) from public, anon;
grant execute on function public.reabrir_toma(integer, text, text, integer) to authenticated, service_role;

-- Borrar fotos: igual que antes (quien la subió, coordinador o manager, y
-- nunca de una toma comprobada), y además nunca una foto que ya estaba al
-- reabrir la toma (revisor-rls, 25-oct-2026).
drop policy if exists pev_del on public.pauta_evidencias;
create policy pev_del on public.pauta_evidencias for delete
  using (
    ((lower(coalesce(subido_por, '')) = lower(auth_email()))
      or tiene_rol('coordinador'::app_role) or tiene_rol('manager'::app_role))
    and not exists (
      select 1 from pauta_monitoreo m
       where m.anio = pauta_evidencias.anio and m.catorcena = pauta_evidencias.catorcena
         and m.vendor_face_id = pauta_evidencias.vendor_face_id
         and (m.fecha_comprobacion is not null
              or (m.reabierta_en is not null
                  and pauta_evidencias.regresada_en is null
                  and pauta_evidencias.creado_en < m.reabierta_en)))
  );
