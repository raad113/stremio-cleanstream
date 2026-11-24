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
  });
  if (token) load();
</script>
</body>
</html>`;

module.exports = { ADMIN_PAGE };
