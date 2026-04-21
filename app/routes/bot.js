'use strict';

const express  = require('express');
const ts3query = require('../services/ts3query');
const audio    = require('../services/audio');

const router = express.Router();

// GET /api/bot/status
router.get('/status', (req, res) => {
  res.json({
    connected:   ts3query.isConnected(),
    nowPlaying:  audio.getCurrentTrack(),
    volume:      audio.getVolume(),
    channels:    ts3query.getCachedChannels(),
    queue:       audio.getQueue(),
    history:     audio.getHistory(),
    loop:        audio.getLoop(),
    voice:       audio.getVoice(),
  });
});

// POST /api/bot/reconnect
router.post('/reconnect', (req, res) => {
  ts3query.disconnect();
  setTimeout(() => ts3query.connect(), 500);
  res.json({ ok: true });
});

// POST /api/bot/disconnect
router.post('/disconnect', (req, res) => {
  ts3query.disconnect();
  res.json({ ok: true });
});

// POST /api/bot/connect
router.post('/connect', (req, res) => {
  ts3query.connect();
  res.json({ ok: true });
});

// GET /api/bot/channels
router.get('/channels', async (req, res) => {
  try {
    const channels = await ts3query.getChannels();
    res.json(channels);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// POST /api/bot/nickname
router.post('/nickname', async (req, res) => {
  const { nickname } = req.body;
  if (!nickname || !nickname.trim()) {
    return res.status(400).json({ error: 'Nickname required' });
  }
  if (nickname.length > 30) {
    return res.status(400).json({ error: 'Nickname too long (max 30 chars)' });
  }
  try {
    await ts3query.changeNickname(nickname.trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// POST /api/bot/move  { cid: number }
router.post('/move', async (req, res) => {
  const cid = parseInt(req.body.cid, 10);
  if (!cid || isNaN(cid)) {
    return res.status(400).json({ error: 'Valid channel ID required' });
  }
  try {
    await ts3query.moveToChannel(cid);
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// POST /api/bot/volume  { volume: 0-100 }
router.post('/volume', (req, res) => {
  const vol = parseInt(req.body.volume, 10);
  if (isNaN(vol) || vol < 0 || vol > 100) {
    return res.status(400).json({ error: 'Volume must be 0–100' });
  }
  const actual = audio.setVolume(vol);
  res.json({ volume: actual });
});

// POST /api/bot/stop
router.post('/stop', (req, res) => {
  audio.stop();
  res.json({ ok: true });
});

// POST /api/bot/play  { name: string }
router.post('/play', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const db     = require('../db/init');
  const record = db.findFileRecordByName(name);
  if (!record) {
    console.warn('[play] not found:', JSON.stringify(name));
    return res.status(404).json({ error: `File not found: ${name}` });
  }

  try {
    const r = await audio.playFile(record.path, record.original_name);
    res.json({ ok: true, superseded: !!r?.superseded, track: audio.getCurrentTrack() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bot/playid  { id: number }  — used by library play button
router.post('/playid', async (req, res) => {
  const id   = parseInt(req.body.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'File ID required' });

  const db   = require('../db/init');
  const file = db.getFileById(id);
  if (!file) return res.status(404).json({ error: `File ID ${id} not found` });

  const filePath = require('path').join(require('../config').MUSIC_DIR, file.filename);
  try {
    const r = await audio.playFile(filePath, file.original_name);
    res.json({ ok: true, superseded: !!r?.superseded, track: audio.getCurrentTrack() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bot/yt  { url: string }
router.post('/yt', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const r = await audio.playYoutube(url);
    res.json({ ok: true, superseded: !!r?.superseded, track: audio.getCurrentTrack() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bot/playlist  { id: number }
router.post('/playlist', async (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Playlist ID required' });

  const db     = require('../db/init');
  const pl     = db.getPlaylistById(id);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });

  const objects = db.getPlaylistFileObjects(id);
  if (!objects.length) return res.status(400).json({ error: 'Playlist is empty' });

  try {
    await audio.playPlaylist(objects);
    res.json({ ok: true, playlist: pl.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bot/queue
router.get('/queue', (req, res) => {
  res.json(audio.getQueue());
});

// POST /api/bot/queue  { type:'file', id:number } | { type:'youtube', url:string }
router.post('/queue', async (req, res) => {
  const { type, id, url } = req.body;
  const path = require('path');

  if (type === 'file') {
    const db   = require('../db/init');
    const file = db.getFileById(parseInt(id, 10));
    if (!file) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(require('../config').MUSIC_DIR, file.filename);
    audio.addToQueue({ type: 'file', path: filePath, title: file.original_name });
    return res.json({ ok: true });
  }
  if (type === 'youtube') {
    if (!url) return res.status(400).json({ error: 'URL required' });
    audio.addToQueue({ type: 'youtube', url, title: url });
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'type must be file or youtube' });
});

// DELETE /api/bot/queue/:index
router.delete('/queue/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx)) return res.status(400).json({ error: 'Invalid index' });
  audio.removeFromQueue(idx);
  res.json({ ok: true });
});

// GET /api/bot/history
router.get('/history', (req, res) => {
  res.json(audio.getHistory());
});

// POST /api/bot/seek  { seconds: number }
router.post('/seek', async (req, res) => {
  const seconds = parseFloat(req.body.seconds);
  if (isNaN(seconds) || seconds < 0) return res.status(400).json({ error: 'seconds required' });
  try {
    await audio.seek(seconds);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bot/loop  { loop?: boolean }  — omit to toggle
router.post('/loop', (req, res) => {
  const track = audio.getCurrentTrack();
  if (track && track.type === 'youtube')
    return res.status(400).json({ error: 'Loop not available for YouTube streams' });
  const val = typeof req.body.loop === 'boolean' ? req.body.loop : !audio.getLoop();
  res.json({ loop: audio.setLoop(val) });
});

// GET /api/bot/voice
router.get('/voice', (req, res) => {
  res.json({ voice: audio.getVoice() });
});

// POST /api/bot/voice  { voice: 'thorsten'|'kerstin' }
router.post('/voice', (req, res) => {
  const { voice } = req.body;
  if (!['thorsten', 'kerstin'].includes(voice))
    return res.status(400).json({ error: 'voice must be thorsten or kerstin' });
  res.json({ voice: audio.setVoice(voice) });
});

// POST /api/bot/say  { text: string }
router.post('/say', async (req, res) => {
  const text = (req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    await audio.say(text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
