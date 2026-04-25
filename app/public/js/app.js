'use strict';

// ── Utilities ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast${type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : ''}`;
  t.textContent = msg;
  $('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 ** 2).toFixed(1) + ' MB';
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── State ────────────────────────────────────────────────────────────────────
let currentUser  = null;
let allFiles     = [];
let allPlaylists = [];
let voiceGroups  = {};  // { de: [{id, label, langLabel}], en: [...] }
let activePl     = null;
let _seeking     = false;

// ── Page navigation ───────────────────────────────────────────────────────────
function navigateTo(pg) {
  document.querySelectorAll('#sidebar a').forEach(a => a.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
  const navLink = document.querySelector(`#sidebar a[data-page="${pg}"]`);
  if (navLink) navLink.classList.add('active');
  const target = $(`page-${pg}`);
  target.classList.remove('hidden');
  target.classList.add('active');
  if (pg === 'library')   loadLibrary();
  if (pg === 'playlists') loadPlaylists();
  if (pg === 'settings')  loadSettings();
  if (pg === 'tts')       loadTtsPage();
}

document.querySelectorAll('#sidebar a[data-page]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    navigateTo(link.dataset.page);
  });
});

// In-page navigation links (e.g. "Open TTS page" link on dashboard)
document.addEventListener('click', e => {
  const link = e.target.closest('a.tts-page-link[data-page]');
  if (link) { e.preventDefault(); navigateTo(link.dataset.page); }
});

// ── Auth ─────────────────────────────────────────────────────────────────────
$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  $('login-error').classList.add('hidden');
  try {
    const user = await api('POST', '/api/auth/login', { username, password });
    onLogin(user);
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').classList.remove('hidden');
  }
});

$('changepw-form').addEventListener('submit', async e => {
  e.preventDefault();
  const cur  = $('cp-current').value;
  const nw   = $('cp-new').value;
  const conf = $('cp-confirm').value;
  if (nw !== conf) { $('cp-error').textContent = 'Passwords do not match'; $('cp-error').classList.remove('hidden'); return; }
  $('cp-error').classList.add('hidden');
  try {
    await api('POST', '/api/auth/change-password', { currentPassword: cur, newPassword: nw });
    $('changepw-overlay').classList.add('hidden');
    $('app').classList.remove('hidden');
    toast('Password changed!', 'success');
    initSocket();
  } catch (err) {
    $('cp-error').textContent = err.message;
    $('cp-error').classList.remove('hidden');
  }
});

$('logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  location.reload();
});

async function onLogin(user) {
  currentUser = user;
  $('login-overlay').classList.add('hidden');
  $('sidebar-user').textContent = user.username;

  if (user.role === 'admin') {
    $('nav-settings').classList.remove('hidden');
    $('nav-settings').classList.remove('admin-only');
  }

  if (user.mustChangePassword) {
    $('changepw-overlay').classList.remove('hidden');
  } else {
    $('app').classList.remove('hidden');
    initSocket();
  }
}

(async () => {
  try {
    const user = await api('GET', '/api/auth/me');
    onLogin(user);
  } catch { /* not logged in */ }
})();

// ── Socket.io ────────────────────────────────────────────────────────────────
let socket = null;

