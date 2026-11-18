import { describe, expect, it } from 'vitest';

import { buildPlaybackCapabilities } from '../src/main/gsmtcController';

describe('capability-gated playback controls', () => {
  it('exposes mute while keeping GSMTC transport flags false when no GSMTC session is active', () => {
    const caps = buildPlaybackCapabilities({
      platform: 'win32',
      isMuted: false,
      gsmtc: {
        sessionFound: false,
        sourceAppUserModelId: null,
        canPlayPause: false,
        canNext: false,
        canPrevious: false,
      },
    });

    expect(caps).toEqual({
      canPlayPause: false,
      canNext: false,
      canPrevious: false,
      canMute: true,
      isMuted: false,
      controlSource: 'webcontents-mute',
    });
  });

  it('enables transport capabilities on Windows when GSMTC reports them available', () => {
    const caps = buildPlaybackCapabilities({
      platform: 'win32',
      isMuted: true,
      gsmtc: {
        sessionFound: true,
        sourceAppUserModelId: 'com.vegaam.siriusxm',
        canPlayPause: true,
        canNext: false,
        canPrevious: false,
      },
    });

    expect(caps).toEqual({
      canPlayPause: true,
      canNext: false,
      canPrevious: false,
      canMute: true,
      isMuted: true,
      controlSource: 'gsmtc',
    });
  });

  it('never enables transport buttons if sessionFound is false even if flags are passed', () => {
    const caps = buildPlaybackCapabilities({
      platform: 'win32',
      isMuted: false,
      gsmtc: {
        sessionFound: false,
        sourceAppUserModelId: null,
        canPlayPause: true,
        canNext: true,
        canPrevious: true,
      },
    });

    expect(caps.canPlayPause).toBe(false);
    expect(caps.canNext).toBe(false);
    expect(caps.canPrevious).toBe(false);
    expect(caps.canMute).toBe(true);
    expect(caps.controlSource).toBe('webcontents-mute');
  });
});
