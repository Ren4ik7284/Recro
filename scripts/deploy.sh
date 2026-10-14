#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="recroz"
REMOTE_PATH="/var/www/recro"

echo "🚀 [1/4] Сборка фронтенда..."
cd "$DIR/frontend"
npm run build

echo "⚙️ [2/4] Сборка бэкенда (Rust release)..."
cd "$DIR/backend"
cargo build --release
nix-shell -p patchelf --run "patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 target/release/signal-audio-backend" || patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 target/release/signal-audio-backend || true

echo "📤 [3/4] Загрузка файлов на сервер $SERVER..."
# Быстрая передача файлов фронтенда через tar
ssh $SERVER "mkdir -p $REMOTE_PATH/frontend"
tar -C "$DIR/frontend/dist/frontend/browser" -cf - . | ssh $SERVER "tar -C $REMOTE_PATH/frontend -xf -"

# Загрузка бинарника бэкенда с атомарной заменой
scp target/release/signal-audio-backend $SERVER:$REMOTE_PATH/backend/signal-audio-backend.new
ssh $SERVER "chmod +x $REMOTE_PATH/backend/signal-audio-backend.new && systemctl stop recro && mv -f $REMOTE_PATH/backend/signal-audio-backend.new $REMOTE_PATH/backend/signal-audio-backend && systemctl start recro && systemctl status recro --no-pager"

echo "🔄 [4/4] Перезагрузка веб-сервера..."
ssh $SERVER "systemctl reload caddy 2>/dev/null || systemctl reload nginx 2>/dev/null || true"

echo "✅ Деплой на хост успешно завершен! (http://177.3.217.64/#/)"
echo "💡 Для обновления зеркала в РФ без VPN запусти: ./scripts/deploy-vercel.sh"
echo "🌐 Зеркало в РФ (без VPN): https://recro-player.vercel.app/#/"
