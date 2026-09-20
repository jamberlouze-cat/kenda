# 🍼 Kenda

Petite app web (PWA) pour suivre les boires de bébé, partagée **en temps réel**
entre les deux parents. Saisie en trois touches, compteurs « aujourd'hui » et
« dernières 24 h » toujours visibles, historique semaine / 2 semaines avec calendrier,
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
- **Modules** (Paramètres → Gérer les modules) : Biberon, Couches, Croissance,
  Premières de bébé. Ordre par glisser-déposer, chacun activable ; un module
  désactivé disparaît de l'accueil, ses données restent. Sous « Biberon », les
  types de lait proposés à la saisie.
- **Couches** : heure (roulette), mouillée et/ou sale (ni l'un ni l'autre =
  sèche), érythème fessier. Même mécanique hors ligne que les boires.
- **Croissance** : poids, taille, tour de tête (chacun facultatif), note et
  photo. En base tout est métrique ; kg ou lb·oz, cm ou po se choisissent dans
  les Paramètres. Les courbes affichent les percentiles 3, 15, 50, 85 et 97 des
  normes de l'OMS (`lib/lms.js`, méthode LMS dans `lib/growth.js`) — ce sont
  les courbes du carnet de santé du Québec. Il faut le sexe et la date de
  naissance du bébé (Paramètres).
- **Premières** : date, titre libre (un émoji au début devient l'icône), note,
  photo ; l'âge du bébé est affiché si la date de naissance est connue.
- **Allaitement** (sous-option de Biberon dans « Gérer les modules ») : le « + »
  de Boires propose Allaitement ou Biberon. Fiche à deux minuteurs Gauche /
  Droit (pause, reprise ; démarrer l'un met l'autre en pause), pastille
  « dernier sein », heure de début. Le minuteur survit à la fermeture de la
  fiche et de l'app (`kenda.timers.v1`) ; l'accueil montre « en cours ». Les
  tétées se mêlent aux boires (accueil, journal, calendrier), sans quantité.
- **Tire-lait** (module, rose) : Gauche/Droite ou Total, minuteur, heure de
  début, quantités, note, photo. Historique par jour avec total.
- **Allergènes** (module, menthe) : introduction des 10 allergènes prioritaires, d'après le guide
  d'Allergies Québec (avril 2024). Une seule sorte d'entrée, l'exposition (table `allergen_exposures`) ;
  l'état de chaque allergène est calculé par l'app : pas introduit → en cours → toléré après 3 expositions
  sans réaction → réaction (reste marquée). Noix, poissons et fruits de mer se suivent une variété à la
  fois (clés `noix:cajou`). Au plus un allergène non toléré par entrée ; les tolérés se combinent.
  L'accueil liste sous « À redonner » les tolérés pas mangés depuis plus de 7 jours (rien si tout est à jour) ; le « i » du bloc ouvre le mode d'emploi. Aucun conseil médical.
- **Photos** des mesures, des premières et des séances de tire-lait : réduites à 640 px sur l'appareil,
  gardées dans la base, mais pas dans l'instantané localStorage (trop petit) :
  copie dans IndexedDB (`lib/photos.js`), chargée à part de la liste.

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
lib/growth.js           courbes de croissance : LMS, percentiles, âge, unités
lib/lms.js              tables LMS de l'OMS (généré, 0-5 ans, garçon/fille)
lib/photos.js           cache des photos (mémoire + IndexedDB)
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
