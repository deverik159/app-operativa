# Guía: staging, migraciones y prueba de carga

_Auditoría primer mes, 24-sep-2026 · para Erik. Nada de esto se ha ejecutado
contra ninguna base: son los pasos y los scripts para hacerlo._

**En una línea:** un proyecto de Supabase aparte (staging) con el mismo
esquema que producción y sin datos personales; ahí se prueban los SQL antes
de producción y se corre la prueba de 300 usuarios.

Orden: §1 decidir costo → §2 crear staging → §3 migraciones → §4 Vercel
Preview → §5 prueba de carga → §6 limpieza.

Archivos:

| Archivo | Para qué |
|---|---|
| `supabase/migrations/` | Cambios de base desde hoy (ver su README) |
| `scripts/usuarios-carga.mjs` | Crea y borra los usuarios de prueba en staging |
| `tests/carga/k6-300.js` | La prueba de carga (k6) |

## 0. Reglas que no se rompen

- **La prueba de carga nunca va contra producción.** Los dos scripts se
  detienen solos si ven el ref `qztxpcfbbbmvgmtjnlxg`. Existe una salida de
  emergencia (`CONFIRMO_PRODUCCION=si`) solo para no dejar un callejón sin
  salida: **no se usa**. Crearía incidencias, fotos y avisos reales.
- **Ninguna llave en archivos.** Todo va en variables de la ventana de
  PowerShell. Al terminar, cierra esa ventana.
- **Staging no habla con sistemas reales:** ni con la base de Mario, ni con
  el push o el WhatsApp de producción (§2.5; se verifica en §2.6).
- **El dump puede traer secretos:** se limpia antes de usarlo o subirlo (§2.5).
- **Cada bloque que toca una base empieza con su candado.** Los de
  PowerShell van dentro de `if (Confirmar-…) { … }`, que PowerShell recibe
  entero: si el candado falla, no corre ninguna línea del bloque. Los de SQL
  empiezan con un `do $$ … raise exception …`: el SQL Editor se detiene en el
  primer error. Los de **producción** van aparte y rotulados; los que
  escriben piden teclear `PRODUCCION`.

En cada ventana nueva de PowerShell, desde la raíz del repo, pega este
bloque y luego el de §2.2. `Pedir` recibe una llave sin que quede en el
historial; los `Confirmar-…` son los candados:

```powershell
function Pedir($t) { [Net.NetworkCredential]::new('', (Read-Host -AsSecureString $t)).Password }
# Candados (revisión primer mes, 24-sep-2026): una cadena o un ref copiados de
# la pestaña equivocada no deben mandar a producción lo que era para staging.
function Confirmar-Staging {
  $p = 'qztxpcfbbbmvgmtjnlxg'   # producción
  if ($env:STAGING_REF -notmatch '^[a-z]{20}$' -or $env:STAGING_REF -eq $p -or
      "$env:STAGING_DB_URL" -match $p -or "$env:STAGING_DB_URL" -notmatch $env:STAGING_REF -or
      ($env:SUPABASE_URL -and $env:SUPABASE_URL -notmatch $env:STAGING_REF)) {
    throw 'ALTO: STAGING_REF, STAGING_DB_URL o SUPABASE_URL faltan, son de PRODUCCIÓN o no coinciden (§2.2; SUPABASE_URL: §5.3)' }
  # Un checkout enlazado a producción manda ahí todo comando sin destino (§2.1).
  if ((Test-Path supabase/.temp/project-ref) -and (Get-Content supabase/.temp/project-ref) -match $p) {
    throw 'ALTO: este checkout está enlazado a PRODUCCIÓN: corre npx supabase unlink (§2.1)' }
  $true
}
function Confirmar-Produccion([switch]$Escribe) {
  if ("$env:PROD_DB_URL" -notmatch 'qztxpcfbbbmvgmtjnlxg') { throw 'ALTO: PROD_DB_URL no es la cadena de PRODUCCIÓN (§2.2)' }
  if ($Escribe -and (Read-Host 'Esto ESCRIBE en PRODUCCIÓN. Para seguir teclea PRODUCCION') -cne 'PRODUCCION') { throw 'Cancelado' }
  $true
}
# Sin limpiar, el dump trae la contraseña del FDW de Mario y la llave del webhook (§2.5).
function Confirmar-DumpLimpio {
  if (Select-String -Path supabase/.temp/esquema.sql -CaseSensitive -Quiet -ErrorAction Stop -Pattern 'USER MAPPING','eyJ','sb_secret_','http_request') {
    throw 'ALTO: el dump aún trae la conexión a Mario, un webhook o una llave: límpialo (§2.5)' }
  $true
}
```

