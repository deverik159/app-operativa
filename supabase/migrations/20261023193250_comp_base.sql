-- ============================================================
-- comp_base — Comprobaciones, fase 2: la base del Supervisor y de los
-- analistas (Erik, 22/23-oct-2026).
--
-- QUÉ HACE (rediseño del 23-oct-2026)
--   Erik: «la idea no es que Victor suba el Excel lleno y la app lo procese,
--   sino que Victor desde la app construya ese Excel». Por eso:
--   · comp_cargar_campanas: UNA sola entrada para las campañas del periodo,
--     vengan de la bitácora comercial (Ecovallas Digital y Biobox), de Pauta
--     VV o del plano (Vía Verde) o del alta manual. Una fila por
--     campaña-versión (= «Asignación de clientes»), con sus sitios y la
--     vigencia y horario de cada sitio.
--   · comp_generar_tomas: Victor elige un plan («al inicio», «inicio y fin»,
--     «cada N días», «diario», «fechas a mano») y la base arma los renglones
--     día × sitio (= «Formato general»), con el horario del día, la ruta del
--     sitio y su monitorista (para el Excel por monitorista).
--   · El resto: asignar y reasignar analistas, marcar lo comprobado (hasta la
--     fase 3), cancelar sitios, cerrar campañas, reglas, avance y diaria.
--   El importador de los Excel de comprobaciones de hoy YA NO es el centro:
--   comp_importar se quitó (no llegó a aplicarse en ninguna base).
--
-- DECISIONES (22/23-oct-2026; las P son valores por omisión que tomó Claude
-- y Erik puede cambiar)
--   · Lo que se marca es el SITIO por campaña-versión (comp_sitios). Las
--     tomas (comp_tomas) son el plan día × sitio y el trabajo de la fase 3.
--   · Unidades con el MISMO texto de usuario_roles: 'Ecovallas', 'Biobox' y
--     'Vía Verde' (en pantalla, Ecovallas es «Ecovallas Digital»). Medios:
--     'Pantalla', 'Máquina', 'Columna' y 'Pórtico'.
--   · Rol y unidad salen de la MISMA fila de usuario_roles (lección del
--     8-oct, src/lib/helpers.ts): unidad NULL = las 3, el manager pasa, y en
--     Ecovallas no cuenta una fila de medio Impreso. Nunca
--     tiene_rol() and unidad in mis_unidades().
--   · Meta = meta_app › meta_full (FULL) › sitios activos. Ya no hay «venta»
--     tecleada: la venta son los sitios cargados; cancelar uno baja la meta.
--   · P1: solo el Supervisor o el manager cierran y reabren, a mano; debajo
--     de la meta piden motivo. La vista solo marca «completa».
--   · P2: un FULL de Vía Verde puede entrar sin sitios; las columnas las
--     agrega la analista de la campaña o el Supervisor. La meta la propone
--     la regla de minutos (sin confirmar) y se puede editar.
--   · P3: el coordinador lee todo lo de su unidad, sin escribir; cada
--     analista ve solo SUS campañas.
--   · P4: al marcar se elige el día: hoy o hasta 7 días atrás, nunca antes
--     del inicio del periodo. La bitácora guarda la hora real.
--   · Una carga de la bitácora o un alta manual NO es la foto completa del
--     periodo (23-oct-2026): las campañas que no vienen no se tocan. Para
--     cada campaña que sí viene, su lista de sitios (si trae la clave
--     «sitios») es la vigente.
--   · Una carga de Pauta VV / plano SÍ es la foto completa del periodo y del
--     medio (revisión del 23-oct-2026, R1/R2): la arma la app desde
--     vv_pautas y vv_ocupacion y, si la lectura llegó incompleta, no carga
--     nada. Las campañas abiertas de fuente pauta_vv o plano que ya no
--     vienen se RETIRAN: se borran si nadie trabajó en ellas y, si no, quedan
--     retiradas (sin tomas pendientes, fuera de la meta). Así una campaña
--     del plano (versión '') que luego llega de Pauta VV con versión «V1» no
--     queda dos veces en el Formato general. p_completa lo decide; NULL =
--     se deduce (todas las entradas son pauta_vv o plano). Para la bitácora
--     y el alta manual se reportan los «posibles duplicados» (misma campaña,
--     otra versión) y el Supervisor los retira con comp_retirar_campanas.
--   · Ventana de toma de un sitio (revisión del 23-oct-2026, R3): la
--     INTERSECCIÓN de su vigencia, la de la campaña y la del periodo
--     (greatest/least ignoran los NULL). Antes la de la campaña solo valía si
--     el sitio no traía la suya, y recortar la campaña en la app no movía
--     nada. Para lo que llega de la bitácora o de Pauta VV da lo mismo: ahí
--     la vigencia de la campaña es la de su primer y último sitio.
--   · Tramos (R10): si el mismo sitio llega dos veces en la misma
--     campaña-versión con vigencias separadas (del 1 al 5 y del 16 al 20), se
--     guarda UN sitio con sus tramos (comp_sitios.tramos) y el plan solo cae
--     en ellos («al inicio» e «inicio y fin», por tramo). Se reporta.
--   · Ruta y monitorista de cada toma (23-oct-2026): ruta_ubicaciones
--     (site_id es único en toda la tabla) → rutas_monitoreo ACTIVA de la
--     misma unidad, Digital o Combinada → el primer asignado de
--     ruta_asignaciones que siga teniendo el rol monitorista en la unidad
--     (R12; en producción todas las rutas Digital/Combinada están activas,
--     SELECT del 23-oct-2026). En producción, las ubicaciones de Ecovallas
--     Digital guardan casi todas la forma vendor_face_id y no el site_id del
--     inventario (6 de 124 coinciden): se busca por los dos. Se guarda en la
--     toma al generarla; las tomas editadas a mano no se recalculan.
--   · Tomas de un sitio que sale del plan (cancelado, fuera de la carga o
--     campaña retirada), R4: las del plan pendientes se borran; las editadas
--     a mano pendientes pasan a 'cancelada' con baja_auto y regresan solas si
--     el sitio vuelve.
--   · Sitio ya comprobado (R11, sin confirmar con Victor): el plan conserva
--     sus tomas pendientes pero no le crea nuevas, salvo que el plan diga
--     incluir_comprobados = true.
--   · Integración con la app (23-oct-2026, pendientes de las piezas TS):
--     - Plano → Pauta VV: si una campaña del plano (versión '') llega
--       después de Pauta VV con UNA versión, se ADOPTA la fila del plano
--       (cambia su versión) en lugar de crear otra y retirar la vieja: así
--       no se pierde lo que ya se trabajó en ella (marcas, analista, plan).
--       Solo con entradas de Pauta VV (o del plano ya con versión, que es
--       como desdePautaVV manda lo del plano de una campaña de Pauta VV) y
--       nunca sobre una fila retirada (revisión del 23-oct-2026).
--     - es_full se puede corregir en la app (comp_editar_campanas) y la
--       recarga ya no lo pisa (editado_app). FULL solo existe en Vía Verde
--       (Erik, 23-oct-2026: Biobox y Ecovallas son 24 h, sin FULL).
--     - comp_fuente_pauta_vv: el Supervisor no puede leer vv_campanas,
--       vv_pautas, vv_ocupacion ni vv_espacios (sus políticas son de
--       comercial, pautas y manager, y NO se tocan). La RPC le entrega, de
--       solo lectura y en un solo jsonb, lo que la app necesita para armar
--       la carga de Vía Verde.
--     - Biobox y Ecovallas Digital son todo 24 horas, sin franjas (Erik,
--       23-oct-2026); Vía Verde sí va por franjas. La base guarda el texto
--       del horario tal como llega: no cambia nada aquí.
--
-- CORRECCIONES DE LA REVISIÓN ADVERSARIAL (22-oct-2026) QUE SIGUEN AQUÍ
--   #1  Pórticos: vv_espacios.tramo es NULL en los 4; el filtro usa coalesce.
--   #2  En Vía Verde las claves ^MX_EM_ (EDO MEX, dado de baja) no entran
--       aunque falten en vv_espacios. Una CDMX inactiva se reporta aparte.
--       En Biobox y Ecovallas Digital las MX_EM_ están activas: sí entran
--       (revisado el 23-oct-2026: la regla va SOLO con p_unidad / c.unidad
--       = 'Vía Verde' en comp_cargar_campanas y comp_agregar_sitios; las
--       caras Digital MX_EM_EV_ de Ecovallas entran como cualquier otra).
--   #3  La meta descuenta lo cancelado (sale de los sitios activos).
--   #4  El crédito de lo comprobado va por comprobado_por (no se mueve al
--       reasignar); la carga va por analista_email.
--   #5  Lo que se edita en la app (editado_app) no lo pisa una recarga.
--   #6  Recargar la bitácora o un alta manual no borra campañas (solo toca
--       las que vienen). Desde el 23-oct-2026 la foto completa de Pauta VV /
--       plano sí retira las suyas que ya no vienen (ver arriba), y solo
--       borra las que nadie trabajó.
--   #7  Recargar no toca campañas cerradas (ni campaña, ni sitios, ni tomas).
--   #8  Un sitio con la clave vacía rechaza la carga completa.
--   #9  Cada llamada es completa en sí misma: no hay carga partida.
--   #11 El cruce con inventario pide la unidad (y en Ecovallas, Digital).
--   #12 Sin UPDATE masivo: las bajas salen de un anti-join contra tablas
--       temporales, y las funciones que escriben llevan lock_timeout.
--   #13 comp_equipo dice quién es asignable (solo analistas).
--   #17 Vistas con columnas explícitas.  #18 índice (analista_email).
--   #19 comp_es_analista_de y las internas no se abren a authenticated.
--   #25 Para marcar, la analista debe seguir teniendo el rol en la unidad.
--   #26 Una catorcena sin fechas da un error claro.
--
-- SEGURIDAD
--   · Las tablas solo reciben SELECT, con RLS; no hay políticas de
--     escritura: todo pasa por RPC security definer con search_path fijo
--     (public y pg_temp al final, para que una tabla temporal del que llama
--     no tape las de public). Cada RPC valida rol y unidad para CADA fila del
--     lote: si una falla, no se cambia nada (no hay éxitos parciales mudos).
--   · Las vistas son security_invoker: respetan la RLS de quien consulta.
--   · Sin correos, clientes, secretos ni ref del proyecto. Re-ejecutable.
-- ============================================================

-- ------------------------------------------------------------
-- 0) Candado: el rol supervisor (migración 20261023100000) va antes.
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                  where t.typname = 'app_role' and e.enumlabel = 'supervisor') then
    raise exception 'Falta el rol supervisor: aplica antes la migración rol_supervisor.';
  end if;
end $$;

-- El primer diseño (22-oct-2026) importaba los Excel de comprobaciones. No
-- se aplicó en ninguna base, pero si quedó en una copia local se quita.
drop function if exists public.comp_importar(text, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean, boolean);
-- Firmas de la primera versión del rediseño (23-oct-2026, tampoco aplicadas):
-- comp_cargar_campanas ganó p_completa, comp_agregar_tomas ganó
-- p_fuera_de_vigencia y comp_aplicar_plan pasó a ser por conjuntos.
drop function if exists public.comp_cargar_campanas(text, text, jsonb, jsonb, boolean);
drop function if exists public.comp_agregar_tomas(bigint[], date[]);
drop function if exists public.comp_aplicar_plan(bigint, jsonb);

-- ------------------------------------------------------------
-- 1) Ayudantes
-- ------------------------------------------------------------

-- Llave de comparación de textos (campaña, versión).
-- Regla (23-oct-2026), idéntica a llaveComp() de src/lib/comprobaciones.ts:
-- quitar acentos, diéresis y ñ con translate (áéíóúÁÉÍÓÚüÜñÑ → aeiouAEIOUuUnN),
-- dejar SOLO [A-Za-z0-9] (fuera espacios, también el duro, y signos) y pasar
-- a MAYÚSCULAS.
-- El orden importa: se quita ANTES de upper() porque upper() de Postgres
-- depende del locale (en el embebido upper('ß') da 'ẞ'; con otro, 'ı' da 'I')
-- y toUpperCase() de JS da ß→SS. Así ß, ı, İ, ﬁ… se quitan igual en los dos
-- lados y upper() solo ve ASCII. La paridad la prueban la tabla de
-- tests/comprobaciones.test.mjs y el Postgres embebido (todo el plano básico).
create or replace function public.comp_llave(t text) returns text
language sql immutable parallel safe set search_path to 'public', 'pg_temp' as $$
  select upper(regexp_replace(translate(coalesce(t, ''), 'áéíóúÁÉÍÓÚüÜñÑ', 'aeiouAEIOUuUnN'),
                              '[^A-Za-z0-9]+', '', 'g'))
$$;

-- Clave de sitio como la guarda el módulo: sin espacios (también el duro,
-- frecuente en Excel) y en mayúsculas. La limpieza fina (ceros, texto
-- pegado) la hace la app; esto es la red.
create or replace function public.comp_clave_sitio(t text) returns text
language sql immutable parallel safe set search_path to 'public', 'pg_temp' as $$
  select nullif(upper(regexp_replace(replace(coalesce(t, ''), chr(160), ''), '\s+', '', 'g')), '')
$$;

-- Clave corta de vv_espacios a partir del vendor_face_id:
-- MX_CM_VV_COL_448 → '448', MX_CM_VV_POR_0015 → 'POR_0015'.
create or replace function public.comp_espacio_vv(t text) returns text
language sql immutable parallel safe set search_path to 'public', 'pg_temp' as $$
  select nullif(regexp_replace(comp_clave_sitio(t), '^MX_[A-Z]{2}_VV_(COL_)?', ''), '')
$$;

