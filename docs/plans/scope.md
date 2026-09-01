# Scope: what was built and what was cut

A record of the choices that set the size of this project. The reasoning behind each technical
decision sits in `docs/design/`; this page says what got made and what did not.

## Built

Two MCP tools over recommend.games. `find_similar_games` takes a game name and returns games like it.
`suggest_games_for_group` takes a player count, a time budget and a complexity band, and returns games
that fit.

Offline name resolution against a committed index, with exact, case-folded, accent-insensitive and
fuzzy matching, and a refusal on genuine ambiguity. `Pandemic Legacy` comes back asking whether the
caller meant Season 0, 1 or 2.

A hardened upstream client: an allow-list on query construction, a corpus-size assertion on every
response, a serial queue, bounded retry with jitter, and a stale-while-error cache. ADR-002 and
ADR-003 record why each piece is shaped the way it is.

47 tests, none of which touch the network, including a real MCP client talking to a real server over
a linked in-memory transport.

A demo that makes five tool calls and prints what comes back, with `--offline` for a reviewer sitting
behind a failing upstream.

## Cut

### A third tool, `find_game_shops`

Local game shops from OpenStreetMap, through the Overpass API. Scoped, verified working, and cut.

The resilience work is the interesting part of this project. It is concentrated in one client. A
second HTTP client would have spread that effort across two upstreams and hardened neither.

Worth knowing if it gets built later:

- Query `nwr`, never `node`. Roughly 9% of `shop=games` matches are ways, which carry `center` and no
  top-level `lat`/`lon`. A parser that reads `lat` drops them silently.
- Overpass allows 2 concurrent slots per IP.
- Coverage is thin, around 3,700 tagged shops worldwide, so small result sets need a coverage note or
  they read as a bug.

### A bespoke React interface

The brief asks for TypeScript and React, which does not sit comfortably on a stdio MCP server.

The server is TypeScript throughout. The React surface is the MCP Inspector, a Vite and React
application and the standard way MCP servers get reviewed, wired up as `npm run inspector`. A page
built to satisfy the word "React" would have shown less than `test/protocol.test.ts` already shows.

### BoardGameGeek as a first-party source

Blocked on access. The XML API returns 401 and needs an approved application, which BGG's policy puts
at "a week or more". ADR-001 covers the decision and the licensing question underneath it.

If a token arrives, `/xmlapi2/thing?id=…&stats=1` gives canonical mechanics, weight, ranks and the
best-at-N poll from source. It needs a request queue: `/thing` accepts at most 20 ids per call, BGG
asks for a 5 second gap between requests, and `/collection` answers HTTP 202 while it queues an export
and has to be politely re-polled. Their terms also require a "Powered by BGG" attribution and forbid
modifying retrieved data.

### Collection-aware recommendations

"What should we play tonight, out of what we own." Depends on the BGG token and the 202 handling
above.

### Self-hosting the data

`board-game-scraper` is open source. Running it removes the 503s and the latency ceiling that ADR-002
works around. That is the honest answer if this ever became a product, and far past the size of a
take-home.

### Streamable HTTP transport

ADR-004. A listener, session management, origin validation and CORS, for a server that runs as a
local subprocess.

### Rate limiting across processes

The serial queue in `src/lib/http.ts` is per-process. Two instances of this server running at once
will exceed what the upstream tolerates. Nothing in the brief puts two instances in play.
