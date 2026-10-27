-- ============================================================
-- comp_f3_captura — Comprobaciones, fase 3 («monitorista y analista»),
-- migración 2 de 3: fotos y captura del monitorista (26-oct-2026).
--
-- QUÉ HACE
--   · Storage (bucket 'evidencias'): ev_obj_del deja fuera comp/ y
--     comp-analista/ y conserva EXACTAMENTE la regla de hoy para todo lo demás
--     (Pauta: pauta/ lo borra cualquiera con sesión, pauta-analista/ solo quien
--     lo subió o el manager). comp/ y comp-analista/ van por ev_obj_del_comp:
--     quien lo subió o el manager, y solo si ninguna fila lo usa
--     (comp_objeto_en_uso). Primero la RPC quita la fila; luego la app borra
--     el objeto.
--   · Captura en el teléfono: comp_subir_foto (registra la foto y la liga a
--     las tomas que manda el teléfono; idempotente por cliente_id; sin
--     ninguna toma que ligar no la registra),
--     comp_quitar_foto (desliga o borra mientras nadie la revisó, devolvió ni
--     envió; si al desligar ya no le queda ninguna toma, la borra entera)
--     y comp_registrar_tomas (la base cuenta contra la plantilla y la pasa a
--     por_revisar; re-entrega sin fotos nuevas se comprueba sola).
--   · Avisos agrupados a quien revisa (comp_aviso_revision): comp_revision a
--     la analista; comp_sin_analista a los Supervisores de la unidad (o, si no
--     hay, a los managers) cuando nadie puede revisarla (V5).
--   · Se adelantan comp_puede_revisar (la usan la re-entrega y el aviso, B5 y
--     V5) y comp_resumen_revision (security invoker; el chip «Por revisar (N)»
--     de «Mis campañas» sale ya en el incremento 2).
--   · No reemplaza ninguna función de la fase 2 ni de la migración 1.
--
-- DECISIONES (Erik, 26-oct-2026; contexto/comprobaciones.md)
--   · Re-entrega sin fotos nuevas: se comprueba sola a nombre de la última
--     revisora, si sigue pudiendo revisar esa campaña (regla de Pauta del
--     24-oct; pregunta 1 de §9, valor por omisión).
--   · Supervisor que también es analista de la unidad revisa campañas de
--     otras analistas (pregunta 2, valor por omisión).
--   · Foto de Galería con fecha anterior: cuenta su día hasta 2 días atrás;
--     más atrás, hoy (pregunta 3, valor por omisión).
--   · Nadie aprueba su propia toma: ni quien la envió ni quien subió una foto
--     vigente de ella; tampoco el manager.
--   · La captura solo funciona para los correos de comp_piloto (o '*') (M6).
--
-- REGLAS COMUNES (las de la migración 1)
--   · security definer, search_path fijo; las que escriben, lock_timeout 3 s.
--     comp_resumen_revision es security invoker: cuenta con la RLS de quien
--     pregunta.
--   · Errores esperados en el RESULTADO ({ok:false, codigo:'ocupada' |
--     'captura_cerrada' | 'sin_objeto' | 'revisada' | 'enviada' |
--     'sin_permiso'}); excepciones solo para lo que no debe pasar: CP001 sin
--     sesión, CP002 datos inválidos (ruta, cliente_id, tipo, topes), CP003
--     tomas de otro sitio o unidad, CP005 dos tomas de la misma campaña para
--     una foto. La cola nunca lee el texto del error.
--   · Orden de candados: tomas (order by id) → ligas/fotos/revisiones →
--     comp_sitios (solo comp_sitio_credito) → avisos (advisory por correo).
--     Ninguna de estas bloquea comp_campanas.
--   · Internas sin grant: comp_slug_unidad, comp_puede_revisar,
--     comp_comprobar_si_revisada, comp_aviso_revision.
--   · Topes: 60 tomas por foto, 200 tomas por registro.
--   · «Hoy» = día de CDMX.
--
-- Re-ejecutable: el candado de Storage acepta la política de producción o la
-- de esta versión; las funciones son nuevas (create or replace).
-- Sin correos, llaves ni servidores (repo público).
-- ============================================================

-- POR QUÉ (26-oct-2026): DROP/CREATE POLICY en storage.objects toma un
-- candado fuerte sobre la tabla de TODAS las fotos (Pauta incluida). Más vale
-- fallar a los 5 s y volver a correr (es re-ejecutable) que formarse detrás de
-- una subida larga y frenar a todos. «set local»: solo dentro de esta migración.
set local lock_timeout = '5s';

-- ------------------------------------------------------------
-- 2a) Storage (B8). La foto cuenta solo si comp_subir_foto la liga, y esa
--     RPC exige que el objeto sea de quien llama: ev_obj_upload y ev_obj_read
--     no cambian. Los huérfanos los limpia la purga (fase 4).
--     Rutas: foto comp/<ecovallas|biobox|via-verde>/<AAAA-MM>/<sitio_clave>/
--     <AAAAMMDD>_<cliente_id>.<ext>; editada comp-analista/<unidad-slug>/
--     <AAAA-MM>/<evidencia_id>_editada_<ms>.<ext>. La URL nunca se guarda.
-- ------------------------------------------------------------

