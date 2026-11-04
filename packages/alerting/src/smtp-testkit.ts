import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

/**
 * Test-only: a tiny in-process SMTP server (not exported from the package index). It speaks just enough of RFC 5321 to exercise the client:
 * EHLO, STARTTLS (self-signed certificate generated at test time with the openssl CLI), implicit TLS, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT,
 * and scripted misbehaviour (rejections, temporary failures, silence, plaintext injection after STARTTLS, oversized lines).
 */
export interface FakeSmtpOptions {
  /** Implicit TLS (port-465 style). Needs `cert`. */
  implicitTls?: boolean;
  /** Advertise STARTTLS (needs `cert`). */
  starttls?: boolean;
  cert?: { key: string; cert: string };
  /** Advertised AUTH mechanisms (empty = none). */
  auth?: ('PLAIN' | 'LOGIN')[];
  credentials?: { user: string; pass: string };
  /** Advertise AUTH only after TLS (as real servers do). Default true. */
  authOnlyOverTls?: boolean;
  /** Reply code for a recipient (null = accept). */
  rcpt?: (addr: string) => number | null;
  mailCode?: number;
  dataCode?: number;
  greetingCode?: number;
  /** Never answer after connecting. */
  silent?: boolean;
  /** Send an extra reply in the same TCP segment as the STARTTLS "220" (a plaintext-injection attack). */
  injectAfterStartTls?: boolean;
  /** Answer EHLO with a single line longer than any sane limit. */
  hugeLine?: boolean;
}
export interface SmtpMessage { from: string; to: string[]; data: string; secure: boolean; authenticated: boolean }
export interface FakeSmtp {
  port: number; messages: SmtpMessage[]; commands: string[]; authAttempts: { mech: string; user: string; pass: string }[];
  connections: number; tlsUpgrades: number; close(): Promise<void>;
}

export function makeSelfSignedCert(): { key: string; cert: string } | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexus-smtp-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2',
      '-subj', '/CN=smtp.example.com', '-addext', 'subjectAltName=DNS:smtp.example.com,DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    return { key: readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: readFileSync(path.join(dir, 'c.pem'), 'utf8') };
  } catch { return null; } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function startFakeSmtp(o: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const messages: SmtpMessage[] = [], commands: string[] = [], authAttempts: FakeSmtp['authAttempts'] = [];
  const state = { connections: 0, tlsUpgrades: 0 };
  const sockets = new Set<net.Socket>();
  const ctx = o.cert ? tls.createSecureContext(o.cert) : undefined;

  const handle = (raw: net.Socket, secure0: boolean) => {
    state.connections++;
    sockets.add(raw); raw.on('close', () => sockets.delete(raw)); raw.on('error', () => undefined);
    let cur: net.Socket = raw;
    let secure = secure0;
    let buf = '';
    let mode: 'cmd' | 'data' | 'login-user' | 'login-pass' = 'cmd';
    let from = '', to: string[] = [], data = '', loginUser = '', authenticated = false;
    const say = (s: string) => { if (!cur.destroyed) cur.write(s); };
    const attach = (s: net.Socket) => { cur = s; s.on('data', onData); s.on('error', () => undefined); };
    const checkCreds = (mech: string, user: string, pass: string) => {
      authAttempts.push({ mech, user, pass });
      const ok = !!o.credentials && user === o.credentials.user && pass === o.credentials.pass;
      authenticated = ok; say(ok ? '235 2.7.0 Authentication successful\r\n' : '535 5.7.8 Authentication credentials invalid\r\n');
    };
    const line = (l: string) => {
      if (mode === 'data') {
        if (l === '.') { messages.push({ from, to, data, secure, authenticated }); mode = 'cmd'; data = ''; say(`${o.dataCode ?? 250} ${(o.dataCode ?? 250) < 400 ? '2.0.0 queued' : 'refused'}\r\n`); return; }
        data += `${l.startsWith('.') ? l.slice(1) : l}\r\n`; return;
      }
      if (mode === 'login-user') { loginUser = Buffer.from(l, 'base64').toString('utf8'); mode = 'login-pass'; say('334 UGFzc3dvcmQ6\r\n'); return; }
      if (mode === 'login-pass') { mode = 'cmd'; checkCreds('LOGIN', loginUser, Buffer.from(l, 'base64').toString('utf8')); return; }
      commands.push(l.toUpperCase().startsWith('AUTH ') ? `${l.split(' ')[0]} ${l.split(' ')[1]} <redacted>` : l);
      const up = l.toUpperCase();
      if (up.startsWith('EHLO') || up.startsWith('HELO')) {
        if (o.hugeLine) { say(`250 ${'x'.repeat(5000)}\r\n`); return; }
        const caps = ['localhost greets you', 'SIZE 1048576'];
        if (o.starttls && !secure) caps.push('STARTTLS');
        if (o.auth?.length && (secure || o.authOnlyOverTls === false)) caps.push(`AUTH ${o.auth.join(' ')}`);
        caps.push('8BITMIME');
        say(caps.map((c, i) => `250${i === caps.length - 1 ? ' ' : '-'}${c}\r\n`).join('')); return;
      }
      if (up === 'STARTTLS') {
        if (!ctx) { say('502 not supported\r\n'); return; }
        say(`220 2.0.0 Ready to start TLS\r\n${o.injectAfterStartTls ? '250 injected-before-handshake\r\n' : ''}`);
        cur.removeAllListeners('data');
        const t = new tls.TLSSocket(raw, { isServer: true, secureContext: ctx });
        state.tlsUpgrades++; secure = true; buf = ''; attach(t); return;
      }
      if (up.startsWith('AUTH PLAIN')) {
        const parts = Buffer.from(l.split(/\s+/)[2] ?? '', 'base64').toString('utf8').split('\0');
        checkCreds('PLAIN', parts[1] ?? '', parts[2] ?? ''); return;
      }
      if (up === 'AUTH LOGIN') { mode = 'login-user'; say('334 VXNlcm5hbWU6\r\n'); return; }
      if (up.startsWith('MAIL FROM:')) { from = /<([^>]*)>/.exec(l)?.[1] ?? ''; to = []; if (o.mailCode && o.mailCode >= 400) { say(`${o.mailCode} mail refused\r\n`); return; } say('250 2.1.0 Ok\r\n'); return; }
      if (up.startsWith('RCPT TO:')) {
        const addr = /<([^>]*)>/.exec(l)?.[1] ?? '';
        const code = o.rcpt?.(addr) ?? null;
        if (code && code >= 400) { say(`${code} recipient refused\r\n`); return; }
        to.push(addr); say('250 2.1.5 Ok\r\n'); return;
      }
      if (up === 'DATA') { mode = 'data'; say('354 End data with <CR><LF>.<CR><LF>\r\n'); return; }
      if (up === 'QUIT') { say('221 2.0.0 Bye\r\n'); cur.end(); return; }
      say('502 5.5.2 Command not recognized\r\n');
    };
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); line(l); }
    };
    attach(raw);
    if (!o.silent) say(`${o.greetingCode ?? 220} localhost ESMTP fake\r\n`);
  };

  const server = o.implicitTls && ctx
    ? tls.createServer({ key: o.cert!.key, cert: o.cert!.cert }, (s) => handle(s as unknown as net.Socket, true))
    : net.createServer((s) => handle(s, false));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, messages, commands, authAttempts,
    get connections() { return state.connections; }, get tlsUpgrades() { return state.tlsUpgrades; },
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
