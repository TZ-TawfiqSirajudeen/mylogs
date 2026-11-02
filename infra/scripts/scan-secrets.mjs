// Offline secret scanner for the working tree AND the full git history. No network, no dependencies, Node >= 22.
//
//     node infra/scripts/scan-secrets.mjs                 # working tree (tracked + untracked, honouring .gitignore) AND `git log -p --all`
//     node infra/scripts/scan-secrets.mjs --tree          # working tree only
//     node infra/scripts/scan-secrets.mjs --history       # history only
//     node infra/scripts/scan-secrets.mjs --max-findings 200
//
// Exit code 1 when anything is found that is not in infra/scripts/secret-scan-allowlist.json, 0 otherwise.
//
// SECRETS ARE NEVER PRINTED. A finding shows rule, file:line (and the commit for history), the value's length, and a
// fingerprint (the first 12 hex characters of SHA-256 of the value) so a reviewed false positive can be allow-listed
// without writing the value down. Git-ignored files (the real .env, .dev-secrets) are not read: use the history scan and a
// private review for those.
//
// Complements, does not replace, gitleaks in CI (.github/workflows/ci.yml): this one works with no internet and knows this
// repository's own credential shapes (MongoDB URIs, nxi_ ingest tokens, SECRETS_KEYS key rings).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWLIST_FILE = path.join(ROOT, 'infra/scripts/secret-scan-allowlist.json');

// ------------------------------------------------------------------ rules (pure; exported for the unit test)
const PLACEHOLDER = /^(?:<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|%[A-Z_]+%|%[sd]|x{3,}|\*{3,}|\.{3,}|\[[^\]]*\]|(?:your|my|some|the)[-_]?[\w-]*|changeme|change-me|replace[-_ ]?me|placeholder|example|password|passwd|pass|pwd|secret|user|username|test|dummy|fake|redacted|local-dev-secret-change-me|smoke-secret-value)$/i;