-- ¿Alguna fila usa este objeto? (la foto o la editada de una revisión). La
-- llama la política ev_obj_del_comp con la sesión de quien borra: definer
-- para leer sin la RLS de las tablas, y con grant a authenticated.
create or replace function public.comp_objeto_en_uso(p_name text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from comp_evidencias e where e.path = p_name)
      or exists (select 1 from comp_revision_fotos r where r.editada_path = p_name)
$$;
revoke all on function public.comp_objeto_en_uso(text) from public, anon;
grant execute on function public.comp_objeto_en_uso(text) to authenticated, service_role;

-- Candado: ev_obj_del como en producción (md5(qual) del 26-oct-2026) o ya
-- como la deja esta migración; ev_obj_del_comp ausente o ya la de aquí. Si no,
-- no se toca nada. ev_obj_del nueva = la regla de hoy, palabra por palabra,
-- más «y no es comp/ ni comp-analista/»: para todo lo demás borra lo mismo.
-- POR QUÉ el md5 (26-oct-2026): pg_policies lo da tal como Postgres lo
-- reescribe; el «nuevo» se sacó en PGlite con la política de producción
-- reconstruida (su md5 sale igual al de producción, c168ae03…).
do $$
declare
  v_del text; v_comp text;
begin
  select md5(p.qual) into v_del from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = 'ev_obj_del';
  select md5(p.qual) into v_comp from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = 'ev_obj_del_comp';
  if coalesce(v_del, 'falta') not in ('c168ae03dbbbaf97f3c777e40fbc72f0', '18a821c749ae63559521117a3747b258') then
    raise exception 'ev_obj_del cambió en producción: revisa antes de reemplazar.';
  end if;
  if v_comp is not null and v_comp <> '2064ceffe0e82b6e5b1949523d576f55' then
    raise exception 'ev_obj_del_comp ya existe y no es la de esta migración: revisa antes de reemplazar.';
  end if;
  if v_del = 'c168ae03dbbbaf97f3c777e40fbc72f0' then
    drop policy ev_obj_del on storage.objects;
    create policy ev_obj_del on storage.objects for delete to authenticated
      using (
        bucket_id = 'evidencias'
        and name not like 'comp/%'
        and name not like 'comp-analista/%'
        and (
          name not like 'pauta-analista/%'
          or owner_id = auth.uid()::text
          or tiene_rol('manager'::app_role)
        )
      );
  end if;
  if v_comp is null then
    create policy ev_obj_del_comp on storage.objects for delete to authenticated
      using (
        bucket_id = 'evidencias'
        and (name like 'comp/%' or name like 'comp-analista/%')
        and (owner_id = auth.uid()::text or tiene_rol('manager'::app_role))
        and not comp_objeto_en_uso(name)
      );
  end if;
end $$;

-- ------------------------------------------------------------
-- 2b) Internas (sin grant: solo las llaman otras funciones security definer).
-- ------------------------------------------------------------

-- Segunda parte de la ruta de una foto: Ecovallas → ecovallas, Biobox →
-- biobox, Vía Verde → via-verde. NULL si la unidad no es de Comprobaciones.
create or replace function public.comp_slug_unidad(p_unidad text) returns text
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case p_unidad when 'Ecovallas' then 'ecovallas' when 'Biobox' then 'biobox' when 'Vía Verde' then 'via-verde' end
$$;

-- ¿p_email puede revisar esta toma? (§4.5 3b; se adelanta aquí, B5 y V5).
-- Campaña abierta, y NO es quien la envió ni quien subió una foto vigente
-- suya (nadie aprueba su propia toma, tampoco el manager), y además: la
-- analista de la campaña con el rol vigente en la unidad, o un Supervisor de
-- la unidad que también es analista de esa unidad (pregunta 2 de §9), o el
-- manager.
create or replace function public.comp_puede_revisar(p_toma_id bigint, p_email text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select coalesce(nullif(lower(btrim(p_email)), '') is not null, false)
     and exists (
       select 1 from comp_tomas t join comp_campanas c on c.id = t.campana_id
        where t.id = p_toma_id and c.estatus = 'abierta'
          and t.tomada_por is distinct from lower(btrim(p_email))
          and not exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                           where et.toma_id = t.id and et.regresada_en is null
                             and e.subido_por = lower(btrim(p_email)))
          and ((c.analista_email = lower(btrim(p_email)) and comp_es_analista_de(p_email, c.unidad))
               or (comp_tiene_rol_en(p_email, 'supervisor', c.unidad) and comp_es_analista_de(p_email, c.unidad))
               or comp_es_manager(p_email)))
$$;

-- Si la toma ya está revisada completa, la comprueba (§4.2 2b). Bloquea la
-- toma (si quien llama no la tenía ya). Falso si no está por_revisar, si
-- p_por está vacío o es quien la envió, si no tiene foto vigente, si alguna
-- foto vigente no tiene revisión correcta o editada, o si le falta algo
-- contra la plantilla CON LA QUE SE ENVIÓ (A2: plantilla_usada, no la
-- vigente). Si pasa: comprobada a nombre de p_por y crédito del sitio.
-- No revisa permisos: quien la llama ya pasó comp_puede_revisar.
create or replace function public.comp_comprobar_si_revisada(p_toma_id bigint, p_por text) returns boolean
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_por text := lower(nullif(btrim(p_por), ''));
  v_t record;
