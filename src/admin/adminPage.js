/**
 * Moderation page (/admin)
 *
 * Lists unconfirmed skips with the contributor's record and lets the owner
 * approve, reject, or reject and block. The page itself holds no secret: it
 * asks for the ADMIN_TOKEN and sends it as a Bearer header to /api/admin/*.
 * The token is kept only in this browser tab (sessionStorage).
 */

const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>CleanStream Moderation</title>
<style>
  :root { --bg:#14182b; --card:#1d2340; --text:#e6f1ff; --muted:#8892b0; --ok:#3ddc97; --bad:#ff6b6b; --line:rgba(255,255,255,.1); }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; font-family:system-ui,sans-serif; background:var(--bg); color:var(--text); }
  main { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.3rem; }
  .card { background:var(--card); border-radius:10px; padding:14px; margin:10px 0; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:space-between; }
  .meta { color:var(--muted); font-size:.85rem; }
  button { font:inherit; border:1px solid var(--line); background:rgba(255,255,255,.08); color:var(--text);
           border-radius:6px; padding:6px 12px; cursor:pointer; }
  button.ok { border-color:var(--ok); color:var(--ok); }
  button.bad { border-color:var(--bad); color:var(--bad); }
  select { font:inherit; padding:5px; border-radius:6px; border:1px solid var(--line); background:#0e1222; color:var(--text); }
  input { font:inherit; padding:8px; border-radius:6px; border:1px solid var(--line); background:#0e1222; color:var(--text); width:100%; max-width:420px; }
  .empty { color:var(--muted); text-align:center; padding:30px 0; }
  a { color:#64ffda; }
</style>
</head>
<body>
<main>
  <h1>CleanStream moderation</h1>
  <div id="login" class="card">
    <p class="meta">Enter the ADMIN_TOKEN from the server's .env file. It stays in this browser tab only.</p>
    <input id="token" type="password" autocomplete="off" placeholder="Admin token">
    <p><button id="go" class="ok">Show unconfirmed skips</button></p>
  </div>
  <div id="editors" class="card" style="display:none">
    <div class="row"><strong>Trusted editors</strong></div>
    <p class="meta">Editors' marks apply for everyone at once, their confirmations and "wrong skip" reports decide a skip straight away, and their timing corrections are shared without waiting for a second viewer. Give each person their own key; they enter it in the app under Settings &gt; Nuvio Clean &gt; Editor key. Removing an editor stops their key at once.</p>
    <div id="editorList"></div>
    <p class="row"><input id="editorName" placeholder="Name, e.g. Raad" maxlength="40"> <button id="addEditor" class="ok">Create key</button></p>
    <p id="newKey" class="meta"></p>
  </div>
  <div id="decisions" class="card" style="display:none">
    <div class="row"><strong>Recent decisions</strong><button id="reloadDecisions">Refresh</button></div>
    <p class="meta">What editors and you decided, newest first. Changed your mind? Press Undo to put the scene back as it was, or open the film to change it.</p>
    <div id="decisionList"></div>
  </div>
  <div id="finder" class="card" style="display:none">
    <div class="row"><strong>Find a film</strong></div>
    <p class="meta">Every scene of a film, whatever its state: confirm it, make it unconfirmed again, reject it, or change what kind of scene it is. Enter the IMDb id (tt1234567, or tt1234567:1:2 for an episode).</p>
    <p class="row"><input id="findId" placeholder="tt0088763" maxlength="30"> <button id="findGo" class="ok">Show scenes</button></p>
    <div id="titleView"></div>
  </div>
  <div id="reports" class="card" style="display:none">
    <div class="row"><strong>Crash reports</strong><button id="clearReports" class="bad">Clear all</button></div>
    <p class="meta">Sent by apps whose viewer turned on "Send crash reports". Web addresses are removed before sending. Click a report to see it all; select its text to copy it.</p>
    <div id="reportList"></div>
  </div>
  <div id="list"></div>
</main>
<script>
  const list = document.getElementById('list');
  const tokenInput = document.getElementById('token');
  let token = '';
  try { token = sessionStorage.getItem('cs-admin') || ''; } catch (e) {}

  const fmt = ms => { const s = Math.round(ms / 1000); return Math.floor(s / 3600) + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function api(path, options = {}) {
    const res = await fetch('/api/admin' + path, {
      ...options,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    if (res.status === 401) throw new Error('Wrong token');
    return res.json();
  }

  async function load() {
    list.innerHTML = '<p class="meta">Loading…</p>';
    try {
      const data = await api('/pending');
      document.getElementById('login').style.display = 'none';
      if (!data.items.length) { list.innerHTML = '<p class="empty">No unconfirmed skips. 🎉</p>'; return; }
      list.innerHTML = data.items.map(item => {
        const s = item.segment, c = item.contributor;
        return '<div class="card" data-id="' + esc(item.imdbId) + '|' + esc(s.id) + '">' +
          '<div class="row"><strong>' + esc(item.title || item.imdbId) + '</strong>' +
          '<a class="meta" target="_blank" rel="noopener" href="https://www.imdb.com/title/' + esc(item.imdbId.split(':')[0]) + '/">' + esc(item.imdbId) + '</a></div>' +
          '<p>' + fmt(s.startMs) + ' – ' + fmt(s.endMs) + ' (' + Math.round((s.endMs - s.startMs) / 1000) + ' s) · ' + esc(s.category) + ' · ' + esc(s.severity) +
          (s.comment ? ' · “' + esc(s.comment) + '”' : '') + '</p>' +
          '<p class="meta">Votes: 👍 ' + (s.votes?.up || 0) + ' · 👎 ' + (s.votes?.down || 0) +
          (c.id ? ' — viewer ' + esc(c.id) + ': ' + c.approved + ' confirmed, ' + c.rejected + ' rejected' + (c.blocked ? ' (blocked)' : '')
                : ' — imported from ' + esc(s.contributor || 'another source')) + '</p>' +
          '<div class="row"><span></span><span>' +
          '<button class="ok" data-action="approve">Approve</button> ' +
          '<button class="bad" data-action="reject">Reject</button> ' +
          '<button class="bad" data-action="block">Reject &amp; block contributor</button></span></div></div>';
      }).join('');
    } catch (e) {
      document.getElementById('login').style.display = '';
      list.innerHTML = '<p class="empty">' + esc(e.message) + '</p>';
    }
  }

  const editorsCard = document.getElementById('editors');
  const editorList = document.getElementById('editorList');
  const newKey = document.getElementById('newKey');

  async function loadEditors() {
    try {
      const data = await api('/editors');
      editorsCard.style.display = '';
      editorList.innerHTML = data.editors.length
        ? data.editors.map(ed => '<div class="row" data-editor="' + esc(ed.id) + '"><span>' + esc(ed.name) +
            ' <span class="meta">since ' + esc(String(ed.createdAt).slice(0, 10)) + '</span></span>' +
            '<button class="bad" data-remove="' + esc(ed.id) + '">Remove</button></div>').join('')
        : '<p class="meta">No editors yet.</p>';
    } catch (e) { /* shown with the skip list */ }
  }

  document.getElementById('addEditor').addEventListener('click', async () => {
    const name = document.getElementById('editorName').value.trim();
    if (!name) return;
    const res = await fetch('/api/admin/editors', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) { newKey.textContent = data.error || 'Could not create the key'; return; }
    newKey.innerHTML = 'Key for <strong>' + esc(data.name) + '</strong> (shown only now, copy it): <code style="user-select:all">' + esc(data.key) + '</code>';
    document.getElementById('editorName').value = '';
    loadEditors();
  });

  editorList.addEventListener('click', async e => {
    const id = e.target.dataset && e.target.dataset.remove;
    if (!id || !confirm('Remove this editor? Their key stops working at once.')) return;
    await fetch('/api/admin/editors/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } });
    loadEditors();
  });

  const CATEGORIES = ['sex', 'nudity', 'violence', 'language', 'drugs', 'fear', 'discrimination', 'dispensable', 'commercial'];
  const STATE = { approved: 'confirmed', pending: 'unconfirmed', rejected: 'rejected', 'new': 'new' };
  const stateText = s => String(s).startsWith('category:') ? String(s).slice(9) : (STATE[s] || s);
  const decisionsCard = document.getElementById('decisions');
  const decisionList = document.getElementById('decisionList');

  async function loadDecisions() {
    try {
      const data = await api('/decisions');
      decisionsCard.style.display = '';
      decisionList.innerHTML = data.decisions.length
        ? data.decisions.slice(0, 60).map((d, i) => {
            const isCategory = String(d.to).startsWith('category:');
            const canUndo = d.from !== 'new' || d.to !== 'rejected';
            return '<div class="row" style="border-top:1px solid var(--line);padding:6px 0" data-i="' + i + '">' +
              '<span><strong>' + esc(d.title || d.imdbId) + '</strong> ' + fmt(d.startMs) + '–' + fmt(d.endMs) + ' · ' + esc(d.category) +
              '<br><span class="meta">' + esc(String(d.at).replace('T', ' ').slice(0, 16)) + ' · ' + esc(d.by) + ': ' +
              esc(stateText(d.from)) + ' → ' + esc(stateText(d.to)) + '</span></span>' +
              '<span><button data-open="' + esc(d.imdbId) + '">Open film</button> ' +
              (canUndo ? '<button class="bad" data-undo="' + i + '">Undo</button>' : '') + '</span></div>';
          }).join('')
        : '<p class="meta">No decisions yet.</p>';
      decisionList._items = data.decisions;
    } catch (e) { /* shown with the skip list */ }
  }

  async function segmentAction(imdbId, segmentId, body) {
    return api('/segments/' + encodeURIComponent(imdbId) + '/' + encodeURIComponent(segmentId), { method: 'POST', body: JSON.stringify(body) });
  }

  decisionList.addEventListener('click', async e => {
    const open = e.target.dataset && e.target.dataset.open;
    if (open) { document.getElementById('findId').value = open; showTitle(open); return; }
    const i = e.target.dataset && e.target.dataset.undo;
    if (i == null) return;
    const d = decisionList._items[Number(i)];
    let body;
    if (String(d.from).startsWith('category:')) body = { action: 'category', category: String(d.from).slice(9) };
    else if (d.from === 'new') body = { action: 'reject' };
    else body = { action: d.from === 'approved' ? 'approve' : d.from === 'pending' ? 'unconfirm' : 'reject' };
    if (!confirm('Undo: put this scene back to "' + stateText(d.from === 'new' ? 'rejected' : d.from) + '"?')) return;
    await segmentAction(d.imdbId, d.segmentId, body);
    loadDecisions();
  });

  const titleView = document.getElementById('titleView');
  async function showTitle(imdbId) {
    imdbId = String(imdbId || '').trim();
    if (!imdbId) return;
    titleView.innerHTML = '<p class="meta">Loading…</p>';
    try {
      const data = await api('/titles/' + encodeURIComponent(imdbId));
      if (data.error) { titleView.innerHTML = '<p class="meta">' + esc(data.error) + '</p>'; return; }
      titleView.innerHTML = '<p><strong>' + esc(data.title || imdbId) + '</strong> <span class="meta">' + data.segments.length + ' scenes</span></p>' +
        data.segments.map(s => '<div class="row" style="border-top:1px solid var(--line);padding:6px 0" data-seg="' + esc(imdbId) + '|' + esc(s.id) + '">' +
          '<span>' + fmt(s.startMs) + '–' + fmt(s.endMs) + ' · <strong>' + esc(stateText(s.status)) + '</strong>' +
          (s.comment ? ' · “' + esc(String(s.comment).slice(0, 60)) + '”' : '') + '</span>' +
          '<span><select data-cat>' + CATEGORIES.map(c => '<option' + (c === s.category ? ' selected' : '') + '>' + c + '</option>').join('') + '</select> ' +
          '<button class="ok" data-act="approve">Confirm</button> ' +
          '<button data-act="unconfirm">Unconfirm</button> ' +
          '<button class="bad" data-act="reject">Reject</button></span></div>').join('');
    } catch (e) {
      titleView.innerHTML = '<p class="meta">' + esc(e.message) + '</p>';
    }
  }
  document.getElementById('findGo').addEventListener('click', () => showTitle(document.getElementById('findId').value));
  document.getElementById('reloadDecisions').addEventListener('click', loadDecisions);
  titleView.addEventListener('click', async e => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    const [imdbId, segmentId] = e.target.closest('[data-seg]').dataset.seg.split('|');
    await segmentAction(imdbId, segmentId, { action: act });
    showTitle(imdbId);
    loadDecisions();
  });
  titleView.addEventListener('change', async e => {
    if (!e.target.matches('[data-cat]')) return;
    const [imdbId, segmentId] = e.target.closest('[data-seg]').dataset.seg.split('|');
    await segmentAction(imdbId, segmentId, { action: 'category', category: e.target.value });
    loadDecisions();
  });

  const reportsCard = document.getElementById('reports');
  const reportList = document.getElementById('reportList');

  async function loadReports() {
    try {
      const data = await api('/reports');
      reportsCard.style.display = '';
      reportList.innerHTML = data.reports.length
        ? data.reports.map(r => {
            const firstLines = esc(r.text.split('\\n').slice(1, 3).join(' \u00b7 '));
            return '<details class="card"><summary><strong>' + esc(r.kind) + '</strong> <span class="meta">' +
              esc(String(r.receivedAt).replace('T', ' ').slice(0, 16)) + ' \u00b7 app ' + esc(r.app) + ' \u00b7 ' + firstLines +
              '</span></summary><pre style="white-space:pre-wrap;font-size:.8rem;user-select:all">' + esc(r.text) + '</pre></details>';
          }).join('')
        : '<p class="meta">No reports yet.</p>';
    } catch (e) { /* shown with the skip list */ }
  }

  document.getElementById('clearReports').addEventListener('click', async () => {
    if (!confirm('Delete all crash reports?')) return;
    await fetch('/api/admin/reports', { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } });
    loadReports();
  });

  list.addEventListener('click', async e => {
    const action = e.target.dataset && e.target.dataset.action;
    if (!action) return;
    const card = e.target.closest('[data-id]');
    const [imdbId, segmentId] = card.dataset.id.split('|');
    if (action === 'block' && !confirm('Reject this skip and block its contributor from adding more?')) return;
    await api('/segments/' + encodeURIComponent(imdbId) + '/' + encodeURIComponent(segmentId), { method: 'POST', body: JSON.stringify({ action }) });
    card.remove();
    if (!list.querySelector('[data-id]')) list.innerHTML = '<p class="empty">No unconfirmed skips. 🎉</p>';
  });

  document.getElementById('go').addEventListener('click', () => {
    token = tokenInput.value.trim();
    try { sessionStorage.setItem('cs-admin', token); } catch (e) {}
    load();
    loadEditors();
    loadDecisions();
    document.getElementById('finder').style.display = '';
    loadReports();
  });
  if (token) { load(); loadEditors(); loadDecisions(); document.getElementById('finder').style.display = ''; loadReports(); }
</script>
</body>
</html>`;

module.exports = { ADMIN_PAGE };
