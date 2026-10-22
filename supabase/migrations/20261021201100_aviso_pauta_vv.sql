-- El aviso de versión por programar remite a «Pauta VV» (21-oct-2026).
--
-- El módulo se llama Pauta VV desde el 19-oct-2026 (antes Bitácora VV), pero
-- el aviso a Pautas seguía diciendo «Revísala en Bitácora VV.». Erik pidió
-- corregirlo. Solo cambia ese texto; lo demás es la función tal como está en
-- producción (bitacora_vv_notificaciones.sql). Los avisos ya enviados no se
-- tocan.

create or replace function public.vv_notificar_por_programar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := lower(coalesce(auth_email(), ''));
  g record;
begin
  for g in
    select n.campana_id, n.version,
           min(n.inicio) as desde, max(n.fin) as hasta, count(*) as espacios,
           c.nombre as campana
    from nuevas n
    join vv_campanas c on c.id = n.campana_id
    where n.estatus = 'por_programar'
    group by n.campana_id, n.version, c.nombre
  loop
    insert into notificaciones (record_id, para_email, evento, mensaje, unidad_negocio)
    select null, u.email, 'vv_version',
           g.campana || ': versión "' || g.version || '" por programar — ' ||
             g.espacios || ' espacio' || case when g.espacios = 1 then '' else 's' end ||
             ', del ' || to_char(g.desde, 'DD/MM') || ' al ' || to_char(g.hasta, 'DD/MM') ||
             '. Revísala en Pauta VV.',
           'Vía Verde'
    from (
      select distinct lower(usuario_email) as email
      from usuario_roles
      where rol = 'pautas'
    ) u
    where u.email <> v_actor
      -- Anti-ruido: la captura periodo-por-periodo de la misma campaña no
      -- re-avisa a quien ya tiene el aviso fresco en la campana.
      and not exists (
        select 1 from notificaciones nn
        where nn.para_email = u.email
          and nn.evento = 'vv_version'
          and nn.mensaje like g.campana || ':%'
          and nn.creado_en > now() - interval '15 minutes'
      );
  end loop;
  return null;
end;
$$;

-- Verificar: debe dar true.
-- select position('Revísala en Pauta VV.' in pg_get_functiondef('public.vv_notificar_por_programar'::regproc)) > 0;
