# ADR-002: cheap filters upstream, everything else in memory

Status: accepted, 2026-09-01.

## Context

recommend.games accepts eleven filters that genuinely narrow the corpus. Their costs differ by an
order of magnitude, measured on 2026-09-01 against the ranked corpus with the service idle:

| Filter | Latency |
|---|---|
| `num_votes__gte` | 1.7s |
| `mechanic` | 3.2–8.3s |
| `complexity__gte` + `complexity__lte` | 15.3–16.6s |
| `min_players__lte` + `max_players__gte` | 18.8s |
| `max_time__lte` | 30.8s, then 503 |

Heroku's router kills any request at 30 seconds with an H12. Two of those filters together already
sit near the ceiling, and `max_time__lte` reached it on its own.

The first version of `suggest_games_for_group` sent the complexity band server-side. It 503'd during
testing, after three attempts with exponential backoff. Nothing in the retry logic could have saved
it, because the query itself was over budget.

The API leaves a way out. Its list endpoint returns complete 58-key game objects, so a row that
comes back already carries complexity, player counts, playtime, the co-op flag and the best-at-N
poll. Everything an expensive filter would have narrowed on is sitting in the cheap response.

## Decision

Send only the cheap, highly selective filters. Do the rest in memory over the returned rows.

The candidate pool for `suggest_games_for_group` is one base query:

```
bgg_rank__isnull=false&num_votes__gte=500&ordering=-bayes_rating&page_size=25
```

paged to a fixed budget. `find_similar_games` adds a single `mechanic` filter, chosen as the seed
game's rarest mechanic. Complexity bands, player counts, playtime ceilings, cooperative status and
caller exclusions are applied locally.

The expensive range filters stay on the allow-list in `src/clients/recommendGames.ts`. They are
correct, and a future caller with a different latency budget may want them. They are simply not sent
by either tool today.

## Alternatives considered

Send the range filters and accept the latency. Measured, and it fails: the query exceeds the 30
second router budget and returns an error page.

Send the range filters and raise the client timeout. Tried at 90 seconds during the `search=`
research. The router cuts the connection at 30 whatever the client is willing to wait.

Query the whole corpus and filter everything locally. 133,004 games at 25 rows per page is 5,321
requests against a service that sheds load at around five. Not viable.

Self-host the scraper. `board-game-scraper` is open source and running it removes the constraint
entirely. Out of scope for a take-home, and recorded in `docs/plans/scope.md`.

## Consequences

Four to eight cheap pages cost less wall-clock time than one expensive query, and they come back.

Every complexity band shares one base query, so the cached pages serve all of them. A caller who asks
for "light" and then "medium" pays the network cost once.

`suggest_games_for_group` searches a shortlist. Candidates are the best-rated games with 500 or more
ratings, read in rating order to a fixed page budget, so a very obscure game will never be suggested.
A request with narrow constraints says so in `coverage_note`.

The corpus-size floors that `assertFilterApplied` checks against are constants observed on
2026-09-01. Refresh them when the committed data is refreshed.