function initSocket() {
  socket = io({ transports: ['websocket'] });

  socket.on('connect',    () => { loadBotStatus(); loadVoiceList(); });
  socket.on('disconnect', () => setBotStatus(false));

  socket.on('state', s => {
    setBotStatus(s.connected);
    setNowPlaying(s.nowPlaying);
    setVolume(s.volume);
    setChannels(s.channels);
    renderQueue(s.queue  || []);
    renderHistory(s.history || []);
    setLoop(s.loop || false);
    setVoice(s.voice || 'thorsten');
    setPiperParams(s.piperParams || { noiseScale: 0.667, lengthScale: 1.0, speakerNoise: 0.8 });
  });

  socket.on('bot:connected',    () => { setBotStatus(true);  toast('Bot connected to TS3', 'success'); loadBotStatus(); });
  socket.on('bot:disconnected', () => { setBotStatus(false); toast('Bot disconnected', 'error'); });
  socket.on('bot:channels',     ch  => setChannels(ch));
  socket.on('bot:playing',      t   => setNowPlaying(t));
  socket.on('bot:stopped',      ()  => { setNowPlaying(null); clearProgress(); });
  socket.on('bot:volume',       v   => setVolume(v));
  socket.on('bot:error',        e   => toast('Bot error: ' + e.message, 'error'));
  socket.on('bot:queue',        q   => renderQueue(q));
  socket.on('bot:history',      h   => renderHistory(h));
  socket.on('bot:progress',     p   => setProgress(p));
  socket.on('bot:loop',         val => setLoop(val));
  socket.on('bot:voice',        val => setVoice(val));
  socket.on('bot:piper-params', p   => setPiperParams(p));

  // TTS say button (dashboard quick TTS)
  $('tts-btn').addEventListener('click', async () => {
    const text = $('tts-text').value.trim();
    if (!text) return;
    try {
      $('tts-btn').disabled = true;
      await api('POST', '/api/bot/say', { text });
      toast('TTS gestartet', 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { $('tts-btn').disabled = false; }
  });
  $('tts-text').addEventListener('keydown', e => { if (e.key === 'Enter') $('tts-btn').click(); });

  $('loop-checkbox').addEventListener('change', async e => {
    try {
      await api('POST', '/api/bot/loop', { loop: e.target.checked });
    } catch (err) {
      toast('Loop error: ' + err.message, 'error');
      e.target.checked = !e.target.checked;
    }
  });

  // Seek slider
  let _seekTimer = null;
  const seekSlider = $('progress-seek');

  seekSlider.addEventListener('pointerdown', () => { _seeking = true; });
  seekSlider.addEventListener('pointerup',   () => {
    clearTimeout(_seekTimer);
    _seekTimer = setTimeout(async () => {
      try { await api('POST', '/api/bot/seek', { seconds: parseInt(seekSlider.value) }); }
      catch { /* ignore */ }
      _seeking = false;
    }, 50);
  });
  seekSlider.addEventListener('input', () => {
    $('progress-time').textContent = fmtTime(parseInt(seekSlider.value));
  });
}

async function loadBotStatus() {
  try {
    const s = await api('GET', '/api/bot/status');
    setBotStatus(s.connected);
    setNowPlaying(s.nowPlaying);
    setVolume(s.volume);
    setChannels(s.channels);
    renderQueue(s.queue   || []);
    renderHistory(s.history || []);
    setLoop(s.loop || false);
    setVoice(s.voice || 'thorsten');
  } catch { /* ignore */ }
}

// ── Dashboard widgets ─────────────────────────────────────────────────────────
function setBotStatus(online) {
  const badge = $('bot-status-badge');
  badge.textContent = online ? 'Online' : 'Offline';
  badge.className   = `badge ${online ? 'badge-online' : 'badge-offline'}`;
}

function setNowPlaying(track) {
  $('now-playing-title').textContent = track ? track.title : '— idle —';
  $('now-playing-type').textContent  = track ? (track.type === 'youtube' ? '▶ YouTube Stream' : '▶ File') : '';
  if (!track) { clearProgress(); }
  const loopLabel = $('loop-label');
  if (track && track.type === 'file') {
    loopLabel.classList.remove('hidden');
  } else {
    loopLabel.classList.add('hidden');
    $('loop-checkbox').checked = false;
  }
  // Show progress bar and init slider when track has known duration
  if (track && track.duration) {
    const dur = track.duration;
    $('progress-seek').max     = Math.floor(dur);
    $('progress-seek').value   = 0;
    $('progress-seek').disabled = false;
    $('progress-duration').textContent = fmtTime(dur);
    $('progress-time').textContent     = '0:00';
    $('progress-bar-wrap').classList.remove('hidden');
  } else if (track) {
    // Playing but duration unknown — show bar without slider
    $('progress-seek').disabled = true;
    $('progress-seek').value    = 0;
    $('progress-duration').textContent = '';
    $('progress-bar-wrap').classList.remove('hidden');
  }
}

function setLoop(val) {
  $('loop-checkbox').checked = !!val;
}

function setVoice(val) {
  const sel = $('tts-page-voice');
  if (sel && sel.querySelector(`option[value="${val}"]`)) sel.value = val;
}

function fmtTime(secs) {
  const s = Math.floor(secs || 0);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function setVolume(vol) {
  $('vol-slider').value      = vol;
  $('vol-label').textContent = vol + '%';
}

function setChannels(channels) {
  const sel = $('channel-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— select channel —</option>';
  (channels || []).forEach(ch => {
    const opt = document.createElement('option');
    opt.value       = ch.cid;
    opt.textContent = ch.channel_name || `Channel ${ch.cid}`;
    if (ch.cid === cur) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ── Progress ──────────────────────────────────────────────────────────────────
function setProgress({ elapsed, duration }) {
  $('progress-bar-wrap').classList.remove('hidden');
  if (!_seeking) $('progress-time').textContent = fmtTime(elapsed);
  if (duration) {
    const slider = $('progress-seek');
    slider.max = Math.floor(duration);
    $('progress-duration').textContent = fmtTime(duration);
    if (!_seeking) slider.value = Math.floor(elapsed);
  }
}

function clearProgress() {
  $('progress-bar-wrap').classList.add('hidden');
  $('progress-time').textContent     = '0:00';
  $('progress-duration').textContent = '0:00';
  $('progress-seek').value           = 0;
}

// ── Bot connect/disconnect/reconnect ──────────────────────────────────────────
$('btn-connect').addEventListener('click', async () => {
  try { await api('POST', '/api/bot/connect'); toast('Connecting…'); }
  catch (e) { toast(e.message, 'error'); }
});

$('btn-disconnect').addEventListener('click', async () => {
  try { await api('POST', '/api/bot/disconnect'); toast('Disconnected.'); }
  catch (e) { toast(e.message, 'error'); }
});

$('btn-reconnect').addEventListener('click', async () => {
  try { await api('POST', '/api/bot/reconnect'); toast('Reconnecting…'); }
  catch (e) { toast(e.message, 'error'); }
});

// Stop
$('btn-stop').addEventListener('click', async () => {
  try { await api('POST', '/api/bot/stop'); toast('Stopped.'); }
  catch (e) { toast(e.message, 'error'); }
});

// Volume slider (debounced)
let volTimer = null;
$('vol-slider').addEventListener('input', e => {
  $('vol-label').textContent = e.target.value + '%';
  clearTimeout(volTimer);
  volTimer = setTimeout(async () => {
    try { await api('POST', '/api/bot/volume', { volume: +e.target.value }); }
    catch (e) { toast(e.message, 'error'); }
  }, 200);
});

// ── Autocomplete ──────────────────────────────────────────────────────────────
const acInput    = $('quick-play-name');
const acDropdown = $('autocomplete-dropdown');
let acVisible    = false;

function showAutocomplete(filter = '') {
  const term  = filter.toLowerCase();
  const items = term
    ? allFiles.filter(f => f.original_name.toLowerCase().includes(term))
    : allFiles;

  acDropdown.innerHTML = '';
  if (!items.length) { hideAutocomplete(); return; }

  items.slice(0, 20).forEach(f => {
    const div = document.createElement('div');
    div.className   = 'ac-item';
    div.textContent = f.original_name;
    div.addEventListener('mousedown', e => {
      e.preventDefault();
      acInput.value = f.original_name;
      hideAutocomplete();
    });
    acDropdown.appendChild(div);
  });
  acDropdown.classList.remove('hidden');
  acVisible = true;
}

function hideAutocomplete() {
  acDropdown.classList.add('hidden');
  acVisible = false;
}

acInput.addEventListener('focus', () => showAutocomplete(acInput.value));
acInput.addEventListener('input', () => showAutocomplete(acInput.value));
acInput.addEventListener('blur',  () => setTimeout(hideAutocomplete, 150));

acInput.addEventListener('keydown', e => {
  if (!acVisible) return;
  const items = acDropdown.querySelectorAll('.ac-item');
  const cur   = acDropdown.querySelector('.ac-item.selected');
  let idx     = cur ? [...items].indexOf(cur) : -1;
  if (e.key === 'ArrowDown')  { e.preventDefault(); idx = Math.min(idx + 1, items.length - 1); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); idx = Math.max(idx - 1, 0); }
  else if (e.key === 'Enter')     { if (cur) { e.preventDefault(); acInput.value = cur.textContent; hideAutocomplete(); return; } }
  else if (e.key === 'Escape')    { hideAutocomplete(); return; }
  else return;
  items.forEach(i => i.classList.remove('selected'));
  if (items[idx]) { items[idx].classList.add('selected'); items[idx].scrollIntoView({ block: 'nearest' }); }
});

// Quick play
$('quick-play-btn').addEventListener('click', async () => {
  const name = acInput.value.trim();
  if (!name) return;
  try { await api('POST', '/api/bot/play', { name }); toast(`Playing: ${name}`, 'success'); }
  catch (e) { toast(e.message, 'error'); }
});
acInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !acVisible) $('quick-play-btn').click(); });

// Quick queue (file)
$('quick-queue-btn').addEventListener('click', async () => {
  const name = acInput.value.trim();
  if (!name) return;
  const file = allFiles.find(f => f.original_name.toLowerCase() === name.toLowerCase())
            || allFiles.find(f => f.original_name.toLowerCase().includes(name.toLowerCase()));
  if (!file) { toast(`File not found: ${name}`, 'error'); return; }
  try { await api('POST', '/api/bot/queue', { type: 'file', id: file.id }); toast(`Queued: ${file.original_name}`, 'success'); }
  catch (e) { toast(e.message, 'error'); }
});

// YouTube
$('yt-play-btn').addEventListener('click', async () => {
  const url = $('yt-url').value.trim();
  if (!url) return;
  try { toast('Fetching stream…'); await api('POST', '/api/bot/yt', { url }); toast('Streaming!', 'success'); }
  catch (e) { toast(e.message, 'error'); }
});
$('yt-url').addEventListener('keydown', e => { if (e.key === 'Enter') $('yt-play-btn').click(); });

// YouTube queue
$('yt-queue-btn').addEventListener('click', async () => {
  const url = $('yt-url').value.trim();
  if (!url) return;
  try { await api('POST', '/api/bot/queue', { type: 'youtube', url }); toast('Queued YouTube URL', 'success'); }
  catch (e) { toast(e.message, 'error'); }
});

// Channel move
$('channel-move-btn').addEventListener('click', async () => {
  const cid = $('channel-select').value;
  if (!cid) return;
  try { await api('POST', '/api/bot/move', { cid: +cid }); toast('Moved to channel.', 'success'); }
  catch (e) { toast(e.message, 'error'); }
});

// Nickname
$('nickname-btn').addEventListener('click', async () => {
  const nn = $('nickname-input').value.trim();
  if (!nn) return;
  try { await api('POST', '/api/bot/nickname', { nickname: nn }); toast('Nickname updated.', 'success'); }
  catch (e) { toast(e.message, 'error'); }
});
$('nickname-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('nickname-btn').click(); });

// ── Queue ─────────────────────────────────────────────────────────────────────
function renderQueue(queue) {
  const ul  = $('queue-list');
  const cnt = $('queue-count');
  ul.innerHTML = '';
  cnt.textContent = queue.length ? `(${queue.length})` : '';

  if (!queue.length) {
    ul.innerHTML = '<li class="empty-msg" id="queue-empty">Queue is empty.</li>';
    return;
  }

  queue.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.innerHTML = `
      <span class="queue-num">${i + 1}</span>
      <span class="queue-type-icon">${item.type === 'youtube' ? '▶YT' : '♪'}</span>
      <span class="queue-title">${item.title}</span>
      <button class="btn btn-danger btn-sm queue-remove" data-idx="${i}" title="Remove">✕</button>
    `;
    li.querySelector('.queue-remove').addEventListener('click', async () => {
      try { await api('DELETE', `/api/bot/queue/${i}`); }
      catch (e) { toast(e.message, 'error'); }
    });
    ul.appendChild(li);
  });
}

// ── History ───────────────────────────────────────────────────────────────────
function renderHistory(history) {
  const ul = $('history-list');
  ul.innerHTML = '';
  if (!history.length) {
    ul.innerHTML = '<li class="empty-msg">No history yet.</li>';
    return;
  }
  history.forEach(item => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <span class="history-type">${item.type === 'youtube' ? '▶YT' : '♪'}</span>
      <span class="history-title" title="${item.title}">${item.title}</span>
      <button class="btn btn-sm history-replay" title="Play again">▶</button>
    `;
    li.querySelector('.history-replay').addEventListener('click', async () => {
      try {
        if (item.type === 'youtube') {
          toast('Fetching stream…');
          await api('POST', '/api/bot/yt', { url: item.title });
          toast('Streaming!', 'success');
        } else {
          const name = item.title.replace(/\.[^.]+$/, '');
          await api('POST', '/api/bot/play', { name });
          toast(`Playing: ${item.title}`, 'success');
        }
      } catch (e) { toast(e.message, 'error'); }
    });
    ul.appendChild(li);
  });
}

// ── Library ───────────────────────────────────────────────────────────────────
async function loadLibrary() {
  try {
    allFiles = await api('GET', '/api/files');
    renderLibrary();
  } catch (e) { toast(e.message, 'error'); }
}

function renderLibrary() {
  const q    = $('lib-search').value.toLowerCase();
  const rows = allFiles.filter(f => f.original_name.toLowerCase().includes(q));
  const tbody = $('lib-tbody');
  tbody.innerHTML = '';
  $('lib-empty').classList.toggle('hidden', rows.length > 0);

  rows.forEach(f => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${f.filename}">${f.original_name}</td>
      <td>${formatBytes(f.size)}</td>
      <td>${formatDate(f.created_at)}</td>
      <td class="action-cell">
        <button class="btn btn-sm play-btn"  data-id="${f.id}">▶</button>
        <button class="btn btn-sm queue-btn" data-id="${f.id}" title="Add to queue">+Q</button>
        <button class="btn btn-danger btn-sm del-btn" data-id="${f.id}">Delete</button>
      </td>
    `;
    tr.querySelector('.play-btn').addEventListener('click',  () => playFileById(f.id, f.original_name));
    tr.querySelector('.queue-btn').addEventListener('click', () => queueFileById(f.id, f.original_name));
    tr.querySelector('.del-btn').addEventListener('click',   () => deleteFile(f.id, f.original_name));
    tbody.appendChild(tr);
  });

  refreshPlaylistFileSelect();
}

async function playFileById(id, name) {
  try { await api('POST', '/api/bot/playid', { id }); toast(`▶ ${name}`, 'success'); }
  catch (e) { toast(e.message, 'error'); }
}

async function queueFileById(id, name) {
  try { await api('POST', '/api/bot/queue', { type: 'file', id }); toast(`Queued: ${name}`, 'success'); }
  catch (e) { toast(e.message, 'error'); }
}

$('lib-search').addEventListener('input', renderLibrary);

async function deleteFile(id, name) {
  if (!confirm(`Delete "${name}"?`)) return;
  try {
    await api('DELETE', `/api/files/${id}`);
    allFiles = allFiles.filter(f => f.id !== id);
    renderLibrary();
    toast('File deleted.', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Upload ────────────────────────────────────────────────────────────────────
const dropZone = $('drop-zone');
dropZone.addEventListener('click',     () => $('file-input').click());
dropZone.addEventListener('dragover',  e  => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  uploadFiles(e.dataTransfer.files);
});
$('file-input').addEventListener('change', e => uploadFiles(e.target.files));

async function uploadFiles(fileList) {
  for (const file of fileList) {
    const prog   = $('upload-progress');
    const bar    = $('upload-bar');
    const status = $('upload-status');
    prog.classList.remove('hidden');
    status.textContent = `Uploading ${file.name}…`;

    const form = new FormData();
    form.append('file', file);

    await new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files/upload');
      xhr.upload.onprogress = ev => { if (ev.lengthComputable) bar.value = (ev.loaded / ev.total * 100) | 0; };
      xhr.onload = () => {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status === 201) {
          allFiles.unshift(data);
          renderLibrary();
          toast(`Uploaded: ${file.name}`, 'success');
        } else {
          toast(data.error || 'Upload failed', 'error');
        }
        prog.classList.add('hidden');
        resolve();
      };
      xhr.onerror = () => { toast('Upload error', 'error'); prog.classList.add('hidden'); resolve(); };
      xhr.send(form);
    });
  }
  $('file-input').value = '';
}

