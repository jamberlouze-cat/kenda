// Copie locale de supabase-js (voir l'en-tête du fichier) : l'app doit pouvoir
// démarrer sans réseau.
import { createClient } from "./vendor/supabase-js.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// En développement, _dev/test.html injecte un faux Supabase en mémoire.
// La session est persistée dans localStorage et rafraîchie automatiquement :
// on se connecte une seule fois par appareil.
export const supabase = globalThis.__KENDA_FAKE_SUPABASE__ ||
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
