-- ============================================================
-- pauta_aviso_campana_cerrada — avisos cuando una campaña de Pauta queda
-- comprobada (Erik, 22-oct-2026).
--
-- DECISIONES DE ERIK (22-oct-2026)
--   · Cuando todas las caras CON RUTA de una campaña (en su catorcena)
--     quedan comprobadas, la campaña se cierra y se avisa:
--       – a los "Coordinadores de Monitoreo": una LISTA FIJA, hoy Victor
--         Fuentes (analista de Ecovallas) y Marco Anaya (coordinador de
--         Ecovallas y Vía Verde). No es un rol: no cambia lo que ven ni sus
--         permisos.
--       – a cada monitorista con tomas comprobadas en esa campaña: UN aviso
--         por campaña completa, no uno por toma (serían ~1,400 por catorcena).
--   · Las foráneas (sin ruta: PLAZA/EDOMEX) no detienen el cierre. Una
--     campaña que solo tiene foráneas se cierra cuando se comprueban todas.
--   · Se avisa UNA vez por campaña y catorcena: si se reabre (un rechazo) y
--     se vuelve a cerrar, no se repite.
--
-- QUÉ CAMBIA
--   1) pauta_campanas_cerradas (anio, catorcena, campana): registro de los
--      cierres; su llave es el candado de "una sola vez".
--   2) avisos_destinatarios (evento, usuario_email): quién recibe un aviso
--      fijo. Se llena aquí por NOMBRE (el repo es público: sin correos).
--      Agregar o quitar a alguien, por SQL mientras no haya pantalla.
--   3) Trigger AFTER INSERT/UPDATE OF fecha_comprobacion en pauta_monitoreo.
--      Cubre los tres caminos que comprueban (revisar_foto_pauta, el
--      comprobado en el acto de registrar_toma y registrar_comprobacion)
--      sin reemplazar ninguna RPC. Un rechazo pone fecha_comprobacion en
--      null y no dispara nada.
--   Eventos nuevos (títulos en enviar-push; pestaña Operación en la campana):
--     pauta_campana_cerrada   → Coordinadores de Monitoreo
--     pauta_tomas_comprobadas → monitorista
--
-- SEGURIDAD
--   · Las dos tablas con RLS y sin permisos para anon ni authenticated:
--     solo las usa el trigger (security definer, search_path fijo).
--   · El trigger nunca truena: si algo falla, deja un WARNING en el log y la
--     comprobación del analista sigue (no se deshace su revisión).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Cierres de campaña (una sola vez por campaña y catorcena).
-- ------------------------------------------------------------
create table if not exists public.pauta_campanas_cerradas (
  anio        integer     not null,
  catorcena   integer     not null,
  campana     text        not null,
  caras       integer     not null,
  cerrada_por text,
  cerrada_en  timestamptz not null default now(),
  primary key (anio, catorcena, campana)
);
alter table public.pauta_campanas_cerradas enable row level security;
revoke all on public.pauta_campanas_cerradas from anon, authenticated;

-- ------------------------------------------------------------
-- 2) Destinatarios fijos de un aviso.
-- ------------------------------------------------------------
create table if not exists public.avisos_destinatarios (
  evento        text not null,
  usuario_email text not null check (usuario_email = lower(usuario_email)),
  primary key (evento, usuario_email)
);
alter table public.avisos_destinatarios enable row level security;
revoke all on public.avisos_destinatarios from anon, authenticated;

-- Coordinadores de Monitoreo, por nombre y rol (mismo patrón que
-- 20261022143254_rutas_por_coordinador.sql): si no hay exactamente uno, no
-- se adivina.
do $$
declare
  v_n integer;
  v_victor text;
  v_marco text;
begin
  select count(distinct lower(ur.usuario_email)), min(lower(ur.usuario_email))
    into v_n, v_victor
    from usuario_roles ur
    join usuarios u on lower(u.email) = lower(ur.usuario_email)
   where ur.rol = 'analista'::app_role
     and ur.unidad_negocio = 'Ecovallas'
     and u.nombre = 'Victor Fuentes';
  if v_n <> 1 then
    raise exception 'No encontré a UN solo analista de Ecovallas llamado Victor Fuentes (hay %).', v_n;
  end if;

  select count(distinct lower(ur.usuario_email)), min(lower(ur.usuario_email))
    into v_n, v_marco
    from usuario_roles ur
    join usuarios u on lower(u.email) = lower(ur.usuario_email)
   where ur.rol = 'coordinador'::app_role
     and ur.unidad_negocio = 'Ecovallas'
     and u.nombre = 'Marco Anaya';
  if v_n <> 1 then
    raise exception 'No encontré a UN solo coordinador de Ecovallas llamado Marco Anaya (hay %).', v_n;
  end if;

  insert into public.avisos_destinatarios (evento, usuario_email)
  values ('pauta_campana_cerrada', v_victor),
         ('pauta_campana_cerrada', v_marco)
  on conflict do nothing;
end $$;

-- ------------------------------------------------------------
-- 3) El aviso, al comprobarse una cara.
-- ------------------------------------------------------------
create or replace function public.pauta_avisar_campana_cerrada()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  c                record;
  v_con_ruta       integer;
  v_pendientes     integer;
  v_foraneas_pend  integer;
  v_todas          integer;
  v_caras          integer;
  v_txt            text;
