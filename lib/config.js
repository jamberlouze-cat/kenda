// ⚙️  CONFIGURATION — à remplir une seule fois.
//
// 1. Crée un projet gratuit sur https://supabase.com
// 2. Dans le tableau de bord : Project Settings → API Keys
// 3. Copie « Project URL » et la clé « publishable » (ou « anon public ») ci-dessous.
//
// (Cette clé est faite pour vivre dans le navigateur : la sécurité réelle est
//  assurée par les règles RLS du fichier schema.sql.)

export const SUPABASE_URL = "https://lcbghasziywkpfwzbdil.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_J4oVo45DUPmDW5fHZviRcg_iouCMOKp";

export function isConfigured() {
  return !SUPABASE_URL.includes("VOTRE-PROJET") &&
         !SUPABASE_ANON_KEY.includes("VOTRE_CLE");
}
