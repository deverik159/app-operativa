-- ============================================================
-- Aviso NUC: «Sitio apagado»
-- (Erik, 4-nov-2026 · sección Aviso NUC)
--
-- Cuando Digital ya diagnosticó el NUC y no regresa, puede ser que el sitio
-- esté apagado completo. En una máquina fuera de línea aparece un tercer
-- botón, «Sitio apagado», que se comporta como marcar fuera de línea: nota
-- opcional y foto obligatoria; avisa a los mismos destinatarios de la
-- unidad. Del apagado se regresa con «Ya está en línea», que suma la
-- respuesta «Se encendió el sitio».
--
--   1. nuc_avisos acepta el estado 'apagado' (sigue siendo un aviso abierto:
--      el índice de uno abierto por sitio no cambia) y guarda quién, cuándo,
--      la nota y la foto del apagado (nuc/<id>/…, como la del cierre).
--   2. El historial acepta la acción y el estado 'apagado'.
--   3. nuc_aviso_apagado(p_id, p_nota, p_foto): solo Digital, solo desde
--      fuera de línea.
--   4. nuc_aviso_en_linea: también desde apagado, con la respuesta nueva; la
--      foto del cierre no puede ser la del apagado.
--   5. nuc_foto_en_uso protege también la foto del apagado.
--   6. (Revisión de seguridad del 4-nov-2026) nuc_es_tecnico solo cuenta en
--      Biobox y Biobox Perú; fuera de ahí, solo el manager, igual que
--      esTecnicoNuc en la pantalla. Hoy no cambia a nadie.
--
-- ORDEN: puede ir antes que el frontend: la app de hoy no ofrece el botón y
-- un aviso apagado se le ve como fuera de línea.
-- ============================================================

-- 1. El estado y los datos del apagado.
alter table public.nuc_avisos drop constraint if exists nuc_avisos_estado_check;
alter table public.nuc_avisos
  add constraint nuc_avisos_estado_check check (estado in ('fuera_linea', 'apagado', 'en_linea'));
alter table public.nuc_avisos add column if not exists apagado_por text;
alter table public.nuc_avisos add column if not exists apagado_en timestamptz;
alter table public.nuc_avisos add column if not exists nota_apagado text;
alter table public.nuc_avisos add column if not exists foto_apagado text;
alter table public.nuc_avisos drop constraint if exists nuc_avisos_foto_apagado_check;
alter table public.nuc_avisos
  add constraint nuc_avisos_foto_apagado_check
  check (foto_apagado is null or foto_apagado ~ ('^nuc/' || id || '/[A-Za-z0-9._-]+$'));

-- 2. El historial.
alter table public.nuc_avisos_eventos drop constraint if exists nuc_avisos_eventos_accion_check;
alter table public.nuc_avisos_eventos
  add constraint nuc_avisos_eventos_accion_check check (accion in ('abierto', 'tomado', 'apagado', 'en_linea'));
alter table public.nuc_avisos_eventos drop constraint if exists nuc_avisos_eventos_estado_check;
alter table public.nuc_avisos_eventos
  add constraint nuc_avisos_eventos_estado_check check (estado in ('fuera_linea', 'en_revision', 'apagado', 'en_linea'));

-- 3. Marcar el sitio apagado.
create or replace function public.nuc_aviso_apagado(p_id bigint, p_nota text, p_foto text)
returns void
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_yo text := lower(auth_email());
  v_a nuc_avisos%rowtype;
  v_nota text := nullif(left(trim(coalesce(p_nota, '')), 500), '');
  v_foto text := trim(coalesce(p_foto, ''));
begin
  if v_yo is null or not nuc_es_digital() then
    raise exception 'Solo Digital puede marcar un sitio apagado.' using errcode = '42501';
  end if;
  if v_foto !~ ('^nuc/' || p_id || '/[A-Za-z0-9._-]+$') then
    raise exception 'Falta la foto.' using errcode = '22023';
  end if;
  -- La foto tiene que estar subida, y por quien marca.
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'evidencias' and o.name = v_foto and o.owner_id = ((select auth.uid()))::text
       and o.metadata->>'mimetype' like 'image/%'
  ) then
    raise exception 'La foto no se subió. Vuelve a intentarlo.' using errcode = '22023';
  end if;

  select * into v_a from nuc_avisos where id = p_id for update;
  if v_a.id is null then
    raise exception 'El aviso ya no existe.';
  end if;
  if v_a.estado <> 'fuera_linea' then
    raise exception 'Solo una máquina fuera de línea se puede marcar como sitio apagado.';
  end if;

  update nuc_avisos
     set estado = 'apagado', apagado_por = v_yo, apagado_en = now(), nota_apagado = v_nota,
         foto_apagado = v_foto, actualizado_en = now()
   where id = p_id;
  insert into nuc_avisos_eventos(aviso_id, accion, estado, por, nota)
  values (p_id, 'apagado', 'apagado', v_yo, v_nota);

  perform nuc_avisar_tecnicos(
    v_a.unidad_negocio, 'nuc_apagado',
    'Sitio apagado en ' || v_a.site_id || coalesce(': ' || v_nota, '') ||
    '. Digital te avisa cuando vuelva a estar en línea.');
