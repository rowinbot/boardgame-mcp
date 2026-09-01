# Committed data, where it comes from

Four files ship in the repository so that a clone runs without a network. This page says where each
one came from, what it covers, and how to rebuild it. All four were generated on 2026-09-01.

## `data/name-index.tsv`

31,226 rows of `bgg_id`, `name`, `year`, `rank`, built from the daily CSV published by
[beefsack/bgg-ranking-historicals](https://github.com/beefsack/bgg-ranking-historicals). The file
carries the source date in a comment on its first line.

The index exists because the upstream has no working name lookup. Its `search=` parameter times out
every time, which `docs/context/upstream-api.md` records in full.

Coverage is BGG's ranked base games, 31,226 of the 133,004 games in the corpus. Unranked titles,
expansions and very new releases will not resolve, and `find_similar_games` answers with a "did you
mean" error when a name misses. An empty result list would read as a valid answer, so the tool does
not return one.

## `data/mechanics.json` and `data/categories.json`

192 mechanics and 84 categories, each with `bgg_id`, `name` and a corpus-wide usage `count`.

The counts are load-bearing. `find_similar_games` picks the seed game's rarest mechanic to query on,
because "Dice Rolling" appears on 30,371 games and separates nothing, while Wingspan's "Turn Order:
Progressive" appears on 503 and separates a lot. Without the counts the tool has no way to tell those
two apart.

These are committed because the list endpoint caps at 25 rows, so reading both vocabularies live
costs 12 sequential requests against a service that starts shedding load at around five.

## `test/fixtures/recommend-games.json`

16 recorded upstream responses: two game details, eight pages of the candidate pool, and six pages of
mechanic-filtered queries. Recorded from the live API by `npx tsx scripts/record-fixtures.ts`.

They are recordings, so they keep the upstream's real quirks: the nulls, the 25-row cap, the relation
id arrays. Hand-written fixtures would agree with whatever the tests assume and prove nothing. The
same file backs `npm run demo -- --offline`.

## Rebuilding

```sh
npm run build-index                  # name-index.tsv, mechanics.json, categories.json
npx tsx scripts/record-fixtures.ts   # test/fixtures/recommend-games.json
```

`build-index` walks back up to seven days to find the most recent published ranking CSV, then pages
the two vocabularies serially. Expect it to take a minute or so, and to fail outright if the upstream
is shedding load.

Refresh the corpus-size floors in `src/clients/recommendGames.ts` at the same time. They are constants
observed on 2026-09-01 and used as lower bounds by `assertFilterApplied`.
