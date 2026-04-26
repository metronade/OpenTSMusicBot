'use strict';

const net          = require('net');
const EventEmitter = require('events');
const config       = require('../config');
const log          = require('./logger').createLogger('[TS3Query]');

const ESCAPE_MAP   = { ' ': '\\s', '|': '\\p', '\\': '\\\\', '/': '\\/', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const UNESCAPE_MAP = Object.fromEntries(Object.entries(ESCAPE_MAP).map(([k, v]) => [v, k]));

function escape(str)   { return String(str).replace(/[ |\\\/\n\r\t]/g, c => ESCAPE_MAP[c] || c); }
function unescape(str) { return String(str).replace(/\\[spnrt\\\/]/g, s => UNESCAPE_MAP[s] || s); }

function parseItems(line) {
  return line.split('|').map(segment =>
    Object.fromEntries(
      segment.split(' ').map(pair => {
        const eq = pair.indexOf('=');
        if (eq === -1) return [pair, true];
        return [pair.slice(0, eq), unescape(pair.slice(eq + 1))];
      })
    )
  );
}

class TS3Query extends EventEmitter {
  constructor() {
    super();
    this.socket        = null;
    this.buffer        = '';
    this.queue         = [];
    this.busy          = false;
    this.connected     = false;
    this._reconnectBaseMs  = 2_000;
    this._reconnectMaxMs   = 60_000;
    this._reconnectAttempt = 0;
    this._reconnectTimer   = null;

    this._channels         = [];
    this._myClid           = null;
    this._myCid            = null;
    this._manualDisconnect = false;
    this._channelMovedAt   = null;
    this._clientNames      = new Map();
  }

  isConnected() { return this.connected; }
  getCachedChannels() { return this._channels; }

  connect() {
    this._manualDisconnect = false;
    if (this.socket) this.socket.destroy();
    clearTimeout(this._reconnectTimer);

    this.socket = new net.Socket();
    this.socket.setEncoding('utf8');
    this.socket.connect(config.TS3_QUERY_PORT, config.TS3_QUERY_HOST);

    this.socket.on('connect', () => {
      log.info('Connected to ClientQuery');
      this._reconnectAttempt = 0;
      this.buffer = '';
    });

    this.socket.on('data', data => this._onData(data));

    this.socket.on('error', err => {
      log.error('Socket error:', err.message);
    });

    this.socket.on('close', () => {
      if (this.connected) {
        this.connected = false;
        this._channels = [];
        this._myClid   = null;
        this.emit('disconnected');
        const delay = this._backoffDelay();
        log.info(`Disconnected — reconnecting in ${delay}ms (attempt ${this._reconnectAttempt + 1})`);
      }
      for (const item of this.queue) item.reject(new Error('Connection closed'));
      this.queue = [];
      this.busy  = false;
      if (!this._manualDisconnect) this._scheduleReconnect();
    });
  }

  disconnect() {
    this._manualDisconnect = true;
    clearTimeout(this._reconnectTimer);
    if (this.connected) {
      this.connected = false;
      this._channels = [];
      this._myClid   = null;
      this.emit('disconnected');
    }
    if (this.socket) { this.socket.destroy(); this.socket = null; }
  }

  send(command) {
    return new Promise((resolve, reject) => {
      this.queue.push({ command, resolve, reject, lines: [] });
      this._pump();
    });
  }

  async whoami() {
    const items = await this.send('whoami');
    return items[0] || {};
  }

  async getChannels() {
    const items = await this.send('channellist');
    this._channels = items;
    this.emit('channels', items);
    return items;
  }

  async changeNickname(name) {
    return this.send(`clientupdate client_nickname=${escape(name)}`);
  }

  async moveToChannel(cid) {
    if (!this._myClid) {
      const info  = await this.whoami();
      this._myClid = info.clid;
    }
    this._channelMovedAt = Date.now();
    return this.send(`clientmove clid=${this._myClid} cid=${cid}`);
  }

  async sendChannelMessage(msg) {
    return this.send(`sendtextmessage targetmode=2 target=${this._myCid || 1} msg=${escape(msg)}`);
  }

  _isGracePeriod() {
    return this._channelMovedAt !== null && (Date.now() - this._channelMovedAt) < 3000;
  }

  _backoffDelay() {
    return Math.min(this._reconnectBaseMs * Math.pow(2, this._reconnectAttempt), this._reconnectMaxMs);
  }

  _scheduleReconnect() {
    const delay = this._backoffDelay();
    this._reconnectAttempt++;
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _pump() {
    if (this.busy || !this.queue.length || !this.connected) return;
    const item = this.queue[0];
    this.busy = true;
    this.socket.write(item.command + '\n');
  }

  _onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    if (line.startsWith('TS3 Client') || line.startsWith('Welcome') || line.startsWith('Use the')) return;

    if (line.startsWith('notify')) {
      this._handleNotification(line);
      return;
    }

    if (!this.connected) {
      if (line.startsWith('error ')) {
        const err = parseItems(line.slice(6))[0];
        if (err.id === '0') { this.connected = true; this._onConnected(); }
        return;
      }
      if (line.startsWith('selected schandlerid=')) {
        this.connected = true;
        this._requireAuth = true;
        this._onConnected();
        return;
      }
      return;
    }

    if (!this.queue.length) return;
    const item = this.queue[0];

    if (line.startsWith('error ')) {
      const err = parseItems(line.slice(6))[0];
      this.queue.shift();
      this.busy = false;
      if (err.id === '0') {
        item.resolve(item.lines.length ? parseItems(item.lines.join('')) : [{}]);
      } else {
        item.reject(new Error(`TS3 error ${err.id}: ${unescape(err.msg || 'unknown')}`));
      }
      this._pump();
    } else {
      item.lines.push(line);
    }
  }

  async _onConnected() {
    try {
      if (this._requireAuth) {
        const key = process.env.TS3_QUERY_APIKEY || '';
        log.warn('auth required — using key:', key ? '(set)' : '(empty — set TS3_QUERY_APIKEY)');
        await this.send(`auth apikey=${key}`).catch(e => log.warn('auth:', e.message));
        this._requireAuth = false;
      }

      const useRes = await this.send('use schandlerid=1').catch(e => { log.warn('use schandlerid=1:', e.message); return null; });
      log.info('use schandlerid=1 →', useRes ? 'ok' : 'failed/skipped');

      await this.send('clientnotifyregister schandlerid=1 event=notifytextmessage').catch(e => log.warn('register textmessage:', e.message));
      await this.send('clientnotifyregister schandlerid=1 event=notifyconnectstatuschange').catch(e => log.warn('register connectstatus:', e.message));
      await this.send('clientnotifyregister schandlerid=1 event=notifycliententerview').catch(e => log.warn('register cliententerview:', e.message));
      await this.send('clientnotifyregister schandlerid=1 event=notifyclientleftview').catch(e => log.warn('register clientleftview:', e.message));
      await this.send('clientnotifyregister schandlerid=1 event=notifyclientmoved').catch(e => log.warn('register clientmoved:', e.message));

      const info  = await this.whoami().catch(e => { log.warn('whoami:', e.message); return {}; });
      log.info('whoami →', JSON.stringify(info));
      this._myClid = info.clid;
      this._myCid  = info.cid;

      await this.getChannels().catch(e => log.warn('channellist:', e.message));

      this.emit('connected', { clid: this._myClid, cid: this._myCid });
      log.info('Bot ready — clid=%s cid=%s', this._myClid, this._myCid);
    } catch (err) {
      log.error('Init error:', err.message);
    }
  }

  _handleNotification(line) {
    const spaceIdx = line.indexOf(' ');
    const event    = line.slice(0, spaceIdx);
    const payload  = parseItems(line.slice(spaceIdx + 1))[0];

    switch (event) {
      case 'notifytextmessage':
        if (payload.cid) this._myCid = payload.cid;
        this.emit('textmessage', payload);
        break;

      case 'notifyconnectstatuschange':
        if (payload.status === 'disconnected') {
          this.emit('ts3disconnected');
        } else if (payload.status === 'connection_established') {
          this.getChannels().catch(() => {});
          this.whoami().then(i => { this._myClid = i.clid; this._myCid = i.cid; }).catch(() => {});
        }
        break;

      case 'notifycliententerview': {
        const clid    = payload.clid;
        const nickname = unescape(payload.client_nickname || '');
        if (clid && nickname) this._clientNames.set(clid, nickname);
        if (clid === this._myClid || this._isGracePeriod()) break;
        if (payload.ctid === this._myCid)
          this.emit('clientjoin', { clid, nickname });
        break;
      }

      case 'notifyclientleftview': {
        const clid = payload.clid;
        if (clid !== this._myClid && !this._isGracePeriod() && payload.cfid === this._myCid)
          this.emit('clientleave', { clid, nickname: this._clientNames.get(clid) || `Client ${clid}` });
        this._clientNames.delete(clid);
        break;
      }

      case 'notifyclientmoved': {
        const clid = payload.clid;
        if (clid === this._myClid) { this._myCid = payload.ctid; this._channelMovedAt = Date.now(); break; }
        if (this._isGracePeriod()) break;
        if (payload.ctid === this._myCid)
          this.emit('clientjoin', { clid, nickname: this._clientNames.get(clid) || `Client ${clid}` });
        else if (payload.cfid === this._myCid)
          this.emit('clientleave', { clid, nickname: this._clientNames.get(clid) || `Client ${clid}` });
        break;
      }

      default:
        this.emit('notification', { event, payload });
    }
  }
}

module.exports = new TS3Query();