begin
  select t.id, t.estado, t.tomada_por, t.plantilla_usada, t.sitio_id into v_t
    from comp_tomas t where t.id = p_toma_id
    for update;
  if v_t.id is null or v_t.estado <> 'por_revisar' or v_por is null or v_por = v_t.tomada_por then
    return false;
  end if;
  if not exists (select 1 from comp_evidencia_tomas et where et.toma_id = v_t.id and et.regresada_en is null) then
    return false;
  end if;
  if exists (select 1 from comp_evidencia_tomas et
              where et.toma_id = v_t.id and et.regresada_en is null
                and not exists (select 1 from comp_revision_fotos r
                                 where r.evidencia_id = et.evidencia_id and r.toma_id = et.toma_id
                                   and r.estado in ('correcta', 'editada'))) then
    return false;
  end if;
  if comp_faltan(v_t.id, v_t.plantilla_usada, true) <> '[]'::jsonb then
    return false;
  end if;
  update comp_tomas t set estado = 'comprobada', comprobada_en = now(), comprobada_por = v_por
   where t.id = v_t.id;
  perform comp_sitio_credito(v_t.sitio_id);
  return true;
end $$;

-- Avisos de tomas por revisar (§4.4; M10 y V5, 26-oct-2026). Agrupa por
-- destinatario, unidad y periodo; record_id = periodo_id, sin buscar el
-- periodo en el texto.
--   · La analista de la campaña, si puede revisarla → comp_revision.
--   · Si nadie de la campaña puede (sin analista, la analista perdió el rol o
--     ella misma la tomó o subió fotos) → los Supervisores de la unidad y, si
--     no hay, los managers → comp_sin_analista. Nunca a quien la envió.
--   · Un aviso sin leer de la última hora con el mismo destinatario, evento,
--     unidad y periodo se ACTUALIZA (sin push: el push sale solo del INSERT);
--     si no hay, se inserta (push). N = tomas por revisar de ese grupo
--     contadas en la base, no sumadas.
-- Devuelve las tomas que se quedaron sin nadie a quien avisar (el movimiento
-- registrar_tomas lo anota con sin_aviso: no se pierde en silencio).
-- POR QUÉ el advisory lock por correo (26-oct-2026): dos registros a la vez
-- para la misma analista insertarían dos avisos (y dos push) en la misma hora.
create or replace function public.comp_aviso_revision(p_toma_ids bigint[]) returns bigint[]
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_r jsonb; v_sin bigint[]; g record;
  v_n int; v_msg text; v_id bigint; v_per text;
