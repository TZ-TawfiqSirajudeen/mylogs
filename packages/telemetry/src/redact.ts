import { REDACTED } from '@nexus/security';
import type { KV, RedactionPolicy } from './types.js';

/**
 * Redaction applied BEFORE anything is persisted or forwarded. Two layers:
 *  - attribute KEYS that name credentials (authorization, cookie, password, token, ...) have their value masked;
 *  - free text (messages, stack traces, and every attribute value) is scrubbed of credential-shaped substrings.
 * It is best-effort by nature: it cannot recognise an arbitrary secret in arbitrary text, which is why the per-project
 * `extraKeys` list exists and why applications should avoid logging secrets in the first place.
 */
const SENSITIVE_KEY =
  /(^|[._\-/])(pass(word|wd)?|pwd|secret|token|authorization|auth|cookie|set-cookie|api[-_]?key|apikey|credential|private[-_]?key|session(id)?|csrf|signature|bearer|x-api-key)([._\-/]|$)|connection[-_]?(string|uri)|client[-_]?secret/i;

const PATTERNS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:\S+@/gi, `$1${REDACTED}@`],
  // Authorization / Bearer / Basic credentials
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (_m, scheme) => `${scheme} ${REDACTED}`],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  // Well-known vendor token formats, recognisable even without a "key=" in front of them
  [/\b[spr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g, REDACTED], // Stripe
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, REDACTED], // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED], // Slack
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, REDACTED], // Google API keys
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, REDACTED], // SendGrid
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // AWS access key ids
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  // key=value / key: value / "key":"value" with a sensitive key name
  [/\b((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|authorization|client[_-]?secret|private[_-]?key|access[_-]?key)["']?\s*[=:]\s*["']?)([^\s"',;&]{3,})/gi, (_m, pre) => `${pre}${REDACTED}`],
];

export function scrubText(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [re, rep] of PATTERNS) {
    out = out.replace(re, (...args: unknown[]) => {
      count++;
      const m = args[0] as string;
      return typeof rep === 'function' ? rep(m, ...(args.slice(1, -2) as string[])) : m.replace(re, rep);
    });
  }
  return { text: out, count };
}

export function redactAttrs(attrs: KV[], policy: RedactionPolicy): { attrs: KV[]; count: number } {
  if (!policy.enabled) return { attrs, count: 0 };
  const extra = new Set(policy.extraKeys.map((k) => k.toLowerCase()));
  let count = 0;
  const out = attrs.map(({ k, v }) => {
    if (SENSITIVE_KEY.test(k) || extra.has(k.toLowerCase()) || [...extra].some((e) => k.toLowerCase().endsWith(`.${e}`))) {
      if (v !== REDACTED) count++;
      return { k, v: REDACTED };
    }
    const s = scrubText(v);
    count += s.count;
    return { k, v: s.text };
  });
  return { attrs: out, count };
}

export const isSensitiveKey = (k: string) => SENSITIVE_KEY.test(k);
