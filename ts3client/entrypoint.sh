#!/bin/bash
# ============================================================
#  TS3 Bot Entrypoint
#  Order: Xvfb → PulseAudio (null sink + TCP) → settings init → TS3 client
# ============================================================
set -euo pipefail

TS3_DIR="$HOME/TeamSpeak3-Client-linux_amd64"
TS3_BIN="$TS3_DIR/ts3client_linux_amd64"
TS3_CFG="$HOME/.ts3client"

# ── 1. Virtual display ──────────────────────────────────────────────────────
# Clean up any leftover lock/socket from a previous (crashed) run.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

Xvfb :99 -screen 0 1024x768x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99

# Wait until Xvfb is actually accepting connections (max 15 s)
for i in $(seq 1 15); do
    xdpyinfo -display :99 &>/dev/null && break
    sleep 1
done
echo "[Xvfb] Display :99 ready"

# ── 2. PulseAudio setup ─────────────────────────────────────────────────────
mkdir -p "$HOME/.config/pulse"
mkdir -p /tmp/runtime-ts3bot/pulse
chmod 700 /tmp/runtime-ts3bot

# daemon.conf: disable idle-exit and RT scheduling (RT fails in containers).
# Larger fragments prevent buffer underflows in TS3's audio subsystem.
cat > "$HOME/.config/pulse/daemon.conf" << 'EOF'
exit-idle-time = -1
allow-exit = no
daemonize = no
realtime-scheduling = no
high-priority = no
nice-level = 0
rlimit-memlock = 0
default-fragments = 4
default-fragment-size-msec = 25
EOF

# client.conf: disable autospawn so libpulse (TS3) never tries to start a
# second PA instance when our managed instance is temporarily unavailable.
cat > "$HOME/.config/pulse/client.conf" << 'EOF'
autospawn = no
daemon-binary = /usr/bin/pulseaudio
EOF

cat > "$HOME/.config/pulse/default.pa" << 'EOF'
# Load the standard modules
load-module module-device-restore
load-module module-stream-restore
load-module module-card-restore

# Null sink — FFmpeg writes here from the app container
load-module module-null-sink sink_name=virtual_out sink_properties=device.description="TS3MusicBot_Output" rate=48000 channels=2

# Discard sink — TS3 client plays incoming server audio here (prevents echo).
# Without this, TS3 would play to virtual_out (the default), and virtual_mic
# would loop it back to the server as the bot's own microphone input.
load-module module-null-sink sink_name=ts3_discard sink_properties=device.description="TS3_Playback_Discard"

# Virtual microphone — TS3 client captures from here (monitors virtual_out only).
# Because TS3's playback goes to ts3_discard, only FFmpeg output ends up here.
load-module module-virtual-source source_name=virtual_mic master=virtual_out.monitor source_properties=device.description="TS3MusicBot_Mic"

# Unix socket — libpulse default discovery checks this path first.
# Without it, libpulse gets ENOENT on both socket candidates and
# null-derefs → SIGSEGV in ts3client.  The socket path must match
# XDG_RUNTIME_DIR/pulse/native (set later to /tmp/runtime-ts3bot).
load-module module-native-protocol-unix auth-anonymous=1 socket=/tmp/runtime-ts3bot/pulse/native

# Expose PulseAudio over TCP (accessible inside Docker network)
load-module module-native-protocol-tcp auth-anonymous=1 port=4713 listen=0.0.0.0
EOF

# Kill any stale PA daemon from a previous (crashed) run before starting fresh.
pulseaudio --kill 2>/dev/null || true; sleep 0.3

pulseaudio --daemonize=no \
           --exit-idle-time=-1 \
           --log-target=stderr \
           --log-level=warn &
PA_PID=$!

# TS3 connects to PA via TCP (PULSE_SERVER=tcp:127.0.0.1:4713).
# Set that server now so all pactl calls below use the same path TS3 will use.
# This makes our readiness checks test the exact connection TS3 will make.
export PULSE_SERVER=tcp:127.0.0.1:4713

# Wait until a full PA protocol handshake over TCP succeeds (not just nc -z).
# nc -z only confirms the port is open; the PA protocol may still be loading.
for i in $(seq 1 60); do
    pactl info &>/dev/null && break
    sleep 0.5
done
echo "[PA] PulseAudio TCP handshake OK"

# Additionally verify virtual_mic source is loaded (module-virtual-source
# loads slightly after the TCP module).
for i in $(seq 1 30); do
    pactl list sources short 2>/dev/null | grep -q virtual_mic && break
    sleep 0.5
done
echo "[PA] virtual_mic source ready"

# Set virtual_mic as the default source so TS3 picks it up automatically
pactl set-default-source virtual_mic 2>/dev/null || true

# Keep virtual_out as the PA default sink so FFmpeg (remote TCP client)
# always lands on the right sink without explicit name resolution.
# TS3's playback output is redirected to ts3_discard AFTER TS3 starts
# (see section 7f below) using pactl move-sink-input.
echo "[PA] PulseAudio ready — default_sink=virtual_out, ts3_playback=ts3_discard (moved after TS3 start), source=virtual_mic"

