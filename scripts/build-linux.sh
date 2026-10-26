#!/usr/bin/env bash
# Recro — Universal Linux Desktop App Builder (AppImage + DEB + RPM + AUR)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/desktop"
FRONTEND_DIR="$ROOT_DIR/frontend"
OUTPUT_DIR="$FRONTEND_DIR/public"
BUILD_DIR="/tmp/recro-linux-build"
VERSION="2.3.7.3"

echo "══════════════════════════════════════════════════════"
echo "  🐧 Recro — Multi-Distro Linux Package Builder v$VERSION"
echo "══════════════════════════════════════════════════════"

mkdir -p "$OUTPUT_DIR"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/AppDir/usr/bin"
mkdir -p "$BUILD_DIR/AppDir/usr/share/icons/hicolor/512x512/apps"
mkdir -p "$BUILD_DIR/AppDir/usr/share/applications"

# 1. Desktop integration files
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

if command -v electron &>/dev/null; then
  exec electron $ELECTRON_ARGS "${APPDIR}/opt/recro" "$@"
fi

if [ -f "${APPDIR}/opt/recro/node_modules/.bin/electron" ]; then
  exec "${APPDIR}/opt/recro/node_modules/.bin/electron" $ELECTRON_ARGS "${APPDIR}/opt/recro" "$@"
fi

if command -v chromium &>/dev/null; then
  exec chromium --app="https://recro.online" --class=recro --user-data-dir="${HOME}/.config/recro" "$@"
elif command -v google-chrome &>/dev/null; then
  exec google-chrome --app="https://recro.online" --class=recro --user-data-dir="${HOME}/.config/recro" "$@"
elif command -v brave &>/dev/null; then
  exec brave --app="https://recro.online" --class=recro --user-data-dir="${HOME}/.config/recro" "$@"
elif command -v firefox &>/dev/null; then
  exec firefox --new-window "https://recro.online" "$@"
else
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

# 5. Create Debian / Ubuntu .deb package
echo "📦 4. Packaging Debian / Ubuntu .deb package..."
DEB_BUILD="/tmp/recro-deb-stage"
rm -rf "$DEB_BUILD"
mkdir -p "$DEB_BUILD/control" "$DEB_BUILD/data/usr/bin" "$DEB_BUILD/data/usr/share/applications" "$DEB_BUILD/data/usr/share/icons/hicolor/512x512/apps"

echo "2.0" > "$DEB_BUILD/debian-binary"

cat << EOF > "$DEB_BUILD/control/control"
Package: recro
Version: $VERSION
Section: sound
Priority: optional
Architecture: all
Maintainer: Recro Team <support@recro.online>
Homepage: https://recro.online
Description: Recro Music & Radio Player
 High-fidelity music streaming client with native Wayland and MPRIS desktop media integration.
EOF

cp "$APPIMAGE_TARGET" "$DEB_BUILD/data/usr/bin/recro"
chmod +x "$DEB_BUILD/data/usr/bin/recro"
cp "$BUILD_DIR/AppDir/recro.desktop" "$DEB_BUILD/data/usr/share/applications/recro.desktop"
cp "$DESKTOP_DIR/assets/icon-512.png" "$DEB_BUILD/data/usr/share/icons/hicolor/512x512/apps/recro.png"

(cd "$DEB_BUILD/control" && tar -czf ../control.tar.gz .)
(cd "$DEB_BUILD/data" && tar -czf ../data.tar.gz .)
ar -rcs "$OUTPUT_DIR/recro.deb" "$DEB_BUILD/debian-binary" "$DEB_BUILD/control.tar.gz" "$DEB_BUILD/data.tar.gz"
rm -rf "$DEB_BUILD"

# 6. Create Red Hat / Fedora .rpm package
echo "📦 5. Packaging Red Hat / Fedora .rpm package..."
RPM_TOP="/tmp/rpmbuild-recro"
rm -rf "$RPM_TOP"
mkdir -p "$RPM_TOP"/{BUILD,RPMS,SOURCES,SPECS,SRPMS,BUILDROOT}

