-- ============================================================
-- comp_f3_revision — Comprobaciones, fase 3 («monitorista y analista»),
-- migración 3 de 3: revisión de la analista, crédito y modo de
-- comprobación (29-oct-2026).
--
-- QUÉ HACE
--   · Revisión dentro de «Mis campañas» (spec §4.5 y §6.2):
--     comp_revisar_fotos (Correcta, Editada o quitar la marca; la misma foto
--     en todas sus versiones que la persona revisa, M5), comp_rechazar_fotos
--     (solo esa toma, con motivo), comp_regresar_toma («Devolver al
--     monitorista»), comp_reabrir_toma y comp_comprobar_toma (respaldo).
--     La toma se comprueba sola cuando no le queda foto sin revisar
--     (comp_comprobar_si_revisada, de la migración 2).
--   · Aviso de toma devuelta al monitorista (comp_aviso_regreso: comp_toma o,
--     si nadie tiene ya el rol, comp_toma_sin_monitorista al Supervisor; V6).
--   · comp_marcar_sitios (3d): al quitar una marca a mano, si el sitio tiene
--     una toma comprobada, queda comprobado por revisión.
--   · Modo de comprobación por campaña-versión (spec §11; Erik, 28 y
--     29-oct-2026): campo, cámaras o mixto.
--       - comp_campanas.modo_toma y pos_camara; una campaña NUEVA de
--         Ecovallas o de Vía Verde nace en mixto con la Corta por cámara (si
--         su plantilla la tiene); Biobox siempre campo. Las que ya existen se
--         quedan en campo.
--       - La plantilla de cada toma marca por posición via 'campo' o 'camara'
--         (comp_plantilla_toma). Una plantilla ya enviada sin «via» (antes de
--         esta migración) es toda de campo.
--       - Capturas de cámara desde la computadora (comp_subir_captura y
--         comp_quitar_captura): las sube la analista de la campaña, un
--         Supervisor de la unidad o el manager, de cualquier día del periodo
--         (nunca a futuro), y cuentan como correctas sin revisión. En cámaras
--         la toma queda comprobada al completar la plantilla; en mixto se
--         comprueba cuando el campo está revisado y la parte de cámara completa.
--       - comp_puede_revisar no cuenta las capturas de cámara: la analista
--         revisa el campo aunque haya subido la parte de cámara.
--       - El monitorista solo ve y registra la parte de campo
--         (comp_mis_tomas, comp_subir_foto, comp_registrar_tomas); una toma
--         de cámaras no le llega aunque su ruta lo nombre.
--       - comp_poner_modo: el Supervisor cambia el modo y las fotos por cámara
--         por lote.
--
-- DECISIONES (Erik; contexto/comprobaciones.md y spec §11)
--   · Nadie aprueba su propia toma (ni el manager), salvo las capturas de
--     cámara, que cuentan solas (29-oct-2026).
--   · Rechazar es por toma (B3); Correcta y Editada van a todas las
--     versiones de esa foto que la persona revisa (M5).
--   · Reabrir no avisa a nadie (25-oct-2026).
--   · Valor por omisión de Claude: «Reabrir» no congela la toma; si después
--     se cambia una marca y todo queda bien, se comprueba sola (igual que
--     cualquier toma por revisar). «Comprobar» sirve cuando no se cambia nada.
--
-- REGLAS COMUNES (las de las migraciones 1 y 2)
--   · security definer, search_path fijo; las que escriben, lock_timeout 3 s.
--   · Errores esperados en el RESULTADO ({ok:false, codigo:'ocupada' |
--     'sin_permiso' | 'toma_cerrada' | 'incompleta' | 'por_camara' |
--     'comprobada' | 'captura_cerrada' | 'sin_objeto'}); excepciones: CP001
--     sin sesión, CP002 datos inválidos, CP003 tomas de otro sitio o unidad,
--     CP005 dos tomas de la misma campaña para una foto; 42501 sin permiso en
--     una RPC del Supervisor.
--   · Orden de candados: tomas (order by id) → ligas/fotos/revisiones →
--     comp_sitios (solo comp_sitio_credito) → avisos (advisory por correo).
--     comp_poner_modo bloquea campañas y ninguna toma (como comp_poner_plantilla).
--   · Topes: 200 fotos por revisión, 60 tomas por captura, 5,000 campañas por lote.
--   · «Hoy» = día de CDMX.
--
-- Re-ejecutable: el candado acepta el md5 de producción o el de esta versión;
-- columnas, checks y trigger usan if not exists / create or replace.
-- Sin correos, llaves ni servidores (repo público).
-- ============================================================

-- POR QUÉ (como en la migración 1): los ALTER TABLE de comp_campanas,
-- comp_evidencias y comp_movimientos toman ACCESS EXCLUSIVE. Más vale fallar a
-- los 5 s y volver a correr que formarse detrás de un Armar.
set local lock_timeout = '5s';

-- ------------------------------------------------------------
-- 3a) Candado: si alguna de las 7 funciones que se reemplazan, o la lista de
--     acciones de la bitácora, cambió en producción desde el 29-oct-2026, no
--     se aplica nada.
-- ------------------------------------------------------------
create or replace function pg_temp.md5_fn(p_nombre text, p_args text) returns text language sql as $$
  select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = p_nombre and pg_get_function_identity_arguments(p.oid) = p_args $$;
do $$ begin
  if coalesce(pg_temp.md5_fn('comp_plantilla_toma', 'p_toma_id bigint'), 'falta')
       not in ('288912b6e73bc6d1321552c0b446baef', '1a7c0742e73890c85fc4a1153f634c5b') then
    raise exception 'comp_plantilla_toma cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce(pg_temp.md5_fn('comp_mis_tomas', 'p_desde date, p_hasta date'), 'falta')
       not in ('9e5277db05e440ab2205a5c1a447e67d', '855fe20c74fbd8c0cd5c0b4dd0918c18') then
    raise exception 'comp_mis_tomas cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce(pg_temp.md5_fn('comp_puede_revisar', 'p_toma_id bigint, p_email text'), 'falta')
       not in ('1db56a1d5396096e8eff8f2ccc970d03', 'f659ac5b49dc52f5766b74b21efa01b5') then
    raise exception 'comp_puede_revisar cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce(pg_temp.md5_fn('comp_aviso_revision', 'p_toma_ids bigint[]'), 'falta')
       not in ('9500f33ae80b23a0347d58a4abf9a098', '3ff290ffb85231d71c5e74dfe8fa5c0c') then
    raise exception 'comp_aviso_revision cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce(pg_temp.md5_fn('comp_subir_foto', 'p_cliente_id uuid, p_path text, p_toma_ids bigint[], p_tipo text, p_pos text, p_momento text, p_tomada_en timestamp with time zone, p_lat double precision, p_lng double precision, p_precision real'), 'falta')
       not in ('79f4fbd7a7ac1c8c3f3e2a0bdd11eabe', '244d0e408bde57b7c348dc3f8de223d2') then
    raise exception 'comp_subir_foto cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce(pg_temp.md5_fn('comp_registrar_tomas', 'p_toma_ids bigint[]'), 'falta')
       not in ('d180e6c003e95eaf6af5fb845cc8b80b', '3cb9994317446a49cbca7244ebc70d01') then
    raise exception 'comp_registrar_tomas cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce(pg_temp.md5_fn('comp_marcar_sitios', 'p_sitio_ids bigint[], p_comprobado boolean, p_dia date'), 'falta')
       not in ('c24c6e89e5a27c140ad11f955594a508', 'b40837be77a1507a741f213412666bf4') then
    raise exception 'comp_marcar_sitios cambió en producción: revisa antes de reemplazar.';
  end if;
  if coalesce((select md5(pg_get_constraintdef(oid)) from pg_constraint
                where conrelid = 'public.comp_movimientos'::regclass and conname = 'comp_movimientos_accion_check'), 'falta')
       not in ('9d22a54eb1c00139c3c364cf030b942d', '5678e7b7ac11c7fac94d5d801b290218') then
    raise exception 'La lista de acciones de comp_movimientos cambió en producción: revisa antes de reemplazar.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 3b) Columnas nuevas, al final. vw_comp_tomas y vw_comp_campanas no cambian
--     (M9): la app lee lo nuevo de las tablas.
-- ------------------------------------------------------------
alter table public.comp_campanas
  add column if not exists modo_toma text not null default 'campo',    -- campo | camaras | mixto
  add column if not exists pos_camara text[] not null default '{}',    -- mixto: posiciones de testigo que van por cámara
  add column if not exists modo_por text,
  add column if not exists modo_en timestamptz;

alter table public.comp_evidencias
  add column if not exists origen text not null default 'campo';      -- campo (teléfono) | camara (computadora)

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.comp_campanas'::regclass and conname = 'comp_campanas_modo_chk') then
    alter table public.comp_campanas add constraint comp_campanas_modo_chk
      check (modo_toma in ('campo', 'camaras', 'mixto'));
  end if;
  -- Erik, 28-oct-2026: Biobox siempre es campo.
  if not exists (select 1 from pg_constraint where conrelid = 'public.comp_campanas'::regclass and conname = 'comp_campanas_modo_biobox_chk') then
    alter table public.comp_campanas add constraint comp_campanas_modo_biobox_chk
      check (unidad <> 'Biobox' or modo_toma = 'campo');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.comp_campanas'::regclass and conname = 'comp_campanas_pos_camara_chk') then
    alter table public.comp_campanas add constraint comp_campanas_pos_camara_chk
      check (modo_toma = 'mixto' or pos_camara = '{}');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.comp_evidencias'::regclass and conname = 'comp_evidencias_origen_chk') then
    alter table public.comp_evidencias add constraint comp_evidencias_origen_chk
      check (origen in ('campo', 'camara'));
  end if;
end $$;

