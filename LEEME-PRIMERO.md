# Central de Operaciones GPO VALLAS — cómo levantar el proyecto

Este zip es el proyecto **completo y al día**: incidencias, usuarios, KPIs,
fijación externa, rutas de monitoreo, pauta y el módulo nuevo de Biobox.

No trae `node_modules` ni `dist` (se generan) ni `.env.local` (tiene tus
llaves). Todo lo demás está.

---

## 1. Instalar

Descomprime **reemplazando la carpeta completa**. No copies archivos sueltos:
este proyecto ya se rompió dos veces por eso —una carpeta que no existía en
destino deja imports colgando y la app arranca en blanco, sin decir por qué.

Si prefieres conservar la carpeta vieja, renómbrala en vez de mezclarla:

```bash
mv app-operativa app-operativa-vieja
# descomprime el zip como app-operativa
```

## 2. Recuperar tu `.env.local`

**Es lo único que el zip no trae, y sin él la app no conecta.** Cópialo de la
carpeta vieja, o créalo desde la plantilla:

```bash
cp app-operativa-vieja/.env.local app-operativa/.env.local
# o bien:
cp .env.example .env.local     # y pega la anon key
```

Lleva dos variables: `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`. La anon
key está en Supabase → Project Settings → API → *anon public*.

`VITE_VAPID_PUBLIC_KEY` puede quedar vacía: las notificaciones push aún no
están configuradas. El botón 🔕 de la barra lo dirá.

## 3. Correr

```bash
npm install
npm run dev          # HTTPS, necesario para el GPS en red local
```

Abre **https://localhost:5173**. El navegador va a advertir por el
certificado: es autofirmado, acepta y sigue.

Desde el celular, en la misma red, escribe la dirección **completa**:
`https://TU-IP:5173` — con `https://`, no solo la IP. Si no levanta:

```bash
npm run dev:http     # sin HTTPS; el GPS deja de funcionar
```

---

## Estado de la base de datos

(31-oct-2026) Todo lo que esta sección pedía aplicar ya está en producción. Los
SQL sueltos se movieron a `contexto/_archivo/sql-historico/` (privado) y **no se
vuelven a correr**. Los cambios de base van solo como migración en
`supabase/migrations/` (ver su README).

---

## Por dónde seguir

`HANDOFF-COMPLETO-GPOVALLAS.md` tiene el detalle de todo: esquema, decisiones
de diseño y por qué, deuda técnica conocida y la lista de pendientes (§9).

Lo inmediato de Biobox: importar el mapa de My Maps desde **Rutas de
Monitoreo → 🗺️ Importar mapa (KML)** y ligar los puntos del checklist con el
catálogo de incidencias desde **Máquinas Biobox → ⚙️ Checklist**.