// ── Playlists ─────────────────────────────────────────────────────────────────
async function loadPlaylists() {
  try {
    allPlaylists = await api('GET', '/api/playlists');
    renderPlaylistList();
    if (allFiles.length === 0) allFiles = await api('GET', '/api/files');
    refreshPlaylistFileSelect();
  } catch (e) { toast(e.message, 'error'); }
}

function renderPlaylistList() {
  const ul = $('pl-list');
  ul.innerHTML = '';
  if (!allPlaylists.length) {
    ul.innerHTML = '<li class="empty-msg">No playlists yet.</li>';
    return;
  }
  allPlaylists.forEach(pl => {
    const li = document.createElement('li');
    li.dataset.id = pl.id;
    if (pl.id === activePl) li.classList.add('active');
    li.innerHTML = `<span class="pl-name">${pl.name}</span><span class="pl-count">${pl.files.length} tracks</span>`;
    li.addEventListener('click', () => openPlaylistEditor(pl.id));
    ul.appendChild(li);
  });
}

function openPlaylistEditor(id) {
  activePl = id;
  const pl = allPlaylists.find(p => p.id === id);
  if (!pl) return;

  $('pl-editor').style.display = '';
  $('pl-editor-name').textContent = pl.name;

  document.querySelectorAll('#pl-list li').forEach(li => {
    li.classList.toggle('active', +li.dataset.id === id);
  });

  const ul = $('pl-editor-files');
  ul.innerHTML = '';
  pl.files.forEach(f => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="file-name">${f.original_name}</span>
      <button class="btn btn-danger btn-sm" data-fid="${f.id}">✕</button>`;
    li.querySelector('button').addEventListener('click', () => removeFromPlaylist(id, f.id));
    ul.appendChild(li);
  });
}

function refreshPlaylistFileSelect() {
  const sel = $('pl-add-file-select');
  sel.innerHTML = '<option value="">— add file —</option>';
  allFiles.forEach(f => {
    const opt = document.createElement('option');
    opt.value       = f.id;
    opt.textContent = f.original_name;
    sel.appendChild(opt);
  });
}

$('new-pl-btn').addEventListener('click', async () => {
  const name = $('new-pl-name').value.trim();
  if (!name) return;
  try {
    const pl = await api('POST', '/api/playlists', { name });
    pl.files = [];
    allPlaylists.push(pl);
    renderPlaylistList();
    $('new-pl-name').value = '';
    toast(`Playlist "${name}" created.`, 'success');
  } catch (e) { toast(e.message, 'error'); }
});

$('pl-add-file-btn').addEventListener('click', async () => {
  const fileId = +$('pl-add-file-select').value;
  if (!fileId || !activePl) return;
  try {
    const { files } = await api('POST', `/api/playlists/${activePl}/files`, { fileId });
    const pl = allPlaylists.find(p => p.id === activePl);
    if (pl) pl.files = files;
    renderPlaylistList();
    openPlaylistEditor(activePl);
  } catch (e) { toast(e.message, 'error'); }
});

async function removeFromPlaylist(plId, fileId) {
  try {
    const { files } = await api('DELETE', `/api/playlists/${plId}/files/${fileId}`);
    const pl = allPlaylists.find(p => p.id === plId);
    if (pl) pl.files = files;
    renderPlaylistList();
    openPlaylistEditor(plId);
  } catch (e) { toast(e.message, 'error'); }
}

$('pl-delete-btn').addEventListener('click', async () => {
  if (!activePl) return;
  const pl = allPlaylists.find(p => p.id === activePl);
  if (!confirm(`Delete playlist "${pl?.name}"?`)) return;
  try {
    await api('DELETE', `/api/playlists/${activePl}`);
    allPlaylists = allPlaylists.filter(p => p.id !== activePl);
    activePl = null;
    $('pl-editor').style.display = 'none';
    renderPlaylistList();
    toast('Playlist deleted.', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

$('pl-play-btn').addEventListener('click', async () => {
  if (!activePl) return;
  try {
    const r = await api('POST', '/api/bot/playlist', { id: activePl });
    toast(`▶ ${r.playlist}`, 'success');
  } catch (e) { toast(e.message, 'error'); }
});

// ── Voice list & TTS Page ──────────────────────────────────────────────────────
async function loadVoiceList() {
  try {
    voiceGroups = await api('GET', '/api/bot/voices');
    populateVoiceDropdowns();
  } catch { /* ignore */ }
}

function populateVoiceDropdowns() {
  // Populate all voice selects on the page
  const selects = [$('tts-page-voice'), $('tts-events-voice')].filter(Boolean);
  const currentVoice = $('tts-page-voice')?.value;

  selects.forEach(sel => {
    const prev = sel.value;
    sel.innerHTML = '';
    for (const [lang, voices] of Object.entries(voiceGroups)) {
      if (voices.length === 0) continue;
      const group = document.createElement('optgroup');
      group.label = voices[0].langLabel;
      voices.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.label;
        group.appendChild(opt);
      });
      sel.appendChild(group);
    }
    // Restore previous selection if still valid
    if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
  });

  // Restore TTS page voice
  if (currentVoice && $('tts-page-voice')?.querySelector(`option[value="${currentVoice}"]`)) {
    $('tts-page-voice').value = currentVoice;
  }
}

function setPiperParams(params) {
  if (!params) return;
  const ns = $('noise-scale');
  const ls = $('length-scale');
  const sn = $('speaker-noise');
  if (ns) { ns.value = params.noiseScale;  $('noise-scale-val').textContent  = params.noiseScale.toFixed(3); }
  if (ls) { ls.value = params.lengthScale; $('length-scale-val').textContent = params.lengthScale.toFixed(2); }
  if (sn) { sn.value = params.speakerNoise; $('speaker-noise-val').textContent = params.speakerNoise.toFixed(3); }
}

async function loadTtsPage() {
  if (!Object.keys(voiceGroups).length) await loadVoiceList();
  populateVoiceDropdowns();
  try {
    const params = await api('GET', '/api/bot/piper-params');
    setPiperParams(params);
  } catch { /* ignore */ }
}

// TTS page voice selector
document.addEventListener('change', e => {
  if (e.target.id === 'tts-page-voice') {
    api('POST', '/api/bot/voice', { voice: e.target.value }).catch(err => toast(err.message, 'error'));
  }
});

// TTS page slider live update
['noise-scale', 'length-scale', 'speaker-noise'].forEach(id => {
  const slider = $(id);
  if (!slider) return;
  slider.addEventListener('input', () => {
    const valId = id + '-val';
    $(valId).textContent = parseFloat(slider.value).toFixed(id === 'length-scale' ? 2 : 3);
  });
});

// Save Piper params
$('piper-save-btn')?.addEventListener('click', async () => {
  try {
    const params = await api('POST', '/api/bot/piper-params', {
      noiseScale:  parseFloat($('noise-scale').value),
      lengthScale: parseFloat($('length-scale').value),
      speakerNoise: parseFloat($('speaker-noise').value),
    });
    setPiperParams(params);
    toast('Parameters saved.', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

// Reset Piper params
$('piper-reset-btn')?.addEventListener('click', async () => {
  try {
    const params = await api('POST', '/api/bot/piper-params', {
      noiseScale: 0.667,
      lengthScale: 1.0,
      speakerNoise: 0.8,
    });
    setPiperParams(params);
    toast('Parameters reset to defaults.', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

// TTS page say button
$('tts-page-btn')?.addEventListener('click', async () => {
  const text = $('tts-page-text').value.trim();
  if (!text) return;
  try {
    $('tts-page-btn').disabled = true;
    await api('POST', '/api/bot/say', {
      text,
      voice: $('tts-page-voice')?.value || undefined,
      noiseScale:  parseFloat($('noise-scale')?.value),
      lengthScale: parseFloat($('length-scale')?.value),
      speakerNoise: parseFloat($('speaker-noise')?.value),
    });
    toast('TTS gestartet', 'success');
  } catch (err) { toast(err.message, 'error'); }
  finally { $('tts-page-btn').disabled = false; }
});
$('tts-page-text')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('tts-page-btn').click(); } });

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  if (!currentUser) {
    try { currentUser = await api('GET', '/api/auth/me'); } catch { /* ignore */ }
  }
  if (currentUser?.role !== 'admin') {
    $('users-tbody').innerHTML = '<tr><td colspan="3" class="empty-msg">Admin access required.</td></tr>';
    return;
  }
  try {
    const users = await api('GET', '/api/users');
    renderUsers(users);
  } catch (e) {
    toast('Could not load users: ' + e.message, 'error');
    $('users-tbody').innerHTML = `<tr><td colspan="3" class="empty-msg" style="color:var(--danger)">${e.message}</td></tr>`;
  }
  loadCookiesStatus();
  loadChatFeedback();
  loadTtsEvents();
}

function renderUsers(users) {
  const tbody = $('users-tbody');
  tbody.innerHTML = '';
  users.forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${u.username}</td>
      <td>${u.role}</td>
      <td>${u.id !== currentUser.id
        ? `<button class="btn btn-danger btn-sm" data-uid="${u.id}">Delete</button>`
        : '<span style="color:var(--text-muted)">you</span>'}</td>
    `;
    tr.querySelector('[data-uid]')?.addEventListener('click', () => deleteUser(u.id, u.username));
    tbody.appendChild(tr);
  });
}