-- Unidades del módulo donde quien llama tiene alguno de p_roles.
-- Rol y unidad de la MISMA fila; unidad NULL = las 3; el manager = las 3;
-- en Ecovallas solo cuenta una fila sin medio o con medio Digital.
-- La unidad se compara EXACTA (revisión #15): la app usa la misma regla.
create or replace function public.comp_mis_unidades(p_roles app_role[])
returns setof text language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select u.unidad
    from unnest(array['Ecovallas', 'Biobox', 'Vía Verde']) as u(unidad)
   where exists (
     select 1 from usuario_roles ur
      where lower(ur.usuario_email) = lower(auth_email())
        and (ur.rol = 'manager'
             or (ur.rol = any (p_roles)
                 and (ur.unidad_negocio is null or ur.unidad_negocio = u.unidad)
                 and (u.unidad <> 'Ecovallas' or ur.medio is null or ur.medio ilike 'digital%'))))
$$;

-- Gestiona = Supervisor de esa unidad (o manager).
create or replace function public.comp_gestiona(p_unidad text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select coalesce(p_unidad in (select comp_mis_unidades(array['supervisor']::app_role[])), false)
$$;

-- Lee toda la unidad: Supervisor y Coordinador (solo lectura, P3), o manager.
create or replace function public.comp_lee(p_unidad text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select coalesce(p_unidad in (select comp_mis_unidades(array['supervisor', 'coordinador']::app_role[])), false)
$$;

-- ¿p_email tiene p_rol en p_unidad? (misma regla de fila). Solo la usan
-- las RPC security definer: sin grant (revisión #19).
create or replace function public.comp_tiene_rol_en(p_email text, p_rol app_role, p_unidad text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from usuario_roles ur
    where lower(ur.usuario_email) = lower(btrim(p_email)) and ur.rol = p_rol
      and (ur.unidad_negocio is null or ur.unidad_negocio = p_unidad)
      and (p_unidad <> 'Ecovallas' or ur.medio is null or ur.medio ilike 'digital%'))
$$;

create or replace function public.comp_es_analista_de(p_email text, p_unidad text) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select comp_tiene_rol_en(p_email, 'analista', p_unidad)
$$;

create or replace function public.comp_etiqueta_unidad(p text) returns text
language sql immutable set search_path to 'public', 'pg_temp' as $$
  select case p when 'Ecovallas' then 'Ecovallas Digital' else p end
$$;

-- Plan de tomas normalizado (23-oct-2026). Acepta
--   {tipo: 'inicio' | 'inicio_fin' | 'cada_n' | 'diario' | 'fechas', cada_n, fechas,
--    incluir_comprobados}
-- y devuelve {tipo, cada_n, fechas} limpio (fechas sin repetir y en orden),
-- o un error claro. Es lo que se guarda en comp_campanas.plan_tomas.
-- ESPEJO de leerPlan() de src/lib/comprobaciones.ts, con los MISMOS textos
-- de error. Reglas iguales en los dos (revisión del 23-oct-2026, R7):
--   · cada_n: un entero de 1 a 366, como número o como texto de solo dígitos
--     (con signo y espacios a los lados). Nada de '3.5', '1e1', true.
--   · fechas: 'YYYY-MM-DD', opcionalmente con hora SIN zona; las vacías
--     (null, '') se ignoran y UNA que no se entienda rechaza todo el plan
--     ('2026-10-5', '05/10/2026', '2026-02-30', '2026-10-04T23:30:00-06:00',
--     un número). Antes la base leía '05/10/2026' con DateStyle MDY.
--     Contrato exacto (23-oct-2026, igual que el TS): btrim(x) debe cumplir
--     ^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$ y la fecha es
--     left(btrim(x), 10)::date. Aquí \d se escribe [0-9]: en Postgres \d
--     puede aceptar dígitos de otros alfabetos según el locale y en JS no.
--     Los casos compartidos están en tests/comprobaciones.test.mjs
--     (CASOS_PLAN) y la prueba de PGlite los repite con el MISMO texto.
--   · incluir_comprobados (R11): solo si viene true se guarda; sin él, el
--     plan no crea tomas NUEVAS para un sitio ya comprobado. La pantalla lo
--     ignora (leerPlan se queda con tipo, cada_n y fechas).
create or replace function public.comp_plan_normal(p jsonb) returns jsonb
language plpgsql immutable set search_path to 'public', 'pg_temp' as $$
declare
  v_tipo text := case when jsonb_typeof(p) = 'object' and jsonb_typeof(p->'tipo') = 'string' then p->>'tipo' end;
  v_n int; v_f date[]; v_d date; e jsonb; v_txt text;
begin
  if v_tipo is null or v_tipo not in ('inicio', 'inicio_fin', 'cada_n', 'diario', 'fechas') then
    raise exception 'Plan de tomas no válido: elige «al inicio», «inicio y fin», «cada N días», «diario» o «fechas a mano».';
  end if;
  if v_tipo = 'cada_n' then
    if jsonb_typeof(p->'cada_n') in ('number', 'string')
       and (p->>'cada_n') ~ '^[ \t\n\r\f\v]*[+-]?[0-9]+[ \t\n\r\f\v]*$' then
      begin
        v_n := (p->>'cada_n')::int;
      exception when others then
        v_n := null;   -- más grande que un int: fuera de rango igual
      end;
    end if;
    if v_n is null or v_n < 1 or v_n > 366 then
      raise exception 'Para «cada N días» escribe N (de 1 a 366).';
    end if;
  end if;
  if v_tipo = 'fechas' then
    if jsonb_typeof(p->'fechas') is distinct from 'array' or jsonb_array_length(p->'fechas') = 0 then
      raise exception 'Para «fechas a mano» elige al menos una fecha.';
    end if;
    for e in select x from jsonb_array_elements(p->'fechas') x loop
      continue when jsonb_typeof(e) = 'null' or (jsonb_typeof(e) = 'string' and btrim(e #>> '{}') = '');
      v_txt := case when jsonb_typeof(e) = 'string' then btrim(e #>> '{}') end;
      if v_txt is null or v_txt !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?)?$' then
        raise exception 'Hay una fecha del plan que no se entiende.';
      end if;
      begin
        v_d := left(v_txt, 10)::date;
      exception when others then
        raise exception 'Hay una fecha del plan que no se entiende.';
      end;
      v_f := v_f || v_d;
    end loop;
    if v_f is null then
      raise exception 'Para «fechas a mano» elige al menos una fecha.';
    end if;
    select array_agg(distinct x order by x) into v_f from unnest(v_f) x;
  end if;
  return jsonb_build_object('tipo', v_tipo, 'cada_n', v_n, 'fechas', to_jsonb(v_f))
         || case when p->'incluir_comprobados' = 'true'::jsonb
                 then jsonb_build_object('incluir_comprobados', true) else '{}'::jsonb end;
end $$;

-- Fechas de un plan dentro de [p_ini, p_fin] (23-oct-2026). ESPEJO de
-- generarFechasPlan(plan, inicio, fin) de src/lib/comprobaciones.ts: deben dar
-- las MISMAS fechas (la prueba de PGlite las compara).
--   inicio      → p_ini
--   inicio_fin  → p_ini y p_fin (una sola si coinciden)
--   cada_n      → p_ini, p_ini + n, p_ini + 2n… sin pasar de p_fin
--   diario      → todos los días
--   fechas      → solo las que caen dentro
-- Sin rango (algún extremo NULL o fin < inicio) no hay fechas.
-- Tope de 400 fechas en «diario» y «cada N», como TOPE_DIAS_PLAN del TS
-- (revisión del 23-oct-2026): una ventana real es de un mes o una catorcena,
-- y así un rango absurdo no gira millones de días. Recibe el plan ya
-- normalizado (comp_plan_normal) y no se abre a authenticated.
create or replace function public.comp_fechas_plan(p_plan jsonb, p_ini date, p_fin date) returns setof date
language sql immutable set search_path to 'public', 'pg_temp' as $$
  with n as (
    select case when p_plan->>'tipo' = 'cada_n' then greatest(coalesce((p_plan->>'cada_n')::int, 1), 1) else 1 end as n)
  select distinct x.d
    from (
      select p_ini as d where p_plan->>'tipo' in ('inicio', 'inicio_fin')
      union all
      select p_fin where p_plan->>'tipo' = 'inicio_fin'
      union all
      select g::date
        from n, generate_series(p_ini::timestamp, least(p_fin, p_ini + 399 * n.n)::timestamp, make_interval(days => n.n)) g
       where p_plan->>'tipo' in ('cada_n', 'diario')
      union all
      select f::date
        from jsonb_array_elements_text(case when p_plan->>'tipo' = 'fechas' and jsonb_typeof(p_plan->'fechas') = 'array'
                                            then p_plan->'fechas' else '[]'::jsonb end) f
    ) x
   where p_ini is not null and p_fin is not null and p_fin >= p_ini and x.d between p_ini and p_fin
   order by x.d
$$;

-- Ventanas de toma de un sitio (revisión del 23-oct-2026, R3 y R10). Cada
-- tramo del sitio (o su única vigencia si no tiene tramos) recortado por la
-- vigencia de la campaña y la del periodo: greatest/least IGNORAN los NULL,
-- así un extremo vacío toma el de la campaña y, si tampoco, el del periodo.
-- Los tramos que se tocan o se enciman se juntan (del 1 al 5 y del 6 al 9
-- es uno solo: «al inicio» no da dos tomas). Sin filas = el sitio no corre
-- en el periodo.
create or replace function public.comp_ventanas(p_s_ini date, p_s_fin date, p_tramos jsonb,
  p_c_ini date, p_c_fin date, p_p_ini date, p_p_fin date)
returns table (ini date, fin date)
language sql immutable set search_path to 'public', 'pg_temp' as $$
  with t as (
    select greatest(x.a, p_c_ini, p_p_ini) as a, least(x.b, p_c_fin, p_p_fin) as b
      from (select p_s_ini as a, p_s_fin as b
             where coalesce(jsonb_typeof(p_tramos), 'null') <> 'array' or jsonb_array_length(p_tramos) = 0
            union all
            select (e->>'inicio')::date, (e->>'fin')::date
              from jsonb_array_elements(case when jsonb_typeof(p_tramos) = 'array' then p_tramos else '[]'::jsonb end) e) x
  ), g as (
    select a, b,
           case when a <= max(b) over (order by a, b rows between unbounded preceding and 1 preceding) + 1
                then 0 else 1 end as nuevo
      from t where a <= b
  ), h as (
    select a, b, sum(nuevo) over (order by a, b rows between unbounded preceding and current row) as grp from g
  )
  select min(a), max(b) from h group by grp order by 1
$$;

-- ------------------------------------------------------------
-- 2) Tablas
-- ------------------------------------------------------------
create table if not exists public.comp_periodos (
  id bigint generated always as identity primary key,
  unidad text not null check (unidad in ('Ecovallas', 'Biobox', 'Vía Verde')),
  tipo text not null check (tipo in ('catorcena', 'mes')),
  anio int not null, numero int not null,              -- catorcena o mes 1..12
  fecha_inicio date not null, fecha_fin date not null,
  etiqueta text not null,                              -- 'Cat-18 · 2026' / 'Agosto 2026'
  creado_por text not null, creado_en timestamptz not null default now(),
  check (fecha_fin >= fecha_inicio),
  check ((unidad = 'Ecovallas') = (tipo = 'catorcena')),
  unique (unidad, tipo, anio, numero));

create table if not exists public.comp_campanas (      -- = fila de «Asignación de clientes»
  id bigint generated always as identity primary key,
  periodo_id bigint not null references public.comp_periodos(id) on delete restrict,
  unidad text not null check (unidad in ('Ecovallas', 'Biobox', 'Vía Verde')),
  medio text not null check (medio in ('Pantalla', 'Máquina', 'Columna', 'Pórtico')),
  -- De dónde salió (23-oct-2026): bitácora comercial, Pauta VV, plano de
  -- ocupación de Vía Verde o alta manual. origen_ref = id de vv_campanas o
  -- «archivo / hoja» de la bitácora; solo informativo.
  fuente text not null check (fuente in ('bitacora', 'pauta_vv', 'plano', 'manual')),
  origen_ref text,
  cliente text,
  campana text not null, version text not null default '',
  campana_llave text not null, version_llave text not null default '',  -- comp_llave(); la llena la RPC
  vendedor text, administrador text, quantum text, mediamonitor boolean,
  arte text check (arte in ('NUEVO', 'REPITE')),
  especificacion text,                                 -- ESPECIFICACIONES DE TOMAS, tal cual
  inicio date, fin date,                               -- vigencia de la campaña (NULL = la del periodo)
  es_full boolean not null default false, full_minutos int check (full_minutos >= 0),
  meta_full int check (meta_full >= 0),                -- FULL: propuesta por comp_reglas, editable
  meta_app int check (meta_app >= 0),                  -- la corrige el Supervisor
  analista_email text check (analista_email = lower(analista_email)),
  -- 'archivo' = vino como propuesta en la carga; 'app' = la puso el Supervisor
  -- (una recarga ya no la cambia).
  asignacion_origen text check (asignacion_origen in ('archivo', 'app')),
  asignado_por text, asignado_en timestamptz,
  sugerido_email text,                                 -- quien la llevó en otro periodo (REPITE)
  fecha_limite date,                                   -- solo la pone el Supervisor
  banderas text[] not null default '{}',
  entrega_tipo text not null default 'enviar' check (entrega_tipo in ('enviar', 'lista_sin_enviar', 'no_se_comprueba')),
  plan_tomas jsonb,                                    -- el último plan aplicado (comp_plan_normal)
  -- Retirada (revisión del 23-oct-2026): ya no viene en Pauta VV / plano, o
  -- el Supervisor la retiró (versión repetida). Se queda solo porque alguien
  -- ya trabajó en ella: sin tomas pendientes y sus pendientes fuera de la
  -- meta. Si vuelve en una carga, deja de estar retirada.
  retirada boolean not null default false, retirada_en timestamptz,
  reemplazada_por bigint references public.comp_campanas(id) on delete set null,
  estatus text not null default 'abierta' check (estatus in ('abierta', 'cerrada')),
  cerrada_por text, cerrada_en timestamptz, cierre_motivo text,
  -- Columnas que se editaron en la app: la recarga ya no las pisa (#5).
  editado_app text[] not null default '{}',
  cargado_por text, cargado_en timestamptz,
  creado_en timestamptz not null default now(), actualizado_en timestamptz not null default now(),
  check (estatus <> 'cerrada' or cerrada_en is not null),
  check (fin is null or inicio is null or fin >= inicio),
  unique (periodo_id, medio, campana_llave, version_llave));
create index if not exists comp_campanas_unidad_periodo on public.comp_campanas (unidad, periodo_id);
-- La política filtra analista_email = lower(auth_email()): índice a secas (#18).
create index if not exists comp_campanas_analista on public.comp_campanas (analista_email);
-- Sugerencia REPITE: misma campaña en otros periodos de la unidad.
create index if not exists comp_campanas_llave on public.comp_campanas (unidad, campana_llave);

create table if not exists public.comp_sitios (        -- campaña-versión × sitio = unidad de la venta
  id bigint generated always as identity primary key,
  campana_id bigint not null references public.comp_campanas(id) on delete cascade,
  unidad text not null check (unidad in ('Ecovallas', 'Biobox', 'Vía Verde')),
  sitio_clave text not null,                           -- limpia (forma vendor_face_id)
  sitio_original text,                                 -- como venía en la bitácora o la pauta
  -- Sin FK a inventario ni a vv_espacios: los reescribe el puente de QTM y
  -- una FK podría frenar la sincronización o borrar en cascada.
  vendor_face_id text, site_id text, espacio_vv text,
  en_inventario boolean not null default false,
  -- Vigencia y horario del sitio en esta versión (bitácora / vv_pautas).
  -- La ventana de toma es la intersección con la campaña y el periodo
  -- (comp_ventanas); un extremo NULL = el de la campaña o el del periodo.
  inicio date, fin date,
  -- Tramos separados del mismo sitio en esta versión (R10, 23-oct-2026):
  -- [{inicio, fin}, …]; inicio/fin guardan el primero y el último. NULL = un
  -- solo tramo.
  tramos jsonb check (tramos is null or jsonb_typeof(tramos) = 'array'),
  horario_lv text, horario_sd text,                    -- lunes a viernes / sábado y domingo
  tipo_venta text check (tipo_venta in ('VENTA', 'BONUS')),
  testigos boolean, observaciones text,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'comprobado', 'cancelado')),
  comprobado_dia date, comprobado_en timestamptz, comprobado_por text,
  comprobado_via text check (comprobado_via in ('marca', 'revision')),  -- fase 2 = marca; fase 3 = revision
  cancelado_motivo text, cancelado_por text, cancelado_en timestamptz,
  origen text not null default 'carga' check (origen in ('carga', 'app')),
  -- La última carga de su campaña ya no lo trajo, pero se quedó porque
  -- tenía marca, cancelación o tomas trabajadas. No genera tomas nuevas.
  fuera_de_carga boolean not null default false,
  creado_en timestamptz not null default now(), actualizado_en timestamptz not null default now(),
  check ((estado = 'comprobado') = (comprobado_dia is not null and comprobado_en is not null)),
  check (estado <> 'cancelado' or nullif(btrim(cancelado_motivo), '') is not null),
  check (fin is null or inicio is null or fin >= inicio),
  unique (campana_id, sitio_clave));
create index if not exists comp_sitios_campana_estado on public.comp_sitios (campana_id, estado);
create index if not exists comp_sitios_dia on public.comp_sitios (unidad, comprobado_dia) where estado = 'comprobado';

create table if not exists public.comp_tomas (         -- = renglón del «Formato general»
  id bigint generated always as identity primary key,
  campana_id bigint not null references public.comp_campanas(id) on delete cascade,
  sitio_id bigint not null references public.comp_sitios(id) on delete cascade,
  unidad text not null check (unidad in ('Ecovallas', 'Biobox', 'Vía Verde')),
  fecha date not null,
  -- Fecha que le dio el plan. Si se mueve a mano, el plan ya no vuelve a
  -- crear la toma en la fecha original.
  fecha_plan date,
  horario_texto text,                                  -- horario L-V o S-D según el día
  observaciones text, notas text,
  comprobacion text not null default 'FOTO',
  turno text check (turno in ('matutino', 'vespertino', 'campo')),
  -- Calculados al generar (sin FK: las rutas se borran y se reimportan).
  ruta_id bigint, ruta_numero int,
  monitorista_email text check (monitorista_email = lower(monitorista_email)),
  -- 'plan' = la generó el plan; 'app' = se editó o agregó a mano: regenerar
  -- el plan ya no la toca.
  origen text not null default 'plan' check (origen in ('plan', 'app')),
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'por_revisar', 'comprobada', 'regresada', 'cancelada')),  -- fase 3
  -- 'cancelada' por el sistema porque su sitio salió del plan (cancelado,
  -- fuera de la carga, campaña retirada); regresa sola si el sitio vuelve
  -- (R4, 23-oct-2026). Las quitadas a mano llevan false.
  baja_auto boolean not null default false,
  editado_por text, editado_en timestamptz,
  creado_en timestamptz not null default now(),
  unique (campana_id, sitio_id, fecha));
create index if not exists comp_tomas_sitio on public.comp_tomas (sitio_id);
create index if not exists comp_tomas_monitorista on public.comp_tomas (unidad, monitorista_email, fecha);

create table if not exists public.comp_reglas (        -- DATOS editables; nada confirmado
  id bigint generated always as identity primary key,
  unidad text check (unidad in ('Ecovallas', 'Biobox', 'Vía Verde')),  -- NULL = todas
  tipo text not null check (tipo in ('full_porcentaje', 'avances_por_sitios', 'dias_limite_por_sitios',
                                     'pendientes_dias_antes', 'toma_especial_cliente', 'texto_general')),
  desde int, hasta int,                                -- minutos o sitios; hasta NULL = «o más»
  valor numeric, valor_texto text, cliente_patron text,
  confirmada boolean not null default false,
  notas text, actualizada_por text, actualizada_en timestamptz not null default now());

create table if not exists public.comp_movimientos (    -- bitácora de lotes
  id bigint generated always as identity primary key,
  accion text not null check (accion in ('cargar', 'generar_tomas', 'editar_tomas', 'agregar_tomas',
                                         'quitar_tomas', 'restaurar_tomas', 'asignar', 'pasar_pendiente',
                                         'marcar', 'desmarcar', 'cancelar', 'restaurar', 'cerrar', 'reabrir',
                                         'editar', 'agregar_sitios', 'regla', 'retirar', 'regresar')),
  unidad text, periodo_id bigint, campana_ids bigint[], sitio_ids bigint[], n int not null default 0,
  de_email text, a_email text, detalle jsonb, por text not null, en timestamptz not null default now());
create index if not exists comp_movimientos_unidad_en on public.comp_movimientos (unidad, en desc);

-- Semillas de comp_reglas: todas SIN CONFIRMAR (Erik se las pregunta al
-- Supervisor). Solo se siembra un tipo si todavía no tiene filas, así
-- re-ejecutar no duplica ni pisa lo que se edite en la app.
-- Las tomas especiales por cliente NO se siembran aquí: el repo es público y
-- llevan nombres de clientes; se capturan en la app (modal de Reglas).
insert into public.comp_reglas (unidad, tipo, desde, hasta, valor, notas)
select 'Vía Verde', 'full_porcentaje', d, h, v,
       'Del Excel de asignación de Vía Verde (ago-2026). % de las columnas activas de CDMX; '
       || 'los conteos del Excel incluyen EDO MEX. Sin confirmar.'
  from (values (1, 15, 0.30), (16, 30, 0.45), (31, 45, 0.60), (46, 59, 0.75), (60, null, 1.00)) r(d, h, v)
 where not exists (select 1 from public.comp_reglas where tipo = 'full_porcentaje');

insert into public.comp_reglas (unidad, tipo, desde, hasta, valor, valor_texto, notas)
select 'Vía Verde', 'avances_por_sitios', d, h, v, vt,
       'Del Excel de asignación de Vía Verde (ago-2026): avances según sitios. Sin confirmar.'
  from (values (1, 5, null::numeric, 'TODAS'), (6, 10, 2, null), (11, 20, 5, null),
               (21, 25, 7, null), (26, 30, 10, null)) r(d, h, v, vt)
 where not exists (select 1 from public.comp_reglas where tipo = 'avances_por_sitios');

insert into public.comp_reglas (unidad, tipo, desde, hasta, valor, notas)
select null, 'dias_limite_por_sitios', d, h, v,
       'De la fórmula de la hoja RESUMEN: días después del inicio según sitios. Sin confirmar.'
  from (values (0, 5, 2), (6, 15, 3), (16, 30, 5), (31, null, 7)) r(d, h, v)
 where not exists (select 1 from public.comp_reglas where tipo = 'dias_limite_por_sitios');

insert into public.comp_reglas (unidad, tipo, valor, notas)
select u, 'pendientes_dias_antes', v, 'Días antes del fin para mandar pendientes. Sin confirmar.'
  from (values ('Biobox', 2), ('Vía Verde', 4)) r(u, v)
 where not exists (select 1 from public.comp_reglas where tipo = 'pendientes_dias_antes');

-- Meta propuesta de un FULL (P2): % de la regla de minutos × espacios activos
-- de CDMX del medio (columnas o pórticos). NULL si no hay minutos o regla.
create or replace function public.comp_meta_full_propuesta(p_medio text, p_minutos int) returns int
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select round(r.valor * (
           select count(*) from vv_espacios ve
            where ve.activo and coalesce(ve.tramo, '') not ilike 'EDO MEX%'
              and ve.tipo_espacio = case p_medio when 'Columna' then 'columna' when 'Pórtico' then 'portico' end))::int
    from comp_reglas r
   where p_minutos is not null and r.tipo = 'full_porcentaje'
     and (r.unidad is null or r.unidad = 'Vía Verde')
     and p_minutos between coalesce(r.desde, 0) and coalesce(r.hasta, 2147483647)
   order by (r.unidad is null), r.desde desc nulls last
   limit 1
$$;

-- ------------------------------------------------------------
-- 3) RLS: solo lectura; las RPC escriben.
-- ------------------------------------------------------------
alter table public.comp_periodos enable row level security;
alter table public.comp_campanas enable row level security;
alter table public.comp_sitios enable row level security;
alter table public.comp_tomas enable row level security;
alter table public.comp_reglas enable row level security;
alter table public.comp_movimientos enable row level security;
revoke all on public.comp_periodos, public.comp_campanas, public.comp_sitios, public.comp_tomas,
  public.comp_reglas, public.comp_movimientos from anon, authenticated;
grant select on public.comp_periodos, public.comp_campanas, public.comp_sitios, public.comp_tomas,
  public.comp_reglas, public.comp_movimientos to authenticated;

-- `unidad in (select …)` se evalúa una vez por consulta (initPlan), no por fila.
drop policy if exists comp_per_sel on public.comp_periodos;
create policy comp_per_sel on public.comp_periodos for select to authenticated
  using (unidad in (select comp_mis_unidades(array['supervisor', 'coordinador', 'analista']::app_role[])));

-- La analista ve sus campañas mientras siga teniendo el rol en esa unidad
-- (#25): si se lo quitan, desaparecen enteras y no a medias.
drop policy if exists comp_cam_sel on public.comp_campanas;
create policy comp_cam_sel on public.comp_campanas for select to authenticated
  using (unidad in (select comp_mis_unidades(array['supervisor', 'coordinador']::app_role[]))
         or (analista_email = lower(auth_email())
             and unidad in (select comp_mis_unidades(array['analista']::app_role[]))));

drop policy if exists comp_sit_sel on public.comp_sitios;
create policy comp_sit_sel on public.comp_sitios for select to authenticated
  using (unidad in (select comp_mis_unidades(array['supervisor', 'coordinador']::app_role[]))
         or campana_id in (select c.id from public.comp_campanas c where c.analista_email = lower(auth_email())));

-- En la fase 3 se agrega una política aditiva para el monitorista.
drop policy if exists comp_tom_sel on public.comp_tomas;
create policy comp_tom_sel on public.comp_tomas for select to authenticated
  using (unidad in (select comp_mis_unidades(array['supervisor', 'coordinador']::app_role[]))
         or campana_id in (select c.id from public.comp_campanas c where c.analista_email = lower(auth_email())));

drop policy if exists comp_reg_sel on public.comp_reglas;
create policy comp_reg_sel on public.comp_reglas for select to authenticated
  using (exists (select 1 from comp_mis_unidades(array['supervisor', 'coordinador', 'analista']::app_role[])));

drop policy if exists comp_mov_sel on public.comp_movimientos;
create policy comp_mov_sel on public.comp_movimientos for select to authenticated
  using (unidad in (select comp_mis_unidades(array['supervisor']::app_role[])));

-- ------------------------------------------------------------
-- 4) Vistas (security_invoker: respetan la RLS de quien consulta).
--    Columnas explícitas (#17): una columna nueva en la tabla no rompe
--    el create or replace.
-- ------------------------------------------------------------
create or replace view public.vw_comp_campanas with (security_invoker = on) as
select c.id, c.periodo_id, c.unidad, comp_etiqueta_unidad(c.unidad) as unidad_etiqueta, c.medio,
       c.fuente, c.origen_ref, c.cliente, c.campana, c.version, c.campana_llave, c.version_llave,
       c.vendedor, c.administrador, c.quantum, c.mediamonitor, c.arte, c.especificacion,
       c.inicio, c.fin, c.es_full, c.full_minutos, c.meta_full, c.meta_app,
       c.analista_email, c.asignacion_origen, c.asignado_por, c.asignado_en, c.sugerido_email,
       c.fecha_limite, c.banderas, c.entrega_tipo, c.plan_tomas,
       c.retirada, c.retirada_en, c.reemplazada_por,
       c.estatus, c.cerrada_por, c.cerrada_en, c.cierre_motivo, c.editado_app,
       c.cargado_por, c.cargado_en, c.creado_en, c.actualizado_en,
       p.tipo as periodo_tipo, p.etiqueta as periodo_etiqueta,
       p.fecha_inicio as periodo_inicio, p.fecha_fin as periodo_fin,
       k.sitios_total, k.sitios_activos, k.comprobados, k.pendientes, k.cancelados, k.fuera_de_carga,
       k.sin_inventario, k.comprobados_hoy,
       -- Tipo de venta resumido de los sitios no cancelados.
       case when k.venta_n > 0 and k.bonus_n > 0 then 'MIXTA'
            when k.venta_n > 0 then 'VENTA' when k.bonus_n > 0 then 'BONUS' end as tipo_venta,
       tm.tomas_total, tm.tomas_pendientes, tm.tomas_editadas,
       m.meta, m.meta_fuente,
       case when m.meta > 0 then round(100.0 * k.comprobados / m.meta, 1) end as pct,
       (m.meta > 0 and k.comprobados >= m.meta) as completa,
       f.fecha_limite_efectiva, f.fecha_limite_fuente,
       f.fecha_limite_efectiva - (now() at time zone 'America/Mexico_City')::date as dias_restantes
  from public.comp_campanas c
  join public.comp_periodos p on p.id = c.periodo_id
  cross join lateral (
    select count(*)::int as sitios_total,
           -- Activo = comprobado, o pendiente que sigue en la carga (#3) de una
           -- campaña no retirada (23-oct-2026).
           (count(*) filter (where s.estado = 'comprobado'
                             or (s.estado = 'pendiente' and not s.fuera_de_carga and not c.retirada)))::int as sitios_activos,
           (count(*) filter (where s.estado = 'comprobado'))::int as comprobados,
           (count(*) filter (where s.estado = 'pendiente' and not s.fuera_de_carga and not c.retirada))::int as pendientes,
           (count(*) filter (where s.estado = 'cancelado'))::int as cancelados,
           (count(*) filter (where s.fuera_de_carga))::int as fuera_de_carga,
           (count(*) filter (where not s.en_inventario))::int as sin_inventario,
           (count(*) filter (where s.estado = 'comprobado'
                             and s.comprobado_dia = (now() at time zone 'America/Mexico_City')::date))::int as comprobados_hoy,
           count(*) filter (where s.estado <> 'cancelado' and s.tipo_venta = 'VENTA') as venta_n,
           count(*) filter (where s.estado <> 'cancelado' and s.tipo_venta = 'BONUS') as bonus_n
      from public.comp_sitios s where s.campana_id = c.id) k
  cross join lateral (
    select (count(*) filter (where t.estado <> 'cancelada'))::int as tomas_total,
           (count(*) filter (where t.estado = 'pendiente'))::int as tomas_pendientes,
           (count(*) filter (where t.origen = 'app'))::int as tomas_editadas
      from public.comp_tomas t where t.campana_id = c.id) tm
  cross join lateral (
    select coalesce(c.meta_app, case when c.es_full then c.meta_full end, k.sitios_activos)::int as meta,
           case when c.meta_app is not null then 'app'
                when c.es_full and c.meta_full is not null then 'full'
                else 'sitios' end as meta_fuente) m
  left join lateral (
    select r.valor from public.comp_reglas r
     where r.tipo = 'dias_limite_por_sitios' and (r.unidad is null or r.unidad = c.unidad)
       and m.meta between coalesce(r.desde, 0) and coalesce(r.hasta, 2147483647)
     order by (r.unidad is null), r.desde desc nulls last limit 1) rl on true
  cross join lateral (
    select coalesce(c.fecha_limite,
                    greatest(coalesce(c.inicio, p.fecha_inicio), p.fecha_inicio) + rl.valor::int,
                    least(coalesce(c.fin, p.fecha_fin), p.fecha_fin)) as fecha_limite_efectiva,
           case when c.fecha_limite is not null then 'app'
                when rl.valor is not null then 'regla' else 'fin' end as fecha_limite_fuente) f;

-- Renglones del «Formato general» (y del Excel por monitorista): una toma
-- con los datos de su campaña y su sitio. Las quitadas (cancelada) siguen
-- aquí para que la app decida si las muestra; el Excel lleva solo
-- estado <> 'cancelada'. Las tomas pendientes de un sitio cancelado, fuera
-- de la carga o de una campaña retirada ya no existen (las del plan) o están
-- 'cancelada' con baja_auto (las editadas a mano), así que ese filtro basta
-- (R4, 23-oct-2026); sitio_fuera_de_carga y campana_retirada van para avisar.
create or replace view public.vw_comp_tomas with (security_invoker = on) as
select t.id, t.campana_id, t.sitio_id, t.unidad, c.medio, c.periodo_id, p.etiqueta as periodo_etiqueta,
       c.cliente, c.campana, c.version, c.vendedor, c.administrador, c.quantum, c.mediamonitor,
       c.especificacion, c.arte, c.es_full, c.analista_email, c.estatus as campana_estatus,
       c.retirada as campana_retirada,
       s.sitio_clave, s.sitio_original, s.vendor_face_id, s.site_id, s.espacio_vv, s.en_inventario,
       s.inicio as sitio_inicio, s.fin as sitio_fin, s.tramos as sitio_tramos, s.tipo_venta, s.testigos,
       s.estado as sitio_estado, s.fuera_de_carga as sitio_fuera_de_carga,
       t.fecha, extract(isodow from t.fecha)::int as dia_semana, t.fecha_plan,
       t.horario_texto, t.observaciones, t.notas, t.comprobacion, t.turno,
       t.ruta_id, t.ruta_numero, t.monitorista_email, t.origen, t.estado, t.baja_auto,
       t.editado_por, t.editado_en, t.creado_en
  from public.comp_tomas t
  join public.comp_sitios s on s.id = t.sitio_id
  join public.comp_campanas c on c.id = t.campana_id
  join public.comp_periodos p on p.id = c.periodo_id;

-- Comprobación diaria: reemplaza la hoja COMPROBACIÓN DIARIA. Trae quién
-- lleva la campaña hoy (analista_email) y quién marcó (comprobado_por, el
-- crédito, #4): la app pivotea por el que necesite.
create or replace view public.vw_comp_diaria with (security_invoker = on) as
select c.id as campana_id, c.unidad, c.medio, c.periodo_id, c.analista_email,
       s.comprobado_por, s.comprobado_dia as dia, count(*)::int as sitios
  from public.comp_sitios s join public.comp_campanas c on c.id = s.campana_id
 where s.estado = 'comprobado'
 group by c.id, c.unidad, c.medio, c.periodo_id, c.analista_email, s.comprobado_por, s.comprobado_dia;

-- Avance por persona (#4): la CARGA (campañas, meta, pendientes, vencidas)
-- va por quien lleva la campaña hoy; el CRÉDITO (comprobados, hoy) por quien
-- marcó. Así «pasar lo pendiente» no le suma a B lo que comprobó A.
-- analista_email NULL = «Sin analista».
create or replace view public.vw_comp_avance_analista with (security_invoker = on) as
with carga as (
  select v.unidad, v.periodo_id, v.analista_email as email,
         count(*)::int as campanas,
         (count(*) filter (where v.estatus = 'abierta'))::int as abiertas,
         sum(v.meta)::int as meta,
         sum(v.pendientes)::int as pendientes,
         sum(v.comprobados)::int as comprobados_en_sus_campanas,
         (count(*) filter (where v.estatus = 'abierta' and not v.completa and v.dias_restantes < 0))::int as vencidas
    from public.vw_comp_campanas v
   group by v.unidad, v.periodo_id, v.analista_email
), credito as (
  select c.unidad, c.periodo_id, s.comprobado_por as email,
         count(*)::int as comprobados,
         (count(*) filter (where s.comprobado_dia = (now() at time zone 'America/Mexico_City')::date))::int as hoy
    from public.comp_sitios s join public.comp_campanas c on c.id = s.campana_id
   where s.estado = 'comprobado'
   group by c.unidad, c.periodo_id, s.comprobado_por
)
select coalesce(ca.unidad, cr.unidad) as unidad,
       coalesce(ca.periodo_id, cr.periodo_id) as periodo_id,
       coalesce(ca.email, cr.email) as analista_email,
       coalesce(ca.campanas, 0) as campanas, coalesce(ca.abiertas, 0) as abiertas,
       coalesce(ca.meta, 0) as meta, coalesce(ca.pendientes, 0) as pendientes,
       coalesce(ca.comprobados_en_sus_campanas, 0) as comprobados_en_sus_campanas,
       coalesce(cr.comprobados, 0) as comprobados, coalesce(cr.hoy, 0) as hoy,
       coalesce(ca.vencidas, 0) as vencidas
  from carga ca
  full join credito cr
    on cr.unidad = ca.unidad and cr.periodo_id = ca.periodo_id and cr.email = coalesce(ca.email, '');

revoke all on public.vw_comp_campanas, public.vw_comp_tomas, public.vw_comp_diaria,
  public.vw_comp_avance_analista from anon;
revoke insert, update, delete, truncate on public.vw_comp_campanas, public.vw_comp_tomas, public.vw_comp_diaria,
  public.vw_comp_avance_analista from authenticated;
grant select on public.vw_comp_campanas, public.vw_comp_tomas, public.vw_comp_diaria,
  public.vw_comp_avance_analista to authenticated;

-- ------------------------------------------------------------
-- 5) Internas (sin grant: solo las llaman las RPC security definer).
-- ------------------------------------------------------------

-- Cuántos de p_ids (sitios) NO puede tocar quien llama: campaña cerrada, o
-- no es Supervisor de la unidad ni la analista de la campaña CON el rol
-- vigente en esa unidad (#25).
create or replace function public.comp_sitios_ajenos(p_ids bigint[]) returns int
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  with yo as (
    select lower(coalesce(auth_email(), '')) as email,
           array(select comp_mis_unidades(array['supervisor']::app_role[])) as gest,
           array(select u from unnest(array['Ecovallas', 'Biobox', 'Vía Verde']) u
                  where comp_es_analista_de(auth_email(), u)) as anal)
  select count(*)::int
    from comp_sitios s join comp_campanas c on c.id = s.campana_id, yo
   where s.id = any (p_ids)
     and (c.estatus <> 'abierta'
          or not (c.unidad = any (yo.gest) or (c.analista_email = yo.email and c.unidad = any (yo.anal))))
$$;

-- Lo mismo para tomas.
create or replace function public.comp_tomas_ajenas(p_ids bigint[]) returns int
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  with yo as (
    select lower(coalesce(auth_email(), '')) as email,
           array(select comp_mis_unidades(array['supervisor']::app_role[])) as gest,
           array(select u from unnest(array['Ecovallas', 'Biobox', 'Vía Verde']) u
                  where comp_es_analista_de(auth_email(), u)) as anal)
  select count(*)::int
    from comp_tomas t join comp_campanas c on c.id = t.campana_id, yo
   where t.id = any (p_ids)
     and (c.estatus <> 'abierta'
          or not (c.unidad = any (yo.gest) or (c.analista_email = yo.email and c.unidad = any (yo.anal))))
$$;

-- Ruta y monitorista de un sitio (23-oct-2026). ruta_ubicaciones.site_id es
-- único en toda la tabla; se busca por el site_id del inventario y, si no,
-- por la clave (Ecovallas Digital guarda la forma vendor_face_id). Solo
-- rutas ACTIVAS de la misma unidad y de medio Digital o Combinada.
-- Monitorista: el primero que se asignó a la ruta y que SIGUE teniendo el
-- rol monitorista en la unidad (R12): si nadie lo tiene, NULL («SIN
-- MONITORISTA» en el Excel), nunca alguien que ya no está.
create or replace function public.comp_ruta_sitio(p_unidad text, p_site_id text, p_clave text)
returns table (ruta_id bigint, ruta_numero int, monitorista_email text)
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select r.id, r.numero,
         (select lower(btrim(a.usuario_email)) from ruta_asignaciones a
           where a.ruta_id = r.id and comp_tiene_rol_en(a.usuario_email, 'monitorista', p_unidad)
           order by a.creado_en nulls last, lower(a.usuario_email) limit 1)
    from ruta_ubicaciones ru
    join rutas_monitoreo r on r.id = ru.ruta_id
   where ru.site_id in (p_site_id, p_clave)
     and r.unidad_negocio = p_unidad and r.tipo_medio in ('Digital', 'Combinada') and r.activa
   order by (ru.site_id = p_site_id) desc nulls last, r.id
   limit 1
$$;

-- ¿Alguien ya trabajó en la campaña? (23-oct-2026) Decide si una campaña que
-- se retira se puede borrar o solo se marca: analista puesta o algo editado
-- en la app, un sitio marcado, cancelado o agregado en la app, o una toma
-- editada a mano o que ya no está pendiente.
create or replace function public.comp_campana_con_trabajo(p_id bigint) returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from comp_campanas c
                  where c.id = p_id
                    and (c.asignacion_origen = 'app' or cardinality(c.editado_app) > 0 or c.meta_app is not null
                         or c.fecha_limite is not null or c.entrega_tipo <> 'enviar'))
      or exists (select 1 from comp_sitios s where s.campana_id = p_id and (s.estado <> 'pendiente' or s.origen = 'app'))
      or exists (select 1 from comp_tomas t where t.campana_id = p_id and (t.origen = 'app' or t.estado <> 'pendiente'))
$$;

-- Aplica los planes a un LOTE de campañas abiertas, por conjuntos (revisión
-- del 23-oct-2026: antes iba campaña por campaña, con una tabla temporal y
-- 6 sentencias cada una, y Vía Verde completo en plan diario rozaba el
-- statement_timeout de 8 s). p_plan = el plan ya normalizado para todas;
-- NULL = el que ya tiene cada una. Quien llama ya validó permiso y estatus.
--   1) Tomas editadas a mano (pendientes) de un sitio que salió del plan
--      (cancelado, fuera de la carga, campaña retirada) → 'cancelada' con
--      baja_auto; si el sitio vuelve, regresan a 'pendiente' (R4). Esto
--      corre aunque la campaña no tenga plan.
--   2) Deseado: sitio × fecha del plan dentro de cada ventana del sitio
--      (comp_ventanas: intersección con la campaña y el periodo, por tramo),
--      de los sitios no cancelados que siguen en la carga de campañas no
--      retiradas. Un sitio comprobado conserva sus tomas pero no recibe
--      nuevas, salvo plan.incluir_comprobados (R11).
--   3) Borra las del plan pendientes que ya no van; actualiza las que siguen
--      (horario, ruta, monitorista) sin cambiar su id; inserta las que
--      faltan, salvo que ya haya una toma esa fecha (de cualquier origen) o
--      una editada a mano que salió de esa fecha. Nunca toca las de origen
--      'app' ni las que ya no están pendientes.
--   4) Reporta las campañas sin tomas y las tomas a mano pendientes que
--      quedaron fuera de la vigencia de su sitio (R13), para que se decida.
create or replace function public.comp_aplicar_planes(p_ids bigint[], p_plan jsonb) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_can int := 0; v_reg int := 0; v_nue int := 0; v_bor int := 0; v_act int := 0; v_cons int := 0; v_omit int := 0;
  v_sin bigint[]; v_fuera bigint[];
begin
  -- 1) Editadas a mano de sitios que salieron (o volvieron).
  update comp_tomas t set estado = 'cancelada', baja_auto = true
    from comp_sitios s, comp_campanas c
   where t.campana_id = any (p_ids) and s.id = t.sitio_id and c.id = t.campana_id and c.estatus = 'abierta'
     and t.origen = 'app' and t.estado = 'pendiente'
     and (s.estado = 'cancelado' or s.fuera_de_carga or c.retirada);
  get diagnostics v_can = row_count;
  update comp_tomas t set estado = 'pendiente', baja_auto = false
    from comp_sitios s, comp_campanas c
   where t.campana_id = any (p_ids) and s.id = t.sitio_id and c.id = t.campana_id and c.estatus = 'abierta'
     and t.baja_auto and t.estado = 'cancelada'
     and s.estado <> 'cancelado' and not s.fuera_de_carga and not c.retirada;
  get diagnostics v_reg = row_count;

  -- 2) Campañas con plan y lo deseado.
  drop table if exists pg_temp.comp_ap_cam;
  create temp table comp_ap_cam on commit drop as
  select c.id, c.unidad, c.inicio, c.fin, c.retirada, p.fecha_inicio as p_ini, p.fecha_fin as p_fin,
         coalesce(p_plan, c.plan_tomas) as plan
    from comp_campanas c join comp_periodos p on p.id = c.periodo_id
   where c.id = any (p_ids) and c.estatus = 'abierta' and coalesce(p_plan, c.plan_tomas) is not null;

  drop table if exists pg_temp.comp_ap_sit;
  create temp table comp_ap_sit on commit drop as
  select s.id as sitio_id, c.id as campana_id, c.unidad, s.inicio, s.fin, s.tramos, c.inicio as c_ini, c.fin as c_fin,
         c.p_ini, c.p_fin, c.plan, s.horario_lv, s.horario_sd, s.observaciones,
         (s.estado <> 'comprobado' or coalesce(c.plan->'incluir_comprobados' = 'true'::jsonb, false)) as crea,
         r.ruta_id, r.ruta_numero, r.monitorista_email
    from pg_temp.comp_ap_cam c
    join comp_sitios s on s.campana_id = c.id and s.estado <> 'cancelado' and not s.fuera_de_carga
    left join lateral comp_ruta_sitio(c.unidad, s.site_id, s.sitio_clave) r on true
   where not c.retirada;

  drop table if exists pg_temp.comp_ap_des;
  create temp table comp_ap_des on commit drop as
  select distinct on (x.sitio_id, f.fecha)
         x.sitio_id, x.campana_id, x.unidad, f.fecha, x.crea,
         nullif(btrim(case when extract(isodow from f.fecha) <= 5 then x.horario_lv else x.horario_sd end), '') as horario_texto,
         x.observaciones, x.ruta_id, x.ruta_numero, x.monitorista_email
    from pg_temp.comp_ap_sit x
    cross join lateral comp_ventanas(x.inicio, x.fin, x.tramos, x.c_ini, x.c_fin, x.p_ini, x.p_fin) w
    cross join lateral comp_fechas_plan(x.plan, w.ini, w.fin) as f(fecha)
   order by x.sitio_id, f.fecha;
  create index on pg_temp.comp_ap_des (sitio_id, fecha);
  analyze pg_temp.comp_ap_des;

  -- 3) Borrar, actualizar e insertar (una sentencia cada uno para todo el lote).
  delete from comp_tomas t using pg_temp.comp_ap_cam c
   where t.campana_id = c.id and t.origen = 'plan' and t.estado = 'pendiente'
     and not exists (select 1 from pg_temp.comp_ap_des d where d.sitio_id = t.sitio_id and d.fecha = t.fecha);
  get diagnostics v_bor = row_count;

  update comp_tomas t
     set horario_texto = d.horario_texto, observaciones = d.observaciones,
         ruta_id = d.ruta_id, ruta_numero = d.ruta_numero, monitorista_email = d.monitorista_email
    from pg_temp.comp_ap_des d
   where t.sitio_id = d.sitio_id and t.fecha = d.fecha and t.campana_id = d.campana_id
     and t.origen = 'plan' and t.estado = 'pendiente'
     and (t.horario_texto, t.observaciones, t.ruta_id, t.ruta_numero, t.monitorista_email)
         is distinct from (d.horario_texto, d.observaciones, d.ruta_id, d.ruta_numero, d.monitorista_email);
  get diagnostics v_act = row_count;

  insert into comp_tomas (campana_id, sitio_id, unidad, fecha, fecha_plan, horario_texto, observaciones,
                          ruta_id, ruta_numero, monitorista_email, origen)
  select d.campana_id, d.sitio_id, d.unidad, d.fecha, d.fecha, d.horario_texto, d.observaciones,
         d.ruta_id, d.ruta_numero, d.monitorista_email, 'plan'
    from pg_temp.comp_ap_des d
   where d.crea
     and not exists (select 1 from comp_tomas t
                      where t.sitio_id = d.sitio_id and t.origen = 'app' and t.fecha_plan = d.fecha)
  on conflict (campana_id, sitio_id, fecha) do nothing;
  get diagnostics v_nue = row_count;

  -- 4) Reporte.
  select count(*) into v_omit from pg_temp.comp_ap_des d
   where not d.crea and not exists (select 1 from comp_tomas t where t.sitio_id = d.sitio_id and t.fecha = d.fecha);
  select count(*) into v_cons from comp_tomas t join pg_temp.comp_ap_cam c on c.id = t.campana_id
   where t.origen = 'app' or t.estado <> 'pendiente';
  select array_agg(c.id order by c.id) into v_sin from pg_temp.comp_ap_cam c
   where not exists (select 1 from pg_temp.comp_ap_des d where d.campana_id = c.id);
  select array_agg(t.id order by t.id) into v_fuera
    from comp_tomas t
    join comp_sitios s on s.id = t.sitio_id
    join comp_campanas c on c.id = t.campana_id
    join comp_periodos p on p.id = c.periodo_id
   where t.campana_id = any (p_ids) and c.estatus = 'abierta' and t.origen = 'app' and t.estado = 'pendiente'
     and not exists (select 1 from comp_ventanas(s.inicio, s.fin, s.tramos, c.inicio, c.fin, p.fecha_inicio, p.fecha_fin) w
                      where t.fecha between w.ini and w.fin);

  update comp_campanas c set plan_tomas = x.plan, actualizado_en = now()
    from pg_temp.comp_ap_cam x
   where c.id = x.id and c.plan_tomas is distinct from x.plan;

  return jsonb_build_object('nuevas', v_nue, 'borradas', v_bor, 'actualizadas', v_act, 'conservadas', v_cons,
                            'canceladas_auto', v_can, 'regresadas_auto', v_reg, 'omitidas_comprobados', v_omit,
                            'sin_tomas', to_jsonb(coalesce(v_sin, '{}')),
                            'app_fuera_de_vigencia', to_jsonb(coalesce(v_fuera, '{}')));
