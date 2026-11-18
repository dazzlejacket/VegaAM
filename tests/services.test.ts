import { describe, expect, it } from 'vitest';

import { LastFmService } from '../src/core/scrobble/lastfm';
import { ListenBrainzService } from '../src/core/scrobble/listenbrainz';
import type { HttpClient, HttpResponse } from '../src/core/scrobble/types';

interface Call {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

function mockHttp(
  responses: { status?: number; body: string }[],
): { http: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const http: HttpClient = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers });
    const response = responses[Math.min(index, responses.length - 1)] ?? { body: '{}' };
    index += 1;
    const result: HttpResponse = {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      text: async () => response.body,
    };
    return result;
  };
  return { http, calls };
}

describe('Last.fm service', () => {
  it('signs requests with the documented md5 signature', async () => {
    const { http, calls } = mockHttp([{ body: '{"scrobbles":[]}' }]);
    const service = new LastFmService({
      apiKey: 'TESTKEY',
      apiSecret: 'SECRET',
      sessionKey: 'TESTSESSION',
      http,
    });

    await service.scrobble({
      artist: 'Test Artist',
      title: 'Test Track',
      timestamp: 1_700_000_000,
    });

    const body = new URLSearchParams(calls[0]?.body ?? '');
    expect(body.get('method')).toBe('track.scrobble');
    expect(body.get('api_key')).toBe('TESTKEY');
    expect(body.get('sk')).toBe('TESTSESSION');
    expect(body.get('timestamp')).toBe('1700000000');
    // md5 of the sorted parameters (api_key, artist, method, sk, timestamp,
    // track) followed by the API secret.
    expect(body.get('api_sig')).toBe('c241d5fb272174102b279f889e31f7e5');
  });

  it('reports the error message returned by the service', async () => {
    const { http } = mockHttp([{ body: '{"error":9,"message":"Invalid session key"}' }]);
    const service = new LastFmService({
      apiKey: 'KEY',
      apiSecret: 'SECRET',
      sessionKey: 'SESSION',
      http,
    });

    const result = await service.scrobble({ artist: 'A', title: 'B', timestamp: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid session key');
  });

  it('refuses to call the API without credentials', async () => {
    const service = new LastFmService({});
    const result = await service.scrobble({ artist: 'A', title: 'B', timestamp: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('API key');
  });

  it('builds the authorisation URL', () => {
    const service = new LastFmService({ apiKey: 'KEY', apiSecret: 'SECRET' });
    const url = service.getAuthUrl('REQUESTTOKEN');
    expect(url).toContain('https://www.last.fm/api/auth/');
    expect(url).toContain('api_key=KEY');
    expect(url).toContain('token=REQUESTTOKEN');
  });

  it('verifies the session with user.getInfo', async () => {
    const { http, calls } = mockHttp([{ body: '{"user":{"name":"tester"}}' }]);
    const service = new LastFmService({
      apiKey: 'KEY',
      apiSecret: 'SECRET',
      sessionKey: 'SESSION',
      http,
    });
    const status = await service.verify();
    expect(status.authorized).toBe(true);
    expect(status.account).toBe('tester');
    expect(new URLSearchParams(calls[0]?.body).get('method')).toBe('user.getInfo');
  });
});

describe('ListenBrainz service', () => {
  it('validates the token', async () => {
    const { http, calls } = mockHttp([{ body: '{"code":"200","user_name":"tester"}' }]);
    const service = new ListenBrainzService({ token: 'TOKEN', http });
    const status = await service.verify();
    expect(status.authorized).toBe(true);
    expect(status.account).toBe('tester');
    expect(calls[0]?.headers?.Authorization).toBe('Token TOKEN');
  });

  it('reports an invalid token', async () => {
    const { http } = mockHttp([{ status: 401, body: '{"code":"401","message":"Invalid token"}' }]);
    const service = new ListenBrainzService({ token: 'TOKEN', http });
    const status = await service.verify();
    expect(status.authorized).toBe(false);
    expect(status.lastError).toBe('Invalid token');
  });

  it('treats the "Token invalid." answer as unauthorized', async () => {
    // The live endpoint answers with HTTP 200 and valid=false for a bad token.
    const { http } = mockHttp([
      { status: 200, body: '{"code":200,"message":"Token invalid.","valid":false}' },
    ]);
    const service = new ListenBrainzService({ token: 'TOKEN', http });
    const status = await service.verify();
    expect(status.authorized).toBe(false);
    expect(status.lastError).toBe('Token invalid.');
  });

  it('submits a listen with the "single" listen type', async () => {
    const { http, calls } = mockHttp([{ body: '{"status":"ok"}' }]);
    const service = new ListenBrainzService({ token: 'TOKEN', http });
    const result = await service.scrobble({
      artist: 'Dave Matthews Band',
      title: 'Cry (October 1, 2020 – Boston, MA)',
      timestamp: 1_700_000_000,
      durationMs: 240_000,
    });
    expect(result.ok).toBe(true);

    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body.listen_type).toBe('single');
    expect(body.payload[0].listened_at).toBe(1_700_000_000);
    expect(body.payload[0].track_metadata.artist_name).toBe('Dave Matthews Band');
    expect(body.payload[0].track_metadata.additional_info.duration_ms).toBe(240_000);
  });

  it('submits a now playing notification with the "playing_now" listen type', async () => {
    const { http, calls } = mockHttp([{ body: '{"status":"ok"}' }]);
    const service = new ListenBrainzService({ token: 'TOKEN', http });
    await service.nowPlaying({ artist: 'Coldplay', title: 'Viva La Vida', timestamp: 1 });

    const body = JSON.parse(calls[0]?.body ?? '{}');

    // The ephemeral "now playing" state uses a different schema from a
    // completed listen. Sending the completed-listen shape is rejected by
    // the service with HTTP 400, so the whole body is asserted here.
    expect(body.listen_type).toBe('playing_now');
    expect(body.payload).toHaveLength(1);

    const entry = body.payload[0];
    expect(entry.track_metadata.artist_name).toBe('Coldplay');
    expect(entry.track_metadata.track_name).toBe('Viva La Vida');
    expect(entry.track_metadata.additional_info.music_service).toBe('siriusxm.com');

    // A now playing entry has no end time, so `listened_at` must be absent.
    expect(entry.listened_at).toBeUndefined();
    expect('listened_at' in entry).toBe(false);

    // The completed-listen wrapper must never be used for now playing.
    expect(entry.metadata).toBeUndefined();
    expect(body.payload[0].metadata).toBeUndefined();
  });

  it('keeps the "single" listen type for completed listens', async () => {
    const { http, calls } = mockHttp([{ body: '{"status":"ok"}' }]);
    const service = new ListenBrainzService({ token: 'TOKEN', http });
    await service.scrobble({ artist: 'A', title: 'B', timestamp: 1_700_000_000 });

    const body = JSON.parse(calls[0]?.body ?? '{}');
    // Regression guard: the two listen types must not be confused.
    expect(body.listen_type).toBe('single');
    expect(body.payload[0].track_metadata).toBeDefined();
    expect(body.payload[0].listened_at).toBe(1_700_000_000);
  });

  it('refuses to submit without a token', async () => {
    const service = new ListenBrainzService({});
    const result = await service.scrobble({ artist: 'A', title: 'B', timestamp: 1 });
    expect(result.ok).toBe(false);
  });
});
