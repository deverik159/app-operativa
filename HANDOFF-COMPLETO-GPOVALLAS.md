# HANDOFF COMPLETO — Central de Operaciones GPO VALLAS
### Documento de traspaso para retomar el proyecto sin empezar de cero

_Última actualización: 24 de septiembre de 2026. Reemplaza la versión anterior
(agosto 2026, "migración en curso"). Este documento captura TODO el contexto:
arquitectura, módulos, esquema de datos, decisiones tomadas, errores cometidos
y pendientes. Léelo completo antes de continuar._

---

## 0. RESUMEN EJECUTIVO (leer primero)

**Qué es:** app operativa interna para GPO VALLAS (publicidad exterior).
Gestiona incidencias, fijación de pautas, rutas de monitoreo y el recorrido de
campo por catorcena.

**Estado de la migración: TERMINADA.** El proyecto nació como un solo archivo
HTML (~2750 líneas, React por CDN sin build) y hoy es un proyecto
**Vite + React 18 + TypeScript** completo. El HTML viejo ya NO se necesita.

**Módulos en producción:**

| Módulo | Estado |
|---|---|
| Auth (correo + Google + recuperar contraseña) | ✅ |
| Incidencias (+8 modales) | ✅ |
| Indicadores / KPIs | ✅ |
| Usuarios y roles | ✅ |
| Fijación Externa (FDW con el sistema de Mario) | ✅ |
| Rutas de Monitoreo (mapa + navegación) | ✅ |
| Pauta y Monitoreo (campañas por catorcena) | ✅ nuevo |
| Máquinas Biobox (revisión/checklist/hoja de vida) | ✅ |
| Disponibilidad de inventario | ✅ |

**Descartados a propósito** (decisión de Erik, agosto 2026): Bitácora,
Mantenimiento Biobox, Fijación interna, Cuadrillas, RutaCuadrilla. No se
migraron y no se van a migrar. El rol `fijador` se deja en la base por si en
el futuro se retoma.

**Regla de oro:** las funciones y políticas RLS viven en **Supabase** y son
compartidas. No se migran ni se duplican. Un módulo nuevo USA las existentes
(`tiene_rol`, `auth_email`), nunca crea funciones redundantes.

### Estado operativo a septiembre de 2026

- El responsive y la PWA están verificados en iPhone y Android: safe areas,
  cámara, modales, mapas táctiles y carga de archivos ya tienen tratamiento
  específico para móvil.
- El estatus inicial lo decide el frontend. Solo incidencias de **Digital**
  fuera del horario del validador se auto-rutean; una anomalía levantada desde
  Biobox entra siempre a `por_validar`.
- Las incidencias duplicadas en `en_proceso` se bloquean tanto en Nueva
  incidencia como en Biobox, usando la cara, unidad, medio e incidencia.
- El repositorio y Vercel se sincronizan por Git; no copiar ZIP entre Windows
  y macOS. Antes de desarrollar, ejecutar `git fetch origin` y confirmar que
  `main` coincide con `origin/main`.
- **Roles separados por trabajo (21–22-sep):** existe el rol `monitorista`
  (solo ve Pauta y Monitoreo, arranca ahí); el técnico ya NO ve Pauta; el
  coordinador GESTIONA (Pauta y Rutas con acciones) pero en Incidencias es de
  consulta — sin reparar, sin reasignar, sin Fijación Externa.
- **El ciclo de campo de Pauta está completo y notificado en sus tres
  esquinas:** ruta asignada → push al monitorista; toma nueva → push al
  coordinador ("Toma por comprobar"); toma regresada con motivo → push al
  monitorista. Tocar cualquiera de esos push aterriza en Pauta RECARGADA.
