# Metadata Acquisition and Provenance (VegaAM 3.2.5)

In VegaAM, all DOM scraping and page-header corroboration have been removed. Metadata is acquired exclusively through an isolated, read-only preload (`src/preload/mediaBridge.ts`) that reads the standard W3C Media Session API (`navigator.mediaSession.metadata` and `navigator.mediaSession.playbackState`) published by the official SiriusXM web player.

> VegaAM ships **no channel catalog, no channel artwork and no channel→artist seed
> mapping**. Everything below is derived from what the official player itself
> publishes, or from an explicit correction the user made. See
> [`LIMITATIONS.md`](LIMITATIONS.md) and [`SECURITY.md`](SECURITY.md).

## Role Resolution (`src/core/metadata/mediaSession.ts`)

The official SiriusXM web player publishes two combined fields in `navigator.mediaSession.metadata`:
- `title`: `"<programme> · <channel>"` (e.g. `"The Beatles Channel · The Beatles Channel"` or `"Bruce Springsteen Concerts · E Street Radio"`)
- `artist`: `"<artist> - <song>"` (e.g. `"The Beatles - Ask Me Why"`, `"Paul McCartney - Coming Up"`, or `"2/14/23 Houston, TX - Badlands"`)

`resolveMediaSessionMetadata` separates these fields using general structural rules:
1. Splits `<programme> · <channel>` (normalizing UTF-8/Latin-1 mojibake separators such as `Â·`) and collapses identical programme/channel pairs.
2. Splits `<artist> - <song>` on the first separator only so song titles containing hyphens remain intact.
3. Separates trailing numeric year qualifiers such as `(67)` into `qualifier` while preserving exact provider spelling (e.g. `Folllow That Dream`).
4. Rejects non-music bumpers, hashtags (`#FabFourum`, `#FromMeToYou`), phone numbers (`844.999.2328`), and interview banners (`Zoey Deutch - Beatlemania!!`).
5. Marks date/location prefixes in the artist slot (`2/14/23 Houston, TX`) as non-artist metadata; if the user has configured an explicit channel→artist mapping for that station (e.g. `E Street Radio` → `Bruce Springsteen`), `normalizeMetadata` (`src/core/metadata/normalizer.ts`) supplies the artist (`evidence: "inferred"`, `source: "channel-fallback"`), keeps the concert date/location for display (`Badlands (February 14, 2023 – Houston, TX)`), and strips it from the submitted scrobble title (`Badlands`).
6. Carries the album the player publishes (`navigator.mediaSession.metadata.album`) into the
   normalised track, so the submitted scrobble is tagged with it instead of album-less.
7. Reads the **album-label form** (`src/core/metadata/albumLabel.ts`) some channels use.
   SiriusXM publishes E Street Radio as `From "The Rising" - My City Of Ruins`: the
   album stands where the artist would be. The label is an album, never an artist
   credit — the artist comes from the user's channel mapping (`E Street Radio` →
   `Bruce Springsteen`), the album is submitted with the track, and the text behind the
   label is the song and is never split again. The album name has to be quoted, so a
   song called *From Me To You* stays a song title.

## User corrections (`src/core/metadata/manualCorrections.ts`)

A correction is remembered under a normalised key. The user never reproduces the raw
broadcast strings by hand: the interface offers **Fix tagging** on the Now Playing card
and on every history entry, which fills the form with the exact strings of that track.

The lookup itself tries several candidates, most specific first:

1. the raw artist/title pair the player published,
2. the artist/title pair the interface shows,
3. the raw song title on its own,
4. the song title the interface shows, on its own,
5. the raw artist on its own,
6. the artist the interface shows, on its own.

A correction that was saved for the song title alone therefore applies to that song for
every artist, and the confirmation message states what the correction is keyed on.

## Channel mappings and artist aliases (`src/core/metadata/channelFallback.ts`)

- A channel mapping matches the published channel exactly, then by the
  `Radio`/`Channel`/`Station` decoration, and finally as a partial match: a station
  that publishes itself as `Bruce Springsteen / E Street Radio` finds the mapping for
  `E Street Radio`. The longest matching mapping wins, so a specific mapping is never
  shadowed by a shorter one.
- An artist alias renames the artist exactly as it is broadcast
  (`Bruce Springsteen & The E Street Band` → `Bruce Springsteen`) before the track is
  submitted. Both controls live in the **Scrobbling Rules** tab and are explicit,
  user-created rules — nothing is shipped with the application.

