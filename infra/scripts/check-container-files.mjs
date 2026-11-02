// Static checks for the container files, for machines WITHOUT Docker or nginx:
//
//     node infra/scripts/check-container-files.mjs
//
// It parses Dockerfile, docker-compose.yml, .dockerignore, infra/nginx/nginx.conf and infra/otel-collector/config.yaml and
// cross-checks them against the repository (workspace packages, service config schemas, tsup entries, ports).
// What it proves: internal consistency and the absence of the specific mistakes listed in docs/deployment.md.
// What it does NOT prove: that an image builds, that compose starts, that nginx accepts the file (`nginx -t`), image size,
// runtime behaviour, or that the image tags exist on a registry. Those need Docker/nginx (see docs/deployment.md).
// Exit code 1 when any check fails.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rel = (...p) => path.join(ROOT, ...p);
const exists = (p) => fs.existsSync(rel(p));
const read = (p) => fs.readFileSync(rel(p), 'utf8');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); };
const info = (msg) => console.log(`INFO  ${msg}`);

// ---------------------------------------------------------------- YAML parser (already installed by pnpm; nothing is added to the lockfile)
const pnpmDir = rel('node_modules/.pnpm');
const yamlPkg = fs.existsSync(pnpmDir) ? fs.readdirSync(pnpmDir).find((d) => /^yaml@\d/.test(d)) : undefined;
if (!yamlPkg) { console.log('FAIL  yaml parser not found in node_modules/.pnpm (run pnpm install)'); process.exit(1); }
const YAML = createRequire(import.meta.url)(path.join(pnpmDir, yamlPkg, 'node_modules', 'yaml'));
const parseYaml = (text) => YAML.parse(text, { merge: true });

// ---------------------------------------------------------------- .dockerignore matcher (Docker semantics: root-relative, ** and *, ! negation, last match wins, a matching parent excludes its children)
function ignoreMatcher(text) {
  const rules = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const neg = l.startsWith('!');
    const pat = (neg ? l.slice(1) : l).replace(/^\/+/, '').replace(/\/+$/, '');
    let re = '';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (c === '*' && pat[i + 1] === '*') { if (pat[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; } }
      else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return { neg, re: new RegExp(`^${re}$`) };
  });
  return (p) => {
    const parts = p.split('/');
    const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    let excluded = false;
    for (const r of rules) if (prefixes.some((x) => r.re.test(x))) excluded = !r.neg;
    return excluded;
  };
}

// ---------------------------------------------------------------- Dockerfile
const dockerfileText = read('Dockerfile');
const logical = [];
for (const raw of dockerfileText.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  if (logical.length && logical[logical.length - 1].endsWith('\\')) logical[logical.length - 1] = `${logical[logical.length - 1].slice(0, -1).trim()} ${line}`;
  else logical.push(line);
}
const stages = []; // { name, base, instr: [{op,args}] }
const argDefaults = {};
for (const l of logical) {
  const m = /^(\w+)\s+(.*)$/.exec(l);
  if (!m) continue;
  const op = m[1].toUpperCase(), args = m[2];
  if (op === 'ARG' && stages.length === 0) { const a = /^(\w+)=(.*)$/.exec(args); if (a) argDefaults[a[1]] = a[2]; continue; }
  if (op === 'FROM') { const f = /^(\S+)(?:\s+AS\s+(\S+))?$/i.exec(args); stages.push({ name: f?.[2] ?? `stage${stages.length}`, base: f?.[1] ?? '', instr: [] }); continue; }
  stages[stages.length - 1]?.instr.push({ op, args });
}
const stageNames = new Set(stages.map((s) => s.name));
const stageByName = (n) => stages.find((s) => s.name === n);
const resolveArg = (s) => s.replace(/\$\{(\w+)\}/g, (_, k) => argDefaults[k] ?? `\${${k}}`);
const ignored = ignoreMatcher(read('.dockerignore'));