- **Supabase sigue en plan Free**: sin backups automáticos, 1 GB de Storage y
  5 GB/mes de egress. Acordado: upgrade a Pro ANTES del lanzamiento global
  (la razón #1 son los respaldos). `medir_almacenamiento.sql` da el desglose;
  a la fecha el video de reparaciones es el 81% del consumo.

---

## 1. STACK Y ACCESOS

- **Vite 5 + React 18 + TypeScript 5**.
- Librerías: `@supabase/supabase-js`, `leaflet` + `@types/leaflet`,
  `xlsx` (SheetJS), `@vitejs/plugin-basic-ssl` (dev).
- Leaflet CSS se incluye en el bundle desde `src/main.tsx`; estilos propios en
  `src/index.css`.
- **Supabase** (Postgres + Auth + RLS + Storage + RPC + Realtime).
  - Project ref: `qztxpcfbbbmvgmtjnlxg`
  - URL: `https://qztxpcfbbbmvgmtjnlxg.supabase.co`
- **Integración externa** (sistema de Mario Luna, también construido con
  Supabase + Vercel) vía `postgres_fdw`.
  Servidor: `aws-0-us-west-2.pooler.supabase.com:6543`, sslmode `require`.
  Tabla importada al esquema local `externo` como `externo.fijacion`.
  Las contraseñas expuestas en chat durante la configuración **ya se rotaron**.

### Variables de entorno (`.env.local`)

```
VITE_SUPABASE_URL=https://qztxpcfbbbmvgmtjnlxg.supabase.co
VITE_SUPABASE_ANON_KEY=<la anon key real>
```

Se leen en `src/lib/supabase.ts` vía `import.meta.env`. Está en `.gitignore`:
**no se sube al repo** y hay que crearlo en cada máquina desde `.env.example`.

### Cómo correr

```bash
npm install
npm run dev        # HTTPS  → el GPS funciona
npm run dev:http   # HTTP   → sin GPS, por si el certificado estorba
```

**HTTPS y GPS — importante.** La geolocalización del navegador solo funciona en
orígenes seguros (`https://` o `localhost`). Por eso `npm run dev` levanta con
certificado autofirmado. **Al probar desde el celular hay que escribir el
`https://` completo**: si se escribe solo la IP, el navegador asume `http://`,
el servidor TLS corta la conexión y aparece *"se interrumpió la conexión"* —
parece problema de red pero no lo es. Ese fue el síntoma exacto que costó una
sesión de diagnóstico.

---

## 2. ESTRUCTURA DEL PROYECTO

```
gpo-vallas/
  .env.example            → plantilla; copiar a .env.local
  .gitattributes          → normaliza CRLF/LF entre Windows y macOS
  vite.config.ts          → HTTPS opcional, host:true, strictPort
  index.html
  src/
    main.tsx
    App.tsx               → sesión, login, recuperar contraseña, navegación
    index.css             → todos los estilos, incluido el responsive
    types/db.ts           → tipos del esquema, VERIFICADOS contra la base
    lib/
      supabase.ts         → cliente único (env)
      constants.ts        → catálogos, colores, roles, horario del validador
      helpers.ts          → SLA, distancias, caraLabel, areaEfectiva
      storage.ts          → subida al bucket `evidencias`
      navegacion.ts       → deep links a Google Maps / Waze / Apple Maps
      useNotificaciones.ts→ campana + globitos de chat
      duplicados.ts       → regla compartida contra incidencias en proceso
      plataforma.ts       → detección confiable de iPhone/iPad
      mapaTactil.ts       → interacción segura de mapas en celular
      comprimirImagen.ts  → compresión de fotos antes de subir
      haversine.ts        → distancias, nearestRoute
      convexHull.ts       → áreas sombreadas de rutas
    components/
      IncCard.tsx         → tarjeta de incidencia
      CampanaNotifs.tsx   → campana 🔔
      SubirArchivos.tsx   → cámara / galería con miniaturas
      IrAqui.tsx          → botón de navegación
    modules/
      incidencias/        → IncidenciasView, KpiView, IndicadoresView
                            NuevaInc, RepararModal, EvidenciaModal,
                            ChatModal, ReasignModal, CorreccionModal,
                            EditModal, KpiDetalleModal, TablaIncidencias
      rutas/RutasView.tsx
      pauta/              → PautaView, ImportarPautaModal
      fijacion-externa/FijacionExternaView.tsx
      biobox/             → BioboxView, RevisionModal, HistorialModal,
                            ChecklistConfigModal
      inventario/DisponibilidadView.tsx
      usuarios/UsuariosView.tsx
```

### Patrón de arquitectura

`App.tsx` hace **solo** sesión y navegación. Cada módulo carga sus propios
datos. Lo único global es la campana de notificaciones, porque la comparten
todos los módulos.

**Detalle que importa:** las pestañas `bandeja` y `todas` renderizan el MISMO
`<IncidenciasView>` en la misma posición del árbol, cambiando solo la prop
`modo`. React lo reconcilia como el mismo componente, así que alternar entre
ellas **no remonta** y conserva lista, filtros y búsqueda — igual que el HTML
viejo, donde todo vivía en `App`.

---

## 3. ESQUEMA DE DATOS (verificado contra la base)

### 3.1. Tablas existentes (del HTML original)

`incidencias` (PK = **`record_id`** text, no `id`), `evidencias`, `mensajes`,
`notificaciones`, `reasignaciones`, `tecnicos`, `catalogo_incidencias`,
`causas_raiz`, `arbol_digital`, `sla_areas`, `usuarios`, `usuario_roles`,
`inventario`, `cuadrillas`, `cuadrilla_integrantes`, `cuadrilla_pautas`,
`qtm_pautas`, `qtm_contratos`, `fijaciones`, `fijacion_evidencias`,
`catorcenas`, `areas`, `equipos`, `miembros_equipo`, `mantenimientos`,
`bitacoras`, `refacciones`, `folio_counters`, `arbol_digital`, `rutas`,
`unidades_negocio`, `rutas_monitoreo`, `ruta_ubicaciones`.

`sla_validacion` guarda dos SLA globales del validador en minutos: `reporte`
(desde que se captura) y `reparacion` (desde que el técnico la marca como
reparada). Ambos inician en 20 minutos y un manager los ajusta desde
Indicadores. La bandeja avisa de forma discreta cuando una validación está por
vencer o vencida. El reloj solo consume jornada hábil del validador: lunes a
viernes, 09:30–18:30 CDMX; se pausa por noche y fin de semana. `sla_validacion.sql`
crea la tabla, sus datos iniciales y RLS.

**Columnas de `incidencias` que el frontend NO debe mandar** — las llenan
triggers: `folio` (`set_folio`), `catorcena`/`semana`/`plaza`/`latitud`/
`longitud` (`set_derivados`), `sla_reparacion_inicio`/`sla_validacion_inicio`
(`set_sla`). El trigger `inc_auto_en_proceso` se ELIMINÓ el 30-ago-2026
(ver `fix_auto_en_proceso.sql`): pisaba el estatus de la app y mandaba todo
lo capturado en fin de semana directo a `en_proceso`. El estatus inicial lo
decide solo el frontend (auto-ruteo únicamente Digital fuera de horario;
Biobox siempre `por_validar`).

### 3.2. `area_responsable` vs `assigned_area` — CLAVE

La base ya tenía las dos columnas y la RLS ya las usaba, pero **el frontend
nunca escribía `assigned_area`** (ni el HTML viejo ni la migración). Ahora sí.

- **`area_responsable`** — la que asigna el catálogo de incidencias al
  reportar. Es el dato con el que los KPIs miden qué área **origina** la carga.
  No se toca.
- **`assigned_area`** — área que realmente repara cuando exista una
  redirección histórica. La precede sobre `area_responsable` al decidir quién
  puede atender la incidencia.

**Reasignar es el único flujo nuevo para cambiar de área.** El técnico elige
la incidencia correcta del catálogo; el catálogo propone la nueva área y se
crea una solicitud. Hasta que el validador aprueba, la incidencia no cambia de
dueño ni llega al técnico nuevo. Al aprobar se actualizan nombre, área, nivel,
origen y tipo desde el catálogo, se conserva el área anterior en
`reasignada_de` y la nueva área recibe una notificación/push de reasignación.

La RLS ya razonaba así: `inc_sel_reparacion` e `inc_upd_reparacion` aceptan
`area_responsable IN mis_departamentos() OR assigned_area IN mis_departamentos()`.
Por eso el técnico del área destino ve y edita la incidencia sin cambios en la
base.

`helpers.ts` expone `areaEfectiva(inc)` = `assigned_area || area_responsable`.
Se usa para el SLA, para filtrar técnicos y para el filtro de área.

### 3.3. Roles: área de pertenencia vs área técnica

La columna `usuario_roles.departamento` tiene dos significados según el rol:

- **Reportante y Validador:** área de pertenencia del usuario. Catálogo actual:
  `Monitoreo`, `Operaciones`, `SRD`, `PPD`. Es obligatoria al crear el rol y
  nunca decide quién repara.
- **Técnico:** área técnica responsable. Sí limita qué incidencias puede
  atender: se compara contra `areaEfectiva(inc)` y la unidad asignada al rol.
- **Coordinador (desde 22-sep):** GESTIONA, no repara. Sus acciones viven en
  Pauta y Rutas; en Incidencias es de consulta (conserva la tabla de
  trazabilidad con export). `reparaEn` y `can.reparar/reasignar` ya no lo
  incluyen. Si a un coordinador le llegan notificaciones de trabajo de área,
  es que su cuenta trae el rol `reparacion` encimado: se limpia en Usuarios.
- **Monitorista (desde 21-sep):** quien recorre la ruta. SOLO ve Pauta y
  Monitoreo (un monitorista puro arranca ahí); levanta reportes desde el flujo
  post-toma con políticas RLS aditivas propias (`inc_ins/sel_monitorista`,
  `ev_ins_monitorista` — ver `rol_monitorista.sql`). Las rutas se asignan
  únicamente a este rol.

No mezclar los dos catálogos en Usuarios y roles. Para auditar roles existentes
sin modificar datos, correr `auditar_areas_roles.sql` en Supabase. Su paso 4
detecta áreas efectivas con incidencias abiertas que no tienen ningún técnico o
coordinador capaz de atenderlas.

### 3.4. `notificaciones`

Columnas: `id`, `record_id`, **`para_email`** (NOT NULL), `evento`, `mensaje`,
`unidad_negocio`, `leida`, `enviada_wa`, `creado_en`.

RLS: `notif_sel` y `notif_upd` con `lower(para_email) = lower(auth_email())`.
**No hay política de INSERT**: el frontend NO puede crear notificaciones. Solo
las crean los triggers `security definer`.

Eventos en uso: `captura`, `asignacion`, `asignacion_area`,
`asignacion_tecnico`, `reparado`, `reparado_reportante`, `cierre`, `reabierta`,
`reasignacion`, `chat`, `ruta`, `pauta_toma` (toma regresada),
`pauta_revision` (toma por comprobar), `mant_autorizado`, `mant_correctivo`.

**Enrutamiento del clic (22-sep):** las notificaciones con `record_id` llevan a
la incidencia; las de pauta (`pauta_toma`, `pauta_revision`, `ruta`) llevan a
Pauta y Monitoreo RECARGADA — el sw.js agrega `?ir=pauta` a la URL y
`enviar-push` manda el `evento` en el payload. Sin la recarga, una lista ya
abierta seguía enseñando la toma vieja y el monitorista no podía reponer.

Hay además un trigger `notificaciones` → `supabase_functions.http_request`
hacia una Edge Function (`dynamic-worker`), que es lo que alimenta
`enviada_wa`. No lo toca la app.

El push web se dispara después de insertar cada fila de `notificaciones`.
`public/sw.js` navega a la incidencia tocada, aun si la app estaba cerrada.
Las suscripciones se vuelven a crear cuando cambia la llave VAPID. Si alguien
no recibe push, primero verificar que exista la fila de notificación para su
correo; después revisar su suscripción activa y la configuración VAPID.

### 3.5. Módulo Pauta (nuevo) — DOS tablas a propósito

```
pautas            → lo que viene DEL ARCHIVO. Se reemplaza al reimportar.
pauta_monitoreo   → lo que genera LA APP. NO se toca al reimportar.
```

Esta separación es la decisión de diseño más importante del módulo. Al
reimportar una catorcena —cosa que pasa seguido por correcciones y cortes— se
borra y recarga `pautas`, pero el trabajo de campo ya registrado (fecha de
toma, comprobación, quién) vive en `pauta_monitoreo` y **sobrevive**. Si todo
estuviera en una tabla, volver a subir el Excel borraría el avance del equipo.

`pautas` llave natural: `(catorcena, vendor_face_id, coalesce(contract_number,''),
coalesce(corte,''))`. No basta `vendor_face_id`: una cara puede aparecer varias
veces legítimamente (dos campañas, o `REPITE` + `NUEVO` por corte a media
catorcena). El `coalesce` es necesario porque en Postgres dos NULL no chocan en
un UNIQUE.

`pauta_monitoreo` se liga por `(catorcena, vendor_face_id)`: a nivel cara, el
trabajo físico es uno solo aunque haya varios contratos.

**Vistas:** `vw_pauta_ruta` (pauta + avance + coordenadas + `navegable` y
`avance` ya calculados; desde el 21–22-sep expone también `fotos`,
`espec_toma` y `rechazo_motivo`/`rechazada_por` — columnas nuevas SIEMPRE al
final, `create or replace view` no permite en medio) y `vw_pauta_resumen`
(totales por ruta y campaña).

**RPCs:** `importar_pauta`, `registrar_toma`, `registrar_comprobacion`,
`rechazar_toma`, `sincronizar_rutas_desde_pauta`, `usuarios_asignables`.
`registrar_toma` NO pisa una toma anterior vigente (la primera responde
"cuándo estuvo ahí"), limpia el rechazo cuando entra la reposición y notifica
`pauta_revision` a los coordinadores solo en toma NUEVA.
`registrar_comprobacion` y `rechazar_toma` exigen coordinador/manager: la
comprobación es la validación del coordinador, con las fotos a la vista.

**Asignación de rutas:** tabla `ruta_asignaciones` (ruta + usuario, leen
todos, escriben coordinador/manager) con trigger que notifica `ruta` al
asignar Y al retirar. `usuarios_asignables` regresa SOLO monitoristas.

### 3.6. Vistas existentes

`vw_fijacion_externa`, `vw_rutas_con_coords`, `vw_rutas_resumen`,
`vw_cuadrilla_ruta`, `vw_pautas_por_fijar`, `vw_pauta_ruta`, `vw_pauta_resumen`.

### 3.7. Permisos: el hueco del coordinador

En `incidencias` las políticas de UPDATE son: `inc_upd_manager`,
`inc_upd_validador`, `inc_upd_reparacion`, `inc_upd_reportante`.
**No existe `inc_upd_coordinador`.**

Consecuencia: un coordinador puro (sin rol manager) no puede actualizar
incidencias. El HTML viejo mostraba "Asignar técnico" gateado en coordinador,
así que ese botón **nunca funcionó** para ellos — guardaba, no daba error y no
pasaba nada (RLS filtra y afecta 0 filas sin lanzar excepción).

Decisión (Erik, ago-2026): **no crear la política**. `asignarTecnico` y
`asignarArea` van gateados en `validador` (con manager como comodín).

Actualización (22-sep): el "hueco" se volvió DISEÑO. El coordinador es de
consulta en Incidencias a propósito — la app tampoco le enseña ya los botones
de reparar/reasignar, así que la RLS y la interfaz por fin cuentan la misma
historia.

---

## 4. MÓDULOS — NOTAS DE IMPLEMENTACIÓN

### 4.1. Incidencias

Alta por **reporte de sitio**: se elige el sitio una vez y se agregan N
incidencias, cada una a las caras que apliquen. Cada par (incidencia × cara)
es una fila.

**La evidencia va POR PARTIDA, no por reporte.** Cada falla lleva sus propias
fotos y se ligan solo a las caras de esa falla. La cara queda en el nombre del
archivo en Storage y en la columna `referencia` de `evidencias`, que es lo que
pinta la galería. Antes la evidencia se ligaba a todas las filas del reporte y
no se sabía qué foto correspondía a qué cara.

El `record_id` se genera **antes** del insert (`crypto.randomUUID().slice(0,8)`)
para saber qué filas son de qué grupo sin depender del orden que devuelva
Postgres.

**Cola de envíos (24-sep, auditoría primer mes):** el `record_id`, la fecha, el
estatus y las rutas de Storage se fijan UNA vez al tocar Guardar
(`lib/crearReporte.ts` arma el envío) y el envío se guarda en IndexedDB antes
de mandar nada (`lib/envios.ts`). Reintentar no duplica: cada paso consulta
primero qué ya quedó. Sin red, `crearReporte` devuelve `[]` (el modal se
cierra y el aviso global `EnviosPendientes` lo manda solo al volver la señal).

Las partidas ya agregadas se pueden **editar** (✏️). La partida no se saca de
la lista mientras se edita, y al guardar se reemplaza en su posición. Si se
intenta guardar el reporte con una edición abierta, avisa.

**Auto-ruteo:** fuera del horario del validador (Lun–Vie 9:30–18:30 CDMX), las
áreas de `AREAS_AUTORUTEO` (hoy solo Digital) entran directo a `en_proceso` con
`requiere_prevalidacion=true`. `fueraHorarioValidador()` evalúa en zona horaria
de CDMX a propósito: el dispositivo del reportante puede estar en otra.

**Duplicidad:** antes de insertar, Nueva incidencia consulta incidencias en
`en_proceso`. Si coinciden unidad, medio, nombre de incidencia y cara, se
bloquea el alta y se muestra el folio existente. Biobox usa la RPC de estado de
máquina para no perder duplicados que la RLS del revisor no puede ver. Las filas
`por_validar` no bloquean: las revisa el validador.

**RepararModal** carga la evidencia de etapa `reparacion` que YA existe (subida
antes desde 📎 Evidencia) y la cuenta para el requisito obligatorio. Obligar a
resubirla sería pedirle al técnico el mismo trabajo dos veces.

**Catálogo por tipo de medio.** Nueva incidencia no decide el catálogo por la
unidad: lo decide por `inventario.tipo_medio` de las caras seleccionadas. Una
cara `Digital` obtiene la lista visible desde `arbol_digital.incidencia`; una
cara Impreso conserva `catalogo_incidencias`, restringido por `tipo_mueble`.
Esto aplica también a unidades mixtas como Ecovallas y Biobox. La incidencia
guardada desde Digital conserva exactamente el texto del árbol y nace con
`area_responsable = 'Digital'`, de modo que el técnico puede clasificarla en
`RepararModal` con la misma ruta SRD/causa/diagnóstico/solución y no queda
como “Sin clasificar”.

`catalogoDesdeArbol()` complementa nivel, origen y tipo con la fila Digital de
`catalogo_incidencias` cuando el mismo nombre existe; no sustituye el nombre
del árbol. Si el árbol no carga por RLS o red, Nueva incidencia cae al catálogo
general para no bloquear la captura: diagnosticar primero la lectura de
`arbol_digital` antes de cambiar ese comportamiento.

**Campaña POR CARA (Ecovallas, 11-sep-2026).** Una misma incidencia puede
pegarle a caras que están en campañas distintas, así que el campo Campaña ya
no es uno por partida: cada cara marcada trae su selector, **prellenado solo**
con su campaña VIGENTE HOY según `qtm_pautas` (por `vendor_face_id`, ventana
de catorcena anterior/actual/siguiente, etiquetada "APAC · Cat-18"). Con
varias vigentes (rotación digital) o ninguna, no se adivina: el reportante
elige, con "Otra…" para texto libre. Cada fila del reporte guarda la campaña
de SU cara. La fecha de "vigente" es LOCAL del dispositivo, no UTC (de noche
UTC ya va en el día siguiente y el corte de catorcena asignaba mal). Requiere
`qtm_pautas_lectura.sql`: sin él, `qtm_pautas` tiene RLS sin políticas, la app
la ve vacía y el campo se comporta como texto libre. El prellenado nunca pisa
lo que el usuario ya decidió. Las fotos siguen compartidas por partida a
propósito: foto-por-cara exacta = capturar partidas separadas.

**Nombres de pantalla (Ecovallas, 17-sep-2026).** Como el nombre de máquina
de Biobox, pero para las 103 megapantallas: tabla `nombres_pantallas`
(`vendor_face_id` → nombre), sembrada con `nombres_pantallas.sql` (upsert:
para altas o correcciones se edita el VALUES y se re-corre). Va en tabla
propia y NO en columna de `inventario` porque el inventario se sincroniza con
QTM cada noche, y `site_legacy_id` (donde vive el nombre Biobox) en Ecovallas
trae el id legado real. El nombre es POR CARA ("… 218 1/4" … "4/4"). El alta y
EditModal lo enseñan junto a la clave y lo copian a
`incidencias.nombre_biobox` — esa columna es, en la práctica, "el nombre
amigable del medio" y toda la tubería de tarjetas y modales ya la muestra.

**`causas_raiz` es catálogo de Digital.** Durante la migración se agregó por
error un selector de causa raíz para áreas no-Digital, razonando que el HTML
cargaba la tabla y la usaba en `guardar()` pero no la renderizaba. No era un
bug: Digital captura su causa por el árbol guiado (`arbol_digital`) y las demás
áreas guardan `causa_raiz` en null. El selector se quitó.

### 4.2. Rutas de Monitoreo

Agrupa **ubicaciones** (`site_id`), no caras. Un sitio con 40 caras sería
miles de puntos encimados en la misma coordenada.

Cada ruta pertenece a UNA `unidad_negocio` y UN `tipo_medio`. Hay un trigger
(`ruta_ubic_valida_segmento`) que impide mezclar segmentos.

**Navegación (sin costo):** botón 🧭 por ubicación con Google Maps, Waze y
—solo en iPhone— Apple Maps, vía deep links. No requiere API key ni
facturación. La URL de direcciones de Google admite **máximo 9 waypoints**, así
que una ruta larga se ofrece por tramos encadenados (cada tramo arranca donde
terminó el anterior). Verificado con 1, 5, 10, 11 y 43 paradas.

### 4.3. Pauta y Monitoreo

Vive en pestaña propia, no dentro de Rutas: RutasView es **administración** de
rutas y esto es **trabajo de campo** sobre una catorcena. Distinta audiencia y
distinto momento. La ven manager, coordinador, **monitorista** y fijador — el
técnico de reparación YA NO (21-sep): su trabajo es otro y mezclarlos
empalmaba funciones.

**El ciclo de campo completo (21–22-sep):**

1. **Importar la catorcena** (coordinador) y, con el botón **🗺️ Sincronizar
   rutas**, poblar `rutas_monitoreo` con los sitios y secuencias del archivo
   (RPC `sincronizar_rutas_desde_pauta`, que envuelve a `importar_rutas`;
   solo rutas numéricas — PLAZA/EDOMEX no son rutas de monitoreo). Sin esto,
   un sitio cuya ruta no existe en el módulo no se puede asignar.
2. **Asignar la ruta** a un monitorista (panel al filtrar una ruta; selector
   con SOLO monitoristas). Le llega push "Cambio en tu ruta" y al abrir Pauta
   su ruta viene pre-filtrada con ⭐ (una vez: si cambia el filtro, se
   respeta).
3. **Registrar la toma**: el modal enseña la `espec_toma` del archivo al pie
   de la tarjeta con color por regla, y EXIGE el mínimo de fotos —
   homologado contra los textos reales: tomas por DISTANCIA
   (corta/media/larga, "corta y media", comas de más, el typo "CORA") = 9;
   todo lo demás (comprobaciones del primer viernes con o sin día/noche,
   "sin obstrucción", vacío) = 3; texto no reconocido = 3 en ámbar. Las
   reglas viven en `lib/especToma.ts` (agregar una redacción = una línea);
   los videos suman evidencia pero no cuentan para el mínimo.
4. Al terminar la toma, un diálogo discreto ofrece **levantar incidencia del
   sitio**: abre el NuevaInc de siempre con el sitio ligado (unidad
   Ecovallas), guardando por `lib/crearReporte.ts` — la MISMA pieza que usa
   IncidenciasView (regla de duplicidad, RLS silenciosa y evidencia por
   grupo idénticas). Cada sitio muestra además su tag "N incidencias
   abiertas ›" (tocarlo abre un modal mínimo — nombre, área y estatus — para
   no reportar lo que ya existe; fuente: RPC `estado_maquina`, que ve todas
   las áreas).
