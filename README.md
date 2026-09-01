# boardgame-mcp

An MCP server that recommends board games. Two tools, backed by
[recommend.games](https://recommend.games), a public no-auth REST API carrying 133,004 games with
BoardGameGeek's complexity ratings, mechanics, categories and community player-count polls.

| Tool | Answers |
|---|---|
| `find_similar_games` | "We like Wingspan — what else would we like?" |
| `suggest_games_for_group` | "Four of us, an hour, nothing heavy. What should we play?" |

Both return `structuredContent` against a published output schema, and both attach a plain-language
reason to every result — `shares 7 of 9 mechanics (Dice Rolling, End Game Bonuses, Hand Management);
complexity 2.4 vs 2.5; plays 1–5 (best at 2); 45 min`. A score a model can only repeat is worth less
than a justification it can defend.

## Run it

```
npm install
npm run demo
```

`npm run demo` connects a real MCP client to the server over a linked in-memory transport and makes
five tool calls, printing what comes back. It calls the live API and falls back to recorded fixtures
per-request if the upstream is down — which it may well be, see [The upstream](#the-upstream). To skip
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

`.mcp.json` is committed, so a client that reads it (Claude Code, and others) picks the server up from
the repo root with no further configuration.

**Node ≥ 22.19.0 is needed for `npm run inspector`.** The server, the tests and the demo run on Node
≥ 20 — this was developed on 22.15.0 — but MCP Inspector v2 declares `engines.node >= 22.19.0` and will
refuse to start below it. If `node --version` is lower and you want the Inspector, `nvm use 24` first.
Nothing else in the repo is affected.

## What the tools do

### `find_similar_games`

```jsonc
{ "game": "Catan", "limit": 8, "complexity_tolerance": 0.5 }
```

1. **Resolve the name offline** against a committed index of BGG's ranked games. Exact, then
   case-insensitive, then fuzzy: `wingspam` → Wingspan, `Carcasonne` → Carcassonne. A genuinely
   ambiguous name is refused rather than guessed — `Pandemic Legacy` comes back asking whether you
   meant Season 0, 1 or 2.
2. **Fetch the seed game** by id. This is the one upstream call that is consistently fast.
3. **Pull candidates** filtered on the seed's *most distinctive* mechanic — the one used by the fewest
   games in the corpus. This matters more than it looks: "Dice Rolling" is on 30,371 games and tells
   you nothing, while Wingspan's "Turn Order: Progressive" is on 503 and tells you a lot. Querying the
   first mechanic in the list instead of the rarest is the difference between a recommendation and a
   popularity chart.
4. **Score locally** on mechanic overlap (weight 0.40), categories (0.15), complexity proximity (0.20),
   player-range overlap (0.10), playtime (0.05), game type (0.05), and community rating (0.05). Rating
   is deliberately the smallest term — it breaks ties without letting a popular but unrelated game
   outrank a similar one.
5. **Exclude the seed's own family** — `implements`, `implemented_by`, `integrates_with`,
   `contained_in`, `compilation_of`. Without this, "similar to Catan" returns Catan: Seafarers and
   Catan: Cities & Knights, which is useless.

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

`best_at_count` is the parameter worth knowing about. BGG runs a community poll on the player counts a
game is actually *good* at, which is a different and more useful claim than the range printed on the
box — plenty of games technically support six players and are miserable with six. Set it and the tool
requires the poll to include your count. Games with no poll data are excluded rather than assumed
fine, because the whole point of the flag is the assertion.

`criteria` echoes back the resolved numeric bounds, so a caller who asked for "light" is told it meant
BGG weight 1.0–2.0 rather than having to guess.

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
the [board-game-recommender](https://gitlab.com/recommend.games/board-game-recommender) project. It is
open, unauthenticated, and generous. It also has three properties that shaped every design decision
here. All three were confirmed against the live service on 2026-09-01.

### 1. Unknown filter parameters are silently ignored

`?name=Catan` returns **HTTP 200 with all 133,004 games** and the default first page. So do `?bgg_id=13`
and `?name__icontains=gloomhaven`. No error, no warning, no hint. A one-character typo in a filter name
produces a confident, plausible, entirely wrong answer, and nothing in the response distinguishes it
from a correct one.

This gets two independent guards, in `src/clients/recommendGames.ts`:

- **An allow-list.** Every query is built through `buildQuery`, which throws `UnknownFilterError` on any
  key not on a list of filters verified to actually filter. The request is never sent. This catches the
  typo we write.
- **A corpus-size assertion.** After every response, `assertFilterApplied` checks that a query which
  narrowed the corpus came back with fewer rows than the corpus contains. This catches the filter the
  upstream quietly stops honouring — the version that would survive a deploy unnoticed. It throws
  rather than degrading: unlike a 503, it is our bug, so it is not retried, not cached, and not served
  stale.

### 2. `search=` is permanently broken

Every attempt returns Heroku's `Application Error` after ~30s — the router's H12 timeout — including
with a 90s client timeout. There is no working name lookup on the API at all.

Names therefore resolve entirely offline, against `data/name-index.tsv`: 31,226 ranked games built from
[beefsack/bgg-ranking-historicals](https://github.com/beefsack/bgg-ranking-historicals), which
publishes a fresh CSV daily. `npm run build-index` regenerates it, along with the mechanic and category
vocabularies — those are committed too, because the API caps *every* list endpoint at 25 rows, so
reading 192 mechanics costs 8 sequential requests against a service that falls over at around five.

The honest limitation: the index covers ranked base games, roughly 31k of the 133k corpus. Obscure
titles will not resolve, and they return a "did you mean" error rather than an empty list — an empty
list looks like a valid answer, and a failed lookup is not one.

### 3. It falls over, and its filters have wildly different costs

The service returned 503 for several minutes after a handful of sequential requests, twice, then
recovered on its own. More usefully, filter latency was measured individually against the ranked
corpus, on an otherwise idle service:

| Filter | Latency | Selectivity |
|---|---|---|
| `num_votes__gte` | 1.7s | 2,545 of 31,135 |
| `page` / `page_size` / `ordering` | 0.7–4.5s | — |
| `mechanic` | 3.2–8.3s | 383–8,476 |
| `complexity__gte` + `complexity__lte` | 15.3–16.6s | 1,785 |
| `min_players__lte` + `max_players__gte` | 18.8s | 23,846 |
| `max_time__lte` | **30.8s → 503** | — |

Against Heroku's hard 30s router cut-off, the expensive filters are not merely slow: stacked, they
exceed the budget and the query dies. The first implementation of `suggest_games_for_group` sent the
complexity band server-side and 503'd in testing, after full retry and backoff.

**So the server sends only the cheap, highly selective filters and does the rest of the work in
memory.** The list endpoint returns complete 58-key game objects, not summaries, so complexity bands,
player counts, playtime ceilings, co-op flags and exclusions are all applied locally over the returned
rows. Paying for four to eight cheap pages beats one expensive query that dies — and because every
complexity band now shares one base query, the cached pages serve all of them.

Range filters remain on the allow-list, because they are correct. They are simply not worth their
latency here. The measurements are recorded in the client next to the code they justify.

## Design

```
src/
  index.ts            stdio wiring, nothing else
  server.ts           tool registration and the error boundary
  render.ts           structured output → text a model can read aloud
  schemas.ts          shared Zod output schemas
  tools/              schema in, schema out. Never calls fetch.
  clients/            recommendGames, nameIndex, gameSchema. Never mention MCP.
  lib/                http (retry/backoff/serial queue), cache, score, errors
data/                 committed name index and vocabularies
test/fixtures/        real recorded upstream responses
```

Tools never call `fetch`; clients never know MCP exists. That separation is what makes the tests below
possible without a network.

### Validation

Zod 4 at both boundaries. `inputSchema` is advertised on `tools/list` and the SDK validates arguments
against it before the handler runs. `outputSchema` is advertised too, and the payload is validated on
the way out — validating our own output sounds redundant until the upstream changes a field's
nullability, at which point it is the difference between a loud failure here and a malformed payload
reaching the model. Upstream responses are parsed into a narrow internal type in `clients/`, so a shape
change fails in one place rather than surfacing as `undefined` three layers down.

One thing worth flagging, since it is the SDK's choice rather than ours: v2 reports input-validation
failures as a tool result with `isError: true`, not as a JSON-RPC error. There is a test asserting
this, so a future SDK version changing it will be caught rather than silently changing our contract.

### Errors

Two families, deliberately kept apart:

- **Recoverable by the caller** — game not found, name ambiguous, upstream 503, no results. Returned as
  `isError: true` with a structured, actionable message. A model can act on "recommend.games is
  returning 503, it usually recovers within a few minutes"; it cannot act on a stack trace.
- **Bugs in this server** — an unknown filter key, a schema mismatch. Rethrown, so the SDK emits a
  JSON-RPC error. Dressing a defect up as a polite tool result just hides it.

Either way nothing escapes as an unhandled rejection, which on stdio would kill the process and leave
the client watching the server vanish.

### Resilience

Sized to the limits actually measured, not to round numbers:

- **One request at a time.** The correct concurrency for this upstream is one, so it is hardcoded
  rather than configured.
- **Bounded retry** — 3 attempts, exponential backoff with full jitter, on 429/5xx and network
  failures. 400 is not retried: a bad query is a bug, not a blip.
- **35s per-attempt cap**, above Heroku's 30s router timeout rather than below it. Cutting requests off
  at 10s would guarantee we never see the slow-but-successful responses.
- **Stale-while-error caching.** Game detail 24h, queries 6h. Expired entries are kept rather than
  evicted, so when the upstream fails the tool serves the stale answer with its age surfaced in
  `cache.age_seconds` and a note in the text block. Given how readily this service 503s, this is the
  difference between a demo that survives and one that dies in front of you.

Small dependency surface on purpose: `@modelcontextprotocol/server` and `zod` at runtime, nothing else.
The retry loop, the serial queue and the stale-while-error cache are about forty lines each and are
directly tested — a general-purpose cache would have needed wrapping for the stale-on-error behaviour
anyway.

## Tests

47 tests, none of which touch the network.

- **`test/protocol.test.ts`** — a real `Client` talking to a real `McpServer` over
  `InMemoryTransport.createLinkedPair()`. Asserts tool advertisement including output schemas,
  `structuredContent` shape, monotonic result ordering, that every returned game genuinely satisfies
  the requested constraints, and that invalid input is rejected **without a single upstream request**.
  These assert what a client receives, not what an internal function returns.
- **`test/resilience.test.ts`** — the 503 path with an injected clock: bounded increasing backoff, then
  a stale cache hit reporting a 2,400-second age rather than throwing. Also: 400 is not retried, the
  serial queue survives a rejected task, and a dropped filter raises rather than returning 133k rows.
- **`test/nameIndex.test.ts`** — exact, case-folded, accent- and punctuation-insensitive, typo-corrected,
  ambiguous, and not-found resolution.
- **`test/recommendations.test.ts`** — scoring arithmetic, deterministic ranking, the seed's expansions
  excluded, supports-N versus best-at-N, and every one of the 300+ recorded fixture rows round-tripping
  through the upstream schema.

Fixtures are recorded from the live API (`npx tsx scripts/record-fixtures.ts`) rather than hand-written,
so they keep the upstream's real quirks — the nulls, the 25-row page cap, the relation id lists.

## Decisions worth stating

**stdio, not Streamable HTTP.** This server runs as a local subprocess for a local client, so HTTP would
add a listener, session management, origin validation and CORS without changing the wire protocol the
client actually sees. The SDK supports both; `PerRequestHTTPServerTransport` is a small change to
`src/index.ts` if a remote deployment ever needs one.

**Two tools, not three.** A third tool over a second API — game shops via OpenStreetMap's Overpass —
was scoped and cut. Two tools that handle a failing upstream correctly, with tests that prove it, are
worth more than three that each call `fetch` and hope. The resilience work is concentrated in one
hardened client instead of spread across two.

**On "TypeScript/React".** The brief asks for TypeScript/React, which does not quite fit a stdio MCP
server. Rather than building a UI to satisfy a word: the server is TypeScript throughout, and the React
surface is the MCP Inspector (`npm run inspector`), which is a Vite + React SPA and the standard way
MCP servers are reviewed. A bespoke page would have demonstrated less than the protocol-level tests do.

**BoardGameGeek is not used directly.** Its XML API now returns 401 and requires an approved
application; its open internal endpoints are richer than anything used here but are explicitly
unlicensed. The reasoning is in [`docs/adr-001-data-source.md`](docs/adr-001-data-source.md).

**AI assistance.** This was built with AI assistance. Every line was reviewed and every upstream claim
in this README was verified against the live service rather than taken from a model's description of
it — the latency table, the 25-row page cap and the silent-filter behaviour were all measured, and two
of them contradicted the original plan. The tests are the validation, and I am happy to walk through
any file, particularly the retry logic, the cache TTLs and the scoring weights.

## Known limitations

- **Name resolution covers ranked games only** (~31k of 133k). Obscure and very new titles will not
  resolve.
- **`suggest_games_for_group` searches a strong shortlist, not the whole corpus.** Candidates are the
  best-rated games with 500+ ratings, read in rating order to a fixed page budget. Requests with narrow
  constraints say so in `coverage_note` rather than quietly returning three results.
- **Complexity, ratings and best-at-N are absent on some games.** Missing components are dropped from
  the weighted average rather than scored zero, so a poorly-documented game is not penalised for the
  gap — that would bias results towards popular games and make the recommendations circular.
- **The corpus-size baselines are constants** observed on 2026-09-01. The corpus only grows, so they
  work as floors, but they are worth refreshing alongside `npm run build-index`.
- **No rate limiting across concurrent server instances.** The serial queue is per-process.

## Roadmap

Not built, and scoped deliberately rather than aspirationally.

- **BGG as a first-party source.** With an approved API token, `/xmlapi2/thing?id=…&stats=1` gives
  canonical mechanics, weight, ranks and the best-at-N poll from source. It needs a request queue
  rather than a fetch loop: `/thing` accepts at most 20 ids per call, BGG asks for a 5-second gap
  between requests, and `/collection` returns HTTP 202 while it queues an export and must be politely
  re-polled. Their terms also require a "Powered by BGG" attribution and forbid modifying retrieved
  data.
- **Collection-aware recommendations** — "what should we play tonight, out of what we own". Needs the
  BGG token and the 202 handling above.
- **Game shops** — Overpass over OpenStreetMap's `shop=games` tag. Verified working during scoping, and
  cut for scope. Worth knowing before building it: use `nwr` rather than `node`, since ~9% of matches
  are ways that carry `center` and no top-level `lat`/`lon` and a naive parser drops them silently;
  Overpass allows 2 concurrent slots per IP; and coverage is thin, ~3,700 tagged shops worldwide, so
  small result sets need a coverage note or they read as a bug.
- **Self-hosting the data.** `board-game-scraper` is open source. Running it removes the 503s entirely
  and is the honest answer if this ever became a product.

## Attribution

Game data from [recommend.games](https://recommend.games), derived from BoardGameGeek. Name index from
[beefsack/bgg-ranking-historicals](https://github.com/beefsack/bgg-ranking-historicals). Not affiliated
with or endorsed by BoardGameGeek. No API keys, credentials or authentication are used anywhere in this
repository.
