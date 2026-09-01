# recommend.games API, measured behaviour

Reference for the only upstream this server calls. Every figure below was measured against the live
service on 2026-09-01, sequentially, with the service otherwise idle. Nothing here is quoted from
documentation, because the service publishes none.

Base URL: `https://recommend.games/api`. No authentication. Django REST Framework on hobby-tier
Heroku.

## Endpoints used

| Endpoint | Purpose | Latency |
|---|---|---|
| `GET /games/{bgg_id}/?format=json` | one game, 58 fields | 0.38–0.90s |
| `GET /games/?...` | filtered list, 25 rows maximum | see the filter table |

Both return the full 58-key game object. The list endpoint does not return summaries, so any field
present on a detail response is also present on a list row.

## Corpus sizes

| Set | Count |
|---|---|
| All games | 133,004 |
| Ranked games (`bgg_rank__isnull=false`) | 31,135 |
| Mechanics in the vocabulary | 192 |
| Categories in the vocabulary | 84 |

The corpus only grows, so these are floors. `src/clients/recommendGames.ts` uses them as floors in
`assertFilterApplied`.

## Page size

`page_size` is capped at 25. A request for `page_size=100` returns 200 with 25 rows and no indication
that the value was clamped. Reading the 192 mechanics therefore costs 8 sequential requests, and the
192 mechanics plus 84 categories cost 12.

## Unknown filter parameters are ignored silently

An unrecognised query parameter is dropped. The response is HTTP 200 with the unfiltered corpus and
the default first page. No error, no warning, no field in the response marks it.

| Request | Response |
|---|---|
| `?name=Catan` | 200, `count: 133004` |
| `?bgg_id=13` | 200, `count: 133004` |
| `?name__icontains=gloomhaven` | 200, `count: 133004` |

A one-character typo in a filter name produces a plausible wrong answer that is indistinguishable
from a correct one at the response level. Two guards in `src/clients/recommendGames.ts` cover it: an
allow-list of verified filter keys, checked before the request is sent, and a corpus-size assertion
on every response.

## Verified filters

Each key below was confirmed to change the result count. Anything not on this list is rejected by
`buildQuery`.

| Key | Effect |
|---|---|
| `bgg_rank__isnull` | restricts to ranked games when `false` |
| `complexity__gte`, `complexity__lte` | BGG weight bounds, 1.0 to 5.0 |
| `min_players__lte`, `max_players__gte` | player-count range overlap |
| `max_time__lte`, `min_time__gte` | playtime bounds in minutes |
| `year__gte` | publication year floor |
| `num_votes__gte` | minimum number of BGG ratings |
| `mechanic` | mechanic id |
| `category` | category id |
| `ordering` | sort key, `-` prefix for descending |
| `page`, `page_size` | pagination, `page_size` capped at 25 |
| `format` | `json` |

## Filter cost

Measured one filter at a time against the ranked corpus.

| Filter | Latency | Rows returned |
|---|---|---|
| `num_votes__gte` | 1.7s | 2,545 of 31,135 |
| `page`, `page_size`, `ordering` | 0.7–4.5s | n/a |
| `mechanic` | 3.2–8.3s | 383–8,476 |
| `complexity__gte` + `complexity__lte` | 15.3–16.6s | 1,785 |
| `min_players__lte` + `max_players__gte` | 18.8s | 23,846 |
| `max_time__lte` | 30.8s, then 503 | none |
| `search` | 503 every time | none |

Heroku's router terminates any request at 30 seconds with an H12 error. Stacked expensive filters
exceed that budget and the query dies. `docs/design/adr-002-client-side-filtering.md` records what the
server does about it.

## `search=` is unusable

Every attempt returns Heroku's `Application Error` page after roughly 30 seconds, including with a 90
second client-side timeout. The API offers no other name lookup. Names resolve offline instead, from
`data/name-index.tsv`. Provenance is in `docs/context/data-provenance.md`.

## Load shedding

The service returned 503 for several minutes after roughly five requests in quick succession, twice
during measurement, and recovered without intervention each time. `src/lib/http.ts` sends one request
at a time for that reason, with 3 attempts, exponential backoff and full jitter, and a 35 second
per-attempt cap set above the router's 30 seconds.

Retried statuses: 429, 500, 502, 503, 504, and network failures. HTTP 400 is not retried.

## Response shape

- Relations arrive as parallel arrays of ids and names, for example `mechanic` and `mechanic_name`.
- `complexity`, `bayes_rating`, `min_players_best` and `max_players_best` are nullable, and are null
  on a large share of unranked games.
- `count` on a list response is the size of the filtered set, not the page.
- Recorded examples live in `test/fixtures/recommend-games.json`, captured by
  `npx tsx scripts/record-fixtures.ts`.