# ── PA watchdog ─────────────────────────────────────────────────────────────
# PulseAudio can crash in containers (e.g. after RT-scheduling failure or a
# module fault).  This watchdog polls every 10 s; if PA is no longer reachable
# it clears the stale PID file and restarts.  Without this, libpulse in TS3
# would permanently lose audio and the bot would stay fullmuted.
_pa_restart() {
    echo "[PA] Watchdog: PulseAudio dead — restarting..."
    pulseaudio --kill 2>/dev/null || true
    rm -f /tmp/runtime-ts3bot/pulse/pid "$HOME/.config/pulse/pid" 2>/dev/null || true
    sleep 0.5
    pulseaudio --daemonize=no \
               --exit-idle-time=-1 \
               --log-target=stderr \
               --log-level=warn &
    echo "[PA] Watchdog: PulseAudio restarted (PID $!)"
    sleep 5
    pactl set-default-source virtual_mic 2>/dev/null || true
}
(
    set +e
    sleep 15   # let PA settle after initial startup
    while true; do
        sleep 10
        if ! pactl --server tcp:127.0.0.1:4713 info &>/dev/null; then
            _pa_restart
        fi
    done
) &

# ── 3. TS3 Client settings initialisation ───────────────────────────────────
mkdir -p "$TS3_CFG"

