import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { capabilityMatrixMarkdown } from '@nexus/connector-sdk';
import { createDefaultRegistry } from './registry.js';

// `pnpm --filter @nexus/connectors matrix` regenerates docs/integrations/capability-matrix.md from the registry.
const out = resolve(process.cwd(), process.argv[2] ?? '../../docs/integrations/capability-matrix.md');
const registry = createDefaultRegistry();
const md = capabilityMatrixMarkdown(registry.list());
const guides = registry.list().filter((d) => d.status === 'implemented' && d.leastPrivilegeGuide)
  .map((d) => `## ${d.displayName}: least-privilege setup\n\n\`\`\`\n${d.leastPrivilegeGuide}\n\`\`\`\n\n**Required permissions**\n\n${d.requiredPermissions.map((p) => `- \`${p.permission}\` (${p.scope})${p.optional ? ' — optional' : ''}: ${p.why}`).join('\n')}\n\n**Known limitations**\n\n${d.limitations.map((l) => `- ${l}`).join('\n')}\n`)
  .join('\n');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${md}\n${guides}`);
console.log(`wrote ${out}`);
