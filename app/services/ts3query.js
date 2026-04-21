'use strict';

/**
 * TS3 ClientQuery service.
 *
 * Connects over TCP to the ClientQuery plugin (default port 25639).
 * Implements the TeamSpeak 3 query wire protocol:
 *  - Commands are single lines terminated by \n
 *  - Responses end with "error id=0 msg=ok\n"  (or error id!=0)
 *  - Notifications arrive asynchronously as "notify…" lines
 *  - Strings are escaped:  \s = space, \p = |, \\ = \, \/ = /, …
 */

const net          = require('net');
const EventEmitter = require('events');
const config       = require('../config');

// ── TS3 wire-protocol escaping ────────────────────────────────────────────────
const ESCAPE_MAP   = { ' ': '\\s', '|': '\\p', '\\': '\\\\', '/': '\\/', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const UNESCAPE_MAP = Object.fromEntries(Object.entries(ESCAPE_MAP).map(([k, v]) => [v, k]));

function escape(str)   { return String(str).replace(/[ |\\\/\n\r\t]/g, c => ESCAPE_MAP[c] || c); }
function unescape(str) { return String(str).replace(/\\[spnrt\\\/]/g, s => UNESCAPE_MAP[s] || s); }

/** Parse a TS3 query response line into an array of key→value objects. */
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

// ── Main class ────────────────────────────────────────────────────────────────
class TS3Query extends EventEmitter {
  constructor() {
    super();
    this.socket        = null;
    this.buffer        = '';
    this.queue         = [];       // pending { resolve, reject, buf[] }
    this.busy          = false;
    this.connected     = false;
    this.reconnectMs   = 5_000;
    this._reconnectTimer = null;

    // Cache
    this._channels         = [];
    this._myClid           = null;
    this._myCid            = null;
    this._manualDisconnect = false;
    this._channelMovedAt   = null;   // timestamp of last bot channel move (grace period)
    this._clientNames      = new Map(); // clid → nickname cache for join/leave events
  }

  // ── Public API ─────────────────────────────────────────────────────────────

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
      console.log('[TS3Query] Connected to ClientQuery');
      this.buffer = '';
    });

    this.socket.on('data', data => this._onData(data));

    this.socket.on('error', err => {
      console.error('[TS3Query] Socket error:', err.message);
    });

    this.socket.on('close', () => {
      if (this.connected) {
        this.connected = false;
        this._channels = [];
        this._myClid   = null;
        this.emit('disconnected');
        console.log('[TS3Query] Disconnected — reconnecting in', this.reconnectMs, 'ms');
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

  /** Send a raw command, returns Promise<parsed items[]>. */
  send(command) {
    return new Promise((resolve, reject) => {
      this.queue.push({ command, resolve, reject, lines: [] });
      this._pump();
    });
  }

  // ── Convenience commands ───────────────────────────────────────────────────

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

  /** Move bot to a channel by its numeric ID. */
  async moveToChannel(cid) {
    if (!this._myClid) {
      const info  = await this.whoami();
      this._myClid = info.clid;
    }
    this._channelMovedAt = Date.now();
    return this.send(`clientmove clid=${this._myClid} cid=${cid}`);
  }

  /** Send a message to the current channel (targetmode=2). */
  async sendChannelMessage(msg) {
    return this.send(`sendtextmessage targetmode=2 target=${this._myCid || 1} msg=${escape(msg)}`);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _isGracePeriod() {
    return this._channelMovedAt !== null && (Date.now() - this._channelMovedAt) < 3000;
  }

  _scheduleReconnect() {
    this._reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
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
    this.buffer = lines.pop(); // keep incomplete trailing line

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    // ── Greeting / banner (not yet connected) ──────────────────────────────
    if (line.startsWith('TS3 Client') || line.startsWith('Welcome') || line.startsWith('Use the')) return;

    // ── Async notifications ────────────────────────────────────────────────
    if (line.startsWith('notify')) {
      this._handleNotification(line);
      return;
    }

    // ── Greeting end markers (not yet connected) ───────────────────────────
    // With acceptUnknownClients=true  the greeting ends with "error id=0 msg=ok".
    // With acceptUnknownClients=false it ends with "selected schandlerid=N"
    // and requires auth — but we handle both so startup is robust.
    if (!this.connected) {
      if (line.startsWith('error ')) {
        const err = parseItems(line.slice(6))[0];
        if (err.id === '0') { this.connected = true; this._onConnected(); }
        return;
      }
      if (line.startsWith('selected schandlerid=')) {
        // acceptUnknownClients=false mode — will attempt auth in _onConnected
        this.connected = true;
        this._requireAuth = true;
        this._onConnected();
        return;
      }
      return; // ignore other greeting lines
    }

    // ── Response to a queued command ───────────────────────────────────────
    if (!this.queue.length) return;
    const item = this.queue[0];

    if (line.startsWith('error ')) {
      // Final line of response
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
      // If open_remote=false, authenticate with the plugin's API key
      if (this._requireAuth) {
        const key = process.env.TS3_QUERY_APIKEY || '';
        console.warn('[TS3Query] auth required — using key:', key ? '(set)' : '(empty — set TS3_QUERY_APIKEY)');
        await this.send(`auth apikey=${key}`).catch(e => console.warn('[TS3Query] auth:', e.message));
        this._requireAuth = false;
      }

      // Select connection slot 1 (ClientQuery syntax: use schandlerid=<id>)
      const useRes = await this.send('use schandlerid=1').catch(e => { console.warn('[TS3Query] use schandlerid=1:', e.message); return null; });
      console.log('[TS3Query] use schandlerid=1 →', useRes ? 'ok' : 'failed/skipped');

      // Register for text-message events
      await this.send('clientnotifyregister schandlerid=1 event=notifytextmessage').catch(e => console.warn('[TS3Query] register textmessage:', e.message));
      await this.send('clientnotifyregister schandlerid=1 event=notifyconnectstatuschange').catch(e => console.warn('[TS3Query] register connectstatus:', e.message));
      await this.send('clientnotifyregister schandlerid=1 event=notifycliententerview').catch(e => console.warn('[TS3Query] register cliententerview:', e.message));
      await this.send('clientnotifyregister schandlerid=1 event=notifyclientleftview').catch(e => console.warn('[TS3Query] register clientleftview:', e.message));
      await this.send('clientnotifyregister schandlerid=1 event=notifyclientmoved').catch(e => console.warn('[TS3Query] register clientmoved:', e.message));

      // Get own client info
      const info  = await this.whoami().catch(e => { console.warn('[TS3Query] whoami:', e.message); return {}; });
      console.log('[TS3Query] whoami →', JSON.stringify(info));
      this._myClid = info.clid;
      this._myCid  = info.cid;

      // Fetch channel list
      await this.getChannels().catch(e => console.warn('[TS3Query] channellist:', e.message));

      this.emit('connected', { clid: this._myClid, cid: this._myCid });
      console.log('[TS3Query] Bot ready — clid=%s cid=%s', this._myClid, this._myCid);
    } catch (err) {
      console.error('[TS3Query] Init error:', err.message);
    }
  }

  _handleNotification(line) {
    const spaceIdx = line.indexOf(' ');
    const event    = line.slice(0, spaceIdx);   // e.g. "notifytextmessage"
    const payload  = parseItems(line.slice(spaceIdx + 1))[0];

    switch (event) {
      case 'notifytextmessage':
        // Update current channel in case we moved
        if (payload.cid) this._myCid = payload.cid;
        this.emit('textmessage', payload);
        break;

      case 'notifyconnectstatuschange':
        if (payload.status === 'disconnected') {
          this.emit('ts3disconnected');
        } else if (payload.status === 'connection_established') {
          // refresh channels after (re)connect
          this.getChannels().catch(() => {});
          this.whoami().then(i => {
            this._myClid = i.clid;
            this._myCid  = i.cid;
          }).catch(() => {});
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
