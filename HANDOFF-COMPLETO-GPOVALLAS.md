# HANDOFF COMPLETO — Central de Operaciones GPO VALLAS
### Documento de traspaso para retomar el proyecto sin empezar de cero

_Última actualización: 20 de agosto de 2026. Reemplaza la versión anterior
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

**Descartados a propósito** (decisión de Erik, agosto 2026): Bitácora,
Mantenimiento Biobox, Fijación interna, Cuadrillas, RutaCuadrilla. No se
migraron y no se van a migrar. El rol `fijador` se deja en la base por si en
el futuro se retoma.

**Regla de oro:** las funciones y políticas RLS viven en **Supabase** y son
compartidas. No se migran ni se duplican. Un módulo nuevo USA las existentes
(`tiene_rol`, `auth_email`), nunca crea funciones redundantes.

---

## 1. STACK Y ACCESOS

- **Vite 5 + React 18 + TypeScript 5**.
- Librerías: `@supabase/supabase-js`, `leaflet` + `@types/leaflet`,
  `xlsx` (SheetJS), `@vitejs/plugin-basic-ssl` (dev).
- Leaflet CSS por CDN en `index.html`. Estilos propios en `src/index.css`.
- **Supabase** (Postgres + Auth + RLS + Storage + RPC + Realtime).
  - Project ref: `qztxpcfbbbmvgmtjnlxg`
  - URL: `https://qztxpcfbbbmvgmtjnlxg.supabase.co`
- **Integración externa** (sistema AppSheet de Mario Luna) vía `postgres_fdw`.
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
      haversine.ts        → distancias, nearestRoute
      convexHull.ts       → áreas sombreadas de rutas
    components/
      IncCard.tsx         → tarjeta de incidencia
      CampanaNotifs.tsx   → campana 🔔
      SubirArchivos.tsx   → cámara / galería con miniaturas
      IrAqui.tsx          → botón de navegación
      Dashboard.tsx       → SIN USO (ver §7)
      FlujoFotos.tsx      → SIN USO (ver §7)
      Mapa.tsx            → SIN USO (ver §7)
    modules/
      incidencias/        → IncidenciasView, KpiView, IndicadoresView
                            NuevaInc, RepararModal, EvidenciaModal,
                            ChatModal, ReasignModal, AsignarTecnicoModal,
                            AsignarAreaModal, EditModal, MotivoModal
      rutas/RutasView.tsx
      pauta/              → PautaView, ImportarPautaModal
      fijacion-externa/FijacionExternaView.tsx
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

**Columnas de `incidencias` que el frontend NO debe mandar** — las llenan
triggers: `folio` (`set_folio`), `catorcena`/`semana`/`plaza`/`latitud`/
`longitud` (`set_derivados`), `sla_reparacion_inicio`/`sla_validacion_inicio`
(`set_sla`), y el paso automático a `en_proceso` (`inc_auto_en_proceso`).

### 3.2. `area_responsable` vs `assigned_area` — CLAVE

La base ya tenía las dos columnas y la RLS ya las usaba, pero **el frontend
nunca escribía `assigned_area`** (ni el HTML viejo ni la migración). Ahora sí.

- **`area_responsable`** — la que asigna el catálogo de incidencias al
  reportar. Es el dato con el que los KPIs miden qué área **origina** la carga.
  No se toca.
- **`assigned_area`** — el área que **realmente repara**, cuando el diagnóstico
  revela que le toca a otra. La escribe el validador con el botón
  🛠 "Asignar área".

Esto NO es una reasignación. La reasignación (`ReasignModal` + tabla
`reasignaciones`) cambia `area_responsable`, deja rastro y requiere aprobación:
sirve cuando el catálogo se equivocó. Asignar área es solo dirigir el trabajo.

La RLS ya razonaba así: `inc_sel_reparacion` e `inc_upd_reparacion` aceptan
`area_responsable IN mis_departamentos() OR assigned_area IN mis_departamentos()`.
Por eso el técnico del área destino ve y edita la incidencia sin cambios en la
base.

`helpers.ts` expone `areaEfectiva(inc)` = `assigned_area || area_responsable`.
Se usa para el SLA, para filtrar técnicos y para el filtro de área.

### 3.3. `notificaciones`

Columnas: `id`, `record_id`, **`para_email`** (NOT NULL), `evento`, `mensaje`,
`unidad_negocio`, `leida`, `enviada_wa`, `creado_en`.

