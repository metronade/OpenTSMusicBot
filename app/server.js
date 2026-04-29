'use strict';

const path         = require('path');
const os           = require('os');
const fs           = require('fs');
const http         = require('http');
const express      = require('express');
const { Server: SocketIO } = require('socket.io');
const session      = require('express-session');
const SqliteStore  = require('connect-sqlite3')(session);
const rateLimit    = require('express-rate-limit');

const config    = require('./config');
const db        = require('./db/init');
const ts3query  = require('./services/ts3query');
const audio     = require('./services/audio');
const { getVoice, getAllVoiceIds, VOICES } = require('./voices');
const log       = require('./services/logger').createLogger('[App]');

const authRouter      = require('./routes/auth');
const botRouter       = require('./routes/bot');
const filesRouter     = require('./routes/files');
const playlistsRouter = require('./routes/playlists');
const radiosRouter    = require('./routes/radios');

const { version } = require('./package.json');

// ── Express + Socket.io setup ────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new SocketIO(server, { cors: { origin: false } });

const sessionMiddleware = session({
  secret:            config.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  store: new SqliteStore({
    db:    path.basename(config.DB_PATH),
    dir:   path.dirname(config.DB_PATH),
    table: 'sessions',
  }),
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
});

app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, socket.request.res || {}, next));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health endpoint (no auth, no rate limit) ─────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ts3: ts3query.isConnected(),
    uptime: Math.floor(process.uptime()),
    version,
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth/login', loginLimiter);
app.use('/api/', apiLimiter);

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    log.warn('requireAdmin: no session for', req.method, req.path);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = db.getUserById(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',      authRouter);
app.use('/api/bot',       requireAuth, botRouter);
app.use('/api/files',     requireAuth, filesRouter);
app.use('/api/playlists', requireAuth, playlistsRouter);
app.use('/api/radios',    requireAuth, radiosRouter);

// User management (admin only)
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.getAllUsers());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role = 'user' } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'role must be admin or user' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be >= 6 chars' });

  try {
    const r = db.createUser(username, password, role);
    res.status(201).json({ id: r.lastInsertRowid, username, role });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.deleteUser(id);
  res.json({ ok: true });
});

