-- ============================================================
-- 23-nov-2026 · Incidencias · Estatus nuevo «duplicada» (1 de 2)
-- Qué: agrega el valor 'duplicada' al enum estatus_incidencia.
-- Por qué: Erik (23-nov-2026) eligió «Descartar como duplicada»: la
--      incidencia que repite a otra en proceso (misma cara, misma falla)
--      queda «Duplicada de <folio>», no cuenta en indicadores y no le queda
--      pendiente al reportante. Caso EVD00040/EVD00041.
--      Va SOLO en esta migración: Postgres no deja usar un valor nuevo del
--      enum en la misma transacción que lo crea, y la segunda migración
--      (función, políticas y vistas) lo usa.
-- Efectos: ninguno por sí sola; nadie usa el valor hasta la segunda.
-- Re-ejecutable: if not exists.
-- ============================================================

alter type public.estatus_incidencia add value if not exists 'duplicada';
