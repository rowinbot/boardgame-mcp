import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { RawGame } from '../clients/gameSchema.js';
import { bggUrl } from '../clients/gameSchema.js';
import type { RecommendGamesClient } from '../clients/recommendGames.js';
import type { NameIndex } from '../clients/nameIndex.js';
import { bestPlayerCount } from '../lib/score.js';
import { GameSummarySchema } from '../schemas.js';

export interface ToolDeps {
  games: RecommendGamesClient;
  index: NameIndex;
  mechanics: MechanicVocabulary;
}

export type GameSummary = z.infer<typeof GameSummarySchema>;

export function toSummary(game: RawGame): GameSummary {
  return {
    name: game.name,
    bgg_id: game.bgg_id,
    year: game.year,
    complexity: game.complexity,
    players: { min: game.min_players, max: game.max_players, best: bestPlayerCount(game) },
    playtime_minutes: { min: game.min_time, max: game.max_time },
    bgg_rank: game.bgg_rank,
    rating: game.bayes_rating,
    mechanics: game.mechanic_name,
    categories: game.category_name,
    cooperative: game.cooperative,
    bgg_url: bggUrl(game),
  };
}

export interface MechanicRow {
  bgg_id: number;
  name: string;
  /** How many of the 133k games use this mechanic. Lower means more distinctive. */
  count: number;
}

const VOCAB_PATH = fileURLToPath(new URL('../../data/mechanics.json', import.meta.url));

/**
 * The mechanic vocabulary with corpus frequencies, used to pick a *distinctive*
 * mechanic to query on.
 *
 * This matters more than it looks. "Dice Rolling" appears on 30,371 games and
 * says nothing about what a game is like; "Random Production" appears on 128 and
 * says a great deal. Querying on the first mechanic in the list instead of the
 * rarest one is the difference between a real recommendation and a popularity
 * chart.
 */
export class MechanicVocabulary {
  private readonly byName = new Map<string, MechanicRow>();

  constructor(rows: MechanicRow[]) {
    for (const row of rows) this.byName.set(row.name, row);
  }

  static load(path: string = VOCAB_PATH): MechanicVocabulary {
    return new MechanicVocabulary(JSON.parse(readFileSync(path, 'utf8')) as MechanicRow[]);
  }

  get(name: string): MechanicRow | undefined {
    return this.byName.get(name);
  }

  /**
   * The rarest of the given mechanics that still has a workable candidate pool.
   *
   * Going too rare backfires: a mechanic on 11 games yields nothing to rank once
   * the vote threshold is applied. `minCorpus` is the floor below which we would
   * rather trade some distinctiveness for a usable pool.
   */
  mostDistinctive(names: readonly string[], minCorpus = 300): MechanicRow | undefined {
    const known = names
      .map((name) => this.byName.get(name))
      .filter((row): row is MechanicRow => row !== undefined)
      .sort((a, b) => a.count - b.count);
    if (known.length === 0) return undefined;
    return known.find((row) => row.count >= minCorpus) ?? known[0];
  }
}

/** Games that are the same game: expansions, reimplementations, compilations. */
export function relatedIds(seed: RawGame): Set<number> {
  return new Set<number>([
    seed.bgg_id,
    ...seed.implements,
    ...seed.implemented_by,
    ...seed.integrates_with,
    ...seed.contained_in,
    ...seed.compilation_of,
  ]);
}

export interface CacheState {
  hit: boolean;
  stale: boolean;
  age_seconds: number | null;
  note: string | null;
}

/** Folds the cache state of several upstream calls into one honest summary. */
export class CacheTracker {
  private hit = false;
  private stale = false;
  private oldest: number | null = null;

  record(cache: { hit: boolean; stale: boolean; ageSeconds: number | null }): void {
    if (cache.hit) this.hit = true;
    if (cache.stale) this.stale = true;
    if (cache.ageSeconds !== null && (this.oldest === null || cache.ageSeconds > this.oldest)) {
      this.oldest = cache.ageSeconds;
    }
  }

  state(): CacheState {
    return {
      hit: this.hit,
      stale: this.stale,
      age_seconds: this.oldest,
      note: this.stale
        ? `recommend.games was unavailable, so this answer was served from cache ` +
          `${this.oldest === null ? 'of unknown age' : `${Math.round(this.oldest / 60)} minutes old`}. ` +
          `Rankings and ratings may have moved since.`
        : null,
    };
  }
}
