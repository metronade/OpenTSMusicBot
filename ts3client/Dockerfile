FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TS3_VERSION=3.6.2
ENV HOME=/home/ts3bot

# ── System dependencies ─────────────────────────────────────────────────────
# Full Qt5/X11/PulseAudio runtime required by ts3client_linux_amd64 3.6.x.
# Derived from: ldd TeamSpeak3-Client-linux_amd64/ts3client_linux_amd64
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    xvfb \
    # PulseAudio
    pulseaudio \
    pulseaudio-utils \
    libpulse0 \
    # Core TS3 / libevent
    libevent-2.1-7 \
    libasound2 \
    libglib2.0-0 \
    # X11 / XCB base
    libx11-6 \
    libxcb1 \
    libxkbcommon-x11-0 \
    libxrender1 \
    libxi6 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxtst6 \
    libxss1 \
    # XCB extensions needed by Qt5 xcb platform plugin (libqxcb.so)
    libxcb-cursor0 \
    libxcb-icccm4 \
    libxcb-image0 \
    libxcb-keysyms1 \
    libxcb-randr0 \
    libxcb-render0 \
    libxcb-render-util0 \
    libxcb-shape0 \
    libxcb-shm0 \
    libxcb-sync1 \
    libxcb-util1 \
    libxcb-xfixes0 \
    libxcb-xinerama0 \
    libxcb-xkb1 \
    # NSS / NSPR (network security)
    libnss3 \
    libnspr4 \
    # DBus / AT-SPI
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    # Pango / Cairo / fonts
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libfontconfig1 \
    libfreetype6 \
    fonts-liberation \
    # Hardware / PCI (libpci.so.3)
    libpci3 \
    # XSLT + atomic + libc++ (LLVM)
    libxslt1.1 \
    libatomic1 \
    libc++1 \
    # OpenGL — software renderer (no GPU in container; Mesa llvmpipe)
    libgl1 \
    libgl1-mesa-dri \
    libegl1 \
    libegl-mesa0 \
    libgles2 \
    # WebP (TS3 image handling)
    libwebp7 \
    libwebpdemux2 \
    # GStreamer (TS3 audio codecs)
    libgstreamer1.0-0 \
    libgstreamer-plugins-base1.0-0 \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-pulseaudio \
    # Utilities used in entrypoint
    sqlite3 \
    netcat-openbsd \
    iputils-ping \
    procps \
    x11-utils \
    # Crash diagnostics
    strace \
    # TCP proxy — bridges 127.0.0.1:25639 (ClientQuery) to 0.0.0.0:25640
    socat \
    # Headless GUI automation (accept TS3 license dialog)
    xdotool \
    # Screenshot utility — captures Xvfb display to /tmp/ts3_license.png
    scrot \
    && rm -rf /var/lib/apt/lists/*

# ── libssl1.1 — focal package (TS3 3.6.x needs 1.1 ABI, Ubuntu 22.04 = 3.x) ─
RUN wget -q \
    "http://security.ubuntu.com/ubuntu/pool/main/o/openssl/libssl1.1_1.1.1f-1ubuntu2_amd64.deb" \
    -O /tmp/libssl1.1.deb \
 && dpkg -i /tmp/libssl1.1.deb \
 && rm /tmp/libssl1.1.deb

# ── libwebp.so.6 compat symlink ───────────────────────────────────────────────
# TS3 3.6.x was built against libwebp.so.6; Ubuntu 22.04 ships libwebp.so.7.
# libwebpdemux.so.2 is already the same soname in both focal and jammy.
# A symlink is safe here: the libwebp public API is stable across 6→7.
RUN ln -sf /usr/lib/x86_64-linux-gnu/libwebp.so.7 \
           /usr/lib/x86_64-linux-gnu/libwebp.so.6

# ── Non-root user ────────────────────────────────────────────────────────────
RUN useradd -m -d "$HOME" -s /bin/bash ts3bot

# ── X11 socket directory ──────────────────────────────────────────────────────
# Xvfb running as a non-root user cannot create /tmp/.X11-unix itself.
# Pre-create it with the sticky bit so the ts3bot user can use it.
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

USER ts3bot
WORKDIR "$HOME"

# ── Download & install TS3 Client ────────────────────────────────────────────
# The .run archive prompts for EULA even with --noexec --target, because the
# EULA check lives in the shell-script header, before the makeself extraction.
# Piping "y" accepts it non-interactively. The installer extracts to
# $HOME/TeamSpeak3-Client-linux_amd64/ by default.
RUN wget -q \
    "https://files.teamspeak-services.com/releases/client/${TS3_VERSION}/TeamSpeak3-Client-linux_amd64-${TS3_VERSION}.run" \
    -O /tmp/ts3client.run \
 && chmod +x /tmp/ts3client.run \
 && echo "y" | /tmp/ts3client.run \
 && rm /tmp/ts3client.run

# ── Verify ALL shared-library dependencies are satisfied ─────────────────────
# Scans the main binary AND every bundled plugin / Qt .so so that the xcb
# platform plugin's own deps are also checked.  Fails the build with the
# full list if anything is missing.
USER root
RUN MISSING=$(find "$HOME/TeamSpeak3-Client-linux_amd64" -name "*.so*" -type f \
              ! -name "*wayland*" \
              -exec ldd {} 2>/dev/null \; \
              | awk '/not found/{print $1}' \
              | sort -u) ; \
    if [ -n "$MISSING" ]; then \
        echo ""; \
        echo "========================================================"; \
        echo " MISSING SHARED LIBRARIES — add these to the Dockerfile:"; \
        echo "========================================================"; \
        echo "$MISSING"; \
        echo "========================================================"; \
        exit 1; \
    fi
USER ts3bot

# ── Diagnostic: show TS3's bundled Qt version ────────────────────────────────
# TS3 ships its Qt libs without version suffixes (libQt5Core.so.5, not .5.x.y)
# so we read the version from the library itself.
RUN echo "=== TS3 Qt libs ===" && \
    ls /home/ts3bot/TeamSpeak3-Client-linux_amd64/libQt5*.so* 2>/dev/null | head -20 || true

# ── Pre-create ClientQuery config dir for the read-only bind mount ───────────
# docker-compose mounts clientquery_plugin.ini (acceptUnknownClients=true)
# as read-only here so the Addon_Install_Manager cannot overwrite it.
# The directory must exist at image build time for Docker to mount a FILE
# (not a directory) at this path.
RUN mkdir -p /home/ts3bot/.ts3client/plugins && \
    chown -R ts3bot:ts3bot /home/ts3bot/.ts3client

# ── Entrypoint ───────────────────────────────────────────────────────────────
USER root
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ClientQuery (25639) and PulseAudio TCP (4713)
EXPOSE 25639 4713

USER ts3bot
ENTRYPOINT ["/entrypoint.sh"]
