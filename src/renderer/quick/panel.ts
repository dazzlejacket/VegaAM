/**
 * Renderer script for the VegaAM 3.2 Integrated In-Window Launcher Pill & Studio Drawer (`panel.html`).
 *
 * Hosts all normal navigation (Appearance, Activity & History, Scrobbling Rules,
 * Accounts, Companions & Desktop, About & Help) inside the single main SiriusXM
 * window without spawning floating popup windows or modal warning dialogs.
 */

import type { SurfaceThemeState, SurfaceThemeSummary } from '../../core/surfaceTheme/types';
import { DraftFieldRegistry } from '../../core/settings/draftFields';
import { lookupKey } from '../../core/util/text';
import type { SxmApi } from '../../preload/app';
import type { VegaDrawerState, VegaQuickApi } from '../../preload/quick';
import type { AppState, HistoryEntryView } from '../../shared/types';

declare global {
  interface Window {
    sxm: SxmApi;
    vegaQuick: VegaQuickApi;
  }
}

type DrawerTabId = VegaDrawerState['tab'];
type ThemeFilterMode = 'all' | 'light' | 'dark';

const TAB_TITLES: Record<DrawerTabId, { title: string; subtitle: string }> = {
  appearance: {
    title: 'Appearance',
    subtitle: 'Live SiriusXM light & dark surface themes — zero popups, uninterrupted audio',
  },
  activity: {
    title: 'Activity & History',
    subtitle: 'Live MediaSession scrobble monitor, listening history & offline retry queue',
  },
  scrobbling: {
    title: 'Scrobbling Rules',
    subtitle: 'Concert title formatting, muted channels, artist mappings & track corrections',
  },
  accounts: {
    title: 'Accounts & Session',
    subtitle: 'Official SiriusXM session, ListenBrainz token & Last.fm authentication',
  },
  companions: {
    title: 'Companions & Desktop',
    subtitle: 'Optional mini-player companions, system tray behaviour & desktop notifications',
  },
  about: {
    title: 'About & Help',
    subtitle: 'Keyboard shortcuts, surface theme technical disclosure & runtime diagnostics',
  },
};

const RAIL_TABS: DrawerTabId[] = [
  'appearance',
  'activity',
  'scrobbling',
  'accounts',
  'companions',
  'about',
];

let latestState: AppState | null = null;
let latestSurface: SurfaceThemeState | null = null;
let historyItems: HistoryEntryView[] = [];
let activeTab: DrawerTabId = 'appearance';
let themeFilter: ThemeFilterMode = 'all';
let activitySubtab: 'history' | 'queue' = 'history';
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Draft state of the editable text fields.
 *
 * The application state is broadcast roughly once per second. Without this
 * registry a broadcast overwrote whatever the user was typing - which is why
 * the Last.fm API key field appeared to "not save".
 */
const draftFields = new DraftFieldRegistry();

/** Show the value of a field without discarding an unsaved draft. */
function applySyncedField(id: string, remote: string): void {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  const value = draftFields.display(id, remote);
  if (input.value !== value) input.value = value;
  if (!draftFields.blocksRemote(id)) draftFields.confirm(id, remote);
}

/** Remember every keystroke so a state broadcast cannot swallow it. */
function trackFieldInput(id: string): void {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  input.addEventListener('input', () => draftFields.type(id, input.value));
}

function showToast(message: string): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 2200);
}

function setDrawerState(state: VegaDrawerState): void {
  const shell = document.getElementById('drawer-shell');
  const focusWasInside = Boolean(
    shell && document.activeElement && shell.contains(document.activeElement),
  );

  document.body.dataset.drawerState = state.open ? 'open' : 'collapsed';
  if (shell) {
    shell.hidden = !state.open;
  }
  if (state.tab) {
    switchTab(state.tab);
  }

  if (state.open) {
    // Move the keyboard into the drawer so the arrow keys work right away.
    window.setTimeout(() => focusActiveRailTab(), 60);
  } else if (focusWasInside) {
    // Give the focus back to the launcher pill instead of losing it.
    document.getElementById('launcher-pill')?.focus();
  }
}

/** The badge text for a Last.fm connection state. */
function lfmConnectionLabel(state: string | undefined): string {
  switch (state) {
    case 'awaiting-authorization':
      return 'Waiting for approval…';
    case 'session-invalid':
      return 'Session expired';
    case 'authentication-failed':
      return 'Not connected';
    case 'connected':
      return 'Connected';
    default:
      return 'Not connected';
  }
}

/** Focus the rail tab that is currently selected. */
function focusActiveRailTab(): void {
  const button = document.getElementById(`nav-${activeTab}`);
  if (button instanceof HTMLElement) button.focus();
}

function switchTab(tab: DrawerTabId): void {
  activeTab = tab;
  document.body.dataset.activeTab = tab;

  const meta = TAB_TITLES[tab] ?? TAB_TITLES.appearance;
  const titleEl = document.getElementById('drawer-title');
  const subtitleEl = document.getElementById('drawer-subtitle');
  if (titleEl) titleEl.textContent = meta.title;
  if (subtitleEl) subtitleEl.textContent = meta.subtitle;

  const tabs: DrawerTabId[] = RAIL_TABS;

  for (const id of tabs) {
    const btn = document.getElementById(`nav-${id}`);
    const pane = document.getElementById(`tab-${id}`);
    const selected = id === tab;
    btn?.setAttribute('aria-selected', String(selected));
    // Roving tabindex: the tablist behaves like the ARIA tab pattern, so the
    // arrow keys move between the sections instead of the Tab key.
    btn?.setAttribute('tabindex', selected ? '0' : '-1');
    if (pane) pane.hidden = !selected;
  }

  if (tab === 'activity') {
    void refreshHistory();
  } else if (tab === 'about') {
    void refreshDiagnostics();
  }
}

