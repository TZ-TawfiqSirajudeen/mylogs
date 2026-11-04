#!/usr/bin/env node
/**
 * nexus-connect: the "bot" that connects a Node.js project to Nexus Observability.
 *
 *   node nexus-connect.mjs --token nxi_xxx                       (run it inside the project folder)
 *   node nexus-connect.mjs --token nxi_xxx --endpoint https://ingest.example.com --dir ../mychap
 *   node nexus-connect.mjs --dry-run                              (show what would change, change nothing)
 *   node nexus-connect.mjs --undo                                 (put everything back)
 *
 * What it does, in order:
 *   1. finds the services in the folder (every apps/* or services/* package with a server entry file, else the folder itself);
 *   2. installs the OpenTelemetry packages (npm / pnpm / yarn, detected from the lockfile);
 *   3. writes ONE bootstrap file `nexus-telemetry.mjs` (traces + metrics + logs over OTLP/HTTP) next to the project root;
 *   4. adds a single import line at the very top of each service entry file (original saved to .nexus-connect-backup/);
 *   5. writes the endpoint and token to `.env.nexus` and adds it to .gitignore (the token never goes into source code).
 *
 * Zero dependencies. Node 18+. Safe to run twice (it skips what is already done).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

const MARK = 'nexus-connect';
const BACKUP_DIR = '.nexus-connect-backup';
const BOOTSTRAP = 'nexus-telemetry.mjs';
const ENV_FILE = '.env.nexus';
// Same versions the Nexus sample app is tested with.
const PACKAGES = [
  '@opentelemetry/api@^1.10.0',
  '@opentelemetry/api-logs@^0.223.0',
  '@opentelemetry/exporter-logs-otlp-proto@^0.300.0',
  '@opentelemetry/exporter-metrics-otlp-proto@^0.300.0',
  '@opentelemetry/exporter-trace-otlp-proto@^0.300.0',
  '@opentelemetry/instrumentation@^0.300.0',
  '@opentelemetry/instrumentation-http@^0.300.0',
  '@opentelemetry/resources@^3.0.0',
  '@opentelemetry/sdk-logs@^3.0.0',
  '@opentelemetry/sdk-metrics@^3.0.0',
  '@opentelemetry/sdk-trace-base@^2.12.0',
  '@opentelemetry/sdk-trace-node@^2.12.0',
];
const ENTRY_NAMES = ['server', 'index', 'main'];
const ENTRY_EXT = ['ts', 'js', 'mjs', 'cjs', 'mts'];

// ------------------------------------------------------------------ args
function parseArgs(argv) {
  const out = { dir: process.cwd(), endpoint: process.env.NEXUS_ENDPOINT ?? 'http://localhost:4318', token: process.env.NEXUS_TOKEN ?? '', env: 'development', dryRun: false, undo: false, noInstall: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? '';
    if (a === '--token') out.token = val();
    else if (a === '--endpoint') out.endpoint = val();
    else if (a === '--dir') out.dir = resolve(val());
    else if (a === '--env') out.env = val();
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--undo') out.undo = true;
    else if (a === '--no-install') out.noInstall = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`Unknown option: ${a}`); out.help = true; }
  }
  return out;
}
const HELP = `nexus-connect: connect a Node.js project to Nexus Observability.

Usage (run inside the project, or point at it with --dir):
  node nexus-connect.mjs --token <nxi_...> [--endpoint http://localhost:4318] [--env development]

Options:
  --token      Ingest token from Nexus > Ingestion (or set NEXUS_TOKEN). Prompted for if missing.
  --endpoint   Ingest base URL, no /v1/... (default http://localhost:4318, or NEXUS_ENDPOINT).
  --env        deployment.environment label (default development).
  --dir        Project folder (default: current folder).
  --dry-run    Show what would change and change nothing.
  --no-install Skip the package install (you will install the OpenTelemetry packages yourself).
  --undo       Restore every file this tool changed and remove what it added.
  -y, --yes    Do not ask for confirmation.
`;

// ------------------------------------------------------------------ helpers
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return undefined; } };
const log = (m = '') => console.log(m);
const toPosix = (p) => p.split(sep).join('/');
const backupName = (rel) => 'f__' + rel.replace(/[\\/]/g, '__');

function packageManager(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml')) || existsSync(join(root, 'pnpm-workspace.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function findEntry(serviceDir) {
  const pkg = readJson(join(serviceDir, 'package.json'));
  const candidates = [];
  for (const dirName of ['src', '']) for (const n of ENTRY_NAMES) for (const e of ENTRY_EXT) candidates.push(join(serviceDir, dirName, `${n}.${e}`));
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c;
  const main = pkg?.main;
  if (typeof main === 'string' && /\.(c|m)?[jt]s$/.test(main) && existsSync(join(serviceDir, main))) return join(serviceDir, main);
  return undefined;
}

/** Services: apps/* and services/* packages that have an entry file; otherwise the folder itself if it has one. */
function findServices(root) {
  const found = [];
  for (const group of ['apps', 'services', 'packages']) {
    const g = join(root, group);
    if (!existsSync(g)) continue;
    for (const name of readdirSync(g)) {
      const dir = join(g, name);
      if (!statSync(dir).isDirectory()) continue;
      const pkg = readJson(join(dir, 'package.json'));
      const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
      const isServer = ['express', 'fastify', 'koa', '@nestjs/core', 'hono', 'next'].some((d) => d in deps);
      if (!isServer || 'next' in deps) continue; // Next.js has its own instrumentation hook: left alone on purpose
      const entry = findEntry(dir);
      if (entry) found.push({ name, dir, entry });
    }
  }
  if (found.length) return found;
  const entry = findEntry(root);
  return entry ? [{ name: readJson(join(root, 'package.json'))?.name ?? basename(root), dir: root, entry }] : [];
}

