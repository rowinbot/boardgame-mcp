import { z } from 'zod';
import type { RawGame } from '../clients/gameSchema.js';
import { ToolError } from '../lib/errors.js';
import { combine, describePlayers, describeTime, proximity, qualitySignal, type Component } from '../lib/score.js';
import { MAX_PAGE_SIZE, type QueryParams } from '../clients/recommendGames.js';
import { CacheSchema, RecommendationSchema, SOURCE, SourceSchema } from '../schemas.js';
import { CacheTracker, toSummary, type ToolDeps } from './shared.js';
import { normalize } from '../clients/nameIndex.js';

/** BGG weight bands. Stated in the schema so the caller knows what "light" bought them. */
const COMPLEXITY_BANDS = {
  light: { min: 1, max: 2.0 },
  medium: { min: 2.0, max: 3.2 },
  heavy: { min: 3.2, max: 5 },
  any: { min: 1, max: 5 },
} as const;

export const inputSchema = z.object({
  players: z.number().int().min(1).max(20).describe('How many people will actually be playing'),
  max_minutes: z.number().int().min(10).max(480).optional().describe('Longest acceptable playtime'),
  complexity: z
    .enum(['light', 'medium', 'heavy', 'any'])
    .default('any')
    .describe('BGG weight band: light ≤2.0, medium 2.0–3.2, heavy ≥3.2'),
  cooperative: z.boolean().optional().describe('Restrict to co-op games, or to competitive games'),
  best_at_count: z
    .boolean()
    .default(false)
    .describe("Require the BGG community's best-at-N poll to include this player count, not merely that the box supports it"),
  exclude: z.array(z.string()).max(20).default([]).describe('Games already owned or ruled out, by name'),
  limit: z.number().int().min(1).max(20).default(8),
});

export const outputSchema = z.object({
  criteria: z.object({
    players: z.number().int(),
    max_minutes: z.number().int().nullable(),
    complexity_band: z.object({ label: z.string(), min: z.number(), max: z.number() }),
    cooperative: z.boolean().nullable(),
    best_at_count_required: z.boolean(),
    excluded: z.array(z.string()),
  }),
  suggestions: z.array(RecommendationSchema),
  result_count: z.number().int(),
  coverage_note: z.string().nullable(),
  method: z.object({ candidates_considered: z.number().int(), upstream_requests: z.number().int() }),
  source: SourceSchema,
  cache: CacheSchema,
});

export type Input = z.infer<typeof inputSchema>;
export type Output = z.infer<typeof outputSchema>;

const MIN_VOTES = 500;
/**
 * Pages are pulled until enough games match or this budget is spent. Four would
 * be too few: `-bayes_rating` puts heavy games first, so a request for light
 * games has to read further down the list before it finds them.
 */
const MAX_PAGES = 8;

export const config = {
  title: 'Suggest board games for a group',
  description:
    'Recommend board games for a specific group: how many people, how long they have, and how heavy ' +
    'a game they want. Can require the BoardGameGeek community best-at-N player poll rather than the ' +
    "box's supported range, which is the difference between a game that works with six and one that " +
    'merely permits six. Echoes back the resolved numeric criteria so the caller can see exactly what ' +
    'the request was interpreted as.',
  inputSchema,
  outputSchema,
} as const;

export async function suggestGamesForGroup(deps: ToolDeps, input: Input): Promise<Output> {
  const cache = new CacheTracker();
  const band = COMPLEXITY_BANDS[input.complexity];
  const excluded = new Set(input.exclude.map(normalize));

  const base: QueryParams = {
    bgg_rank__isnull: false,
    num_votes__gte: MIN_VOTES,
    ordering: '-bayes_rating',
    page_size: MAX_PAGE_SIZE,
  };

  // Note what is *not* in that query: the complexity band, though the API
  // supports `complexity__gte`/`complexity__lte` and they genuinely filter.
  // Sending them was the first implementation and it 503'd in testing. Range
  // filters on this upstream cost 13–29s on their own against a 30s router
  // timeout, so the band is applied in memory instead and the cost is paid in
  // cheap extra pages. See MEASUREMENTS in clients/recommendGames.ts.

  const matches: RawGame[] = [];
  let considered = 0;
  let requests = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await deps.games.query({ ...base, page });
    requests += 1;
    cache.record(result.cache);
    considered += result.value.results.length;

    for (const game of result.value.results) {
      if (inBand(game, band) && matchesGroup(game, input, excluded)) matches.push(game);
    }
    if (!result.value.next || matches.length >= input.limit * 2) break;
  }

  if (matches.length === 0) {
    throw new ToolError(
      `No ranked board game matched ${describeCriteria(input)}.`,
      'no_results',
      'Try relaxing one constraint — a wider complexity band, a longer time limit, or best_at_count set to false.',
    );
  }

  const suggestions = matches
    .map((game) => {
      const fit = scoreGroupFit(game, input, band);
      return { ...toSummary(game), score: fit.score, why: fit.why, shared_mechanics: [] };
    })
    .sort((a, b) => b.score - a.score || (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, input.limit);

  return {
    criteria: {
      players: input.players,
      max_minutes: input.max_minutes ?? null,
      complexity_band: { label: input.complexity, min: band.min, max: band.max },
      cooperative: input.cooperative ?? null,
      best_at_count_required: input.best_at_count,
      excluded: input.exclude,
    },
    suggestions,
    result_count: suggestions.length,
    coverage_note: coverageNote(matches.length, considered, input),
    method: { candidates_considered: considered, upstream_requests: requests },
    source: SOURCE,
    cache: cache.state(),
  };
}

