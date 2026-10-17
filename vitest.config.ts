import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Tests that start real processes and race real clocks (a gateway, upstreams and a Redis proxy talking over sockets;
 * limits that last seconds). They are heavy and sensitive to a starved CPU, and they in turn starve everything else:
 * the Redis parity tests, for one, drive an injected clock but Redis expires keys in real time, so a one-second
 * stall in the middle of them is a failure. So they run in their own phase, after the rest and one file at a time.
 */
const heavy = ['test/e2e/**/*.test.ts', 'test/cluster.integration.test.ts', 'test/process.test.ts'];

export default defineConfig({
  test: {
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...heavy],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: heavy,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
