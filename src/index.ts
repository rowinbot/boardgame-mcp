#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { buildServer } from './server.js';

/**
 * stdio transport. An MCP server that runs as a local subprocess needs no HTTP
 * server, no session management and no CORS policy, and the wire protocol is
 * identical either way — see the README for why Streamable HTTP was considered
 * and not used.
 *
 * Nothing may be written to stdout except protocol frames. Diagnostics go to
 * stderr, which the client surfaces as server logs.
 */
async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error('boardgame-mcp ready on stdio');
}

main().catch((error: unknown) => {
  console.error('boardgame-mcp failed to start:', error);
  process.exit(1);
});