function isEsm(entry, serviceDir, root) {
  if (/\.(ts|mts)$/.test(entry)) {
    const src = readFileSync(entry, 'utf8');
    return /^\s*(import|export)\s/m.test(src); // compiles to import or require; an `import 'x.cjs'` line works for both
  }
  if (entry.endsWith('.mjs')) return true;
  if (entry.endsWith('.cjs')) return false;
  const typeOf = (d) => readJson(join(d, 'package.json'))?.type;
  return (typeOf(serviceDir) ?? typeOf(root)) === 'module';
}

// ------------------------------------------------------------------ bootstrap file (generated into the project)
const EXTRA_INSTRUMENTATIONS = [
  { lib: 'express', mod: '@opentelemetry/instrumentation-express', cls: 'ExpressInstrumentation' },
  { lib: 'pino', mod: '@opentelemetry/instrumentation-pino', cls: 'PinoInstrumentation' },
];
function bootstrapSource(extras) {
  const template = readFileSync(new URL('./nexus-telemetry.template.mjs', import.meta.url), 'utf8');
  return template
    .replace('/*__EXTRA_IMPORTS__*/', extras.map((e) => `import { ${e.cls} } from '${e.mod}';`).join(String.fromCharCode(10)))
    .replace('/*__EXTRA_INSTRUMENTATIONS__*/', extras.map((e) => `, new ${e.cls}()`).join(''));
}

