#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-frontend}"
TARGET_SERVER="$2"

REMOTE_PATH="/var/www/recro"

if [ -n "$TARGET_SERVER" ]; then
    SERVERS=("$TARGET_SERVER")
else
    # По умолчанию деплоим на оба сервера: Москва (РФ без VPN) и Франкфурт (С VPN и мир)
    SERVERS=("bebragnom89" "recroz")
fi

echo "=================================================="
echo "🎵 Recro Deploy: Режим [${MODE}] -> Серверы [${SERVERS[*]}]"
echo "=================================================="

# 1. Сборка и деплой фронтенда
if [ "$MODE" = "frontend" ] || [ "$MODE" = "all" ]; then
    echo "📦 [1/2] Сборка фронтенда (Angular 21 + inline chunk loader)..."
    cd "$DIR/frontend"
    npm run build

    echo "📦 [2/2] Синхронизация dist_frontend и упаковка..."
    mkdir -p "$DIR/dist_frontend"
    cp -rf "$DIR/frontend/dist/frontend/browser/"* "$DIR/dist_frontend/"
    TAR_TMP="/tmp/recro-frontend-deploy.tar.gz"
    tar -czf "$TAR_TMP" -C "$DIR/frontend/dist/frontend/browser" .

    for SVR in "${SERVERS[@]}"; do
        echo "📤 Загрузка на сервер $SVR..."
        if scp -o ConnectTimeout=8 "$TAR_TMP" $SVR:/tmp/recro-frontend-deploy.tar.gz; then
            # Если это bebragnom89, синхронизируем Caddyfile
            if [ "$SVR" = "bebragnom89" ]; then
                scp -o ConnectTimeout=8 "$DIR/Caddyfile" $SVR:/tmp/Caddyfile 2>/dev/null || true
                ssh -o ConnectTimeout=8 $SVR "mkdir -p $REMOTE_PATH/frontend && tar -xzf /tmp/recro-frontend-deploy.tar.gz -C $REMOTE_PATH/frontend && rm -f /tmp/recro-frontend-deploy.tar.gz && mv -f /tmp/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true"
            else
                ssh -o ConnectTimeout=8 $SVR "mkdir -p $REMOTE_PATH/frontend && tar -xzf /tmp/recro-frontend-deploy.tar.gz -C $REMOTE_PATH/frontend && rm -f /tmp/recro-frontend-deploy.tar.gz && systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true"
            fi
            echo "✅ Сервер $SVR успешно обновлен!"
        else
            echo "⚠️ Сервер $SVR временно недоступен по SSH (тайм-аут), пропускаем..."
        fi
    done
    rm -f "$TAR_TMP"
fi

# 2. Сборка и деплой бэкенда
if [ "$MODE" = "backend" ] || [ "$MODE" = "all" ]; then
    echo "⚙️ Сборка Rust бэкенда (release)..."
    cd "$DIR/backend"
    cargo build --release
    nix-shell -p patchelf --run "patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 target/release/signal-audio-backend" 2>/dev/null || patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 target/release/signal-audio-backend 2>/dev/null || true

    for SVR in "${SERVERS[@]}"; do
        echo "📤 Загрузка бинарника бэкенда на $SVR..."
        if scp -o ConnectTimeout=8 target/release/signal-audio-backend $SVR:$REMOTE_PATH/backend/signal-audio-backend.new; then
            if [ "$SVR" = "bebragnom89" ]; then
                scp -o ConnectTimeout=8 "$DIR/Caddyfile" $SVR:/tmp/Caddyfile 2>/dev/null || true
                ssh -o ConnectTimeout=10 $SVR "chmod +x $REMOTE_PATH/backend/signal-audio-backend.new && mv -f /tmp/Caddyfile /etc/caddy/Caddyfile 2>/dev/null || true && systemctl reload caddy 2>/dev/null || true && systemctl stop recro && mv -f $REMOTE_PATH/backend/signal-audio-backend.new $REMOTE_PATH/backend/signal-audio-backend && systemctl start recro && systemctl status recro --no-pager"
            else
                ssh -o ConnectTimeout=10 $SVR "chmod +x $REMOTE_PATH/backend/signal-audio-backend.new && systemctl stop recro && mv -f $REMOTE_PATH/backend/signal-audio-backend.new $REMOTE_PATH/backend/signal-audio-backend && systemctl start recro && systemctl status recro --no-pager"
            fi
            echo "✅ Бэкенд на $SVR перезапущен!"
        else
            echo "⚠️ Сервер $SVR временно недоступен по SSH (тайм-аут), пропускаем..."
        fi
    done
fi

# Smoke-test CORS and health on bebragnom89
if curl -s -I "http://80.87.202.157/api/health" | grep -q "Access-Control-Allow-Origin"; then
    DUP_COUNT=$(curl -s -I "http://80.87.202.157/api/health" | grep -ci "Access-Control-Allow-Origin" || true)
    if [ "$DUP_COUNT" -gt 1 ]; then
        echo "⚠️ ВНИМАНИЕ: Обнаружены дубликаты CORS заголовков ($DUP_COUNT)!"
    else
        echo "✅ Smoke-test успешен: CORS заголовок корректен и уникален."
    fi
fi

# 3. Деплой зеркала Vercel
if [ "$MODE" = "vercel" ] || [ "$MODE" = "all" ] || [ "$MODE" = "frontend" ]; then
    echo "☁️ Деплой на Vercel..."
    bash "$DIR/scripts/deploy-vercel.sh"
fi

echo ""
echo "=================================================="
echo "✅ ДЕПЛОЙ УСПЕШНО ЗАВЕРШЕН!"
echo "=================================================="
echo "🌐 Прямые хосты (VPS):"
echo "   👉 http://80.87.202.157/#/ (Москва, РФ без VPN)"
echo "   👉 http://177.3.217.64/#/ (Франкфурт)"
echo ""
echo "☁️ Облачное зеркало (Vercel):"
echo "   👉 https://recro-player.vercel.app/#/"
echo "=================================================="
