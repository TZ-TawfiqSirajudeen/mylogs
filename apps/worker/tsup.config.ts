import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  noExternal: [/^@nexus\//],
  // Bundled CommonJS dependencies (the MongoDB driver) call require() for Node built-ins; an ES module has no `require`.
  banner: { js: "import { createRequire as __nxCreateRequire } from 'node:module'; const require = __nxCreateRequire(import.meta.url);" },
});