-- Bitácora: + 'modo'. Las capturas no se registran una por una (son miles,
-- como las fotos correctas): quedan en comp_evidencias con quién y cuándo.
alter table public.comp_movimientos drop constraint if exists comp_movimientos_accion_check;
alter table public.comp_movimientos add constraint comp_movimientos_accion_check check (accion in (
  'cargar','generar_tomas','editar_tomas','agregar_tomas','quitar_tomas','restaurar_tomas','asignar','pasar_pendiente',
  'marcar','desmarcar','cancelar','restaurar','cerrar','reabrir','editar','agregar_sitios','regla','retirar','regresar',
  'plantilla','refrescar_rutas','registrar_tomas','rechazar_fotos','regresar_toma','reabrir_toma','comprobar_toma','modo'));

-- ------------------------------------------------------------
-- 3c) Modo por omisión (trigger). Ningún insert de hoy nombra modo_toma, así
--     que al nacer siempre llega 'campo': Ecovallas y Vía Verde pasan a
--     mixto (Erik, 29-oct-2026). Para otro modo, comp_poner_modo después.
--     En mixto, pos_camara se queda solo con posiciones de la plantilla de
--     testigo; si queda vacío al entrar a mixto o al cambiar de plantilla,
--     va la Corta cuando la plantilla la tiene. Fuera de mixto, vacío.
--     Las campañas que ya existen no pasan por aquí (ADD COLUMN no dispara
--     triggers): se quedan en campo.
-- ------------------------------------------------------------
create or replace function public.comp_campana_modo_trg() returns trigger
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_pos text[];
begin
  if tg_op = 'INSERT' and new.modo_toma = 'campo' and new.unidad in ('Ecovallas', 'Vía Verde') then
    new.modo_toma := 'mixto';
  end if;
  if new.modo_toma is distinct from 'mixto' then
    new.pos_camara := '{}';
    return new;
  end if;
  select coalesce(array_agg(distinct x->>'pos'), '{}') into v_pos
    from comp_plantillas_toma p cross join lateral jsonb_array_elements(p.posiciones) x
   where p.codigo = coalesce(new.plantilla_codigo, 'unica');
  new.pos_camara := array(select distinct u from unnest(coalesce(new.pos_camara, '{}')) u where u = any (v_pos) order by u);
  if cardinality(new.pos_camara) = 0 and 'corta' = any (v_pos)
     and (tg_op = 'INSERT' or old.modo_toma is distinct from 'mixto'
          or old.plantilla_codigo is distinct from new.plantilla_codigo) then
    new.pos_camara := array['corta'];
  end if;
  return new;
end $$;

drop trigger if exists comp_campanas_modo on public.comp_campanas;
create trigger comp_campanas_modo before insert or update of modo_toma, pos_camara, plantilla_codigo
  on public.comp_campanas for each row execute function public.comp_campana_modo_trg();

-- Capturas que dejan de ir por cámara (revisión de seguridad, 29-oct-2026).
-- POR QUÉ: una captura cuenta como correcta sin revisión porque la posición
-- es de cámara. Si después cambia el modo, las fotos por cámara o la
-- plantilla de la campaña, esa captura seguiría cubriendo una posición que
-- ahora es de CAMPO, aprobada por quien la subió (comp_faltan cuenta fotos
-- de cualquier origen). Así, en las tomas que todavía se cuentan contra la
-- plantilla vigente (pendiente o devuelta), las capturas cuya posición ya no
-- va por cámara dejan de contar (regresada_en, como una foto devuelta: se
-- quedan de rastro) y la toma vuelve a pedir esa foto en campo. Las tomas
-- por revisar o comprobadas se cuentan contra su plantilla enviada (A2): ahí
-- la captura sigue valiendo.
-- Orden de candados: quien cambia la campaña ya la tiene; aquí se bloquean
-- sus tomas (order by id) y después las ligas. Ninguna RPC de tomas bloquea
-- campañas, así que no hay ciclo.
-- La regla, en UN lugar (segunda revisión de seguridad, 29-oct-2026): la
-- llaman este trigger, comp_rechazar_fotos y comp_regresar_toma (una toma
-- por revisar que conservaba su captura por A2 vuelve a contarse contra la
-- vigente al regresar) y comp_registrar_tomas antes de contar (cualquier
-- otro camino a pendiente o devuelta queda cubierto ahí). Solo toca tomas
-- pendientes o devueltas; quien llama ya bloqueó esas tomas. Devuelve
-- cuántas ligas dejaron de contar.
create or replace function public.comp_invalidar_capturas(p_toma_ids bigint[]) returns int
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_n int;
begin
  update comp_evidencia_tomas et set regresada_en = now()
    from comp_evidencias e, comp_tomas t
   where e.id = et.evidencia_id and t.id = et.toma_id and t.id = any (coalesce(p_toma_ids, '{}'))
     and t.estado in ('pendiente', 'regresada') and et.regresada_en is null and e.origen = 'camara'
     and not exists (select 1 from jsonb_array_elements(comp_plantilla_parte(comp_plantilla_toma(t.id), 'camara')) y
                      where y->>'pos' = e.pos and nullif(y->>'momento', '') is not distinct from e.momento);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.comp_campana_modo_ligas_trg() returns trigger
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_ids bigint[];
begin
  if (old.modo_toma, old.pos_camara, old.plantilla_codigo) is not distinct from (new.modo_toma, new.pos_camara, new.plantilla_codigo) then
    return null;
  end if;
  select array_agg(t.id order by t.id) into v_ids
    from (select t.id from comp_tomas t
           where t.campana_id = new.id and t.estado in ('pendiente', 'regresada')
             and exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                          where et.toma_id = t.id and et.regresada_en is null and e.origen = 'camara')
           order by t.id for update) t;
  perform comp_invalidar_capturas(v_ids);
  return null;
end $$;

drop trigger if exists comp_campanas_modo_ligas on public.comp_campanas;
create trigger comp_campanas_modo_ligas after update of modo_toma, pos_camara, plantilla_codigo
  on public.comp_campanas for each row execute function public.comp_campana_modo_ligas_trg();

-- ------------------------------------------------------------
-- 3d) Internas (sin grant: solo las llaman otras funciones security definer).
-- ------------------------------------------------------------

-- Plantilla VIGENTE de una toma (migración 1) + «via» por posición: 'camara'
-- si la campaña es de cámaras o, en mixto, si la posición está en
-- pos_camara; si no, 'campo'. La capa de mueble (Biobox) siempre es campo.
create or replace function public.comp_plantilla_toma(p_toma_id bigint) returns jsonb
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  with t as (
    select t.id, t.unidad, c.plantilla_codigo, s.vendor_face_id, c.modo_toma, c.pos_camara
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
           bool_or(capa_n = 1) as de_mueble,
           (array_agg(x->>'etiqueta' order by capa_n, ord))[1] as etiqueta,
           min(capa_n * 1000 + ord) as orden
      from pos group by 1, 2
  )
  select coalesce((select jsonb_agg(jsonb_build_object('pos', g.pos, 'n', g.n,
                                                       'alcance', case when g.de_sitio then 'sitio' else 'version' end,
                                                       'momento', g.momento, 'etiqueta', g.etiqueta,
                                                       'via', case when not g.de_mueble
                                                                    and (t.modo_toma = 'camaras'
                                                                         or (t.modo_toma = 'mixto' and g.pos = any (t.pos_camara)))
                                                                   then 'camara' else 'campo' end) order by g.orden)
                     from g cross join t), '[]'::jsonb)
   where exists (select 1 from t)
$$;

-- Una parte de una plantilla: las posiciones con via = p_via ('campo' o
-- 'camara'). Una posición sin via (plantilla enviada antes del 29-oct) es de campo.
create or replace function public.comp_plantilla_parte(p_plantilla jsonb, p_via text) returns jsonb
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select coalesce(jsonb_agg(x order by o), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_plantilla) = 'array' then p_plantilla else '[]'::jsonb end)
         with ordinality e(x, o)
   where coalesce(x->>'via', 'campo') = p_via
$$;

