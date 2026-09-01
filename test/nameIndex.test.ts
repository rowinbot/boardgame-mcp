import { describe, expect, it } from 'vitest';
import { NameIndex, editDistance, normalize } from '../src/clients/nameIndex.js';
import { ToolError } from '../src/lib/errors.js';

const index = NameIndex.load();

describe('offline name resolution', () => {
  it('loads the committed BGG ranked-games index', () => {
    expect(index.size).toBeGreaterThan(30_000);
  });

  it('matches an exact name exactly', () => {
    const result = index.resolve('Catan');
    expect(result.entry.bggId).toBe(13);
    expect(result.matched).toBe('exact');
  });

  it('distinguishes a case-folded match from an exact one', () => {
    expect(index.resolve('catan').matched).toBe('case_insensitive');
    expect(index.resolve('CATAN').entry.bggId).toBe(13);
  });

  it('ignores punctuation and accents', () => {
    expect(index.resolve('brass birmingham').entry.bggId).toBe(224517);
    expect(normalize('Brass: Birmingham')).toBe('brass birmingham');
    expect(normalize('Café Racer')).toBe('cafe racer');
  });

  it('recovers from a typo', () => {
    const result = index.resolve('wingspam');
    expect(result.entry.bggId).toBe(266192);
    expect(result.matched).toBe('fuzzy');
  });

  it('prefers the popular game when a name is a prefix of several', () => {
    // "Ticket to Ride" prefixes a dozen editions; the base game is what is meant.
    expect(index.resolve('Ticket to Ride').entry.bggId).toBe(9209);
  });

  it('asks rather than guessing when a name is genuinely ambiguous', () => {
    // Seasons 0, 1 and 2 are equally good matches for the bare series name.
    try {
      index.resolve('Pandemic Legacy');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe('ambiguous_game');
      expect((error as ToolError).suggestion).toContain('Season');
    }
  });

  it('returns an actionable error, not an empty list, for an unknown game', () => {
    try {
      index.resolve('qzxwvunknowntitle');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ToolError).code).toBe('game_not_found');
      // The index covers ranked games only, and the caller is told so.
      expect((error as ToolError).suggestion).toContain('ranked games');
    }
  });

  it('offers alternatives alongside a fuzzy match', () => {
    // A partial title resolves to the base game and hands back the editions and
    // expansions it might have meant, so the caller can correct us cheaply.
    const result = index.resolve('Agricol');
    expect(result.entry.name).toBe('Agricola');
    expect(result.matched).toBe('fuzzy');
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.alternatives.join(' ')).toContain('Agricola');
  });

  it('corrects a misspelling with a doubled consonant', () => {
    expect(index.resolve('Carcasonne').entry.name).toBe('Carcassonne');
  });
});

describe('editDistance', () => {
  it('measures the usual cases', () => {
    expect(editDistance('catan', 'catan', 2)).toBe(0);
    expect(editDistance('catan', 'cattan', 2)).toBe(1);
    expect(editDistance('wingspan', 'wingspam', 2)).toBe(1);
  });

  it('abandons early instead of computing a distance it cannot use', () => {
    expect(editDistance('a', 'abcdefghij', 2)).toBeGreaterThan(2);
  });
});