end;
$function$;

revoke all on function public.nuc_aviso_apagado(bigint, text, text) from public, anon;
grant execute on function public.nuc_aviso_apagado(bigint, text, text) to authenticated;

-- 4. Poner en línea también desde apagado. Cuerpo copiado de producción
--    (md5 6fdc92f1…, 4-nov-2026); lo nuevo va marcado con CAMBIO.
create or replace function public.nuc_aviso_en_linea(p_id bigint, p_respuesta text, p_foto text)
returns void
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_yo text := lower(auth_email());
  v_a nuc_avisos%rowtype;
  v_resp text := trim(coalesce(p_respuesta, ''));
  v_foto text := trim(coalesce(p_foto, ''));
begin
  if v_yo is null or not nuc_es_digital() then
    raise exception 'Solo Digital puede poner el NUC en línea.' using errcode = '42501';
  end if;
  -- Las mismas de la pantalla (RESPUESTAS_DIGITAL en src/lib/avisoNuc.ts).
  -- CAMBIO (4-nov-2026): «Se encendió el sitio», para el sitio apagado.
  if v_resp not in ('Se reinició el NUC', 'Se restableció la red', 'VPN apagada', 'Se encendió el sitio') then
    raise exception 'Elige qué se hizo: Se reinició el NUC, Se restableció la red, VPN apagada o Se encendió el sitio.'
      using errcode = '22023';
  end if;
  if v_foto !~ ('^nuc/' || p_id || '/[A-Za-z0-9._-]+$') then
    raise exception 'Falta la foto.' using errcode = '22023';
  end if;
  -- La foto tiene que estar subida, y por quien cierra el aviso.
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'evidencias' and o.name = v_foto and o.owner_id = ((select auth.uid()))::text
       and o.metadata->>'mimetype' like 'image/%'
  ) then
    raise exception 'La foto no se subió. Vuelve a intentarlo.' using errcode = '22023';
  end if;

  select * into v_a from nuc_avisos where id = p_id for update;
  if v_a.id is null then
    raise exception 'El aviso ya no existe.';
  end if;
  if v_a.estado = 'en_linea' then
    raise exception 'Este aviso ya está cerrado.';
  end if;
  -- CAMBIO (4-nov-2026): «Se encendió el sitio» solo cierra un sitio apagado.
  if v_resp = 'Se encendió el sitio' and v_a.estado <> 'apagado' then
    raise exception '«Se encendió el sitio» es solo para un sitio apagado.' using errcode = '22023';
  end if;
  -- CAMBIO (4-nov-2026): la del cierre no puede ser la misma del apagado.
  if v_foto = v_a.foto_apagado then
    raise exception 'Esa foto ya es la del sitio apagado: toma otra.' using errcode = '22023';
  end if;

  update nuc_avisos
     set estado = 'en_linea', cerrado_por = v_yo, cerrado_en = now(), nota_cierre = v_resp,
         foto_cierre = v_foto, actualizado_en = now()
   where id = p_id;
  insert into nuc_avisos_eventos(aviso_id, accion, estado, por, nota)
  values (p_id, 'en_linea', 'en_linea', v_yo, v_resp);

  -- El aviso dice la clave del mueble, no el nombre (Erik, 29-oct-2026).
  perform nuc_avisar_tecnicos(
    v_a.unidad_negocio, 'nuc_en_linea',
    'El NUC de ' || v_a.site_id || ' ya está en línea: ' || v_resp || '.');
end;
$function$;

-- 5. Ninguna de las tres fotos de un aviso se borra.
create or replace function public.nuc_foto_en_uso(p_name text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (
    select 1 from nuc_avisos a
     where a.foto_cierre = p_name or a.foto_abierto = p_name or a.foto_apagado = p_name)
$$;

-- 6. Técnico de la máquina: solo en Biobox. Cuerpo copiado de producción
--    (md5 881874be…, 4-nov-2026); lo nuevo va marcado con CAMBIO.
create or replace function public.nuc_es_tecnico(p_unidad text)
returns boolean
language sql
stable
security definer
set search_path = 'public', 'pg_temp'
as $function$
  select tiene_rol('manager'::app_role)
      or (
           -- CAMBIO (4-nov-2026): Ecovallas y Vía Verde no tienen área Op. Bio Box.
           lower(p_unidad) in ('biobox', 'biobox perú')
       and exists (
           select 1 from usuario_roles ur
            where lower(ur.usuario_email) = lower(auth_email())
              and (ur.unidad_negocio is null or lower(ur.unidad_negocio) = lower(p_unidad))
              and (
                    (ur.rol = 'reparacion'::app_role and trim(ur.departamento) ilike 'op. bio box')
                 or (ur.rol = 'coordinador'::app_role
                     and (ur.departamento is null or trim(ur.departamento) ilike 'op. bio box'))
              )));
$function$;

-- ══ Verificación (solo lectura) ══
-- select pg_get_constraintdef(oid) from pg_constraint where conname = 'nuc_avisos_estado_check';
-- select pg_get_function_arguments('public.nuc_aviso_apagado'::regproc);
