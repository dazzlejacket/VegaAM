/**
 * The album-label form of the official player's now-playing string.
 *
 * Some SiriusXM channels publish the album where the artist would be:
 *
 *   From "The Rising" — My City Of Ruins
 *
 * The leading `From "<album>"` is an album label, not an artist credit.
 * Reading it as an artist would scrobble every track of the channel under
 * the name of an album - on E Street Radio every Bruce Springsteen track
 * would be tagged as the artist `From "The Rising"`.
 *
 * The label is therefore recovered as the album, and the artist is left to
 * the channel mapping the user configured for the channel.
 */

/**
 * A leading album label.
 *
 * The album name has to be quoted. An unquoted "From ..." is an ordinary song
 * title ("From Me To You"), and reading that as an album would be worse than
 * leaving the metadata alone.
 */
const ALBUM_LABEL_RE = new RegExp(
  [
    '^\\s*(from\\s+(?:"([^"]+)"|\u201c([^\u201d]+)\u201d|\u2018([^\u2019]+)\u2019))',
    '\\s*(?:[-\u2013\u2014|]\\s*)?',
  ].join(''),
  'i',
);

export interface AlbumLabel {
  /** The album name, without the label and without the quotes. */
  album: string;
  /** The label exactly as it was published, e.g. `From "The Rising"`. */
  label: string;
  /** The text that followed the label. */
  rest: string;
}

/**
 * Match a leading album label.
 *
 * Returns null when the text does not start with a quoted album label.
 */
export function matchAlbumLabel(value: string | null | undefined): AlbumLabel | null {
  const text = (value ?? '').trim();
  if (!text) return null;

  const match = ALBUM_LABEL_RE.exec(text);
  if (!match) return null;

  const album = (match[2] ?? match[3] ?? match[4] ?? '').trim();
  if (!album) return null;

  return {
    album,
    label: (match[1] ?? '').trim(),
    rest: text.slice(match[0].length).trim(),
  };
}