begin
  if coalesce(cardinality(p_toma_ids), 0) = 0 then
    return '{}'::bigint[];
  end if;
  -- 1) Destinatarios de cada toma, una vez.
  with t as (
    select t.id, t.unidad, c.periodo_id, t.tomada_por, s.sitio_clave,
           btrim(c.campana || ' ' || coalesce(c.version, '')) as cv,
           c.analista_email is not null and comp_puede_revisar(t.id, c.analista_email) as ok_ana,
           c.analista_email is not null
             and (c.analista_email = t.tomada_por
                  or exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                              where et.toma_id = t.id and et.regresada_en is null
                                and e.subido_por = c.analista_email)) as misma,
           c.analista_email
      from comp_tomas t
      join comp_campanas c on c.id = t.campana_id
      join comp_sitios s on s.id = t.sitio_id
     where t.id = any (p_toma_ids) and t.estado = 'por_revisar'
  ), d as (
    select t.*,
           array(select distinct lower(btrim(ur.usuario_email)) from usuario_roles ur
                  where ur.rol = 'supervisor' and comp_tiene_rol_en(ur.usuario_email, 'supervisor', t.unidad)
                    and lower(btrim(ur.usuario_email)) is distinct from t.tomada_por) as sup,
           array(select distinct lower(btrim(ur.usuario_email)) from usuario_roles ur
                  where ur.rol = 'manager' and lower(btrim(ur.usuario_email)) is distinct from t.tomada_por) as mgr
      from t
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'unidad', d.unidad, 'periodo_id', d.periodo_id, 'sitio', d.sitio_clave, 'cv', d.cv,
           'misma', d.misma,
           'evento', case when d.ok_ana then 'comp_revision' else 'comp_sin_analista' end,
           'dest', to_jsonb(case when d.ok_ana then array[d.analista_email]
                                 when cardinality(d.sup) > 0 then d.sup
                                 else d.mgr end))), '[]'::jsonb)
    into v_r
    from d;

  select coalesce(array_agg((x->>'id')::bigint order by (x->>'id')::bigint), '{}'::bigint[]) into v_sin
    from jsonb_array_elements(v_r) x
   where jsonb_array_length(x->'dest') = 0;

  -- 2) Un aviso por destinatario, evento, unidad y periodo (en orden de correo:
  --    dos registros a la vez toman los candados en el mismo orden).
  for g in
    select dd.email, x.evento, x.unidad, x.periodo_id,
           (array_agg(x.sitio || ' (' || x.cv || ')' order by x.id desc))[1] as ultima,
           (array_agg(x.misma order by x.id desc))[1] as misma
      from jsonb_to_recordset(v_r) x(id bigint, unidad text, periodo_id bigint, sitio text, cv text, misma boolean,
                                      evento text, dest jsonb)
      cross join lateral jsonb_array_elements_text(x.dest) dd(email)
     group by dd.email, x.evento, x.unidad, x.periodo_id
     order by dd.email, x.evento, x.unidad, x.periodo_id
  loop
    perform pg_advisory_xact_lock(hashtext('comp_aviso'), hashtext(g.email));
    if g.evento = 'comp_revision' then
      select count(*)::int into v_n
        from comp_campanas c join comp_tomas t on t.campana_id = c.id
       where c.periodo_id = g.periodo_id and c.unidad = g.unidad and c.analista_email = g.email
         and t.estado = 'por_revisar' and comp_puede_revisar(t.id, g.email);
    else
      select count(*)::int into v_n
        from comp_campanas c join comp_tomas t on t.campana_id = c.id
       where c.periodo_id = g.periodo_id and c.unidad = g.unidad and t.estado = 'por_revisar'
         and t.tomada_por is distinct from g.email
         and not (c.analista_email is not null and comp_puede_revisar(t.id, c.analista_email));
    end if;
    v_n := greatest(v_n, 1);
    select p.etiqueta into v_per from comp_periodos p where p.id = g.periodo_id;
    v_msg := v_n || case when v_n = 1 then ' toma' else ' tomas' end
             || case when g.evento = 'comp_revision' then ' por revisar' else ' sin analista' end
             || ' · ' || comp_etiqueta_unidad(g.unidad) || ' · ' || coalesce(v_per, 'periodo ' || g.periodo_id)
             || case when g.evento = 'comp_revision' then ' · última: ' || g.ultima
                     when g.misma then ' · la tomó la misma analista · asigna otra o revísala tú'
                     else ' · asigna una en Campañas' end;
    -- Los avisos de Comprobaciones se guardan con el correo en minúsculas:
    -- la comparación directa usa el índice de para_email si lo hay.
    select n.id into v_id from notificaciones n
     where n.para_email = g.email and n.evento = g.evento and n.unidad_negocio = g.unidad
       and n.record_id = g.periodo_id::text and not n.leida and n.creado_en > now() - interval '1 hour'
     order by n.id desc limit 1
     for update;
    if v_id is not null then
      update notificaciones set mensaje = v_msg where id = v_id and mensaje is distinct from v_msg;
    else
      insert into notificaciones (record_id, para_email, evento, mensaje, unidad_negocio)
      values (g.periodo_id::text, g.email, g.evento, v_msg, g.unidad);
    end if;
  end loop;
  return v_sin;
end $$;

revoke all on function public.comp_slug_unidad(text), public.comp_puede_revisar(bigint, text),
  public.comp_comprobar_si_revisada(bigint, text), public.comp_aviso_revision(bigint[])
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2c) RPC de captura.
-- ------------------------------------------------------------

