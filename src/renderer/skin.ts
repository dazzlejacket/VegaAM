/**
 * Renderer script for the Skinned Companion window (`skin.html`, 560x720).
 *
 * Supports Bluebird Classic, Retro Amp, Modern, Retro Satellite, Classic Compact,
 * and user-imported themes in both Light and Dark colour modes.
 *
 * Capability-gated: OS transport buttons (Play/Pause, Next, Previous) are shown
 * ONLY when `state.capabilities` reports them as supported.
 */

import type { AppState, PlaybackCapabilities } from '../shared/types';

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

let currentState: AppState | null = null;

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function applySkinCapabilities(capabilities: PlaybackCapabilities): void {
  const prevBtn = $('btn-skin-prev');
  const playBtn = $('btn-skin-play');
  const nextBtn = $('btn-skin-next');
  const muteBtn = $('btn-skin-mute');

  if (prevBtn) prevBtn.hidden = !capabilities.canPrevious;
  if (playBtn) playBtn.hidden = !capabilities.canPlayPause;
  if (nextBtn) nextBtn.hidden = !capabilities.canNext;
  if (muteBtn) {
    muteBtn.hidden = !capabilities.canMute;
    muteBtn.textContent = capabilities.isMuted ? 'Unmute Audio' : 'Mute Audio';
    muteBtn.classList.toggle('is-active', capabilities.isMuted);
  }
}

function renderState(state: AppState): void {
  currentState = state;

  const skinTheme = state.skinTheme ?? state.theme;
  const styleEl = $('theme-vars');
  if (styleEl && styleEl.textContent !== skinTheme.css) {
    styleEl.textContent = skinTheme.css;
  }

  const resolvedMode =
    state.settings.colorMode === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : state.settings.colorMode;

  document.body.dataset.theme = skinTheme.id;
  document.body.dataset.layout = skinTheme.layout ?? skinTheme.id;
  document.body.dataset.mode = resolvedMode;

  const labelEl = $('skin-window-label');
  if (labelEl) labelEl.textContent = skinTheme.name;

  const picker = $('skin-picker') as HTMLSelectElement | null;
  if (picker && document.activeElement !== picker) {
    picker.innerHTML = '';
    for (const t of state.themes) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      if (t.id === skinTheme.id) opt.selected = true;
      picker.appendChild(opt);
    }
  }

  const modeBtn = $('btn-skin-mode');
  if (modeBtn) {
    modeBtn.textContent = resolvedMode === 'light' ? 'Light' : 'Dark';
  }

  const pinBtn = $('btn-skin-pin');
  if (pinBtn) {
    pinBtn.classList.toggle('is-active', state.settings.alwaysOnTop);
  }

  const pb = state.playback;
  const led = $('skin-led');
  if (led) {
    led.dataset.status = pb.playing ? 'playing' : 'idle';
  }

  const channelText = (pb.channel || 'SIRIUSXM OFFICIAL STREAM').toUpperCase();
  const chEl = $('skin-channel');
  if (chEl) chEl.textContent = channelText;

  const listenedSec = Math.round((pb.listeningMs || 0) / 1000);
  const floorSec = Math.round(
    (pb.thresholdMs || state.settings.thresholds.radioMinListenMs || 90000) / 1000,
  );
  const timerEl = $('skin-timer');
  if (timerEl) {
    timerEl.textContent = `${formatClock(listenedSec)} / ${formatClock(floorSec)}`;
  }

  const displayTitle = pb.displayTitle || pb.title || 'Waiting for SiriusXM…';
  const displayArtist = pb.artist || 'Play any station in the official SiriusXM window';

  const readoutTitle = $('skin-readout-title');
  if (readoutTitle) readoutTitle.textContent = displayTitle;
  const readoutArtist = $('skin-readout-artist');
  if (readoutArtist) readoutArtist.textContent = displayArtist;

  const pct = Math.min(100, Math.round((listenedSec / Math.max(1, floorSec)) * 100));
  const meterFill = $('skin-meter-fill');
  if (meterFill) meterFill.style.width = `${pct}%`;

  const progEl = $('skin-programme');
  if (progEl) {
    const parts = [pb.channel, pb.programme && pb.programme !== pb.channel ? pb.programme : null].filter(Boolean);
    progEl.textContent = parts.length > 0 ? parts.join(' • ') : 'Official SiriusXM Player';
  }

  const titleEl = $('skin-title');
  if (titleEl) titleEl.textContent = displayTitle;

  const artistEl = $('skin-artist');
  if (artistEl) artistEl.textContent = displayArtist;

  const concertEl = $('skin-concert');
  if (concertEl) {
    if (pb.concert && (pb.concert.dateText || pb.concert.location || pb.concert.venue)) {
      concertEl.hidden = false;
      concertEl.textContent = [pb.concert.dateText, pb.concert.venue, pb.concert.location]
        .filter(Boolean)
        .join(' • ');
    } else {
      concertEl.hidden = true;
    }
  }

  const artImg = $('skin-artwork') as HTMLImageElement | null;
  const artFallback = $('skin-artwork-fallback');
  const fallbackCode = $('skin-fallback-code');
  if (artImg && artFallback) {
    if (pb.artwork && pb.artwork.startsWith('https://')) {
      if (artImg.src !== pb.artwork) artImg.src = pb.artwork;
      artImg.hidden = false;
      artFallback.hidden = true;
    } else {
      artImg.hidden = true;
      artFallback.hidden = false;
      if (fallbackCode) {
        fallbackCode.textContent = (pb.channel || 'SXM').slice(0, 4).toUpperCase();
      }
    }
  }

  const scrobbleBadge = $('skin-scrobble-badge');
  const scrobbleReason = $('skin-scrobble-reason');
  if (scrobbleBadge) {
    const anyConnected =
      state.services.listenbrainz.authorized || state.services.lastfm.authorized;
    if (!anyConnected) {
      scrobbleBadge.textContent = 'Offline';
      scrobbleBadge.dataset.status = 'warn';
    } else if (pb.playing && !pb.ambiguous && !pb.skipped) {
      scrobbleBadge.textContent = listenedSec >= floorSec ? 'Scrobbled' : 'Tracking';
      scrobbleBadge.dataset.status = 'ok';
    } else {
      scrobbleBadge.textContent = 'Standby';
      scrobbleBadge.dataset.status = 'warn';
    }
  }
  if (scrobbleReason) {
    scrobbleReason.textContent = state.monitor.eligibility;
  }

  const muteScrobbleBtn = $('btn-skin-mute-scrobble') as HTMLButtonElement | null;
  if (muteScrobbleBtn) {
    if (pb.channel) {
      muteScrobbleBtn.hidden = false;
      const isMuted = (state.settings.scrobbleMutedChannels ?? []).some(
        (c) => c.toLowerCase() === pb.channel?.toLowerCase(),
      );
      muteScrobbleBtn.textContent = isMuted ? 'Unmute Scrobbling' : 'Mute Scrobbling';
    } else {
      muteScrobbleBtn.hidden = true;
    }
  }

  applySkinCapabilities(state.capabilities);
}

