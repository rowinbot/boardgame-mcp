import { z } from 'zod';

/**
 * recommend.games returns 58 keys per game. We parse the dozen we actually use
 * and drop the rest, so an upstream shape change fails loudly here rather than
 * surfacing as `undefined` three layers down in the scorer.
 *
 * Nearly everything is nullable: the corpus includes 133k games, many of them
 * obscure enough to have no complexity rating, no playtime and no rank.
 */
const nullableNumber = z.number().nullable().default(null);
const nameList = z.array(z.string()).default([]);
const idList = z.array(z.number()).default([]);

export const RawGameSchema = z.object({
  bgg_id: z.number(),
  name: z.string(),
  year: nullableNumber,
  complexity: nullableNumber,
  min_players: nullableNumber,
  max_players: nullableNumber,
  min_players_best: nullableNumber,
  max_players_best: nullableNumber,
  min_time: nullableNumber,
  max_time: nullableNumber,
  bgg_rank: nullableNumber,
  avg_rating: nullableNumber,
  bayes_rating: nullableNumber,
  num_votes: nullableNumber,
  cooperative: z.boolean().nullable().default(null),
  mechanic_name: nameList,
  category_name: nameList,
  game_type_name: nameList,
  // The relation fields. A "similar games" answer that returns the seed's own
  // expansions is the classic failure here, so all five are used as exclusions.
  implements: idList,
  implemented_by: idList,
  integrates_with: idList,
  contained_in: idList,
  compilation_of: idList,
  url: z.string().nullable().default(null),
});

export type RawGame = z.infer<typeof RawGameSchema>;

export const PageSchema = z.object({
  count: z.number(),
  next: z.string().nullable(),
  previous: z.string().nullable(),
  results: z.array(RawGameSchema),
});

export type Page = z.infer<typeof PageSchema>;

/** Absolute BGG link. The API's `url` is a path on some rows and absent on others. */
export function bggUrl(game: RawGame): string {
  if (game.url && game.url.startsWith('http')) return game.url;
  if (game.url) return `https://boardgamegeek.com${game.url}`;
  return `https://boardgamegeek.com/boardgame/${game.bgg_id}`;
}
