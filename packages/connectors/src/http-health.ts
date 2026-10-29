import http from 'node:http';
import https from 'node:https';
import { pinnedLookup, resolveSafeTarget, type SafeTarget } from '@nexus/security';
import {
  ConnectorError, withDeadline, type Connector, type ConnectorContext, type ConnectorDescriptor,
  type DiscoveryResult, type TestReport,
} from '@nexus/connector-sdk';
import { z } from 'zod';
import { fromTargetRejection, guarded, Run } from './run.js';

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'cookie', 'set-cookie', 'proxy-authorization']);

export const HttpHealthConfig = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  method: z.enum(['GET', 'HEAD']).default('GET'),
  expectedStatuses: z.array(z.number().int().min(100).max(599)).min(1).max(10).default([200, 204]),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
  /** Only for the "header" auth method; the value itself is a secret. */
  headerName: z.string().regex(HEADER_NAME).optional(),
});
export type HttpHealthConfig = z.infer<typeof HttpHealthConfig>;

const creds = {
  none: z.strictObject({}),
  bearer: z.strictObject({ token: z.string().min(1).max(4096) }),
  header: z.strictObject({ value: z.string().min(1).max(4096) }),
};
export type HttpHealthCreds = Partial<{ token: string; value: string }>;

const descriptor: ConnectorDescriptor = {
  type: 'http-health',
  displayName: 'Authenticated application health check',
  category: 'application',
  status: 'implemented',
  collection: 'not_implemented',
  signals: [
    { signal: 'metrics', availability: 'supported', note: 'Availability and latency of one endpoint (probing runs; time-series storage arrives with the telemetry pipeline).' },
    { signal: 'logs', availability: 'unsupported' }, { signal: 'traces', availability: 'unsupported' },
    { signal: 'events', availability: 'unsupported' }, { signal: 'inventory', availability: 'unsupported' },
  ],
  deploymentTypes: ['any HTTP(S) service reachable from the platform'],
  authMethods: [
    { id: 'bearer', label: 'Bearer token', recommended: true, description: 'Sent as "Authorization: Bearer …". Use a dedicated read-only health token.', secretFields: [{ name: 'token', label: 'Token' }] },
    { id: 'header', label: 'Custom header', recommended: false, description: 'A custom request header (e.g. X-Health-Key). The header name is configuration; the value is a secret.', secretFields: [{ name: 'value', label: 'Header value' }] },
    { id: 'none', label: 'No authentication', recommended: false, description: 'Only for public health endpoints.', secretFields: [] },
  ],
  requiredPermissions: [{ scope: 'target application', permission: 'Read access to the health endpoint only', why: 'The probe issues GET/HEAD requests and never sends a body.' }],
  operations: ['GET/HEAD probe', 'status check', 'latency measurement'],
  configRequirements: ['https:// URL (http:// only if an administrator enabled it)', 'a public address, or an approved private network path'],
  limitations: ['Redirects are never followed', 'Response bodies are not stored', 'Probes one URL per connection'],
  leastPrivilegeGuide: 'Create a token that can only call the health endpoint (for example, scope "health:read") and rotate it regularly.',
};

type Details = { status: number; latencyMs: number; retryAfterMs?: number; tls: boolean };

function codeToError(e: unknown, timedOut: boolean): ConnectorError {
  if (e instanceof ConnectorError) return e;
  const code = (e as { code?: string }).code ?? '';
  if (timedOut || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return new ConnectorError('timeout', 'The request timed out');
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code)) {
    return new ConnectorError('misconfigured', `TLS certificate problem (${code})`, { remediation: 'The server certificate is not trusted or does not match the host name. Fix the certificate; certificate validation cannot be disabled.' });
  }
  if (code === 'ABORT_ERR' || (e as Error).name === 'AbortError') return new ConnectorError('cancelled', 'Cancelled');
  return new ConnectorError('unreachable', `Connection failed${code ? ` (${code})` : ''}`);
}

