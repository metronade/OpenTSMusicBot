# OpenTS Music Bot

A fully self-hosted **TeamSpeak 3 Music Bot** built on a headless TS3 client (Xvfb + PulseAudio) running inside Docker.  
Audio from local files or YouTube is streamed via `yt-dlp` → `FFmpeg` → PulseAudio virtual sink → TS3 microphone input — no external services, no API keys, no SinusBot.

## Features

| Category | Details |
|----------|---------|
| **Playback** | Local files, YouTube streams, radio streams, named playlists, queue with auto-advance, drag-and-drop queue reorder |
| **Controls** | Volume, stop, skip, loop, seek/scrub, channel move, nickname change |
| **Radio** | Stream any internet radio URL, save and manage stations, play via dashboard or `!radio` chat command |
| **TTS** | Text-to-speech via Piper — 10 voices in German & English, adjustable noise/speed/speaker-noise parameters |
| **TTS Events** | Configurable join/leave announcements with `{username}` placeholder |
| **Web UI** | Dashboard, drag-and-drop upload, playlist builder, radio station management, user management |
| **Themes** | Dark (default) and light theme toggle with persistent preference |
| **Keyboard Shortcuts** | Space = stop, Left/Right arrows = seek ±5s, M = mute/unmute |
| **Chat Commands** | Full set of `!`-commands usable directly in the TS3 channel |
| **Auth** | Session-based login, admin/user roles, forced password change on first login, session invalidation |
| **Reliability** | FFmpeg watchdog (30s timeout), exponential reconnect backoff (2s–60s), upload validation via ffprobe |
| **Security** | Rate limiting (login 5/15min, API 100/min), configurable log level |
| **Files** | mp3, ogg, wav, flac, m4a — up to 50 MB per file, validated for audio content on upload |
| **Identity** | Upload existing `identity.ini` or let the client auto-generate one |
| **Admin Tools** | Database backup download, healthcheck endpoint, session management |
| **Deployment** | Single `docker compose up --build` — two containers, three bind-mount volumes |

---

## Quick Start

### 1. Prerequisites

- Docker ≥ 24 and Docker Compose v2
- A TeamSpeak 3 **server** to connect to

### 2. Clone and configure

```bash
git clone https://github.com/metronade/OpenTSMusicBot.git
cd ts3musicandytbot
cp .env.example .env
```

Edit `.env`:

```dotenv
SESSION_SECRET=<random 48+ character string>
TS3_SERVER=your.ts3server.com
TS3_PORT=9987
TS3_NICKNAME=MusicBot
TS3_CHANNEL=Music          # channel to auto-join (leave empty for default)
TS3_PASSWORD=              # server password if required
APP_PORT=3000
LOG_LEVEL=info             # debug | info | warn | error
```

Generate a strong session secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 3. Build and run

```bash
docker compose up --build -d
docker compose logs -f    # watch startup
```

Open **http://localhost:3000** and log in with `admin` / `admin`.  
You will be forced to change the password on first login.

---

## Chat Commands

Commands are typed in the **TS3 channel** where the bot is present.

| Command | Description |
|---------|-------------|
| `!play <name>` | Play a file from the library. No extension needed — `!play mysong` matches `mysong.mp3` |
| `!yt <url>` | Stream audio from a YouTube URL |
| `!radio <url\|name>` | Play a radio stream by URL or saved station name |
| `!radio-list` | List all saved radio stations |
| `!playlist <name>` | Play a named playlist created in the Web UI |
| `!queue` | Show the first 5 entries of the current playback queue |
| `!queue <name>` | Add a file to the queue by name |
| `!skip` | Skip to the next track in the queue |
| `!loop` | Toggle loop for the current track (not available for YouTube/radio streams) |
| `!vol <0-100>` | Set playback volume in real-time |
| `!stop` | Stop current playback and clear the queue |
| `!say <text>` | Read text aloud via TTS (max 300 characters) |
| `!voice <name>` | Switch the TTS voice (or show current + all available voices) |
| `!list` | Show all files and playlists in the channel chat |
| `!help` | Show all available commands |

> **Concurrent play protection:** If two `!play` or `!yt` commands arrive at nearly the same time, only the last one wins. The earlier command is silently discarded before FFmpeg starts, so there is never parallel playback.