function updateDrawerColorMode(): void {
  if (!latestState) return;
  const pref = latestState.settings.colorMode;
  let resolved: 'dark' | 'light' = 'dark';
  if (pref === 'light') {
    resolved = 'light';
  } else if (pref === 'dark') {
    resolved = 'dark';
  } else {
    // When 'system', also follow active light surface theme if one is applied
    const activeSurface = latestSurface?.themes.find((t) => t.id === latestSurface?.activeId);
    if (latestSurface?.consent && activeSurface?.mode === 'light') {
      resolved = 'light';
    } else {
      resolved = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
  }
  document.body.dataset.mode = resolved;

  for (const mode of ['dark', 'light', 'system'] as const) {
    const btn = document.getElementById(`ui-mode-${mode}`);
    btn?.classList.toggle('active', pref === mode);
  }
}

function renderSurfaceThemes(surface: SurfaceThemeState): void {
  latestSurface = surface;
  updateDrawerColorMode();

  const isOfficial = !surface.consent || surface.activeId === 'official';
  const activeSummary = surface.themes.find((t) => t.id === surface.activeId);

  // Update launcher pill dot & header active pill
  const pillDot = document.getElementById('pill-dot');
  if (pillDot) {
    const color = !isOfficial
      ? surface.accent || activeSummary?.accent || '#5B8CFF'
      : latestState?.playback.playing
        ? '#5CE0A0'
        : '#5B8CFF';
    pillDot.style.background = color;
    pillDot.style.boxShadow = `0 0 8px ${color}`;
  }

  const headerPill = document.getElementById('header-theme-pill');
  if (headerPill) {
    if (isOfficial) {
      headerPill.textContent = 'Official Stock';
    } else if (activeSummary) {
      headerPill.textContent = `${activeSummary.name} · ${activeSummary.mode === 'light' ? 'Light' : 'Dark'}`;
    } else {
      headerPill.textContent = surface.activeId;
    }
  }

  // Update counts in filter buttons
  const lightCount = surface.themes.filter((t) => t.mode === 'light').length;
  const darkCount = surface.themes.filter((t) => t.mode === 'dark').length;
  const allBtn = document.getElementById('filter-all');
  const lightBtn = document.getElementById('filter-light');
  const darkBtn = document.getElementById('filter-dark');
  if (allBtn) allBtn.textContent = `All (${surface.themes.length})`;
  if (lightBtn) lightBtn.textContent = `☀ Light (${lightCount})`;
  if (darkBtn) darkBtn.textContent = `☾ Dark (${darkCount})`;
  const badgeThemes = document.getElementById('badge-themes');
  if (badgeThemes) badgeThemes.textContent = String(surface.themes.length);

  // Official stock card state
  const officialCard = document.getElementById('official-theme-card');
  if (officialCard) {
    officialCard.setAttribute('aria-pressed', String(isOfficial));
  }

  // Sync custom accent inputs
  const hexInput = document.getElementById('accent-hex-input') as HTMLInputElement | null;
  const pickerInput = document.getElementById('accent-color-picker') as HTMLInputElement | null;
  const effectiveAccent = surface.accent || activeSummary?.accent || '#5B8CFF';
  if (hexInput && document.activeElement !== hexInput) {
    hexInput.value = surface.accent ?? '';
    hexInput.placeholder = activeSummary?.accent ?? '#5B8CFF';
  }
  if (pickerInput) {
    pickerInput.value = /^#[0-9a-f]{6}$/i.test(effectiveAccent) ? effectiveAccent : '#5B8CFF';
  }

  // Render filtered theme preview cards
  const grid = document.getElementById('surface-theme-grid');
  if (!grid) return;
  grid.replaceChildren();

  const filtered = surface.themes.filter((theme) =>
    themeFilter === 'all' ? true : theme.mode === themeFilter,
  );

  for (const theme of filtered) {
    const active = surface.consent && surface.activeId === theme.id;
    grid.appendChild(createThemePreviewCard(theme, active, surface.accent));
  }
}

function createThemePreviewCard(
  theme: SurfaceThemeSummary,
  active: boolean,
  customAccent: string | null,
): HTMLButtonElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'theme-card';
  card.dataset.themeId = theme.id;
  card.dataset.themeMode = theme.mode;
  card.setAttribute('aria-pressed', String(active));

  const displayAccent = active && customAccent ? customAccent : theme.accent;
  const mantle = theme.mantle || theme.surface;

  card.innerHTML = `
    <div class="mini-sxm-preview" style="background:${theme.bg};" aria-hidden="true">
      <div class="msp-sidebar" style="background:${mantle};">
        <span class="msp-dot" style="background:${displayAccent};opacity:1;"></span>
        <span class="msp-dot" style="background:${theme.text};"></span>
        <span class="msp-dot" style="background:${theme.text};width:55%;"></span>
      </div>
      <div class="msp-main">
        <div class="msp-cards">
          <div class="msp-card" style="background:${theme.surface};">
            <span class="msp-card-line" style="background:${theme.text};"></span>
            <span class="msp-play-dot" style="background:${displayAccent};"></span>
          </div>
          <div class="msp-card" style="background:${theme.surface};">
            <span class="msp-card-line" style="background:${theme.text};width:52%;"></span>
            <span class="msp-play-dot" style="background:${displayAccent};"></span>
          </div>
        </div>
        <div class="msp-footer" style="background:${mantle};">
          <div class="msp-progress" style="background:${displayAccent};"></div>
        </div>
      </div>
    </div>
    <div class="theme-card-meta">
      <strong class="theme-card-title"></strong>
      <span class="mode-tag ${theme.mode}">${theme.mode === 'light' ? 'LIGHT' : 'DARK'}</span>
    </div>
    <p class="theme-card-desc"></p>
    <div class="theme-swatches-row" aria-hidden="true">
      <span class="swatch-pill" style="background:${theme.bg}" title="Background ${theme.bg}"></span>
      <span class="swatch-pill" style="background:${mantle}" title="Mantle ${mantle}"></span>
      <span class="swatch-pill" style="background:${theme.surface}" title="Surface ${theme.surface}"></span>
      <span class="swatch-pill" style="background:${displayAccent}" title="Accent ${displayAccent}"></span>
    </div>
    <span class="theme-check" aria-hidden="true">✓</span>
  `;

  const titleEl = card.querySelector('.theme-card-title');
  const descEl = card.querySelector('.theme-card-desc');
  if (titleEl) titleEl.textContent = theme.name;
  if (descEl) descEl.textContent = theme.description;

  card.addEventListener('click', async () => {
    const next = await window.vegaQuick.applySurfaceTheme(theme.id);
    renderSurfaceThemes(next);
    if (next.lastError) {
      showToast('Could not apply theme — reverted to Official');
    } else if (next.pausedOnAuth) {
      showToast(`${theme.name} saved (paused on sign-in route)`);
    } else {
      showToast(`${theme.name} (${theme.mode}) applied live`);
    }
  });

  return card;
}

