-- ============================================================
-- 17-nov-2026 · Incidencias · Reportes de la app Biobox
-- Qué: cada reporte de la app que se liga a una incidencia que ya existía
--      queda en el historial de esa incidencia (evento reporte_app_ligado,
--      detalle = folio de la app, p. ej. BBOTR-00437).
-- Por qué: Erik (17-nov-2026) quiere buscar en Incidencias por el folio del
--      reporte de la app. Las incidencias que nacieron de un reporte ya
--      traen su folio en observaciones; las ligadas no lo tenían en ningún
--      lado que vieran todos: solo en biobox_app_reportes, que lee solo la
--      bandeja. El historial se lee con los mismos permisos que la
--      incidencia (inc_hist_sel) y la tarjeta ya lo trae.
-- Cómo:
--   · Trigger en biobox_app_reportes: cuando un reporte pasa a 'ligado'
--     (a mano con ligar_reporte_biobox_app o por las reglas automáticas de
--     duplicados) se anota con la hora y quién lo decidió (la regla
--     automática queda sin nombre). ref = 'app:' + report_id + ':' +
--     record_id evita duplicar. Si fallara, avisa en el log y NO frena la
--     liga. Revisada por revisor-rls (17-nov-2026), sugerencias incluidas.
--   · Relleno de los 32 ya ligados (reconstruido = true).
--   · Solo se anota el folio de la app: nada de lo que escribió el usuario.
-- Re-ejecutable: or replace / drop if exists; el relleno no duplica.
-- ============================================================

create or replace function public.reporte_app_registrar_historial()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  -- El WHEN del trigger ya dejó pasar solo los ligados; aquí se descarta
  -- la carga que vuelve a escribir lo mismo.
  if tg_op = 'UPDATE'
     and old.decision is not distinct from new.decision
     and old.record_id is not distinct from new.record_id then
    return null;
  end if;

  begin
    insert into incidencias_historial (record_id, evento, por_email, en, detalle, ref)
    values (
      new.record_id,
      'reporte_app_ligado',
      -- Solo quien decidió: la regla automática no llena decidido_por y no
      -- debe quedar a nombre de quien tuviera la sesión.
      lower(nullif(trim(new.decidido_por), '')),
      coalesce(new.decidido_en, now()),
      coalesce(new.folio_app, new.report_id::text),
      -- Con la incidencia en la referencia: si se volviera a ligar a otra,
      -- la nueva también lo anota.
      'app:' || new.report_id || ':' || new.record_id
    )
    on conflict (ref, evento) where ref is not null do nothing;
  exception when others then
    raise warning 'reporte_app_registrar_historial (%): %', new.report_id, sqlerrm;
  end;
  return null;
end
$$;

revoke execute on function public.reporte_app_registrar_historial() from public, anon, authenticated;

drop trigger if exists trg_reporte_app_historial on public.biobox_app_reportes;
create trigger trg_reporte_app_historial
  after insert or update of decision, record_id on public.biobox_app_reportes
  for each row
  -- La sincronización reescribe decision en todas las filas: así el
  -- trigger solo corre para los ligados.
  when (new.decision = 'ligado' and new.record_id is not null)
  execute function public.reporte_app_registrar_historial();

-- Relleno: los que ya estaban ligados.
insert into incidencias_historial (record_id, evento, por_email, en, detalle, reconstruido, ref)
select r.record_id, 'reporte_app_ligado', lower(nullif(trim(r.decidido_por), '')),
       r.decidido_en, coalesce(r.folio_app, r.report_id::text), true,
       'app:' || r.report_id || ':' || r.record_id
from biobox_app_reportes r
join incidencias i on i.record_id = r.record_id
where r.decision = 'ligado' and r.decidido_en is not null
on conflict (ref, evento) where ref is not null do nothing;