-- ¿p_email puede subir o quitar capturas de cámara en esta toma? Campaña
-- abierta y no retirada, y además: la analista de la campaña con el rol
-- vigente en la unidad, un Supervisor de la unidad o el manager (Erik,
-- 29-oct-2026). No mira el estado de la toma.
create or replace function public.comp_puede_capturar(p_toma_id bigint, p_email text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select coalesce(nullif(lower(btrim(p_email)), '') is not null, false)
     and exists (
       select 1 from comp_tomas t join comp_campanas c on c.id = t.campana_id
        where t.id = p_toma_id and c.estatus = 'abierta' and not c.retirada
          and ((c.analista_email = lower(btrim(p_email)) and comp_es_analista_de(p_email, c.unidad))
               or comp_tiene_rol_en(p_email, 'supervisor', c.unidad)
               or comp_es_manager(p_email)))
$$;

-- ¿p_email puede revisar esta toma? (migración 2) + las capturas de cámara
-- no cuentan como «subió una foto vigente» (Erik, 29-oct-2026: en mixto la
-- analista sube la parte de cámara y revisa la de campo).
create or replace function public.comp_puede_revisar(p_toma_id bigint, p_email text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select coalesce(nullif(lower(btrim(p_email)), '') is not null, false)
     and exists (
       select 1 from comp_tomas t join comp_campanas c on c.id = t.campana_id
        where t.id = p_toma_id and c.estatus = 'abierta'
          and t.tomada_por is distinct from lower(btrim(p_email))
          and not exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                           where et.toma_id = t.id and et.regresada_en is null and e.origen = 'campo'
                             and e.subido_por = lower(btrim(p_email)))
          and ((c.analista_email = lower(btrim(p_email)) and comp_es_analista_de(p_email, c.unidad))
               or (comp_tiene_rol_en(p_email, 'supervisor', c.unidad) and comp_es_analista_de(p_email, c.unidad))
               or comp_es_manager(p_email)))
$$;

-- Avisos de tomas por revisar (migración 2). Único cambio: «la tomó la
-- misma analista» ya no cuenta sus capturas de cámara.
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
                              where et.toma_id = t.id and et.regresada_en is null and e.origen = 'campo'
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

-- Aviso de toma devuelta (spec §4.4). Por toma regresada: a quien la envió si
-- sigue siendo monitorista de la unidad; si no, al monitorista asignado si lo
-- es → evento comp_toma, record_id = la toma más reciente del grupo. Si
-- ninguno sigue con el rol (V6) → Supervisores de la unidad (o, si no hay,
-- managers) → comp_toma_sin_monitorista, record_id = periodo. Agrupado por
-- destinatario, evento, unidad (y periodo en V6) dentro de la hora, como
-- comp_aviso_revision: se actualiza el aviso sin leer (sin push) o se inserta
-- uno nuevo (push). Nunca a quien devolvió.
create or replace function public.comp_aviso_regreso(p_toma_ids bigint[], p_por text) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_r jsonb; g record; v_n int; v_msg text; v_id bigint; v_per text;
  v_por text := lower(coalesce(btrim(p_por), ''));
  v_mes text[] := array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
begin
  if coalesce(cardinality(p_toma_ids), 0) = 0 then
    return;
  end if;
  with t as (
    select t.id, t.unidad, c.periodo_id, s.sitio_clave, t.fecha, t.rechazo_motivo,
           btrim(c.campana || ' ' || coalesce(c.version, '')) as cv,
           case when t.tomada_por is not null and comp_tiene_rol_en(t.tomada_por, 'monitorista', t.unidad) then t.tomada_por
                when t.monitorista_email is not null and comp_tiene_rol_en(t.monitorista_email, 'monitorista', t.unidad)
                  then t.monitorista_email end as mon
      from comp_tomas t
      join comp_campanas c on c.id = t.campana_id
      join comp_sitios s on s.id = t.sitio_id
     where t.id = any (p_toma_ids) and t.estado = 'regresada'
  ), d as (
    select t.*,
           case when t.mon is not null then 'comp_toma' else 'comp_toma_sin_monitorista' end as evento,
           case when t.mon is not null then array[t.mon]
                else coalesce(nullif(array(select distinct lower(btrim(ur.usuario_email)) from usuario_roles ur
                                            where ur.rol = 'supervisor' and comp_tiene_rol_en(ur.usuario_email, 'supervisor', t.unidad)
                                              and lower(btrim(ur.usuario_email)) <> v_por), '{}'),
                              array(select distinct lower(btrim(ur.usuario_email)) from usuario_roles ur
                                     where ur.rol = 'manager' and lower(btrim(ur.usuario_email)) <> v_por)) end as dest
      from t
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'unidad', d.unidad, 'periodo_id', d.periodo_id, 'evento', d.evento, 'dest', to_jsonb(d.dest),
           'ultima', d.sitio_clave || ' · ' || d.cv || ' · ' || to_char(d.fecha, 'FMDD') || '-' || v_mes[extract(month from d.fecha)::int]
                     || ': ' || left(coalesce(d.rechazo_motivo, ''), 140))), '[]'::jsonb)
    into v_r
    from d;

  for g in
    select dd.email, x.evento, x.unidad,
           case when x.evento = 'comp_toma_sin_monitorista' then x.periodo_id end as periodo_id,
           max(x.id) as ultima_id,
           (array_agg(x.ultima order by x.id desc))[1] as ultima
      from jsonb_to_recordset(v_r) x(id bigint, unidad text, periodo_id bigint, evento text, dest jsonb, ultima text)
      cross join lateral jsonb_array_elements_text(x.dest) dd(email)
     where dd.email <> v_por
     group by dd.email, x.evento, x.unidad, case when x.evento = 'comp_toma_sin_monitorista' then x.periodo_id end
     order by 1, 2, 3, 4
  loop
    perform pg_advisory_xact_lock(hashtext('comp_aviso'), hashtext(g.email));
    if g.evento = 'comp_toma' then
      select count(*)::int into v_n from comp_tomas t
       where t.unidad = g.unidad and t.estado = 'regresada' and (t.tomada_por = g.email or t.monitorista_email = g.email);
      v_n := greatest(v_n, 1);
      v_msg := 'Te devolvieron ' || v_n || case when v_n = 1 then ' toma' else ' tomas' end || ' · última: ' || g.ultima;
    else
      select count(*)::int into v_n from comp_tomas t join comp_campanas c on c.id = t.campana_id
       where c.periodo_id = g.periodo_id and t.unidad = g.unidad and t.estado = 'regresada'
         and not coalesce(comp_tiene_rol_en(t.tomada_por, 'monitorista', t.unidad), false)
         and not coalesce(comp_tiene_rol_en(t.monitorista_email, 'monitorista', t.unidad), false);
      v_n := greatest(v_n, 1);
      select p.etiqueta into v_per from comp_periodos p where p.id = g.periodo_id;
      v_msg := v_n || case when v_n = 1 then ' toma devuelta' else ' tomas devueltas' end || ' sin monitorista vigente · '
               || comp_etiqueta_unidad(g.unidad) || ' · ' || coalesce(v_per, 'periodo ' || g.periodo_id)
               || ' · reasígnalas en Formato';
    end if;
    select n.id into v_id from notificaciones n
     where n.para_email = g.email and n.evento = g.evento and n.unidad_negocio = g.unidad
       and (g.evento = 'comp_toma' or n.record_id = g.periodo_id::text)
       and not n.leida and n.creado_en > now() - interval '1 hour'
     order by n.id desc limit 1
     for update;
    if v_id is not null then
      update notificaciones
         set mensaje = v_msg, record_id = case when g.evento = 'comp_toma' then g.ultima_id::text else record_id end
       where id = v_id;
    else
      insert into notificaciones (record_id, para_email, evento, mensaje, unidad_negocio)
      values (case when g.evento = 'comp_toma' then g.ultima_id::text else g.periodo_id::text end, g.email, g.evento, v_msg, g.unidad);
    end if;
  end loop;
end $$;

revoke all on function public.comp_campana_modo_trg(), public.comp_campana_modo_ligas_trg(),
  public.comp_invalidar_capturas(bigint[]), public.comp_plantilla_toma(bigint),
  public.comp_plantilla_parte(jsonb, text), public.comp_puede_capturar(bigint, text),
  public.comp_puede_revisar(bigint, text), public.comp_aviso_revision(bigint[]), public.comp_aviso_regreso(bigint[], text)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3e) Captura del monitorista (migración 2) con el modo.
-- ------------------------------------------------------------

-- comp_subir_foto: igual que en la migración 2, salvo el paso 7: una toma de
-- cámaras sale en «ajenas» y una posición que en esa toma va por cámara, en
-- «duplicadas» ('extra' sí se acepta en mixto). Una plantilla vacía
-- (anomalía: alguien borró «unica») se trata como antes, de campo.
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
  v_dup bigint[] := '{}'; v_ok bigint[] := '{}'; v_cam bigint[] := '{}';
  v_x record; v_pl jsonb;
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
    select e.id, e.path, e.subido_por, e.fecha, e.pos, e.origen into v_e
      from comp_evidencias e where e.cliente_id = p_cliente_id
      for key share;
  exception when lock_not_available then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;
  if v_e.id is not null then
    -- Una captura de cámara no se liga por aquí (29-oct-2026, revisor-rls).
    if v_e.path <> p_path or v_e.subido_por <> v_email or v_e.origen <> 'campo' then
      raise exception 'Ese cliente_id ya es de otra foto.' using errcode = 'CP002';
    end if;
    v_ya := true;
  elsif not exists (select 1 from storage.objects o
                     where o.bucket_id = 'evidencias' and o.name = p_path and o.owner_id = (auth.uid())::text) then
    return jsonb_build_object('ok', false, 'codigo', 'sin_objeto');
  end if;

  -- 7) Clasificación. Modo (29-oct-2026): una toma sin parte de campo no es
  --    del monitorista (ajenas); una posición que en esa toma va por cámara
  --    sale en duplicadas (revisor-rls, 29-oct-2026: la app publicada lee
  --    «ajena» como «te la quitaron» y deja de registrar la toma; con
  --    duplicadas solo avisa que esa foto no cuenta). Cuenta la posición
  --    guardada si la foto ya existe. La plantilla: la enviada si la toma
  --    espera revisión; si no, la vigente, la misma que exige el registro.
  for v_x in
    select x.id, tt.id as existe, tt.estado, tt.fecha, tt.campana_id, tt.plantilla_usada, c.estatus, c.retirada
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
      v_pl := case when v_x.estado = 'por_revisar' then v_x.plantilla_usada else comp_plantilla_toma(v_x.id) end;
      if comp_plantilla_parte(v_pl, 'campo') = '[]'::jsonb and comp_plantilla_parte(v_pl, 'camara') <> '[]'::jsonb then
        v_aje := v_aje || v_x.id;
      elsif exists (select 1 from jsonb_array_elements(comp_plantilla_parte(v_pl, 'camara')) y
                     where y->>'pos' = coalesce(v_e.pos, p_pos)) then
        v_cam := v_cam || v_x.id;
      else
        v_ok := v_ok || v_x.id;
      end if;
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
                              'ajenas', to_jsonb(v_aje), 'duplicadas', to_jsonb(v_cam));
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
                            'ajenas', to_jsonb(v_aje), 'duplicadas', to_jsonb(v_dup || v_cam));
end $$;