function renderAppState(state: AppState): void {
  latestState = state;
  if (state.surfaceTheme) {
    renderSurfaceThemes(state.surfaceTheme);
  } else {
    updateDrawerColorMode();
  }

  // Left rail live now-playing mini card
  const pb = state.playback;
  // The threshold is adaptive: it follows the song length observed on the
  // current channel, so it is never a hard-coded radio floor.
  const thresholdMs = pb.thresholdMs ?? state.settings.thresholds?.radioMinListenMs ?? 90_000;
  const pct = Math.min(100, Math.round(((pb.listeningMs ?? 0) / Math.max(1000, thresholdMs)) * 100));

  const npDot = document.getElementById('rail-np-dot');
  const npChannel = document.getElementById('rail-np-channel');
  const npTrack = document.getElementById('rail-np-track');
  const npArtist = document.getElementById('rail-np-artist');
  const npFill = document.getElementById('rail-np-bar-fill');

  if (npDot) npDot.classList.toggle('playing', pb.playing);
  if (npChannel) npChannel.textContent = pb.channel || (state.player.reachable ? 'SiriusXM Ready' : 'Loading…');
  if (npTrack) npTrack.textContent = pb.displayTitle || pb.title || 'No song active';
  if (npArtist) npArtist.textContent = pb.artist || (pb.playing ? 'Live broadcast' : 'Paused / Idle');
  if (npFill) npFill.style.width = `${pct}%`;

  // Activity Tab Live Monitor
  const actChannel = document.getElementById('act-channel');
  const actStateBadge = document.getElementById('act-state-badge');
  const actTitle = document.getElementById('act-title');
  const actArtist = document.getElementById('act-artist');
  const actArt = document.getElementById('act-art');
  const actElapsed = document.getElementById('act-elapsed-label');
  const actThreshold = document.getElementById('act-threshold-label');
  const actFill = document.getElementById('act-progress-fill');
  const actElig = document.getElementById('act-eligibility');
  const actNowPlaying = document.getElementById('act-now-playing');
  const actSource = document.getElementById('act-source');
  const actMuteBtn = document.getElementById('act-mute-channel-btn') as HTMLButtonElement | null;

  if (actChannel) actChannel.textContent = pb.channel || 'Official SiriusXM';
  if (actStateBadge) {
    actStateBadge.textContent = pb.playing ? 'Playing' : 'Idle';
    actStateBadge.className = `badge ${pb.playing ? 'ok' : ''}`;
  }
  if (actTitle) actTitle.textContent = pb.displayTitle || pb.title || 'Waiting for SiriusXM track…';
  if (actArtist) actArtist.textContent = pb.artist || pb.programme || 'Play any channel on SiriusXM';
  if (actArt) {
    if (pb.artwork) {
      actArt.style.backgroundImage = `url("${pb.artwork}")`;
      actArt.textContent = '';
    } else {
      actArt.style.backgroundImage = '';
      actArt.textContent = '♫';
    }
  }
  const listenedSec = Math.floor((pb.listeningMs ?? 0) / 1000);
  const targetSec = Math.floor(thresholdMs / 1000);
  const observed = pb.observedSongCount ?? 0;
  const trusted = pb.songEstimateTrusted !== false;
  if (actElapsed) actElapsed.textContent = `${listenedSec}s listened`;
  if (actThreshold) {
    actThreshold.textContent = trusted
      ? observed > 0
        ? `${targetSec}s scrobble threshold (adaptive · ${observed} song${observed === 1 ? '' : 's'} observed)`
        : `${targetSec}s scrobble threshold (adaptive)`
      : observed > 0
        ? `${targetSec}s scrobble threshold (learning · ${observed} song${observed === 1 ? '' : 's'} seen)`
        : `${targetSec}s scrobble threshold (adaptive · learning)`;
  }
  if (actFill) actFill.style.width = `${pct}%`;
  if (actElig) actElig.textContent = state.monitor.eligibility || '—';
  if (actNowPlaying) actNowPlaying.textContent = state.monitor.nowPlaying || '—';
  if (actSource) actSource.textContent = state.monitor.metadataSource || 'Official MediaSession';

  if (actMuteBtn) {
    const ch = pb.channel;
    const isMuted = Boolean(
      ch &&
        state.settings.scrobbleMutedChannels.some(
          (m) => m.toLowerCase() === ch.toLowerCase(),
        ),
    );
    actMuteBtn.disabled = !ch;
    actMuteBtn.textContent = isMuted ? 'Unmute Channel Scrobbling' : 'Mute Channel Scrobbling';
  }

  // Queue count
  const qCount = state.queue?.length ?? 0;
  const qCountEl = document.getElementById('queue-count-inline');
  if (qCountEl) qCountEl.textContent = String(qCount);
  if (activitySubtab === 'queue') {
    renderQueueList();
  }

  // Scrobbling Rules Tab
  const concertSelect = document.getElementById('rule-concert-select') as HTMLSelectElement | null;
  if (concertSelect && document.activeElement !== concertSelect) {
    concertSelect.value = state.settings.metadata.concertInScrobbleTitle;
  }
  const featuredCheck = document.getElementById('rule-featured-checkbox') as HTMLInputElement | null;
  if (featuredCheck) {
    featuredCheck.checked = state.settings.metadata.includeFeaturedInScrobbleArtist;
  }
  const verifiedCheck = document.getElementById('rule-verified-checkbox') as HTMLInputElement | null;
  if (verifiedCheck) {
    verifiedCheck.checked = state.settings.metadata.requireVerifiedMetadata;
  }
  const adaptiveCheck = document.getElementById('rule-adaptive-checkbox') as HTMLInputElement | null;
  if (adaptiveCheck) {
    adaptiveCheck.checked = state.settings.thresholds.radioAdaptiveEstimate !== false;
  }
  const thresholdBadge = document.getElementById('scrobble-threshold-badge');
  if (thresholdBadge) {
    const adaptive = state.settings.thresholds.radioAdaptiveEstimate !== false;
    const observed = state.playback.observedSongCount ?? 0;
    const trusted = state.playback.songEstimateTrusted !== false;
    const targetSec = Math.round(
      (state.playback.thresholdMs ?? state.settings.thresholds.radioMinListenMs ?? 90_000) / 1000,
    );
    thresholdBadge.textContent = !adaptive
      ? `${targetSec}s · flat floor`
      : trusted
        ? `${targetSec}s · adaptive${observed > 0 ? ` · ${observed} song${observed === 1 ? '' : 's'} observed` : ''}`
        : `${targetSec}s · adaptive · learning${observed > 0 ? ` (${observed})` : ''}`;
  }
  const adaptiveHint = document.getElementById('scrobble-adaptive-hint');
  if (adaptiveHint) {
    const adaptive = state.settings.thresholds.radioAdaptiveEstimate !== false;
    adaptiveHint.textContent = adaptive
      ? ''
      : 'Off: a flat floor of ' +
          Math.round(state.settings.thresholds.radioMinListenMs / 1000) +
          's is used for every song.';
  }
  renderMutedChannels(state.settings.scrobbleMutedChannels);
  renderChannelMappings(state.settings.metadata.channelMappings);
  renderArtistAliases(state.settings.metadata.artistAliases ?? {});
  renderManualCorrections(state.settings.metadata.manualCorrections);

  // Accounts Tab
  const sxmBadge = document.getElementById('acc-sxm-badge');
  if (sxmBadge) {
    if (state.player.authRequired) {
      sxmBadge.textContent = 'Sign-In Required';
      sxmBadge.className = 'badge warn';
    } else if (state.player.reachable) {
      sxmBadge.textContent = 'Connected';
      sxmBadge.className = 'badge ok';
    } else {
      sxmBadge.textContent = state.player.loadState;
      sxmBadge.className = 'badge';
    }
  }
  const bridgeCheck = document.getElementById('acc-media-bridge-checkbox') as HTMLInputElement | null;
  if (bridgeCheck) bridgeCheck.checked = state.settings.mediaBridgeConsent;

  const lbBadge = document.getElementById('acc-lb-badge');
  const lbEnabled = document.getElementById('acc-lb-enabled') as HTMLInputElement | null;
  if (lbEnabled) lbEnabled.checked = state.settings.listenbrainzEnabled;
  if (lbBadge) {
    const lb = state.services.listenbrainz;
    lbBadge.textContent = lb.authorized
      ? `Connected${lb.account ? ` · ${lb.account}` : ''}`
      : lb.configured
        ? 'Configured'
        : 'Not connected';
    lbBadge.className = `badge ${lb.authorized ? 'ok' : ''}`;
  }

  const lfmBadge = document.getElementById('acc-lfm-badge');
  const lfmEnabled = document.getElementById('acc-lfm-enabled') as HTMLInputElement | null;
  if (lfmEnabled) lfmEnabled.checked = state.settings.lastfmEnabled;
  applySyncedField('acc-lfm-key', state.settings.lastfmApiKey || '');

  const lfm = state.services.lastfm;
  if (lfmBadge) {
    lfmBadge.textContent = lfm.authorized
      ? `Connected${lfm.account ? ` · ${lfm.account}` : ''}`
      : lfmConnectionLabel(lfm.connectionState);
    lfmBadge.className = `badge ${lfm.authorized ? 'ok' : ''}`;
  }

  const lfmAccount = document.getElementById('acc-lfm-account');
  const lfmUsername = document.getElementById('acc-lfm-username');
  if (lfmAccount) lfmAccount.hidden = !lfm.authorized || !lfm.account;
  if (lfmUsername) lfmUsername.textContent = lfm.account ?? '';

  const lfmHint = document.getElementById('acc-lfm-hint');
  if (lfmHint) {
    const source =
      lfm.credentialSource === 'build'
        ? 'VegaAM uses its built-in Last.fm application credentials - you never have to enter a key.'
        : lfm.credentialSource === 'user'
          ? 'VegaAM uses your own Last.fm API key. The shared secret is stored in your system keychain.'
          : lfm.lastError ?? '';
    lfmHint.textContent = source;
    lfmHint.dataset.tone = lfm.lastError ? 'error' : 'info';
    lfmHint.hidden = !source;
  }

  // While the authorization is pending, offer the page again - the browser
  // may not have opened, or the user may want to approve in another browser.
  const authLink = document.getElementById('acc-lfm-auth-link');
  if (authLink) {
    const pending = lfm.connectionState === 'awaiting-authorization' && Boolean(lfm.authUrl);
    authLink.hidden = !pending;
    authLink.dataset.authUrl = pending ? (lfm.authUrl ?? '') : '';
  }

  const accountsDot = document.getElementById('badge-accounts-dot');
  if (accountsDot) {
    accountsDot.classList.toggle(
      'ok',
      Boolean(state.services.listenbrainz.authorized || state.services.lastfm.authorized),
    );
  }

  // Credential storage diagnostics (which OS key store protects the session)
  const credentialsBadge = document.getElementById('about-credentials-badge');
  const credentialsDetail = document.getElementById('about-credentials-detail');
  if (credentialsBadge && state.credentials) {
    credentialsBadge.textContent = state.credentials.strong
      ? 'Protected'
      : state.credentials.available
        ? 'Weak backend'
        : 'Not persistent';
    credentialsBadge.className = `badge ${state.credentials.strong ? 'ok' : 'warn'}`;
  }
  if (credentialsDetail && state.credentials) {
    credentialsDetail.textContent = state.credentials.detail;
  }

  // Companions & Desktop Tab
  const closeTray = document.getElementById('desk-close-tray') as HTMLInputElement | null;
  const alwaysTop = document.getElementById('desk-always-top') as HTMLInputElement | null;
  const notifyTrack = document.getElementById('desk-notify-track') as HTMLInputElement | null;
  const notifyScrobble = document.getElementById('desk-notify-scrobble') as HTMLInputElement | null;
  const startLogin = document.getElementById('desk-start-login') as HTMLInputElement | null;
  if (closeTray) closeTray.checked = state.settings.closeToTray;
  if (alwaysTop) alwaysTop.checked = state.settings.alwaysOnTop;
  if (notifyTrack) notifyTrack.checked = state.settings.notificationsEnabled;
  if (notifyScrobble) notifyScrobble.checked = state.settings.notifyOnScrobble;
  if (startLogin) startLogin.checked = state.settings.startAtLogin;
}

