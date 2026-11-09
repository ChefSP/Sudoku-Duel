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
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';        // hasło do panelu /owner.html (właściciel: wszystko, co admin + dodatki)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';        // hasło do panelu /admin.html (bez niego panel jest wyłączony)

const DIFFS = {
  easy:     { label: 'Łatwy',    remove: 38, lock: 2000 },
  medium:   { label: 'Średni',   remove: 48, lock: 4000 },
  hard:     { label: 'Trudny',   remove: 55, lock: 10000 },
  hardcore: { label: 'Hardcore', remove: 55, lock: 0, blind: true }   // bez blokady i bez sprawdzania cyfr
};
// tryby gry (na razie wszystkie poza klasycznym są bez rankingu)
const MODES = ['classic', 'blitz', 'line', 'sprint', 'rush'];
const RUSH_SECS = [30, 60, 120, 300];     // Na czas: kto w tym czasie wstawi więcej poprawnych cyfr (po skończonej planszy dostaje następną)
const secsOf = v => RUSH_SECS.includes(+v) ? +v : 60;
const queueKey = (mode, ranked, secs) => ranked ? 'ranked' : mode === 'classic' ? 'casual' : mode === 'rush' ? 'rush' + secs : mode;
const BLITZ_ROUNDS = 3;           // Blitz: 3 plansze pod rząd, wygrywa ten, kto weźmie więcej (2 wygrane kończą serię)
const LINE_TARGET = 3;            // Linie: wygrywa pierwszy, kto skompletuje tyle rzędów / kolumn / bloków 3x3
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
    history: [], eloLog: {}, badges: [], friends: [], fin: [], fout: [], daily: { date: '', runs: {}, done: {} },
    flags: 0, createdAt: now, lastSeen: now,
    profile: { bio: '', avatar: '🙂', showcase: [] }, ach: {}, achNew: [], dstreak: { cur: 0, best: 0, last: '' }, cnt: { wins: 0 }, warning: null, club: null
  };
}
const isGuest = u => !u.pass && !u.google;
function indexUser(u) {
  for (const s of u.sessions) sessionIndex.set(s, u.id);
  nameIndex.set(u.name.toLowerCase(), u.id);
}

const reports = new Map();        // id -> zgłoszenie
const banById = new Map(), banUser = new Map(), banIp = new Map();
const clubs = new Map();                          // kluby: id -> { id, name, tag, emoji, desc, ownerId, members[], createdAt }
const feedback = new Map();                       // zgłoszenia pomysłów i błędów (tekst w bazie, załączniki osobno)
const saveU = u => { if (!u.bot) store.save('users', u); };
const removeU = u => store.remove('users', u);
function indexBan(b) { banById.set(b.id, b); (b.type === 'ip' ? banIp : banUser).set(b.value, b); }
function unindexBan(b) { banById.delete(b.id); (b.type === 'ip' ? banIp : banUser).delete(b.value); }
const liveBan = b => (b && (!b.until || b.until > Date.now())) ? b : null;
const userBanned = id => liveBan(banUser.get(id));
const ipBanned = ip => liveBan(banIp.get(ip));

