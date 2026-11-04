import { isIP } from 'node:net';
import net from 'node:net';
import tls from 'node:tls';
import { EMAIL_LIMITS, isValidEmailAddress, type SmtpSecurity } from '@nexus/contracts';
import { pinnedLookup, resolveSafeTarget, TargetRejectedError, type NetworkPolicy } from '@nexus/security';
import { fail, WebhookUrlError, type WebhookResult } from './webhook.js';

/**
 * A deliberately small SMTP submission client (ADR-0008 #4-5, #9-10): connect to a *validated, pinned* address, optional implicit TLS or a REQUIRED
 * STARTTLS upgrade, AUTH PLAIN/LOGIN, one message to a handful of recipients. It never follows anything the server says beyond reply codes: server
 * text is not copied into results, so a hostile server cannot put secrets or markup into the delivery log.
 */
export const SMTP_LIMITS = { connectTimeoutMs: 5_000, totalTimeoutMs: 20_000, maxLineChars: 1_024, maxReplyBytes: 8 * 1024 } as const;
/** Ports opened up for SMTP on top of the generic guard's blocklist (it blocks 25, 465 and 587 for the HTTP path). */
const SMTP_ALLOW_PORTS = [465, 587];

export interface SmtpRequest {
  host: string; port: number; security: SmtpSecurity;
  username?: string | undefined; password?: string | undefined;
  from: string; to: string[];
  /** The complete message (headers and body, CRLF line endings). Dot-stuffing is done here. */
  message: string;
  localName?: string;
}
export interface SmtpOptions {
  policy: NetworkPolicy; totalTimeoutMs?: number; connectTimeoutMs?: number;
  /** Extra trusted CA certificate(s) (PEM). Only ever supplied by code (tests); never by an API request. Verification stays on. */
  tlsCa?: string | string[];
}
export type EmailSender = (req: SmtpRequest, opts: SmtpOptions) => Promise<WebhookResult>;

/** Static + DNS + SSRF checks for an SMTP target. Same guard as webhooks; the mail ports 465/587 (and 2525) are the only ones allowed outside development. */
export async function checkSmtpTarget(host: string, port: number, policy: NetworkPolicy): Promise<{ addresses: string[] }> {
  const dev = policy.allowInsecureHttp; // the development switch (same flag that allows plain http for webhooks)
  if (!dev && !EMAIL_LIMITS.smtpPorts.includes(port)) throw new WebhookUrlError('blocked_port', 'SMTP port must be 587 (STARTTLS), 465 (implicit TLS) or 2525');
  try {
    const t = await resolveSafeTarget(host.replace(/^\[|\]$/g, ''), port, policy, { allowPorts: dev ? [...SMTP_ALLOW_PORTS, port] : SMTP_ALLOW_PORTS });
    return { addresses: t.addresses };
  } catch (e) {
    if (e instanceof TargetRejectedError) {
      if (e.code === 'dns_failure') throw new WebhookUrlError('dns_failure', 'The SMTP host name could not be resolved');
      if (e.code === 'blocked_port') throw new WebhookUrlError('blocked_port', 'SMTP port must be 587 (STARTTLS), 465 (implicit TLS) or 2525');
      throw new WebhookUrlError('blocked_target', 'This address is not permitted as an SMTP target (private, loopback, link-local, metadata or reserved addresses are blocked)');
    }
    throw e;
  }
}

interface Reply { code: number; lines: string[] }
class SmtpFailure extends Error { constructor(readonly result: WebhookResult) { super(result.message); } }

/** Line-oriented SMTP reply reader over a socket. Bounded: a line longer than the cap or a reply larger than the cap is a protocol error. */
function makeReader(sock: net.Socket) {
  let buf = '', bytes = 0;
  let acc: string[] = [];
  const queue: Reply[] = [];
  let waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  let error: Error | null = null;
  const protocol = () => new SmtpFailure(fail('smtp_protocol_error', 'The SMTP server sent an unexpected or oversized response', true));
  const push = (r: Reply) => { if (waiter) { const w = waiter; waiter = null; w.resolve(r); } else queue.push(r); };
  const stop = (e: Error) => { error = error ?? e; if (waiter) { const w = waiter; waiter = null; w.reject(error); } };
  const onData = (d: Buffer) => {
    buf += d.toString('latin1'); bytes += d.length;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) { if (buf.length > SMTP_LIMITS.maxLineChars) return stop(protocol()); return; }
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.length > SMTP_LIMITS.maxLineChars) return stop(protocol());
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) return stop(protocol());
      acc.push(m[3]!);
      if (acc.join('').length > SMTP_LIMITS.maxReplyBytes) return stop(protocol());
      if (m[2] === ' ') { const r = { code: Number(m[1]), lines: acc }; acc = []; bytes = 0; push(r); }
    }
  };
  const onEnd = () => stop(Object.assign(new Error('closed'), { code: 'ECONNRESET' }));
  const onErr = (e: Error) => stop(e);
  sock.on('data', onData); sock.on('error', onErr); sock.on('close', onEnd); sock.on('end', onEnd);
  return {
    read(): Promise<Reply> {
      const q = queue.shift();
      if (q) return Promise.resolve(q);
      if (error) return Promise.reject(error);
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    /** Anything buffered but not yet consumed (used to refuse a STARTTLS plaintext-injection attempt). */
    pending: () => buf.length > 0 || queue.length > 0 || acc.length > 0,
    detach() { sock.off('data', onData); sock.off('error', onErr); sock.off('close', onEnd); sock.off('end', onEnd); },
  };
}

