# Login con Google

El botón ya está en la pantalla de acceso. Falta conectarlo, y hay **una
decisión de fondo que tomar antes de tocar nada** — está al final, en la
sección "El conflicto con el registro cerrado". Léela primero: si no, vas a
configurar todo y el login va a fallar de una forma difícil de entender.

---

## 1. En Google Cloud

console.cloud.google.com → crea un proyecto (o usa uno existente).

### 1.1. Pantalla de consentimiento

**APIs y servicios → Pantalla de consentimiento de OAuth**

- Tipo de usuario: **Interno** si GPO VALLAS tiene Google Workspace. Es la
  mejor opción con diferencia: solo entra gente de tu dominio y Google se
  encarga, sin que tú programes nada.
- Si no hay Workspace, será **Externo**. Entonces cualquier cuenta de Gmail
  del mundo puede pasar esta pantalla, y el filtro tienes que ponerlo tú
  (ver §4).
- Nombre de la app: `Central de Operaciones GPO VALLAS`
- Correo de soporte y de contacto: el tuyo.

### 1.2. Credenciales

**APIs y servicios → Credenciales → Crear credenciales → ID de cliente de
OAuth** → Tipo: **Aplicación web**.

**Orígenes autorizados de JavaScript:**

```
https://<tu-proyecto>.vercel.app
```

**URI de redireccionamiento autorizados** — aquí va el error clásico:

```
https://qztxpcfbbbmvgmtjnlxg.supabase.co/auth/v1/callback
```

> **Es la URL de SUPABASE, no la de Vercel.** El flujo es: tu app manda a
> Google → Google regresa a **Supabase** → Supabase crea la sesión y manda a
> tu app. Google nunca habla directo con Vercel. Poner aquí la URL de Vercel
> es el motivo número uno de `redirect_uri_mismatch`.

Guarda el **Client ID** y el **Client Secret**.

---

## 2. En Supabase

**Authentication → Sign In / Providers → Google** → habilitar, y pegar el
Client ID y el Client Secret.

Ahí mismo Supabase te muestra su *callback URL*. **Cópiala y compárala con la
que pusiste en Google.** Deben ser idénticas, carácter por carácter.

---

## 3. Las URLs de retorno

**Authentication → URL Configuration:**

- **Site URL:** `https://<tu-proyecto>.vercel.app`
- **Redirect URLs:** esa misma **y** `https://<tu-proyecto>.vercel.app/**`

Sin esto, Supabase rechaza el regreso después de autenticar. Es el mismo paso
que ya hiciste para el correo de recuperación de contraseña; si ya está, no
hay que repetirlo.

---

## 4. El conflicto con el registro cerrado ⚠️

**Esto es lo importante, y hay que decidirlo antes de habilitar Google.**

En §9.1 del handoff cerramos el registro público:

> Authentication → Sign In / Providers → **"Allow new users to sign up"** → apagado

Se hizo porque veintiuna tablas se leen con `auth_email() IS NOT NULL`, o sea
**cualquiera con sesión**. Con el registro abierto, cualquier persona se crea
una cuenta y lee el inventario, las rutas y el chat interno.

**Pero ese interruptor aplica a TODOS los métodos, incluido Google.** Con el
registro apagado, alguien que entre con Google y no tenga cuenta previa en
`auth.users` recibe un error de "registro deshabilitado" — aunque su correo
esté en `usuario_roles` con su rol bien puesto.

Y hoy tienes **23 personas con rol y solo un puñado con cuenta creada**. O
sea que la mayoría del equipo caería en ese caso.

Hay dos caminos y son excluyentes:

### Opción A — Dejar el registro cerrado

Google sirve solo para quien **ya** tiene cuenta. A los demás los das de alta
con **Authentication → Users → Invite user** y luego ellos vinculan Google.

- ✅ Nadie de fuera crea cuenta jamás. Es lo más cerrado.
- ❌ Trabajo manual por cada persona, y Google deja de ser el atajo que
  querías: si igual tienes que invitar a cada quien, casi no aporta.

### Opción B — Registro abierto, pero solo tu dominio