// Backup (admin only)
app.get('/api/backup/db', requireAdmin, (req, res) => {
  const backupPath = path.join(os.tmpdir(), `backup_${Date.now()}.sqlite`);
  try {
    db.db.backup(backupPath).then(() => {
      const filename = `ts3bot_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
      res.download(backupPath, filename, (err) => {
        try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
        if (err) log.error('Backup download error:', err.message);
      });
    }).catch(err => {
      res.status(500).json({ error: 'Backup failed: ' + err.message });
    });
  } catch (err) {
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

// Identity upload
app.post('/api/identity/upload', requireAdmin, (req, res) => {
  const multer = require('multer');
  const upload = multer({ dest: '/app/identities/', limits: { fileSize: 1024 * 1024 } });
  upload.single('identity')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const dest = '/app/identities/identity.ini';
    try {
      fs.renameSync(req.file.path, dest);
      res.json({ ok: true, message: 'Identity uploaded. Restart the ts3client container to apply.' });
    } catch (e) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      res.status(500).json({ error: e.message });
    }
  });
});

// YouTube cookies upload / status / delete
app.get('/api/cookies/status', requireAdmin, (req, res) => {
  try {
    const stat = fs.statSync(config.COOKIES_PATH);
    res.json({ present: true, uploadedAt: stat.mtime });
  } catch {
    res.json({ present: false, uploadedAt: null });
  }
});

app.post('/api/cookies/upload', requireAdmin, (req, res) => {
  const multer = require('multer');
  const upload = multer({ dest: path.dirname(config.COOKIES_PATH), limits: { fileSize: 5 * 1024 * 1024 } });
  upload.single('cookies')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    try {
      fs.renameSync(req.file.path, config.COOKIES_PATH);
      res.json({ ok: true });
    } catch (e) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      res.status(500).json({ error: e.message });
    }
  });
});

app.delete('/api/cookies', requireAdmin, (req, res) => {
  try { fs.unlinkSync(config.COOKIES_PATH); } catch { /* already gone */ }
  res.json({ ok: true });
});

// Chat feedback settings
app.get('/api/settings/chat', requireAdmin, (req, res) => {
  res.json(db.getSetting('chat_feedback'));
});

app.post('/api/settings/chat', requireAdmin, (req, res) => {
  const allowed = ['play', 'stop', 'volume', 'youtube', 'playlist'];
  const current = db.getSetting('chat_feedback');
  for (const key of allowed) {
    if (key in req.body) current[key] = !!req.body[key];
  }
  db.setSetting('chat_feedback', current);
  res.json(current);
});

// Dynamic nickname settings
app.get('/api/settings/dynamic-nickname', requireAdmin, (req, res) => {
  res.json(db.getSetting('dynamic_nickname'));
});

app.post('/api/settings/dynamic-nickname', requireAdmin, (req, res) => {
  const current = db.getSetting('dynamic_nickname') || { enabled: false, base: config.TS3_NICKNAME };  if ('enabled' in req.body) current.enabled = !!req.body.enabled;
  if (typeof req.body.base === 'string') current.base = req.body.base.trim().slice(0, 30) || config.TS3_NICKNAME;
  db.setSetting('dynamic_nickname', current);
  // Apply immediately: revert to base or update if radio is playing
  if (current.enabled) {
    const track = audio.getCurrentTrack();
    if (track?.type === 'radio') {
      const label = `${current.base} [Radio: ${track.title}]`;
      ts3query.changeNickname(label.slice(0, 30)).catch(() => {});
    } else {
      ts3query.changeNickname(current.base.slice(0, 30)).catch(() => {});
    }
  }
  res.json(current);
});

// TTS event announcements settings
app.get('/api/settings/tts-events', requireAdmin, (req, res) => {
  res.json(db.getSetting('tts_events'));
});

app.post('/api/settings/tts-events', requireAdmin, (req, res) => {
  const current = db.getSetting('tts_events');
  if (req.body.voice && getVoice(req.body.voice)) current.voice = req.body.voice;
  for (const event of ['join', 'leave']) {
    if (event in req.body) {
      const e = req.body[event];
      if (typeof e.enabled === 'boolean') current[event].enabled = e.enabled;
      if (typeof e.text === 'string' && e.text.trim()) current[event].text = e.text.trim().slice(0, 200);
    }
  }
  db.setSetting('tts_events', current);
  res.json(current);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  if (!socket.request.session?.userId) {
    socket.disconnect(true);
    return;
  }

  socket.emit('state', {
    connected:  ts3query.isConnected(),
    nowPlaying: audio.getCurrentTrack(),
    volume:     audio.getVolume(),
    channels:   ts3query.getCachedChannels(),
    queue:      audio.getQueue(),
    history:    audio.getHistory(),
    loop:       audio.getLoop(),
    voice:      audio.getVoice(),
    piperParams: audio.getPiperParams(),
  });
});

ts3query.on('connected',    data     => io.emit('bot:connected',    data));
ts3query.on('disconnected', ()       => io.emit('bot:disconnected'));
ts3query.on('channels',     channels => io.emit('bot:channels',     channels));

audio.on('playing',  track   => {
  io.emit('bot:playing', track);
  // Dynamic nickname: show [Radio: name] when radio is playing
  const dn = db.getSetting('dynamic_nickname');
  if (dn?.enabled && track?.type === 'radio') {
    const label = `${dn.base || config.TS3_NICKNAME} [Radio: ${track.title}]`;
    ts3query.changeNickname(label.slice(0, 30)).catch(() => {});
  }
});
audio.on('stopped',  ()      => {
  io.emit('bot:stopped');
  // Dynamic nickname: revert to base when playback stops
  const dn = db.getSetting('dynamic_nickname');
  if (dn?.enabled) {
    ts3query.changeNickname((dn.base || config.TS3_NICKNAME).slice(0, 30)).catch(() => {});
  }
});
audio.on('volume',   vol     => io.emit('bot:volume',   vol));
audio.on('error',    err     => io.emit('bot:error',    { message: err.message }));
audio.on('queue',    queue   => io.emit('bot:queue',    queue));
audio.on('history',  history => io.emit('bot:history',  history));
audio.on('progress', prog    => io.emit('bot:progress', prog));
audio.on('loop',     val     => io.emit('bot:loop',     val));
audio.on('voice',    val     => io.emit('bot:voice',    val));
audio.on('piper-params', p   => io.emit('bot:piper-params', p));

// ── TTS event announcements ───────────────────────────────────────────────────
function handleTtsEvent(eventKey, nickname) {
  let cfg = {};
  try { cfg = db.getSetting('tts_events') || {}; } catch { /* ignore */ }
  const ev = cfg[eventKey];
  if (!ev || !ev.enabled) return;
  const text = (ev.text || '').replace(/\{username\}/gi, nickname).slice(0, 300);
  if (text) audio.say(text, cfg.voice || 'thorsten').catch(() => {});
}

ts3query.on('clientjoin',  ({ nickname }) => handleTtsEvent('join',  nickname));
ts3query.on('clientleave', ({ nickname }) => handleTtsEvent('leave', nickname));

// ── Chat command handler ──────────────────────────────────────────────────────
ts3query.on('textmessage', async payload => {
  const msg = payload.msg?.trim();
  if (!msg?.startsWith('!')) return;
  if (payload.invokerid && payload.invokerid === ts3query._myClid) return;

  const [cmd, ...rest] = msg.split(/\s+/);
  const arg = rest.join(' ');

  let cf = {};
  try { cf = db.getSetting('chat_feedback') || {}; } catch { /* ignore */ }

  const reply = async (text, category) => {
    if (category && cf[category] === false) return;
    try { await ts3query.sendChannelMessage(text); } catch { /* ignore */ }
  };

  try {
    switch (cmd.toLowerCase()) {

      case '!play': {
        if (!arg) { await reply('Usage: !play <name>'); return; }
        const record = db.findFileRecordByName(arg);
        if (!record) { await reply(`File not found: ${arg}`); return; }
        const pr = await audio.playFile(record.path, record.original_name);
        if (pr?.superseded) return;
        io.emit('bot:playing', audio.getCurrentTrack());
        await reply(`Now playing: ${record.original_name}`, 'play');
        break;
      }

      case '!yt': {
        if (!arg) { await reply('Usage: !yt <url>'); return; }
        const ytUrl = arg.replace(/\[URL(?:=[^\]]+)?\](.*?)\[\/URL\]/gi, '$1').trim();
        const yr = await audio.playYoutube(ytUrl);
        if (yr?.superseded) return;
        io.emit('bot:playing', audio.getCurrentTrack());
        await reply(`Streaming: ${ytUrl}`, 'youtube');
        break;
      }

      case '!radio': {
        if (!arg) { await reply('Usage: !radio <url|name>'); return; }
        let radioUrl = arg;
        let radioTitle = arg;
        const station = db.getRadioByName(arg);
        if (station) { radioUrl = station.url; radioTitle = station.name; }
        else if (!audio._isValidUrl(arg)) { await reply('Unknown station or invalid URL.'); return; }
        await audio.playRadio(radioUrl, radioTitle);
        await reply(`Radio: ${radioTitle}`, 'play');
        break;
      }

      case '!radio-list': {
        const radios = db.getAllRadios();
        if (!radios.length) { await reply('No radio stations saved.'); return; }
        const list = radios.map(r => `${r.name}`).join(' | ');
        await reply(`Radios: ${list}`);
        break;
      }

      case '!playlist': {
        if (!arg) { await reply('Usage: !playlist <name>'); return; }
        const pl = db.getPlaylistByName(arg);
        if (!pl) { await reply(`Playlist not found: ${arg}`); return; }
        const objects = db.getPlaylistFileObjects(pl.id);
        if (!objects.length) { await reply('Playlist is empty.'); return; }
        await audio.playPlaylist(objects);
        await reply(`Starting playlist: ${pl.name} (${objects.length} tracks)`, 'playlist');
        break;
      }

      case '!vol': {
        const v = parseInt(arg, 10);
        if (isNaN(v) || v < 0 || v > 100) { await reply('Usage: !vol <0-100>'); return; }
        audio.setVolume(v);
        await reply(`Volume: ${v}%`, 'volume');
        break;
      }

      case '!stop': {
        audio.stop();
        await reply('Stopped.', 'stop');
        break;
      }

      case '!skip': {
        audio.skip();
        await reply('Skipped.', 'play');
        break;
      }

      case '!queue': {
        if (arg) {
          const record = db.findFileRecordByName(arg);
          if (!record) { await reply(`File not found: ${arg}`); return; }
          audio.addToQueue({ type: 'file', path: record.path, title: record.original_name });
          await reply(`+ Queue: ${record.original_name}`, 'play');
        } else {
          const q = audio.getQueue();
          if (!q.length) { await reply('Queue is empty.'); return; }
          const list = q.slice(0, 5).map((item, i) => `${i + 1}. ${item.title}`).join(' | ');
          await reply(`Queue (${q.length}): ${list}`);
        }
        break;
      }

      case '!loop': {
        const track = audio.getCurrentTrack();
        if (track && (track.type === 'youtube' || track.type === 'radio')) {
          await reply('Loop not available for streams.');
          return;
        }
        const looping = audio.setLoop(!audio.getLoop());
        await reply(looping ? 'Loop enabled.' : 'Loop disabled.');
        break;
      }

      case '!say': {
        const text = arg.replace(/^["']|["']$/g, '').trim();
        if (!text) { await reply('Usage: !say <text>'); return; }
        await audio.say(text.slice(0, 300));
        break;
      }

      case '!voice': {
        const v = arg.toLowerCase().trim();
        if (!v || !getVoice(v)) {
          const names = VOICES.map(vc => vc.id).join(', ');
          await reply(`Current voice: ${audio.getVoice()} – Change with: !voice <name>\nAvailable: ${names}`);
          return;
        }
        audio.setVoice(v);
        await reply(`Voice changed: ${v}`);
        break;
      }

      case '!list': {
        const files     = db.getAllFiles().map(f => f.original_name);
        const playlists = db.getAllPlaylists().map(p => p.name);
        if (!files.length && !playlists.length) { await reply('No files or playlists.'); return; }
        if (files.length) {
          const chunks = [];
          for (let i = 0; i < files.length; i += 5)
            chunks.push(files.slice(i, i + 5).join(' | '));
          await ts3query.sendChannelMessage(`Files (${files.length}): ${chunks[0]}`);
          for (const c of chunks.slice(1)) await ts3query.sendChannelMessage(c);
        }
        if (playlists.length)
          await ts3query.sendChannelMessage(`Playlists (${playlists.length}): ${playlists.join(' | ')}`);
        break;
      }

      case '!help': {
        const lines = [
          '=== Music Bot Commands ===',
          '!list                      – Files and playlists',
          '!play <name>               – Play a file',
          '!queue                     – Show queue (max 5)',
          '!queue <name>              – Add file to queue',
          '!skip                      – Skip to next track',
          '!loop                      – Toggle loop for current song',
          '!yt <url>                  – Stream YouTube audio',
          '!radio <url|name>          – Play radio stream',
          '!radio-list                – List saved radio stations',
          '!playlist <name>           – Play a playlist',
          '!vol <0-100>               – Set volume',
          '!stop                      – Stop playback',
          '!say <text>                – Text to speech (TTS)',
          '!voice <name>              – Change TTS voice',
          '!help                      – Show all commands',
        ];
        for (const line of lines) {
          await ts3query.sendChannelMessage(line);
          await new Promise(r => setTimeout(r, 600));
        }
        break;
      }
    }
  } catch (err) {
    log.error('Command', cmd, err.message);
    await reply(`Error: ${err.message}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(config.PORT, '0.0.0.0', () => {
  log.info(`Web UI listening on http://0.0.0.0:${config.PORT}`);
  log.info(`Database: ${config.DB_PATH}`);
  log.info('Default login: admin / admin  (change on first login)');
  ts3query.connect();
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  audio.stop();
  ts3query.disconnect();
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  audio.stop();
  ts3query.disconnect();
  server.close(() => process.exit(0));
});
