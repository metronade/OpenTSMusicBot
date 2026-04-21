'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db/init');
const config  = require('../config');

const router = express.Router();

// ── Multer configuration ──────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.MUSIC_DIR),
  filename: (req, file, cb) => {
    const ext      = path.extname(file.originalname).toLowerCase();
    const safeName = uuidv4() + ext;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.UPLOAD_MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (config.ALLOWED_MIMETYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: mp3, ogg, wav, flac, m4a`));
    }
  },
});

// ── GET /api/files ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json(db.getAllFiles());
});

// ── POST /api/files/upload ────────────────────────────────────────────────────
router.post('/upload', (req, res) => {
  upload.single('file')(req, res, err => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large (max ${config.UPLOAD_MAX_MB} MB)` });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const record = db.insertFile(
      req.file.filename,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
    );

    res.status(201).json({
      id:            record.lastInsertRowid,
      filename:      req.file.filename,
      original_name: req.file.originalname,
      mimetype:      req.file.mimetype,
      size:          req.file.size,
    });
  });
});

// ── DELETE /api/files/:id ─────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const file = db.getFileById(id);

  if (!file) return res.status(404).json({ error: 'File not found' });

  // Remove physical file
  const fullPath = path.join(config.MUSIC_DIR, file.filename);
  try { fs.unlinkSync(fullPath); } catch { /* already gone */ }

  db.deleteFile(id);
  res.json({ ok: true });
});

module.exports = router;
