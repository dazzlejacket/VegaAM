# What is actually verified

This document separates **claims backed by an automated test or a recorded run** from
**claims that are not verified**. It is written so that a reader can trust the
difference.

**VegaAM 3.2.4.**

---

## 1. Verified by the automated suite

Everything in this section is enforced by `npm test` (Vitest) and `npm run typecheck`
and is re-checked on every push in CI on Linux, macOS and Windows.

### Build and packaging

- `npm run typecheck` passes with 0 errors.
- `npm test` passes — the suite covers the theme engine, the surface-theme engine
  and its contrast rules, the metadata pipeline, the scrobble policy, the adaptive
  threshold, the queue, the Last.fm client and authorization, the settings
  migration, the MPRIS adapter, the MediaSession bridge, the companion windows, the
  icon identity and the static guardrails below.
- `npm run build` bundles the main process, the three preloads and the four
  renderers into `dist/` with 0 errors, and generates the full icon set.
- `npm run verify:icons` verifies that `build/icon.ico` embeds all nine Windows
  sizes (16, 20, 24, 32, 40, 48, 64, 128, 256 px) and that the `.icns` container is
  valid.
- CI produces a Windows NSIS installer, a macOS DMG/ZIP and Linux AppImage/deb/rpm
  packages from a clean checkout on every push.

### The one-player invariant (static guardrails)

These are enforced by `tests/noCatalog.test.ts` and `tests/officialWindow.test.ts`
and cannot silently regress:

- the main `BrowserWindow` loads `https://www.siriusxm.com/player` directly in the
  `persist:siriusxm` partition;
- `window.contentView.children.length === 0` — there is no `WebContentsView` and no
  custom shell around the official page;
- the fake channel catalog (`CHANNEL_DIRECTORY`), the local route table and the
  custom player shell are **absent from the source tree**;
- the standalone Settings window and the Activity window are absent, and the
  integrated drawer is the only settings surface;
- `executeJavaScriptCount === 0` and `insertCSSCount === 0` on the official
  `webContents` before a theme is applied.

### Themes

- All **14 surface themes** (9 dark + 5 light) are present, are applied through
  `insertCSS`/`removeInsertedCSS` and are removed by `removeInsertedCSS`.
- Theming is **off by default** and requires explicit consent.
- The auth/billing route guard strips the stylesheet on `/login`, `/signin`,
  `/authenticate`, `/welcome`, `/account`, `/billing`, `/payment`, `/checkout`,
  `/subscribe` and `/oauth`, and restores it on return to `/player/*`.
- The light palettes pass the alpha-aware contrast audit: every text-bearing role
  is corrected against every surface it can sit on, using that token's own alpha.
- All **5 companion skins** (Bluebird Classic, Retro Amp, Modern, Retro Satellite,
  Classic Compact) load in light and dark mode.

### Scrobbling

- The **adaptive threshold** is covered by regression tests: the median of the last
  12 observed song lengths, the trust-after-three rule, the 60 s–600 s clamp, the
  song-end rule (a song that ends below the threshold is still submitted), the
  joined-mid-song case, the skipped-track case, the pause case, the DJ-bumper case
  and the settings-migration rules.
- The **50 % rule** and the 30 s floor of real playback are enforced; paused and
  unobserved time never counts.
- The Last.fm client is covered for signed `auth.getToken`, `auth.getSession`
  without a preexisting session, missing-session responses, unauthorized tokens,
  invalid sessions, and accepted versus ignored scrobbles.
- The queue is covered for capacity limits, bounded backoff, restart recovery from
  the `sending` state, and the "do not replay an acknowledged submission" rule.

### Windows icon identity

- The AUMID-squatter detection is covered for UTF-16LE alignment, byte offset,
  casing, a legitimate VegaAM shortcut and a foreign Electron shortcut; the cleanup
  target list is covered as well. The detection never removes a legitimate VegaAM
  shortcut.

---

## 2. Verified by a recorded live run

These were verified against a real, signed-in SiriusXM session on a Windows host
during development. **They are historical evidence, not a guarantee** — the public
repository does not ship the evidence artifacts (screenshots and telemetry) because
they contain account and session data.

- **Live playback and metadata.** The official player was played live, the
  MediaSession bridge produced artist/title/channel metadata, and the values were
  observed to update on real track transitions.
- **Live scrobbling.** Real submissions were made to Last.fm and ListenBrainz from
  a live broadcast, and both services acknowledged them.
- **Adaptive threshold on a real channel.** Over a real broadcast the threshold
  adapted downwards as the channel's songs were observed, and DJ bumpers were
  correctly rejected.
- **Companion windows.** The Compact and Skinned companions rendered live metadata
  in all five skins and in both modes.
- **Windows taskbar identity.** With the stale development shortcut removed and the
  AUMID re-registered, the taskbar button renders the V-star instead of the stock
  Electron icon.

To reproduce the live checks on your own machine you need a legitimate subscription
and the acceptance runners described in [`BUILD.md`](BUILD.md) (`npm run smoke`,
`npm run qa:3.2`, `npm run qa:threshold`, `npm run live-probe`).

---

## 3. Not verified — do not claim these

- **No macOS runtime verification.** The macOS packaging, the hardened-runtime
  entitlements and the notarization path are configured, but the Keychain
  behaviour could not be exercised on a physical Mac during development. See
  [`MACOS_KEYCHAIN.md`](MACOS_KEYCHAIN.md).
- **No Linux runtime verification.** Linux packages are produced by CI, but the
  MPRIS runtime behaviour and the companion windows were not exercised on a physical
  Linux host.
- **No code signing.** Release artifacts are unsigned unless the maintainer
  configures a signing identity and Apple notarization credentials. Expect
  SmartScreen and Gatekeeper warnings.
- **No ARM, multi-monitor or every-DPI verification.**
- **No verification of SiriusXM's own service.** Nothing here says anything about
  the availability, behaviour or terms of SiriusXM, its DRM or its catalogue.
- **No claim about MediaSession stability.** SiriusXM can change or remove the
  Media Session metadata at any time; the bridge would then degrade, and VegaAM
  would say so rather than invent data.

---

*This project is unofficial and is not affiliated with Sirius XM Holdings Inc.
See [`../NOTICE.md`](../NOTICE.md).*