5. **Comprobar es del coordinador**, desde el visor de fotos ("🔎 Revisar y
   comprobar"): el botón de la lista se retiró para que no se pueda validar
   sin ver las fotos. Ahí mismo puede **⛔ Regresar** la toma con motivo
   obligatorio: la cara vuelve a PENDIENTE con el motivo visible, el
   monitorista recibe push "Toma regresada" (que lo lleva a Pauta recargada)
   y su reposición limpia el rechazo sola.
6. **Tarjetas-filtro**: Sitios / Caras / Pendientes / Tomadas / Comprobadas /
   Incidencias son botones que filtran la lista al tocarse (los conteos
   salen del filtrado SIN esa dimensión, para que no se pongan en cero).

Los importadores de **Rutas de Monitoreo** son contextuales por unidad
(22-sep): Biobox ve su Excel de operación y su mapa KML; las demás unidades
ven el Excel genérico — con una línea de ayuda visible de qué archivo espera
cada uno (los `title` no existen en táctil).

Agrupa por sitio con sus caras dentro: se navega al poste una vez y ahí hay que
saber qué anuncio va en cada cara. **Dos de cada tres sitios tienen más de una
campaña** (251 de 380 en la CAT 16).

**El importador detecta las columnas por patrón, no por texto exacto.** Los
encabezados de campaña traen la catorcena dentro del nombre
(`Campaign Version CAT 16 (15)`), así que cambian cada periodo. Se toma la de
número mayor como campaña actual y la menor como anterior. Si estuvieran fijas,
el siguiente archivo importaría la campaña en blanco sin dar error.

También autodetecta la hoja (`/^CAT\s*\d/`) y permite corregirla, porque el
nombre cambia (`CAT 16(15) 21JUL-03AGO`).

**`ESTATUS` explica las fechas:** los `NUEVO` tienen fecha de fijación, los
`REPITE` no — si el arte se repite no hay que fijar de nuevo. Así que
"pendiente de fijar" = `NUEVO`.

**Rutas no numéricas:** el archivo trae `PLAZA` y `EDOMEX` en la columna RUTA
(plazas foráneas: MT, GD, QR, PB, EM). Se guardan en `ruta_clave` tal cual y
`ruta_numero` queda NULL: se ven en búsquedas y reportes, no en el recorrido.

**Duplicados del archivo:** el import usa `distinct on` para colapsar
duplicados exactos. En la CAT 16 hay 11, incluida una cara repetida 12 veces
con el mismo contrato. Sin eso, un error de captura del Excel abortaría toda la
importación.

### 4.4. Fijación Externa

Lee `vw_fijacion_externa`. El correo del grupo va en **`operadores_cuadrilla`**,
NO en `responsable_de_cuadrilla`. El estado real vive en `estado`
(PENDIENTE/COMPLETO/RESUELTO), NO en `validacion` (null en todos).

Marcar fijado sube fotos a Storage y llama a `marcar_fijacion_externa`, que
escribe en `externo.fijacion`. **Confirmado funcionando** en pruebas de agosto.

### 4.5. Máquinas Biobox (hoja de vida / revisión)

`src/modules/biobox/` — `BioboxView` + `RevisionModal` + `HistorialModal` +
`ChecklistConfigModal`.

Mismo patrón de campo que Pauta (ruta → paradas → navegación por tramos), pero
lo que se registra es una **revisión contra checklist**, no una foto de
campaña.

**El checklist es catálogo, no código.** `checklist_plantillas` /
`checklist_puntos` alimentan el botón Revisar. El botón de configuración
⚙️ Checklist se retiró el 10-sep-2026; el formato/Excel de revisión de Biobox
sigue en proceso y el flujo de captura permanece disponible.
Si los puntos vivieran en el código, cada ajuste operativo sería un
despliegue. La plantilla sembrada para Biobox es un **punto de partida**: 17
puntos en 4 grupos (Estructura, Publicidad, Operación, Entorno), armados con
lo que se puede revisar a simple vista. Se esperan cambios.

**Cada respuesta guarda una COPIA del texto del punto**
(`revision_respuestas.punto_texto`). No es redundancia por descuido: el
checklist se edita con el tiempo y una revisión de hace seis meses tiene que
seguir leyéndose tal como se contestó. Guardar solo el `punto_id` haría que
renombrar un punto reescribiera el pasado.

**Una anomalía NO es una incidencia.** Marcarla deja constancia en la
revisión; convertirla en incidencia es una casilla aparte. Si fuera
automático, una máquina grafiteada visitada cuatro veces generaría cuatro
incidencias abiertas del mismo problema. Cuando sí se levanta, se inserta en
`incidencias` con los campos necesarios de NuevaInc, pero **siempre entra a
`por_validar`**: una revisión de máquina nunca salta al técnico sin pasar por
validación. Antes de guardar también se comprueba duplicidad contra las
incidencias en proceso de toda la máquina. La foto de la anomalía
se escribe en `revision_evidencias` **y** en `evidencias` con
`etapa='reporte'`: sin lo segundo, quien atiende la incidencia por el flujo
normal la vería sin un solo archivo.

**Ligar el punto con el catálogo es lo que da valor.**
`checklist_puntos.incidencia_sugerida` empata con
`catalogo_incidencias.detalle`; de ahí salen área, impacto/nivel, origen y
tipo. Sin esa liga todo funciona, pero el revisor tiene que elegir del
catálogo completo a mano.

**El orden por default de la lista no es la secuencia de la ruta** sino el
abandono: nunca revisadas primero, luego las más viejas. La secuencia sirve
para *recorrer*; el abandono para *decidir a qué ruta ir*. Se cambia con el
selector.

`revision_respuestas` tiene el UPDATE acotado **a nivel de columna**
(`grant update (incidencia_record_id)`). Con el GRANT de tabla completa,
cualquier sesión podía mandar un PATCH y borrar una anomalía de una revisión
vieja. La política RLS sola no alcanzaba.

---

### 4.6. Importación de rutas desde My Maps (KML)

`src/lib/kml.ts` + `src/modules/rutas/ImportarKmlModal.tsx`, botón
**🗺️ Importar mapa (KML)** en Rutas de Monitoreo. Cada **capa** (`<Folder>`)
se vuelve una ruta; cada **marcador**, una parada.

No hay API pública para leer un mapa de My Maps: se exporta el KML
(⋮ → Descargar KML → marcar *"Exportar a un archivo .KML"*, si no sale .kmz
comprimido y no se puede leer) y se sube.

**Lo delicado son los nombres.** Los marcadores se llaman `Leibnitz - 116`:
esquina y, tras un guion, un número.

**Ese número NO es `site_legacy_id`.** `site_legacy_id` es el *nombre* que la
operación le da a la máquina (`ALBERCA OLÍMPICA`, `AMSTERDAM LAREDO`). El
número del mapa es el **sufijo de `site_id`**:

```
"Alberca Olímpica - 99"  →  MX_CM_BB_MEC_0099  ("ALBERCA OLÍMPICA")
"Alfonso Reyes - 102"    →  MX_CM_BB_MED_0102  ("ALFONSO REYES")
```

Comprobado 10/10 contra la muestra del diagnóstico. Eso deja **dos señales
independientes** por marcador —número y nombre— más la distancia. `alta` exige
que dos coincidan; una sola señal no pasa de `media`; y cuando número y nombre
se contradicen, baja a `baja` diciendo cuál apunta a dónde en vez de elegir en
silencio.

Pero los nombres los escribió gente distinta durante meses y el mapa real
tiene:

| Caso | Qué hace el parser |
|---|---|
| `Leibnitz - 116` | ID confiable → empate `alta` |
| `Masarayk Moliere- 91` | guion pegado, igual lo toma → `alta` |
| `Masaryk Taine 34` | sin guion → **dudoso**, se resuelve por cercanía |
| `OXXO Héroes de 47` | el 47 es de la CALLE → dudoso, cercanía manda |
| `116` (solo el número) | dudoso; se confirma con el nombre o la distancia |
| `Nicolas Romero - UCL0002` | ID no numérico, funciona igual |
| `OXXO Apolonia` | sin ID → solo cercanía |

Solo se toma como ID lo que sigue a un guion. Un número suelto al final es
**dudoso**, y si además apunta a una máquina que está a kilómetros, se
**descarta por completo**: `OXXO Héroes de 47` sí empata con la máquina 47,
pero está a 58 km — el 47 es de la calle. Descartándolo, el marcador se
resuelve por nombre o cercanía, que es lo que de verdad lo identifica. Un
número *confiable* que queda lejos sí se conserva, marcado `baja`: ahí el dato
existe y alguien tiene que mirarlo. Por eso hay vista previa con nivel de
confianza y motivo por fila, y la importación es una decisión.

Detalles que costaron un bug cada uno:

- La llave de cada marcador es un **índice**, no el nombre. En el mapa real
  hay homónimos incluso en la misma capa (`Ejercito Nacional`); con llave por
  nombre, desmarcar uno desmarcaba el otro.
- `ruta_ubicaciones` tiene `UNIQUE(site_id)`, así que dos marcadores
  apuntando a la misma máquina no crean dos paradas: el segundo **mueve** la
  primera de ruta. Se bloquea al incluir y se deduplica en el payload.
- `importar_rutas_capas` recibe `p_conservar`: los `site_id` que venían en el
  mapa pero no se importaron (desmarcados u omitidos por segmento). Sin eso,
  la limpieza opcional los sacaría de su ruta, que es lo contrario de lo que
  promete la casilla.
- Las rutas se identifican **por nombre** dentro del segmento, y conservan su
  número y color al reimportar. Renumerar dejaría el histórico apuntando a
  rutas que cambiaron de identidad.
- El modal se renderiza **antes** del `if (loading)` de RutasView: si no, al
  terminar la importación el spinner lo desmontaba y su pantalla de resultado
  —con los avisos de omitidas y sobrantes— nunca se veía.

**El tipo de medio va por parada, no por importación.** Biobox tiene 125
máquinas Digital y 77 Impreso, y las capas del mapa son *geográficas*: una
ruta lleva de las dos. Pero el trigger `ruta_ubic_valida_segmento` exige que
la ubicación coincida con el tipo de medio de su ruta, así que **una ruta
mixta hoy no puede existir**.

En vez de aflojar ese trigger —que también cuida a Ecovallas— cada parada
entra a la ruta de *su* segmento. Si la capa es homogénea se crea una sola
ruta y no se nota nada; si viene mezclada quedan dos filas en
`rutas_monitoreo` con el mismo nombre y distinto tipo. **BioboxView agrupa por
NOMBRE**, no por `ruta_id`, así que el monitorista sigue viendo una sola ruta:
la partición es interna y no le llega.

De ahí que `vw_revision_ubicaciones` exponga **dos** campos de tipo:
`tipo_medio` (el del segmento de la ruta) y `medio` (el de la máquina, de
inventario). El segundo es el que decide qué checklist se usa y qué se escribe
en la incidencia — y por eso hay **dos plantillas sembradas**: una para
máquinas impresas (lona, arte, vitrina, iluminación) y otra para digitales
(pantalla, contenido en reproducción, conectividad). Un checklist común
obligaría a marcar N/A la mitad de los puntos en cada visita, y un punto que
casi siempre es N/A deja de leerse.

**Salvo eso, Biobox no necesitó cambios de esquema para rutas**:
`rutas_monitoreo` ya estaba segmentada y el selector de RutasView ya ofrecía
Biobox.

---

## 5. ARCHIVOS SQL

| Archivo | Estado |
|---|---|
| `pauta_schema.sql` | ✅ aplicado |
| `importar_pauta.sql` | ✅ aplicado |
| `notificar_area_asignada.sql` | ✅ aplicado |
| `fix_auto_en_proceso.sql` | ✅ aplicado — elimina trigger que pisaba el estatus inicial |
| `reasignacion_incidencia.sql` | ✅ aplicado — incidencia propuesta en reasignación |
| `notificar_reasignacion_aprobada.sql` | ✅ aplicado — avisa al área nueva y conserva `reasignada_de` |
| `fix_notificaciones_unidad_null.sql` | ✅ aplicado — unidad NULL en un rol es comodín |
| `push_secret_vault.sql` | ✅ aplicado — secreto del push en Vault |
| `chat_adjuntos.sql` | ✅ aplicado — adjuntos temporales del chat |
| `rechazos_reparacion.sql` | ✅ aplicado — rastro y KPI de rechazos |
| `incidencias_lado_porticos.sql` | ✅ aplicado — lado fijo para pórticos de Vía Verde |
| `incidencias_clasificacion_digital.sql` | ✅ aplicado — clasificación técnica Digital |
| `fijacion_externa_vista_v2.sql` | ✅ aplicado — vista actual de órdenes externas |
| `diagnostico_incidencias.sql` | referencia, solo lectura |
| `diagnostico_notificaciones.sql` | referencia, solo lectura |
| `verificar_mis_notificaciones.sql` | referencia, solo lectura |
| `auditar_areas_roles.sql` | referencia, solo lectura — auditoría de alcance por rol |
| `diagnostico_pauta_cobertura.sql` | referencia, solo lectura |
| `pauta_evidencias.sql` | ✅ aplicado |
| `push_suscripciones.sql` | ✅ aplicado — secreto configurado vía Vault |
| `revisiones_schema.sql` | ✅ aplicado — checklist, revisiones, vista y RPC |
| `importar_rutas_capas.sql` | ✅ aplicado |
| `fijacion_limpiar_urls_muertas.sql` | ✅ aplicado (2-sep) — limpió URLs de evidencia muertas en la base de Mario |
| `qtm_pautas_lectura.sql` | ✅ aplicado (17-sep) — lectura de `qtm_pautas` para la campaña por cara |
| `chat_editar_mensajes.sql` | ✅ aplicado (17-sep) — edición de mensajes 15 min con rastro |
| `chat_retencion_30_dias.sql` | ✅ aplicado (17-sep) — archivos del chat viven mínimo 30 días; trae monitor de peso vs 1 GB |
| `nombres_pantallas.sql` | ✅ aplicado (17-sep) — nombres de las 103 pantallas de Ecovallas; upsert re-ejecutable para altas/correcciones |
| `biobox_causas.sql` | ✅ aplicado y verificado (18-sep) — alta de detalles al catálogo, tabla checklist_causas (94 causas), punto "Robot", y recorte del checklist a los puntos del Excel; re-ejecutable |
| `diagnostico_biobox.sql` | referencia, solo lectura — ✅ ya corrido |
| `diagnostico_biobox_2.sql` | referencia, solo lectura — ✅ ya corrido (10-sep; OJO: los números de máquina SÍ se repiten entre claves, la tarjeta enseña la clave completa por eso) |
| `diagnostico_qtm_campanias.sql` | referencia, solo lectura — ✅ ya corrido (columnas y RLS de qtm_pautas/qtm_contratos) |
| `pauta_espec_toma.sql` | ✅ aplicado (21-sep) — expone `espec_toma` en la vista; su verificación lista los textos por homologar |
| `ruta_asignaciones.sql` | ✅ aplicado (21-sep) — tabla ruta+usuario, trigger de notificación (asignar y retirar) y RPC `usuarios_asignables` |
| `pauta_comprobacion_coordinador.sql` | ✅ aplicado (21-sep) — comprobar exige coordinador/manager; RPC `rechazar_toma` con motivo + notificación; vista con rechazo |
| `rol_monitorista.sql` | ✅ aplicado (21-sep) — valor nuevo del enum (correr el PASO 1 SOLO y primero) + políticas aditivas inc/ev del monitorista |
| `coordinador_solo_gestion.sql` | ✅ aplicado (21-sep) — `usuarios_asignables` solo monitoristas + diagnóstico de triggers que notifiquen a coordinador |
| `notificar_toma_por_comprobar.sql` | ✅ aplicado (22-sep) — `registrar_toma` avisa a coordinadores (evento `pauta_revision`) solo en toma NUEVA |
| `sincronizar_rutas_pauta.sql` | ✅ aplicado (22-sep) — RPC `sincronizar_rutas_desde_pauta`; ojo con la firma json/jsonb de `importar_rutas` (PASO 0) |
| `medir_almacenamiento.sql` | referencia, solo lectura — Storage por módulo, pauta POR CATORCENA, foto vs video, top-20 y GB/semana |
| `prelanzamiento_300.sql` | ✅ aplicado y verificado (24-sep) — índices, purgas por pg_cron, `errores_cliente`, anon sin permisos (tablas, vistas y RPC definer), `app_config` cerrada, `pauta_monitoreo` sin escritura directa, `dar_baja_usuario` / `reactivar_usuario`. Re-ejecutable; el PASO 6 es una sola consulta de verificación. Sin cuentas vivas sin ficha |
| `limpiar_indices_duplicados.sql` | ✅ aplicado (24-sep) — quitó 3 duplicados exactos (inc_estatus_idx, evid_record_idx, msg_record_idx); quedan los heredados equivalentes. prelanzamiento_300.sql ya no los recrea |
| `primer_mes.sql` | ✅ aplicado y verificado (24-sep) — RPC `fotos_tarjetas(p_ids)` (SECURITY INVOKER, stable, un jsonb por lote) para las fotos de tarjeta; EXECUTE solo authenticated y service_role (anon no). La prueba con 5 incidencias recientes devolvió sus fotos de reporte y la de reparación |

De la fase anterior (ya aplicados): `rutas_monitoreo_schema.sql`,
`rutas_monitoreo_rls.sql`, `rutas_importar.sql`, `fijacion_externa_vista.sql`,
`fijacion_externa_marcar.sql`.
`rutas_monitoreo_rls_fix.sql` es **OBSOLETO**; la versión final es
`rutas_monitoreo_rls.sql`.

Para notificaciones de chat, la versión vigente es la compuesta por
`notificar_chat_participantes.sql` y `notificar_chat_validador.sql`: avisa a
participantes del hilo, al área efectiva que atiende y al validador cuando le
corresponde. No reejecutar scripts antiguos de chat sin comparar funciones.

---

## 6. FORMATOS DE ARCHIVO

### Rutas (hoja `RUTAS ECOVALLAS`)
`Clave Nueva` (=site_id), `Ruta`, `Secuencia`, `Dirección`, `Estatus`
(ACTIVA/INHABILITADA/RETIRADA), `VALLAS`, `ARRENDADOR`, `OBSERVACIONES`.
Hay columnas basura con `#REF!` que se ignoran.

### Pauta (hoja `CAT nn(nn) DDMMM-DDMMM`)
29 columnas. Las que importan: `CLAVE SITIO` (=site_id),
`Vendor Face ID` (=vendor_face_id), `CARA`, `RUTA`, `SECUENCIA`,
`Contract Number`, `ORDEN DE FIJACIÓN`, `Campaign Version CAT nn (nn)`,
`VERSIÓN`, `ESTATUS`, `CORTE`, `FECHA DE FIJACIÓN`, `FECHA DE TOMA`,
`FECHA COMPROBACIÓN`, `DIRECCIÓN`, `ID ESTADO`, `MEDIO`.

Perfil de la CAT 16 (referencia): 1207 filas, 380 sitios, 1187 caras,
50 campañas, 8 rutas + PLAZA + EDOMEX, 610 NUEVO / 597 REPITE.

**El archivo NO trae coordenadas** en ninguna de sus 19 hojas. La única fuente
es `inventario`.

---

## 7. DEUDA TÉCNICA CONOCIDA

**Archivos sin uso.** `Dashboard.tsx`, `FlujoFotos.tsx` y `Mapa.tsx` ya se
eliminaron del repositorio. No restaurarlos: Indicadores usa `KpiView`, las
subidas usan `SubirArchivos` y Rutas tiene su propio mapa.

**El rol `fijador`** existe en el enum `app_role` pero NO está en `ROLE_LABEL`,
`ROLE_ICON` ni `ROLE_PRIORITY`. Por eso no se puede asignar desde Usuarios, y
si alguien lo tuviera se mostraría como "Viewer". Se dejó así a propósito: no
se usa. Si se retoma, hay que agregarlo a los tres lugares.

**Catálogos de áreas separados.** `AREAS_USUARIOS` representa pertenencia de
Reportante/Validador y `AREAS_REPARACION_POR_UNIDAD` representa acceso técnico.
No añadir a ciegas un área vista en datos al catálogo técnico: primero decidir
si es un equipo que repara o un área de pertenencia/negocio. El catálogo de
incidencias sigue siendo la fuente de `area_responsable` al crear o reclasificar
una incidencia.

**`NuevaInc` conserva el prop `preset`** (abrir el alta con el sitio ya
elegido), que venía de la Bitácora. Como Bitácora se descartó, hoy nadie lo
pasa. Es inofensivo y podría servir.

---

## 8. RESPONSIVE

Verificado en Chromium a 360, 390 y 768px: sin desborde horizontal.

**El bug principal era un menú duplicado:** `.side` se convertía en barra
inferior fija (z-index 900) y `.mobile-nav` también era fija abajo. En el HTML
original `.side` se ocultaba en móvil. Se eliminó `.mobile-nav` por completo.

Otras causas de desborde, ya resueltas: las claves tipo
`MX_EM_EV_EVA_01_0009` y las direcciones no tienen espacios y estiraban su
contenedor (`overflow-wrap:anywhere`, excluyendo pills/tags/botones); faltaba
`min-width:0` en hijos flex; el título del topbar se encimaba con los botones.

En móvil: filtros apilados, tarjetas a 2 columnas, inputs a 16px (para que iOS
no haga zoom al enfocar), modales casi a pantalla completa, y el estatus de la
incidencia debajo del folio.

**Mapas — `relative`, nunca `static`.** Los controles de Leaflet son
`position:absolute` y se anclan al ancestro posicionado más cercano. Al pasar
el mapa a `static` para quitarle el sticky, los controles **se escapaban** y el
zoom y la atribución de OpenStreetMap aterrizaban encima de las tarjetas de
KPIs. Se usa `position:relative` + `isolation:isolate`, y el corte del sticky
está en 900px (donde `.fij-split` se colapsa a una columna).

---

## 9. PENDIENTES

### 9.1. Inmediatos
- **Habilitar Google** en Supabase → Authentication → Providers (Client ID y
  Secret de Google Cloud) y dar de alta las URLs de redirect, incluida la de
  red local con `https://`. El botón ya está en el login; sin esto Google
  rechaza el intento.
  - Nota de seguridad: cualquiera con cuenta de Google podrá autenticarse y
    llegar a la pantalla "Falta darte acceso". No ve datos (la RLS lo bloquea
    sin rol), pero sí crea un usuario en auth. Si se quiere restringir a
    `@gpovallas.com`, hay que filtrar por dominio.
- **Probar el módulo Pauta con datos reales**: importar la CAT 16, recorrerla
  desde celular, y confirmar que al reimportar el avance de campo sobrevive.
- Decidir qué hacer con `AREAS_RESP` (§7).
- **Biobox — causas y prioridades por punto (✅ APLICADO y verificado,
  18-sep-2026)**. Las verificaciones del PASO 4 salieron limpias tras dos
  ajustes de la primera corrida: se dio de alta el punto "Robot" (nuevo en el
  Excel) y "Falla en el sensor de mano" para M5; además, el PASO 3b recortó
  el checklist EXACTAMENTE a los puntos del Excel — los sobrantes quedaron
  con `activo=false` (no borrados: el historial de revisiones los sigue
  leyendo; se revive uno con `update … set activo = true`). Falta solo la
  prueba de campo de una revisión real. Historia del build: del Excel
  corregido
  `BIOBOX-CAUSAS-Y-PRIORIDAD.xlsx` salió `biobox_causas.sql`: (1) alta de los
  10 detalles nuevos al catálogo — áreas decididas por Erik: Teltonika dañado
  y revisión remota → TI, Apagado parcial y Falta arte → Digital, el resto →
  Op. Bio Box ("Biotech" no existe como área) — en los CINCO muebles del
  catálogo, no solo los 3 del Excel; (2) tabla `checklist_causas` (94 causas,
  textos ya corregidos, notas de acción unidas); (3) verificaciones de liga.
  En RevisionModal, al marcar anomalía el revisor elige la causa de una LISTA
  CERRADA: prende "Levantar incidencia" con la incidencia del catálogo ya
  puesta, enseña el semáforo de prioridad, y la causa + acción sugerida se
  escriben en la respuesta de la revisión y en las observaciones de la
  incidencia. "Otra (texto libre)" conserva el flujo anterior; un punto sin
  causas se captura como siempre. El empate causa↔punto es POR TEXTO
  (sin acentos): renombrar un punto desliga sus causas y el PASO 4a del SQL
  lo detecta. El ÁREA la sigue decidiendo el catálogo, no la causa. La liga
  vive por SQL re-ejecutable (el ⚙️ del checklist se retiró en fbde3b0).
- **Biobox, resto**:
  0. Revisar una máquina real desde el celular, de punta a punta (la revisión
     y el historial siguen vivos; solo se retiró el ⚙️ de configuración).
  1. Decidir qué hacer con `bitacoras`: ya existe, tiene la misma forma
     (estado + observaciones + una evidencia + liga a incidencia) y viene
     del módulo de Bitácora que se descartó. Si trae historia, conviene
     mostrarla dentro de la hoja de vida en vez de dejarla huérfana.
  2. `diagnostico_biobox_2.sql` ya se corrió (10-sep): los números de máquina
     SÍ se repiten entre claves (el número 1 vive en 7 máquinas) — por eso la
     tarjeta enseña la clave completa. Y los municipios vienen duplicados por
     mayúsculas ("Benito Juárez"/"BENITO JUÁREZ"): ensucia filtros, limpiar
     algún día en inventario.
- Los 4 marcadores de la capa `Biobox` del mapa (`Escato`, `Cov Vallas`,
  `Mas Espacio`, `Placove`) parecen proveedores o bodegas, no máquinas.
  Decidir si se importan como ruta o se dejan fuera.

### 9.2. Despliegue
- GitHub + Vercel, con las variables de entorno del proyecto. Por ahora se
  trabaja en local.
- **Usar Git, no ZIP**, para sincronizar entre la Mac personal y la Windows de
  la empresa. `.gitattributes` ya normaliza CRLF/LF; sin eso, cambiar de
  máquina marca todos los archivos como modificados.
- **Upgrade de Supabase a Pro ANTES del lanzamiento global** (acordado
  22-sep). El plan Free no tiene backups automáticos — esa es la razón #1,
  por encima del espacio: un borrado accidental hoy no tiene vuelta atrás.
  Además: 1 GB de Storage (~3 meses al ritmo de pruebas) y 5 GB/mes de
  egress, que con fotos vistas a diario en campo sería el primer muro.
  Medición del 22-sep (`medir_almacenamiento.sql`): 113 MB usados; el VIDEO
  de reparaciones es el 81% con el 12% de los archivos; las fotos comprimidas
  salen a ~100–190 kB. Con 2–3 catorcenas reales medidas se decide el
  purgador de evidencia de pauta (propuesta: conservar 3 catorcenas) y/o
  capar el video (hoy hasta 50 MB por clip).
- El CLI de Supabase ya está instalado y logueado en la Mac
  (`brew install supabase/tap/supabase`). Para redesplegar la función de
  push: `supabase functions deploy enviar-push --no-verify-jwt --project-ref
  qztxpcfbbbmvgmtjnlxg`.

### 9.3. Evoluciones del módulo Pauta
- Reporte descargable de avance por catorcena (Excel/PDF).
- ~~Ligar la evidencia fotográfica del monitorista a `pauta_monitoreo`~~ —
  HECHO: `pauta_evidencias` guarda las fotos por cara/catorcena y el mínimo
  lo exige la `espec_toma`.
- Ordenar las paradas desde la posición GPS actual. `nearestRoute` ya está
  escrito en `lib/haversine.ts` y sin usar.
- Si los push "Toma por comprobar" resultan demasiados en campo (es uno por
  toma nueva), convertirlos en resumen (por sitio o por hora) — pendiente del
  veredicto de los coordinadores.
- Cruzar pauta con `vw_fijacion_externa`: hay un campo `campana` en el sistema
  de Mario. Si las dos fuentes nombran distinto la misma campaña, se va a
  contar doble. Conviene detectarlo antes de que crezca.

### 9.4. Fuera de alcance (evaluado y descartado)
- **Rastreo en vivo del monitorista.** El navegador no rastrea con la pantalla
  apagada: iOS y Android suspenden la pestaña. Requiere app nativa, tabla de
  posiciones y una conversación de privacidad laboral.
- **Optimización de ruta con tráfico** (Google Directions/Routes API):
  requiere facturación de Google Cloud.

### 9.5. Datos
- Quedan **2 sitios de 380** de la CAT 16 sin match en inventario:
  `MX_CM_EV_0001` y `MX_CM_EV_3380`. El problema histórico de las 1861 pautas
  de CDMX **ya se resolvió**: el inventario ahora sí trae la plaza CM.
- Extender `catorcenas.py` más allá de 2027 cuando aplique.
- Confirmar con Mario que su sistema Supabase/Vercel lee bien el JSON de fotos en
  `foto_url`/`evidencia_url` (array de URLs).

---

## 10. PRINCIPIOS Y APRENDIZAJES

1. **Las funciones y RLS viven en Supabase y son compartidas.** No migrarlas ni
   duplicarlas. Los módulos nuevos USAN `tiene_rol` y `auth_email`.
2. **Diagnóstico antes de construir.** Correr una query que confirme el
   supuesto. Así se descubrió `operadores_cuadrilla` vs `responsable`,
   `estado` vs `validacion`, que `assigned_area` ya estaba en la RLS, y que el
   90% de la pauta era CDMX.
3. **No tragarse los errores.** El hook de notificaciones descartaba el
   `error` de Supabase, así que un bloqueo de RLS se veía idéntico a un día sin
   novedades. Una lista vacía y un error son cosas distintas y hay que
   mostrarlas distinto.
4. **Que exista la función no significa que el trigger esté conectado.**
   `pg_proc` lista funciones; `pg_trigger` dice si algo las dispara. Son
   consultas distintas.
5. **Un trigger de UPDATE puede tener una condición que nunca se cumple.**
   `notificar_incidencia` solo actúa si cambia `estatus`, así que asignar
   `assigned_area` no notificaba a nadie. El trigger corría y salía.
6. **Supabase API solo expone `public`**: para escribir en `externo` (FDW) se
   usan RPC `security definer`.
7. **Límite de 1000 filas** por consulta: paginar con `.range()`.
8. **Leaflet**: `invalidateSize()` y recrear el mapa si el contenedor cambió.
   Y nunca `position:static` (§8).
9. **`auth_email()` devuelve null en el SQL Editor** porque no hay sesión; en
   la app sí funciona. No es un bug.
10. **Separar lo que viene del archivo de lo que genera la app.** Es lo que
    hace que reimportar sea seguro (§3.4).
11. **Los encabezados que contienen datos cambian.** Las columnas de campaña
    traen la catorcena en el nombre: detectar por patrón, no por texto exacto.
12. **Al entregar un módulo nuevo, mandar el proyecto completo en ZIP.** Los
    archivos sueltos no traen la carpeta, y `src/modules/pauta/` no existía →
    Vite falla al resolver el import y la página queda en blanco. Pasó y costó
    una vuelta.

---

## 11. PERSONAS

- **Erik Mejía** (mejia.erik@gpovallas.com, GitHub `deverik159`): dueño del
  proyecto, rol manager. Trabaja en Windows (empresa) y macOS (personal).
- **Mario Luna Ramírez**: maneja el sistema externo de fijación
  (Supabase + Vercel propio) al que la app se conecta por FDW.
- Usuarios con rol en `usuario_roles`: anaya.marco (coordinador),
  mejia.erik (manager), rojas.luis (coordinador), solicitudes@ (coordinador),
  anaya.ana (validador), alvarez.jonathan.

---

## 12. CAMBIOS OPERATIVOS RECIENTES (agosto–septiembre 2026)

### 12.1. Móvil y evidencia

- La PWA instalada respeta el notch de iPhone; los modales y la barra superior
  usan safe areas. Tras un cambio de manifest, reinstalar la PWA para probarlo.
- `SubirArchivos` comprime imágenes antes de subir, muestra un spinner mínimo y
  libera previews. En Android, **Tomar foto** abre la cámara directa: su input
  acepta solo imágenes y no usa `multiple`; Galería conserva fotos y videos.
- Los mapas no capturan el scroll de un dedo: requieren dos dedos o desbloquear
  el control táctil. En Fijación, los pines pesados se limitan a la página
  visible y el resto se dibuja ligero.

### 12.2. Push y campana

- Una notificación push abre y enfoca la incidencia tanto con la app abierta
  como cerrada. La campana se refresca de inmediato.
- La suscripción push se renueva si cambia VAPID. Si una activación aparentemente
  funciona pero no llegan avisos, revisar `push_suscripciones` y la Edge
  Function `enviar-push` antes de cambiar el frontend.
- Chat notifica a participantes, al área que atiende y al validador cuando le
  toca. Los managers reciben lo que sus triggers les inserten; no asumir que
  un manager es destinatario de todo sin verificar las funciones vigentes.

### 12.3. Incidencias y reparación

- La tabla es ordenable por encabezado; folio se ordena numéricamente y estatus
  sigue el orden del flujo. Sitio, capturó y reparó se mantienen legibles.
- Nivel es el dato visible de clasificación; Origen y Tipo se siguen guardando
  para indicadores, pero no se muestran junto al nivel.
- Reparar exige rol **y** área efectiva. El guardado detecta que la RLS pudo
  rechazar una actualización aun sin devolver error explícito.
- Cada rechazo de reparación conserva su motivo y alimenta el KPI.

### 12.4. Alcance de módulos

- Biobox solo se muestra a personas de esa unidad; Fijación Externa y Pauta se
  tratan como Ecovallas Impreso; Rutas se acota por unidad.
- La tarjeta de Biobox muestra el número de máquina y la clave completa en
  renglones separados.
- Fijación Externa usa la vista v2 y opera como lista de órdenes de cuadrilla;
  sus incidencias cruzan por sitio y requieren pertenecer al área.

### 12.5. Actualización del 10-sep-2026: máquinas e indicadores

- Indicadores identifica sus filtros como Unidad, Área y Estatus.
- Aclaración de alcance: solo se retira el botón ⚙️ Checklist de configuración.
  Se conservan ✅ Revisar en cada máquina, captura de respuestas/evidencia,
  creación de incidencias, historial y datos de última revisión. El formato
  basado en el Excel de Biobox sigue en proceso. No se borraron datos de Supabase.
- `vw_revision_ubicaciones` aporta rutas, ubicaciones y última revisión.
- Fuera de línea se calcula exclusivamente con `inventario.face_status =
  'Out of Service'`, cruzado por el `vendor_face_id` que seleccionó la vista.
  Un estado ausente no se interpreta como fuera de línea.
- Indicadores de máquinas: total, nunca revisadas, +30 días, con anomalías,
  con incidencias abiertas, fuera de línea y sin coordenadas. Cada tarjeta abre
  las mismas máquinas contadas, respeta
  ruta/medio/búsqueda y deduplica por sitio. La lista mantiene navegación por
  tramos, pendientes de revisión y orden por urgencia. Permite consultar
  incidencias con `EstadoMaquinaPanel`, revisar y abrir historial.
- Actualizar local y el botón global recargan rutas, estado del inventario y
  resumen de incidencias. Se muestra progreso/hora; un fallo se informa y
  conserva la última carga válida. No hace falta ejecutar SQL para este cambio.
- Verificación del cálculo: `node --test tests/maquinasBiobox.test.mjs`.

### 12.6. Limpieza de datos

- `limpiar_datos_migrados.sql` y `scripts/limpiar-storage.mjs` sirven para
  retirar datos anteriores al corte elegido. Supabase bloquea DELETE directo
  en `storage.objects`: los archivos se eliminan mediante Storage API.
- La limpieza histórica ya se ejecutó dejando agosto de 2026 como datos de
  prueba. No correr scripts de limpieza sin revisar primero sus conteos.

### 12.7. Actualización del 10–11-sep-2026: catálogo Digital, pauta y despliegue

- Nueva incidencia ya separa el catálogo por `tipo_medio`: Digital usa
  `arbol_digital.incidencia`; Impreso usa `catalogo_incidencias`. En Ecovallas
  y Biobox la decisión se toma por cara seleccionada, no por el nombre de la
  unidad. El técnico de Digital continúa reparando con el árbol técnico.
- La campana de Nueva incidencia se obtiene de `qtm_pautas` por cara y por la
  ventana de catorcenas anterior, actual y siguiente; al cambiar de sección se
  limpia el buscador y al accionar una notificación se marca como atendida.
  `qtm_pautas_lectura.sql` documenta el diagnóstico de esa fuente.
- El técnico puede quitar evidencia de reparación antes de mandar a validar.
- La PWA consulta `version.json` al volver a primer plano y muestra un botón de
  actualización si Vercel publicó una versión nueva. Esto evita abrir una
  notificación con JavaScript obsoleto.
- Al iniciar en Windows o macOS, ejecutar `git fetch origin` y comparar
  `HEAD` con `origin/main`. Al 11-sep-2026 ambos apuntan a `1ceeb7d`, sin
  cambios locales; el repositorio está alineado con GitHub.

### 12.8. Actualización del 14–17-sep-2026: campaña por cara, chat y nombres

Todo salió de las pruebas de campo de Erik (línea Windows, commits
`64d2f49` → `1daa96b`):

- **Campaña POR CARA** (`64d2f49`): refina lo del 11-sep — ya no hay un solo
  desplegable por partida; cada cara marcada se prellena sola con su campaña
  vigente HOY y cada fila guarda la suya. Detalle completo en §4.1
  ("Campaña POR CARA").
- **Chat** (`4563bc7`, `a4779b5`): el autor puede EDITAR su mensaje 15 minutos
  (como WhatsApp) mientras la incidencia siga abierta; la burbuja marca
  "(editado)", el trigger `msg_marca_edicion` guarda `editado_en` y el texto
  ORIGINAL (auditoría — el cliente no puede pisarlos), la edición llega en
  vivo por Realtime de UPDATE y borrar sigue prohibido. Requiere
  `chat_editar_mensajes.sql`. Además: **buscador** del hilo (texto y autor,
  sin acentos) y retención de archivos a **30 días** desde la subida aunque
  la incidencia cierre (antes: 2 días tras el cierre; válvula de 60 días se
  queda) — `chat_retencion_30_dias.sql`, que incluye el monitor de "peso
  vivo" contra el 1 GB del plan gratis: el riesgo son los videos (50 MB
  c/u); si se acerca a ~700 MB, bajar la retención solo de videos.
