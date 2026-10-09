# Ultra Speed

A standalone Subway Builder mod for players using native cities. Open World already includes this feature; Open World players do not need to install Ultra Speed.

Enable **Ultra-high-speed mode** in the **Ultra speed** toolbar panel. It replaces detailed train, signal, crowd, and passenger movement simulation with calculated journeys, ridership, and finance profiles. Select the game's Ultra speed tier to advance its clock 10× faster than the normal Ultra increment. Other speed tiers keep their normal increments; pause still works. Existing train positions remain frozen while estimates run.

This estimates service without capacity limits, signal delays, missed connections, or crowding. Demand views retain calculated modes and routes. Turning the toggle off restores native simulation and rebases train timing. Service and fare changes recalculate journeys at the next midnight. Normal native saves and autosaves remain authoritative, including finances. There is no external save writer.

The toggle is remembered independently from Open World's setting. New installs default to off. If both mods are enabled, this panel yields entirely to Open World; use Open World's Map rendering panel. For standalone native-city play, enable Ultra Speed with Open World disabled. This also preserves Open World's retained controller when leaving a World city. Click **Reload Now** after disabling Open World (or restart the game); toggling it off alone leaves its running code loaded until reload. The standalone checks the game's loaded-mod registry against registered World consumers, so stale global records from disabled mods no longer block it. The panel names the blocking manifest ID.

To inspect the running check in the game's developer console:

```js
SubwayBuilderAPI.mods.getLoadedMods()
globalThis.__subwayBuilderUltraSpeedModV1__?.snapshot()
```

The snapshot should report `version: "ultra-speed-standalone-v3"` for 0.1.2. With all World consumers disabled and reloaded, `worldOwner` is `null`. If it names a manifest ID, that registered World is still present in the host's loaded-mod list.

## Build for publication

Requires Node.js 22.15+ and the repository's platform dependencies:

```powershell
cd open-world-platform
npm ci
cd ../mods/ultra-speed
npm test
npm run build
```

Publish `dist/ultra-speed-0.1.2.zip`. The archive contains only `manifest.json` and `index.js` at its root, including embedded demand and finance workers. Its manifest ID is `gcm.ultra-speed`. Extract those two files into a mod folder for manual installation, or upload the ZIP to a platform accepting native Subway Builder mod archives.

The build does not install anything. It never reads World Definitions or generated geography, and includes no city data, tile server, native executable, or network service. It uses the demand already loaded by Subway Builder. Compatibility targets the inspected Subway Builder 1.7.2 and Mod API 1.0.0.

Implementation and the shared UI live in `open-world-platform/src/runtime`. This directory is a publication shell, outside the World consumers and their installers. Fixing the shared cached simulation updates both distributions when they are rebuilt.
