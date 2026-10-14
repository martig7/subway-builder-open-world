#!/usr/bin/env bash
set -euo pipefail
rid="${1:?Usage: build-manager.sh linux-x64|linux-arm64 OUTPUT}"
output="${2:?Output directory is required}"
case "$rid" in linux-x64) arch=amd64 ;; linux-arm64) arch=arm64 ;; *) echo 'Unsupported Linux architecture' >&2; exit 1 ;; esac
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
version="$(tr -d '\r\n' < "$repo/VERSION")"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
stage="$output/Open-World-Manager"
test ! -e "$stage" || { echo 'Use a fresh output directory' >&2; exit 1; }
mkdir -p "$stage/app"
node "$repo/open-world-platform/scripts/build-manager-processing.mjs" "$repo/open-world-platform/native/processing" "$rid"
dotnet publish "$repo/open-world-platform/native/src/OpenWorld.LinuxManager" -c Release -r "$rid" --self-contained true -o "$stage/app"
dotnet publish "$repo/open-world-platform/native/src/OpenWorld.TileServer" -c Release -r "$rid" --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=true -o "$output/server"
cp "$output/server/open-world-tile-server" "$stage/app/"
cp -a "$output/server/processing" "$stage/app/"
test -f "$stage/app/processing/node"
test ! -e "$stage/app/processing/node.exe"
chmod 755 "$stage/app/OpenWorldManager" "$stage/app/open-world-tile-server" "$stage/app/processing/node"
cp "$repo/open-world-platform/native/linux/install.sh" "$stage/"
cp "$repo/open-world-platform/native/linux/README.md" "$stage/README.txt"
chmod 755 "$stage/install.sh"
tar -czf "$output/Open-World-Manager-$rid-v$version.tar.gz" -C "$output" Open-World-Manager

# Debian package installs the application only. World data stays per-user.
deb="$output/debian"
mkdir -p "$deb/DEBIAN" "$deb/usr/lib/open-world-manager" "$deb/usr/bin" "$deb/usr/share/applications"
cp -a "$stage/app/." "$deb/usr/lib/open-world-manager/"
cat > "$deb/usr/bin/open-world-manager" <<'EOF'
#!/bin/sh
exec /usr/lib/open-world-manager/OpenWorldManager "$@"
EOF
chmod 755 "$deb/usr/bin/open-world-manager"
cat > "$deb/usr/share/applications/open-world-manager.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Open World Manager
Comment=Install and manage Subway Builder Open World
Exec=open-world-manager
Icon=applications-games
Terminal=false
Categories=Game;Utility;
EOF
cat > "$deb/DEBIAN/control" <<EOF
Package: open-world-manager
Version: $version
Section: games
Priority: optional
Architecture: $arch
Installed-Size: $(du -sk "$deb/usr" | cut -f1)
Maintainer: Giancarlo Martinelli <martig7@users.noreply.github.com>
Depends: libx11-6, libice6, libsm6, libfontconfig1, libicu74 | libicu72 | libicu70, libssl3, zlib1g, libstdc++6, libgcc-s1, libc6 (>= 2.28), ca-certificates, xdg-utils
Homepage: https://github.com/martig7/subway-builder-open-world
Description: Linux installer and manager for Subway Builder Open World
 Includes the native desktop manager, .NET runtime, PMTiles server, and Node
 processing helper. Verified world packages are downloaded separately.
EOF
dpkg-deb --root-owner-group --build "$deb" "$output/Open-World-Manager-v${version}_${arch}.deb"
cd "$output"
sha256sum ./*.deb ./*.tar.gz > SHA256SUMS