async function refreshHistory(): Promise<void> {
  try {
    historyItems = await window.sxm.history();
    const countBadge = document.getElementById('badge-history');
    const inlineCount = document.getElementById('history-count-inline');
    if (countBadge) countBadge.textContent = String(historyItems.length);
    if (inlineCount) inlineCount.textContent = String(historyItems.length);
    renderHistoryList();
  } catch {
    /* ignore */
  }
}

function renderHistoryList(): void {
  const container = document.getElementById('history-view-container');
  if (!container) return;
  container.replaceChildren();

  const searchInput = document.getElementById('history-search') as HTMLInputElement | null;
  const query = (searchInput?.value ?? '').trim().toLowerCase();

  const filtered = historyItems.filter((item) => {
    if (!query) return true;
    return (
      (item.title && item.title.toLowerCase().includes(query)) ||
      (item.artist && item.artist.toLowerCase().includes(query)) ||
      (item.channel && item.channel.toLowerCase().includes(query))
    );
  });

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'studio-card';
    empty.textContent = query
      ? 'No history entries match your filter.'
      : 'No tracks recorded in history yet.';
    container.appendChild(empty);
    return;
  }

  for (const entry of filtered.slice(0, 80)) {
    const row = document.createElement('div');
    row.className = 'history-row';

    const main = document.createElement('div');
    main.className = 'history-row-main';

    const title = document.createElement('div');
    title.className = 'history-row-title';
    title.textContent = entry.artist ? `${entry.artist} — ${entry.title}` : entry.title;

    const sub = document.createElement('div');
    sub.className = 'history-row-sub';
    const timeStr = new Date(entry.startedAt).toLocaleString();
    sub.textContent = `${entry.channel || 'SiriusXM'} · ${timeStr} · ${entry.reason || ''}`;

    main.append(title, sub);

    const right = document.createElement('div');
    right.className = 'history-row-right';

    const badge = document.createElement('span');
    badge.className = `badge ${entry.scrobbled ? 'ok' : ''}`;
    badge.textContent = entry.scrobbled ? 'Scrobbled' : 'Recorded';
    right.appendChild(badge);

    if (entry.artist) {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn btn-subtle btn-sm';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', async () => {
        const res = await window.sxm.retryHistory(entry.id);
        showToast(res.detail);
        void refreshHistory();
      });
      right.appendChild(retryBtn);
    }

    const fixBtn = document.createElement('button');
    fixBtn.type = 'button';
    fixBtn.className = 'btn btn-subtle btn-sm';
    fixBtn.textContent = 'Fix tagging';
    fixBtn.title = 'Correct the artist and title of this track';
    fixBtn.addEventListener('click', () => {
      prefillCorrection({
        rawArtist: entry.rawArtist,
        rawTitle: entry.rawTitle,
        artist: entry.artist,
        title: entry.title,
      });
    });
    right.appendChild(fixBtn);

    row.append(main, right);
    container.appendChild(row);
  }
}