async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"?`)) return;
  try {
    await api('DELETE', `/api/users/${id}`);
    toast('User deleted.', 'success');
    loadSettings();
  } catch (e) { toast(e.message, 'error'); }
}

$('create-user-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('new-username').value.trim();
  const password = $('new-password').value;
  const role     = $('new-role').value;
  $('create-user-error').classList.add('hidden');
  try {
    await api('POST', '/api/users', { username, password, role });
    toast(`User "${username}" created.`, 'success');
    $('new-username').value = '';
    $('new-password').value = '';
    loadSettings();
  } catch (err) {
    $('create-user-error').textContent = err.message;
    $('create-user-error').classList.remove('hidden');
  }
});

// ── Chat Feedback ─────────────────────────────────────────────────────────────
const CHAT_LABELS = { play: 'Play (files)', stop: 'Stop', volume: 'Volume', youtube: 'YouTube', playlist: 'Playlist' };

async function loadChatFeedback() {
  try {
    const settings = await api('GET', '/api/settings/chat');
    const wrap = $('chat-feedback-toggles');
    wrap.innerHTML = '';
    Object.entries(CHAT_LABELS).forEach(([key, label]) => {
      const row = document.createElement('label');
      row.className = 'toggle-row';
      row.innerHTML = `
        <span>${label}</span>
        <input type="checkbox" data-key="${key}" ${settings[key] !== false ? 'checked' : ''} />
      `;
      row.querySelector('input').addEventListener('change', async ev => {
        try {
          await api('POST', '/api/settings/chat', { [key]: ev.target.checked });
        } catch (e) { toast(e.message, 'error'); ev.target.checked = !ev.target.checked; }
      });
      wrap.appendChild(row);
    });
  } catch (e) { toast('Could not load chat settings: ' + e.message, 'error'); }
}

