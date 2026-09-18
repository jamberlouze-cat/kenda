# 🍼 Kenda

Petite app web (PWA) pour suivre les boires de bébé, partagée **en temps réel**
entre les deux parents. Saisie en trois touches, compteurs « aujourd'hui » et
« dernières 24 h » toujours visibles, historique jour / semaine / 2 semaines,
horaire type, plusieurs bébés, et ça marche **hors ligne**.

- Aucune compilation, aucun `npm` : juste des fichiers statiques (comme Calico et Panache).
- Données + temps réel + connexion : **Supabase** (offre gratuite).
- Hébergement : **Cloudflare Workers**, publié à chaque `git push`.
- Installable sur l'écran d'accueil de l'iPhone.

---

## 1. Créer le projet Supabase (≈ 3 min, une seule fois)

1. https://supabase.com → connecte-toi avec **max.chamberland@gmail.com** → **New project**.
   Nom : « Kenda », région la plus proche (*East US* ou *Canada Central*).
2. Menu de gauche → **SQL Editor** → **New query** → copie **tout** `schema.sql`,
   colle, **Run**. Tu dois voir « Success ». (Rejouable sans danger.)
3. **Authentication → Sign In / Providers → Email** : activé, et **désactive
   « Confirm email »** → Save. (Le compte est actif tout de suite, aucun courriel
   à envoyer — même réglage que Calico et Panache.)
4. **Authentication → URL Configuration → Site URL** :
   `https://kenda.jamberlouze.workers.dev` ; dans **Redirect URLs**, ajoute aussi
   `https://dev-kenda.jamberlouze.workers.dev` (pour « Mot de passe oublié ? »).
5. **Project Settings → API Keys** : note la **Project URL** et la clé
   **publishable** (`sb_publishable_…`).

## 2. Relier l'app

Ouvre `lib/config.js` et remplace les deux valeurs :

```js
export const SUPABASE_URL = "https://abcdxyz.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_...";
```