- **Visor de archivos** (`a4779b5`): las miniaturas de `SubirArchivos` se
  abren a pantalla completa (video reproducible) para revisar la toma ANTES
  de mandarla. Aplica a todos los modales que suben archivos.
- **GPS con instrucciones** (`a4779b5`): `explicarErrorGps()` en
  `plataforma.ts` — el caso Brayan: GPS del teléfono encendido pero permiso
  del NAVEGADOR bloqueado ("User denied"), que no se puede volver a pedir
  desde la app. El mensaje ahora da los pasos exactos por plataforma
  (iPhone: Ajustes → Privacidad → Localización → Safari; Android: candado en
  Chrome → Permisos, o Ajustes → Apps si es la PWA instalada), y distingue
  origen inseguro, sin señal y timeout. Se usa en "Sitios cerca de mí" y en
  la revisión de Biobox.
- **Nombres de pantallas Ecovallas** (`1daa96b`, ✅ verificado en vivo):
  detalle en §4.1 ("Nombres de pantalla") y `nombres_pantallas.sql`.
- **El técnico borra SUS fotos en RepararModal** (`f729911`): 🗑 bajo cada
  miniatura propia antes de mandar a reparar; espeja `ev_del` y verifica la
  negación silenciosa de RLS (0 filas). Vale igual en Fijación Externa (modal
  compartido).