function renderQueueList(): void {
  const container = document.getElementById('queue-view-container');
  if (!container || !latestState) return;
  container.replaceChildren();

  const items = latestState.queue ?? [];
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'studio-card';
    empty.textContent = 'Offline retry queue is empty.';
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-row';

    const main = document.createElement('div');
    main.className = 'history-row-main';
    const title = document.createElement('div');
    title.className = 'history-row-title';
    title.textContent = `${item.artist} — ${item.title}`;
    const sub = document.createElement('div');
    sub.className = 'history-row-sub';
    sub.textContent = `${item.service} · ${item.state}${item.lastError ? ` · ${item.lastError}` : ''}`;
    main.append(title, sub);

    const right = document.createElement('div');
    right.className = 'history-row-right';

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-subtle btn-sm';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', async () => {
      await window.sxm.retryQueueItem(item.id);
      showToast('Retrying queued item…');
    });

    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'btn btn-subtle btn-sm danger-text';
    rmBtn.textContent = 'Remove';
    rmBtn.addEventListener('click', async () => {
      await window.sxm.removeQueueItem(item.id);
      showToast('Removed from queue');
    });

    right.append(retryBtn, rmBtn);
    row.append(main, right);
    container.appendChild(row);
  }
}

function renderMutedChannels(channels: string[]): void {
  const container = document.getElementById('muted-channels-list');
  if (!container) return;
  container.replaceChildren();

  for (const ch of channels) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const span = document.createElement('span');
    span.textContent = ch;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.title = `Unmute ${ch}`;
    btn.addEventListener('click', async () => {
      await window.sxm.toggleMuted(ch);
      showToast(`Unmuted ${ch}`);
    });
    chip.append(span, btn);
    container.appendChild(chip);
  }
}

function renderChannelMappings(
  mappings: { channel: string; artist: string; disabled?: boolean }[],
): void {
  const container = document.getElementById('channel-mappings-list');
  if (!container) return;
  container.replaceChildren();

  for (const m of mappings.slice(0, 40)) {
    const item = document.createElement('div');
    item.className = 'rule-item';
    const text = document.createElement('span');
    text.textContent = `${m.channel} → ${m.artist}`;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-subtle btn-sm';
    delBtn.textContent = 'Remove';
    delBtn.addEventListener('click', async () => {
      if (!latestState) return;
      const next = latestState.settings.metadata.channelMappings.filter(
        (x) => x.channel.toLowerCase() !== m.channel.toLowerCase(),
      );
      await window.sxm.patchSettings({
        metadata: { ...latestState.settings.metadata, channelMappings: next },
      });
      showToast(`Removed mapping for ${m.channel}`);
    });
    item.append(text, delBtn);
    container.appendChild(item);
  }
}

function renderArtistAliases(aliases: Record<string, string>): void {
  const container = document.getElementById('artist-aliases-list');
  if (!container) return;
  container.replaceChildren();

  const entries = Object.entries(aliases ?? {});
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'field-hint';
    empty.textContent = 'No artist aliases configured.';
    container.appendChild(empty);
    return;
  }

  for (const [alias, canonical] of entries) {
    const item = document.createElement('div');
    item.className = 'rule-item';
    const text = document.createElement('span');
    text.textContent = `${alias} → ${canonical}`;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-subtle btn-sm';
    delBtn.textContent = 'Remove';
    delBtn.addEventListener('click', async () => {
      if (!latestState) return;
      const next = { ...(latestState.settings.metadata.artistAliases ?? {}) };
      delete next[alias];
      await window.sxm.patchSettings({
        metadata: { ...latestState.settings.metadata, artistAliases: next },
      });
      showToast(`Removed alias for ${alias}`);
    });
    item.append(text, delBtn);
    container.appendChild(item);
  }
}

function renderManualCorrections(
  corrections: Record<string, { artist?: string; title?: string; album?: string }>,
): void {
  const container = document.getElementById('manual-corrections-list');
  if (!container) return;
  container.replaceChildren();

  const entries = Object.entries(corrections ?? {});
  for (const [key, val] of entries) {
    const item = document.createElement('div');
    item.className = 'rule-item';
    const text = document.createElement('span');
    text.textContent = `${key} → ${[val.artist, val.title, val.album].filter(Boolean).join(' — ')}`;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-subtle btn-sm';
    delBtn.textContent = 'Remove';
    delBtn.addEventListener('click', async () => {
      await window.sxm.correctMetadata({ remove: true, key });
      showToast('Removed manual correction');
    });
    item.append(text, delBtn);
    container.appendChild(item);
  }
}

async function refreshDiagnostics(): Promise<void> {
  const pre = document.getElementById('about-diag-pre');
  if (!pre) return;
  try {
    const diag = await window.vegaQuick.getSurfaceDiagnostics();
    pre.textContent = JSON.stringify(diag, null, 2);
  } catch (err) {
    pre.textContent = String(err);
  }
}

// ============================================================================
// Wire DOM Events
// ============================================================================

// Launcher pill opens the drawer
document.getElementById('launcher-pill')?.addEventListener('click', () => {
  void window.vegaQuick.openPanel(activeTab);
});

// Close button collapses the drawer back to the pill
document.getElementById('drawer-close-btn')?.addEventListener('click', () => {
  void window.vegaQuick.closePanel();
});

// Rail navigation tabs
for (const tab of RAIL_TABS) {
  document.getElementById(`nav-${tab}`)?.addEventListener('click', () => {
    switchTab(tab);
  });
}

// Arrow key navigation inside the tab list (ARIA tab pattern)
document.getElementById('rail-nav')?.addEventListener('keydown', (event) => {
  const key = event.key;
  if (
    key !== 'ArrowDown' &&
    key !== 'ArrowUp' &&
    key !== 'ArrowLeft' &&
    key !== 'ArrowRight' &&
    key !== 'Home' &&
    key !== 'End'
  ) {
    return;
  }
  const current = RAIL_TABS.indexOf(activeTab);
  if (current === -1) return;

  let next = current;
  if (key === 'ArrowDown' || key === 'ArrowRight') {
    next = (current + 1) % RAIL_TABS.length;
  } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
    next = (current - 1 + RAIL_TABS.length) % RAIL_TABS.length;
  } else if (key === 'Home') {
    next = 0;
  } else {
    next = RAIL_TABS.length - 1;
  }

  event.preventDefault();
  const target = RAIL_TABS[next] ?? RAIL_TABS[0]!;
  switchTab(target);
  document.getElementById(`nav-${target}`)?.focus();
});

// Rail now-playing card jumps to Activity tab
document.getElementById('rail-now-playing')?.addEventListener('click', () => {
  switchTab('activity');
});

// Header Reset to Official button
document.getElementById('header-reset-btn')?.addEventListener('click', async () => {
  const next = await window.vegaQuick.revertSurfaceTheme();
  renderSurfaceThemes(next);
  showToast('Official SiriusXM appearance restored');
});

// Official Stock Banner Card
document.getElementById('official-theme-card')?.addEventListener('click', async () => {
  const next = await window.vegaQuick.revertSurfaceTheme();
  renderSurfaceThemes(next);
  showToast('Official SiriusXM appearance restored');
});

