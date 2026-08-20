# GPO VALLAS — Central de Operaciones

Proyecto **Vite + React 18 + TypeScript**. Migración completa del HTML original.

---

## Arrancar en macOS

### 1. Node.js

Necesitas **Node 18 o superior** (recomendado 20 LTS). Verifica:

```bash
node -v
```

Si no lo tienes, la vía más limpia en Mac:

```bash
# con Homebrew
brew install node

# o con nvm, si manejas varias versiones
nvm install 20 && nvm use 20
```

> No hay que instalar Vite aparte: viene como dependencia del proyecto y se
> instala con `npm install`.

### 2. Dependencias

```bash
cd gpo-vallas
npm install
```

### 3. Credenciales

Copia la plantilla y pega tu anon key real de Supabase:

```bash
cp .env.example .env.local
```

Abre `.env.local` y reemplaza `PEGA_AQUI_TU_ANON_KEY`.

La encuentras en Supabase → Project Settings → API → **anon public**.

> `.env.local` está en `.gitignore` a propósito: **nunca** se sube al repo.
> Por eso este paquete no lo incluye — hay que crearlo en cada máquina.

### 4. Correr

```bash
npm run dev        # HTTPS  → el GPS funciona
npm run dev:http   # HTTP   → sin GPS, por si el certificado estorba
```

---

## Sobre el HTTPS y el GPS

La geolocalización del navegador **solo funciona en orígenes seguros**:
`https://` o `localhost`. Por eso `npm run dev` levanta con un certificado
autofirmado.

**Al probar desde el celular hay que escribir el `https://` completo.** Si
escribes solo la IP, el navegador asume `http://`, el servidor TLS corta la
conexión y verás *"se interrumpió la conexión"* — parece un problema de red
pero no lo es.

```
https://192.168.X.X:5173     ← así
192.168.X.X:5173             ← así NO
```

La primera vez cada dispositivo avisa *"conexión no privada"*. En Chrome:
**Configuración avanzada → Continuar**. En Safari: **Mostrar detalles →
Visitar este sitio web**. Pasa una sola vez por dispositivo.

---

## Trabajar entre Mac y Windows

Pasarse el proyecto en ZIP funciona una vez, pero **se desincroniza rápido**:
en cuanto edites en las dos máquinas vas a tener versiones distintas sin saber
cuál es la buena.

Lo correcto es un repositorio Git:

```bash
git init
git add .
git commit -m "Migración completa a Vite + React + TypeScript"
git remote add origin https://github.com/TU-USUARIO/app-operativa.git
git push -u origin main
```

Después, en cada máquina: `git pull` al empezar, `git push` al terminar.

`.gitignore` ya excluye `node_modules`, `dist` y `.env.local`. Cada máquina
corre su propio `npm install` y tiene su propio `.env.local`.

**Ojo con los saltos de línea:** Windows usa CRLF y macOS LF. Sin control,
cada `git status` marcaría todos los archivos como modificados. El archivo
`.gitattributes` incluido lo normaliza.

---

## Estructura

```
src/
  App.tsx                  → sesión, login (correo y Google), navegación
  index.css                → todos los estilos, incluido el responsive
  lib/
    supabase.ts            → cliente único (lee de .env.local)
    constants.ts           → catálogos, colores, roles, horario del validador
    helpers.ts             → SLA, distancias, etiquetas de cara, área efectiva
    storage.ts             → subida de archivos al bucket `evidencias`
    navegacion.ts          → enlaces a Google Maps / Waze / Apple Maps
    useNotificaciones.ts   → campana y globitos de chat
    haversine.ts           → distancias y ordenamiento por cercanía
    convexHull.ts          → áreas sombreadas de las rutas en el mapa
  types/db.ts              → tipos del esquema, verificados contra la base
  components/              → IncCard, CampanaNotifs, SubirArchivos, IrAqui…
  modules/
    incidencias/           → vista + 8 modales + KPIs
    rutas/                 → rutas de monitoreo con mapa y navegación
    fijacion-externa/      → módulo conectado al sistema externo por FDW
    usuarios/              → alta de usuarios y asignación de roles
```

### Archivos sin uso

Estos quedaron de etapas anteriores y **hoy no los importa nadie**:

- `src/components/Dashboard.tsx` — la pestaña Indicadores usa `KpiView`.
  (En el HTML original tampoco se usaba.)
- `src/components/FlujoFotos.tsx` — lo reemplazó `SubirArchivos.tsx`.
- `src/components/Mapa.tsx` — `RutasView` tiene su propio mapa.

Se pueden borrar sin romper nada. Se dejaron por si sirven de base para el
módulo de fijación interna.

---

## SQL incluido

Van aparte porque se aplican a mano en el SQL Editor de Supabase:

| Archivo | Qué hace |
|---|---|
| `notificar_area_asignada.sql` | **Pendiente de aplicar.** Trigger que avisa al área cuando se le dirige una incidencia (`assigned_area`). Sin esto, esa asignación no notifica a nadie. |
| `diagnostico_incidencias.sql` | Consultas de verificación del esquema. Solo lectura. |
| `diagnostico_notificaciones.sql` | Diagnóstico de la campana y los triggers. Solo lectura. |
| `verificar_mis_notificaciones.sql` | Qué notificaciones le tocan a cada correo. Solo lectura. |

---

## Pendientes

- Aplicar `notificar_area_asignada.sql`.
- Habilitar Google en Supabase → Authentication → Providers, y dar de alta las
  URLs de redirect (incluida la de red local con `https://`).
- Importar el archivo de campañas para el seguimiento de rutas (fase 2).
- Despliegue en Vercel con las variables de entorno del proyecto.
