#!/bin/sh
set -e

mkdir -p /app/data /var/www/recro/cache /var/www/recro/frontend

# Cloud Persistence (Litestream with Cloudflare R2 / S3 / Supabase)
LITESTREAM_PID=""
if [ -n "$LITESTREAM_BUCKET" ] || [ -n "$LITESTREAM_REPLICA_URL" ]; then
    REPLICA_URL="${LITESTREAM_REPLICA_URL:-s3://${LITESTREAM_BUCKET}/signal.db}"
    echo "[Litestream] Cloud persistence enabled: $REPLICA_URL"
    echo "[Litestream] Restoring database from cloud snapshot if exists..."
    litestream restore -if-replica-exists "$REPLICA_URL" /app/data/signal.db || echo "[Litestream] Starting fresh database (no previous snapshot found)."
    echo "[Litestream] Launching continuous real-time cloud replication..."
    litestream replicate /app/data/signal.db "$REPLICA_URL" &
    LITESTREAM_PID=$!
fi

# Run Rust backend in background on port 8085
echo "[Entrypoint] Starting Rust backend on port 8085..."
PORT=8085 /app/signal-audio-backend &
BACKEND_PID=$!

# Ensure backend started properly and didn't crash on initialization
sleep 1
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "[Entrypoint] FATAL: Rust backend exited immediately!"
    wait "$BACKEND_PID"
    exit 1
fi
echo "[Entrypoint] Rust backend running successfully (PID $BACKEND_PID)."

# Monitor backend in background - if it crashes, terminate container so Render alerts/restarts
(
    wait "$BACKEND_PID"
    EXIT_STATUS=$?
    echo "[Entrypoint] WARNING: Rust backend exited with code $EXIT_STATUS!"
    kill -TERM 1 2>/dev/null || exit 1
) &

# Run Caddy in foreground on $PORT
echo "[Entrypoint] Starting Caddy reverse proxy on port ${PORT:-10000}..."
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
