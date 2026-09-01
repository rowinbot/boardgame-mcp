import pLimit from 'p-limit';
import pRetry, { AbortError } from 'p-retry';

import { UpstreamError } from './errors.js';

/**
 * recommend.games is a hobby-tier Heroku deployment. During research it returned
 * 503 for several minutes after roughly five requests in quick succession, twice,
 * and recovered on its own. Heroku's router also hard-kills any request that
 * takes longer than 30s (H12), which the slower filtered queries genuinely reach.
 *
 * So: one request at a time, bounded retries with jitter, and a wall-clock cap
 * that is above the router's 30s rather than below it — cutting a request off at
 * 10s would just guarantee we never see the slow-but-successful responses.
 */
export const USER_AGENT = 'boardgame-mcp/0.1 (+https://github.com/rowinhernandez/boardgame-mcp)';

/** Statuses worth retrying. 400 is absent on purpose: a bad query is a bug, not a blip. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface HttpDeps {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export const defaultHttpDeps: HttpDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

export interface HttpOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Wall-clock cap for a single attempt. Above Heroku's 30s H12, on purpose. */
  timeoutMs?: number;
  baseDelayMs?: number;
}

const DEFAULTS = { attempts: 3, timeoutMs: 35_000, baseDelayMs: 700 } as const;

export class HttpClient {
  /**
   * The correct concurrency for this upstream is one. It 503s after roughly five
   * requests in quick succession, so requests are serialised rather than merely
   * rate-limited.
   */
  private readonly limit = pLimit(1);
  private readonly deps: HttpDeps;
  private readonly opts: Required<HttpOptions>;

  constructor(deps: Partial<HttpDeps> = {}, opts: HttpOptions = {}) {
    this.deps = { ...defaultHttpDeps, ...deps };
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Fetches JSON, one request at a time, retrying only what is worth retrying. */
  async getJson<T>(url: string): Promise<T> {
    return this.limit(() => this.attemptLoop<T>(url));
  }

  private async attemptLoop<T>(url: string): Promise<T> {
    return pRetry(
      async () => {
        try {
          return await this.once<T>(url);
        } catch (error) {
          // A non-UpstreamError is our own bug, not a blip. The silent-filter
          // guard throws one deliberately, and retrying it would hide the very
          // thing it exists to surface. AbortError stops p-retry immediately and
          // rethrows the original.
          if (!(error instanceof UpstreamError)) throw new AbortError(error as Error);
          const retryable = error.status === undefined || RETRYABLE_STATUS.has(error.status);
          if (!retryable) throw new AbortError(error);
          throw error;
        }
      },
      {
        retries: this.opts.attempts - 1,
        // p-retry's own backoff is deterministic. Jitter matters here because
        // several servers retrying a fragile upstream in lockstep is how a 503
        // becomes a sustained one.
        onFailedAttempt: async ({ attemptNumber, retriesLeft }) => {
          // p-retry calls this after the final attempt too. Sleeping there would
          // delay the rejection by a backoff nobody is waiting through.
          if (retriesLeft > 0) await this.deps.sleep(this.backoffMs(attemptNumber));
        },
        minTimeout: 0,
        maxTimeout: 0,
        factor: 1,
      },
    );
  }

  /** Exponential, with full jitter so retries from parallel servers do not synchronise. */
  private backoffMs(attempt: number): number {
    const ceiling = this.opts.baseDelayMs * 2 ** (attempt - 1);
    return Math.round(ceiling * (0.5 + this.deps.random() * 0.5));
  }

  private async once<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const response = await this.deps.fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new UpstreamError(`${response.status} ${response.statusText} from ${url}`, response.status);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new UpstreamError(`Network failure calling ${url}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