// Theme Mode Filters (All / Light / Dark)
for (const mode of ['all', 'light', 'dark'] as const) {
  document.getElementById(`filter-${mode}`)?.addEventListener('click', () => {
    themeFilter = mode;
    for (const m of ['all', 'light', 'dark'] as const) {
      document.getElementById(`filter-${m}`)?.classList.toggle('active', m === mode);
    }
    if (latestSurface) renderSurfaceThemes(latestSurface);
  });
}

// Drawer / Companion UI Mode (Dark / Light / Auto)
for (const mode of ['dark', 'light', 'system'] as const) {
  document.getElementById(`ui-mode-${mode}`)?.addEventListener('click', async () => {
    await window.sxm.patchSettings({ colorMode: mode });
    showToast(`Panel & companion UI set to ${mode}`);
  });
}

// Custom Accent Colour Controls
const applyAccentHex = async (hex: string | null) => {
  const targetId =
    latestSurface && latestSurface.activeId !== 'official' ? latestSurface.activeId : 'vega';
  try {
    const next = await window.vegaQuick.applyCustomAccent(targetId, hex);
    renderSurfaceThemes(next);
    showToast(hex ? `Custom accent ${hex.toUpperCase()} applied` : 'Restored theme default accent');
  } catch {
    showToast('Enter a valid #RRGGBB hex colour');
  }
};

document.getElementById('accent-color-picker')?.addEventListener('input', (event) => {
  const val = (event.target as HTMLInputElement).value.toUpperCase();
  const hexInput = document.getElementById('accent-hex-input') as HTMLInputElement | null;
  if (hexInput) hexInput.value = val;
});

document.getElementById('accent-color-picker')?.addEventListener('change', (event) => {
  const val = (event.target as HTMLInputElement).value.toUpperCase();
  void applyAccentHex(val);
});

document.getElementById('accent-apply-btn')?.addEventListener('click', () => {
  const hexInput = document.getElementById('accent-hex-input') as HTMLInputElement | null;
  const picker = document.getElementById('accent-color-picker') as HTMLInputElement | null;
  const raw = hexInput?.value.trim() || picker?.value || '';
  void applyAccentHex(raw);
});

document.getElementById('accent-reset-btn')?.addEventListener('click', () => {
  void applyAccentHex(null);
});

document.querySelectorAll<HTMLButtonElement>('.accent-dot').forEach((btn) => {
  btn.addEventListener('click', () => {
    const hex = btn.dataset.accent;
    if (hex) void applyAccentHex(hex);
  });
});

// Inline disclosure links
document.getElementById('link-about-disclosure')?.addEventListener('click', () => {
  switchTab('about');
});

document.getElementById('btn-disable-themes')?.addEventListener('click', async () => {
  const next = await window.vegaQuick.setSurfaceConsent(false);
  renderSurfaceThemes(next);
  showToast('Custom surface themes disabled & reset to Official');
});

// Activity Tab controls
document.getElementById('act-fix-btn')?.addEventListener('click', () => {
  const pb = latestState?.playback;
  if (!pb) return;
  prefillCorrection({
    rawArtist: pb.rawArtist,
    rawTitle: pb.rawTitle,
    artist: pb.artist,
    title: pb.title,
  });
});

document.getElementById('act-mute-channel-btn')?.addEventListener('click', async () => {
  const ch = latestState?.playback.channel;
  if (!ch) return;
  await window.sxm.toggleMuted(ch);
  showToast(`Updated scrobble mute for ${ch}`);
});

document.getElementById('subtab-history-btn')?.addEventListener('click', () => {
  activitySubtab = 'history';
  document.getElementById('subtab-history-btn')?.classList.add('active');
  document.getElementById('subtab-queue-btn')?.classList.remove('active');
  const hView = document.getElementById('history-view-container');
  const qView = document.getElementById('queue-view-container');
  if (hView) hView.hidden = false;
  if (qView) qView.hidden = true;
  renderHistoryList();
});

document.getElementById('subtab-queue-btn')?.addEventListener('click', () => {
  activitySubtab = 'queue';
  document.getElementById('subtab-queue-btn')?.classList.add('active');
  document.getElementById('subtab-history-btn')?.classList.remove('active');
  const hView = document.getElementById('history-view-container');
  const qView = document.getElementById('queue-view-container');
  if (hView) hView.hidden = true;
  if (qView) qView.hidden = false;
  renderQueueList();
});

document.getElementById('history-search')?.addEventListener('input', () => {
  renderHistoryList();
});

document.getElementById('history-refresh-btn')?.addEventListener('click', () => {
  void refreshHistory();
  showToast('History refreshed');
});

document.getElementById('history-clear-btn')?.addEventListener('click', async () => {
  await window.sxm.clearHistory();
  await refreshHistory();
  showToast('Scrobble history cleared');
});

// Scrobbling Rules Tab controls
document.getElementById('rule-concert-select')?.addEventListener('change', async (e) => {
  if (!latestState) return;
  const val = (e.target as HTMLSelectElement).value as 'always' | 'when-known' | 'never';
  await window.sxm.patchSettings({
    metadata: { ...latestState.settings.metadata, concertInScrobbleTitle: val },
  });
  showToast('Updated concert title preference');
});

document.getElementById('rule-featured-checkbox')?.addEventListener('change', async (e) => {
  if (!latestState) return;
  const checked = (e.target as HTMLInputElement).checked;
  await window.sxm.patchSettings({
    metadata: { ...latestState.settings.metadata, includeFeaturedInScrobbleArtist: checked },
  });
  showToast('Updated featured artist rule');
});

document.getElementById('rule-verified-checkbox')?.addEventListener('change', async (e) => {
  if (!latestState) return;
  const checked = (e.target as HTMLInputElement).checked;
  await window.sxm.patchSettings({
    metadata: { ...latestState.settings.metadata, requireVerifiedMetadata: checked },
  });
  showToast('Updated verification requirement');
});

document.getElementById('rule-adaptive-checkbox')?.addEventListener('change', async (e) => {
  if (!latestState) return;
  const checked = (e.target as HTMLInputElement).checked;
  await window.sxm.patchSettings({
    thresholds: { ...latestState.settings.thresholds, radioAdaptiveEstimate: checked },
  });
  showToast(
    checked
      ? 'Threshold now follows the song length of the channel'
      : 'Threshold now uses the flat radio floor',
  );
});

document.getElementById('mute-channel-add-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('mute-channel-input') as HTMLInputElement | null;
  const val = input?.value.trim();
  if (!val) return;
  await window.sxm.toggleMuted(val);
  if (input) input.value = '';
  showToast(`Muted channel "${val}"`);
});

