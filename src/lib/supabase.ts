// ============================================================
// src/lib/supabase.ts
// Cliente único de Supabase para toda la app.
// Las credenciales vienen de variables de entorno (.env.local),
// NO hardcodeadas como en el HTML original.
// ============================================================
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  // Aviso claro en desarrollo si faltan las variables de entorno.
  console.error(
    'Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY en .env.local'
  );
}

export const sb = createClient(url, anonKey);
