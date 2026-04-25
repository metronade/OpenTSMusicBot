FROM node:20-slim

WORKDIR /app

# ── System tools ─────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    ffmpeg \
    git \
    python3 \
    python3-pip \
    pulseaudio-utils \
 && rm -rf /var/lib/apt/lists/*

# ── Piper TTS (binary + German voice models) ──────────────────────────────────
ARG PIPER_VERSION=2023.11.14-2
RUN wget -q "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
    -O /tmp/piper.tar.gz \
 && tar -xzf /tmp/piper.tar.gz -C /usr/local \
 && echo "/usr/local/piper" > /etc/ld.so.conf.d/piper.conf \
 && ldconfig \
 && rm /tmp/piper.tar.gz

RUN mkdir -p /app/piper-voices \
 && HF="https://huggingface.co/rhasspy/piper-voices/resolve/main" \
 && wget -q "$HF/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx"      -O /app/piper-voices/de_DE-thorsten-medium.onnx \
 && wget -q "$HF/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx.json" -O /app/piper-voices/de_DE-thorsten-medium.onnx.json \
 && wget -q "$HF/de/de_DE/kerstin/low/de_DE-kerstin-low.onnx"              -O /app/piper-voices/de_DE-kerstin-low.onnx \
 && wget -q "$HF/de/de_DE/kerstin/low/de_DE-kerstin-low.onnx.json"         -O /app/piper-voices/de_DE-kerstin-low.onnx.json \
 && wget -q "$HF/de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx"      -O /app/piper-voices/de_DE-thorsten_emotional-medium.onnx \
 && wget -q "$HF/de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx.json" -O /app/piper-voices/de_DE-thorsten_emotional-medium.onnx.json \
 && wget -q "$HF/en/en_GB/alba/medium/en_GB-alba-medium.onnx"      -O /app/piper-voices/en_GB-alba-medium.onnx \
 && wget -q "$HF/en/en_GB/alba/medium/en_GB-alba-medium.onnx.json" -O /app/piper-voices/en_GB-alba-medium.onnx.json \
 && wget -q "$HF/en/en_GB/cori/medium/en_GB-cori-medium.onnx"      -O /app/piper-voices/en_GB-cori-medium.onnx \
 && wget -q "$HF/en/en_GB/cori/medium/en_GB-cori-medium.onnx.json" -O /app/piper-voices/en_GB-cori-medium.onnx.json \
 && wget -q "$HF/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx"      -O /app/piper-voices/en_GB-northern_english_male-medium.onnx \
 && wget -q "$HF/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx.json" -O /app/piper-voices/en_GB-northern_english_male-medium.onnx.json

# ── yt-dlp via pip (enables automatic plugin discovery) ──────────────────────
# bgutil-ytdlp-pot-provider generates PO Tokens so YouTube works on server IPs
# without needing cookies. YTDLP_DATE busts the layer cache on demand.
ARG YTDLP_DATE=2025-04-20
RUN pip3 install --break-system-packages yt-dlp bgutil-ytdlp-pot-provider

# Clone and build the bgutil server scripts (needed by the pot provider)
RUN git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider \
      /root/bgutil-ytdlp-pot-provider \
 && cd /root/bgutil-ytdlp-pot-provider/server \
 && npm install \
 && node_modules/.bin/tsc --project tsconfig.json \
 && npm prune --omit=dev

# ── Node dependencies ─────────────────────────────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── Application source ────────────────────────────────────────────────────────
COPY . .

# Ensure runtime directories exist
RUN mkdir -p /app/music /app/config /app/identities

EXPOSE 3000
CMD ["node", "server.js"]
