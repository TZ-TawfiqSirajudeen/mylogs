/**
 * Free-text search runs against one pre-lowercased field (`searchText`) held in a covering index, instead of three
 * case-insensitive regular expressions over full documents. Matching cost is then proportional to the (small) index entries,
 * not to the documents (which carry attributes and stack traces).
 *
 * Trade-off, deliberately visible: only the first SEARCH_MESSAGE_CHARS characters of the message and SEARCH_EXCEPTION_CHARS
 * of the exception message are searchable; the error type is searched in full. Text beyond that still displays everywhere.
 */
export const SEARCH_MESSAGE_CHARS = 2048;
export const SEARCH_EXCEPTION_CHARS = 512;
/** Separates the three parts so a phrase cannot match across the boundary between, say, the message and the error type. */
const SEP = '\u0001';

export function buildSearchText(message: string, errorType: string | null, exceptionMessage: string | null): string {
  return `${message.slice(0, SEARCH_MESSAGE_CHARS)}${SEP}${errorType ?? ''}${SEP}${(exceptionMessage ?? '').slice(0, SEARCH_EXCEPTION_CHARS)}`.toLowerCase();
}

/** Normalizes a user's search term exactly like the stored text, so a plain (case-sensitive, index-friendly) match is a case-insensitive one. */
export const searchNeedle = (term: string): string => term.replace(/\u0001/g, ' ').toLowerCase();

export const SEARCH_INDEX = 'logs_scope_ts_search';