begin
  -- Solo cuando la cara PASA a comprobada (no al re-comprobar ni al regresar).
  if new.fecha_comprobacion is null
     or (tg_op = 'UPDATE' and old.fecha_comprobacion is not null) then
    return new;
  end if;

  -- Una cara puede estar en dos campañas de la misma catorcena. En orden
  -- fijo: dos comprobaciones que comparten campañas toman los candados en el
  -- mismo orden y no se bloquean entre sí (revisor-rls, 22-oct-2026).
  for c in
    select distinct trim(p.campana) as campana
      from pautas p
     where p.anio = new.anio
       and p.catorcena = new.catorcena
       and p.vendor_face_id = new.vendor_face_id
       and coalesce(trim(p.campana), '') <> ''
     order by 1
  loop
    -- Un bloque por campaña: si una falla, no se lleva el cierre y los
    -- avisos de otra que sí estaban bien (revisor-rls, 22-oct-2026).
    begin
      -- Dos analistas comprobando las dos últimas caras a la vez: con el
      -- candado (dura hasta el commit) el segundo ya ve la del primero y el
      -- aviso no se pierde.
      perform pg_advisory_xact_lock(
        hashtext('pauta_campana_cerrada'),
        hashtext(new.anio || '-' || new.catorcena || '-' || c.campana));

      select count(distinct p.vendor_face_id) filter (where p.ruta_numero is not null),
             count(distinct p.vendor_face_id) filter (where p.ruta_numero is not null
                                                        and m.fecha_comprobacion is null),
             count(distinct p.vendor_face_id) filter (where p.ruta_numero is null
                                                        and m.fecha_comprobacion is null),
             count(distinct p.vendor_face_id)
        into v_con_ruta, v_pendientes, v_foraneas_pend, v_todas
        from pautas p
        left join pauta_monitoreo m
          on m.anio = p.anio and m.catorcena = p.catorcena and m.vendor_face_id = p.vendor_face_id
       where p.anio = new.anio
         and p.catorcena = new.catorcena
         and trim(p.campana) = c.campana;

      -- Solo foráneas: se cierra cuando se comprueban todas.
      if v_con_ruta = 0 then
        v_pendientes := v_foraneas_pend;
      end if;
      continue when v_pendientes > 0;

      v_caras := case when v_con_ruta > 0 then v_con_ruta else v_todas end;
      insert into pauta_campanas_cerradas (anio, catorcena, campana, caras, cerrada_por)
      values (new.anio, new.catorcena, c.campana, v_caras, lower(new.comprobacion_por))
      on conflict do nothing;
      -- Ya se había cerrado (y avisado) antes: no se repite.
      continue when not found;

      v_txt := c.campana || ' (Cat-' || new.catorcena || ' · ' || new.anio || ')';

      -- Coordinadores de Monitoreo (lista fija). No se excluye a quien
      -- comprobó la última cara: Victor es analista y muchas veces será él.
      insert into notificaciones (record_id, para_email, evento, mensaje, unidad_negocio)
      select null, d.usuario_email, 'pauta_campana_cerrada',
             'Campaña cerrada: ' || v_txt || ', '
               || v_caras || case when v_caras = 1 then ' cara comprobada' else ' caras comprobadas' end
               || case when v_con_ruta > 0 and v_foraneas_pend > 0
                       then ' (' || v_foraneas_pend
                            || case when v_foraneas_pend = 1 then ' foránea sin comprobar)' else ' foráneas sin comprobar)' end
                       else '' end
               || '.',
             'Ecovallas'
        from avisos_destinatarios d
       where d.evento = 'pauta_campana_cerrada';

      -- Monitoristas con tomas COMPROBADAS en la campaña (uno por persona).
      insert into notificaciones (record_id, para_email, evento, mensaje, unidad_negocio)
      select null, t.email, 'pauta_tomas_comprobadas',
             'Tus tomas de ' || v_txt || ' quedaron comprobadas: la campaña está completa.',
             'Ecovallas'
        from (select distinct lower(m.toma_por) as email
                from pautas p
                join pauta_monitoreo m
                  on m.anio = p.anio and m.catorcena = p.catorcena and m.vendor_face_id = p.vendor_face_id
               where p.anio = new.anio
                 and p.catorcena = new.catorcena
                 and trim(p.campana) = c.campana
                 and m.fecha_comprobacion is not null
                 and coalesce(m.toma_por, '') <> '') t
       where t.email not in (select d.usuario_email from avisos_destinatarios d
                              where d.evento = 'pauta_campana_cerrada');
    exception when others then
      -- El aviso nunca deshace la comprobación del analista.
      raise warning 'pauta_avisar_campana_cerrada (%-%, %, %): %',
        new.anio, new.catorcena, new.vendor_face_id, c.campana, sqlerrm;
    end;
  end loop;
  return new;
end;
$function$;

revoke all on function public.pauta_avisar_campana_cerrada() from public, anon, authenticated;

drop trigger if exists trg_pauta_avisar_campana_cerrada on public.pauta_monitoreo;
create trigger trg_pauta_avisar_campana_cerrada
  after insert or update of fecha_comprobacion on public.pauta_monitoreo
  for each row
  execute function public.pauta_avisar_campana_cerrada();
