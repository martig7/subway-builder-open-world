# Manual installation

These instructions are a temporary alternative to the Open World installer. They install Northeast Corridor Open World and run the shared tile server without administrator access. The tile-server window or Terminal process must remain running while an Open World mod is in use.

Download these release assets into one folder:

- `northeast-corridor-open-world-v0.5.0.zip`
- `nec-map-part-01-of-04-v0.5.0.zip` through `nec-map-part-04-of-04-v0.5.0.zip`
- The standalone tile-server ZIP for your operating system
- `tile-server-SHA256SUMS.txt`

The tile server listens only on `127.0.0.1:8799`. Running it without `--tiles` serves every compatible World found in the Subway Builder city-data directory.

## Windows

1. Verify the tile-server ZIP against `tile-server-SHA256SUMS.txt`:

   ```powershell
   Get-FileHash .\open-world-tile-server-windows-x64-v0.5.0.zip -Algorithm SHA256
   ```

2. Create these per-user directories:

   ```powershell
   $gameRoot = Join-Path $env:APPDATA 'metro-maker4'
   $modRoot = Join-Path $gameRoot 'mods\northeast-corridor-open-world'
   $dataRoot = Join-Path $gameRoot 'cities\data'
   $serverRoot = Join-Path $env:LOCALAPPDATA 'Programs\Subway Builder Open World\server'
   New-Item -ItemType Directory -Force -Path $modRoot, $dataRoot, $serverRoot
   ```

3. Extract the mod ZIP into `$modRoot`. Extract all four map-part ZIPs into `$dataRoot`; after extraction, `$dataRoot` should contain directories such as `NEC_CM01_RM01`.

4. Extract `open-world-tile-server-windows-x64-v0.5.0.zip` into `$serverRoot`.

5. Start the server:

   ```powershell
   & (Join-Path $serverRoot 'open-world-tile-server.exe')
   ```

6. Leave that window open, start Subway Builder, and enable Northeast Corridor Open World in the Mods menu. Stop the server with `Ctrl+C`, or run `open-world-tile-server.exe stop` from a second window.

Confirm that the server is ready by opening <http://127.0.0.1:8799/_health>.

## macOS

Subway Builder supports macOS 12 or later on both Apple Silicon and Intel. In Terminal, run `uname -m`: use `macos-arm64` when it prints `arm64`, or `macos-x64` when it prints `x86_64`.

1. Verify the selected ZIP. Replace `ARCH` with `arm64` or `x64`:

   ```bash
   shasum -a 256 "open-world-tile-server-macos-ARCH-v0.5.0.zip"
   ```

   Compare the result with `tile-server-SHA256SUMS.txt`.

2. Set the per-user locations:

   ```bash
   game_root="$HOME/Library/Application Support/metro-maker4"
   mod_root="$game_root/mods/northeast-corridor-open-world"
   data_root="$game_root/cities/data"
   server_root="$HOME/Library/Application Support/Subway Builder Open World/server"
   mkdir -p "$mod_root" "$data_root" "$server_root"
   ```

3. Extract the mod and map files from the directory containing the downloads:

   ```bash
   ditto -x -k "northeast-corridor-open-world-v0.5.0.zip" "$mod_root"
   for archive in nec-map-part-*-of-04-v0.5.0.zip; do
     ditto -x -k "$archive" "$data_root"
   done
   ```

4. Extract the selected server ZIP and make the binary executable:

   ```bash
   ditto -x -k "open-world-tile-server-macos-ARCH-v0.5.0.zip" "$server_root"
   chmod +x "$server_root/open-world-tile-server"
   ```

5. Start the server:

   ```bash
   "$server_root/open-world-tile-server"
   ```

   This initial placeholder is unsigned. If Gatekeeper blocks it, open System Settings > Privacy & Security, review the blocked Open World tile server, and choose **Open Anyway**. Do not disable Gatekeeper globally.

6. Leave Terminal open, start Subway Builder, and enable Northeast Corridor Open World in the Mods menu. Stop the server with `Control-C`, or run `"$server_root/open-world-tile-server" stop` from a second Terminal window.

Confirm that the server is ready by opening <http://127.0.0.1:8799/_health>.

## Updating or removing files

Stop the shared tile server before replacing or removing any World package. Verify that <http://127.0.0.1:8799/_health> no longer responds, then update the mod or map directories. Saved games are separate and should not be deleted.
