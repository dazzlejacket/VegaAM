# Architecture

**VegaAM 3.2.4 — the ownership boundary, the processes and the windows.**

## The ownership boundary

VegaAM is a desktop shell around **one** official SiriusXM `BrowserWindow`
(`src/main/officialPlayer.ts`). The main window's own `webContents` loads
`https://www.siriusxm.com/player` in the persistent `persist:siriusxm` partition.

**SiriusXM owns** the page, the channel catalog, search, the channel guide,
favourites, entitlements, navigation, the playback engine, the DRM and the visual
design of its own player.

**VegaAM owns** the native window, the menu, the tray, the settings, the scrobbling
pipeline, the monitor and history, the notifications, the desktop integration, the
themes of its own windows and the optional companion windows.

There is **no local channel catalog**, no local search, no channel picker, no
duplicate player bar and no custom shell around the official page. The official page
is never scripted: `executeJavaScriptCount === 0` on the official `webContents` at
every point in the acceptance suite.

### The three rules that keep the boundary intact

1. **No script injection.** Theme changes go through
   `webContents.insertCSS(css, { cssOrigin: 'user' })` and are undone with
   `removeInsertedCSS(key)`. Nothing is evaluated in the page.
2. **No unofficial data sources.** Metadata comes only from the standard browser
   Media Session API that the official page publishes to the operating system.
   VegaAM never calls a SiriusXM endpoint, never reuses a token and never scrapes the
   catalog.
3. **No audio handling.** VegaAM has no code path that captures, decodes, proxies,
   records, relays or re-encodes audio. The official player is the only audio
   engine, and it must stay alive for playback to continue.

See [`SECURITY.md`](SECURITY.md) for the full service boundary and
[`LIMITATIONS.md`](LIMITATIONS.md) for what the boundary costs.

## Processes and windows

- **Main process (`src/main/app.ts`, `src/main/main.ts`)** — window lifecycle,
  settings migration, OS-encrypted Last.fm/ListenBrainz secrets, MediaSession
  validation, the pure `TrackStateEngine`, the per-service durable `ScrobbleQueue`,
  the bounded `HistoryStore`, native desktop integration and the capability-gated
  GSMTC/MPRIS adapters.

- **Official main window (`src/main/officialPlayer.ts`, `1280×860` default, `900×600`
  minimum)** — the only SiriusXM page and the only audio engine. One persistent
  authentication session (`persist:siriusxm`). Navigation is restricted to an exact
  HTTPS SiriusXM host allowlist; unknown hosts are dropped and in-app popups are
  denied.

- **Integrated studio drawer (`src/main/quickPanel.ts`, `src/renderer/quick/`)** — a
  single `WebContentsView` hosted inside `mainWindow.contentView`, **not** a separate
  OS window.
  - *Collapsed:* a compact launcher pill in the open SiriusXM header, so the player
    keeps direct pointer and wheel events.
  - *Expanded:* a right-side drawer (700 px, clamped to the display work area) with a
    navigation rail: **Appearance**, **Activity & History**, **Scrobbling Rules**,
    **Accounts**, **Companions & Desktop**, **About & Help**.
  - The standalone Settings window and the Scrobble Monitor window were **removed** in
    3.2. `BrowserWindow.getAllWindows().length` stays at 1 through every navigation
    path, and a static guardrail test keeps it that way.

- **MediaSession preload (`src/preload/mediaBridge.ts`)** — a context-isolated,
  sandboxed reader of `navigator.mediaSession.metadata` and
  `navigator.mediaSession.playbackState`. It does not query the DOM, does not inject
  code into the page's main world, does not register MediaSession action handlers and
  does not read cookies, storage, URLs or network responses. It forwards one
  validated `media:state` payload to `src/main/mediaBridge.ts`.

- **Compact Companion (`src/main/companionWindows.ts`, `480×152`)** — a mini-player
  with artwork, channel, track, scrobble progress and a mute toggle
  (`0` `<audio>`/`<video>` elements).

- **Skinned Companion (`src/main/companionWindows.ts`, `560×720`)** — the same view
  rendered in one of five original VegaAM skins: **Bluebird Classic**, **Retro Amp**,
  **Modern**, **Retro Satellite** and **Classic Compact**, each in light and dark
  mode.

