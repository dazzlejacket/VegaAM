## VegaAM 3.2.5 — the Bruce channel is tagged correctly now

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

- **An album label is no longer scrobbled as the artist.** SiriusXM publishes some
  channels in the album-label form — `From "The Rising" — My City Of Ruins` — where the
  album stands where the artist would be. VegaAM used to take the left half of that
  string as the artist, so every track of E Street Radio was tagged with the artist
  `From "The Rising"`. The label is now read as the album, the artist comes from your
  channel mapping (`E Street Radio` → `Bruce Springsteen`), and the song keeps its full
  title: `Bruce Springsteen — Further On (Up The Road)`.
- **The album is carried into the scrobble.** The album recovered from the label is
  submitted with the track, so the scrobble is tagged `Bruce Springsteen — My City Of
  Ruins` (`The Rising`) instead of album-less.
- **A song title keeps the bracket that belongs to it.** `Further On (Up The Road)`
  lost the bracket whenever the artist could not be derived from the title.

### Changed

- **The ListenBrainz token hint says what it means.** The hint under the token field
  no longer explains that the token never has to be typed by hand — the **Paste**
  button next to it does that.

### Downloads

**Windows**

| File | Architecture |
| :--- | :--- |
| `VegaAM-3.2.5.exe` | x64 and arm64 in one installer |
| `VegaAM-3.2.5-x64.exe` | x64 only |
| `VegaAM-3.2.5-arm64.exe` | arm64 only |

**macOS**

| File | Architecture |
| :--- | :--- |
| `VegaAM-3.2.5.dmg` | x64 (Intel) |
| `VegaAM-3.2.5-arm64.dmg` | arm64 (Apple Silicon) |
| `VegaAM-3.2.5-mac.zip` | x64 (Intel) |
| `VegaAM-3.2.5-arm64-mac.zip` | arm64 (Apple Silicon) |

**Linux**

| File | Architecture |
| :--- | :--- |
| `VegaAM-3.2.5-x86_64.AppImage` | x86_64 |
| `VegaAM-3.2.5-arm64.AppImage` | arm64 |
| `vegaam_3.2.5_amd64.deb` | amd64 |
| `vegaam-3.2.5.x86_64.rpm` | x86_64 |

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
