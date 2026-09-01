import { describe, expect, it } from 'vitest';
import { RawGameSchema, type RawGame } from '../src/clients/gameSchema.js';
import { combine, jaccard, playerOverlap, proximity, scoreSimilarity } from '../src/lib/score.js';
import { findSimilarGames, inputSchema as similarInput, outputSchema as similarOutput } from '../src/tools/findSimilarGames.js';
import { suggestGamesForGroup, inputSchema as groupInput, outputSchema as groupOutput, matchesGroup } from '../src/tools/suggestGamesForGroup.js';
import { relatedIds } from '../src/tools/shared.js';
import { loadFixtures } from '../src/lib/recordedFetch.js';
import { fixtureDeps } from './support/deps.js';

const fixtures = loadFixtures();
const catan = RawGameSchema.parse(fixtures.game_catan);

/** A minimal game, so each test states only the fields it is actually about. */
function game(overrides: Partial<RawGame> & { bgg_id: number; name: string }): RawGame {
  return RawGameSchema.parse({ ...overrides });
}

describe('scoring arithmetic', () => {
  it('computes Jaccard overlap', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
    expect(jaccard([], ['a'])).toBeNull();
  });

  it('drops missing components from the average instead of scoring them zero', () => {
    // Otherwise a game with no recorded complexity is penalised for the gap,
    // which biases results towards well-documented — meaning popular — games.
    expect(combine([{ key: 'a', weight: 1, value: 0.5 }, { key: 'b', weight: 1, value: null }])).toBe(0.5);
    expect(combine([{ key: 'a', weight: 1, value: null }])).toBe(0);
  });

  it('scores proximity as a linear falloff to zero', () => {
    expect(proximity(2, 2, 1)).toBe(1);
    expect(proximity(2, 2.5, 1)).toBe(0.5);
    expect(proximity(2, 4, 1)).toBe(0);
    expect(proximity(2, null, 1)).toBeNull();
  });

  it('measures how much of the seed player range a candidate covers', () => {
    const seed = game({ bgg_id: 1, name: 'seed', min_players: 3, max_players: 4 });
    expect(playerOverlap(seed, game({ bgg_id: 2, name: 'a', min_players: 3, max_players: 4 }))).toBe(1);
    expect(playerOverlap(seed, game({ bgg_id: 3, name: 'b', min_players: 4, max_players: 6 }))).toBe(0.5);
    expect(playerOverlap(seed, game({ bgg_id: 4, name: 'c', min_players: 5, max_players: 6 }))).toBe(0);
  });

  it('ranks a mechanically identical game above a mechanically unrelated one', () => {
    const twin = game({
      bgg_id: 99,
      name: 'Catan-like',
      complexity: 2.3,
      min_players: 3,
      max_players: 4,
      min_time: 60,
      max_time: 120,
      mechanic_name: catan.mechanic_name,
      category_name: catan.category_name,
      game_type_name: catan.game_type_name,
      bayes_rating: 7,
    });
    const stranger = game({
      bgg_id: 100,
      name: 'Something else',
      complexity: 4.6,
      min_players: 1,
      max_players: 1,
      min_time: 300,
      max_time: 300,
      mechanic_name: ['Deck Construction'],
      category_name: ['Word Game'],
      bayes_rating: 8.4,
    });

    const options = { complexityTolerance: 0.5 };
    const twinScore = scoreSimilarity(catan, twin, options).score;
    const strangerScore = scoreSimilarity(catan, stranger, options).score;

    expect(twinScore).toBeGreaterThan(strangerScore);
    // The rating term is a tie-break only: a much better-rated but unrelated
    // game must not outrank a genuinely similar one.
    expect(strangerScore).toBeLessThan(0.4);
  });

  it('is deterministic', () => {
    const candidate = game({ bgg_id: 7, name: 'x', complexity: 2.2, mechanic_name: ['Trading'] });
    const a = scoreSimilarity(catan, candidate, { complexityTolerance: 0.5 });
    const b = scoreSimilarity(catan, candidate, { complexityTolerance: 0.5 });
    expect(a).toEqual(b);
  });

  it('explains itself in terms a person can check', () => {
    const candidate = game({
      bgg_id: 8,
      name: 'y',
      complexity: 2.4,
      min_players: 2,
      max_players: 4,
      min_time: 60,
      max_time: 90,
      mechanic_name: ['Trading', 'Dice Rolling'],
      category_name: ['Economic'],
    });
    const { why } = scoreSimilarity(catan, candidate, { complexityTolerance: 0.5 });
    expect(why).toContain('shares 2 of 15 mechanics');
    expect(why).toContain('complexity 2.4 vs 2.3');
    expect(why).toContain('plays 2–4');
  });
});

