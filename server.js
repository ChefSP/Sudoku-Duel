const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ================= KONFIGURACJA =================
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const DATABASE_URL = process.env.DATABASE_URL || '';           // Postgres (Neon / Supabase) - trwała baza
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';    // logowanie Google (opcjonalne)
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || ''; // captcha Cloudflare (opcjonalna)
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';        // hasło do panelu /admin.html (bez niego panel jest wyłączony)

const DIFFS = {
  easy:     { label: 'Łatwy',    remove: 38, lock: 2000 },
  medium:   { label: 'Średni',   remove: 48, lock: 4000 },
  hard:     { label: 'Trudny',   remove: 55, lock: 10000 },
  hardcore: { label: 'Hardcore', remove: 55, lock: 0, blind: true }   // bez blokady i bez sprawdzania cyfr
};
// tryby gry (na razie wszystkie poza klasycznym są bez rankingu)
const MODES = ['classic', 'blitz', 'line', 'sprint'];
const BLITZ_ROUNDS = 3;           // Blitz: 3 plansze pod rząd, wygrywa ten, kto weźmie więcej (2 wygrane kończą serię)
const LINE_TARGET = 3;            // Linie: wygrywa pierwszy, kto skompletuje tyle rzędów / kolumn / bloków 3x3
const LINE_MIN_EMPTY = 4;         // do Linii liczą się tylko rzędy/kolumny/bloki z co najmniej tyloma pustymi polami
const SPRINT_TARGET = 20;         // Sprint: wygrywa pierwszy, kto wstawi tyle poprawnych cyfr
const ROOM_TTL_MS = 10 * 60e3;    // jak długo ważny jest link do znajomego
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REMATCH_MS = 120e3;         // jak długo po meczu można poprosić o rewanż
const HISTORY_MAX = 100;          // ile ostatnich meczów pamiętamy na konto
const ELO_LOG_MAX = 200;          // ile punktów wykresu Elo na poziom
// rangi wg Elo na danym poziomie (min = najniższe Elo tej rangi)
const RANKS = [
  { min: 0,    name: 'Brąz',    icon: '🥉' },
  { min: 1100, name: 'Srebro',  icon: '🥈' },
  { min: 1250, name: 'Złoto',   icon: '🥇' },
  { min: 1400, name: 'Diament', icon: '💎' }
];
const rankIndex = elo => { let k = 0; RANKS.forEach((r, i) => { if (elo >= r.min) k = i; }); return k; };
// sezony: co miesiąc (czas polski) ranking się "resetuje". SEASON_KEEP: 1 = bez zmian, 0 = pełny reset do 1000, 0.5 = Elo wraca w połowie do 1000.
const SEASON_KEEP = process.env.SEASON_KEEP !== undefined ? Math.min(Math.max(+process.env.SEASON_KEEP, 0), 1) : 0.5;
const SEASON_MIN_GAMES = 5;       // tyle meczów rankingowych w sezonie trzeba rozegrać, by liczyć się do odznak TOP 3
const COUNTDOWN_MS = 3000;
const GRACE_MS = process.env.GRACE_MS ? +process.env.GRACE_MS : 30000;   // tyle czekamy na powrót rozłączonego gracza
const K = 32;                     // współczynnik Elo

// anty-boty
const MIN_MOVE_MS = 120;          // minimalny odstęp między ruchami jednego gracza
const MIN_MS_PER_CELL = process.env.MIN_MS_PER_CELL !== undefined ? +process.env.MIN_MS_PER_CELL : 400;  // szybciej (średnio na pole) = nierealne, mecz unieważniony
const FLAGS_HIDE = 3;             // tyle unieważnień = konto znika z rankingu
const MAX_CONN_PER_IP = 6;
const MAX_MSG_PER_SEC = 40;

// ================= MAŁE NARZĘDZIA =================
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const NAME_RE = /^[\p{L}\p{N}_-]{3,16}$/u;

const RESERVED_RE = /^guest\d*$/i;     // nicki Guest123 są tylko dla gości
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(pw, rec) {
  const salt = rec ? rec.salt : '00'.repeat(16);   // stały czas także dla nieistniejącego konta
  const h = crypto.scryptSync(pw, salt, 64);
  if (!rec) return false;
  const a = Buffer.from(rec.hash, 'hex');
  return a.length === h.length && crypto.timingSafeEqual(a, h);
}

// limity zapytań (w pamięci)
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 3600e3) hits.delete(k);
}, 600e3).unref();

function ipOf(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'x';
}

// ================= GENERATOR SUDOKU =================
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function candMask(g, i) {
  const r = (i / 9) | 0, c = i % 9;
  let used = 0;
  for (let k = 0; k < 9; k++) { used |= 1 << g[r * 9 + k]; used |= 1 << g[k * 9 + c]; }
  const br = r - (r % 3), bc = c - (c % 3);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) used |= 1 << g[(br + a) * 9 + bc + b];
  return ~used & 0x3FE;   // bity 1..9
}
function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }
function fillGrid(g) {
  let best = -1, bm = 0, bn = 10;
  for (let i = 0; i < 81; i++) if (g[i] === 0) {
    const m = candMask(g, i), n = popcount(m);
    if (n === 0) return false;
    if (n < bn) { best = i; bm = m; bn = n; if (n === 1) break; }
  }
  if (best < 0) return true;
  for (const v of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
    if (bm & (1 << v)) {
      g[best] = v;
      if (fillGrid(g)) return true;
      g[best] = 0;
    }
  }
  return false;
}
function countSolutions(g, limit) {   // liczy rozwiązania (z heurystyką najmniej kandydatów)
  let best = -1, bm = 0, bn = 10;
  for (let i = 0; i < 81; i++) if (g[i] === 0) {
    const m = candMask(g, i), n = popcount(m);
    if (n === 0) return 0;
    if (n < bn) { best = i; bm = m; bn = n; if (n === 1) break; }
  }
  if (best < 0) return 1;
  let cnt = 0;
  for (let v = 1; v <= 9; v++) if (bm & (1 << v)) {
    g[best] = v;
    cnt += countSolutions(g, limit - cnt);
    g[best] = 0;
    if (cnt >= limit) break;
  }
  return cnt;
}
function generatePuzzle(diff) {
  const target = DIFFS[diff].remove;
  const solution = new Array(81).fill(0);
  fillGrid(solution);
  const puzzle = solution.slice();
  let removed = 0;
  for (const idx of shuffle([...Array(81).keys()])) {
    if (removed >= target) break;
    const keep = puzzle[idx];
    puzzle[idx] = 0;
    if (countSolutions(puzzle.slice(), 2) === 1) removed++;
    else puzzle[idx] = keep;
  }
  return { puzzle, solution };
}

// ================= ELO =================
function newElo(a, b, scoreA) {
  const ea = 1 / (1 + Math.pow(10, (b - a) / 400));
  return Math.round(a + K * (scoreA - ea));
}

// ================= BAZA DANYCH =================
// Wszyscy użytkownicy leżą w pamięci (Map), a każda zmiana jest zapisywana do pliku JSON albo do Postgresa.
const users = new Map();          // id -> user
const sessionIndex = new Map();   // sha256(token) -> userId
const nameIndex = new Map();      // nick małymi literami -> userId (konta i goście: nazwy są unikalne)

const newStats = () => ({ elo: 1000, wins: 0, losses: 0, solved: 0, sumMs: 0, bestMs: 0, streak: 0, bestStreak: 0, sgames: 0 });
function newUser(name) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(), name, pass: null, google: null, sessions: [],
    stats: Object.fromEntries(Object.keys(DIFFS).map(d => [d, newStats()])),
    history: [], eloLog: {}, badges: [], daily: { date: '', runs: {}, done: {} },
    flags: 0, createdAt: now, lastSeen: now
  };
}
const isGuest = u => !u.pass && !u.google;
function indexUser(u) {
  for (const s of u.sessions) sessionIndex.set(s, u.id);
  nameIndex.set(u.name.toLowerCase(), u.id);
}