-- Registra una foto (o video) ya subida a Storage y la liga EXACTAMENTE a las
-- tomas que manda el teléfono (A1: el servidor no liga solo). Idempotente por
-- p_cliente_id: un reintento contesta ya:true; con el mismo cliente_id y más
-- tomas sirve para «Usar también para…».
--   · Ruta (B4) parte por parte: comp/<slug unidad>/<AAAA-MM>/<sitio_clave>/
--     <AAAAMMDD>_<cliente_id>.<ext>, con AAAA-MM = el mes de AAAAMMDD.
--   · El objeto tiene que existir y ser de quien llama; si no, sin_objeto
--     (la cola lo vuelve a subir).
--   · fecha = la pone el SERVIDOR: el día CDMX de p_tomada_en acotado a
--     [hoy-2, hoy]; sin p_tomada_en, hoy (A1d y pregunta 3 de §9).
--   · Cada toma sale en una lista: ligadas (pendiente, regresada o
--     por_revisar: en ésta es una foto extra que la analista verá), cerradas
--     (comprobada, cancelada, campaña cerrada o retirada, o ya no existe),
--     futuras (fecha > hoy), ajenas (no es tuya: comp_es_mi_toma; M2d) y
--     duplicadas (esa campaña ya tiene la foto en otro día, A1a, o la foto ya
--     se devolvió en esa misma toma, B4).
-- POR QUÉ la foto se busca DESPUÉS de bloquear las tomas y con «for key
-- share» (26-oct-2026): si comp_quitar_foto la está borrando, se espera y se
-- ve que ya no está (entonces cuenta como nueva y sin objeto, si la app ya lo
-- borró), en vez de caer en un error de llave foránea.
create or replace function public.comp_subir_foto(p_cliente_id uuid, p_path text, p_toma_ids bigint[], p_tipo text,
  p_pos text, p_momento text, p_tomada_en timestamptz, p_lat double precision, p_lng double precision,
  p_precision real)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_hoy date := (now() at time zone 'America/Mexico_City')::date;
  v_ids bigint[]; v_unidad text; v_clave text; v_partes text[];
  v_e record; v_ya boolean := false; v_fecha date;
  v_lig bigint[] := '{}'; v_cerr bigint[] := '{}'; v_fut bigint[] := '{}'; v_aje bigint[] := '{}';
  v_dup bigint[] := '{}'; v_ok bigint[] := '{}';
  v_x record;
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  -- 1) Datos.
  if p_cliente_id is null or nullif(btrim(p_path), '') is null then
    raise exception 'Falta el cliente_id o la ruta de la foto.' using errcode = 'CP002';
  end if;
  if p_tipo is null or p_tipo not in ('foto', 'video') then
    raise exception 'Tipo de archivo no válido: %.', p_tipo using errcode = 'CP002';
  end if;
  if p_pos is null or p_pos !~ '^[a-z_]{1,20}$' then
    raise exception 'Posición no válida: %.', p_pos using errcode = 'CP002';
  end if;
  if p_momento is not null and p_momento not in ('dia', 'noche') then
    raise exception 'Momento no válido: %.', p_momento using errcode = 'CP002';
  end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_toma_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) > 60 then
    raise exception 'Una foto va con 1 a 60 tomas (llegaron %).', coalesce(cardinality(v_ids), 0) using errcode = 'CP002';
  end if;

  -- 2) Todas de la misma unidad y sitio (CP003). Las que ya no existen (un
  --    replan borró una toma sin fotos) salen en cerradas.
  select min(t.unidad), min(s.sitio_clave) into v_unidad, v_clave
    from comp_tomas t join comp_sitios s on s.id = t.sitio_id
   where t.id = any (v_ids);
  if exists (select 1 from comp_tomas t join comp_sitios s on s.id = t.sitio_id
              where t.id = any (v_ids) and (t.unidad <> v_unidad or s.sitio_clave <> v_clave)) then
    raise exception 'Las tomas de una foto deben ser del mismo sitio y unidad.' using errcode = 'CP003';
  end if;

  -- 3) Bandera de captura (M6).
  if not comp_captura_abierta(v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'captura_cerrada');
  end if;

  if v_unidad is null then
    -- Ninguna toma existe ya: nada que ligar ni contra qué validar la ruta.
    return jsonb_build_object('ok', true, 'ya', false, 'evidencia_id', null, 'fecha', null,
                              'ligadas', '[]'::jsonb, 'cerradas', to_jsonb(v_ids), 'futuras', '[]'::jsonb,
                              'ajenas', '[]'::jsonb, 'duplicadas', '[]'::jsonb);
  end if;

  -- 4) Ruta (B4), parte por parte.
  v_partes := string_to_array(p_path, '/');
  if cardinality(v_partes) <> 5
     or v_partes[1] <> 'comp'
     or v_partes[2] is distinct from comp_slug_unidad(v_unidad)
     or v_partes[3] !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     or v_partes[4] <> v_clave
     or v_partes[5] !~ ('^[0-9]{8}_' || p_cliente_id::text || '\.[a-z0-9]{2,5}$')
     or v_partes[3] <> substr(v_partes[5], 1, 4) || '-' || substr(v_partes[5], 5, 2) then
    raise exception 'La ruta de la foto no es válida para esa toma.' using errcode = 'CP002';
  end if;

  -- 6) Candado de las tomas (M8: ocupada = reintento).
  begin
    perform 1 from comp_tomas t where t.id = any (v_ids) order by t.id for update;
  exception when lock_not_available then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;

  -- 5) ¿Ya estaba? Mismo path y mismo dueño, o es un error de la app (CP002).
  begin
    select e.id, e.path, e.subido_por, e.fecha into v_e
      from comp_evidencias e where e.cliente_id = p_cliente_id
      for key share;
  exception when lock_not_available then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;
  if v_e.id is not null then
    if v_e.path <> p_path or v_e.subido_por <> v_email then
      raise exception 'Ese cliente_id ya es de otra foto.' using errcode = 'CP002';
    end if;
    v_ya := true;
  elsif not exists (select 1 from storage.objects o
                     where o.bucket_id = 'evidencias' and o.name = p_path and o.owner_id = (auth.uid())::text) then
    return jsonb_build_object('ok', false, 'codigo', 'sin_objeto');
  end if;

  -- 7) Clasificación.
  for v_x in
    select x.id, tt.id as existe, tt.estado, tt.fecha, tt.campana_id, c.estatus, c.retirada
      from unnest(v_ids) x(id)
      left join comp_tomas tt on tt.id = x.id
      left join comp_campanas c on c.id = tt.campana_id
     order by x.id
  loop
    if v_x.existe is null or v_x.estado in ('comprobada', 'cancelada') or v_x.estatus <> 'abierta' or v_x.retirada then
      v_cerr := v_cerr || v_x.id;
    elsif v_x.fecha > v_hoy then
      v_fut := v_fut || v_x.id;
    elsif not comp_es_mi_toma(v_x.id, v_email) then
      v_aje := v_aje || v_x.id;
    else
      v_ok := v_ok || v_x.id;
    end if;
  end loop;

  -- 8) A1: una foto vale para un solo día de cada campaña.
  if exists (select 1 from comp_tomas t where t.id = any (v_ok) group by t.campana_id having count(*) > 1) then
    raise exception 'Una foto no puede ir a dos días de la misma campaña.' using errcode = 'CP005';
  end if;

  -- POR QUÉ no se registra una foto nueva sin ninguna toma que ligar
  -- (26-oct-2026, revisor-rls): quedaría una fila sin tomas que el Supervisor
  -- ve y cuyo objeto no se puede borrar («en uso»), aunque quien la subió no
  -- sea monitorista de esa toma (todas ajenas). Sin fila, el objeto queda
  -- suelto y su dueño lo borra; «Usar también para…» con el mismo cliente_id
  -- la registra cuando sí haya toma.
  if v_e.id is null and cardinality(v_ok) = 0 then
    return jsonb_build_object('ok', true, 'ya', false, 'evidencia_id', null, 'fecha', null,
                              'ligadas', '[]'::jsonb, 'cerradas', to_jsonb(v_cerr), 'futuras', to_jsonb(v_fut),
                              'ajenas', to_jsonb(v_aje), 'duplicadas', '[]'::jsonb);
  end if;

  -- 9) La foto, si no estaba.
  if v_e.id is null then
    v_fecha := case when p_tomada_en is null then v_hoy
                    else least(v_hoy, greatest(v_hoy - 2, (p_tomada_en at time zone 'America/Mexico_City')::date)) end;
    insert into comp_evidencias (cliente_id, path, unidad, sitio_clave, fecha, tipo, pos, momento, tomada_en_tel,
                                 lat, lng, precision_m, subido_por)
    values (p_cliente_id, p_path, v_unidad, v_clave, v_fecha, p_tipo, p_pos, p_momento, p_tomada_en,
            case when p_lat between -90 and 90 then p_lat end, case when p_lng between -180 and 180 then p_lng end,
            case when p_precision >= 0 then p_precision end, v_email)
    on conflict (cliente_id) do nothing;
    select e.id, e.path, e.subido_por, e.fecha into v_e from comp_evidencias e where e.cliente_id = p_cliente_id;
    if v_e.path <> p_path or v_e.subido_por <> v_email then      -- otra sesión ganó con otros datos
      raise exception 'Ese cliente_id ya es de otra foto.' using errcode = 'CP002';
    end if;
  end if;

  -- 10) Ligas. Ya ligada y vigente = ligada (reintento); ya ligada y devuelta
  --     (B4: se re-toma, no se vuelve a ligar) u otro día de la campaña =
  --     duplicada.
  for v_x in select x.id, tt.campana_id from unnest(v_ok) x(id) join comp_tomas tt on tt.id = x.id order by x.id loop
    insert into comp_evidencia_tomas (evidencia_id, toma_id, campana_id, ligada_por)
    values (v_e.id, v_x.id, v_x.campana_id, v_email)
    on conflict do nothing;
    if found or exists (select 1 from comp_evidencia_tomas et
                         where et.evidencia_id = v_e.id and et.toma_id = v_x.id and et.regresada_en is null) then
      v_lig := v_lig || v_x.id;
    else
      v_dup := v_dup || v_x.id;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'ya', v_ya, 'evidencia_id', v_e.id, 'fecha', v_e.fecha,
                            'ligadas', to_jsonb(v_lig), 'cerradas', to_jsonb(v_cerr), 'futuras', to_jsonb(v_fut),
                            'ajenas', to_jsonb(v_aje), 'duplicadas', to_jsonb(v_dup));
