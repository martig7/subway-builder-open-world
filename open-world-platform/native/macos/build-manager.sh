#!/bin/bash
set -euo pipefail
rid="$1"
output="$2"
repo="$(git rev-parse --show-toplevel)"
version="$(tr -d '\r\n' < "$repo/VERSION")"
stage="$output/stage"
app="$stage/Open World Manager.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
dotnet publish "$repo/open-world-platform/native/src/OpenWorld.MacBackend" -c Release -r "$rid" --self-contained true -p:PublishSingleFile=true -o "$output/backend"
dotnet publish "$repo/open-world-platform/native/src/OpenWorld.TileServer" -c Release -r "$rid" --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=true -o "$output/server"
cp "$output/backend/open-world-manager-backend" "$output/server/open-world-tile-server" "$app/Contents/MacOS/"
if [[ "$rid" == osx-arm64 ]]; then target=arm64-apple-macos13.0; else target=x86_64-apple-macos13.0; fi
swiftc -parse-as-library -swift-version 5 -target "$target" -framework SwiftUI -framework AppKit -framework ServiceManagement "$repo/open-world-platform/native/macos/OpenWorldManager.swift" -o "$app/Contents/MacOS/OpenWorldManager"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Open World Manager</string>
<key>CFBundleDisplayName</key><string>Open World Manager</string>
<key>CFBundleIdentifier</key><string>com.gcm.open-world.manager</string>
<key>CFBundleExecutable</key><string>OpenWorldManager</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>$version</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSHumanReadableCopyright</key><string>Giancarlo Martinelli (gcm)</string>
</dict></plist>
EOF
chmod 755 "$app/Contents/MacOS/"*
# Ad-hoc signing is free. It is not Apple Developer ID signing or notarization.
codesign --force --sign - "$app/Contents/MacOS/open-world-manager-backend"
codesign --force --sign - "$app/Contents/MacOS/open-world-tile-server"
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"
ln -s /Applications "$stage/Applications"
printf 'Drag Open World Manager.app to Applications, then open it and choose your worlds.\n' > "$stage/Install Open World.txt"
hdiutil create -volname 'Install Open World' -srcfolder "$stage" -ov -format UDZO "$output/Open-World-Manager-$rid-v$version.dmg"
hdiutil verify "$output/Open-World-Manager-$rid-v$version.dmg"
