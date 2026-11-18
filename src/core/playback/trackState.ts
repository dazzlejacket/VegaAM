/**
 * Central playback state engine.
 *
 * Scrobbling must be based on *actual* listening, not on the broadcast
 * playlist of a channel. This engine therefore keeps track of
 *
 *   - the current raw metadata and its normalised form,
 *   - the accumulated listening time (paused and buffering time excluded),
 *   - confirmed song boundaries (metadata change or channel switch),
 *   - the thresholds that have to be reached before a track is scrobbled.
 *
 * The engine is pure: it has no Electron or network dependency and can be
 * driven by synthetic events in tests.
 */

import { normalizeMetadata } from '../metadata/normalizer';
import type { MetadataConfig, NormalizedTrack, RawMetadata } from '../metadata/types';
import type { ScrobbleThresholds } from '../settings/defaults';

export type PlaybackEvent =
  | { type: 'metadata'; raw: RawMetadata; at: number }
  | { type: 'state'; playing: boolean; buffering: boolean; at: number }
  | { type: 'channel'; channel: string | null; at: number }
  | { type: 'tick'; at: number };

export interface TrackState {
  /** The raw metadata as reported by the player. */
  raw: RawMetadata;
  /** The normalised metadata. */
  normalized: NormalizedTrack;
  /** Epoch ms when the track started playing. */
  startedAt: number;
  /** Accumulated listening time in milliseconds. */
  listeningMs: number;
  /** Epoch ms of the last event that touched this track. */
  lastEventAt: number;
  /** True once a song boundary was confirmed for this track. */
  boundaryConfirmed: boolean;
  /** True when the track was already submitted. */
  scrobbled: boolean;
  /** Why the track was (not) scrobbled. */
  scrobbleReason?: string;
  /** Known duration of the track in milliseconds (when the player reports it). */
  durationMs?: number;
  /**
   * Epoch ms when this song slot started.
   *
   * Unlike `startedAt` this anchor is never moved by a pause/resume, so it
   * always describes the slot the song occupied on the channel.
   */
  slotStartedAt: number;
  /**
   * Playing time that elapsed inside this song slot, in milliseconds.
   *
   * This is the observed length of the song the slot describes. It is used
   * instead of the wall clock because a pause or a system suspend must not
   * make a song look longer than it is: only the time the song actually
   * played is counted.
   */
  slotPlayingMs: number;
  /**
   * True when the previous song was observed until it ended, so this slot
   * starts at a real song boundary.
   *
   * Only then is the observed slot length the real length of the song. The
   * first song after start-up or a channel switch may have been joined
   * half-way through, and its slot must not be trusted.
   */
  observedFromStart: boolean;
}

/**
 * Prior estimate of a radio song length (3 minutes).
 *
 * SiriusXM never publishes a track duration, so the "50% of the track" rule
 * has to work from an estimate. This prior is used until the channel has been
 * observed; it is deliberately the median length of a pop/rock radio song.
 */
export const DEFAULT_RADIO_SONG_ESTIMATE_MS = 180_000;

/** How many observed song lengths are kept per channel and globally. */
const SONG_LENGTH_HISTORY = 12;

/**
 * How many observed songs are needed before the estimate is trusted.
 *
 * A single song is not representative of a channel, so the prior is used
 * until a few songs have been heard. Three songs is enough for the median to
 * be stable; the first song of a session is never learned (it may have been
 * joined half-way), so the estimate is trusted from the fourth song on.
 */
export const SONG_LENGTH_SAMPLES_REQUIRED = 3;

/**
 * Shortest observed slot that can plausibly be a complete song.
 *
 * A slot shorter than this is not trusted as a song length: it is more likely
 * a station ident, a jingle or a track the user skipped. Such a slot is
 * neither learned nor used to lower the threshold.
 */
const MIN_PLAUSIBLE_SONG_MS = 45_000;

/** Longest observed slot that can plausibly be a song (not a long DJ set). */
const MAX_PLAUSIBLE_SONG_MS = 20 * 60 * 1000;

/** Bounds for the estimated song length of a channel. */
const MIN_SONG_ESTIMATE_MS = 60_000;
const MAX_SONG_ESTIMATE_MS = 10 * 60 * 1000;

