'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db/init');

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = db.getUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.userId = user.id;
  req.session.role   = user.role;

  res.json({
    id:             user.id,
    username:       user.username,
    role:           user.role,
    mustChangePassword: user.must_change_pw === 1,
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/auth/me  — check current session
router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.getUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({
    id:             user.id,
    username:       user.username,
    role:           user.role,
    mustChangePassword: user.must_change_pw === 1,
  });
});

// POST /api/auth/change-password
router.post('/change-password', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Both current and new password required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const user = db.getUserById(req.session.userId);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  db.updatePassword(req.session.userId, newPassword);
  res.json({ ok: true });
});

// POST /api/auth/invalidate-sessions  — admin: logout all other sessions
router.post('/invalidate-sessions', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = db.getUserById(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const sid = req.sessionID;
  db.db.prepare("DELETE FROM sessions WHERE sid != ?").run(sid);
  res.json({ ok: true });
});

module.exports = router;