## 1. Por qué staging y cuánto cuesta

Hoy cada SQL se corre a mano en el SQL Editor de producción: el primer lugar
donde se prueba es con los datos reales. Y medir cómo aguanta la app con 300
usuarios a la vez requiere 300 sesiones falsas capturando: eso no puede
pasar en producción.

| Opción | Costo | Ojo |
|---|---|---|
| Proyecto **Free** (en una organización Free) | $0 | Se **pausa** tras ~1 semana sin uso (se reactiva desde el panel). Cómputo mínimo y fijo: sirve para probar SQL, pero la prueba de carga saldría peor que en producción y no diría nada útil. |
| Proyecto extra en la **organización Pro** | Se cobra **por hora** según su tamaño de cómputo (un Micro ronda US$10/mes; los créditos de cómputo del plan normalmente ya los consume producción) | **Valídalo con dirección.** Se puede subir de tamaño solo el día de la prueba y bajarlo después. |

Recomendación: staging en la organización Pro, en tamaño Micro. El día de
la prueba de carga súbelo al **mismo tamaño que producción** (si no, los
números no dicen nada de producción) y regrésalo a Micro al terminar.
Confirma los precios vigentes en supabase.com/pricing.

## 2. Crear staging y copiarle la línea base

### 2.1. Proyecto y herramientas

1. Supabase → New project: `app-operativa-staging`, en la **misma región**
   que producción (Settings → General de producción). La contraseña de la
   base va a tu gestor de contraseñas, no a un archivo.
2. Herramientas en Windows:
   - **Docker Desktop** (`winget install Docker.DockerDesktop`): el CLI de
     Supabase lo usa para `db dump`. Ábrelo antes de los comandos.
   - **psql**: `winget search PostgreSQL`, instala la 17 y en el instalador
     marca solo *Command Line Tools*. Agrega su carpeta `bin` al PATH.
   - **CLI de Supabase** por npx (la primera vez lo descarga):
     `npx supabase --version`. Si falla la descarga del binario, usa Scoop:
     `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git`
     y `scoop install supabase` (entonces escribe `supabase` en vez de
     `npx supabase`).
3. Una sola vez en el repo: `npx supabase login` y `npx supabase init`
   (crea `supabase/config.toml`; contesta **N** a las preguntas de VS Code
   / IntelliJ). Súbelo al repo: no trae secretos. En ese archivo agrega:

   ```toml
   [functions.enviar-push]
   verify_jwt = false
   ```

   Así ningún deploy vuelve a prender Verify JWT por olvido (el trigger del
   push llama sin token de usuario; lo autoriza `x-push-secret`).
4. **Que el checkout no quede enlazado a producción.** `GUIA-PUSH.md` pedía
   `supabase link` a producción, y ese enlace (`supabase/.temp/project-ref`)
   es de cada máquina. En cada máquina donde sigas esta guía corre
   `npx supabase unlink` (si no había enlace, solo lo avisa).
   `Confirmar-Staging` lo vuelve a revisar en cada bloque.

### 2.2. Cadenas de conexión

Panel de cada proyecto → **Connect** → *Session pooler* (funciona sin IPv6).
Queda así: `postgresql://postgres.<ref>:<contraseña>@<host>:5432/postgres`.
El ref de staging son las 20 letras que salen en su URL del panel.

```powershell
# Todo en un solo bloque (revisión primer mes, 24-sep-2026): pegado renglón
# por renglón, el primer Pedir se tragaría el renglón siguiente como cadena.
& {
  $env:PROD_DB_URL    = Pedir 'Cadena de PRODUCCIÓN'
  $env:STAGING_DB_URL = Pedir 'Cadena de STAGING'
  $env:STAGING_REF    = '<ref-de-staging>'
  Confirmar-Staging      # debe decir True
  Confirmar-Produccion   # debe decir True
}
```

Si un candado dice ALTO, vuelve a pegar el bloque: lo normal es que el
portapapeles todavía trajera la otra cadena. La de producción solo hace
falta en §2.3, §2.7, §2.8 y §3; si en esa ventana no la vas a usar, deja
vacía su pregunta: su candado dirá ALTO y ningún bloque de producción correrá.

**No hace falta `supabase link`.** Todos los comandos de esta guía llevan su
destino explícito (`--db-url` o `--project-ref`). Si algún día enlazas,
enlaza **staging**, nunca producción: un `db push` sin destino iría al
proyecto enlazado. Por lo mismo, **toda sugerencia que imprima el CLI** (p.
ej. `supabase migration repair --status reverted …` cuando falla un
`db push`) se corre agregándole `--db-url` o `--project-ref`, dentro del
candado del bloque que falló.