- **Campana y buscador** (`6483e5f`): accionar una incidencia (validar,
  reparar, rechazar, decidir reasignación) marca leídos sus avisos — la
  campana no sigue anunciando lo ya hecho (el chat NO se toca: se marca al
  abrir el chat); y cambiar de sección limpia el buscador (el folio fijado
  por una notificación se quedaba filtrando la otra pestaña).
- **Biobox causas/prioridades por punto**: aplicado y verificado el
  18-sep-2026 (detalle en §9.1 y `biobox_causas.sql`). Sigue en curso la
  conexión INVERSA con Mario (exponerle `incidencias` por FDW para que su
  sistema asigne cuadrilla — diseñar vista/RPC acotada, no tabla completa).
- **Documentación para dirección**: `RESUMEN-DIRECCION.md` (18-sep-2026) —
  el funcionamiento de la app en lenguaje de negocio, para dar contexto sin
  entrar a lo técnico. Publicado también como página para compartir por liga:
  https://claude.ai/artifact/QHahoSKBfuYLvjTf5BJtSn (privada hasta que Erik
  la comparta). Este handoff sigue siendo el documento técnico.
- Al 17-sep-2026, `main` local y `origin/main` apuntan a `1daa96b` más este
  documento; sin cambios locales fuera de él.

