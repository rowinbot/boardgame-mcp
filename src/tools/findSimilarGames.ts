import { z } from 'zod';
import type { RawGame } from '../clients/gameSchema.js';
import { ToolError } from '../lib/errors.js';
import { scoreSimilarity } from '../lib/score.js';
import { MAX_PAGE_SIZE, type QueryParams } from '../clients/recommendGames.js';
import { CacheSchema, RecommendationSchema, SOURCE, SourceSchema, GameSummarySchema } from '../schemas.js';
import { CacheTracker, relatedIds, toSummary, type ToolDeps } from './shared.js';

export const inputSchema = z.object({
  game: z.string().min(2).max(120).describe('Board game name, e.g. "Wingspan". Resolved against BGG ranked games.'),
  limit: z.number().int().min(1).max(20).default(8).describe('How many recommendations to return'),
  complexity_tolerance: z
    .number()
    .min(0.1)
    .max(2)
    .default(0.5)
    .describe('How far from the seed game\'s BGG weight (1–5) a recommendation may drift before scoring zero on complexity'),
});

export const outputSchema = z.object({
  seed: GameSummarySchema,
  recommendations: z.array(RecommendationSchema),
  resolution: z.object({
    matched: z.enum(['exact', 'case_insensitive', 'fuzzy']),
    query: z.string(),
    alternatives: z.array(z.string()).describe('Other games the name could have meant'),
  }),
  method: z.object({
    queried_mechanic: z.string().nullable(),
    candidates_considered: z.number().int(),
    upstream_requests: z.number().int(),
  }),
  source: SourceSchema,
  cache: CacheSchema,
});

export type Input = z.infer<typeof inputSchema>;
export type Output = z.infer<typeof outputSchema>;

/** Keeps well-known games in the pool. Below this, ratings are noise. */
const MIN_VOTES = 500;
/** Bounded so a single tool call cannot hammer a service that falls over at ~5 requests. */
const MAX_CANDIDATE_PAGES = 3;

export const config = {
  title: 'Find similar board games',
  description:
    'Given a board game, find others that play like it. Resolves the name against BoardGameGeek ' +
    'ranked games, then scores candidates on shared mechanics, categories, complexity, player count ' +
    'and playtime. Excludes the game itself and its expansions and reimplementations. Every result ' +
    'carries a plain-language reason it was chosen.',
  inputSchema,
  outputSchema,
} as const;

export async function findSimilarGames(deps: ToolDeps, input: Input): Promise<Output> {
  const cache = new CacheTracker();
  const resolution = deps.index.resolve(input.game);

  const seedFetch = await deps.games.getGame(resolution.entry.bggId);
  cache.record(seedFetch.cache);
  const seed = seedFetch.value;

  const mechanic = deps.mechanics.mostDistinctive(seed.mechanic_name);
  const excluded = relatedIds(seed);

  const base: QueryParams = {
    bgg_rank__isnull: false,
    num_votes__gte: MIN_VOTES,
    ordering: '-bayes_rating',
    page_size: MAX_PAGE_SIZE,
  };

  const candidates = new Map<number, RawGame>();
  let requests = 0;

  // Server-side we use only the filters measured to be cheap; every fine-grained
  // constraint is applied locally. See the README for the latency numbers that
  // forced this split — stacking range filters reliably exceeds Heroku's 30s cap.
  const pool = mechanic ? { ...base, mechanic: mechanic.bgg_id } : base;
  for (let page = 1; page <= MAX_CANDIDATE_PAGES; page += 1) {
    const result = await deps.games.query({ ...pool, page });
    requests += 1;
    cache.record(result.cache);
    for (const game of result.value.results) {
      if (!excluded.has(game.bgg_id)) candidates.set(game.bgg_id, game);
    }
    if (!result.value.next) break;
  }

  // A very distinctive mechanic can leave too little to rank. Widen once, on the
  // cheapest axis available, rather than returning three thin results.
  if (candidates.size < input.limit * 2 && mechanic) {
    const result = await deps.games.query({ ...base, page: 1 });
    requests += 1;
    cache.record(result.cache);
    for (const game of result.value.results) {
      if (!excluded.has(game.bgg_id)) candidates.set(game.bgg_id, game);
    }
  }

  if (candidates.size === 0) {
    throw new ToolError(
      `Found "${seed.name}" but no candidate games came back to compare it against.`,
      'no_results',
      'recommend.games may be degraded. Retrying in a minute usually works.',
    );
  }

  const recommendations = [...candidates.values()]
    .map((candidate) => {
      const similarity = scoreSimilarity(seed, candidate, { complexityTolerance: input.complexity_tolerance });
      return {
        ...toSummary(candidate),
        score: similarity.score,
        why: similarity.why,
        shared_mechanics: similarity.sharedMechanics,
      };
    })
    .sort((a, b) => b.score - a.score || (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, input.limit);

  return {
    seed: toSummary(seed),
    recommendations,
    resolution: {
      matched: resolution.matched,
      query: input.game,
      alternatives: resolution.alternatives,
    },
    method: {
      queried_mechanic: mechanic ? `${mechanic.name} (${mechanic.count} games use it)` : null,
      candidates_considered: candidates.size,
      upstream_requests: requests,
    },
    source: SOURCE,
    cache: cache.state(),
  };
}
