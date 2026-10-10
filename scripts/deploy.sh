#!/usr/bin/env bash
set -e

SERVER="bebragnom89"
REMOTE_PATH="/var/www/recro"

echo "🚀 [1/4] Сборка фронтенда..."
npm run build
node scripts/chunked-loader.mjs

echo "⚙️ [2/4] Сборка бэкенда (Rust release)..."
cd "../backend"
cargo build --release
nix-shell -p patchelf --run "patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 target/release/signal-audio-backend" 2>/dev/null || true

echo "📤 [3/4] Загрузка файлов на сервер $SERVER..."
# Быстрая передача файлов фронтенда через tar
ssh $SERVER "mkdir -p $REMOTE_PATH/frontend"
tar -C ../frontend/dist/frontend/browser -cf - . | ssh $SERVER "tar -C $REMOTE_PATH/frontend -xf -"

# Загрузка бинарника бэкенда с атомарной заменой
scp target/release/signal-audio-backend $SERVER:$REMOTE_PATH/backend/signal-audio-backend.new
ssh $SERVER "chmod +x $REMOTE_PATH/backend/signal-audio-backend.new && systemctl stop recro && mv -f $REMOTE_PATH/backend/signal-audio-backend.new $REMOTE_PATH/backend/signal-audio-backend && systemctl start recro && systemctl status recro --no-pager"

echo "🔄 [4/4] Перезагрузка Nginx..."
ssh $SERVER "systemctl reload nginx"

echo "✅ Деплой успешно завершен! Плеер доступен на http://80.87.202.157/#/"