---

## Web UI

| Section | Features |
|---------|----------|
| **Dashboard** | Bot status (Connect / Disconnect / Reconnect), now-playing with live progress bar and seek slider, skip button, volume slider, Quick Play with autocomplete, YouTube stream input, radio stream input, queue management (drag & drop reorder), play history, channel switcher, nickname changer, quick TTS input |
| **TTS** | Dedicated TTS page — voice selection (German & English), Piper parameter sliders (noise scale, length scale, speaker noise), text input |
| **Radio** | Manage saved radio stations (add/delete), quick-play any stream URL |
| **Library** | Drag-and-drop upload (mp3 / ogg / wav / flac / m4a, max 50 MB), searchable file list with per-file Play, +Queue and Delete buttons |
| **Playlists** | Create / delete playlists, add / remove files, play entire playlist |
| **Settings** *(admin)* | User management, session invalidation, chat feedback toggles, TTS event announcements, identity upload, YouTube cookies |

### Queue

Files, YouTube URLs, and radio streams can be added to the queue from:
- **Dashboard** → Quick Play `+Q` or YouTube `+Q`
- **Library** → `+Q` next to each file

Queue items can be **reordered via drag & drop** on the Dashboard.

When nothing is playing, adding the first item starts playback immediately.
Use `!stop` (or the Stop button) to stop and clear the queue. `!skip` (or the Skip button) advances to the next queued track. Individual items can be removed from the Dashboard queue list.

### Play History

The Dashboard shows the last **10 played tracks** in the *Recent Plays* card. Click ▶ next to any entry to replay it immediately.

### Progress Bar & Seek

For local files the progress bar shows elapsed / total time and doubles as a seek slider — drag or click to jump to any position. YouTube streams show elapsed time only (seeking requires re-buffering the stream). Radio streams do not support seeking.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Stop playback |
| `←` / `→` | Seek backward/forward 5 seconds |
| `M` | Toggle mute/unmute |

Shortcuts are disabled while typing in an input field, textarea, or select.

### Dark / Light Theme

Click the moon/sun icon in the sidebar footer to toggle between dark and light themes. The preference is stored in `localStorage` and applied before the page renders (no flash).

### Now Playing in Tab Title

When a track is playing, the browser tab title updates to show the track name: `Song Name — TS3 Music Bot`. When idle, it reverts to `TS3 Music Bot`.

---

## Radio Streams

The bot can play any internet radio stream (Icecast/Shoutcast/etc.) by URL or by saved station name.

### Adding stations

**Web UI → Radio page:** Enter a station name and stream URL, then click **Add**.

Stations appear in the list and can be played or deleted from there.

### Playing radio

- **Dashboard:** Enter a stream URL in the "Radio Stream" card, or select a saved station from the dropdown
- **Radio page:** Click ▶ next to a station, or use the Quick Play URL input
- **Chat:** `!radio <url>` or `!radio <station-name>` to play, `!radio-list` to see saved stations

Radio streams play continuously until stopped or another track is started. Loop and seek are not available for radio streams.

**Settings → Chat Feedback** lets admins toggle which bot actions send a reply in the TS3 channel:

| Toggle | Controls replies for |
|--------|---------------------|
| Play (files) | `!play`, queue auto-play |
| Stop | `!stop` |
| Volume | `!vol` |
| YouTube | `!yt` |
| Playlist | `!playlist` |

Changes take effect immediately without a restart.

---

## Text-to-Speech (TTS)