// ------------------------------------------------------------------ undo
function undo(root, dry) {
  const manifestPath = join(root, BACKUP_DIR, 'manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest) { log('Nothing to undo: no .nexus-connect-backup/manifest.json here.'); return; }
  for (const f of manifest.modified) {
    log(`  restore  ${f}`);
    if (!dry) copyFileSync(join(root, BACKUP_DIR, backupName(f)), join(root, f));
  }
  for (const f of manifest.created) { log(`  delete   ${f}`); if (!dry) rmSync(join(root, f), { force: true }); }
  if (!dry) rmSync(join(root, BACKUP_DIR), { recursive: true, force: true });
  log(dry ? '\n(dry run) nothing changed.' : '\nUndone. The OpenTelemetry packages stay in package.json; remove them with your package manager if you want.');
}

// ------------------------------------------------------------------ main
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { log(HELP); return; }
  const root = o.dir;
  if (!existsSync(join(root, 'package.json'))) { console.error(`No package.json in ${root}. Run this inside a Node.js project, or pass --dir.`); process.exit(1); }
  log(`nexus-connect  ·  project: ${root}${o.dryRun ? '  (DRY RUN)' : ''}\n`);
  if (o.undo) return undo(root, o.dryRun);

  if (!o.token && !o.dryRun) {
    if (!process.stdin.isTTY) { console.error('Missing --token (or NEXUS_TOKEN). Get one in Nexus > Ingestion.'); process.exit(1); }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    o.token = (await rl.question('Paste your Nexus ingest token (nxi_...): ')).trim();
    rl.close();
  }
  if (!o.dryRun && !/^nxi_/.test(o.token)) console.warn('Warning: the token does not start with nxi_. Check that you copied it from Nexus > Ingestion.');
  o.endpoint = o.endpoint.replace(/\/+$/, '').replace(/\/v1\/(logs|traces|metrics)$/, '');

  const services = findServices(root);
  if (!services.length) { console.error('Could not find a server entry file (server/index/main .ts/.js). Tell your developer to import nexus-telemetry.mjs first in the app entry.'); process.exit(1); }
  const pm = packageManager(root);
  const isWorkspace = existsSync(join(root, 'pnpm-workspace.yaml'));
  const rootPkg = readJson(join(root, 'package.json')) ?? {};
  const allDeps = { ...(rootPkg.dependencies ?? {}), ...(rootPkg.devDependencies ?? {}) };
  for (const s of services) Object.assign(allDeps, readJson(join(s.dir, 'package.json'))?.dependencies ?? {});

  log(`Package manager : ${pm}${isWorkspace ? ' (workspace)' : ''}`);
  log(`Endpoint        : ${o.endpoint}`);
  log(`Environment     : ${o.env}`);
  log(`Services (${services.length})   :`);
  for (const s of services) log(`   - ${s.name.padEnd(22)} ${toPosix(relative(root, s.entry))}`);
  log('\nPlanned changes:');
  log(`   + ${BOOTSTRAP}, ${ENV_FILE} (token stays here, gitignored), .gitignore entry`);
  log(`   ~ ${services.length} entry file(s): one import line added at the top (backup in ${BACKUP_DIR}/)`);
  if (!o.noInstall) log(`   + install ${PACKAGES.length}+ OpenTelemetry packages with ${pm}`);
  if (o.dryRun) { log('\n(dry run) nothing changed.'); return; }
  if (!o.yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question('\nProceed? [Y/n] ')).trim().toLowerCase();
    rl.close();
    if (a && a !== 'y' && a !== 'yes') { log('Cancelled. Nothing changed.'); return; }
  }

  // 1. packages
  const wanted = EXTRA_INSTRUMENTATIONS.filter((e) => e.lib in allDeps);
  if (!o.noInstall) {
    const run = (list) => {
      const args = pm === 'npm' ? ['install', '--save', ...list] : pm === 'yarn' ? ['add', ...list] : ['add', ...(isWorkspace ? ['-w'] : []), ...list];
      return spawnSync(pm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    };
    log('\nInstalling packages (this can take a minute)...');
    const r = run(PACKAGES);
    if (r.status !== 0) { console.error(`\nInstall failed (exit ${r.status}). Fix the error above and run again. Nothing in your source was changed.`); process.exit(1); }
    if (wanted.length) { const r2 = run(wanted.map((e) => e.mod)); if (r2.status !== 0) console.warn('Optional instrumentation packages failed to install; continuing without them.'); }
  }
  // only wire up an optional instrumentation if its package is really there (a missing one would stop the bootstrap)
  const extras = wanted.filter((e) => existsSync(join(root, 'node_modules', ...e.mod.split('/'))));

  // 2. files
  const manifest = readJson(join(root, BACKUP_DIR, 'manifest.json')) ?? { modified: [], created: [] };
  mkdirSync(join(root, BACKUP_DIR), { recursive: true });
  writeFileSync(join(root, BACKUP_DIR, '.gitignore'), '*\n');
  const created = (f) => { if (!manifest.created.includes(f)) manifest.created.push(f); };
  writeFileSync(join(root, BOOTSTRAP), bootstrapSource(extras)); created(BOOTSTRAP);
  writeFileSync(join(root, ENV_FILE), [
    '# Written by nexus-connect. Contains a secret token: do not commit.',
    `OTEL_EXPORTER_OTLP_ENDPOINT=${o.endpoint}`,
    'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
    `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${o.token}`,
    `NEXUS_ENV=${o.env}`,
    '# OTEL_SERVICE_NAME is chosen automatically per service; set it only to override.',
    '# NEXUS_DISABLED=1   turns telemetry off without removing anything.',
    '',
  ].join('\n'));
  created(ENV_FILE);
  const gi = join(root, '.gitignore');
  const giText = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!giText.split(/\r?\n/).includes(ENV_FILE)) {
    if (giText) { copyFileSync(gi, join(root, BACKUP_DIR, backupName('.gitignore'))); if (!manifest.modified.includes('.gitignore')) manifest.modified.push('.gitignore'); } else created('.gitignore');
    writeFileSync(gi, `${giText}${giText && !giText.endsWith('\n') ? '\n' : ''}${ENV_FILE}\n${BACKUP_DIR}/\n`);
  }
  const MARKER = `/* ${MARK} */`;
  for (const s of services) {
    const src = readFileSync(s.entry, 'utf8');
    if (src.includes(MARKER)) { log(`  skip     ${s.name} (already connected)`); continue; }
    const rel = toPosix(relative(dirname(s.entry), join(root, BOOTSTRAP)));
    const spec = rel.startsWith('.') ? rel : `./${rel}`;
    const esm = isEsm(s.entry, s.dir, root);
    const line = esm ? `import '${spec}'; ${MARKER}\n` : `require('${spec}'); ${MARKER}\n`;
    const relEntry = toPosix(relative(root, s.entry));
    copyFileSync(s.entry, join(root, BACKUP_DIR, backupName(relEntry)));
    manifest.modified.push(relEntry);
    // keep a shebang / "use strict" first line valid
    const m = /^(#!.*\n|['"]use strict['"];?\s*\n)/.exec(src);
    writeFileSync(s.entry, m ? m[0] + line + src.slice(m[0].length) : line + src);
    log(`  patched  ${relEntry}`);
  }
  manifest.modified = [...new Set(manifest.modified)];
  writeFileSync(join(root, BACKUP_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  log(`
Done. Next:
  1. Start your services as usual (restart them if they were running).
     Each one prints:  [nexus] telemetry on: service=<name>
  2. Send some traffic (open the app, call an API).
  3. In Nexus open Services, Traces and Logs (selecting the same project and environment as the token).
     Data usually appears within 15 to 30 seconds.

Logs from pino/express in ES-module apps ("type": "module") need ONE more thing, because Node cannot patch them otherwise.
  Start the services with this variable set (PowerShell shown; bash: export NODE_OPTIONS=...):
     $env:NODE_OPTIONS = "--import=${pathToFileURL(join(root, BOOTSTRAP)).href}"
  (Traces, HTTP spans and metrics already work without it.)

Docker? Containers cannot reach "localhost" on your machine: re-run with
  --endpoint http://host.docker.internal:4318   and make sure ${BOOTSTRAP} and ${ENV_FILE} are copied into the image.
Undo anytime:  node nexus-connect.mjs --undo`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