-- comp_registrar_tomas: igual que en la migración 2, salvo (29-oct-2026):
--   · cuenta solo contra la parte de CAMPO de la plantilla y exige una foto de
--     campo vigente; una toma sin parte de campo (cámaras) es «ajena»;
--   · plantilla_usada guarda la plantilla completa, con su «via»: la parte de
--     cámara se exige al comprobar (comp_comprobar_si_revisada);
--   · la re-entrega busca a la última revisora entre las fotos de campo (las
--     capturas traen su propia revisión «correcta» a nombre de quien las subió).
create or replace function public.comp_registrar_tomas(p_toma_ids bigint[])
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_hoy date := (now() at time zone 'America/Mexico_City')::date;
  v_ids bigint[]; v_res jsonb := '[]'::jsonb; v_env bigint[] := '{}'; v_solas bigint[] := '{}';
  v_sin bigint[]; v_faltan jsonb; v_pl jsonb; v_campo jsonb; v_rev text;
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
      v_pl := case when v_x.existe is not null then comp_plantilla_toma(v_x.id) end;
      v_campo := comp_plantilla_parte(v_pl, 'campo');
      if v_x.existe is null or not comp_es_mi_toma(v_x.id, v_email)
         or (v_x.estado not in ('por_revisar', 'comprobada') and v_campo = '[]'::jsonb
             and comp_plantilla_parte(v_pl, 'camara') <> '[]'::jsonb) then
        v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', v_x.estado, 'codigo', 'ajena', 'regreso_n', v_x.regreso_n);
      elsif v_x.estado in ('por_revisar', 'comprobada') then
        v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', v_x.estado, 'ya', true, 'regreso_n', v_x.regreso_n);
      elsif v_x.estado = 'cancelada' or v_x.estatus <> 'abierta' or v_x.retirada then
        v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', v_x.estado, 'codigo', 'cerrada', 'regreso_n', v_x.regreso_n);
      elsif v_x.fecha > v_hoy then
        v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', v_x.estado, 'codigo', 'futura', 'regreso_n', v_x.regreso_n);
      else
        -- Seguridad (29-oct-2026): antes de contar, una captura que ya no va
        -- por cámara deja de contar (cubre cualquier camino a pendiente o devuelta).
        perform comp_invalidar_capturas(array[v_x.id]);
        v_faltan := comp_faltan(v_x.id, v_campo, false);
        -- POR QUÉ también sin ninguna foto vigente (26-oct-2026, revisor-rls):
        -- con una plantilla vacía (si alguien borra «unica») comp_faltan da
        -- '[]' y la toma iría a revisión sin fotos. Desde el 29-oct, de campo.
        if v_faltan <> '[]'::jsonb
           or not exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                           where et.toma_id = v_x.id and et.regresada_en is null and e.tipo = 'foto'
                             and e.origen = 'campo') then
          v_res := v_res || jsonb_build_object('id', v_x.id, 'estado', v_x.estado, 'codigo', 'faltan', 'faltan', v_faltan,
                                               'regreso_n', v_x.regreso_n);
        else
          update comp_tomas tt
             set estado = 'por_revisar', enviada_en = now(), tomada_por = v_email, plantilla_usada = v_pl
           where tt.id = v_x.id;
          v_rev := null;
          if v_x.estado = 'regresada' then
            select r.revisado_por into v_rev
              from comp_revision_fotos r join comp_evidencias e on e.id = r.evidencia_id
             where r.toma_id = v_x.id and e.origen = 'campo'
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

-- comp_mis_tomas: igual que en la migración 1, salvo (29-oct-2026):
--   · no manda tomas de campañas de cámaras ni tomas sin parte de campo;
--   · 'plantilla' = solo la parte de campo, y 'por_camara' = la de cámara
--     (para decir «la Corta la toma la analista desde cámaras»);
--   · 'tiene' cuenta solo fotos de campo, y «subió una foto» también;
--   · una toma devuelta trae la plantilla vigente (la que exige el registro),
--     no la del envío anterior.
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
       and c.modo_toma <> 'camaras'
       and t.estado in ('pendiente', 'regresada', 'por_revisar')
       and (t.monitorista_email = v_email
            or (t.estado = 'regresada' and t.tomada_por = v_email)
            or (t.estado in ('pendiente', 'regresada')
                and exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                             where et.toma_id = t.id and et.regresada_en is null and e.subido_por = v_email
                               and e.origen = 'campo')))
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
               and e.origen = 'campo'
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
           'plantilla', pp.campo,
           'por_camara', pp.camara,
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
    -- revisor-rls (29-oct-2026): una devuelta se re-toma contra la vigente, la misma que exige el registro.
    cross join lateral (select case when x.estado = 'por_revisar' then x.plantilla_usada
                                    else comp_plantilla_toma(x.id) end as p) p0
    cross join lateral (select comp_plantilla_parte(p0.p, 'campo') as campo, comp_plantilla_parte(p0.p, 'camara') as camara) pp
    left join lateral (select i.tipo_mueble, i.latitud, i.longitud from inventario i
                        where i.vendor_face_id = s.vendor_face_id and i.unidad_negocio = x.unidad
                        order by (i.tipo_medio = 'Digital') desc limit 1) i on true
    left join lateral (select p.secuencia, p.parada from par p
                        where p.ruta_id = x.ruta_id and p.site_id in (s.site_id, s.sitio_clave)
                        order by (p.site_id = s.site_id) desc limit 1) ru on true
    left join rutas_monitoreo rm on rm.id = x.ruta_id
    left join tiene ti on ti.toma_id = x.id
    left join rech re on re.toma_id = x.id
   where jsonb_array_length(pp.campo) > 0 or jsonb_array_length(pp.camara) = 0;

  return jsonb_build_object('hoy', v_hoy, 'captura', comp_captura_abierta(v_email), 'unidades', to_jsonb(v_unidades),
                            'cortada', coalesce(v_n, 0) > 1500, 'tomas', v_tomas);
end $$;

