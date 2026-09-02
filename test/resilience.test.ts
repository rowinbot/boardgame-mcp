import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/lib/http.js';
import { RecommendGamesClient, RANKED_CORPUS, UNFILTERED_CORPUS, assertFilterApplied, assertRowsSatisfyFilters, buildQuery } from '../src/clients/recommendGames.js';
import { FilterIgnoredError, FilterNotAppliedError, UnknownFilterError, UpstreamError } from '../src/lib/errors.js';
import { loadFixtures } from '../src/lib/recordedFetch.js';
import { fakeFetch } from './support/deps.js';
import { RawGameSchema, type RawGame } from '../src/clients/gameSchema.js';

/**
 * A row with everything nullable left null, so a test states only the field it
 * is about. Built through the schema rather than cast, so a schema change breaks
 * these tests instead of letting them assert against a shape that no longer
 * exists.
 */
function row(fields: Partial<RawGame> & { name: string }): RawGame {
  return RawGameSchema.parse({ bgg_id: 1, bgg_rank: 1, ...fields });
}

const fixtures = loadFixtures();
const catan = fixtures.game_catan as Record<string, unknown>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function serviceUnavailable(): Response {
  return new Response('Application Error', { status: 503, statusText: 'Service Unavailable' });
}

describe('the silently-ignored-filter trap', () => {
  it('refuses to build a query containing an unknown filter key', () => {
    // `name` is the trap in its natural habitat: a reasonable-looking parameter
    // that the API accepts, ignores, and answers with the entire corpus.
    expect(() => buildQuery({ name: 'Catan' })).toThrow(UnknownFilterError);
    expect(() => buildQuery({ complexity_gte: 2 })).toThrow(UnknownFilterError);
    expect(() => buildQuery({ bgg_id: 13 })).toThrow(UnknownFilterError);
  });

  it('allows the filters that were verified to actually filter', () => {
    expect(() => buildQuery({ bgg_rank__isnull: false, num_votes__gte: 500, mechanic: 2987 })).not.toThrow();
  });

  it('treats a corpus-sized response to a narrowed query as a failure', () => {
    const params = { bgg_rank__isnull: false, num_votes__gte: 500 };
    expect(() => assertFilterApplied('u', params, RANKED_CORPUS)).toThrow(FilterIgnoredError);
    expect(() => assertFilterApplied('u', params, RANKED_CORPUS + 5_000)).toThrow(FilterIgnoredError);
    expect(() => assertFilterApplied('u', params, 2_545)).not.toThrow();
  });

  it('checks a rank-only query against the unfiltered corpus, not the ranked one', () => {
    const params = { bgg_rank__isnull: false };
    // 31,135 ranked games is the correct answer here, not a dropped filter.
    expect(() => assertFilterApplied('u', params, RANKED_CORPUS)).not.toThrow();
    expect(() => assertFilterApplied('u', params, UNFILTERED_CORPUS)).toThrow(FilterIgnoredError);
  });

  // The gap the count check cannot close, and the reason the row check exists.
  //
  // Every real query sends two or three narrowing filters together. Drop the
  // mechanic and keep the other two and the response is roughly 2,545 rows,
  // which is far under the 31,135 baseline, so the count check passes it and the
  // tool ranks the highest-rated ranked games instead of games like the seed.
  // The test above asserts exactly that count passing, which is correct for what
  // it measures and is why a second check was needed rather than a tighter one.
  it('accepts a count the row check is meant to catch, so the two are not redundant', () => {
    const params = { bgg_rank__isnull: false, num_votes__gte: 500, mechanic: 2987 };
    expect(() => assertFilterApplied('u', params, 2_545)).not.toThrow();
  });

  it('rejects a row that violates a filter the query asked for', () => {
    const rows = [row({ name: 'Thin Game', num_votes: 12 })];
    expect(() => assertRowsSatisfyFilters('u', { num_votes__gte: 500 }, rows)).toThrow(FilterNotAppliedError);
    expect(() => assertRowsSatisfyFilters('u', { num_votes__gte: 10 }, rows)).not.toThrow();
  });

  it('rejects an unranked row from a ranked-only query', () => {
    const rows = [row({ name: 'Unranked', bgg_rank: null })];
    expect(() => assertRowsSatisfyFilters('u', { bgg_rank__isnull: false }, rows)).toThrow(FilterNotAppliedError);
    expect(() => assertRowsSatisfyFilters('u', { bgg_rank__isnull: true }, rows)).not.toThrow();
  });

  it('treats a missing field as a match, because the upstream does', () => {
    // recommend.games keeps rows whose filtered field is null rather than
    // dropping them. Calling that a violation would throw on legitimate data.
    const rows = [row({ name: 'No Complexity', complexity: null })];
    expect(() => assertRowsSatisfyFilters('u', { complexity__lte: 2 }, rows)).not.toThrow();
  });

  it('ignores filters no row field can answer', () => {
    // `mechanic` is an id and the row carries names, so the client cannot check
    // it. findSimilarGames does, where the name it asked for is in scope.
    const rows = [row({ name: 'Anything' })];
    expect(() => assertRowsSatisfyFilters('u', { mechanic: 2987 }, rows)).not.toThrow();
  });

  it('ignores paging and ordering when deciding whether a filter was applied', () => {
    expect(() => assertFilterApplied('u', { page: 2, page_size: 25, ordering: '-bayes_rating' }, UNFILTERED_CORPUS)).not.toThrow();
  });

  it('surfaces a dropped filter through the client rather than returning 133k games', async () => {
    const fetch = vi.fn(async () => jsonResponse({ count: UNFILTERED_CORPUS, next: null, previous: null, results: [catan] }));
    const client = new RecommendGamesClient({ http: new HttpClient({ fetch: fakeFetch(fetch), sleep: async () => undefined }) });

    // Not retried, not cached, not degraded — it is our bug and it must be loud.
    await expect(client.query({ bgg_rank__isnull: false, num_votes__gte: 500 })).rejects.toThrow(FilterIgnoredError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('a 503-prone upstream', () => {
  it('retries a 503 with bounded, increasing backoff', async () => {
    const delays: number[] = [];
    const fetch = vi.fn(async () => serviceUnavailable());
    const http = new HttpClient(
      { fetch: fakeFetch(fetch), sleep: async (ms) => { delays.push(ms); }, random: () => 1 },
      { attempts: 3, baseDelayMs: 100 },
    );

    await expect(http.getJson('https://recommend.games/api/games/13/')).rejects.toThrow(UpstreamError);
    expect(fetch).toHaveBeenCalledTimes(3);
    // Two sleeps for three attempts, and the second waits longer than the first.
    expect(delays).toHaveLength(2);
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    expect(delays[1]).toBeLessThanOrEqual(200);
  });

  it('does not retry a 400, because a bad query is a bug and not a blip', async () => {
    const fetch = vi.fn(async () => new Response('bad', { status: 400, statusText: 'Bad Request' }));
    const http = new HttpClient({ fetch: fakeFetch(fetch), sleep: async () => undefined });

    await expect(http.getJson('https://recommend.games/api/games/')).rejects.toThrow(UpstreamError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serves stale cache with its age when the upstream goes down', async () => {
    let now = 0;
    let up = true;
    const fetch = vi.fn(async () => (up ? jsonResponse(catan) : serviceUnavailable()));
    const client = new RecommendGamesClient({
      http: new HttpClient({ fetch: fakeFetch(fetch), sleep: async () => undefined }),
      detailTtlMs: 60_000,
      now: () => now,
    });

    const first = await client.getGame(13);
    expect(first.cache).toEqual({ hit: false, stale: false, ageSeconds: null });

    // Well past the TTL, and now the service is having one of its afternoons.
    now = 40 * 60_000;
    up = false;
    const second = await client.getGame(13);

    expect(second.value.name).toBe('Catan');
    expect(second.cache.hit).toBe(true);
    expect(second.cache.stale).toBe(true);
    expect(second.cache.ageSeconds).toBe(2400);
  });

  it('fails cleanly when the upstream is down and nothing is cached', async () => {
    const client = new RecommendGamesClient({
      http: new HttpClient({ fetch: fakeFetch(async () => serviceUnavailable()), sleep: async () => undefined }),
    });
    await expect(client.getGame(13)).rejects.toThrow(UpstreamError);
  });

  it('serves a fresh cache hit without touching the network', async () => {
    const fetch = vi.fn(async () => jsonResponse(catan));
    const client = new RecommendGamesClient({
      http: new HttpClient({ fetch: fakeFetch(fetch), sleep: async () => undefined }),
    });

    await client.getGame(13);
    const second = await client.getGame(13);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second.cache).toMatchObject({ hit: true, stale: false });
  });

  it('sends exactly one request at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return jsonResponse(catan);
    });
    const http = new HttpClient({ fetch: fakeFetch(fetch), sleep: async () => undefined });

    await Promise.all([1, 2, 3, 4, 5].map((id) => http.getJson(`https://recommend.games/api/games/${id}/`)));
    expect(peak).toBe(1);
  });

  it('keeps the queue running after a failed request', async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      return call === 1 ? serviceUnavailable() : jsonResponse(catan);
    });
    const http = new HttpClient({ fetch: fakeFetch(fetch), sleep: async () => undefined }, { attempts: 1 });

    // A rejected task must not poison the serial queue for everything behind it.
    await expect(http.getJson('https://recommend.games/api/games/1/')).rejects.toThrow(UpstreamError);
    await expect(http.getJson('https://recommend.games/api/games/2/')).resolves.toMatchObject({ name: 'Catan' });
  });
});
