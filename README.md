# boardgame-mcp

An MCP server that recommends board games. Two tools, backed by
[recommend.games](https://recommend.games), a public REST API with no authentication, carrying
133,004 games with BoardGameGeek's complexity ratings, mechanics, categories and community
player-count polls.

| Tool | Answers |
|---|---|
| `find_similar_games` | "We like Wingspan, what else would we like?" |
| `suggest_games_for_group` | "Four of us, an hour, nothing heavy. What should we play?" |

Both return `structuredContent` against a published output schema, and both attach a plain-language
reason to every result: `shares 7 of 9 mechanics (Dice Rolling, End Game Bonuses, Hand Management);
complexity 2.4 vs 2.5; plays 1–5 (best at 2); 45 min`. The reason is there so the model can tell
whoever asked why this game came up.

## Run it

```
npm install
npm run demo
```

`npm run demo` connects a real MCP client to the server over a linked in-memory transport and makes
five tool calls, printing what comes back. It calls the live API and falls back to recorded fixtures
per request if the upstream is down, which it may well be. See [the upstream](#the-upstream). To skip
the network entirely:

```
npm run demo -- --offline
```

Other entry points:

```
npm test          # 47 tests, no network
npm run typecheck
npm start         # the server itself, speaking MCP over stdio
npm run inspector # the official MCP Inspector, a React web client
```

`.mcp.json` is committed, so a client that reads it, Claude Code among others, picks the server up
from the repo root with no further configuration.

### Node version

The server, tests and demo run on Node 20 and up. Development was on 22.15.0. MCP Inspector v2
declares `engines.node >= 22.19.0`, which npm treats as advisory: it did launch on 22.15.0 when
tested. It is still below what the Inspector supports, so run `nvm use 24` before `npm run inspector`
if you hit anything odd. Nothing else in the repo is affected.

## What the tools do

### `find_similar_games`

```jsonc
{ "game": "Catan", "limit": 8, "complexity_tolerance": 0.5 }
```

1. Resolve the name offline, against a committed index of BGG's ranked games. Exact, then
   case-insensitive, then fuzzy: `wingspam` gives Wingspan, `Carcasonne` gives Carcassonne. A
   genuinely ambiguous name is refused. `Pandemic Legacy` comes back asking whether you meant Season
   0, 1 or 2.
2. Fetch the seed game by id. This is the one upstream call that is consistently fast, 0.38 to 0.90s
   in every measurement taken.
3. Pull candidates filtered on the seed's *most distinctive* mechanic, the one used by the fewest
   games in the corpus. This matters more than it looks. "Dice Rolling" is on 30,371 games and tells
   you nothing, while Wingspan's "Turn Order: Progressive" is on 503 and tells you a lot. Querying
   the first mechanic in the list instead of the rarest turns a recommendation into a popularity
   chart.
4. Score locally on mechanic overlap (weight 0.40), categories (0.15), complexity proximity (0.20),
   player-range overlap (0.10), playtime (0.05), game type (0.05), and community rating (0.05).
   Rating is deliberately the smallest term. It breaks ties without letting a popular but unrelated
   game outrank a similar one.
5. Exclude the seed's own family: `implements`, `implemented_by`, `integrates_with`, `contained_in`,
   `compilation_of`. Without that step, "similar to Catan" returns Catan: Seafarers and Catan: Cities
   & Knights.

Real output, `{ "game": "wingspam", "limit": 5 }`:

```
Read "wingspam" as Wingspan (2019) [fuzzy match]. Similar games:
1. Creature Comforts (2022) — shares 7 of 9 mechanics (Dice Rolling, End Game Bonuses, Hand
   Management); both Animals; complexity 2.4 vs 2.5; plays 1–5 (best at 2); 45 min.
2. Fantastic Factories (2019) — shares 7 of 9 mechanics (Dice Rolling, End Game Bonuses, Hand
   Management); both Card Game; complexity 2.2 vs 2.5; plays 1–5 (best at 3); 45–60 min.
3. Legacy: The Testament of Duke de Crecy (2013) — shares 6 of 9 mechanics (End Game Bonuses, Hand
   Management, Open Drafting); both Card Game; complexity 2.7 vs 2.5; plays 1–4 (best at 1–4); 60 min.
Matched on its most distinctive mechanic: Turn Order: Progressive (503 games use it). 73 candidates
compared.
```

### `suggest_games_for_group`

```jsonc
{ "players": 4, "max_minutes": 60, "complexity": "light",
  "cooperative": false, "best_at_count": true, "exclude": ["Ticket to Ride"], "limit": 8 }
```

`best_at_count` is the parameter worth knowing about. BGG runs a community poll on the player counts
a game is actually *good* at, which is a different claim from the range printed on the box. Plenty of
games technically support six players and are miserable with six. Set the flag and the tool requires
the poll to include your count. A game with no poll data is excluded, because the flag is an
assertion about the poll and a game without one cannot satisfy it.

`criteria` echoes back the resolved numeric bounds, so a caller who asked for "light" is told it
meant BGG weight 1.0 to 2.0.

Real output, `{ "players": 4, "max_minutes": 60, "complexity": "light", "limit": 5 }`:

```
For 4 players, up to 60 min, light weight (1–2):
1. SCOUT (2019) — plays 2–5 (best at 4); BGG rates it best at 4; 20 min; weight 1.4; rated 7.57.
2. Crokinole (1876) — plays 2–4 (best at 2–4); BGG rates it best at 4; 30 min; weight 1.2; rated 7.80.
3. Decrypto (2018) — plays 3–8 (best at 4–6); BGG rates it best at 4; 15–45 min; weight 1.8; rated 7.55.
4. The Lord of the Rings: The Fellowship of the Ring – Trick-Taking Game (2025) — plays 1–4 (best at
   4); BGG rates it best at 4; 20 min; weight 1.9; cooperative; rated 7.51.
5. The Crew: The Quest for Planet Nine (2019) — plays 2–5 (best at 4); BGG rates it best at 4; 20 min;
   weight 2.0; cooperative; rated 7.61.
```

## The upstream

recommend.games is a Django REST Framework API on hobby-tier Heroku, published by the maintainers of
the [board-game-recommender](https://gitlab.com/recommend.games/board-game-recommender) project. It
is open, unauthenticated and generous. It also has three properties that shaped every design decision
here, all confirmed against the live service on 2026-09-01. The full measurement record is in
[`docs/context/upstream-api.md`](docs/context/upstream-api.md).

### Unknown filter parameters are ignored silently

`?name=Catan` returns HTTP 200 with all 133,004 games and the default first page. So do `?bgg_id=13`
and `?name__icontains=gloomhaven`. No error, no warning, no hint. A one-character typo in a filter
name produces a confident, plausible, entirely wrong answer, and nothing in the response
distinguishes it from a correct one.

Two independent guards cover it, both in `src/clients/recommendGames.ts`.

The first is an allow-list. Every query is built through `buildQuery`, which throws
`UnknownFilterError` on any key not on a list of filters verified to actually filter. The request is
never sent. That catches the typo we write.

The second is a corpus-size assertion. After every response, `assertFilterApplied` checks that a
query which narrowed the corpus came back with fewer rows than the corpus contains. That catches the
filter the upstream quietly stops honouring, the version that would survive a deploy unnoticed. It
throws. Unlike a 503 it is our bug, so it is not retried, not cached, and not served stale.

### `search=` is permanently broken

Every attempt returns Heroku's `Application Error` after about 30s, the router's H12 timeout,
including with a 90s client timeout. The API has no working name lookup at all.

Names therefore resolve entirely offline, against `data/name-index.tsv`: 31,226 ranked games built
from [beefsack/bgg-ranking-historicals](https://github.com/beefsack/bgg-ranking-historicals), which
publishes a fresh CSV daily. `npm run build-index` regenerates it, along with the mechanic and
category vocabularies. Those are committed too, because the API caps *every* list endpoint at 25
rows, so reading 192 mechanics costs 8 sequential requests against a service that falls over at
around five. [`docs/context/data-provenance.md`](docs/context/data-provenance.md) has the details.

The honest limitation: the index covers ranked base games, 31,226 of the 133,004 corpus. Obscure
titles will not resolve. They come back as a "did you mean" error, because an empty list would read
to the caller as "nothing is similar to this game".

### It falls over, and its filters have wildly different costs

The service returned 503 for several minutes after a handful of sequential requests, twice, then
recovered on its own. Filter latency was measured individually against the ranked corpus, on an
otherwise idle service:

| Filter | Latency | Selectivity |
|---|---|---|
| `num_votes__gte` | 1.7s | 2,545 of 31,135 |
| `page` / `page_size` / `ordering` | 0.7–4.5s | n/a |
| `mechanic` | 3.2–8.3s | 383–8,476 |
| `complexity__gte` + `complexity__lte` | 15.3–16.6s | 1,785 |
| `min_players__lte` + `max_players__gte` | 18.8s | 23,846 |
| `max_time__lte` | **30.8s, then 503** | none |

Heroku's router cuts every request off at 30s. Stacked, the expensive filters exceed that budget and
the query dies. The first implementation of `suggest_games_for_group` sent the complexity band
server-side and 503'd in testing, after full retry and backoff.

So the server sends only the cheap, highly selective filters and does the rest of the work in memory.
The list endpoint returns complete 58-key game objects, so complexity bands, player counts, playtime
ceilings, co-op flags and exclusions are all applied locally over the returned rows. Four to eight
cheap pages beat one expensive query that dies, and because every complexity band shares one base
query, the cached pages serve all of them.

Range filters stay on the allow-list, because they are correct. They are simply not worth their
latency here. The measurements sit in the client next to the code they justify, and the decision is
[ADR-002](docs/design/adr-002-client-side-filtering.md).

## Design

```
src/
  index.ts            stdio wiring, nothing else
  server.ts           tool registration and the error boundary
  render.ts           structured output turned into text a model can read aloud
  schemas.ts          shared Zod output schemas
  tools/              schema in, schema out. Never calls fetch.
  clients/            recommendGames, nameIndex, gameSchema. Never mention MCP.
  lib/                http (retry, backoff, serial queue), cache, score, errors
data/                 committed name index and vocabularies
test/fixtures/        real recorded upstream responses
```

Tools never call `fetch`. Clients never know MCP exists. That separation is what makes the tests
below possible without a network.

### Validation

Zod 4 at both boundaries. `inputSchema` is advertised on `tools/list` and the SDK validates arguments
against it before the handler runs. `outputSchema` is advertised too, and the payload is validated on
the way out. Validating our own output sounds redundant until the upstream changes a field's
nullability, at which point it is the difference between a loud failure here and a malformed payload
reaching the model. Upstream responses are parsed into a narrow internal type in `clients/`, so a
shape change fails in one place instead of surfacing as `undefined` three layers down.

One thing worth flagging, since it is the SDK's choice: v2 reports input-validation failures as a
tool result with `isError: true`, not as a JSON-RPC error. A test asserts the current behaviour, so a
future SDK version changing it will be caught.

### Errors

Two families, deliberately kept apart.

Recoverable by the caller: game not found, name ambiguous, upstream 503, no results. Returned as
`isError: true` with a structured, actionable message. A model can act on "recommend.games is
returning 503, it usually recovers within a few minutes". It cannot act on a stack trace.

Bugs in this server: an unknown filter key, a schema mismatch. Rethrown, so the SDK emits a JSON-RPC
error. A polite tool result would hide the defect from us and from the client.

Either way nothing escapes as an unhandled rejection, which on stdio would kill the process and leave
the client watching the server vanish.

### Resilience

Sized to the limits actually measured. [ADR-003](docs/design/adr-003-resilience-budget.md) records
the alternatives that were tried and dropped.

One request at a time. The correct concurrency for this upstream is one, so it is hardcoded.

Bounded retry: 3 attempts, exponential backoff with full jitter, on 429, 5xx and network failures.
HTTP 400 is excluded, because a bad query is a bug.

A 35s per-attempt cap. The router gives up at 30s, so the cap sits above it. Cutting requests off at
10s would guarantee we never see the slow-but-successful responses.

Stale-while-error caching. Game detail 24h, queries 6h. An expired entry is kept, so when the upstream
fails the tool serves the old answer with its age surfaced in `cache.age_seconds` and a note in the
text block. Given how readily this service 503s, that is the difference between a demo that survives
and one that dies in front of you.

Small dependency surface on purpose: `@modelcontextprotocol/server`, `zod`, `p-retry`, `p-limit` and
`lru-cache`.

## Tests

47 tests, none of which touch the network.

`test/protocol.test.ts` runs a real `Client` against a real `McpServer` over
`InMemoryTransport.createLinkedPair()`. It asserts tool advertisement including output schemas,
`structuredContent` shape, monotonic result ordering, that every returned game genuinely satisfies
the requested constraints, and that invalid input is rejected without a single upstream request.
These assert what a client receives.

`test/resilience.test.ts` covers the 503 path with an injected clock: bounded increasing backoff,
then a stale cache hit reporting a 2,400-second age. Also that 400 is not retried, that the serial
queue survives a rejected task, and that a dropped filter raises instead of returning 133,004 rows.

`test/nameIndex.test.ts` covers exact, case-folded, accent- and punctuation-insensitive,
typo-corrected, ambiguous, and not-found resolution.

`test/recommendations.test.ts` covers scoring arithmetic, deterministic ranking, the seed's
expansions excluded, supports-N versus best-at-N, and every one of the 300+ recorded fixture rows
round-tripping through the upstream schema.

Fixtures are recorded from the live API (`npx tsx scripts/record-fixtures.ts`), so they keep the
upstream's real quirks: the nulls, the 25-row page cap, the relation id lists.

## Decisions worth stating

Each of these is written up in [`docs/design/`](docs/design/), with the alternatives that lost.

stdio, not Streamable HTTP. This server runs as a local subprocess for a local client, so HTTP would
add a listener, session management, origin validation and CORS without changing the wire protocol the
client sees. `PerRequestHTTPServerTransport` is a small change to `src/index.ts` if a remote
deployment ever needs one. [ADR-004](docs/design/adr-004-stdio-transport.md).

Two tools. A third tool over a second API, game shops via OpenStreetMap's Overpass, was scoped and
cut. The resilience work is the interesting part of this project and it is concentrated in one
hardened client. A second client would have spread it across two upstreams and hardened neither.
[`docs/plans/scope.md`](docs/plans/scope.md) has the notes for whoever builds it.

On "TypeScript/React". The brief asks for TypeScript and React, which does not quite fit a stdio MCP
server. The server is TypeScript throughout, and the React surface is the MCP Inspector
(`npm run inspector`), a Vite and React application and the standard way MCP servers get reviewed. A
bespoke page would have demonstrated less than the protocol-level tests do.

BoardGameGeek is not used directly. Its XML API now returns 401 and requires an approved application.
Its open internal endpoints are richer than anything used here and are explicitly unlicensed. The
reasoning is in [ADR-001](docs/design/adr-001-data-source.md).

AI assistance. This was built with AI assistance. Every line was reviewed, and every upstream claim in
this README was verified against the live service. The latency table, the 25-row page cap and the
silent-filter behaviour were all measured, and two of them contradicted the original plan. The tests
are the validation, and I am happy to walk through any file, particularly the retry logic, the cache
TTLs and the scoring weights.

## Known limitations

Name resolution covers ranked games only, 31,226 of 133,004. Obscure and very new titles will not
resolve.

`suggest_games_for_group` searches a shortlist. Candidates are the best-rated games with 500 or more
ratings, read in rating order to a fixed page budget. Requests with narrow constraints say so in
`coverage_note`.

Complexity, ratings and best-at-N are absent on some games. Missing components are dropped from the
weighted average, so a poorly-documented game is not penalised for the gap. Scoring them zero would
bias results towards popular games and make the recommendations circular.

The corpus-size baselines in `src/clients/recommendGames.ts` are constants observed on 2026-09-01.
The corpus only grows, so they work as floors. Refresh them alongside `npm run build-index`.

Rate limiting is per-process. Two instances of this server running at once will exceed what the
upstream tolerates.

## What was cut, and what would come next

BGG as a first-party source, collection-aware recommendations, the game shops tool, and self-hosting
the scraper. [`docs/plans/scope.md`](docs/plans/scope.md) has the reason for each one and the
research notes that go with it.

## Attribution

Game data from [recommend.games](https://recommend.games), derived from BoardGameGeek. Name index
from [beefsack/bgg-ranking-historicals](https://github.com/beefsack/bgg-ranking-historicals). Not
affiliated with or endorsed by BoardGameGeek. No API keys, credentials or authentication are used
anywhere in this repository.
