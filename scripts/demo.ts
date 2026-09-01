/**
 * Drives the server through the real MCP protocol and prints what comes back.
 *
 * It connects a real client to a real server over a linked in-memory transport,
 * so what you see is what a client receives — the same path an editor or agent
 * would take, minus the subprocess.
 *
 * By default it calls the live API and falls back to recorded fixtures whenever
 * a request fails, so the demo still shows real data when recommend.games is
 * having one of its 503 spells. `--offline` skips the network entirely.
 *
 *   npm run demo
 *   npm run demo -- --offline
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildServer, createDeps } from '../src/server.js';
import { HttpClient } from '../src/lib/http.js';
import { RecommendGamesClient } from '../src/clients/recommendGames.js';
import { createRecordedFetch } from '../src/lib/recordedFetch.js';

const offline = process.argv.includes('--offline');

let livePath = 0;
let fixturePath = 0;

/** Live first, recorded on failure. Reports which path each request took. */
function resilientFetch(): typeof globalThis.fetch {
  const replay = createRecordedFetch();
  if (offline) {
    return (async (...args: Parameters<typeof globalThis.fetch>) => {
      fixturePath += 1;
      return replay(...args);
    }) as typeof globalThis.fetch;
  }

  return (async (...args: Parameters<typeof globalThis.fetch>) => {
    try {
      const response = await globalThis.fetch(...args);
      if (response.ok) {
        livePath += 1;
        return response;
      }
    } catch {
      // Fall through to the recording.
    }
    fixturePath += 1;
    return replay(...args);
  }) as typeof globalThis.fetch;
}

const CALLS = [
  { name: 'find_similar_games', arguments: { game: 'Catan', limit: 5 } },
  { name: 'find_similar_games', arguments: { game: 'wingspam', limit: 5 } },
  { name: 'suggest_games_for_group', arguments: { players: 4, max_minutes: 60, complexity: 'light', limit: 5 } },
  { name: 'suggest_games_for_group', arguments: { players: 2, complexity: 'medium', cooperative: true, limit: 3 } },
  { name: 'find_similar_games', arguments: { game: 'Pandemic Legacy' } },
] as const;

async function main(): Promise<void> {
  const http = new HttpClient({ fetch: resilientFetch() });
  const deps = createDeps({ games: new RecommendGamesClient({ http }) });

  const server = buildServer(deps);
  const client = new Client({ name: 'boardgame-mcp-demo', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  console.log(`Connected. ${tools.length} tools: ${tools.map((tool) => tool.name).join(', ')}\n`);

  for (const call of CALLS) {
    console.log('─'.repeat(78));
    console.log(`> ${call.name}(${JSON.stringify(call.arguments)})\n`);
    const started = Date.now();
    const result = await client.callTool(call);
    const text = (result.content as { type: string; text: string }[])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    console.log(text);
    console.log(`\n[${result.isError ? 'tool error' : 'ok'} in ${((Date.now() - started) / 1000).toFixed(1)}s]\n`);
  }

  console.log('─'.repeat(78));
  console.log(
    offline
      ? `Offline run: ${fixturePath} requests served from recorded fixtures.`
      : `${livePath} requests hit recommend.games; ${fixturePath} fell back to recorded fixtures.`,
  );

  await Promise.all([client.close(), server.close()]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
