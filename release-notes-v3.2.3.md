## VegaAM 3.2.3 — first public release

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

### What you get

- **14 reversible surface themes** — 9 dark and 5 light — applied with
  `webContents.insertCSS(css, { cssOrigin: 'user' })` and removed with
  `removeInsertedCSS(key)`. Off by default, explicit consent, stripped on sign-in,
  account, billing and checkout routes, instant reset to the official look without a
  reload or an interrupted stream.
- **5 original companion skins** — Bluebird Classic, Retro Amp, Modern, Retro
  Satellite and Classic Compact — plus a compact mini-player and a floating quick orb.
- **One integrated studio drawer** — Appearance, Activity & History, Scrobbling Rules,
  Accounts, Companions & Desktop and About & Help, all inside the main window. No
  popup settings windows.
- **Last.fm and ListenBrainz scrobbling** with an **adaptive 50 % threshold**: SiriusXM
  publishes no track duration, so VegaAM measures the songs it hears end-to-end,
  takes the median of the last twelve and submits a short song that ends below the
  threshold instead of dropping it. Paused and unobserved time never counts.
- **Desktop integration** — OS media panels (Windows GSMTC, macOS Now Playing, Linux
  MPRIS), media keys, tray, notifications and global shortcuts.

### Downloads

**Windows**

| File | Architecture |
| :--- | :--- |
| `VegaAM-3.2.3.exe` | combined (x64 + arm64) |
| `VegaAM-3.2.3-x64.exe` | x64 only |
| `VegaAM-3.2.3-arm64.exe` | arm64 only |

**macOS**

| File | Architecture |
| :--- | :--- |
| `VegaAM-3.2.3-mac-x64.dmg` | x64 only |
| `VegaAM-3.2.3-mac-arm64.dmg` | arm64 only |
| `VegaAM-3.2.3-mac-x64.zip` | x64 only |
| `VegaAM-3.2.3-mac-arm64.zip` | arm64 only |

**Linux**

| File | Architecture |
| :--- | :--- |
| `VegaAM-3.2.3-linux-x86_64.AppImage` | x86_64 |
| `VegaAM-3.2.3-linux-arm64.AppImage` | arm64 |
| `vegaam_3.2.3_amd64.deb` | x86_64 |
| `vegaam-3.2.3.x86_64.rpm` | x86_64 |

The Windows installers were built on Windows, the macOS packages on a macOS runner and the
Linux packages on a Linux runner — all through the same
[`electron-builder.yml`](https://github.com/dazzlejacket/VegaAM/blob/master/electron-builder.yml)
configuration that ships with the repository.

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
API key and shared secret in **Settings → Accounts**. Your session key is stored in the
operating system key store, never in plain text.

See the [README](https://github.com/dazzlejacket/VegaAM#readme),
[SECURITY.md](https://github.com/dazzlejacket/VegaAM/blob/master/docs/SECURITY.md) and
[LIMITATIONS.md](https://github.com/dazzlejacket/VegaAM/blob/master/docs/LIMITATIONS.md)
for the exact technical and service boundary.

MIT licensed — see [LICENSE](https://github.com/dazzlejacket/VegaAM/blob/master/LICENSE).
