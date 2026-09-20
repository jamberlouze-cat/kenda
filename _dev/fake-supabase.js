// Faux Supabase en mémoire (dev seulement) : permet de tester toute l'interface
// sans projet Supabase. Chargé par _dev/test.html avant app.js.
// Les données vivent dans localStorage (clé kenda.fake.db).
//   ?fresh=1      données de démo neuves (2 bébés, 16 jours de boires)
//   ?fresh=empty  compte connecté, aucun bébé (écran de bienvenue)
//   ?fresh=auth   déconnecté (écran de connexion ; maxime@test.local / secret1 ;
//                 un nouveau courriel crée un compte, qui peut rejoindre KND42)
// Dans la console :
//   __fakeOffline = true        toutes les requêtes échouent comme sans réseau
//   localStorage["kenda.fake.offline"] = "1"   idem, mais survit au rechargement (démarrage hors ligne)
//   __fakeLatency = 1500        réseau lent
//   __fakeOther(120)            « Julie » ajoute un boire depuis son appareil (temps réel)
(function () {
  const DB_KEY = "kenda.fake.db", SESSION_KEY = "kenda.fake.session";
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2));
  const params = new URLSearchParams(location.search);
  const fresh = params.get("fresh");
  if (fresh) ["kenda.queue.v1", "kenda.snapshot.v1", "kenda.baby.v1"].forEach((k) => localStorage.removeItem(k));
  let db = fresh ? null : JSON.parse(localStorage.getItem(DB_KEY) || "null");
  if (!db) { db = seed(fresh); save(); }
  db.allergen_exposures ||= [];          // base d'essai créée avant le module Allergènes
  if (fresh) history.replaceState(null, "", location.pathname);
  function save() { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
  function iso(ms) { return new Date(ms).toISOString(); }

  function seed(mode) {
    const d = { users: [], babies: [], caregivers: [], feeds: [], diapers: [], growth: [], firsts: [], nursings: [], pumpings: [], allergen_exposures: [] };
    const u = { id: uuid(), email: "maxime@test.local", password: "secret1" };
    const u2 = { id: uuid(), email: "julie@test.local", password: "secret1" };
    d.users.push(u, u2);
    if (mode === "auth") localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify({ user: { id: u.id, email: u.email } }));
    if (mode === "empty") return d;

    const now = Date.now(), DAY = 86400000;
    let s = 11; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    function baby(name, code, hours, base, kinds) {
      const b = { id: uuid(), name, join_code: code, unit: "ml", kinds: ["maternel", "formule"], remind_after_min: 210, created_at: iso(now - 20 * DAY),
        sex: name === "Milo" ? "m" : "f", birth_date: new Date(now - 130 * DAY).toISOString().slice(0, 10), weight_unit: "kg", length_unit: "cm", modules: null, nursing: true };
      d.babies.push(b);
      const max = { id: uuid(), baby_id: b.id, user_id: u.id, name: "Maxime", color: "#6B5A85", created_at: iso(now - 20 * DAY) };
      const jul = { id: uuid(), baby_id: b.id, user_id: u2.id, name: "Julie", color: "#3E6B7A", created_at: iso(now - 19 * DAY) };
      d.caregivers.push(max, jul);
      for (let day = 60; day >= 0; day--) {
        const midnight = new Date(now - day * DAY); midnight.setHours(0, 0, 0, 0);
        hours.forEach((h, i) => {
          if (rnd() < 0.06) return;                                  // un boire sauté de temps en temps
          const at = midnight.getTime() + (h * 60 + Math.round((rnd() - 0.5) * 70)) * 60000;
          if (at > now - 80 * 60000) return;
          const amount = Math.round((base + (rnd() - 0.5) * 50 + Math.max(-45, (16 - day) * 1.5)) / 5) * 5;
          d.feeds.push({
            id: uuid(), baby_id: b.id, kind: kinds[i % kinds.length], amount_ml: amount,
            started_at: iso(at), caregiver_id: (h < 7 || rnd() > 0.55 ? jul : max).id,
            created_at: iso(at), updated_at: iso(at), deleted_at: null,
          });
        });
      }
      // Couches : 6 à 8 par jour sur 16 jours.
      for (let day = 16; day >= 0; day--) {
        const midnight = new Date(now - day * DAY); midnight.setHours(0, 0, 0, 0);
        for (let i = 0; i < 7; i++) {
          const at = midnight.getTime() + (i * 200 + 40 + Math.round(rnd() * 90)) * 60000;
          if (at > now - 30 * 60000) continue;
          const dirty = rnd() < 0.4;
          d.diapers.push({ id: uuid(), baby_id: b.id, wet: dirty ? rnd() < 0.6 : true, dirty, rash: rnd() < 0.08, changed_at: iso(at),
            caregiver_id: (rnd() > 0.5 ? jul : max).id, created_at: iso(at), updated_at: iso(at), deleted_at: null });
        }
      }
      // Tétées (2 par jour, la nuit et l'après-midi) et séances de tire-lait (1 par jour).
      for (let day = 16; day >= 0; day--) {
        const midnight = new Date(now - day * DAY); midnight.setHours(0, 0, 0, 0);
        [[3.5, "left"], [14, "right"]].forEach(([h, side], i) => {
          const at = midnight.getTime() + h * 3600000 + Math.round(rnd() * 40) * 60000;
          if (at > now - 30 * 60000) return;
          d.nursings.push({ id: uuid(), baby_id: b.id, started_at: iso(at), left_sec: (8 + Math.round(rnd() * 8)) * 60, right_sec: (5 + Math.round(rnd() * 8)) * 60,
            last_side: side, caregiver_id: jul.id, created_at: iso(at), updated_at: iso(at), deleted_at: null });
        });
        const at = midnight.getTime() + 10 * 3600000 + Math.round(rnd() * 60) * 60000;
        if (at < now - 30 * 60000) {
          const l = 40 + Math.round(rnd() * 40), r = 35 + Math.round(rnd() * 40);
          d.pumpings.push({ id: uuid(), baby_id: b.id, started_at: iso(at), duration_sec: (12 + Math.round(rnd() * 10)) * 60, amount_ml: l + r, left_ml: l, right_ml: r,
            note: null, photo: null, caregiver_id: jul.id, created_at: iso(at), updated_at: iso(at), deleted_at: null });
        }
      }
      // Croissance : naissance puis toutes les ~3 semaines (à peu près sur le 50e percentile).
      const birth = new Date(b.birth_date + "T12:00");
      [0, 7, 21, 42, 63, 91, 120].forEach((age, i) => {
        const on = new Date(birth.getTime() + age * DAY);
        if (on > new Date()) return;
        const kg = 3.3 + age * 0.03 - Math.pow(age, 1.5) * 0.0004 + (rnd() - 0.5) * 0.2;
        d.growth.push({ id: uuid(), baby_id: b.id, measured_on: on.toISOString().slice(0, 10), weight_g: Math.round(kg * 100) * 10,
          height_cm: i % 2 ? null : Math.round((49.5 + age * 0.11) * 10) / 10, head_cm: i % 3 ? null : Math.round((34.5 + age * 0.06) * 10) / 10,
          note: i === 0 ? "À la naissance, à l'hôpital" : null, photo: null, caregiver_id: max.id, created_at: iso(on), updated_at: iso(on), deleted_at: null });
      });
      [["Premier sourire", 38], ["Première nuit de 6 h", 70], ["Premier bain dans la grande baignoire", 95]].forEach(([title, age]) => {
        const on = new Date(birth.getTime() + age * DAY);
        if (on > new Date()) return;
        d.firsts.push({ id: uuid(), baby_id: b.id, happened_on: on.toISOString().slice(0, 10), title, note: age === 70 ? "De 22 h à 4 h, sans se réveiller !" : null,
          photo: null, caregiver_id: jul.id, created_at: iso(on), updated_at: iso(on), deleted_at: null });
      });
      // Allergènes : tolérés (3+), en cours, une réaction, une famille à variétés, et un œuf pas redonné depuis 9 jours.
      [["arachide", [20, 17, 12, 2], "beurre d'arachide délayé"], ["oeuf", [19, 15, 9], "œuf cuit dur écrasé"], ["ble", [18, 14, 10, 3], "céréales de blé"],
        ["soya", [6, 3], "tofu soyeux"], ["sesame", [4], "tahini dans une purée"], ["poisson:saumon", [16, 11, 5], "saumon écrasé"], ["poisson:truite", [1], "truite"],
        ["noix:cajou", [7, 2], "beurre de cajou"], ["lait", [14, 11, 8], "yogourt nature"]].forEach(([key, days, food]) => days.forEach((ago, i) => {
        const at = now - ago * DAY - 3 * 3600000, bad = key === "lait" && i === days.length - 1;
        d.allergen_exposures.push({ id: uuid(), baby_id: b.id, given_at: iso(at), allergens: [key], food, reaction: bad ? "mild" : "none", symptoms: bad ? ["urticaire"] : [],
          photo: null, caregiver_id: (i % 2 ? jul : max).id, created_at: iso(at), updated_at: iso(at), deleted_at: null });
      }));
      return b;
    }
    baby("Kenda", "KND42", [2.5, 6, 9.25, 12.5, 15.75, 19, 22.25], 110, ["formule", "formule", "maternel"]);
    baby("Milo", "MIL07", [1, 5, 8.5, 12, 15.5, 19, 22.5], 95, ["maternel"]);
    return d;
  }

  // ---------------- temps réel ----------------
  const listeners = [];
  function emit(table, eventType, row) {
    for (const l of listeners) if (l.table === table) setTimeout(() => l.cb({ eventType, new: { ...row }, old: { id: row.id }, table }), 0);
  }

  // ---------------- réseau simulé ----------------
  const offline = () => !!window.__fakeOffline || localStorage.getItem("kenda.fake.offline") === "1";
  const netError = { message: "TypeError: Failed to fetch", code: "" };
  const delay = () => new Promise((r) => setTimeout(r, window.__fakeLatency || 40));
  const session = () => JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  const myBabyIds = () => { const uid = session()?.user.id; return db.caregivers.filter((c) => c.user_id === uid).map((c) => c.baby_id); };
  /** Les règles RLS : on ne voit que ce qui touche à ses bébés. */
  function visible(table, row) {
    const mine = myBabyIds();
    return table === "babies" ? mine.includes(row.id) : mine.includes(row.baby_id);
  }

  class Query {
    constructor(table) { this.table = table; this.filters = []; this.orders = []; this.op = "select"; this.slice = null; }
    select(cols) { this.cols = cols && cols !== "*" ? cols.split(",").map((c) => c.trim()) : null; return this; }
    eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
    is(k, v) { this.filters.push((r) => (r[k] ?? null) === v); return this; }
    gte(k, v) { this.filters.push((r) => Date.parse(r[k]) >= Date.parse(v)); return this; }
    in(k, vs) { this.filters.push((r) => vs.includes(r[k])); return this; }
    order(k, { ascending = true } = {}) { this.orders.push([k, ascending]); return this; }
    range(a, b) { this.slice = [a, b + 1]; return this; }
    limit(n) { this.slice = [0, n]; return this; }
    update(o) { this.op = "update"; this.payload = o; return this; }
    upsert(o, opts) { this.op = "upsert"; this.payload = o; this.conflict = (opts?.onConflict || "id").split(","); return this; }
    delete() { this.op = "delete"; return this; }
    then(res, rej) { return delay().then(() => this.run()).then(res, rej); }
    match(row) { return visible(this.table, row) && this.filters.every((f) => f(row)); }
    run() {
      if (offline()) return { data: null, error: netError, status: 0 };
      const rows = db[this.table];
      if (this.op === "select") {
        let out = rows.filter((r) => this.match(r)).map((r) => ({ ...r, ...("photo" in r ? { has_photo: r.photo != null } : {}) }));
        if (this.cols) out = out.map((r) => Object.fromEntries(this.cols.map((c) => [c, r[c] ?? null])));
        for (const [k, asc] of [...this.orders].reverse()) out.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
        if (this.slice) out = out.slice(...this.slice);
        return { data: out, error: null };
      }
      if (this.op === "upsert") {
        const p = this.payload;
        if (!myBabyIds().includes(p.baby_id)) return { data: null, error: { message: "new row violates row-level security policy", code: "42501" } };
        if (this.table === "feeds" && !(p.amount_ml > 0 && p.amount_ml <= 1000)) return { data: null, error: { message: "check constraint", code: "23514" } };
        if (["diapers", "growth", "firsts", "nursings", "pumpings", "allergen_exposures"].includes(this.table) && !("baby_id" in p)) return { data: null, error: { message: "null value", code: "23502" } };
        let row = rows.find((r) => this.conflict.every((k) => r[k] === p[k]));
        if (row) {
          // Le déclencheur feeds_keep_latest : une version plus vieille est ignorée.
          if (Date.parse(p.updated_at) >= Date.parse(row.updated_at)) { Object.assign(row, p); emit(this.table, "UPDATE", row); }
        } else { row = { created_at: new Date().toISOString(), ...p }; rows.push(row); emit(this.table, "INSERT", row); }
        save(); return { data: null, error: null };
      }
      if (this.op === "update") {
        const hit = rows.filter((r) => this.match(r));
        hit.forEach((r) => { Object.assign(r, this.payload); emit(this.table, "UPDATE", r); });
        save(); return { data: null, error: null };
      }
      if (this.op === "delete") {
        const hit = rows.filter((r) => this.match(r));
        db[this.table] = rows.filter((r) => !hit.includes(r));
        hit.forEach((r) => emit(this.table, "DELETE", r));
        save(); return { data: null, error: null };
      }
    }
  }

  const authListeners = [];
  const auth = {
    async getSession() { return { data: { session: session() }, error: null }; },
    async signInWithPassword({ email, password }) {
      await delay(); if (offline()) return { data: {}, error: { message: "Failed to fetch" } };
      const u = db.users.find((x) => x.email === email);
      if (!u || u.password !== password) return { data: {}, error: { message: "Invalid login credentials" } };
      const s = { user: { id: u.id, email } }; localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      authListeners.forEach((cb) => cb("SIGNED_IN", s)); return { data: { session: s }, error: null };
    },
    async signUp({ email, password }) {
      await delay(); if (db.users.find((x) => x.email === email)) return { data: {}, error: { message: "User already registered" } };
      const u = { id: uuid(), email, password }; db.users.push(u); save();
      const s = { user: { id: u.id, email } }; localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      authListeners.forEach((cb) => cb("SIGNED_IN", s)); return { data: { session: s }, error: null };
    },
    async signOut() { localStorage.removeItem(SESSION_KEY); authListeners.forEach((cb) => cb("SIGNED_OUT", null)); return { error: null }; },
    async resetPasswordForEmail(email) {
      await delay(); console.info(`[faux Supabase] lien « envoyé » à ${email} → ouvre ${location.pathname}#type=recovery`);
      return { data: {}, error: null };
    },
    async updateUser({ password }) {
      await delay(); const s = session(); if (!s) return { data: {}, error: { message: "Auth session missing!" } };
      const u = db.users.find((x) => x.id === s.user.id);
      if (u.password === password) return { data: {}, error: { message: "New password should be different from the old password." } };
      u.password = password; save(); return { data: { user: s.user }, error: null };
    },
    onAuthStateChange(cb) { authListeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
  };

  const rpcs = {
    baby_totals({ p_before }) {
      const mine = myBabyIds(), out = {};
      for (const f of db.feeds) {
        if (f.deleted_at || !mine.includes(f.baby_id) || Date.parse(f.started_at) >= Date.parse(p_before)) continue;
        const t = (out[f.baby_id] ||= { baby_id: f.baby_id, total_ml: 0, feeds: 0, first_at: f.started_at });
        t.total_ml += Number(f.amount_ml); t.feeds++; if (f.started_at < t.first_at) t.first_at = f.started_at;
      }
      return Object.values(out);
    },
    create_baby({ p_baby_name, p_caregiver_name, p_color }) {
      const uid = session()?.user.id; if (!uid) throw new Error("not authenticated");
      const b = { id: uuid(), name: p_baby_name, join_code: Math.random().toString(36).slice(2, 7).toUpperCase(), unit: "ml", kinds: ["maternel", "formule"], remind_after_min: null, created_at: new Date().toISOString() };
      db.babies.push(b);
      db.caregivers.push({ id: uuid(), baby_id: b.id, user_id: uid, name: p_caregiver_name, color: p_color, created_at: new Date().toISOString() });
      save(); return b.id;
    },
    join_baby({ p_code, p_caregiver_name, p_color }) {
      const uid = session()?.user.id; const b = db.babies.find((x) => x.join_code === p_code.toUpperCase());
      if (!b) throw new Error("baby not found");
      if (!db.caregivers.find((c) => c.baby_id === b.id && c.user_id === uid)) {
        const COLORS = ["#6B5A85", "#3E6B7A", "#8A6D4B", "#5F7F5A", "#9A5F72", "#7A7468"];
        const n = db.caregivers.filter((c) => c.baby_id === b.id).length;
        db.caregivers.push({ id: uuid(), baby_id: b.id, user_id: uid, name: p_caregiver_name, color: p_color || COLORS[n % 6], created_at: new Date().toISOString() });
      }
      save(); return b.id;
    },
  };

  /** L'autre parent ajoute un boire depuis son appareil : arrive par le temps réel. */
  window.__fakeOther = (ml = 120, minutesAgo = 0) => {
    const uid = session()?.user.id;
    const other = db.caregivers.find((c) => c.user_id !== uid && myBabyIds().includes(c.baby_id));
    if (!other) return null;
    const at = new Date(Date.now() - minutesAgo * 60000).toISOString();
    const row = { id: uuid(), baby_id: other.baby_id, kind: "formule", amount_ml: ml, started_at: at, caregiver_id: other.id, created_at: at, updated_at: at, deleted_at: null };
    db.feeds.push(row); save(); emit("feeds", "INSERT", row); return row;
  };

  window.__KENDA_FAKE_SUPABASE__ = {
    auth,
    from: (t) => new Query(t),
    async rpc(name, args) {
      await delay(); if (offline()) return { data: null, error: netError };
      try { return { data: rpcs[name](args), error: null }; } catch (e) { return { data: null, error: { message: e.message } }; }
    },
    channel(name) {
      const ch = { name, state: "joined", subs: [], on(type, cfg, cb) { const l = { table: cfg.table, cb }; listeners.push(l); this.subs.push(l); return this; },
        subscribe(cb) { setTimeout(() => cb?.("SUBSCRIBED"), 0); return this; } };
      return ch;
    },
    removeChannel(ch) { for (const l of ch.subs) { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); } },
    __db: () => db,
  };
})();