RLS: `notif_sel` y `notif_upd` con `lower(para_email) = lower(auth_email())`.
**No hay política de INSERT**: el frontend NO puede crear notificaciones. Solo
las crean los triggers `security definer`.

Eventos en uso: `captura`, `asignacion`, `asignacion_area`,
`asignacion_tecnico`, `reparado`, `reparado_reportante`, `cierre`, `reabierta`,
`reasignacion`, `chat`, `ruta`, `mant_autorizado`, `mant_correctivo`.

Hay además un trigger `notificaciones` → `supabase_functions.http_request`
hacia una Edge Function (`dynamic-worker`), que es lo que alimenta
`enviada_wa`. No lo toca la app.

### 3.4. Módulo Pauta (nuevo) — DOS tablas a propósito

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
`avance` ya calculados) y `vw_pauta_resumen` (totales por ruta y campaña).

**RPCs:** `importar_pauta`, `registrar_toma`, `registrar_comprobacion`.
`registrar_toma` NO pisa una toma anterior: la primera es la que responde
"cuándo estuvo ahí".

### 3.5. Vistas existentes

`vw_fijacion_externa`, `vw_rutas_con_coords`, `vw_rutas_resumen`,
`vw_cuadrilla_ruta`, `vw_pautas_por_fijar`, `vw_pauta_ruta`, `vw_pauta_resumen`.

### 3.6. Permisos: el hueco del coordinador

En `incidencias` las políticas de UPDATE son: `inc_upd_manager`,
`inc_upd_validador`, `inc_upd_reparacion`, `inc_upd_reportante`.
**No existe `inc_upd_coordinador`.**

Consecuencia: un coordinador puro (sin rol manager) no puede actualizar
incidencias. El HTML viejo mostraba "Asignar técnico" gateado en coordinador,
así que ese botón **nunca funcionó** para ellos — guardaba, no daba error y no
pasaba nada (RLS filtra y afecta 0 filas sin lanzar excepción).

Decisión (Erik, ago-2026): **no crear la política**. `asignarTecnico` y
`asignarArea` van gateados en `validador` (con manager como comodín).

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

Las partidas ya agregadas se pueden **editar** (✏️). La partida no se saca de
la lista mientras se edita, y al guardar se reemplaza en su posición. Si se
intenta guardar el reporte con una edición abierta, avisa.

**Auto-ruteo:** fuera del horario del validador (Lun–Vie 9:30–18:30 CDMX), las
áreas de `AREAS_AUTORUTEO` (hoy solo Digital) entran directo a `en_proceso` con
`requiere_prevalidacion=true`. `fueraHorarioValidador()` evalúa en zona horaria
de CDMX a propósito: el dispositivo del reportante puede estar en otra.

**RepararModal** carga la evidencia de etapa `reparacion` que YA existe (subida
antes desde 📎 Evidencia) y la cuenta para el requisito obligatorio. Obligar a
resubirla sería pedirle al técnico el mismo trabajo dos veces.

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
distinto momento. La ven manager, coordinador, reparación y fijador.

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
`checklist_puntos` se editan desde la app (⚙️ Checklist, solo coordinación).
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
`incidencias` con **exactamente los mismos campos que NuevaInc** (incluido el
auto-ruteo fuera de horario del validador), así que hereda folio, SLA,
notificaciones y flujo de validación sin código nuevo. La foto de la anomalía
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
| `diagnostico_incidencias.sql` | referencia, solo lectura |
| `diagnostico_notificaciones.sql` | referencia, solo lectura |
| `verificar_mis_notificaciones.sql` | referencia, solo lectura |
| `diagnostico_pauta_cobertura.sql` | referencia, solo lectura |
| `pauta_evidencias.sql` | ⏳ pendiente de aplicar |
| `push_suscripciones.sql` | ⏳ pendiente (cambiar `CAMBIA-ESTE-SECRETO` antes) |
| `revisiones_schema.sql` | ⏳ pendiente — checklist, revisiones, vista y RPC |
| `importar_rutas_capas.sql` | ⏳ pendiente — aplicar DESPUÉS de revisiones_schema |
| `diagnostico_biobox.sql` | referencia, solo lectura — ✅ ya corrido |
| `diagnostico_biobox_2.sql` | referencia, solo lectura — pendiente |

