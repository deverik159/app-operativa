-- ============================================================
-- comp_fuente_reservadas — Vía Verde: avisar las columnas «reservada» del
-- plano que no entran a Comprobaciones (Erik, 23-oct-2026).
--
-- POR QUÉ. comp_fuente_pauta_vv (comp_base, 20261023193250) solo entrega las
-- líneas del plano vendidas y pautadas: las «reservada» son prospectos de
-- comercial (revisor-rls, 23-oct-2026). Erik lo confirmó: «se quedan
-- fuera». Pero en el Formato general de agosto de hoy algunas de esas
-- columnas sí se comprobaron (TOPO CHICO: 12 columnas en el Excel, 4 en la
-- app), así que la previa debe AVISAR para que Victor las agregue a mano si
-- hace falta (revisión 2, punta-a-punta-2).
--
-- QUÉ CAMBIA. La misma función, con la misma firma, el mismo candado
-- (comp_gestiona('Vía Verde')) y la misma lista de líneas, devuelve además:
--   · reservadas: por campaña, las columnas «reservada» de las campañas que
--     SÍ tienen líneas vendidas o pautadas en el mismo plano y rango (las
--     que Victor ya está armando): [{campana, n, espacios}].
--   · reservadas_otras: cuántas líneas «reservada» son de campañas sin nada
--     vendido ni pautado en el rango. Solo el número: no se nombran
--     prospectos que el Supervisor no debe ver.
-- Ni una línea reservada entra a la carga; no cambia nada más. Solo lectura.
-- Re-ejecutable.
-- ============================================================

create or replace function public.comp_fuente_pauta_vv(p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_mes text; v_plano text; v_cam jsonb; v_pau jsonb; v_ocu jsonb; v_esp jsonb; v_res jsonb;
  v_nc int; v_np int; v_no int; v_ne int; v_res_otras int;
begin
  if not comp_gestiona('Vía Verde') then
    raise exception 'Solo el Supervisor de Vía Verde (o el Admin) lee Pauta VV y el plano para armar la carga.';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde then
    raise exception 'Rango no válido: elige el inicio y el fin del periodo.';
  end if;
  if p_hasta - p_desde + 1 > 93 then
    raise exception 'Rango demasiado largo (% días): pide un mes o una catorcena.', p_hasta - p_desde + 1;
  end if;
  v_mes := to_char(p_desde, 'YYYY-MM');
  select coalesce(max(o.plano_mes) filter (where o.plano_mes <= v_mes), min(o.plano_mes))
    into v_plano
    from vv_ocupacion o where o.origen = 'plano' and o.plano_mes is not null;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'campana_id', p.campana_id, 'espacio_clave', p.espacio_clave, 'tipo_venta', p.tipo_venta,
           'version', p.version, 'inicio', p.inicio, 'fin', p.fin, 'horario_lv', p.horario_lv,
           'horario_sd', p.horario_sd, 'testigos', p.testigos, 'observaciones', p.observaciones,
           'estatus', p.estatus) order by p.id), '[]'), count(*)::int
    into v_pau, v_np
    from vv_pautas p
   where p.inicio <= p_hasta and p.fin >= p_desde;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'cliente', c.cliente, 'nombre', c.nombre, 'vendedor', c.vendedor,
           'administrador', c.administrador, 'quantum', c.quantum, 'fecha_inicio', c.fecha_inicio,
           'fecha_fin', c.fecha_fin, 'mediamonitor', c.mediamonitor, 'espec_tomas', c.espec_tomas,
           'estatus', c.estatus) order by c.id), '[]'), count(*)::int
    into v_cam, v_nc
    from vv_campanas c
   where exists (select 1 from vv_pautas p
                  where p.campana_id = c.id and p.inicio <= p_hasta and p.fin >= p_desde);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'espacio_clave', o.espacio_clave, 'slot', o.slot, 'campana', o.campana,
           'negociacion', o.negociacion, 'convencional', o.convencional, 'inicio', o.inicio, 'fin', o.fin,
           'dias', o.dias, 'horas', o.horas, 'estatus', o.estatus, 'origen', o.origen,
           'plano_mes', o.plano_mes) order by o.id), '[]'), count(*)::int
    into v_ocu, v_no
    from vv_ocupacion o
   where o.inicio <= p_hasta and o.fin >= p_desde
     and (o.origen = 'app' or o.plano_mes = v_plano)
     and o.estatus in ('vendida', 'pautada');

  -- Reservadas (23-oct-2026): mismas líneas candidatas (rango y plano), solo
  -- para avisar. Se nombran únicamente las de campañas que también tienen
  -- algo vendido o pautado en esas líneas; las demás, solo el número.
  with cand as (
    select o.campana, o.espacio_clave, o.estatus, comp_llave(o.campana) as cl
      from vv_ocupacion o
     where o.inicio <= p_hasta and o.fin >= p_desde
       and (o.origen = 'app' or o.plano_mes = v_plano)
       and o.estatus in ('vendida', 'pautada', 'reservada')
  ), vivas as (
    select distinct cl from cand where estatus in ('vendida', 'pautada') and cl <> ''
  ), res as (
    select c.*, (c.cl in (select cl from vivas)) as de_viva from cand c where c.estatus = 'reservada'
  )
  select coalesce((select jsonb_agg(jsonb_build_object('campana', x.campana, 'n', x.n, 'espacios', x.espacios)
                                    order by x.campana)
                     from (select min(r.campana) as campana, count(*)::int as n,
                                  jsonb_agg(distinct r.espacio_clave) as espacios
                             from res r where r.de_viva group by r.cl) x), '[]'),
         (select count(*)::int from res r where not r.de_viva)
    into v_res, v_res_otras;

  select coalesce(jsonb_agg(jsonb_build_object('clave', e.clave, 'tipo_espacio', e.tipo_espacio,
                                               'tramo', e.tramo, 'activo', e.activo) order by e.clave), '[]'),
         count(*)::int
    into v_esp, v_ne
    from vv_espacios e;

  return jsonb_build_object('desde', p_desde, 'hasta', p_hasta, 'plano_mes', v_plano,
                            'campanas', v_cam, 'pautas', v_pau, 'ocupacion', v_ocu, 'espacios', v_esp,
                            'reservadas', v_res, 'reservadas_otras', coalesce(v_res_otras, 0),
                            'totales', jsonb_build_object('campanas', v_nc, 'pautas', v_np,
                                                          'ocupacion', v_no, 'espacios', v_ne));
end $$;
