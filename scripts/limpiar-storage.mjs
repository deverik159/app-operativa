// ============================================================
// scripts/limpiar-storage.mjs — borrar de Storage los archivos de prueba
//
// Es el PASO 3 de limpiar_todo.sql (y de limpiar_datos_migrados.sql): el
// SQL ya vació las tablas y dejó las rutas de los archivos en
// public._limpieza_paths. Supabase no permite borrar de storage.objects
// por SQL (trigger protect_delete), así que este script los elimina por la
// Storage API, que es la vía soportada y sí borra el archivo físico.
//
// CÓMO CORRERLO (desde la carpeta del proyecto):
//
//   Mac / Linux:
//     SUPABASE_URL="https://TU-PROYECTO.supabase.co" \
//     SUPABASE_SERVICE_ROLE_KEY="la-service-role-key" \
//     node scripts/limpiar-storage.mjs
//
//   Windows (PowerShell):
//     $env:SUPABASE_URL = "https://TU-PROYECTO.supabase.co"
//     $env:SUPABASE_SERVICE_ROLE_KEY = "la-service-role-key"
//     node scripts/limpiar-storage.mjs
//
// La service role key está en Supabase → Settings → API → service_role.
// Se pasa por variable de entorno A PROPÓSITO: no se guarda en ningún
// archivo ni se commitea. Esa llave brinca la RLS — no la compartas.
//
// Antes de borrar enseña el proyecto y cuántos archivos van, y pide
// escribir BORRAR (27-sep-2026). Se niega a correr si la lista trae algo
// de fijacion-externa/: esas fotos son de la base de Mario.
//
// Va en lotes de 100 y borra cada ruta de _limpieza_paths solo cuando el
// bucket confirmó: si se interrumpe (red, Ctrl+C), se vuelve a correr y
// retoma donde iba. Al terminar, correr el PASO 4 del SQL.
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline/promises';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    'Faltan variables. Uso:\n' +
      '  SUPABASE_URL="https://TU-PROYECTO.supabase.co" ' +
      'SUPABASE_SERVICE_ROLE_KEY="…" node scripts/limpiar-storage.mjs\n' +
      '(en PowerShell: $env:SUPABASE_URL = "…"; $env:SUPABASE_SERVICE_ROLE_KEY = "…")'
  );
  process.exit(1);
}

const sb = createClient(url, key);
const BUCKET = 'evidencias';
const LOTE = 100;
/** Carpetas que NUNCA se borran desde aquí (fotos de la base de Mario). */
const PROTEGIDAS = ['fijacion-externa/'];

// --- Antes de borrar: qué hay, dónde, y confirmación ---
const { count, error: eCuenta } = await sb
  .from('_limpieza_paths')
  .select('path', { count: 'exact', head: true });
if (eCuenta) {
  console.error('No se pudo leer _limpieza_paths:', eCuenta.message);
  console.error('¿Ya corriste el PASO 2 del SQL? ¿La llave es la service_role?');
  process.exit(1);
}
if (!count) {
  console.log('No había nada pendiente: _limpieza_paths está vacía.');
  console.log('Corre el PASO 4 del SQL para verificar.');
  process.exit(0);
}

for (const carpeta of PROTEGIDAS) {
  const { count: n, error } = await sb
    .from('_limpieza_paths')
    .select('path', { count: 'exact', head: true })
    .like('path', carpeta + '%');
  if (error || n) {
    console.error(
      error
        ? 'No se pudo revisar la lista: ' + error.message
        : `La lista trae ${n} archivo(s) de ${carpeta}, que NO se deben borrar.`
    );
    console.error('No se borró nada. Revisa el PASO 2 del SQL.');
    process.exit(1);
  }
}

let proyecto = url;
try {
  proyecto = new URL(url).hostname.split('.')[0];
} catch {
  /* se enseña la URL tal cual */
}
console.log(`\nProyecto: ${proyecto}`);
console.log(`Se van a borrar ${count} archivos del bucket "${BUCKET}". No hay vuelta atrás.`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const resp = await rl.question('Escribe BORRAR para continuar: ');
rl.close();
if (resp.trim() !== 'BORRAR') {
  console.log('Cancelado: no se borró nada.');
  process.exit(0);
}

// --- Borrado por lotes ---
let borrados = 0;

for (;;) {
  const { data, error } = await sb
    .from('_limpieza_paths')
    .select('path')
    .limit(LOTE);
  if (error) {
    console.error('No se pudo leer _limpieza_paths:', error.message);
    process.exit(1);
  }
  if (!data.length) break;

  const paths = data.map((r) => r.path);
  if (paths.some((p) => PROTEGIDAS.some((c) => p.startsWith(c)))) {
    console.error('Apareció una ruta protegida en la lista: me detengo sin borrar este lote.');
    process.exit(1);
  }
  // remove() no truena por archivos que ya no existen: los reporta y sigue.
  const { error: eRm } = await sb.storage.from(BUCKET).remove(paths);
  if (eRm) {
    console.error('Storage rechazó el lote:', eRm.message);
    console.error('Nada de este lote se marcó como borrado; re-corre para reintentar.');
    process.exit(1);
  }

  const { error: eDel } = await sb
    .from('_limpieza_paths')
    .delete()
    .in('path', paths);
  if (eDel) {
    console.error('Los archivos se borraron pero no se pudo vaciar la lista:', eDel.message);
    process.exit(1);
  }

  borrados += paths.length;
  console.log(`${borrados} de ${count} archivos borrados…`);
}

console.log(`Listo: ${borrados} archivos eliminados del bucket "${BUCKET}".`);
console.log('Ahora corre el PASO 4 del SQL para verificar y el PASO 5 para tirar la tabla puente.');
