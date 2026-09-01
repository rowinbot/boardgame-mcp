# ADR-003: resilience sized to the measured upstream

Status: accepted, 2026-09-01.

## Context

recommend.games runs on hobby-tier Heroku. During research it returned 503 for several minutes after
roughly five requests in quick succession, twice, and recovered on its own each time. Its router
terminates any request at 30 seconds. Its slower filtered queries genuinely take 15 to 19 seconds
when they succeed.

A server that treats this upstream like a healthy one will fail in front of whoever is watching the
demo.

## Decision

One request at a time. `src/lib/http.ts` wraps every call in a `p-limit(1)` queue. Concurrency is
hardcoded because the correct value for this upstream is one, and a configurable knob would only
offer a way to get it wrong.

Three attempts, exponential backoff with full jitter, on 429, 500, 502, 503, 504 and network
failures. HTTP 400 is excluded, and so is anything that is not an `UpstreamError`. A bad query is a
defect here. Retrying it hides the defect.

A 35 second cap per attempt. The router gives up at 30, so the cap sits above it. A 10 second cap
would guarantee the client never sees a slow-but-successful response.

Stale-while-error caching. Game detail lives 24 hours, queries 6 hours. An expired entry stays in the
cache. When the upstream fails, the tool answers from that entry and reports its age in
`cache.age_seconds` and in the text block.

The stale path covers upstream failures only. A `FilterIgnoredError` or a schema mismatch is a defect
here, and it is rethrown so the SDK emits a JSON-RPC error.

## Alternatives considered

A shorter per-attempt timeout. Rejected on the measurements: the queries this server issues take up
to 19 seconds when they work, so anything under 20 seconds would turn successes into failures.

Deterministic backoff, which is `p-retry`'s default. Rejected: several server instances retrying a
fragile upstream in lockstep is how a transient 503 becomes a sustained one. `backoffMs` applies the
jitter, and the default `minTimeout`, `maxTimeout` and `factor` are neutralised.

Evicting entries at TTL expiry, which is what a normal cache does. Rejected because the failure path
is the whole point. An answer from forty minutes ago with an honest note about its age is more use to
a calling model than an error.

`lru-cache`'s own `ttl` option. Rejected because it reads the real clock and offers no injection
point, so a faked clock in `test/resilience.test.ts` could not produce a stale entry. Freshness is
computed from `storedAt` against an injected `now()`. `lru-cache` keeps bounded size and LRU order.

## Consequences

A run of upstream failures is served from one cache entry, because `noDeleteOnStaleGet` keeps the
entry after a stale read.

`npm run demo` survives an outage. So does the test suite, which never touches the network at all.

Callers can tell a stale answer from a fresh one, because `cache.stale` and `cache.age_seconds` are
part of the published output schema.

Rate limiting is per-process. Two instances of this server running side by side will exceed what the
upstream tolerates.
