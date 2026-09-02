import { HttpClient } from '../lib/http.js';
import { StaleWhileErrorCache, type CacheLookup } from '../lib/cache.js';
import { FilterIgnoredError, FilterNotAppliedError, UnknownFilterError, UpstreamError } from '../lib/errors.js';
import { PageSchema, RawGameSchema, type Page, type RawGame } from './gameSchema.js';

const BASE = 'https://recommend.games/api';

/**
 * The allow-list exists because of the single most dangerous property of this
 * API: unknown filter parameters are silently ignored. `?name=Catan` returns
 * HTTP 200 with all 133,004 games and no warning of any kind. A one-character
 * typo therefore turns into a confident, plausible, completely wrong answer.
 *
 * Every key here was confirmed to actually filter by comparing result counts
 * against the unfiltered corpus on 2026-09-01.
 */
const ALLOWED_FILTERS = [
  'bgg_rank__isnull',
  'complexity__gte',
  'complexity__lte',
  'min_players__lte',
  'max_players__gte',
  'max_time__lte',
  'min_time__gte',
  'year__gte',
  'num_votes__gte',
  'mechanic',
  'category',
  'ordering',
  'page',
  'page_size',
  'format',
] as const;

const ALLOWED = new Set<string>(ALLOWED_FILTERS);

/**
 * Measured on 2026-09-01, each filter applied on its own to the ranked corpus,
 * sequentially, with the service otherwise idle. These numbers are the reason
 * the tools look the way they do.
 *
 *   num_votes__gte                    1.7s     2,545 of 31,135 rows
 *   page / page_size / ordering       0.7–4.5s
 *   mechanic                          3.2–8.3s
 *   complexity__gte + complexity__lte 15.3–16.6s
 *   min_players__lte + max_players__gte 18.8s
 *   max_time__lte                     30.8s -> 503
 *   search                            always 503 (permanently broken)
 *
 * Heroku's router kills any request at 30s (H12), so the expensive filters are
 * not merely slow — stacked, they exceed the budget and the query dies. The
 * tools therefore send only the cheap, highly selective filters and do the rest
 * of the work in memory over the returned rows, which carry all 58 fields.
 *
 * The range filters stay on the allow-list because they are correct; they are
 * simply not worth their latency here.
 */

/** Keys that only shape the response rather than narrowing the corpus. */
const NON_NARROWING = new Set<string>(['ordering', 'page', 'page_size', 'format']);

/**
 * Corpus sizes observed on 2026-09-01. Used as floors, not equalities: the
 * corpus only ever grows, so a filtered query returning at least this many rows
 * means the filter was dropped.
 */
export const UNFILTERED_CORPUS = 133_004;
export const RANKED_CORPUS = 31_135;

/** The API caps page size at 25 regardless of what is requested. Verified. */
export const MAX_PAGE_SIZE = 25;

export type QueryParams = Record<string, string | number | boolean>;

export function buildQuery(params: QueryParams): string {
  const search = new URLSearchParams({ format: 'json' });
  for (const [key, value] of Object.entries(params)) {
    if (!ALLOWED.has(key)) throw new UnknownFilterError(key, ALLOWED_FILTERS);
    search.set(key, String(value));
  }
  return search.toString();
}

/**
 * Second belt on the silent-ignore trap. The allow-list stops keys we typo'd;
 * this catches a key the upstream quietly stops honouring, which is the version
 * that would otherwise survive a deploy unnoticed.
 */
export function assertFilterApplied(url: string, params: QueryParams, count: number): void {
  const narrowing = Object.keys(params).filter((key) => !NON_NARROWING.has(key));
  if (narrowing.length === 0) return;

  const onlyRankFilter = narrowing.length === 1 && narrowing[0] === 'bgg_rank__isnull';
  const baseline = onlyRankFilter ? UNFILTERED_CORPUS : RANKED_CORPUS;
  if (count >= baseline) throw new FilterIgnoredError(url, count, baseline);
}

/**
 * Row-level check on the same trap, and the one that catches the common case.
 *
 * `assertFilterApplied` only fires when a dropped filter leaves a corpus-sized
 * count. Every query this server sends carries two or three narrowing filters
 * together, so the realistic failure is one being dropped while the others hold:
 * `mechanic` going missing from a query that still has `bgg_rank__isnull` and
 * `num_votes__gte` returns roughly 2,545 rows, far under the 31,135 baseline,
 * and the count check passes it. The answer is then the highest-rated ranked
 * games rather than games resembling the seed, which is precisely the confident
 * wrong answer the guard exists to prevent.
 *
 * A row either satisfies a filter or it does not, so checking rows removes the
 * heuristic. Only filters backed by a field on the row can be checked here;
 * `mechanic` and `category` are ids the row does not carry, and are verified by
 * the caller, which knows the name it asked for.
 */
type RowCheck = (row: RawGame, value: string) => string | null;

