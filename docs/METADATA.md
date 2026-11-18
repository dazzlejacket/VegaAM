# Metadata Acquisition and Provenance (VegaAM 3.2.3)

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