describe('excluding the game itself and its family', () => {
  it('collects every relation the API exposes', () => {
    const ids = relatedIds(catan);
    expect(ids.has(13)).toBe(true);
    // Catan: Seafarers is an expansion, listed under contained_in.
    expect(ids.has(325)).toBe(false);
    expect(ids.size).toBeGreaterThan(10);
  });

  it('keeps the seed and its expansions out of the recommendations', async () => {
    const output = await findSimilarGames(fixtureDeps(), similarInput.parse({ game: 'Catan', limit: 10 }));
    const excluded = relatedIds(catan);
    for (const item of output.recommendations) {
      expect(excluded.has(item.bgg_id), `${item.name} should have been excluded`).toBe(false);
    }
    expect(output.recommendations.some((item) => item.bgg_id === 13)).toBe(false);
  });
});

describe('group filtering', () => {
  const base = groupInput.parse({ players: 4 });

  it('respects the supported player range', () => {
    expect(matchesGroup(game({ bgg_id: 1, name: 'a', min_players: 2, max_players: 4 }), base, new Set())).toBe(true);
    expect(matchesGroup(game({ bgg_id: 2, name: 'b', min_players: 5, max_players: 8 }), base, new Set())).toBe(false);
    expect(matchesGroup(game({ bgg_id: 3, name: 'c', min_players: 1, max_players: 2 }), base, new Set())).toBe(false);
  });

  it('distinguishes "supports 6" from "good with 6"', () => {
    const supportsSix = game({ bgg_id: 4, name: 'd', min_players: 2, max_players: 6, min_players_best: 3, max_players_best: 4 });
    const loose = groupInput.parse({ players: 6 });
    const strict = groupInput.parse({ players: 6, best_at_count: true });

    expect(matchesGroup(supportsSix, loose, new Set())).toBe(true);
    expect(matchesGroup(supportsSix, strict, new Set())).toBe(false);
  });

  it('excludes a game with no best-at-N poll when the poll is required', () => {
    const noPoll = game({ bgg_id: 5, name: 'e', min_players: 2, max_players: 6 });
    expect(matchesGroup(noPoll, groupInput.parse({ players: 6, best_at_count: true }), new Set())).toBe(false);
  });

  it('matches exclusions by normalised name', () => {
    const excluded = new Set(['ticket to ride']);
    const ttr = game({ bgg_id: 6, name: 'Ticket to Ride', min_players: 2, max_players: 5 });
    expect(matchesGroup(ttr, base, excluded)).toBe(false);
  });

  it('honours the playtime ceiling using the shortest listed time', () => {
    const long = game({ bgg_id: 7, name: 'f', min_players: 2, max_players: 4, min_time: 90, max_time: 180 });
    expect(matchesGroup(long, groupInput.parse({ players: 4, max_minutes: 60 }), new Set())).toBe(false);
    expect(matchesGroup(long, groupInput.parse({ players: 4, max_minutes: 120 }), new Set())).toBe(true);
  });
});

describe('output schema conformance', () => {
  it('find_similar_games output parses against its advertised schema', async () => {
    const output = await findSimilarGames(fixtureDeps(), similarInput.parse({ game: 'Wingspan', limit: 8 }));
    expect(() => similarOutput.parse(output)).not.toThrow();
  });

  it('suggest_games_for_group output parses against its advertised schema', async () => {
    const output = await suggestGamesForGroup(
      fixtureDeps(),
      groupInput.parse({ players: 4, max_minutes: 60, complexity: 'light' }),
    );
    expect(() => groupOutput.parse(output)).not.toThrow();
  });

  it('every recorded fixture game parses against the upstream schema', () => {
    let parsed = 0;
    for (const [key, value] of Object.entries(fixtures)) {
      if (key.startsWith('game_')) {
        expect(() => RawGameSchema.parse(value), key).not.toThrow();
        parsed += 1;
        continue;
      }
      const page = value as { results: unknown[] };
      for (const row of page.results) {
        expect(() => RawGameSchema.parse(row), key).not.toThrow();
        parsed += 1;
      }
    }
    expect(parsed).toBeGreaterThan(250);
  });
});