const MEDIA_DIR = path.join(path.dirname(DATA_FILE), 'media');
function makeJsonStore() {
  let timer = null;
  const write = () => {
    const data = JSON.stringify({ version: 3, users: [...users.values()], reports: [...reports.values()], bans: [...banById.values()], feedback: [...feedback.values()], clubs: [...clubs.values()], meta });
    fs.writeFile(DATA_FILE + '.tmp', data, err => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(write, 500); };
  return {
    kind: 'plik JSON',
    async load() {
      let raw;
      try { raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { users: [], reports: [], bans: [], feedback: [], clubs: [], meta: [] }; }
      if (raw && raw.version >= 2) return { users: raw.users || [], reports: raw.reports || [], bans: raw.bans || [], feedback: raw.feedback || [], clubs: raw.clubs || [], meta: raw.meta ? [raw.meta] : [] };
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
    remove() { schedule(); },
    // załączniki (zrzuty ekranu / wideo) leżą w osobnych plikach, żeby nie puchła pamięć
    async mediaPut(id, mime, buf) { await fs.promises.mkdir(MEDIA_DIR, { recursive: true }); await fs.promises.writeFile(path.join(MEDIA_DIR, id), buf); await fs.promises.writeFile(path.join(MEDIA_DIR, id + '.mime'), mime); },
    async mediaGet(id) { try { return { mime: await fs.promises.readFile(path.join(MEDIA_DIR, id + '.mime'), 'utf8'), buf: await fs.promises.readFile(path.join(MEDIA_DIR, id)) }; } catch { return null; } },
    async mediaDel(id) { for (const f of [id, id + '.mime']) await fs.promises.unlink(path.join(MEDIA_DIR, f)).catch(() => {}); }
  };
}
function makePgStore(url) {
  const { Pool } = require('pg');
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  const ssl = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: u.toString(), ssl, max: 5 });
  pool.on('error', e => console.error('pg pool:', e.message));
  const TABLE = { users: 'users', reports: 'reports', bans: 'bans', meta: 'meta', feedback: 'feedback', clubs: 'clubs' };    // stała lista (nic od użytkownika nie trafia do SQL)
  return {
    kind: 'Postgres',
    async load() {
      const out = {};
      for (const k of Object.keys(TABLE)) {
        await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE[k]} (id text PRIMARY KEY, data jsonb NOT NULL)`);
        out[k] = (await pool.query(`SELECT data FROM ${TABLE[k]}`)).rows.map(x => x.data);
      }
      await pool.query('CREATE TABLE IF NOT EXISTS media (id text PRIMARY KEY, mime text NOT NULL, data bytea NOT NULL, at bigint NOT NULL)');
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
    },
    async mediaPut(id, mime, buf) { await pool.query('INSERT INTO media (id, mime, data, at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data', [id, mime, buf, Date.now()]); },
    async mediaGet(id) { const r = await pool.query('SELECT mime, data FROM media WHERE id = $1', [id]); return r.rows[0] ? { mime: r.rows[0].mime, buf: r.rows[0].data } : null; },
    async mediaDel(id) { await pool.query('DELETE FROM media WHERE id = $1', [id]).catch(() => {}); }
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
  for (const k of ['friends', 'fin', 'fout']) if (!Array.isArray(u[k])) u[k] = [];   // znajomi, zaproszenia do mnie, zaproszenia ode mnie
  if (!u.daily || typeof u.daily !== 'object') u.daily = { date: '', runs: {}, done: {} };
  if (!u.profile || typeof u.profile !== 'object') u.profile = { bio: '', avatar: '🙂', showcase: [] };
  if (u.club === undefined) u.club = null;
  if (!u.ach || typeof u.ach !== 'object') u.ach = {};
  if (!Array.isArray(u.achNew)) u.achNew = [];
  if (!u.dstreak || typeof u.dstreak !== 'object') u.dstreak = { cur: 0, best: 0, last: '' };
  if (!u.cnt || typeof u.cnt !== 'object') u.cnt = { wins: Object.values(u.stats).reduce((n, x) => n + x.wins, 0) };
  if (u.warning === undefined) u.warning = null;     // ostrzeżenie od moderacji (pokazujemy do potwierdzenia)
}
function pub(u) {
  const c = clubs.get(u.club);
  return { name: u.name, guest: isGuest(u), google: !!u.google, stats: u.stats, club: c ? { id: c.id, name: c.name, tag: c.tag } : null };
}

// ================= HTTP =================
const app = express();
app.disable('x-powered-by');
app.use('/api/owner', express.json({ limit: '64kb' }));
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, f) => { if (f.endsWith('sw.js') || f.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache'); }   // service worker i manifest zawsze świeże
}));
app.use('/api', (req, res, next) => {              // zablokowany adres IP nie korzysta z API (poza panelem admina)
  if (!req.path.startsWith('/admin') && !req.path.startsWith('/owner') && ipBanned(ipOf(req))) return res.status(403).json({ error: 'Ten adres IP został zablokowany.' });
  next();
});

// ładne adresy podstron gry (aplikacja sama rozpoznaje je po adresie)
app.get(['/tryb/:mode', '/zagadka', '/znajomi', '/zasady', '/zglos', '/zmiany', '/kluby'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- pomysły i błędy (z opcjonalnym zrzutem ekranu lub krótkim wideo) ----------
const FEEDBACK_KINDS = ['bug', 'idea', 'other'], FEEDBACK_MAX = 500, IMG_MAX = 2.5e6, VID_MAX = 10e6, MEDIA_TOTAL_MAX = 150e6;
function sniffMedia(b, mime) {
  if (mime === 'image/png') return b.length > 8 && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (mime === 'image/jpeg') return b.length > 4 && b[0] === 0xff && b[1] === 0xd8;
  if (mime === 'image/webp') return b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
  if (mime === 'video/mp4' || mime === 'video/quicktime') return b.length > 12 && b.subarray(4, 8).toString() === 'ftyp';
  if (mime === 'video/webm') return b.length > 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}
async function dropFeedback(f) {
  if (f.media && f.media.id) await store.mediaDel(f.media.id);
  feedback.delete(f.id); store.remove('feedback', f);
}
app.post('/api/feedback', (req, res) => {
  const b = req.body || {}, u = userByToken(b.token);
  if (!u) return res.status(401).json({ error: 'Odśwież stronę i spróbuj ponownie.' });
  if (limited('fb:' + u.id, 5, 3600e3) || limited('fbip:' + ipOf(req), 15, 3600e3)) return res.status(429).json({ error: 'Za dużo zgłoszeń, spróbuj za godzinę.' });
  const text = String(b.text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, 1000);
  if (text.length < 5) return res.status(400).json({ error: 'Opisz to trochę dokładniej (min. 5 znaków).' });
  const kind = FEEDBACK_KINDS.includes(b.kind) ? b.kind : 'other', c = b.ctx || {};
  const f = { id: crypto.randomUUID(), at: Date.now(), userId: u.id, name: u.name, guest: isGuest(u), kind, text, status: 'open', media: null,
              ctx: { ua: String(c.ua || '').slice(0, 200), url: String(c.url || '').slice(0, 80), screen: String(c.screen || '').slice(0, 30) } };
  feedback.set(f.id, f); store.save('feedback', f);
  if (feedback.size > FEEDBACK_MAX) {                          // zostaw najnowsze (najpierw wyrzucamy załatwione)
    const old = [...feedback.values()].sort((x, y) => (x.status === 'done' ? 0 : 1) - (y.status === 'done' ? 0 : 1) || x.at - y.at)[0];
    if (old && old.id !== f.id) dropFeedback(old);
  }
  res.json({ id: f.id });
});
app.post('/api/feedback/:id/media', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
  const u = userByToken(req.headers['x-token']), f = feedback.get(req.params.id);
  if (!u || !f || f.userId !== u.id) return res.status(403).json({ error: 'Brak dostępu.' });
  if (f.media) return res.status(409).json({ error: 'Załącznik jest już dodany.' });
  if (limited('fbm:' + u.id, 8, 3600e3)) return res.status(429).json({ error: 'Za dużo załączników, spróbuj za godzinę.' });
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Pusty plik.' });
  const isImg = mime.startsWith('image/');
  if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'].includes(mime) || !sniffMedia(buf, mime)) return res.status(400).json({ error: 'Ten format pliku nie jest obsługiwany (PNG, JPG, WebP, MP4, WebM).' });
  if (buf.length > (isImg ? IMG_MAX : VID_MAX)) return res.status(413).json({ error: isImg ? 'Zrzut ekranu jest za duży (max 2,5 MB).' : 'Nagranie jest za duże (max 10 MB, ok. 15–30 s).' });
  const id = crypto.randomUUID();
  try { await store.mediaPut(id, mime, buf); } catch (e) { console.error('media:', e.message); return res.status(500).json({ error: 'Nie udało się zapisać pliku.' }); }
  f.media = { id, mime, size: buf.length }; store.save('feedback', f);
  let total = [...feedback.values()].reduce((n, x) => n + (x.media ? x.media.size : 0), 0);     // limit miejsca: najstarsze załączniki znikają
  for (const x of [...feedback.values()].sort((a, b) => a.at - b.at)) {
    if (total <= MEDIA_TOTAL_MAX) break;
    if (x.media && x.id !== f.id) { total -= x.media.size; await store.mediaDel(x.media.id); x.media = { gone: true, size: 0 }; store.save('feedback', x); }
  }
  res.json({ ok: true });
});
app.get('/api/admin/feedback', (req, res) => {
  if (!adminAuth(req, res)) return;
  res.json([...feedback.values()].sort((a, b) => b.at - a.at).map(f => ({ id: f.id, at: f.at, name: f.name, guest: f.guest, kind: f.kind, text: f.text, status: f.status, ctx: f.ctx,
    media: f.media && f.media.id ? { id: f.media.id, mime: f.media.mime, size: f.media.size } : f.media && f.media.gone ? { gone: true } : null })));
});
app.get('/api/admin/media/:id', async (req, res) => {
  if (!adminAuth(req, res)) return;
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(400).end();
  const m = await store.mediaGet(req.params.id);
  if (!m) return res.status(404).json({ error: 'Brak pliku.' });
  res.set('Cache-Control', 'private, max-age=3600').type(m.mime).send(m.buf);
});
app.post('/api/admin/feedback/status', (req, res) => {
  if (!adminAuth(req, res)) return;
  const f = feedback.get(String((req.body || {}).id || ''));
  if (!f) return res.status(404).json({ error: 'Nie ma takiego zgłoszenia.' });
  f.status = req.body.status === 'open' ? 'open' : 'done'; store.save('feedback', f); res.json({ ok: true });
});
app.post('/api/admin/feedback/delete', async (req, res) => {
  if (!adminAuth(req, res)) return;
  const f = feedback.get(String((req.body || {}).id || ''));
  if (!f) return res.status(404).json({ error: 'Nie ma takiego zgłoszenia.' });
  await dropFeedback(f); res.json({ ok: true });
});
setInterval(() => {                                            // sprzątanie: 45 dni (załatwione: 7 dni)
  for (const f of [...feedback.values()]) { const age = Date.now() - f.at; if (age > 45 * 86400e3 || (f.status === 'done' && age > 7 * 86400e3)) dropFeedback(f); }
}, 3600e3).unref();


// ================= PANEL WŁAŚCICIELA, ZMIANY, TEKSTY =================
const DEFAULT_CHANGELOG = [
  { v: '11.0', date: '2026-11-09', title: 'Powtórki i kluby', items: ['Powtórka meczu: odtwarzanie ruchów obu graczy w czasie (ostatnie 10 meczów w historii).', 'Kluby: zakładanie, dołączanie, ranking klubów i skrót [TAG] przy nicku.', 'Osiągnięcie „Drużynowy gracz”.'] },
  { v: '10.0', date: '2026-11-08', title: 'Profil i osiągnięcia', items: ['Profil: awatar, opis i wizytówka z 3 osiągnięć; klik w nick w rankingu otwiera profil gracza.', '22 osiągnięcia (wygrana bez błędu, powrót po blokadzie, rangi, tryby, serie).', 'Seria dni z rzędu w Zagadce dnia.', 'Przycisk „Udostępnij wynik” z obrazkiem po wygranej.'] },
  { v: '9.0', date: '2026-11-08', title: 'Zmiany, panel właściciela', items: ['Nowa zakładka „Co nowego” z listą zmian.', 'W trybie Linie liczy się każdy rząd, kolumna i blok – bez dodatkowych obramowań na planszy.', 'Panel właściciela i bezpieczniejszy panel admina.'] },
  { v: '8.0', date: '2026-11-08', title: 'Jak grać i zgłoszenia', items: ['Strona „Jak grać” z krótką lekcją sudoku.', 'Formularz „Pomysł / błąd” ze zrzutem ekranu lub wideo do 30 s.', 'Kary czasowe, ostrzeżenia i ogłoszenia od moderacji.'] },
  { v: '7.0', date: '', title: 'Na czas i bot', items: ['Tryb „Na czas” (30 s – 5 min): kto ułoży więcej plansz.', 'Gra z botem na kilku poziomach.'] },
  { v: '6.0', date: '', title: 'Strony trybów', items: ['Każdy tryb ma własną stronę i adres.', 'Liczniki wypełnionych pól w Sprincie, poprawki Zagadki dnia, podgląd końcowej planszy w historii.'] },
  { v: '5.0', date: '', title: 'Znajomi', items: ['Lista znajomych, zaproszenia i wyzwania na pojedynek.'] },
  { v: '4.0', date: '', title: 'Nowe tryby', items: ['Blitz, Linie i Sprint oraz Zagadka dnia.'] },
  { v: '3.0', date: '', title: 'Rangi i sezony', items: ['Rangi z ikonami: Brąz, Srebro, Złoto, Diament.', 'Miesięczne sezony i odznaki dla TOP 3.'] },
  { v: '2.0', date: '', title: 'Wygląd i dźwięk', items: ['Motywy, animacje, dźwięki, aplikacja PWA, emotki i podgląd planszy rywala.'] },
  { v: '1.0', date: '', title: 'Start', items: ['Pojedynki 1 na 1, konta, ranking Elo, poziomy trudności i Hardcore.'] }
];
const clip = (x, n) => String(x == null ? '' : x).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, n);
app.get('/api/changelog', (req, res) => res.json(meta.changelog || DEFAULT_CHANGELOG));
app.get('/api/texts', (req, res) => res.json(meta.texts || {}));
app.post('/api/owner/changelog', (req, res) => {
  if (!ownerAuth(req, res)) return;
  const a = Array.isArray((req.body || {}).entries) ? req.body.entries.slice(0, 60) : null;
  if (!a) return res.status(400).json({ error: 'Zły format.' });
  meta.changelog = a.map(e => ({ v: clip(e.v, 12), date: clip(e.date, 12), title: clip(e.title, 80),
    items: (Array.isArray(e.items) ? e.items : []).slice(0, 12).map(x => clip(x, 200)).filter(Boolean) })).filter(e => e.title);
  audit(req, 'changelog', meta.changelog.length + ' wpisów'); res.json(meta.changelog);
});
app.post('/api/owner/texts', (req, res) => {
  if (!ownerAuth(req, res)) return;
  const b = req.body || {}, t = { hub: clip(b.hub, 200), modes: {} };
  for (const m of MODES) { const x = clip((b.modes || {})[m], 400); if (x) t.modes[m] = x; }
  meta.texts = t; audit(req, 'texts', 'zmiana opisów'); res.json(t);
});
app.get('/api/owner/audit', (req, res) => { if (ownerAuth(req, res)) res.json((meta.audit || []).slice().reverse()); });
function liveGames() {
  const set = new Set();
  for (const p of players.values()) if (p.game && !p.game.over) set.add(p.game);
  return [...set];
}
app.get('/api/owner/live', (req, res) => {
  if (!ownerAuth(req, res)) return;
  res.json(liveGames().map(g => ({ id: g.id, mode: modeOf(g), diff: g.diff, ranked: g.ranked, names: g.players.map(p => p.user.name), bot: !!g.bot,
    prog: g.prog, goal: g.goal, since: g.t0 })));
});
app.get('/api/owner/live/:id', (req, res) => {
  if (!ownerAuth(req, res)) return;
  const g = liveGames().find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Ten mecz już się skończył.' });
  res.json({ id: g.id, mode: modeOf(g), diff: g.diff, names: g.players.map(p => p.user.name), puzzle: g.puzzle.join(''), solution: g.solution.join(''),
    cur: g.cur.map(c => c.join('')), prog: g.prog, goal: g.goal, score: g.score, round: g.round, elapsed: Date.now() - g.t0 });
});
app.post('/api/owner/message', (req, res) => {
  if (!ownerAuth(req, res)) return;
  const u = users.get(String((req.body || {}).userId || '')), text = clip(req.body.text, 300), p = u && players.get(u.id);
  if (!u) return res.status(404).json({ error: 'Nie ma takiego gracza.' });
  if (!text) return res.status(400).json({ error: 'Wpisz wiadomość.' });
  if (!p || !p.ws) return res.status(409).json({ error: 'Gracz jest offline. Użyj ostrzeżenia – zobaczy je po wejściu.' });
  notice(p, '📩 Wiadomość od właściciela: ' + text); audit(req, 'message', u.name + ': ' + text); res.json({ ok: true });
});
app.get('/api/owner/player', (req, res) => {
  if (!ownerAuth(req, res)) return;
  const id = nameIndex.get(String(req.query.name || '').toLowerCase()), u = id && users.get(id);
  if (!u) return res.status(404).json({ error: 'Nie ma takiego gracza.' });
  const p = players.get(u.id), g = p && p.game && !p.game.over ? p.game : null;
  res.json({ id: u.id, name: u.name, guest: isGuest(u), google: !!u.google, createdAt: u.createdAt, lastSeen: u.lastSeen, flags: u.flags,
    online: !!(p && p.ws), liveGame: g ? g.id : null, banned: !!userBanned(u.id), friends: (u.friends || []).length, badges: u.badges.length,
    stats: Object.fromEntries(Object.entries(u.stats).map(([d, x]) => [d, { elo: x.elo, wins: x.wins, losses: x.losses, sgames: x.sgames }])),
    history: u.history.slice(-30).reverse() });
});
app.post('/api/owner/elo', (req, res) => {
  if (!ownerAuth(req, res)) return;
  const u = users.get(String((req.body || {}).userId || '')), d = String(req.body.diff || ''), elo = Math.round(+req.body.elo);
  if (!u || !DIFFS[d] || !(elo >= 100 && elo <= 4000)) return res.status(400).json({ error: 'Zły gracz, poziom lub Elo (100–4000).' });
  u.stats[d].elo = elo; pushElo(u, d, elo, Date.now()); saveU(u);
  const p = players.get(u.id); if (p && p.ws) sendP(p, { type: 'me', user: pub(u) });
  audit(req, 'elo', u.name + ' ' + d + ' → ' + elo); res.json({ ok: true });
});
app.post('/api/owner/delete_user', (req, res) => {
  if (!ownerAuth(req, res)) return;
  const u = users.get(String((req.body || {}).userId || ''));
  if (!u) return res.status(404).json({ error: 'Nie ma takiego gracza.' });
  if (String(req.body.confirm || '').toLowerCase() !== u.name.toLowerCase()) return res.status(400).json({ error: 'Wpisz nick gracza, aby potwierdzić.' });
  if (u.club) leaveClub(u);
  const p = players.get(u.id);
  if (p) { if (p.game && !p.game.over) endGame(p.game, 1 - p.idx, 'banned', { void: true }); if (p.ws) { try { p.ws.close(4004, 'deleted'); } catch {} } }
  users.delete(u.id); u.sessions.forEach(x => sessionIndex.delete(x)); if (nameIndex.get(u.name.toLowerCase()) === u.id) nameIndex.delete(u.name.toLowerCase());
  for (const o of users.values()) { // sprzątanie znajomych
    for (const k of ['friends', 'fin', 'fout']) if (Array.isArray(o[k]) && o[k].includes(u.id)) { o[k] = o[k].filter(x => x !== u.id); saveU(o); }
  }
  removeU(u); audit(req, 'delete_user', u.name); res.json({ ok: true });
});
app.post('/api/owner/reset_ranking', (req, res) => {
  if (!ownerAuth(req, res)) return;
  const b = req.body || {}, diffs = b.diff === 'all' ? Object.keys(DIFFS) : DIFFS[b.diff] ? [b.diff] : null;
  if (!diffs) return res.status(400).json({ error: 'Wybierz poziom lub „all”.' });
  if (b.confirm !== 'RESET') return res.status(400).json({ error: 'Wpisz RESET, aby potwierdzić.' });
  const now = Date.now(), results = {};
  for (const d of diffs) results[d] = [...users.values()].filter(u => !isGuest(u) && u.stats[d].sgames > 0).sort((x, y) => y.stats[d].elo - x.stats[d].elo).slice(0, 3).map((u, k) => ({ place: k + 1, name: u.name, elo: u.stats[d].elo }));
  meta.history.push({ season: (meta.season || '?') + ' (reset ręczny)', results }); meta.history = meta.history.slice(-12);
  for (const u of users.values()) {
    if (isGuest(u)) continue;
    for (const d of diffs) { const st = u.stats[d]; if (st.elo !== 1000) pushElo(u, d, 1000, now); st.elo = 1000; st.sgames = 0; }
    saveU(u);
  }
  store.save('meta', meta);
  for (const p of players.values()) if (p.ws) { sendP(p, { type: 'me', user: pub(p.user) }); notice(p, 'Ranking został zresetowany przez właściciela.'); }
  audit(req, 'reset_ranking', diffs.join(',')); res.json({ ok: true, diffs });
});
app.get('/api/admin/user_basic', (req, res) => { if (adminAuth(req, res)) res.json({ ok: true }); });

app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, turnstileSiteKey: TURNSTILE_SITE_KEY || null, ranks: RANKS, ach: ACH, avatars: AVATARS,
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
    .map(u => ({ name: u.name, avatar: u.profile.avatar, tag: (clubs.get(u.club) || {}).tag || '', elo: u.stats[diff].elo, wins: u.stats[diff].wins, losses: u.stats[diff].losses,
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
const challenges = new Map();                     // id wyzywającego -> { to, diff, mode, at } (jedno wyzwanie naraz)
const queues = { ranked: {}, casual: {}, blitz: {}, line: {}, sprint: {}, rush30: {}, rush60: {}, rush120: {}, rush300: {} };        // rankingowa (tylko konta) i towarzyska (każdy, bez Elo)
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
function leaveAll(p) { dequeue(p); closeRoom(p); clearLast(p); cancelChallenge(p.user.id); }
function onlineCount() { let n = 0; for (const p of players.values()) if (p.ws) n++; return n; }
function broadcastOnline() {
  const n = onlineCount();
  for (const c of wss.clients) send(c, { type: 'online', n });
}

wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  const ib = ipBanned(ip);
  if (ib) { send(ws, { type: 'banned', reason: ib.reason || '', until: ib.until || null }); ws.close(4003, 'banned'); return; }
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
      const ranked = mode === 'classic' && !!m.ranked, secs = secsOf(m.secs);
      if (ranked && isGuest(p.user)) {
        notice(p, 'Gra rankingowa wymaga konta. Zaloguj się albo zagraj w kolejce towarzyskiej.');
        return sendP(p, { type: 'idle' });
      }
      leaveAll(p);
      queues[queueKey(mode, ranked, secs)][m.diff].push({ p, since: Date.now() });
      sendP(p, { type: 'queued', diff: m.diff, ranked, mode, secs });
    }
    else if (m.type === 'cancel') { leaveAll(p); sendP(p, { type: 'idle' }); }
    else if (m.type === 'report') handleReport(p, m);
    else if (m.type === 'emote') handleEmote(p, m);
    else if (m.type === 'leave') leaveAll(p);                       // wyjście z ekranu wyniku
    else if (m.type === 'move' && p.game) handleMove(p, m);
    else if (m.type === 'resign' && p.game) endGame(p.game, 1 - p.idx, 'resign');
    else if (m.type === 'bot') {
      if (p.game || !DIFFS[m.diff]) return;
      const mode = MODES.includes(m.mode) ? m.mode : 'classic';
      if (DIFFS[m.diff].blind) return notice(p, 'Z botem nie gramy w Hardcore.');
      if (limited('bot:' + p.user.id, 20, 60e3)) return notice(p, 'Za dużo gier z botem, poczekaj chwilę.');
      startBotGame(p, m.diff, { mode, secs: secsOf(m.secs), level: BOT_LEVELS[m.level] ? m.level : 'mid' });
    }
    else if (m.type === 'achack') { if (p.user.achNew.length) { p.user.achNew = []; saveU(p.user); } }
    else if (m.type === 'warnack') { if (p.user.warning) { p.user.warning = null; saveU(p.user); } }
    else if (m.type === 'friends') sendP(p, friendsView(p.user));
    else if (m.type === 'fadd') friendAdd(p, m);
    else if (m.type === 'faccept') friendAccept(p, m);
    else if (m.type === 'fdecline') friendDrop(p, m, 'decline');
    else if (m.type === 'fcancel') friendDrop(p, m, 'cancel');
    else if (m.type === 'fremove') friendDrop(p, m, 'remove');
    else if (m.type === 'challenge') challengeSend(p, m);
    else if (m.type === 'caccept') challengeAccept(p, m);
    else if (m.type === 'cdecline') challengeDecline(p, m);
    else if (m.type === 'room') {                                    // zaproszenie znajomego
      if (p.game || !DIFFS[m.diff]) return;
      const mode = MODES.includes(m.mode) ? m.mode : 'classic';
      if (mode !== 'classic' && DIFFS[m.diff].blind) return notice(p, 'Hardcore jest tylko w grze klasycznej.');
      leaveAll(p);
      let code;
      do { code = Array.from(crypto.randomBytes(6), b => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join(''); } while (rooms.has(code));
      const secs = secsOf(m.secs);
      rooms.set(code, { hostId: p.user.id, diff: m.diff, mode, secs, at: Date.now() });
      sendP(p, { type: 'room', code, diff: m.diff, mode, secs, ttl: ROOM_TTL_MS });
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
      startGame(host, p, r.diff, { ranked: false, friend: true, mode: r.mode, secs: r.secs });
    }
    else if (m.type === 'rematch') {
      const L = p.last;
      if (L && L.botLevel && !p.game && Date.now() - L.at <= REMATCH_MS) { p.last = null; return startBotGame(p, L.diff, { mode: L.mode, secs: L.secs, level: L.botLevel }); }
      const o = L && players.get(L.oppId);
      if (!L || p.game || Date.now() - L.at > REMATCH_MS || !o || !o.ws || o.game || !o.last || o.last.oppId !== p.user.id)
        return notice(p, 'Rewanż jest niedostępny.');
      p.rematchWant = true;
      if (o.rematchWant) {
        p.last = o.last = null; p.rematchWant = o.rematchWant = false;
        startGame(o, p, L.diff, { ranked: L.ranked, friend: L.friend, mode: L.mode, secs: L.secs });
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
    leaveAll(p); dropChallengesTo(p.user.id);
    setTimeout(() => pushFriendsOf(p.user), 50);
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
  if (ub) { send(ws, { type: 'banned', reason: ub.reason || '', until: ub.until || null }); ws.close(4003, 'banned'); return; }

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
  if (!isGuest(user)) send(ws, friendsView(user));
  if (user.warning) send(ws, { type: 'warning', text: user.warning.text });
  if (user.achNew.length) send(ws, { type: 'ach', list: user.achNew });
  if (meta.announce && meta.announce.until > Date.now()) send(ws, { type: 'announce', text: meta.announce.text, until: meta.announce.until });
  pushFriendsOf(user);
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
    for (const k of ['casual', 'blitz', 'line', 'sprint', 'rush30', 'rush60', 'rush120', 'rush300']) {
      const qc = queues[k][diff];
      while (qc.length >= 2) {
        const a = qc.shift(), b = qc.shift();
        startGame(a.p, b.p, diff, k.startsWith('rush') ? { ranked: false, mode: 'rush', secs: +k.slice(4) } : { ranked: false, mode: k === 'casual' ? 'classic' : k });
      }
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
  for (const [fid, ch] of challenges) if (Date.now() - ch.at > CHALLENGE_TTL_MS) cancelChallenge(fid, 'Wyzwanie wygasło.');
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
    id: crypto.randomUUID().slice(0, 8), diff, mode, ranked: mode === 'classic' && !!opts.ranked, friend: !!opts.friend, blind: !!cfg.blind, lockMs: cfg.lock,
    players: [p0, p1], round: 1, score: [0, 0], over: false, t0: Date.now() + COUNTDOWN_MS,
    secs: mode === 'rush' ? secsOf(opts.secs) : 0
  };
  setupBoard(game);
  if (mode === 'rush') {                                     // koniec gry na czas
    game.duration = game.secs * 1000; game.endAt = game.startAt + game.duration;
    game.endTimer = setTimeout(() => rushEnd(game), game.endAt - Date.now() + 50);
  }
  [p0, p1].forEach((p, i) => { p.game = game; p.idx = i; p.emoteCount = 0; });
  [p0, p1].forEach((p, i) => sendP(p, matchPayload(game, i)));
  pushFriendsOf(p0.user); pushFriendsOf(p1.user);
}

const UNITS = [];                                          // 27 jednostek: 9 rzędów, 9 kolumn, 9 bloków 3x3
for (let k = 0; k < 9; k++) {
  UNITS.push(Array.from({ length: 9 }, (_, j) => k * 9 + j));
  UNITS.push(Array.from({ length: 9 }, (_, j) => j * 9 + k));
  const br = (k / 3 | 0) * 3, bc = (k % 3) * 3;
  UNITS.push(Array.from({ length: 9 }, (_, j) => (br + (j / 3 | 0)) * 9 + bc + (j % 3)));
}
function rushBoard(g, n) {                                  // n-ta plansza serii "Na czas": obaj gracze dostają te same plansze w tej samej kolejności
  while (g.seq.length <= n) g.seq.push(generatePuzzle(g.diff));
  const { puzzle, solution } = g.seq[n], empties = puzzle.filter(v => v === 0).length;
  return { n, puzzle, solution, cur: puzzle.slice(), empties, left: empties };
}
function setupBoard(g) {                                   // nowa plansza (start meczu albo kolejna runda Blitza)
  if (g.mode === 'rush') {
    g.seq = [];
    g.rb = [rushBoard(g, 0), rushBoard(g, 0)];
    g.puzzle = g.rb[0].puzzle; g.solution = g.rb[0].solution; g.empties = g.rb[0].empties;
    g.cur = [g.rb[0].cur, g.rb[1].cur];
    g.filled = [0, 0]; g.prog = [0, 0]; g.lockedUntil = [0, 0]; g.lastMove = [0, 0];
    g.errors = [0, 0]; g.lastScore = [0, 0]; g.score = [0, 0];
    g.startAt = g.t0; g.units = []; g.goal = 0;
    return;
  }
  const { puzzle, solution } = generatePuzzle(g.diff);
  g.puzzle = puzzle; g.solution = solution;
  g.empties = puzzle.filter(v => v === 0).length;
  g.cur = [puzzle.slice(), puzzle.slice()];
  g.filled = [0, 0]; g.prog = [0, 0]; g.lockedUntil = [0, 0]; g.lastMove = [0, 0];
  g.startAt = g.round === 1 ? g.t0 : Date.now() + COUNTDOWN_MS;
  const open = UNITS.filter(u => u.some(k => !puzzle[k]));
  g.units = open;                                           // liczy się każdy rząd / kolumna / blok, w którym było co wpisać
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
  const now = Date.now(), o = g.players[1 - i], rb = g.rb && g.rb[i];
  return {
    type: 'match', diff: g.diff, mode: g.mode, ranked: g.ranked, friend: g.friend, blind: g.blind,
    round: g.round, rounds: g.mode === 'blitz' ? BLITZ_ROUNDS : 1, score: [g.score[i], g.score[1 - i]],
    goal: g.goal, prog: g.prog[i], oppProg: g.prog[1 - i],
    puzzle: rb ? rb.puzzle : g.puzzle, cur: rb ? rb.cur : g.cur[i], empties: rb ? rb.empties : g.empties,
    elapsed: now - g.startAt,                          // ujemne = trwa odliczanie
    filled: rb ? rb.empties - rb.left : g.filled[i], oppFilled: g.filled[1 - i], oppMask: rb ? new Array(81).fill(0) : oppMask(g, 1 - i),
    rush: rb ? { secs: g.secs, n: rb.n } : undefined,
    lockMs: Math.max(0, g.lockedUntil[i] - now),
    opp: { name: o.user.name, elo: g.ranked ? o.user.stats[g.diff].elo : null, bot: !!o.isBot },
    oppOnline: !!o.ws || !!o.isBot
  };
}

function rushMove(g, p, r, c, v, now) {
  const i = p.idx, b = g.rb[i], idx = r * 9 + c;
  if (b.puzzle[idx] || b.cur[idx]) return;
  g.lastMove[i] = now;
  if (b.solution[idx] !== v) {
    g.errors[i]++; g.lockedUntil[i] = now + g.lockMs;
    return sendP(p, { type: 'wrong', r, c, lockMs: g.lockMs });
  }
  b.cur[idx] = v; b.left--; g.score[i]++; g.prog[i] = g.score[i]; g.lastScore[i] = now;
  sendP(p, { type: 'ok', r, c, v, filled: b.empties - b.left, prog: g.score[i], goal: 0 });
  sendP(g.players[1 - i], { type: 'opp', prog: g.score[i], goal: 0 });
  if (b.left === 0) {                                        // skończona plansza: następna od razu
    const nb = rushBoard(g, b.n + 1);
    g.rb[i] = nb; g.cur[i] = nb.cur;
    sendP(p, { type: 'board', puzzle: nb.puzzle, cur: nb.cur, empties: nb.empties, n: nb.n, prog: g.score[i] });
  }
}
function rushEnd(g) {
  if (g.over) return;
  const [a, b] = g.score;
  let w, tie = a === b;
  if (!tie) w = a > b ? 0 : 1;
  else if (g.errors[0] !== g.errors[1]) w = g.errors[0] < g.errors[1] ? 0 : 1;        // remis: mniej błędów
  else if (g.lastScore[0] !== g.lastScore[1]) w = g.lastScore[0] < g.lastScore[1] ? 0 : 1;   // potem: kto wcześniej zdobył ostatnie pole
  else w = Math.random() < .5 ? 0 : 1;
  endGame(g, w, 'time', { tie });
}

function boardWon(g, i) {
  if (g.mode !== 'blitz') return endGame(g, i, 'solved');
  g.score[i]++;
  if (g.score[i] > BLITZ_ROUNDS / 2) return endGame(g, i, 'solved');
  g.round++; setupBoard(g);                                  // następna plansza serii
  g.players.forEach((q, k) => sendP(q, { ...matchPayload(g, k), roundWinner: i === k ? 'me' : 'opp' }));
}

const RP_MAX = 400, RP_KEEP = 10;                           // powtórki: max ruchów na gracza, powtórki trzymamy w ostatnich 10 meczach
function recMove(g, i, now, idx, v, w) {
  const a = (g.rp || (g.rp = [[], []]))[i];
  if (a.length < RP_MAX) a.push([Math.max(0, now - g.startAt), idx, v, w]);
}
function handleMove(p, m) {
  const g = p.game, i = p.idx, now = Date.now();
  if (g.over || now < g.startAt) return;
  const r = m.r | 0, c = m.c | 0, v = m.v | 0;
  if (r < 0 || r > 8 || c < 0 || c > 8 || v < (g.blind ? 0 : 1) || v > 9) return;   // 0 = gumka (tylko Hardcore)
  if (now - g.lastMove[i] < MIN_MOVE_MS) return;     // anty-bot: nierealnie szybkie ruchy
  if (now < g.lockedUntil[i]) return;
  if (g.mode === 'rush') return rushMove(g, p, r, c, v, now);
  const idx = r * 9 + c;
  if (g.puzzle[idx]) return;                         // pole z podpowiedzią
  const mine = g.cur[i];

  if (g.blind) {                                     // Hardcore: przyjmujemy wszystko, nic nie sprawdzamy
    if (mine[idx] === v) return;
    g.lastMove[i] = now;
    g.filled[i] += (v ? 1 : 0) - (mine[idx] ? 1 : 0);
    mine[idx] = v; recMove(g, i, now, idx, v, 0);
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
    mine[idx] = v; recMove(g, i, now, idx, v, 0);
    g.filled[i]++;
    g.prog[i] = progressOf(g, i);
    sendP(p, { type: 'ok', r, c, v, filled: g.filled[i], prog: g.prog[i], goal: g.goal });
    sendP(g.players[1 - i], { type: 'opp', filled: g.filled[i], cell: idx, on: 1, prog: g.prog[i], goal: g.goal });
    if (g.prog[i] >= g.goal) boardWon(g, i);
  } else {
    (g.wrongN || (g.wrongN = [0, 0]))[i]++; recMove(g, i, now, idx, v, 1);
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
  if (p.isBot) return;
  if (p.ws) send(p.ws, msg);
  else {
    pendingResults.set(p.user.id, msg);
    setTimeout(() => { if (pendingResults.get(p.user.id) === msg) pendingResults.delete(p.user.id); }, 600e3).unref();
  }
}

function modeOf(g) { return g.bot ? 'bot' : g.mode && g.mode !== 'classic' ? g.mode : g.friend ? 'friend' : g.ranked ? 'ranked' : 'casual'; }
const lastMode = L => L.botLevel ? 'bot' : L.mode && L.mode !== 'classic' ? L.mode : L.friend ? 'friend' : L.ranked ? 'ranked' : 'casual';
function pushElo(u, diff, elo, t) {
  const log = u.eloLog[diff] || (u.eloLog[diff] = [[u.createdAt, 1000]]);
  log.push([t, elo]);
  while (log.length > ELO_LOG_MAX) log.splice(1, 1);         // punkt startowy zostaje
}
function logHistory(u, e) {
  if (isGuest(u)) return;                                    // goście nie mają historii
  u.history.push(e);
  while (u.history.length > HISTORY_MAX) u.history.shift();
  for (let k = 0; k < u.history.length - RP_KEEP; k++) if (u.history[k].rp) delete u.history[k].rp;
}

function endGame(g, winnerIdx, reason, opts = {}) {
  if (g.over) return;
  g.over = true;
  clearTimeout(g.endTimer); if (g.bot) clearTimeout(g.bot.timer);
  const w = g.players[winnerIdx], l = g.players[1 - winnerIdx];
  const at = Date.now();
  const ms = Math.max(0, at - g.t0);
  const diff = g.diff, mode = modeOf(g);
  const wu = w.user, lu = l.user;

  // anty-bot: wygrana szybsza niż człowiek jest w stanie = mecz unieważniony
  const tooFast = g.ranked && reason === 'solved' && ms < g.empties * MIN_MS_PER_CELL;
  const voided = tooFast || !!opts.void;
  let wDelta = 0, lDelta = 0, wRank = null, lRank = null, eloGap = 0;
  if (tooFast) {
    wu.flags++;
    console.log('Mecz unieważniony (zbyt szybki):', wu.name, ms + 'ms', 'flagi:', wu.flags);
  }
  if (g.ranked && !voided) {                                 // tylko gra rankingowa zmienia Elo i statystyki
    const ws_ = wu.stats[diff], ls_ = lu.stats[diff];
    const wOld = ws_.elo, lOld = ls_.elo; eloGap = lOld - wOld;
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
  const boards0 = i => g.mode === 'rush' ? {} : ({ puz: g.puzzle.join(''), sol: g.solution.join(''), mine: g.cur[i].join(''), theirs: g.cur[1 - i].join(''), ...(g.rp && g.mode !== 'blitz' ? { rp: [g.rp[i], g.rp[1 - i]] } : {}) });   // do podglądu planszy z historii
  const boards = i => ({ ...boards0(i), ...(g.mode === 'blitz' || g.mode === 'rush' ? { sc: [g.score[i], g.score[1 - i]] } : {}) });
  logHistory(wu, { t: at, opp: lu.name, diff, mode, won: true, reason, ms, delta: wDelta, elo: eloAfter(wu), void: voided, ...boards(winnerIdx) });
  logHistory(lu, { t: at, opp: wu.name, diff, mode, won: false, reason, ms, delta: lDelta, elo: eloAfter(lu), void: voided, ...boards(1 - winnerIdx) });
  if (!voided) awardAfterGame(g, wu, lu, winnerIdx, reason, ms, eloGap);
  saveU(wu); saveU(lu);
  flushAch(wu); flushAch(lu);

  const base = { type: 'result', reason, ms, diff, mode: g.mode, ranked: g.ranked, friend: g.friend, void: voided, tie: !!opts.tie, secs: g.secs || undefined, bot: !!g.bot };
  deliver(w, { ...base, won: true, delta: wDelta, rank: wRank, score: [g.score[winnerIdx], g.score[1 - winnerIdx]], user: pub(wu) });
  deliver(l, { ...base, won: false, delta: lDelta, rank: lRank, score: [g.score[1 - winnerIdx], g.score[winnerIdx]], user: pub(lu) });
  w.last = { oppId: lu.id, oppIp: l.ip, diff, mode: g.mode, secs: g.secs, botLevel: g.bot ? g.bot.levelKey : undefined, ranked: g.ranked, friend: g.friend, at, ms };   // rewanż i zgłoszenie
  l.last = { oppId: wu.id, oppIp: w.ip, diff, mode: g.mode, secs: g.secs, botLevel: g.bot ? g.bot.levelKey : undefined, ranked: g.ranked, friend: g.friend, at, ms };
  for (const p of [w, l]) {
    clearTimeout(p.graceTimer);
    p.game = null; p.rematchWant = false;
    if (!p.ws) players.delete(p.user.id);
  }
  pushFriendsOf(wu); pushFriendsOf(lu);
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
    if (o.isBot) return notice(p, 'To bot – nie ma kogo zgłaszać. 🙂');
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

// ---------- profil, osiągnięcia, serie ----------
const AVATARS = ['🙂', '😎', '🤓', '🧠', '🦊', '🐼', '🐯', '🦁', '🐸', '🐙', '🦉', '🐺', '🦄', '🐲', '🚀', '⚡', '🔥', '🌈', '🎯', '♟️', '👑', '💎', '🍀', '🌙'];
const ACH = [
  { id: 'first_win',    icon: '🎯', name: 'Pierwsza wygrana',   desc: 'Wygraj dowolny pojedynek z człowiekiem.' },
  { id: 'wins_10',      icon: '🔟', name: '10 wygranych',       desc: 'Wygraj 10 pojedynków.' },
  { id: 'wins_50',      icon: '⭐', name: '50 wygranych',       desc: 'Wygraj 50 pojedynków.' },
  { id: 'wins_100',     icon: '🌟', name: '100 wygranych',      desc: 'Wygraj 100 pojedynków.' },
  { id: 'clean',        icon: '🧼', name: 'Czysta plansza',     desc: 'Wygraj klasyczny pojedynek bez ani jednego błędu.' },
  { id: 'comeback',     icon: '💪', name: 'Powrót',             desc: 'Wygraj, choć po drodze dostałeś blokadę za błąd.' },
  { id: 'speed',        icon: '🚀', name: 'Błyskawica',         desc: 'Wygraj klasyczną grę: Łatwy w 2:30, Średni w 4:00 albo Trudny w 7:00.' },
  { id: 'underdog',     icon: '🐺', name: 'Dawid i Goliat',     desc: 'Pokonaj w rankingu gracza z Elo wyższym o co najmniej 150.' },
  { id: 'hardcore',     icon: '💀', name: 'Bez litości',        desc: 'Wygraj grę Hardcore (bez podpowiedzi o błędach).' },
  { id: 'blitz_w',      icon: '⚡', name: 'Mistrz Blitza',      desc: 'Wygraj mecz w trybie Blitz.' },
  { id: 'line_w',       icon: '📏', name: 'Mistrz Linii',       desc: 'Wygraj mecz w trybie Linie.' },
  { id: 'sprint_w',     icon: '🏁', name: 'Mistrz Sprintu',     desc: 'Wygraj mecz w trybie Sprint.' },
  { id: 'rush_w',       icon: '⏱️', name: 'Mistrz Na czas',     desc: 'Wygraj mecz w trybie Na czas.' },
  { id: 'streak5',      icon: '🔥', name: 'Passa 5',            desc: 'Wygraj 5 meczów rankingowych z rzędu.' },
  { id: 'rank_silver',  icon: '🥈', name: 'Ranga Srebro',       desc: 'Osiągnij rangę Srebro na dowolnym poziomie.' },
  { id: 'rank_gold',    icon: '🥇', name: 'Ranga Złoto',        desc: 'Osiągnij rangę Złoto na dowolnym poziomie.' },
  { id: 'rank_diamond', icon: '💎', name: 'Ranga Diament',      desc: 'Osiągnij rangę Diament na dowolnym poziomie.' },
  { id: 'daily_1',      icon: '📅', name: 'Zagadka dnia',       desc: 'Rozwiąż swoją pierwszą Zagadkę dnia.' },
  { id: 'daily_3',      icon: '📆', name: 'Seria 3 dni',        desc: 'Rozwiązuj Zagadkę dnia 3 dni z rzędu.' },
  { id: 'daily_7',      icon: '🗓️', name: 'Seria 7 dni',        desc: 'Rozwiązuj Zagadkę dnia 7 dni z rzędu.' },
  { id: 'daily_30',     icon: '👑', name: 'Seria 30 dni',       desc: 'Rozwiązuj Zagadkę dnia 30 dni z rzędu.' },
  { id: 'club_join',    icon: '🛡️', name: 'Drużynowy gracz',    desc: 'Dołącz do klubu albo załóż własny.' },
  { id: 'season_medal', icon: '🏆', name: 'Medalista sezonu',   desc: 'Zakończ sezon w TOP 3 na dowolnym poziomie.' },
  { id: 'supporter',    icon: '💖', name: 'Wspierający',        desc: 'Dziękujemy za wsparcie gry!' }
];
const ACH_IDS = new Set(ACH.map(a => a.id));
function grantAch(u, id) {
  if (!ACH_IDS.has(id) || u.ach[id] || u.bot) return false;
  u.ach[id] = Date.now(); u.achNew.push(id); return true;
}
function flushAch(u) {
  if (!u.achNew.length) return;
  const p = players.get(u.id);
  if (p && p.ws) sendP(p, { type: 'ach', list: u.achNew });
}
const SPEED_MS = { easy: 150e3, medium: 240e3, hard: 420e3 };
function awardAfterGame(g, wu, lu, winnerIdx, reason, ms, eloGap) {
  if (g.bot || lu.bot || wu.bot || isGuest(wu)) return;
  const mode = g.mode;
  wu.cnt.wins = (wu.cnt.wins || 0) + 1;
  grantAch(wu, 'first_win');
  if (wu.cnt.wins >= 10) grantAch(wu, 'wins_10');
  if (wu.cnt.wins >= 50) grantAch(wu, 'wins_50');
  if (wu.cnt.wins >= 100) grantAch(wu, 'wins_100');
  const wrong = (g.wrongN || [0, 0])[winnerIdx];
  if (mode === 'classic' && reason === 'solved' && !g.blind) {
    if (wrong === 0) grantAch(wu, 'clean'); else grantAch(wu, 'comeback');
    if (SPEED_MS[g.diff] && ms <= SPEED_MS[g.diff]) grantAch(wu, 'speed');
  }
  if (g.blind && reason === 'solved') grantAch(wu, 'hardcore');
  if (g.ranked && eloGap >= 150) grantAch(wu, 'underdog');
  const mid = { blitz: 'blitz_w', line: 'line_w', sprint: 'sprint_w', rush: 'rush_w' }[mode];
  if (mid && reason !== 'disconnect') grantAch(wu, mid);
  if (g.ranked) {
    const st = wu.stats[g.diff];
    if (st.streak >= 5) grantAch(wu, 'streak5');
    const best = Math.max(...Object.values(wu.stats).map(x => rankIndex(x.elo)));
    if (best >= 1) grantAch(wu, 'rank_silver'); if (best >= 2) grantAch(wu, 'rank_gold'); if (best >= 3) grantAch(wu, 'rank_diamond');
  }
}
function prevDay(day) { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10); }
function bumpDailyStreak(u, day) {
  const s = u.dstreak;
  if (s.last === day) return;
  s.cur = s.last === prevDay(day) ? s.cur + 1 : 1; s.last = day; s.best = Math.max(s.best, s.cur);
  grantAch(u, 'daily_1'); if (s.cur >= 3) grantAch(u, 'daily_3'); if (s.cur >= 7) grantAch(u, 'daily_7'); if (s.cur >= 30) grantAch(u, 'daily_30');
}
const liveStreak = (u, today) => (u.dstreak.last === today || u.dstreak.last === prevDay(today)) ? u.dstreak.cur : 0;   // seria wygasa, gdy opuścisz dzień
const BIO_BAD = /(https?:|www\.|\w\.(com|pl|net|org|io|ly|me|gg|tv|xyz)\b|@\w|\b\d{9}\b)/i;

app.post('/api/me/profile', (req, res) => {
  const b = req.body || {}, u = userByToken(b.token);
  if (!u || isGuest(u)) return res.status(401).json({ error: 'Profil mają tylko konta.' });
  if (limited('mep:' + u.id, 20, 3600e3)) return res.status(429).json({ error: 'Za dużo zmian, spróbuj później.' });
  const bio = String(b.bio == null ? u.profile.bio : b.bio).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (bio && BIO_BAD.test(bio)) return res.status(400).json({ error: 'W opisie nie można wpisywać linków, adresów ani numerów.' });
  const avatar = b.avatar === undefined ? u.profile.avatar : String(b.avatar);
  if (!AVATARS.includes(avatar)) return res.status(400).json({ error: 'Nieznany awatar.' });
  const sc = Array.isArray(b.showcase) ? b.showcase : u.profile.showcase;
  const showcase = [...new Set(sc.map(String))].filter(id => u.ach[id]).slice(0, 3);
  u.profile = { bio, avatar, showcase }; saveU(u);
  res.json({ profile: u.profile });
});
app.post('/api/player', (req, res) => {
  if (limited('pl:' + ipOf(req), 60, 60e3)) return res.status(429).json({ error: 'Za dużo zapytań.' });
  const id = nameIndex.get(String((req.body || {}).name || '').trim().toLowerCase().slice(0, 40)), u = id && users.get(id);
  if (!u || u.bot || userBanned(u.id)) return res.status(404).json({ error: 'Nie ma takiego gracza.' });
  if (isGuest(u)) return res.json({ name: u.name, guest: true });
  const stats = {};
  for (const d of Object.keys(DIFFS)) { const x = u.stats[d]; stats[d] = { elo: x.elo, wins: x.wins, losses: x.losses, bestMs: x.bestMs || null }; }
  const cl = clubs.get(u.club);
  res.json({ name: u.name, guest: false, club: cl ? { id: cl.id, name: cl.name, tag: cl.tag, emoji: cl.emoji } : null, avatar: u.profile.avatar, bio: u.profile.bio, showcase: u.profile.showcase.filter(i => u.ach[i]), achCount: Object.keys(u.ach).length,
             streak: liveStreak(u, warsawDay()), bestStreak: u.dstreak.best, since: u.createdAt, stats,
             medals: [1, 2, 3].map(pl => u.badges.filter(x => x.place === pl).length) });
});
app.post('/api/admin/clear_bio', (req, res) => {
  if (!adminAuth(req, res)) return;
  const u = users.get(String((req.body || {}).userId || ''));
  if (!u) return res.status(404).json({ error: 'Nie ma takiego gracza.' });
  u.profile = { bio: '', avatar: '🙂', showcase: u.profile.showcase }; saveU(u); audit(req, 'clear_bio', u.name); res.json({ ok: true });
});

// ---------- kluby ----------
const CLUB_MAX = 30, CLUB_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{1,18}[\p{L}\p{N}]$/u;
const clubKey = n => String(n).toLowerCase().replace(/\s+/g, ' ');
const bestElo = u => Math.max(...Object.values(u.stats).filter(x => x.sgames > 0).map(x => x.elo), 1000);
const weeklyWins = u => { const lim = Date.now() - 7 * 86400e3; return u.history.filter(h => h.t > lim && h.won && !h.void && h.mode !== 'bot' && h.mode !== 'friend').length; };
const clubCache = new Map();
function clubStats(c) {
  const hit = clubCache.get(c.id); if (hit && Date.now() - hit.at < 60e3) return hit.v;
  const ms = c.members.map(id => users.get(id)).filter(Boolean);
  const rows = ms.map(u => ({ id: u.id, name: u.name, avatar: u.profile.avatar, elo: bestElo(u), weekly: weeklyWins(u), owner: u.id === c.ownerId, online: !!(players.get(u.id) || {}).ws }));
  rows.sort((a, b) => b.weekly - a.weekly || b.elo - a.elo);
  const top5 = rows.map(r => r.elo).sort((a, b) => b - a).slice(0, 5);
  const v = { rows, weekly: rows.reduce((n, r) => n + r.weekly, 0), avgElo: top5.length ? Math.round(top5.reduce((a, b) => a + b, 0) / top5.length) : 1000 };
  clubCache.set(c.id, { at: Date.now(), v }); return v;
}
const clubCard = c => { const st = clubStats(c); return { id: c.id, name: c.name, tag: c.tag, emoji: c.emoji, desc: c.desc, members: c.members.length, max: CLUB_MAX, weekly: st.weekly, avgElo: st.avgElo }; };
const clubFull = (c, viewer) => ({ ...clubCard(c), rows: clubStats(c).rows, mine: !!viewer && c.members.includes(viewer.id), owner: !!viewer && c.ownerId === viewer.id });
function clubAuth(req, res) {
  const u = userByToken((req.body || {}).token);
  if (!u) { res.status(401).json({ error: 'Odśwież stronę i spróbuj ponownie.' }); return null; }
  if (isGuest(u)) { res.status(403).json({ error: 'Kluby są dla zalogowanych graczy – załóż konto.' }); return null; }
  return u;
}
function dropClub(c) { for (const id of c.members) { const m = users.get(id); if (m) { m.club = null; saveU(m); } } clubs.delete(c.id); clubCache.delete(c.id); store.remove('clubs', c); }
function leaveClub(u) {
  const c = clubs.get(u.club); u.club = null; saveU(u); if (!c) return;
  c.members = c.members.filter(x => x !== u.id); clubCache.delete(c.id);
  if (!c.members.length) return dropClub(c);
  if (c.ownerId === u.id) { c.ownerId = clubStats(c).rows[0].id; clubCache.delete(c.id); }           // przywództwo przejmuje najaktywniejszy członek
  store.save('clubs', c);
}
const cleanTxt = (t, n) => String(t == null ? '' : t).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
app.post('/api/clubs/list', (req, res) => {
  const u = userByToken((req.body || {}).token);
  if (!u) return res.status(401).json({ error: 'Odśwież stronę i spróbuj ponownie.' });
  if (limited('cl:' + ipOf(req), 90, 60e3)) return res.status(429).json({ error: 'Za dużo zapytań.' });
  const q = clubKey(cleanTxt((req.body || {}).q, 30));
  let list = [...clubs.values()].filter(c => !q || clubKey(c.name).includes(q) || c.tag.toLowerCase() === q).map(clubCard)
    .sort((a, b) => b.weekly - a.weekly || b.avgElo - a.avgElo || b.members - a.members).slice(0, 30);
  const mine = clubs.get(u.club);
  res.json({ guest: isGuest(u), mine: mine ? clubFull(mine, u) : null, top: list });
});
app.post('/api/clubs/get', (req, res) => {
  const u = userByToken((req.body || {}).token), c = clubs.get(String((req.body || {}).id || ''));
  if (!u) return res.status(401).json({ error: 'Odśwież stronę i spróbuj ponownie.' });
  if (!c) return res.status(404).json({ error: 'Nie ma takiego klubu.' });
  res.json(clubFull(c, u));
});
app.post('/api/clubs/create', (req, res) => {
  const u = clubAuth(req, res); if (!u) return;
  const b = req.body; if (u.club && clubs.has(u.club)) return res.status(400).json({ error: 'Najpierw opuść obecny klub.' });
  const name = cleanTxt(b.name, 20), tag = String(b.tag || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4), desc = cleanTxt(b.desc, 100), emoji = AVATARS.includes(b.emoji) ? b.emoji : '🛡️';
  if (!CLUB_NAME_RE.test(name)) return res.status(400).json({ error: 'Nazwa: 3–20 znaków (litery, cyfry, spacja, - i _).' });
  if (tag.length < 2) return res.status(400).json({ error: 'Skrót klubu: 2–4 litery lub cyfry.' });
  if (desc && BIO_BAD.test(desc)) return res.status(400).json({ error: 'W opisie nie można wpisywać linków, adresów ani numerów.' });
  for (const c of clubs.values()) if (clubKey(c.name) === clubKey(name) || c.tag === tag) return res.status(409).json({ error: 'Klub o takiej nazwie lub skrócie już istnieje.' });
  if (limited('clc:' + u.id, 3, 86400e3)) return res.status(429).json({ error: 'Dziś założyłeś już kilka klubów, spróbuj jutro.' });
  const c = { id: crypto.randomUUID(), name, tag, emoji, desc, ownerId: u.id, members: [u.id], createdAt: Date.now() };
  clubs.set(c.id, c); store.save('clubs', c); u.club = c.id; grantAch(u, 'club_join'); saveU(u); flushAch(u);
  res.json(clubFull(c, u));
});
app.post('/api/clubs/join', (req, res) => {
  const u = clubAuth(req, res); if (!u) return;
  const c = clubs.get(String(req.body.id || ''));
  if (!c) return res.status(404).json({ error: 'Nie ma takiego klubu.' });
  if (u.club && clubs.has(u.club)) return res.status(400).json({ error: 'Najpierw opuść obecny klub.' });
  if (c.members.length >= CLUB_MAX) return res.status(400).json({ error: 'Klub jest pełny (' + CLUB_MAX + ' osób).' });
  if (limited('clj:' + u.id, 10, 3600e3)) return res.status(429).json({ error: 'Za dużo prób, spróbuj później.' });
  c.members.push(u.id); u.club = c.id; clubCache.delete(c.id); grantAch(u, 'club_join'); store.save('clubs', c); saveU(u); flushAch(u);
  res.json(clubFull(c, u));
});
app.post('/api/clubs/leave', (req, res) => {
  const u = clubAuth(req, res); if (!u) return;
  if (!u.club) return res.json({ ok: true });
  leaveClub(u); res.json({ ok: true });
});
app.post('/api/clubs/kick', (req, res) => {
  const u = clubAuth(req, res); if (!u) return;
  const c = clubs.get(u.club), t = users.get(String(req.body.userId || ''));
  if (!c || c.ownerId !== u.id) return res.status(403).json({ error: 'Tylko założyciel może usuwać członków.' });
  if (!t || t.id === u.id || !c.members.includes(t.id)) return res.status(404).json({ error: 'Nie ma takiego członka.' });
  leaveClub(t); res.json(clubFull(c, u));
});
app.post('/api/clubs/edit', (req, res) => {
  const u = clubAuth(req, res); if (!u) return;
  const c = clubs.get(u.club); if (!c || c.ownerId !== u.id) return res.status(403).json({ error: 'Tylko założyciel może edytować klub.' });
  const desc = cleanTxt(req.body.desc == null ? c.desc : req.body.desc, 100); if (desc && BIO_BAD.test(desc)) return res.status(400).json({ error: 'W opisie nie można wpisywać linków, adresów ani numerów.' });
  if (req.body.emoji !== undefined) { if (!AVATARS.includes(req.body.emoji)) return res.status(400).json({ error: 'Nieznana ikona.' }); c.emoji = req.body.emoji; }
  c.desc = desc; clubCache.delete(c.id); store.save('clubs', c); res.json(clubFull(c, u));
});
app.post('/api/clubs/disband', (req, res) => {
  const u = clubAuth(req, res); if (!u) return;
  const c = clubs.get(u.club); if (!c || c.ownerId !== u.id) return res.status(403).json({ error: 'Tylko założyciel może rozwiązać klub.' });
  dropClub(c); res.json({ ok: true });
});
app.get('/api/admin/clubs', (req, res) => {
  if (!adminAuth(req, res)) return;
  res.json([...clubs.values()].sort((a, b) => b.createdAt - a.createdAt).map(c => ({ id: c.id, name: c.name, tag: c.tag, emoji: c.emoji, desc: c.desc, members: c.members.length, owner: (users.get(c.ownerId) || {}).name || '?', createdAt: c.createdAt })));
});
app.post('/api/admin/club_delete', (req, res) => {
  if (!adminAuth(req, res)) return;
  const c = clubs.get(String((req.body || {}).id || ''));
  if (!c) return res.status(404).json({ error: 'Nie ma takiego klubu.' });
  audit(req, 'club_delete', c.name + ' [' + c.tag + ']'); dropClub(c); res.json({ ok: true });
});

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
  res.json({ name: u.name, stats, history: u.history.slice(-50).reverse(), eloLog: u.eloLog, badges: u.badges.slice().reverse(),
             profile: u.profile, ach: u.ach, streak: liveStreak(u, warsawDay()), bestStreak: u.dstreak.best });
});

// ---------- panel admina ----------
function roleOf(req) {
  const h = x => Buffer.from(sha(x)), k = h(req.headers['x-admin-key'] || '');
  if (OWNER_PASSWORD && crypto.timingSafeEqual(k, h(OWNER_PASSWORD))) return 'owner';
  if (ADMIN_PASSWORD && crypto.timingSafeEqual(k, h(ADMIN_PASSWORD))) return 'admin';
  return null;
}
function adminAuth(req, res, needOwner) {
  if (!ADMIN_PASSWORD && !OWNER_PASSWORD) { res.status(404).json({ error: 'Panel jest wyłączony (brak ADMIN_PASSWORD).' }); return false; }
  const ip = ipOf(req), key = 'adminfail:' + ip;
  const fails = (hits.get(key) || []).filter(t => Date.now() - t < 600e3);
  if (fails.length >= 10) { res.status(429).json({ error: 'Za dużo błędnych prób, spróbuj za kilka minut.' }); return false; }
  const role = roleOf(req);
  if (!role) { fails.push(Date.now()); hits.set(key, fails); res.status(401).json({ error: 'Zły klucz.' }); return false; }
  if (needOwner && role !== 'owner') { res.status(403).json({ error: 'Ta opcja jest tylko dla właściciela.' }); return false; }
  req.role = role; return true;
}
const ownerAuth = (req, res) => adminAuth(req, res, true);
function audit(req, action, detail) {                          // dziennik działań moderacji (ostatnie 200)
  if (!meta.audit) meta.audit = [];
  meta.audit.push({ at: Date.now(), role: req.role || '?', action, detail: String(detail || '').slice(0, 200) });
  if (meta.audit.length > 200) meta.audit.splice(0, meta.audit.length - 200);
  store.save('meta', meta);
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
  if (p.ws) { const bb = userBanned(userId) || {}; send(p.ws, { type: 'banned', reason: bb.reason || '', until: bb.until || null }); try { p.ws.close(4003, 'banned'); } catch {} }
}
app.get('/api/admin/overview', (req, res) => { if (adminAuth(req, res)) res.json(adminOverview()); });
app.get('/api/admin/user', (req, res) => {
  if (!adminAuth(req, res)) return;
  const id = nameIndex.get(String(req.query.name || '').toLowerCase());
  const u = id && users.get(id);
  if (!u) return res.status(404).json({ error: 'Nie ma takiego gracza.' });
  const games = Object.values(u.stats).reduce((n, x) => n + x.wins + x.losses, 0);
  res.json({ id: u.id, name: u.name, guest: isGuest(u), google: !!u.google, createdAt: u.createdAt, lastSeen: u.lastSeen,
             flags: u.flags, ranked: games, banned: !!userBanned(u.id), bio: u.profile.bio, avatar: u.profile.avatar,
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
    let hrs = Math.min(Math.max(+req.body.hours || 0, 0), 24 * 365);
    if (req.role !== 'owner') hrs = Math.min(hrs || 720, 720);                       // admin: maks. 30 dni, bez blokad na stałe
    ban = { id: crypto.randomUUID(), type: 'user', value: u.id, name: u.name, reason: why, at: Date.now(), until: hrs ? Date.now() + hrs * 3600e3 : null };
  } else if (type === 'ip') {
    const ip = String(req.body.ip || '').trim().slice(0, 64);
    if (!ip) return res.status(400).json({ error: 'Brak adresu IP.' });
    let hrs = Math.min(Math.max(+req.body.hours || (+req.body.days || 7) * 24, 1), 24 * 365);
    if (req.role !== 'owner') hrs = Math.min(hrs, 720);
    ban = { id: crypto.randomUUID(), type: 'ip', value: ip, name: ip, reason: why, at: Date.now(), until: Date.now() + hrs * 3600e3 };
  } else return res.status(400).json({ error: 'Zły typ blokady.' });
  indexBan(ban); store.save('bans', ban);
  audit(req, 'ban', ban.type + ' ' + ban.name + ' ' + (ban.until ? 'do ' + new Date(ban.until).toISOString().slice(0, 16) : 'na stałe') + ' – ' + ban.reason);
  if (ban.type === 'user') {
    for (const r of reports.values()) if (r.target.id === ban.value && r.status === 'open') { r.status = 'actioned'; store.save('reports', r); }
    kickUser(ban.value);
  } else {
    for (const p of [...players.values()]) if (p.ip === ban.value) kickUser(p.user.id);
  }
  res.json(adminOverview());
});
app.get('/api/admin/whoami', (req, res) => { if (adminAuth(req, res)) res.json({ role: req.role }); });
app.get('/api/admin/stats', (req, res) => {
  if (!ownerAuth(req, res)) return;
  const now = Date.now(); let reg = 0, guests = 0, a24 = 0, a7 = 0;
  for (const u of users.values()) { if (isGuest(u)) guests++; else reg++; if (now - u.lastSeen < 86400e3) a24++; if (now - u.lastSeen < 7 * 86400e3) a7++; }
  const live = [...players.values()].filter(q => q.ws), games = new Set(live.filter(q => q.game && !q.game.over).map(q => q.game));
  let queued = 0; for (const k in queues) for (const d in queues[k]) queued += queues[k][d].length;
  res.json({ registered: reg, guests, active24h: a24, active7d: a7, online: live.length, games: games.size, queued, rooms: rooms.size,
             openReports: [...reports.values()].filter(r => r.status === 'open').length, openFeedback: [...feedback.values()].filter(f => f.status === 'open').length,
             bans: [...banById.values()].filter(liveBan).length, season: meta.season, db: store.kind, uptimeMin: Math.round(process.uptime() / 60),
             announce: meta.announce && meta.announce.until > now ? meta.announce : null });
});
app.post('/api/admin/warn', (req, res) => {
  if (!adminAuth(req, res)) return;
  let u = users.get(String(req.body.userId || ''));
  if (!u && req.body.name) u = users.get(nameIndex.get(String(req.body.name).toLowerCase()));
  const text = String(req.body.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
  if (!u || isGuest(u) && false) return res.status(404).json({ error: 'Nie ma takiego gracza.' });
  if (!text) return res.status(400).json({ error: 'Wpisz treść ostrzeżenia.' });
  u.warning = { text, at: Date.now() }; saveU(u); audit(req, 'warn', u.name + ': ' + text);
  for (const r of reports.values()) if (r.target.id === u.id && r.status === 'open') { r.status = 'actioned'; store.save('reports', r); }
  const q = players.get(u.id); if (q && q.ws) sendP(q, { type: 'warning', text });
  res.json(adminOverview());
});
app.post('/api/admin/flags', (req, res) => {
  if (!adminAuth(req, res)) return;
  const u = users.get(String(req.body.userId || ''));
  if (!u) return res.status(404).json({ error: 'Nie ma takiego gracza.' });
  u.flags = 0; saveU(u); audit(req, 'flags', u.name); res.json({ ok: true });
});
app.post('/api/admin/announce', (req, res) => {
  if (!ownerAuth(req, res)) return;
  const text = String(req.body.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  const mins = Math.min(Math.max(+req.body.minutes || 60, 1), 1440);
  meta.announce = text ? { text, until: Date.now() + mins * 60e3 } : null;
  store.save('meta', meta);
  for (const q of players.values()) if (q.ws) sendP(q, { type: 'announce', text: text, until: meta.announce ? meta.announce.until : 0 });
  res.json({ ok: true, announce: meta.announce });
});
app.post('/api/admin/unban', (req, res) => {
  if (!adminAuth(req, res)) return;
  audit(req, 'unban', String((req.body || {}).id || ''));
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
      top.forEach((u, k) => { u.badges.push({ season: old, diff: d, place: k + 1, elo: u.stats[d].elo }); grantAch(u, 'season_medal'); });
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

// ================= BOT =================
// Bot gra jak człowiek: wstawia poprawne cyfry w losowym tempie, czasem się myli (i dostaje tę samą blokadę). Tylko gra towarzyska.
const BOT_LEVELS = {
  novice: { name: 'Bot Nowicjusz', mean: 7000, err: 0.06 },
  mid:    { name: 'Bot Amator',    mean: 4500, err: 0.03 },
  pro:    { name: 'Bot Mistrz',    mean: 2500, err: 0.01 }
};
const BOT_DIFF_MULT = { easy: 1, medium: 1.3, hard: 1.8 };      // średni czas na pole rośnie z trudnością
function startBotGame(p, diff, opts) {
  leaveAll(p);
  const lv = BOT_LEVELS[opts.level] || BOT_LEVELS.mid;
  const user = newUser(lv.name); user.bot = true;
  const bp = { user, ws: null, game: null, idx: -1, graceTimer: null, last: null, rematchWant: false, isBot: true, ip: '' };
  startGame(p, bp, diff, { ranked: false, mode: opts.mode, secs: opts.secs });
  const g = p.game;
  g.bot = { p: bp, idx: 1, level: lv, levelKey: opts.level, mult: BOT_DIFF_MULT[diff] || 1.5, timer: null };
  scheduleBot(g, g.startAt - Date.now());
}
function scheduleBot(g, lead = 0) {
  const B = g.bot; if (!B || g.over) return;
  B.timer = setTimeout(() => botTick(g), Math.max(700, lead + B.level.mean * B.mult * (0.5 + Math.random())));
}
function botTick(g) {
  const B = g.bot; if (!B || g.over) return;
  const i = B.idx, now = Date.now();
  if (now < g.startAt) return scheduleBot(g, g.startAt - now);
  const rb = g.rb && g.rb[i], puzzle = rb ? rb.puzzle : g.puzzle, cur = rb ? rb.cur : g.cur[i], sol = rb ? rb.solution : g.solution;
  const empty = [];
  for (let k = 0; k < 81; k++) if (!puzzle[k] && !cur[k]) empty.push(k);
  if (!empty.length) return scheduleBot(g);
  let pool = empty;
  if (g.mode === 'line' && g.units.length) {                  // w Liniach bot dokańcza te jednostki, którym brakuje najmniej pól
    const left = u => u.filter(k => !puzzle[k] && !cur[k]).length;
    const score = k => g.units.reduce((m, u) => u.includes(k) ? Math.min(m, left(u)) : m, 99);
    const best = Math.min(...empty.map(score));
    pool = empty.filter(k => score(k) === best);
  }
  const idx = pool[Math.floor(Math.random() * pool.length)];
  let v = sol[idx];
  const wrong = Math.random() < B.level.err;
  if (wrong) { do { v = 1 + Math.floor(Math.random() * 9); } while (v === sol[idx]); }
  handleMove(B.p, { r: (idx / 9) | 0, c: idx % 9, v });
  scheduleBot(g, wrong ? g.lockMs : 0);
}

// ================= ZNAJOMI I WYZWANIA =================
const FRIENDS_MAX = 50, REQUESTS_MAX = 20, CHALLENGE_TTL_MS = +process.env.CHALLENGE_TTL_MS || 60e3;
const onlineP = id => { const q = players.get(id); return q && q.ws ? q : null; };
const userByName = name => { const id = nameIndex.get(String(name || '').trim().toLowerCase().slice(0, 40)); return id ? users.get(id) : null; };
function friendsView(u) {
  const nm = id => { const f = users.get(id); return f && !userBanned(id) ? f.name : null; };
  const friends = u.friends.map(id => {
    const f = users.get(id); if (!f || userBanned(id)) return null;
    const q = onlineP(id); return { name: f.name, online: !!q, busy: !!(q && q.game) };
  }).filter(Boolean).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name, 'pl'));
  return { type: 'friends', friends, incoming: u.fin.map(nm).filter(Boolean), outgoing: u.fout.map(nm).filter(Boolean) };
}
function pushFriends(u) { const q = onlineP(u.id); if (q && !isGuest(u)) sendP(q, friendsView(u)); }
function pushFriendsOf(u) { if (isGuest(u)) return; for (const id of u.friends) { const f = users.get(id); if (f) pushFriends(f); } }
const without = (arr, id) => arr.filter(x => x !== id);

function friendAdd(p, m) {
  const me = p.user;
  if (isGuest(me)) return notice(p, 'Znajomych mogą mieć tylko gracze z kontem. Załóż konto.');
  if (limited('fadd:' + me.id, 20, 3600e3)) return notice(p, 'Za dużo zaproszeń, spróbuj później.');
  const t = userByName(m.name);
  if (!t || isGuest(t) || userBanned(t.id)) return notice(p, 'Nie ma gracza z takim nickiem (goście nie mają listy znajomych).');
  if (t.id === me.id) return notice(p, 'To Ty. 🙂');
  if (me.friends.includes(t.id)) return notice(p, t.name + ' jest już Twoim znajomym.');
  if (me.fout.includes(t.id)) return notice(p, 'Zaproszenie dla ' + t.name + ' już czeka na odpowiedź.');
  if (me.fin.includes(t.id)) return friendAccept(p, { name: t.name });           // on już zaprosił mnie: od razu znajomi
  if (me.friends.length >= FRIENDS_MAX) return notice(p, 'Masz maksymalną liczbę znajomych (' + FRIENDS_MAX + ').');
  if (me.fout.length >= REQUESTS_MAX || t.fin.length >= REQUESTS_MAX) return notice(p, 'Za dużo oczekujących zaproszeń.');
  me.fout.push(t.id); t.fin.push(me.id); saveU(me); saveU(t);
  notice(p, 'Wysłano zaproszenie do ' + t.name + '.');
  const tp = onlineP(t.id); if (tp) notice(tp, '👥 ' + me.name + ' zaprasza Cię do znajomych (zakładka Znajomi).');
  pushFriends(me); pushFriends(t);
}
function friendAccept(p, m) {
  const me = p.user, t = userByName(m.name);
  if (!t || !me.fin.includes(t.id)) return;
  if (me.friends.length >= FRIENDS_MAX || t.friends.length >= FRIENDS_MAX) return notice(p, 'Lista znajomych jest pełna.');
  me.fin = without(me.fin, t.id); t.fout = without(t.fout, me.id);
  me.fout = without(me.fout, t.id); t.fin = without(t.fin, me.id);
  if (!me.friends.includes(t.id)) me.friends.push(t.id);
  if (!t.friends.includes(me.id)) t.friends.push(me.id);
  saveU(me); saveU(t);
  notice(p, '🤝 ' + t.name + ' jest teraz Twoim znajomym.');
  const tp = onlineP(t.id); if (tp) notice(tp, '🤝 ' + me.name + ' przyjął(-ęła) Twoje zaproszenie.');
  pushFriends(me); pushFriends(t);
}
function friendDrop(p, m, how) {                 // decline: odrzucam zaproszenie do mnie, cancel: cofam swoje, remove: usuwam znajomego
  const me = p.user, t = userByName(m.name); if (!t) return;
  if (how === 'decline') { me.fin = without(me.fin, t.id); t.fout = without(t.fout, me.id); }
  else if (how === 'cancel') { me.fout = without(me.fout, t.id); t.fin = without(t.fin, me.id); }
  else {
    me.friends = without(me.friends, t.id); t.friends = without(t.friends, me.id);
    const ch = challenges.get(me.id); if (ch && ch.to === t.id) cancelChallenge(me.id);
    const ch2 = challenges.get(t.id); if (ch2 && ch2.to === me.id) cancelChallenge(t.id);
  }
  saveU(me); saveU(t); pushFriends(me); pushFriends(t);
}

// wyzwanie: tylko znajomy dla znajomego, 60 s na odpowiedź, zawsze bez rankingu
function cancelChallenge(fromId, why) {
  const ch = challenges.get(fromId); if (!ch) return;
  challenges.delete(fromId);
  const f = onlineP(fromId), tp = onlineP(ch.to), fu = users.get(fromId);
  if (tp && fu) sendP(tp, { type: 'challengeGone', from: fu.name });
  if (why && f) { notice(f, why); sendP(f, { type: 'idle' }); }
}
function dropChallengesTo(toId) {
  for (const [fid, ch] of challenges) if (ch.to === toId) cancelChallenge(fid, 'Znajomy się rozłączył – wyzwanie anulowane.');
}
function challengeSend(p, m) {
  const me = p.user;
  if (p.game || isGuest(me)) return;
  if (!DIFFS[m.diff]) return;
  const mode = MODES.includes(m.mode) ? m.mode : 'classic';
  if (mode !== 'classic' && DIFFS[m.diff].blind) return notice(p, 'Hardcore jest tylko w grze klasycznej.');
  if (limited('chal:' + me.id, 15, 60e3)) return notice(p, 'Za dużo wyzwań, poczekaj chwilę.');
  const t = userByName(m.name);
  if (!t || !me.friends.includes(t.id)) return notice(p, 'Wyzwać można tylko znajomych.');
  const tp = onlineP(t.id);
  if (!tp) return notice(p, t.name + ' jest offline.');
  if (tp.game) return notice(p, t.name + ' jest teraz w grze.');
  leaveAll(p);
  const secs = secsOf(m.secs);
  challenges.set(me.id, { to: t.id, diff: m.diff, mode, secs, at: Date.now() });
  sendP(p, { type: 'challengeSent', name: t.name, diff: m.diff, mode, secs, ttl: CHALLENGE_TTL_MS });
  sendP(tp, { type: 'challenge', from: me.name, diff: m.diff, mode, secs, ttl: CHALLENGE_TTL_MS });
}
function challengeFind(p, m) {
  const f = userByName(m.from); if (!f) return null;
  const ch = challenges.get(f.id);
  return ch && ch.to === p.user.id ? { f, ch } : null;
}
function challengeAccept(p, m) {
  const x = challengeFind(p, m);
  if (!x) return notice(p, 'To wyzwanie już wygasło.');
  const fp = onlineP(x.f.id);
  if (!fp || fp.game || p.game) { cancelChallenge(x.f.id, 'Wyzwanie nie jest już możliwe.'); return; }
  challenges.delete(x.f.id);
  startGame(fp, p, x.ch.diff, { ranked: false, friend: true, mode: x.ch.mode, secs: x.ch.secs });
}
function challengeDecline(p, m) {
  const x = challengeFind(p, m); if (!x) return;
  cancelChallenge(x.f.id, p.user.name + ' odrzucił(-a) wyzwanie.');
}

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
  bumpDailyStreak(u, daily.date); flushAch(u);
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
  if (!isGuest(u)) { out.streak = liveStreak(u, daily.date); out.bestStreak = u.dstreak.best; }
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
  for (const f of data.feedback || []) feedback.set(f.id, f);
  for (const c of data.clubs || []) clubs.set(c.id, c);
  for (const u of users.values()) if (u.club && !clubs.has(u.club)) u.club = null;
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
