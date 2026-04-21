'use strict';

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const config   = require('../config');

// Ensure directory exists
fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    username            TEXT    UNIQUE NOT NULL,
    password_hash       TEXT    NOT NULL,
    role                TEXT    NOT NULL DEFAULT 'user'
                                CHECK(role IN ('admin','user')),
    must_change_pw      INTEGER NOT NULL DEFAULT 0,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT    UNIQUE NOT NULL,
    original_name TEXT    NOT NULL,
    mimetype      TEXT    NOT NULL,
    size          INTEGER NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlist_files (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id  INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    file_id      INTEGER NOT NULL REFERENCES files(id)     ON DELETE CASCADE,
    order_index  INTEGER NOT NULL DEFAULT 0,
    UNIQUE(playlist_id, file_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`);

// ── Seed default admin (admin / admin) ────────────────────────────────────────
const seed = db.prepare(`
    INSERT OR IGNORE INTO users (username, password_hash, role, must_change_pw)
    VALUES (?, ?, 'admin', 1)
`);
seed.run('admin', bcrypt.hashSync('admin', 10));

// ── User helpers ──────────────────────────────────────────────────────────────
const stmts = {
  getUserById:        db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByUsername:  db.prepare('SELECT * FROM users WHERE username = ?'),
  getAllUsers:        db.prepare('SELECT id, username, role, must_change_pw, created_at FROM users ORDER BY id'),
  createUser:         db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'),
  updatePassword:     db.prepare('UPDATE users SET password_hash = ?, must_change_pw = 0 WHERE id = ?'),
  deleteUser:         db.prepare('DELETE FROM users WHERE id = ? AND role != \'admin\''),

  // File helpers
  getAllFiles:        db.prepare('SELECT * FROM files ORDER BY created_at DESC'),
  getFileById:        db.prepare('SELECT * FROM files WHERE id = ?'),
  getFileByFilename:  db.prepare('SELECT * FROM files WHERE filename = ?'),
  insertFile:         db.prepare('INSERT INTO files (filename, original_name, mimetype, size) VALUES (?, ?, ?, ?)'),
  deleteFile:         db.prepare('DELETE FROM files WHERE id = ?'),

  // Playlist helpers
  getAllPlaylists:    db.prepare('SELECT * FROM playlists ORDER BY name'),
  getPlaylistById:   db.prepare('SELECT * FROM playlists WHERE id = ?'),
  getPlaylistByName: db.prepare('SELECT * FROM playlists WHERE name = ?'),
  createPlaylist:    db.prepare('INSERT INTO playlists (name) VALUES (?)'),
  deletePlaylist:    db.prepare('DELETE FROM playlists WHERE id = ?'),
  renamePlaylist:    db.prepare('UPDATE playlists SET name = ? WHERE id = ?'),

  getPlaylistFiles:  db.prepare(`
      SELECT f.* FROM playlist_files pf
      JOIN files f ON f.id = pf.file_id
      WHERE pf.playlist_id = ?
      ORDER BY pf.order_index
  `),
  addFileToPlaylist: db.prepare(`
      INSERT OR IGNORE INTO playlist_files (playlist_id, file_id, order_index)
      VALUES (?, ?, (SELECT COALESCE(MAX(order_index),0)+1 FROM playlist_files WHERE playlist_id = ?))
  `),
  removeFileFromPlaylist: db.prepare('DELETE FROM playlist_files WHERE playlist_id = ? AND file_id = ?'),
  clearPlaylist:     db.prepare('DELETE FROM playlist_files WHERE playlist_id = ?'),
  reorderPlaylist:   db.prepare('UPDATE playlist_files SET order_index = ? WHERE playlist_id = ? AND file_id = ?'),
};

// ── File search (for !play without extension) ─────────────────────────────────
function _matchFile(name) {
  const nameLower = path.basename(name, path.extname(name)).toLowerCase();
  const all = stmts.getAllFiles.all();
  return all.find(f =>
    path.basename(f.original_name, path.extname(f.original_name)).toLowerCase() === nameLower
  ) || all.find(f =>
    path.basename(f.original_name, path.extname(f.original_name)).toLowerCase().includes(nameLower)
  ) || null;
}

function findFileByName(name) {
  const file = _matchFile(name);
  return file ? path.join(config.MUSIC_DIR, file.filename) : null;
}

// Returns { path, original_name } or null — used when the caller needs the display name
function findFileRecordByName(name) {
  const file = _matchFile(name);
  if (!file) return null;
  return { path: path.join(config.MUSIC_DIR, file.filename), original_name: file.original_name };
}

// ── getPlaylistFilePaths / getPlaylistFileObjects ─────────────────────────────
function getPlaylistFilePaths(playlistId) {
  const rows = stmts.getPlaylistFiles.all(playlistId);
  return rows.map(r => path.join(config.MUSIC_DIR, r.filename));
}

// Returns [{path, title}] — preserves original_name for display
function getPlaylistFileObjects(playlistId) {
  const rows = stmts.getPlaylistFiles.all(playlistId);
  return rows.map(r => ({ path: path.join(config.MUSIC_DIR, r.filename), title: r.original_name }));
}

const settingStmts = {
  get: db.prepare('SELECT value FROM settings WHERE key = ?'),
  set: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
};

// Default chat feedback toggles (all on)
const CHAT_DEFAULTS = { play: true, stop: true, volume: true, youtube: true, playlist: true };
const chatKey = 'chat_feedback';
if (!settingStmts.get.get(chatKey)) {
  settingStmts.set.run(chatKey, JSON.stringify(CHAT_DEFAULTS));
}

// Default TTS event announcements (disabled by default)
const TTS_EVENTS_DEFAULTS = {
  voice: 'thorsten',
  join:  { enabled: false, text: 'Hallo {username}' },
  leave: { enabled: false, text: 'Tschüss {username}' },
};
const ttsEventsKey = 'tts_events';
if (!settingStmts.get.get(ttsEventsKey)) {
  settingStmts.set.run(ttsEventsKey, JSON.stringify(TTS_EVENTS_DEFAULTS));
}

function getSetting(key, fallback = null) {
  const row = settingStmts.get.get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  settingStmts.set.run(key, JSON.stringify(value));
}

module.exports = {
  db,
  getSetting,
  setSetting,
  getUserById:       (id)       => stmts.getUserById.get(id),
  getUserByUsername: (username) => stmts.getUserByUsername.get(username),
  getAllUsers:        ()         => stmts.getAllUsers.all(),
  createUser(username, password, role = 'user') {
    const hash = bcrypt.hashSync(password, 10);
    return stmts.createUser.run(username, hash, role);
  },
  updatePassword(userId, newPassword) {
    const hash = bcrypt.hashSync(newPassword, 10);
    return stmts.updatePassword.run(hash, userId);
  },
  deleteUser:        (id)       => stmts.deleteUser.run(id),

  getAllFiles:        ()         => stmts.getAllFiles.all(),
  getFileById:       (id)       => stmts.getFileById.get(id),
  getFileByFilename: (filename) => stmts.getFileByFilename.get(filename),
  insertFile:        (filename, originalName, mimetype, size) =>
                       stmts.insertFile.run(filename, originalName, mimetype, size),
  deleteFile:        (id)       => stmts.deleteFile.run(id),
  findFileByName,
  findFileRecordByName,

  getAllPlaylists:    ()         => stmts.getAllPlaylists.all(),
  getPlaylistById:   (id)       => stmts.getPlaylistById.get(id),
  getPlaylistByName: (name)     => stmts.getPlaylistByName.get(name),
  createPlaylist:    (name)     => stmts.createPlaylist.run(name),
  deletePlaylist:    (id)       => stmts.deletePlaylist.run(id),
  renamePlaylist:    (id, name) => stmts.renamePlaylist.run(name, id),
  getPlaylistFiles:  (id)       => stmts.getPlaylistFiles.all(id),
  getPlaylistFilePaths,
  getPlaylistFileObjects,
  addFileToPlaylist: (plId, fileId) => stmts.addFileToPlaylist.run(plId, fileId, plId),
  removeFileFromPlaylist: (plId, fileId) => stmts.removeFileFromPlaylist.run(plId, fileId),
  clearPlaylist:     (plId)     => stmts.clearPlaylist.run(plId),
  reorderPlaylist:   (plId, fileId, idx) => stmts.reorderPlaylist.run(idx, plId, fileId),
};