end $$;

-- Vuelve a aplicar su plan a las campañas abiertas de p_ids (después de
-- cancelar, restaurar o agregar sitios, de cambiar la vigencia o de una
-- carga) y sincroniza las tomas editadas a mano de sitios que salieron o
-- volvieron. Devuelve las llaves que suman los reportes.
create or replace function public.comp_reaplicar_planes(p_ids bigint[]) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v jsonb;
begin
  if coalesce(cardinality(p_ids), 0) = 0 then
    return jsonb_build_object('tomas_nuevas', 0, 'tomas_borradas', 0, 'tomas_actualizadas', 0,
                              'tomas_canceladas', 0, 'tomas_regresadas', 0, 'tomas_app_fuera_de_vigencia', '[]'::jsonb);
  end if;
  v := comp_aplicar_planes(p_ids, null);
  return jsonb_build_object('tomas_nuevas', v->'nuevas', 'tomas_borradas', v->'borradas',
                            'tomas_actualizadas', v->'actualizadas', 'tomas_canceladas', v->'canceladas_auto',
                            'tomas_regresadas', v->'regresadas_auto',
                            'tomas_app_fuera_de_vigencia', v->'app_fuera_de_vigencia');
end $$;

-- Retira campañas abiertas (23-oct-2026): las que nadie trabajó se borran
-- (con sus sitios y tomas); las demás quedan retiradas y sus tomas
-- pendientes salen del plan. reemplazada_por: la campaña que la sustituye
-- (misma campaña, otra versión, no retirada), solo informativo. Devuelve cuántas se
-- borraron y la lista de lo que pasó con cada una. Quien llama validó
-- permiso, estatus y que no estén ya retiradas.
create or replace function public.comp_retirar(p_ids bigint[]) returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_lista jsonb; v_borradas int := 0; v_marcadas bigint[];
begin
  drop table if exists pg_temp.comp_ret;
  create temp table comp_ret on commit drop as
  select c.id, c.campana, c.version, c.fuente, c.periodo_id, c.medio, c.campana_llave, c.version_llave,
         comp_campana_con_trabajo(c.id) as con_trabajo,
         (select c2.id from comp_campanas c2
           where c2.periodo_id = c.periodo_id and c2.medio = c.medio and c2.campana_llave = c.campana_llave
             and c2.id <> c.id and not c2.retirada and c2.id <> all (p_ids)
           order by c2.id limit 1) as reemplazo
    from comp_campanas c
   where c.id = any (p_ids) and c.estatus = 'abierta' and not c.retirada;
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'campana', r.campana, 'version', r.version, 'fuente', r.fuente,
                                               'borrada', not r.con_trabajo, 'reemplazada_por', r.reemplazo) order by r.id), '[]')
    into v_lista from pg_temp.comp_ret r;
  delete from comp_campanas c using pg_temp.comp_ret r where c.id = r.id and not r.con_trabajo;
  get diagnostics v_borradas = row_count;
  with upd as (
    update comp_campanas c
       set retirada = true, retirada_en = now(), reemplazada_por = r.reemplazo, actualizado_en = now()
      from pg_temp.comp_ret r
     where c.id = r.id and r.con_trabajo
    returning c.id)
  select array_agg(id) into v_marcadas from upd;
  -- Quien llama vuelve a aplicar los planes de las marcadas (sus tomas
  -- pendientes salen y las editadas a mano quedan con baja_auto).
  return jsonb_build_object('borradas', v_borradas, 'lista', v_lista, 'marcadas', to_jsonb(coalesce(v_marcadas, '{}')));
