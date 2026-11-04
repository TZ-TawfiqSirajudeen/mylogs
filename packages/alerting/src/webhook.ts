import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { pinnedLookup, resolveSafeTarget, TargetRejectedError, type NetworkPolicy } from '@nexus/security';

/**
 * Outbound webhook delivery. Everything a hostile or careless URL could do is bounded here:
 *  - https is required unless the platform policy explicitly allows plain http (development);
 *  - credentials in the URL, fragments and over-long URLs are refused;
 *  - the target is resolved and EVERY address is checked (private, loopback, link-local, cloud metadata, mixed answers) on every send, and the
 *    connection is pinned to the validated addresses, so DNS rebinding between the check and the connect cannot redirect the request;
 *  - redirects are never followed (a 3xx is a failure);
 *  - the request has a hard timeout, the body a size cap, and the response is read only up to a small cap and then discarded.
 */
export const WEBHOOK_LIMITS = { timeoutMs: 5_000, maxBodyBytes: 16 * 1024, maxResponseBytes: 2 * 1024, maxUrlChars: 2_048 } as const;

export type WebhookErrorCode =
  | 'invalid_url' | 'insecure_scheme' | 'blocked_target' | 'dns_failure' | 'timeout' | 'connection_failed' | 'tls_error'
  | 'redirect_not_followed' | 'http_client_error' | 'http_server_error' | 'rate_limited_by_receiver' | 'body_too_large'
  // SMTP (ADR-0008)
  | 'smtp_rejected' | 'smtp_temporary_failure' | 'smtp_auth_failed' | 'smtp_tls_required' | 'smtp_protocol_error' | 'recipients_rejected' | 'invalid_address' | 'blocked_port';

export interface WebhookResult {
  ok: boolean;
  httpStatus: number | null;
  code: WebhookErrorCode | null;
  /** Never contains the URL, the secret or any part of the response body. */
  message: string;
  /** Whether trying again later could succeed (a 4xx, a blocked target or an invalid URL will not fix itself). */
  retryable: boolean;
}

export class WebhookUrlError extends Error {
  constructor(readonly code: WebhookErrorCode, message: string) { super(message); this.name = 'WebhookUrlError'; }
}

