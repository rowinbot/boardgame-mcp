import { HttpClient } from '../../src/lib/http.js';
import { RecommendGamesClient } from '../../src/clients/recommendGames.js';
import { NameIndex } from '../../src/clients/nameIndex.js';
import { MechanicVocabulary, type ToolDeps } from '../../src/tools/shared.js';
import { createRecordedFetch } from '../../src/lib/recordedFetch.js';

/**
 * Test dependencies wired to recorded fixtures. No test in this suite touches
 * the network, so the suite is deterministic and stays green when the upstream
 * is having one of its afternoons.
 */
export function fixtureDeps(onRequest?: (url: string) => void): ToolDeps {
  const http = new HttpClient({
    fetch: createRecordedFetch(onRequest ? { onRequest } : {}),
    sleep: async () => undefined,
  });
  return {
    games: new RecommendGamesClient({ http }),
    index: NameIndex.load(),
    mechanics: MechanicVocabulary.load(),
  };
}
