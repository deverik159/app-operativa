// ============================================================
// scripts/limpiar-storage.mjs — borrar de Storage los archivos viejos
//
// Es el PASO 3 de limpiar_datos_migrados.sql: el SQL ya borró las filas y
// dejó las rutas de los archivos en public._limpieza_paths. Supabase no
// permite borrar de storage.objects por SQL (trigger protect_delete), así
// que este script los elimina por la Storage API, que es la vía soportada
// y sí borra el archivo físico.
//
// CÓMO CORRERLO (desde la carpeta del proyecto):
//
//   SUPABASE_URL="https://TU-PROYECTO.supabase.co" \
//   SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
//   node scripts/limpiar-storage.mjs
//
// La service role key está en Supabase → Settings → API → service_role.
// Se pasa por variable de entorno A PROPÓSITO: no se guarda en ningún
// archivo ni se commitea. Esa llave brinca la RLS — no la compartas.
//
// Va en lotes de 100 y borra cada ruta de _limpieza_paths solo cuando el
// bucket confirmó: si se interrumpe (red, Ctrl+C), se vuelve a correr y
// retoma donde iba. Al terminar, correr el PASO 4 del SQL.
// ============================================================
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    'Faltan variables. Uso:\n' +
      '  SUPABASE_URL="https://TU-PROYECTO.supabase.co" ' +
      'SUPABASE_SERVICE_ROLE_KEY="eyJ..." node scripts/limpiar-storage.mjs'
  );
  process.exit(1);
}

const sb = createClient(url, key);
const BUCKET = 'evidencias';
const LOTE = 100;

let borrados = 0;

for (;;) {
  const { data, error } = await sb
    .from('_limpieza_paths')
    .select('path')
    .limit(LOTE);
  if (error) {
    console.error('No se pudo leer _limpieza_paths:', error.message);
    console.error('¿Ya corriste el PASO 2 del SQL? ¿La llave es la service_role?');
    process.exit(1);
  }
  if (!data.length) break;

  const paths = data.map((r) => r.path);
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
  console.log(`${borrados} archivos borrados…`);
}

console.log(
  borrados === 0
    ? 'No había nada pendiente: _limpieza_paths está vacía.'
    : `Listo: ${borrados} archivos eliminados del bucket "${BUCKET}".`
);
console.log('Ahora corre el PASO 4 del SQL para verificar y tirar la tabla puente.');
