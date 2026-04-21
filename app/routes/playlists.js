'use strict';

const express = require('express');
const db      = require('../db/init');

const router = express.Router();

// GET /api/playlists
router.get('/', (req, res) => {
  const lists = db.getAllPlaylists();
  const result = lists.map(pl => ({
    ...pl,
    files: db.getPlaylistFiles(pl.id),
  }));
  res.json(result);
});

// GET /api/playlists/:id
router.get('/:id', (req, res) => {
  const pl = db.getPlaylistById(parseInt(req.params.id, 10));
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  res.json({ ...pl, files: db.getPlaylistFiles(pl.id) });
});

// POST /api/playlists  { name: string }
router.post('/', (req, res) => {
  const name = req.body.name?.trim();
  if (!name) return res.status(400).json({ error: 'Name required' });

  try {
    const result = db.createPlaylist(name);
    res.status(201).json({ id: result.lastInsertRowid, name, files: [] });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Playlist name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/playlists/:id  { name: string }
router.patch('/:id', (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const name = req.body.name?.trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (!db.getPlaylistById(id)) return res.status(404).json({ error: 'Playlist not found' });

  db.renamePlaylist(id, name);
  res.json({ ok: true });
});

// DELETE /api/playlists/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.getPlaylistById(id)) return res.status(404).json({ error: 'Playlist not found' });
  db.deletePlaylist(id);
  res.json({ ok: true });
});

// POST /api/playlists/:id/files  { fileId: number }
router.post('/:id/files', (req, res) => {
  const plId   = parseInt(req.params.id, 10);
  const fileId = parseInt(req.body.fileId, 10);

  if (!db.getPlaylistById(plId)) return res.status(404).json({ error: 'Playlist not found' });
  if (!db.getFileById(fileId))   return res.status(404).json({ error: 'File not found' });

  db.addFileToPlaylist(plId, fileId);
  res.json({ ok: true, files: db.getPlaylistFiles(plId) });
});

// DELETE /api/playlists/:id/files/:fileId
router.delete('/:id/files/:fileId', (req, res) => {
  const plId   = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);

  if (!db.getPlaylistById(plId)) return res.status(404).json({ error: 'Playlist not found' });
  db.removeFileFromPlaylist(plId, fileId);
  res.json({ ok: true, files: db.getPlaylistFiles(plId) });
});

// PUT /api/playlists/:id/files  — full reorder [ { fileId, order } ]
router.put('/:id/files', (req, res) => {
  const plId  = parseInt(req.params.id, 10);
  const order = req.body.order; // [{ fileId, index }]

  if (!db.getPlaylistById(plId)) return res.status(404).json({ error: 'Playlist not found' });
  if (!Array.isArray(order))     return res.status(400).json({ error: 'order array required' });

  for (const item of order) {
    db.reorderPlaylist(plId, parseInt(item.fileId, 10), parseInt(item.index, 10));
  }
  res.json({ ok: true, files: db.getPlaylistFiles(plId) });
});

module.exports = router;
