# ADR-001: board game data source

Status: accepted, 2026-09-01.

## Context

The server needs board game data rich enough to make real recommendations: mechanics, categories,
complexity, player counts, playtime, community ratings. The brief requires a public HTTP API with no
authentication, and a reviewer has to be able to clone the repository and run one command. That last
constraint rules out any source gated behind an approval process, however good its data is.

Every finding below was checked against the live service on 2026-09-01.

## Options considered

### BoardGameGeek's XML API

Rejected, unavailable. It is the canonical source and it is now closed:

```
$ curl -sI "https://boardgamegeek.com/xmlapi2/thing?id=13"
HTTP/2 401
www-authenticate: Bearer realm="xml api"
```

`/xmlapi`, `/xmlapi2` and `api.geekdo.com/xmlapi2` all answer 401. Access needs a registered
application and an approval wait that BGG's own policy puts at "a week or more". Even with a token in
hand, a reviewer cloning this repository would not have one, so the option fails the brief twice over.

### BGG's internal website endpoints

Rejected on licensing. `api.geekdo.com/api/geekitems` and `/api/dynamicinfo` are open, take no
authentication, and were verified returning 200. They carry the richest data of anything evaluated:
mechanics, `avgweight`, `rankinfo`, and the best-at-N player polls, straight from source.

They are also unlicensed. BGG's policy states that they operate several private APIs used by their
own website, and that unless otherwise noted they grant no licence to use them.

This is the decision I would most want to be asked about in a review. The endpoints work, nothing
technical would stop me, and the data is better than what I settled for. Building on someone's
unlicensed internal API under deadline pressure is still a bad signal about how I would treat a
partner's terms, and for a company whose business runs on vendor relationships that signal costs more
than the data is worth. The price of declining is visible in the limitations section of the README.

### recommend.games

Accepted. A Django REST Framework API published by the maintainers of the open-source
[board-game-recommender](https://gitlab.com/recommend.games/board-game-recommender) project.
BGG-derived data, offered publicly as an API by the people who built it.

Verified: 133,004 games; `/api/games/13/` returns 58 fields in 0.38s;
`ordering=bgg_rank&bgg_rank__isnull=false` returns the genuine current BGG top 25, with Brass:
Birmingham at 1, Ark Nova at 2, Pandemic Legacy Season 1 at 3, Gloomhaven at 4. Complexity,
mechanics, categories, playtime and BGG's `min_players_best` and `max_players_best` poll data are all
present.

It is fragile. Three measured properties drove the whole implementation, and
`docs/context/upstream-api.md` records them in full:

1. Unknown filter parameters are ignored silently. `?name=Catan` returns HTTP 200 with all 133,004
   games. A typo becomes a wrong answer that looks right. Handled with an allow-list on query
   construction and a corpus-size assertion on every response.
2. `search=` is permanently broken. Heroku H12 timeout every time, including with a 90 second client
   timeout. The API has no other name lookup. Names resolve offline instead.
3. Filter latency varies by an order of magnitude and the router kills requests at 30 seconds.
   `num_votes__gte` costs 1.7s. `max_time__lte` alone reached 30.8s and then 503'd. Handled in
   [ADR-002](adr-002-client-side-filtering.md).

The fragility turned out to be the most interesting thing about the project. An early version of
`suggest_games_for_group` sent the complexity band server-side and 503'd in testing after full retry
and backoff. That failure produced the current design.

### Also rejected

| Source | Verified status | Verdict |
|---|---|---|
| Board Game Atlas | Dangling CNAME to a dormant Heroku app, no A record | Dead |
| bgg-json | NXDOMAIN | Dead |
| Wikidata SPARQL | 200, no auth, 4,049 board games; designer on 377, duration on 670; no complexity, ratings or mechanics | Too thin for a recommendation corpus. Usable later as enrichment, since `P2339` joins on BGG id |
| Wikipedia REST | 200, CORS-enabled, good prose | No structured game data. Roadmap only |
| Ludopedia, BoardGameOracle, RAWG, IGDB, MobyGames | 401 or 403 | Need API keys, excluded by the brief |

## Decision

Use recommend.games as the sole upstream. Resolve names offline against a committed index built from
[beefsack/bgg-ranking-historicals](https://github.com/beefsack/bgg-ranking-historicals), which also
supplies the mechanic and category vocabularies. Provenance for all of it is in
`docs/context/data-provenance.md`.

## Consequences

No API keys appear anywhere in the repository. It clones and runs.

Name resolution covers roughly 31,226 ranked games out of a 133,004-game corpus. The README states
that as a limitation and the tool answers a miss with a "did you mean" error, because an empty list
would read as a valid answer.

The upstream will sometimes be down. Stale-while-error caching and recorded fixtures keep the demo and
the test suite working through an outage, and the tools report the age of any cached answer they
serve.

The data sits one step removed from BGG and refreshes on recommend.games' schedule.

Moving to BGG later is a client swap. Tools never call `fetch`, and the internal game type is already
narrower than either API's response, so the change is confined to `src/clients/`.
