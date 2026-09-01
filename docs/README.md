# docs

Four kinds of document, one canonical home each. Working rules for agents live in
[`../AGENTS.md`](../AGENTS.md).

## context

Durable knowledge about things this project does not control.

| File | What it holds |
|---|---|
| [context/upstream-api.md](context/upstream-api.md) | recommend.games as measured on 2026-09-01: page caps, verified filters, latencies, load shedding, response shape |
| [context/data-provenance.md](context/data-provenance.md) | where the committed files in `data/` and `test/fixtures/` came from, what they cover, how to rebuild them |

`context/upstream-api.md` is written as reference, so it reads mechanically on purpose.

## design

Decisions with a rejected alternative, numbered in sequence.

| ADR | Decides |
|---|---|
| [adr-001-data-source.md](design/adr-001-data-source.md) | recommend.games as the sole upstream, and why BGG's own APIs were declined |
| [adr-002-client-side-filtering.md](design/adr-002-client-side-filtering.md) | which filters go to the server and which run in memory |
| [adr-003-resilience-budget.md](design/adr-003-resilience-budget.md) | concurrency, retry, timeouts, stale-while-error caching |
| [adr-004-stdio-transport.md](design/adr-004-stdio-transport.md) | stdio over Streamable HTTP |

An ADR is never edited to reverse itself. To reverse a decision, write the next number and mark the
old one superseded.

## plans

[plans/scope.md](plans/scope.md) holds what was built and what was cut, with the reason for each cut.

## No deliverables directory

Larger projects here carry `docs/deliverables/` for submission artefacts. This one has a single
deliverable, the repository, and [`../README.md`](../README.md) is its front door. An empty directory
would only give a future reader a place to look and find nothing.