- **Quick orb (`src/renderer/quick/orb.html`)** — a small always-on-top launcher for
  the drawer.

- **Tray and native menu (`src/main/tray.ts`, `src/main/menu.ts`)** — zero-pixel
  desktop chrome with keyboard accelerators (`Ctrl+,`, `Ctrl+Shift+A`, `Ctrl+M`,
  `Alt+Left`, `Alt+Right`, `Ctrl+R`). The menu also carries the standard **Edit**
  roles (`cut`, `copy`, `paste`, `selectAll`): Electron registers the clipboard
  accelerators from these menu items, so without them the drawer fields could not
  receive a pasted key. The template lives in `src/main/menuTemplate.ts` so that it
  can be tested without starting Electron.

## Themes and skins

Two independent theming systems, both original VegaAM work:

- **Surface themes (`src/core/surfaceTheme/`)** — 14 palettes (9 dark, 5 light) plus
  *Official (Stock)* and optional `#RRGGBB` accent derivation. A surface theme
  overrides SiriusXM's `--color-*` design tokens and a small set of targeted surface
  rules through `insertCSS`/`removeInsertedCSS`. It is **off by default**, requires
  explicit consent, is stripped on sign-in, account, billing and checkout routes, and
  is removed instantly on *Reset to Official* — without a reload and without
  interrupting audio. See `src/core/surfaceTheme/contrast.ts` for the alpha-aware
  contrast correction that keeps light palettes readable.

- **VegaAM skins (`src/core/theme/`)** — the appearance of VegaAM's *own* companion
  windows. A skin is a VegaAM presentation, not a SiriusXM theme, and contains no
  SiriusXM artwork.

## Scrobbling

The pipeline is deliberately boring and auditable:

```
official page → MediaSession preload → validated snapshot → TrackStateEngine
   → eligibility policy → durable ScrobbleQueue → Last.fm / ListenBrainz
```

- **`src/core/metadata/`** — the pure normalizer: it separates the combined
  `<programme> · <channel>` and `<artist> - <song>` fields, rejects non-music
  bumpers, hashtags and interview banners, and never guesses an artist.
- **`src/core/playback/trackState.ts`** — the state machine and the **adaptive
  scrobble threshold**. SiriusXM publishes no track duration, so the threshold is
  derived from the observed song length of the channel (median of the last 12
  observations, trusted after three, clamped to 60 s–600 s) and the normal **50 %
  rule** applies. A song that ends while it is still shorter than the threshold is
  submitted with the length it actually had. Paused and unobserved time never counts
  and an absolute floor of 30 s of real playback always applies.
- **`src/core/scrobble/`** — the pure Last.fm and ListenBrainz clients and the
  durable, bounded queue.
- **`src/main/historyStore.ts`** — the bounded local history and the manual retry
  path.

See [`SCROBBLE_STATE_MACHINE.md`](SCROBBLE_STATE_MACHINE.md) and
[`METADATA.md`](METADATA.md).

## Credential storage

- The **Last.fm session key**, the **ListenBrainz token** and a **user-supplied
  Last.fm shared secret** live in OS-encrypted storage (DPAPI on Windows, the
  Keychain on macOS, a supported Linux key ring). Electron's asynchronous
  `safeStorage` API is used; the encrypted file is written only when its content
  changed and is re-encrypted when the OS rotates its key.
- The renderer never receives a secret. The state broadcast carries the connection
  state, the connected account name and an error message only.
- The public Last.fm **API key** is not a secret and is renderer-visible.

See [`SECURITY.md`](SECURITY.md) and [`MACOS_KEYCHAIN.md`](MACOS_KEYCHAIN.md).

## Build

esbuild bundles the main process, the three preloads and the four renderers into
`dist/`. There are **no runtime dependencies** — `"dependencies": {}` is declared
explicitly. `scripts/make-icons.mjs` renders every application, installer, taskbar
and tray icon deterministically from the V-star geometry, and
`scripts/verify-icons.mjs` verifies the result.

See [`BUILD.md`](BUILD.md).