function request(
  ctx: ConnectorContext, url: URL, target: SafeTarget, method: string, headers: Record<string, string>, timeoutMs: number,
): Promise<Details> {
  const dl = withDeadline(ctx.signal, timeoutMs);
  const secure = url.protocol === 'https:';
  const started = Date.now();
  return new Promise<Details>((resolve, reject) => {
    const done = (fn: () => void) => { dl.dispose(); fn(); };
    const req = (secure ? https : http).request({
      hostname: url.hostname.replace(/^\[|\]$/g, ''), port: target.port, path: `${url.pathname}${url.search}`, method, headers,
      // Connect ONLY to the addresses that passed validation (defeats DNS rebinding between check and connect).
      lookup: pinnedLookup(target.addresses),
      agent: false, // no keep-alive pool: nothing is reused across runs or tenants
      signal: dl.signal,
      ...(secure ? { servername: url.hostname.replace(/^\[|\]$/g, '') } : {}),
    }, (res) => {
      const retryAfter = Number(res.headers['retry-after']);
      const details: Details = { status: res.statusCode ?? 0, latencyMs: Date.now() - started, tls: secure, ...(Number.isFinite(retryAfter) ? { retryAfterMs: retryAfter * 1000 } : {}) };
      res.destroy(); // body is irrelevant and untrusted: never read it
      done(() => resolve(details));
    });
    req.on('error', (e) => done(() => reject(codeToError(e, dl.timedOut()))));
    req.end();
  });
}

function classify(status: number, expected: number[], d: Details): ConnectorError | null {
  if (expected.includes(status)) return null;
  if (status >= 300 && status < 400) return new ConnectorError('misconfigured', `The endpoint answered with a redirect (HTTP ${status}); redirects are never followed`, { remediation: 'Configure the final URL directly (for example, the https:// address without redirects).' });
  if (status === 401) return new ConnectorError('authentication', 'The endpoint rejected the credentials (HTTP 401)');
  if (status === 403) return new ConnectorError('permission_denied', 'The credentials are valid but not allowed to call this endpoint (HTTP 403)');
  if (status === 404) return new ConnectorError('misconfigured', 'The health endpoint was not found (HTTP 404)', { remediation: 'Check the URL path of the health endpoint.' });
  if (status === 429) return new ConnectorError('rate_limited', 'The endpoint is rate limiting requests (HTTP 429)', d.retryAfterMs ? { retryAfterMs: d.retryAfterMs } : {});
  if (status >= 500) return new ConnectorError('unhealthy', `The service reports itself unhealthy (HTTP ${status})`);
  return new ConnectorError('misconfigured', `Unexpected status HTTP ${status}; expected one of ${expected.join(', ')}`, { remediation: 'Adjust the expected status codes or the URL.' });
}