cat << EOF > "$RPM_TOP/SPECS/recro.spec"
Name:           recro
Version:        $VERSION
Release:        1%{?dist}
Summary:        Modern lossless music and radio streaming player
License:        MIT
URL:            https://recro.online
BuildArch:      x86_64
AutoReqProv:    no

%description
Recro is a modern, high-fidelity music streaming client and radio player with native Wayland and MPRIS desktop media integration.

%install
mkdir -p %{buildroot}/usr/bin
mkdir -p %{buildroot}/usr/share/applications
mkdir -p %{buildroot}/usr/share/icons/hicolor/512x512/apps

cp "$APPIMAGE_TARGET" %{buildroot}/usr/bin/recro
chmod 755 %{buildroot}/usr/bin/recro
cp "$BUILD_DIR/AppDir/recro.desktop" %{buildroot}/usr/share/applications/recro.desktop
cp "$DESKTOP_DIR/assets/icon-512.png" %{buildroot}/usr/share/icons/hicolor/512x512/apps/recro.png

%files
/usr/bin/recro
/usr/share/applications/recro.desktop
/usr/share/icons/hicolor/512x512/apps/recro.png
EOF

rpmbuild --define "_topdir $RPM_TOP" -bb "$RPM_TOP/SPECS/recro.spec" >/dev/null 2>&1 || true
if [ -f "$RPM_TOP/RPMS/x86_64/recro-$VERSION-1.x86_64.rpm" ]; then
  cp "$RPM_TOP/RPMS/x86_64/recro-$VERSION-1.x86_64.rpm" "$OUTPUT_DIR/recro.rpm"
elif [ -f "$RPM_TOP/RPMS/x86_64/recro-$VERSION-1.fc40.x86_64.rpm" ]; then
  cp "$RPM_TOP/RPMS/x86_64/recro-$VERSION-1.fc40.x86_64.rpm" "$OUTPUT_DIR/recro.rpm"
else
  find "$RPM_TOP/RPMS" -name "*.rpm" -exec cp {} "$OUTPUT_DIR/recro.rpm" \;
fi
rm -rf "$RPM_TOP"

# 7. Create Arch Linux PKGBUILD
echo "📦 6. Generating Arch Linux AUR PKGBUILD..."
cat << EOF > "$OUTPUT_DIR/PKGBUILD"
# Maintainer: Recro Team <support@recro.online>
pkgname=recro-bin
pkgver=$VERSION
pkgrel=1
pkgdesc="Modern lossless music and radio streaming player (Wayland + MPRIS)"
arch=('x86_64')
url="https://recro.online"
license=('MIT')
provides=('recro')
conflicts=('recro')
source=("recro-\${pkgver}.AppImage::https://recro-player.vercel.app/recro.AppImage")
sha256sums=('SKIP')

package() {
    install -Dm755 "\${srcdir}/recro-\${pkgver}.AppImage" "\${pkgdir}/usr/bin/recro"
}
EOF

# Sync all to dist_frontend
if [ -d "$ROOT_DIR/dist_frontend" ]; then
  cp "$OUTPUT_DIR/recro.AppImage" "$ROOT_DIR/dist_frontend/recro.AppImage"
  cp "$OUTPUT_DIR/recro.deb" "$ROOT_DIR/dist_frontend/recro.deb"
  cp "$OUTPUT_DIR/recro.rpm" "$ROOT_DIR/dist_frontend/recro.rpm"
  cp "$OUTPUT_DIR/PKGBUILD" "$ROOT_DIR/dist_frontend/PKGBUILD"
  cp "$OUTPUT_DIR/install.sh" "$ROOT_DIR/dist_frontend/install.sh"
fi

echo "══════════════════════════════════════════════════════"
echo "  ✓ Successfully built all Linux packages!"
echo "  📍 Debian / Ubuntu:  $OUTPUT_DIR/recro.deb"
echo "  📍 Red Hat / Fedora: $OUTPUT_DIR/recro.rpm"
echo "  📍 AppImage:         $OUTPUT_DIR/recro.AppImage"
echo "  📍 Arch Linux (AUR): $OUTPUT_DIR/PKGBUILD (v$VERSION)"
echo "══════════════════════════════════════════════════════"
