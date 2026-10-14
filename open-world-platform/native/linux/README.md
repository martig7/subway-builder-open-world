# Linux installer and manager

Use the architecture matching your Linux desktop: `linux-x64` (Intel/AMD) or
`linux-arm64`. The manager includes .NET, the PMTiles server and Node 22 or later;
you do not need to install those runtimes. It requires a glibc desktop with X11
or XWayland, fontconfig, ICU, OpenSSL 3, and `xdg-utils`. Ubuntu 22.04/24.04 and
Debian 12 are the intended baseline. Alpine/musl is unsupported.

On Debian/Ubuntu, install the `.deb` with your graphical package installer or
`sudo apt install ./Open-World-Manager-vVERSION_ARCH.deb`. Open **Open World
Manager** from the application menu. To remove the app use `sudo apt remove
open-world-manager`; uninstall worlds through the manager first if desired.
Before a `.deb` upgrade, stop the tile server and quit the manager so the running
service's executable remains verifiable throughout replacement.

For other distributions, extract the `.tar.gz` and run `bash install.sh` as your
desktop user. This installs into `$XDG_DATA_HOME/open-world-manager/app` (default
`~/.local/share/open-world-manager/app`) and creates an application-menu shortcut.
`--no-launch` registers the app without opening its window. Quit the existing
manager before upgrading; the portable installer stops the verified tile service
before replacing its executable. An upgrade keeps one `app.previous` backup; move or
remove that backup before the next upgrade. Neither app packaging method changes
saved games or installs world packages automatically.

Select NEC (`northeast-corridor-open-world`) and/or Japan
(`local.japan-open-world`), then **Install / repair selected**. Both use the
shared runtime built by `prototype/nec-corridor/mod` and `prototype/japan/mod`.
The manager verifies the embedded signed release catalog and every downloaded
asset's size and SHA-256, stages the full selection, and rolls interrupted
commits back. Windows support assets are excluded; Linux support is bundled.
Installation verifies all recorded files and starts the shared server. Enable
the mod and reload Subway Builder after installation.

The manager provides Start/Stop/Restart, verification, repair, scoped uninstall,
logs, stable-release update checks, diagnostic recording, and the three optional
demand/autosave/station-naming processing switches. All processing switches and
login startup default to off. Desktop environments supporting tray icons expose
the manager's menu while its window is open or minimized. Closing quits the app;
the tile server continues independently. Native Windows crash capture and game
launch flags are Windows-specific and are not offered here.

Linux game data is `$XDG_CONFIG_HOME/metro-maker4` (default
`~/.config/metro-maker4`). Manager receipts, cache and logs use
`$XDG_DATA_HOME/open-world-manager`; shared service state uses
`$XDG_DATA_HOME/metro-maker4/open-world-pmtiles`. Relative XDG values are ignored.
The **start when I sign in** option writes a per-user XDG autostart entry. It
starts the manager and the shared server, and is disabled until selected.

Mod and tile destinations are exact manifest IDs from the catalog. Replacement
removes obsolete files inside those destinations. Uninstall removes only recorded
unmodified files, preserving saves, other worlds and user-added files. Symlink
installation paths are rejected. A file lock serializes mutations. Unknown
services on port 8799 are never stopped; controls verify the server's instance
token and protocol header.

Build on the matching Linux architecture:

```sh
npm ci --prefix open-world-platform
bash open-world-platform/native/linux/build-manager.sh linux-x64 /tmp/ow-linux-build
```

`.github/workflows/linux-installer.yml` builds both architectures on Ubuntu,
tests the shared installer and Linux integration, renders the actual GUI under
Xvfb, installs the packaged app and verifies real NEC/Japan vVERSION assets in
disposable folders. Artifacts contain `.deb`, `.tar.gz`, checksums, screenshots
and logs. Workflows do not publish a release or install into this workstation's
game. Hosted-runner tests do not establish an in-game Linux reload or all desktop
environments' tray/autostart behavior.
