#!/usr/bin/env bash
# Recro — One-line automated Linux installer
set -euo pipefail

echo "══════════════════════════════════════════════════════"
echo "  🎵 Установка плеера Recro в систему..."
echo "══════════════════════════════════════════════════════"

BASE_URL="https://recro-player.vercel.app"
BIN_DIR="${HOME}/.local/bin"
APP_DIR="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons/hicolor/512x512/apps"

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"

echo "📥 [1/3] Загрузка исполняемого файла Recro..."
curl -sSL "${BASE_URL}/recro.AppImage" -o "${BIN_DIR}/recro"
chmod +x "${BIN_DIR}/recro"

echo "🎨 [2/3] Загрузка иконки..."
curl -sSL "${BASE_URL}/icons/icon-512.png" -o "${ICON_DIR}/recro.png"

echo "🚀 [3/3] Создание системного ярлыка в меню..."
cat << EOF > "${APP_DIR}/recro.desktop"
[Desktop Entry]
Name=Recro
GenericName=Music Player
Comment=Modern lossless music and radio streaming player
Exec=${BIN_DIR}/recro %U
Icon=recro
Type=Application
Terminal=false
Categories=Audio;AudioVideo;Player;
MimeType=x-scheme-handler/recro;audio/mpeg;audio/flac;audio/ogg;
Keywords=music;player;audio;stream;radio;mpris;
StartupWMClass=recro
EOF

if command -v update-desktop-database &>/dev/null; then
  update-desktop-database "${APP_DIR}" 2>/dev/null || true
fi

echo "══════════════════════════════════════════════════════"
echo "  ✅ Recro успешно установлен!"
echo "  🎉 Ярлык добавлен в меню ваших приложений."
echo "  ▶️  Команда для запуска из терминала: recro"
echo "══════════════════════════════════════════════════════"

# Запуск в фоновом режиме
"${BIN_DIR}/recro" & disown
