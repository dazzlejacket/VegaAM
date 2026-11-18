/**
 * Re-exports from the pure MediaSession metadata parser.
 *
 * Retained as a module alias for existing imports while keeping zero DOM or
 * page-field dependencies.
 */

export {
  normalizeMojibake,
  resolveMediaSessionMetadata,
  resolveProviderMetadata,
  splitChannelProgramme,
  splitCombinedArtistSong,
  splitTrailingQualifier,
  stripChannelNumberPrefix,
  type MediaSessionSnapshot,
  type MetadataEvidence,
  type ProviderMetadataSnapshot,
  type ResolvedMetadata,
} from './mediaSession';
