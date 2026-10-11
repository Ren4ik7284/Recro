#!/bin/sh
set -e

mkdir -p /app/data /var/www/recro/cache /var/www/recro/frontend

# Fast Turso Cloud Database snapshot hydration on boot
if [ -n "$TURSO_API_TOKEN" ] && [ -x /usr/local/bin/turso ]; then
    echo "[Turso] Authorizing CLI with Turso cloud..."
    /usr/local/bin/turso config set token "$TURSO_API_TOKEN" 2>/dev/null || true
    echo "[Turso] Exporting cloud snapshot to /app/data/signal.db..."
    /usr/local/bin/turso db export signal-db --output-file /app/data/signal.db --overwrite 2>/dev/null || echo "[Turso] Snapshot export skipped, syncing via Rust runtime."
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