// ── YouTube cookies ───────────────────────────────────────────────────────────
async function loadCookiesStatus() {
  try {
    const s = await api('GET', '/api/cookies/status');
    const row = $('cookies-status-row');
    const del = $('cookies-delete-btn');
    if (s.present) {
      const d = new Date(s.uploadedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      row.innerHTML = `<span class="badge badge-online">Cookies present</span> <span style="color:var(--text-muted);font-size:.85em">uploaded ${d}</span>`;
      del.style.display = '';
    } else {
      row.innerHTML = `<span class="badge badge-offline">No cookies</span>`;
      del.style.display = 'none';
    }
  } catch { /* ignore */ }
}

$('cookies-upload-btn').addEventListener('click', async () => {
  const file = $('cookies-file-input').files[0];
  if (!file) { toast('Select a cookies.txt file first.', 'error'); return; }
  const form = new FormData();
  form.append('cookies', file);
  try {
    const res  = await fetch('/api/cookies/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast('Cookies uploaded.', 'success');
    $('cookies-file-input').value = '';
    loadCookiesStatus();
  } catch (err) { toast(err.message, 'error'); }
});

$('cookies-delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete YouTube cookies?')) return;
  try {
    await api('DELETE', '/api/cookies');
    toast('Cookies deleted.', 'success');
    loadCookiesStatus();
  } catch (err) { toast(err.message, 'error'); }
});