> Cette clé est faite pour vivre dans le navigateur : la vraie sécurité vient des
> règles RLS de `schema.sql` (on ne voit que les bébés qu'on suit).

## 3. Héberger — GitHub + Cloudflare

1. Sur GitHub (compte **jamberlouze-cat**) : crée un dépôt **privé** `kenda`, vide.
2. Pousse le code (l'alias SSH `github-calico` est celui du compte jamberlouze-cat) :

   ```bash
   git remote add origin git@github-calico:jamberlouze-cat/kenda.git
   git push -u origin main dev
   ```

3. Cloudflare → **Workers & Pages → Create → Import a repository** → `kenda`.
   Nom du projet : `kenda` (l'adresse devient `kenda.jamberlouze.workers.dev`).
   Dans **Settings → Build → Branch control**, active les constructions des
   branches secondaires : la branche `dev` est alors publiée à
   `dev-kenda.jamberlouze.workers.dev`.

- branche **`main`** → production : https://kenda.jamberlouze.workers.dev
- branche **`dev`** → aperçu « Kenda DEV » (icône à fond foncé, pour ne pas
  confondre les deux sur l'iPhone) : https://dev-kenda.jamberlouze.workers.dev

Cycle habituel : commit + push sur `dev` → test sur « Kenda DEV » → fusion dans
`main` pour publier.

### Supabase reste éveillé tout seul

L'offre gratuite met un projet en pause après 7 jours sans activité suffisante :
il faut quelques requêtes à la base **chaque jour**. Deux gardiens indépendants :

- `worker.js` : tâche planifiée Cloudflare, quatre fois par jour (trois petites
  requêtes auxquelles les règles de sécurité répondent une liste vide).
- `.github/workflows/supabase-eveil.yml` : GitHub Actions, trois fois par jour
  (ne tourne que sur `main`).

Vérifier à la main : https://kenda.jamberlouze.workers.dev/_ping doit répondre
« Supabase répond. »

## 4. Installer sur l'iPhone

Ouvre l'adresse dans **Safari** → **Partager** → **Sur l'écran d'accueil**.

## 5. Premier usage

1. Toi : courriel + mot de passe → **Continuer** (la première fois, ça crée le compte).
2. Entre ton prénom et celui du bébé → **Créer le suivi**.
3. **Paramètres → Partage** : copie le **code de partage**.
4. Ta conjointe : crée son compte, entre son prénom et le code → **Rejoindre ce
   suivi**. Vous voyez les mêmes boires, en temps réel.
5. Jumeaux ou deuxième enfant : **Paramètres → Mes bébés → Ajouter un bébé**.
   Chaque bébé a son propre code ; on bascule en touchant le nom en haut.

---

## Comment ça marche

- **Quantités** : toujours gardées en ml dans la base ; l'unité (ml ou oz) est un
  réglage du bébé, partagé, jamais redemandé à la saisie. 1 oz = 29,5735 ml.
- **Aujourd'hui** = depuis minuit (heure de l'appareil). **Dernières 24 h** =
  fenêtre glissante. Les deux sont recalculés à chaque affichage, toutes les
  20 secondes, et à chaque retour dans l'app.
- **Saisie** : le « + » de la carte « Boires » ouvre une fiche ; l'heure passe par
  le sélecteur natif de l'iPhone, la quantité par son clavier numérique (ouvert
  d'office). « Utiliser la dernière quantité ? Oui » la remplit d'une touche.
- **Hors ligne** : on peut ajouter, corriger et supprimer des boires. Ils sont
  gardés sur l'appareil (file d'attente) et envoyés dès que le réseau revient ;
  un petit nuage marque ceux qui attendent. Le compte, les bébés et les réglages
  partagés attendent le réseau. L'app démarre sur la dernière synchro.
- **Conflits** : chaque boire a un identifiant créé sur l'appareil (pas de
  doublon au renvoi) ; si les deux parents corrigent le même boire, la
  modification la plus récente gagne (déclencheur `feeds_keep_latest`).
- **Suppression** : le boire est marqué `deleted_at` (rien n'est effacé pour de bon).
- **Passation** : à l'ouverture de l'ajout, l'app prévient si un boire a été noté
  dans les 20 dernières minutes, et par qui.
- **Horaire type** : nombre médian de boires par jour → regroupement des heures
  de boire en autant de créneaux ; un créneau n'est gardé que s'il revient au
  moins 4 jours sur 10. Demande au moins 3 jours de saisie.

## Structure des fichiers

```
index.html              coquille de l'app + service worker + détection « DEV »
app.css                 thème pastel (lilas, bleu poudre, crème)
app.js                  logique : auth, bébés, vues, feuilles, temps réel, hors ligne
lib/config.js           ← TES clés Supabase vont ici
lib/supabase.js         client Supabase
lib/vendor/             supabase-js embarqué (pour démarrer hors ligne)
lib/store.js            file d'attente + instantané (localStorage)
lib/stats.js            compteurs, tendances, horaire type (fonctions pures)
sw.js                   service worker (augmenter CACHE quand la liste SHELL change)
manifest*.webmanifest   métadonnées PWA (prod et DEV)
schema.sql              à exécuter dans Supabase
worker.js               garde-éveil Supabase + /_ping
wrangler.jsonc          config Cloudflare Workers (+ cron)
_headers                en-têtes HTTP
.assetsignore           fichiers du dépôt à ne pas publier

_dev/test.html          banc d'essai : la vraie app sur un faux Supabase
_dev/fake-supabase.js   le faux Supabase (voir son en-tête pour les scénarios)
_dev/devserver.py       petit serveur local sans cache
```

## Tester en local

```bash
python3 _dev/devserver.py 8770
```

Puis http://localhost:8770/_dev/test.html?fresh=1 (données de démo, aucun
Supabase requis). `?fresh=empty` : écran de bienvenue ; `?fresh=auth` : écran de
connexion.