### 12.9. Actualización del 21–22-sep-2026: ciclo de campo de Pauta y roles separados

Dos jornadas (Mac, sesiones con Claude) que convirtieron Pauta y Monitoreo de
vista de consulta en el módulo de operación del monitorista, y separaron los
roles por trabajo. Todo desplegado y verificado por Erik en producción.

- **Reporte post-toma** (`da1f45c`): al registrar una toma, un diálogo
  discreto ofrece levantar incidencia del sitio; abre el NuevaInc de siempre
  con el sitio ligado (unidad Ecovallas) sin salir de Pauta. El guardado se
  extrajo a `lib/crearReporte.ts`, COMPARTIDO con IncidenciasView — regla de
  duplicidad, RLS silenciosa y evidencia por grupo idénticas se capture desde
  donde se capture.
- **Espec de toma** (`da1f45c`, homologada en `5ad1b68`): la vista expone
  `espec_toma`, el modal la pinta con color por regla y EXIGE el mínimo de
  fotos (distancia = 9; todo lo demás = 3; texto no reconocido = 3 en ámbar).
  Reglas por patrón en `lib/especToma.ts`.
- **Rutas asignables** (`ff02c75`): `ruta_asignaciones` + panel del
  coordinador; push "Cambio en tu ruta" al asignar y al retirar; la ruta del
  monitorista se pre-filtra con ⭐. El selector lista SOLO monitoristas
  (`fd90930`).