const reports = new Map();        // id -> zgłoszenie
const banById = new Map(), banUser = new Map(), banIp = new Map();
const saveU = u => store.save('users', u);
const removeU = u => store.remove('users', u);
function indexBan(b) { banById.set(b.id, b); (b.type === 'ip' ? banIp : banUser).set(b.value, b); }
function unindexBan(b) { banById.delete(b.id); (b.type === 'ip' ? banIp : banUser).delete(b.value); }
const liveBan = b => (b && (!b.until || b.until > Date.now())) ? b : null;
const userBanned = id => liveBan(banUser.get(id));
const ipBanned = ip => liveBan(banIp.get(ip));

function makeJsonStore() {
  let timer = null;
  const write = () => {
    const data = JSON.stringify({ version: 3, users: [...users.values()], reports: [...reports.values()], bans: [...banById.values()], meta });
    fs.writeFile(DATA_FILE + '.tmp', data, err => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(write, 500); };
  return {
    kind: 'plik JSON',
    async load() {
      let raw;
      try { raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { users: [], reports: [], bans: [], meta: [] }; }
      if (raw && raw.version >= 2) return { users: raw.users || [], reports: raw.reports || [], bans: raw.bans || [], meta: raw.meta ? [raw.meta] : [] };
      // stary format: { token: {name, elo, wins, losses} }
      const list = Object.entries(raw || {}).map(([token, o]) => {
        const u = newUser('Guest');
        u.stats.medium = Object.assign(newStats(), { elo: o.elo || 1000, wins: o.wins || 0, losses: o.losses || 0 });
        u.sessions = [sha(token)];
        return u;
      });
      return { users: list, reports: [], bans: [], meta: [] };
    },
    save() { schedule(); },
    remove() { schedule(); }
  };
}
function makePgStore(url) {
  const { Pool } = require('pg');
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  const ssl = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: u.toString(), ssl, max: 5 });
  pool.on('error', e => console.error('pg pool:', e.message));
  const TABLE = { users: 'users', reports: 'reports', bans: 'bans', meta: 'meta' };    // stała lista (nic od użytkownika nie trafia do SQL)
  return {
    kind: 'Postgres',
    async load() {
      const out = {};
      for (const k of Object.keys(TABLE)) {
        await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE[k]} (id text PRIMARY KEY, data jsonb NOT NULL)`);
        out[k] = (await pool.query(`SELECT data FROM ${TABLE[k]}`)).rows.map(x => x.data);
      }
      return out;
    },
    save(kind, obj) {
      pool.query(
        `INSERT INTO ${TABLE[kind]} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [obj.id, JSON.stringify(obj)]
      ).catch(e => console.error('pg save:', e.message));
    },
    remove(kind, obj) {
      pool.query(`DELETE FROM ${TABLE[kind]} WHERE id = $1`, [obj.id]).catch(e => console.error('pg delete:', e.message));
    }
  };
}
const store = DATABASE_URL ? makePgStore(DATABASE_URL) : makeJsonStore();

// ---------- sesje ----------
function newSession(user) {
  const t = crypto.randomBytes(24).toString('hex');
  const h = sha(t);
  user.sessions.push(h);
  sessionIndex.set(h, user.id);
  while (user.sessions.length > 10) sessionIndex.delete(user.sessions.shift());
  return t;
}
function userByToken(t) {
  if (typeof t !== 'string' || t.length > 100) return null;
  const id = sessionIndex.get(sha(t));
  return id ? users.get(id) || null : null;
}
function dropSession(t) {
  const h = sha(t);
  const id = sessionIndex.get(h);
  sessionIndex.delete(h);
  const u = id && users.get(id);
  if (u) { u.sessions = u.sessions.filter(s => s !== h); saveU(u); }
}
function nameFree(name, exceptId) {
  const id = nameIndex.get(name.toLowerCase());
  return !id || id === exceptId;
}
function uniqueName(base) {
  base = (base || 'Gracz').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 12) || 'Gracz';
  if (base.length < 3) base += '123';
  let n = base;
  while (!nameFree(n)) n = base + Math.floor(Math.random() * 9000 + 1000);
  return n;
}
function makeRegistered(user, name) {   // zmienia nazwę gościa na wybraną (stary indeks zwalniamy)
  if (nameIndex.get(user.name.toLowerCase()) === user.id) nameIndex.delete(user.name.toLowerCase());
  user.name = name;
}
function guestName() {
  for (let d = 4; ; d++)
    for (let k = 0; k < 50; k++) {
      const n = 'Guest' + String(Math.floor(Math.random() * 10 ** d)).padStart(d, '0');
      if (!nameIndex.has(n.toLowerCase())) return n;
    }
}
function ensureUser(u) {                // uzupełnia dane starszych kont po aktualizacji
  for (const d of Object.keys(DIFFS)) u.stats[d] = Object.assign(newStats(), u.stats[d] || {});
  if (!Array.isArray(u.history)) u.history = [];
  if (!u.eloLog || typeof u.eloLog !== 'object') u.eloLog = {};
  if (!Array.isArray(u.badges)) u.badges = [];
  if (!u.daily || typeof u.daily !== 'object') u.daily = { date: '', runs: {}, done: {} };
}
function pub(u) {
  return { name: u.name, guest: isGuest(u), google: !!u.google, stats: u.stats };
}

// ================= HTTP =================
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, f) => { if (f.endsWith('sw.js') || f.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache'); }   // service worker i manifest zawsze świeże
}));
app.use('/api', (req, res, next) => {              // zablokowany adres IP nie korzysta z API (poza panelem admina)
  if (!req.path.startsWith('/admin') && ipBanned(ipOf(req))) return res.status(403).json({ error: 'Ten adres IP został zablokowany.' });
  next();
});

app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, turnstileSiteKey: TURNSTILE_SITE_KEY || null, ranks: RANKS,
             diffs: Object.fromEntries(Object.entries(DIFFS).map(([k, v]) => [k, { label: v.label, lock: v.lock, blind: !!v.blind }])) });
});

app.get('/api/solo', (req, res) => {          // plansza do gry jednoosobowej (liczy się w przeglądarce)
  const diff = req.query.diff;
  if (!DIFFS[diff]) return res.status(400).json({ error: 'Zły poziom.' });
  if (limited('solo:' + ipOf(req), 30, 60e3)) return res.status(429).json({ error: 'Za dużo zapytań.' });
  const { puzzle, solution } = generatePuzzle(diff);
  res.json({ diff, puzzle, solution });
});

app.get('/api/leaderboard', (req, res) => {
  const diff = DIFFS[req.query.diff] ? req.query.diff : 'medium';
  const top = [...users.values()]
    .filter(u => !isGuest(u) && u.stats[diff].sgames > 0 && u.flags < FLAGS_HIDE && !userBanned(u.id))   // tabela bieżącego sezonu
    .sort((a, b) => b.stats[diff].elo - a.stats[diff].elo)
    .slice(0, 20)
    .map(u => ({ name: u.name, elo: u.stats[diff].elo, wins: u.stats[diff].wins, losses: u.stats[diff].losses,
                 badges: [1, 2, 3].map(pl => u.badges.filter(b => b.place === pl).length) }));
  res.json(top);
});

app.get('/api/season', (req, res) => {
  const prev = meta.history.length ? meta.history[meta.history.length - 1] : null;
  res.json({ id: meta.season, endsAt: seasonEnd(meta.season), keep: SEASON_KEEP, minGames: SEASON_MIN_GAMES, prev });
});

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true;
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5000)
    });
    return !!(await r.json()).success;
  } catch { return false; }
}