// ── TTS Event Announcements ───────────────────────────────────────────────────
async function loadTtsEvents() {
  try {
    if (!Object.keys(voiceGroups).length) await loadVoiceList();
    populateVoiceDropdowns();
    const s = await api('GET', '/api/settings/tts-events');
    if ($('tts-events-voice').querySelector(`option[value="${s.voice || 'thorsten'}"]`))
      $('tts-events-voice').value = s.voice || 'thorsten';
    $('tts-join-enabled').checked  = !!s.join?.enabled;
    $('tts-join-text').value       = s.join?.text  || '';
    $('tts-leave-enabled').checked = !!s.leave?.enabled;
    $('tts-leave-text').value      = s.leave?.text || '';
  } catch (e) { toast('Could not load TTS event settings: ' + e.message, 'error'); }
}

$('tts-events-save-btn').addEventListener('click', async () => {
  const body = {
    voice: $('tts-events-voice').value,
    join:  { enabled: $('tts-join-enabled').checked,  text: $('tts-join-text').value.trim()  || 'Hallo {username}' },
    leave: { enabled: $('tts-leave-enabled').checked, text: $('tts-leave-text').value.trim() || 'Tschüss {username}' },
  };
  try {
    await api('POST', '/api/settings/tts-events', body);
    const msg = $('tts-events-msg');
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 2000);
  } catch (e) { toast(e.message, 'error'); }
});

// Identity upload
$('identity-form').addEventListener('submit', async e => {
  e.preventDefault();
  const file = $('identity-file-input').files[0];
  if (!file) return;
  const form = new FormData();
  form.append('identity', file);
  try {
    const res  = await fetch('/api/identity/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    $('identity-status').textContent = data.message;
    $('identity-status').style.color = 'var(--success)';
    $('identity-status').classList.remove('hidden');
  } catch (err) {
    $('identity-status').textContent = err.message;
    $('identity-status').style.color = 'var(--danger)';
    $('identity-status').classList.remove('hidden');
  }
});
