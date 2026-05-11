FROM node:20-slim

# Install ffmpeg (system-wide, no .exe needed)
RUN apt-get update && apt-get install -y ffmpeg wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Download yt-dlp Linux binary
RUN wget -q -O /usr/local/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source (exclude ffmpeg/*.exe via .dockerignore)
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
