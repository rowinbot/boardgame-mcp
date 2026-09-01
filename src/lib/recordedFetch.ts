import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A `fetch`-shaped function that replays recorded upstream responses.
 *
 * Used by the offline demo and by the tests. recommend.games 503s readily, so
 * "the reviewer runs the demo and the upstream happens to be down" is a likely
 * outcome rather than an edge case; replaying real recorded traffic means the
 * demo still shows real data instead of an apology.
 */
const FIXTURE_PATH = fileURLToPath(new URL('../../test/fixtures/recommend-games.json', import.meta.url));

type Fixtures = Record<string, unknown>;

export function loadFixtures(path: string = FIXTURE_PATH): Fixtures {
  return JSON.parse(readFileSync(path, 'utf8')) as Fixtures;
}

/** Maps a request URL back to the fixture key used when recording it. */
export function fixtureKeyFor(url: string): string | undefined {
  const parsed = new URL(url);

  const detail = /\/api\/games\/(\d+)\/$/.exec(parsed.pathname);
  if (detail) {
    const ids: Record<string, string> = { '13': 'game_catan', '266192': 'game_wingspan' };
    return ids[detail[1] as string];
  }

  const page = parsed.searchParams.get('page') ?? '1';
  const mechanic = parsed.searchParams.get('mechanic');
  return mechanic ? `mechanic_${mechanic}_page_${page}` : `pool_page_${page}`;
}

export interface RecordedFetchOptions {
  fixtures?: Fixtures;
  /** Called for every request, so tests can assert on upstream traffic. */
  onRequest?: (url: string) => void;
}

export function createRecordedFetch(options: RecordedFetchOptions = {}): typeof globalThis.fetch {
  const fixtures = options.fixtures ?? loadFixtures();

  return (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    options.onRequest?.(url);

    const key = fixtureKeyFor(url);
    const body = key ? fixtures[key] : undefined;
    if (body === undefined) {
      return new Response('Not recorded', { status: 404, statusText: 'Not Found' });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}