- **Tarjetas-filtro** (`ff02c75`, `9545bda`): Sitios/Caras/Pendientes/
  Tomadas/Comprobadas/Incidencias son botones que filtran; los conteos se
  calculan sin la dimensión propia para no ponerse en cero. La de
  Incidencias usa la RPC `estado_maquina`, y el tag por sitio abre un modal
  mínimo (nombre, área, estatus) para no reportar lo que ya existe
  (`b8bb9a4`).
- **Comprobación del coordinador** (`bb3b6f9`): `registrar_comprobacion`
  exige coordinador/manager; el botón vive DENTRO del visor de evidencia
  ("🔎 Revisar y comprobar") — no se valida sin ver las fotos. `rechazar_toma`
  regresa la toma con motivo obligatorio, notifica al monitorista
  (`pauta_toma`) y la reposición limpia el rechazo sola. La toma NUEVA avisa
  a los coordinadores (`pauta_revision`, `5ad1b68`) — vigilar el volumen.
- **Push que lleva a Pauta** (`b8bb9a4`): sw.js agrega `?ir=pauta`,
  enviar-push manda el `evento`, y App enruta campana/push a Pauta RECARGADA.
- **Rol monitorista** (`25a73e8`): solo ve Pauta, arranca ahí; el técnico ya
  no ve Pauta. **Coordinador gestiona, no repara** (`fd90930`): sin
  reparar/reasignar en Incidencias, sin Fijación Externa; migración de datos
  = quitar roles encimados en Usuarios.
- **Importadores de Rutas contextuales** (`7d23036`) y **sincronizar rutas
  desde la pauta** (`484a1f8`): la catorcena puebla `rutas_monitoreo` vía
  `sincronizar_rutas_desde_pauta` — sin segundo Excel, y los sitios quedan
  asignables.
- **Storage medido** (`8c25bb3`, resultados en §9.2): plan Free, upgrade a
  Pro acordado antes del lanzamiento (backups primero).
- Al 22-sep-2026, `main` local y `origin/main` apuntan a `b8bb9a4` más este
  documento. La Edge Function `enviar-push` está desplegada con los títulos
  `pauta_toma`/`pauta_revision` y el `evento` en el payload.

### 12.10. Bloque "antes de abrir a 300" (24-sep-2026)

Salió de una auditoría de 80 hallazgos (7 dimensiones, verificados contra el
código; ninguno refutado) y pasó DOS revisiones adversariales antes de
subirse. Supabase Pro y respaldos quedaron fuera: los ve dirección. Todo lo
de base de datos vive en `prelanzamiento_300.sql`, que se corre ANTES de
publicar este frontend (la baja de usuarios llama funciones que crea).

- **Campana** (`useNotificaciones.ts`, `versionApp.ts`): no consulta con la
  app oculta y consulta al volver a primer plano; 60 s en lugar de 25; solo
  las columnas que se pintan; no re-renderiza si nada cambió. Con 300
  usuarios eran ~24 consultas/s constantes. Versión nueva cada 15 min.
- **La recarga ya no destruye capturas** (IncidenciasView, PautaView,
  BitacoraVV): solo la PRIMERA carga pone "Cargando…"; antes toda recarga
  (↻ o un aviso nuevo) desmontaba NuevaInc/RegistrarToma con las fotos en
  memoria. Con error de red se conserva la lista y sus fotos. Como ahora se
  puede accionar mientras viaja una recarga: cada carga lleva número (la
  superada se descarta) y lo que el usuario toca en ese lapso conserva su
  versión local al fusionar (`tocadasEnCarga`); en Pauta la respuesta vieja
  se descarta y se pide otra.
- **Concurrencia en estatus** (IncidenciasView, FijacionExternaView): cada
  cambio de estatus exige el estatus que el usuario VE (`.eq('estatus', …)`)
  y, al aprobar o rechazar una reparación, que sea la MISMA (`repaired_at`).
  0 filas se explica releyendo la fila (`explicarSinCambio`): "ya la atendió
  otra persona" vs "sin permiso". Antes ganaba el último que escribía.
- **Errores visibles**: `ErrorBoundary` por módulo (la barra y el menú
  sobreviven; se limpia al cambiar de módulo, tocar un aviso o ↻) y
  `reportarError` → tabla `errores_cliente` (render, `window.error`,
  promesas y subidas fallidas). Tope por sesión, dedupe, cola de 10 que se
  reenvía al volver la red; los rechazos definitivos no se reintentan.
  Consultar como manager: `select * from errores_cliente order by creado_en desc`.
- **Egress de fotos** (`storage.ts`): toda subida lleva caché de 1 año
  (nombres únicos, sin upsert). Las fotos que pintan tarjetas generan una
  miniatura de 640 px en `…/mini/…jpg` (reporte, evidencia, reparación,
  reasignación, revisión Biobox); la tarjeta la pide y cae sola al original
  si no existe (fotos anteriores al 24-sep). La miniatura es de mejor
  esfuerzo con tope de 8 s: nunca frena el guardado.