end $$;

-- Quita una foto de una toma (p_toma_id) o la borra entera (sin p_toma_id).
-- Solo quien la subió o el manager. Nunca le quita fotos a una toma que
-- espera revisión o ya está comprobada (enviada) ni toca una foto con
-- cualquier revisión (revisada; B2: se perdería el motivo del rechazo). Así
-- no existe la «toma atorada» de Pauta y no hace falta trigger.
-- Al borrar devuelve el path: la app borra el objeto después (ev_obj_del_comp
-- ya lo deja, porque la fila no existe).
-- POR QUÉ una liga devuelta (regresada_en) cuenta como revisada (26-oct-2026):
-- «Devolver al monitorista» marca la liga sin crear revisión. Si se pudiera
-- quitar, la misma foto se volvería a ligar limpia a esa toma y se saltaría
-- B4 (una foto devuelta se re-toma); además se perdería el rastro.
-- POR QUÉ se bloquean las tomas dos veces (26-oct-2026): entre leer las ligas
-- y bloquear la foto, comp_subir_foto pudo ligarla a otra toma; esa toma
-- también se bloquea y se revisa antes de borrar.
create or replace function public.comp_quitar_foto(p_cliente_id uuid, p_toma_id bigint default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_e record; v_quedan int;
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  if p_cliente_id is null then
    raise exception 'Falta el cliente_id.' using errcode = 'CP002';
  end if;
  select e.id, e.path, e.subido_por into v_e from comp_evidencias e where e.cliente_id = p_cliente_id;
  if v_e.id is null then
    return jsonb_build_object('ok', true, 'ya', true);
  end if;
  if v_e.subido_por <> v_email and not comp_es_manager(v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'sin_permiso');
  end if;

  begin
    perform 1 from comp_tomas t
     where t.id in (select et.toma_id from comp_evidencia_tomas et where et.evidencia_id = v_e.id)
     order by t.id for update;
    select e.id, e.path, e.subido_por into v_e from comp_evidencias e where e.id = v_e.id for update;
    if v_e.id is null then
      return jsonb_build_object('ok', true, 'ya', true);
    end if;
    perform 1 from comp_tomas t
     where t.id in (select et.toma_id from comp_evidencia_tomas et where et.evidencia_id = v_e.id)
     order by t.id for update;
  exception when lock_not_available then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;

  if p_toma_id is not null then
    if not exists (select 1 from comp_evidencia_tomas et where et.evidencia_id = v_e.id and et.toma_id = p_toma_id) then
      select count(*)::int into v_quedan from comp_evidencia_tomas et where et.evidencia_id = v_e.id;
      return jsonb_build_object('ok', true, 'ya', true, 'quedan', v_quedan);
    end if;
    if exists (select 1 from comp_revision_fotos r where r.evidencia_id = v_e.id and r.toma_id = p_toma_id)
       or exists (select 1 from comp_evidencia_tomas et
                   where et.evidencia_id = v_e.id and et.toma_id = p_toma_id and et.regresada_en is not null) then
      return jsonb_build_object('ok', false, 'codigo', 'revisada');
    end if;
    if exists (select 1 from comp_tomas t
                where t.id = p_toma_id and t.estado not in ('pendiente', 'regresada', 'cancelada')) then
      return jsonb_build_object('ok', false, 'codigo', 'enviada');
    end if;
    delete from comp_evidencia_tomas et where et.evidencia_id = v_e.id and et.toma_id = p_toma_id;
    select count(*)::int into v_quedan from comp_evidencia_tomas et where et.evidencia_id = v_e.id;
    -- POR QUÉ sin ninguna liga se borra la foto entera (26-oct-2026, revisión
    -- final): una foto ligada a A que en B salió ajena, cerrada o futura se
    -- quedaba, al quitarla de A, con fila y sin tomas, y su objeto «en uso».
    -- Igual que comp_subir_foto, no hay foto sin tomas; contesta path para que
    -- la app borre el objeto.
    if v_quedan = 0 and not exists (select 1 from comp_revision_fotos r where r.evidencia_id = v_e.id) then
      delete from comp_evidencias e where e.id = v_e.id;
      return jsonb_build_object('ok', true, 'desligada', true, 'quedan', 0, 'borrada', true, 'path', v_e.path);
    end if;
    return jsonb_build_object('ok', true, 'desligada', true, 'quedan', v_quedan);
  end if;

  if exists (select 1 from comp_revision_fotos r where r.evidencia_id = v_e.id)
     or exists (select 1 from comp_evidencia_tomas et where et.evidencia_id = v_e.id and et.regresada_en is not null) then
    return jsonb_build_object('ok', false, 'codigo', 'revisada');
  end if;
  if exists (select 1 from comp_evidencia_tomas et join comp_tomas t on t.id = et.toma_id
              where et.evidencia_id = v_e.id and t.estado in ('por_revisar', 'comprobada')) then
    return jsonb_build_object('ok', false, 'codigo', 'enviada');
  end if;
  delete from comp_evidencias e where e.id = v_e.id;              -- las ligas caen en cascada
  return jsonb_build_object('ok', true, 'borrada', true, 'path', v_e.path);
end $$;

-- Envía tomas a revisión (§4.2 2c; B11: la cola la llama sola en cuanto la
-- plantilla está completa). La BASE cuenta contra la plantilla vigente, no el
-- teléfono. Por toma, en orden: ajena · ya (por_revisar o comprobada) ·
-- cerrada (cancelada, campaña cerrada o retirada) · futura · faltan · si no,
-- por_revisar con enviada_en (hora del servidor), tomada_por y
-- plantilla_usada (A2).
-- Re-entrega (venía de regresada): si la última revisora sigue pudiendo
-- revisar esa campaña (B5) y la toma ya está revisada completa (sin fotos
-- nuevas), se comprueba sola a su nombre (pregunta 1 de §9).
-- Movimiento registrar_tomas por unidad y periodo, y aviso a quien revisa.
-- POR QUÉ todo va dentro de un solo bloque con «ocupada» (26-oct-2026): el
-- aviso toma un candado por correo; si choca a los 3 s, se deshace TODO el
-- registro (ninguna toma queda por_revisar sin su aviso) y la cola reintenta.
create or replace function public.comp_registrar_tomas(p_toma_ids bigint[])
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_hoy date := (now() at time zone 'America/Mexico_City')::date;
  v_ids bigint[]; v_res jsonb := '[]'::jsonb; v_env bigint[] := '{}'; v_solas bigint[] := '{}';
  v_sin bigint[]; v_faltan jsonb; v_pl jsonb; v_rev text;
  v_x record;
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_toma_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) > 200 then
    raise exception 'Se registran de 1 a 200 tomas a la vez (llegaron %).', coalesce(cardinality(v_ids), 0)
      using errcode = 'CP002';
  end if;
  if not comp_captura_abierta(v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'captura_cerrada');
  end if;

  begin
    perform 1 from comp_tomas tt where tt.id = any (v_ids) order by tt.id for update;

    for v_x in
      select x.id, tt.id as existe, tt.estado, tt.fecha, tt.regreso_n, c.estatus, c.retirada
        from unnest(v_ids) x(id)
        left join comp_tomas tt on tt.id = x.id
        left join comp_campanas c on c.id = tt.campana_id
       order by x.id
    loop
      if v_x.existe is null or not comp_es_mi_toma(v_x.id, v_email) then
        v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', v_x.estado, 'codigo', 'ajena', 'regreso_n', v_x.regreso_n);
      elsif v_x.estado in ('por_revisar', 'comprobada') then
        v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', v_x.estado, 'ya', true, 'regreso_n', v_x.regreso_n);
      elsif v_x.estado = 'cancelada' or v_x.estatus <> 'abierta' or v_x.retirada then
        v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', v_x.estado, 'codigo', 'cerrada', 'regreso_n', v_x.regreso_n);
      elsif v_x.fecha > v_hoy then
        v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', v_x.estado, 'codigo', 'futura', 'regreso_n', v_x.regreso_n);
      else
        v_pl := comp_plantilla_toma(v_x.id);
        v_faltan := comp_faltan(v_x.id, v_pl, false);
        -- POR QUÉ también sin ninguna foto vigente (26-oct-2026, revisor-rls):
        -- con una plantilla vacía (si alguien borra «unica») comp_faltan da
        -- '[]' y la toma iría a revisión sin fotos.
        if v_faltan <> '[]'::jsonb
           or not exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                           where et.toma_id = v_x.id and et.regresada_en is null and e.tipo = 'foto') then
          v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', v_x.estado, 'codigo', 'faltan', 'faltan', v_faltan,
                                               'regreso_n', v_x.regreso_n);
        else
          update comp_tomas tt
             set estado = 'por_revisar', enviada_en = now(), tomada_por = v_email, plantilla_usada = v_pl
           where tt.id = v_x.id;
          v_rev := null;
          if v_x.estado = 'regresada' then
            select r.revisado_por into v_rev
              from comp_revision_fotos r where r.toma_id = v_x.id
             order by r.revisado_en desc, r.evidencia_id desc limit 1;
          end if;
          if v_rev is not null and comp_puede_revisar(v_x.id, v_rev) and comp_comprobar_si_revisada(v_x.id, v_rev) then
            v_solas := v_solas || v_x.id;
            v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', 'comprobada', 'sola', true, 'regreso_n', v_x.regreso_n);
          else
            v_env := v_env || v_x.id;
            v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', 'por_revisar', 'regreso_n', v_x.regreso_n);
          end if;
        end if;
      end if;
    end loop;

    v_sin := comp_aviso_revision(v_env);

    insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
    select 'registrar_tomas', c.unidad, c.periodo_id, array_agg(distinct c.id order by c.id), count(*),
           jsonb_build_object('tomas', jsonb_agg(tt.id order by tt.id))
             || case when bool_or(tt.id = any (v_solas))
                     then jsonb_build_object('comprobadas_solas', jsonb_agg(tt.id order by tt.id) filter (where tt.id = any (v_solas)))
                     else '{}'::jsonb end
             || case when bool_or(tt.id = any (v_sin)) then jsonb_build_object('sin_aviso', true) else '{}'::jsonb end,
           v_email
      from comp_tomas tt join comp_campanas c on c.id = tt.campana_id
     where tt.id = any (v_env || v_solas)
     group by c.unidad, c.periodo_id;
  exception when lock_not_available then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;

  return jsonb_build_object('ok', true, 'tomas', v_res);
