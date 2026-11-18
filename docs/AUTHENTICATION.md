# Last.fm desktop authentication

> **SiriusXM authentication is not handled here.** The official SiriusXM page owns
> sign-in, session persistence, entitlements and playback authorization. VegaAM never
> asks for, stores, proxies or logs a SiriusXM password, cookie or token. See
> [`SECURITY.md`](SECURITY.md). This document covers Last.fm only.

VegaAM implements Last.fm's [desktop application flow](https://www.last.fm/api/desktopauth), using a signed `auth.getToken`, an external browser authorization URL containing `api_key` and `token`, and signed `auth.getSession` exchanges. Neither authentication call includes an existing session key. Authenticated playback submissions include the resulting session key and signature.

## Setup

**This open-source build ships without a built-in Last.fm key pair.** Last.fm's API
terms expect every application to identify itself with its own credentials, and a
key pair baked into a desktop binary is extractable by anyone who installs it — so
VegaAM asks you for your own.

1. Create your application at
   [Last.fm API account creation](https://www.last.fm/api/account/create). It takes
   a minute and needs a Last.fm account.
2. Enter that application's API key and shared secret in **Settings → Accounts**.
3. Click **Connect Last.fm** and approve the request in the browser window that
   opens. VegaAM exchanges the token for a session by itself.

The key identifies your application, and its shared secret signs API requests. You
do not need to acquire or paste a session key.

> Maintainers who want to bake their **own** pair into a private build can set
> `VEGAAM_LASTFM_API_KEY` and `VEGAAM_LASTFM_API_SECRET` in the environment or in a
> git-ignored `.env.local` — see [`SECURITY.md`](SECURITY.md).

Connect saves the public key, encrypts the supplied secret with the OS facility and opens your browser. Complete Last.fm's authorization there. VegaAM polls session exchange after three seconds and then every five seconds while Last.fm reports an unauthorized token. Polling expires after the documented 60-minute request-token lifetime. A temporary network failure can retry within that window. Closing VegaAM during authorization requires connecting again; an authorized stored session is restored and verified on restart.

The renderer keeps unsaved API-key drafts across periodic state broadcasts and blur. The saved public key stays visible. A successfully handled shared-secret draft is cleared from the renderer; leaving that field blank reuses the encrypted saved secret. A malformed or missing credential produces a visible failure, not a cleared API key.

Connection states are Not configured, Awaiting authorization, Connected (with username), Authentication failed, and Session invalid/reconnect required. Revoked sessions fail visibly and their submissions remain available for manual retry after reconnection. Concurrent or cancelled authorization attempts cannot install an obsolete session.

## Storage and disconnection

The session and shared secret are main-process-only values in OS-encrypted storage (DPAPI on Windows, Keychain on macOS, supported secure Linux backend). Connection is refused if secure storage is unavailable; Linux `basic_text` is explicitly refused. A legacy plaintext shared secret is migrated into encrypted storage when a secure backend is available. No credential-bearing responses are sent to the renderer or diagnostics clipboard.

Disconnect cancels pending token exchange and removes the locally stored session. It retains the application key and shared secret so reconnecting does not require recreating the application. To revoke remote access as well, use Last.fm's account application settings. No remote revocation is implied by local disconnect.

## Verification boundary

Automated protocol tests verify signed token acquisition, exchange without a preexisting session, missing-session responses, unauthorized tokens, invalid sessions, and accepted versus ignored scrobbles. Real Electron UI tests verify typing, blur, persistence of the saved key, and removal of the manual session field. These are distinct from real-account authorization: the inspected existing profile had no configured Last.fm session, so no successful live authorization or scrobble acknowledgement is claimed for this repair session.