Se vuelve a permitir el registro y se pone un candado por dominio en la base.
Quien no venga de un dominio autorizado no puede crear cuenta.

- ✅ La gente entra sola con su cuenta de trabajo. Sin rol no ve nada (la RLS
  la detiene) y aparece la pantalla de "falta darte acceso".
- ⚠️ Depende de que el candado esté bien puesto. Por eso el SQL de abajo
  falla cerrado: si algo sale mal, **rechaza**, no acepta.

**Si tu Google Cloud es de tipo "Interno" (Workspace), la Opción B ya viene
resuelta por Google** y este SQL es un cinturón extra — que igual conviene,
porque el registro por correo y contraseña sigue existiendo y ese no lo filtra
Google.

```sql
-- ============================================================
-- Candado de dominio para el registro.
-- Solo si eliges la Opción B.
--
-- Se corre como trigger BEFORE INSERT sobre auth.users: es el único punto por
-- el que pasan TODAS las altas, venga de Google, de correo o de donde sea.
-- ============================================================
create table if not exists dominios_permitidos (
  dominio text primary key,
  nota    text
);
alter table dominios_permitidos enable row level security;
-- Sin políticas: nadie la toca por la API. Solo el trigger, que es definer.

insert into dominios_permitidos (dominio, nota) values
  ('gpovallas.com',    'Personal de GPO VALLAS'),
  ('viaverde.com.mx',  'Vía Verde — cruz.ivan y tapia.saul ya tienen rol')
on conflict do nothing;

create or replace function public.validar_dominio_registro()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_dominio text;
begin
  v_dominio := lower(split_part(coalesce(new.email, ''), '@', 2));

  -- Falla cerrado: sin correo legible, no se crea la cuenta.
  if v_dominio = '' then
    raise exception 'No se pudo determinar el dominio del correo.';
  end if;

  if not exists (
    select 1 from dominios_permitidos d where d.dominio = v_dominio
  ) then
    raise exception 'El registro está limitado al personal de GPO VALLAS. Si crees que es un error, contacta al administrador.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validar_dominio on auth.users;
create trigger trg_validar_dominio
  before insert on auth.users
  for each row execute function public.validar_dominio_registro();

-- Verificación: debe listar los dos dominios y el trigger.
select * from dominios_permitidos;
select tgname, tgenabled from pg_trigger
where tgrelid = 'auth.users'::regclass and not tgisinternal;
```

Para agregar un dominio después (un proveedor, otra empresa del grupo), es un
`insert` en `dominios_permitidos`. No hay que tocar código.

> **Y que quede claro qué NO hace esto:** el candado impide crear la cuenta,
> no da permisos. Alguien de `@gpovallas.com` que entre sin rol asignado ve la
> pantalla de "falta darte acceso" y nada más. **Los permisos siguen viviendo
> en `usuario_roles`**, como siempre.

---

## 5. Probar

1. Ventana de incógnito → tu URL de Vercel → botón de Google.
2. Con una cuenta **que ya tenga rol**: debe entrar y ver sus módulos.
3. Con una cuenta de otro dominio (un Gmail personal): debe rechazarla con el
   mensaje del trigger. Si entra, el candado no está puesto.
4. Con una cuenta de tu dominio **sin rol**: debe llegar a "falta darte
   acceso".

Después del paso 3, revisa que no haya quedado basura:

```sql
select email, created_at,
       coalesce(raw_app_meta_data->>'provider','—') as entro_por
from auth.users order by created_at desc limit 10;
```

---

## Errores comunes

| Síntoma | Causa |
|---|---|
| `redirect_uri_mismatch` | En Google pusiste la URL de Vercel. Va la de Supabase (§1.2). |
| `Signups not allowed` | Registro cerrado + cuenta que no existía. Es §4. |
| Entra y ve "falta darte acceso" | Correcto: falta su fila en `usuario_roles`. |
| Regresa al login sin error | Falta la URL en Authentication → URL Configuration (§3). |
| Funciona en local y no en Vercel | Falta el origen de Vercel en Google (§1.2). |