end $$;

-- ------------------------------------------------------------
-- 6) RPC. Todas: security definer, search_path fijo, grant explícito.
--    «Hoy» = día de CDMX. Las que escriben llevan lock_timeout: si otra
--    carga tiene tomadas las filas, se avisa en segundos en vez de esperar
--    al statement_timeout de 8 s (#12).
-- ------------------------------------------------------------

-- a) Cargar campañas del periodo (23-oct-2026). Una sola entrada para la
--    bitácora comercial, Pauta VV, el plano y el alta manual.
--      p_periodo   = {tipo: 'catorcena'|'mes', anio, numero}
--      p_campanas  = [{ fuente, origen_ref, cliente, campana, version, vendedor, administrador,
--                       quantum, mediamonitor, especificacion, arte, inicio, fin, es_full,
--                       full_minutos, analista_email,
--                       sitios: [{ sitio_clave, sitio_original, espacio_vv, inicio, fin,
--                                  horario_lv, horario_sd, tipo_venta, testigos, observaciones }] }]
--    Fechas: 'AAAA-MM-DD' o null; cualquier otra forma rechaza la carga
--    (R6: con DateStyle MDY '05/10/2026' entraba como 10 de mayo).
--    Una campaña de la bitácora con varias versiones = una entrada por
--    versión. Llave: (periodo, medio, comp_llave(campana), comp_llave(version)).
--    Si dos entradas dan la misma llave, los datos de la campaña son los de
--    la primera y sus sitios se juntan. El mismo sitio dos veces en una
--    campaña-versión se junta como juntarSitio() de src/lib/bitacoraComp.ts
--    (vigencia de la primera a la última fecha, el primer horario, VENTA
--    gana a BONUS, testigos si alguno, observaciones sin repetir) y además
--    guarda sus tramos (R10); se reporta en sitios_repetidos.
--    Un sitio cuya ventana no toca el periodo (ni la vigencia de la campaña)
--    no entra y se reporta en sitios_fuera_del_periodo (R5): no contaría en
--    la meta sin poder comprobarse.
--    Idempotente. Nunca pisa: la analista puesta en la app, lo editado en la
--    app (editado_app), las marcas, los cancelados, las campañas cerradas,
--    los sitios agregados en la app ni las tomas editadas o trabajadas.
--    analista_email es una PROPUESTA: entra si la campaña es nueva o su
--    analista vino de una carga, y solo si tiene rol de analista en la unidad.
--    Sin la clave «sitios» (o null), los sitios de esa campaña no se tocan;
--    con una lista (aunque sea vacía), esa es la lista vigente: lo que ya no
--    viene se borra si estaba pendiente y sin tomas trabajadas, y si no, se
--    queda marcado fuera_de_carga.
--    p_completa (R1/R2): true = la llamada es la foto completa del periodo y
--    del medio para las fuentes pauta_vv y plano; las campañas abiertas de
--    esas fuentes que no vienen se retiran (comp_retirar). NULL = se deduce:
--    sí, si todas las entradas son pauta_vv o plano. false = nunca retira
--    (recargar una sola campaña). Con otras fuentes se reportan los
--    posibles_duplicados (misma campaña abierta con otra versión que no
--    vino) y no se tocan.
--    Plano → Pauta VV (23-oct-2026, hallazgo #7 de la revisión de la
--    bitácora): si llega una entrada CON versión de una campaña que en este
--    periodo y medio solo existe como fila del plano con versión ''
--    (abierta y no retirada), esa fila se ADOPTA: toma la versión nueva y
--    sigue con su id, sus sitios marcados, su analista y su plan. Antes se
--    creaba otra fila y la del plano se retiraba (y si alguien ya la había
--    trabajado, quedaba partida en dos). Solo si de esa campaña llega UNA
--    versión y no llega también la del plano ('') en la misma carga; si
--    llegan varias, no se adivina cuál es: la del plano se retira como
--    antes (R2). Se reporta en campanas_adoptadas.
--    Qué entradas adoptan (revisión del 23-oct-2026): las de Pauta VV y las
--    del plano que YA traen versión (desdePautaVV le pone a lo del plano la
--    versión única de Pauta VV, aunque esa versión esté en el otro medio).
--    La bitácora y el alta manual NO adoptan: el plano no se entera y en la
--    siguiente foto volvería a mandar la campaña con versión '', creando
--    otra fila con los mismos sitios. Con ellas queda como antes
--    (posibles_duplicados). Una fila del plano ya retirada tampoco se
--    adopta: revivirla dejaría retirada la versión que la reemplazó, con su
--    trabajo.
--    El plan de tomas se vuelve a aplicar solo a las campañas que cambiaron
--    (sitios nuevos, cambiados o de baja, vigencia, retiro): una recarga
--    igual no rehace miles de tomas (revisión de rendimiento, 23-oct-2026).
--    p_solo_revisar: hace todo y lo deshace; devuelve el mismo reporte (previa).
create or replace function public.comp_cargar_campanas(p_unidad text, p_medio text, p_periodo jsonb,
  p_campanas jsonb, p_solo_revisar boolean default false, p_completa boolean default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_revisar boolean := coalesce(p_solo_revisar, false);
  v_tipo text := p_periodo->>'tipo';
  v_anio int; v_num int; v_ini date; v_fin date; v_etq text; v_pid bigint;
  v_ncam int; v_nsit int; v_mal int; v_mal_txt text; v_todas_vv boolean; v_completa boolean;
  v_rep jsonb; v_tom jsonb; v_lista jsonb; v_ids bigint[]; v_cambio bigint[]; v_x bigint[]; v_ret_ids bigint[];
  v_ret jsonb := jsonb_build_object('borradas', 0, 'lista', '[]'::jsonb, 'marcadas', '[]'::jsonb);
  v_c_nue int := 0; v_c_act int := 0; v_c_dup int := 0; v_app_cons int := 0; v_sin_analista int := 0;
  v_s_nue int := 0; v_s_act int := 0; v_s_baja int := 0; v_s_fuera int := 0;
  v_cerradas jsonb; v_sin_inv jsonb; v_edomex jsonb; v_inactivas jsonb; v_otro_medio jsonb; v_no_rec jsonb;
  v_fuera_per jsonb; v_repetidos jsonb; v_dups jsonb; v_adoptadas jsonb;
begin
  -- 1) Validación y permiso (antes de tocar nada)
  if v_email = '' then
    raise exception 'Sesión sin correo: vuelve a entrar.';
  end if;
  if not ((p_unidad = 'Ecovallas' and p_medio = 'Pantalla') or (p_unidad = 'Biobox' and p_medio = 'Máquina')
       or (p_unidad = 'Vía Verde' and p_medio in ('Columna', 'Pórtico'))) then
    raise exception 'Unidad o medio no válidos: % / %.', p_unidad, p_medio;
  end if;
  if not comp_gestiona(p_unidad) then
    raise exception 'Solo el Supervisor (o el Admin) carga campañas de %.', comp_etiqueta_unidad(p_unidad);
  end if;
  if jsonb_typeof(p_campanas) is distinct from 'array' or jsonb_array_length(p_campanas) = 0 then
    raise exception 'No hay campañas que cargar.';
  end if;
  v_ncam := jsonb_array_length(p_campanas);
  select count(*) into v_mal from jsonb_array_elements(p_campanas) e where jsonb_typeof(e) <> 'object';
  if v_mal > 0 then
    raise exception 'La lista de campañas viene mal armada. No se cargó nada.';
  end if;
  select coalesce(sum(case when jsonb_typeof(e->'sitios') = 'array' then jsonb_array_length(e->'sitios') else 0 end), 0)
    into v_nsit from jsonb_array_elements(p_campanas) e;
  -- Vía Verde completo son ~250 campañas-versión y ~3,200 sitios.
  if v_ncam > 1000 or v_nsit > 20000 then
    raise exception 'Demasiado para una carga (% campañas, % sitios). Revisa que sea de un solo periodo.', v_ncam, v_nsit;
  end if;

  select count(*), string_agg(n::text, ', ' order by n) into v_mal, v_mal_txt
    from (select o.n from jsonb_array_elements(p_campanas) with ordinality o(e, n)
           where nullif(btrim(o.e->>'campana'), '') is null
              or coalesce(o.e->>'fuente', '') not in ('bitacora', 'pauta_vv', 'plano', 'manual')
              or (o.e->>'fuente' in ('pauta_vv', 'plano') and p_unidad <> 'Vía Verde')
              or coalesce(jsonb_typeof(o.e->'sitios'), 'null') not in ('array', 'null')
           limit 20) x;
  if v_mal > 0 then
    raise exception 'Hay campañas sin nombre, sin fuente válida o con los sitios mal armados (posiciones %). No se cargó nada.', v_mal_txt;
  end if;
  -- Un sitio sin clave rechaza la carga (#8): nunca se convierte en otra cosa.
  select count(*) into v_mal
    from jsonb_array_elements(p_campanas) e
    cross join lateral jsonb_array_elements(case when jsonb_typeof(e->'sitios') = 'array' then e->'sitios' else '[]'::jsonb end) s
   where jsonb_typeof(s) <> 'object' or comp_clave_sitio(s->>'sitio_clave') is null;
  if v_mal > 0 then
    raise exception '% sitio(s) vienen sin clave. No se cargó nada.', v_mal;
  end if;
  -- Fechas solo 'AAAA-MM-DD' (R6). La forma se revisa aquí; un día que no
  -- existe ('2026-13-45') lo rechaza la conversión más abajo.
  select count(*), string_agg(n::text, ', ' order by n) into v_mal, v_mal_txt
    from (select o.n from jsonb_array_elements(p_campanas) with ordinality o(e, n)
           where exists (
                   select 1
                     from (select o.e->'inicio' as x union all select o.e->'fin'
                           union all
                           select s->'inicio' from jsonb_array_elements(case when jsonb_typeof(o.e->'sitios') = 'array'
                                                                             then o.e->'sitios' else '[]'::jsonb end) s
                           union all
                           select s->'fin' from jsonb_array_elements(case when jsonb_typeof(o.e->'sitios') = 'array'
                                                                          then o.e->'sitios' else '[]'::jsonb end) s) f
                    where f.x is not null and jsonb_typeof(f.x) <> 'null'
                      and (jsonb_typeof(f.x) <> 'string' or (f.x #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
           limit 20) x;
  if v_mal > 0 then
    raise exception 'Hay fechas que no vienen como AAAA-MM-DD (campañas en las posiciones %). No se cargó nada.', v_mal_txt;
  end if;

  -- ¿Foto completa? (R1/R2)
  select bool_and(e->>'fuente' in ('pauta_vv', 'plano')) into v_todas_vv from jsonb_array_elements(p_campanas) e;
  if p_completa and not v_todas_vv then
    raise exception 'Solo una carga de Pauta VV o del plano es la foto completa del periodo; la bitácora y el alta manual no.';
  end if;
  v_completa := coalesce(p_completa, v_todas_vv);

  -- 2) Periodo
  begin
    v_anio := (p_periodo->>'anio')::int;
    v_num := (p_periodo->>'numero')::int;
  exception when others then
    raise exception 'Periodo no válido: %.', p_periodo;
  end;
  if v_anio is null or v_num is null then
    raise exception 'Periodo no válido: %.', p_periodo;
  end if;
  if (p_unidad = 'Ecovallas') <> (v_tipo is not distinct from 'catorcena') then
    raise exception 'Ecovallas Digital va por catorcena; Biobox y Vía Verde, por mes.';
  end if;
  if v_tipo = 'catorcena' then
    select fecha_inicio, fecha_fin into v_ini, v_fin from catorcenas where anio = v_anio and numero = v_num;
    if not found then
      raise exception 'La Cat-% de % no está en el calendario.', v_num, v_anio;
    end if;
    if v_ini is null or v_fin is null or v_fin < v_ini then   -- #26
      raise exception 'La Cat-% de % no tiene fechas válidas en el calendario.', v_num, v_anio;
    end if;
    v_etq := 'Cat-' || v_num || ' · ' || v_anio;
  elsif v_tipo = 'mes' and v_num between 1 and 12 and v_anio between 2020 and 2100 then
    v_ini := make_date(v_anio, v_num, 1);
    v_fin := (v_ini + interval '1 month')::date - 1;
    v_etq := (array['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre',
                    'Octubre', 'Noviembre', 'Diciembre'])[v_num] || ' ' || v_anio;
  else
    raise exception 'Periodo no válido: %.', p_periodo;
  end if;

  -- Una carga a la vez por unidad y periodo (Columnas y Pórticos comparten periodo).
  perform pg_advisory_xact_lock(hashtext('comp_cargar_campanas'),
                                hashtext(p_unidad || '|' || v_tipo || '|' || v_anio || '|' || v_num));

  begin  -- ===== todo lo de este bloque se deshace en modo «solo revisar» =====
    insert into comp_periodos (unidad, tipo, anio, numero, fecha_inicio, fecha_fin, etiqueta, creado_por)
    values (p_unidad, v_tipo, v_anio, v_num, v_ini, v_fin, v_etq, v_email)
    on conflict (unidad, tipo, anio, numero) do update
      set fecha_inicio = excluded.fecha_inicio, fecha_fin = excluded.fecha_fin, etiqueta = excluded.etiqueta
    returning id into v_pid;

    -- Entrada → tablas temporales. Un tipo que no se entiende (fecha,
    -- número, sí/no) rechaza la carga con un mensaje claro.
    begin
      drop table if exists pg_temp.comp_car_cam;
      create temp table comp_car_cam on commit drop as
      select (o.n - 1)::int as i, x.*,
             comp_llave(x.campana) as cl, comp_llave(coalesce(x.version, '')) as vl,
             lower(nullif(btrim(x.analista_email), '')) as analista_in,
             coalesce(comp_es_analista_de(nullif(btrim(x.analista_email), ''), p_unidad), false) as analista_ok,
             jsonb_typeof(o.e->'sitios') = 'array' as trae_sitios,
             o.e->'sitios' as sitios_json
        from jsonb_array_elements(p_campanas) with ordinality o(e, n),
             jsonb_to_record(o.e) as x(fuente text, origen_ref text, cliente text, campana text, version text,
               vendedor text, administrador text, quantum text, mediamonitor boolean, especificacion text,
               arte text, inicio date, fin date, es_full boolean, full_minutos int, analista_email text);

      drop table if exists pg_temp.comp_car_sit0;
      create temp table comp_car_sit0 on commit drop as
      select t.i, (o.n - 1)::int as j, y.*
        from pg_temp.comp_car_cam t
        cross join lateral jsonb_array_elements(case when t.trae_sitios then t.sitios_json else '[]'::jsonb end)
             with ordinality o(e, n)
        cross join lateral jsonb_to_record(o.e) as y(sitio_clave text, sitio_original text, espacio_vv text,
               inicio date, fin date, horario_lv text, horario_sd text, tipo_venta text, testigos boolean,
               observaciones text);
    exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation
                   or numeric_value_out_of_range or invalid_parameter_value then
      raise exception 'Hay una fecha, un número o un sí/no que no se entiende (%). No se cargó nada.', sqlerrm;
    end;

    select string_agg(distinct t.campana, ', ') into v_mal_txt
      from pg_temp.comp_car_cam t where t.fin < t.inicio;
    if v_mal_txt is not null then
      raise exception 'La vigencia termina antes de empezar en: %. No se cargó nada.', v_mal_txt;
    end if;
    select string_agg(distinct t.campana || ' · ' || x.sitio_clave, ', ') into v_mal_txt
      from pg_temp.comp_car_sit0 x join pg_temp.comp_car_cam t on t.i = x.i where x.fin < x.inicio;
    if v_mal_txt is not null then
      raise exception 'La vigencia del sitio termina antes de empezar en: %. No se cargó nada.', v_mal_txt;
    end if;

    select count(*) - count(distinct (cl, vl)) into v_c_dup from pg_temp.comp_car_cam;

    -- Plano → Pauta VV (23-oct-2026): la fila del plano (versión '') se
    -- adopta cuando llega la misma campaña con UNA versión. Va antes de
    -- comp_car_antes para que la adoptada cuente como campaña que ya
    -- existía (no nueva) y el upsert de abajo la encuentre por su llave
    -- nueva y la actualice con los datos de Pauta VV.
    -- Revisión del 23-oct-2026: (a) cuenta TODA entrada con versión, venga
    -- de Pauta VV o del plano (desdePautaVV manda lo del plano con la
    -- versión única de la campaña aunque esa versión esté en el otro
    -- medio; antes eso no adoptaba y la campaña quedaba partida); (b) exige
    -- que alguna sea de Pauta VV o del plano: la bitácora y el alta manual
    -- no adoptan, porque el plano seguiría mandando la '' y la siguiente
    -- foto crearía otra fila con los mismos sitios; (c) nunca una fila
    -- retirada: revivirla dejaría retirada la versión que la reemplazó.
    drop table if exists pg_temp.comp_car_adop;
    create temp table comp_car_adop on commit drop as
    with una as (   -- campañas que llegan con UNA sola versión no vacía
      select t.cl, min(t.vl) as vl
        from pg_temp.comp_car_cam t
       where t.vl <> ''
       group by t.cl
      having count(distinct t.vl) = 1 and bool_or(t.fuente in ('pauta_vv', 'plano')))
    select c.id, u.cl, u.vl,
           (select btrim(coalesce(t.version, '')) from pg_temp.comp_car_cam t
             where t.cl = u.cl and t.vl = u.vl order by (t.fuente = 'pauta_vv') desc, t.i limit 1) as version
      from una u
      join comp_campanas c on c.periodo_id = v_pid and c.medio = p_medio and c.campana_llave = u.cl
                          and c.version_llave = '' and c.fuente = 'plano' and c.estatus = 'abierta'
                          and not c.retirada
     where not exists (select 1 from pg_temp.comp_car_cam t where t.cl = u.cl and t.vl = '')
       and not exists (select 1 from comp_campanas c2
                        where c2.periodo_id = v_pid and c2.medio = p_medio
                          and c2.campana_llave = u.cl and c2.version_llave = u.vl);
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'campana', c.campana, 'version_antes', c.version,
                                                 'version', a.version) order by c.campana), '[]')
      into v_adoptadas
      from pg_temp.comp_car_adop a join comp_campanas c on c.id = a.id;
    update comp_campanas c set version = a.version, version_llave = a.vl, actualizado_en = now()
      from pg_temp.comp_car_adop a
     where c.id = a.id;

    -- Analista puesta en la app que la carga habría cambiado (se reporta).
    -- Va DESPUÉS de la adopción (revisión del 23-oct-2026): la fila adoptada
    -- ya tiene su llave nueva y también cuenta.
    select count(*) into v_app_cons
      from (select distinct on (t.cl, t.vl) t.* from pg_temp.comp_car_cam t order by t.cl, t.vl, t.i) t
      join comp_campanas c on c.periodo_id = v_pid and c.medio = p_medio
                          and c.campana_llave = t.cl and c.version_llave = t.vl
     where c.estatus = 'abierta' and c.asignacion_origen = 'app' and t.analista_ok
       and c.analista_email is distinct from t.analista_in;

    -- Cómo estaban las campañas que vienen (para saber si cambió su vigencia
    -- o si regresan de estar retiradas).
    drop table if exists pg_temp.comp_car_antes;
    create temp table comp_car_antes on commit drop as
    select c.id, c.inicio, c.fin, c.retirada
      from comp_campanas c
     where c.periodo_id = v_pid and c.medio = p_medio
       and (c.campana_llave, c.version_llave) in (select t.cl, t.vl from pg_temp.comp_car_cam t);

    -- 3) Campañas. Las cerradas no se tocan (#7): el WHERE del do update las
    --    salta. La analista de la app y lo editado en la app (#5) no se pisan.
    --    Una retirada que vuelve a venir deja de estar retirada.
    drop table if exists pg_temp.comp_car_up;
    create temp table comp_car_up (id bigint, nueva boolean) on commit drop;
    with src as (
      select distinct on (t.cl, t.vl) t.*,
             -- REPITE: quien llevó la misma campaña en otro periodo (sugerencia).
             case when not t.analista_ok then
               (select c2.analista_email from comp_campanas c2 join comp_periodos p2 on p2.id = c2.periodo_id
                 where c2.unidad = p_unidad and c2.campana_llave = t.cl and c2.periodo_id <> v_pid
                   and c2.analista_email is not null
                 order by p2.fecha_inicio desc, c2.id desc limit 1) end as sugerido
        from pg_temp.comp_car_cam t
       order by t.cl, t.vl, t.i
    ), up as (
      insert into comp_campanas as c (periodo_id, unidad, medio, fuente, origen_ref, cliente, campana, version,
             campana_llave, version_llave, vendedor, administrador, quantum, mediamonitor, especificacion, arte,
             inicio, fin, es_full, full_minutos, meta_full, analista_email, asignacion_origen, sugerido_email,
             cargado_por, cargado_en)
      select v_pid, p_unidad, p_medio, s.fuente, nullif(btrim(s.origen_ref), ''), nullif(btrim(s.cliente), ''),
             btrim(s.campana), btrim(coalesce(s.version, '')), s.cl, s.vl,
             nullif(btrim(s.vendedor), ''), nullif(btrim(s.administrador), ''), nullif(btrim(s.quantum), ''),
             s.mediamonitor, nullif(btrim(s.especificacion), ''),
             case when upper(btrim(s.arte)) in ('NUEVO', 'REPITE') then upper(btrim(s.arte)) end,
             -- FULL solo en Vía Verde (Erik, 23-oct-2026); fuera, un es_full
             -- de la carga se ignora.
             s.inicio, s.fin, coalesce(s.es_full, false) and p_unidad = 'Vía Verde',
             case when s.full_minutos >= 0 then s.full_minutos end,
             case when coalesce(s.es_full, false) and p_unidad = 'Vía Verde'
                  then comp_meta_full_propuesta(p_medio, s.full_minutos) end,
             case when s.analista_ok then s.analista_in end,
             case when s.analista_ok then 'archivo' end,
             s.sugerido, v_email, now()
        from src s
      on conflict (periodo_id, medio, campana_llave, version_llave) do update set
        fuente = excluded.fuente, origen_ref = excluded.origen_ref,
        campana = excluded.campana, version = excluded.version,
        -- es_full corregido en la app no lo pisa la recarga (23-oct-2026,
        -- hallazgo #9: el FULL con rotación que la app no reconoce).
        es_full = case when 'es_full' = any (c.editado_app) then c.es_full else excluded.es_full end,
        cliente = case when 'cliente' = any (c.editado_app) then c.cliente else excluded.cliente end,
        vendedor = case when 'vendedor' = any (c.editado_app) then c.vendedor else excluded.vendedor end,
        administrador = case when 'administrador' = any (c.editado_app) then c.administrador else excluded.administrador end,
        quantum = case when 'quantum' = any (c.editado_app) then c.quantum else excluded.quantum end,
        mediamonitor = case when 'mediamonitor' = any (c.editado_app) then c.mediamonitor else excluded.mediamonitor end,
        especificacion = case when 'especificacion' = any (c.editado_app) then c.especificacion else excluded.especificacion end,
        arte = case when 'arte' = any (c.editado_app) then c.arte else excluded.arte end,
        inicio = case when 'inicio' = any (c.editado_app) then c.inicio else excluded.inicio end,
        fin = case when 'fin' = any (c.editado_app) then c.fin else excluded.fin end,
        full_minutos = case when 'full_minutos' = any (c.editado_app) then c.full_minutos else excluded.full_minutos end,
        meta_full = case when 'meta_full' = any (c.editado_app) then c.meta_full
                         when case when 'es_full' = any (c.editado_app) then c.es_full else excluded.es_full end
                              and c.unidad = 'Vía Verde'
                           then comp_meta_full_propuesta(c.medio, case when 'full_minutos' = any (c.editado_app)
                                                                       then c.full_minutos else excluded.full_minutos end)
                         else null end,
        analista_email = case when c.asignacion_origen = 'app' or excluded.analista_email is null
                              then c.analista_email else excluded.analista_email end,
        asignacion_origen = case when c.asignacion_origen = 'app' or excluded.analista_email is null
                                 then c.asignacion_origen else excluded.asignacion_origen end,
        sugerido_email = excluded.sugerido_email,
        retirada = false, retirada_en = null, reemplazada_por = null,
        cargado_por = excluded.cargado_por, cargado_en = now(), actualizado_en = now()
      where c.estatus = 'abierta'
      returning c.id, (xmax = 0) as nueva)
    insert into pg_temp.comp_car_up select u.id, u.nueva from up u;
    select count(*) filter (where nueva), count(*) filter (where not nueva) into v_c_nue, v_c_act from pg_temp.comp_car_up;

    -- Mapa entrada → campaña (también las cerradas, para el reporte).
    drop table if exists pg_temp.comp_car_map;
    create temp table comp_car_map on commit drop as
    select t.i, c.id as campana_id, c.estatus, c.campana, c.version, coalesce(t.trae_sitios, false) as trae_sitios
      from pg_temp.comp_car_cam t
      join comp_campanas c on c.periodo_id = v_pid and c.medio = p_medio
                          and c.campana_llave = t.cl and c.version_llave = t.vl;

    select coalesce(jsonb_agg(distinct m.campana || case when m.version <> '' then ' / ' || m.version else '' end), '[]')
      into v_cerradas from pg_temp.comp_car_map m where m.estatus = 'cerrada';

    -- Campañas que cambiaron: nuevas, con otra vigencia o que regresan.
    select array_agg(u.id) into v_cambio
      from pg_temp.comp_car_up u
      join comp_campanas c on c.id = u.id
      left join pg_temp.comp_car_antes a on a.id = u.id
     where u.nueva or a.id is null or a.retirada
        or (a.inicio, a.fin) is distinct from (c.inicio, c.fin);

    -- 4) Sitios de las campañas ABIERTAS, cruzados con inventario de la
    --    unidad (#11; Ecovallas: solo caras Digital) y, en Vía Verde, con
    --    vv_espacios: EDO MEX (#2), inactivas y del otro medio no entran.
    --    Una clave sin inventario entra con en_inventario = false.
    drop table if exists pg_temp.comp_car_sit1;
    create temp table comp_car_sit1 on commit drop as
    select m.campana_id, x.i, x.j, k.clave, k.esp, i.vendor_face_id as inv_vfid, i.site_id,
           coalesce(nullif(btrim(x.sitio_original), ''), btrim(x.sitio_clave)) as sitio_original,
           x.inicio, x.fin, nullif(btrim(x.horario_lv), '') as horario_lv, nullif(btrim(x.horario_sd), '') as horario_sd,
           case when upper(btrim(x.tipo_venta)) in ('VENTA', 'BONUS') then upper(btrim(x.tipo_venta)) end as tipo_venta,
           x.testigos, nullif(btrim(x.observaciones), '') as observaciones,
           case when p_unidad = 'Vía Verde'
                     and (k.clave ~ '^MX_EM_' or coalesce(ve.tramo, '') ilike 'EDO MEX%') then 'edo_mex'
                when ve.clave is not null and not ve.activo then 'inactiva'
                when p_unidad = 'Vía Verde'
                     and coalesce(ve.tipo_espacio = 'portico', k.esp ~ '^POR_') <> (p_medio = 'Pórtico') then 'otro_medio'
           end as omitida
      from pg_temp.comp_car_sit0 x
      join pg_temp.comp_car_map m on m.i = x.i and m.estatus = 'abierta'
      cross join lateral (
        select comp_clave_sitio(x.sitio_clave) as clave,
               case when p_unidad = 'Vía Verde'
                    then coalesce(comp_clave_sitio(x.espacio_vv), comp_espacio_vv(x.sitio_clave)) end as esp) k
      left join inventario i on i.vendor_face_id = k.clave and i.unidad_negocio = p_unidad
                            and (p_unidad <> 'Ecovallas' or i.tipo_medio = 'Digital')
      left join vv_espacios ve on p_unidad = 'Vía Verde' and ve.clave = k.esp;

    -- Un renglón por (campaña, sitio), como juntarSitio() del TS, con tramos.
    drop table if exists pg_temp.comp_car_sit;
    create temp table comp_car_sit on commit drop as
    with g as (
      select x.campana_id, x.clave, count(*)::int as renglones,
             (array_agg(x.sitio_original order by x.i, x.j))[1] as sitio_original,
             (array_agg(x.esp order by x.i, x.j))[1] as espacio_vv,
             (array_agg(x.inv_vfid order by x.i, x.j))[1] as inv_vfid,
             (array_agg(x.site_id order by x.i, x.j))[1] as site_id,
             case when bool_and(x.inicio is not null) then min(x.inicio) end as inicio,
             case when bool_and(x.fin is not null) then max(x.fin) end as fin,
             array_agg(x.inicio order by x.i, x.j) as inis, array_agg(x.fin order by x.i, x.j) as fins,
             (array_agg(x.horario_lv order by x.i, x.j) filter (where x.horario_lv is not null))[1] as horario_lv,
             (array_agg(x.horario_sd order by x.i, x.j) filter (where x.horario_sd is not null))[1] as horario_sd,
             case when bool_or(x.tipo_venta = 'VENTA') then 'VENTA'
                  else (array_agg(x.tipo_venta order by x.i, x.j) filter (where x.tipo_venta is not null))[1] end as tipo_venta,
             bool_or(x.testigos) as testigos,
             array_agg(x.observaciones order by x.i, x.j) filter (where x.observaciones is not null) as obs,
             (array_agg(x.omitida order by x.i, x.j))[1] as omitida
        from pg_temp.comp_car_sit1 x
       group by x.campana_id, x.clave)
    select g.campana_id, g.clave as sitio_clave, g.renglones, g.sitio_original, g.espacio_vv, g.inv_vfid, g.site_id,
           g.inicio, g.fin,
           case when (select count(distinct (a, b)) from unnest(g.inis, g.fins) u(a, b)) > 1 then
             (select jsonb_agg(jsonb_build_object('inicio', z.a, 'fin', z.b) order by z.a nulls first, z.b nulls last)
                from (select distinct a, b from unnest(g.inis, g.fins) u(a, b)) z) end as tramos,
           g.horario_lv, g.horario_sd, g.tipo_venta, g.testigos,
           (select string_agg(z.o, ' · ' order by z.p)
              from (select o, min(p) as p from unnest(g.obs) with ordinality u(o, p) group by o) z) as observaciones,
           g.omitida
      from g;

    -- Fuera del periodo (R5): ningún tramo toca la vigencia de la campaña y
    -- el periodo. No entra (si ya estaba, se va como cualquier baja).
    update pg_temp.comp_car_sit t set omitida = 'fuera_periodo'
      from comp_campanas c
     where c.id = t.campana_id and t.omitida is null
       and not exists (select 1 from comp_ventanas(t.inicio, t.fin, t.tramos, c.inicio, c.fin, v_ini, v_fin));

    select coalesce(jsonb_agg(distinct sitio_clave) filter (where omitida = 'edo_mex'), '[]'),
           coalesce(jsonb_agg(distinct sitio_clave) filter (where omitida = 'inactiva'), '[]'),
           coalesce(jsonb_agg(distinct sitio_clave) filter (where omitida = 'otro_medio'), '[]'),
           coalesce(jsonb_agg(distinct sitio_clave) filter (where omitida is null and inv_vfid is null), '[]'),
           coalesce(jsonb_agg(distinct sitio_clave) filter (where omitida = 'fuera_periodo'), '[]')
      into v_edomex, v_inactivas, v_otro_medio, v_sin_inv, v_fuera_per
      from pg_temp.comp_car_sit;
    select coalesce(jsonb_agg(jsonb_build_object('campana', c.campana, 'version', c.version, 'sitio_clave', t.sitio_clave,
                                                 'renglones', t.renglones, 'tramos', t.tramos)
                              order by c.campana, c.version, t.sitio_clave), '[]')
      into v_repetidos
      from pg_temp.comp_car_sit t join comp_campanas c on c.id = t.campana_id
     where t.renglones > 1 and t.omitida is null;

    -- Nuevos: insert ... do nothing (no bloquea las filas que ya existen).
    with ins as (
      insert into comp_sitios (campana_id, unidad, sitio_clave, sitio_original, vendor_face_id, site_id, espacio_vv,
                               en_inventario, inicio, fin, tramos, horario_lv, horario_sd, tipo_venta, testigos,
                               observaciones, origen)
      select t.campana_id, p_unidad, t.sitio_clave, t.sitio_original, t.inv_vfid, t.site_id, t.espacio_vv,
             t.inv_vfid is not null, t.inicio, t.fin, t.tramos, t.horario_lv, t.horario_sd, t.tipo_venta, t.testigos,
             t.observaciones, 'carga'
        from pg_temp.comp_car_sit t
       where t.omitida is null
      on conflict (campana_id, sitio_clave) do nothing
      returning campana_id)
    select count(*), array_agg(distinct campana_id) into v_s_nue, v_x from ins;
    v_cambio := coalesce(v_cambio, '{}') || coalesce(v_x, '{}');

    -- Existentes: solo se tocan las filas que cambian (#12). NUNCA estado,
    -- comprobado_* ni cancelado_*.
    with upd as (
      update comp_sitios s
         set sitio_original = t.sitio_original, vendor_face_id = t.inv_vfid, site_id = t.site_id,
             espacio_vv = t.espacio_vv, en_inventario = (t.inv_vfid is not null),
             inicio = t.inicio, fin = t.fin, tramos = t.tramos, horario_lv = t.horario_lv, horario_sd = t.horario_sd,
             tipo_venta = t.tipo_venta, testigos = t.testigos, observaciones = t.observaciones,
             fuera_de_carga = false, actualizado_en = now()
        from pg_temp.comp_car_sit t
       where t.omitida is null and s.campana_id = t.campana_id and s.sitio_clave = t.sitio_clave
         and (s.sitio_original, s.vendor_face_id, s.site_id, s.espacio_vv, s.en_inventario, s.inicio, s.fin, s.tramos,
              s.horario_lv, s.horario_sd, s.tipo_venta, s.testigos, s.observaciones, s.fuera_de_carga)
             is distinct from
             (t.sitio_original, t.inv_vfid, t.site_id, t.espacio_vv, t.inv_vfid is not null, t.inicio, t.fin, t.tramos,
              t.horario_lv, t.horario_sd, t.tipo_venta, t.testigos, t.observaciones, false)
      returning s.campana_id)
    select count(*), array_agg(distinct campana_id) into v_s_act, v_x from upd;
    v_cambio := v_cambio || coalesce(v_x, '{}');

    -- 5) Bajas, solo en campañas abiertas que trajeron su lista de sitios y
    --    solo de sitios de la carga (los agregados en la app se quedan).
    --    Anti-join contra lo que llegó (#12). Se borra solo lo pendiente sin
    --    tomas editadas ni trabajadas; lo demás queda fuera_de_carga.
    drop table if exists pg_temp.comp_car_baja;
    create temp table comp_car_baja on commit drop as
    select s.id, s.campana_id, s.fuera_de_carga as ya_fuera,
           (s.estado = 'pendiente'
            and not exists (select 1 from comp_tomas t
                             where t.sitio_id = s.id and (t.origen = 'app' or t.estado <> 'pendiente'))) as borrar
      from comp_sitios s
      join (select distinct mm.campana_id from pg_temp.comp_car_map mm
             where mm.estatus = 'abierta' and mm.trae_sitios) m on m.campana_id = s.campana_id
     where s.origen = 'carga'
       and not exists (select 1 from pg_temp.comp_car_sit t
                        where t.omitida is null and t.campana_id = s.campana_id and t.sitio_clave = s.sitio_clave);
    delete from comp_sitios s using pg_temp.comp_car_baja b where s.id = b.id and b.borrar;
    get diagnostics v_s_baja = row_count;
    update comp_sitios s set fuera_de_carga = true, actualizado_en = now()
      from pg_temp.comp_car_baja b
     where s.id = b.id and not b.borrar and not s.fuera_de_carga;
    select count(*) into v_s_fuera from pg_temp.comp_car_baja b where not b.borrar;
    select v_cambio || coalesce(array_agg(distinct b.campana_id), '{}') into v_cambio
      from pg_temp.comp_car_baja b where b.borrar or not b.ya_fuera;

    -- 5b) Foto completa (R1/R2): las campañas abiertas de Pauta VV / plano
    --     del periodo y medio que ya no vienen se retiran.
    if v_completa then
      select array_agg(c.id order by c.id) into v_ret_ids
        from comp_campanas c
       where c.periodo_id = v_pid and c.medio = p_medio and c.estatus = 'abierta' and not c.retirada
         and c.fuente in ('pauta_vv', 'plano')
         and not exists (select 1 from pg_temp.comp_car_map m where m.campana_id = c.id);
      if v_ret_ids is not null then
        v_ret := comp_retirar(v_ret_ids);
        select v_cambio || coalesce(array_agg(x::bigint), '{}') into v_cambio
          from jsonb_array_elements_text(v_ret->'marcadas') x;
      end if;
    end if;
    -- Posibles duplicados: la misma campaña abierta con OTRA versión que no
    -- vino (p. ej. «V1» y «VERSION 1» en dos bitácoras). No se tocan.
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'campana', c.campana, 'version', c.version,
                                                 'fuente', c.fuente) order by c.campana, c.version), '[]')
      into v_dups
      from comp_campanas c
     where c.periodo_id = v_pid and c.medio = p_medio and c.estatus = 'abierta' and not c.retirada
       and c.campana_llave in (select t.cl from pg_temp.comp_car_cam t)
       and not exists (select 1 from pg_temp.comp_car_map m where m.campana_id = c.id);

    -- 6) Plan: solo las campañas que cambiaron y lo tienen (o tienen tomas a
    --    mano que sincronizar). Lo editado a mano no se toca.
    select array_agg(distinct x) into v_cambio from unnest(v_cambio) x
     where exists (select 1 from comp_campanas c where c.id = x and c.estatus = 'abierta');
    v_tom := comp_reaplicar_planes(coalesce(v_cambio, '{}'));

    select array_agg(distinct m.campana_id) into v_ids from pg_temp.comp_car_map m where m.estatus = 'abierta';
    select coalesce(jsonb_agg(distinct t.analista_in), '[]') into v_no_rec
      from pg_temp.comp_car_cam t where t.analista_in is not null and not t.analista_ok;
    select count(*) into v_sin_analista
      from comp_campanas c where c.id = any (coalesce(v_ids, '{}')) and c.analista_email is null;
    select coalesce(jsonb_agg(jsonb_build_object(
             'i', m.i, 'id', case when v_revisar then null else m.campana_id end,
             'campana', m.campana, 'version', m.version, 'estatus', m.estatus,
             'nueva', coalesce(u.nueva, false)) order by m.i), '[]')
      into v_lista
      from pg_temp.comp_car_map m left join pg_temp.comp_car_up u on u.id = m.campana_id;

    v_rep := jsonb_build_object(
      'periodo_id', case when v_revisar then null else v_pid end, 'periodo', v_etq,
      'periodo_inicio', v_ini, 'periodo_fin', v_fin, 'unidad', p_unidad, 'medio', p_medio,
      'completa', v_completa,
      'campanas_recibidas', v_ncam, 'campanas_duplicadas', v_c_dup,
      'campanas_nuevas', v_c_nue, 'campanas_actualizadas', v_c_act, 'cerradas_sin_tocar', v_cerradas,
      'campanas_retiradas', case when v_revisar
                                 then (select coalesce(jsonb_agg(e || jsonb_build_object('reemplazada_por', null)), '[]')
                                         from jsonb_array_elements(v_ret->'lista') e)
                                 else v_ret->'lista' end,
      'campanas_borradas', (v_ret->>'borradas')::int,
      'posibles_duplicados', v_dups,
      'campanas_adoptadas', v_adoptadas,
      'analista_de_la_app_conservada', v_app_cons,
      'sitios_recibidos', v_nsit, 'sitios_nuevos', v_s_nue, 'sitios_actualizados', v_s_act,
      'sitios_baja', v_s_baja, 'sitios_fuera_de_carga', v_s_fuera,
      'sin_inventario', v_sin_inv, 'edo_mex_omitidas', v_edomex, 'inactivas_omitidas', v_inactivas,
      'otro_medio_omitidas', v_otro_medio, 'sitios_fuera_del_periodo', v_fuera_per,
      'sitios_repetidos', v_repetidos,
      'campanas_replanificadas', coalesce(cardinality(v_cambio), 0),
      'tomas_nuevas', (v_tom->>'tomas_nuevas')::int, 'tomas_borradas', (v_tom->>'tomas_borradas')::int,
      'tomas_actualizadas', (v_tom->>'tomas_actualizadas')::int,
      'tomas_canceladas', (v_tom->>'tomas_canceladas')::int, 'tomas_regresadas', (v_tom->>'tomas_regresadas')::int,
      'tomas_app_fuera_de_vigencia', v_tom->'tomas_app_fuera_de_vigencia',
      'analistas_no_reconocidos', v_no_rec, 'sin_analista', v_sin_analista,
      'campanas', v_lista);

    insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
    values ('cargar', p_unidad, v_pid, v_ids, v_ncam, v_rep - 'campanas', v_email);

    if v_revisar then
      raise exception using errcode = 'P0C01', message = 'solo revisar';
    end if;
  exception when sqlstate 'P0C01' then
    null;  -- Postgres deshizo el bloque; v_rep (variable) conserva el reporte
  end;
  return v_rep || jsonb_build_object('solo_revisar', v_revisar);
