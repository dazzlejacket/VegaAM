# macOS Keychain investigation (without a Mac)

**Status:** the root cause is identified and the shared-code part is fixed.
The remaining macOS-only behaviour could **not** be executed here - this
machine is Windows only. Everything below is either (a) proven on Windows, or
(b) derived from the Electron/Chromium documentation and the Electron source
behaviour, and marked as such.

---

## 1. What VegaAM does with credentials

| Item | Where | Notes |
| --- | --- | --- |
| Last.fm session key | `src/main/secretStore.ts` | encrypted, OS key store |
| ListenBrainz user token | `src/main/secretStore.ts` | encrypted, OS key store |
| User supplied Last.fm shared secret | `src/main/secretStore.ts` | encrypted, OS key store |
| Built-in application credentials | injected at build time (optional) | **not** a user credential; the open-source build has none by default — see [`SECURITY.md`](SECURITY.md) |

The renderer never receives a secret. `AppState.services.lastfm` only carries
the connection state, the connected account name and an error message.

## 2. How Electron stores the encryption key

Electron's `safeStorage` does not encrypt with a key of its own:

* **Windows** - the key is protected with **DPAPI**, bound to the Windows
  user account. The application name plays no role.
* **macOS** - the key lives in a **Keychain** generic password item named
  `<application name> Safe Storage` (account `<application name> Key`).
* **Linux** - the key lives in the desktop key ring (`gnome_libsecret`,
  `kwallet`); Electron falls back to a weak `basic_text` encryption when no
  key ring exists.

Two details decide whether the macOS prompt appears again and again:

1. **The item name follows the application name.** Chromium resolves
   `"<name> Safe Storage"` while the main message loop starts - that is,
   *before* the `ready` event. `app.setName()` therefore only works when it
   runs before `ready`; a `setName()` inside `whenReady()` is ignored.
2. **The Keychain access rules follow the code signature.** macOS stores an
   access control list on the item that trusts the *creating application*.
   The trust is expressed as a "designated requirement", which for a signed
   app is derived from the Developer ID certificate and the bundle
   identifier, and for an unsigned or ad-hoc signed app is derived from the
   binary's hash. A different hash means a different application - so macOS
   asks for permission again.

Electron documents this explicitly:

