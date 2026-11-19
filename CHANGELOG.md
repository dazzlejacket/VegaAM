# Changelog

All notable changes to VegaAM are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A key can be pasted into the account fields.** The custom application menu carried
  no standard editing roles, and Electron registers the clipboard accelerators
  (`Ctrl+C` / `Ctrl+X` / `Ctrl+V` / `Ctrl+A`) from those menu items — so the renderer had
  no working paste command and a token had to be typed by hand. The menu now has a real
  **Edit** menu, the drawer inputs opt back into text selection, and the token and
  credential fields offer an explicit **Paste** button that reads the clipboard through
  the main process.
- **A manual track correction now reaches the track it was made for.** The correction
  was keyed on the exact strings the player published, while the interface shows the
  resolved artist and title. A correction saved for a broadcast whose artist field
  carried a date and location therefore never matched. Corrections are now looked up
  with several candidates — the raw pair, the pair shown in the interface, the song
  title on its own, the artist on its own — most specific first, and the confirmation
  states exactly what the correction is keyed on.
- **A channel mapping also matches a decorated channel name.** A station that publishes
  itself as `Bruce Springsteen / E Street Radio` now finds the mapping for
  `E Street Radio`; the longest matching mapping wins.

### Added

- **"Fix tagging" on the Now Playing card and on every history entry.** It fills the
  correction form with the exact broadcast strings of that track, so the raw metadata
  never has to be reproduced by hand.
- **Artist Aliases in the Scrobbling tab.** The engine already supported renaming an
  artist exactly as it is broadcast (`Bruce Springsteen & The E Street Band` →
  `Bruce Springsteen`); the control to do it is now reachable from the interface.
- **The album is no longer dropped.** The album the official player publishes is carried
  into the normalised track and submitted with the scrobble, and a correction can set
  it.

## [3.2.3]

### Added

- **Last.fm connection without an API key hunt.** The *Connect Last.fm* button opens
  the authorization page, waits for the approval and exchanges the token for a
  session by itself through a loopback callback. No manual session key, no copy-paste
  dance.
- **Session restore after a restart.** The Last.fm session is stored in the operating
  system key store and revalidated on start-up. The connected account name is shown
  in the Accounts tab.
- **Documented error handling.** A rejected session is detected through the
  documented Last.fm error code instead of a heuristic.
- **Reliable credential fields.** The API key field persists on blur and is no longer
  overwritten by the live state broadcast.
- 28 new platform-independent regression tests covering the whole Last.fm path.

## [3.2.2]

### Fixed

- **Windows taskbar identity.** A leftover development shortcut that advertised the
  VegaAM `AppUserModelID` while pointing at an Electron binary made Windows resolve
  the taskbar button through that shortcut and draw the stock Electron atom instead
  of the V-star. VegaAM now removes such shortcuts automatically at start-up,
  re-registers its `AppUserModelID` with a real icon path, and refreshes the shell
  icon cache. A **Clean Legacy Shortcuts** button in *About & Help* does the same on
  demand.

## [3.2.1]

### Changed

- **Adaptive scrobble threshold.** SiriusXM publishes no track duration, so the old
  flat 150-second radio floor threw away short songs. VegaAM now measures the songs
  it hears end-to-end, takes the median of the last 12 observations and applies the
  same **50 % rule** Last.fm uses. A song that ends while it is still under the
  threshold is **submitted** with the length it actually had. Paused and unobserved
  time never counts and a 30-second floor of real playback still applies. The
  threshold in force is shown in the *Scrobbling* and *Activity* panels, and the flat
  floor remains available as an explicit choice.

## [3.2.0]

### Added

- **Integrated studio drawer.** *Appearance*, *Activity & History*, *Scrobbling Rules*,
  *Accounts*, *Companions & Desktop* and *About & Help* now open as a single
  right-side drawer inside the main window. The standalone Settings and Scrobble
  Monitor windows were removed — `BrowserWindow.getAllWindows().length` stays at 1
  through every navigation path.
- **Real light themes.** Five genuine daylight palettes, alpha-aware so translucent
  SiriusXM tokens stay legible once composited.
- **Scrobble Monitor & History tab** with a live view of the current track, the
  decision log and the retry queue.
- **Custom accent derivation** from any `#RRGGBB` value with live preview.

### Changed

- **Theme opt-in is now a single unobtrusive line of text** instead of a modal
  dialog, and *Disable Themes* revokes consent instantly.
- Theming starts disabled; the stylesheet is stripped on sign-in, account, billing
  and checkout routes.

## [3.1.0]

### Added

- **Reversible SiriusXM surface themes** — 9 dark + 5 light palettes, applied with
  `insertCSS` / `removeInsertedCSS` and removed instantly without a reload or an
  audio interruption.
- **14 surface themes** in total, plus *Official (Stock)*.
- **Read-only MediaSession bridge** — a context-isolated, sandboxed preload that
  forwards validated `navigator.mediaSession` snapshots to the main process.
- **5 companion skins** for the Skinned Companion window: Bluebird Classic, Retro
  Amp, Modern, Retro Satellite and Classic Compact.
- **Windows V-star icon identity** — a multi-size `.ico` (16–256 px), a monochrome
  tray mark and an NSIS script that cleans up legacy shortcuts.

## [3.0.0]

### Changed

- **Official-first architecture.** The main window's own `webContents` loads
  `https://www.siriusxm.com/player` directly. The fake channel catalog, the custom
  player shell, the scripted search and the local channel picker were permanently
  removed — the official page owns the catalog, search, favourites, entitlements and
  playback.
- **Zero `executeJavaScript` on the official player.** Theme changes go through
  `insertCSS` / `removeInsertedCSS` only.

### Removed

- The shipped channel directory and its seed defaults.
- Scripted page interactions and header search.

## [0.3.0]

### Added

- The initial desktop shell: native window, tray, menu, settings, scrobble monitor,
  notifications, the Compact companion and the first skinned companion.

---

*This project is unofficial and is not affiliated with Sirius XM Holdings Inc.
See [NOTICE.md](NOTICE.md).*