end $$;

-- b) Generar las tomas con un plan, para una campaña o en lote
--    (23-oct-2026). Solo el Supervisor (o el manager).
--    p_plan = {tipo: 'inicio'|'inicio_fin'|'cada_n'|'diario'|'fechas', cada_n, fechas}.
--    p_plan NULL = volver a aplicar el plan que ya tiene cada campaña.
--    Guarda el plan en comp_campanas.plan_tomas. Al regenerar borra solo las
--    tomas del plan que siguen pendientes y ya no van; nunca las editadas a
--    mano (origen 'app') ni las que ya no están pendientes. Las campañas
--    cerradas se saltan y se reportan. Todo el lote va por conjuntos
--    (comp_aplicar_planes); la pantalla puede mandar lotes de ~50 campañas
--    para dar avance, pero no hace falta.
create or replace function public.comp_generar_tomas(p_campana_ids bigint[], p_plan jsonb)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_ids bigint[]; v_abiertas bigint[]; v_plan jsonb; v_n int; v_cerr int := 0; v jsonb; v_sin jsonb;
begin
  select array_agg(distinct x) into v_ids from unnest(p_campana_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste campañas.';
  end if;
  if cardinality(v_ids) > 1000 then
    raise exception 'Demasiadas campañas en un lote (%).', cardinality(v_ids);
  end if;
  select cardinality(v_ids) - count(*) into v_n from comp_campanas where id = any (v_ids);
  if v_n > 0 then
    raise exception '% campaña(s) ya no existen. Recarga la lista; no se generó nada.', v_n;
  end if;
  select count(*) into v_n from comp_campanas c
   where c.id = any (v_ids) and c.unidad not in (select comp_mis_unidades(array['supervisor']::app_role[]));
  if v_n > 0 then
    raise exception 'Solo el Supervisor (o el Admin) genera el plan de tomas. No se generó nada.';
  end if;
  if p_plan is not null and jsonb_typeof(p_plan) <> 'null' then
    v_plan := comp_plan_normal(p_plan);
  else
    select count(*) into v_n from comp_campanas c
     where c.id = any (v_ids) and c.estatus = 'abierta' and c.plan_tomas is null;
    if v_n > 0 then
      raise exception '% campaña(s) todavía no tienen plan: elige uno.', v_n;
    end if;
  end if;
  select count(*) into v_cerr from comp_campanas c where c.id = any (v_ids) and c.estatus = 'cerrada';

  -- Bloquea las campañas en orden para que dos lotes no se crucen.
  perform 1 from comp_campanas c where c.id = any (v_ids) and c.estatus = 'abierta' order by c.id for update;
  select array_agg(c.id order by c.id) into v_abiertas from comp_campanas c where c.id = any (v_ids) and c.estatus = 'abierta';
  v := comp_aplicar_planes(coalesce(v_abiertas, '{}'), v_plan);

  select coalesce(jsonb_agg(c.campana || case when c.version <> '' then ' / ' || c.version else '' end order by c.id), '[]')
    into v_sin
    from comp_campanas c where c.id in (select x::bigint from jsonb_array_elements_text(v->'sin_tomas') x);

  insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
  select 'generar_tomas', c.unidad, case when count(distinct c.periodo_id) = 1 then min(c.periodo_id) end,
         array_agg(c.id order by c.id), count(*),
         jsonb_build_object('plan', coalesce(v_plan, 'null'::jsonb), 'nuevas', v->'nuevas', 'borradas', v->'borradas'), v_email
    from comp_campanas c where c.id = any (coalesce(v_abiertas, '{}')) group by c.unidad;

  return jsonb_build_object('campanas', coalesce(cardinality(v_abiertas), 0), 'cerradas_omitidas', v_cerr,
                            'tomas_nuevas', v->'nuevas', 'tomas_borradas', v->'borradas',
                            'tomas_actualizadas', v->'actualizadas', 'tomas_conservadas', v->'conservadas',
                            'tomas_canceladas', v->'canceladas_auto', 'tomas_regresadas', v->'regresadas_auto',
                            'omitidas_comprobados', v->'omitidas_comprobados',
                            'tomas_app_fuera_de_vigencia', v->'app_fuera_de_vigencia',
                            'sin_tomas', v_sin, 'plan', v_plan);
end $$;

-- c) Editar tomas a mano (23-oct-2026): la analista de la campaña o el
--    Supervisor. Quedan con origen 'app' y regenerar el plan ya no las toca.
--    Solo tomas pendientes. La fecha se cambia de una en una y debe caer en
--    el periodo y en la vigencia del sitio (R8); fuera de la vigencia solo
--    con p_cambios.fuera_de_vigencia = true (la pantalla lo confirma). Al
--    cambiar la fecha sin mandar horario, el horario se recalcula con el del
--    día nuevo (L-V o S-D). Si ese día había una toma QUITADA del mismo
--    sitio, la movida toma su lugar (R9). El monitorista debe tener ese rol
--    en la unidad.
create or replace function public.comp_editar_tomas(p_toma_ids bigint[], p_cambios jsonb)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_permitidas text[] := array['fecha', 'horario_texto', 'observaciones', 'notas', 'monitorista_email', 'turno',
                               'comprobacion', 'fuera_de_vigencia'];
  v_otras text; v_ids bigint[]; v_n int; v_fecha date; v_mon text; v_u text; v_cambiadas int := 0;
  v_forzar boolean := false; v_c jsonb; v_vig text; v_reemplazo int := 0;