> On macOS, your app should be code signed for `safeStorage` to behave
> consistently. Without a valid, consistent signature, macOS may not
> recognize different builds of your app as the same application, which can
> cause the Keychain to re-prompt the user for permission on every update.
> &mdash; [Electron `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)

and

> `safeStorage` - Without a valid, consistent code signature, macOS may be
> unable to tell that two builds of your unsigned app are "the same app",
> which can cause the Keychain to prompt the user for permission again after
> every update.
> &mdash; [Electron code signing guide](https://github.com/electron/electron/blob/main/docs/tutorial/code-signing.md)

## 3. Root causes found in this repository

### 3.1 The macOS build was unsigned (primary cause)

`.github/workflows/ci.yml` builds the macOS installer with

```yaml
CSC_IDENTITY_AUTO_DISCOVERY: "false"
```

so the produced `.app` has **no** Developer ID signature. Every build is
therefore a different application as far as the Keychain is concerned, and
every start asks the user for Keychain permission. An ad-hoc signature does
not help either: its designated requirement is the binary hash, which
changes with every build.

**Fix:** the macOS release job now signs with a stable identity when the
certificate is available, and the CI job *verifies* the signature and the
bundle identifier afterwards. See `.github/workflows/ci.yml`.

### 3.2 The development run and the release build shared one Keychain item

`app.setName('VegaAM')` was called before `ready` (correct), and the
packaged `productName` is also `VegaAM` (correct), but an unpackaged
development run is a *different binary* than the signed release build. Both
used the Keychain item `VegaAM Safe Storage`, so a developer who switched
between `npm start` and the installed application was prompted by macOS every
time - and the development run could not decrypt the secrets the release
build had written.

**Fix (shared code, provable on Windows):**

* the development run now uses its own name (`VegaAM Dev`), so it gets its
  own Keychain item and never touches the release build's item;
* the secret file is variant specific (`secrets.enc` / `secrets.dev.enc`), so
  the two builds never fight over a file the other cannot decrypt.

### 3.3 Every write re-encrypted the payload

`SecretStore.save()` rewrote the file on every call, and every write encrypts
the payload, and every encryption on macOS touches the Keychain. Saving the
same secret twice caused two Keychain accesses instead of one.

**Fix:** the file is only written when its content actually changed, and an
empty secret is treated as "no secret" so that clearing a session that does
not exist does not write anything.

### 3.4 The synchronous `safeStorage` API is deprecated

The running application logged:

```
'safeStorage.isEncryptionAvailable' is deprecated and will be removed. Please use 'safeStorage.isAsyncEncryptionAvailable' instead.
'safeStorage.encryptString' is deprecated ...
'safeStorage.decryptString' is deprecated ...
```

The synchronous API is removed in Electron 46 and the asynchronous one also
handles a **rotated key** (`shouldReEncrypt`).

**Fix:** `SecretStore` now uses `isAsyncEncryptionAvailable`,
`encryptStringAsync` and `decryptStringAsync`, and re-encrypts the payload
when the operating system rotated its key.

### 3.5 The Linux fallback never persisted anything

The old code refused to write on Linux when Electron had selected the weak
`basic_text` backend, so the Last.fm session was lost on **every** restart -
Last.fm simply never worked on Linux.

**Fix:** the secrets are encrypted with `safeStorage` on every platform
(never in plain text), the weaker backend is reported in the diagnostics and
the UI, and the session survives a restart.

## 4. What was changed

| File | Change |
| --- | --- |
| `src/main/secretStore.ts` | async `safeStorage`, change detection, key rotation, variant specific file |
| `src/core/secrets/storage.ts` | pure, platform independent backend classification and diagnostics |
| `src/main/main.ts` | application name split (packaged / development) before `ready` |
| `src/main/app.ts` | secret store variant, credential diagnostics in the application state |
| `electron-builder.yml` | explicit macOS bundle id, entitlements, notarization switch |
| `build/entitlements.mac.plist` | Chromium JIT entitlements for the hardened runtime |
| `.github/workflows/ci.yml` | macOS signing + signature/bundle-id verification |
| `tests/lastfmAuth.test.ts` | regression tests for the backend classification |
| `src/renderer/quick/panel.ts` | the About tab shows how the credentials are protected |

## 5. What still needs a real Mac

These points cannot be proven without macOS hardware and are therefore
**unverified**:

1. That a signed build produces the Keychain item `VegaAM Safe Storage`
   with an access control list that survives an update - needs a real Mac
   with two signed builds.
2. That the prompt is really gone after the update - needs a real Mac.
3. That the notarized `.dmg` opens without a Gatekeeper warning - needs a
   real Mac (and an Apple Developer account).
4. The exact wording and the exact button order of the macOS Keychain
   dialog, and whether the user has to enter the login password.
5. The behaviour of `security` CLI based keychain inspection (`security
   find-generic-password -s "VegaAM Safe Storage"`).
6. Whether the current user profile already contains an orphaned
   `VegaAM Safe Storage` item from an older build.

**No existing Keychain entry is ever deleted by VegaAM.** The application
only reads and writes its own item.

## 6. How to verify on a real Mac

```bash
# 1. Build a signed .app (needs a Developer ID Application certificate).
CSC_LINK=/path/to/Developer\ ID\ Application.p12 \
CSC_KEY_PASSWORD=… \
npm run dist

# 2. Confirm the identity and the bundle id.
codesign -dv --verbose=4 "release/mac/VegaAM.app"
codesign -d --entitlements - "release/mac/VegaAM.app"

# 3. Confirm the Keychain item exists exactly once.
security find-generic-password -s "VegaAM Safe Storage"

# 4. Start the app twice and watch: the second start must NOT prompt.
```

## 7. References

* [Electron `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)
* [Electron code signing guide](https://github.com/electron/electron/blob/main/docs/tutorial/code-signing.md)
* [Electron issue #34614 - the Keychain service name follows the app name](https://github.com/electron/electron/issues/34614)
