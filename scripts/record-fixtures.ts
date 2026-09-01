/**
 * Records real upstream responses into test/fixtures/.
 *
 * Fixtures are recorded rather than hand-written so they keep the upstream's
 * actual quirks — the nulls, the 25-row page cap, the relation id lists. They
 * are also what makes `npm run demo` and the test suite work with the upstream
 * down, which given how readily it 503s is not a hypothetical.
 *
 * Run: npx tsx scripts/record-fixtures.ts
 */
import { writeFileSync } from 'node:fs';
import { HttpClient } from '../src/lib/http.js';
import { RawGameSchema } from '../src/clients/gameSchema.js';
import { MechanicVocabulary } from '../src/tools/shared.js';

const BASE = 'https://recommend.games/api';

const SEEDS = [
  { id: 13, slug: 'catan' },
  { id: 266192, slug: 'wingspan' },
];

/** The exact pool query the tools issue, so fixtures line up with cache keys. */
const POOL = 'bgg_rank__isnull=false&num_votes__gte=500&ordering=-bayes_rating&page_size=25';

async function main(): Promise<void> {
  const http = new HttpClient();
  const out: Record<string, unknown> = {};

  const vocabulary = MechanicVocabulary.load();
  const mechanicIds = new Set<number>();

  for (const seed of SEEDS) {
    const detail = await http.getJson(`${BASE}/games/${seed.id}/?format=json`);
    out[`game_${seed.slug}`] = detail;
    // Derive the mechanic each seed will actually be queried on, rather than
    // hardcoding an id that silently drifts when the vocabulary changes.
    const mechanic = vocabulary.mostDistinctive(RawGameSchema.parse(detail).mechanic_name);
    if (mechanic) mechanicIds.add(mechanic.bgg_id);
    console.error(`recorded game ${seed.slug} (mechanic ${mechanic?.name ?? 'none'})`);
  }

  // Pages 1–8 of the shared candidate pool: what suggest_games_for_group reads.
  for (let page = 1; page <= 8; page += 1) {
    out[`pool_page_${page}`] = await http.getJson(`${BASE}/games/?format=json&${POOL}&page=${page}`);
    console.error(`recorded pool page ${page}`);
  }

  // Each seed's distinctive-mechanic pool: what find_similar_games reads.
  for (const mechanic of mechanicIds) {
    for (let page = 1; page <= 3; page += 1) {
      out[`mechanic_${mechanic}_page_${page}`] = await http.getJson(
        `${BASE}/games/?format=json&${POOL}&mechanic=${mechanic}&page=${page}`,
      );
      console.error(`recorded mechanic ${mechanic} page ${page}`);
    }
  }

  writeFileSync('test/fixtures/recommend-games.json', `${JSON.stringify(out, null, 1)}\n`);
  console.error('wrote test/fixtures/recommend-games.json');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
