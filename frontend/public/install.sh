#!/usr/bin/env bash
# Recro — Universal One-Line Installer for Any Linux (Ubuntu, Fedora, Arch, NixOS, Mint, etc.)
set -euo pipefail

echo "══════════════════════════════════════════════════════"
echo "  🎵 Установка плеера Recro в систему..."
echo "══════════════════════════════════════════════════════"

BASE_URL="https://recro-player.vercel.app"
BIN_DIR="${HOME}/.local/bin"
APP_DIR="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons/hicolor/512x512/apps"
PIX_DIR="${HOME}/.local/share/pixmaps"
USER_ICONS="${HOME}/.icons"

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR" "$PIX_DIR" "$USER_ICONS"

echo "📥 [1/3] Загрузка исполняемого файла Recro..."
# Check if NixOS
IS_NIXOS=0
if [ -f /etc/NIXOS ] || grep -qi nixos /etc/os-release 2>/dev/null; then
  IS_NIXOS=1
fi

cat << 'EOF' > "${BIN_DIR}/recro"
#!/usr/bin/env bash
TARGET_URL="https://recro-player.vercel.app/#/"

if command -v chromium &>/dev/null; then
  exec chromium --app="${TARGET_URL}" --class=recro --user-data-dir="${HOME}/.config/recro" "$@"
elif command -v google-chrome &>/dev/null; then
  exec google-chrome --app="${TARGET_URL}" --class=recro --user-data-dir="${HOME}/.config/recro" "$@"
elif command -v brave &>/dev/null; then
  exec brave --app="${TARGET_URL}" --class=recro --user-data-dir="${HOME}/.config/recro" "$@"
elif command -v appimage-run &>/dev/null && [ -f "${HOME}/.local/share/recro/recro.AppImage" ]; then
  exec appimage-run "${HOME}/.local/share/recro/recro.AppImage" "$@"
elif command -v electron &>/dev/null; then
  exec electron --ozone-platform-hint=auto "${TARGET_URL}" "$@"
elif command -v firefox &>/dev/null; then
  exec firefox --new-window "${TARGET_URL}" "$@"
else
  xdg-open "${TARGET_URL}"
fi
EOF
chmod +x "${BIN_DIR}/recro"

# Also download AppImage bundle as fallback
mkdir -p "${HOME}/.local/share/recro"
curl -sSL "${BASE_URL}/recro.AppImage" -o "${HOME}/.local/share/recro/recro.AppImage" 2>/dev/null || true
chmod +x "${HOME}/.local/share/recro/recro.AppImage" 2>/dev/null || true

echo "🎨 [2/3] Загрузка иконки приложения..."
curl -sSL "${BASE_URL}/icons/icon-512.png" -o "${ICON_DIR}/recro.png" 2>/dev/null || true
cp "${ICON_DIR}/recro.png" "${PIX_DIR}/recro.png" 2>/dev/null || true
cp "${ICON_DIR}/recro.png" "${USER_ICONS}/recro.png" 2>/dev/null || true

echo "🚀 [3/3] Создание системного ярлыка в меню приложений..."
cat << EOF > "${APP_DIR}/recro.desktop"
[Desktop Entry]
Name=Recro
GenericName=Music Player
Comment=Modern lossless music and radio streaming player
Exec=${BIN_DIR}/recro %U
Icon=${ICON_DIR}/recro.png
Type=Application
Terminal=false
Categories=Audio;AudioVideo;Player;
MimeType=x-scheme-handler/recro;audio/mpeg;audio/flac;audio/ogg;
Keywords=music;player;audio;stream;radio;mpris;flac;lossless;
StartupWMClass=recro
EOF

if command -v update-desktop-database &>/dev/null; then
  update-desktop-database "${APP_DIR}" 2>/dev/null || true
fi

echo "══════════════════════════════════════════════════════"
echo "  ✅ Recro успешно установлен!"
echo "  🎉 Ярлык добавлен в меню ваших приложений (Rofi/GNOME/KDE)."
echo "  ▶️  Команда для запуска из терминала: recro"
echo "══════════════════════════════════════════════════════"

# Запуск в фоновом режиме
"${BIN_DIR}/recro" & disown
