/**
 * Live Last.fm acceptance probe.
 *
 * It uses the *same* shared client the application uses
 * (`src/core/scrobble/lastfm.ts`) so the evidence is about VegaAM's code and
 * not about a separate script.
 *
 * Usage (through the bundled tool, see `scripts/lastfm-live-check.mjs`):
 *
 *   VEGAAM_LASTFM_API_KEY=... VEGAAM_LASTFM_API_SECRET=... node dist/tools/...
 *
 * Modes:
 *   token    - request a Last.fm request token (proves the key pair is valid)
 *   verify   - verify a stored session and report the account name
 *   scrobble - submit a real scrobble and report the acknowledgement
 *
 * The evidence is written as JSON so it can be attached to a report.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LastFmService } from '../core/scrobble/lastfm';
import { resolveLastFmCredentials } from '../core/scrobble/lastfmCredentials';

interface ProbeResult {
  mode: string;
  ok: boolean;
  at: string;
  apiKeyFingerprint?: string;
  sessionFingerprint?: string;
  account?: string;
  token?: string;
  error?: string;
  errorCode?: number;
  raw?: unknown;
}

/** A short, non reversible fingerprint so evidence never contains a secret. */
function fingerprint(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function readEnv(name: string): string {
  return (process.env[name] ?? '').trim();
}

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? 'token').trim();
  const outputDir = process.env.VEGAAM_LIVE_OUTPUT ?? join(process.cwd(), 'artifacts', 'lastfm-live');

  const credentials = resolveLastFmCredentials({
    userApiKey: readEnv('VEGAAM_LASTFM_API_KEY'),
    userApiSecret: readEnv('VEGAAM_LASTFM_API_SECRET'),
  });

  const service = new LastFmService({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    sessionKey: readEnv('VEGAAM_LASTFM_SESSION') || undefined,
  });

  const result: ProbeResult = {
    mode,
    ok: false,
    at: new Date().toISOString(),
    apiKeyFingerprint: credentials.apiKey ? fingerprint(credentials.apiKey) : undefined,
    credentialSource: credentials.source,
  } as ProbeResult;

  if (!credentials.usable) {
    result.error = 'No Last.fm API key pair available.';
  } else if (mode === 'token') {
    const response = await service.getToken();
    result.ok = response.ok;
    result.error = response.error;
    result.errorCode = response.errorCode;
    const token = (response.response as { token?: string } | undefined)?.token;
    if (token) {
      result.token = token;
      result.sessionFingerprint = fingerprint(token);
    }
  } else if (mode === 'verify') {
    const status = await service.verify();
    result.ok = status.authorized;
    result.account = status.account;
    result.error = status.lastError;
    result.errorCode = status.errorCode;
  } else if (mode === 'scrobble') {
    const artist = process.env.VEGAAM_LIVE_ARTIST ?? 'The Beatles';
    const title = process.env.VEGAAM_LIVE_TITLE ?? 'VegaAM Live Acceptance';
    const timestamp = Math.floor(Number(process.env.VEGAAM_LIVE_TIMESTAMP ?? 0) / 1000) || Math.floor(Date.now() / 1000);
    const response = await service.scrobble({
      artist,
      title,
      timestamp,
      durationMs: 240000,
    });
    result.ok = response.ok;
    result.error = response.error;
    result.errorCode = response.errorCode;
    result.raw = {
      artist,
      title,
      timestamp,
      response: response.response,
    };
  } else {
    result.error = `Unknown mode "${mode}".`;
  }

  mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, `lastfm-${mode}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  console.log(`[lastfm-live] evidence written to ${file}`);
}

void main().catch((error) => {
  console.error('[lastfm-live] failed:', error);
  process.exitCode = 1;
});
