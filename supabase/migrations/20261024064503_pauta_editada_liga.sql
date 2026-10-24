-- ============================================================
-- pauta_editada_liga — la foto editada del analista ya no lleva la dirección
-- del proyecto escrita en la base (pendiente técnico, revisor-rls 20-oct-2026).
--
-- POR QUÉ. revisar_foto_pauta armaba editada_url concatenando
-- 'https://<proyecto>.supabase.co/storage/v1/object/public/evidencias/' con
-- la ruta: con una rama de prueba o staging, la liga apuntaría a producción.
--
-- QUÉ CAMBIA. La base guarda solo la ruta (editada_path, que ya existía) y
-- la app arma la liga pública con getPublicUrl del proyecto en el que corre
-- (AnalistaPauta.tsx, urlPublica; descargasPauta.ts, editadasDe), con
-- editada_url de respaldo para las filas viejas. editada_url se queda como
-- columna, en null para lo nuevo. El check pasa de exigir editada_url a
-- exigir editada_path. La RPC devuelve 'path' además de 'url' (null).
--
-- ORDEN (revisor-rls, 24-oct-2026): PRIMERO se publica la app que lee
-- editada_path y DESPUÉS se aplica esta migración. Al revés, una app vieja
-- mostraría y descargaría la foto original en vez de la editada, sin error.
--
-- Resto del cuerpo: el vigente en producción (md5 verificado abajo). Misma
-- firma, security definer, search_path y grants. Re-ejecutable.
-- ============================================================

do $$
declare
  v text;
begin
  select md5(replace(prosrc, E'\r', '')) into v from pg_proc
   where oid = 'public.revisar_foto_pauta(bigint, text, text)'::regprocedure;
  if v not in ('0973243c0cddc02a240b6dacdb5b3ea6', '687e30367bd0f3877e02df9e084a6ff7') then
    raise exception 'revisar_foto_pauta cambió en producción; revisar antes de aplicar.';
  end if;
end;
$$;

alter table public.pauta_revision_fotos drop constraint if exists pauta_revision_fotos_check;
alter table public.pauta_revision_fotos drop constraint if exists pauta_revision_fotos_editada_path_check;
alter table public.pauta_revision_fotos
  add constraint pauta_revision_fotos_editada_path_check
  check (estado <> 'editada' or editada_path is not null);

create or replace function public.revisar_foto_pauta(p_evidencia_id bigint, p_estado text, p_path text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(auth_email());
  v_ev    pauta_evidencias%rowtype;
  v_ok    boolean;
begin
  if v_email is null then
    raise exception 'Sesión no válida.';
  end if;
  if not (tiene_rol('analista'::app_role) or tiene_rol('manager'::app_role)) then
    raise exception 'Solo el analista revisa las fotos de las tomas.';
  end if;
  if p_estado not in ('correcta', 'editada') then
    raise exception 'Estado no válido: %.', p_estado;
  end if;

  select * into v_ev from pauta_evidencias where id = p_evidencia_id;
  if not found then
    raise exception 'Esa foto no existe.';
  end if;
  -- Primero se bloquea la toma (mismo orden que rechazar_fotos_pauta: dos
  -- analistas a la vez no se traban) y luego se vuelve a leer la foto.
  perform 1 from pauta_monitoreo m
   where m.anio = v_ev.anio and m.catorcena = v_ev.catorcena
     and m.vendor_face_id = v_ev.vendor_face_id and m.fecha_toma is not null
   for update;
  if not found then
    raise exception 'Esa toma no está registrada: el monitorista todavía no la entrega.';
  end if;
  select * into v_ev from pauta_evidencias where id = p_evidencia_id;
  if v_ev.regresada_en is not null then
    raise exception 'Esa foto ya fue rechazada o su toma se regresó.';
  end if;

  -- La editada debe estar de verdad en Storage y haberla subido quien la
  -- marca (revisor-rls, 20-oct-2026). La liga la arma la app desde la ruta
  -- (24-oct-2026): aquí ya no se escribe la dirección del proyecto.
  if p_estado = 'editada' then
    if coalesce(p_path, '') not like 'pauta-analista/%'
       or not exists (select 1 from storage.objects o
                      where o.bucket_id = 'evidencias' and o.name = p_path
                        and o.owner_id = auth.uid()::text) then
      raise exception 'Falta la foto editada.';
    end if;
  end if;

  insert into pauta_revision_fotos (
    evidencia_id, anio, catorcena, vendor_face_id, estado, motivo, editada_path, editada_url,
    revisado_por, revisado_en)
  values (
    v_ev.id, v_ev.anio, v_ev.catorcena, v_ev.vendor_face_id, p_estado, null,
    case when p_estado = 'editada' then p_path end, null, v_email, now())
  on conflict (evidencia_id) do update
    set estado       = excluded.estado,
        motivo       = null,
        editada_path = excluded.editada_path,
        editada_url  = null,
        revisado_por = excluded.revisado_por,
        revisado_en  = excluded.revisado_en;

  v_ok := pauta_comprobar_si_revisada(v_ev.anio, v_ev.catorcena, v_ev.vendor_face_id, v_email);
  return jsonb_build_object('comprobada', v_ok, 'url', null,
                            'path', case when p_estado = 'editada' then p_path end);
end;
$function$;
