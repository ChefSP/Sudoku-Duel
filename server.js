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

const DIFFS = {
  easy:   { label: 'Łatwy',   remove: 38 },
  medium: { label: 'Średni',  remove: 48 },
  hard:   { label: 'Trudny',  remove: 55 }
};
const COUNTDOWN_MS = 3000;
const WRONG_LOCK_MS = 4000;       // kara za błędną cyfrę
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

function cleanGuestName(n) {
  n = String(n || '').replace(/[^\p{L}\p{N}_\- ]/gu, '').trim().slice(0, 16);
  return n || 'Gracz' + Math.floor(Math.random() * 9000 + 1000);
}
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
const nameIndex = new Map();      // nick małymi literami -> userId (tylko konta założone, nie goście)

function newUser(name) {
  const now = Date.now();
  const st = () => ({ elo: 1000, wins: 0, losses: 0 });
  return {
    id: crypto.randomUUID(), name, pass: null, google: null, sessions: [],
    stats: { easy: st(), medium: st(), hard: st() },
    flags: 0, createdAt: now, lastSeen: now
  };
}
const isGuest = u => !u.pass && !u.google;
function indexUser(u) {
  for (const s of u.sessions) sessionIndex.set(s, u.id);
  if (!isGuest(u)) nameIndex.set(u.name.toLowerCase(), u.id);
}

