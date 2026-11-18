# Security and service boundaries

**Status:** the boundary described here is what VegaAM 3.2.3 implements and what the
automated test suite enforces. It is both a security model and a **service-term
contract**: a change that crosses one of these lines is a breaking change for the
project, not a feature.

## Unofficial project, no affiliation

VegaAM is an independent, community-driven open-source project. It is **not
affiliated with, endorsed by, sponsored by or officially connected to Sirius XM
Holdings Inc.** SiriusXM, Sirius XM and all related trademarks belong to their
respective owners and are used only nominatively, to identify the service that this
software works with. The V-star mark, the wordmark and every shipped icon are
original VegaAM artwork.

**VegaAM is not a SiriusXM product, does not provide SiriusXM access and does not
include any SiriusXM content.** A user needs their own legitimate SiriusXM
subscription; the official player handles sign-in, entitlement checks and playback.

**There is no DRM bypass, no audio capture and no redistribution.** VegaAM contains
no code path that decrypts, decodes, records, proxies, relays or re-encodes audio,
and no unofficial streaming endpoint. Widevine, the official player's requests and
the official player's revenue behaviour are left untouched.

## SiriusXM session

The official SiriusXM page runs in the main window's own `webContents`, in the persistent `persist:siriusxm` partition, with context isolation, sandboxing and no Node integration. It is the only place that authenticates, checks entitlements, receives the playback authorization and produces audio. VegaAM never reads, stores, proxies or logs the SiriusXM password, cookie, token, playback key or internal API response. It never opens a second authenticated window and does not offer its own sign-out; use the official page's account controls.

Navigation is limited to HTTPS URLs on an exact SiriusXM host allowlist. `will-navigate`, `will-redirect` and `setWindowOpenHandler` enforce it. Allowlisted external links (help, account management) go to the system browser; unknown hosts are dropped. In-app popups are denied. The page's `beforeunload` is overridden so it cannot silently block quit.

Permissions are denied unless a documented official feature requires them. Camera, microphone, geolocation, notifications, MIDI, HID, serial, USB and clipboard-read are not granted by default. Fullscreen and pointer lock may be kept if the page uses them. Do not grant broad permissions to make a broken feature pass.

## MediaSession bridge

The official page's preload is read-only. It reads `navigator.mediaSession` (title, artist, album, artwork, playback state) and sends a bounded payload to the main process over a one-way IPC channel. It does not:

- call `contextBridge.exposeInMainWorld`;
- query the DOM;
- call `executeJavaScript` in the page;
- inject CSS or scripts;
- register MediaSession action handlers;
- read cookies, storage, URLs, tokens or network responses;
- click or type into the official page.

The main process validates types, caps string lengths, accepts only HTTPS artwork URLs, rate-limits and deduplicates. It also validates the sender: the official window's `webContents`, its main frame, and the current allowed URL. A malformed payload or a subframe sender is dropped; it cannot crash the app or reach the renderer. The bridge is disabled unless the user consents, and the UI states that it is not an official SiriusXM integration.

## What VegaAM must not do

- Harvest or reconstruct the channel catalog, search results, favourites, programmes or schedules.
- Inject CSS or DOM scripts into the official page.
- Drive the official search, channel selection or transport by scripting or clicking.
- Call internal SiriusXM APIs, reuse tokens or inspect network responses.
- Spoof a device, region or entitlement; extract audio; bypass DRM; block ads or alter page behavior.
- Bundle or redistribute SiriusXM credentials, tokens, logos or channel artwork.

These are both security and service-term constraints. See §4.4 of the architecture correction for the exact Customer Agreement and Website Terms clauses.

## Local application

VegaAM renderers use a narrow local preload. IPC handlers validate the sender, the sender frame and the current document URL. Secrets stay in the main process. The Last.fm session key, the ListenBrainz token and a user supplied Last.fm shared secret use OS-encrypted storage (DPAPI on Windows, the Keychain on macOS, a supported Linux key ring backend). The public API key is renderer-visible; the secret and the session key are not.

The credential store uses the **asynchronous** `safeStorage` API, writes the encrypted file only when its content changed, and re-encrypts the payload when the operating system rotated its key. A development run and the packaged application use **separate** encrypted files, because they are different applications to the operating system key store. See [`MACOS_KEYCHAIN.md`](MACOS_KEYCHAIN.md).

When a Linux desktop has no key ring at all, Electron's weak `basic_text` backend is used: the payload is still encrypted (never plain text), the session still survives a restart, and **About & Help → Credential Protection** states that the protection is weak. The secrets are never written unencrypted.

Companion windows never load SiriusXM and never authenticate. They receive a public view model only. They cannot request arbitrary URLs, arbitrary files or raw service responses.

## Diagnostics

Copy Diagnostics uses an explicit field allowlist and excludes settings, URLs, cookies, tokens, session keys, raw service responses and page content. Transport errors use generic messages. The packaged build has no remote-debugging port and no developer tools.

## The Last.fm application credentials

This open-source build **ships without a built-in Last.fm key pair**. That is
deliberate:

* Last.fm's API terms expect every application to identify itself with its own
  credentials rather than with a key pair that ships inside the binary.
* A key pair baked into a desktop executable is not a secret — anyone who installs
  the application can extract it and act as that API client.

So the **user** registers a Last.fm API application
([Last.fm API account creation](https://www.last.fm/api/account/create)) and enters
the key and shared secret in **Settings → Accounts**. The shared secret is stored
with the OS-encrypted facility, exactly like the session key.

A maintainer who wants to build a **private** release with their own credentials
baked in can set `VEGAAM_LASTFM_API_KEY` and `VEGAAM_LASTFM_API_SECRET` in the
environment or in a git-ignored `.env.local`:

* they are **never committed**, never printed and never written to a log;
* they are injected into the **main-process bundle only** — the renderer bundles
  never see them;
* a **release** build (`npm run dist`) refuses to build with a shared secret that
  was published publicly — the revoked secret is detected through its SHA-256
  digest, which is the only thing the repository stores;
* a release build **without** credentials is valid; it only warns.

The **user** session key never leaves the main process, is encrypted at rest,
and is deleted from the store when the service rejects it.

## Distribution

SiriusXM access is the user's own legitimate subscription through the official page.
VegaAM is unaffiliated with Sirius XM Holdings Inc.; SiriusXM, Sirius XM, Last.fm,
ListenBrainz and MusicBrainz trademarks belong to their respective owners. The
Last.fm application credentials are described in *The Last.fm application
credentials* above.

A distributed VegaAM build must:

* keep the unofficial notice and the "your own subscription" statement visible —
  in the README, in `NOTICE.md` and in the application's *About & Help* tab;
* not ship anybody else's Last.fm application credentials;
* not bundle SiriusXM logos, channel artwork or channel data;
* not claim any official relationship with Sirius XM Holdings Inc.

See [`AUTHENTICATION.md`](AUTHENTICATION.md), [`LIMITATIONS.md`](LIMITATIONS.md) and
[`../NOTICE.md`](../NOTICE.md).