begin
  if jsonb_typeof(p_cambios) is distinct from 'object' or (p_cambios - 'fuera_de_vigencia') = '{}'::jsonb then
    raise exception 'No hay cambios.';
  end if;
  select string_agg(k, ', ') into v_otras from jsonb_object_keys(p_cambios) k where k <> all (v_permitidas);
  if v_otras is not null then
    raise exception 'No se puede editar: %. Solo fecha, horario, observaciones, notas, monitorista, turno y comprobación.', v_otras;
  end if;
  if p_cambios ? 'fuera_de_vigencia' then
    if jsonb_typeof(p_cambios->'fuera_de_vigencia') <> 'boolean' then
      raise exception 'fuera_de_vigencia es sí o no.';
    end if;
    v_forzar := (p_cambios->>'fuera_de_vigencia')::boolean;
  end if;
  v_c := p_cambios - 'fuera_de_vigencia';
  select array_agg(distinct x) into v_ids from unnest(p_toma_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste tomas.';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'Demasiadas tomas en un lote (%).', cardinality(v_ids);
  end if;
  select cardinality(v_ids) - count(*) into v_n from comp_tomas where id = any (v_ids);
  if v_n > 0 then
    raise exception '% toma(s) ya no existen. Recarga la lista; no se cambió nada.', v_n;
  end if;
  v_n := comp_tomas_ajenas(v_ids);
  if v_n > 0 then
    raise exception '% toma(s) son de campañas cerradas o que no llevas. No se cambió nada.', v_n;
  end if;

  if v_c ? 'fecha' then
    if cardinality(v_ids) <> 1 then
      raise exception 'La fecha se cambia de una toma a la vez.';
    end if;
    begin
      v_fecha := (v_c->>'fecha')::date;
    exception when others then
      raise exception 'La fecha no se entiende.';
    end;
    if v_fecha is null then
      raise exception 'La fecha no puede quedar vacía.';
    end if;
    select count(*) into v_n
      from comp_tomas t join comp_campanas c on c.id = t.campana_id join comp_periodos p on p.id = c.periodo_id
     where t.id = any (v_ids) and v_fecha not between p.fecha_inicio and p.fecha_fin;
    if v_n > 0 then
      raise exception 'El % no cae en el periodo de la campaña.', to_char(v_fecha, 'DD/MM/YYYY');
    end if;
    if not v_forzar then
      select string_agg('del ' || to_char(w.ini, 'DD/MM') || ' al ' || to_char(w.fin, 'DD/MM'), ', ' order by w.ini),
             count(*) filter (where v_fecha between w.ini and w.fin)
        into v_vig, v_n
        from comp_tomas t join comp_sitios s on s.id = t.sitio_id join comp_campanas c on c.id = t.campana_id
        join comp_periodos p on p.id = c.periodo_id
        cross join lateral comp_ventanas(s.inicio, s.fin, s.tramos, c.inicio, c.fin, p.fecha_inicio, p.fecha_fin) w
       where t.id = v_ids[1];
      if coalesce(v_n, 0) = 0 then
        raise exception 'El % no está en la vigencia del sitio (%). Si de todos modos va, confírmalo.',
          to_char(v_fecha, 'DD/MM/YYYY'), coalesce(v_vig, 'no corre en el periodo');
      end if;
    end if;
  end if;
  if v_c ? 'turno' and v_c->>'turno' is not null
     and v_c->>'turno' not in ('matutino', 'vespertino', 'campo') then
    raise exception 'Turno no válido: %.', v_c->>'turno';
  end if;
  if v_c ? 'monitorista_email' then
    v_mon := lower(nullif(btrim(v_c->>'monitorista_email'), ''));
    if v_mon is not null then
      for v_u in select distinct t.unidad from comp_tomas t where t.id = any (v_ids) loop
        if not comp_tiene_rol_en(v_mon, 'monitorista', v_u) then
          raise exception '% no es monitorista de %. No se cambió nada.', v_mon, comp_etiqueta_unidad(v_u);
        end if;
      end loop;
    end if;
  end if;

  begin
    -- R9: una toma quitada ese día del mismo sitio deja su lugar a la movida.
    if v_c ? 'fecha' then
      delete from comp_tomas q using comp_tomas t
       where t.id = v_ids[1] and t.estado = 'pendiente' and t.fecha <> v_fecha
         and q.campana_id = t.campana_id and q.sitio_id = t.sitio_id and q.fecha = v_fecha
         and q.estado = 'cancelada' and q.id <> t.id;
      get diagnostics v_reemplazo = row_count;
    end if;
    with upd as (
      update comp_tomas t set
        fecha = case when v_c ? 'fecha' then v_fecha else t.fecha end,
        horario_texto = case when v_c ? 'horario_texto' then nullif(btrim(v_c->>'horario_texto'), '')
                             when v_c ? 'fecha' and v_fecha is distinct from t.fecha
                               then nullif(btrim(case when extract(isodow from v_fecha) <= 5
                                                      then s.horario_lv else s.horario_sd end), '')
                             else t.horario_texto end,
        observaciones = case when v_c ? 'observaciones' then nullif(btrim(v_c->>'observaciones'), '')
                             else t.observaciones end,
        notas = case when v_c ? 'notas' then nullif(btrim(v_c->>'notas'), '') else t.notas end,
        monitorista_email = case when v_c ? 'monitorista_email' then v_mon else t.monitorista_email end,
        turno = case when v_c ? 'turno' then v_c->>'turno' else t.turno end,
        comprobacion = case when v_c ? 'comprobacion'
                            then coalesce(nullif(btrim(v_c->>'comprobacion'), ''), 'FOTO') else t.comprobacion end,
        origen = 'app', editado_por = v_email, editado_en = now()
        from comp_sitios s
       where s.id = t.sitio_id and t.id = any (v_ids) and t.estado = 'pendiente'
      returning t.id, t.unidad, t.campana_id
    ), mov as (
      insert into comp_movimientos (accion, unidad, campana_ids, n, detalle, por)
      select 'editar_tomas', u.unidad, array_agg(distinct u.campana_id), count(*),
             p_cambios || jsonb_build_object('tomas', array_agg(u.id order by u.id), 'quitada_reemplazada', v_reemplazo > 0),
             v_email
        from upd u group by u.unidad
    )
    select count(*) into v_cambiadas from upd;
  exception when unique_violation then
    raise exception 'Ese sitio ya tiene una toma el %.', to_char(v_fecha, 'DD/MM/YYYY');
  end;
  return jsonb_build_object('cambiadas', v_cambiadas, 'sin_cambio', cardinality(v_ids) - v_cambiadas,
                            'quitada_reemplazada', v_reemplazo > 0);
end $$;

-- d) Agregar tomas a mano (fechas sueltas para unos sitios): origen 'app'.
--    Las fechas fuera del periodo y las que ya existen se saltan y se
--    cuentan. Las que caen fuera de la vigencia del sitio (R8) también se
--    saltan, salvo p_fuera_de_vigencia = true (la pantalla lo confirma).
--    No a sitios cancelados, fuera de la carga ni de campañas retiradas.
create or replace function public.comp_agregar_tomas(p_sitio_ids bigint[], p_fechas date[],
  p_fuera_de_vigencia boolean default false)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_forzar boolean := coalesce(p_fuera_de_vigencia, false);
  v_ids bigint[]; v_fechas date[]; v_n int; v_pedidas int; v_fuera int; v_fuera_vig int; v_agregadas int := 0;
begin
  select array_agg(distinct x) into v_ids from unnest(p_sitio_ids) x where x is not null;
  select array_agg(distinct f order by f) into v_fechas from unnest(p_fechas) f where f is not null;
  if v_ids is null or v_fechas is null then
    raise exception 'Elige sitios y fechas.';
  end if;
  if cardinality(v_ids) * cardinality(v_fechas) > 20000 then
    raise exception 'Demasiadas tomas en un lote (%).', cardinality(v_ids) * cardinality(v_fechas);
  end if;
  select cardinality(v_ids) - count(*) into v_n from comp_sitios where id = any (v_ids);
  if v_n > 0 then
    raise exception '% sitio(s) ya no existen. Recarga la lista; no se agregó nada.', v_n;
  end if;
  v_n := comp_sitios_ajenos(v_ids);
  if v_n > 0 then
    raise exception '% sitio(s) son de campañas cerradas o que no llevas. No se agregó nada.', v_n;
  end if;
  select count(*) into v_n from comp_sitios s join comp_campanas c on c.id = s.campana_id
   where s.id = any (v_ids) and (s.estado = 'cancelado' or s.fuera_de_carga or c.retirada);
  if v_n > 0 then
    raise exception '% sitio(s) están cancelados, fuera de la carga o en una campaña retirada. No se agregó nada.', v_n;
  end if;

  drop table if exists pg_temp.comp_add_t;
  create temp table comp_add_t on commit drop as
  select s.id as sitio_id, s.campana_id, s.unidad, f,
         f between p.fecha_inicio and p.fecha_fin as en_periodo,
         exists (select 1 from comp_ventanas(s.inicio, s.fin, s.tramos, c.inicio, c.fin, p.fecha_inicio, p.fecha_fin) w
                  where f between w.ini and w.fin) as en_vigencia,
         nullif(btrim(case when extract(isodow from f) <= 5 then s.horario_lv else s.horario_sd end), '') as horario_texto,
         s.observaciones, s.site_id, s.sitio_clave
    from comp_sitios s
    join comp_campanas c on c.id = s.campana_id
    join comp_periodos p on p.id = c.periodo_id
    cross join unnest(v_fechas) f
   where s.id = any (v_ids);
  select count(*), count(*) filter (where not en_periodo), count(*) filter (where en_periodo and not en_vigencia)
    into v_pedidas, v_fuera, v_fuera_vig from pg_temp.comp_add_t;

  with ins as (
    insert into comp_tomas (campana_id, sitio_id, unidad, fecha, fecha_plan, horario_texto, observaciones,
                            ruta_id, ruta_numero, monitorista_email, origen, editado_por, editado_en)
    select a.campana_id, a.sitio_id, a.unidad, a.f, null, a.horario_texto, a.observaciones,
           r.ruta_id, r.ruta_numero, r.monitorista_email, 'app', v_email, now()
      from pg_temp.comp_add_t a
      left join lateral comp_ruta_sitio(a.unidad, a.site_id, a.sitio_clave) r on true
     where a.en_periodo and (a.en_vigencia or v_forzar)
    on conflict (campana_id, sitio_id, fecha) do nothing
    returning id, unidad, campana_id
  ), mov as (
    insert into comp_movimientos (accion, unidad, campana_ids, sitio_ids, n, detalle, por)
    select 'agregar_tomas', i.unidad, array_agg(distinct i.campana_id), v_ids, count(*),
           jsonb_build_object('fechas', to_jsonb(v_fechas), 'fuera_de_vigencia', v_forzar), v_email
      from ins i group by i.unidad
  )
  select count(*) into v_agregadas from ins;
  return jsonb_build_object('agregadas', v_agregadas, 'fuera_del_periodo', v_fuera,
                            'fuera_de_vigencia', case when v_forzar then 0 else v_fuera_vig end,
                            'ya_estaban', v_pedidas - v_fuera - case when v_forzar then 0 else v_fuera_vig end - v_agregadas);
end $$;

-- e) Quitar tomas (quedan 'cancelada' con origen 'app', así el plan no las
--    vuelve a crear) o regresarlas (p_quitar = false). Solo pendientes. No
--    se regresa una toma de un sitio cancelado, fuera de la carga o de una
--    campaña retirada (volvería a caer en la siguiente sincronización).
create or replace function public.comp_quitar_tomas(p_toma_ids bigint[], p_quitar boolean default true)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_quitar boolean := coalesce(p_quitar, true);
  v_ids bigint[]; v_n int; v_cambiadas int := 0;
begin
  select array_agg(distinct x) into v_ids from unnest(p_toma_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste tomas.';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'Demasiadas tomas en un lote (%).', cardinality(v_ids);
  end if;
  v_n := comp_tomas_ajenas(v_ids);
  if v_n > 0 then
    raise exception '% toma(s) son de campañas cerradas o que no llevas. No se cambió nada.', v_n;
  end if;
  with upd as (
    update comp_tomas t
       set estado = case when v_quitar then 'cancelada' else 'pendiente' end, baja_auto = false,
           origen = 'app', editado_por = v_email, editado_en = now()
      from comp_sitios s, comp_campanas c
     where s.id = t.sitio_id and c.id = t.campana_id and t.id = any (v_ids)
       and t.estado = case when v_quitar then 'pendiente' else 'cancelada' end
       and (v_quitar or (s.estado <> 'cancelado' and not s.fuera_de_carga and not c.retirada))
    returning t.id, t.unidad, t.campana_id
  ), mov as (
    insert into comp_movimientos (accion, unidad, campana_ids, n, detalle, por)
    select case when v_quitar then 'quitar_tomas' else 'restaurar_tomas' end, u.unidad,
           array_agg(distinct u.campana_id), count(*), jsonb_build_object('tomas', array_agg(u.id order by u.id)), v_email
      from upd u group by u.unidad
  )
  select count(*) into v_cambiadas from upd;
  return jsonb_build_object('cambiadas', v_cambiadas, 'sin_cambio', cardinality(v_ids) - v_cambiadas);
end $$;

-- f) Equipo de la unidad para los selectores. Hace falta porque
--    ur_self_read no deja ver las filas de los demás. Solo los analistas
--    son asignables (#13); el Supervisor sale para que se vea, sin asignar.
create or replace function public.comp_equipo(p_unidad text)
returns table (email text, nombre text, rol text, asignable boolean)
language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
#variable_conflict use_column
begin
  if not comp_lee(p_unidad) then
    raise exception 'No puedes ver el equipo de %.', comp_etiqueta_unidad(p_unidad);
  end if;
  return query
  with filas as (
    select lower(btrim(ur.usuario_email)) as correo, ur.rol::text as r
      from usuario_roles ur
     where ur.rol in ('analista', 'supervisor')
       and (ur.unidad_negocio is null or ur.unidad_negocio = p_unidad)
       and (p_unidad <> 'Ecovallas' or ur.medio is null or ur.medio ilike 'digital%'))
  select f.correo,
         coalesce((select u.nombre from usuarios u where lower(u.email) = f.correo limit 1), f.correo),
         case when bool_or(f.r = 'analista') then 'analista' else 'supervisor' end,
         bool_or(f.r = 'analista')
    from filas f
   group by f.correo
   order by 2;
end $$;

-- g) Monitoristas de la unidad (para cambiar a mano el de una toma).
create or replace function public.comp_monitoristas(p_unidad text)
returns table (email text, nombre text)
language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
#variable_conflict use_column
begin
  if not (comp_lee(p_unidad) or comp_es_analista_de(auth_email(), p_unidad)) then
    raise exception 'No puedes ver los monitoristas de %.', comp_etiqueta_unidad(p_unidad);
  end if;
  return query
  select d.correo, coalesce((select u.nombre from usuarios u where lower(u.email) = d.correo limit 1), d.correo)
    from (select distinct lower(btrim(ur.usuario_email)) as correo
            from usuario_roles ur
           where ur.rol = 'monitorista'
             and (ur.unidad_negocio is null or ur.unidad_negocio = p_unidad)
             and (p_unidad <> 'Ecovallas' or ur.medio is null or ur.medio ilike 'digital%')) d
   order by 2;
end $$;

