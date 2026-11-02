import { defineConfig } from 'vitest/config';
// Failure-injection suite: real multi-member replica set, real Redis, fault-injecting proxies. Too slow for the default run (see `test:resilience`).
export default defineConfig({ test: { include: ['src/**/*.resilience.test.ts'], testTimeout: 120_000, hookTimeout: 240_000, fileParallelism: false } });
