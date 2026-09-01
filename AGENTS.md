# boardgame-mcp, agent guide

Authoritative working rules for this repository, agent-agnostic. `CLAUDE.md` points here and holds no
rules of its own, so a rule changed in this file takes effect in every harness with no second edit.

## What this is

An MCP server with two tools, backed by [recommend.games](https://recommend.games), a public REST API
that needs no authentication. TypeScript throughout, stdio transport, no credentials anywhere in the
repo. Written as a hiring take-home, so the first thing a reader does is clone it and run
`npm install && npm run demo`.

## Hard rules

1. No credentials. The upstream needs none and nothing here reads an environment variable for auth. A
   change that appears to need a key is a change in the wrong direction.
2. Tools never call `fetch`. Clients never mention MCP. `src/tools/` takes a schema in and gives a
   schema out; `src/clients/` speaks HTTP and knows nothing about the protocol. That boundary is what
   makes 47 network-free tests possible.
3. Every upstream query goes through `buildQuery` in `src/clients/recommendGames.ts`. The API ignores
   unknown filter parameters and answers HTTP 200 with the whole 133,004-game corpus, so a
   hand-written URL string is a wrong answer waiting to happen. Read
   [docs/context/upstream-api.md](docs/context/upstream-api.md) before touching a query.
4. Numbers in prose are measured, and the measurement date is stated next to them. Where a number is
   assumed, say it is assumed.
5. Do not weaken a test to make a change pass. If a test is wrong, fix the test and say why in the
   commit.
6. Commit as you go, one coherent step per commit. Subject line `type: subject`, lowercase, no body
   unless the reasoning does not fit.

## Repo map

| Path | What lives there |
|---|---|
| `src/index.ts` | stdio wiring, nothing else |
| `src/server.ts` | tool registration and the error boundary |
| `src/tools/` | one file per tool, plus shared input coercion |
| `src/clients/` | the recommend.games HTTP client, the offline name index, the upstream Zod schema |
| `src/lib/` | retry and serial queue, stale-while-error cache, scoring, error types |
| `src/render.ts` | structured output turned into text a model can read aloud |
| `src/schemas.ts` | the published output schemas |
| `data/` | committed name index and mechanic/category vocabularies |
| `scripts/` | demo, index build, fixture recording |
| `test/` | four suites, none of which touch the network |
| `docs/` | mapped in [docs/README.md](docs/README.md) |

## Commands

```sh
npm install
npm run demo               # five tool calls over a real in-memory MCP transport
npm run demo -- --offline  # the same run against recorded fixtures
npm test                   # 47 tests, no network
npm run typecheck
npm start                  # the server itself, speaking MCP over stdio
npm run inspector          # MCP Inspector, the React web client
npm run build-index        # regenerate data/ from the upstream and the BGG ranking dump
```

`npm run inspector` wants Node 22.19 or newer. Everything else runs on Node 20 and up.

## Where a fact belongs

One canonical home per fact, and every other mention links to it. Two files that both assert the same
rule will drift.

| Kind of knowledge | Home |
|---|---|
| Measured upstream behaviour, corpus sizes, latencies | `docs/context/upstream-api.md` |
| Where the committed data files come from and how to refresh them | `docs/context/data-provenance.md` |
| A decision with a rejected alternative | `docs/design/adr-NNN-*.md` |
| What was built, what was cut, and why | `docs/plans/scope.md` |
| The reviewer's front door | `README.md` |

The README summarises and links. When it disagrees with a doc under `docs/`, the doc wins and the
README gets fixed in the same change.

A new ADR is numbered in sequence and never edited to reverse its own decision. Reversing a decision
means writing the next ADR and marking the old one superseded.

## Prose rules

These apply to every markdown file except the parameter and latency tables in
`docs/context/upstream-api.md`, where sounding mechanical is the point.

- No maxims. Say what happened to this project. Do not close a section on a general truth about
  software.
- No see-saw. `X rather than Y`, `X, not Y`, `not just X but Y`. Two clauses where the second restates
  the first from the negative side. State X and stop.
- No definite article on a noun the reader has not met yet.
- Simple past for past events. `measured`, never `was measuring`.
- Name the referent. No `that pattern`, no `this approach`.
- One idea per sentence. If it balances on `, and`, split it.
- No em dashes. Commas and full stops carry the same load.
- No rule of three. Use the number of items there actually are.
- No closing summary restating the section above it.
- Numbers over adjectives. `1.7s`, never `fast`.

## Verifying a claim about the upstream

recommend.games is a hobby-tier deployment that sheds load after about five requests in quick
succession. Anything that re-measures it runs serially, with pauses, and records the date. The
`.claude/agents/upstream-check.md` agent exists for that job.
