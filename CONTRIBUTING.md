# Contributing to VegaAM

Thanks for helping out. VegaAM is a small, friendly project and contributions of
every size are welcome — a typo fix, a new theme palette, a platform bug report or a
documentation improvement all count.

## Before you start

Please read [`README.md`](README.md) and [`docs/SECURITY.md`](docs/SECURITY.md).
The service boundary described there is the part of VegaAM that matters most.

**A contribution that decrypts, captures, proxies, records or redistributes SiriusXM
audio, that bypasses DRM, that calls unofficial SiriusXM APIs, that scrapes the
channel catalog, or that injects scripts into the official page will not be merged.**
So will anything that bundles somebody else's Last.fm credentials.

If you are unsure whether an idea is inside the boundary, open an issue first and
ask. That is always cheaper than a rejected pull request.

## Getting set up

```sh
git clone https://github.com/dazzlejacket/VegaAM.git
cd VegaAM
npm ci
npm run typecheck
npm test
npm start
```

You need Node.js 20+ and npm. Nothing else — VegaAM has **no runtime dependencies**
and every source file is bundled by esbuild into `dist/`.

## The usual loop

```sh
npm run build          # bundle main, preloads and renderers into dist/
npm start              # build + launch Electron
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run build:watch    # rebuild on change
```

## Code conventions

- **TypeScript**, strict mode, no `any` in new code.
- **Pure core.** Anything in `src/core/` must stay free of Electron and filesystem
  imports, so it can be unit tested without a browser. Platform behaviour belongs in
  `src/main/`.
- **No `executeJavaScript` on the official player.** The official `webContents` is
  read-only. Theme changes go through `insertCSS` / `removeInsertedCSS`.
- **Preloads stay context-isolated** and only expose a narrow, typed API.
- **Secrets never reach the renderer.** Anything sensitive lives in the main process
  and, at rest, in the OS key store.
- Comments explain *why*, not *what*. Match the surrounding style.

## Adding a theme or a skin

Surface themes live in `src/core/surfaceTheme/palettes.ts`; skins live in
`src/core/theme/builtin/*.json`.

1. Add the palette with its id, name, family, mode and full token set.
2. Keep every text-bearing role legible against **every** surface it can sit on.
   The contrast helpers in `src/core/surfaceTheme/contrast.ts` exist for this.
3. Add a regression test in `tests/surfaceTheme.test.ts` — in particular the
   light-mode contrast test.
4. Never reuse SiriusXM artwork or logos in a theme, skin or icon.

## Pull requests

- One logical change per pull request.
- Run `npm run typecheck && npm test` before you push.
- Describe what changed and why. Screenshots are very welcome for UI changes.
- Keep the MIT license header on new files.

## Reporting bugs

Open an issue with your operating system, the VegaAM version, what you did, what
you expected and what happened. A log from **Settings → About & Help → Copy
Diagnostics** is ideal — it is redacted by design and contains no credentials, URLs,
cookies or page content.

## Security issues

Please **do not** open a public issue for a security problem. Report it privately to
the maintainers through the repository's security advisory page instead.