const classify = (step: 'greeting' | 'ehlo' | 'starttls' | 'auth' | 'mail' | 'data' | 'body', code: number): WebhookResult => {
  if (step === 'auth') return code >= 500 || code === 334 ? fail('smtp_auth_failed', `SMTP authentication failed (${code}); check the user name and password`, false) : fail('smtp_temporary_failure', `The SMTP server could not authenticate right now (${code})`, true);
  if (code >= 400 && code < 500) return fail('smtp_temporary_failure', `The SMTP server temporarily refused the message (${code})`, true);
  if (code >= 500 && code < 600) return fail('smtp_rejected', `The SMTP server rejected the message (${code})`, false);
  return fail('smtp_protocol_error', `Unexpected SMTP reply (${code})`, true);
};
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** CRLF-normalise, dot-stuff (RFC 5321 4.5.2) and terminate. */
export function dotStuff(message: string): string {
  const body = message.replace(/\r\n|\r|\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
  return `${body}${body.endsWith('\r\n') ? '' : '\r\n'}.\r\n`;
}

export const sendSmtp: EmailSender = async (req, opts) => {
  const dev = opts.policy.allowInsecureHttp;
  if (!isValidEmailAddress(req.from) || req.to.length === 0 || !req.to.every(isValidEmailAddress)) return fail('invalid_address', 'An e-mail address is not valid', false);
  if (req.to.length > EMAIL_LIMITS.maxRecipients) return fail('invalid_address', `At most ${EMAIL_LIMITS.maxRecipients} recipients are allowed`, false);
  if (req.security === 'none' && !dev) return fail('smtp_tls_required', 'Unencrypted SMTP is only permitted in development', false);
  let target: { addresses: string[] };
  try { target = await checkSmtpTarget(req.host, req.port, opts.policy); } catch (e) {
    if (e instanceof WebhookUrlError) return fail(e.code, e.message, e.code === 'dns_failure');
    return fail('connection_failed', 'The target could not be validated', true);
  }
  const hostname = req.host.replace(/^\[|\]$/g, '');
  const servername = isIP(hostname) ? undefined : hostname;
  const lookup = pinnedLookup(target.addresses);
  const connectMs = opts.connectTimeoutMs ?? SMTP_LIMITS.connectTimeoutMs;
  const totalMs = opts.totalTimeoutMs ?? SMTP_LIMITS.totalTimeoutMs;
  const tlsOpts = { rejectUnauthorized: true, ...(servername ? { servername } : {}), ...(opts.tlsCa ? { ca: opts.tlsCa } : {}) };
  let sock: net.Socket | null = null;
  let timer: NodeJS.Timeout | undefined;

  const run = async (): Promise<WebhookResult> => {
    // ---- connect (pinned to the validated addresses)
    const s: net.Socket = req.security === 'tls' ? tls.connect({ host: hostname, port: req.port, lookup, ...tlsOpts }) : net.connect({ host: hostname, port: req.port, lookup });
    sock = s;
    s.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), connectMs);
      s.once(req.security === 'tls' ? 'secureConnect' : 'connect', () => { clearTimeout(t); resolve(); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    let reader = makeReader(s);
    let current: net.Socket = s;
    const send = (line: string) => {
      if (/[\r\n\0]/.test(line)) throw new SmtpFailure(fail('invalid_address', 'A command contained a control character', false)); // header/command injection backstop
      current.write(`${line}\r\n`);
    };
    const expect = async (step: Parameters<typeof classify>[0], ok: number[]): Promise<Reply> => {
      const r = await reader.read();
      if (!ok.includes(r.code)) throw new SmtpFailure(classify(step, r.code));
      return r;
    };
    const cmd = (step: Parameters<typeof classify>[0], line: string, ok: number[]) => { send(line); return expect(step, ok); };

    await expect('greeting', [220]);
    const localName = (req.localName ?? 'nexus-alerting').replace(/[^A-Za-z0-9.-]/g, '') || 'nexus-alerting';
    const caps = (r: Reply) => new Set(r.lines.slice(1).map((l) => l.toUpperCase()));
    let capSet = caps(await cmd('ehlo', `EHLO ${localName}`, [250]));

    if (req.security === 'starttls') {
      if (!capSet.has('STARTTLS')) throw new SmtpFailure(fail('smtp_tls_required', 'The SMTP server does not offer STARTTLS; refusing to send unencrypted', false));
      await cmd('starttls', 'STARTTLS', [220]);
      if (reader.pending()) throw new SmtpFailure(fail('smtp_protocol_error', 'The SMTP server sent data before the TLS handshake', false));
      reader.detach();
      s.on('error', () => undefined); // later errors surface through the TLS socket; the raw socket must not throw unhandled
      const upgraded = tls.connect({ socket: s, ...tlsOpts });
      await new Promise<void>((resolve, reject) => { upgraded.once('secureConnect', resolve); upgraded.once('error', reject); });
      sock = upgraded; current = upgraded; reader = makeReader(upgraded);
      capSet = caps(await cmd('ehlo', `EHLO ${localName}`, [250]));
    }

    if (req.username !== undefined && req.password !== undefined) {
      if (req.security === 'none' && !dev) throw new SmtpFailure(fail('smtp_tls_required', 'Credentials are never sent over an unencrypted connection', false));
      const mech = [...capSet].find((l) => l.startsWith('AUTH '))?.slice(5).split(/\s+/) ?? [];
      if (mech.includes('PLAIN')) {
        await cmd('auth', `AUTH PLAIN ${b64(`\0${req.username}\0${req.password}`)}`, [235]);
      } else if (mech.includes('LOGIN')) {
        await cmd('auth', 'AUTH LOGIN', [334]);
        await cmd('auth', b64(req.username), [334]);
        await cmd('auth', b64(req.password), [235]);
      } else throw new SmtpFailure(fail('smtp_auth_failed', 'The SMTP server offers no supported authentication method (PLAIN or LOGIN)', false));
    }

    await cmd('mail', `MAIL FROM:<${req.from}>`, [250]);
    let accepted = 0, temporary = 0;
    for (const to of req.to) {
      send(`RCPT TO:<${to}>`);
      const r = await reader.read();
      if (r.code === 250 || r.code === 251) accepted++; else if (r.code >= 400 && r.code < 500) temporary++;
    }
    if (accepted === 0) throw new SmtpFailure(temporary > 0 ? fail('smtp_temporary_failure', 'The SMTP server temporarily refused every recipient', true) : fail('recipients_rejected', 'The SMTP server rejected every recipient', false));
    await cmd('data', 'DATA', [354]);
    current.write(dotStuff(req.message));
    await expect('body', [250]);
    try { current.write('QUIT\r\n'); } catch { /* best effort */ }
    const refused = req.to.length - accepted;
    return { ok: true, httpStatus: null, code: null, message: `Delivered (accepted by the SMTP server${refused ? `; ${refused} of ${req.to.length} recipients were refused` : ''})`, retryable: false };
  };

  const toResult = (e: unknown): WebhookResult => {
    if (e instanceof SmtpFailure) return e.result;
    const code = (e as NodeJS.ErrnoException)?.code ?? '';
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|ERR_TLS|ERR_SSL|EPROTO|DEPTH_ZERO/i.test(code) || /certificate|handshake|ssl|tls/i.test((e as Error)?.message ?? '')) return fail('tls_error', `TLS problem while talking to the SMTP server${code ? ` (${code})` : ''}`, false);
    if (code === 'ETIMEDOUT') return fail('timeout', 'The SMTP connection timed out', true);
    return fail('connection_failed', `SMTP connection failed${code ? ` (${code})` : ''}`, true);
  };

  return new Promise<WebhookResult>((resolve) => {
    let settled = false;
    const done = (r: WebhookResult) => {
      if (settled) return; settled = true; if (timer) clearTimeout(timer);
      const s = sock as net.Socket | null;
      try {
        if (r.ok && s) { s.end(); setTimeout(() => s.destroy(), 500).unref(); } else s?.destroy(); // on success let QUIT flush
      } catch { /* ignore */ }
      resolve(r);
    };
    timer = setTimeout(() => done(fail('timeout', `The SMTP server did not finish within ${Math.round(totalMs / 1000)} seconds`, true)), totalMs);
    run().then(done, (e) => done(toResult(e)));
  });
};