function wireEvents(): void {
  $('skin-picker')?.addEventListener('change', (e) => {
    const skinId = (e.target as HTMLSelectElement).value;
    void window.sxm.selectSkin(skinId);
  });

  $('btn-skin-mode')?.addEventListener('click', () => {
    if (!currentState) return;
    const currentMode = document.body.dataset.mode === 'light' ? 'light' : 'dark';
    const nextMode = currentMode === 'light' ? 'dark' : 'light';
    void window.sxm.patchSettings({ colorMode: nextMode });
  });

  $('btn-skin-pin')?.addEventListener('click', () => {
    if (!currentState) return;
    void window.sxm.setAlwaysOnTop(!currentState.settings.alwaysOnTop);
  });

  $('btn-skin-activity')?.addEventListener('click', () => {
    void window.sxm.openActivityWindow();
  });

  $('btn-skin-settings')?.addEventListener('click', () => {
    void window.sxm.openSettingsWindow();
  });

  $('btn-skin-minimize')?.addEventListener('click', () => {
    void window.sxm.minimizeWindow();
  });

  $('btn-skin-close')?.addEventListener('click', () => {
    void window.sxm.closeWindow();
  });

  $('btn-skin-mute-scrobble')?.addEventListener('click', () => {
    const ch = currentState?.playback.channel;
    if (!ch) return;
    void window.sxm.toggleMuted(ch);
  });

  $('btn-skin-prev')?.addEventListener('click', () => {
    void window.sxm.playerCommand('previous');
  });

  $('btn-skin-play')?.addEventListener('click', () => {
    void window.sxm.playerCommand('toggle');
  });

  $('btn-skin-next')?.addEventListener('click', () => {
    void window.sxm.playerCommand('next');
  });

  $('btn-skin-mute')?.addEventListener('click', () => {
    void window.sxm.playerCommand('mute');
  });

  $('btn-skin-official')?.addEventListener('click', () => {
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
