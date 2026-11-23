-- 23-nov-2026 · Plataforma (rendimiento)
-- Qué hace: quita las tres políticas de lectura de qtm_pautas que ya no deciden nada
-- (qtm_pauta_sel_fijador, qtm_pauta_sel_mgr y qtm_pauta_sel_reparacion) y envuelve en
-- (select …) la que queda, qtm_pautas_sel.
-- Por qué: qtm_pautas_sel (TO authenticated) ya deja leer toda la tabla a cualquiera con
-- sesión y correo. Las otras tres se suman con OR, así que no agregan ninguna fila,
-- pero llaman tiene_rol() (security definer con SET, no se inlinea) por cada renglón, y
-- dos de ellas además hacen un EXISTS en inventario por renglón. Cada página de 1000 de
-- la copia sin señal tardaba 160–211 ms en la base contra 8 ms sin RLS, y son 7 páginas
-- por descarga (auditoría de rendimiento del 23-nov-2026).
-- No cambia quién ve qué:
--   · authenticated con correo: ya lo veía todo por qtm_pautas_sel, y lo sigue viendo.
--   · authenticated sin correo en el JWT: qtm_pautas_sel daba falso y tiene_rol() también
--     (busca por el correo), así que no veía nada antes ni después.
--   · anon: no tiene SELECT sobre qtm_pautas ni EXECUTE sobre tiene_rol(); se le niega
--     la tabla antes de llegar a las políticas, antes y después.
-- No toca escritura: qtm_pautas no tiene políticas de INSERT/UPDATE/DELETE (la carga la
-- hace service_role, que no pasa por RLS).
-- Se puede volver a correr.

set local lock_timeout = '3s';

drop policy if exists qtm_pauta_sel_fijador on public.qtm_pautas;
drop policy if exists qtm_pauta_sel_mgr on public.qtm_pautas;
drop policy if exists qtm_pauta_sel_reparacion on public.qtm_pautas;

alter policy qtm_pautas_sel on public.qtm_pautas
  using ((select nullif(lower(coalesce(auth_email(), ''::text)), ''::text)) is not null);