/** Shannon entropy in bits per character. */
export function entropy(s) {
  if (!s) return 0;
  const f = new Map();
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

const looksLikeRef = (v) => /process\.env|import\.meta|\$\{|<[^>]+>|\bfunction\b|=>|^\w+\(|\.\.\./.test(v);
const isPlaceholder = (v) => PLACEHOLDER.test(v) || /^(.)\1{5,}$/.test(v) || /^(?:test|fake|dummy|example|sample|demo|local|smoke|mock)[-_.\w]*$/i.test(v);

/**
 * Each rule: { id, re (global), pick(match) -> the secret value, ok?(value, match, line) -> boolean (false = ignore the hit), describe }.
 * `pick` returns what is hashed, measured and (never) printed.
 */
export const RULES = [
  {
    id: 'mongodb-uri-credentials',
    describe: 'MongoDB connection string with an embedded user:password',
    re: /mongodb(?:\+srv)?:\/\/([^\s:@/'"`<>]+):([^\s@/'"`<>]+)@/gi,
    pick: (m) => m[2],
    ok: (v) => !isPlaceholder(v) && !/^\$|^\{|\}$/.test(v) && !/^(?:pw|pwd|pass\d*|secret\d*|s3cret|hunter2|abc\d*|123\d*|1234)$/i.test(v),
  },
  { id: 'aws-access-key-id', describe: 'AWS access key id', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g, pick: (m) => m[0], ok: (v) => !/EXAMPLE/.test(v) },
  {
    id: 'aws-secret-access-key',
    describe: 'AWS secret access key assignment',
    re: /aws_?secret_?(?:access_?)?key['"]?\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})\b/gi,
    pick: (m) => m[1],
    ok: (v) => entropy(v) > 3.5 && !/EXAMPLE/.test(v),
  },
  { id: 'private-key-block', describe: 'PEM private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, pick: (m) => m[0] },
  { id: 'github-token', describe: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, pick: (m) => m[0] },
  { id: 'github-fine-grained-token', describe: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, pick: (m) => m[0] },
  { id: 'slack-token', describe: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, pick: (m) => m[0] },
  { id: 'google-api-key', describe: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, pick: (m) => m[0] },
  { id: 'stripe-secret-key', describe: 'Stripe secret key', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{20,}\b/g, pick: (m) => m[0] },
  { id: 'bearer-jwt', describe: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, pick: (m) => m[0], ok: (v, m, line) => !/test|fixture|example|mock/i.test(line) },
  {
    id: 'nexus-ingest-token',
    describe: 'Nexus ingestion token (nxi_...)',
    re: /\bnxi_[A-Za-z0-9_-]{20,}\b/g,
    pick: (m) => m[0],
    ok: (v) => entropy(v.slice(4)) > 3.6 && !/^nxi_(?:x+|0+|a+|test|example|fake)/i.test(v),
  },
  {
    id: 'kek-key-ring',
    describe: 'SECRETS_KEYS key-encryption key ring with a real-looking 32-byte base64 key',
    re: /SECRETS_KEYS['"]?\s*[:=]\s*['"]?[\w.-]+:([A-Za-z0-9+/]{43}=)/g,
    pick: (m) => m[1],
    ok: (v) => entropy(v) > 4,
  },
  {
    id: 'secret-assignment',
    describe: 'high-entropy value assigned to a secret-like name',
    re: /(?:secret|password|passwd|token|api[_-]?key|private[_-]?key|access[_-]?key|credential|kek)[\w.-]*['"]?\s*[:=]\s*['"`]?([A-Za-z0-9/+_=.-]{24,})['"`]?/gi,
    pick: (m) => m[1],
    ok: (v, m) => !looksLikeRef(v) && !isPlaceholder(v) && entropy(v) >= 4.0 && /\d/.test(v) && /[A-Za-z]/.test(v),
  },
  {
    id: 'long-hex-literal',
    describe: 'quoted hexadecimal string of 40+ characters with high entropy',
    re: /['"`]([0-9a-fA-F]{40,})['"`]/g,
    pick: (m) => m[1],
    ok: (v, m, line) => entropy(v) > 3.3 && !/sha\d*|integrity|checksum|digest|hash|commit|etag|sri|lock/i.test(line),
  },
  {
    id: 'long-base64-literal',
    describe: 'quoted base64 string of 40+ characters with high entropy on a secret-looking line',
    re: /['"`]([A-Za-z0-9+/]{40,}={0,2})['"`]/g,
    pick: (m) => m[1],
    ok: (v, m, line) => entropy(v) > 4.3 && /key|secret|token|password|credential|kek/i.test(line) && !looksLikeRef(line),
  },
];

const SKIP_FILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip|gz|tgz|br|wasm|mp4|map)$|(?:^|\/)node_modules\//;
// Self-references: this scanner's own rules and its test (which builds fixtures at run time) are not findings.
const SELF = new Set(['infra/scripts/scan-secrets.mjs', 'infra/scripts/scan-secrets.test.mjs', 'infra/scripts/secret-scan-allowlist.json']);

export const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

/** Scan one line. Returns [{ rule, col, length, fp }]. Values are NOT returned. */
export function scanLine(line) {
  if (line.length > 4000) return [];
  const out = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(line))) {
      const value = rule.pick(m);
      if (value && (!rule.ok || rule.ok(value, m, line))) out.push({ rule: rule.id, col: m.index + 1, length: value.length, fp: fingerprint(value) });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  // one finding per (rule, fingerprint) per line
  const seen = new Set();
  return out.filter((f) => { const k = `${f.rule}:${f.fp}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ------------------------------------------------------------------ allowlist
function loadAllowlist() {
  try {
    const j = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'));
    return (j.entries ?? []).map((e) => ({ rule: e.rule, fingerprint: e.fingerprint, path: e.path, reason: e.reason }));
  } catch { return []; }
}
const allowed = (list, f) => list.some((e) => e.fingerprint === f.fp && (!e.rule || e.rule === f.rule) && (!e.path || e.path === f.file));

// ------------------------------------------------------------------ git helpers
const git = (args, opts = {}) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const isGitRepo = () => git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true';

function listTreeFiles() {
  if (isGitRepo()) {
    const r = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'buffer' });
    return [...new Set(r.stdout.toString('utf8').split('\0').filter(Boolean))];
  }
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '.mongo-data', '.dev-secrets'].includes(e.name) || e.name === '.env' || e.name.startsWith('.env.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(ROOT);
  return out;
}

const findings = new Map(); // key -> { rule, file, line, length, fp, where, count, commits[] }
function record(f) {
  const key = `${f.rule}|${f.fp}|${f.file}|${f.where}`;
  const ex = findings.get(key);
  if (ex) { ex.count++; if (f.commit && ex.commits.length < 5 && !ex.commits.includes(f.commit)) ex.commits.push(f.commit); return; }
  findings.set(key, { ...f, count: 1, commits: f.commit ? [f.commit] : [] });
}

function scanTree(list) {
  let files = 0;
  for (const rel of listTreeFiles()) {
    if (SKIP_FILE.test(rel) || SELF.has(rel)) continue;
    const abs = path.join(ROOT, rel);
    let buf;
    try { const st = fs.statSync(abs); if (!st.isFile() || st.size > 2 * 1024 * 1024) continue; buf = fs.readFileSync(abs); } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    files++;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const f of scanLine(lines[i])) if (!allowed(list, { ...f, file: rel })) record({ ...f, file: rel, line: i + 1, where: 'tree' });
    }
  }
  return files;
}

async function scanHistory(list) {
  if (!isGitRepo()) { console.log('INFO  not a git repository: history scan skipped'); return { commits: 0, lines: 0 }; }
  const p = spawn('git', ['log', '-p', '--all', '--no-color', '--no-ext-diff', '-U0', '--no-renames', '--format=@@COMMIT %H'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', () => {});
  const rl = readline.createInterface({ input: p.stdout, crlfDelay: Infinity });
  let commit = '', file = '', line = 0, skip = true, commits = 0, scanned = 0;
  for await (const raw of rl) {
    if (raw.startsWith('@@COMMIT ')) { commit = raw.slice(9, 21); commits++; file = ''; skip = true; continue; }
    if (raw.startsWith('diff --git ')) { skip = true; continue; }
    if (raw.startsWith('+++ ')) { const t = raw.slice(4); file = t === '/dev/null' ? '' : t.replace(/^b\//, ''); skip = !file || SKIP_FILE.test(file) || SELF.has(file); continue; }
    if (raw.startsWith('--- ') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('Binary files')) { if (raw.startsWith('Binary files')) skip = true; continue; }
    if (raw.startsWith('@@ ')) { const m = /\+(\d+)/.exec(raw); line = m ? Number(m[1]) - 1 : 0; continue; }
    if (skip || !raw.startsWith('+')) continue;
    line++;
    scanned++;
    for (const f of scanLine(raw.slice(1))) if (!allowed(list, { ...f, file })) record({ ...f, file, line, where: 'history', commit });
  }
  await new Promise((r) => p.on('close', r));
  return { commits, lines: scanned };
}

// ------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const doTree = !args.includes('--history');
  const doHistory = !args.includes('--tree');
  const maxIdx = args.indexOf('--max-findings');
  const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 500;
  const list = loadAllowlist();
  console.log('Offline secret scan (values are never printed; fingerprint = first 12 hex of SHA-256).');
  if (doTree) { const n = scanTree(list); console.log(`INFO  working tree: ${n} text files scanned (tracked + untracked, git-ignored files such as .env are NOT read)`); }
  if (doHistory) { const h = await scanHistory(list); console.log(`INFO  history: ${h.commits} commits, ${h.lines} added lines scanned (git log -p --all)`); }
  const all = [...findings.values()].sort((a, b) => (a.where + a.file).localeCompare(b.where + b.file) || a.line - b.line);
  for (const f of all.slice(0, max)) {
    const at = f.where === 'history' ? ` (history, commit ${f.commits.join(',')}${f.count > 1 ? `, ${f.count} occurrences` : ''})` : '';
    console.log(`FOUND ${f.file}:${f.line}  [${f.rule}]  value=<REDACTED len=${f.length} fp=${f.fp}>${at}`);
  }
  if (all.length > max) console.log(`... ${all.length - max} more (raise --max-findings)`);
  console.log(all.length ? `FAIL  ${all.length} finding(s). Rotate real credentials (docs/runbooks/credential-rotation.md); allow-list reviewed false positives by fingerprint in infra/scripts/secret-scan-allowlist.json.` : 'PASS  no findings');
  process.exit(all.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(`ERROR ${e.message}`); process.exit(2); });
