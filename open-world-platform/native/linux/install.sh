#!/usr/bin/env bash
# Per-user portable application installation. It does not install world data.
set -euo pipefail
case "${1:-}" in ''|--no-launch) ;; *) echo 'Usage: install.sh [--no-launch]' >&2; exit 1 ;; esac
test "$(id -u)" != 0 || { echo 'Run this installer as your desktop user, without sudo.' >&2; exit 1; }
source_dir="$(cd "$(dirname "$0")" && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
case "$data" in /*) ;; *) data="$HOME/.local/share" ;; esac
destination="$data/open-world-manager/app"
# Reject symlinks in every existing ancestor before copying application files.
path="$destination"
while [ "$path" != / ]; do
  test ! -L "$path" || { echo "Installation path is a symbolic link: $path" >&2; exit 1; }
  path="$(dirname "$path")"
done
test -x "$source_dir/app/OpenWorldManager"
"$source_dir/app/OpenWorldManager" --catalog > /dev/null
mkdir -p "$data/open-world-manager"
# Refuse replacement of a running manager; the .NET lock is enforced on Linux.
test ! -L "$data/open-world-manager/manager.lock" || { echo 'The manager lock is a symbolic link.' >&2; exit 1; }
exec 9> "$data/open-world-manager/manager.lock"
flock -n 9 || { echo 'Quit the existing manager before installing an update.' >&2; exit 1; }
stage="$(mktemp -d "$data/open-world-manager/.app-install.XXXXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
cp -a "$source_dir/app/." "$stage/"
if [ -e "$destination" ]; then
  test -d "$destination" && test ! -e "$destination.previous" && test ! -L "$destination.previous" || { echo 'Resolve the previous application backup before updating.' >&2; exit 1; }
  # Stop the authenticated old service before its executable is renamed.
  # Linux /proc reports renamed/deleted executables differently after replacement.
  "$source_dir/app/open-world-tile-server" stop --state-root "$data/metro-maker4/open-world-pmtiles"
  mv -- "$destination" "$destination.previous"
fi
mv -- "$stage" "$destination"
stage=""
"$destination/OpenWorldManager" --register-desktop
# Keep the previous app as a recoverable backup. No game files are removed.
flock -u 9
echo "Installed Open World Manager at $destination"
if [ "${1:-}" != --no-launch ]; then exec "$destination/OpenWorldManager"; fi
