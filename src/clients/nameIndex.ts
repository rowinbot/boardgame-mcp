import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ToolError } from '../lib/errors.js';

/**
 * Name resolution runs entirely offline.
 *
 * recommend.games exposes a `search=` parameter, but it is permanently broken:
 * every call sits until Heroku's 30s router timeout and returns an error page.
 * There is no working name lookup on the API at all. So names resolve against a
 * committed index built from beefsack/bgg-ranking-historicals, which lists every
 * ranked game on BGG.
 *
 * The honest limitation: the index covers ranked base games (~31k) rather than
 * the full 133k corpus, so genuinely obscure titles will not resolve. That
 * returns a "did you mean" error rather than an empty result set, because an
 * empty list looks like a valid answer and a failed lookup is not one.
 */
export interface IndexEntry {
  bggId: number;
  name: string;
  year: number | null;
  rank: number | null;
  normalized: string;
}

export type MatchKind = 'exact' | 'case_insensitive' | 'fuzzy';

export interface Resolution {
  entry: IndexEntry;
  matched: MatchKind;
  /** Other games the name could plausibly have meant, best first. */
  alternatives: string[];
}

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Levenshtein distance, abandoned early once it cannot beat `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length] ?? max + 1;
}

const DEFAULT_PATH = fileURLToPath(new URL('../../data/name-index.tsv', import.meta.url));

export class NameIndex {
  private readonly byNormalized = new Map<string, IndexEntry[]>();
  private readonly entries: IndexEntry[] = [];

  constructor(tsv: string) {
    for (const line of tsv.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [id, name, year, rank] = line.split('\t');
      if (!id || !name) continue;
      const entry: IndexEntry = {
        bggId: Number(id),
        name,
        year: year ? Number(year) : null,
        rank: rank ? Number(rank) : null,
        normalized: normalize(name),
      };
      this.entries.push(entry);
      const bucket = this.byNormalized.get(entry.normalized);
      if (bucket) bucket.push(entry);
      else this.byNormalized.set(entry.normalized, [entry]);
    }
  }

  static load(path: string = DEFAULT_PATH): NameIndex {
    return new NameIndex(readFileSync(path, 'utf8'));
  }

  get size(): number {
    return this.entries.length;
  }

  /** Lower rank is better; unranked sorts last. */
  private static byPopularity(a: IndexEntry, b: IndexEntry): number {
    return (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
  }

  resolve(query: string): Resolution {
    const normalized = normalize(query);
    if (!normalized) {
      throw new ToolError('Game name was empty after normalisation.', 'game_not_found', 'Provide a game name, for example "Wingspan".');
    }

    const exactBucket = this.byNormalized.get(normalized);
    if (exactBucket && exactBucket.length > 0) {
      const sorted = [...exactBucket].sort(NameIndex.byPopularity);
      const best = sorted[0] as IndexEntry;
      return {
        entry: best,
        // Distinguishing these two matters: an exact hit needs no second look,
        // a case-fold hit is worth echoing back so the caller sees what we chose.
        matched: best.name === query ? 'exact' : 'case_insensitive',
        alternatives: sorted.slice(1, 5).map(describe),
      };
    }

    const near = this.nearest(normalized);
    if (near.length === 0) {
      throw new ToolError(
        `No board game matching "${query}" in the BGG ranked-games index.`,
        'game_not_found',
        'The index covers ranked games only. Check the spelling, or try the full published title.',
      );
    }

    const best = near[0];
    if (!best) {
      throw new ToolError(`No board game matching "${query}".`, 'game_not_found');
    }
    const second = near[1];
    if (second && second.score === best.score) {
      throw new ToolError(
        `"${query}" is ambiguous.`,
        'ambiguous_game',
        `Did you mean ${near.slice(0, 4).map((c) => `"${c.entry.name}"`).join(', ')}?`,
      );
    }

    return {
      entry: best.entry,
      matched: 'fuzzy',
      alternatives: near.slice(1, 5).map((candidate) => describe(candidate.entry)),
    };
  }

  /**
   * Ranked candidate list. Prefix beats containment beats edit distance, and
   * popularity breaks ties — when someone types "catan" they mean the famous one.
   */
  private nearest(normalized: string): Scored[] {
    const tolerance = Math.max(1, Math.floor(normalized.length * 0.25));
    const scored: Scored[] = [];

    for (const entry of this.entries) {
      let score: number | null = null;
      if (entry.normalized.startsWith(normalized)) score = 1000 - (entry.normalized.length - normalized.length);
      else if (entry.normalized.includes(normalized)) score = 500 - (entry.normalized.length - normalized.length);
      else if (Math.abs(entry.normalized.length - normalized.length) <= tolerance) {
        const distance = editDistance(normalized, entry.normalized, tolerance);
        if (distance <= tolerance) score = 100 - distance;
      }
      if (score !== null) scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score || NameIndex.byPopularity(a.entry, b.entry));
    return scored.slice(0, 8);
  }
}

interface Scored {
  entry: IndexEntry;
  score: number;
}

function describe(entry: IndexEntry): string {
  return entry.year ? `${entry.name} (${entry.year})` : entry.name;
}
