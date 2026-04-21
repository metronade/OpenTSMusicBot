'use strict';

const path = require('path');

module.exports = {
  PORT:            parseInt(process.env.PORT || '3000', 10),
  SESSION_SECRET:  process.env.SESSION_SECRET || 'dev_secret_change_me',
  DB_PATH:         process.env.DB_PATH        || path.join(__dirname, 'config', 'db.sqlite'),
  MUSIC_DIR:       process.env.MUSIC_DIR      || path.join(__dirname, 'music'),

  TS3_QUERY_HOST:  process.env.TS3_QUERY_HOST || 'ts3client',
  TS3_QUERY_PORT:  parseInt(process.env.TS3_QUERY_PORT || '25639', 10),

  PULSE_SERVER:    process.env.PULSE_SERVER   || 'tcp:ts3client:4713',
  PULSE_SINK:      'virtual_out',

  COOKIES_PATH:    process.env.COOKIES_PATH || path.join(__dirname, 'config', 'cookies.txt'),

  PIPER_BINARY:    process.env.PIPER_BINARY     || '/usr/local/piper/piper',
  PIPER_VOICES_DIR: process.env.PIPER_VOICES_DIR || '/app/piper-voices',

  UPLOAD_MAX_MB:   50,
  ALLOWED_MIMETYPES: new Set(['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/mp4']),
};
