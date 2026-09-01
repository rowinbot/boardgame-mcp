import { z } from 'zod';

/**
 * Output schemas are declared, advertised on `tools/list`, and validated on the
 * way out. Validating our own output sounds redundant until the upstream
 * changes a field's nullability — then it is the difference between a loud
 * failure here and a malformed payload reaching the model.
 */

export const SourceSchema = z.object({
  api: z.string(),
  attribution: z.string(),
});

export const CacheSchema = z.object({
  hit: z.boolean().describe('Whether any part of this answer came from cache'),
  stale: z.boolean().describe('True when cached data was served because the upstream was failing'),
  age_seconds: z.number().nullable(),
  note: z.string().nullable().describe('Set when staleness materially affects the answer'),
});

export const GameSummarySchema = z.object({
  name: z.string(),
  bgg_id: z.number().int(),
  year: z.number().int().nullable(),
  complexity: z.number().nullable().describe('BGG weight, 1 (lightest) to 5 (heaviest)'),
  players: z.object({
    min: z.number().nullable(),
    max: z.number().nullable(),
    best: z.string().nullable().describe("BGG community's best-at-N poll result"),
  }),
  playtime_minutes: z.object({ min: z.number().nullable(), max: z.number().nullable() }),
  bgg_rank: z.number().nullable(),
  rating: z.number().nullable().describe('Bayesian average rating'),
  mechanics: z.array(z.string()),
  categories: z.array(z.string()),
  cooperative: z.boolean().nullable(),
  bgg_url: z.string(),
});

export const RecommendationSchema = GameSummarySchema.extend({
  score: z.number().describe('0–1 fit score'),
  why: z.string().describe('Plain-language justification, repeatable to a user'),
  shared_mechanics: z.array(z.string()),
});

export const SOURCE = {
  api: 'https://recommend.games/api',
  attribution:
    'Game data from recommend.games, derived from BoardGameGeek. Name index from ' +
    'beefsack/bgg-ranking-historicals. Not affiliated with or endorsed by BoardGameGeek.',
} as const;
