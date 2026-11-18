# Live-radio track state machine

> **VegaAM 3.2.3.** The bridge reads `navigator.mediaSession` only: no rendered
> channel-page text, no HTMLMediaElement DOM reads, no channel-name artist
> inference, no seed channel mappings. The state machine, timing and duplicate rules
> below describe the shipped behaviour. The **threshold** is adaptive since 3.2.1 —
> see §6 below and [`LIMITATIONS.md`](LIMITATIONS.md).

The official SiriusXM player remains the sole playback engine. The read-only bridge observes its published browser MediaSession fields and ordinary HTMLMediaElement playback/buffering state. No internal protected player state, audio extraction, unofficial streaming API, DRM changes or channel-specific artist assumptions are used to manufacture a song.

## States and transitions

1. **Detected:** a changed channel/artist/title identity enters a four-second default debounce window.
2. **Metadata verified or classified:** in 0.3.0, agreement between MediaSession and the active page yields `verified`; a separable MediaSession artist/song field yields `split`. **In 3.0 there is no page agreement:** the split MediaSession fields are the only source, and an ambiguous split is rejected. Programmes, channel names, date/location fields, missing artists and ambiguous data carry rejection reasons. Page-only programme listings do not establish the actively playing song.
3. **Now Playing:** a safe artist/title pair is sent only during observed playback. The monitor reports the service acknowledgement or failure. A failed Now Playing update does not prevent later eligibility.
4. **Listening:** only observed playing and nonbuffering intervals accrue. Pauses, failed snapshots and observation gaps over five seconds do not earn listening time. Background main-process polling continues. Stream position is not mistaken for song position or duration.
5. **Transition:** a stable new song identity finalizes the old observation. Identical repeated metadata does not restart the song. A transient metadata change that reverts before verification is cancelled. A channel switch ends observation and finalizes the track - it is the last chance to submit a track that reached the floor, but it never proves that the old song ended and it never submits a track that is below the floor.
6. **Eligibility:** metadata must pass the safety filters. With a valid song duration, tracks must exceed 30 seconds and meet at least half their duration or four minutes, whichever is shorter (user settings may be more conservative). The default 30-second listening floor is also conservative. The official HTML stream duration is never used as a song duration.
7. **Unknown-duration radio (adaptive threshold):** SiriusXM never publishes a reliable song duration, so every track is treated as a radio track. Instead of a fixed floor, VegaAM **measures** the songs it hears end-to-end on the current channel, keeps the last 12 observed song lengths, and takes their **median** (trusted after three observations, clamped to 60 s-600 s, seeded with a 180 s radio prior). A track is submitted once it reached **half** of that measured song length - the same 50 % rule Last.fm and ListenBrainz use. A track that **ends while it is still below the threshold is submitted** with the length it actually had, provided the slot was observed from a real song boundary. A 30 s floor of real playback always applies, and paused or unobserved time never counts. The stricter policy, in which a track is only submitted after a confirmed song-metadata transition, is available as a setting (`radioRequiresBoundary`) and defaults to off. No duration is invented or sent to Last.fm. This is a local policy, not a claim that Last.fm specifies this radio fallback. The flat floor remains selectable (`radioAdaptiveEstimate` off).
8. **Queued:** save the service-specific payload, original listening-start timestamp and duplicate identity before attempting submission.
9. **Submitted / acknowledged / rejected:** an HTTP 200 alone is insufficient. Last.fm must acknowledge an accepted scrobble and must not report an ignored-message code. Monitor pending, failed and done records separately; internal engine emission never counts as a service acknowledgement in history.

## Timing and duplicates

The first stable observation time is retained rather than using the later debounce completion time. If metadata arrives while paused, the first subsequent listening event becomes the start. Verification delay is not credited as listening. The provider does not expose a reliable absolute song-start timestamp in the observed fields; VegaAM cannot recover time before observation. Late-arriving metadata can lose some valid listening time, which is safer than crediting unobserved playback.

Duplicate identity is artist/title/listening-start second, with separate service queue items. A completed item cannot be manually retried or re-enqueued. The same song can qualify again after actual intervening song transitions. A repeated title with no intervening observable transition is conservatively treated as the same play. Queue entries interrupted in `sending` return to pending on restart. Partial current-track listening is not carried across restart; no unobserved downtime is credited.

## Persistence and retries

History retains 500 tracks. The queue retains at most 500 acknowledged items and 1000 outstanding items; capacity failures are recorded in history rather than silently dropping a candidate. Network errors, including thrown transport exceptions, use bounded backoff and at most 12 attempts. Last.fm invalid-session errors and permanent ignored submissions stop in failed state. Reconnect and use Retry for recoverable failures. Retry does not replay a completed acknowledgement.

A history entry that was never delivered - or that a service rejected - can be submitted again from the history. The track goes through the same queue as an automatic submission, and a service that already accepted it is not asked again. Clearing the history asks for confirmation.

The monitor includes current channel/artist/title, metadata evidence and reasons, observation age, listening time, known/unknown song duration, connection state, Now Playing status, eligibility and recent decisions. The submission list is newest first; its done entries are recent acknowledgements. Copy Diagnostics uses an explicit allowlist and excludes settings, credentials, cookies, URLs and raw service responses.

## Bruce-related broadcasts

A normal `Bruce Springsteen - Atlantic City` pair uses the same parser as Beatles metadata.

A concert broadcast puts the date and the location where the artist would be - the observed E Street field was `12/13/92 Boston, MA - Bobby Jean`. Two things follow from that:

- The published string is **not** an artist, and the parser never treats it as one.
- A **user-confirmed channel mapping** may supply the artist for that channel. The mapping is explicit and editable in Settings → Advanced. When it applies, the artist comes from the mapping and is recorded as inferred; the date and the location are read as concert information, are shown in the interface, and are **never part of the submitted title**. A channel that the user never mapped is still never used as an artist source.

> **Note:** the shipped seed mappings are removed. A mapping exists only because the user created it for an exact observed channel, and it lives in Settings → Scrobbling Rules. The bundled test fixture already publishes a plain `Artist - Song` pair, so it does not need a mapping at all.

A browsed channel page also cannot replace a paused stream's active MediaSession metadata — the bridge reads the MediaSession of the playing page, never a page that happens to be open.

Reference: [Last.fm scrobbling rules](https://www.last.fm/api/scrobbling).