interface Band {
  min: number;
  max: number;
}

/** Complexity band check. Games with no recorded weight pass only an "any" request. */
export function inBand(game: RawGame, band: Band): boolean {
  if (band.min <= 1 && band.max >= 5) return true;
  if (game.complexity === null) return false;
  return game.complexity >= band.min && game.complexity <= band.max;
}

export function matchesGroup(game: RawGame, input: Input, excludedNames: Set<string>): boolean {
  if (excludedNames.has(normalize(game.name))) return false;

  if (game.min_players !== null && input.players < game.min_players) return false;
  if (game.max_players !== null && input.players > game.max_players) return false;

  if (input.best_at_count) {
    const { min_players_best: min, max_players_best: max } = game;
    // No poll data means we cannot assert the game is good at this count, and the
    // whole point of the flag is that assertion. Excluding is the honest choice.
    if (min === null || max === null) return false;
    if (input.players < min || input.players > max) return false;
  }

  if (input.max_minutes !== undefined) {
    const shortest = game.min_time ?? game.max_time;
    if (shortest !== null && shortest > input.max_minutes) return false;
  }

  if (input.cooperative !== undefined && game.cooperative !== null && game.cooperative !== input.cooperative) {
    return false;
  }

  return true;
}

function scoreGroupFit(game: RawGame, input: Input, band: Band): { score: number; why: string } {
  const bandCentre = (band.min + band.max) / 2;
  const components: Component[] = [
    // Sitting in the middle of the requested weight band beats scraping its edge.
    { key: 'complexity', weight: 0.3, value: proximity(game.complexity, bandCentre, (band.max - band.min) || 1) },
    { key: 'best_at_count', weight: 0.35, value: bestAtScore(game, input.players) },
    { key: 'playtime', weight: 0.15, value: playtimeScore(game, input.max_minutes) },
    { key: 'rating', weight: 0.2, value: qualitySignal(game) },
  ];

  return { score: Number(combine(components).toFixed(4)), why: explainFit(game, input) };
}

/** 1 when the community says this count is best, 0.5 when merely supported. */
function bestAtScore(game: RawGame, players: number): number | null {
  const { min_players_best: min, max_players_best: max } = game;
  if (min === null || max === null) return null;
  return players >= min && players <= max ? 1 : 0.5;
}

function playtimeScore(game: RawGame, maxMinutes: number | undefined): number | null {
  if (maxMinutes === undefined) return null;
  const shortest = game.min_time ?? game.max_time;
  if (shortest === null) return null;
  // Comfortably inside the budget scores best; right at the limit still passes.
  return Math.max(0, Math.min(1, 1 - (shortest / maxMinutes) * 0.5));
}

function explainFit(game: RawGame, input: Input): string {
  const parts: string[] = [];
  const players = describePlayers(game);
  if (players) parts.push(players);

  const { min_players_best: min, max_players_best: max } = game;
  if (min !== null && max !== null && input.players >= min && input.players <= max) {
    parts.push(`BGG rates it best at ${input.players}`);
  }

  const time = describeTime(game);
  if (time) parts.push(time);
  if (game.complexity !== null) parts.push(`weight ${game.complexity.toFixed(1)}`);
  if (game.cooperative === true) parts.push('cooperative');
  if (game.bayes_rating !== null) parts.push(`rated ${game.bayes_rating.toFixed(2)}`);

  return `${parts.join('; ')}.`;
}

function describeCriteria(input: Input): string {
  const bits = [`${input.players} players`, `${input.complexity} complexity`];
  if (input.max_minutes !== undefined) bits.push(`under ${input.max_minutes} minutes`);
  if (input.cooperative !== undefined) bits.push(input.cooperative ? 'cooperative' : 'competitive');
  if (input.best_at_count) bits.push(`best at ${input.players}`);
  return bits.join(', ');
}

/**
 * Small result sets are a real property of the data, not a bug. Saying so stops
 * a caller reading three suggestions as a broken tool.
 */
function coverageNote(matched: number, considered: number, input: Input): string | null {
  if (matched >= input.limit) return null;
  return (
    `Only ${matched} of the ${considered} candidates examined matched. Candidates are the ` +
    `best-rated games with 500+ BGG ratings, read in rating order up to a fixed page budget, so ` +
    `this is the best of a strong shortlist rather than an exhaustive search of all 31,000 ranked ` +
    `games. Relaxing the complexity band or the time limit will widen it.`
  );
}