app.post('/api/register', async (req, res) => {
  const ip = ipOf(req);
  if (limited('reg:' + ip, 5, 3600e3)) return res.status(429).json({ error: 'Za dużo prób, spróbuj później.' });
  const { name, password, captcha, token } = req.body || {};
  if (typeof name !== 'string' || !NAME_RE.test(name))
    return res.status(400).json({ error: 'Nick: 3-16 znaków (litery, cyfry, _ lub -).' });
  if (RESERVED_RE.test(name)) return res.status(400).json({ error: 'Nicki w stylu Guest123 są zarezerwowane dla gości.' });
  if (typeof password !== 'string' || password.length < 6 || password.length > 100)
    return res.status(400).json({ error: 'Hasło musi mieć co najmniej 6 znaków.' });
  if (!(await verifyTurnstile(captcha, ip)))
    return res.status(400).json({ error: 'Nie przeszła weryfikacja captcha.' });

  const guest = userByToken(token);
  const me = guest && isGuest(guest) ? guest : null;      // gość zakłada konto = zachowuje ranking
  if (!nameFree(name, me && me.id)) return res.status(409).json({ error: 'Ten nick jest zajęty.' });

  const user = me || newUser(name);
  makeRegistered(user, name);
  user.pass = hashPassword(password);
  if (!users.has(user.id)) users.set(user.id, user);
  nameIndex.set(name.toLowerCase(), user.id);
  const t = newSession(user);
  saveU(user);
  res.json({ token: t });
});

app.post('/api/login', (req, res) => {
  const ip = ipOf(req);
  const { name, password } = req.body || {};
  if (typeof name !== 'string' || typeof password !== 'string' || password.length > 100)
    return res.status(400).json({ error: 'Błędne dane.' });
  if (limited('login:' + ip, 20, 600e3) || limited('loginname:' + name.toLowerCase(), 8, 600e3))
    return res.status(429).json({ error: 'Za dużo prób, spróbuj za kilka minut.' });
  const id = nameIndex.get(name.toLowerCase());
  const user = id && users.get(id);
  if (!checkPassword(password, user && user.pass)) return res.status(401).json({ error: 'Zły nick lub hasło.' });
  const ub = userBanned(user.id);
  if (ub) return res.status(403).json({ error: 'Konto zablokowane' + (ub.reason ? ': ' + ub.reason : '.') });
  res.json({ token: newSession(user) });
  saveU(user);
});

app.post('/api/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(404).json({ error: 'Logowanie Google nie jest włączone.' });
  const ip = ipOf(req);
  if (limited('google:' + ip, 20, 600e3)) return res.status(429).json({ error: 'Za dużo prób.' });
  const { credential, token } = req.body || {};
  if (typeof credential !== 'string' || credential.length > 4096) return res.status(400).json({ error: 'Błędne dane.' });
  let info;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential),
                          { signal: AbortSignal.timeout(5000) });
    info = await r.json();
    if (!r.ok) throw new Error('bad token');
  } catch { return res.status(401).json({ error: 'Nie udało się zweryfikować konta Google.' }); }
  const okIss = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (info.aud !== GOOGLE_CLIENT_ID || !okIss || !info.sub || Number(info.exp) * 1000 < Date.now())
    return res.status(401).json({ error: 'Nieprawidłowy token Google.' });

  let user = [...users.values()].find(u => u.google === info.sub);
  if (!user) {
    const guest = userByToken(token);
    user = guest && isGuest(guest) ? guest : newUser('x');
    const name = uniqueName(info.given_name || (info.email || '').split('@')[0]);
    makeRegistered(user, name);
    user.google = info.sub;
    users.set(user.id, user);
    nameIndex.set(name.toLowerCase(), user.id);
  }
  const ub = userBanned(user.id);
  if (ub) return res.status(403).json({ error: 'Konto zablokowane' + (ub.reason ? ': ' + ub.reason : '.') });
  const t = newSession(user);
  saveU(user);
  res.json({ token: t });
});

app.post('/api/logout', (req, res) => {
  const { token } = req.body || {};
  if (typeof token === 'string') dropSession(token);
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 4096 });

// ================= GRA =================
const players = new Map();                        // userId -> p
const queues = { ranked: {}, casual: {}, blitz: {}, line: {}, sprint: {} };        // rankingowa (tylko konta) i towarzyska (każdy, bez Elo)
for (const k of Object.keys(queues)) for (const d of Object.keys(DIFFS)) queues[k][d] = [];
const rooms = new Map();                          // kod -> { hostId, diff, at }  (pojedynek ze znajomym)
const pendingResults = new Map();                 // userId -> wiadomość (gdy gracz był offline w chwili końca meczu)
const ipConns = new Map();

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function sendP(p, obj) { send(p.ws, obj); }
function notice(p, text) { sendP(p, { type: 'notice', text }); }
function dequeue(p) { for (const k in queues) for (const d in queues[k]) queues[k][d] = queues[k][d].filter(q => q.p !== p); }
function closeRoom(p) { for (const [c, r] of rooms) if (r.hostId === p.user.id) rooms.delete(c); }
function clearLast(p) {                           // rezygnacja z rewanżu
  const L = p.last; p.last = null; p.rematchWant = false;
  if (!L) return;
  const o = players.get(L.oppId);
  if (o && o.last && o.last.oppId === p.user.id) { o.rematchWant = false; sendP(o, { type: 'rematchGone' }); }
}
function leaveAll(p) { dequeue(p); closeRoom(p); clearLast(p); }
function onlineCount() { let n = 0; for (const p of players.values()) if (p.ws) n++; return n; }
function broadcastOnline() {
  const n = onlineCount();
  for (const c of wss.clients) send(c, { type: 'online', n });
}

wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  const ib = ipBanned(ip);
  if (ib) { send(ws, { type: 'banned', reason: ib.reason || '' }); ws.close(4003, 'banned'); return; }
  if ((ipConns.get(ip) || 0) >= MAX_CONN_PER_IP) { ws.close(1008, 'limit'); return; }
  ipConns.set(ip, (ipConns.get(ip) || 0) + 1);

  let msgCount = 0, msgTick = Date.now();
  ws.p = null; ws.ip = ip;

  ws.on('message', raw => {
    const now = Date.now();
    if (now - msgTick > 1000) { msgTick = now; msgCount = 0; }
    if (++msgCount > MAX_MSG_PER_SEC) { ws.close(1008, 'spam'); return; }
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.type === 'hello') return handleHello(ws, m);
    const p = ws.p;
    if (!p) return;

    if (m.type === 'queue') {
      if (p.game || !DIFFS[m.diff]) return;
      const mode = MODES.includes(m.mode) ? m.mode : 'classic';
      if (mode !== 'classic' && DIFFS[m.diff].blind) return notice(p, 'Hardcore jest tylko w grze klasycznej.');
      const ranked = mode === 'classic' && !!m.ranked;
      if (ranked && isGuest(p.user)) {
        notice(p, 'Gra rankingowa wymaga konta. Zaloguj się albo zagraj w kolejce towarzyskiej.');
        return sendP(p, { type: 'idle' });
      }
      leaveAll(p);
      queues[ranked ? 'ranked' : mode === 'classic' ? 'casual' : mode][m.diff].push({ p, since: Date.now() });
      sendP(p, { type: 'queued', diff: m.diff, ranked, mode });
    }
    else if (m.type === 'cancel') { leaveAll(p); sendP(p, { type: 'idle' }); }
    else if (m.type === 'report') handleReport(p, m);
    else if (m.type === 'emote') handleEmote(p, m);
    else if (m.type === 'leave') leaveAll(p);                       // wyjście z ekranu wyniku
    else if (m.type === 'move' && p.game) handleMove(p, m);
    else if (m.type === 'resign' && p.game) endGame(p.game, 1 - p.idx, 'resign');
    else if (m.type === 'room') {                                    // zaproszenie znajomego
      if (p.game || !DIFFS[m.diff]) return;
      const mode = MODES.includes(m.mode) ? m.mode : 'classic';
      if (mode !== 'classic' && DIFFS[m.diff].blind) return notice(p, 'Hardcore jest tylko w grze klasycznej.');
      leaveAll(p);
      let code;
      do { code = Array.from(crypto.randomBytes(6), b => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join(''); } while (rooms.has(code));
      rooms.set(code, { hostId: p.user.id, diff: m.diff, mode, at: Date.now() });
      sendP(p, { type: 'room', code, diff: m.diff, mode, ttl: ROOM_TTL_MS });
    }
    else if (m.type === 'join') {
      if (p.game) return;
      if (limited('join:' + ip, 20, 60e3)) return notice(p, 'Za dużo prób, poczekaj chwilę.');
      const code = String(m.code || '').toUpperCase().slice(0, 12);
      const r = rooms.get(code);
      const host = r && players.get(r.hostId);
      if (host === p) return notice(p, 'To Twoje własne zaproszenie. Wyślij link znajomemu.');
      if (!r || !host || !host.ws || host.game) { rooms.delete(code); return notice(p, 'Zaproszenie wygasło lub nie istnieje.'); }
      rooms.delete(code);
      startGame(host, p, r.diff, { ranked: false, friend: true, mode: r.mode });
    }
    else if (m.type === 'rematch') {
      const L = p.last, o = L && players.get(L.oppId);
      if (!L || p.game || Date.now() - L.at > REMATCH_MS || !o || !o.ws || o.game || !o.last || o.last.oppId !== p.user.id)
        return notice(p, 'Rewanż jest niedostępny.');
      p.rematchWant = true;
      if (o.rematchWant) {
        p.last = o.last = null; p.rematchWant = o.rematchWant = false;
        startGame(o, p, L.diff, { ranked: L.ranked, friend: L.friend, mode: L.mode });
      } else {
        sendP(p, { type: 'rematchWait' });
        sendP(o, { type: 'rematchOffer' });
      }
    }
  });

  ws.on('close', () => {
    ipConns.set(ip, Math.max(0, (ipConns.get(ip) || 1) - 1));
    const p = ws.p;
    if (!p || p.ws !== ws) return;          // to połączenie zostało już zastąpione nowym
    p.ws = null;
    leaveAll(p);
    const g = p.game;
    if (g && !g.over) {
      sendP(g.players[1 - p.idx], { type: 'oppstatus', online: false, graceMs: GRACE_MS });
      clearTimeout(p.graceTimer);
      p.graceTimer = setTimeout(() => { if (p.game === g && !g.over) endGame(g, 1 - p.idx, 'disconnect'); }, GRACE_MS);
    } else {
      players.delete(p.user.id);
    }
    broadcastOnline();
  });
});

function handleHello(ws, m) {
  let user = userByToken(m.token), token = m.token;
  if (!user) {
    user = newUser(guestName());
    users.set(user.id, user);
    nameIndex.set(user.name.toLowerCase(), user.id);
    token = newSession(user);
    saveU(user);
  } else if (Date.now() - user.lastSeen > 3600e3) {
    user.lastSeen = Date.now();
    saveU(user);
  }
  user.lastSeen = Date.now();
  const ub = userBanned(user.id);
  if (ub) { send(ws, { type: 'banned', reason: ub.reason || '' }); ws.close(4003, 'banned'); return; }

  let p = players.get(user.id);
  if (p && p.ws && p.ws !== ws) {           // to samo konto w drugiej karcie: nowa przejmuje
    send(p.ws, { type: 'replaced' });
    const old = p.ws; p.ws = null;
    try { old.close(4000, 'replaced'); } catch {}
  }
  if (!p) { p = { user, ws: null, game: null, idx: -1, graceTimer: null, last: null, rematchWant: false }; players.set(user.id, p); }
  p.user = user; p.ws = ws; ws.p = p; p.ip = ws.ip;
  clearTimeout(p.graceTimer);

  send(ws, { type: 'hello', token, user: pub(user) });
  broadcastOnline();

  const pend = pendingResults.get(user.id);
  if (pend) { pendingResults.delete(user.id); send(ws, pend); }
  else if (p.game && !p.game.over) {
    send(ws, matchPayload(p.game, p.idx));
    sendP(p.game.players[1 - p.idx], { type: 'oppstatus', online: true });
  }
}

// ---------- matchmaking: co sekundę ----------
// rankingowa: okno różnicy Elo rośnie z czasem czekania; towarzyska: kto pierwszy, ten pierwszy
setInterval(() => {
  for (const diff of Object.keys(DIFFS)) {
    for (const k of ['casual', 'blitz', 'line', 'sprint']) {
      const qc = queues[k][diff];
      while (qc.length >= 2) { const a = qc.shift(), b = qc.shift(); startGame(a.p, b.p, diff, { ranked: false, mode: k === 'casual' ? 'classic' : k }); }
    }

    const q = queues.ranked[diff];
    if (q.length < 2) continue;
    q.sort((a, b) => a.p.user.stats[diff].elo - b.p.user.stats[diff].elo);
    for (let i = 0; i < q.length - 1; i++) {
      const a = q[i], b = q[i + 1];
      const waited = (Date.now() - Math.min(a.since, b.since)) / 1000;
      const win = 100 + waited * 50;
      if (Math.abs(a.p.user.stats[diff].elo - b.p.user.stats[diff].elo) <= win) {
        q.splice(i, 2);
        startGame(a.p, b.p, diff, { ranked: true });
        i--;
      }
    }
  }
  const now = Date.now();                    // wygasanie zaproszeń
  for (const [code, r] of rooms) if (now - r.at > ROOM_TTL_MS) {
    rooms.delete(code);
    const h = players.get(r.hostId);
    if (h && h.ws && !h.game) { notice(h, 'Zaproszenie wygasło.'); sendP(h, { type: 'idle' }); }
  }
}, 1000).unref();

function startGame(p0, p1, diff, opts = {}) {
  leaveAll(p0); leaveAll(p1);
  const cfg = DIFFS[diff];
  const mode = MODES.includes(opts.mode) ? opts.mode : 'classic';
  const game = {
    diff, mode, ranked: mode === 'classic' && !!opts.ranked, friend: !!opts.friend, blind: !!cfg.blind, lockMs: cfg.lock,
    players: [p0, p1], round: 1, score: [0, 0], over: false, t0: Date.now() + COUNTDOWN_MS
  };
  setupBoard(game);
  [p0, p1].forEach((p, i) => { p.game = game; p.idx = i; p.emoteCount = 0; });
  [p0, p1].forEach((p, i) => sendP(p, matchPayload(game, i)));
}

