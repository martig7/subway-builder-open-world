# Mac installer and manager

The native SwiftUI app requires macOS 13 or later. Both Apple Silicon and Intel
builds include the self-contained .NET installer backend and independent tile
server. No terminal commands or .NET installation are required from users.

Open the DMG, drag **Open World Manager.app** to **Applications**, and open it.
Select worlds and click **Install**. The app downloads and verifies the map and
mod ZIPs; the Windows support asset is deliberately excluded. After installation,
click **Start** in the manager. The menu-bar controls remain available when its
window is closed. Login startup is disabled until the user enables it.

## Ownership and safety

- Shared installer primitives remain in `OpenWorld.Release`; Mac orchestration
  lives in `OpenWorld.MacBackend`, and native presentation lives here.
- The embedded release envelope preserves the exact signed catalog bytes and
  public certificate. No signing private key is included. Catalog and app
  versions must agree with `VERSION`; refresh the envelope for a new release.
- Data goes to `~/Library/Application Support/metro-maker4`; receipts, transaction
  journal, cache and logs go to `~/Library/Application Support/Open World Manager`.
- The full selected installation is staged and hashed before live directories
  are replaced. Cancellation before commit preserves the previous installation.
  A journal restores an interrupted commit on the next modifying operation.
- A file lock serializes manager mutations. Symlink paths are rejected. Installing
  replaces the exact selected mod and tile folders, including manual installations
  without receipts and obsolete files within those folders. Other folders are untouched.
- Uninstall only deletes recorded, unmodified files. Saved games, other worlds,
  and added files are preserved. The manager app itself can be moved to Trash.
- One server scans all worlds. Stop uses the existing authenticated control
  command, not a PID kill. Unknown services are not stopped.

## CI

`.github/workflows/macos-installer.yml` builds and tests both architectures on
macOS 15. Its artifacts contain the DMG and screenshots for setup, progress,
cancellation confirmation, completion, manager, error, and uninstall confirmation.
Screenshots render the actual interface with deterministic demonstration states;
they are not evidence of a live download at the pictured progress percentage.

Backend tests exercise local multi-world install, cancellation, recovery,
corruption/repair and scoped removal. The Apple Silicon job also downloads the
real signed NEC assets from GitHub, installs and verifies them in a disposable
location, then uninstalls them. No game installation on this workstation is used.

Builds are ad-hoc signed, not Apple Developer ID signed or notarized. Hosted
runner tests do not establish the end-user Gatekeeper approval experience or
exercise macOS Login Items approval. CI does not publish a release automatically.