/** Static checks that need no network. Returns the parsed URL. */
export function parseWebhookUrl(raw: string, policy: Pick<NetworkPolicy, 'allowInsecureHttp'>): URL {
  if (raw.length > WEBHOOK_LIMITS.maxUrlChars) throw new WebhookUrlError('invalid_url', 'The URL is too long');
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebhookUrlError('invalid_url', 'The URL is not valid. Enter a full URL such as https://hooks.example.com/nexus'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new WebhookUrlError('invalid_url', 'Only https:// URLs are supported');
  if (url.protocol === 'http:' && !policy.allowInsecureHttp) throw new WebhookUrlError('insecure_scheme', 'Webhook URLs must use https:// (plain http:// is only permitted in development)');
  if (url.username || url.password) throw new WebhookUrlError('invalid_url', 'Credentials must not be embedded in the URL; use the signing secret instead');
  if (url.hash) throw new WebhookUrlError('invalid_url', 'The URL must not contain a fragment');
  return url;
}

/** Display form that is safe to show and store in plain text: scheme, host and port only (the path/query often carries a token). */
export function displayUrl(url: URL): string {
  return `${url.protocol}//${url.host}/…`;
}

/** Static checks plus DNS resolution and SSRF classification of every address. Throws WebhookUrlError. */
export async function checkWebhookTarget(raw: string, policy: NetworkPolicy): Promise<{ url: URL; addresses: string[]; port: number }> {
  const url = parseWebhookUrl(raw, policy);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  try {
    const t = await resolveSafeTarget(url.hostname, port, policy);
    return { url, addresses: t.addresses, port };
  } catch (e) {
    if (e instanceof TargetRejectedError) {
      if (e.code === 'dns_failure') throw new WebhookUrlError('dns_failure', 'The host name could not be resolved');
      throw new WebhookUrlError('blocked_target', 'This address is not permitted as a webhook target (private, loopback, link-local, metadata or reserved addresses are blocked)');
    }
    throw e;
  }
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Receivers should reject timestamps older than a few minutes (replay protection). */
export function signPayload(secret: string, timestampSeconds: number, body: string): string {
  return `t=${timestampSeconds},v1=${createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')}`;
}

export interface WebhookRequest { url: string; secret: string; event: string; deliveryId: string; body: string; now: Date }
export interface WebhookOptions { policy: NetworkPolicy; timeoutMs?: number; maxResponseBytes?: number }

export const fail = (code: WebhookErrorCode, message: string, retryable: boolean, httpStatus: number | null = null): WebhookResult => ({ ok: false, httpStatus, code, message, retryable });

export type WebhookSender = (req: WebhookRequest, opts: WebhookOptions) => Promise<WebhookResult>;

/** Slack incoming webhooks have no receiver-side signature check: the URL itself is the secret (stored encrypted, never returned). */
export interface SlackRequest { url: string; event: string; deliveryId: string; body: string; now: Date }
export type SlackSender = (req: SlackRequest, opts: WebhookOptions) => Promise<WebhookResult>;

/**
 * POSTs a JSON body to a user-supplied URL under every guard described at the top of this file. Shared by webhook and Slack channels so the
 * SSRF protections, redirect policy, timeouts and response handling cannot drift apart. Error messages never contain the URL.
 */
export async function postJson(rawUrl: string, extraHeaders: Record<string, string>, body: string, opts: WebhookOptions): Promise<WebhookResult> {
  if (Buffer.byteLength(body) > WEBHOOK_LIMITS.maxBodyBytes) return fail('body_too_large', 'The notification body exceeds the size limit', false);
  let target: Awaited<ReturnType<typeof checkWebhookTarget>>;
  try { target = await checkWebhookTarget(rawUrl, opts.policy); } catch (e) {
    if (e instanceof WebhookUrlError) return fail(e.code, e.message, e.code === 'dns_failure');
    return fail('connection_failed', 'The target could not be validated', true);
  }
  const { url, addresses, port } = target;
  const secure = url.protocol === 'https:';
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const timeoutMs = opts.timeoutMs ?? WEBHOOK_LIMITS.timeoutMs;
  const cap = opts.maxResponseBytes ?? WEBHOOK_LIMITS.maxResponseBytes;
  const payload = Buffer.from(body);
  const headers = { 'content-type': 'application/json', 'content-length': String(payload.length), 'user-agent': 'nexus-alerting/1', accept: '*/*', ...extraHeaders };
  return new Promise<WebhookResult>((resolve) => {
    let settled = false;
    const done = (r: WebhookResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { r.destroy(); done(fail('timeout', `The receiver did not answer within ${Math.round(timeoutMs / 1000)} seconds`, true)); }, timeoutMs);
    const r = (secure ? https : http).request({
      hostname, port, path: `${url.pathname}${url.search}`, method: 'POST', headers,
      // Connect ONLY to the addresses that passed validation (defeats DNS rebinding between check and connect).
      lookup: pinnedLookup(addresses),
      agent: false,
      ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
    }, (res) => {
      const status = res.statusCode ?? 0;
      let read = 0;
      res.on('data', (chunk: Buffer) => { read += chunk.length; if (read > cap) res.destroy(); }); // drained and discarded, never stored
      const finish = () => {
        if (status >= 200 && status < 300) return done({ ok: true, httpStatus: status, code: null, message: `Delivered (HTTP ${status})`, retryable: false });
        if (status >= 300 && status < 400) return done(fail('redirect_not_followed', `The receiver answered with a redirect (HTTP ${status}); redirects are never followed`, false, status));
        if (status === 429) return done(fail('rate_limited_by_receiver', 'The receiver is rate limiting (HTTP 429)', true, status));
        if (status === 408 || status >= 500) return done(fail('http_server_error', `The receiver failed (HTTP ${status})`, true, status));
        return done(fail('http_client_error', `The receiver rejected the notification (HTTP ${status})`, false, status));
      };
      res.on('end', finish); res.on('close', finish); res.on('error', finish);
    });
    r.on('error', (e: NodeJS.ErrnoException) => {
      const code = e.code ?? '';
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return done(fail('tls_error', `TLS certificate problem (${code})`, false));
      if (code === 'ETIMEDOUT') return done(fail('timeout', 'The connection timed out', true));
      done(fail('connection_failed', `Connection failed${code ? ` (${code})` : ''}`, true));
    });
    r.end(payload);
  });
}

export const sendWebhook: WebhookSender = (req, opts) => {
  const ts = Math.floor(req.now.getTime() / 1000);
  return postJson(req.url, { 'x-nexus-event': req.event, 'x-nexus-delivery': req.deliveryId, 'x-nexus-signature': signPayload(req.secret, ts, req.body) }, req.body, opts);
};

export const sendSlack: SlackSender = (req, opts) =>
  postJson(req.url, { 'x-nexus-event': req.event, 'x-nexus-delivery': req.deliveryId }, req.body, opts);
