#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$DIR/frontend/dist/frontend/browser"
DEPLOY_DIR="$DIR/dist_frontend/vercel-deploy"

echo "📦 Подготовка файлов для Vercel..."
mkdir -p "$DEPLOY_DIR"
cp -r "$DIST_DIR"/* "$DEPLOY_DIR"/

cat << 'EOF' > "$DEPLOY_DIR/vercel.json"
{
  "version": 2,
  "cleanUrls": false,
  "rewrites": [
    {
      "source": "/api/:match*",
      "destination": "http://177.3.217.64/api/:match*"
    },
    {
      "source": "/cache/:match*",
      "destination": "http://177.3.217.64/cache/:match*"
    },
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ],
  "headers": [
    {
      "source": "/(index.html|sw.js)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "no-cache, no-store, must-revalidate"
        }
      ]
    },
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Access-Control-Allow-Origin",
          "value": "*"
        },
        {
          "key": "Access-Control-Allow-Methods",
          "value": "GET, POST, OPTIONS, PUT, DELETE"
        },
        {
          "key": "Access-Control-Allow-Headers",
          "value": "*"
        }
      ]
    }
  ]
}
EOF

echo "🚀 Деплой на Vercel..."
vercel "$DEPLOY_DIR" --prod --yes
vercel alias set vercel-deploy-two-sigma-75.vercel.app recro-player.vercel.app || true

echo "✅ Готово! Плеер доступен: https://recro-player.vercel.app/#/"
