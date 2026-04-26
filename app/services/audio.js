'use strict';

const { spawn, spawnSync } = require('child_process');
const path         = require('path');
const fs           = require('fs');
const EventEmitter = require('events');
const config       = require('../config');
const { getVoice } = require('../voices');
const log          = require('./logger').createLogger('[Audio]');

class AudioManager extends EventEmitter {
  constructor() {
    super();
    this._ffmpeg        = null;
    this._ytdlp         = null;
    this.volume         = 80;
    this.track          = null;
    this._queue         = [];   // { type:'file'|'youtube'|'radio', path?:'', url?:'', title:'' }
    this._playing       = false;
    this._loop          = false;
    this._duration      = null; // total seconds (float), null if unknown
    this._elapsed       = 0;    // absolute playback position in seconds
    this._seekOffset    = 0;    // seek offset applied to current FFmpeg invocation
    this.history        = [];   // last 10 played tracks
    this._voice         = 'thorsten';
    this._piperParams   = { noiseScale: 0.667, lengthScale: 1.0, speakerNoise: 0.8 };
    this._generation    = 0;
    this._watchdogTimer = null;
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  isPlaying()       { return this._ffmpeg !== null; }
  getCurrentTrack() { return this.track ? { ...this.track, duration: this._duration } : null; }
  getVolume()       { return this.volume; }
  getQueue()        { return [...this._queue]; }
  getHistory()      { return [...this.history]; }
  getLoop()         { return this._loop; }
  getDuration()     { return this._duration; }
  getElapsed()      { return this._elapsed; }
  getVoice()        { return this._voice; }
  getPiperParams()  { return { ...this._piperParams }; }

  setLoop(val) {
    this._loop = !!val;
    this.emit('loop', this._loop);
    return this._loop;
  }

  setVoice(voice) {
    if (!getVoice(voice)) return this._voice;
    this._voice = voice;
    this.emit('voice', this._voice);
    return this._voice;
  }

  setPiperParams(params) {
    if (params.noiseScale != null)  this._piperParams.noiseScale  = Math.max(0, Math.min(1, parseFloat(params.noiseScale)));
    if (params.lengthScale != null) this._piperParams.lengthScale = Math.max(0.1, Math.min(5, parseFloat(params.lengthScale)));
    if (params.speakerNoise != null) this._piperParams.speakerNoise = Math.max(0, Math.min(1, parseFloat(params.speakerNoise)));
    this.emit('piper-params', this.getPiperParams());
    return this.getPiperParams();
  }

  // ── Queue management ───────────────────────────────────────────────────────

  addToQueue(item) {
    this._queue.push(item);
    this.emit('queue', this.getQueue());
    if (!this._ffmpeg && !this._ytdlp) {
      this._playing = true;
      this._playNext();
    }
  }

  removeFromQueue(index) {
    this._queue.splice(index, 1);
    this.emit('queue', this.getQueue());
  }

  reorderQueue(from, to) {
    if (from < 0 || from >= this._queue.length || to < 0 || to >= this._queue.length) {
      throw new Error('Invalid queue indices');
    }
    const [item] = this._queue.splice(from, 1);
    this._queue.splice(to, 0, item);
    this.emit('queue', this.getQueue());
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  async playFile(filePath, title = null, seekTo = 0) {
    const gen = ++this._generation;
    this._stopCurrent();
    this._playing    = true;
    this._duration   = await this._probeDuration(filePath);
    if (this._generation !== gen) return { superseded: true };
    this._elapsed    = seekTo;
    this._seekOffset = seekTo;

    const audioFilter  = `volume=${this.volume / 100},apad=pad_dur=2.5`;

    const args = [
      ...(seekTo > 0 ? ['-ss', String(seekTo)] : []),
      '-re',
      '-i', filePath,
      '-vn',
      '-ac', '2',
      '-ar', '48000',
      '-af', audioFilter,
      '-f', 'pulse',
      config.PULSE_SINK,
    ];

    return new Promise((resolve, reject) => {
      this._startFFmpeg(
        args,
        { title: title || path.basename(filePath), type: 'file', path: filePath },
        resolve, reject,
      );
    });
  }

  playYoutube(url) {
    const gen = ++this._generation;
    return new Promise((resolve, reject) => {
      this.setLoop(false);
      this._stopCurrent();
      this._duration   = null;
      this._elapsed    = 0;
      this._seekOffset = 0;

      const hasCookies = fs.existsSync(config.COOKIES_PATH);
      const ytdlpArgs = [
        '--no-playlist',
        '-f', 'bestaudio/best',
        '--print', 'duration',
        '--print', 'url',
        '--no-warnings',
        '--no-cache-dir',
        '--js-runtimes', 'node:/usr/local/bin/node',
        ...(hasCookies ? ['--cookies', config.COOKIES_PATH] : []),
        url,
      ];

      let rawOut = '';
      let errorOutput = '';
      this._ytdlp = spawn('yt-dlp', ytdlpArgs);

      this._ytdlp.stdout.on('data', d => { rawOut += d.toString(); });
      this._ytdlp.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg) log.error(msg);
        errorOutput += msg + '\n';
      });

      this._ytdlp.on('error', err => {
        this._ytdlp = null;
        reject(new Error(`yt-dlp failed: ${err.message}`));
      });

      this._ytdlp.on('close', (code, signal) => {
        this._ytdlp = null;
        if (this._generation !== gen) return resolve({ superseded: true });
        const lines     = rawOut.trim().split('\n');
        const durStr    = lines[0]?.trim();
        const streamUrl = lines.slice(1).join('\n').trim();

        if ((code !== 0 && signal !== null) || (!streamUrl && code !== 0)) {
          return reject(new Error(this._parseYtdlpError(errorOutput, code)));
        }
        if (!streamUrl) {
          return reject(new Error(this._parseYtdlpError(errorOutput, code)));
        }

        this._duration = (durStr && durStr !== 'NA') ? parseFloat(durStr) || null : null;

        const ffmpegArgs = [
          '-re',
          '-thread_queue_size', '512',
          '-i', streamUrl,
          '-vn',
          '-ac', '2',
          '-ar', '48000',
          '-af', `volume=${this.volume / 100},apad=pad_dur=2.5`,
          '-f', 'pulse',
          config.PULSE_SINK,
        ];
        this._startFFmpeg(
          ffmpegArgs,
          { title: url, type: 'youtube', streamUrl },
          resolve, reject,
        );
      });
    });
  }

  playRadio(url, title = null) {
    const gen = ++this._generation;
    this._stopCurrent();
    this.setLoop(false);
    this._playing    = true;
    this._duration   = null;
    this._elapsed    = 0;
    this._seekOffset = 0;
    if (this._generation !== gen) return Promise.resolve({ superseded: true });

    const args = [
      '-re',
      '-i', url,
      '-vn',
      '-ac', '2',
      '-ar', '48000',
      '-af', `volume=${this.volume / 100}`,
      '-f', 'pulse',
      config.PULSE_SINK,
    ];

    return new Promise((resolve, reject) => {
      this._startFFmpeg(
        args,
        { title: title || url, type: 'radio', url },
        resolve, reject,
      );
    });
  }

  async playPlaylist(fileObjects) {
    this.stop();
    this._queue = fileObjects.map(o =>
      typeof o === 'string'
        ? { type: 'file', path: o, title: path.basename(o) }
        : { type: 'file', path: o.path, title: o.title || path.basename(o.path) }
    );
    this._playing = true;
    this.emit('queue', this.getQueue());
    await this._playNext();
  }

  // ── TTS ────────────────────────────────────────────────────────────────────

  async say(text, voiceOverride = null, piperOverride = null) {
    const voiceId   = (voiceOverride && getVoice(voiceOverride)) ? voiceOverride : this._voice;
    const voiceCfg  = getVoice(voiceId);
    if (!voiceCfg) throw new Error(`Unknown voice: ${voiceId}`);

    const modelPath = path.join(config.PIPER_VOICES_DIR, voiceCfg.modelFile);
    const tmpFile   = path.join('/tmp', `tts_${Date.now()}.wav`);
    const params    = piperOverride || this._piperParams;

    const piperArgs = [
      '--model', modelPath,
      '--output_file', tmpFile,
      '--noise-scale', String(params.noiseScale),
      '--length-scale', String(params.lengthScale),
      '--speaker-noise', String(params.speakerNoise),
    ];
    if (voiceCfg.multiSpeaker && voiceCfg.speakerId != null) {
      piperArgs.push('--speaker', String(voiceCfg.speakerId));
    }

    await new Promise((resolve, reject) => {
      const piper = spawn(config.PIPER_BINARY, piperArgs, { env: { ...process.env, LD_LIBRARY_PATH: '/usr/local/piper' } });

      piper.stdin.write(text.replace(/\r?\n/g, ' ') + '\n');
      piper.stdin.end();
      piper.stdout.on('data', () => {});
      piper.stderr.on('data', () => {});
      piper.on('error', reject);
      piper.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`piper exited with code ${code}`));
      });
    });

    this._stopCurrent();
    this._duration = null;
    this._elapsed  = 0;
    this._seekOffset = 0;

    const padSecs = voiceCfg.quality === 'low' ? 5 : 4;
    const args = [
      '-re',
      '-i', tmpFile,
      '-vn',
      '-ac', '2',
      '-ar', '48000',
      '-af', `volume=${this.volume / 100},apad=pad_dur=${padSecs}`,
      '-f', 'pulse',
      config.PULSE_SINK,
    ];

    return new Promise((resolve, reject) => {
      this._startFFmpeg(
        args,
        { title: `TTS: ${text.slice(0, 60)}`, type: 'file', path: tmpFile },
        resolve, reject,
        true,
      );
      this.once('stopped', () => fs.unlink(tmpFile, () => {}));
    });
  }

  // ── Seek ───────────────────────────────────────────────────────────────────

  async seek(seconds) {
    const track = this.track;
    if (!track || !this._playing) return;
    if (track.type === 'radio') return;
    ++this._generation;

    const sec = Math.max(0, this._duration ? Math.min(seconds, this._duration) : seconds);

    const savedDuration = this._duration;
    this._stopCurrent();
    this._duration   = savedDuration;
    this._elapsed    = sec;
    this._seekOffset = sec;

    let args;
    if (track.type === 'file' && track.path) {
      const audioFilter  = `volume=${this.volume / 100},apad=pad_dur=2.5`;

      args = [
        '-re', '-ss', String(sec),
        '-i', track.path,
        '-vn', '-ac', '2', '-ar', '48000',
        '-af', audioFilter,
        '-f', 'pulse', config.PULSE_SINK,
      ];
    } else if (track.type === 'youtube' && track.streamUrl) {
      args = [
        '-re',
        '-thread_queue_size', '512',
        '-ss', String(sec),
        '-i', track.streamUrl,
        '-vn', '-ac', '2', '-ar', '48000',
        '-af', `volume=${this.volume / 100},apad=pad_dur=2.5`,
        '-f', 'pulse', config.PULSE_SINK,
      ];
    } else {
      return;
    }

    return new Promise((resolve, reject) => {
      this._startFFmpeg(args, track, resolve, reject, true /* skipHistory */);
    });
  }

  // ── Stop / Skip ────────────────────────────────────────────────────────────

  stop() {
    this._playing    = false;
    this._loop       = false;
    this._duration   = null;
    this._elapsed    = 0;
    this._seekOffset = 0;
    this._queue      = [];
    this.emit('loop',  false);
    this.emit('queue', []);
    this._stopCurrent();
  }

  skip() {
    if (!this._ffmpeg && !this._ytdlp) return;
    this._stopCurrent();
  }

  _stopCurrent() {
    this._clearWatchdog();
    if (this._ytdlp) {
      this._ytdlp.kill('SIGKILL');
      this._ytdlp = null;
    }
    if (this._ffmpeg) {
      this._ffmpeg.kill('SIGKILL');
      this._ffmpeg = null;
    }
    if (this.track) {
      this.track = null;
      this.emit('stopped');
    }
    // Flush PulseAudio sink to discard any buffered audio
    try {
      spawnSync('pactl', ['--server', config.PULSE_SERVER, 'suspend-sink', config.PULSE_SINK, '1'], { timeout: 2000 });
      spawnSync('pactl', ['--server', config.PULSE_SERVER, 'suspend-sink', config.PULSE_SINK, '0'], { timeout: 2000 });
    } catch { /* ignore */ }
  }

  // ── Volume ─────────────────────────────────────────────────────────────────

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(100, Math.round(vol)));

    const pactl = spawn('pactl', [
      '--server', config.PULSE_SERVER,
      'set-sink-volume', config.PULSE_SINK,
      `${this.volume}%`,
    ]);
    pactl.on('error', err => log.error('pactl error:', err.message));

    this.emit('volume', this.volume);
    return this.volume;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _playNext() {
    if (!this._playing || !this._queue.length) {
      this._playing = false;
      this.emit('queue', []);
      return;
    }
    const next = this._queue.shift();
    this.emit('queue', this.getQueue());
    try {
      if (next.type === 'youtube') {
        await this.playYoutube(next.url);
      } else if (next.type === 'radio') {
        await this.playRadio(next.url, next.title);
      } else {
        await this.playFile(next.path, next.title);
      }
    } catch (err) {
      log.error('Queue track error:', err.message);
      this.emit('error', err);
      await this._playNext();
    }
  }

  _startFFmpeg(args, trackInfo, resolve, reject, skipHistory = false) {
    const env = { ...process.env, PULSE_SERVER: config.PULSE_SERVER };

    this._ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'warning',
      '-progress', 'pipe:1',
      '-nostats',
      ...args,
    ], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.track = trackInfo;

    if (!skipHistory) {
      this.history = [trackInfo, ...this.history.filter(h => h.title !== trackInfo.title)].slice(0, 10);
      this.emit('history', this.getHistory());
    }

    this.emit('playing', { ...trackInfo, duration: this._duration });
    resolve(trackInfo);

    let _progBuf = '';
    let _stderrBuf = '';
    const _resetWatchdog = () => {
      this._clearWatchdog();
      this._watchdogTimer = setTimeout(() => {
        log.warn('Watchdog: no progress for 30s, killing FFmpeg');
        this.emit('error', new Error('Playback stalled (no progress for 30s)'));
        if (this._ffmpeg) this._ffmpeg.kill('SIGKILL');
      }, 30_000);
    };
    _resetWatchdog();

    this._ffmpeg.stdout.on('data', d => {
      _progBuf += d.toString();
      const lines = _progBuf.split('\n');
      _progBuf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)$/);
        if (!m) continue;
        _resetWatchdog();
        const segSecs = parseInt(m[1]) / 1_000_000;
        const rawElapsed = segSecs + this._seekOffset;
        const bufferDelaySec = 2.0;
        const adjusted = rawElapsed - bufferDelaySec;
        this._elapsed = this._duration
          ? Math.max(0, Math.min(adjusted, this._duration))
          : Math.max(0, adjusted);
        this.emit('progress', { elapsed: this._elapsed, duration: this._duration });
      }
    });

    this._ffmpeg.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) {
        log.error(msg);
        _stderrBuf += msg + '\n';
        if (_stderrBuf.length > 4000) _stderrBuf = _stderrBuf.slice(-2000);
      }
    });

    this._ffmpeg.on('error', err => {
      log.error('spawn error:', err.message);
      this._clearWatchdog();
      this._ffmpeg = null;
      this.track   = null;
      this.emit('error', err);
    });

    this._ffmpeg.on('close', (code, signal) => {
      log.info(`process exited code=${code ?? 'none'} signal=${signal ?? 'none'} track=${trackInfo?.title ?? 'none'}`);
      this._clearWatchdog();
      const wasTrack   = this.track;
      this._ffmpeg     = null;
      this._ytdlp      = null;
      this.track       = null;
      this._elapsed    = 0;
      this._seekOffset = 0;
      this._duration   = null;

      if (code !== 0 && code !== null && wasTrack) {
        const lastErr = _stderrBuf.trim().split('\n').slice(-3).join('; ');
        this.emit('error', new Error(`FFmpeg exited (${code ?? signal}): ${lastErr || 'unknown error'}`));
      }

      if (wasTrack) this.emit('stopped');

      if (this._playing) {
        if (this._loop && wasTrack && wasTrack.type === 'file' && wasTrack.path) {
          this.playFile(wasTrack.path, wasTrack.title).catch(err => this.emit('error', err));
        } else {
          this._playNext().catch(err => this.emit('error', err));
        }
      }
    });
  }

  _clearWatchdog() {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  _parseYtdlpError(output, code) {
    const lower = (output || '').toLowerCase();
    if (lower.includes('sign in to confirm') || lower.includes('bot'))
      return 'YouTube requires authentication. Upload cookies via Settings.';
    if (lower.includes('video unavailable') || lower.includes('private'))
      return 'Video is unavailable or private.';
    if (lower.includes('age') || lower.includes('inappropriate'))
      return 'Video is age-restricted and cannot be accessed.';
    if (lower.includes('geo') || lower.includes('country'))
      return 'Video is geo-blocked in the server\'s region.';
    return `yt-dlp error (code ${code ?? 'unknown'}): ${(output || '').trim().slice(-200)}`;
  }

  async _probeDuration(src) {
    return new Promise(resolve => {
      const proc = spawn('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_format', src,
      ]);
      let out = '';
      proc.stdout.on('data', d => { out += d; });
      proc.on('close', () => {
        try { resolve(parseFloat(JSON.parse(out).format?.duration) || null); }
        catch { resolve(null); }
      });
      proc.on('error', () => resolve(null));
    });
  }

  _isValidUrl(str) {
    try {
      const u = new URL(str);
      return ['http:', 'https:'].includes(u.protocol);
    } catch {
      return false;
    }
  }
}

module.exports = new AudioManager();
