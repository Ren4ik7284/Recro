#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$DIR/frontend/dist/frontend/browser"
DEPLOY_DIR="$DIR/dist_frontend/vercel-deploy"

echo "📦 Сборка фронтенда..."
cd "$DIR/frontend"
npm run build

echo "📦 Подготовка файлов для Vercel..."
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"
cp -r "$DIST_DIR"/* "$DEPLOY_DIR"/

# Привязываем к официальному проекту recro-player
mkdir -p "$DEPLOY_DIR/.vercel"
cat << 'EOF' > "$DEPLOY_DIR/.vercel/project.json"
{
  "projectId": "prj_C6l6dXOeMIfDCk8TWxFhyrqTN8Zr",
  "orgId": "team_SHpRT2P2J98eHqq9rpLLzAW6",
  "projectName": "recro-player"
}
EOF

cat << 'EOF' > "$DEPLOY_DIR/vercel.json"
{
  "version": 2,
  "cleanUrls": false,
  "rewrites": [
    {
      "source": "/api/:match*",
      "destination": "http://80.87.202.157/api/:match*"
    },
    {
      "source": "/cache/:match*",
      "destination": "http://80.87.202.157/cache/:match*"
    },
    {
      "source": "/recro.apk",
      "destination": "/recro.apk"
    },
    {
      "source": "/recro.ipa",
      "destination": "/recro.ipa"
    },
    {
      "source": "/recro.AppImage",
      "destination": "/recro.AppImage"
    },
    {
      "source": "/recro.deb",
      "destination": "/recro.deb"
    },
    {
      "source": "/recro.rpm",
      "destination": "/recro.rpm"
    },
    {
      "source": "/install.sh",
      "destination": "/install.sh"
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
      "source": "/(.*\\.(?:js|css|woff2|svg|png|jpg|webp))",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ]
}
EOF

echo "🚀 Деплой на Vercel (recro-player)..."
cd "$DEPLOY_DIR"
DEPLOY_OUTPUT=$(vercel --prod --yes)
echo "$DEPLOY_OUTPUT"
DEPLOY_URL=$(echo "$DEPLOY_OUTPUT" | grep -Eo "https://[a-zA-Z0-9.-]+\.vercel\.app" | tail -n 1)

if [ -n "$DEPLOY_URL" ]; then
    echo "🔗 Назначение алиаса recro-player.vercel.app -> $DEPLOY_URL..."
    vercel alias set "$DEPLOY_URL" recro-player.vercel.app || true
fi

echo "✅ Готово! Плеер доступен: https://recro-player.vercel.app/#/"