const ROW_CHECKS: Record<string, RowCheck> = {
  bgg_rank__isnull: (row, value) => {
    const wantNull = value === 'true';
    const isNull = row.bgg_rank === null;
    return isNull === wantNull ? null : `"${row.name}" has bgg_rank ${String(row.bgg_rank)}`;
  },
  num_votes__gte: (row, value) =>
    row.num_votes !== null && row.num_votes < Number(value)
      ? `"${row.name}" has ${row.num_votes} votes, under ${value}`
      : null,
  complexity__gte: (row, value) =>
    row.complexity !== null && row.complexity < Number(value)
      ? `"${row.name}" has complexity ${row.complexity}, under ${value}`
      : null,
  complexity__lte: (row, value) =>
    row.complexity !== null && row.complexity > Number(value)
      ? `"${row.name}" has complexity ${row.complexity}, over ${value}`
      : null,
  min_players__lte: (row, value) =>
    row.min_players !== null && row.min_players > Number(value)
      ? `"${row.name}" needs ${row.min_players} players minimum, over ${value}`
      : null,
  max_players__gte: (row, value) =>
    row.max_players !== null && row.max_players < Number(value)
      ? `"${row.name}" seats ${row.max_players} at most, under ${value}`
      : null,
  max_time__lte: (row, value) =>
    row.max_time !== null && row.max_time > Number(value)
      ? `"${row.name}" runs to ${row.max_time} min, over ${value}`
      : null,
  min_time__gte: (row, value) =>
    row.min_time !== null && row.min_time < Number(value)
      ? `"${row.name}" starts at ${row.min_time} min, under ${value}`
      : null,
  year__gte: (row, value) =>
    row.year !== null && row.year < Number(value)
      ? `"${row.name}" is from ${row.year}, before ${value}`
      : null,
};

/**
 * A null field is not a violation. The upstream's own filters keep rows whose
 * value is missing rather than dropping them, so treating null as a failure
 * would throw on data the API considers a legitimate match.
 */
export function assertRowsSatisfyFilters(url: string, params: QueryParams, rows: readonly RawGame[]): void {
  for (const [key, raw] of Object.entries(params)) {
    const check = ROW_CHECKS[key];
    if (!check) continue;
    const value = String(raw);
    for (const row of rows) {
      const violation = check(row, value);
      if (violation) throw new FilterNotAppliedError(url, `${key}=${value}`, violation);
    }
  }
}

export interface Fetched<T> {
  value: T;
  cache: { hit: boolean; stale: boolean; ageSeconds: number | null };
}

const fresh = <T>(value: T): Fetched<T> => ({
  value,
  cache: { hit: false, stale: false, ageSeconds: null },
});

const fromCache = <T>(lookup: CacheLookup<T>): Fetched<T> => ({
  value: lookup.value,
  cache: { hit: true, stale: lookup.stale, ageSeconds: lookup.ageSeconds },
});

export interface RecommendGamesOptions {
  http?: HttpClient;
  /** Game detail barely changes; ratings drift slowly. Queries are the expensive call. */
  detailTtlMs?: number;
  queryTtlMs?: number;
  now?: () => number;
}

export class RecommendGamesClient {
  private readonly http: HttpClient;
  private readonly detailCache: StaleWhileErrorCache<RawGame>;
  private readonly queryCache: StaleWhileErrorCache<Page>;

  constructor(options: RecommendGamesOptions = {}) {
    this.http = options.http ?? new HttpClient();
    this.detailCache = new StaleWhileErrorCache(options.detailTtlMs ?? 24 * 60 * 60 * 1000, 500, options.now);
    this.queryCache = new StaleWhileErrorCache(options.queryTtlMs ?? 6 * 60 * 60 * 1000, 200, options.now);
  }

  /** Fast and reliable: 0.38–0.90s in every measurement taken. */
  async getGame(bggId: number): Promise<Fetched<RawGame>> {
    const key = `game:${bggId}`;
    const hit = this.detailCache.getFresh(key);
    if (hit) return fromCache(hit);

    const url = `${BASE}/games/${bggId}/?format=json`;
    try {
      const game = RawGameSchema.parse(await this.http.getJson(url));
      this.detailCache.set(key, game);
      return fresh(game);
    } catch (error) {
      return this.recover(error, this.detailCache.getStale(key), `game ${bggId}`);
    }
  }

  async query(params: QueryParams): Promise<Fetched<Page>> {
    const qs = buildQuery(params);
    const key = `query:${qs}`;
    const hit = this.queryCache.getFresh(key);
    if (hit) return fromCache(hit);

    const url = `${BASE}/games/?${qs}`;
    try {
      const page = PageSchema.parse(await this.http.getJson(url));
      assertFilterApplied(url, params, page.count);
      assertRowsSatisfyFilters(url, params, page.results);
      this.queryCache.set(key, page);
      return fresh(page);
    } catch (error) {
      return this.recover(error, this.queryCache.getStale(key), 'game query');
    }
  }

  /**
   * On an upstream failure, prefer stale data over no data — but only for
   * upstream failures. A FilterIgnoredError or a schema mismatch is our bug and
   * must not be papered over with an old result.
   */
  private recover<T>(error: unknown, stale: CacheLookup<T> | undefined, label: string): Fetched<T> {
    if (!(error instanceof UpstreamError)) throw error;
    if (stale) return fromCache(stale);
    throw new UpstreamError(`recommend.games is unavailable and nothing cached for ${label}: ${error.message}`, error.status);
  }

}
