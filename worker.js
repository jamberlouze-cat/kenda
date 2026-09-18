// Worker Cloudflare de Kenda.
//
// Le site lui-même est servi comme fichiers statiques (voir wrangler.jsonc).
// Ce script n'a qu'un rôle : garder le projet Supabase éveillé. L'offre
// gratuite met un projet en pause après une semaine « sans activité
// suffisante » : Supabase exige quelques requêtes à la base chaque jour (deux
// par semaine ne suffisaient pas — leçon apprise sur Calico et Panache le
// 2026-09-14). La tâche planifiée (voir "triggers" dans wrangler.jsonc)
// « visite » donc la base quatre fois par jour.
//
// Les requêtes envoyées sont minuscules : elles demandent un identifiant dans
// trois tables avec la clé publique, et les règles de sécurité (RLS) répondent
// une liste vide. Ça compte comme de l'activité sans rien exposer.
// (Le même ping existe aussi dans .github/workflows/supabase-eveil.yml, au
// cas où le cron Cloudflare ne tournerait pas.)

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./lib/config.js";

const TABLES = ["babies", "caregivers", "feeds"];

async function pingSupabase() {
  const statuts = await Promise.all(TABLES.map(async (table) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id&limit=1`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!res.ok) throw new Error(`Supabase a répondu ${res.status} pour ${table}`);
    return res.status;
  }));
  console.log(`Supabase keep-alive: HTTP ${statuts.join(", ")}`);
  return statuts;
}

const text = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  // Tâche planifiée : trois requêtes légères à l'API REST de Supabase.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pingSupabase());
  },

  // Toute requête qui ne correspond à aucun fichier statique aboutit ici.
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/_ping") {
      try {
        await pingSupabase();
        return text("Supabase répond.");
      } catch (err) {
        return text(`Échec : ${err.message}`, 502);
      }
    }
    return text("Page introuvable.", 404);
  },
};
