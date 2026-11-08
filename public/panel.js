
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let key = ''; try { key = sessionStorage.getItem('akey') || ''; } catch {}
const REASON = { cheat: '🤖 bot / oszustwo', abuse: '💬 obraźliwy nick', other: '❓ inne' };
const MODE = { ranked: 'rankingowa', casual: 'towarzyska', friend: 'ze znajomym', blitz: 'Blitz', line: 'Linie', sprint: 'Sprint', rush: 'Na czas', bot: 'z botem' };
const fmtT = t => new Date(t).toLocaleString('pl-PL', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
const fmtMs = ms => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
let data = null, role = 'admin';

async function api(path, body){
  const r = await fetch('/api/admin/' + path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ 'x-admin-key': key }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Błąd ' + r.status);
  return d;
}
async function load(){
  try { data = await api('overview'); } catch (e) {
    $('panel').classList.add('hidden'); $('login').classList.remove('hidden'); $('lerr').textContent = e.message; return false;
  }
  const w = await api('whoami').catch(() => ({})); role = w.role || 'admin';
  if (window.PANEL === 'owner' && role !== 'owner'){ $('panel').classList.add('hidden'); $('login').classList.remove('hidden'); $('lerr').textContent = 'To nie jest hasło właściciela.'; return false; }
  $('login').classList.add('hidden'); $('panel').classList.remove('hidden'); render(); if (role === 'owner' && window.PANEL === 'owner') initOwner(); loadStats(); loadFeedback(); return true;
}
function render(){
  $('status').textContent = 'Zgłoszeń do przejrzenia: ' + data.reports.length + ' · blokad: ' + data.bans.length;
  $('reports').innerHTML = data.reports.length ? '' : '<div class="card muted">Brak otwartych zgłoszeń. 🎉</div>';
  data.reports.forEach((g, gi) => {
    const el = document.createElement('div'); el.className = 'card';
    const reasons = Object.entries(g.reasons).map(([k, n]) => '<span class="tag red">' + (REASON[k] || k) + ' ×' + n + '</span>').join('');
    el.innerHTML = '<b>' + esc(g.name) + '</b> ' + (g.guest ? '<span class="tag">gość</span>' : '') + (g.banned ? '<span class="tag red">zablokowany</span>' : '')
      + (g.flags ? '<span class="tag gold">unieważnione mecze: ' + g.flags + '</span>' : '')
      + '<div class="muted" style="margin:6px 0">Zgłoszeń: <b>' + g.count + '</b> · ostatnie: ' + fmtT(g.lastAt) + (g.ip ? ' · IP: ' + esc(g.ip) : '') + '</div>' + reasons
      + g.reports.map(r => '<div class="rep">' + (REASON[r.reason] || r.reason) + ' · od <b>' + esc(r.reporter) + '</b>' + (r.reporterGuest ? ' (gość)' : '')
        + ' · ' + fmtT(r.at) + (r.match ? '<div class="muted">mecz: ' + (MODE[r.match.mode] || '') + ', ' + esc(r.match.diff) + (r.match.ms ? ', ' + fmtMs(r.match.ms) : '') + (r.match.live ? ' (w trakcie)' : '') + '</div>' : '')
        + (r.note ? '<div>„' + esc(r.note) + '”</div>' : '') + '</div>').join('')
      + '<div class="row"></div>';
    const row = el.querySelector('.row');
    const mk = (txt, cls, fn) => { const b = document.createElement('button'); b.textContent = txt; if (cls) b.className = cls; b.onclick = fn; row.appendChild(b); };
    if (!g.banned) mk('🚫 Zablokuj konto', 'red', () => ban({ type:'user', userId: g.targetId }, g.name));
    if (g.ip) mk('🌐 Zablokuj IP', 'red', () => ban({ type:'ip', ip: g.ip }, g.ip));
    mk('⚠ Ostrzeż', 'sec', () => warn({ id: g.targetId, name: g.name }));
    mk('Odrzuć zgłoszenia', 'sec', () => act('dismiss', { targetId: g.targetId }));
    $('reports').appendChild(el);
  });
  $('bans').innerHTML = data.bans.length
    ? '<tr><th>Co</th><th>Powód</th><th>Od</th><th>Do</th><th></th></tr>' + data.bans.map(b =>
        '<tr><td>' + (b.type === 'ip' ? '🌐 ' : '👤 ') + esc(b.name) + '</td><td>' + esc(b.reason) + '</td><td>' + fmtT(b.at) + '</td><td>' + (b.until ? fmtT(b.until) : 'bezterminowo')
        + '</td><td><button class="sec" data-id="' + esc(b.id) + '">Odblokuj</button></td></tr>').join('')
    : '<tr><td class="muted">Brak blokad.</td></tr>';
  $('bans').querySelectorAll('button[data-id]').forEach(b => b.onclick = () => { if (confirm('Odblokować?')) act('unban', { id: b.dataset.id }); });
}
async function act(path, body){
  try { data = await api(path, body); render(); } catch (e) { alert(e.message); }
}
function modal(html){
  const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = '<div class="card">' + html + '</div>';
  m.onclick = e => { if (e.target === m) m.remove(); }; document.body.appendChild(m); return m;
}
function ban(body, label){
  const m = modal('<b>Blokada: ' + esc(label) + '</b><input type="text" id="bReason" placeholder="Powód (widzi go gracz)" value="' + (body.type === 'ip' ? 'Naruszenie regulaminu' : 'Oszustwo / naruszenie regulaminu') + '" style="margin-top:8px">'
    + '<select id="bHours"><option value="1">1 godzina</option><option value="24">24 godziny</option><option value="72">3 dni</option><option value="168" selected>7 dni</option><option value="720">30 dni</option>' + (body.type === 'ip' ? '' : '<option value="0">Na stałe</option>') + '</select>'
    + '<div class="row"><button class="red" id="bOk">Zablokuj</button><button class="sec" id="bNo">Anuluj</button></div>');
  m.querySelector('#bNo').onclick = () => m.remove();
  m.querySelector('#bOk').onclick = () => { const reason = m.querySelector('#bReason').value, hours = +m.querySelector('#bHours').value; m.remove(); act('ban', Object.assign({ reason, hours }, body)); };
}
function warn(u){
  const m = modal('<b>Ostrzeżenie dla ' + esc(u.name) + '</b><textarea id="wTxt" rows="3" maxlength="300" placeholder="Treść – gracz zobaczy ją w oknie i musi kliknąć „Rozumiem”"></textarea>'
    + '<div class="row"><button id="wOk">Wyślij</button><button class="sec" id="wNo">Anuluj</button></div>');
  m.querySelector('#wNo').onclick = () => m.remove();
  m.querySelector('#wOk').onclick = async () => { const text = m.querySelector('#wTxt').value.trim(); if (!text) return; m.remove(); await act('warn', { userId: u.id, text }); alert('Ostrzeżenie wysłane.'); };
}
const KIND = { bug: '🐞 Błąd', idea: '💡 Pomysł', other: '💬 Inne' };
let fbOnlyOpen = false, blobs = [];
let loadStats = async () => {};
async function loadFeedback(){
  blobs.forEach(u => URL.revokeObjectURL(u)); blobs = [];
  let list; try { list = await api('feedback'); } catch (e) { $('fbList').textContent = e.message; return; }
  if (fbOnlyOpen) list = list.filter(f => f.status === 'open');
  $('fbList').innerHTML = list.length ? '' : '<div class="card muted">Brak zgłoszeń.</div>';
  list.forEach(f => {
    const el = document.createElement('div'); el.className = 'card fb';
    el.innerHTML = '<span class="tag' + (f.kind === 'bug' ? ' red' : '') + '">' + KIND[f.kind] + '</span><b>' + esc(f.name) + '</b> ' + (f.guest ? '<span class="tag">gość</span>' : '') + (f.status === 'done' ? '<span class="tag">załatwione</span>' : '')
      + '<div class="muted">' + fmtT(f.at) + ' · ' + esc(f.ctx.screen) + ' · ' + esc(f.ctx.url) + '</div><div style="margin-top:6px;white-space:pre-wrap">' + esc(f.text) + '</div>'
      + (f.ctx.ua ? '<div class="muted" style="margin-top:4px;word-break:break-all">' + esc(f.ctx.ua) + '</div>' : '')
      + (f.media && f.media.gone ? '<div class="muted">Załącznik został usunięty (limit miejsca).</div>' : '')
      + (f.media && f.media.id ? '<div class="row"><button class="sec" data-m="1">📎 Pokaż załącznik (' + (f.media.mime.startsWith('video') ? 'wideo' : 'zrzut') + ', ' + Math.round(f.media.size / 1024) + ' KB)</button></div><div class="mediaBox"></div>' : '')
      + '<div class="row"><button class="sec" data-s="1">' + (f.status === 'done' ? 'Otwórz ponownie' : '✔ Załatwione') + '</button><button class="red" data-d="1">Usuń</button></div>';
    const mb = el.querySelector('[data-m]');
    if (mb) mb.onclick = async () => {
      try {
        const r = await fetch('/api/admin/media/' + f.media.id, { headers: { 'x-admin-key': key } }); if (!r.ok) throw new Error('Brak pliku');
        const url = URL.createObjectURL(await r.blob()); blobs.push(url);
        const box = el.querySelector('.mediaBox'); box.innerHTML = '';
        const n = document.createElement(f.media.mime.startsWith('video') ? 'video' : 'img'); n.src = url; if (n.tagName === 'VIDEO') n.controls = true; box.appendChild(n); mb.remove();
      } catch (e) { alert(e.message); }
    };
    el.querySelector('[data-s]').onclick = async () => { try { await api('feedback/status', { id: f.id, status: f.status === 'done' ? 'open' : 'done' }); loadFeedback(); loadStats(); } catch (e) { alert(e.message); } };
    el.querySelector('[data-d]').onclick = async () => { if (!confirm('Usunąć zgłoszenie razem z załącznikiem?')) return; try { await api('feedback/delete', { id: f.id }); loadFeedback(); loadStats(); } catch (e) { alert(e.message); } };
    $('fbList').appendChild(el);
  });
}
$('fbAll').onclick = () => { fbOnlyOpen = false; loadFeedback(); };
$('fbOpen').onclick = () => { fbOnlyOpen = true; loadFeedback(); };

$('go').onclick = async () => {
  key = $('key').value; try { sessionStorage.setItem('akey', key); } catch {}
  $('lerr').textContent = ''; await load();
};
$('key').onkeydown = e => { if (e.key === 'Enter') $('go').click(); };
$('refresh').onclick = load;
$('logout').onclick = () => { key = ''; try { sessionStorage.removeItem('akey'); } catch {} $('panel').classList.add('hidden'); $('login').classList.remove('hidden'); };
$('qgo').onclick = async () => {
  const name = $('qname').value.trim(); if (!name) return;
  try {
    const u = await api('user?name=' + encodeURIComponent(name));
    $('qres').innerHTML = '<b style="color:var(--text)">' + esc(u.name) + '</b> ' + (u.guest ? '<span class="tag">gość</span>' : '') + (u.banned ? '<span class="tag red">zablokowany</span>' : '')
      + '<div>Założone: ' + fmtT(u.createdAt) + ' · ostatnio: ' + fmtT(u.lastSeen) + ' · mecze rankingowe: ' + u.ranked + ' · unieważnione: ' + u.flags + '</div>'
      + '<div>' + Object.entries(u.stats).map(([d, s]) => esc(d) + ': Elo ' + s.elo + ' (' + s.wins + '/' + s.losses + ')').join(' · ') + '</div>'
      + '<div class="row">' + (u.banned ? '' : '<button class="red" id="qban">🚫 Zablokuj konto</button>') + '<button class="sec" id="qwarn">⚠ Ostrzeż</button>' + (u.flags ? '<button class="sec" id="qflag">Wyzeruj unieważnione (' + u.flags + ')</button>' : '') + '</div>';
    const b = $('qban'); if (b) b.onclick = () => ban({ type:'user', userId: u.id }, u.name);
    $('qwarn').onclick = () => warn(u);
    const fl = $('qflag'); if (fl) fl.onclick = async () => { try { await api('flags', { userId: u.id }); $('qgo').click(); } catch (e) { alert(e.message); } };
  } catch (e) { $('qres').textContent = e.message; }
};
if (key) load();


// ================= panel właściciela =================
const OMODES = { classic: 'Klasyczny', blitz: 'Blitz', line: 'Linie', sprint: 'Sprint', rush: 'Na czas' };
const DIFFN = { easy: 'Łatwy', medium: 'Średni', hard: 'Trudny', hardcore: 'Hardcore' };
async function oapi(path, body){
  const r = await fetch('/api/owner/' + path, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'x-admin-key': key }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Błąd ' + r.status); return d;
}
const oerr = e => alert(e.message);
let liveT = null;
function initOwner(){
  const A = $('ownerArea'); if (A.dataset.ready){ loadStats(); return; } A.dataset.ready = '1';
  A.innerHTML = `
  <h2>📊 Przegląd</h2><div class="card"><div class="stats" id="stats"></div></div>
  <h2>📢 Ogłoszenie dla graczy</h2><div class="card">
    <input type="text" id="anText" maxlength="200" placeholder="np. Za 10 min przerwa techniczna">
    <select id="anMin"><option value="15">na 15 min</option><option value="60" selected>na 1 godz.</option><option value="360">na 6 godz.</option><option value="1440">na 24 godz.</option></select>
    <div class="row"><button id="anGo">Pokaż wszystkim</button><button class="sec" id="anOff">Wyłącz</button></div><div class="muted" id="anNow" style="margin-top:8px"></div></div>
  <h2>👁 Mecze na żywo</h2><div class="card"><div class="row" style="margin:0 0 8px"><button class="sec" id="lvRefresh">Odśwież listę</button></div><div id="lvList" class="muted">Kliknij „Odśwież listę”.</div><div id="lvView"></div></div>
  <h2>🧑‍💼 Gracz (pełna karta)</h2><div class="card"><input type="text" id="opName" placeholder="Nick gracza"><div class="row"><button class="sec" id="opGo">Szukaj</button></div><div id="opRes" style="margin-top:10px"></div></div>
  <h2>📰 Lista zmian („Co nowego”)</h2><div class="card"><div class="muted">Jeden wpis na blok: pierwsza linia = nagłówek (np. <code>9.1 | 2026-11-09 | Tytuł</code>), kolejne linie = punkty. Bloki oddziel pustą linią.</div><textarea id="clText" rows="10"></textarea><div class="row"><button id="clSave">Zapisz</button></div></div>
  <h2>✏️ Opisy w grze</h2><div class="card"><div class="muted">Napis na stronie głównej (puste = brak) i opisy trybów widoczne na stronach trybów.</div><input type="text" id="txHub" maxlength="200" placeholder="Napis na stronie głównej" style="margin-top:8px">
    ${Object.entries(OMODES).map(([k, n]) => `<label class="muted" style="display:block;margin-top:8px">${n}</label><textarea id="tx_${k}" rows="2" maxlength="400" placeholder="Domyślny opis"></textarea>`).join('')}<div class="row"><button id="txSave">Zapisz opisy</button></div></div>
  <h2>⚠️ Strefa niebezpieczna</h2><div class="card"><b>Reset rankingu</b><div class="muted">Wszyscy rejestrowani wracają do 1000 Elo. Top 3 trafia do historii sezonów.</div>
    <select id="rrDiff"><option value="all">Wszystkie poziomy</option>${Object.entries(DIFFN).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
    <div class="row"><button class="red" id="rrGo">Zresetuj ranking</button></div></div>
  <h2>🧾 Dziennik zmian (kto co zrobił)</h2><div class="card"><div class="row" style="margin:0 0 8px"><button class="sec" id="auRefresh">Odśwież</button></div><table id="auTab"></table></div>`;

  loadStats = async () => {
    try {
      const s = await api('stats'), it = (n, v) => '<div class="stat"><span class="muted">' + n + '</span><b>' + v + '</b></div>';
      $('stats').innerHTML = it('Online', s.online) + it('Mecze teraz', s.games) + it('W kolejce', s.queued) + it('Konta', s.registered) + it('Goście', s.guests) + it('Aktywni 24 h', s.active24h) + it('Aktywni 7 dni', s.active7d)
        + it('Zgłoszenia', s.openReports) + it('Pomysły/błędy', s.openFeedback) + it('Blokady', s.bans) + it('Sezon', esc(s.season || '-')) + it('Baza', esc(s.db)) + it('Uptime', s.uptimeMin + ' min');
      $('anNow').textContent = s.announce ? 'Aktywne: „' + s.announce.text + '” do ' + fmtT(s.announce.until) : 'Brak aktywnego ogłoszenia.';
    } catch (e) { $('stats').textContent = e.message; }
  };
  $('anGo').onclick = async () => { try { await api('announce', { text: $('anText').value, minutes: +$('anMin').value }); $('anText').value = ''; loadStats(); } catch (e) { oerr(e); } };
  $('anOff').onclick = async () => { try { await api('announce', { text: '' }); loadStats(); } catch (e) { oerr(e); } };

  // --- mecze na żywo ---
  const board = (puz, cur) => { let h = '<div style="display:grid;grid-template-columns:repeat(9,1fr);width:180px;border:2px solid var(--muted);font-size:11px;text-align:center">';
    for (let i = 0; i < 81; i++){ const r = (i / 9) | 0, c = i % 9, v = cur[i] === '0' ? '' : cur[i], g = puz[i] !== '0';
      h += '<div style="aspect-ratio:1;line-height:20px;border:1px solid #4a4743;' + (c % 3 === 2 && c < 8 ? 'border-right:2px solid var(--muted);' : '') + (r % 3 === 2 && r < 8 ? 'border-bottom:2px solid var(--muted);' : '') + (g ? 'font-weight:700' : 'color:var(--green)') + '">' + v + '</div>'; }
    return h + '</div>'; };
  async function watch(id){
    clearInterval(liveT);
    const draw = async () => { try { const g = await oapi('live/' + id);
      $('lvView').innerHTML = '<div class="muted" style="margin:10px 0">' + (OMODES[g.mode] || g.mode) + ' · ' + esc(DIFFN[g.diff] || g.diff) + ' · ' + fmtMs(g.elapsed) + (g.goal ? ' · cel ' + g.goal : '') + '</div><div class="row" style="align-items:flex-start;justify-content:space-around">'
        + g.names.map((n, i) => '<div><b>' + esc(n) + '</b>' + (g.prog && g.prog[i] != null ? ' <span class="muted">(' + g.prog[i] + ')</span>' : '') + board(g.puzzle, g.cur[i]) + '</div>').join('') + '</div>'; }
      catch (e) { clearInterval(liveT); $('lvView').innerHTML = '<div class="muted">' + esc(e.message) + '</div>'; } };
    draw(); liveT = setInterval(draw, 2500);
  }
  $('lvRefresh').onclick = async () => { try { const l = await oapi('live'); $('lvView').innerHTML = ''; clearInterval(liveT);
    $('lvList').innerHTML = l.length ? '' : 'Brak trwających meczów.';
    l.forEach(g => { const b = document.createElement('button'); b.className = 'sec'; b.style.cssText = 'display:block;width:100%;margin-top:6px;text-align:left';
      b.textContent = '👁 ' + g.names.join(' vs ') + ' · ' + (OMODES[g.mode] || g.mode) + ' · ' + (DIFFN[g.diff] || g.diff) + (g.ranked ? ' · rank.' : ''); b.onclick = () => watch(g.id); $('lvList').appendChild(b); }); } catch (e) { oerr(e); } };

  // --- karta gracza ---
  $('opGo').onclick = async () => {
    const name = $('opName').value.trim(); if (!name) return;
    try {
      const u = await oapi('player?name=' + encodeURIComponent(name));
      $('opRes').innerHTML = '<b>' + esc(u.name) + '</b> ' + (u.guest ? '<span class="tag">gość</span>' : '') + (u.online ? '<span class="tag gold">online</span>' : '') + (u.banned ? '<span class="tag red">zablokowany</span>' : '')
        + '<div class="muted">Założone: ' + fmtT(u.createdAt) + ' · ostatnio: ' + fmtT(u.lastSeen) + ' · znajomi: ' + u.friends + ' · odznaki: ' + u.badges + ' · unieważnione: ' + u.flags + '</div>'
        + '<table>' + Object.entries(u.stats).map(([d, s]) => '<tr><td>' + esc(DIFFN[d] || d) + '</td><td>Elo <b>' + s.elo + '</b></td><td>' + s.wins + '/' + s.losses + '</td><td><button class="sec" data-e="' + d + '">Ustaw Elo</button></td></tr>').join('') + '</table>'
        + '<div class="muted" style="margin-top:8px">Ostatnie mecze:</div>' + (u.history.slice(0, 8).map(h => '<div class="rep">' + esc(JSON.stringify(h).slice(0, 140)) + '</div>').join('') || '<div class="muted">brak</div>')
        + '<div class="row">' + (u.liveGame ? '<button id="opWatch">👁 Oglądaj mecz</button>' : '') + '<button class="sec" id="opMsg">📩 Wiadomość</button><button class="sec" id="opWarn">⚠ Ostrzeż</button>' + (u.banned ? '' : '<button class="red" id="opBan">🚫 Zablokuj</button>') + '<button class="red" id="opDel">🗑 Usuń konto</button></div>';
      $('opRes').querySelectorAll('[data-e]').forEach(b => b.onclick = async () => { const v = prompt('Nowe Elo dla ' + b.dataset.e + ' (100–4000):'); if (v === null) return; try { await oapi('elo', { userId: u.id, diff: b.dataset.e, elo: +v }); $('opGo').click(); } catch (e) { oerr(e); } });
      if ($('opWatch')) $('opWatch').onclick = () => watch(u.liveGame);
      $('opMsg').onclick = async () => { const t = prompt('Wiadomość dla ' + u.name + ' (zobaczy ją od razu, jeśli jest online):'); if (!t) return; try { await oapi('message', { userId: u.id, text: t }); alert('Wysłano.'); } catch (e) { oerr(e); } };
      $('opWarn').onclick = () => warn(u);
      if ($('opBan')) $('opBan').onclick = () => ban({ type: 'user', userId: u.id }, u.name);
      $('opDel').onclick = async () => { const c = prompt('Usunięcie konta jest NIEODWRACALNE. Wpisz nick „' + u.name + '”, aby potwierdzić:'); if (c === null) return; try { await oapi('delete_user', { userId: u.id, confirm: c }); $('opRes').textContent = 'Konto usunięte.'; } catch (e) { oerr(e); } };
    } catch (e) { $('opRes').textContent = e.message; }
  };

  // --- lista zmian ---
  const clToText = l => l.map(e => [[e.v, e.date, e.title].join(' | ')].concat(e.items.map(x => '- ' + x)).join('\n')).join('\n\n');
  const clFromText = t => t.split(/\n\s*\n/).map(b => b.trim().split('\n').map(x => x.trim()).filter(Boolean)).filter(l => l.length).map(l => { const h = l[0].split('|').map(x => x.trim()); const title = h.length >= 3 ? h.slice(2).join(' | ') : h[h.length - 1];
    return { v: h.length >= 3 ? h[0] : '', date: h.length >= 3 ? h[1] : '', title, items: l.slice(1).map(x => x.replace(/^[-•]\s*/, '')) }; });
  fetch('/api/changelog').then(r => r.json()).then(l => { $('clText').value = clToText(l); });
  $('clSave').onclick = async () => { try { const r = await oapi('changelog', { entries: clFromText($('clText').value) }); $('clText').value = clToText(r); alert('Zapisano (' + r.length + ' wpisów).'); } catch (e) { oerr(e); } };

  // --- opisy ---
  fetch('/api/texts').then(r => r.json()).then(t => { $('txHub').value = t.hub || ''; for (const k in OMODES) $('tx_' + k).value = (t.modes || {})[k] || ''; });
  $('txSave').onclick = async () => { const modes = {}; for (const k in OMODES) modes[k] = $('tx_' + k).value.trim(); try { await oapi('texts', { hub: $('txHub').value.trim(), modes }); alert('Zapisano. Gracze zobaczą zmiany po odświeżeniu strony.'); } catch (e) { oerr(e); } };

  // --- reset rankingu ---
  $('rrGo').onclick = async () => { const d = $('rrDiff').value; const c = prompt('Reset rankingu (' + (d === 'all' ? 'wszystkie poziomy' : DIFFN[d]) + ') NIE da się cofnąć. Wpisz RESET, aby potwierdzić:'); if (c === null) return; try { await oapi('reset_ranking', { diff: d, confirm: c }); alert('Ranking zresetowany.'); loadStats(); } catch (e) { oerr(e); } };

  // --- dziennik ---
  const loadAudit = async () => { try { const a = await oapi('audit'); $('auTab').innerHTML = a.length ? '<tr><th>Kiedy</th><th>Rola</th><th>Akcja</th><th>Szczegóły</th></tr>' + a.slice(0, 100).map(x => '<tr><td>' + fmtT(x.at) + '</td><td>' + esc(x.role) + '</td><td>' + esc(x.action) + '</td><td>' + esc(x.detail) + '</td></tr>').join('') : '<tr><td class="muted">Brak wpisów.</td></tr>'; } catch (e) { $('auTab').innerHTML = '<tr><td>' + esc(e.message) + '</td></tr>'; } };
  $('auRefresh').onclick = loadAudit; loadAudit(); loadStats();
}

