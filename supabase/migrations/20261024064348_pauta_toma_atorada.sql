-- ============================================================
-- pauta_toma_atorada — al borrar una foto, si la toma quedó con todas sus
-- fotos revisadas como buenas, se le avisa al analista para que la
-- compruebe (pendiente técnico de Pauta, revisor-rls 20 y 22-oct-2026;
-- decisión de Erik, 24-oct-2026: solo avisar, sin comprobar).
--
-- POR QUÉ. El borrado de una foto no pasa por ninguna RPC: la app hace
-- DELETE directo en pauta_evidencias (RegistrarTomaModal y la cola de
-- tomas, limpiarQuitado) y solo lo filtra la política pev_del. Nadie vuelve
-- a mirar la toma, así que si el monitorista borra la ÚNICA foto que
-- faltaba revisar de una toma entregada, la toma se queda «tomada» con
-- todas sus fotos vigentes buenas y sin fecha_comprobacion, y nadie se
-- entera. Se destrababa solo con el botón «Comprobar toma» del analista.
--
-- POR QUÉ NO COMPRUEBA SOLA. revisor-rls (24-oct-2026): quien puede borrar
-- fotos (el monitorista que las subió, el coordinador o el manager) cerraría
-- la toma sin el analista: con A marcada buena y B y C sin revisar, borrar
-- B y C dejaría la toma comprobada con una sola foto. Erik eligió que el
-- analista conserve la decisión: el trigger solo le avisa.
--
-- QUÉ CAMBIA. Un trigger AFTER DELETE que, si la foto borrada contaba (no
-- era video ni estaba regresada) y la toma sigue entregada, sin comprobar,
-- con al menos una foto vigente que no sea video y ninguna sin revisar como
-- buena (el mismo criterio de pauta_comprobar_si_revisada), inserta UN
-- aviso pauta_revision al último analista que revisó una foto vigente de
-- esa toma: «ya tiene todas sus fotos revisadas: compruébala». Si ese
-- analista ya tiene ese mismo aviso sin leer, no se repite. El aviso lleva
-- la catorcena como «Cat-N de AAAA», a propósito distinto del «Cat-N · AAAA»
-- de registrar_toma, para que el agrupamiento por hora de ese aviso no lo
-- pise (20261024064415). Al tocarlo, la app abre Comprobaciones › Tomas de
-- Pauta, como cualquier pauta_revision; el push lo manda trg_notificar_push.
--
-- PERMISOS. La función del trigger es security definer: el DELETE lo hace
-- el monitorista y notificaciones no tiene política de insert para él. Nadie
-- la llama directo (revoke). Solo lee pauta_* y escribe un aviso; no toca
-- pauta_monitoreo. Re-ejecutable.
-- ============================================================

create or replace function public.pauta_evid_tras_borrar()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_revisor text;
  v_sitio record;
  v_msg text;
begin
  -- Solo cuenta una foto vigente que no sea video: las regresadas y los
  -- videos no entran en la comprobación.
  if old.regresada_en is not null or coalesce(old.tipo, 'foto') = 'video' then
    return old;
  end if;
  -- Toma entregada y sin comprobar.
  if not exists (
       select 1 from pauta_monitoreo m
        where m.anio = old.anio and m.catorcena = old.catorcena and m.vendor_face_id = old.vendor_face_id
          and m.fecha_toma is not null and m.fecha_comprobacion is null) then
    return old;
  end if;
  -- Al menos una foto vigente (no video) y ninguna sin revisar como buena.
  if not exists (
       select 1 from pauta_evidencias e
        where e.anio = old.anio and e.catorcena = old.catorcena and e.vendor_face_id = old.vendor_face_id
          and e.regresada_en is null and coalesce(e.tipo, 'foto') <> 'video')
     or exists (
       select 1 from pauta_evidencias e
        left join pauta_revision_fotos r on r.evidencia_id = e.id
        where e.anio = old.anio and e.catorcena = old.catorcena and e.vendor_face_id = old.vendor_face_id
          and e.regresada_en is null and coalesce(e.tipo, 'foto') <> 'video'
          and coalesce(r.estado, '') not in ('correcta', 'editada')) then
    return old;
  end if;
  -- El último analista que revisó una foto vigente de esta toma.
  select r.revisado_por into v_revisor
    from pauta_revision_fotos r
    join pauta_evidencias e on e.id = r.evidencia_id
   where e.anio = old.anio and e.catorcena = old.catorcena and e.vendor_face_id = old.vendor_face_id
     and e.regresada_en is null and r.estado in ('correcta', 'editada')
   order by r.revisado_en desc
   limit 1;
  if v_revisor is null then
    return old;
  end if;

  select site_id, cara into v_sitio
    from pautas
   where anio = old.anio and catorcena = old.catorcena and vendor_face_id = old.vendor_face_id
   limit 1;
  v_msg := 'La toma de ' || coalesce(v_sitio.site_id, old.vendor_face_id) ||
           coalesce(' cara ' || v_sitio.cara, '') ||
           ' (Cat-' || old.catorcena || ' de ' || old.anio ||
           ') ya tiene todas sus fotos revisadas: compruébala en Comprobaciones, pestaña Tomas de Pauta.';
  -- Sin repetir: si ya tiene este mismo aviso sin leer, no se inserta otro.
  if exists (
       select 1 from notificaciones n
        where lower(n.para_email) = lower(v_revisor) and n.evento = 'pauta_revision'
          and not n.leida and n.mensaje = v_msg) then
    return old;
  end if;
  insert into notificaciones(record_id, para_email, evento, mensaje, unidad_negocio)
  values (null, lower(v_revisor), 'pauta_revision', v_msg, 'Ecovallas');
  return old;
end;
$function$;

revoke all on function public.pauta_evid_tras_borrar() from public, anon, authenticated;

drop trigger if exists trg_pauta_evid_tras_borrar on public.pauta_evidencias;
create trigger trg_pauta_evid_tras_borrar after delete on public.pauta_evidencias
  for each row execute function public.pauta_evid_tras_borrar();
