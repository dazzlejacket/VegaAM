## VegaAM 3.2.4 — pasting works, and your tagging corrections actually apply

**VegaAM is an unofficial, independent, open-source project.** It is not affiliated
with, endorsed by, or sponsored by Sirius XM Holdings Inc. SiriusXM, Sirius XM and all
related trademarks belong to their respective owners and are used only to identify the
service this app works with. Every theme, skin and icon shipped with VegaAM is original
VegaAM artwork.

**You need your own legitimate SiriusXM subscription.** VegaAM provides no SiriusXM
access and ships no content. It hosts the official SiriusXM web player and gives you a
desktop-native shell around it.

**No DRM bypass, no audio capture, no redistribution.** VegaAM never decrypts,
records, proxies or re-streams audio, never calls unofficial SiriusXM APIs and never
blocks or alters the official player's requests.

### Fixed

- **You can paste a key again.** The custom application menu carried no standard
  editing roles, and Electron registers the clipboard accelerators from exactly those
  menu items — so the renderer had no working paste command and a ListenBrainz token
  or a Last.fm API key had to be typed by hand. The menu has a real **Edit** menu
  again, the drawer inputs select their text, and every credential field now has a
  **Paste** button next to it that reads the clipboard for you.
- **A track correction reaches the track it was made for.** The correction was keyed
  on the exact strings the player published, while the interface shows the resolved
  artist and title. A correction saved for a broadcast whose artist field carried a
  date and a location therefore never matched — it was saved, confirmed, and silently
  ignored. Corrections are now matched against the raw pair, the pair the interface
  shows, the song title on its own and the artist on its own, and the confirmation
  states exactly what the correction is keyed on.
- **A channel mapping also matches a decorated station name.** A station that
  publishes itself as `Bruce Springsteen / E Street Radio` now finds your
  `E Street Radio` mapping.

### Added

- **Fix tagging** on the Now Playing card and on every history entry fills the
  correction form with the exact broadcast strings of that track.
- **Artist Aliases** in the Scrobbling tab rename an artist exactly as it is
  broadcast — `Bruce Springsteen & The E Street Band` → `Bruce Springsteen` — so your
  profile stays clean.
- **The album is tagged too.** The album the official player publishes is carried into
  the scrobble instead of being dropped, and a correction can set it.

### Downloads

**Windows**

| File | Architecture |
| :--- | :--- |
| `VegaAM-3.2.4.exe` | x64 and arm64 in one installer |
| `VegaAM-3.2.4-x64.exe` | x64 only |
| `VegaAM-3.2.4-arm64.exe` | arm64 only |

**macOS**

| File | Architecture |
| :--- | :--- |
| `VegaAM-3.2.4.dmg` | x64 (Intel) |
| `VegaAM-3.2.4-arm64.dmg` | arm64 (Apple Silicon) |
| `VegaAM-3.2.4-mac.zip` | x64 (Intel) |
| `VegaAM-3.2.4-arm64-mac.zip` | arm64 (Apple Silicon) |

**Linux**

| File | Architecture |
| :--- | :--- |
| `VegaAM-3.2.4-x86_64.AppImage` | x86_64 |
| `VegaAM-3.2.4-arm64.AppImage` | arm64 |
| `vegaam_3.2.4_amd64.deb` | amd64 |
| `vegaam-3.2.4.x86_64.rpm` | x86_64 |

Every asset is built by the same
[`electron-builder.yml`](https://github.com/dazzlejacket/VegaAM/blob/master/electron-builder.yml)
configuration that ships with the repository, on a native runner for its platform.

> The installers are **not code-signed**, so Windows SmartScreen and macOS Gatekeeper
> will warn on first launch. On macOS, right-click the app and choose **Open** the first
> time. The macOS Keychain permission is requested once per install.

### Build it yourself

```sh
git clone https://github.com/dazzlejacket/VegaAM.git
cd VegaAM
npm ci
npm run typecheck
npm test
npm run build
npm start
```

Node.js 20+ and npm are the only requirements — VegaAM has no runtime dependencies.

### Connect Last.fm

This build ships **without** a built-in Last.fm key pair. Register an application at
[Last.fm API account creation](https://www.last.fm/api/account/create) and enter your
API key and shared secret in **Settings → Accounts** — paste them, don't type them.
Your session key is stored in the operating system key store, never in plain text.

See the [README](https://github.com/dazzlejacket/VegaAM#readme),
[SECURITY.md](https://github.com/dazzlejacket/VegaAM/blob/master/docs/SECURITY.md) and
[LIMITATIONS.md](https://github.com/dazzlejacket/VegaAM/blob/master/docs/LIMITATIONS.md)
for the exact technical and service boundary.

MIT licensed — see [LICENSE](https://github.com/dazzlejacket/VegaAM/blob/master/LICENSE).
