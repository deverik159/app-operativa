-- ============================================================
-- 17-nov-2026 · Incidencias · Chat
-- Qué: un adjunto del chat solo se puede ligar al folio de su propio
--      mensaje.
-- Por qué: lo encontró revisor-rls (17-nov-2026) y Erik pidió arreglarlo.
--      chat_adj_ins exigía que el mensaje fuera tuyo y que el folio del
--      adjunto estuviera abierto, pero no que fueran el MISMO folio: con una
--      llamada directa a la base (la app no lo hace), alguien con un mensaje
--      propio en un folio podía colgar un adjunto en otro folio abierto
--      donde no puede escribir.
-- Cómo: la misma política, con m.record_id = chat_adjuntos.record_id dentro
--      del EXISTS de mensajes. Lo demás queda igual. Verificado antes: los
--      162 adjuntos existentes coinciden con el folio de su mensaje, y la
--      app (ChatModal) siempre manda el record_id de la incidencia del
--      mensaje.
-- Re-ejecutable: drop if exists.
-- ============================================================

drop policy if exists chat_adj_ins on public.chat_adjuntos;
create policy chat_adj_ins on public.chat_adjuntos
  for insert
  to authenticated
  with check (
    lower(subido_por) = lower(auth_email())
    and exists (
      select 1 from public.mensajes m
      where m.id = chat_adjuntos.mensaje_id
        and m.record_id = chat_adjuntos.record_id
        and lower(m.autor_email) = lower(auth_email())
    )
    and exists (
      select 1 from public.incidencias i
      where i.record_id = chat_adjuntos.record_id
        and i.estatus <> 'cerrada'
    )
  );
