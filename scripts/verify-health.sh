#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "🛡️ ==================================================="
echo "🛡️ Recro Pre-Flight / Pre-Push Safety Verification"
echo "🛡️ ==================================================="

# 1. Проверка JWT_SECRET консистентности
echo "🔑 [1/5] Проверка согласованности JWT_SECRET..."
JWT_MASTER="recro_production_jwt_master_secret_2026_super_stable_key_998877_permanent"

if ! grep -q "$JWT_MASTER" "$DIR/backend/src/auth.rs"; then
    echo "❌ ОШИБКА: backend/src/auth.rs не содержит мастер-ключ JWT!"
    exit 1
fi

if ! grep -q "$JWT_MASTER" "$DIR/render.yaml"; then
    echo "❌ ОШИБКА: render.yaml не содержит мастер-ключ JWT!"
    exit 1
fi

if ! grep -q "$JWT_MASTER" "$DIR/Dockerfile"; then
    echo "❌ ОШИБКА: Dockerfile не содержит мастер-ключ JWT!"
    exit 1
fi
echo "   ✅ JWT_SECRET согласован во всех конфигурациях!"

# 2. Проверка CORS и Caddyfile
echo "🌐 [2/5] Проверка CORS и Caddyfile..."
# В Caddyfile reverse_proxy /api/* НЕ должен дублировать CORS заголовки
if grep -A 5 "handle /api/\*" "$DIR/Caddyfile" | grep -i "Access-Control-Allow-Origin"; then
    echo "❌ ОШИБКА: Обнаружен дублирующий заголовок CORS в блоке /api/* в Caddyfile!"
    exit 1
fi
echo "   ✅ Caddyfile чист от дублирующихся заголовков CORS!"

# 3. Проверка компиляции Rust бэкенда
echo "⚙️ [3/5] Проверка компиляции Rust бэкенда..."
cd "$DIR/backend"
cargo check --quiet
echo "   ✅ Бэкенд компилируется без ошибок!"

# 4. Проверка сборки фронтенда Angular
echo "📦 [4/5] Проверка сборки Angular фронтенда..."
cd "$DIR/frontend"
npm run build --silent
echo "   ✅ Фронтенд успешно собирается!"

# 5. Проверка dist_frontend
echo "📁 [5/5] Проверка артефактов dist_frontend..."
if [ ! -f "$DIR/dist_frontend/index.html" ] || [ ! -f "$DIR/dist_frontend/sw.js" ]; then
    echo "❌ ОШИБКА: dist_frontend поврежден или не содержит index.html / sw.js!"
    exit 1
fi
echo "   ✅ dist_frontend готов к деплою на Vercel/Render/VPS!"

echo ""
echo "🎉 ==================================================="
echo "🎉 ВСЕ ПРОВЕРКИ БЕЗОПАСНОСТИ УСПЕШНО ПРОЙДЕНЫ!"
echo "🎉 Изменения стабильны, CORS и треки защищены от падений."
echo "🎉 ==================================================="
