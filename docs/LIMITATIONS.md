# Known limitations

**VegaAM 3.2.4.** This document is deliberately honest about what the software does
**not** do, what it cannot do, and which claims are *not* verified on a real machine.
It is the boundary of the project.

> **VegaAM is an unofficial project.** It is not affiliated with Sirius XM Holdings
> Inc. See [`SECURITY.md`](SECURITY.md) and [`../NOTICE.md`](../NOTICE.md).

## SiriusXM integration

- **No public consumer web-player API.** `https://developer.siriusxm.com/` is a
  secure partner portal. VegaAM does not call internal SiriusXM APIs, reuse tokens
  or reverse engineer playback.
- **MediaSession is not an official SiriusXM API.** The bridge reads the browser
  Media Session that the official page publishes to the operating system. It is the
  least invasive available metadata path, but it is a compatibility technique.
  SiriusXM can change or remove it at any time.
- **No channel catalog is maintained.** Channel names, numbers, artwork, categories,
  search, favourites, programmes and entitlements come from the official page.
  VegaAM cannot list channels before the user signs in, cannot guarantee a channel
  number, and does not substitute a similarly named entry.
- **No DRM circumvention, no audio extraction, no redistribution.** VegaAM contains
  no code that decrypts, captures, records, proxies, relays or re-encodes audio.
  Widevine and the official player's own network requests are untouched. There is no
  unofficial streaming endpoint.
- **No ad blocking, device spoofing, region shifting or entitlement spoofing.**
  These are prohibited and are not features.
- **The official page's own analytics and advertising load as they do in a browser.**
  VegaAM does not inject a blocker or alter the page's revenue behaviour. A user who
  wants network-level blocking can use an OS or DNS filter; VegaAM does not ship one.
- **No background playback independent of the official window.** The official
  `webContents` must stay alive. If it is destroyed, playback stops.
- **No second authentication session.** Only the official window signs in. VegaAM
  cannot authenticate on the user's behalf or transfer a session.
- **Surface themes are a local appearance customization.** They override SiriusXM's
  design tokens through `insertCSS`/`removeInsertedCSS`. They are **off by default**,
  require explicit consent, are stripped on sign-in, account, billing and checkout
  routes, and are removed instantly by *Reset to Official*. They inject **no scripts
  and no DOM changes**, and they cannot modify playback, requests or DRM.
- **No theme parity claim.** A skin that looks like a vintage radio is a VegaAM
  presentation, not a SiriusXM theme. The companion skins are original artwork.
- **No guaranteed custom transport.** Companion play/pause/previous/next exist only
  where a supported native adapter is verified: Windows has a WinRT GSMTC path,
  Linux depends on MPRIS, and macOS has no verified supported cross-app command
  path, so the controls are hidden there. Volume and seek are not offered.
- **Service terms.** SiriusXM's Customer Agreement and Website Terms restrict
  manipulation, reverse engineering and web data extraction. A distributed product
  should obtain written permission before shipping the metadata bridge. **This is a
  design constraint, not legal advice.** See the repository's release audit and
  [`SECURITY.md`](SECURITY.md).

## Metadata and scrobbling

- SiriusXM does not publish a reliable **song duration**. The MediaSession bridge
  exposes no `metadata.duration` and no playback position (`getPositionState()`
  returns `null`), so VegaAM cannot know how long a song is before it ends. The
  threshold is therefore **adaptive**: VegaAM measures the songs it hears end-to-end
  on the current channel, takes the median of the last 12 observations, and requires
  **half of that song length** (the same 50 % rule Last.fm and ListenBrainz use).
  The median of a 180 s prior is assumed until three songs of the channel have been
  observed, and the estimate is clamped to 60 s–600 s.
- **A song that ends while it is still shorter than the threshold is submitted**
  instead of being dropped. The length of the finished song is used for the 50 % rule,
  so a 70 s punk song needs 35 s of playback. This only applies when the slot was
  observed from a real song boundary: a song that was joined half-way through (the
  first song after start-up or after a channel switch) keeps the channel-wide
  threshold, so a song the user barely heard is never submitted.