### 2.3. Sacar la línea base de producción

**PRODUCCIÓN · solo lectura:**

```powershell
if (Confirmar-Produccion) {
  npx supabase db dump --db-url "$env:PROD_DB_URL" --role-only -f supabase/.temp/roles.sql
  npx supabase db dump --db-url "$env:PROD_DB_URL" -f supabase/.temp/esquema.sql
}
```

- Van a `supabase/.temp/`, que ya está en `.gitignore`, hasta limpiarlos.
- Sin `--schema`, el dump trae todos los esquemas propios: `public` **y**
  `externo`. Con `--schema public` solo, las vistas de Fijación Externa
  (que leen `externo.fijacion`) fallarían al crearse.
- **No se usa `--data-only`**: traería incidencias, correos, teléfonos y
  fotos de personas reales. Los catálogos se copian aparte (§2.8).

**Sin Docker (plan B):** con psql 17 instalado viene `pg_dump`
(**PRODUCCIÓN · solo lectura**):

```powershell
if (Confirmar-Produccion) { pg_dump "$env:PROD_DB_URL" --schema-only --no-owner --schema=public --schema=externo -f supabase/.temp/esquema.sql }
```

Con `--schema`, `pg_dump` deja fuera las extensiones y el servidor foráneo
de Mario, pero sí trae las tablas foráneas de `externo`: sin servidor no se
crean y el psql de §2.6 revierte todo. Antes de §2.6, mira en producción
`select extname from pg_extension;` y `select srvname from pg_foreign_server;`.
En staging habilita esas extensiones y crea el servidor con el **mismo
nombre**, apuntando a ninguna parte y **sin** user mapping (así staging
nunca llega a Mario). En el SQL Editor de **staging**:

```sql
-- Candado: en producción el esquema ya existe.
do $$ begin if to_regclass('public.incidencias') is not null then
  raise exception 'ALTO: esta base ya tiene el esquema: ¿es PRODUCCIÓN?'; end if; end $$;
create extension if not exists postgres_fdw;
create server if not exists <srvname> foreign data wrapper postgres_fdw options (host 'invalid.invalid', dbname 'postgres');
```

Con `--schema=public`, `pg_dump` puede escribir también `CREATE SCHEMA public;`,
que en staging ya existe: si el psql de §2.6 falla con
`schema "public" already exists`, borra esa línea del dump y repite.

### 2.4. Lo que el dump NO trae

| Qué | Dónde vive | Cómo se repone en staging |
|---|---|---|
| Tareas de pg_cron | esquema `cron` | §2.7 (o re-correr `prelanzamiento_300.sql`) |
| Bucket `evidencias` | `storage.buckets` | §2.7 |
| Políticas de Storage | `storage.objects` | §2.7 |
| Configuración de Auth (URLs, Google, plantillas, límites) | ajustes del proyecto | a mano (§4 y §5.2) |
| Secretos: Vault, Edge Functions, `app_config` | cada proyecto | **nuevos** para staging (§2.7) |
| Triggers sobre `auth.users` | esquema `auth` | revisar en prod: `select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;` |
| Datos | — | solo catálogos (§2.8) |

### 2.5. Limpiar el dump antes de usarlo

```powershell
Select-String -Path supabase/.temp/esquema.sql -Pattern 'USER MAPPING','password','eyJ','sb_secret_','http_request','qztxpcfbbbmvgmtjnlxg'
```

| Si aparece… | Qué es | Qué hacer |
|---|---|---|
| `CREATE USER MAPPING … password` | La contraseña de la base de **Mario** (FDW) | Borra esa sentencia completa. Staging NO se conecta a Mario: Fijación Externa dará error ahí, y es lo correcto (marcar fijado escribe en SU sistema). |
| `supabase_functions.http_request(…)` en un `CREATE TRIGGER` | El webhook a `dynamic-worker` (WhatsApp), con una llave en sus encabezados | Borra ese `CREATE TRIGGER` completo. En staging nadie debe recibir WhatsApp. |
| `eyJ…` o `sb_secret_…` sueltos | Una llave | Bórrala; averigua de qué es antes de seguir. |
| `qztxpcfbbbmvgmtjnlxg` dentro de una función | URL de producción escrita en el código (`notificar_push` la trae) | Déjala en el archivo: se corrige en staging en §2.7. |

Este archivo limpio es también la **línea base** de las migraciones (§3).
Queda limpio cuando `Confirmar-DumpLimpio` dice True; §2.6 y §3 no avanzan
sin eso.

### 2.6. Aplicar a staging

1. Staging → Database → Extensions: habilita **pg_cron** y **pg_net**
   (`supabase_vault` ya viene). Con el dump del CLI, `postgres_fdw` y el
   servidor de Mario los crea el propio dump; con el plan B, ver §2.3.
