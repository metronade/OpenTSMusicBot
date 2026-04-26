'use strict';

const express = require('express');
const db      = require('../db/init');

const router = express.Router();

// GET /api/radios
router.get('/', (req, res) => {
  res.json(db.getAllRadios());
});

// POST /api/radios  { name, url }
router.post('/', (req, res) => {
  const { name, url } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (!url || !url.trim()) return res.status(400).json({ error: 'URL required' });
  try {
    const r = db.createRadio(name.trim(), url.trim());
    res.status(201).json({ id: r.lastInsertRowid, name: name.trim(), url: url.trim() });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Radio name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/radios/:id  { name?, url? }
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  const existing = db.getRadioById(id);
  if (!existing) return res.status(404).json({ error: 'Radio not found' });
  const name = (req.body.name || existing.name).trim();
  const url  = (req.body.url  || existing.url).trim();
  if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });
  try {
    db.updateRadio(id, name, url);
    res.json({ id, name, url });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Radio name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/radios/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  db.deleteRadio(id);
  res.json({ ok: true });
});

module.exports = router;