init_settings_db() {
    local db="$TS3_CFG/settings.db"
    if [[ "${ACCEPT_EULA:-}" != "1" ]]; then return; fi
    echo "[TS3] Pre-accepting EULA in settings.db …"
    sqlite3 "$db" << 'SQL'
CREATE TABLE IF NOT EXISTS Misc (
    key   TEXT NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT OR REPLACE INTO Misc(key, value) VALUES ('licenseAgreementRead',       '1');
INSERT OR REPLACE INTO Misc(key, value) VALUES ('licenseAgreementVersion',    '5');
INSERT OR REPLACE INTO Misc(key, value) VALUES ('LicenseAgreed',             'true');
-- "min version 0 to 4" in update log → TS3 requires min-version acceptance too.
-- Try all candidate key names since TS3 source is closed.
INSERT OR REPLACE INTO Misc(key, value) VALUES ('licenseAgreementMinVersion', '4');
INSERT OR REPLACE INTO Misc(key, value) VALUES ('licenseMinVersion',          '4');
INSERT OR REPLACE INTO Misc(key, value) VALUES ('LicenseMinVersion',          '4');

CREATE TABLE IF NOT EXISTS Plugins (
    filename TEXT NOT NULL PRIMARY KEY,
    enabled  INTEGER NOT NULL DEFAULT 1
);
INSERT OR REPLACE INTO Plugins(filename, enabled)
    VALUES ('libclientquery_plugin_linux_amd64.so', 1);

-- TS3 runtime checks General.LicenseVersion (not Misc) for the update dialog.
CREATE TABLE IF NOT EXISTS General (
    timestamp INTEGER UNSIGNED NOT NULL,
    key       VARCHAR NOT NULL UNIQUE,
    value     VARCHAR
);
CREATE INDEX IF NOT EXISTS index_General_key ON General (key);
INSERT OR REPLACE INTO General(timestamp, key, value)
    VALUES (strftime('%s','now'), 'LicenseVersion',    '5');
INSERT OR REPLACE INTO General(timestamp, key, value)
    VALUES (strftime('%s','now'), 'LicenseMinVersion', '4');

-- Capture profile: continuous transmission so TS3 always forwards
-- virtual_mic audio (FFmpeg music) without waiting for VAD to trigger.
-- TS3 seeds missing profiles with INSERT OR IGNORE, so our values win.
CREATE TABLE IF NOT EXISTS Profiles (
    timestamp INTEGER UNSIGNED NOT NULL,
    key       VARCHAR NOT NULL UNIQUE,
    value     VARCHAR
);
CREATE INDEX IF NOT EXISTS index_Profiles_key ON Profiles (key);
INSERT OR REPLACE INTO Profiles(timestamp, key, value)
    VALUES (strftime('%s','now'), 'DefaultCaptureProfile', 'Default');
INSERT OR REPLACE INTO Profiles(timestamp, key, value)
    VALUES (strftime('%s','now'), 'Capture/', '');
INSERT OR REPLACE INTO Profiles(timestamp, key, value)
    VALUES (strftime('%s','now'), 'Capture//', '');
INSERT OR REPLACE INTO Profiles(timestamp, key, value)
    VALUES (strftime('%s','now'), 'Capture/Default', 'Mode=
Device=virtual_mic
DeviceDisplayName=TS3MusicBot_Mic
');
INSERT OR REPLACE INTO Profiles(timestamp, key, value)
    VALUES (strftime('%s','now'), 'Capture/Default/PreProcessing',
'denoise=false
continous_transmission=true
vad=false
voiceactivation_level=-40
agc=false
vad_over_ptt=false
vad_mode=0');

-- Playback profile: route TS3 playback directly to ts3_discard instead of
-- relying on the runtime pactl move-sink-input workaround (section 7f).
-- Without this, TS3 uses a "ts.pa.dummy.playbackdefault" device that causes
-- constant buffer underflows, destabilising the entire audio thread.
INSERT OR REPLACE INTO Profiles(timestamp, key, value)
    VALUES (strftime('%s','now'), 'DefaultPlaybackProfile', 'Default');
INSERT OR REPLACE INTO Profiles(timestamp, key, value)
    VALUES (strftime('%s','now'), 'Playback/', '');
INSERT OR REPLACE INTO Profiles(timestamp, key, value)
    VALUES (strftime('%s','now'), 'Playback//', '');
INSERT OR REPLACE INTO Profiles(timestamp, key, value)
    VALUES (strftime('%s','now'), 'Playback/Default', 'Mode=
Device=ts3_discard
DeviceDisplayName=TS3_Playback_Discard
');
SQL
}
init_settings_db

# ── 4. ClientQuery plugin config (listen on all interfaces) ─────────────────
# ~/.ts3client/plugins/clientquery_plugin.ini is bind-mounted read-only from the
# host; do not write to it here.  Copy to the TS3 install dir as a fallback.
mkdir -p "$TS3_DIR/config/plugins"
cp "$TS3_CFG/plugins/clientquery_plugin.ini" "$TS3_DIR/config/plugins/clientquery_plugin.ini" 2>/dev/null || true

# ── 5. Identity handling ─────────────────────────────────────────────────────
IDENTITY_DATA=""
if [[ -f "/identities/identity.ini" ]]; then
    echo "[TS3] Found identity.ini"
    # Extract the actual private key from identity="<nonce><base64>" — NOT the id= nickname field
    IDENTITY_DATA=$(grep -oP '^identity="\K[^"]+' /identities/identity.ini | head -1)
    if [[ -n "$IDENTITY_DATA" ]]; then
        echo "[TS3] Identity data extracted (${#IDENTITY_DATA} chars)"
    else
        echo "[TS3] WARNING: identity.ini found but id= line is empty or not matched"
    fi
else
    echo "[TS3] No /identities/identity.ini found — TS3 will create a default identity"
fi

# ── 6. Build connect URL ─────────────────────────────────────────────────────
build_connect_url() {
    local server="${TS3_SERVER:-}"
    if [[ -z "$server" ]]; then
        echo ""
        return
    fi

    local port="${TS3_PORT:-9987}"
    local nick="${TS3_NICKNAME:-MusicBot}"
    # URL-encode nickname (replace spaces)
    nick="${nick// /%20}"

    local url="ts3server://${server}?port=${port}&nickname=${nick}"
    [[ -n "${TS3_PASSWORD:-}" ]]  && url+="&password=${TS3_PASSWORD}"
    [[ -n "${TS3_CHANNEL:-}" ]]   && url+="&channel=${TS3_CHANNEL// /%20}"
    echo "$url"
}

CONNECT_URL=$(build_connect_url)

# ── 7. Launch TS3 Client ─────────────────────────────────────────────────────
echo "[TS3] Starting client …"
cd "$TS3_DIR"

# ── Qt / OpenGL environment ──────────────────────────────────────────────────
# XDG_RUNTIME_DIR must exist or Qt warns and some subsystems may crash
export XDG_RUNTIME_DIR="/tmp/runtime-ts3bot"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Use the xcb platform plugin (bundled in TS3's platforms/) with Mesa software
# rendering via EGL+DRI2.
#
# Why not offscreen: TS3 bundles Qt 5.9.x — the system Qt 5.15 offscreen
#   plugin is ABI-incompatible and rejected at load time.
# Why not QT_XCB_GL_INTEGRATION=none: that disables *both* GLX and EGL; TS3
#   then tries to create an OpenGL context, gets null, and aborts.
# Why not GLX: Ubuntu 22.04 removed indirect GLX from Xvfb for security.
# EGL via DRI2: Mesa swrast driver provides software EGL through the X11
#   DRI2 extension, which Xvfb does expose.  Setting LIBGL_ALWAYS_SOFTWARE=1
#   forces Mesa to use swrast rather than a missing GPU driver.
export QT_QPA_PLATFORM=xcb
export QT_QPA_PLATFORM_PLUGIN_PATH="$TS3_DIR/platforms"

# Mesa software rendering — no GPU required.
# MESA_LOADER_DRIVER_OVERRIDE=swrast forces the Mesa software-rasterizer DRI
# driver.  softpipe is used instead of llvmpipe to avoid potential LLVM JIT
# issues in Docker containers.
export LIBGL_ALWAYS_SOFTWARE=1
export MESA_LOADER_DRIVER_OVERRIDE=swrast
export GALLIUM_DRIVER=softpipe

# PULSE_SERVER: tell libpulse to connect via TCP to the local PulseAudio instance.
# Without this, libpulse searches for a Unix socket (/tmp/runtime-ts3bot/pulse/native,
# /var/run/pulse/native) which doesn't exist because PulseAudio was started with
# module-native-protocol-tcp only.  That failure causes a null-deref → SIGSEGV.
export PULSE_SERVER=tcp:127.0.0.1:4713

# PULSE_SOURCE points TS3 at our virtual microphone
export PULSE_SOURCE=virtual_mic

# ── Workarounds for headless / Docker crashes ────────────────────────────────

# GStreamer: scan plugins in-process (forked scanner can crash in containers)
export GST_REGISTRY_FORK=no
gst-inspect-1.0 --no-recurse &>/dev/null || true

# Qt MIT-SHM: Xvfb may have limited SHM; disable shared-memory pixmaps
export QT_X11_NO_MITSHM=1

# D-Bus: Qt xcb tries to connect to the session bus for accessibility/systray.
# In a headless container with no dbus-daemon, this segfaults during
# QApplication construction.  "disabled:" is the canonical value Qt respects
# to skip D-Bus initialisation entirely.
export DBUS_SESSION_BUS_ADDRESS=disabled:
export QT_ACCESSIBILITY=0
export NO_AT_BRIDGE=1

# GStreamer warning verbosity for docker logs
export GST_DEBUG="*:2"

# Ignore SIGPIPE before forking TS3.  SIG_IGN is preserved across exec, so TS3
# inherits it.  TS3's thread pool uses pthread_kill(tid, SIGPIPE) to shut down
# worker threads; with SIG_DFL that cascade kills the whole process.  With
# SIG_IGN the workers keep running and TS3 stays up through server disconnects.
trap '' PIPE

# Pre-check: log whether the TS3 server host is reachable (informational only).
if [[ -n "${TS3_SERVER:-}" ]]; then
    if ping -c1 -W3 "$TS3_SERVER" &>/dev/null; then
        echo "[TS3] Server $TS3_SERVER is reachable (ping OK)"
    else
        echo "[TS3] WARNING: $TS3_SERVER did not respond to ping (firewalled or down)"
    fi
fi

# ── Strace wrapper — prints fault address live to docker logs ────────────────
# Filter to fatal signals only (SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE) so
# output is minimal.  Output goes directly to stdout → visible immediately
# in "docker compose logs" without waiting for the container to exit.
# Always start without a connect URL.  The high-security identity is injected
# via ClientQuery (section 7d) AFTER TS3 initialises, so the first connection
# attempt already uses the correct identity.  Passing the URL here would cause
# TS3 to connect immediately with the default low-security identity, receive a
# server rejection with autoreconnect=0, and refuse any subsequent reconnect.
if [[ -n "$CONNECT_URL" ]]; then
    echo "[TS3] Will connect via ClientQuery after identity import (URL: $CONNECT_URL)"
else
    echo "[TS3] No TS3_SERVER set — starting without auto-connect."
fi
strace -f -q -e trace=exit_group -e "signal=SIGSEGV,SIGABRT,SIGBUS,SIGILL,SIGFPE,SIGPIPE" \
    ./ts3client_linux_amd64 2>&1 &
TS3_PID=$!

# ── 7b. Re-patch General.LicenseVersion after TS3 recreates it ──────────────
# TS3 overwrites General.LicenseVersion at startup; keep it at 5 so TS3 does
# not show a license-update dialog.  Also dumps the Profiles table schema once
# (after the loop) so we can discover how identity data is stored there.
(
    set +e
    DB="$HOME/.ts3client/settings.db"
    sleep 1.5
    for i in $(seq 1 35); do
        sqlite3 "$DB" \
            "INSERT OR REPLACE INTO General(timestamp,key,value) VALUES(strftime('%s','now'),'LicenseVersion','5');
             INSERT OR REPLACE INTO General(timestamp,key,value) VALUES(strftime('%s','now'),'LicenseMinVersion','4');" \
            2>/dev/null
        sleep 0.3
    done
    echo "[TS3] License key patch loop done"

    # ── 7b2. Re-patch capture profile after TS3 writes its own defaults ──────
    # TS3 may overwrite the capture profile during startup. Re-apply our settings
    # with INSERT OR REPLACE to ensure continuous transmission mode is active.
    echo "[TS3] Re-patching capture profile…"
    sqlite3 "$DB" "
        INSERT OR REPLACE INTO Profiles(timestamp,key,value) VALUES(strftime('%s','now'),'DefaultCaptureProfile','Default');
        INSERT OR REPLACE INTO Profiles(timestamp,key,value) VALUES(strftime('%s','now'),'Capture/Default','Mode=
Device=virtual_mic
DeviceDisplayName=TS3MusicBot_Mic
');
        INSERT OR REPLACE INTO Profiles(timestamp,key,value) VALUES(strftime('%s','now'),'Capture/Default/PreProcessing','denoise=false
continous_transmission=true
vad=false
voiceactivation_level=-40
agc=false
vad_over_ptt=false
vad_mode=0');
        INSERT OR REPLACE INTO Profiles(timestamp,key,value) VALUES(strftime('%s','now'),'DefaultPlaybackProfile','Default');
        INSERT OR REPLACE INTO Profiles(timestamp,key,value) VALUES(strftime('%s','now'),'Playback/Default','Mode=
Device=ts3_discard
DeviceDisplayName=TS3_Playback_Discard
');
    " 2>/dev/null
    echo "[TS3] Capture+Playback profiles re-patched"

    # Wait for identity/myTeamSpeak dialogs to be dismissed (7e) before dumping,
    # so we capture the DB state AFTER TS3 has written the new identity.
    for _w in $(seq 1 120); do
        [[ -f /tmp/ts3_identity_ready ]] && break
        sleep 0.5
    done
    # Dump all candidate tables to discover where TS3 stores the identity key.
    echo "[TS3] === Capture profile values ==="
    sqlite3 "$DB" "SELECT key, value FROM Profiles WHERE key LIKE 'Capture%' OR key LIKE '%Capture%';" 2>/dev/null
    echo "[TS3] === Profiles schema ==="
    sqlite3 "$DB" ".schema Profiles" 2>/dev/null
    echo "[TS3] === All non-empty tables (identity discovery) ==="
    for _t in $(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" 2>/dev/null); do
        _c=$(sqlite3 "$DB" "SELECT count(*) FROM \"$_t\";" 2>/dev/null || echo 0)
        if [[ "$_c" -gt 0 ]]; then
            echo "[TS3] --- $_t ($_c rows) ---"
            sqlite3 "$DB" "SELECT * FROM \"$_t\" LIMIT 10;" 2>/dev/null | head -40
        fi
    done
) &

# ── 7d. Identity import + connect via ClientQuery ────────────────────────────
# TS3 is started without a connect URL (section 7 above) to avoid a first
# failed attempt with the low-security default identity (autoreconnect=0).
# Here we wait for CQ to be ready, import the high-security identity from
# identity.ini, then connect specifying that identity explicitly.
# CQ output is streamed line-by-line so it appears in logs even if TS3 later
# exits (avoids the temp-file-lost-on-container-exit problem).
(
    set +e
    if [[ -z "${TS3_SERVER:-}" ]]; then exit 0; fi

    # Wait for ClientQuery plugin to open its port (up to 30 s)
    echo "[CQ] Waiting for ClientQuery port 25639…"
    _cq_found=false
    for _j in $(seq 1 60); do
        if nc -z 127.0.0.1 25639 2>/dev/null; then _cq_found=true; break; fi
        sleep 0.5
    done
    if [[ "$_cq_found" != "true" ]]; then
        echo "[CQ] Port 25639 never opened — ClientQuery plugin not loaded, skipping CQ session"
        exit 0
    fi

    # Wait for section 7e to signal that identity import is done (or timeout 60s).
    # This replaces a fixed sleep and ensures we connect only after the identity
    # is in place regardless of how long the license + dialog handling takes.
    echo "[CQ] Waiting for identity-ready signal from section 7e…"
    for _k in $(seq 1 120); do
        [[ -f /tmp/ts3_identity_ready ]] && break
        sleep 0.5
    done
    echo "[CQ] Identity-ready=$([ -f /tmp/ts3_identity_ready ] && echo yes || echo timeout)"
    sleep 2  # brief settle after import
    echo "[CQ] Starting CQ session…"

    CQ_APIKEY=$(grep -oP '^api_key=\K.+' "$TS3_CFG/clientquery.ini" 2>/dev/null | head -1)

    (
        sleep 0.5    # let greeting arrive
        [[ -n "${CQ_APIKEY:-}" ]] && printf 'auth apikey=%s\n' "$CQ_APIKEY"
        sleep 0.4
        # Register for connection-status notifications so we see accept/reject result
        printf 'clientnotifyregister schandlerid=1 event=notifyconnectstatuschange\n'
        sleep 0.3
        printf 'whoami\n'
        sleep 0.5
        # CQ v10 connect: address=host:port, no identity= parameter (unsupported).
        # Identity is imported via GUI in section 7e before this command runs.
        if [[ -n "${TS3_PASSWORD:-}" ]]; then
            printf 'connect address=%s:%s nickname=%s password=%s\n' \
                "${TS3_SERVER}" "${TS3_PORT:-9987}" "${TS3_NICKNAME:-MusicBot}" \
                "${TS3_PASSWORD}"
        else
            printf 'connect address=%s:%s nickname=%s\n' \
                "${TS3_SERVER}" "${TS3_PORT:-9987}" "${TS3_NICKNAME:-MusicBot}"
        fi
        sleep 30   # receive connection result + notifications
        printf 'whoami\n'
        sleep 3
    ) | nc 127.0.0.1 25639 | while IFS= read -r _cq; do
        echo "[CQ] $_cq"
    done || true
    echo "[CQ] session ended"
) &

# ── 7c. Accept license dialog if TS3 shows one ──────────────────────────────
# Return = Decline (TS3 default button exits with code 0). Do NOT use Return.
# Sweep ALL x-positions in one run; check kill -0 to distinguish Accept/Decline.
(
    set +e
    for i in $(seq 1 40); do
        WID=$(DISPLAY=:99 xdotool search --name "License agreement" 2>/dev/null | head -1)
        if [[ -n "$WID" ]]; then
            GEOM=$(DISPLAY=:99 xdotool getwindowgeometry "$WID" 2>/dev/null)
            echo "[TS3] License dialog $WID — $GEOM"

            WIN_X=$(echo "$GEOM" | grep -oP 'Position: \K[0-9]+(?=,)')
            WIN_Y=$(echo "$GEOM" | grep -oP 'Position: [0-9]+,\K[0-9]+')
            WIN_W=$(echo "$GEOM" | grep -oP 'Geometry: \K[0-9]+(?=x)')
            WIN_H=$(echo "$GEOM" | grep -oP 'Geometry: [0-9]+x\K[0-9]+')
            : "${WIN_X:=0}" "${WIN_Y:=0}" "${WIN_W:=740}" "${WIN_H:=700}"

            DISPLAY=:99 xdotool windowfocus --sync "$WID" 2>/dev/null || true
            sleep 0.3

            # Screenshot for debugging (docker cp ts3bot_ts3:/tmp/ts3_license.png .)
            scrot -d 0 /tmp/ts3_license.png 2>/dev/null || true

            # "I accept" (x≈74%, y≈677) is greyed out until the license text is
            # scrolled to the very bottom.  Qt enables the button only when the
            # QScrollBar value reaches its maximum (valueChanged signal).
            TEXT_X=$(( WIN_X + WIN_W / 2 ))
            TEXT_Y=$(( WIN_Y + WIN_H / 2 ))

            # Click text area to give it keyboard focus, then send 3000 Down-
            # arrow events in one xdotool call (--repeat/--delay 0 is fast and
            # definitely reaches the end of any length license document).
            DISPLAY=:99 xdotool mousemove "$TEXT_X" "$TEXT_Y" 2>/dev/null || true
            sleep 0.1
            DISPLAY=:99 xdotool click 1 2>/dev/null || true
            sleep 0.2
            echo "[TS3] Scrolling to bottom via 3000x Down key…"
            DISPLAY=:99 xdotool key --window "$WID" --repeat 3000 --delay 0 \
                --clearmodifiers Down 2>/dev/null || true
            sleep 0.5

            # Click "I accept" — from the screenshot: x≈74% (548/740), y≈677 (y-23)
            ACCEPT_X=$(( WIN_X + WIN_W * 74 / 100 ))
            for dy in 23 27 20 30 17; do
                DISPLAY=:99 xdotool search --name "License agreement" &>/dev/null || break
                ACCEPT_Y=$(( WIN_Y + WIN_H - dy ))
                echo "[TS3] Clicking 'I accept' (74%,y-${dy}): ($ACCEPT_X,$ACCEPT_Y)"
                DISPLAY=:99 xdotool mousemove "$ACCEPT_X" "$ACCEPT_Y" 2>/dev/null || true
                sleep 0.1
                DISPLAY=:99 xdotool click 1 2>/dev/null || true
                sleep 0.5
                if ! DISPLAY=:99 xdotool search --name "License agreement" &>/dev/null; then
                    if kill -0 "$TS3_PID" 2>/dev/null; then
                        echo "[TS3] License ACCEPTED"
                    else
                        echo "[TS3] Click at y-${dy} = Decline (TS3 exited)"
                    fi
                    break
                fi
            done
            break
        fi
        sleep 0.5
    done
) &

# ── 7e. Dismiss startup dialogs + import high-security identity via GUI ──────
# After the license dialog is accepted (section 7c), TS3 shows two more dialogs:
#   1. "You need to setup your identity" (QMessageBox, Enter = OK)
#   2. myTeamSpeak login (Escape = Continue without logging in)
# Once both are dismissed TS3 creates a fresh (level-0) default identity.
# We then import the pre-computed high-security identity from identity.ini via
# Self → Identities → Import so the CQ connect (section 7d, t≈25s) uses it.
(
    set +e

    # Phase 1: wait for license dialog to APPEAR (up to 25 s)
    # Without this the loop below exits immediately because the dialog isn't up yet.
    echo "[GUI] Waiting for license dialog to appear…"
    for _i in $(seq 1 50); do
        DISPLAY=:99 xdotool search --name "License agreement" &>/dev/null && break
        sleep 0.5
    done

    # Phase 2: wait for license dialog to DISAPPEAR (section 7c handles it)
    echo "[GUI] Waiting for license dialog to be dismissed…"
    for _i in $(seq 1 120); do
        ! DISPLAY=:99 xdotool search --name "License agreement" &>/dev/null && break
        sleep 0.5
    done
    # Extra settle: TS3 may still be rendering the next dialogs
    sleep 1.5
    scrot -d 0 /tmp/ts3_post_license.png 2>/dev/null || true

    # 1. "You need to setup your identity" QMessageBox → Enter (OK button)
    echo "[GUI] Dismissing 'setup your identity' dialog…"
    DISPLAY=:99 xdotool key Return 2>/dev/null || true
    sleep 0.8

    # 2. myTeamSpeak login dialog → Escape (Continue without logging in)
    # This appears BEFORE the nickname dialog in TS3 3.6.x wizard order.
    echo "[GUI] Dismissing myTeamSpeak dialog…"
    DISPLAY=:99 xdotool key Escape 2>/dev/null || true
    sleep 1.0
    scrot -d 0 /tmp/ts3_post_mts.png 2>/dev/null || true

    # 3. "Choose your nickname" dialog — appears AFTER myTeamSpeak is dismissed.
    # Type the bot nickname into the input field and confirm with Enter (OK).
    echo "[GUI] Entering nickname in 'Choose your nickname' dialog…"
    DISPLAY=:99 xdotool type --clearmodifiers "${TS3_NICKNAME:-MusicBot}" 2>/dev/null || true
    sleep 0.2
    DISPLAY=:99 xdotool key Return 2>/dev/null || true
    sleep 1.0
    scrot -d 0 /tmp/ts3_post_nickname.png 2>/dev/null || true

    # 3. Import identity via Self → Identities → Import
    if [[ ! -f "/identities/identity.ini" ]]; then
        echo "[GUI] No identity.ini — skipping import"
        touch /tmp/ts3_identity_ready
        exit 0
    fi

    WID=$(DISPLAY=:99 xdotool search --name "TeamSpeak 3" 2>/dev/null | tail -1)
    if [[ -z "$WID" ]]; then
        echo "[GUI] TS3 window not found — cannot import identity"
        touch /tmp/ts3_identity_ready
        exit 1
    fi
    GEOM=$(DISPLAY=:99 xdotool getwindowgeometry "$WID" 2>/dev/null)
    WIN_X=$(echo "$GEOM" | grep -oP 'Position: \K[0-9]+(?=,)')
    WIN_Y=$(echo "$GEOM" | grep -oP 'Position: [0-9]+,\K[0-9]+')
    WIN_W=$(echo "$GEOM" | grep -oP 'Geometry: \K[0-9]+(?=x)')
    WIN_H=$(echo "$GEOM" | grep -oP 'Geometry: [0-9]+x\K[0-9]+')
    : "${WIN_X:=0}" "${WIN_Y:=0}" "${WIN_W:=521}" "${WIN_H:=505}"

    DISPLAY=:99 xdotool windowfocus --sync "$WID" 2>/dev/null || true
    sleep 0.5

    # Open Identities dialog via Ctrl+I shortcut (Tools → Identities, Ctrl+I).
    echo "[GUI] Opening Identities dialog via Ctrl+I…"
    DISPLAY=:99 xdotool key ctrl+i 2>/dev/null || true
    sleep 1.0
    scrot -d 0 /tmp/ts3_identities_dlg.png 2>/dev/null || true

    # Enumerate all visible X11 windows to discover the dialog (even child windows).
    echo "[GUI] Visible windows after Ctrl+I:"
    DISPLAY=:99 xdotool search --onlyvisible 2>/dev/null | while IFS= read -r _wid; do
        _wname=$(DISPLAY=:99 xdotool getwindowname "$_wid" 2>/dev/null)
        _wgeom=$(DISPLAY=:99 xdotool getwindowgeometry "$_wid" 2>/dev/null | tr '\n' ' ')
        echo "[GUI]   wid=$_wid name='$_wname' $_wgeom"
    done

    # Try to locate the Identities dialog as a named window; fall back to main-window coords.
    DLG_WID=$(DISPLAY=:99 xdotool search --name "Identities" 2>/dev/null | tail -1)
    if [[ -n "$DLG_WID" ]]; then
        echo "[GUI] Found Identities dialog by name: WID=$DLG_WID"
        DLG_GEOM=$(DISPLAY=:99 xdotool getwindowgeometry "$DLG_WID" 2>/dev/null)
        DLG_X=$(echo "$DLG_GEOM" | grep -oP 'Position: \K[0-9]+(?=,)')
        DLG_Y=$(echo "$DLG_GEOM" | grep -oP 'Position: [0-9]+,\K[0-9]+')
        : "${DLG_X:=$WIN_X}" "${DLG_Y:=$WIN_Y}"
        DISPLAY=:99 xdotool windowfocus --sync "$DLG_WID" 2>/dev/null || true
    else
        echo "[GUI] Identities dialog not found by name — using main-window coords"
        DLG_X=$WIN_X; DLG_Y=$WIN_Y
        DISPLAY=:99 xdotool windowfocus --sync "$WID" 2>/dev/null || true
    fi
    sleep 0.3

    # Right-click the "Default" identity entry → context menu confirmed to show Import.
    # Dialog layout (from screenshots): list on left, first entry at ~(70,89) relative.
    RC_X=$(( DLG_X + 70 ))
    RC_Y=$(( DLG_Y + 89 ))
    echo "[GUI] Right-clicking identity entry at ($RC_X,$RC_Y)…"
    DISPLAY=:99 xdotool mousemove "$RC_X" "$RC_Y" 2>/dev/null || true
    sleep 0.2
    DISPLAY=:99 xdotool click 3 2>/dev/null || true
    sleep 0.7
    scrot -d 0 /tmp/ts3_ctx_menu.png 2>/dev/null || true

    # Click "Import" — confirmed 5th item in the context menu.
    # Menu appears near (79,91)–(319,228) relative to dialog origin.
    # "Import" centre ≈ (DLG_X+120, DLG_Y+194).
    IMP_X=$(( DLG_X + 120 ))
    IMP_Y=$(( DLG_Y + 194 ))
    echo "[GUI] Clicking Import at ($IMP_X,$IMP_Y)…"
    DISPLAY=:99 xdotool mousemove "$IMP_X" "$IMP_Y" 2>/dev/null || true
    sleep 0.2
    DISPLAY=:99 xdotool click 1 2>/dev/null || true
    sleep 0.8
    scrot -d 0 /tmp/ts3_file_chooser.png 2>/dev/null || true

    # File chooser dialog: Ctrl+L jumps to the path bar, type full path, confirm.
    echo "[GUI] Entering identity path in file dialog…"
    DISPLAY=:99 xdotool key ctrl+l 2>/dev/null || true
    sleep 0.3
    DISPLAY=:99 xdotool type --clearmodifiers "/identities/identity.ini" 2>/dev/null || true
    sleep 0.3
    DISPLAY=:99 xdotool key Return 2>/dev/null || true
    sleep 0.8
    scrot -d 0 /tmp/ts3_identity_imported.png 2>/dev/null || true

    # Set the imported identity as TS3 default so it is used on every connect.
    # Button layout (confirmed from screenshots, y≈472):
    #   Create≈55  Remove≈152  Default≈252  Go Advanced≈364  OK≈466  Cancel≈553
    DEF_X=$(( DLG_X + 252 ))
    DEF_Y=$(( DLG_Y + 472 ))
    echo "[GUI] Setting imported identity as default at ($DEF_X,$DEF_Y)…"
    DISPLAY=:99 xdotool mousemove "$DEF_X" "$DEF_Y" 2>/dev/null || true
    sleep 0.2
    DISPLAY=:99 xdotool click 1 2>/dev/null || true
    sleep 0.5

    # Close the Identities dialog with OK to persist the changes.
    OK_X=$(( DLG_X + 466 ))
    OK_Y=$(( DLG_Y + 472 ))
    echo "[GUI] Closing Identities dialog with OK at ($OK_X,$OK_Y)…"
    DISPLAY=:99 xdotool mousemove "$OK_X" "$OK_Y" 2>/dev/null || true
    sleep 0.2
    DISPLAY=:99 xdotool click 1 2>/dev/null || true
    sleep 0.5
    scrot -d 0 /tmp/ts3_identity_done.png 2>/dev/null || true

    touch /tmp/ts3_identity_ready
    echo "[GUI] Identity import + default set + dialog closed — ready to connect"
) &

# ── 7f. Continuously redirect TS3 playback to ts3_discard (anti-echo) ────────
# TS3 registers its playback sink-input as application.name="TeamSpeak".
# Without this, incoming server audio plays into virtual_out, which
# virtual_mic monitors — creating an echo loop back to the server.
# Runs every 2 s so newly created sink-inputs (per-user streams) are caught.
# Bug note: pactl outputs "Sink Input #N" — awk must strip the leading # from $3.
(
    set +e
    while kill -0 "$TS3_PID" 2>/dev/null; do
        pactl --server tcp:127.0.0.1:4713 list sink-inputs 2>/dev/null \
        | awk '/^Sink Input #/{ idx=substr($3,2) }
               /application\.name.*TeamSpeak/{ if (idx!="") print idx }' \
        | while IFS= read -r _si; do
            echo "[PA] Routing TS3 sink-input $_si → ts3_discard"
            pactl --server tcp:127.0.0.1:4713 move-sink-input "$_si" ts3_discard 2>/dev/null || true
        done
        sleep 2
    done
) &

# ── 8. Wait for ClientQuery plugin to open port 25639 ───────────────────────
echo "[TS3] Waiting for ClientQuery on :25639 …"
for i in $(seq 1 60); do
    if nc -z 127.0.0.1 25639 2>/dev/null; then
        echo "[TS3] ClientQuery ready!"
        break
    fi
    sleep 1
done

# ── 8b. Bridge loopback ClientQuery to all interfaces via socat ──────────────
# The ClientQuery plugin always binds to 127.0.0.1:25639 regardless of the
# ini config (the Addon_Install_Manager overwrites it on every start).
# socat forwards 0.0.0.0:25640 → 127.0.0.1:25639 so the app container can
# reach the plugin over the Docker bridge network.
socat TCP-LISTEN:25640,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:25639 &
echo "[TS3] socat bridge: 0.0.0.0:25640 → 127.0.0.1:25639"

# ── 9. Keep container alive (follow TS3 process) ────────────────────────────
wait $TS3_PID
EXIT_CODE=$?
echo "[TS3] Client exited with code $EXIT_CODE"

# Clean up
kill $XVFB_PID 2>/dev/null || true
kill $PA_PID 2>/dev/null || true

exit $EXIT_CODE
