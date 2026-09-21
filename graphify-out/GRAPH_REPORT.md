# Graph Report - Kenda  (2026-09-21)

## Corpus Check
- Corpus is ~41,049 words - fits in a single context window. You may not need a graph.

## Summary
- 642 nodes · 1777 edges · 28 communities (23 shown, 5 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 54 edges (avg confidence: 0.86)
- Token cost: 157,261 input · 0 output

## Community Hubs (Navigation)
- Supabase Auth Client (vendor)
- Feeding Stats & Charts
- App Boot, Sync & Offline Queue
- App Core Constants & Helpers
- Fake Supabase Test Double
- Local Store & Photo Cache
- Docs, Deployment & Config
- Supabase Storage API (vendor)
- Growth Percentiles (LMS)
- Supabase Realtime Setup (vendor)
- Home Cards: Growth & Firsts
- Entry Sheets & Timers
- Realtime Socket Transport (vendor)
- Form Sheets & Auth Views
- Allergens Module
- Vendor Fetch & Endpoint Helpers
- Realtime Channel Push (vendor)
- Realtime Channel Lifecycle (vendor)
- App Shell Rendering & Navigation
- Koala Icons & Mascot
- Dev Server
- Vendor Minified Helpers A
- Feed Entry Design Decisions
- Vendor SSO Sign-in
- Vendor Minified Helpers B
- Vendor Admin Link Generation
- Vendor Event Unsubscribe

## God Nodes (most connected - your core abstractions)
1. `p()` - 41 edges
2. `icon()` - 39 edges
3. `esc()` - 38 edges
4. `constructor()` - 30 edges
5. `_debug()` - 22 edges
6. `loadAll()` - 21 edges
7. `w()` - 20 edges
8. `currentBaby()` - 19 edges
9. `toast()` - 18 edges
10. `unit()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `Banc d'essai (_dev/test.html) : la vraie app.js sur un faux Supabase` --semantically_similar_to--> `index.html : coquille de l'app`  [INFERRED] [semantically similar]
  _dev/test.html → index.html
- `todayKey()` --calls--> `dayKey()`  [EXTRACTED]
  app.js → lib/stats.js
- `homeDiapers()` --calls--> `dayKey()`  [EXTRACTED]
  app.js → lib/stats.js
- `homeDiapers()` --calls--> `formatElapsed()`  [EXTRACTED]
  app.js → lib/stats.js
- `formatMeasure()` --calls--> `formatLength()`  [EXTRACTED]
  app.js → lib/growth.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Garde-éveil Supabase : cron Cloudflare + GitHub Actions + /_ping** — github_workflows_supabase_eveil, worker, readme_ping_endpoint, readme_garde_eveil_supabase [EXTRACTED 1.00]
- **Stratégie hors ligne : file d'attente, identifiants client, dernier gagne, suppression douce, cache photos, service worker** — readme_hors_ligne_file_d_attente, readme_conflits_feeds_keep_latest, readme_suppression_douce_deleted_at, readme_photos_indexeddb, index_enregistrement_service_worker [INFERRED 0.85]
- **Séparation production / Kenda DEV / banc d'essai** — readme_cloudflare_workers, index_detection_dev, dev_test, readme_banc_d_essai_local [INFERRED 0.85]

## Communities (28 total, 5 thin omitted)

### Community 0 - "Supabase Auth Client (vendor)"
Cohesion: 0.07
Nodes (73): _acquireLock(), At(), _autoRefreshTokenTick(), bs(), _callRefreshToken(), _challenge(), _challengeAndVerify(), createUser() (+65 more)

### Community 1 - "Feeding Stats & Charts"
Cohesion: 0.09
Nodes (65): amount(), babyFeeds(), babyNursings(), babyPumpings(), bottleOn(), bottleStats(), capitalize(), caregiver() (+57 more)

### Community 3 - "App Boot, Sync & Offline Queue"
Cohesion: 0.10
Nodes (51): boot(), chooseBaby(), closeSheet(), commitFeed(), commitRow(), createOrJoinBaby(), createOrJoinBabyOnce(), deleteSheet() (+43 more)

### Community 4 - "App Core Constants & Helpers"
Cohesion: 0.06
Nodes (33): allergenCustom(), allergenPick(), ALLERGENS, app, CAREGIVER_COLORS, cleanAmount(), ensureScrim(), FORM_SHEETS (+25 more)

### Community 5 - "Fake Supabase Test Double"
Cohesion: 0.07
Nodes (11): create_baby(), emit(), iso(), join_baby(), Query, save(), seed(), baby() (+3 more)

### Community 6 - "Local Store & Photo Cache"
Cohesion: 0.07
Nodes (25): Enregistrement du service worker (sw.js), memory, photos, babyMemory, nameMemory, queue, snapshot, timerMemory (+17 more)

### Community 7 - "Docs, Deployment & Config"
Cohesion: 0.10
Nodes (27): Banc d'essai (_dev/test.html) : la vraie app.js sur un faux Supabase, Workflow GitHub Actions : Supabase garde-éveil, Job ping : trois requêtes REST (babies, caregivers, feeds), index.html : coquille de l'app, Détection « DEV » (PROD_HOSTS, window.KENDA_DEV, manifeste et icônes à part), Métadonnées PWA (manifeste, icônes, apple-mobile-web-app), SUPABASE_ANON_KEY, SUPABASE_URL (+19 more)

### Community 8 - "Supabase Storage API (vendor)"
Cohesion: 0.10
Nodes (28): copy(), createBucket(), createSignedUploadUrl(), createSignedUrl(), createSignedUrls(), download(), emptyBucket(), encodeMetadata() (+20 more)

### Community 9 - "Growth Percentiles (LMS)"
Cohesion: 0.12
Nodes (22): CM_PER_IN, comma(), formatLength(), formatWeight(), G_PER_LB, G_PER_OZ, lbOzToG(), lengthToCm() (+14 more)

### Community 10 - "Supabase Realtime Setup (vendor)"
Cohesion: 0.11
Nodes (24): cloneDeep(), constructor(), fs(), _handleTokenChanged(), _initRealtimeClient(), _initSupabaseAuthClient(), inPendingSyncState(), _isClosed() (+16 more)

### Community 11 - "Home Cards: Growth & Firsts"
Cohesion: 0.23
Nodes (22): currentBaby(), firstWhen(), fmtDate(), formatMeasure(), growthChart(), growthPoints(), homeDiapers(), homeFirsts() (+14 more)

### Community 12 - "Entry Sheets & Timers"
Cohesion: 0.18
Nodes (22): daysAgo(), deleteFoot(), fmtClock(), pumpTotalLabel(), runningRow(), sheetBand(), sheetDiaper(), sheetNursing() (+14 more)

### Community 13 - "Realtime Socket Transport (vendor)"
Cohesion: 0.14
Nodes (21): a(), _binaryDecode(), connectionState(), decode(), _decodeBroadcast(), _flushSendBuffer(), isConnected(), _isMember() (+13 more)

### Community 14 - "Form Sheets & Auth Views"
Cohesion: 0.21
Nodes (15): babyFormHtml(), dateRow(), esc(), noteRow(), photoRow(), render(), resetScroll(), sheetFirst() (+7 more)

### Community 15 - "Allergens Module"
Cohesion: 0.31
Nodes (14): agoDays(), alBadge(), alDef(), alDot(), alLabel(), allergenStats(), alStatus(), exposureRow() (+6 more)

### Community 16 - "Vendor Fetch & Endpoint Helpers"
Cohesion: 0.20
Nodes (14): _appendParams(), c(), connect(), _endPointURL(), exists(), h(), i(), ks() (+6 more)

### Community 17 - "Realtime Channel Push (vendor)"
Cohesion: 0.15
Nodes (14): _cancelRefEvent(), _cancelTimeout(), deleteBucket(), destroy(), _getPayloadRecords(), gt(), _joinRef(), _matchReceive() (+6 more)

### Community 18 - "Realtime Channel Lifecycle (vendor)"
Cohesion: 0.20
Nodes (14): _canPush(), disconnect(), _fetchWithTimeout(), _hasReceived(), _isJoined(), _isJoining(), _leaveOpenTopic(), receive() (+6 more)

### Community 19 - "App Shell Rendering & Navigation"
Cohesion: 0.24
Nodes (12): babyFace(), delta(), firstBadge(), icon(), navBtn(), pageModules(), refreshHeader(), renderApp() (+4 more)

### Community 20 - "Koala Icons & Mascot"
Cohesion: 0.38
Nodes (10): Kenda app icon 180px (lavender koala on cream, Apple touch icon size), Kenda app icon 192px (lavender koala on cream, PWA manifest size), Kenda app icon 512px (lavender koala on cream, large PWA/splash size), Kenda dev icon 180px (cream koala on near-black, Apple touch icon size), Kenda dev icon 192px (cream koala on near-black, PWA manifest size), Kenda dev icon 512px (cream koala on near-black, large PWA/splash size), Dev build icon variant (inverted: cream koala on dark background, distinguishes dev install from production), Production PWA app icon (lavender koala on cream background) (+2 more)

### Community 21 - "Dev Server"
Cohesion: 0.29
Nodes (4): NoCacheHandler, http_server, socketserver, sys

### Community 22 - "Vendor Minified Helpers A"
Cohesion: 0.67
Nodes (3): Ar(), Er(), or()

### Community 23 - "Feed Entry Design Decisions"
Cohesion: 0.67
Nodes (3): Passation : alerte si un boire a été noté dans les 20 dernières minutes, Quantités gardées en ml ; unité ml/oz = réglage partagé du bébé, Saisie d'un boire (fiche, sélecteur natif, dernière quantité)

## Knowledge Gaps
- **33 isolated node(s):** `KINDS`, `KIND_SHORT`, `CAREGIVER_COLORS`, `REMIND_CHOICES`, `MODULES` (+28 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 129 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Banc d'essai (_dev/test.html) : la vraie app.js sur un faux Supabase` connect `Docs, Deployment & Config` to `App Core Constants & Helpers`, `Fake Supabase Test Double`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Why does `index.html : coquille de l'app` connect `Docs, Deployment & Config` to `App Core Constants & Helpers`, `Local Store & Photo Cache`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **What connects `KINDS`, `KIND_SHORT`, `CAREGIVER_COLORS` to the rest of the system?**
  _33 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Supabase Auth Client (vendor)` be split into smaller, more focused modules?**
  _Cohesion score 0.06506849315068493 - nodes in this community are weakly interconnected._
- **Should `Feeding Stats & Charts` be split into smaller, more focused modules?**
  _Cohesion score 0.08638625056535504 - nodes in this community are weakly interconnected._
- **Should `Supabase Query Builder (vendor)` be split into smaller, more focused modules?**
  _Cohesion score 0.03571428571428571 - nodes in this community are weakly interconnected._
- **Should `App Boot, Sync & Offline Queue` be split into smaller, more focused modules?**
  _Cohesion score 0.09568627450980392 - nodes in this community are weakly interconnected._