/** Clamp a song length estimate into the range that is treated as plausible. */
function clampSongEstimate(value: number): number {
  return Math.min(MAX_SONG_ESTIMATE_MS, Math.max(MIN_SONG_ESTIMATE_MS, value));
}

/** Median of a list of numbers (unsorted input is fine). */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lower = sorted[middle - 1] ?? sorted[middle];
    const upper = sorted[middle];
    if (lower === undefined || upper === undefined) return undefined;
    return (lower + upper) / 2;
  }
  return sorted[middle];
}

export interface ScrobbleCandidate {
  artist: string;
  title: string;
  /** Epoch seconds - the moment the track started playing. */
  timestamp: number;
  durationMs?: number;
  album?: string | null;
  track: NormalizedTrack;
  /** Why this track is being scrobbled. */
  reason: string;
}

export interface TrackStateEngineOptions {
  thresholds: ScrobbleThresholds;
  config: MetadataConfig;
  onScrobble?: (candidate: ScrobbleCandidate) => void;
  onTrackChange?: (state: TrackState | undefined) => void;
  onProgress?: (state: TrackState | undefined) => void;
  /** Called when a track ends, with the reason why it was (not) scrobbled. */
  onFinalize?: (state: TrackState, reason: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Keys of tracks that were already scrobbled (duplicate protection). */
  isDuplicate?: (key: string) => boolean;
  /** Exclude gaps where actual playback was not observed (e.g. system suspend). */
  maxAccrualGapMs?: number;
}

/** Build the duplicate protection key of a track. */
export function scrobbleKey(
  artist: string,
  title: string,
  timestampMs: number,
): string {
  return `${artist.toLowerCase()}|${title.toLowerCase()}|${Math.floor(timestampMs / 1000)}`;
}

/**
 * Compute the threshold (in milliseconds) after which a track counts as
 * listened to.
 *
 * Known duration: half of the track or four minutes, whichever is shorter
 * (the rule used by Last.fm and ListenBrainz), with a small floor so that
 * very short clips are not scrobbled instantly.
 *
 * Unknown duration (radio): SiriusXM publishes no duration, so the threshold
 * is derived from `songEstimateMs` — the typical song length observed on the
 * current channel — using the same 50% rule. Without an estimate the flat
 * `radioMinListenMs` floor is used.
 *
 * The flat floor is only a stand-in for a song length that is not known yet.
 * It is therefore used when the adaptive estimate is switched off, and never
 * when the real length of a song has been observed.
 */
export function computeThreshold(
  durationMs: number | undefined,
  thresholds: ScrobbleThresholds,
  songEstimateMs?: number,
): { thresholdMs: number; needsBoundary: boolean } {
  if (durationMs && durationMs > 0) {
    const byRatio = durationMs * thresholds.ratio;
    const threshold = Math.min(Math.max(byRatio, thresholds.minMs), thresholds.maxMs);
    return { thresholdMs: threshold, needsBoundary: false };
  }
  if (thresholds.radioAdaptiveEstimate !== false && songEstimateMs && songEstimateMs > 0) {
    const byRatio = songEstimateMs * thresholds.ratio;
    const threshold = Math.min(Math.max(byRatio, thresholds.minMs), thresholds.maxMs);
    return { thresholdMs: threshold, needsBoundary: thresholds.radioRequiresBoundary };
  }
  return {
    thresholdMs: thresholds.radioMinListenMs,
    needsBoundary: thresholds.radioRequiresBoundary,
  };
}

/**
 * Whether a track is a real song.
 *
 * DJ bumpers, station idents, hashtag announcements and other filtered
 * metadata occupy a slot on the channel but are not songs. They must not
 * teach the channel how long a song lasts.
 */
export function isRealSong(state: TrackState): boolean {
  const normalized = state.normalized;
  if (normalized.skip || normalized.ambiguous) return false;
  if (normalized.scrobbleSafe === false) return false;
  return Boolean(normalized.scrobbleArtist && normalized.scrobbleTitle);
}

export class TrackStateEngine {
  private readonly now: () => number;
  private options: TrackStateEngineOptions;