document.getElementById('map-add-btn')?.addEventListener('click', async () => {
  if (!latestState) return;
  const chIn = document.getElementById('map-channel-input') as HTMLInputElement | null;
  const arIn = document.getElementById('map-artist-input') as HTMLInputElement | null;
  const channel = chIn?.value.trim() ?? '';
  const artist = arIn?.value.trim() ?? '';
  if (!channel || !artist) {
    showToast('Enter both channel name and default artist');
    return;
  }
  const existing = latestState.settings.metadata.channelMappings.filter(
    (m) => m.channel.toLowerCase() !== channel.toLowerCase(),
  );
  await window.sxm.patchSettings({
    metadata: {
      ...latestState.settings.metadata,
      channelMappings: [{ channel, artist }, ...existing],
    },
  });
  if (chIn) chIn.value = '';
  if (arIn) arIn.value = '';
  showToast(`Mapped ${channel} → ${artist}`);
});

/**
 * Fill the correction form with a track and jump to the Scrobbling tab.
 *
 * The broadcast strings are the exact ones a correction is keyed on, so the
 * user never has to reproduce them by hand.
 */
function prefillCorrection(input: {
  rawArtist?: string | null;
  rawTitle?: string | null;
  artist?: string | null;
  title?: string | null;
}): void {
  const set = (id: string, value: string): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    el.value = value;
    draftFields.type(id, value);
  };
  set('corr-raw-artist', input.rawArtist ?? '');
  set('corr-raw-title', input.rawTitle ?? '');
  set('corr-new-artist', input.artist ?? '');
  set('corr-new-title', input.title ?? '');
  switchTab('scrobbling');
  showToast('Correction filled in — adjust the values, then save');
}

/** Copy the system clipboard into a text field. */
async function pasteIntoField(id: string): Promise<void> {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return;
  let text = '';
  try {
    text = await window.sxm.readClipboard();
  } catch {
    text = '';
  }
  if (!text) {
    showToast('The clipboard is empty');
    return;
  }
  input.value = text.trim();
  draftFields.type(id, input.value);
  input.focus();
  showToast('Pasted from the clipboard');
}

document.getElementById('alias-add-btn')?.addEventListener('click', async () => {
  if (!latestState) return;
  const aliasIn = document.getElementById('alias-artist-input') as HTMLInputElement | null;
  const canonicalIn = document.getElementById('alias-canonical-input') as HTMLInputElement | null;
  const alias = aliasIn?.value.trim() ?? '';
  const canonical = canonicalIn?.value.trim() ?? '';
  if (!alias || !canonical) {
    showToast('Enter both the broadcast artist and the artist to scrobble');
    return;
  }
  const key = lookupKey(alias);
  if (!key) {
    showToast('That artist name cannot be used as an alias');
    return;
  }
  await window.sxm.patchSettings({
    metadata: {
      ...latestState.settings.metadata,
      artistAliases: {
        ...(latestState.settings.metadata.artistAliases ?? {}),
        [key]: canonical,
      },
    },
  });
  if (aliasIn) aliasIn.value = '';
  if (canonicalIn) canonicalIn.value = '';
  showToast(`Aliased ${alias} → ${canonical}`);
});

document.getElementById('corr-save-btn')?.addEventListener('click', async () => {
  const rawArtist =
    (document.getElementById('corr-raw-artist') as HTMLInputElement | null)?.value.trim() || null;
  const rawTitle =
    (document.getElementById('corr-raw-title') as HTMLInputElement | null)?.value.trim() || null;
  const artist =
    (document.getElementById('corr-new-artist') as HTMLInputElement | null)?.value.trim() || '';
  const title =
    (document.getElementById('corr-new-title') as HTMLInputElement | null)?.value.trim() || '';
  const album =
    (document.getElementById('corr-new-album') as HTMLInputElement | null)?.value.trim() || '';
  const res = await window.sxm.correctMetadata({ rawArtist, rawTitle, artist, title, album });
  showToast(res.detail);
});

// Accounts Tab controls
document.getElementById('acc-media-bridge-checkbox')?.addEventListener('change', async (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  await window.sxm.patchSettings({ mediaBridgeConsent: checked });
  showToast(checked ? 'MediaSession bridge enabled' : 'MediaSession bridge paused');
});

document.getElementById('acc-sxm-reload-btn')?.addEventListener('click', async () => {
  await window.sxm.reloadPlayer();
  showToast('Reloading official SiriusXM player…');
});

document.getElementById('acc-sxm-clear-btn')?.addEventListener('click', async () => {
  await window.sxm.clearPlayerSession();
  showToast('SiriusXM session cleared');
});

document.getElementById('acc-lb-enabled')?.addEventListener('change', async (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  await window.sxm.patchSettings({ listenbrainzEnabled: checked });
  showToast(checked ? 'ListenBrainz enabled' : 'ListenBrainz disabled');
});

document.getElementById('acc-lb-paste-btn')?.addEventListener('click', () => {
  void pasteIntoField('acc-lb-token');
});

document.getElementById('acc-lfm-key-paste-btn')?.addEventListener('click', () => {
  void pasteIntoField('acc-lfm-key');
});

document.getElementById('acc-lfm-secret-paste-btn')?.addEventListener('click', () => {
  void pasteIntoField('acc-lfm-secret');
});

document.getElementById('acc-lb-save-btn')?.addEventListener('click', async () => {
  const tokenIn = document.getElementById('acc-lb-token') as HTMLInputElement | null;
  const token = tokenIn?.value.trim() ?? '';
  if (!token) {
    showToast('Enter your ListenBrainz user token');
    return;
  }
  const status = await window.sxm.connectListenbrainz(token);
  await window.sxm.patchSettings({ listenbrainzEnabled: true });
  if (tokenIn) tokenIn.value = '';
  showToast(status.authorized ? `Connected to ListenBrainz (${status.account || 'OK'})` : 'Token check failed');
});

document.getElementById('acc-lb-disconnect-btn')?.addEventListener('click', async () => {
  await window.sxm.disconnectListenbrainz();
  showToast('ListenBrainz disconnected');
});

document.getElementById('acc-lfm-enabled')?.addEventListener('change', async (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  await window.sxm.patchSettings({ lastfmEnabled: checked });
  showToast(checked ? 'Last.fm enabled' : 'Last.fm disabled');
});

/** Persist the API key the user typed (the settings file, not a secret). */
async function persistLastFmKey(): Promise<void> {
  const value = draftFields.commit('acc-lfm-key');
  if (value === null) return;
  try {
    await window.sxm.saveLastfmCredentials({ apiKey: value });
    draftFields.confirm('acc-lfm-key', value);
  } catch {
    draftFields.reject('acc-lfm-key');
    showToast('Could not save the Last.fm API key');
  }
}

/**
 * Persist the shared secret the user typed.
 *
 * The secret is written to the operating system keychain, never to the
 * settings file, and the input is cleared afterwards.
 */
async function persistLastFmSecret(): Promise<void> {
  const value = draftFields.commit('acc-lfm-secret');
  if (value === null) return;
  try {
    await window.sxm.saveLastfmCredentials({ apiSecret: value });
    draftFields.confirm('acc-lfm-secret', '');
    const input = document.getElementById('acc-lfm-secret') as HTMLInputElement | null;
    if (input) input.value = '';
    showToast('Shared secret stored in your system keychain');
  } catch {
    draftFields.reject('acc-lfm-secret');
    showToast('Could not store the Last.fm shared secret');
  }
}