2. Aplica todo en una sola transacción (si algo falla, no queda nada a medias):

```powershell
if ((Confirmar-Staging) -and (Confirmar-DumpLimpio)) {
  psql --single-transaction --variable ON_ERROR_STOP=1 --file supabase/.temp/roles.sql --file supabase/.temp/esquema.sql --dbname "$env:STAGING_DB_URL"
}
```

Si falla por una extensión que falta, habilítala y repite. Si `roles.sql`
viene vacío, quita ese `--file`. Si falla por `supabase_functions`, quedó el
webhook: bórralo del dump (§2.5); **no** habilites Database Webhooks en
staging.

3. Verifica: corre esto en el SQL Editor de **los dos** proyectos; los
números deben coincidir (en staging, `triggers` sale menor por los webhooks
que quitaste):

```sql
select
  (select count(*) from pg_policies where schemaname = 'public') as politicas,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public') as funciones,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal) as triggers,
  (select count(*) from information_schema.tables where table_schema = 'public') as tablas_y_vistas;
```

4. **Staging no habla con Mario ni con WhatsApp.** En el SQL Editor de
**staging** esto debe regresar **cero filas** antes de seguir a §2.7, y otra
vez antes de §5. Un webhook guarda su URL y su llave en los argumentos del
trigger, no en una función: por eso la consulta de §2.7 no lo ve.

```sql
select 'trigger' as que, tgrelid::regclass::text as donde, tgname::text as nombre
from pg_trigger
where not tgisinternal and pg_get_triggerdef(oid) ~* 'http_request|dynamic-worker|qztxpcfbbbmvgmtjnlxg'
union all
select 'user_mapping', srvname::text, usename::text from pg_user_mappings;
```

Si sale algo, bórralo en staging (`drop trigger <nombre> on <donde>;` o
`drop user mapping for <nombre> server <donde>;`) y también del dump.

### 2.7. Lo que se repone a mano

Todo lo que en esta sección se corre en el SQL Editor de **staging** lleva
**arriba** este candado. En staging, en este punto, todavía no hay
incidencias ni usuarios; en producción sí:

```sql
do $$ begin if (select count(*) from public.incidencias) > 0 or (select count(*) from public.usuarios) > 5 then
  raise exception 'ALTO: esta base tiene datos: parece PRODUCCIÓN (en staging, §2.7 va antes de §5)'; end if; end $$;
```

**Tareas de pg_cron.** En el SQL Editor de **staging** pega el candado y,
debajo, `prelanzamiento_300.sql` completo (es re-ejecutable): recrea las
dos purgas y su PASO 6 confirma que `anon` quedó sin permisos, como en
producción. Para ver si producción tiene otras tareas, corre ahí:
`select jobname, schedule, command from cron.job order by jobname;`.
`limpiar-chat-diario` no hace falta en staging.

**Bucket y sus políticas.** **PRODUCCIÓN · solo lectura:**

```sql
select id, public, file_size_limit, allowed_mime_types from storage.buckets;

-- Genera los CREATE POLICY de storage.objects para pegarlos en staging:
select format('create policy %I on storage.objects as %s for %s to %s%s%s;',
  policyname, permissive, cmd, array_to_string(roles, ', '),
  case when qual is not null then ' using (' || qual || ')' else '' end,
  case when with_check is not null then ' with check (' || with_check || ')' else '' end)
from pg_policies where schemaname = 'storage' and tablename = 'objects';
```

En staging: Storage → New bucket `evidencias`, **Public**, con el mismo
límite y tipos; luego, en su SQL Editor, pega el candado y debajo los
`create policy` generados.

**Push, con secretos NUEVOS (nunca los de producción):**