- **Seguridad**: popups de Leaflet escapados (`escHtml`; datos de Mario y de
  KML ajenos), CSV sin inyección de fórmulas, anon sin ningún permiso en
  public (tablas, vistas y RPC SECURITY DEFINER, también las futuras),
  `app_config` cerrada, `pauta_monitoreo` solo por sus RPC. **Baja real**:
  "Dar de baja" llama `dar_baja_usuario` (roles, ficha, rutas y push fuera;
  cuenta de Auth bloqueada con `banned_until` y sesiones cerradas); volver a
  dar de alta el correo llama `reactivar_usuario`. El PASO 6 del SQL lista
  las cuentas VIVAS sin ficha — las "eliminadas" con el botón anterior, que
  siguen pudiendo usar la API.
- **Quedó para el primer mes** (auditoría): bandeja y KPIs en servidor (hoy
  truncan a 1000 en silencio), captura idempotente con reintento y borrador
  local, migraciones + staging + prueba de carga, `React.lazy` por módulo
  (bundle 1.3 MB), rutas por URL — **hecho el mismo día, ver §12.11**.
  Pendientes chicos: backfill de miniaturas para las fotos viejas (o Image
  Transformations ya en Pro), `enviar-push` con `.ilike` sin escapar
  (redeploy con Verify JWT apagado) y tope de video.

### 12.11. Bloque "primer mes" (24-sep-2026)

Cuatro frentes en paralelo, una revisión adversarial (24 hallazgos
confirmados, 6 refutados) y una segunda vuelta que verificó cada corrección.
Lo único de base es `primer_mes.sql` (fotos de tarjeta; aplicado y
verificado el 24-sep). Si faltara la función, la app cae a la consulta
anterior.

- **Datos completos** (IncidenciasView, IndicadoresView): lo ABIERTO
  (todo menos `cerrada`/`no_reparado`) se trae completo, paginado de 1000 en
  1000 — la bandeja y el globito ya no pierden trabajo viejo. De lo terminal
  se traen las 1000 más recientes; si hay más, un aviso lo dice y el filtro
  «Desde» trae lo anterior del servidor (solo en vistas que muestran
  cerradas: Incidencias, bandeja del reportante, manager/coordinador/viewer;
  la ampliación se suelta sola al quitar «Desde»). Al unir, gana la versión
  terminal. Las tarjetas se pintan de 150 en 150 («Mostrar 150 más»); la
  enfocada desde un aviso siempre se pinta. Fotos por `fotos_tarjetas` en
  lotes de 400. **Indicadores**: selector de periodo (30 / 90 por omisión /
  365 días / todo), paginado, columnas proyectadas (`COLUMNAS_KPI`: si
  KpiView empieza a leer otra columna, agregarla ahí y en k6), nota con las
  abiertas de antes del periodo, recarga sin perder filtros y botón
  Reintentar. Indicadores solo recarga con ↻ (`recargaManual`), no con cada
  aviso: es la pestaña de inicio de casi todos.
- **Captura a prueba de mala señal** (`crearReporte`, `lib/envios.ts`,
  `lib/idb.ts`, `lib/borrador.ts`, `EnviosPendientes`): ver §4.1 «Cola de
  envíos». Contrato de `crearReporte`: filas = creado, `[]` = quedó en la
  cola del teléfono (el modal se cierra), `null` = corregir (el modal sigue).
  Choque de `record_id` ajeno (8 hex) → se regenera antes de insertar. La
  regla de duplicidad corre antes del primer insert; en diferido quita la
  partida duplicada y lo avisa. **Borrador** de NuevaInc en IndexedDB (1 s de
  pausa, y al ocultarse la app): «Tienes un reporte sin terminar — Recuperar
  / Descartar», 48 h. Vive hasta que SU envío termina o se descarta, y nunca
  se ofrece si su envío ya entró (duplicaría). El ciclo completo está en el
  encabezado de `borrador.ts`. Telemetría nueva en `errores_cliente`:
  `envios.*`, `crearReporte.ligar`.
- **Armazón** (App, `lib/cargaDiferida.ts`, ErrorBoundary): 8 módulos se
  bajan al abrirlos (index de 1,304 KB → 557 KB; xlsx 429 KB solo al
  importar/exportar, `lib/xlsxDiferido.ts`; leaflet 150 KB solo en mapas).
  IncidenciasView sigue estático. Si un chunk falla tras un despliegue, se
  reintenta y recarga UNA vez, solo si ese módulo está en pantalla y no hay
  envíos en riesgo; a los 15 s de «Cargando…» sale «Tarda más de lo normal».
  **Rutas por URL**: `/pendientes`, `/incidencias`, `/indicadores`, `/pauta`,
  `/bitacora-vv`, `/fijacion-externa`, `/rutas`, `/biobox`,
  `/disponibilidad`, `/usuarios`; Atrás en Android regresa de pestaña (con el
  alta abierta, no la tira). `?record=` / `?ir=` del SW siguen igual.
- **Staging y carga** (sin correr nada): `GUIA-STAGING-Y-CARGA.md` (candados
  `Confirmar-Staging` / `Confirmar-Produccion` en cada bloque; el dump se
  limpia de secretos antes de versionarse), `tests/carga/k6-300.js` (300
  usuarios con el patrón real; aborta contra producción),
  `scripts/usuarios-carga.mjs` (crear/borrar usuarios de prueba en staging),
  `supabase/migrations/README.md`. `tests/carga/.usuarios.json` está en
  `.gitignore`.
- **Falta de Erik**: decidir con dirección el
  proyecto de staging; subir el límite de logins por IP de Auth (~100–150 /
  5 min) antes del arranque; probar en un iPhone real: capturar sin señal,
  cerrar la app, volver a abrir y ver que el aviso lo mande.
- **Queda abierto** (declarado): Atrás con otros modales (Reparar, Chat…)
  cambia de pestaña; tocar un push con la app abierta recarga la página
  (`sw.js` navigate) y un envío que no cupo en IndexedDB se perdería; un
  envío solo en memoria cuya respuesta se perdió puede volver a ofrecer su
  borrador; paginación por offset puede saltar una fila con >1000 abiertas.

### 12.12. Modo sin señal (24-sep-2026)

Lo pidió Erik tras probar en iPhone: la captura en cola ya funcionaba, pero
sin señal el buscador de sitios no enseñaba inventario, validar y reparar
daban "Load failed" y, si iOS cerraba la PWA, no volvía a abrir. Salió de una
lectura del código en 4 frentes, 5 frentes de implementación, una revisión
adversarial (34 hallazgos confirmados, ninguno alto) y una vuelta de
correcciones con verificador por grupo. **No hay SQL.**

- **Abrir sin señal** (`public/sw.js`, `vite.config.ts`): el SW ahora SÍ
  guarda el armazón. El build inyecta la lista de precarga en `dist/sw.js`
  (`self.__PRECACHE__`); el núcleo se precarga estricto y los módulos en
  "lo que se pueda" (xlsx no). Navegación = **red primero** con tope de 4 s
  (con red siempre abre la versión nueva; la copia es solo respaldo);
  `/assets` caché primero; nunca se guarda un 404; `version.json`, Supabase,
  OSM y Google no pasan por el SW. Se conservan la caché actual y la
  anterior. "Actualizar ahora" navega sin tope. **Interruptor**: variable
  de build `SW_SIN_CACHE=1` en Vercel + redeploy (con commit) deja el SW
  como antes (solo push) y borra sus cachés. Tras cada despliegue, cada
  teléfono debe abrir la app una vez con señal para precargar.
- **Sesión y roles sin red** (`App.tsx`): si `getSession` falla por red y hay
  sesión guardada (`sb-<ref>-auth-token`), entra con ella "sin verificar";
  roles en `localStorage` (`gpovallas_roles:<email>`); franja "📴 Sin
  señal"; Salir funciona sin red (borra la sesión local y la lista guardada;
  la cola se queda y sale al volver a entrar con esa cuenta). La campana no
  sondea sin red.
- **Datos en el teléfono** (`lib/datosLocales.ts`, base IndexedDB
  `gpo-datos`): inventario de las unidades del usuario, catálogo, árbol
  Digital, nombres de pantalla, catorcenas, qtm_pautas (ventana) y la última
  lista de incidencias por usuario. Se refresca con red y sesión real (cada
  12 h; pautas cada 6 h) y NUNCA se reemplaza con datos pedidos sin sesión
  (al volver la señal hay ~60 s en que las peticiones salen como anon).
  `redOLocal`: red con tope corto si hay copia; sin copia espera a la red
  (~20 s). El buscador de NuevaInc responde al instante desde la copia y
  agrega al final lo que llegue de la red. Corrección, Reasignar, Evidencia y
  Editar dicen "Necesitas señal" en vez de errores crudos (no van en cola).
- **Validar y reparar en cola** (`lib/acciones.ts`, base `gpo-acciones`):
  validar, aprobar/rechazar reparación, prevalidar, descartar y reparación con
  fotos. Se guarda en el teléfono ANTES de mandar; precondiciones de estatus,
  `repaired_at` y `validator_at` (si otra persona ya la atendió, NO se pisa:
  se avisa); reconciliación releyendo la fila; fotos con nombre por huella
  del contenido (reintentar no duplica evidencia); guardia de sesión real y
  del DUEÑO antes de cada paso (también en la cola de reportes: antes, una
  subida en la ventana sin sesión se marcaba fallida para siempre). Las
  tarjetas con algo en cola llevan "⏳ En cola" y no regresan a su estado
  viejo al recargar. `EnviosPendientes` muestra y manda las dos colas.
- **Reparar** (`RepararModal`): las fotos ya NO se suben al elegirlas; se
  guardan en el teléfono al momento (`lib/borradorReparacion.ts`, prefijo
  `r:`) y se recuperan si iOS recarga la app al volver de la cámara; 🗑 las
  quita antes de guardar. Se suben al tocar Guardar (con progreso).
- **Regla IndexedDB**: `gpo-capturas` se queda en **v1** y no se le agregan
  almacenes (así, revertir en Vercel a un build anterior no deja sin cola de
  reportes ni borrador). Lo nuevo va en `gpo-datos` y `gpo-acciones`.
- **Decisión pendiente de Erik**: `usuario_roles` se consulta sin `medio`,
  así que el filtro "Ecovallas Impreso" de Fijación Externa y Pauta nunca
  aplica; pedirlo cambiaría quién ve esos módulos.
- **Queda abierto**: una acción que termina en segundo plano con Incidencias
  cerrada no actualiza la lista guardada hasta la siguiente carga con red;
  con el árbol Digital en copia pero sin filas para esa incidencia, Guardar
  puede esperar hasta 20 s; falta la prueba en un iPhone real con el SW
  activo (el navegador de pruebas no registra service workers).
