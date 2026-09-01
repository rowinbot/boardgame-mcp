/**
 * Two error families, deliberately kept apart.
 *
 * `ToolError` is something the *caller* can act on: the game wasn't found, the
 * upstream is down, the group is too big for anything we know about. These are
 * returned to the LLM as `isError: true` with an actionable message, never
 * thrown past the tool boundary.
 *
 * Everything else — an unknown filter key, a schema mismatch — is a bug in this
 * server. Those throw, and the SDK turns them into a JSON-RPC error, which is
 * the correct signal: the caller cannot fix them by rephrasing.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    /** Short machine-readable tag, surfaced in the structured error payload. */
    readonly code: ToolErrorCode,
    /** What the caller could try instead. Written for an LLM to act on. */
    readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export type ToolErrorCode =
  | 'game_not_found'
  | 'ambiguous_game'
  | 'upstream_unavailable'
  | 'no_results';

/**
 * The upstream silently ignores filter parameters it does not recognise and
 * returns the entire 133k-row corpus with a 200. If a query that should have
 * narrowed the corpus comes back with a corpus-sized count, the filter was
 * dropped and every downstream answer would be confidently wrong.
 *
 * This is a bug in our query construction, so it throws rather than degrading.
 */
export class FilterIgnoredError extends Error {
  constructor(
    readonly url: string,
    readonly count: number,
    readonly baseline: number,
  ) {
    super(
      `recommend.games returned ${count} results for a filtered query, at or above the ` +
        `${baseline} baseline for an unfiltered corpus. The filter was silently ignored. URL: ${url}`,
    );
    this.name = 'FilterIgnoredError';
  }
}

/** An unknown key reached the query builder. Always a typo, always our fault. */
export class UnknownFilterError extends Error {
  constructor(key: string, allowed: readonly string[]) {
    super(
      `Unknown recommend.games filter "${key}". The API ignores unknown filters silently, ` +
        `so this is rejected before the request. Allowed: ${allowed.join(', ')}`,
    );
    this.name = 'UnknownFilterError';
  }
}

/** Upstream returned a status we retry on, or stopped responding. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}
