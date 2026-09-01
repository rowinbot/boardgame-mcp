import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The 503-backoff test advances a fake clock, but the protocol tests do real
    // in-process I/O. 20s is generous for both and still fails fast if we hang.
    testTimeout: 20_000,
  },
});