document.getElementById('acc-lfm-key')?.addEventListener('blur', () => {
  void persistLastFmKey();
});
document.getElementById('acc-lfm-key')?.addEventListener('change', () => {
  void persistLastFmKey();
});
document.getElementById('acc-lfm-secret')?.addEventListener('blur', () => {
  void persistLastFmSecret();
});
document.getElementById('acc-lfm-secret')?.addEventListener('change', () => {
  void persistLastFmSecret();
});
trackFieldInput('acc-lfm-key');
trackFieldInput('acc-lfm-secret');

document.getElementById('acc-lfm-save-btn')?.addEventListener('click', async () => {
  await persistLastFmKey();
  await persistLastFmSecret();
  showToast('Last.fm credentials saved');
});

document.getElementById('acc-lfm-connect-btn')?.addEventListener('click', async () => {
  // Whatever the user typed is stored first, so the authorization uses it.
  await persistLastFmKey();
  await persistLastFmSecret();
  showToast('Approve the Last.fm request in your browser…');
  const status = await window.sxm.connectLastfm({});
  if (status.authorized) {
    showToast(`Connected to Last.fm${status.account ? ` (${status.account})` : ''}`);
  } else if (status.lastError) {
    showToast(status.lastError);
  }
});

document.getElementById('acc-lfm-auth-link')?.addEventListener('click', async () => {
  const url = (document.getElementById('acc-lfm-auth-link') as HTMLElement | null)?.dataset
    .authUrl;
  if (!url) return;
  // The page is opened in the system browser - never in an Electron popup.
  await window.sxm.openExternal(url);
});

document.getElementById('acc-lfm-disconnect-btn')?.addEventListener('click', async () => {
  await window.sxm.disconnectLastfm();
  showToast('Last.fm disconnected');
});

document.getElementById('acc-test-services-btn')?.addEventListener('click', async () => {
  await window.sxm.testServices();
  showToast('Verified scrobbling service connections');
});

// Companions & Desktop Tab controls
document.getElementById('comp-open-compact')?.addEventListener('click', async () => {
  const open = await window.vegaQuick.toggleCompact();
  showToast(open ? 'Compact mini-player opened' : 'Compact mini-player closed');
});

document.querySelectorAll<HTMLButtonElement>('.companion-card[data-skin]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const skin = btn.dataset.skin;
    if (!skin) return;
    await window.vegaQuick.toggleSkin(skin);
    showToast(`Opened ${skin} companion window`);
  });
});

document.getElementById('comp-import-json-btn')?.addEventListener('click', async () => {
  const res = await window.sxm.importThemeFile();
  if (!res.canceled) {
    showToast(res.ok ? 'Companion theme imported' : res.errors?.[0] || 'Import failed');
  }
});

document.getElementById('comp-export-json-btn')?.addEventListener('click', async () => {
  const skinId = latestState?.settings.skinId || 'modern';
  const res = await window.sxm.exportThemeFile(skinId);
  if (!res.canceled) {
    showToast(res.ok ? 'Companion theme exported' : 'Export failed');
  }
});

document.getElementById('desk-close-tray')?.addEventListener('change', async (e) => {
  await window.sxm.patchSettings({ closeToTray: (e.target as HTMLInputElement).checked });
});
document.getElementById('desk-always-top')?.addEventListener('change', async (e) => {
  await window.sxm.patchSettings({ alwaysOnTop: (e.target as HTMLInputElement).checked });
});
document.getElementById('desk-notify-track')?.addEventListener('change', async (e) => {
  await window.sxm.patchSettings({ notificationsEnabled: (e.target as HTMLInputElement).checked });
});
document.getElementById('desk-notify-scrobble')?.addEventListener('change', async (e) => {
  await window.sxm.patchSettings({ notifyOnScrobble: (e.target as HTMLInputElement).checked });
});
document.getElementById('desk-start-login')?.addEventListener('change', async (e) => {
  await window.sxm.patchSettings({ startAtLogin: (e.target as HTMLInputElement).checked });
});

// About & Help Tab controls
document.getElementById('about-clean-shortcuts-btn')?.addEventListener('click', async () => {
  const res = await window.sxm.cleanupLegacyShortcuts();
  showToast(
    res.removed.length > 0
      ? `Removed ${res.removed.length} obsolete shortcut(s)`
      : 'No obsolete shortcuts found — the V-star identity is clean',
  );
});

document.getElementById('about-refresh-icons-btn')?.addEventListener('click', async () => {
  await window.sxm.refreshIconCache();
  showToast('Windows icon cache refreshed');
});

document.getElementById('about-refresh-diag-btn')?.addEventListener('click', () => {
  void refreshDiagnostics();
  showToast('Diagnostics refreshed');
});

document.getElementById('about-copy-diag-btn')?.addEventListener('click', async () => {
  const pre = document.getElementById('about-diag-pre');
  if (pre?.textContent) {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      showToast('Diagnostics JSON copied to clipboard');
    } catch {
      showToast('Diagnostics ready above');
    }
  }
});

// Keyboard accessibility: Escape closes drawer; Tab cycles within open drawer
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.dataset.drawerState === 'open') {
    event.preventDefault();
    void window.vegaQuick.closePanel();
    return;
  }
  if (event.key === 'Tab' && document.body.dataset.drawerState === 'open') {
    const shell = document.getElementById('drawer-shell');
    if (!shell) return;
    const focusables = Array.from(
      shell.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.closest('[hidden]') && el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

// Subscribe to IPC updates
window.vegaQuick.onDrawerState((drawerState) => {
  setDrawerState(drawerState);
});

window.vegaQuick.onTab((tab) => {
  switchTab(tab);
});

window.vegaQuick.onFilter((mode) => {
  themeFilter = mode;
  for (const m of ['all', 'light', 'dark'] as const) {
    document.getElementById(`filter-${m}`)?.classList.toggle('active', m === mode);
  }
  if (latestSurface) renderSurfaceThemes(latestSurface);
});

window.vegaQuick.onSurfaceTheme((surface) => {
  renderSurfaceThemes(surface);
});

window.vegaQuick.onState((state) => {
  renderAppState(state);
});

// Initial bootstrap
void Promise.all([
  window.vegaQuick.getDrawerState(),
  window.vegaQuick.getSurfaceTheme(),
  window.vegaQuick.getState(),
  window.sxm.history(),
])
  .then(([drawerState, surface, appState, hist]) => {
    historyItems = hist;
    const countBadge = document.getElementById('badge-history');
    const inlineCount = document.getElementById('history-count-inline');
    if (countBadge) countBadge.textContent = String(hist.length);
    if (inlineCount) inlineCount.textContent = String(hist.length);

    renderAppState(appState);
    renderSurfaceThemes(surface);
    setDrawerState(drawerState);
  })
  .catch(() => {
    showToast('Could not initialize VegaAM studio drawer');
  });
