import type { RawGame } from '../clients/gameSchema.js';

/**
 * Similarity is plain arithmetic over fields the API actually returns. No
 * embeddings, no model — every number here can be recomputed by hand from the
 * two games being compared, which is what makes the `why` string trustworthy
 * rather than decorative.
 */

export interface Component {
  key: string;
  weight: number;
  /** 0–1, or null when the data needed to judge it is missing. */
  value: number | null;
}

/**
 * Weighted mean over the components we could actually evaluate.
 *
 * Missing data lowers the denominator rather than scoring zero. A game with no
 * recorded complexity should not be pushed down the list for it — that would
 * quietly bias results towards well-documented games, which correlates with
 * popularity and would make the recommendations circular.
 */
export function combine(components: Component[]): number {
  let weighted = 0;
  let total = 0;
  for (const component of components) {
    if (component.value === null) continue;
    weighted += component.weight * component.value;
    total += component.weight;
  }
  return total === 0 ? 0 : weighted / total;
}

/**
 * Jaccard over the two lists treated as sets.
 *
 * The intersection is de-duplicated, which the first version was not: it counted
 * matches with a filter over the raw array while dividing by a de-duplicated
 * union, so a repeated entry on the left could push the result above 1. Three
 * mechanics with one repeat against two scored 1.5. The upstream is not known to
 * repeat a mechanic, so this may never have fired, but a similarity that can
 * exceed its own maximum is not worth leaving to the upstream's good behaviour.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  const shared = sharedItems(a, b).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? null : shared / union;
}

/** The intersection, de-duplicated and in the order `a` gives. */
export function sharedItems(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of a) {
    if (!setB.has(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** 1 when identical, falling to 0 at twice the caller's tolerance. */
export function proximity(a: number | null, b: number | null, fullPenaltyAt: number): number | null {
  if (a === null || b === null || fullPenaltyAt <= 0) return null;
  return Math.max(0, 1 - Math.abs(a - b) / fullPenaltyAt);
}

/** How much of the seed's supported player range the candidate also supports. */
export function playerOverlap(seed: RawGame, candidate: RawGame): number | null {
  const seedMin = seed.min_players;
  const seedMax = seed.max_players;
  const candMin = candidate.min_players;
  const candMax = candidate.max_players;
  if (seedMin === null || seedMax === null || candMin === null || candMax === null) return null;
  const low = Math.max(seedMin, candMin);
  const high = Math.min(seedMax, candMax);
  if (high < low) return 0;
  const seedSpan = seedMax - seedMin + 1;
  return seedSpan <= 0 ? null : (high - low + 1) / seedSpan;
}

function midpoint(min: number | null, max: number | null): number | null {
  if (min === null && max === null) return null;
  if (min === null) return max;
  if (max === null) return min;
  return (min + max) / 2;
}

/** Community rating, mapped onto 0–1. Only ever a tie-break. */
export function qualitySignal(game: RawGame): number | null {
  if (game.bayes_rating === null) return null;
  return Math.min(1, Math.max(0, (game.bayes_rating - 5.5) / 2.5));
}

export interface SimilarityResult {
  score: number;
  sharedMechanics: string[];
  why: string;
}

export interface SimilarityOptions {
  /** Complexity distance, on BGG's 1–5 weight scale, at which the score hits 0. */
  complexityTolerance: number;
}

/**
 * Weights, and why they are what they are.
 *
 * Mechanics dominate because they are what a game *is* — two games sharing
 * worker placement and area control play alike even across themes. Categories
 * are thematic and much coarser ("Economic" spans Monopoly and Food Chain
 * Magnate), so they count for less. Complexity matters a lot to whether a
 * recommendation lands with a given group, hence third. Rating is deliberately
 * the smallest term: it breaks ties between similar games without letting a
 * popular but unrelated game outrank a genuinely similar one.
 */
export function scoreSimilarity(seed: RawGame, candidate: RawGame, options: SimilarityOptions): SimilarityResult {
  const shared = sharedItems(seed.mechanic_name, candidate.mechanic_name);
  const sharedCategories = sharedItems(seed.category_name, candidate.category_name);

  const components: Component[] = [
    { key: 'mechanics', weight: 0.4, value: jaccard(seed.mechanic_name, candidate.mechanic_name) },
    { key: 'categories', weight: 0.15, value: jaccard(seed.category_name, candidate.category_name) },
    { key: 'game_type', weight: 0.05, value: jaccard(seed.game_type_name, candidate.game_type_name) },
    {
      key: 'complexity',
      weight: 0.2,
      value: proximity(seed.complexity, candidate.complexity, options.complexityTolerance * 2),
    },
    { key: 'players', weight: 0.1, value: playerOverlap(seed, candidate) },
    {
      key: 'playtime',
      weight: 0.05,
      value: proximity(
        midpoint(seed.min_time, seed.max_time),
        midpoint(candidate.min_time, candidate.max_time),
        120,
      ),
    },
    { key: 'rating', weight: 0.05, value: qualitySignal(candidate) },
  ];

  return {
    score: Number(combine(components).toFixed(4)),
    sharedMechanics: shared,
    why: explainSimilarity(seed, candidate, shared, sharedCategories),
  };
}

function explainSimilarity(
  seed: RawGame,
  candidate: RawGame,
  shared: string[],
  sharedCategories: string[],
): string {
  const parts: string[] = [];

  if (shared.length > 0) {
    const headline = shared.slice(0, 3).join(', ');
    parts.push(`shares ${shared.length} of ${seed.mechanic_name.length} mechanics (${headline})`);
  } else {
    parts.push('no mechanics in common');
  }

  if (sharedCategories.length > 0) parts.push(`both ${sharedCategories.slice(0, 2).join(' and ')}`);

  if (seed.complexity !== null && candidate.complexity !== null) {
    parts.push(`complexity ${candidate.complexity.toFixed(1)} vs ${seed.complexity.toFixed(1)}`);
  }

  const players = describePlayers(candidate);
  if (players) parts.push(players);

  const time = describeTime(candidate);
  if (time) parts.push(time);

  return `${parts.join('; ')}.`;
}

export function describePlayers(game: RawGame): string | null {
  if (game.min_players === null || game.max_players === null) return null;
  const range = game.min_players === game.max_players ? `${game.min_players}` : `${game.min_players}–${game.max_players}`;
  const best = bestPlayerCount(game);
  return best ? `plays ${range} (best at ${best})` : `plays ${range}`;
}

/**
 * BGG's community "best at N" poll, which is a different and more useful claim
 * than the box's supported range — plenty of games technically support six
 * players and are miserable with six.
 */
export function bestPlayerCount(game: RawGame): string | null {
  const { min_players_best: min, max_players_best: max } = game;
  if (min === null && max === null) return null;
  if (min !== null && max !== null) return min === max ? `${min}` : `${min}–${max}`;
  return String(min ?? max);
}

export function describeTime(game: RawGame): string | null {
  if (game.min_time === null && game.max_time === null) return null;
  if (game.min_time !== null && game.max_time !== null && game.min_time !== game.max_time) {
    return `${game.min_time}–${game.max_time} min`;
  }
  return `${game.max_time ?? game.min_time} min`;
}