- The floor that protects against "bad faith" scrobbles is **30 s of actual playback**
  (`minMs`), and paused or unobserved time never counts.
- The MediaSession fields are sometimes combined. The parser separates
  `"Programme · Channel"` and `"Artist - Song"`, but ambiguous values are rejected
  rather than guessed. A rejected track produces no scrobble.
- MediaSession artwork is not guaranteed. When the page publishes no artwork URL, the
  compact and skinned windows show a neutral placeholder. VegaAM does not scrape the
  page for artwork.
- A missing artist is not replaced by a channel name. There are **no shipped
  channel→artist mappings**. A user-created mapping or correction is explicit and
  labelled inferred, and it applies to the broadcast strings it was created for —
  a correction that was saved for a song title alone also applies to that song on
  another station. VegaAM never invents an artist that was neither published nor
  configured by the user.
- Channel numbers are not in MediaSession. VegaAM does not invent them.
- Stream position/duration is not song position/duration. Observation age is not
  provider freshness.
- A track only accrues listening while the session is playing: the published
  MediaSession state is `playing`, or Electron reports the official window as
  currently audible. Pauses, observation gaps over five seconds and a muted window
  do not accrue. Time before the first observation cannot be recovered.
- Buffering cannot be distinguished from playing without page data. The bridge does
  not read the `<audio>` element, so a stalled stream that still reports audible may
  be credited. This is a known conservative/accuracy trade-off.
- A partial current listen starts fresh after restart. Queued eligible submissions
  survive. No unobserved downtime is credited.
- **Last.fm requires the user's own application API key and shared secret.** This
  open-source build ships **without** a built-in key pair, so nobody else's
  credentials are distributed with it. The user registers a Last.fm API application
  and enters the pair in Settings → Accounts. See
  [`AUTHENTICATION.md`](AUTHENTICATION.md).
- **ListenBrainz requires a user token.** The `playing_now` and `single` payloads are
  tested with synthetic responses; real-account acknowledgement is separate evidence.
- Metadata-dependent desktop features (notifications, artwork, OS media panels)
  degrade when MediaSession is missing. They say so; they do not invent data.

## Platform and distribution

- Windows x64 packaging and the unpacked executable were exercised on Windows 11.
  **Release artifacts are not code-signed by default** — an unsigned build triggers
  SmartScreen warnings and macOS Gatekeeper on first launch.
- The **Windows taskbar icon** was verified on one Windows 11 host (2880×1800,
  200 % DPI). Windows resolves the taskbar button of an explicit `AppUserModelID`
  through *shortcuts that advertise the same AUMID*, so a third-party shortcut can
  still override the icon. VegaAM 3.2.2 removes such shortcuts automatically and
  re-registers the AUMID, but the behaviour is a shell decision and is only claimed
  for the host that was measured.
- Linux x64 packaging is configured (AppImage, deb, rpm) but **runtime behaviour was
  not verified on a physical Linux host** in the development environment. MPRIS
  runtime behaviour is therefore not claimed.
- macOS packaging, entitlements and notarization are configured
  (`build/entitlements.mac.plist`), but the **Keychain behaviour could not be
  exercised on a real Mac** during development. See
  [`MACOS_KEYCHAIN.md`](MACOS_KEYCHAIN.md).
- No ARM, multi-monitor or every-DPI verification is claimed.
- Chromium MediaSession → GSMTC / MPNowPlayingInfoCenter / MPRIS is platform
  behaviour, not a VegaAM guarantee. The presence of the bridge does not prove that
  the OS panel works on every host.
- Native notifications, media keys and taskbar/dock controls need per-platform
  acceptance tests.

## What "verified" means here

[`VERIFIED.md`](VERIFIED.md) separates the claims that are backed by an automated
test or a recorded run from the claims that are not. Nothing in this repository
should be read as a guarantee about SiriusXM's own service, its DRM, its catalogue
or its terms.