-- ------------------------------------------------------------
-- 3f) comp_marcar_sitios (spec 3d): igual que en la fase 2, salvo que al
--     quitar una marca a mano el sitio pasa por comp_sitio_credito: si tiene
--     una toma comprobada queda comprobado por revisión en vez de pendiente.
-- ------------------------------------------------------------
create or replace function public.comp_marcar_sitios(p_sitio_ids bigint[], p_comprobado boolean default true,
  p_dia date default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_hoy date := (now() at time zone 'America/Mexico_City')::date;
  v_dia date := coalesce(p_dia, (now() at time zone 'America/Mexico_City')::date);
  v_ids bigint[]; v_n int; v_cambiados int := 0; v_desm bigint[];
begin
  if p_comprobado is null then
    raise exception 'Falta decir si se marca o se quita la marca.';
  end if;
  select array_agg(distinct x) into v_ids from unnest(p_sitio_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste sitios.';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'Demasiados sitios en un lote (%); el tope es 5,000.', cardinality(v_ids);
  end if;
  -- Permiso por CADA sitio: campaña abierta que la persona lleva (con el
  -- rol vigente, #25) o gestiona. Si uno falla, no se cambia nada.
  v_n := comp_sitios_ajenos(v_ids);
  if v_n > 0 then
    raise exception '% sitio(s) son de campañas cerradas o que no llevas. No se marcó nada.', v_n;
  end if;

  if p_comprobado then
    if v_dia > v_hoy or v_dia < v_hoy - 7 then
      raise exception 'El día debe ser hoy o uno de los 7 días anteriores.';
    end if;
    -- Un sitio que ya no viene en la carga o de una campaña retirada no se
    -- marca: no cuenta para la meta (revisor-rls, 23-oct-2026).
    select count(*) into v_n
      from comp_sitios s join comp_campanas c on c.id = s.campana_id
     where s.id = any (v_ids) and s.estado = 'pendiente' and (s.fuera_de_carga or c.retirada);
    if v_n > 0 then
      raise exception '% sitio(s) ya no vienen en la carga o son de una campaña retirada. No se marcó nada.', v_n;
    end if;
    select count(*) into v_n
      from comp_sitios s join comp_campanas c on c.id = s.campana_id join comp_periodos p on p.id = c.periodo_id
     where s.id = any (v_ids) and s.estado = 'pendiente' and v_dia < p.fecha_inicio;
    if v_n > 0 then
      raise exception 'El % es antes de que empiece el periodo de % sitio(s). No se marcó nada.', to_char(v_dia, 'DD/MM/YYYY'), v_n;
    end if;
    with upd as (
      update comp_sitios s
         set estado = 'comprobado', comprobado_dia = v_dia, comprobado_en = now(),
             comprobado_por = v_email, comprobado_via = 'marca'
       where s.id = any (v_ids) and s.estado = 'pendiente'
      returning s.id, s.unidad, s.campana_id
    ), mov as (
      insert into comp_movimientos (accion, unidad, campana_ids, sitio_ids, n, detalle, por)
      select 'marcar', u.unidad, array_agg(distinct u.campana_id), array_agg(u.id order by u.id), count(*),
             jsonb_build_object('dia', v_dia), v_email
        from upd u group by u.unidad
    )
    select count(*) into v_cambiados from upd;
  else
    -- Solo quien marcó o el Supervisor quita una marca; la revisión (fase 3)
    -- no se desmarca aquí.
    select count(*) into v_n
      from comp_sitios s join comp_campanas c on c.id = s.campana_id
     where s.id = any (v_ids) and s.estado = 'comprobado' and s.comprobado_via = 'marca'
       and s.comprobado_por is distinct from v_email
       and c.unidad not in (select comp_mis_unidades(array['supervisor']::app_role[]));
    if v_n > 0 then
      raise exception '% sitio(s) los marcó otra persona: solo ella o el Supervisor puede quitar la marca. No se cambió nada.', v_n;
    end if;
    with upd as (
      update comp_sitios s
         set estado = 'pendiente', comprobado_dia = null, comprobado_en = null,
             comprobado_por = null, comprobado_via = null
       where s.id = any (v_ids) and s.estado = 'comprobado' and s.comprobado_via = 'marca'
      returning s.id, s.unidad, s.campana_id
    ), mov as (
      insert into comp_movimientos (accion, unidad, campana_ids, sitio_ids, n, por)
      select 'desmarcar', u.unidad, array_agg(distinct u.campana_id), array_agg(u.id order by u.id), count(*), v_email
        from upd u group by u.unidad
    )
    select count(*), array_agg(u.id order by u.id) into v_cambiados, v_desm from upd u;
    -- 3d (fase 3): si el sitio tiene una toma comprobada, cuenta por revisión.
    perform comp_sitio_credito(x) from unnest(coalesce(v_desm, '{}')) x;
  end if;
  return jsonb_build_object('cambiados', v_cambiados, 'sin_cambio', cardinality(v_ids) - v_cambiados,
                            'dia', case when p_comprobado then v_dia end);
end $$;

-- ------------------------------------------------------------
-- 3g) RPC de revisión (spec §4.5 3c). Todas: lock_timeout 3 s; bloquean las
--     tomas (order by id) antes de leer o escribir ligas y revisiones.
-- ------------------------------------------------------------

-- Correcta, Editada o quitar la marca de unas fotos de una toma.
--   · p_estado: 'correcta' | 'editada' (una sola foto y p_editada_path, un
--     objeto de quien llama en comp-analista/<unidad>/<AAAA-MM>/<evidencia>_editada_<ms>.<ext>)
--     | 'quitar' (borra la marca de una toma por revisar; no toca rechazadas).
--   · Solo fotos de CAMPO con liga vigente a p_toma_id (CP002 si no): las de
--     cámara ya cuentan solas.
--   · p_en_todas (M5): la misma marca va a las ligas vigentes de esa foto en
--     las otras tomas que la persona puede revisar, por revisar o comprobadas
--     ('quitar': solo por revisar).
--   · Después, cada toma por revisar se comprueba si ya no le falta nada;
--     una comprobada recalcula el crédito (el día puede cambiar con la editada).
--   · borrar = editadas viejas que ya no usa nadie (la app borra el objeto).
create or replace function public.comp_revisar_fotos(p_toma_id bigint, p_evidencia_ids bigint[], p_estado text,
  p_editada_path text default null, p_en_todas boolean default true)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_ids bigint[]; v_t record; v_dest bigint[]; v_viejas text[]; v_borrar text[];
  v_n int; v_comp bigint[] := '{}'; v_partes text[]; v_x record;
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  if p_estado is null or p_estado not in ('correcta', 'editada', 'quitar') then
    raise exception 'Marca no válida: %.', p_estado using errcode = 'CP002';
  end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_evidencia_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) > 200 then
    raise exception 'Se revisan de 1 a 200 fotos a la vez (llegaron %).', coalesce(cardinality(v_ids), 0) using errcode = 'CP002';
  end if;
  if p_estado = 'editada' then
    v_partes := string_to_array(coalesce(p_editada_path, ''), '/');
    if cardinality(v_ids) <> 1 or cardinality(v_partes) <> 4 or v_partes[1] <> 'comp-analista'
       or v_partes[2] is null or v_partes[2] not in ('ecovallas', 'biobox', 'via-verde')
       or v_partes[3] !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
       or v_partes[4] !~ ('^' || v_ids[1] || '_editada_[0-9]{10,16}\.[a-z0-9]{2,5}$') then
      raise exception 'La editada va con una sola foto y una ruta válida.' using errcode = 'CP002';
    end if;
    if not exists (select 1 from storage.objects o
                    where o.bucket_id = 'evidencias' and o.name = p_editada_path and o.owner_id = (auth.uid())::text) then
      raise exception 'El archivo editado no está arriba o no es tuyo.' using errcode = 'CP002';
    end if;
  elsif p_editada_path is not null then
    raise exception 'Solo la editada lleva archivo.' using errcode = 'CP002';
  end if;

  if not comp_puede_revisar(p_toma_id, v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'sin_permiso');
  end if;

  -- POR QUÉ todo en un bloque (revisor-rls, 29-oct-2026): después de las tomas
  -- se bloquean sitios (crédito) en orden de toma; un choque o un deadlock con
  -- otra revisión deshace todo y contesta «ocupada» (la app reintenta), en vez
  -- de reventar con 55P03 o 40P01.
  begin
    -- Destinos: p_toma_id y, con p_en_todas, las otras tomas con liga vigente
    -- a esas fotos que la persona puede revisar.
    select array_agg(distinct et.toma_id order by et.toma_id) into v_dest
      from comp_evidencia_tomas et join comp_tomas t on t.id = et.toma_id
     where et.evidencia_id = any (v_ids) and et.regresada_en is null
       and (et.toma_id = p_toma_id
            or (coalesce(p_en_todas, true) and t.estado in ('por_revisar', 'comprobada')
                and (p_estado <> 'quitar' or t.estado = 'por_revisar')
                and comp_puede_revisar(t.id, v_email)));
    v_dest := array(select distinct x from unnest(coalesce(v_dest, '{}') || p_toma_id) x order by x);
    perform 1 from comp_tomas t where t.id = any (v_dest) order by t.id for update;

  select t.id, t.estado into v_t from comp_tomas t where t.id = p_toma_id;
  if v_t.estado is distinct from 'por_revisar' and (v_t.estado is distinct from 'comprobada' or p_estado = 'quitar') then
    return jsonb_build_object('ok', false, 'codigo', 'toma_cerrada');
  end if;
  -- Ya con la toma bloqueada: ¿sigue pudiendo? (B5: la campaña pudo cerrarse o cambiar de analista).
  if not comp_puede_revisar(p_toma_id, v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'sin_permiso');
  end if;
  select count(*) into v_n
    from unnest(v_ids) x(id)
   where not exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                      where et.evidencia_id = x.id and et.toma_id = p_toma_id and et.regresada_en is null
                        and e.origen = 'campo');
  if v_n > 0 then
    raise exception '% foto(s) no son de campo con liga vigente a esa toma.', v_n using errcode = 'CP002';
  end if;
  -- Los destinos que ya no se pueden revisar (cambió algo entre leer y bloquear) se quedan fuera.
  v_dest := array(select t.id from comp_tomas t
                   where t.id = any (v_dest)
                     and (t.id = p_toma_id
                          or (t.estado in ('por_revisar', 'comprobada') and (p_estado <> 'quitar' or t.estado = 'por_revisar')
                              and comp_puede_revisar(t.id, v_email)))
                   order by t.id);

  -- Editadas que se van a reemplazar o quitar.
  select array_agg(distinct r.editada_path) into v_viejas
    from comp_revision_fotos r
   where r.evidencia_id = any (v_ids) and r.toma_id = any (v_dest) and r.editada_path is not null
     and r.editada_path is distinct from p_editada_path;

  if p_estado = 'quitar' then
    delete from comp_revision_fotos r
     using comp_evidencia_tomas et
     where et.evidencia_id = r.evidencia_id and et.toma_id = r.toma_id and et.regresada_en is null
       and r.evidencia_id = any (v_ids) and r.toma_id = any (v_dest) and r.estado <> 'rechazada'
       and exists (select 1 from comp_tomas t where t.id = r.toma_id and t.estado = 'por_revisar');
    get diagnostics v_n = row_count;
  else
    insert into comp_revision_fotos (evidencia_id, toma_id, estado, motivo, editada_path, revisado_por, revisado_en)
    select et.evidencia_id, et.toma_id, p_estado, null, case when p_estado = 'editada' then p_editada_path end, v_email, now()
      from comp_evidencia_tomas et
     where et.evidencia_id = any (v_ids) and et.toma_id = any (v_dest) and et.regresada_en is null
    on conflict (evidencia_id, toma_id) do update
      set estado = excluded.estado, motivo = null, editada_path = excluded.editada_path,
          revisado_por = excluded.revisado_por, revisado_en = excluded.revisado_en;
    get diagnostics v_n = row_count;
  end if;

  select array_agg(x) into v_borrar from unnest(coalesce(v_viejas, '{}')) x
   where not exists (select 1 from comp_revision_fotos r where r.editada_path = x);

  for v_x in select t.id, t.estado, t.sitio_id from comp_tomas t where t.id = any (v_dest) order by t.id loop
    if v_x.estado = 'por_revisar' then
      if comp_comprobar_si_revisada(v_x.id, v_email) then
        v_comp := v_comp || v_x.id;
      end if;
    elsif v_x.estado = 'comprobada' then
      perform comp_sitio_credito(v_x.sitio_id);
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'aplicadas', v_n, 'tomas', to_jsonb(v_dest), 'comprobadas', to_jsonb(v_comp),
                            'borrar', to_jsonb(coalesce(v_borrar, '{}')));
  exception when lock_not_available or deadlock_detected then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;
end $$;

-- Rechaza unas fotos de CAMPO de una toma (solo esa toma, B3), con motivo.
-- La toma vuelve al monitorista (regresada) con «Fotos rechazadas (n): motivo»
-- y la plantilla le vuelve a pedir lo rechazado. Desde por_revisar o comprobada
-- (le quita el crédito o lo pasa a otra toma comprobada del sitio).
create or replace function public.comp_rechazar_fotos(p_toma_id bigint, p_evidencia_ids bigint[], p_motivo text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_motivo text := nullif(btrim(p_motivo), '');
  v_ids bigint[]; v_t record; v_n int; v_viejas text[]; v_borrar text[];
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  if v_motivo is null or length(v_motivo) > 500 then
    raise exception 'Escribe el motivo del rechazo (hasta 500 letras).' using errcode = 'CP002';
  end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_evidencia_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) > 200 then
    raise exception 'Se rechazan de 1 a 200 fotos a la vez (llegaron %).', coalesce(cardinality(v_ids), 0) using errcode = 'CP002';
  end if;

  begin
    select t.id, t.estado, t.sitio_id, t.unidad, t.campana_id into v_t from comp_tomas t where t.id = p_toma_id for update;
  if v_t.id is null or v_t.estado not in ('por_revisar', 'comprobada') then
    return jsonb_build_object('ok', false, 'codigo', 'toma_cerrada');
  end if;
  if not comp_puede_revisar(p_toma_id, v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'sin_permiso');
  end if;
  select count(*) into v_n
    from unnest(v_ids) x(id)
   where not exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                      where et.evidencia_id = x.id and et.toma_id = p_toma_id and et.regresada_en is null
                        and e.origen = 'campo');
  if v_n > 0 then
    raise exception '% foto(s) no son de campo con liga vigente a esa toma.', v_n using errcode = 'CP002';
  end if;

  select array_agg(distinct r.editada_path) into v_viejas
    from comp_revision_fotos r where r.toma_id = p_toma_id and r.evidencia_id = any (v_ids) and r.editada_path is not null;
  update comp_evidencia_tomas et set regresada_en = now()
   where et.toma_id = p_toma_id and et.evidencia_id = any (v_ids) and et.regresada_en is null;
  insert into comp_revision_fotos (evidencia_id, toma_id, estado, motivo, editada_path, revisado_por, revisado_en)
  select x, p_toma_id, 'rechazada', v_motivo, null, v_email, now() from unnest(v_ids) x
  on conflict (evidencia_id, toma_id) do update
    set estado = 'rechazada', motivo = excluded.motivo, editada_path = null,
        revisado_por = excluded.revisado_por, revisado_en = excluded.revisado_en;
  update comp_tomas t
     set estado = 'regresada', rechazo_motivo = 'Fotos rechazadas (' || cardinality(v_ids) || '): ' || v_motivo,
         rechazada_por = v_email, rechazada_en = now(), regreso_n = t.regreso_n + 1,
         comprobada_en = null, comprobada_por = null
   where t.id = p_toma_id;
  -- Devuelta = se cuenta contra la vigente: una captura que ya no va por cámara deja de contar.
  perform comp_invalidar_capturas(array[p_toma_id]);
  perform comp_sitio_credito(v_t.sitio_id);

  select array_agg(x) into v_borrar from unnest(coalesce(v_viejas, '{}')) x
   where not exists (select 1 from comp_revision_fotos r where r.editada_path = x);

  insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
  select 'rechazar_fotos', c.unidad, c.periodo_id, array[c.id], cardinality(v_ids),
         jsonb_build_object('toma', p_toma_id, 'fotos', to_jsonb(v_ids), 'motivo', v_motivo), v_email
    from comp_campanas c where c.id = v_t.campana_id;
  perform comp_aviso_regreso(array[p_toma_id], v_email);

  return jsonb_build_object('ok', true, 'rechazadas', cardinality(v_ids), 'borrar', to_jsonb(coalesce(v_borrar, '{}')));
  exception when lock_not_available or deadlock_detected then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;