// every stage's FROM resolves (an earlier stage or an image reference)
for (const [i, s] of stages.entries()) {
  const base = resolveArg(s.base);
  const isStage = stages.slice(0, i).some((x) => x.name === base);
  check(`Dockerfile stage "${s.name}": FROM ${s.base} resolves`, isStage || /[:/]/.test(base), `"${base}" is neither an earlier stage nor an image reference`);
}
// COPY --from references an existing stage; COPY sources exist and are not removed by .dockerignore
const copies = [];
for (const s of stages) for (const ins of s.instr) {
  if (ins.op !== 'COPY') continue;
  const flags = {}; const words = [];
  for (const w of ins.args.split(/\s+/)) { const f = /^--(\w+)=(.*)$/.exec(w); if (f) flags[f[1]] = f[2]; else words.push(w); }
  copies.push({ stage: s.name, from: flags.from, sources: words.slice(0, -1), dest: words[words.length - 1] });
}
for (const c of copies) {
  if (c.from) { check(`COPY --from=${c.from} (stage ${c.stage}) references an existing stage`, stageNames.has(c.from), 'unknown stage'); continue; }
  for (const src of c.sources) {
    if (src === '.') continue;
    check(`COPY source exists and is not excluded by .dockerignore: ${src}`, exists(src) && !ignored(src.replace(/\/+$/, '')), !exists(src) ? 'path does not exist' : 'removed by .dockerignore');
  }
}
// the dependency layer lists every workspace package.json, before the install
const wsYaml = parseYaml(read('pnpm-workspace.yaml'));
const wsDirs = [];
for (const g of wsYaml.packages ?? []) {
  const m = /^(.*)\/\*$/.exec(g);
  if (!m) { if (exists(`${g}/package.json`)) wsDirs.push(g); continue; }
  for (const d of fs.readdirSync(rel(m[1]), { withFileTypes: true })) if (d.isDirectory() && d.name !== 'node_modules' && exists(`${m[1]}/${d.name}/package.json`)) wsDirs.push(`${m[1]}/${d.name}`);
}
const build = stageByName('build');
const installAt = build ? build.instr.findIndex((i) => i.op === 'RUN' && /pnpm install/.test(i.args)) : -1;
check('build stage runs `pnpm install --frozen-lockfile`', installAt >= 0 && /--frozen-lockfile/.test(build.instr[installAt].args), 'missing or without --frozen-lockfile');
const layerCopies = new Set(installAt < 0 ? [] : build.instr.slice(0, installAt).filter((i) => i.op === 'COPY').flatMap((i) => i.args.split(/\s+/).filter((w) => !w.startsWith('--')).slice(0, -1)));
for (const d of wsDirs) check(`workspace package is in the dependency layer: ${d}/package.json`, layerCopies.has(`${d}/package.json`), 'pnpm install --frozen-lockfile fails when a workspace package manifest is missing');
for (const f of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', ...(exists('.npmrc') ? ['.npmrc'] : [])]) check(`dependency layer copies ${f}`, layerCopies.has(f), 'not copied before the install');
check('package.json pins packageManager (corepack uses the lockfile pnpm version)', !!JSON.parse(read('package.json')).packageManager, 'missing');

// ports, bind addresses and entrypoints of the runtime stages
const pick = (file, re) => { const m = re.exec(read(file)); return m ? m[1] : null; };
const expectations = [
  { stage: 'api', port: pick('apps/api/src/config.ts', /\bPORT:[^\n]*?default\((\d+)\)/), bindEnv: 'HOST', tsup: 'apps/api', dist: 'server.js' },
  { stage: 'worker', port: pick('apps/worker/src/main.ts', /WORKER_HEALTH_PORT:[^\n]*?default\((\d+)\)/), bindEnv: null, tsup: 'apps/worker', dist: 'main.js' },
  { stage: 'ingest', port: pick('apps/ingest/src/server.ts', /INGEST_PORT:[^\n]*?default\((\d+)\)/), bindEnv: 'INGEST_HOST', tsup: 'apps/ingest', dist: 'server.js' },
];
for (const e of expectations) {
  const s = stageByName(e.stage);
  check(`${e.stage}: default port read from source (${e.port})`, !!e.port, 'could not read the default from the source');
  const expose = s?.instr.filter((i) => i.op === 'EXPOSE').map((i) => i.args.trim()) ?? [];
  check(`${e.stage}: EXPOSE matches the app default ${e.port}`, expose.includes(String(e.port)), `EXPOSE ${expose.join(',') || '(none)'}`);
  const health = s?.instr.find((i) => i.op === 'HEALTHCHECK')?.args ?? '';
  check(`${e.stage}: HEALTHCHECK probes the app default port ${e.port} on /healthz`, health.includes(`||${e.port}`) && health.includes('/healthz'), health || 'no HEALTHCHECK');
  const env = s?.instr.filter((i) => i.op === 'ENV').map((i) => i.args).join(' ') ?? '';
  if (e.bindEnv) check(`${e.stage}: binds 0.0.0.0 inside the container (${e.bindEnv})`, new RegExp(`${e.bindEnv}=0\\.0\\.0\\.0`).test(env), `ENV: ${env}`);
  const cmd = s?.instr.find((i) => i.op === 'CMD')?.args ?? '';
  const entry = /dist\/([\w.-]+\.js)/.exec(cmd)?.[1];
  const tsupEntry = /entry:\s*\[\s*'src\/([\w.-]+)\.ts'/.exec(read(`${e.tsup}/tsup.config.ts`))?.[1];
  check(`${e.stage}: CMD entrypoint dist/${entry} is what tsup builds (src/${tsupEntry}.ts)`, !!entry && `${tsupEntry}.js` === entry, `CMD ${cmd}`);
  const copiesDist = copies.some((c) => c.stage === e.stage && c.from === 'build' && c.sources.includes(`/repo/${e.tsup}/dist`));
  check(`${e.stage}: the built dist/ is copied from the build stage`, copiesDist, 'no COPY --from=build of dist');
  if (exists(`${e.tsup}/dist/${e.dist}`)) check(`${e.stage}: ${e.tsup}/dist/${e.dist} exists on disk`, true);
  else info(`${e.tsup}/dist/${e.dist} not built here; run the build to check the file exists`);
}
const runtime = stageByName('runtime');
const runtimeOps = runtime?.instr.map((i) => `${i.op} ${i.args}`) ?? [];
const userAt = runtimeOps.findIndex((o) => /^USER node$/.test(o));
check('runtime stage drops to USER node', userAt >= 0, 'no USER node');
check('nothing in the Dockerfile switches back to root', !stages.some((s) => s.instr.some((i) => i.op === 'USER' && /^(root|0)$/.test(i.args.trim()))), 'USER root found');
const devDirAt = runtimeOps.findIndex((o) => /^RUN .*mkdir -p \/data\/dev-secrets.*chown .*node:node \/data/.test(o));
check('/data/dev-secrets is created and owned by node BEFORE the user switch (named volumes copy image ownership)', devDirAt >= 0 && devDirAt < userAt, 'a compose named volume would be root-owned and the API could not write the dev key');
const web = stageByName('web');
check('web stage is based on an unprivileged nginx image', /nginx-unprivileged/.test(resolveArg(web?.base ?? '')), web?.base ?? 'no web stage');
const webExpose = web?.instr.filter((i) => i.op === 'EXPOSE').map((i) => i.args.trim()) ?? [];
check('web: EXPOSE 8080', webExpose.includes('8080'), webExpose.join(','));
check('web: HEALTHCHECK uses /nginx-health on 8080', /8080\/nginx-health/.test(web?.instr.find((i) => i.op === 'HEALTHCHECK')?.args ?? ''), 'mismatch');
const mock = stageByName('mock-idp');
check('mock-idp stage runs as USER node', !!mock?.instr.some((i) => i.op === 'USER' && i.args.trim() === 'node'), 'no USER node');

// ---------------------------------------------------------------- .dockerignore against real and representative paths
const mustIgnore = ['.env', 'apps/api/.env', '.env.local', '.dev-secrets/kek.json', 'apps/api/.dev-secrets/kek.json', 'packages/database/.mongo-data/x.wt',
  'node_modules/x', 'apps/web/node_modules/x', 'apps/web/dist/index.html', 'tests/e2e/.results/x.zip', 'apps/api/server.log', '.git/config', 'AppData/Local/x'];
for (const p of mustIgnore) check(`.dockerignore excludes ${p}`, ignored(p), 'would be sent in the build context');
for (const p of ['.env.example', 'pnpm-lock.yaml', 'apps/api/src/server.ts', 'infra/nginx/nginx.conf', 'infra/otel-collector/config.yaml', 'tsconfig.base.json']) check(`.dockerignore keeps ${p}`, !ignored(p), 'excluded, but the image needs it');
for (const p of ['.dev-secrets', 'apps/api/.dev-secrets', 'packages/database/.mongo-data', '.env']) if (exists(p)) info(`${p} exists on this machine: ${ignored(p) ? 'excluded from the build context' : 'NOT excluded'}`);

// ---------------------------------------------------------------- docker-compose.yml
const composeText = read('docker-compose.yml');
const compose = parseYaml(composeText);
const services = compose.services ?? {};
const composeCode = composeText.replace(/(^|\s)#.*$/gm, '$1'); // comments may legitimately mention ${VAR:?...}
const interp = [...composeCode.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
for (const v of interp) check(`compose interpolation is valid: \${${v}}`, /^[A-Za-z_][A-Za-z0-9_]*(:?[-?+].*)?$/.test(v), 'invalid variable syntax');
check('compose has no required-variable (${VAR:?}) that could block the default stack', !/\$\{[^}]*:\?/.test(composeCode), 'a required variable in a profile service may stop `docker compose up`');
const dfHasHealth = (target) => { const s = stageByName(target); return !!s?.instr.some((i) => i.op === 'HEALTHCHECK'); };
const knownKeys = (file, re) => new Set([...read(file).matchAll(re)].map((m) => m[1]));
const schemaKeys = {
  api: knownKeys('apps/api/src/config.ts', /\b([A-Z][A-Z0-9_]{2,})\s*:\s*(?:z\.|bool\b)/g),
  worker: knownKeys('apps/worker/src/main.ts', /\b([A-Z][A-Z0-9_]{2,})\s*:\s*z\./g),
  ingest: knownKeys('apps/ingest/src/server.ts', /\b([A-Z][A-Z0-9_]{2,})\s*:\s*z\./g),
  'mock-idp': knownKeys('packages/mock-idp/src/cli.ts', /process\.env\.([A-Z][A-Z0-9_]+)/g),
};
const anyKnown = new Set([...schemaKeys.api, ...schemaKeys.worker, ...schemaKeys.ingest]);
const anchorKeys = new Set(Object.keys(compose['x-node-env'] ?? {}));
const hostPorts = [];
for (const [name, svc] of Object.entries(services)) {
  const target = svc.build?.target;
  if (svc.build) {
    check(`compose ${name}: build target "${target}" exists in the Dockerfile`, stageNames.has(target), 'unknown target');
    check(`compose ${name}: build context exists`, exists(svc.build.context ?? '.'), svc.build.context);
  }
  const env = Array.isArray(svc.environment) ? Object.fromEntries(svc.environment.map((e) => e.split(/=(.*)/s).slice(0, 2))) : svc.environment ?? {};
  const own = schemaKeys[name] ?? null;
  for (const k of Object.keys(env)) {
    if (!own) continue; // images we do not own (mongo, collector): not ours to check here
    const ok = anchorKeys.has(k) ? anyKnown.has(k) : own.has(k);
    check(`compose ${name}: environment ${k} is read by the service`, ok, anchorKeys.has(k) ? 'no service schema knows this name' : `not in ${name}'s config schema`);
  }
  for (const [dep, d] of Object.entries(Array.isArray(svc.depends_on) ? Object.fromEntries(svc.depends_on.map((x) => [x, {}])) : svc.depends_on ?? {})) {
    check(`compose ${name}: depends_on ${dep} exists`, !!services[dep], 'unknown service');
    const cond = d?.condition ?? 'service_started';
    check(`compose ${name}: depends_on ${dep} condition "${cond}" is valid`, ['service_started', 'service_healthy', 'service_completed_successfully'].includes(cond), cond);
    if (cond === 'service_healthy') check(`compose ${name}: ${dep} defines a healthcheck (compose or Dockerfile)`, !!services[dep]?.healthcheck || dfHasHealth(services[dep]?.build?.target), 'service_healthy would wait forever');
    if (!svc.profiles && services[dep]?.profiles) check(`compose ${name}: default service does not depend on profile service ${dep}`, false, 'cannot start without the profile');
  }
  for (const p of svc.ports ?? []) {
    const m = /^(\d+):(\d+)$/.exec(String(p));
    check(`compose ${name}: port mapping ${p} is HOST:CONTAINER`, !!m, 'unexpected format');
    if (m) hostPorts.push({ name, host: m[1] });
  }
  for (const v of svc.volumes ?? []) {
    const [src] = String(v).split(':');
    if (src.startsWith('.')) check(`compose ${name}: bind mount source exists: ${src}`, exists(src.replace(/^\.\//, '')), 'missing file');
    else check(`compose ${name}: named volume "${src}" is declared`, src in (compose.volumes ?? {}), 'declare it under volumes:');
  }
}
const seen = new Map();
for (const p of hostPorts) { if (seen.has(p.host)) check(`compose host port ${p.host} is unique`, false, `${seen.get(p.host)} and ${p.name}`); seen.set(p.host, p.name); }
check('compose host ports are unique', ![...hostPorts].some((p, i) => hostPorts.findIndex((q) => q.host === p.host) !== i), 'duplicate');
check('compose api HOST is not forced to loopback', !/127\.0\.0\.1/.test(JSON.stringify(compose.services?.api?.environment ?? {})), 'a published port would be unreachable');

// ---------------------------------------------------------------- nginx.conf (no nginx here: a tokenizer, brace/semicolon check and the rules that matter)
const nginxText = read('infra/nginx/nginx.conf');
function parseNginx(text) {
  const src = text.replace(/^\s*#.*$/gm, '');
  const toks = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([{};])|([^\s{};"']+)/g;
  let m;
  while ((m = re.exec(src))) toks.push(m[3] ?? (m[1] !== undefined ? { s: m[1] } : m[2] !== undefined ? { s: m[2] } : m[4]));
  let i = 0;
  const isPunct = (t) => t === '{' || t === '}' || t === ';'; // quoted strings are objects, so a quoted ";" is never punctuation
  const block = (top) => {
    const out = [];
    for (;;) {
      if (i >= toks.length) { if (!top) throw new Error('unclosed {'); return out; }
      if (toks[i] === '}') { if (top) throw new Error('unexpected }'); i++; return out; }
      const words = [];
      while (i < toks.length && !isPunct(toks[i])) { const t = toks[i++]; words.push(typeof t === 'object' ? t.s : t); }
      if (toks[i] === ';') { i++; out.push({ name: words[0], args: words.slice(1) }); }
      else if (toks[i] === '{') { i++; out.push({ name: words[0], args: words.slice(1), children: block(false) }); }
      else throw new Error(`directive "${words.join(' ')}" is not terminated by ;`);
    }
  };
  return block(true);
}
let ngx = null;
try { ngx = parseNginx(nginxText); check('nginx.conf: braces balance and every directive ends with ;', true); } catch (e) { check('nginx.conf: braces balance and every directive ends with ;', false, e.message); }
if (ngx) {
  const known = new Set(['server', 'listen', 'server_name', 'root', 'index', 'server_tokens', 'location', 'access_log', 'return', 'proxy_pass', 'proxy_http_version', 'proxy_set_header',
    'client_max_body_size', 'proxy_buffering', 'proxy_request_buffering', 'proxy_read_timeout', 'add_header', 'gzip', 'gzip_vary', 'gzip_min_length', 'gzip_types', 'try_files', 'expires', 'include', 'error_page']);
  const walk = (nodes, f) => nodes.forEach((n) => { f(n); if (n.children) walk(n.children, f); });
  const unknown = []; walk(ngx, (n) => { if (!known.has(n.name)) unknown.push(n.name); });
  check('nginx.conf: only known directives (typo guard)', unknown.length === 0, unknown.join(','));
  const server = ngx.find((n) => n.name === 'server');
  const kids = server?.children ?? [];
  const listens = kids.filter((n) => n.name === 'listen').map((n) => n.args[0]);
  check('nginx.conf: listens on 8080 only (unprivileged image cannot bind 80)', listens.length > 0 && listens.every((l) => l === '8080'), listens.join(','));
  const locs = kids.filter((n) => n.name === 'location');
  const loc = (p) => locs.find((l) => l.args[l.args.length - 1] === p);
  check('nginx.conf: /nginx-health exists (Dockerfile HEALTHCHECK path)', !!loc('/nginx-health') && /nginx-health/.test(web?.instr.find((i) => i.op === 'HEALTHCHECK')?.args ?? ''), 'missing');
  const api = loc('/api/');
  const dir = (l, n) => l?.children?.filter((c) => c.name === n) ?? [];
  const apiPort = expectations[0].port;
  check(`nginx.conf: /api/ proxies to the compose service "api" on ${apiPort}`, dir(api, 'proxy_pass')[0]?.args[0] === `http://api:${apiPort}` && !!services.api, dir(api, 'proxy_pass')[0]?.args[0]);
  check('nginx.conf: /api/ does not buffer (live tail / exports stream)', dir(api, 'proxy_buffering')[0]?.args[0] === 'off', 'proxy_buffering must be off');
  const readTimeout = dir(api, 'proxy_read_timeout')[0]?.args[0] ?? '60s';
  const secs = (v) => { const m = /^(\d+)(s|m|h)?$/.exec(v); return m ? Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] ?? 's']) : 0; };
  check('nginx.conf: /api/ read timeout is at least 1 hour (idle live-tail streams)', secs(readTimeout) >= 3600, readTimeout);
  const maxBody = dir(api, 'client_max_body_size')[0]?.args[0] ?? '1m';
  const bytes = (v) => { const m = /^(\d+)([kmg])?$/i.exec(v); return m ? Number(m[1]) * ({ k: 1024, m: 1048576, g: 1073741824 }[(m[2] ?? '').toLowerCase()] ?? 1) : 0; };
  const apiBody = Number(/bodyLimit:\s*(\d+)\s*\*\s*(\d+)/.exec(read('apps/api/src/app.ts'))?.slice(1).reduce((a, b) => a * Number(b), 1) ?? 0);
  check(`nginx.conf: /api/ body ceiling (${maxBody}) is not below the API's own limit (${apiBody} bytes)`, apiBody > 0 && bytes(maxBody) >= apiBody, 'requests the API would accept are refused by nginx');
  check('nginx.conf: /api/ adds no security headers of its own (the API sends its own; duplicates conflict)', dir(api, 'add_header').length === 0, 'remove add_header from /api/');
  const serverHeaders = kids.filter((n) => n.name === 'add_header');
  const staticLocs = locs.filter((l) => dir(l, 'try_files').length > 0);
  const required = ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Content-Security-Policy'];
  const sigs = [];
  for (const l of staticLocs) {
    const names = dir(l, 'add_header').map((h) => h.args[0]);
    check(`nginx.conf: static location ${l.args.join(' ')} sends every security header itself (add_header is not inherited when a location has its own)`, required.every((r) => names.includes(r)), `missing: ${required.filter((r) => !names.includes(r)).join(', ')}`);
    sigs.push(JSON.stringify(required.map((r) => dir(l, 'add_header').find((h) => h.args[0] === r)?.args.slice(1))));
  }
  check('nginx.conf: security headers are identical in every static location (no drift)', new Set(sigs).size <= 1, 'locations differ');
  check('nginx.conf: no server-level add_header that locations would silently drop', serverHeaders.length === 0 || staticLocs.every((l) => dir(l, 'add_header').length === 0), 'move them into the locations or remove');
  const csp = dir(staticLocs[0], 'add_header').find((h) => h.args[0] === 'Content-Security-Policy')?.args[1] ?? '';
  check("nginx.conf: CSP has default-src 'self' and frame-ancestors 'none'", /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp), csp);
  check('nginx.conf: CSP matches the pattern tests/e2e/specs/13 extracts', /add_header Content-Security-Policy "([^"]+)"/.test(nginxText), 'spec 13 would not find the CSP');
  const spa = loc('/');
  check('nginx.conf: SPA fallback to /index.html on /', dir(spa, 'try_files')[0]?.args.includes('/index.html'), 'missing');
  check('nginx.conf: / revalidates index.html (Cache-Control no-cache)', dir(spa, 'add_header').some((h) => h.args[0] === 'Cache-Control' && /no-cache/.test(h.args[1])), 'missing');
  const assets = loc('/assets/');
  check('nginx.conf: /assets/ is immutable-cached and a missing asset is 404, not the SPA shell', dir(assets, 'add_header').some((h) => h.args[0] === 'Cache-Control' && /immutable/.test(h.args[1])) && dir(assets, 'try_files')[0]?.args.includes('=404'), 'check /assets/');
  check('nginx.conf: static locations are gzip-compressed, /api/ is not (BREACH)', staticLocs.every((l) => dir(l, 'gzip')[0]?.args[0] === 'on') && dir(api, 'gzip').length === 0, 'gzip placement');
}

// ---------------------------------------------------------------- OpenTelemetry Collector config + compose profile
const colText = read('infra/otel-collector/config.yaml');
const col = parseYaml(colText);
const comps = (kind) => new Set(Object.keys(col[kind] ?? {}));
for (const [pipe, p] of Object.entries(col.service?.pipelines ?? {})) {
  for (const [kind, key] of [['receivers', 'receivers'], ['processors', 'processors'], ['exporters', 'exporters']]) {
    for (const c of p[key] ?? []) check(`collector pipeline ${pipe}: ${kind.slice(0, -1)} "${c}" is defined`, comps(kind).has(c), 'undefined component');
  }
}
const colSvc = services['otel-collector'];
if (colSvc) {
  const version = /otelcol-contrib v(\d+\.\d+\.\d+)/.exec(colText)?.[1];
  const tag = /opentelemetry-collector-contrib:(\S+)$/.exec(colSvc.image ?? '')?.[1];
  check(`collector image tag (${tag}) equals the version the config was verified with (v${version})`, !!version && tag === version, 'tag and verified binary version differ');
  const cfgArg = (colSvc.command ?? []).join(' ').match(/--config=(\S+)/)?.[1];
  check('collector: --config path equals the mounted file path', (colSvc.volumes ?? []).some((v) => String(v).split(':')[0] === './infra/otel-collector/config.yaml' && String(v).split(':')[1] === cfgArg), `command ${cfgArg}`);
  const supplied = new Set(Object.keys(colSvc.environment ?? {}));
  for (const m of colText.matchAll(/\$\{env:([A-Z0-9_]+)(:-[^}]*)?\}/g)) check(`collector env ${m[1]} has a default or is supplied by compose`, !!m[2] || supplied.has(m[1]), 'unset variable would fail the Collector');
  const baseUrl = colSvc.environment?.NEXUS_INGEST_BASE_URL;
  check(`collector exports to the compose ingest service on its port (${baseUrl})`, baseUrl === `http://ingest:${expectations[2].port}` && !!services.ingest, String(baseUrl));
}

// ---------------------------------------------------------------- credentials in container/infra files
const scanFiles = ['Dockerfile', 'docker-compose.yml', '.dockerignore', '.env.example', 'infra/nginx/nginx.conf', 'infra/otel-collector/config.yaml'];
const secretPatterns = [
  [/mongodb(?:\+srv)?:\/\/[^:\s/@]+:(?!\$\{|<|\*|\[)[^@\s]+@/i, 'MongoDB URI with an embedded password'],
  [/\bpassword\s*[:=]\s*(?!\$\{|<|\s*$)[^\s#]+/i, 'password literal'],
  [/Bearer\s+nxi_[A-Za-z0-9_-]{20,}/, 'ingest token'],
  [/nxi_[A-Za-z0-9_-]{40,}/, 'ingest token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/SECRETS_KEYS\s*[:=]\s*\S*[A-Za-z0-9+/]{32,}={0,2}/, 'key-encryption key'],
];
const allowed = ['local-dev-secret-change-me']; // the documented dev-only default for the bundled mock IdP
for (const f of scanFiles) {
  if (!exists(f)) continue;
  const text = allowed.reduce((t, a) => t.split(a).join('<dev-default>'), read(f));
  const hits = secretPatterns.filter(([re]) => re.test(text)).map(([, label]) => label);
  check(`no credentials in ${f}`, hits.length === 0, hits.join(', '));
}

// ---------------------------------------------------------------- summary
console.log('\nNot verifiable without Docker/nginx/registry access: image build, `docker compose up`, `nginx -t`, runtime behaviour, image size, image-tag existence.');
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