const UNITS = [];                                          // 27 jednostek: 9 rzędów, 9 kolumn, 9 bloków 3x3
for (let k = 0; k < 9; k++) {
  UNITS.push(Array.from({ length: 9 }, (_, j) => k * 9 + j));
  UNITS.push(Array.from({ length: 9 }, (_, j) => j * 9 + k));
  const br = (k / 3 | 0) * 3, bc = (k % 3) * 3;
  UNITS.push(Array.from({ length: 9 }, (_, j) => (br + (j / 3 | 0)) * 9 + bc + (j % 3)));
}
function setupBoard(g) {                                   // nowa plansza (start meczu albo kolejna runda Blitza)
  const { puzzle, solution } = generatePuzzle(g.diff);
  g.puzzle = puzzle; g.solution = solution;
  g.empties = puzzle.filter(v => v === 0).length;
  g.cur = [puzzle.slice(), puzzle.slice()];
  g.filled = [0, 0]; g.prog = [0, 0]; g.lockedUntil = [0, 0]; g.lastMove = [0, 0];
  g.startAt = g.round === 1 ? g.t0 : Date.now() + COUNTDOWN_MS;
  const open = UNITS.filter(u => u.some(k => !puzzle[k]));
  const big = open.filter(u => u.filter(k => !puzzle[k]).length >= LINE_MIN_EMPTY);
  g.units = big.length >= LINE_TARGET * 2 ? big : open;     // liczą się linie, w których jest co robić (min. LINE_MIN_EMPTY pustych pól)
  g.goal = g.mode === 'sprint' ? Math.min(SPRINT_TARGET, g.empties) : g.mode === 'line' ? Math.min(LINE_TARGET, g.units.length) : g.empties;
}
function progressOf(g, i) {
  if (g.mode === 'line') { const c = g.cur[i]; return g.units.filter(u => u.every(k => c[k])).length; }
  return g.filled[i];
}

function oppMask(g, i) {                                 // które pola ma wypełnione gracz i (bez cyfr, bez podpowiedzi)
  return g.cur[i].map((v, k) => (v && !g.puzzle[k]) ? 1 : 0);
}

function matchPayload(g, i) {
  const now = Date.now(), o = g.players[1 - i];
  return {
    type: 'match', diff: g.diff, mode: g.mode, ranked: g.ranked, friend: g.friend, blind: g.blind,
    round: g.round, rounds: g.mode === 'blitz' ? BLITZ_ROUNDS : 1, score: [g.score[i], g.score[1 - i]],
    goal: g.goal, prog: g.prog[i], oppProg: g.prog[1 - i],
    puzzle: g.puzzle, cur: g.cur[i], empties: g.empties,
    elapsed: now - g.startAt,                          // ujemne = trwa odliczanie
    filled: g.filled[i], oppFilled: g.filled[1 - i], oppMask: oppMask(g, 1 - i),
    lockMs: Math.max(0, g.lockedUntil[i] - now),
    opp: { name: o.user.name, elo: g.ranked ? o.user.stats[g.diff].elo : null },
    oppOnline: !!o.ws
  };
}

function boardWon(g, i) {
  if (g.mode !== 'blitz') return endGame(g, i, 'solved');
  g.score[i]++;
  if (g.score[i] > BLITZ_ROUNDS / 2) return endGame(g, i, 'solved');
  g.round++; setupBoard(g);                                  // następna plansza serii
  g.players.forEach((q, k) => sendP(q, { ...matchPayload(g, k), roundWinner: i === k ? 'me' : 'opp' }));
}

function handleMove(p, m) {
  const g = p.game, i = p.idx, now = Date.now();
  if (g.over || now < g.startAt) return;
  const r = m.r | 0, c = m.c | 0, v = m.v | 0;
  if (r < 0 || r > 8 || c < 0 || c > 8 || v < (g.blind ? 0 : 1) || v > 9) return;   // 0 = gumka (tylko Hardcore)
  if (now - g.lastMove[i] < MIN_MOVE_MS) return;     // anty-bot: nierealnie szybkie ruchy
  if (now < g.lockedUntil[i]) return;
  const idx = r * 9 + c;
  if (g.puzzle[idx]) return;                         // pole z podpowiedzią
  const mine = g.cur[i];

  if (g.blind) {                                     // Hardcore: przyjmujemy wszystko, nic nie sprawdzamy
    if (mine[idx] === v) return;
    g.lastMove[i] = now;
    g.filled[i] += (v ? 1 : 0) - (mine[idx] ? 1 : 0);
    mine[idx] = v;
    sendP(p, { type: 'ok', r, c, v, filled: g.filled[i] });
    sendP(g.players[1 - i], { type: 'opp', filled: g.filled[i], cell: idx, on: v ? 1 : 0 });
    if (g.filled[i] >= g.empties) {
      if (mine.every((x, k) => x === g.solution[k])) endGame(g, i, 'solved');
      else sendP(p, { type: 'full' });               // pełna plansza, ale gdzieś jest błąd (bez wskazywania gdzie)
    }
    return;
  }

  if (mine[idx] !== 0) return;
  g.lastMove[i] = now;
  if (g.solution[idx] === v) {
    mine[idx] = v;
    g.filled[i]++;
    g.prog[i] = progressOf(g, i);
    sendP(p, { type: 'ok', r, c, v, filled: g.filled[i], prog: g.prog[i], goal: g.goal });
    sendP(g.players[1 - i], { type: 'opp', filled: g.filled[i], cell: idx, on: 1, prog: g.prog[i], goal: g.goal });
    if (g.prog[i] >= g.goal) boardWon(g, i);
  } else {
    g.lockedUntil[i] = now + g.lockMs;
    sendP(p, { type: 'wrong', r, c, lockMs: g.lockMs });
  }
}

// ---------- emotki (gotowe wiadomości, bez wolnego tekstu) ----------
const EMOTE_COUNT = 8, EMOTE_GAP_MS = 1500, EMOTE_MAX = 30;      // lista i treść emotek jest po stronie strony
function handleEmote(p, m) {
  const id = m.id;
  if (!Number.isInteger(id) || id < 0 || id >= EMOTE_COUNT) return;
  const now = Date.now();
  if (now - (p.lastEmote || 0) < EMOTE_GAP_MS || (p.emoteCount || 0) >= EMOTE_MAX) return;
  let o = null;
  if (p.game && !p.game.over) o = p.game.players[1 - p.idx];
  else if (p.last && Date.now() - p.last.at <= REMATCH_MS) {          // chwila po meczu ("GG")
    o = players.get(p.last.oppId);
    if (o && !(o.last && o.last.oppId === p.user.id)) o = null;
  }
  if (!o || !o.ws) return;
  p.lastEmote = now; p.emoteCount = (p.emoteCount || 0) + 1;
  sendP(o, { type: 'emote', id, from: p.user.name });
}

function deliver(p, msg) {
  if (p.ws) send(p.ws, msg);
  else {
    pendingResults.set(p.user.id, msg);
    setTimeout(() => { if (pendingResults.get(p.user.id) === msg) pendingResults.delete(p.user.id); }, 600e3).unref();
  }
}

function modeOf(g) { return g.mode && g.mode !== 'classic' ? g.mode : g.friend ? 'friend' : g.ranked ? 'ranked' : 'casual'; }
const lastMode = L => L.mode && L.mode !== 'classic' ? L.mode : L.friend ? 'friend' : L.ranked ? 'ranked' : 'casual';
function pushElo(u, diff, elo, t) {
  const log = u.eloLog[diff] || (u.eloLog[diff] = [[u.createdAt, 1000]]);
  log.push([t, elo]);
  while (log.length > ELO_LOG_MAX) log.splice(1, 1);         // punkt startowy zostaje
}
function logHistory(u, e) {
  if (isGuest(u)) return;                                    // goście nie mają historii
  u.history.push(e);
  while (u.history.length > HISTORY_MAX) u.history.shift();
}

