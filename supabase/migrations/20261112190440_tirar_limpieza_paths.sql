-- ============================================================
-- tirar_limpieza_paths — se tira la tabla puente de la limpieza
-- (Plataforma, 12-nov-2026).
--
-- POR QUÉ. _limpieza_paths la crea /limpiar-todo para pasarle al script de
-- Storage las rutas de los archivos que hay que borrar. La limpieza del
-- piloto del 26-oct-2026 la dejó con 73 rutas porque el script no corrió.
-- Erik lo corrió el 12-nov-2026 y borró los 58 archivos que quedaban (18 MB;
-- ningún dato vivo los mencionaba). La tabla quedó en 0 filas.
--
-- QUÉ CAMBIA. Solo se tira la tabla vacía. Nada depende de ella: ninguna
-- función, vista ni llave foránea (revisado el 12-nov-2026); la app no la
-- usa. El asesor de seguridad deja de listarla en rls_enabled_no_policy.
-- La próxima /limpiar-todo la vuelve a crear.
--
-- Se niega sola si la tabla todavía trae rutas (igual que el PASO 5 de
-- limpiar_todo.sql). Re-ejecutable.
-- ============================================================

-- Dos `if` separados a propósito (revisor-rls): en una sola condición con
-- `and`, Postgres resuelve la tabla aunque ya no exista y truena.
do $$
begin
  if to_regclass('public._limpieza_paths') is not null then
    if exists (select 1 from public._limpieza_paths) then
      raise exception 'Aún hay rutas en _limpieza_paths: corre primero el script de Storage.';
    end if;
    drop table public._limpieza_paths;
  end if;
end $$;
