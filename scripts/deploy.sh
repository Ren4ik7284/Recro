#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${2:-bebragnom89}"
REMOTE_PATH="/var/www/recro"
MODE="${1:-frontend}"

echo "=================================================="
echo "🎵 Recro Deploy: Режим [${MODE}] -> Сервер [${SERVER}]"
echo "=================================================="

# 1. Сборка и деплой фронтенда
if [ "$MODE" = "frontend" ] || [ "$MODE" = "all" ]; then
    echo "📦 [1/3] Сборка фронтенда (Angular 21 + inline chunk loader)..."
    cd "$DIR/frontend"
    npm run build

    echo "📦 [2/3] Упаковка и загрузка фронтенда на сервер $SERVER..."
    TAR_TMP="/tmp/recro-frontend-deploy.tar.gz"
    tar -czf "$TAR_TMP" -C "$DIR/frontend/dist/frontend/browser" .

    echo "📤 Передача файлов на сервер..."
    scp -o ConnectTimeout=10 "$TAR_TMP" "$DIR/Caddyfile" $SERVER:/tmp/
    rm -f "$TAR_TMP"

    echo "⚙️ Распаковка и обновление Caddy..."
    ssh -o ConnectTimeout=10 $SERVER "mkdir -p $REMOTE_PATH/frontend && tar -xzf /tmp/recro-frontend-deploy.tar.gz -C $REMOTE_PATH/frontend && rm -f /tmp/recro-frontend-deploy.tar.gz && mv -f /tmp/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true"
fi

# 2. Сборка и деплой бэкенда
if [ "$MODE" = "backend" ] || [ "$MODE" = "all" ]; then
    echo "⚙️ Сборка Rust бэкенда (release)..."
    cd "$DIR/backend"
    cargo build --release
    nix-shell -p patchelf --run "patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 target/release/signal-audio-backend" 2>/dev/null || patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 target/release/signal-audio-backend 2>/dev/null || true

    echo "📤 Загрузка бинарника бэкенда..."
    scp -o ConnectTimeout=10 target/release/signal-audio-backend $SERVER:$REMOTE_PATH/backend/signal-audio-backend.new
    ssh -o ConnectTimeout=10 $SERVER "chmod +x $REMOTE_PATH/backend/signal-audio-backend.new && systemctl stop recro && mv -f $REMOTE_PATH/backend/signal-audio-backend.new $REMOTE_PATH/backend/signal-audio-backend && systemctl start recro && systemctl status recro --no-pager"
fi

# 3. Деплой зеркала Vercel (опционально)
if [ "$MODE" = "vercel" ]; then
    echo "☁️ Деплой на Vercel..."
    bash "$DIR/scripts/deploy-vercel.sh"
fi

echo ""
echo "=================================================="
echo "✅ ДЕПЛОЙ УСПЕШНО ЗАВЕРШЕН!"
echo "=================================================="
echo "🌐 Основной HTTPS (РФ БЕЗ VPN и с VPN): https://recro.80.87.202.157.sslip.io/#/"
echo "🌐 Прямой HTTP (без зависимости от DNS): http://80.87.202.157/#/"
echo "📱 Скачать APK: https://recro.80.87.202.157.sslip.io/recro.apk"
echo "🍏 Скачать IPA: https://recro.80.87.202.157.sslip.io/recro.ipa"
echo "=================================================="
