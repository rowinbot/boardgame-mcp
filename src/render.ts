import type { Output as SimilarOutput } from './tools/findSimilarGames.js';
import type { Output as GroupOutput } from './tools/suggestGamesForGroup.js';
import type { z } from 'zod';
import type { RecommendationSchema } from './schemas.js';

type Recommendation = z.infer<typeof RecommendationSchema>;

/**
 * Every tool returns both `structuredContent` and a text block. The structured
 * payload is the contract; the text is what a model quotes back to a person, so
 * it is written to be read aloud rather than parsed.
 */
function line(index: number, item: Recommendation): string {
  return `${index + 1}. ${item.name}${item.year ? ` (${item.year})` : ''} — ${item.why}\n   ${item.bgg_url}`;
}

function cacheLine(cache: { note: string | null }): string {
  return cache.note ? `\n⚠ ${cache.note}` : '';
}

export function renderSimilar(output: SimilarOutput): string {
  const { seed, resolution, method } = output;
  const header =
    resolution.matched === 'exact'
      ? `Games like ${seed.name}${seed.year ? ` (${seed.year})` : ''}:`
      : `Read "${resolution.query}" as ${seed.name}${seed.year ? ` (${seed.year})` : ''} [${resolution.matched} match]. Similar games:`;

  const body = output.recommendations.map((item, index) => line(index, item)).join('\n');
  const method_note = method.queried_mechanic
    ? `\nMatched on its most distinctive mechanic: ${method.queried_mechanic}. ${method.candidates_considered} candidates compared.`
    : `\n${method.candidates_considered} candidates compared.`;
  const alternatives = resolution.alternatives.length
    ? `\nCould also have meant: ${resolution.alternatives.join(', ')}.`
    : '';

  return `${header}\n${body}${method_note}${alternatives}${cacheLine(output.cache)}`;
}

export function renderGroup(output: GroupOutput): string {
  const { criteria } = output;
  const constraints = [
    `${criteria.players} players`,
    criteria.max_minutes ? `up to ${criteria.max_minutes} min` : null,
    `${criteria.complexity_band.label} weight (${criteria.complexity_band.min}–${criteria.complexity_band.max})`,
    criteria.cooperative === null ? null : criteria.cooperative ? 'cooperative' : 'competitive',
    criteria.best_at_count_required ? `best at ${criteria.players} per BGG poll` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const body = output.suggestions.map((item, index) => line(index, item)).join('\n');
  const coverage = output.coverage_note ? `\n${output.coverage_note}` : '';

  return `For ${constraints}:\n${body}${coverage}${cacheLine(output.cache)}`;
}
