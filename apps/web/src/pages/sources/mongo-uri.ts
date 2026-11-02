/**
 * Parses a MongoDB connection string in the browser so people can paste what Atlas, DocumentDB or a DBA gave them instead of
 * splitting it by hand. Pure and side-effect free: nothing is sent anywhere. The password is returned separately so the caller
 * can put it in the write-only credential field; it must never be logged or put in a URL.
 *
 * Monitoring connects to every member individually, so replica-set, read-preference and write options are accepted but ignored
 * (reported in `ignored`). `mongodb+srv://` needs a DNS lookup that only the server can do: the caller resolves `srvHost`.
 */
export interface ParsedMongoUri {
  scheme: 'mongodb' | 'mongodb+srv';
  username: string | null;
  password: string | null;
  /** Explicit members (mongodb://). Empty for mongodb+srv://. */
  hosts: { host: string; port: number }[];
  /** The single DNS name to expand with an SRV lookup (mongodb+srv://). */
  srvHost: string | null;
  authSource: string | null;
  /** null = the string did not say; leave the form's (secure) default alone. */
  tls: boolean | null;
  /** Options that were understood but have no effect on monitoring. */
  ignored: string[];
}
export type MongoUriResult = { ok: true; value: ParsedMongoUri } | { ok: false; error: string };

const IGNORED = new Set(['retrywrites', 'w', 'wtimeoutms', 'journal', 'readpreference', 'readpreferencetags', 'replicaset', 'appname', 'maxpoolsize', 'minpoolsize', 'retryreads', 'compressors', 'directconnection', 'connecttimeoutms', 'sockettimeoutms', 'serverselectiontimeoutms', 'heartbeatfrequencyms', 'loadbalanced', 'authmechanism']);

const decode = (s: string): string | null => { try { return decodeURIComponent(s); } catch { return null; } };
const bool = (v: string): boolean | null => (v === 'true' ? true : v === 'false' ? false : null);

export function parseMongoUri(input: string): MongoUriResult {
  const text = input.trim();
  const m = /^(mongodb(?:\+srv)?):\/\/(.*)$/is.exec(text);
  if (!m) return { ok: false, error: 'This is not a MongoDB connection string. It should start with mongodb:// or mongodb+srv://.' };
  const scheme = m[1]!.toLowerCase() as ParsedMongoUri['scheme'];
  const rest = m[2]!;
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd);

  let username: string | null = null, password: string | null = null, hostPart = authority;
  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    const info = authority.slice(0, at);
    hostPart = authority.slice(at + 1);
    const colon = info.indexOf(':');
    const u = decode(colon === -1 ? info : info.slice(0, colon));
    const p = colon === -1 ? null : decode(info.slice(colon + 1));
    if (u === null || (colon !== -1 && p === null)) return { ok: false, error: 'The username or password contains a "%" that is not a valid escape. Special characters (@ : / ? # % and so on) must be percent-encoded, e.g. @ becomes %40.' };
    username = u || null;
    password = p || null;
  }
  if (!hostPart) return { ok: false, error: 'The connection string has no host.' };

  const q = tail.indexOf('?');
  const dbName = decode((q === -1 ? tail : tail.slice(0, q)).replace(/^\//, '')) ?? '';
  const query = q === -1 ? '' : tail.slice(q + 1);

  let authSource: string | null = null, tls: boolean | null = null;
  const ignored: string[] = [];
  for (const pair of query.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const key = (decode(eq === -1 ? pair : pair.slice(0, eq)) ?? '').toLowerCase();
    const val = decode(eq === -1 ? '' : pair.slice(eq + 1)) ?? '';
    if (key === 'authsource') authSource = val || null;
    else if (key === 'tls' || key === 'ssl') tls = bool(val.toLowerCase());
    else if (IGNORED.has(key)) ignored.push(key === 'appname' ? 'appName' : key);
    else ignored.push(key);
  }
  if (!authSource && dbName && username) authSource = dbName;

  let hosts: ParsedMongoUri['hosts'] = [];
  let srvHost: string | null = null;
  if (scheme === 'mongodb+srv') {
    if (hostPart.includes(',') || /:\d+$/.test(hostPart) || hostPart.startsWith('[')) return { ok: false, error: 'A mongodb+srv:// string takes exactly one host name and no port. Use mongodb:// to list several hosts.' };
    if (hostPart.split('.').length < 3) return { ok: false, error: 'A mongodb+srv:// host needs at least three parts, like cluster0.abcde.mongodb.net.' };
    srvHost = hostPart.toLowerCase();
    tls ??= true; // srv implies TLS unless the string says otherwise
  } else {
    for (const raw of hostPart.split(',')) {
      const h = raw.trim();
      if (!h) return { ok: false, error: 'The host list has an empty entry.' };
      const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(h);
      const v4 = /^([^:[\]]+)(?::(\d{1,5}))?$/.exec(h);
      const hit = v6 ?? v4;
      if (!hit) return { ok: false, error: `"${h}" is not a valid host:port.` };
      const port = hit[2] ? Number(hit[2]) : 27017;
      if (port < 1 || port > 65535) return { ok: false, error: `"${h}" has an invalid port.` };
      hosts.push({ host: hit[1]!, port });
    }
    if (hosts.length > 7) return { ok: false, error: 'At most 7 hosts can be monitored in one connection.' };
  }
  return { ok: true, value: { scheme, username, password, hosts, srvHost, authSource, tls, ignored: [...new Set(ignored)] } };
}