  /** The track that is currently playing. */
  private current: TrackState | undefined;
  /** Metadata that is waiting for the debounce window to expire. */
  private pending: { raw: RawMetadata; since: number } | undefined;
  /** Last time listening time was accrued. */
  private lastAccrualAt: number | undefined;
  /** Playback flags. */
  private playing = false;
  private buffering = false;
  /** Duration reported by the player for the current track. */
  private durationMs: number | undefined;
  /** Keys of the tracks scrobbled during this session. */
  private readonly sessionKeys = new Set<string>();
  /** Observed song lengths, per channel and globally. */
  private readonly channelSongLengths = new Map<string, number[]>();
  private globalSongLengths: number[] = [];
  /** The channel the current track is playing on. */
  private currentChannel: string | null = null;

  constructor(options: TrackStateEngineOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * The estimated length of a song on the current channel.
   *
   * Derived from the songs VegaAM has already heard end-to-end on that
   * channel. The median is used so that one unusually long or unusually short
   * song cannot move the estimate much.
   *
   * The estimate is only trusted once enough songs have been observed. Until
   * then the prior (`DEFAULT_RADIO_SONG_ESTIMATE_MS`) is used, which is the
   * median length of a pop/rock radio song.
   */
  get songEstimateMs(): number {
    return this.songEstimate().ms;
  }

  /**
   * The threshold that currently applies to the playing track, in milliseconds.
   *
   * This is the number the UI shows, so it always reflects the rule that is
   * really in force instead of a hard-coded radio floor.
   */
  get effectiveThresholdMs(): number {
    const state = this.current;
    return computeThreshold(
      state?.durationMs ?? this.durationMs,
      this.options.thresholds,
      this.songEstimateMs,
    ).thresholdMs;
  }

  /**
   * The number of song lengths observed on the current channel.
   *
   * This is the raw number of observations, so the interface can show that it
   * is still learning. The estimate itself is only trusted once
   * `SONG_LENGTH_SAMPLES_REQUIRED` songs have been observed.
   */
  get observedSongCount(): number {
    const channel = this.currentChannel;
    if (channel) return this.channelSongLengths.get(channel)?.length ?? 0;
    return this.globalSongLengths.length;
  }

  /**
   * Whether the channel estimate is trusted (enough songs observed).
   */
  get songEstimateTrusted(): boolean {
    return this.songEstimate().trusted;
  }

  /**
   * The song length estimate and the number of samples it is based on.
   *
   * The channel estimate wins as soon as the channel has been observed often
   * enough. Otherwise the estimate falls back to all channels, and finally to
   * the prior.
   */
  private songEstimate(): { ms: number; samples: number; trusted: boolean } {
    const channel = this.currentChannel;
    if (channel) {
      const samples = this.channelSongLengths.get(channel) ?? [];
      if (samples.length >= SONG_LENGTH_SAMPLES_REQUIRED) {
        const value = median(samples);
        if (value !== undefined) {
          return { ms: clampSongEstimate(value), samples: samples.length, trusted: true };
        }
      }
    }
    if (this.globalSongLengths.length >= SONG_LENGTH_SAMPLES_REQUIRED) {
      const value = median(this.globalSongLengths);
      if (value !== undefined) {
        return {
          ms: clampSongEstimate(value),
          samples: this.globalSongLengths.length,
          trusted: true,
        };
      }
    }
    return { ms: DEFAULT_RADIO_SONG_ESTIMATE_MS, samples: 0, trusted: false };
  }

  /**
   * Apply new settings without interrupting the playback.
   *
   * The engine used to be rebuilt whenever a setting changed. That threw away
   * the current track, the accumulated listening time and the confirmed song
   * boundary, so a colour mode change could stop a running listen.
   */
  configure(options: {
    thresholds?: ScrobbleThresholds;
    config?: MetadataConfig;
  }): void {
    if (options.thresholds) this.options = { ...this.options, thresholds: options.thresholds };
    if (options.config) this.options = { ...this.options, config: options.config };
  }

  /**
   * Re-apply the metadata rules to the track that is currently playing.
   *
   * Used after a manual correction was saved: the correction has to change
   * the track that is about to be submitted, but it must not touch the
   * tracks that were already submitted.
   */
  reapplyConfig(at: number = this.now()): void {
    const state = this.current;
    if (!state) return;
    const before = `${state.normalized.scrobbleArtist}|${state.normalized.scrobbleTitle}`;
    state.normalized = normalizeMetadata(state.raw, this.options.config);
    const after = `${state.normalized.scrobbleArtist}|${state.normalized.scrobbleTitle}`;
    this.options.onProgress?.(state);
    if (before !== after) {
      this.options.onTrackChange?.(state);
    }
    state.lastEventAt = at;
  }

  /** The track that is currently playing (if any). */
  get state(): TrackState | undefined {
    return this.current;
  }

  /** True while the player reports playing audio. */
  get isPlaying(): boolean {
    return this.playing;
  }

  /** Feed an event into the engine. */
  handle(event: PlaybackEvent): void {
    switch (event.type) {
      case 'metadata':
        this.onMetadata(event.raw, event.at);
        break;
      case 'state':
        this.onState(event.playing, event.buffering, event.at);
        break;
      case 'channel':
        this.onChannel(event.channel, event.at);
        break;
      case 'tick':
        this.onTick(event.at);
        break;
    }
  }

  /** Force an evaluation, e.g. when the application is shutting down. */
  flush(at: number = this.now()): void {
    this.accrue(at);
    this.commitPending(at, true);
  }

  private onMetadata(raw: RawMetadata, at: number): void {
    this.accrue(at);
    const normalizedKey = metadataKey(raw);

    // Repeated metadata must not restart the current track.
    if (this.current && metadataKey(this.current.raw) === normalizedKey) {
      this.current.lastEventAt = at;
      this.current.raw = raw;
      this.current.normalized = normalizeMetadata(raw, this.options.config);
      this.pending = undefined; // transient changed metadata reverted before confirmation
      return;
    }

    if (this.pending && metadataKey(this.pending.raw) === normalizedKey) {
      return;
    }

    this.pending = { raw, since: at };
    this.commitPending(at, false);
  }

  private onState(playing: boolean, buffering: boolean, at: number): void {
    const changed = playing !== this.playing || buffering !== this.buffering;
    this.accrue(at);
    if (playing && !buffering && this.current && this.current.listeningMs === 0 && !this.playing) {
      this.current.startedAt = at;
    }
    this.playing = playing;
    this.buffering = buffering;
    if (changed) {
      this.options.onProgress?.(this.current);
    }
    this.commitPending(at, false);
  }

  private onChannel(channel: string | null, at: number): void {
    this.accrue(at);
    // A channel switch ends observation, but does not prove a song ended.
    if (this.current) {
      this.finalizeCurrent(at, 'Channel switch');
      this.current = undefined;
      this.durationMs = undefined;
    }
    this.pending = undefined;
    this.currentChannel = channel;
  }

  private onTick(at: number): void {
    this.accrue(at);
    this.commitPending(at, false);
    this.evaluateCurrent(at);
    this.options.onProgress?.(this.current);
  }

  /** Add the elapsed time to the listening counter when audio was playing. */
  private accrue(at: number): void {
    if (!this.current) {
      this.lastAccrualAt = at;
      return;
    }
    if (this.lastAccrualAt === undefined) {
      this.lastAccrualAt = at;
      return;
    }
    const delta = at - this.lastAccrualAt;
    this.lastAccrualAt = at;
    if (delta <= 0 || delta > (this.options.maxAccrualGapMs ?? Infinity)) return;
    if (!this.playing || this.buffering) return; // paused / buffering is not listening
    this.current.listeningMs += delta;
    this.current.slotPlayingMs += delta;
    this.current.lastEventAt = at;
  }

  /**
   * Commit pending metadata once it stayed unchanged for the debounce window.
   */
  private commitPending(at: number, force: boolean): void {
    if (!this.pending) return;
    const debounce = this.options.thresholds.metadataDebounceMs;
    if (!force && at - this.pending.since < debounce) return;

    const raw = this.pending.raw;
    const observedAt = this.pending.since;
    this.pending = undefined;

    // The previous song was observed until it ended, so the new slot starts at
    // a real song boundary and its length is the real length of the song.
    const observedFromStart = this.current !== undefined;

    // The debounce window belongs to the new song: the old song ended when
    // the new metadata first appeared, so the time in between is played by
    // the new song and must not be counted for the old one.
    const windowMs = Math.max(0, at - observedAt);
    const wasPlaying = this.playing && !this.buffering;

    if (this.current) {
      // Debounce belongs to neither verified track; remove it from the previous listen.
      if (wasPlaying) {
        this.current.listeningMs = Math.max(0, this.current.listeningMs - windowMs);
      }
      this.current.slotPlayingMs = Math.max(0, this.current.slotPlayingMs - windowMs);
      this.current.boundaryConfirmed = true;
      this.finalizeCurrent(observedAt, 'Metadata changed');
    }

    const normalized = normalizeMetadata(raw, this.options.config);
    this.current = {
      raw,
      normalized,
      startedAt: observedAt,
      listeningMs: 0,
      lastEventAt: at,
      boundaryConfirmed: false,
      scrobbled: false,
      durationMs: this.durationMs,
      slotStartedAt: observedAt,
      slotPlayingMs: wasPlaying ? windowMs : 0,
      observedFromStart,
    };
    this.lastAccrualAt = at;
    this.options.onTrackChange?.(this.current);
  }

  /**
   * Evaluate the current track and emit a scrobble when the thresholds are
   * reached.
   */
  private evaluateCurrent(at: number): void {
    const state = this.current;
    if (!state || state.scrobbled) return;
    if (state.normalized.skip || state.normalized.ambiguous || state.normalized.scrobbleSafe === false) {
      state.scrobbleReason = state.normalized.skipReason || state.normalized.scrobbleBlockReason || 'Ambiguous metadata';
      return;
    }
    if (state.durationMs !== undefined && state.durationMs <= 30_000) {
      state.scrobbleReason = 'Track duration must exceed 30 seconds.';
      return;
    }

    const { thresholdMs, needsBoundary } = computeThreshold(
      state.durationMs,
      this.options.thresholds,
      this.songEstimateMs,
    );
    if (state.listeningMs < thresholdMs) return;
    if (needsBoundary && !state.boundaryConfirmed) return;

    this.emitScrobble(state, at, `Listened for ${Math.round(state.listeningMs / 1000)}s`);
  }

  /** Finalize the current track (song ended, channel switched, ...). */
  private finalizeCurrent(at: number, reason: string): void {
    const state = this.current;
    if (!state) return;

    // The observed length of the slot: the time the song actually played.
    // The wall clock is not used, so a pause or a system suspend cannot make a
    // song look longer than it is.
    const slotLengthMs = Math.max(0, state.slotPlayingMs);
    const songEnded = reason === 'Metadata changed';

    // A song that ended after a real boundary tells us how long a song on
    // this channel actually lasts. That is what makes the threshold adaptive.
    // Only real songs may teach the estimate: a DJ bumper, an ident or a
    // filtered announcement is not a song and must not shorten the channel.
    if (songEnded && state.observedFromStart && isRealSong(state)) {
      this.learnSongLength(slotLengthMs);
    }

    if (!state.scrobbled) {
      const { thresholdMs, needsBoundary } = computeThreshold(
        state.durationMs,
        this.options.thresholds,
        this.songEstimateMs,
      );
      // A song that ended may be shorter than the threshold that applied while
      // it was playing. If the user heard enough of it, submit it now instead
      // of dropping it - this is what stops short songs from being lost.
      const endedThresholdMs = songEnded
        ? this.endedSongThresholdMs(state, slotLengthMs)
        : thresholdMs;

      if (state.normalized.skip) {
        state.scrobbleReason = `Skipped: ${state.normalized.skipReason ?? 'filtered metadata'}`;
      } else if (!state.normalized.scrobbleArtist || !state.normalized.scrobbleTitle) {
        state.scrobbleReason = 'No artist or title could be determined.';
      } else if (state.normalized.scrobbleSafe === false) {
        state.scrobbleReason =
          state.normalized.scrobbleBlockReason ?? 'The artist and title are not a well formed pair.';
      } else if (state.normalized.ambiguous) {
        state.scrobbleReason = 'The metadata is ambiguous.';
      } else if (state.durationMs !== undefined && state.durationMs <= 30_000) {
        state.scrobbleReason = 'Track duration must exceed 30 seconds.';
      } else if (state.listeningMs < endedThresholdMs) {
        state.scrobbleReason = `Listened for ${Math.round(state.listeningMs / 1000)}s, threshold is ${Math.round(endedThresholdMs / 1000)}s.`;
      } else if (needsBoundary && !state.boundaryConfirmed) {
        state.scrobbleReason = 'No confirmed song boundary.';
      } else {
        this.emitScrobble(state, at, `${reason} after ${Math.round(state.listeningMs / 1000)}s`);
      }
    }

    this.options.onFinalize?.(state, state.scrobbleReason ?? reason);
  }

  /**
   * The threshold that applies once a song has ended.
   *
   * When the slot was observed from a real song boundary, the slot length is
   * the real length of the song, so the normal "50% of the track" rule is
   * applied to it. That is how a 70 second punk song gets submitted even
   * though it never reached the channel-wide threshold.
   *
   * The flat radio floor does not apply here: it only exists to stand in for
   * a song length that is not known. Once the song has ended its length is
   * known, so the 50% rule wins. The absolute floor (`minMs`) still applies,
   * so a song is never submitted after a few seconds of playback.
   *
   * When the song may have been joined half-way through, the slot length
   * cannot be trusted and the channel-wide estimate is used instead, so a
   * song the user barely heard is not submitted.
   */
  private endedSongThresholdMs(state: TrackState, slotLengthMs: number): number {
    const thresholds = this.options.thresholds;
    if (thresholds.radioAdaptiveEstimate === false) {
      return computeThreshold(state.durationMs, thresholds).thresholdMs;
    }
    const estimate = this.songEstimateMs;
    if (state.durationMs && state.durationMs > 0) {
      return computeThreshold(state.durationMs, thresholds, estimate).thresholdMs;
    }
    if (!state.observedFromStart) {
      // Possibly joined mid-song: only the estimate may be used.
      return computeThreshold(undefined, thresholds, estimate).thresholdMs;
    }
    if (slotLengthMs < MIN_PLAUSIBLE_SONG_MS) {
      // Too short to be a complete song (ident, jingle, skipped track):
      // fall back to the channel estimate.
      return computeThreshold(undefined, thresholds, estimate).thresholdMs;
    }
    // The song really lasted `slotLengthMs`; use the shorter of the two so a
    // short song is not penalised by a longer channel average.
    const effectiveSongMs = Math.min(slotLengthMs, estimate);
    return computeThreshold(undefined, thresholds, effectiveSongMs).thresholdMs;
  }

  /** Remember how long a song on the current channel lasted. */
  private learnSongLength(slotLengthMs: number): void {
    if (slotLengthMs < MIN_PLAUSIBLE_SONG_MS || slotLengthMs > MAX_PLAUSIBLE_SONG_MS) {
      return;
    }
    this.globalSongLengths.push(slotLengthMs);
    if (this.globalSongLengths.length > SONG_LENGTH_HISTORY) {
      this.globalSongLengths.shift();
    }
    const channel = this.currentChannel;
    if (!channel) return;
    const history = this.channelSongLengths.get(channel) ?? [];
    history.push(slotLengthMs);
    if (history.length > SONG_LENGTH_HISTORY) history.shift();
    this.channelSongLengths.set(channel, history);
  }

  private emitScrobble(state: TrackState, at: number, reason: string): void {
    const artist = state.normalized.scrobbleArtist;
    const title = state.normalized.scrobbleTitle;
    if (!artist || !title) return;
    if (state.normalized.skip || state.normalized.ambiguous || state.normalized.scrobbleSafe === false) {
      state.scrobbleReason =
        state.normalized.scrobbleBlockReason ?? 'The artist and title are not a well formed pair.';
      return;
    }

    const key = scrobbleKey(artist, title, state.startedAt);
    if (this.sessionKeys.has(key)) {
      state.scrobbled = true;
      state.scrobbleReason = 'Duplicate in this session.';
      return;
    }
    if (this.options.isDuplicate?.(key)) {
      state.scrobbled = true;
      state.scrobbleReason = 'Duplicate - already scrobbled.';
      return;
    }

    this.sessionKeys.add(key);
    state.scrobbled = true;
    state.scrobbleReason = reason;

    this.options.onScrobble?.({
      artist,
      title,
      timestamp: Math.floor(state.startedAt / 1000),
      durationMs: state.durationMs,
      album: state.normalized.album ?? null,
      track: state.normalized,
      reason,
    });
  }

  /** Update the known duration of the current track. */
  setDuration(durationMs: number | undefined): void {
    this.durationMs = durationMs && durationMs > 0 ? durationMs : undefined;
    if (this.current && !this.pending) this.current.durationMs = this.durationMs;
  }
}

/** Stable key for a raw metadata snapshot. */
export function metadataKey(raw: RawMetadata): string {
  return [raw.channel ?? '', raw.artist ?? '', raw.title ?? ''].join('\u0000').trim();
}