1. Secreto compartido y llaves VAPID de staging:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` y
   `npx web-push generate-vapid-keys`.
2. En el SQL Editor de **staging** pega el candado y, debajo,
   `push_secret_vault.sql`, y cambia dos cosas antes de correrlo:
   `'CAMBIA-ESTE-SECRETO'` por el secreto nuevo, y en `v_url` el ref de
   producción por el de staging. Después, esto debe regresar **cero filas**:
   `select p.oid::regprocedure from pg_proc p where p.prosrc like '%qztxpcfbbbmvgmtjnlxg%';`
3. Secretos y funciones en staging (usa `Pedir` para los valores):

```powershell
if (Confirmar-Staging) {
  $env:STAGING_PUSH_SECRET = Pedir 'PUSH_SECRET de staging'
  $env:STAGING_VAPID_PRIVADA = Pedir 'VAPID privada de staging'
  npx supabase secrets set --project-ref $env:STAGING_REF "PUSH_SECRET=$env:STAGING_PUSH_SECRET" "VAPID_PRIVATE_KEY=$env:STAGING_VAPID_PRIVADA" "VAPID_PUBLIC_KEY=<pública de staging>" "VAPID_SUBJECT=mailto:mejia.erik@gpovallas.com"
  npx supabase functions deploy enviar-push --no-verify-jwt --project-ref $env:STAGING_REF
}
```

Si Docker no está corriendo, agrega `--use-api` al deploy. `limpiar-chat` es
opcional en staging (si no configuras su `app_config`, la tarea solo avisa).

**Tu acceso.** En staging solo existen las cuentas que crees. Authentication
→ Add user (tu correo, confirmado) y en el SQL Editor de **staging**:

```sql
do $$ begin if (select count(*) from public.incidencias) > 0 or (select count(*) from public.usuarios) > 5 then
  raise exception 'ALTO: esta base tiene datos: parece PRODUCCIÓN (en staging, §2.7 va antes de §5)'; end if; end $$;