function endGame(g, winnerIdx, reason, opts = {}) {
  if (g.over) return;
  g.over = true;
  const w = g.players[winnerIdx], l = g.players[1 - winnerIdx];
  const at = Date.now();
  const ms = Math.max(0, at - g.t0);
  const diff = g.diff, mode = modeOf(g);
  const wu = w.user, lu = l.user;

  // anty-bot: wygrana szybsza niż człowiek jest w stanie = mecz unieważniony
  const tooFast = g.ranked && reason === 'solved' && ms < g.empties * MIN_MS_PER_CELL;
  const voided = tooFast || !!opts.void;
  let wDelta = 0, lDelta = 0, wRank = null, lRank = null;
  if (tooFast) {
    wu.flags++;
    console.log('Mecz unieważniony (zbyt szybki):', wu.name, ms + 'ms', 'flagi:', wu.flags);
  }
  if (g.ranked && !voided) {                                 // tylko gra rankingowa zmienia Elo i statystyki
    const ws_ = wu.stats[diff], ls_ = lu.stats[diff];
    const wOld = ws_.elo, lOld = ls_.elo;
    ws_.elo = newElo(wOld, lOld, 1); ls_.elo = newElo(lOld, wOld, 0);
    ws_.wins++; ls_.losses++; ws_.sgames++; ls_.sgames++;
    ws_.streak++; ws_.bestStreak = Math.max(ws_.bestStreak, ws_.streak); ls_.streak = 0;
    if (reason === 'solved') {                               // czasy liczymy tylko z rozwiązanych plansz
      ws_.solved++; ws_.sumMs += ms;
      if (!ws_.bestMs || ms < ws_.bestMs) ws_.bestMs = ms;
    }
    wDelta = ws_.elo - wOld; lDelta = ls_.elo - lOld;
    wRank = { from: rankIndex(wOld), to: rankIndex(ws_.elo) }; lRank = { from: rankIndex(lOld), to: rankIndex(ls_.elo) };
    pushElo(wu, diff, ws_.elo, at); pushElo(lu, diff, ls_.elo, at);
  }
  const eloAfter = u => (g.ranked && !voided) ? u.stats[diff].elo : null;
  logHistory(wu, { t: at, opp: lu.name, diff, mode, won: true, reason, ms, delta: wDelta, elo: eloAfter(wu), void: voided });
  logHistory(lu, { t: at, opp: wu.name, diff, mode, won: false, reason, ms, delta: lDelta, elo: eloAfter(lu), void: voided });
  saveU(wu); saveU(lu);

  const base = { type: 'result', reason, ms, diff, mode: g.mode, ranked: g.ranked, friend: g.friend, void: voided };
  deliver(w, { ...base, won: true, delta: wDelta, rank: wRank, score: [g.score[winnerIdx], g.score[1 - winnerIdx]], user: pub(wu) });
  deliver(l, { ...base, won: false, delta: lDelta, rank: lRank, score: [g.score[1 - winnerIdx], g.score[winnerIdx]], user: pub(lu) });
  w.last = { oppId: lu.id, oppIp: l.ip, diff, mode: g.mode, ranked: g.ranked, friend: g.friend, at, ms };   // rewanż i zgłoszenie
  l.last = { oppId: wu.id, oppIp: w.ip, diff, mode: g.mode, ranked: g.ranked, friend: g.friend, at, ms };
  for (const p of [w, l]) {
    clearTimeout(p.graceTimer);
    p.game = null; p.rematchWant = false;
    if (!p.ws) players.delete(p.user.id);
  }
}

