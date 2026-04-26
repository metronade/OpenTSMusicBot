'use strict';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const configuredLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configuredLevel] ?? LEVELS.info;

function ts() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function log(level, prefix, ...args) {
  if (LEVELS[level] < threshold) return;
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method(`[${ts()}] [${level.toUpperCase()}] ${prefix} ${args.join(' ')}`);
}

function createLogger(prefix) {
  return {
    debug: (...args) => log('debug', prefix, ...args),
    info:  (...args) => log('info',  prefix, ...args),
    warn:  (...args) => log('warn',  prefix, ...args),
    error: (...args) => log('error', prefix, ...args),
  };
}

module.exports = { createLogger };