-- h) Asignar (o quitar, con p_analista NULL) analista en lote.
create or replace function public.comp_asignar_analista(p_campana_ids bigint[], p_analista text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_a text := lower(nullif(btrim(p_analista), ''));
  v_ids bigint[];
  v_n int; v_u text; v_asig int := 0; v_cerr int := 0;
begin
  select array_agg(distinct x) into v_ids from unnest(p_campana_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste campañas.';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'Demasiadas campañas en un lote (%).', cardinality(v_ids);
  end if;
  select cardinality(v_ids) - count(*) into v_n from comp_campanas where id = any (v_ids);
  if v_n > 0 then
    raise exception '% campaña(s) ya no existen. Recarga la lista; no se asignó nada.', v_n;
  end if;
  select count(*) into v_n from comp_campanas c
   where c.id = any (v_ids) and c.unidad not in (select comp_mis_unidades(array['supervisor']::app_role[]));
  if v_n > 0 then
    raise exception '% campaña(s) son de unidades que no gestionas. No se asignó nada.', v_n;
  end if;
  if v_a is not null then
    for v_u in select distinct c.unidad from comp_campanas c where c.id = any (v_ids) loop
      if not comp_es_analista_de(v_a, v_u) then
        raise exception '% no tiene rol de analista en %. No se asignó nada.', v_a, comp_etiqueta_unidad(v_u);
      end if;
    end loop;
  end if;
  select count(*) into v_cerr from comp_campanas c where c.id = any (v_ids) and c.estatus = 'cerrada';

  with obj as (
    select c.id, c.analista_email as antes from comp_campanas c
     where c.id = any (v_ids) and c.estatus = 'abierta' and c.analista_email is distinct from v_a
     for update
  ), upd as (
    update comp_campanas c
       set analista_email = v_a, asignacion_origen = 'app', asignado_por = v_email,
           asignado_en = now(), actualizado_en = now()
      from obj where c.id = obj.id
    returning c.id, c.unidad, c.periodo_id, obj.antes
  ), mov as (
    insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, de_email, a_email, por)
    select 'asignar', u.unidad, case when count(distinct u.periodo_id) = 1 then min(u.periodo_id) end,
           array_agg(u.id order by u.id), count(*),
           case when count(distinct coalesce(u.antes, '')) = 1 then max(u.antes) end, v_a, v_email
      from upd u group by u.unidad
  ), aviso as (
    -- UN aviso por unidad y periodo a la analista nueva, no uno por campaña;
    -- nada si se asigna a sí misma.
    insert into notificaciones (record_id, para_email, evento, mensaje, unidad_negocio)
    select null, v_a, 'comp_asignada',
           'Se te ' || case when count(*) = 1 then 'asignó 1 campaña' else 'asignaron ' || count(*) || ' campañas' end
             || ' de ' || comp_etiqueta_unidad(u.unidad) || ' · ' || p.etiqueta || '.',
           u.unidad
      from upd u join comp_periodos p on p.id = u.periodo_id
     where v_a is not null and v_a <> v_email
     group by u.unidad, u.periodo_id, p.etiqueta
  )
  select count(*) into v_asig from upd;

  return jsonb_build_object('asignadas', v_asig, 'cerradas_omitidas', v_cerr,
                            'sin_cambio', cardinality(v_ids) - v_asig - v_cerr);
end $$;

-- i) Pasar lo pendiente de una analista a otra. Lo ya comprobado conserva
--    su comprobado_por: el crédito no se mueve (#4).
create or replace function public.comp_pasar_pendiente(p_de text, p_a text, p_unidad text,
  p_periodo_id bigint default null, p_solo_sin_avance boolean default false, p_solo_contar boolean default false)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_de text := lower(nullif(btrim(p_de), ''));
  v_a text := lower(nullif(btrim(p_a), ''));
  v_ids bigint[]; v_pend int; v_r jsonb;
begin
  if not comp_gestiona(p_unidad) then
    raise exception 'Solo el Supervisor (o el Admin) pasa pendientes de %.', coalesce(comp_etiqueta_unidad(p_unidad), '?');
  end if;
  if v_de is null then
    raise exception 'Elige de quién se pasa lo pendiente.';
  end if;
  if not p_solo_contar and (v_a is null or v_a = v_de) then
    raise exception 'Elige a quién se pasa (otra persona).';
  end if;
  select array_agg(c.id order by c.id), coalesce(sum(k.pend), 0)::int into v_ids, v_pend
    from comp_campanas c
    cross join lateral (
      select count(*) filter (where s.estado = 'pendiente') as pend,
             count(*) filter (where s.estado = 'comprobado') as comp
        from comp_sitios s where s.campana_id = c.id) k
   where c.unidad = p_unidad and c.estatus = 'abierta' and c.analista_email = v_de
     and (p_periodo_id is null or c.periodo_id = p_periodo_id)
     and case when coalesce(p_solo_sin_avance, false) then k.comp = 0 else (k.pend > 0 or k.comp = 0) end;
  if p_solo_contar or v_ids is null then
    return jsonb_build_object('campanas', coalesce(cardinality(v_ids), 0), 'sitios_pendientes', v_pend,
                              'solo_contar', coalesce(p_solo_contar, false));
  end if;
  v_r := comp_asignar_analista(v_ids, v_a);
  insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, de_email, a_email, detalle, por)
  values ('pasar_pendiente', p_unidad, p_periodo_id, v_ids, cardinality(v_ids), v_de, v_a,
          jsonb_build_object('solo_sin_avance', coalesce(p_solo_sin_avance, false), 'sitios_pendientes', v_pend), v_email);
  return v_r || jsonb_build_object('campanas', cardinality(v_ids), 'sitios_pendientes', v_pend, 'solo_contar', false);
end $$;

