# Rediseño "Precisión" — qué es, dónde vive y cómo seguir

_Rama `rediseno` (worktree `app-operativa-rediseno`), iniciado el 5-oct-2026
desde `main` 5544038. Solo local: nada se ha subido ni publicado._

## En una línea

La misma app, con otra piel. El estilo es el de **A · Precisión** (tipografía
Inter, líneas finas, un solo color de acento, el estatus como punto de color)
con el **orden de B · Nativo** (títulos grandes, listas agrupadas, filtros en
píldoras y segmentos). Tiene tema **Automático / Claro / Oscuro**, con el mismo
mecanismo de siempre (`lib/tema.ts`).

Ninguna función, rol, filtro ni flujo cambió.

## Prototipos (abrir en el navegador)

| Archivo | Qué muestra |
|---|---|
| `prototipos/index.html` | Comparación: el diseño actual y las alternativas A, B y C |
| `prototipos/precision.html` | La elegida (Bandeja) en claro, oscuro y escritorio |
| `prototipos/modulos.html` | Los 12 módulos, navegables, con el selector de tema |
| `prototipos/ventanas.html` | Las ventanas (reparación, chat, evidencia, visita, revisión…) |

## Qué cambió en la app

**Base (afecta a todo).** `src/estilo/precision.css` se carga DESPUÉS de
`index.css` (ver `main.tsx`) y solo cambia la piel:
- colores de los dos temas;
- Inter incluida en la app (juego latino, 48 KB; entra a la precarga del SW,
  así que funciona sin señal);
- botones, campos, tarjetas, barra superior, menú y ventanas.

`index.css` quedó casi intacto. **No se tocó nada de lo que se arregló para el
iPhone**: posiciones fijas, safe-area, el menú inferior y el armazón. En
`precision.css` no va `position`, `transform`, `filter` ni `backdrop-filter`
sobre `.topbar`, `.side`, `.main` ni `.overlay`.

**Acento.** `#ff5a3c` pasó a `#cc4119` porque con texto blanco da 4.6:1. El
texto sobre el acento usa la variable `--sobre-acento`, no `#151515`. La barra
del sistema (`theme-color`) toma el color del fondo de cada tema.

**Piezas nuevas:**

| Archivo | Para qué |
|---|---|
| `components/IconoNav.tsx` | Íconos lucide del menú en vez de emojis, y nombre corto para la barra del celular |
| `components/MenuMas.tsx` | En el celular, 4 módulos en la barra y el resto en la hoja "Más" (portal en `<body>`). Si hay 5 o menos, caben todos |
| `components/CerrarModal.tsx` | El ✕ de las ventanas. Usa el MISMO manejador y bloqueo que el Cancelar de cada una |
| `lib/toqueFantasma.ts` | Ignora los clics dentro de una ventana o panel durante sus primeros 450 ms (el toque que la abrió puede repetirse en iOS) |

**Clases reutilizables (en `precision.css`):**

| Clase | Qué hace |
|---|---|
| `.inc-list.agrupada` | Lista agrupada. Solo donde los hijos son tarjetas `.inc` |
| `.modal-actions.pie-fijo` | Pie de ventana siempre a la vista. Sigue el patrón de `.rt-pie`; el overlay se detecta con `:has()` porque varias ventanas cierran comparando `className === 'overlay'` (NO agregarle clases al overlay) |
| `.segmento` | Pocas opciones excluyentes como botones con `aria-pressed` |
| `.toolbar.filtros-pildora` | Los `<select>` siguen siendo nativos pero se ven como píldoras; el activo lleva `.on`. En el celular forman una fila deslizable |
| `.pildora-check` | Una casilla dentro de una píldora |

**Por pantalla:**
- **Tarjeta de incidencia** (`IncCard`): estatus como punto, nivel con punto, y la acción principal arriba en el acento. Las condiciones de cada botón no cambiaron.
- **Ventanas:** ✕ en 22 de ellas. Las de campo llevan pie fijo. En el celular salen CENTRADAS; como hoja pegada abajo quedaban al fondo cuando tenían poco contenido.
- **Menú del avatar:** Salir queda fijo al pie del menú.
- **Indicadores:** periodo en segmento y filtros en píldoras.
- **Incidencias, Pauta y Biobox:** filtros en píldoras.
- **Bitácora:** "Campañas · Hoy al aire" en segmento.
- **Fijación:** estado en segmento, con la misma subida de página antes de cambiar (`subirYLuego`).
- **Listas agrupadas:** Incidencias, Pauta, Mis rutas, Disponibilidad, Usuarios y campañas de Bitácora.

## Cómo verlo en local

1. Crear `.env.local` en la raíz del worktree con `VITE_SUPABASE_URL` y
   `VITE_SUPABASE_ANON_KEY`. Git lo ignora; no lo borres ni lo sobrescribas.
2. Ejecutar `npm run dev`. Con HTTPS funciona el GPS; desde el teléfono, en la
   misma red Wi-Fi, abrir la IP que se muestre.
3. ⚠️ **No hay base de pruebas (staging)**: en local la app usa los datos
   REALES. Navegar es seguro; validar, reparar o guardar cambia producción.
4. Probar SIEMPRE en el teléfono directo. La duplicación del iPhone en la Mac
   no entrega bien los toques (el 6-oct, "Salir" parecía no responder por eso).

## Para pasarlo a `main` (cuando se decida)

1. `git merge main` dentro de la rama `rediseno` para traer lo nuevo. Los
   choques probables son pocos y chicos: `App.tsx` (menú), `IncCard.tsx` y los
   módulos donde se cambiaron filtros o ventanas.
2. `npm run build` y una pasada por los 12 módulos en un iPhone y un Android,
   en claro y en oscuro.
3. Revisar sobre todo el menú inferior, las ventanas con pie fijo, el mapa de
   Rutas y Mis rutas, y las píldoras con la rueda del iPhone.
4. Solo entonces publicar. Es un cambio visible para TODOS los usuarios:
   conviene avisarles antes, con una imagen del antes y el después.

## Pendiente o por decidir

- Feedback de usuarios (Erik lo está recogiendo).
- Quedan emojis dentro de algunos botones y etiquetas de los módulos (📥, 🗺️,
  🎯…). Funcionan; cambiarlos por íconos es pulido opcional.
- El color por omisión de una ruta nueva sigue siendo `#ff5a3c`. Es un DATO
  (identidad de la ruta), no la piel; se dejó a propósito.
