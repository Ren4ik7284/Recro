#!/usr/bin/env bash
# Recro — Universal Linux Desktop App Builder (AppImage / Standalone)
# Packages Recro Desktop for all Linux distributions (Arch, Ubuntu, Debian, Fedora, openSUSE, NixOS)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/desktop"
FRONTEND_DIR="$ROOT_DIR/frontend"
OUTPUT_DIR="$FRONTEND_DIR/public"
BUILD_DIR="/tmp/recro-linux-build"

echo "══════════════════════════════════════════════════════"
echo "  🐧 Recro — Universal Linux AppImage Builder"
echo "══════════════════════════════════════════════════════"

mkdir -p "$OUTPUT_DIR"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/AppDir/usr/bin"
mkdir -p "$BUILD_DIR/AppDir/usr/share/icons/hicolor/512x512/apps"
mkdir -p "$BUILD_DIR/AppDir/usr/share/applications"

# 1. Prepare desktop icon & desktop entry
echo "📦 1. Setting up Linux desktop integration..."
cp "$DESKTOP_DIR/assets/icon-512.png" "$BUILD_DIR/AppDir/recro.png"
cp "$DESKTOP_DIR/assets/icon-512.png" "$BUILD_DIR/AppDir/usr/share/icons/hicolor/512x512/apps/recro.png"

cat << 'EOF' > "$BUILD_DIR/AppDir/recro.desktop"
[Desktop Entry]
Name=Recro
GenericName=Music Player
Comment=Modern lossless music and radio streaming player
Exec=recro %U
Icon=recro
Type=Application
Terminal=false
Categories=Audio;AudioVideo;Player;
MimeType=x-scheme-handler/recro;audio/mpeg;audio/flac;audio/ogg;
Keywords=music;player;audio;stream;radio;mpris;flac;lossless;
StartupWMClass=recro
EOF

cp "$BUILD_DIR/AppDir/recro.desktop" "$BUILD_DIR/AppDir/usr/share/applications/recro.desktop"

# 2. Bundle application payload
echo "📦 2. Preparing desktop launcher & MPRIS payload..."
mkdir -p "$BUILD_DIR/AppDir/opt/recro"
cp -r "$DESKTOP_DIR/src" "$BUILD_DIR/AppDir/opt/recro/"
cp -r "$DESKTOP_DIR/assets" "$BUILD_DIR/AppDir/opt/recro/"
cp "$DESKTOP_DIR/package.json" "$BUILD_DIR/AppDir/opt/recro/"

# 3. Create high-compatibility AppRun executable launcher
cat << 'EOF' > "$BUILD_DIR/AppDir/AppRun"
#!/usr/bin/env bash
set -e

APPDIR="$(dirname "$(readlink -f "$0")")"
export APPDIR
export PATH="${APPDIR}/usr/bin:${PATH}"
export LD_LIBRARY_PATH="${APPDIR}/usr/lib:${LD_LIBRARY_PATH:-}"

# Native Wayland & Audio Flags
ELECTRON_ARGS="--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --autoplay-policy=no-user-gesture-required"

# 1. Try system electron if present
if command -v electron &>/dev/null; then
  exec electron $ELECTRON_ARGS "${APPDIR}/opt/recro" "$@"
fi

# 2. Try electron from node_modules if present
if [ -f "${APPDIR}/opt/recro/node_modules/.bin/electron" ]; then
  exec "${APPDIR}/opt/recro/node_modules/.bin/electron" $ELECTRON_ARGS "${APPDIR}/opt/recro" "$@"
fi

# 3. Native webview/browser fallback runner (works on ANY Linux distro without installation)
if command -v chromium &>/dev/null; then
  exec chromium --app="https://recro.online" --class=recro --user-data-dir="${HOME}/.config/recro" "$@"
elif command -v google-chrome &>/dev/null; then
  exec google-chrome --app="https://recro.online" --class=recro --user-data-dir="${HOME}/.config/recro" "$@"
elif command -v brave &>/dev/null; then
  exec brave --app="https://recro.online" --class=recro --user-data-dir="${HOME}/.config/recro" "$@"
elif command -v firefox &>/dev/null; then
  exec firefox --new-window "https://recro.online" "$@"
else
  # Generic opener
  xdg-open "https://recro.online"
fi
EOF

chmod +x "$BUILD_DIR/AppDir/AppRun"

# 4. Create AppImage binary package
echo "📦 3. Packaging universal recro.AppImage..."

APPIMAGE_TARGET="$OUTPUT_DIR/recro.AppImage"
TAR_TEMP="/tmp/recro-appdir.tar.gz"
rm -f "$TAR_TEMP"

tar -czf "$TAR_TEMP" -C "$BUILD_DIR/AppDir" .

cat << 'EOF' > "$APPIMAGE_TARGET"
#!/usr/bin/env bash
# Universal self-mounting Recro Linux AppImage Bundle
set -e

TMP_DIR="$(mktemp -d /tmp/recro-appimage-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

ARCHIVE_LINE=$(awk '/^__ARCHIVE_STARTS_HERE__/ {print NR + 1; exit 0; }' "$0")
tail -n +"$ARCHIVE_LINE" "$0" | tar -xz -C "$TMP_DIR"
chmod +x "$TMP_DIR/AppRun"

"$TMP_DIR/AppRun" "$@"
exit $?
__ARCHIVE_STARTS_HERE__
EOF

cat "$TAR_TEMP" >> "$APPIMAGE_TARGET"
chmod +x "$APPIMAGE_TARGET"
rm -f "$TAR_TEMP"

# Also sync to dist_frontend if it exists
if [ -d "$ROOT_DIR/dist_frontend" ]; then
  cp "$APPIMAGE_TARGET" "$ROOT_DIR/dist_frontend/recro.AppImage"
fi

APP_SIZE=$(du -h "$APPIMAGE_TARGET" | cut -f1)
echo "══════════════════════════════════════════════════════"
echo "  ✓ Successfully built Recro Linux AppImage!"
echo "  📍 File: $APPIMAGE_TARGET ($APP_SIZE)"
echo "══════════════════════════════════════════════════════"
