/**
 * Build script.
 *
 * esbuild bundles the TypeScript sources for the main process, the preloads
 * and the VegaAM renderers (the in-window studio drawer, Compact and Skin
 * companions). The main BrowserWindow loads https://www.siriusxm.com/player
 * directly.
 *
 * The Last.fm application credentials are OPTIONAL and are injected here, at
 * build time, from the environment:
 *
 *   VEGAAM_LASTFM_API_KEY     - public half of the application key pair
 *   VEGAAM_LASTFM_API_SECRET  - private half of the application key pair
 *
 * A local `.env.local` file (git ignored) may hold them. The values are never
 * written to the repository and never printed.
 *
 * This open-source build ships WITHOUT a built-in key pair: Last.fm's API terms
 * expect every application to identify itself with its own credentials, so the
 * user supplies their own in Settings -> Accounts (see docs/AUTHENTICATION.md).
 * A build without credentials is perfectly valid - the Last.fm UI then asks for
 * a key pair before it can connect.
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { isRevokedLastFmSecret } from './revokedSecrets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');
const release = process.argv.includes('--release');

/**
 * Read the build-time credentials.
 *
 * `.env.local` is read first so a developer does not have to export the
 * variables in every shell; the process environment always wins.
 */
async function readBuildCredentials() {
  const values = { apiKey: '', apiSecret: '' };
  const envFile = join(root, '.env.local');
  try {
    const content = await readFile(envFile, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = /^\s*(VEGAAM_LASTFM_API_KEY|VEGAAM_LASTFM_API_SECRET)\s*=\s*(.*)\s*$/.exec(
        line,
      );
      if (!match) continue;
      const value = match[2].trim().replace(/^["']|["']$/g, '');
      if (match[1] === 'VEGAAM_LASTFM_API_KEY') values.apiKey = value;
      else values.apiSecret = value;
    }
  } catch {
    // No local credential file - the environment is enough.
  }
  values.apiKey = (process.env.VEGAAM_LASTFM_API_KEY || values.apiKey).trim();
  values.apiSecret = (process.env.VEGAAM_LASTFM_API_SECRET || values.apiSecret).trim();
  return values;
}

/**
 * Validate the credentials for a release build.
 *
 * Missing credentials are NOT an error in the open-source build: the user
 * supplies their own Last.fm key pair at runtime, and Last.fm's API terms
 * require that an application identifies itself with its own credentials
 * rather than with a shared one that ships inside the binary.
 *
 * A release must however never carry a shared secret that was already
 * published publicly - that one is a hard failure.
 */
function assertReleaseCredentials(credentials) {
  if (!credentials.apiKey || !credentials.apiSecret) {
    console.warn(
      '[build] No Last.fm application credentials were supplied, so this build has no ' +
        'built-in key pair. Users connect Last.fm with their own application key and ' +
        'shared secret (Settings -> Accounts). Set VEGAAM_LASTFM_API_KEY and ' +
        'VEGAAM_LASTFM_API_SECRET to bake your own pair into a private build.',
    );
    return;
  }
  if (isRevokedLastFmSecret(credentials.apiSecret)) {
    throw new Error(
      '[build] The configured Last.fm shared secret was already published publicly and must ' +
        'be rotated at Last.fm before a release is built. The build was stopped.',
    );
  }
}

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  minify: !watch,
  target: 'node20',
};

/**
 * Build targets.
 *
 * The Last.fm credentials are only injected into the main process bundle -
 * the renderer bundles never see them.
 */
function createTargets(credentials) {
  const lastfmDefine = {
    __VEGAAM_LASTFM_API_KEY__: JSON.stringify(credentials.apiKey),
    __VEGAAM_LASTFM_API_SECRET__: JSON.stringify(credentials.apiSecret),
  };

  return [
    {
      ...shared,
      entryPoints: [join(root, 'src', 'main', 'main.ts')],
      outfile: join(dist, 'main', 'main.js'),
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      define: lastfmDefine,
    },
    {
      ...shared,
      entryPoints: [join(root, 'src', 'preload', 'app.ts')],
      outfile: join(dist, 'preload', 'app.js'),
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    },
    {
      ...shared,
      entryPoints: [join(root, 'src', 'preload', 'mediaBridge.ts')],
      outfile: join(dist, 'preload', 'mediaBridge.js'),
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    },
    {
      ...shared,
      entryPoints: [join(root, 'src', 'preload', 'quick.ts')],
      outfile: join(dist, 'preload', 'quick.js'),
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    },
    {
      ...shared,
      entryPoints: [join(root, 'src', 'renderer', 'compact.ts')],
      outfile: join(dist, 'renderer', 'compact.js'),
      platform: 'browser',
      format: 'iife',
    },
    {
      ...shared,
      entryPoints: [join(root, 'src', 'renderer', 'skin.ts')],
      outfile: join(dist, 'renderer', 'skin.js'),
      platform: 'browser',
      format: 'iife',
    },
    {
      ...shared,
      entryPoints: [join(root, 'src', 'renderer', 'quick', 'orb.ts')],
      outfile: join(dist, 'renderer', 'quick', 'orb.js'),
      platform: 'browser',
      format: 'iife',
    },
    {
      ...shared,
      entryPoints: [join(root, 'src', 'renderer', 'quick', 'panel.ts')],
      outfile: join(dist, 'renderer', 'quick', 'panel.js'),
      platform: 'browser',
      format: 'iife',
    },
    {
      // The live acceptance probe reuses the real Last.fm client.
      ...shared,
      entryPoints: [join(root, 'src', 'tools', 'lastfmLiveCheck.ts')],
      outfile: join(dist, 'tools', 'lastfmLiveCheck.js'),
      platform: 'node',
      format: 'cjs',
      define: lastfmDefine,
    },
  ];
}

const rendererPages = ['compact', 'skin'];

async function copyStatic() {
  await mkdir(join(dist, 'renderer', 'styles'), { recursive: true });
  await mkdir(join(dist, 'renderer', 'quick'), { recursive: true });
  for (const page of rendererPages) {
    await cp(
      join(root, 'src', 'renderer', `${page}.html`),
      join(dist, 'renderer', `${page}.html`),
    );
    await cp(
      join(root, 'src', 'renderer', 'styles', `${page}.css`),
      join(dist, 'renderer', 'styles', `${page}.css`),
    );
  }
  await cp(
    join(root, 'src', 'renderer', 'styles', 'quick.css'),
    join(dist, 'renderer', 'styles', 'quick.css'),
  );
  await cp(
    join(root, 'src', 'renderer', 'quick', 'orb.html'),
    join(dist, 'renderer', 'quick', 'orb.html'),
  );
  await cp(
    join(root, 'src', 'renderer', 'quick', 'panel.html'),
    join(dist, 'renderer', 'quick', 'panel.html'),
  );
}

async function build() {
  const credentials = await readBuildCredentials();
  if (release) {
    assertReleaseCredentials(credentials);
  } else if (credentials.apiSecret && isRevokedLastFmSecret(credentials.apiSecret)) {
    console.warn(
      '[build] WARNING: the configured Last.fm shared secret was published publicly. ' +
        'Rotate it at Last.fm before shipping this build.',
    );
  }

  const targets = createTargets(credentials);

  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const iconResult = spawnSync(process.execPath, [join(root, 'scripts', 'make-icons.mjs')], {
    stdio: 'inherit',
  });
  if (iconResult.status !== 0) {
    throw new Error('Could not generate the icons.');
  }

  const verifyIconResult = spawnSync(process.execPath, [join(root, 'scripts', 'verify-icons.mjs')], {
    stdio: 'inherit',
  });
  if (verifyIconResult.status !== 0) {
    throw new Error('Icon verification failed.');
  }

  await copyStatic();

  if (watch) {
    const contexts = await Promise.all(targets.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((context) => context.watch()));
    console.log('[build] watching for changes…');
    return;
  }

  await Promise.all(targets.map((options) => esbuild.build(options)));
  console.log('[build] done');
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
