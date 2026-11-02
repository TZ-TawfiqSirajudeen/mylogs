import { configDefaults, defineConfig } from 'vitest/config';
// *.resilience.test.ts (real 3-member replica set, fault injection) run via `pnpm test:resilience`, not here.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 240_000, fileParallelism: false, exclude: [...configDefaults.exclude, 'src/**/*.resilience.test.ts'] } });