end $$;

-- «Devolver al monitorista» (B6): toda la parte de CAMPO deja de contar en esta
-- toma (las revisiones se quedan, para el rastro) y la toma vuelve con el
-- motivo. La parte de cámara se queda. Desde por_revisar o comprobada. Una
-- toma sin parte de campo (cámaras) no se devuelve: por_camara.
-- La toma se bloquea ANTES de leer quién la tomó.
create or replace function public.comp_regresar_toma(p_toma_id bigint, p_motivo text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_motivo text := nullif(btrim(p_motivo), '');
  v_t record; v_n int;
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  if v_motivo is null or length(v_motivo) > 500 then
    raise exception 'Escribe el motivo para devolverla (hasta 500 letras).' using errcode = 'CP002';
  end if;
  begin
    select t.id, t.estado, t.sitio_id, t.campana_id, t.plantilla_usada into v_t from comp_tomas t where t.id = p_toma_id for update;
  if v_t.id is null or v_t.estado not in ('por_revisar', 'comprobada') then
    return jsonb_build_object('ok', false, 'codigo', 'toma_cerrada');
  end if;
  if not comp_puede_revisar(p_toma_id, v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'sin_permiso');
  end if;
  if comp_plantilla_parte(v_t.plantilla_usada, 'campo') = '[]'::jsonb
     and comp_plantilla_parte(v_t.plantilla_usada, 'camara') <> '[]'::jsonb then
    return jsonb_build_object('ok', false, 'codigo', 'por_camara');
  end if;

  update comp_evidencia_tomas et set regresada_en = now()
    from comp_evidencias e
   where e.id = et.evidencia_id and et.toma_id = p_toma_id and et.regresada_en is null and e.origen = 'campo';
  get diagnostics v_n = row_count;
  update comp_tomas t
     set estado = 'regresada', rechazo_motivo = 'Devuelta completa: ' || v_motivo,
         rechazada_por = v_email, rechazada_en = now(), regreso_n = t.regreso_n + 1,
         comprobada_en = null, comprobada_por = null
   where t.id = p_toma_id;
  perform comp_invalidar_capturas(array[p_toma_id]);
  perform comp_sitio_credito(v_t.sitio_id);

  insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
  select 'regresar_toma', c.unidad, c.periodo_id, array[c.id], 1,
         jsonb_build_object('toma', p_toma_id, 'fotos', v_n, 'motivo', v_motivo), v_email
    from comp_campanas c where c.id = v_t.campana_id;
  perform comp_aviso_regreso(array[p_toma_id], v_email);

  return jsonb_build_object('ok', true, 'fotos', v_n);
  exception when lock_not_available or deadlock_detected then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;
end $$;

-- Reabre una toma comprobada: vuelve a por_revisar con sus fotos y marcas
-- intactas y el sitio deja de contar con ella (comp_sitio_credito). Sin aviso
-- (Erik, 25-oct-2026). El rastro (reabierta_*) no se limpia después.
create or replace function public.comp_reabrir_toma(p_toma_id bigint, p_motivo text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_motivo text := nullif(btrim(p_motivo), '');
  v_t record;
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  if v_motivo is null or length(v_motivo) > 500 then
    raise exception 'Escribe el motivo para reabrirla (hasta 500 letras).' using errcode = 'CP002';
  end if;
  begin
    select t.id, t.estado, t.sitio_id, t.campana_id into v_t from comp_tomas t where t.id = p_toma_id for update;
  if v_t.id is null or v_t.estado <> 'comprobada' then
    return jsonb_build_object('ok', false, 'codigo', 'toma_cerrada');
  end if;
  if not comp_puede_revisar(p_toma_id, v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'sin_permiso');
  end if;
  update comp_tomas t
     set estado = 'por_revisar', comprobada_en = null, comprobada_por = null,
         reabierta_motivo = v_motivo, reabierta_por = v_email, reabierta_en = now()
   where t.id = p_toma_id;
  perform comp_sitio_credito(v_t.sitio_id);
  insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
  select 'reabrir_toma', c.unidad, c.periodo_id, array[c.id], 1,
         jsonb_build_object('toma', p_toma_id, 'motivo', v_motivo), v_email
    from comp_campanas c where c.id = v_t.campana_id;
  return jsonb_build_object('ok', true);
  exception when lock_not_available or deadlock_detected then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;
end $$;

-- Respaldo (después de reabrir sin cambiar nada): comprueba la toma si ya no
-- le falta nada; si no, incompleta con lo que falta.
create or replace function public.comp_comprobar_toma(p_toma_id bigint)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_t record;
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  begin
    select t.id, t.estado, t.campana_id, t.plantilla_usada into v_t from comp_tomas t where t.id = p_toma_id for update;
  if v_t.id is null or v_t.estado <> 'por_revisar' then
    return jsonb_build_object('ok', false, 'codigo', 'toma_cerrada');
  end if;
  if not comp_puede_revisar(p_toma_id, v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'sin_permiso');
  end if;
  if not comp_comprobar_si_revisada(p_toma_id, v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'incompleta',
                              'faltan', comp_faltan(p_toma_id, v_t.plantilla_usada, true),
                              'sin_revisar', (select count(*)::int from comp_evidencia_tomas et
                                               where et.toma_id = p_toma_id and et.regresada_en is null
                                                 and not exists (select 1 from comp_revision_fotos r
                                                                  where r.evidencia_id = et.evidencia_id and r.toma_id = et.toma_id
                                                                    and r.estado in ('correcta', 'editada'))));
  end if;
  insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
  select 'comprobar_toma', c.unidad, c.periodo_id, array[c.id], 1, jsonb_build_object('toma', p_toma_id), v_email
    from comp_campanas c where c.id = v_t.campana_id;
  return jsonb_build_object('ok', true);
  exception when lock_not_available or deadlock_detected then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;
end $$;

-- ------------------------------------------------------------
-- 3h) Modo de comprobación: lote del Supervisor y capturas de cámara.
-- ------------------------------------------------------------

-- Modo de un lote de campañas (Campañas › «Modo…»). Solo el Supervisor de la
-- unidad (o el manager). Biobox solo campo (CP002). p_pos_camara: solo en
-- mixto; NULL = la que ya tenía (o la Corta, si entra a mixto). El trigger
-- deja solo posiciones de la plantilla. Bloquea las campañas abiertas
-- (order by id) y ninguna toma. Las tomas ya enviadas conservan su
-- plantilla_usada (enviadas_conservan); las pendientes que ya tienen fotos de
-- campo que el modo nuevo manda a cámara se cuentan en con_fotos.
create or replace function public.comp_poner_modo(p_campana_ids bigint[], p_modo text, p_pos_camara text[] default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_modo text := nullif(btrim(p_modo), '');
  v_pos text[];
  v_ids bigint[]; v_n int; v_u text; v_cambiadas int := 0; v_cerradas int := 0; v_enviadas int := 0;
  v_sin_camara int := 0; v_con_fotos int := 0; v_camb bigint[];
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  if v_modo is null or v_modo not in ('campo', 'camaras', 'mixto') then
    raise exception 'Modo no válido: %.', p_modo using errcode = 'CP002';
  end if;
  if p_pos_camara is not null then
    if exists (select 1 from unnest(p_pos_camara) x where x is null or x !~ '^[a-z_]{1,20}$') then
      raise exception 'Posición no válida en las fotos por cámara.' using errcode = 'CP002';
    end if;
    v_pos := array(select distinct x from unnest(p_pos_camara) x order by x);
  end if;
  select array_agg(distinct x) into v_ids from unnest(p_campana_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste campañas.' using errcode = 'CP002';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'Demasiadas campañas en un lote (%).', cardinality(v_ids) using errcode = 'CP002';
  end if;
  select cardinality(v_ids) - count(*) into v_n from comp_campanas where id = any (v_ids);
  if v_n > 0 then
    raise exception '% campaña(s) ya no existen. Recarga la lista; no se cambió nada.', v_n using errcode = 'CP002';
  end if;
  for v_u in select distinct c.unidad from comp_campanas c where c.id = any (v_ids) loop
    if not comp_gestiona(v_u) then
      raise exception 'Solo el Supervisor (o el Admin) cambia el modo de %.', comp_etiqueta_unidad(v_u)
        using errcode = '42501';
    end if;
  end loop;
  if v_modo <> 'campo' and exists (select 1 from comp_campanas c where c.id = any (v_ids) and c.unidad = 'Biobox') then
    raise exception 'Biobox siempre se comprueba en campo.' using errcode = 'CP002';
  end if;

  begin
    -- for no key update (revisor-rls): modo_toma no es llave; así no choca con
    -- los inserts de tomas, que toman candado de llave sobre la campaña.
    perform 1 from comp_campanas c where c.id = any (v_ids) and c.estatus = 'abierta' order by c.id for no key update;
  exception when lock_not_available then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;

  select count(*) into v_cerradas from comp_campanas c where c.id = any (v_ids) and c.estatus <> 'abierta';
  with upd as (
    update comp_campanas c
       set modo_toma = v_modo,
           pos_camara = case when v_modo <> 'mixto' then '{}'
                             when v_pos is not null then v_pos
                             when c.modo_toma = 'mixto' then c.pos_camara
                             else '{}' end,
           modo_por = v_email, modo_en = now(), actualizado_en = now()
     where c.id = any (v_ids) and c.estatus = 'abierta'
       and (c.modo_toma is distinct from v_modo or (v_modo = 'mixto' and v_pos is not null and c.pos_camara is distinct from v_pos))
    returning c.id, c.unidad, c.periodo_id, c.modo_toma, c.pos_camara
  ), mov as (
    insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
    select 'modo', u.unidad, u.periodo_id, array_agg(u.id order by u.id), count(*),
           jsonb_build_object('modo', v_modo) || case when v_pos is not null then jsonb_build_object('pos_camara', to_jsonb(v_pos)) else '{}'::jsonb end,
           v_email
      from upd u group by u.unidad, u.periodo_id
  )
  select count(*), array_agg(id), count(*) filter (where modo_toma = 'mixto' and pos_camara = '{}')
    into v_cambiadas, v_camb, v_sin_camara from upd;
  select count(*) into v_enviadas
    from comp_tomas t where t.campana_id = any (coalesce(v_camb, '{}')) and t.estado in ('por_revisar', 'comprobada');
  select count(*) into v_con_fotos
    from comp_tomas t
   where t.campana_id = any (coalesce(v_camb, '{}')) and t.estado in ('pendiente', 'regresada')
     and exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                  where et.toma_id = t.id and et.regresada_en is null and e.origen = 'campo'
                    and e.pos in (select y->>'pos' from jsonb_array_elements(comp_plantilla_parte(comp_plantilla_toma(t.id), 'camara')) y));

  return jsonb_build_object('ok', true, 'modo', v_modo, 'cambiadas', v_cambiadas,
                            'sin_cambio', cardinality(v_ids) - v_cerradas - v_cambiadas,
                            'cerradas_omitidas', v_cerradas, 'enviadas_conservan', v_enviadas,
                            'mixto_sin_camara', v_sin_camara, 'con_fotos', v_con_fotos);
end $$;

-- Sube una captura de cámara (desde la computadora) y la liga a las tomas que
-- manda la pantalla. Idempotente por p_cliente_id (como comp_subir_foto).
--   · Quién: la analista de la campaña, un Supervisor de la unidad o el
--     manager (comp_puede_capturar); con la captura abierta (comp_piloto).
--   · p_dia: el día que muestra la grabación; dentro del periodo, recortado a
--     la vigencia de la campaña si la tiene, y nunca a futuro (Erik,
--     29-oct-2026). La foto cuenta con ese día. Una captura que ya existe
--     solo se vuelve a ligar con su misma posición, momento y día.
--   · Ruta como la de campo: comp/<slug>/<AAAA-MM>/<sitio_clave>/<AAAAMMDD>_<cliente_id>.<ext>.
--   · Por toma: ligadas, cerradas (comprobada, cancelada, campaña cerrada o
--     retirada, borrada), futuras (fecha > hoy), ajenas (no puede capturar
--     ahí), no_camara (esa posición no va por cámara en esa toma),
--     fuera_periodo y duplicadas (A1 o ya devuelta).
--   · Cada liga nace con su revisión 'correcta' a nombre de quien sube.
--   · Después: una toma sin parte de campo (cámaras) se comprueba en cuanto
--     su plantilla está completa; en mixto, una toma por revisar se
--     comprueba si el campo ya está revisado (a nombre de quien sube, si puede
--     revisar; si no, de la última revisora del campo).
create or replace function public.comp_subir_captura(p_cliente_id uuid, p_path text, p_toma_ids bigint[], p_pos text,
  p_momento text, p_dia date)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_hoy date := (now() at time zone 'America/Mexico_City')::date;
  v_ids bigint[]; v_unidad text; v_clave text; v_partes text[];
  v_e record; v_ya boolean := false; v_pl jsonb; v_rev text;
  v_lig bigint[] := '{}'; v_cerr bigint[] := '{}'; v_fut bigint[] := '{}'; v_aje bigint[] := '{}';
  v_nocam bigint[] := '{}'; v_fuera bigint[] := '{}'; v_dup bigint[] := '{}'; v_ok bigint[] := '{}';
  v_comp bigint[] := '{}';
  v_x record;
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  if p_cliente_id is null or nullif(btrim(p_path), '') is null then
    raise exception 'Falta el cliente_id o la ruta de la captura.' using errcode = 'CP002';
  end if;
  if p_pos is null or p_pos !~ '^[a-z_]{1,20}$' then
    raise exception 'Posición no válida: %.', p_pos using errcode = 'CP002';
  end if;
  if p_momento is not null and p_momento not in ('dia', 'noche') then
    raise exception 'Momento no válido: %.', p_momento using errcode = 'CP002';
  end if;
  if p_dia is null or p_dia > v_hoy then
    raise exception 'El día de la captura no puede ser futuro ni faltar.' using errcode = 'CP002';
  end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_toma_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) > 60 then
    raise exception 'Una captura va con 1 a 60 tomas (llegaron %).', coalesce(cardinality(v_ids), 0) using errcode = 'CP002';
  end if;
  select min(t.unidad), min(s.sitio_clave) into v_unidad, v_clave
    from comp_tomas t join comp_sitios s on s.id = t.sitio_id
   where t.id = any (v_ids);
  if exists (select 1 from comp_tomas t join comp_sitios s on s.id = t.sitio_id
              where t.id = any (v_ids) and (t.unidad <> v_unidad or s.sitio_clave <> v_clave)) then
    raise exception 'Las tomas de una captura deben ser del mismo sitio y unidad.' using errcode = 'CP003';
  end if;
  if not comp_captura_abierta(v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'captura_cerrada');
  end if;
  if v_unidad is null then
    return jsonb_build_object('ok', true, 'ya', false, 'evidencia_id', null, 'ligadas', '[]'::jsonb,
                              'cerradas', to_jsonb(v_ids), 'futuras', '[]'::jsonb, 'ajenas', '[]'::jsonb,
                              'no_camara', '[]'::jsonb, 'fuera_periodo', '[]'::jsonb, 'duplicadas', '[]'::jsonb,
                              'comprobadas', '[]'::jsonb);
  end if;
  v_partes := string_to_array(p_path, '/');
  if cardinality(v_partes) <> 5
     or v_partes[1] <> 'comp'
     or v_partes[2] is distinct from comp_slug_unidad(v_unidad)
     or v_partes[3] !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     or v_partes[4] <> v_clave
     or v_partes[5] !~ ('^[0-9]{8}_' || p_cliente_id::text || '\.[a-z0-9]{2,5}$')
     or v_partes[3] <> substr(v_partes[5], 1, 4) || '-' || substr(v_partes[5], 5, 2) then
    raise exception 'La ruta de la captura no es válida para esa toma.' using errcode = 'CP002';
  end if;

  begin
    perform 1 from comp_tomas t where t.id = any (v_ids) order by t.id for update;
    select e.id, e.path, e.subido_por, e.fecha, e.origen, e.pos, e.momento into v_e
      from comp_evidencias e where e.cliente_id = p_cliente_id
      for key share;
  if v_e.id is not null then
    if v_e.path <> p_path or v_e.subido_por <> v_email or v_e.origen <> 'camara' then
      raise exception 'Ese cliente_id ya es de otra foto.' using errcode = 'CP002';
    end if;
    -- revisor-rls (29-oct-2026, alto): la misma captura con otra posición
    -- podría ligarse a otra versión donde esa posición es de campo y cubrirla
    -- aprobada por quien la subió. Una captura vale con lo que se guardó.
    if v_e.pos <> p_pos or v_e.momento is distinct from p_momento or v_e.fecha <> p_dia then
      raise exception 'Esa captura ya está registrada con otra posición o día.' using errcode = 'CP002';
    end if;
    v_ya := true;
  elsif not exists (select 1 from storage.objects o
                     where o.bucket_id = 'evidencias' and o.name = p_path and o.owner_id = (auth.uid())::text) then
    return jsonb_build_object('ok', false, 'codigo', 'sin_objeto');
  end if;

  for v_x in
    select x.id, tt.id as existe, tt.estado, tt.fecha, tt.plantilla_usada, c.estatus, c.retirada,
           -- La ventana: el periodo recortado a la vigencia de la campaña, si la
           -- tiene, y siempre el día de la toma (comp_agregar_tomas acepta tomas
           -- fuera de vigencia; sin esto no podrían recibir captura).
           least(greatest(p.fecha_inicio, coalesce(c.inicio, p.fecha_inicio)), tt.fecha) as desde,
           greatest(least(p.fecha_fin, coalesce(c.fin, p.fecha_fin)), tt.fecha) as hasta
      from unnest(v_ids) x(id)
      left join comp_tomas tt on tt.id = x.id
      left join comp_campanas c on c.id = tt.campana_id
      left join comp_periodos p on p.id = c.periodo_id
     order by x.id
  loop
    if v_x.existe is null or v_x.estado in ('comprobada', 'cancelada') or v_x.estatus <> 'abierta' or v_x.retirada then
      v_cerr := v_cerr || v_x.id;
    elsif v_x.fecha > v_hoy then
      v_fut := v_fut || v_x.id;
    elsif not comp_puede_capturar(v_x.id, v_email) then
      v_aje := v_aje || v_x.id;
    elsif p_dia < v_x.desde or p_dia > v_x.hasta then
      v_fuera := v_fuera || v_x.id;
    else
      -- La enviada si espera revisión; si no, la vigente (como el registro).
      v_pl := case when v_x.estado = 'por_revisar' then v_x.plantilla_usada else comp_plantilla_toma(v_x.id) end;
      if not exists (select 1 from jsonb_array_elements(comp_plantilla_parte(v_pl, 'camara')) y
                      where y->>'pos' = p_pos and nullif(y->>'momento', '') is not distinct from p_momento) then
        v_nocam := v_nocam || v_x.id;
      else
        v_ok := v_ok || v_x.id;
      end if;
    end if;
  end loop;

  if exists (select 1 from comp_tomas t where t.id = any (v_ok) group by t.campana_id having count(*) > 1) then
    raise exception 'Una captura no puede ir a dos días de la misma campaña.' using errcode = 'CP005';
  end if;
  if v_e.id is null and cardinality(v_ok) = 0 then
    return jsonb_build_object('ok', true, 'ya', false, 'evidencia_id', null, 'ligadas', '[]'::jsonb,
                              'cerradas', to_jsonb(v_cerr), 'futuras', to_jsonb(v_fut), 'ajenas', to_jsonb(v_aje),
                              'no_camara', to_jsonb(v_nocam), 'fuera_periodo', to_jsonb(v_fuera),
                              'duplicadas', '[]'::jsonb, 'comprobadas', '[]'::jsonb);
  end if;

  if v_e.id is null then
    insert into comp_evidencias (cliente_id, path, unidad, sitio_clave, fecha, tipo, pos, momento, subido_por, origen)
    values (p_cliente_id, p_path, v_unidad, v_clave, p_dia, 'foto', p_pos, p_momento, v_email, 'camara')
    on conflict (cliente_id) do nothing;
    select e.id, e.path, e.subido_por, e.fecha, e.origen into v_e from comp_evidencias e where e.cliente_id = p_cliente_id;
    if v_e.path <> p_path or v_e.subido_por <> v_email or v_e.origen <> 'camara' then
      raise exception 'Ese cliente_id ya es de otra foto.' using errcode = 'CP002';
    end if;
  end if;

  for v_x in select x.id, tt.campana_id from unnest(v_ok) x(id) join comp_tomas tt on tt.id = x.id order by x.id loop
    insert into comp_evidencia_tomas (evidencia_id, toma_id, campana_id, ligada_por)
    values (v_e.id, v_x.id, v_x.campana_id, v_email)
    on conflict do nothing;
    if found or exists (select 1 from comp_evidencia_tomas et
                         where et.evidencia_id = v_e.id and et.toma_id = v_x.id and et.regresada_en is null) then
      v_lig := v_lig || v_x.id;
      insert into comp_revision_fotos (evidencia_id, toma_id, estado, revisado_por)
      values (v_e.id, v_x.id, 'correcta', v_email)
      on conflict (evidencia_id, toma_id) do nothing;
    else
      v_dup := v_dup || v_x.id;
    end if;
  end loop;

  -- ¿Ya se comprueba alguna?
  for v_x in select t.id, t.estado, t.sitio_id, t.plantilla_usada from comp_tomas t where t.id = any (v_lig) order by t.id loop
    v_pl := case when v_x.estado = 'por_revisar' then v_x.plantilla_usada else comp_plantilla_toma(v_x.id) end;
    if comp_plantilla_parte(v_pl, 'campo') = '[]'::jsonb then
      -- Cámaras: sin revisión; se comprueba al completar la plantilla, y
      -- nunca con una foto de campo ligada que nadie revisó (revisor-rls,
      -- 29-oct-2026: la campaña pudo pasar a cámaras con fotos ya subidas).
      if v_x.estado in ('pendiente', 'regresada', 'por_revisar')
         and comp_faltan(v_x.id, v_pl, true) = '[]'::jsonb
         and not exists (select 1 from comp_evidencia_tomas et join comp_evidencias e on e.id = et.evidencia_id
                          where et.toma_id = v_x.id and et.regresada_en is null and e.origen = 'campo'
                            and not exists (select 1 from comp_revision_fotos r
                                             where r.evidencia_id = et.evidencia_id and r.toma_id = et.toma_id
                                               and r.estado in ('correcta', 'editada'))) then
        update comp_tomas t
           set estado = 'comprobada', enviada_en = coalesce(t.enviada_en, now()), plantilla_usada = v_pl,
               comprobada_en = now(), comprobada_por = v_email
         where t.id = v_x.id;
        perform comp_sitio_credito(v_x.sitio_id);
        v_comp := v_comp || v_x.id;
      end if;
    elsif v_x.estado = 'por_revisar' then
      -- Mixto: el campo ya revisado y ahora completa la parte de cámara.
      v_rev := null;
      if comp_puede_revisar(v_x.id, v_email) then
        v_rev := v_email;
      else
        select r.revisado_por into v_rev
          from comp_revision_fotos r join comp_evidencias e on e.id = r.evidencia_id
         where r.toma_id = v_x.id and e.origen = 'campo' and r.estado in ('correcta', 'editada')
         order by r.revisado_en desc, r.evidencia_id desc limit 1;
        if v_rev is not null and not comp_puede_revisar(v_x.id, v_rev) then
          v_rev := null;
        end if;
      end if;
      if v_rev is not null and comp_comprobar_si_revisada(v_x.id, v_rev) then
        v_comp := v_comp || v_x.id;
      end if;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'ya', v_ya, 'evidencia_id', v_e.id, 'fecha', v_e.fecha,
                            'ligadas', to_jsonb(v_lig), 'cerradas', to_jsonb(v_cerr), 'futuras', to_jsonb(v_fut),
                            'ajenas', to_jsonb(v_aje), 'no_camara', to_jsonb(v_nocam), 'fuera_periodo', to_jsonb(v_fuera),
                            'duplicadas', to_jsonb(v_dup), 'comprobadas', to_jsonb(v_comp));
  exception when lock_not_available or deadlock_detected then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;
