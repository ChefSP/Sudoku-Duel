const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const REMOVE_CELLS = 50;        // ile pól usuwamy (50 = ok. 31 podpowiedzi, średni poziom)
const COUNTDOWN_MS = 3000;
const WRONG_LOCK_MS = 5000;     // kara za błędną cyfrę
const K = 32;                   // współczynnik Elo

// ---------- "baza danych" w pliku JSON ----------
let users = {};
try { users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(users), () => {}), 500);
}

// ---------- generator sudoku ----------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function canPlace(g, i, v) {
  const r = (i / 9) | 0, c = i % 9;
  for (let k = 0; k < 9; k++) if (g[r * 9 + k] === v || g[k * 9 + c] === v) return false;
  const br = r - (r % 3), bc = c - (c % 3);
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++) if (g[(br + a) * 9 + bc + b] === v) return false;
  return true;
}
function fillGrid(g) {
  const i = g.indexOf(0);
  if (i < 0) return true;
  for (const v of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
    if (canPlace(g, i, v)) {
      g[i] = v;
      if (fillGrid(g)) return true;
      g[i] = 0;
    }
  }
  return false;
}
function countSolutions(g, limit) {
  const i = g.indexOf(0);
  if (i < 0) return 1;
  let n = 0;
  for (let v = 1; v <= 9; v++) {
    if (canPlace(g, i, v)) {
      g[i] = v;
      n += countSolutions(g, limit - n);
      g[i] = 0;
      if (n >= limit) break;
    }
  }
  return n;
}
function generatePuzzle() {
  const solution = new Array(81).fill(0);
  fillGrid(solution);
  const puzzle = solution.slice();
  const order = shuffle([...Array(81).keys()]);
  let removed = 0;
  for (const idx of order) {
    if (removed >= REMOVE_CELLS) break;
    const keep = puzzle[idx];
    puzzle[idx] = 0;
    if (countSolutions(puzzle.slice(), 2) === 1) removed++;
    else puzzle[idx] = keep;
  }
  return { puzzle, solution };
}

// ---------- Elo ----------
function newElo(a, b, scoreA) {
  const ea = 1 / (1 + Math.pow(10, (b - a) / 400));
  return Math.round(a + K * (scoreA - ea));
}

// ---------- serwer ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/leaderboard', (req, res) => {
  const top = Object.values(users)
    .filter(u => u.wins + u.losses > 0)
    .sort((a, b) => b.elo - a.elo)
    .slice(0, 20)
    .map(u => ({ name: u.name, elo: u.elo, wins: u.wins, losses: u.losses }));
  res.json(top);
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let queue = [];       // { p, since }
let online = 0;

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function cleanName(n) {
  n = String(n || '').replace(/[<>&"'`]/g, '').trim().slice(0, 16);
  return n || 'Gracz' + Math.floor(Math.random() * 9000 + 1000);
}

wss.on('connection', ws => {
  const p = { ws, user: null, game: null, idx: -1 };
  online++;
  broadcastOnline();

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'hello') {
      let token = typeof m.token === 'string' && users[m.token] ? m.token : null;
      if (!token) {
        token = crypto.randomBytes(16).toString('hex');
        users[token] = { name: cleanName(m.name), elo: 1000, wins: 0, losses: 0 };
      } else if (m.name) {
        users[token].name = cleanName(m.name);
      }
      p.token = token;
      p.user = users[token];
      save();
      send(ws, { type: 'hello', token, name: p.user.name, elo: p.user.elo, wins: p.user.wins, losses: p.user.losses });
    }

    if (!p.user) return;

    if (m.type === 'queue' && !p.game && !queue.find(q => q.p === p)) {
      queue.push({ p, since: Date.now() });
      send(ws, { type: 'queued' });
    }
    if (m.type === 'cancel') {
      queue = queue.filter(q => q.p !== p);
      send(ws, { type: 'idle' });
    }
    if (m.type === 'move' && p.game) handleMove(p, m);
    if (m.type === 'resign' && p.game) endGame(p.game, 1 - p.idx, 'resign');
  });

  ws.on('close', () => {
    online--;
    broadcastOnline();
    queue = queue.filter(q => q.p !== p);
    if (p.game && !p.game.over) endGame(p.game, 1 - p.idx, 'disconnect');
  });
});

function broadcastOnline() {
  for (const c of wss.clients) send(c, { type: 'online', n: online });
}

// ---------- matchmaking: co sekundę, okno Elo rośnie z czasem czekania ----------
setInterval(() => {
  queue.sort((a, b) => a.p.user.elo - b.p.user.elo);
  for (let i = 0; i < queue.length - 1; i++) {
    const a = queue[i], b = queue[i + 1];
    const waited = (Date.now() - Math.min(a.since, b.since)) / 1000;
    const window = 100 + waited * 50;
    if (Math.abs(a.p.user.elo - b.p.user.elo) <= window) {
      queue.splice(i, 2);
      startGame(a.p, b.p);
      i--;
    }
  }
}, 1000);

function startGame(p0, p1) {
  const { puzzle, solution } = generatePuzzle();
  const empties = puzzle.filter(v => v === 0).length;
  const game = {
    players: [p0, p1],
    puzzle, solution, empties,
    cur: [puzzle.slice(), puzzle.slice()],
    filled: [0, 0],
    lockedUntil: [0, 0],
    startAt: Date.now() + COUNTDOWN_MS,
    over: false
  };
  [p0, p1].forEach((p, i) => { p.game = game; p.idx = i; });
  [p0, p1].forEach((p, i) => {
    const o = game.players[1 - i];
    send(p.ws, {
      type: 'match',
      puzzle,
      empties,
      startIn: COUNTDOWN_MS,
      opp: { name: o.user.name, elo: o.user.elo }
    });
  });
}

function handleMove(p, m) {
  const g = p.game, i = p.idx;
  if (g.over || Date.now() < g.startAt) return;
  const r = m.r | 0, c = m.c | 0, v = m.v | 0;
  if (r < 0 || r > 8 || c < 0 || c > 8 || v < 1 || v > 9) return;
  const now = Date.now();
  if (now < g.lockedUntil[i]) return;
  const idx = r * 9 + c;
  if (g.cur[i][idx] !== 0) return;

  if (g.solution[idx] === v) {
    g.cur[i][idx] = v;
    g.filled[i]++;
    send(p.ws, { type: 'ok', r, c, v, filled: g.filled[i] });
    send(g.players[1 - i].ws, { type: 'opp', filled: g.filled[i] });
    if (g.filled[i] >= g.empties) endGame(g, i, 'solved');
  } else {
    g.lockedUntil[i] = now + WRONG_LOCK_MS;
    send(p.ws, { type: 'wrong', r, c, lockMs: WRONG_LOCK_MS });
  }
}

function endGame(g, winnerIdx, reason) {
  if (g.over) return;
  g.over = true;
  const w = g.players[winnerIdx], l = g.players[1 - winnerIdx];
  const wOld = w.user.elo, lOld = l.user.elo;
  w.user.elo = newElo(wOld, lOld, 1);
  l.user.elo = newElo(lOld, wOld, 0);
  w.user.wins++;
  l.user.losses++;
  save();
  const ms = Date.now() - g.startAt;
  send(w.ws, { type: 'result', won: true, reason, ms, elo: w.user.elo, delta: w.user.elo - wOld });
  send(l.ws, { type: 'result', won: false, reason, ms, elo: l.user.elo, delta: l.user.elo - lOld });
  w.game = null; l.game = null;
}

server.listen(PORT, () => console.log('Sudoku Duel działa na porcie ' + PORT));
