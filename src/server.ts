import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { RecommendGamesClient } from './clients/recommendGames.js';
import { NameIndex } from './clients/nameIndex.js';
import { MechanicVocabulary, type ToolDeps } from './tools/shared.js';
import { ToolError, UpstreamError } from './lib/errors.js';
import * as similar from './tools/findSimilarGames.js';
import * as group from './tools/suggestGamesForGroup.js';
import { renderSimilar, renderGroup } from './render.js';

export const SERVER_INFO = { name: 'boardgame-mcp', version: '0.1.0' } as const;

export function createDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    games: overrides.games ?? new RecommendGamesClient(),
    index: overrides.index ?? NameIndex.load(),
    mechanics: overrides.mechanics ?? MechanicVocabulary.load(),
  };
}

/**
 * The distinction that decides whether a calling model can recover.
 *
 * A `ToolError` or an upstream outage is something the caller can do something
 * about — rephrase the name, relax a constraint, try again shortly. Those come
 * back as `isError: true` with an actionable sentence, and the conversation
 * continues.
 *
 * Anything else is a defect in this server: a filter we constructed wrongly, a
 * schema that no longer matches reality. Those are rethrown so the SDK emits a
 * JSON-RPC error, because dressing a bug up as a polite tool result just hides
 * it. Either way the stdio process stays alive — an unhandled rejection here
 * would kill the server and the client would simply see it vanish.
 */
async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ToolError) {
      return {
        content: [{ type: 'text', text: [error.message, error.suggestion].filter(Boolean).join(' ') }],
        structuredContent: { error: error.code, message: error.message, suggestion: error.suggestion ?? null },
        isError: true,
      };
    }
    if (error instanceof UpstreamError) {
      return {
        content: [
          {
            type: 'text',
            text:
              `recommend.games is currently unavailable${error.status ? ` (HTTP ${error.status})` : ''} and ` +
              `nothing suitable was cached. It is a hobby-tier service that sheds load and usually ` +
              `recovers within a few minutes — retrying shortly is worthwhile.`,
          },
        ],
        structuredContent: { error: 'upstream_unavailable', status: error.status ?? null },
        isError: true,
      };
    }
    throw error;
  }
}

export function buildServer(deps: ToolDeps = createDeps()): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool('find_similar_games', similar.config, async (args) =>
    guard(async () => {
      const output = await similar.findSimilarGames(deps, args);
      return { content: [{ type: 'text', text: renderSimilar(output) }], structuredContent: output };
    }),
  );

  server.registerTool('suggest_games_for_group', group.config, async (args) =>
    guard(async () => {
      const output = await group.suggestGamesForGroup(deps, args);
      return { content: [{ type: 'text', text: renderGroup(output) }], structuredContent: output };
    }),
  );

  return server;
}
