-- vw_pauta_riesgo_retiro respeta la RLS de quien la consulta (20-oct-2026).
--
-- Era de postgres y sin security_invoker: cualquiera con sesión leía por ella
-- inventario, pautas y catorcenas sin pasar por la RLS de esas tablas, y
-- authenticated tenía además insert/update/delete/truncate sobre la vista.
-- La app no la usa hoy. Queda como vw_pautas_por_fijar: security_invoker y
-- solo lectura para authenticated (select y maintain, igual que vw_pauta_ruta
-- y vw_pauta_resumen).

alter view public.vw_pauta_riesgo_retiro set (security_invoker = on);

revoke insert, update, delete, truncate, references, trigger
  on public.vw_pauta_riesgo_retiro from authenticated;

-- Verificar: reloptions = {security_invoker=on} y authenticated=rm.
-- select reloptions, relacl from pg_class where oid = 'public.vw_pauta_riesgo_retiro'::regclass;
