# Multi-stage Dockerfile for Recro (Fullstack Web Audio Player)
# Stage 1: Build Angular Frontend
FROM node:20-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --legacy-peer-deps
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Rust Axum Backend
FROM rust:1.85-slim-bookworm AS backend-builder
WORKDIR /app/backend
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY backend/ ./
ENV CARGO_BUILD_JOBS=2
RUN cargo build --release

# Stage 3: Minimal Production Runtime
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && curl -sL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy \
    && chmod +x /usr/local/bin/caddy \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mkdir -p /var/www/recro/frontend /var/www/recro/cache /app/data

# Copy built frontend
COPY --from=frontend-builder /app/frontend/dist/frontend/browser /var/www/recro/frontend

# Copy built backend binary
COPY --from=backend-builder /app/backend/target/release/signal-audio-backend /app/signal-audio-backend

# Copy Caddyfile and entrypoint
COPY Caddyfile /etc/caddy/Caddyfile
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENV PORT=10000
ENV BACKEND_PORT=8085
ENV DATABASE_URL="sqlite:///app/data/signal.db?mode=rwc"
ENV CACHE_DIR="/var/www/recro/cache"

EXPOSE 10000

CMD ["/app/docker-entrypoint.sh"]
