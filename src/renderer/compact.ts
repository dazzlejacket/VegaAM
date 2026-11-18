/**
 * Renderer script for the Compact Companion window (`compact.html`, 480x152).
 *
 * Capability-gated: transport buttons (Play/Pause, Next, Previous) are shown
 * ONLY when `state.capabilities` reports them as supported by the OS media
 * session. Mute and "Return to Official Player" are always available.
 */

import type { AppState, PlaybackCapabilities } from '../shared/types';

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function applyCompactCapabilities(capabilities: PlaybackCapabilities): void {
  const prevBtn = $('btn-compact-prev');
  const playBtn = $('btn-compact-play');
  const nextBtn = $('btn-compact-next');
  const muteBtn = $('btn-compact-mute');

  if (prevBtn) prevBtn.hidden = !capabilities.canPrevious;
  if (playBtn) playBtn.hidden = !capabilities.canPlayPause;
  if (nextBtn) nextBtn.hidden = !capabilities.canNext;
  if (muteBtn) {
    muteBtn.hidden = !capabilities.canMute;
    muteBtn.textContent = capabilities.isMuted ? 'Unmute' : 'Mute';
    muteBtn.classList.toggle('is-active', capabilities.isMuted);
  }
}

function renderState(state: AppState): void {
  const styleEl = $('theme-vars');
  if (styleEl && styleEl.textContent !== state.theme.css) {
    styleEl.textContent = state.theme.css;
  }
  const resolvedMode =
    state.settings.colorMode === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : state.settings.colorMode;
  document.body.dataset.theme = state.theme.id;
  document.body.dataset.mode = resolvedMode;

  const pb = state.playback;
  const chEl = $('compact-channel');
  if (chEl) {
    chEl.textContent = pb.channel || 'SiriusXM Official Player';
  }

  const titleEl = $('compact-title');
  if (titleEl) {
    titleEl.textContent = pb.displayTitle || pb.title || 'Waiting for SiriusXM…';
  }

  const artistEl = $('compact-artist');
  if (artistEl) {
    artistEl.textContent = pb.artist || pb.programme || 'Play a channel in the official player';
  }

  const subEl = $('compact-sub');
  if (subEl) {
    const sec = Math.round((pb.listeningMs || 0) / 1000);
    const floor = Math.round(
      (pb.thresholdMs || state.settings.thresholds.radioMinListenMs || 90000) / 1000,
    );
    subEl.textContent = pb.title
      ? `${pb.playing ? 'Playing' : 'Paused'} • ${sec}s / ${floor}s`
      : state.monitor.eligibility;
  }

  const artImg = $('compact-art') as HTMLImageElement | null;
  const artFallback = $('compact-art-fallback');
  if (artImg && artFallback) {
    if (pb.artwork && pb.artwork.startsWith('https://')) {
      if (artImg.src !== pb.artwork) artImg.src = pb.artwork;
      artImg.hidden = false;
      artFallback.hidden = true;
    } else {
      artImg.hidden = true;
      artFallback.hidden = false;
      artFallback.textContent = (pb.channel || 'SXM').slice(0, 3).toUpperCase();
    }
  }

  const pinBtn = $('btn-compact-pin');
  if (pinBtn) {
    pinBtn.classList.toggle('is-active', state.settings.alwaysOnTop);
  }

  const dot = $('compact-scrobble-dot');
  if (dot) {
    const connected =
      state.services.listenbrainz.authorized || state.services.lastfm.authorized;
    dot.dataset.status = connected && pb.playing ? 'ok' : 'idle';
  }

  applyCompactCapabilities(state.capabilities);
}

function wireEvents(): void {
  $('btn-compact-pin')?.addEventListener('click', async () => {
    const state = await window.sxm.getState();
    await window.sxm.setAlwaysOnTop(!state.settings.alwaysOnTop);
  });
  $('btn-compact-skin')?.addEventListener('click', () => {
    void window.sxm.toggleSkinWindow();
  });
  $('btn-compact-close')?.addEventListener('click', () => {
    void window.sxm.closeWindow();
  });
  $('btn-compact-prev')?.addEventListener('click', () => {
    void window.sxm.playerCommand('previous');
  });
  $('btn-compact-play')?.addEventListener('click', () => {
    void window.sxm.playerCommand('toggle');
  });
  $('btn-compact-next')?.addEventListener('click', () => {
    void window.sxm.playerCommand('next');
  });
  $('btn-compact-mute')?.addEventListener('click', () => {
    void window.sxm.playerCommand('mute');
  });
  $('btn-compact-official')?.addEventListener('click', () => {
    void window.sxm.showMainWindow();
  });
}

async function init(): Promise<void> {
  if (typeof window === 'undefined' || !window.sxm) return;
  wireEvents();
  window.sxm.onState((state) => renderState(state));
  const initial = await window.sxm.getState();
  renderState(initial);
}

void init();
