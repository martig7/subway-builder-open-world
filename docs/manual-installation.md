# Manual installation

Install Northeast Corridor Open World by copying the downloaded files into Subway Builder's folders, then opening the tile server.

## Download

Download these files from the v0.5.0 release:

- `northeast-corridor-open-world-v0.5.0.zip`
- All four map ZIPs: `nec-map-part-01-of-04-v0.5.0.zip` through `nec-map-part-04-of-04-v0.5.0.zip`
- One tile-server ZIP for your computer:
  - Windows: `open-world-tile-server-windows-x64-v0.5.0.zip`
  - Mac with Apple silicon: `open-world-tile-server-macos-arm64-v0.5.0.zip`
  - Mac with an Intel processor: `open-world-tile-server-macos-x64-v0.5.0.zip`

On Mac, Apple menu > About This Mac shows either an Apple chip or an Intel processor.

## Open the game folders

1. In Subway Builder, open the mod manager and click **Open Mods Folder**.
2. Go up one folder level to reach **metro-maker4**. Use the parent-folder control, not the browser-style Back button.
3. Keep this folder open, then close Subway Builder and any Open World tile-server window before copying files. If Open World Manager is running a server, click **Stop** there first.

## Copy the mod and maps

1. Extract each downloaded ZIP. On Windows, right-click it and choose **Extract All**. On Mac, double-click it.
2. Inside `metro-maker4`, open `mods` and create a folder named `northeast-corridor-open-world` if it does not already exist.
3. Copy the contents of the extracted mod ZIP into that folder. `manifest.json` and `index.js` should sit directly inside `northeast-corridor-open-world`, not inside another nested folder.
4. Return to `metro-maker4`, then open `cities` and `data`. Create either folder if it is missing.
5. From each of the four extracted map ZIPs, copy all the `NEC_` folders into `data`. For example, `NEC_CM01_RM01` should sit directly inside `data`. Do not copy the enclosing `nec-map-part-...` folders.

## Run the tile server

1. Move the extracted tile-server folder somewhere you can keep it, such as Documents. Do not run it from inside the ZIP.
2. Open that folder and double-click:
   - Windows: `open-world-tile-server.exe`
   - Mac: `Open World Tile Server.app` (opens the tile-server window in Terminal; no commands to type)
3. Leave the tile-server window open while playing. Open Subway Builder and enable Northeast Corridor Open World in the mod manager.

Open the same executable before playing each time. Only one tile server is needed for all installed Open World maps; do not start a second copy if one is already running.

## Updating

Close Subway Builder and stop the tile server before replacing files. Copy the new mod files and map folders into the same locations, accepting replacement of matching files. Leave other worlds and saved games alone, then open the tile-server executable again.