function makeJsonStore() {
  let timer = null;
  const write = () => {
    const data = JSON.stringify({ version: 2, users: [...users.values()] });
    fs.writeFile(DATA_FILE + '.tmp', data, err => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(write, 500); };
  return {
    kind: 'plik JSON',
    async load() {
      let raw;
      try { raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
      if (raw && raw.version === 2) return raw.users;
      // stary format: { token: {name, elo, wins, losses} }
      return Object.entries(raw || {}).map(([token, o]) => {
        const u = newUser(cleanGuestName(o.name));
        u.stats.medium = { elo: o.elo || 1000, wins: o.wins || 0, losses: o.losses || 0 };
        u.sessions = [sha(token)];
        return u;
      });
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
  return {
    kind: 'Postgres',
    async load() {
      await pool.query('CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, data jsonb NOT NULL)');
      const r = await pool.query('SELECT data FROM users');
      return r.rows.map(x => x.data);
    },
    save(user) {
      pool.query(
        'INSERT INTO users (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
        [user.id, JSON.stringify(user)]
      ).catch(e => console.error('pg save:', e.message));
    },
    remove(user) {
      pool.query('DELETE FROM users WHERE id = $1', [user.id]).catch(e => console.error('pg delete:', e.message));
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
  if (u) { u.sessions = u.sessions.filter(s => s !== h); store.save(u); }
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
function makeRegistered(user, name) {   // nadaje nazwę i indeksuje
  if (!isGuest(user)) nameIndex.delete(user.name.toLowerCase());
  user.name = name;
}
function pub(u) {
  return { name: u.name, guest: isGuest(u), google: !!u.google, stats: u.stats };
}

// ================= HTTP =================
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, turnstileSiteKey: TURNSTILE_SITE_KEY || null,
             diffs: Object.fromEntries(Object.entries(DIFFS).map(([k, v]) => [k, v.label])) });
});

app.get('/api/leaderboard', (req, res) => {
  const diff = DIFFS[req.query.diff] ? req.query.diff : 'medium';
  const top = [...users.values()]
    .filter(u => u.stats[diff].wins + u.stats[diff].losses > 0 && u.flags < FLAGS_HIDE)
    .sort((a, b) => b.stats[diff].elo - a.stats[diff].elo)
    .slice(0, 20)
    .map(u => ({ name: u.name, elo: u.stats[diff].elo, wins: u.stats[diff].wins, losses: u.stats[diff].losses }));
  res.json(top);
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
  store.save(user);
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
  res.json({ token: newSession(user) });
  store.save(user);
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
  const t = newSession(user);
  store.save(user);
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
const queues = { easy: [], medium: [], hard: [] };
const pendingResults = new Map();                 // userId -> wiadomość (gdy gracz był offline w chwili końca meczu)
const ipConns = new Map();

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function sendP(p, obj) { send(p.ws, obj); }
function dequeue(p) { for (const d in queues) queues[d] = queues[d].filter(q => q.p !== p); }
function onlineCount() { let n = 0; for (const p of players.values()) if (p.ws) n++; return n; }
function broadcastOnline() {
  const n = onlineCount();
  for (const c of wss.clients) send(c, { type: 'online', n });
}

wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  if ((ipConns.get(ip) || 0) >= MAX_CONN_PER_IP) { ws.close(1008, 'limit'); return; }
  ipConns.set(ip, (ipConns.get(ip) || 0) + 1);

  let msgCount = 0, msgTick = Date.now();
  ws.p = null;

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

    if (m.type === 'name' && isGuest(p.user)) {
      const n = cleanGuestName(m.name);
      if (nameFree(n)) { p.user.name = n; store.save(p.user); }
      sendP(p, { type: 'me', user: pub(p.user) });
    }
    else if (m.type === 'queue') {
      if (p.game || !DIFFS[m.diff]) return;
      dequeue(p);
      queues[m.diff].push({ p, since: Date.now() });
      sendP(p, { type: 'queued', diff: m.diff });
    }
    else if (m.type === 'cancel') { dequeue(p); sendP(p, { type: 'idle' }); }
    else if (m.type === 'move' && p.game) handleMove(p, m);
    else if (m.type === 'resign' && p.game) endGame(p.game, 1 - p.idx, 'resign');
  });

  ws.on('close', () => {
    ipConns.set(ip, Math.max(0, (ipConns.get(ip) || 1) - 1));
    const p = ws.p;
    if (!p || p.ws !== ws) return;          // to połączenie zostało już zastąpione nowym
    p.ws = null;
    dequeue(p);
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
    user = newUser(cleanGuestName(m.name));
    users.set(user.id, user);
    token = newSession(user);
    store.save(user);
  } else if (Date.now() - user.lastSeen > 3600e3) {
    user.lastSeen = Date.now();
    store.save(user);
  }
  user.lastSeen = Date.now();

  let p = players.get(user.id);
  if (p && p.ws && p.ws !== ws) {           // to samo konto w drugiej karcie: nowa przejmuje
    send(p.ws, { type: 'replaced' });
    const old = p.ws; p.ws = null;
    try { old.close(4000, 'replaced'); } catch {}
  }
  if (!p) { p = { user, ws: null, game: null, idx: -1, graceTimer: null }; players.set(user.id, p); }
  p.user = user; p.ws = ws; ws.p = p;
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

// ---------- matchmaking: co sekundę, okno Elo rośnie z czasem czekania ----------
setInterval(() => {
  for (const diff of Object.keys(queues)) {
    const q = queues[diff];
    if (q.length < 2) continue;
    q.sort((a, b) => a.p.user.stats[diff].elo - b.p.user.stats[diff].elo);
    for (let i = 0; i < q.length - 1; i++) {
      const a = q[i], b = q[i + 1];
      const waited = (Date.now() - Math.min(a.since, b.since)) / 1000;
      const win = 100 + waited * 50;
      if (Math.abs(a.p.user.stats[diff].elo - b.p.user.stats[diff].elo) <= win) {
        q.splice(i, 2);
        startGame(a.p, b.p, diff);
        i--;
      }
    }
  }
}, 1000).unref();

function startGame(p0, p1, diff) {
  const { puzzle, solution } = generatePuzzle(diff);
  const game = {
    diff, players: [p0, p1], puzzle, solution,
    empties: puzzle.filter(v => v === 0).length,
    cur: [puzzle.slice(), puzzle.slice()],
    filled: [0, 0], lockedUntil: [0, 0], lastMove: [0, 0],
    startAt: Date.now() + COUNTDOWN_MS, over: false
  };
  [p0, p1].forEach((p, i) => { p.game = game; p.idx = i; });
  [p0, p1].forEach((p, i) => sendP(p, matchPayload(game, i)));
}

function matchPayload(g, i) {
  const now = Date.now(), o = g.players[1 - i];
  return {
    type: 'match', diff: g.diff, puzzle: g.puzzle, cur: g.cur[i], empties: g.empties,
    elapsed: now - g.startAt,                          // ujemne = trwa odliczanie
    filled: g.filled[i], oppFilled: g.filled[1 - i],
    lockMs: Math.max(0, g.lockedUntil[i] - now),
    opp: { name: o.user.name, elo: o.user.stats[g.diff].elo },
    oppOnline: !!o.ws
  };
}

function handleMove(p, m) {
  const g = p.game, i = p.idx, now = Date.now();
  if (g.over || now < g.startAt) return;
  const r = m.r | 0, c = m.c | 0, v = m.v | 0;
  if (r < 0 || r > 8 || c < 0 || c > 8 || v < 1 || v > 9) return;
  if (now - g.lastMove[i] < MIN_MOVE_MS) return;     // anty-bot: nierealnie szybkie ruchy
  if (now < g.lockedUntil[i]) return;
  const idx = r * 9 + c;
  if (g.cur[i][idx] !== 0) return;
  g.lastMove[i] = now;

  if (g.solution[idx] === v) {
    g.cur[i][idx] = v;
    g.filled[i]++;
    sendP(p, { type: 'ok', r, c, v, filled: g.filled[i] });
    sendP(g.players[1 - i], { type: 'opp', filled: g.filled[i] });
    if (g.filled[i] >= g.empties) endGame(g, i, 'solved');
  } else {
    g.lockedUntil[i] = now + WRONG_LOCK_MS;
    sendP(p, { type: 'wrong', r, c, lockMs: WRONG_LOCK_MS });
  }
}

function deliver(p, msg) {
  if (p.ws) send(p.ws, msg);
  else {
    pendingResults.set(p.user.id, msg);
    setTimeout(() => { if (pendingResults.get(p.user.id) === msg) pendingResults.delete(p.user.id); }, 600e3).unref();
  }
}

function endGame(g, winnerIdx, reason) {
  if (g.over) return;
  g.over = true;
  const w = g.players[winnerIdx], l = g.players[1 - winnerIdx];
  const ms = Math.max(0, Date.now() - g.startAt);
  const diff = g.diff;
  const wu = w.user, lu = l.user, ws_ = wu.stats[diff], ls_ = lu.stats[diff];

  // anty-bot: wygrana szybsza niż człowiek jest w stanie = mecz unieważniony
  const voided = reason === 'solved' && ms < g.empties * MIN_MS_PER_CELL;
  let wDelta = 0, lDelta = 0;
  if (voided) {
    wu.flags++;
    console.log('Mecz unieważniony (zbyt szybki):', wu.name, ms + 'ms', 'flagi:', wu.flags);
  } else {
    const wOld = ws_.elo, lOld = ls_.elo;
    ws_.elo = newElo(wOld, lOld, 1); ls_.elo = newElo(lOld, wOld, 0);
    ws_.wins++; ls_.losses++;
    wDelta = ws_.elo - wOld; lDelta = ls_.elo - lOld;
  }
  store.save(wu); store.save(lu);

  deliver(w, { type: 'result', won: true, reason, ms, diff, void: voided, delta: wDelta, user: pub(wu) });
  deliver(l, { type: 'result', won: false, reason, ms, diff, void: voided, delta: lDelta, user: pub(lu) });
  for (const p of [w, l]) {
    clearTimeout(p.graceTimer);
    p.game = null;
    if (!p.ws) players.delete(p.user.id);
  }
}

// sprzątanie: goście bez ani jednego meczu, nieaktywni od 7 dni
setInterval(() => {
  const limit = Date.now() - 7 * 86400e3;
  for (const u of [...users.values()]) {
    const games = Object.values(u.stats).reduce((s, x) => s + x.wins + x.losses, 0);
    if (isGuest(u) && games === 0 && u.lastSeen < limit && !players.has(u.id)) {
      users.delete(u.id);
      u.sessions.forEach(s => sessionIndex.delete(s));
      store.remove(u);
    }
  }
}, 3600e3).unref();

// ================= START =================
async function main() {
  for (const u of await store.load()) { users.set(u.id, u); indexUser(u); }
  console.log(`Baza: ${store.kind}, użytkowników: ${users.size}`);
  server.listen(PORT, () => console.log('Sudoku Duel działa na porcie ' + PORT));
}
if (require.main === module || process.env.SUDOKU_TEST) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { generatePuzzle, countSolutions, DIFFS };