end $$;

revoke all on function public.comp_subir_foto(uuid, text, bigint[], text, text, text, timestamptz, double precision,
  double precision, real), public.comp_quitar_foto(uuid, bigint), public.comp_registrar_tomas(bigint[])
  from public, anon;
grant execute on function public.comp_subir_foto(uuid, text, bigint[], text, text, text, timestamptz, double precision,
  double precision, real), public.comp_quitar_foto(uuid, bigint), public.comp_registrar_tomas(bigint[])
  to authenticated, service_role;

-- ------------------------------------------------------------
-- 2d) comp_resumen_revision (§4.5; se adelanta aquí, 26-oct-2026): el chip
--     «Por revisar (N)» de «Mis campañas» sale en el incremento 2 (solo
--     lectura). security INVOKER: cuenta con la RLS de quien pregunta (la
--     analista, sus campañas; el Supervisor, su unidad; el manager, todo).
--     Usa comp_tomas_revision (campana_id, estado). ultima_enviada = el
--     enviada_en más reciente de esas tomas (cualquiera de los tres estados).
--     vw_comp_campanas no cambia (M9).
-- ------------------------------------------------------------
create or replace function public.comp_resumen_revision(p_periodo_id bigint)
returns table (campana_id bigint, por_revisar int, regresadas int, comprobadas int, ultima_enviada timestamptz)
language sql stable security invoker set search_path to 'public', 'pg_temp' as $$
  select t.campana_id,
         count(*) filter (where t.estado = 'por_revisar')::int,
         count(*) filter (where t.estado = 'regresada')::int,
         count(*) filter (where t.estado = 'comprobada')::int,
         max(t.enviada_en)
    from comp_tomas t
   where t.campana_id in (select c.id from comp_campanas c where c.periodo_id = p_periodo_id)
     and t.estado in ('por_revisar', 'regresada', 'comprobada')
   group by t.campana_id
   order by t.campana_id
$$;
revoke all on function public.comp_resumen_revision(bigint) from public, anon;
grant execute on function public.comp_resumen_revision(bigint) to authenticated, service_role;