-- j) Marcar o desmarcar sitios comprobados (fase 2: lo marca la analista).
--    P4: el día es hoy o hasta 7 días atrás, nunca antes del periodo.
create or replace function public.comp_marcar_sitios(p_sitio_ids bigint[], p_comprobado boolean default true,
  p_dia date default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_hoy date := (now() at time zone 'America/Mexico_City')::date;
  v_dia date := coalesce(p_dia, (now() at time zone 'America/Mexico_City')::date);
  v_ids bigint[]; v_n int; v_cambiados int := 0;
begin
  if p_comprobado is null then
    raise exception 'Falta decir si se marca o se quita la marca.';
  end if;
  select array_agg(distinct x) into v_ids from unnest(p_sitio_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste sitios.';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'Demasiados sitios en un lote (%); el tope es 5,000.', cardinality(v_ids);
  end if;
  -- Permiso por CADA sitio: campaña abierta que la persona lleva (con el
  -- rol vigente, #25) o gestiona. Si uno falla, no se cambia nada.
  v_n := comp_sitios_ajenos(v_ids);
  if v_n > 0 then
    raise exception '% sitio(s) son de campañas cerradas o que no llevas. No se marcó nada.', v_n;
  end if;

  if p_comprobado then
    if v_dia > v_hoy or v_dia < v_hoy - 7 then
      raise exception 'El día debe ser hoy o uno de los 7 días anteriores.';
    end if;
    -- Un sitio que ya no viene en la carga o de una campaña retirada no se
    -- marca: no cuenta para la meta (revisor-rls, 23-oct-2026).
    select count(*) into v_n
      from comp_sitios s join comp_campanas c on c.id = s.campana_id
     where s.id = any (v_ids) and s.estado = 'pendiente' and (s.fuera_de_carga or c.retirada);
    if v_n > 0 then
      raise exception '% sitio(s) ya no vienen en la carga o son de una campaña retirada. No se marcó nada.', v_n;
    end if;
    select count(*) into v_n
      from comp_sitios s join comp_campanas c on c.id = s.campana_id join comp_periodos p on p.id = c.periodo_id
     where s.id = any (v_ids) and s.estado = 'pendiente' and v_dia < p.fecha_inicio;
    if v_n > 0 then
      raise exception 'El % es antes de que empiece el periodo de % sitio(s). No se marcó nada.', to_char(v_dia, 'DD/MM/YYYY'), v_n;
    end if;
    with upd as (
      update comp_sitios s
         set estado = 'comprobado', comprobado_dia = v_dia, comprobado_en = now(),
             comprobado_por = v_email, comprobado_via = 'marca'
       where s.id = any (v_ids) and s.estado = 'pendiente'
      returning s.id, s.unidad, s.campana_id
    ), mov as (
      insert into comp_movimientos (accion, unidad, campana_ids, sitio_ids, n, detalle, por)
      select 'marcar', u.unidad, array_agg(distinct u.campana_id), array_agg(u.id order by u.id), count(*),
             jsonb_build_object('dia', v_dia), v_email
        from upd u group by u.unidad
    )
    select count(*) into v_cambiados from upd;
  else
    -- Solo quien marcó o el Supervisor quita una marca; la revisión (fase 3)
    -- no se desmarca aquí.
    select count(*) into v_n
      from comp_sitios s join comp_campanas c on c.id = s.campana_id
     where s.id = any (v_ids) and s.estado = 'comprobado' and s.comprobado_via = 'marca'
       and s.comprobado_por is distinct from v_email
       and c.unidad not in (select comp_mis_unidades(array['supervisor']::app_role[]));
    if v_n > 0 then
      raise exception '% sitio(s) los marcó otra persona: solo ella o el Supervisor puede quitar la marca. No se cambió nada.', v_n;
    end if;
    with upd as (
      update comp_sitios s
         set estado = 'pendiente', comprobado_dia = null, comprobado_en = null,
             comprobado_por = null, comprobado_via = null
       where s.id = any (v_ids) and s.estado = 'comprobado' and s.comprobado_via = 'marca'
      returning s.id, s.unidad, s.campana_id
    ), mov as (
      insert into comp_movimientos (accion, unidad, campana_ids, sitio_ids, n, por)
      select 'desmarcar', u.unidad, array_agg(distinct u.campana_id), array_agg(u.id order by u.id), count(*), v_email
        from upd u group by u.unidad
    )
    select count(*) into v_cambiados from upd;
  end if;
  return jsonb_build_object('cambiados', v_cambiados, 'sin_cambio', cardinality(v_ids) - v_cambiados,
                            'dia', case when p_comprobado then v_dia end);
end $$;

-- k) Cancelar sitios (bajas, «no se comprueban») y restaurarlos. Si la
--    campaña tiene plan, se vuelve a aplicar: las tomas pendientes del plan
--    de un sitio cancelado se quitan y al restaurarlo regresan.
create or replace function public.comp_cancelar_sitios(p_sitio_ids bigint[], p_motivo text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_motivo text := nullif(btrim(p_motivo), '');
  v_ids bigint[]; v_n int; v_cambiados int := 0; v_cams bigint[]; v_tom jsonb;
begin
  if v_motivo is null then
    raise exception 'Escribe el motivo de la cancelación.';
  end if;
  select array_agg(distinct x) into v_ids from unnest(p_sitio_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste sitios.';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'Demasiados sitios en un lote (%).', cardinality(v_ids);
  end if;
  v_n := comp_sitios_ajenos(v_ids);
  if v_n > 0 then
    raise exception '% sitio(s) son de campañas cerradas o que no llevas. No se canceló nada.', v_n;
  end if;
  with upd as (
    update comp_sitios s
       set estado = 'cancelado', cancelado_motivo = v_motivo, cancelado_por = v_email, cancelado_en = now(),
           actualizado_en = now()
     where s.id = any (v_ids) and s.estado = 'pendiente'
    returning s.id, s.unidad, s.campana_id
  ), mov as (
    insert into comp_movimientos (accion, unidad, campana_ids, sitio_ids, n, detalle, por)
    select 'cancelar', u.unidad, array_agg(distinct u.campana_id), array_agg(u.id order by u.id), count(*),
           jsonb_build_object('motivo', v_motivo), v_email
      from upd u group by u.unidad
  )
  select count(*), array_agg(distinct campana_id) into v_cambiados, v_cams from upd;
  v_tom := comp_reaplicar_planes(coalesce(v_cams, '{}'));
  return jsonb_build_object('cambiados', v_cambiados, 'sin_cambio', cardinality(v_ids) - v_cambiados) || v_tom;
end $$;

create or replace function public.comp_restaurar_sitios(p_sitio_ids bigint[])
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_ids bigint[]; v_n int; v_cambiados int := 0; v_cams bigint[]; v_tom jsonb;
begin
  select array_agg(distinct x) into v_ids from unnest(p_sitio_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste sitios.';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'Demasiados sitios en un lote (%).', cardinality(v_ids);
  end if;
  v_n := comp_sitios_ajenos(v_ids);
  if v_n > 0 then
    raise exception '% sitio(s) son de campañas cerradas o que no llevas. No se restauró nada.', v_n;
  end if;
  with upd as (
    update comp_sitios s
       set estado = 'pendiente', cancelado_motivo = null, cancelado_por = null, cancelado_en = null,
           actualizado_en = now()
     where s.id = any (v_ids) and s.estado = 'cancelado'
    returning s.id, s.unidad, s.campana_id
  ), mov as (
    insert into comp_movimientos (accion, unidad, campana_ids, sitio_ids, n, por)
    select 'restaurar', u.unidad, array_agg(distinct u.campana_id), array_agg(u.id order by u.id), count(*), v_email
      from upd u group by u.unidad
  )
  select count(*), array_agg(distinct campana_id) into v_cambiados, v_cams from upd;
  v_tom := comp_reaplicar_planes(coalesce(v_cams, '{}'));
  return jsonb_build_object('cambiados', v_cambiados, 'sin_cambio', cardinality(v_ids) - v_cambiados) || v_tom;
end $$;

-- l) Agregar sitios a una campaña (origen 'app': ninguna carga los quita).
--    P2: la analista de la campaña los agrega solo a un FULL; el
--    Supervisor, a cualquier campaña abierta. En Vía Verde se aceptan '448',
--    'POR_0008' o el vendor_face_id; deben ser espacios activos de CDMX del
--    mismo medio. En las otras unidades, caras del inventario de la unidad
--    (Ecovallas: Digital). Si una clave no sirve, no se agrega ninguna.
--    Si la campaña tiene plan, los sitios nuevos reciben sus tomas.
create or replace function public.comp_agregar_sitios(p_campana_id bigint, p_claves text[])
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  c comp_campanas%rowtype;
  v_gest boolean;
  v_malas text; v_total int; v_n int := 0; v_ids bigint[]; v_tom jsonb;
begin
  select * into c from comp_campanas where id = p_campana_id for update;
  if not found then
    raise exception 'La campaña ya no existe.';
  end if;
  v_gest := comp_gestiona(c.unidad);
  if not (v_gest or (c.analista_email = v_email and comp_es_analista_de(v_email, c.unidad))) then
    raise exception 'Solo la analista de la campaña o el Supervisor agrega sitios.';
  end if;
  if c.estatus <> 'abierta' then
    raise exception 'La campaña está cerrada.';
  end if;
  if c.retirada then
    raise exception 'La campaña está retirada: regrésala antes de agregarle sitios.';
  end if;
  -- FULL solo existe en Vía Verde (Erik, 23-oct-2026): un es_full en otra
  -- unidad (dato raro de una carga) no abre esta puerta a la analista.
  if not v_gest and not (c.es_full and c.unidad = 'Vía Verde') then
    raise exception 'La analista solo agrega sitios a una campaña FULL; en las demás, pídeselo al Supervisor.';
  end if;

  drop table if exists pg_temp.comp_add;
  create temp table comp_add on commit drop as
  select distinct k.clave, k.esp, i.vendor_face_id as inv_vfid, i.site_id,
         case
           when c.unidad = 'Vía Verde' then
             not (k.clave !~ '^MX_EM_' and ve.clave is not null and ve.activo
                  and coalesce(ve.tramo, '') not ilike 'EDO MEX%'
                  and ve.tipo_espacio = case c.medio when 'Columna' then 'columna' when 'Pórtico' then 'portico' end)
           else i.vendor_face_id is null
         end as mala,
         o.original
    from unnest(p_claves) as o(original)
    cross join lateral (
      select case when c.unidad <> 'Vía Verde' or comp_clave_sitio(o.original) ~ '^MX_'
                  then comp_clave_sitio(o.original)
                  when comp_clave_sitio(o.original) ~ '^POR_' then 'MX_CM_VV_' || comp_clave_sitio(o.original)
                  else 'MX_CM_VV_COL_' || comp_clave_sitio(o.original) end as clave) k0
    cross join lateral (
      select k0.clave, case when c.unidad = 'Vía Verde' then comp_espacio_vv(k0.clave) end as esp) k
    left join inventario i on i.vendor_face_id = k.clave and i.unidad_negocio = c.unidad
                          and (c.unidad <> 'Ecovallas' or i.tipo_medio = 'Digital')
    left join vv_espacios ve on c.unidad = 'Vía Verde' and ve.clave = k.esp
   where comp_clave_sitio(o.original) is not null;

  select count(distinct clave) into v_total from pg_temp.comp_add;
  if v_total = 0 then
    raise exception 'No escribiste claves.';
  end if;
  select string_agg(distinct original, ', ') into v_malas from pg_temp.comp_add where mala;
  if v_malas is not null then
    raise exception 'Estas claves no son sitios activos de %: %. No se agregó nada.', comp_etiqueta_unidad(c.unidad), v_malas;
  end if;

  with ins as (
    insert into comp_sitios (campana_id, unidad, sitio_clave, sitio_original, vendor_face_id, site_id,
                             espacio_vv, en_inventario, origen)
    select distinct on (a.clave) c.id, c.unidad, a.clave, btrim(a.original), a.inv_vfid, a.site_id,
           a.esp, a.inv_vfid is not null, 'app'
      from pg_temp.comp_add a order by a.clave
    on conflict (campana_id, sitio_clave) do nothing
    returning id)
  select count(*), array_agg(id order by id) into v_n, v_ids from ins;

  insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, sitio_ids, n, por)
  values ('agregar_sitios', c.unidad, c.periodo_id, array[c.id], v_ids, v_n, v_email);
  v_tom := comp_reaplicar_planes(array[c.id]);
  return jsonb_build_object('agregados', v_n, 'ya_estaban', v_total - v_n) || v_tom;
end $$;

-- m) Cerrar o reabrir campañas (P1): solo el Supervisor o el manager. Si
--    alguna no llega a la meta, pide motivo. Al reabrir se limpia cerrada_*;
--    la historia queda en la bitácora.
create or replace function public.comp_cerrar_campanas(p_campana_ids bigint[], p_cerrar boolean, p_motivo text default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_motivo text := nullif(btrim(p_motivo), '');
  v_ids bigint[]; v_n int; v_incompletas int := 0; v_cambiadas int := 0;
begin
  if p_cerrar is null then
    raise exception 'Falta decir si se cierra o se reabre.';
  end if;
  select array_agg(distinct x) into v_ids from unnest(p_campana_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste campañas.';
  end if;
  select cardinality(v_ids) - count(*) into v_n from comp_campanas where id = any (v_ids);
  if v_n > 0 then
    raise exception '% campaña(s) ya no existen. Recarga la lista; no se cambió nada.', v_n;
  end if;
  select count(*) into v_n from comp_campanas c
   where c.id = any (v_ids) and c.unidad not in (select comp_mis_unidades(array['supervisor']::app_role[]));
  if v_n > 0 then
    raise exception 'Solo el Supervisor (o el Admin) cierra o reabre campañas. No se cambió nada.';
  end if;

  if p_cerrar then
    select count(*) into v_incompletas from vw_comp_campanas v
     where v.id = any (v_ids) and v.estatus = 'abierta' and not v.completa;
    if v_incompletas > 0 and v_motivo is null then
      raise exception '% campaña(s) no llegan al 100 %%: escribe el motivo para cerrarlas.', v_incompletas;
    end if;
    with upd as (
      update comp_campanas c
         set estatus = 'cerrada', cerrada_por = v_email, cerrada_en = now(), cierre_motivo = v_motivo,
             actualizado_en = now()
       where c.id = any (v_ids) and c.estatus = 'abierta'
      returning c.id, c.unidad, c.periodo_id
    ), mov as (
      insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
      select 'cerrar', u.unidad, case when count(distinct u.periodo_id) = 1 then min(u.periodo_id) end,
             array_agg(u.id order by u.id), count(*),
             jsonb_build_object('motivo', v_motivo, 'incompletas', v_incompletas), v_email
        from upd u group by u.unidad
    )
    select count(*) into v_cambiadas from upd;
  else
    with upd as (
      update comp_campanas c
         set estatus = 'abierta', cerrada_por = null, cerrada_en = null, cierre_motivo = null,
             actualizado_en = now()
       where c.id = any (v_ids) and c.estatus = 'cerrada'
      returning c.id, c.unidad, c.periodo_id
    ), mov as (
      insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
      select 'reabrir', u.unidad, case when count(distinct u.periodo_id) = 1 then min(u.periodo_id) end,
             array_agg(u.id order by u.id), count(*), jsonb_build_object('motivo', v_motivo), v_email
        from upd u group by u.unidad
    )
    select count(*) into v_cambiadas from upd;
  end if;
  return jsonb_build_object('cambiadas', v_cambiadas, 'sin_cambio', cardinality(v_ids) - v_cambiadas,
                            'incompletas', v_incompletas);
end $$;

-- m2) Retirar campañas o regresarlas (23-oct-2026; solo el Supervisor o el
--     manager). Para la versión repetida que reporta una carga
--     (posibles_duplicados) o una campaña que se cayó. Retirar: si nadie
--     trabajó en ella se BORRA con sus sitios y tomas; si no, queda retirada
--     (sus tomas pendientes salen del plan y sus pendientes, de la meta).
--     Regresar (p_retirar = false): deja de estar retirada y su plan se
--     vuelve a aplicar (las tomas a mano regresan). Las cerradas se saltan.
create or replace function public.comp_retirar_campanas(p_campana_ids bigint[], p_retirar boolean default true)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_retirar boolean := coalesce(p_retirar, true);
  v_ids bigint[]; v_obj bigint[]; v_n int; v_r jsonb; v_tom jsonb; v_marcadas bigint[]; v_unidades text[];
begin
  select array_agg(distinct x) into v_ids from unnest(p_campana_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste campañas.';
  end if;
  select cardinality(v_ids) - count(*) into v_n from comp_campanas where id = any (v_ids);
  if v_n > 0 then
    raise exception '% campaña(s) ya no existen. Recarga la lista; no se cambió nada.', v_n;
  end if;
  select count(*) into v_n from comp_campanas c
   where c.id = any (v_ids) and c.unidad not in (select comp_mis_unidades(array['supervisor']::app_role[]));
  if v_n > 0 then
    raise exception 'Solo el Supervisor (o el Admin) retira o regresa campañas. No se cambió nada.';
  end if;
  perform 1 from comp_campanas c where c.id = any (v_ids) and c.estatus = 'abierta' order by c.id for update;
  select array_agg(c.id order by c.id) into v_obj from comp_campanas c
   where c.id = any (v_ids) and c.estatus = 'abierta' and c.retirada is distinct from v_retirar;
  select array_agg(distinct c.unidad) into v_unidades from comp_campanas c where c.id = any (coalesce(v_obj, '{}'));
  if v_retirar then
    v_r := comp_retirar(coalesce(v_obj, '{}'));
    select array_agg(x::bigint) into v_marcadas from jsonb_array_elements_text(v_r->'marcadas') x;
  else
    update comp_campanas c set retirada = false, retirada_en = null, reemplazada_por = null, actualizado_en = now()
     where c.id = any (coalesce(v_obj, '{}'));
    v_marcadas := v_obj;
    v_r := jsonb_build_object('borradas', 0, 'lista', '[]'::jsonb);
  end if;
  v_tom := comp_reaplicar_planes(coalesce(v_marcadas, '{}'));
  insert into comp_movimientos (accion, unidad, campana_ids, n, detalle, por)
  select case when v_retirar then 'retirar' else 'regresar' end, u, v_obj, cardinality(v_obj),
         jsonb_build_object('lista', v_r->'lista'), v_email
    from unnest(coalesce(v_unidades, '{}')) u;
  return jsonb_build_object('cambiadas', coalesce(cardinality(v_obj), 0), 'borradas', (v_r->>'borradas')::int,
                            'retiradas', case when v_retirar then coalesce(cardinality(v_marcadas), 0) else 0 end,
                            'regresadas', case when v_retirar then 0 else coalesce(cardinality(v_obj), 0) end,
                            'sin_cambio', cardinality(v_ids) - coalesce(cardinality(v_obj), 0),
                            'lista', v_r->'lista') || v_tom;
end $$;

-- n) Editar campañas en lote (solo el Supervisor). Lo editado se anota en
--    editado_app y la recarga ya no lo pisa (#5). Un valor null en un campo
--    que viene de la carga lo devuelve a lo que diga la próxima carga.
--    Si cambia la vigencia o los minutos de un FULL, se vuelve a aplicar el
--    plan o a proponer la meta. La vigencia de la campaña recorta la de
--    TODOS sus sitios (comp_ventanas, R3): acortarla quita las tomas del plan
--    que quedan fuera y reporta las editadas a mano que quedan fuera.
--    es_full (23-oct-2026, hallazgo #9): el Supervisor corrige un FULL que
--    la app no reconoció (rotación) o uno que no lo era; sí/no, y null lo
--    devuelve a lo que diga la carga. Al volverse FULL en Vía Verde se
--    propone la meta por minutos, salvo que meta_full ya se haya editado.
create or replace function public.comp_editar_campanas(p_campana_ids bigint[], p_cambios jsonb)
returns jsonb language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_permitidas text[] := array['fecha_limite', 'meta_app', 'meta_full', 'full_minutos', 'entrega_tipo',
                               'especificacion', 'arte', 'inicio', 'fin', 'cliente', 'vendedor',
                               'administrador', 'quantum', 'mediamonitor', 'es_full'];
  v_otras text; v_set text[]; v_null text[];
  v_ids bigint[]; v_n int; v_cerr int; v_cambiadas int := 0; v_cams bigint[]; v_tom jsonb := '{}';
begin
  if jsonb_typeof(p_cambios) is distinct from 'object' or p_cambios = '{}'::jsonb then
    raise exception 'No hay cambios.';
  end if;
  select string_agg(k, ', ') into v_otras from jsonb_object_keys(p_cambios) k where k <> all (v_permitidas);
  if v_otras is not null then
    raise exception 'No se puede editar: %.', v_otras;
  end if;
  v_set := array(select e.k from jsonb_each(p_cambios) e(k, v) where jsonb_typeof(e.v) <> 'null');
  v_null := array(select e.k from jsonb_each(p_cambios) e(k, v) where jsonb_typeof(e.v) = 'null');
  if 'entrega_tipo' = any (v_null) then
    raise exception 'La entrega no puede quedar vacía.';
  end if;
  if p_cambios ? 'entrega_tipo' and p_cambios->>'entrega_tipo' not in ('enviar', 'lista_sin_enviar', 'no_se_comprueba') then
    raise exception 'Entrega no válida: %.', p_cambios->>'entrega_tipo';
  end if;
  if p_cambios ? 'es_full' and jsonb_typeof(p_cambios->'es_full') not in ('boolean', 'null') then
    raise exception 'FULL es sí o no.';
  end if;
  if p_cambios ? 'arte' and p_cambios->>'arte' is not null and upper(btrim(p_cambios->>'arte')) not in ('NUEVO', 'REPITE') then
    raise exception 'Arte no válido: %. Usa NUEVO o REPITE.', p_cambios->>'arte';
  end if;
  select array_agg(distinct x) into v_ids from unnest(p_campana_ids) x where x is not null;
  if v_ids is null then
    raise exception 'No elegiste campañas.';
  end if;
  select cardinality(v_ids) - count(*) into v_n from comp_campanas where id = any (v_ids);
  if v_n > 0 then
    raise exception '% campaña(s) ya no existen. Recarga la lista; no se cambió nada.', v_n;
  end if;
  select count(*) into v_n from comp_campanas c
   where c.id = any (v_ids) and c.unidad not in (select comp_mis_unidades(array['supervisor']::app_role[]));
  if v_n > 0 then
    raise exception 'Solo el Supervisor (o el Admin) edita campañas. No se cambió nada.';
  end if;
  -- FULL solo existe en Vía Verde (Erik, 23-oct-2026: Biobox y Ecovallas
  -- son 24 h, sin FULL por minutos). Marcarlo en otra unidad abriría
  -- comp_agregar_sitios a la analista. Quitarlo (false) o devolverlo a la
  -- carga (null) sí se deja.
  if jsonb_typeof(p_cambios->'es_full') = 'boolean' and (p_cambios->>'es_full')::boolean
     and exists (select 1 from comp_campanas c where c.id = any (v_ids) and c.unidad <> 'Vía Verde') then
    raise exception 'FULL solo existe en Vía Verde. No se cambió nada.';
  end if;
  select count(*) into v_cerr from comp_campanas c where c.id = any (v_ids) and c.estatus = 'cerrada';

  begin
    with upd as (
      update comp_campanas c set
        fecha_limite = case when p_cambios ? 'fecha_limite' then (p_cambios->>'fecha_limite')::date else c.fecha_limite end,
        meta_app = case when p_cambios ? 'meta_app' then (p_cambios->>'meta_app')::int else c.meta_app end,
        full_minutos = case when p_cambios ? 'full_minutos' then (p_cambios->>'full_minutos')::int else c.full_minutos end,
        -- es_full null = sin cambio aquí (la columna es not null): solo sale
        -- de editado_app y la próxima carga lo vuelve a decidir.
        es_full = case when jsonb_typeof(p_cambios->'es_full') = 'boolean' then (p_cambios->>'es_full')::boolean
                       else c.es_full end,
        meta_full = case when p_cambios ? 'meta_full' then (p_cambios->>'meta_full')::int
                         when (p_cambios ? 'full_minutos' or jsonb_typeof(p_cambios->'es_full') = 'boolean')
                              and case when jsonb_typeof(p_cambios->'es_full') = 'boolean'
                                       then (p_cambios->>'es_full')::boolean else c.es_full end
                              and c.unidad = 'Vía Verde'
                              and not ('meta_full' = any (c.editado_app))
                           then comp_meta_full_propuesta(c.medio, case when p_cambios ? 'full_minutos'
                                                                       then (p_cambios->>'full_minutos')::int
                                                                       else c.full_minutos end)
                         else c.meta_full end,
        entrega_tipo = case when p_cambios ? 'entrega_tipo' then p_cambios->>'entrega_tipo' else c.entrega_tipo end,
        especificacion = case when p_cambios ? 'especificacion' then nullif(btrim(p_cambios->>'especificacion'), '')
                              else c.especificacion end,
        arte = case when p_cambios ? 'arte' then upper(nullif(btrim(p_cambios->>'arte'), '')) else c.arte end,
        inicio = case when p_cambios ? 'inicio' then (p_cambios->>'inicio')::date else c.inicio end,
        fin = case when p_cambios ? 'fin' then (p_cambios->>'fin')::date else c.fin end,
        cliente = case when p_cambios ? 'cliente' then nullif(btrim(p_cambios->>'cliente'), '') else c.cliente end,
        vendedor = case when p_cambios ? 'vendedor' then nullif(btrim(p_cambios->>'vendedor'), '') else c.vendedor end,
        administrador = case when p_cambios ? 'administrador' then nullif(btrim(p_cambios->>'administrador'), '')
                             else c.administrador end,
        quantum = case when p_cambios ? 'quantum' then nullif(btrim(p_cambios->>'quantum'), '') else c.quantum end,
        mediamonitor = case when p_cambios ? 'mediamonitor' then (p_cambios->>'mediamonitor')::boolean else c.mediamonitor end,
        editado_app = array(select distinct e from unnest(c.editado_app || v_set) e where e <> all (v_null) order by e),
        actualizado_en = now()
       where c.id = any (v_ids) and c.estatus = 'abierta'
      returning c.id, c.unidad, c.periodo_id
    ), mov as (
      insert into comp_movimientos (accion, unidad, periodo_id, campana_ids, n, detalle, por)
      select 'editar', u.unidad, case when count(distinct u.periodo_id) = 1 then min(u.periodo_id) end,
             array_agg(u.id order by u.id), count(*), p_cambios, v_email
        from upd u group by u.unidad
    )
    select count(*), array_agg(id) into v_cambiadas, v_cams from upd;
  exception
    when invalid_datetime_format or datetime_field_overflow or invalid_text_representation
         or numeric_value_out_of_range then
      raise exception 'Hay un valor que no se entiende (%). No se cambió nada.', sqlerrm;
    when check_violation then
      raise exception 'Revisa los valores: la vigencia no puede terminar antes de empezar y las metas no son negativas.';
  end;
  if p_cambios ? 'inicio' or p_cambios ? 'fin' then
    v_tom := comp_reaplicar_planes(coalesce(v_cams, '{}'));
  end if;
  return jsonb_build_object('cambiadas', v_cambiadas, 'cerradas_omitidas', v_cerr,
                            'sin_cambio', cardinality(v_ids) - v_cambiadas - v_cerr) || v_tom;
end $$;

-- o) Reglas: el Supervisor edita las de su unidad; las generales (unidad
--    NULL) solo el manager.
create or replace function public.comp_guardar_regla(p jsonb)
returns bigint language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  v_id bigint := (p->>'id')::bigint;
  v_u text := nullif(btrim(p->>'unidad'), '');
  v_ant text;
begin
  if v_u is not null and v_u not in ('Ecovallas', 'Biobox', 'Vía Verde') then
    raise exception 'Unidad no válida: %.', v_u;
  end if;
  if not (case when v_u is null then tiene_rol('manager') else comp_gestiona(v_u) end) then
    raise exception 'No puedes editar las reglas de %.', coalesce(comp_etiqueta_unidad(v_u), 'todas las unidades');
  end if;
  if v_id is not null then
    select unidad into v_ant from comp_reglas where id = v_id for update;
    if not found then
      raise exception 'La regla ya no existe.';
    end if;
    if not (case when v_ant is null then tiene_rol('manager') else comp_gestiona(v_ant) end) then
      raise exception 'No puedes editar las reglas de %.', coalesce(comp_etiqueta_unidad(v_ant), 'todas las unidades');
    end if;
    update comp_reglas set unidad = v_u, tipo = p->>'tipo', desde = (p->>'desde')::int, hasta = (p->>'hasta')::int,
           valor = (p->>'valor')::numeric, valor_texto = nullif(btrim(p->>'valor_texto'), ''),
           cliente_patron = nullif(btrim(p->>'cliente_patron'), ''),
           confirmada = coalesce((p->>'confirmada')::boolean, false), notas = nullif(btrim(p->>'notas'), ''),
           actualizada_por = v_email, actualizada_en = now()
     where id = v_id;
  else
    insert into comp_reglas (unidad, tipo, desde, hasta, valor, valor_texto, cliente_patron, confirmada, notas, actualizada_por)
    values (v_u, p->>'tipo', (p->>'desde')::int, (p->>'hasta')::int, (p->>'valor')::numeric,
            nullif(btrim(p->>'valor_texto'), ''), nullif(btrim(p->>'cliente_patron'), ''),
            coalesce((p->>'confirmada')::boolean, false), nullif(btrim(p->>'notas'), ''), v_email)
    returning id into v_id;
  end if;
  insert into comp_movimientos (accion, unidad, n, detalle, por)
  values ('regla', v_u, 1, p || jsonb_build_object('id', v_id), v_email);
  return v_id;
end $$;

create or replace function public.comp_borrar_regla(p_id bigint)
returns boolean language plpgsql security definer
set search_path to 'public', 'pg_temp'
set lock_timeout to '3s'
as $$
declare
  v_email text := lower(coalesce(auth_email(), ''));
  r comp_reglas%rowtype;
begin
  select * into r from comp_reglas where id = p_id for update;
  if not found then
    return false;
  end if;
  if not (case when r.unidad is null then tiene_rol('manager') else comp_gestiona(r.unidad) end) then
    raise exception 'No puedes borrar las reglas de %.', coalesce(comp_etiqueta_unidad(r.unidad), 'todas las unidades');
  end if;
  delete from comp_reglas where id = p_id;
  insert into comp_movimientos (accion, unidad, n, detalle, por)
  values ('regla', r.unidad, 1, jsonb_build_object('borrada', to_jsonb(r)), v_email);
  return true;
end $$;

-- p) Fuente de Vía Verde para armar la carga (23-oct-2026, hallazgo #1 de la
--    revisión de la bitácora). El Supervisor (Victor) arma la carga de Vía
--    Verde con desdePautaVV (src/lib/bitacoraComp.ts), pero las políticas de
--    vv_campanas, vv_pautas, vv_ocupacion y vv_espacios solo dejan leer a
--    comercial, pautas y manager: para él llegaban VACÍAS y la carga (foto
--    completa) habría retirado todo. Esas políticas NO se tocan (son de
--    Pauta VV y del plano); esta RPC de SOLO LECTURA le entrega lo justo,
--    protegida con comp_gestiona('Vía Verde') (Supervisor de Vía Verde o
--    manager).
--    Devuelve un solo jsonb (no hay corte de 1,000 filas de PostgREST):
--      campanas   = las de vv_campanas que tienen pautas en la lista
--      pautas     = las de vv_pautas que tocan [p_desde, p_hasta]
--      ocupacion  = las del plano que tocan el rango: lo capturado en la app
--                   (origen 'app') y el plano vigente (plano_mes), con la
--                   regla de planoVigente() del TS: el más reciente que no
--                   sea posterior al mes de p_desde; si no hay, el primero
--                   después. Se elige aquí con TODOS los planos, así que el
--                   TS, al repetir la regla con lo que llega, da el mismo.
--                   Solo vendida y pautada: las «reservada» son prospectos de
--                   comercial que la app no usa y el Supervisor no debe ver
--                   (revisor-rls, 23-oct-2026). v_plano sí se elige con todas.
--      espacios   = vv_espacios completo (clave, tipo_espacio, tramo, activo)
--      totales    = count(*) de cada lista. Salen del MISMO select que arma
--                   la lista, así que aquí siempre coinciden con su largo:
--                   solo servirían si la app partiera o paginara la
--                   respuesta (revisión del 23-oct-2026). Lo que de verdad
--                   evita una lectura incompleta es que todo venga en este
--                   único jsonb: si la RPC falla, la pantalla no arma nada.
--    Solo las columnas que usa desdePautaVV: sin creada_por (correos).
--    Rango: hasta 93 días contando los dos extremos (un mes o una catorcena
--    con holgura).
create or replace function public.comp_fuente_pauta_vv(p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_mes text; v_plano text; v_cam jsonb; v_pau jsonb; v_ocu jsonb; v_esp jsonb;
  v_nc int; v_np int; v_no int; v_ne int;
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

  select coalesce(jsonb_agg(jsonb_build_object('clave', e.clave, 'tipo_espacio', e.tipo_espacio,
                                               'tramo', e.tramo, 'activo', e.activo) order by e.clave), '[]'),
         count(*)::int
    into v_esp, v_ne
    from vv_espacios e;

  return jsonb_build_object('desde', p_desde, 'hasta', p_hasta, 'plano_mes', v_plano,
                            'campanas', v_cam, 'pautas', v_pau, 'ocupacion', v_ocu, 'espacios', v_esp,
                            'totales', jsonb_build_object('campanas', v_nc, 'pautas', v_np,
                                                          'ocupacion', v_no, 'espacios', v_ne));
end $$;

-- ------------------------------------------------------------
-- 7) Permisos de las funciones. Nada para anon ni PUBLIC; las internas
--    (comp_tiene_rol_en, comp_es_analista_de, comp_sitios_ajenos,
--    comp_tomas_ajenas, comp_meta_full_propuesta, comp_ruta_sitio,
--    comp_aplicar_planes, comp_reaplicar_planes, comp_campana_con_trabajo,
--    comp_retirar, comp_fechas_plan, comp_ventanas) solo las usan otras
--    funciones security definer (#19). comp_fechas_plan ya no se abre: sin
--    tope de rango, cualquiera podía ocupar la CPU (revisión del 23-oct-2026);
--    la pantalla tiene su espejo en TS.
-- ------------------------------------------------------------
revoke all on function public.comp_llave(text), public.comp_clave_sitio(text), public.comp_espacio_vv(text),
  public.comp_mis_unidades(app_role[]), public.comp_gestiona(text), public.comp_lee(text),
  public.comp_tiene_rol_en(text, app_role, text), public.comp_es_analista_de(text, text),
  public.comp_etiqueta_unidad(text), public.comp_plan_normal(jsonb), public.comp_fechas_plan(jsonb, date, date),
  public.comp_ventanas(date, date, jsonb, date, date, date, date),
  public.comp_meta_full_propuesta(text, int), public.comp_sitios_ajenos(bigint[]), public.comp_tomas_ajenas(bigint[]),
  public.comp_ruta_sitio(text, text, text), public.comp_aplicar_planes(bigint[], jsonb),
  public.comp_reaplicar_planes(bigint[]), public.comp_campana_con_trabajo(bigint), public.comp_retirar(bigint[]),
  public.comp_cargar_campanas(text, text, jsonb, jsonb, boolean, boolean), public.comp_generar_tomas(bigint[], jsonb),
  public.comp_editar_tomas(bigint[], jsonb), public.comp_agregar_tomas(bigint[], date[], boolean),
  public.comp_quitar_tomas(bigint[], boolean), public.comp_retirar_campanas(bigint[], boolean),
  public.comp_equipo(text), public.comp_monitoristas(text), public.comp_asignar_analista(bigint[], text),
  public.comp_pasar_pendiente(text, text, text, bigint, boolean, boolean),
  public.comp_marcar_sitios(bigint[], boolean, date),
  public.comp_cancelar_sitios(bigint[], text), public.comp_restaurar_sitios(bigint[]),
  public.comp_agregar_sitios(bigint, text[]), public.comp_cerrar_campanas(bigint[], boolean, text),
  public.comp_editar_campanas(bigint[], jsonb), public.comp_guardar_regla(jsonb), public.comp_borrar_regla(bigint),
  public.comp_fuente_pauta_vv(date, date)
  from public, anon, authenticated;

grant execute on function public.comp_llave(text), public.comp_clave_sitio(text), public.comp_espacio_vv(text),
  public.comp_mis_unidades(app_role[]), public.comp_gestiona(text), public.comp_lee(text),
  public.comp_etiqueta_unidad(text), public.comp_plan_normal(jsonb),
  public.comp_cargar_campanas(text, text, jsonb, jsonb, boolean, boolean), public.comp_generar_tomas(bigint[], jsonb),
  public.comp_editar_tomas(bigint[], jsonb), public.comp_agregar_tomas(bigint[], date[], boolean),
  public.comp_quitar_tomas(bigint[], boolean), public.comp_retirar_campanas(bigint[], boolean),
  public.comp_equipo(text), public.comp_monitoristas(text), public.comp_asignar_analista(bigint[], text),
  public.comp_pasar_pendiente(text, text, text, bigint, boolean, boolean),
  public.comp_marcar_sitios(bigint[], boolean, date),
  public.comp_cancelar_sitios(bigint[], text), public.comp_restaurar_sitios(bigint[]),
  public.comp_agregar_sitios(bigint, text[]), public.comp_cerrar_campanas(bigint[], boolean, text),
  public.comp_editar_campanas(bigint[], jsonb), public.comp_guardar_regla(jsonb), public.comp_borrar_regla(bigint),
  public.comp_fuente_pauta_vv(date, date)
  to authenticated;
