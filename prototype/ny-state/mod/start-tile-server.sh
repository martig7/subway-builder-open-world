#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
port="${1:-8798}"

if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "Usage: $0 [port]" >&2
  exit 2
fi

if command -v cygpath >/dev/null 2>&1; then
  ps_script="$(cygpath -w "$script_dir/start-tile-server.ps1")"
elif command -v wslpath >/dev/null 2>&1; then
  ps_script="$(wslpath -w "$script_dir/start-tile-server.ps1")"
else
  ps_script="$script_dir/start-tile-server.ps1"
fi

powershell_command=""
for candidate in powershell.exe pwsh.exe powershell pwsh; do
  if command -v "$candidate" >/dev/null 2>&1; then
    powershell_command="$candidate"
    break
  fi
done
if [[ -z "$powershell_command" ]]; then
  echo "A Windows PowerShell executable is required (powershell.exe or pwsh.exe)." >&2
  exit 127
fi

exec "$powershell_command" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$ps_script" -Port "$port"
