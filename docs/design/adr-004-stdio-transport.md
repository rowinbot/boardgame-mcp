# ADR-004: stdio transport

Status: accepted, 2026-09-01.

## Context

The MCP TypeScript SDK ships two transports. `StdioServerTransport` runs the server as a subprocess
of the client and speaks JSON-RPC over stdin and stdout. `PerRequestHTTPServerTransport` runs it as
an HTTP service.

This server is a local tool for a local client. A reviewer clones the repository, and Claude Code
picks it up from the committed `.mcp.json` with no further configuration.

## Decision

stdio.

## Alternatives considered

Streamable HTTP. It would add a listener, session management, origin validation and CORS. None of
that changes the wire protocol the client sees, so the cost buys nothing here.

Both, behind a flag. Rejected as speculative. Nothing in the brief asks for a remote deployment.

## Consequences

An unhandled rejection would kill the process and leave the client watching the server vanish, so
`src/server.ts` wraps every tool call in an error boundary. That boundary is asserted in
`test/protocol.test.ts`.

Nothing binds a port, and there is no authentication surface to get wrong.

Adding HTTP later is a change to `src/index.ts` only. `buildServer()` returns an `McpServer` that
knows nothing about its transport, and `test/protocol.test.ts` already drives it over
`InMemoryTransport.createLinkedPair()`.