De la fase anterior (ya aplicados): `rutas_monitoreo_schema.sql`,
`rutas_monitoreo_rls.sql`, `rutas_importar.sql`, `fijacion_externa_vista.sql`,
`fijacion_externa_marcar.sql`.
`rutas_monitoreo_rls_fix.sql` es **OBSOLETO**; la versión final es
`rutas_monitoreo_rls.sql`.

`notificar_area_asignada.sql` incluye además una versión actualizada de
`notificar_chat()` que usa el área efectiva, para que los mensajes lleguen al
área que está trabajando y no a la del catálogo.

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

**Archivos sin uso.** No los importa nadie; se pueden borrar:
- `components/Dashboard.tsx` — Indicadores usa `KpiView`. En el HTML viejo
  también estaba muerto: nunca se renderizó `<Dashboard>`.
- `components/FlujoFotos.tsx` — lo reemplazó `SubirArchivos.tsx`.
- `components/Mapa.tsx` — `RutasView` tiene su propio mapa.

**El rol `fijador`** existe en el enum `app_role` pero NO está en `ROLE_LABEL`,
`ROLE_ICON` ni `ROLE_PRIORITY`. Por eso no se puede asignar desde Usuarios, y
si alguien lo tuviera se mostraría como "Viewer". Se dejó así a propósito: no
se usa. Si se retoma, hay que agregarlo a los tres lugares.

**`AREAS_RESP` está incompleto.** En los datos reales existen áreas que no
están en la constante: Urban (19), Operación Digital (5), Op. Bio Box (3),
Imprenta (2), Admin Comercial (1). Consecuencia: esas incidencias no se pueden
reasignar hacia esas áreas ni asignarle ese departamento a un coordinador.
Los KPIs y el filtro de área SÍ las muestran, porque se arman de los datos.
**Pendiente de decisión de Erik.**

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
- **Biobox, en este orden**:
  1. Correr `diagnostico_biobox_2.sql`. Lo que falta de ahí: el listado de
     `detalle` del catálogo de incidencias (para ligar los puntos del
     checklist) y confirmar que ningún número de máquina se repite entre
     las 202.
  2. Aplicar `revisiones_schema.sql`, luego `importar_rutas_capas.sql`.
  3. Exportar el KML del mapa e importarlo desde Rutas de Monitoreo con la
     unidad Biobox. Revisar la vista previa antes de confirmar: los empates
     `baja` y `ninguna` vienen desmarcados a propósito.
  4. Ajustar los dos checklists sembrados (⚙️ Checklist, con selector
     Impreso/Digital) y **ligar cada punto con su incidencia del catálogo**
     — es lo que hace que una anomalía salga con área y SLA correctos sin
     que el revisor sepa nada de eso.
  5. Revisar una máquina real desde el celular, de punta a punta.
  6. Decidir qué hacer con `bitacoras`: ya existe, tiene la misma forma
     (estado + observaciones + una evidencia + liga a incidencia) y viene
     del módulo de Bitácora que se descartó. Si trae historia, conviene
     mostrarla dentro de la hoja de vida en vez de dejarla huérfana.
- Los 4 marcadores de la capa `Biobox` del mapa (`Escato`, `Cov Vallas`,
  `Mas Espacio`, `Placove`) parecen proveedores o bodegas, no máquinas.
  Decidir si se importan como ruta o se dejan fuera.

### 9.2. Despliegue
- GitHub + Vercel, con las variables de entorno del proyecto. Por ahora se
  trabaja en local.
- **Usar Git, no ZIP**, para sincronizar entre la Mac personal y la Windows de
  la empresa. `.gitattributes` ya normaliza CRLF/LF; sin eso, cambiar de
  máquina marca todos los archivos como modificados.

### 9.3. Evoluciones del módulo Pauta
- Reporte descargable de avance por catorcena (Excel/PDF).
- Ligar la evidencia fotográfica del monitorista a `pauta_monitoreo` (hoy solo
  se registra la fecha, no las fotos).
- Ordenar las paradas desde la posición GPS actual. `nearestRoute` ya está
  escrito en `lib/haversine.ts` y sin usar.
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
- Confirmar con Mario que su AppSheet lee bien el JSON de fotos en
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
  (AppSheet + Supabase propio) al que la app se conecta por FDW.
- Usuarios con rol en `usuario_roles`: anaya.marco (coordinador),
  mejia.erik (manager), rojas.luis (coordinador), solicitudes@ (coordinador),
  anaya.ana (validador), alvarez.jonathan.
