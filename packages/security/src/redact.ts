/**
 * Redaction for audit payloads, logs, error messages and (later) telemetry. Key-based: any value under a key that looks
 * like a credential is replaced; string values additionally have URL-embedded credentials scrubbed.
 */
const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|credential|private[-_]?key|connection[-_]?(string|uri)|uri$|dsn$|session|csrf|signature|bearer/i;

export const REDACTED = '[REDACTED]';
/** scheme://user:password@host — credentials embedded in a URL are secrets whatever the key is called. */
// The password part is matched greedily up to the LAST '@' of the token, so passwords containing '@' or '/' are fully
// removed (a legal password may contain both). Whitespace ends the token; exact secret values are handled by scrubKnownSecrets.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:\S+@/gi;
const MAX_DEPTH = 8;
const MAX_STRING = 2_000;

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') {
    const scrubbed = value.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
    return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}…[TRUNCATED]` : scrubbed;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Removes the exact secret values used in a run from free text (driver/HTTP error messages can echo a password,
 * a token or a header value even when no key name gives it away).
 */
export function scrubKnownSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join(REDACTED);
  }
  return out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
}
