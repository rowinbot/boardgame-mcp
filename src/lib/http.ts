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

/**
 * A serial queue. Not a general-purpose concurrency limiter — the correct limit
 * for this upstream is one, and hardcoding that is clearer than configuring it.
 */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    // The chain the next task waits on must never reject, or one failed request
    // would poison every request queued behind it. The caller still gets the
    // original rejection through `result`.
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class HttpClient {
  private readonly queue = new SerialQueue();
  private readonly deps: HttpDeps;
  private readonly opts: Required<HttpOptions>;

  constructor(deps: Partial<HttpDeps> = {}, opts: HttpOptions = {}) {
    this.deps = { ...defaultHttpDeps, ...deps };
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Fetches JSON, one request at a time, retrying only what is worth retrying. */
  async getJson<T>(url: string): Promise<T> {
    return this.queue.run(() => this.attemptLoop<T>(url));
  }

  private async attemptLoop<T>(url: string): Promise<T> {
    let lastError: UpstreamError | undefined;

    for (let attempt = 1; attempt <= this.opts.attempts; attempt += 1) {
      try {
        return await this.once<T>(url);
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        lastError = error;
        const retryable = error.status === undefined || RETRYABLE_STATUS.has(error.status);
        if (!retryable || attempt === this.opts.attempts) break;
        await this.deps.sleep(this.backoffMs(attempt));
      }
    }

    throw lastError ?? new UpstreamError(`Request to ${url} failed`);
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
