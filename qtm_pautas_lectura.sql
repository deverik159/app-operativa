-- ============================================================
-- qtm_pautas_lectura.sql — dejar LEER la pauta de QTM desde la app
-- Correr una vez en Supabase → SQL Editor.
--
-- POR QUÉ: qtm_pautas tiene RLS activa y NINGUNA política (lo confirmó
-- diagnostico_qtm_campanias.sql, paso 7): la app ve la tabla vacía. El
-- desplegable de campaña de Nueva incidencia (Ecovallas) la necesita para
-- ofrecer, por CARA, la campaña pautada de la catorcena actual y sus
-- vecinas. Solo LECTURA para usuarios con sesión; no se abre escritura ni
-- se toca qtm_contratos (los montos del contrato no le hacen falta a la
-- captura y mejor no exponerlos).
-- ============================================================

grant select on public.qtm_pautas to authenticated;

drop policy if exists qtm_pautas_sel on public.qtm_pautas;
create policy qtm_pautas_sel on public.qtm_pautas
  for select to authenticated
  using (nullif(lower(coalesce(auth_email(), '')), '') is not null);

-- Verificar: debe salir la política recién creada.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'qtm_pautas';
