import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildServer } from '../src/server.js';
import { fixtureDeps } from './support/deps.js';

/**
 * These tests speak MCP. A linked in-memory transport pair carries real
 * JSON-RPC between a real client and a real server, so what is asserted is what
 * a client would actually receive — schema advertisement, structured content,
 * error flags — rather than the return value of an internal function.
 */
async function connected() {
  const server = buildServer(fixtureDeps());
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

describe('MCP protocol surface', () => {
  it('advertises both tools with input and output schemas', async () => {
    const { client, close } = await connected();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(['find_similar_games', 'suggest_games_for_group']);

      for (const tool of tools) {
        expect(tool.description, `${tool.name} description`).toBeTruthy();
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
        // Advertising an output schema is what lets a client rely on
        // structuredContent instead of parsing prose back out of the text block.
        expect(tool.outputSchema, `${tool.name} outputSchema`).toMatchObject({ type: 'object' });
      }
    } finally {
      await close();
    }
  });

  it('returns structured content for find_similar_games over the wire', async () => {
    const { client, close } = await connected();
    try {
      const result = await client.callTool({
        name: 'find_similar_games',
        arguments: { game: 'Catan', limit: 5 },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        seed: { bgg_id: number; name: string };
        recommendations: { bgg_id: number; score: number; why: string }[];
        resolution: { matched: string };
      };

      expect(structured.seed).toMatchObject({ bgg_id: 13, name: 'Catan' });
      expect(structured.resolution.matched).toBe('exact');
      expect(structured.recommendations).toHaveLength(5);

      for (const item of structured.recommendations) {
        expect(item.why.length).toBeGreaterThan(10);
        expect(item.score).toBeGreaterThan(0);
        expect(item.score).toBeLessThanOrEqual(1);
      }

      // Scores must be non-increasing: the ordering is the product.
      const scores = structured.recommendations.map((item) => item.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);

      const text = (result.content as { type: string; text: string }[])[0];
      expect(text?.type).toBe('text');
      expect(text?.text).toContain('Games like Catan');
    } finally {
      await close();
    }
  });

  it('returns structured content for suggest_games_for_group over the wire', async () => {
    const { client, close } = await connected();
    try {
      const result = await client.callTool({
        name: 'suggest_games_for_group',
        arguments: { players: 4, max_minutes: 60, complexity: 'light', limit: 5 },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        criteria: { complexity_band: { min: number; max: number }; players: number };
        suggestions: { name: string; complexity: number; players: { min: number; max: number } }[];
      };

      // The echoed criteria are part of the contract: the caller asked for
      // "light" and is told exactly what that was taken to mean.
      expect(structured.criteria.complexity_band).toEqual({ label: 'light', min: 1, max: 2.0 });
      expect(structured.suggestions.length).toBeGreaterThan(0);

      for (const game of structured.suggestions) {
        expect(game.complexity, game.name).toBeLessThanOrEqual(2.0);
        expect(game.players.min, game.name).toBeLessThanOrEqual(4);
        expect(game.players.max, game.name).toBeGreaterThanOrEqual(4);
      }
    } finally {
      await close();
    }
  });

  it('rejects invalid input at the protocol boundary, without calling upstream', async () => {
    const requests: string[] = [];
    const server = buildServer(fixtureDeps((url) => requests.push(url)));
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      // The SDK validates against the advertised inputSchema before dispatch and
      // reports failures as an error *result* rather than a JSON-RPC error — the
      // handler is never entered. Asserted here because it is the SDK's choice,
      // not ours, and a future version changing it would change our contract.
      for (const args of [{ players: 0 }, { players: 4, limit: 500 }, { players: 4, complexity: 'trivial' }]) {
        const result = await client.callTool({ name: 'suggest_games_for_group', arguments: args });
        expect(result.isError, JSON.stringify(args)).toBe(true);
        const text = (result.content as { text: string }[])[0]?.text ?? '';
        expect(text, JSON.stringify(args)).toContain('validation');
      }
      // Validation failing before any network call is the point: a malformed
      // request must not cost the fragile upstream anything.
      expect(requests).toEqual([]);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('reports an unknown tool as a protocol error', async () => {
    const { client, close } = await connected();
    try {
      await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