end $$;

-- Quita una captura de cámara de una toma (p_toma_id) o la borra entera (sin
-- p_toma_id). Quien puede capturar en todas sus tomas (comp_puede_capturar).
-- Nunca de una toma comprobada (primero «Reabrir»): codigo 'comprobada'. Su
-- revisión automática se va con la liga. Sin ligas, la foto se borra y se
-- devuelve el path (la app borra el objeto; ev_obj_del_comp ya lo deja si es
-- de quien borra o del manager).
create or replace function public.comp_quitar_captura(p_cliente_id uuid, p_toma_id bigint default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_e record; v_quedan int; v_tomas bigint[];
begin
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.' using errcode = 'CP001';
  end if;
  if p_cliente_id is null then
    raise exception 'Falta el cliente_id.' using errcode = 'CP002';
  end if;
  select e.id, e.path, e.origen into v_e from comp_evidencias e where e.cliente_id = p_cliente_id;
  if v_e.id is null then
    return jsonb_build_object('ok', true, 'ya', true);
  end if;
  if v_e.origen <> 'camara' then
    raise exception 'Esa foto no es una captura de cámara.' using errcode = 'CP002';
  end if;
  if not comp_captura_abierta(v_email) then
    return jsonb_build_object('ok', false, 'codigo', 'captura_cerrada');
  end if;

  begin
    perform 1 from comp_tomas t
     where t.id in (select et.toma_id from comp_evidencia_tomas et where et.evidencia_id = v_e.id)
     order by t.id for update;
    select e.id, e.path into v_e from comp_evidencias e where e.id = v_e.id for update;
    if v_e.id is null then
      return jsonb_build_object('ok', true, 'ya', true);
    end if;
    perform 1 from comp_tomas t
     where t.id in (select et.toma_id from comp_evidencia_tomas et where et.evidencia_id = v_e.id)
     order by t.id for update;

  v_tomas := array(select et.toma_id from comp_evidencia_tomas et
                    where et.evidencia_id = v_e.id and (p_toma_id is null or et.toma_id = p_toma_id)
                    order by et.toma_id);
  if cardinality(v_tomas) = 0 then
    select count(*)::int into v_quedan from comp_evidencia_tomas et where et.evidencia_id = v_e.id;
    return jsonb_build_object('ok', true, 'ya', true, 'quedan', v_quedan);
  end if;
  if exists (select 1 from unnest(v_tomas) x where not comp_puede_capturar(x, v_email)) then
    return jsonb_build_object('ok', false, 'codigo', 'sin_permiso');
  end if;
  if exists (select 1 from comp_tomas t where t.id = any (v_tomas) and t.estado = 'comprobada') then
    return jsonb_build_object('ok', false, 'codigo', 'comprobada');
  end if;

  delete from comp_evidencia_tomas et where et.evidencia_id = v_e.id and et.toma_id = any (v_tomas);
  select count(*)::int into v_quedan from comp_evidencia_tomas et where et.evidencia_id = v_e.id;
  if v_quedan = 0 then
    delete from comp_evidencias e where e.id = v_e.id;
    return jsonb_build_object('ok', true, 'desligada', true, 'quedan', 0, 'borrada', true, 'path', v_e.path);
  end if;
  return jsonb_build_object('ok', true, 'desligada', true, 'quedan', v_quedan);
  exception when lock_not_available or deadlock_detected then
    return jsonb_build_object('ok', false, 'codigo', 'ocupada');
  end;
end $$;

revoke all on function public.comp_revisar_fotos(bigint, bigint[], text, text, boolean),
  public.comp_rechazar_fotos(bigint, bigint[], text), public.comp_regresar_toma(bigint, text),
  public.comp_reabrir_toma(bigint, text), public.comp_comprobar_toma(bigint),
  public.comp_poner_modo(bigint[], text, text[]),
  public.comp_subir_captura(uuid, text, bigint[], text, text, date), public.comp_quitar_captura(uuid, bigint)
  from public, anon;
grant execute on function public.comp_revisar_fotos(bigint, bigint[], text, text, boolean),
  public.comp_rechazar_fotos(bigint, bigint[], text), public.comp_regresar_toma(bigint, text),
  public.comp_reabrir_toma(bigint, text), public.comp_comprobar_toma(bigint),
  public.comp_poner_modo(bigint[], text, text[]),
  public.comp_subir_captura(uuid, text, bigint[], text, text, date), public.comp_quitar_captura(uuid, bigint)
  to authenticated, service_role;
