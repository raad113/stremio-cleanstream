// ==UserScript==
// @name         CleanStream Auto-Skip for Stremio Web
// @namespace    cleanstream
// @version      1.0.0
// @description  Automatically skips (or mutes) unwanted scenes in Stremio Web using CleanStream community skip data, and lets you add and vote on skips.
// @match        https://web.stremio.com/*
// @match        https://*.strem.io/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * How it works
 * ------------
 * 1. Watches the Stremio Web address bar. When a player page opens, it reads the
 *    IMDb id (tt1234567, or tt1234567:season:episode for an episode).
 * 2. Downloads the skip list for that id from your CleanStream server, using
 *    your filter settings.
 * 3. Checks the video position several times a second. Inside a "video" or
 *    "both" segment it jumps to the end of the segment; inside an "audio"
 *    segment (e.g. profanity) it mutes until the segment ends.
 *
 * Keyboard shortcuts (while a video is playing)
 *   Alt+S        mark the start of a scene you want to share
 *   Alt+E        mark the end and open the "share a skip" form
 *   Alt+C        turn auto-skip on/off
 *   Alt+← / →    shift all skips 0.5 s earlier/later (for a different cut)
 *   Alt+H        show help
 */

(function () {
  'use strict';

  // Filled in by the CleanStream server when the script is downloaded.
  const SERVER = '__CLEANSTREAM_SERVER__'.replace(/\/+$/, '');
  const DEFAULT_CONFIG = __CLEANSTREAM_CONFIG__;

  const POLL_MS = 200;
  const ID_PATTERN = /^tt\d+(?::\d+:\d+)?$/;
  const CATEGORIES = ['nudity', 'sex', 'violence', 'language', 'drugs', 'fear', 'discrimination', 'dispensable'];
  const LEVELS = ['off', 'low', 'medium', 'high'];

  /* ---------------------------------------------------------------- */
  /* Storage and network helpers                                      */
  /* ---------------------------------------------------------------- */

  const hasGM = typeof GM_getValue === 'function';
  const store = {
    get(key, fallback) {
      try {
        if (hasGM) return GM_getValue(key, fallback);
        const raw = localStorage.getItem('cleanstream:' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (hasGM) GM_setValue(key, value);
        else localStorage.setItem('cleanstream:' + key, JSON.stringify(value));
      } catch (e) { /* storage unavailable: settings last for this page only */ }
    },
  };

  // GM_xmlhttpRequest avoids mixed-content and CORS problems with self-hosted
  // servers; plain fetch is the fallback when the script runs without a manager.
  function request(method, path, body) {
    const url = SERVER + path;
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method,
          url,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          data: body ? JSON.stringify(body) : undefined,
          timeout: 15000,
          onload: r => {
            let data = null;
            try { data = JSON.parse(r.responseText); } catch (e) { /* not JSON */ }
            resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, data });
          },
          onerror: () => reject(new Error('Network error')),
          ontimeout: () => reject(new Error('Request timed out')),
        });
      });
    }
    return fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(async r => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => null) }));
  }

  /* ---------------------------------------------------------------- */
  /* State                                                            */
  /* ---------------------------------------------------------------- */

  const state = {
    contentId: null,
    skips: [],
    loading: false,
    enabled: store.get('enabled', true),
    config: Object.assign({}, DEFAULT_CONFIG, store.get('config', {})),
    offsetMs: 0,
    allowed: new Set(),     // skips the viewer chose to watch (Undo)
    mutedBySkip: null,      // skip id currently muting audio
    lastJump: 0,
    markStart: null,
    formOpen: false,
  };

  /* ---------------------------------------------------------------- */
  /* Reading the current title from Stremio Web                       */
  /* ---------------------------------------------------------------- */

  // Player route: #/player/<stream>/<streamAddon>/<metaAddon>/<type>/<id>/<videoId>
  function currentContentId() {
    const hash = location.hash || '';
    if (!hash.startsWith('#/player')) return null;
    const parts = hash.split(/[/?]/).map(p => {
      try { return decodeURIComponent(p); } catch (e) { return p; }
    });
    for (let i = parts.length - 1; i >= 0; i--) {
      if (ID_PATTERN.test(parts[i])) return parts[i];
    }
    const loose = decodeURIComponent(hash).match(/tt\d+(?::\d+:\d+)?/g);
    return loose ? loose[loose.length - 1] : null;
  }

  function findVideo() {
    const videos = [...document.querySelectorAll('video')];
    return videos.find(v => v.duration > 0) || videos[0] || null;
  }

  async function loadSkips(id) {
    state.loading = true;
    state.skips = [];
    state.allowed.clear();
    state.offsetMs = store.get('offset:' + id, 0);
    renderBadge();
    try {
      const query = encodeURIComponent(JSON.stringify(state.config));
      const res = await request('GET', `/api/skips/${encodeURIComponent(id)}?config=${query}`);
      if (id !== state.contentId) return; // the viewer moved on meanwhile
      state.skips = res.ok && res.data ? res.data.skips || [] : [];
    } catch (e) {
      toast('CleanStream: could not reach the server (' + e.message + ')');
    } finally {
      state.loading = false;
      renderBadge();
    }
  }

  /* ---------------------------------------------------------------- */
  /* The skip loop                                                    */
  /* ---------------------------------------------------------------- */

  function tick() {
    const id = currentContentId();
    if (id !== state.contentId) {
      state.contentId = id;
      state.mutedBySkip = null;
      state.markStart = null;
      if (id) loadSkips(id); else renderBadge();
    }
    if (!id || !state.enabled || state.formOpen || state.skips.length === 0) return;

    const video = findVideo();
    if (!video || video.seeking || !(video.duration > 0)) return;

    const nowMs = video.currentTime * 1000 - state.offsetMs;
    const active = state.skips.find(s => nowMs >= s.startMs && nowMs < s.endMs - 250 && !state.allowed.has(s.startMs));

    // Release the mute once we leave an audio-only segment
    if (state.mutedBySkip !== null && (!active || active.startMs !== state.mutedBySkip)) {
      video.muted = false;
      state.mutedBySkip = null;
    }
    if (!active) return;

    if (active.channel === 'audio') {
      if (state.mutedBySkip === null) {
        video.muted = true;
        state.mutedBySkip = active.startMs;
        toast(`Muted: ${active.description}`, active);
      }
      return;
    }

    // Guard against a stuck loop if the player refuses the seek
    if (Date.now() - state.lastJump < 1000) return;
    state.lastJump = Date.now();
    video.currentTime = (active.endMs + state.offsetMs) / 1000 + 0.05;
    toast(`Skipped ${formatTime(active.duration)}: ${active.description}`, active);
  }

  /* ---------------------------------------------------------------- */
  /* User interface                                                   */
  /* ---------------------------------------------------------------- */

  const css = `
    .cs-badge{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483646;
      font:600 12px/1 system-ui,sans-serif;background:rgba(20,22,40,.85);color:#e6f1ff;
      padding:7px 12px;border-radius:999px;cursor:pointer;border:1px solid rgba(100,255,218,.4)}
    .cs-badge.off{border-color:rgba(255,255,255,.2);color:#8892b0}
    .cs-toast{position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:2147483647;
      font:14px/1.4 system-ui,sans-serif;background:rgba(20,22,40,.95);color:#fff;padding:10px 14px;
      border-radius:10px;display:flex;gap:10px;align-items:center;box-shadow:0 4px 18px rgba(0,0,0,.4)}
    .cs-toast button,.cs-panel button{font:inherit;background:rgba(255,255,255,.12);color:#fff;
      border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:4px 9px;cursor:pointer}
    .cs-panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;
      width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;
      font:14px/1.4 system-ui,sans-serif;background:#16213e;color:#e6f1ff;padding:18px;border-radius:12px;
      box-shadow:0 10px 40px rgba(0,0,0,.6)}
    .cs-panel *{box-sizing:border-box}
    .cs-panel h3{margin:0 0 12px;font-size:16px}
    .cs-panel label{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:8px 0}
    .cs-panel input,.cs-panel select{font:inherit;background:rgba(255,255,255,.08);color:#fff;
      border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:5px 8px}
    .cs-panel input[type=text]{width:100%}
    .cs-panel .cs-row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
    .cs-panel .cs-primary{background:#64ffda;color:#1a1a2e;border-color:#64ffda}
    .cs-panel small{color:#8892b0}
    .cs-panel option{color:#000}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.documentElement.appendChild(style);

  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    for (const c of [].concat(children || [])) node.append(c);
    return node;
  }

  let badge = null;
  function renderBadge() {
    if (!state.contentId) {
      if (badge) badge.remove();
      badge = null;
      return;
    }
    if (!badge) {
      badge = el('div', { className: 'cs-badge', title: 'CleanStream settings (Alt+H for help)', onclick: openSettings });
      document.body.appendChild(badge);
    }
    const count = state.loading ? '…' : state.skips.length;
    const offset = state.offsetMs ? ` · offset ${(state.offsetMs / 1000).toFixed(1)}s` : '';
    badge.textContent = `CleanStream: ${count} skips · ${state.enabled ? 'auto-skip on' : 'off'}${offset}`;
    badge.classList.toggle('off', !state.enabled);
  }

  let toastTimer = null;
  let toastNode = null;
  function toast(message, skip) {
    if (toastNode) toastNode.remove();
    clearTimeout(toastTimer);
    const children = [el('span', { textContent: message })];

    if (skip) {
      children.push(
        el('button', { textContent: 'Undo', title: 'Go back and watch this scene', onclick: () => undoSkip(skip) }),
        el('button', { textContent: '👍', title: 'This skip was accurate', onclick: () => vote(skip, 'up') }),
        el('button', { textContent: '👎', title: 'This skip was wrong', onclick: () => vote(skip, 'down') }),
      );
    }
    toastNode = el('div', { className: 'cs-toast' }, children);
    document.body.appendChild(toastNode);
    toastTimer = setTimeout(() => { if (toastNode) toastNode.remove(); toastNode = null; }, skip ? 7000 : 4000);
  }

  function undoSkip(skip) {
    state.allowed.add(skip.startMs);
    const video = findVideo();
    if (video) {
      if (skip.channel === 'audio') video.muted = false;
      else video.currentTime = (skip.startMs + state.offsetMs) / 1000;
    }
    toast('Playing the scene. It will not be skipped again this time.');
  }

  async function vote(skip, direction) {
    const ids = skip.sourceIds && skip.sourceIds.length ? skip.sourceIds : [skip.id];
    try {
      const results = await Promise.all(ids.map(segId =>
        request('POST', `/api/vote/${encodeURIComponent(state.contentId)}/${encodeURIComponent(segId)}`, { vote: direction })));
      if (results.some(r => r.ok)) toast('Thanks, your vote helps everyone.');
      else if (results.every(r => r.status === 409)) toast('You already voted on this skip.');
      else toast('Vote failed: ' + ((results[0].data && results[0].data.error) || 'HTTP ' + results[0].status));
    } catch (e) {
      toast('Vote failed: ' + e.message);
    }
  }

  function closePanel() {
    document.querySelectorAll('.cs-panel').forEach(p => p.remove());
    state.formOpen = false;
  }

  function openSettings() {
    closePanel();
    const selects = {};
    const rows = ['nudity', 'sex', 'violence', 'language', 'drugs', 'fear'].map(cat => {
      const select = el('select', {}, LEVELS.map(l => el('option', { value: l, textContent: l, selected: state.config[cat] === l })));
      selects[cat] = select;
      return el('label', {}, [cat[0].toUpperCase() + cat.slice(1), select]);
    });
    const enabled = el('input', { type: 'checkbox', checked: state.enabled });

    const panel = el('div', { className: 'cs-panel' }, [
      el('h3', { textContent: 'CleanStream auto-skip' }),
      el('label', {}, ['Auto-skip enabled', enabled]),
      el('small', { textContent: '"high" skips every flagged scene in a category; "low" skips only the strongest ones.' }),
      ...rows,
      el('small', { textContent: 'Shortcuts: Alt+S / Alt+E mark a scene to share, Alt+C on/off, Alt+← / Alt+→ fix timing.' }),
      el('div', { className: 'cs-row' }, [
        el('button', { textContent: 'Cancel', onclick: closePanel }),
        el('button', {
          className: 'cs-primary',
          textContent: 'Save',
          onclick: () => {
            for (const cat of Object.keys(selects)) state.config[cat] = selects[cat].value;
            state.enabled = enabled.checked;
            store.set('config', state.config);
            store.set('enabled', state.enabled);
            closePanel();
            if (state.contentId) loadSkips(state.contentId);
          },
        }),
      ]),
    ]);
    document.body.appendChild(panel);
  }

  function openContributeForm(startMs, endMs) {
    closePanel();
    if (toastNode) { toastNode.remove(); toastNode = null; }
    const video = findVideo();
    if (video) video.pause();
    state.formOpen = true;

    const start = el('input', { type: 'text', value: formatClock(startMs) });
    const end = el('input', { type: 'text', value: formatClock(endMs) });
    const category = el('select', {}, CATEGORIES.map(c => el('option', { value: c, textContent: c })));
    const severity = el('select', {}, ['low', 'medium', 'high'].map(s => el('option', { value: s, textContent: s, selected: s === 'medium' })));
    const channel = el('select', {}, [
      el('option', { value: 'both', textContent: 'skip the scene' }),
      el('option', { value: 'audio', textContent: 'mute audio only' }),
    ]);
    const comment = el('input', { type: 'text', placeholder: 'Short description (optional)', maxLength: 200 });
    const status = el('small', {});

    const submit = el('button', {
      className: 'cs-primary',
      textContent: 'Share with everyone',
      onclick: async () => {
        const s = parseClock(start.value);
        const e = parseClock(end.value);
        if (s === null || e === null || e <= s) {
          status.textContent = 'Times must look like 1:02:03 and the end must be after the start.';
          return;
        }
        submit.disabled = true;
        status.textContent = 'Sending…';
        try {
          const res = await request('POST', `/api/contribute/${encodeURIComponent(state.contentId)}`, {
            // Store times as they are in the reference cut (remove local offset)
            startMs: Math.round(s - state.offsetMs),
            endMs: Math.round(e - state.offsetMs),
            category: category.value,
            severity: severity.value,
            channel: channel.value,
            comment: comment.value,
            title: document.title.replace(/\s*[-|]\s*Stremio.*$/i, '') || undefined,
          });
          if (!res.ok) throw new Error((res.data && res.data.error) || 'HTTP ' + res.status);
          closePanel();
          toast('Thank you! Your skip is now shared with other viewers.');
          loadSkips(state.contentId);
        } catch (err) {
          submit.disabled = false;
          status.textContent = 'Could not send: ' + err.message;
        }
      },
    });

    const panel = el('div', { className: 'cs-panel' }, [
      el('h3', { textContent: 'Share a skip' }),
      el('label', {}, ['Start', start]),
      el('label', {}, ['End', end]),
      el('label', {}, ['Category', category]),
      el('label', {}, ['Severity', severity]),
      el('label', {}, ['Action', channel]),
      comment,
      status,
      el('div', { className: 'cs-row' }, [el('button', { textContent: 'Cancel', onclick: closePanel }), submit]),
    ]);
    document.body.appendChild(panel);
  }

  /* ---------------------------------------------------------------- */
  /* Keyboard shortcuts                                               */
  /* ---------------------------------------------------------------- */

  document.addEventListener('keydown', e => {
    if (!e.altKey || !state.contentId || state.formOpen) return;
    const video = findVideo();
    const nowMs = video ? Math.round(video.currentTime * 1000) : 0;
    let handled = true;

    switch (e.code) {
      case 'KeyS':
        state.markStart = nowMs;
        toast(`Scene start marked at ${formatClock(nowMs)}. Press Alt+E at the end.`);
        break;
      case 'KeyE':
        if (state.markStart === null || nowMs <= state.markStart) {
          toast('Press Alt+S at the start of the scene first.');
        } else {
          openContributeForm(state.markStart, nowMs);
          state.markStart = null;
        }
        break;
      case 'KeyC':
        state.enabled = !state.enabled;
        store.set('enabled', state.enabled);
        if (!state.enabled && video && state.mutedBySkip !== null) { video.muted = false; state.mutedBySkip = null; }
        toast(state.enabled ? 'Auto-skip on' : 'Auto-skip off');
        renderBadge();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        state.offsetMs += e.code === 'ArrowRight' ? 500 : -500;
        store.set('offset:' + state.contentId, state.offsetMs);
        toast(`Skip timing shifted ${(state.offsetMs / 1000).toFixed(1)} s`);
        renderBadge();
        break;
      case 'KeyH':
        toast('Alt+S / Alt+E: mark a scene to share · Alt+C: on/off · Alt+← / Alt+→: fix timing');
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  /* ---------------------------------------------------------------- */
  /* Time formatting                                                  */
  /* ---------------------------------------------------------------- */

  function formatClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }

  function parseClock(text) {
    const parts = String(text).trim().split(':').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return null;
    const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
    return ((h * 60 + m) * 60 + s) * 1000;
  }

  function formatTime(ms) {
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }

  setInterval(tick, POLL_MS);
})();
