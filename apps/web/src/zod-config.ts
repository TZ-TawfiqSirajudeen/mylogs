import { z } from 'zod';

// MUST be the first import of the entry point: schemas in @nexus/contracts are built when their module is evaluated, and the
// decision to JIT-compile is taken then. Zod's JIT probes `new Function`, which the production Content-Security-Policy (no
// 'unsafe-eval') correctly blocks. Interpreted validation is plenty fast for forms and API responses.
z.config({ jitless: true });