// ---------- zgłoszenia graczy ----------
const REPORT_REASONS = ['cheat', 'abuse', 'other'];
function handleReport(p, m) {
  if (!REPORT_REASONS.includes(m.reason)) return;
  if (limited('rep:' + p.user.id, 10, 3600e3) || limited('repip:' + (p.ip || ''), 15, 3600e3))
    return notice(p, 'Za dużo zgłoszeń, spróbuj później.');
  let target, ip, ctx;
  const g = p.game;
  if (g && !g.over) {
    const o = g.players[1 - p.idx];
    target = o.user; ip = o.ip;
    ctx = { diff: g.diff, mode: modeOf(g), ms: Date.now() - g.t0, live: true, at: Date.now() };
  } else if (p.last) {
    target = users.get(p.last.oppId); ip = p.last.oppIp;
    ctx = { diff: p.last.diff, mode: lastMode(p.last), ms: p.last.ms, live: false, at: p.last.at };
  }
  if (!target) return notice(p, 'Nie ma kogo zgłosić. Zgłoszenie jest możliwe w trakcie meczu i na ekranie wyniku.');
  if (target.id === p.user.id) return;
  const dayAgo = Date.now() - 86400e3;
  for (const r of reports.values())
    if (r.reporter.id === p.user.id && r.target.id === target.id && r.at > dayAgo)
      return notice(p, 'Ten gracz został już przez Ciebie zgłoszony.');
  const note = String(m.note || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  const rep = {
    id: crypto.randomUUID(), at: Date.now(), status: 'open', reason: m.reason, note, match: ctx,
    reporter: { id: p.user.id, name: p.user.name, guest: isGuest(p.user) },
    target: { id: target.id, name: target.name, guest: isGuest(target), ip: ip || '' }
  };
  reports.set(rep.id, rep);
  store.save('reports', rep);
  notice(p, 'Dziękujemy, zgłoszenie zostało wysłane do moderacji.');
}

// ---------- profil: statystyki i historia ----------
app.post('/api/profile', (req, res) => {
  if (limited('prof:' + ipOf(req), 60, 60e3)) return res.status(429).json({ error: 'Za dużo zapytań.' });
  const u = userByToken((req.body || {}).token);
  if (!u) return res.status(401).json({ error: 'Zaloguj się ponownie.' });
  if (isGuest(u)) return res.json({ guest: true });
  const stats = {};
  for (const d of Object.keys(DIFFS)) {
    const s = u.stats[d];
    stats[d] = { elo: s.elo, wins: s.wins, losses: s.losses, streak: s.streak, bestStreak: s.bestStreak,
                 bestMs: s.bestMs || null, avgMs: s.solved ? Math.round(s.sumMs / s.solved) : null };
  }
  res.json({ name: u.name, stats, history: u.history.slice(-50).reverse(), eloLog: u.eloLog, badges: u.badges.slice().reverse() });
});

// ---------- panel admina ----------
function adminAuth(req, res) {
  if (!ADMIN_PASSWORD) { res.status(404).json({ error: 'Panel admina jest wyłączony (brak ADMIN_PASSWORD).' }); return false; }
  const ip = ipOf(req), key = 'adminfail:' + ip;
  const fails = (hits.get(key) || []).filter(t => Date.now() - t < 600e3);
  if (fails.length >= 10) { res.status(429).json({ error: 'Za dużo błędnych prób, spróbuj za kilka minut.' }); return false; }
  const a = crypto.createHash('sha256').update(String(req.headers['x-admin-key'] || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) { fails.push(Date.now()); hits.set(key, fails); res.status(401).json({ error: 'Zły klucz.' }); return false; }
  return true;
}
function banView(b) { return { id: b.id, type: b.type, value: b.type === 'user' ? '' : b.value, name: b.name, reason: b.reason, at: b.at, until: b.until || null }; }
function adminOverview() {
  const groups = new Map();
  for (const r of reports.values()) {
    if (r.status !== 'open') continue;
    let gr = groups.get(r.target.id);
    if (!gr) { gr = { targetId: r.target.id, name: r.target.name, guest: r.target.guest, ip: r.target.ip, count: 0, reasons: {}, lastAt: 0, reports: [] }; groups.set(r.target.id, gr); }
    gr.count++; gr.reasons[r.reason] = (gr.reasons[r.reason] || 0) + 1;
    if (r.at > gr.lastAt) { gr.lastAt = r.at; gr.ip = r.target.ip || gr.ip; }
    gr.reports.push({ at: r.at, reporter: r.reporter.name, reporterGuest: r.reporter.guest, reason: r.reason, note: r.note, match: r.match });
  }
  const list = [...groups.values()].map(gr => {
    const u = users.get(gr.targetId);
    gr.reports.sort((a, b) => b.at - a.at); gr.reports = gr.reports.slice(0, 10);
    return Object.assign(gr, { banned: !!userBanned(gr.targetId), flags: u ? u.flags : 0 });
  }).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  return { reports: list, bans: [...banById.values()].filter(liveBan).sort((a, b) => b.at - a.at).map(banView) };
}
function kickUser(userId) {
  const p = players.get(userId);
  if (!p) return;
  if (p.game && !p.game.over) endGame(p.game, 1 - p.idx, 'banned', { void: true });
  if (p.ws) { send(p.ws, { type: 'banned', reason: (userBanned(userId) || {}).reason || '' }); try { p.ws.close(4003, 'banned'); } catch {} }
}
app.get('/api/admin/overview', (req, res) => { if (adminAuth(req, res)) res.json(adminOverview()); });
app.get('/api/admin/user', (req, res) => {
  if (!adminAuth(req, res)) return;
  const id = nameIndex.get(String(req.query.name || '').toLowerCase());
  const u = id && users.get(id);
  if (!u) return res.status(404).json({ error: 'Nie ma takiego gracza.' });
  const games = Object.values(u.stats).reduce((n, x) => n + x.wins + x.losses, 0);
  res.json({ id: u.id, name: u.name, guest: isGuest(u), google: !!u.google, createdAt: u.createdAt, lastSeen: u.lastSeen,
             flags: u.flags, ranked: games, banned: !!userBanned(u.id),
             stats: Object.fromEntries(Object.entries(u.stats).map(([d, s]) => [d, { elo: s.elo, wins: s.wins, losses: s.losses }])) });
});
app.post('/api/admin/ban', (req, res) => {
  if (!adminAuth(req, res)) return;
  const { type, reason } = req.body || {};
  const why = String(reason || '').slice(0, 200);
  let ban;
  if (type === 'user') {
    let u = users.get(String(req.body.userId || ''));
    if (!u && req.body.name) u = users.get(nameIndex.get(String(req.body.name).toLowerCase()));
    if (!u) return res.status(404).json({ error: 'Nie ma takiego gracza.' });
    if (userBanned(u.id)) return res.status(409).json({ error: 'Ten gracz jest już zablokowany.' });
    ban = { id: crypto.randomUUID(), type: 'user', value: u.id, name: u.name, reason: why, at: Date.now(), until: null };
  } else if (type === 'ip') {
    const ip = String(req.body.ip || '').trim().slice(0, 64);
    if (!ip) return res.status(400).json({ error: 'Brak adresu IP.' });
    const days = Math.min(Math.max(+req.body.days || 7, 1), 365);
    ban = { id: crypto.randomUUID(), type: 'ip', value: ip, name: ip, reason: why, at: Date.now(), until: Date.now() + days * 86400e3 };
  } else return res.status(400).json({ error: 'Zły typ blokady.' });
  indexBan(ban); store.save('bans', ban);
  if (ban.type === 'user') {
    for (const r of reports.values()) if (r.target.id === ban.value && r.status === 'open') { r.status = 'actioned'; store.save('reports', r); }
    kickUser(ban.value);
  } else {
    for (const p of [...players.values()]) if (p.ip === ban.value) kickUser(p.user.id);
  }
  res.json(adminOverview());
});
app.post('/api/admin/unban', (req, res) => {
  if (!adminAuth(req, res)) return;
  const b = banById.get(String((req.body || {}).id || ''));
  if (b) { unindexBan(b); store.remove('bans', b); }
  res.json(adminOverview());
});
app.post('/api/admin/dismiss', (req, res) => {
  if (!adminAuth(req, res)) return;
  const id = String((req.body || {}).targetId || '');
  for (const r of reports.values()) if (r.target.id === id && r.status === 'open') { r.status = 'dismissed'; store.save('reports', r); }
  res.json(adminOverview());
});

// sprzątanie zgłoszeń i wygasłych blokad IP
setInterval(() => {
  const now = Date.now();
  for (const r of [...reports.values()])
    if (now - r.at > (r.status === 'dismissed' ? 7 : 60) * 86400e3) { reports.delete(r.id); store.remove('reports', r); }
  for (const b of [...banById.values()]) if (b.until && b.until < now) { unindexBan(b); store.remove('bans', b); }
}, 3600e3).unref();

// sprzątanie: goście bez ani jednego meczu, nieaktywni od 7 dni
setInterval(() => {
  const limit = Date.now() - 7 * 86400e3;
  for (const u of [...users.values()]) {
    const games = Object.values(u.stats).reduce((s, x) => s + x.wins + x.losses, 0);
    if (isGuest(u) && games === 0 && u.lastSeen < limit && !players.has(u.id)) {
      users.delete(u.id);
      u.sessions.forEach(s => sessionIndex.delete(s));
      nameIndex.delete(u.name.toLowerCase());
      removeU(u);
    }
  }
}, 3600e3).unref();

// ================= SEZONY =================
let meta = { id: 'meta', season: '', history: [] };          // bieżący sezon + wyniki poprzednich (ostatnie 12)
function seasonId(d = new Date()) { return d.toLocaleString('sv-SE', { timeZone: 'Europe/Warsaw' }).slice(0, 7); }    // np. "2026-11"
function seasonEnd(id) {                                      // początek następnego miesiąca w Polsce (ms)
  if (!/^\d{4}-\d{2}$/.test(id || '')) return null;
  const [y, m] = id.split('-').map(Number), guess = Date.UTC(y, m, 1);
  const off = Date.parse(new Date(guess).toLocaleString('sv-SE', { timeZone: 'Europe/Warsaw' }).replace(' ', 'T') + 'Z') - guess;
  return guess - off;
}
function rollSeason(newId) {
  const old = meta.season, now = Date.now();
  if (old) {                                                  // odznaki dla TOP 3 każdego poziomu (min. SEASON_MIN_GAMES meczów)
    const results = {};
    for (const d of Object.keys(DIFFS)) {
      const top = [...users.values()]
        .filter(u => !isGuest(u) && u.stats[d].sgames >= SEASON_MIN_GAMES && u.flags < FLAGS_HIDE && !userBanned(u.id))
        .sort((a, b) => b.stats[d].elo - a.stats[d].elo).slice(0, 3);
      results[d] = top.map((u, k) => ({ place: k + 1, name: u.name, elo: u.stats[d].elo }));
      top.forEach((u, k) => u.badges.push({ season: old, diff: d, place: k + 1, elo: u.stats[d].elo }));
    }
    meta.history.push({ season: old, results });
    meta.history = meta.history.slice(-12);
  }
  for (const u of users.values()) {                           // miękki reset: Elo zbliża się do 1000
    if (isGuest(u)) continue;
    for (const d of Object.keys(DIFFS)) {
      const s = u.stats[d];
      if (s.wins + s.losses > 0) { s.elo = Math.round(1000 + (s.elo - 1000) * SEASON_KEEP); pushElo(u, d, s.elo, now); }
      s.sgames = 0;
    }
    saveU(u);
  }
  meta.season = newId;
  store.save('meta', meta);
  for (const p of players.values()) if (p.ws) {               // odśwież ekrany graczy online
    sendP(p, { type: 'me', user: pub(p.user) });
    notice(p, 'Nowy sezon ' + newId + '! Elo zostało zresetowane.');
  }
  console.log('Nowy sezon:', newId, '(poprzedni:', old || 'brak', ')');
}
setInterval(() => { const id = seasonId(); if (meta.season && id !== meta.season) rollSeason(id); }, 60e3).unref();

// ================= ZAGADKA DNIA =================
// Jedna plansza na poziom na dobę (czas polski), taka sama dla wszystkich. Czas mierzy serwer: od pierwszego pobrania do wysłania poprawnej planszy.
const warsawDay = (d = new Date()) => d.toLocaleString('sv-SE', { timeZone: 'Europe/Warsaw' }).slice(0, 10);
function dayEnd(day) {
  const [y, m, d] = day.split('-').map(Number), guess = Date.UTC(y, m - 1, d + 1);
  const off = Date.parse(new Date(guess).toLocaleString('sv-SE', { timeZone: 'Europe/Warsaw' }).replace(' ', 'T') + 'Z') - guess;
  return guess - off;
}
const DAILY_BOARD_MAX = 500;
function dailyNow() {
  const day = warsawDay();
  if (!meta.daily || meta.daily.date !== day) {
    const prev = meta.daily ? { date: meta.daily.date, top: Object.fromEntries(Object.keys(DIFFS).map(d => [d, dailyTop(meta.daily, d, 3)])) } : null;
    const puzzles = {}, boards = {};
    for (const d of Object.keys(DIFFS)) { puzzles[d] = generatePuzzle(d); boards[d] = []; }
    meta.daily = { date: day, puzzles, boards, prev };
    store.save('meta', meta);
  }
  return meta.daily;
}
function dailyTop(daily, diff, n) {
  return daily.boards[diff].map(e => ({ e, u: users.get(e.id) }))
    .filter(x => x.u && x.u.flags < FLAGS_HIDE && !userBanned(x.u.id)).slice(0, n)
    .map(x => ({ name: x.u.name, ms: x.e.ms }));
}
function dailyUser(u, day) {
  if (u.daily.date !== day) u.daily = { date: day, runs: {}, done: {} };
  return u.daily;
}
function dailyRank(daily, diff, id) { const i = daily.boards[diff].findIndex(e => e.id === id); return i < 0 ? null : i + 1; }

app.post('/api/daily/start', (req, res) => {
  if (limited('dstart:' + ipOf(req), 40, 60e3)) return res.status(429).json({ error: 'Za dużo zapytań.' });
  const u = userByToken((req.body || {}).token), diff = (req.body || {}).diff;
  if (!u) return res.status(401).json({ error: 'Zaloguj się ponownie.' });
  if (!DIFFS[diff]) return res.status(400).json({ error: 'Zły poziom.' });
  const daily = dailyNow(), pz = daily.puzzles[diff];
  if (isGuest(u)) return res.json({ date: daily.date, diff, puzzle: pz.puzzle, solution: pz.solution, elapsed: 0, guest: true });
  const du = dailyUser(u, daily.date);
  if (du.done[diff] != null) return res.json({ date: daily.date, diff, done: true, ms: du.done[diff], rank: dailyRank(daily, diff, u.id) });
  if (!du.runs[diff]) { du.runs[diff] = Date.now(); saveU(u); }
  res.json({ date: daily.date, diff, puzzle: pz.puzzle, solution: pz.solution, elapsed: Date.now() - du.runs[diff] });
});

app.post('/api/daily/finish', (req, res) => {
  if (limited('dfin:' + ipOf(req), 40, 60e3)) return res.status(429).json({ error: 'Za dużo zapytań.' });
  const b = req.body || {}, u = userByToken(b.token), diff = b.diff;
  if (!u) return res.status(401).json({ error: 'Zaloguj się ponownie.' });
  if (isGuest(u) || !DIFFS[diff]) return res.status(400).json({ error: 'Wynik zapisują tylko konta.' });
  const daily = dailyNow(), du = dailyUser(u, daily.date), sol = daily.puzzles[diff].solution;
  if (du.done[diff] != null) return res.json({ ms: du.done[diff], rank: dailyRank(daily, diff, u.id), already: true });
  if (!du.runs[diff]) return res.status(400).json({ error: 'Najpierw rozpocznij zagadkę.' });
  if (!Array.isArray(b.cur) || b.cur.length !== 81 || !b.cur.every((v, k) => v === sol[k])) return res.status(400).json({ error: 'Plansza nie jest poprawnie rozwiązana.' });
  const ms = Date.now() - du.runs[diff], empties = daily.puzzles[diff].puzzle.filter(v => !v).length;
  if (ms < empties * MIN_MS_PER_CELL) {                       // jak w grze rankingowej: czas niemożliwy dla człowieka
    u.flags++; delete du.runs[diff]; saveU(u);
    return res.status(400).json({ error: 'Wynik w czasie niemożliwym dla człowieka. Nie został zapisany.' });
  }
  du.done[diff] = ms;
  const board = daily.boards[diff];
  board.push({ id: u.id, ms }); board.sort((x, y) => x.ms - y.ms);
  if (board.length > DAILY_BOARD_MAX) board.length = DAILY_BOARD_MAX;
  store.save('meta', meta); saveU(u);
  res.json({ ms, rank: dailyRank(daily, diff, u.id), total: board.length });
});

app.get('/api/daily/board', (req, res) => {
  const diff = DIFFS[req.query.diff] ? req.query.diff : 'medium', daily = dailyNow();
  res.json({ date: daily.date, endsAt: dayEnd(daily.date), diff, count: daily.boards[diff].length, top: dailyTop(daily, diff, 20),
             prev: daily.prev ? { date: daily.prev.date, top: daily.prev.top[diff] || [] } : null });
});

app.post('/api/daily/status', (req, res) => {
  if (limited('dstat:' + ipOf(req), 60, 60e3)) return res.status(429).json({ error: 'Za dużo zapytań.' });
  const u = userByToken((req.body || {}).token);
  if (!u) return res.status(401).json({ error: 'Zaloguj się ponownie.' });
  const daily = dailyNow(), out = { date: daily.date, endsAt: dayEnd(daily.date), guest: isGuest(u), done: {}, running: {} };
  if (!isGuest(u)) {
    const du = dailyUser(u, daily.date);
    for (const d of Object.keys(DIFFS)) {
      if (du.done[d] != null) out.done[d] = { ms: du.done[d], rank: dailyRank(daily, d, u.id) };
      else if (du.runs[d]) out.running[d] = true;
    }
  }
  res.json(out);
});

// ================= START =================
async function main() {
  const data = await store.load();
  const loaded = data.users;
  if (data.meta && data.meta[0]) meta = data.meta[0];
  const firstRun = !meta.season;                    // pierwszy start po dodaniu sezonów
  for (const r of data.reports) reports.set(r.id, r);
  for (const b of data.bans) indexBan(b);
  loaded.sort((a, b) => (isGuest(a) ? 1 : 0) - (isGuest(b) ? 1 : 0));       // najpierw konta, potem goście
  for (const u of loaded) {
    ensureUser(u);
    let changed = false;
    if (firstRun) for (const d of Object.keys(DIFFS)) { const st = u.stats[d]; if (!st.sgames && st.wins + st.losses) { st.sgames = st.wins + st.losses; changed = true; } }   // dotychczasowe mecze liczą się do bieżącego sezonu
    if (isGuest(u) && (!/^Guest\d+$/.test(u.name) || nameIndex.has(u.name.toLowerCase()))) { u.name = guestName(); changed = true; }
    users.set(u.id, u); indexUser(u);
    if (changed) saveU(u);
  }
  const cur = seasonId();
  if (meta.season) dailyNow();                   // przygotuj dzisiejsze zagadki od razu
  if (firstRun) { meta.season = cur; store.save('meta', meta); }
  else if (meta.season !== cur) rollSeason(cur);
  console.log(`Baza: ${store.kind}, użytkowników: ${users.size}, zgłoszeń: ${reports.size}, blokad: ${banById.size}`);
  server.listen(PORT, () => console.log('Sudoku Duel działa na porcie ' + PORT));
}
if (require.main === module || process.env.SUDOKU_TEST) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { UNITS, generatePuzzle, countSolutions, DIFFS, rollSeason, seasonId, _users: users };