insert into usuarios (email, nombre) values ('mejia.erik@gpovallas.com', 'Erik Mejía');
insert into usuario_roles (usuario_email, rol) values ('mejia.erik@gpovallas.com', 'manager');
```

### 2.8. Catálogos (sin datos de personas)

Solo tablas de catálogo. **No** se copian `usuarios`, `usuario_roles`,
`tecnicos`, `incidencias`, `evidencias`, `mensajes`, `notificaciones`,
`push_suscripciones`, `app_config` ni nada de pauta con correos.

Lee de **PRODUCCIÓN** (solo lectura) y escribe en **STAGING**:

```powershell
if ((Confirmar-Produccion) -and (Confirmar-Staging)) {
  $tablas = 'catalogo_incidencias','causas_raiz','arbol_digital','sla_areas','sla_validacion','unidades_negocio','areas','catorcenas','folio_counters','checklist_plantillas','checklist_puntos','checklist_causas','nombres_pantallas'
  foreach ($t in $tablas) {
    psql "$env:PROD_DB_URL" -c "\copy public.$t to 'supabase/.temp/$t.csv' with csv header"
    psql "$env:STAGING_DB_URL" -c "\copy public.$t from 'supabase/.temp/$t.csv' with csv header"
  }
}
```

Si una tabla no existe, psql lo dice y sigue con la siguiente. `inventario`
(sitios, sin personas) es opcional: solo si quieres capturar sitios reales
desde la Preview. Si después un alta en staging marca `duplicate key … pkey`,
adelanta su secuencia:
`select setval(pg_get_serial_sequence('public.<tabla>', 'id'), (select max(id) from public.<tabla>));`.
Al terminar, borra los `.csv` de `supabase/.temp`.

## 3. Migraciones desde hoy

- Cada cambio nuevo es un archivo `supabase/migrations/AAAAMMDDHHMMSS_nombre.sql`
  (hora UTC), creado con `npx supabase migration new nombre`. Reglas de
  contenido en [supabase/migrations/README.md](supabase/migrations/README.md).
- **Primero staging, luego producción.** Siempre con `--dry-run` antes.
- Los `.sql` de la raíz se quedan como historia: no se mueven (el HANDOFF
  los referencia) ni se vuelven a correr.

**Registrar la línea base** (una vez, antes de la primera migración nueva).
Pon la fecha del día en que sacaste el dump (cambia los `20260924000000`).
Primero se copia a `supabase/migrations/`, y solo si ya está limpio: esa
carpeta sí se sube a GitHub, y una contraseña o llave que entre ahí ya no
sale del historial.

```powershell
if (Confirmar-DumpLimpio) { Copy-Item supabase/.temp/esquema.sql supabase/migrations/20260924000000_linea_base.sql }
```

Luego se registra en **STAGING** (ya recibió ese esquema por `psql`, §2.6):

```powershell
if (Confirmar-Staging) { npx supabase migration repair 20260924000000 --status applied --db-url "$env:STAGING_DB_URL" }
```

Y en **PRODUCCIÓN · escribe** (solo el historial de migraciones):

```powershell
if (Confirmar-Produccion -Escribe) {
  npx supabase migration repair 20260924000000 --status applied --db-url "$env:PROD_DB_URL"
  npx supabase migration list --db-url "$env:PROD_DB_URL"
}
```

"Repair" solo anota en cada base que esa migración ya está: no ejecuta nada.
Si un SQL de la raíz (p. ej. `primer_mes.sql`) se corrió en producción ANTES
del dump, ya viene en la línea base; si se corre después, va como migración.

**Cada cambio nuevo**, en tres pasos separados:

1. Crea el archivo:

```powershell
npx supabase migration new indice_bandeja
```

Escribe y guarda el SQL en el archivo que creó. **No sigas si está vacío:**
el CLI aplicaría el archivo vacío, lo anotaría como hecho y el SQL que
escribas después ya no correría en ningún `db push` (solo compara
versiones). Una migración ya empujada a cualquier lado no se edita: se
corrige con otra nueva.

2. **STAGING:**

```powershell
if (Confirmar-Staging) {
  $vacias = Get-ChildItem supabase/migrations/*.sql | Where-Object { -not "$(Get-Content $_ -Raw)".Trim() }
  if ($vacias) { throw "ALTO: migración vacía ($($vacias.Name -join ', ')): escríbele el SQL antes del push" }
  npx supabase db push --db-url "$env:STAGING_DB_URL" --dry-run
  npx supabase db push --db-url "$env:STAGING_DB_URL"
}
```

3. Pruébalo en la Preview de Vercel (§4). Solo después, **PRODUCCIÓN ·
   escribe:**

```powershell
if (Confirmar-Produccion -Escribe) {
  npx supabase db push --db-url "$env:PROD_DB_URL" --dry-run
  npx supabase db push --db-url "$env:PROD_DB_URL"
  npx supabase migration list --db-url "$env:PROD_DB_URL"   # Local y Remote iguales
}
```

Si prefieres seguir pegando en el SQL Editor: pega la migración, córrela y
regístrala en ESE proyecto con
`npx supabase migration repair <AAAAMMDDHHMMSS> --status applied --db-url …`,
dentro de su candado: `if (Confirmar-Staging) { … "$env:STAGING_DB_URL" }`
o `if (Confirmar-Produccion -Escribe) { … "$env:PROD_DB_URL" }`.
Sin eso, el siguiente `db push` la intentaría correr de nuevo.

## 4. Vercel Preview → staging

1. Vercel → app-operativa → Settings → Environment Variables. Revisa
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` y `VITE_VAPID_PUBLIC_KEY`:
   si están marcadas también para *Preview*, edítalas y déjalas **solo en
   Production**.
2. Agrega las mismas tres con los valores de **staging**, entorno
   **Preview** únicamente. Como variable normal, no *Sensitive*: las `VITE_`
   van dentro del bundle de todos modos (la anon es pública).
3. Para que una variable nueva se use hay que **empujar un commit** (p. ej.
   una rama `staging`). *Redeploy* recicla el build anterior y no la toma.
4. Supabase **staging** → Authentication → URL Configuration: Site URL = la
   URL de la Preview, y en Redirect URLs `https://app-operativa-*.vercel.app/**`.
5. Las Preview piden iniciar sesión en Vercel (Deployment Protection). Para
   que alguien de campo pruebe sin cuenta de Vercel, usa un *Shareable
   Link* o apágala solo para Preview: decisión tuya.
6. Comprueba: en la Preview entra con tu cuenta de **staging**. Si te dice
   credenciales inválidas con la contraseña de producción, vas bien: es
   otra base.

## 5. Prueba de carga con k6

### 5.1. Qué simula

300 personas a la vez con el uso real de la app (detalle en la cabecera de
`k6-300.js`): entran en 5 minutos (login → roles → Indicadores → bandeja),
se quedan 10 minutos con la campana cada 60 s, recargan la lista cada ~5
min (y cuando les llega un aviso nuevo), a veces abren Indicadores, y 1 de
cada 20 captura un reporte de prueba con foto. El monitorista abre Pauta.
**No simula** la descarga del bundle ni de las miniaturas (CDN), el chat en
vivo ni el push: lo que se mide es la base y la API.

Instalar k6: `winget install k6 --source winget` (o `choco install k6`), y
`k6 version`.

### 5.2. Preparar staging (el día de la prueba)

1. **Cómputo igual al de producción** (Settings → Compute).
2. **Límite de login por IP.** Las 300 sesiones salen de TU máquina, una
   sola IP, y Auth limita los inicios de sesión por IP (Authentication →
   Rate Limits, del orden de 30 cada 5 min). En **staging** súbelo a ~500
   durante la prueba y regrésalo al terminar.
   Para producción: si el día del lanzamiento mucha gente entra por primera
   vez desde la misma red de oficina, ese mismo límite puede frenarlos.
   Súbelo moderadamente (100–150) esa semana.
3. **La RPC `fotos_tarjetas`** (frente de la bandeja, `primer_mes.sql`)
   aplicada en staging. Si falta, la prueba cae al respaldo viejo y lo avisa.
4. **Volumen parecido al de producción.** Sin incidencias, las listas salen
   vacías y la prueba no mide nada (el resumen lo avisa). Mira cuántas hay
   en producción (**PRODUCCIÓN · solo lectura**, en su SQL Editor); la
   siembra en staging va en §5.3, **después** de crear los usuarios.

```sql
select count(*) as total, count(*) filter (where estatus not in ('cerrada','no_reparado')) as abiertas from incidencias;
```

5. Repite en staging la verificación de §2.6 punto 4: cero filas.

### 5.3. Crear los usuarios de prueba y sembrar volumen

```powershell
if (Confirmar-Staging) {
  $env:SUPABASE_URL = "https://$env:STAGING_REF.supabase.co"
  $env:SUPABASE_SERVICE_ROLE_KEY = Pedir 'service_role de STAGING'
  $env:CARGA_PASSWORD = Pedir 'Contraseña para las cuentas de prueba (8+)'
  node scripts/usuarios-carga.mjs crear 300 --simular   # enseña la mezcla, sin tocar nada
  node scripts/usuarios-carga.mjs crear 300
}
```

Crea `carga+001@gpovallas.com` … `carga+300@…` ya confirmadas (no sale
ningún correo), con roles mezclados: 40 % reportantes, 35 % técnicos, 15 %
validadores, 5 % coordinadores y 5 % monitoristas; 3 de cada 4 en Ecovallas.
Deja las credenciales en `tests/carga/.usuarios.json` (**debe estar en
`.gitignore`**: trae contraseñas; el script avisa si no lo está). Se puede
volver a correr: actualiza en vez de duplicar.

**Siembra**, en el SQL Editor de **staging** y ya con los usuarios creados.
El candado del inicio exige que exista `carga+001`, que solo existe en
staging: en producción no corre nada. Si cambiaste `CARGA_PREFIJO` o
`CARGA_DOMINIO`, pon el correo del primer usuario de carga en el candado y
en `captured_by`.

```sql
-- SOLO STAGING. Incidencias sintéticas con la marca: las borra
-- `node scripts/usuarios-carga.mjs borrar` (van a nombre de carga+001).
-- Ajusta 3000 y los porcentajes a lo que dio producción.
do $$ begin if not exists (select 1 from auth.users where email = 'carga+001@gpovallas.com') then
  raise exception 'ALTO: esto no es staging, o faltan los usuarios de carga (§5.3)'; end if; end $$;
set session_replication_role = replica;  -- sin triggers: sin miles de avisos ni push
insert into public.incidencias (record_id, estatus, captured_by, area_reportante,
  fecha_reporte, unidad_negocio, clave_sitio, clave_medio, medio, tipo_medio,
  nombre_incidencia, area_responsable, nivel, observaciones,
  requiere_prevalidacion, prevalidada, reasignacion_pendiente)
select 'sm' || lpad(g::text, 6, '0'),
  (case when g % 5 = 0 then 'en_proceso' when g % 9 = 0 then 'por_validar'
        when g % 13 = 0 then 'reparado' when g % 17 = 0 then 'no_reparado'
        else 'cerrada' end)::estatus_incidencia,
  'carga+001@gpovallas.com', 'Monitoreo',
  now() - (g % 180) * interval '1 day' - (g % 24) * interval '1 hour',
  (array['Ecovallas','Ecovallas','Ecovallas','Vía Verde','Biobox'])[1 + g % 5],
  'PRUEBA-CARGA-SEMILLA', 'PRUEBA-CARGA-SEMILLA-' || g, 'Impreso', 'Impreso',
  'PRUEBA DE CARGA (semilla)',
  (array['Mantenimiento','Fijación','Digital','Iluminación'])[1 + g % 4],
  'Bajo', 'PRUEBA DE CARGA · semilla — no atender', false, false, false
from generate_series(1, 3000) g;
insert into public.evidencias (record_id, etapa, tipo, url, subido_por, referencia)
select record_id, 'reporte', 'foto', 'https://example.invalid/semilla.jpg', captured_by, 'PRUEBA DE CARGA'
from public.incidencias where clave_sitio = 'PRUEBA-CARGA-SEMILLA';
set session_replication_role = origin;
```

Si `set session_replication_role` marca falta de permiso, quita esas dos
líneas (los triggers correrán: tarda más y genera avisos entre usuarios de
staging). Si el tipo del estatus se llama distinto, el error lo dice
(`select pg_typeof(estatus) from incidencias limit 1;`).

### 5.4. Correr la prueba

Primero una de humo (10 usuarios, 3 minutos):

```powershell
if (Confirmar-Staging) {
  $env:SUPABASE_ANON_KEY = Pedir 'anon de STAGING'
  $env:USUARIOS_CARGA = 'C:/app-operativa/tests/carga/.usuarios.json'   # ruta ABSOLUTA, con /
  k6 run -e VUS=10 -e RAMPA=1m -e MESETA=2m tests/carga/k6-300.js
}
```

Si sale limpia, la de 300:

```powershell
if (Confirmar-Staging) { k6 run tests/carga/k6-300.js }
```

Dura ~17 minutos. Para guardar todo en JSON:
`-e RESULTADO_JSON=C:/temp/carga-AAAA-MM-DD.json` (fuera del repo). Mientras
corre, mira en staging **Reports** (CPU, conexiones, peticiones por
segundo) y después **Advisors → Query Performance**. Cada petición lleva el
encabezado `X-Client-Info: k6-carga-gpovallas` para filtrarla en los logs.

### 5.5. Cómo leer el resultado

- **p95** = el 95 % de las peticiones tardó menos que eso. Es la experiencia
  del usuario en un mal momento, no en el promedio.
- **UMBRALES**: `OK` o `FALLA` por cada uno. Si alguno falla, k6 termina con
  código 99.

| Umbral | Esperado |
|---|---|
| `http_req_failed` | menos de 1 % de peticiones con error |
| `http_req_duration{tipo:lectura}` p95 | menos de 800 ms |
| `http_req_duration{nombre:login}` p95 | menos de 2 s |
| `checks` | más de 99 % (incluye "la base devolvió la fila creada") |

- **POR ENDPOINT**: n, p50, p95, máx y fallas de cada consulta (campana,
  abiertas, historial, fotos_tarjetas, kpi_incidencias, captura…). Aquí se
  ve **cuál** es el lento. Lo normal es que la campana y los catálogos anden
  muy por debajo del umbral; lo pesado son abiertas, historial y kpi.
- **CONTADORES** (401/403/429/5xx/sin red) y **AVISOS**: el resumen dice en
  palabras si faltó la RPC, si las bandejas vinieron vacías o si hubo
  límites de peticiones.

### 5.6. Si algo falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| 429 o login p95 > 2 s | Límite de Auth por IP, o cómputo chico (el login cifra la contraseña: es CPU) | §5.2 punto 1 y 2. En producción el login es raro: la sesión se conserva. |
| p95 alto en abiertas / historial / kpi | Tamaño de la respuesta (`select=*` × 1000 filas), RLS evaluada fila por fila, falta de índice | Query Performance; `explain analyze` como usuario (abajo); proyectar columnas; en las políticas, envolver `tiene_rol(…)`/`auth_email()` en `(select …)` para que se evalúen una vez. Cada arreglo = una migración, probada aquí primero. |
| p95 alto pero staging tranquilo (CPU < 50 %) | El cuello es TU internet o tu máquina | Compara `recibido` con la duración; repite desde otra red, o con `-e VUS=150` y mira si el p95 baja a la mitad. |
| 5xx, 503, "sin red" a media prueba | Conexiones agotadas o CPU al 100 % | Reports → Database; subir cómputo o abaratar la consulta más pesada. |
| 403 | La RLS rechazó algo que la app sí hace | El endpoint de la tabla lo dice; revisa la política con ese rol. |
| 401 | Sesión vencida | El script renueva el token; si persiste, revisa la duración del JWT en Auth. |
| Aviso "RLS silenciosa" en capturas | El insert pasó pero la base no deja leer la fila de vuelta | Revisa la política SELECT del reportante. |

Para ver el plan de una consulta como la ve un usuario (SQL Editor de
staging; si `auth_email()` lee otro dato del token, ajústalo):

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","email":"carga+009@gpovallas.com"}', true);
explain analyze select * from incidencias
 where estatus not in ('cerrada','no_reparado')
 order by fecha_reporte desc, record_id limit 1000;
rollback;
```

## 6. Limpieza

```powershell
if (Confirmar-Staging) { node scripts/usuarios-carga.mjs borrar }
```

Pide escribir `BORRAR` y quita: las cuentas `carga+…@gpovallas.com`, sus
roles, fichas, avisos y suscripciones; las incidencias con la marca
"PRUEBA DE CARGA" (capturas de k6 y siembra) con sus evidencias, sus
archivos de Storage y sus avisos; y el JSON local de credenciales. Una
incidencia de esos usuarios **sin** la marca no se toca: el script la cuenta
para que la revises. Se puede volver a correr si algo se cortó.

Después:

- Regresa el límite de login de staging y su cómputo a Micro.
- Cierra la ventana de PowerShell (ahí vivían las llaves).
- Si guardaste `RESULTADO_JSON`, quédatelo fuera del repo: es tu línea de
  comparación para la siguiente prueba.