TTS is powered by **[Piper](https://github.com/rhasspy/piper)** with pre-bundled voice models in German and English.

### Available voices

#### German

| Voice ID | Label | Model | Notes |
|----------|-------|-------|-------|
| `thorsten` | Thorsten | de_DE-thorsten-medium | Default — natural, clear |
| `kerstin` | Kerstin | de_DE-kerstin-low | Lighter model |
| `thorsten_angry` | Thorsten (Angry) | de_DE-thorsten_emotional-medium | Multi-speaker model |
| `thorsten_disgusted` | Thorsten (Disgusted) | de_DE-thorsten_emotional-medium | Multi-speaker model |
| `thorsten_drunk` | Thorsten (Drunk) | de_DE-thorsten_emotional-medium | Multi-speaker model |
| `thorsten_sleepy` | Thorsten (Sleepy) | de_DE-thorsten_emotional-medium | Multi-speaker model |
| `thorsten_whisper` | Thorsten (Whisper) | de_DE-thorsten_emotional-medium | Multi-speaker model |

#### English

| Voice ID | Label | Model |
|----------|-------|-------|
| `alba` | Alba | en_GB-alba-medium |
| `cori` | Cori | en_GB-cori-medium |
| `northern_english_male` | Northern English Male | en_GB-northern_english_male-medium |

### Piper parameters

The dedicated **TTS page** in the Web UI exposes three adjustable Piper parameters:

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| Noise Scale | 0.667 | 0 – 1 | Controls randomness in audio generation. Higher values = more variation |
| Length Scale | 1.0 | 0.1 – 5 | Speech speed. < 1 = faster, > 1 = slower |
| Speaker Noise | 0.8 | 0 – 1 | Controls phoneme prediction noise. Higher values = more variation |

Parameters are saved server-side and persist across sessions. Use the **Reset Defaults** button to restore defaults.

### Usage

**Web UI — TTS page:** Select a voice (grouped by language), adjust parameters, type text, click **Say**.

**Web UI — Dashboard:** Quick TTS card with default voice and settings. Click the link to open the full TTS page.

**Chat:**
```
!say Hallo zusammen, willkommen im Kanal!
!voice kerstin
!voice thorsten_angry
!voice          (shows current voice + all available)
```

The TTS voice selected in the WebUI / via `!voice` is the **interactive voice** used for `!say` and the WebUI Say button. It is independent of the voice used for event announcements (see below).

---

## TTS Event Announcements

The bot can automatically announce when users **join or leave** the channel it is currently in.

### Configuration

**Settings → TTS Event Announcements:**

- Enable/disable join and leave events independently
- Customize the spoken text — use `{username}` as a placeholder for the joining/leaving user's nickname
- Choose a **dedicated voice** for event announcements (independent of the interactive TTS voice)

**Example texts:**

| Event | Example text |
|-------|-------------|
| Join | `Hallo {username}, schön dass du da bist!` |
| Leave | `Tschüss {username}!` |

### Grace period

When the bot itself moves to a different channel, all join/leave events within the next **3 seconds** are suppressed. This prevents false announcements caused by the bot's own channel switch.

---

## YouTube Streaming

YouTube streaming uses `yt-dlp` to resolve the direct audio URL, which FFmpeg then plays.

### Why cookies are required on server/VPS IPs

YouTube blocks unauthenticated requests from datacenter IP ranges (Hetzner, OVH, DigitalOcean, etc.) with a "Sign in to confirm you're not a bot" error. Authenticating via a browser cookie file bypasses this check.

### How to export cookies

**Chrome / Edge:**
1. Install **[Get cookies.txt LOCALLY](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)**
2. Go to **https://www.youtube.com** while logged in
3. Click the extension icon → **Export** → save as `cookies.txt`

**Firefox:**
1. Install **[cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/)**
2. Go to **https://www.youtube.com** while logged in
3. Click the extension icon → **Current Site** → download

> **Tip:** Use a dedicated Google account so the bot's watch history stays separate from yours.

### Uploading via the Web UI

1. **Settings → YouTube Cookies → Upload cookies.txt**
2. The status badge changes to **Cookies present**
3. Streaming now works — no restart needed

To replace expired cookies, upload a fresh file. To remove them, click **Delete**.

### How long do cookies last?

Typically several months while the Google account stays active. If streaming fails again with a "Sign in to confirm" error, export and upload a fresh `cookies.txt`.

---

## Identity Management

### Upload an existing identity

> **Important:** The full process requires **two restarts** and takes about 4–5 minutes total.

1. Export your identity from the TS3 client: **Tools → Identities → Export**
2. Start the containers and **wait ~2 minutes** for the ts3client startup sequence to complete
3. **Settings → Bot Identity** → upload the `.ini` file
4. Restart the TS3 container and wait ~2 minutes again:
   ```bash
   docker compose restart ts3client
   ```
5. Restart both containers for a clean connection state:
   ```bash
   docker compose restart
   ```

**Why two restarts?** The identity file is only read at ts3client startup. The second restart ensures the app container initialises with a fully connected TS3 client.

**Tip:** Place `identity.ini` in `./identities/` *before* the very first `docker compose up` to skip the upload step entirely.

### Auto-generated identity

If no identity file is present, the TS3 client generates a new identity at security level 8 on first run.

---

## Project Structure

```
ts3musicandytbot/
├── docker-compose.yml          # Two services: app + ts3client
├── .env.example                # All configuration variables
├── music/                      # Uploaded audio files (bind-mount)
├── identities/                 # TS3 identity files (bind-mount)
├── config/                     # SQLite DB + sessions (bind-mount)
│
├── app/                        # Node.js backend + Web UI
│   ├── Dockerfile              # Node 20, FFmpeg, yt-dlp, Piper TTS, healthcheck
│   ├── server.js               # Express + Socket.io + chat command handler
│   ├── config.js               # Env vars + LOG_LEVEL
│   ├── voices.js               # Piper TTS voice registry (all voices + speaker IDs)
│   ├── db/init.js              # SQLite schema + radios table + settings helpers
│   ├── services/
│   │   ├── logger.js           # Level-aware logger utility
│   │   ├── ts3query.js         # ClientQuery TCP client (protocol parser, event emitter)
│   │   └── audio.js            # FFmpeg / yt-dlp / Piper process manager
│   ├── routes/
│   │   ├── auth.js             # Login / logout / change-password / session invalidation
│   │   ├── bot.js              # Playback, skip, volume, seek, TTS, radio, queue reorder
│   │   ├── files.js            # Upload (ffprobe validated) / list / delete
│   │   ├── playlists.js        # CRUD + file ordering
│   │   └── radios.js           # CRUD for radio stations
│   └── public/                 # Single-page Web UI (vanilla JS, dark/light themes)
│
└── ts3client/                  # Headless TS3 client container
    ├── Dockerfile              # Ubuntu 22.04 + Xvfb + PulseAudio + TS3 3.6.2
    └── entrypoint.sh           # Starts Xvfb → PulseAudio → TS3 client
```

---

## Architecture

```
┌──────────────────────────┐        TCP :25639         ┌───────────────────────────┐
│   app container          │ ◄─── ClientQuery plugin ──► │   ts3client container     │
│  ─────────────────────── │                             │  ──────────────────────── │
│  Express  + Socket.io    │   PULSE_SERVER tcp:4713     │  Xvfb :99                 │
│  SQLite  (users/files/   │ ──── FFmpeg audio ────────► │  PulseAudio               │
│          playlists/      │       to virtual_out         │   ├─ null sink virtual_out │
│          settings)       │                             │   └─ virtual_mic (monitor) │
│  yt-dlp  + FFmpeg        │                             │  TS3 Client ← PULSE_SOURCE │
│  Piper TTS               │                             └───────────────────────────┘
│  Web UI  :3000           │
└──────────────────────────┘
```

### Audio pipeline

```
yt-dlp stdout  ─or─  local file  ─or─  Piper TTS WAV
        │
        ▼
FFmpeg  -ar 48000  -ac 2  -af volume=N  -f pulse  virtual_out
        │  PULSE_SERVER=tcp:ts3client:4713
        ▼
PulseAudio  null sink "virtual_out"
        │
        │  virtual_mic  (monitors virtual_out)
        ▼
TS3 Client  PULSE_SOURCE=virtual_mic
        │
        ▼
TeamSpeak 3 Server  (transmitted as microphone input)
```

FFmpeg always resamples to **48 kHz / stereo** to match TeamSpeak's codec parameters.

---

## Volume

Volume is controlled in two ways:

- **At stream start:** FFmpeg applies a `volume=N/100` audio filter.
- **In real-time** (`!vol` / Web UI slider): `pactl set-sink-volume` adjusts the PulseAudio sink without restarting the stream.

---

## Volumes & Persistence

| Host path | Container path | Purpose |
|-----------|---------------|---------|
| `./music/` | `/app/music` | Uploaded audio files |
| `./identities/` | `/app/identities` (app), `/identities` (ts3) | TS3 identity files |
| `./config/` | `/app/config` | SQLite DB, sessions |

---

## Troubleshooting

### Bot is offline / ClientQuery not reachable

The app retries every 5 seconds. Check TS3 container logs:
```bash
docker compose logs ts3client
```
If you see `ClientQuery ready!` but the app still can't connect, ensure `ts3client/entrypoint.sh` writes `Host=0.0.0.0` to the plugin config, then rebuild.

### No audio / yt-dlp errors

```bash
# Check yt-dlp version (rebuild pulls latest)
docker compose exec app yt-dlp --version
docker compose build app --no-cache

# Confirm PulseAudio TCP is reachable from the app container
docker compose exec app pactl --server tcp:ts3client:4713 info
```

### TTS produces no audio

Piper requires the voice model files to be present in `/app/piper-voices/`. These are downloaded during the app image build. Rebuild the app image if they are missing:
```bash
docker compose build app
```

### EULA dialog blocks startup

Set `ACCEPT_EULA=1` in `docker-compose.yml` (already the default). If the client still hangs, verify the EULA keys were written:
```bash
docker compose exec ts3client sqlite3 ~/.config/TeamSpeak/settings.db \
  "SELECT * FROM Misc WHERE key LIKE '%license%';"
```

### TS3 client crashes on start

The container needs `cap_add: SYS_NICE` and `shm_size: 256m` (both set in `docker-compose.yml`). Verify they are present.

### `Server is already active for display 99` on container restart

Xvfb leaves a lock file behind when the container stops uncleanly. The entrypoint removes it automatically. If the error persists:
```bash
docker compose exec ts3client rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
docker compose restart ts3client
```

### `libssl1.1` missing at runtime

TS3 3.6.x was built against OpenSSL 1.1. Ubuntu 22.04 ships only OpenSSL 3. The Dockerfile installs `libssl1.1` from the Ubuntu focal security repo automatically. If the error reappears after a base-image update:
```bash
docker compose build --no-cache ts3client
```

---

## Reliability

### FFmpeg Watchdog

A 30-second watchdog monitors FFmpeg progress events. If no progress is received within 30 seconds, FFmpeg is killed and an error is emitted. This prevents the bot from hanging on stalled streams.

### Reconnect Backoff

The TS3 ClientQuery connection uses exponential backoff on reconnect: starting at 2 seconds, doubling each attempt, capped at 60 seconds. The counter resets on successful connection.

### Upload Validation

Uploaded files are validated with `ffprobe` to ensure they contain at least one audio stream. Corrupted or non-audio files are rejected before they enter the library.

### yt-dlp Error Hints

When `yt-dlp` fails, the bot parses the error output and provides user-friendly hints:
- **Cookies required** → suggests uploading `cookies.txt`
- **Private / age-restricted** → explains the limitation
- **Geo-blocked** → notes geographic restrictions

---

## Admin Tools

### Health Check

The `/api/health` endpoint returns bot status without authentication:

```json
{ "status": "ok", "ts3": true, "uptime": 3600, "version": "1.0.0" }
```

The Dockerfile includes a built-in `HEALTHCHECK` instruction using this endpoint.

### Database Backup

**Settings page** or direct API call (`GET /api/backup/db`, admin only) downloads a consistent SQLite snapshot.

### Session Invalidation

**Settings → User Management → Logout All Other Sessions** kills all sessions except the current one. Useful after a password change.

### Rate Limiting

- Login: 5 attempts per 15 minutes per IP
- General API: 100 requests per minute per IP
- Health endpoint: unlimited (no auth required)

### Configurable Logging

Set `LOG_LEVEL` in `.env` to control verbosity:

| Level | Output |
|-------|--------|
| `debug` | Everything |
| `info` | Normal operations (default) |
| `warn` | Warnings and above |
| `error` | Errors only |

---

## Security Notes

- Change `SESSION_SECRET` to a strong random value before first run.
- The default admin password must be changed on first login (enforced by the UI).
- The Web UI is not HTTPS by default — place it behind a reverse proxy (nginx / Caddy) with TLS for external access.
- PulseAudio TCP uses `auth-anonymous=1`; it is only exposed inside the private Docker bridge network, not to the host.

---

## Development

```bash
cd app
npm install
TS3_QUERY_HOST=localhost npm run dev
```

Dependencies: `express`, `socket.io`, `better-sqlite3`, `bcryptjs`, `express-session`, `connect-sqlite3`, `express-rate-limit`, `multer`, `uuid`.
