# ADR-001: Board game data source

**Status:** accepted, 2026-09-01

## Context

The server needs board game data rich enough to make real recommendations: mechanics, categories,
complexity, player counts, playtime, and community ratings. The brief requires a public HTTP API with
no authentication, and the result has to be runnable by a reviewer who clones the repo and runs one
command. That last constraint rules out anything gated behind an approval process, however good the
data is.

Every finding below was checked against the live service.

## Options considered

### BoardGameGeek XML API — rejected, unavailable

The obvious first choice, and the canonical source. It is now closed:

```
$ curl -sI "https://boardgamegeek.com/xmlapi2/thing?id=13"
HTTP/2 401
www-authenticate: Bearer realm="xml api"
```

`/xmlapi`, `/xmlapi2` and `api.geekdo.com/xmlapi2` all return 401. Access requires registering an
application and waiting for approval, which BGG's own policy says "may be a week or more". Beyond the
timing, a token-gated server is not runnable by a reviewer, so this fails the brief regardless.

### BGG's internal endpoints — rejected on licensing

`api.geekdo.com/api/geekitems` and `/api/dynamicinfo` are open, unauthenticated, and carry the richest
data of anything evaluated: mechanics, `avgweight`, `rankinfo`, and the best-at-N player polls, all
straight from source. Verified returning 200.

They are also explicitly unlicensed. BGG's policy states that they operate several private APIs used by
their website and that, unless otherwise noted, they grant no licence for use of those endpoints.

This is the decision I would most want to be asked about. The endpoints work, nothing would stop me,
and the data is better than what I settled for. It is still the wrong call: knowingly building on
someone's unlicensed internal API — for a take-home, for a company whose business runs on vendor
relationships — is a bad signal about how I would treat a partner's terms under deadline pressure. The
cost of declining is real and it is visible in the limitations section of the README.

### recommend.games — accepted

A Django REST Framework API published by the maintainers of the open-source
[board-game-recommender](https://gitlab.com/recommend.games/board-game-recommender) project. BGG-derived
data, offered publicly as an API by the people who built it — a front door rather than a side entrance.

Verified: 133,004 games; `/api/games/13/` returns 58 fields in 0.38s;
`ordering=bgg_rank&bgg_rank__isnull=false` returns the genuine current BGG top 25 (Brass: Birmingham 1,
Ark Nova 2, Pandemic Legacy Season 1 3, Gloomhaven 4). Complexity, mechanics, categories, playtime, and
BGG's `min_players_best`/`max_players_best` poll data are all present.

It is fragile, and that turned out to be the most interesting thing about the project rather than a
reason to avoid it. Three properties drove the implementation:

1. **Unknown filter parameters are silently ignored.** `?name=Catan` returns HTTP 200 with all 133,004
   games. A typo becomes a wrong answer that looks right. Handled with an allow-list on query
   construction plus a corpus-size assertion on every response.
2. **`search=` is permanently broken** — Heroku H12 timeout, every time, including with a 90s client
   timeout. There is no working name lookup on the API. Handled by resolving names offline against a
   committed index.
3. **Filter latency varies by an order of magnitude and the router kills requests at 30s.**
   `num_votes__gte` costs 1.7s; `max_time__lte` alone hit 30.8s and 503'd. Handled by sending only cheap
   selective filters and doing the rest in memory. The measured table is in the README and in the
   client.

An earlier implementation of `suggest_games_for_group` sent the complexity band server-side and 503'd in
testing after full retry and backoff. That failure is what produced the current design.

### Also rejected

| Source | Verified status | Verdict |
|---|---|---|
| Board Game Atlas | Dangling CNAME to a dormant Heroku app, no A record | Dead |
| bgg-json | NXDOMAIN | Dead |
| Wikidata SPARQL | 200, no auth, but only 4,049 board games; designer on 377, duration on 670. No complexity, ratings or mechanics | Not a recommendation corpus. Viable later as enrichment — `P2339` joins on BGG id |
| Wikipedia REST | 200, CORS-enabled, good prose | No structured game data. Roadmap only |
| Ludopedia, BoardGameOracle, RAWG, IGDB, MobyGames | 401/403 | Need API keys, out under the brief |

## Decision

Use recommend.games as the sole upstream, with a committed offline index built from
[beefsack/bgg-ranking-historicals](https://github.com/beefsack/bgg-ranking-historicals) for name
resolution and for the mechanic and category vocabularies.

## Consequences

- **No API keys anywhere.** The repo clones and runs.
- **Name resolution is limited to ~31k ranked games** rather than the full 133k corpus, and is stated as
  a limitation rather than hidden behind an empty result.
- **The upstream will sometimes be down.** Stale-while-error caching and recorded fixtures mean the
  demo and the tests work anyway, and the tools tell the caller when an answer is stale rather than
  presenting old data as current.
- **The data is one step removed from BGG** and refreshes on recommend.games' schedule, not BGG's.
- **Migrating to BGG later is a client swap**, not a rewrite: tools never call `fetch`, and the internal
  game type is already narrower than either API's response.
