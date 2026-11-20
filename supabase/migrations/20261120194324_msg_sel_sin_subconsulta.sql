-- 20-nov-2026 · Plataforma (corrige 20261120175825_rls_incidencias_rapida)
-- Qué hace: regresa la política msg_sel de mensajes a como estaba antes de esa
-- migración: auth_email() is not null, sin (select …).
-- Por qué: editar un mensaje del chat falló con «infinite recursion detected in
-- policy for relation "mensajes"» (Dulce, 20-nov-2026 12:45 CDMX). El camino es
-- UPDATE mensajes → msg_upd_autor (EXISTS en incidencias) → inc_sel_participante_chat
-- (EXISTS en mensajes) → msg_sel. Postgres solo revisa la recursión cuando la
-- política tiene una subconsulta; msg_sel no tenía, y el (select auth_email()) que
-- se le puso sí cuenta como subconsulta. Sin ella el ciclo vuelve a pasar como antes.
-- Regla: ninguna política SELECT de mensajes (msg_sel ni una nueva) lleva subconsulta,
-- ni siquiera (select …), mientras msg_upd_autor lea incidencias e
-- inc_sel_participante_chat lea mensajes. El costo por renglón es mínimo.
-- No cambia quién ve qué. ALTER POLICY conserva roles y comando; se puede volver a correr.

set local lock_timeout = '3s';

alter policy msg_sel on public.mensajes
  using (auth_email() is not null);
