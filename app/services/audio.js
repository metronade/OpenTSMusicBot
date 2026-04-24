'use strict';

const { spawn }    = require('child_process');
const path         = require('path');
const fs           = require('fs');
const EventEmitter = require('events');
const config       = require('../config');

class AudioManager extends EventEmitter {
  constructor() {
    super();
    this._ffmpeg      = null;
    this._ytdlp       = null;
    this.volume       = 80;
    this.track        = null;
    this._queue       = [];   // { type:'file'|'youtube', path?:'', url?:'', title:'' }
    this._playing     = false;
    this._loop        = false;
    this._duration    = null; // total seconds (float), null if unknown
    this._elapsed     = 0;    // absolute playback position in seconds
    this._seekOffset  = 0;    // seek offset applied to current FFmpeg invocation
    this.history      = [];   // last 10 played tracks
    this._voice       = 'thorsten';
    this._generation  = 0;  // incremented on every play/seek; lets later calls supersede earlier async setups
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

  setLoop(val) {
    this._loop = !!val;
    this.emit('loop', this._loop);
    return this._loop;
  }

  setVoice(voice) {
    if (!['thorsten', 'kerstin'].includes(voice)) return this._voice;
    this._voice = voice;
    this.emit('voice', this._voice);
    return this._voice;
  }

  // ── Queue management ───────────────────────────────────────────────────────

  addToQueue(item) {
    this._queue.push(item);
    this.emit('queue', this.getQueue());
    // Auto-start if nothing is playing
    if (!this._ffmpeg && !this._ytdlp) {
      this._playing = true;
      this._playNext();
    }
  }

  removeFromQueue(index) {
    this._queue.splice(index, 1);
    this.emit('queue', this.getQueue());
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  async playFile(filePath, title = null, seekTo = 0) {
    const gen = ++this._generation;
    this._stopCurrent();
    this._duration   = await this._probeDuration(filePath);
    if (this._generation !== gen) return { superseded: true };
    this._elapsed    = seekTo;
    this._seekOffset = seekTo;

    // apad=pad_dur=2.5: module-virtual-source has a ~2000ms internal buffer.
    // Without padding, short files are swallowed by the buffer. The 2.5s of
    // silence tail ensures all real audio passes through before FFmpeg exits.
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
        '--print', 'duration',  // first stdout line: duration in seconds (or "NA")
        '--print', 'url',       // second stdout line: direct stream URL
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
        if (msg) console.error('[yt-dlp]', msg);
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
          return reject(new Error(`yt-dlp error (code ${code ?? signal}): ${errorOutput.trim()}`));
        }
        if (!streamUrl) {
          return reject(new Error(`yt-dlp returned no URL (code ${code}): ${errorOutput.trim()}`));
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

  async playPlaylist(fileObjects) {
    this.stop();
    // Accept either plain path strings or {path, title} objects
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

  async say(text, voiceOverride = null) {
    const voice     = (voiceOverride && ['thorsten', 'kerstin'].includes(voiceOverride)) ? voiceOverride : this._voice;
    const modelFile = voice === 'kerstin'
      ? 'de_DE-kerstin-low.onnx'
      : 'de_DE-thorsten-medium.onnx';
    const modelPath = path.join(config.PIPER_VOICES_DIR, modelFile);
    const tmpFile   = path.join('/tmp', `tts_${Date.now()}.wav`);

    await new Promise((resolve, reject) => {
      const piper = spawn(config.PIPER_BINARY, [
        '--model', modelPath,
        '--output_file', tmpFile,
      ], { env: { ...process.env, LD_LIBRARY_PATH: '/usr/local/piper' } });

      // Piper reads line-by-line — trailing \n is required to flush the last sentence
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

    // Stop anything currently playing
    this._stopCurrent();
    this._duration = null;
    this._elapsed  = 0;
    this._seekOffset = 0;

    // kerstin-low uses 16 kHz; resampling introduces more jitter → needs more tail.
    // Extra +2s on top of the base padding compensates for virtual-source buffer.
    const padSecs = voice === 'kerstin' ? 5 : 4;
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
        true, // skipHistory
      );
      this.once('stopped', () => fs.unlink(tmpFile, () => {}));
    });
  }

  // ── Seek ───────────────────────────────────────────────────────────────────

  async seek(seconds) {
    const track = this.track;
    if (!track || !this._playing) return;
    ++this._generation;

    const sec = Math.max(0, this._duration ? Math.min(seconds, this._duration) : seconds);

    const savedDuration = this._duration;
    this._stopCurrent();            // emits 'stopped', sets track=null
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

  // ── Stop ───────────────────────────────────────────────────────────────────

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

  _stopCurrent() {
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
  }

  // ── Volume ─────────────────────────────────────────────────────────────────

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(100, Math.round(vol)));

    const pactl = spawn('pactl', [
      '--server', config.PULSE_SERVER,
      'set-sink-volume', config.PULSE_SINK,
      `${this.volume}%`,
    ]);
    pactl.on('error', err => console.error('[Audio] pactl error:', err.message));

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
      } else {
        await this.playFile(next.path, next.title);
      }
    } catch (err) {
      console.error('[Audio] Queue track error:', err.message);
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

    // Parse structured progress from stdout (out_time_us=microseconds)
    let _progBuf = '';
    this._ffmpeg.stdout.on('data', d => {
      _progBuf += d.toString();
      const lines = _progBuf.split('\n');
      _progBuf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)$/);
        if (!m) continue;
        const segSecs = parseInt(m[1]) / 1_000_000;
        this._elapsed = segSecs + this._seekOffset;
        this.emit('progress', { elapsed: this._elapsed, duration: this._duration });
      }
    });

    this._ffmpeg.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) console.error('[FFmpeg]', msg);
    });

    this._ffmpeg.on('error', err => {
      console.error('[FFmpeg] spawn error:', err.message);
      this._ffmpeg = null;
      this.track   = null;
      this.emit('error', err);
    });

    this._ffmpeg.on('close', (code, signal) => {
      console.log(`[FFmpeg] process exited code=${code ?? 'none'} signal=${signal ?? 'none'} track=${this.track?.title ?? 'none'}`);
      const wasTrack   = this.track;
      this._ffmpeg     = null;
      this._ytdlp      = null;
      this.track       = null;
      this._elapsed    = 0;
      this._seekOffset = 0;
      this._duration   = null;

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
