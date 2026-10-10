#!/bin/sh
set -e

mkdir -p /app/data /var/www/recro/cache /var/www/recro/frontend

# Run Rust backend in background on port 8085
echo "[Entrypoint] Starting Rust backend on port 8085..."
PORT=8085 /app/signal-audio-backend &

# Run Caddy in foreground on $PORT
echo "[Entrypoint] Starting Caddy reverse proxy on port ${PORT:-10000}..."
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