function parseUrl(config: HttpHealthConfig, ctx: ConnectorContext): URL {
  let url: URL;
  try { url = new URL(config.url); } catch { throw new ConnectorError('misconfigured', 'The URL is not valid', { remediation: 'Enter a full URL such as https://app.example.com/healthz' }); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConnectorError('misconfigured', 'Only http(s) URLs are supported');
  if (url.protocol === 'http:' && !ctx.network.allowInsecureHttp) {
    throw new ConnectorError('misconfigured', 'Plain http:// targets are not permitted by the platform policy', { remediation: 'Use an https:// URL.' });
  }
  if (url.username || url.password) {
    throw new ConnectorError('misconfigured', 'Credentials must not be embedded in the URL', { remediation: 'Remove user:password@ from the URL and use the credential fields.' });
  }
  return url;
}

function buildHeaders(authMethod: string | undefined, config: HttpHealthConfig, c: HttpHealthCreds): Record<string, string> {
  const h: Record<string, string> = { accept: '*/*', 'user-agent': 'nexus-health-probe/1' };
  if (authMethod === 'bearer' && c.token) h.authorization = `Bearer ${c.token}`;
  if (authMethod === 'header' && c.value) {
    const name = config.headerName?.toLowerCase();
    if (!name || FORBIDDEN_HEADERS.has(name)) throw new ConnectorError('misconfigured', 'A valid, allowed header name is required for the custom-header method');
    h[name] = c.value;
  }
  return h;
}

/** Which method was used is inferred from which secret fields are present (the connection layer validates against the chosen method). */
const inferMethod = (c: HttpHealthCreds) => (c.token ? 'bearer' : c.value ? 'header' : 'none');

export const httpHealthConnector: Connector<HttpHealthConfig, HttpHealthCreds> = {
  descriptor,
  configSchema: HttpHealthConfig as never,
  credentialSchema: (m) => (m in creds ? (creds[m as keyof typeof creds] as never) : undefined),

  validateConfig(config, authMethod) {
    const issues: string[] = [];
    if (config.headerName && FORBIDDEN_HEADERS.has(config.headerName.toLowerCase())) issues.push(`Header "${config.headerName}" is not allowed`);
    if (authMethod === 'header' && !config.headerName) issues.push('A header name is required for the custom-header method');
    return issues;
  },

  async test(ctx, config, c): Promise<TestReport> {
    const run = new Run(Object.values(c).filter((v): v is string => typeof v === 'string'));
    return guarded(run, async () => {
      if (ctx.signal.aborted) throw new ConnectorError('cancelled', 'Cancelled');
      const url = await run.step('config', 'Validate URL and options', async () => parseUrl(config, ctx), (u) => `${u.protocol}//${u.host}${u.pathname}`);
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      const target = await run.step('network-policy', 'Check target against network policy (SSRF protection)', async () => {
        try { return await resolveSafeTarget(url.hostname, port, ctx.network, { allowPorts: [] }); } catch (e) { throw fromTargetRejection(e); }
      }, (t) => `${t.addresses.length} address(es) validated`);
      const headers = buildHeaders(inferMethod(c), config, c);
      const d = await run.step('request', `${config.method} request`, async () => request(ctx, url, target, config.method, headers, config.timeoutMs),
        (r) => `HTTP ${r.status} in ${r.latencyMs} ms`);
      run.facts.statusCode = d.status;
      run.facts.latencyMs = d.latencyMs;
      run.facts.tls = d.tls;
      const err = classify(d.status, config.expectedStatuses, d);
      if (err) {
        run.steps.push({ id: 'status', label: 'Check response status', status: 'fail', detail: err.message, remediation: err.remediation ?? '' });
        throw err;
      }
      run.steps.push({ id: 'status', label: 'Check response status', status: 'pass', detail: `HTTP ${d.status} is expected` });
      if (!d.tls) run.warn('transport', 'Transport security', 'The probe used plain HTTP; the token (if any) was sent unencrypted.', 'Use https://.');
      run.capability({ id: 'availability', label: 'Availability probe', available: true, signal: 'metrics' });
      run.capability({ id: 'latency', label: 'Response latency', available: true, signal: 'metrics' });
      run.capability({ id: 'logs', label: 'Logs', available: false, signal: 'logs', reason: 'A health endpoint does not expose logs; use the OTLP or log-shipping sources.' });
    });
  },

  async discover(ctx, config): Promise<DiscoveryResult> {
    const url = parseUrl(config, ctx);
    return {
      resources: [{
        id: 'endpoint', type: 'http_endpoint', name: `${url.host}${url.pathname}`,
        // The query string is dropped: it can carry tokens.
        attributes: { origin: url.origin, path: url.pathname, method: config.method }, signals: ['metrics'],
      }],
      capabilities: [{ id: 'availability', label: 'Availability probe', available: true, signal: 'metrics' }],
      truncated: false,
    };
  },
};
