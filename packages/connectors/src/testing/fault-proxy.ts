import net from 'node:net';

/**
 * A TCP proxy for failure injection in tests (works for MongoDB and Redis alike; it never looks inside the stream).
 *  - pass:      forward bytes both ways;
 *  - blackhole: keep every connection open but forward nothing (a firewall that drops packets, a hung server);
 *  - delay:     hold server -> client bytes for `delayMs` (a slow command);
 *  - reset:     destroy all current sockets and refuse new ones (connection reset / server gone).
 * `cutAfterServerBytes` closes the client socket after that many server -> client bytes (a reset in the middle of a conversation).
 */
export type ProxyMode = 'pass' | 'blackhole' | 'delay' | 'reset';

export class FaultProxy {
  mode: ProxyMode = 'pass';
  delayMs = 0;
  cutAfterServerBytes: number | null = null;
  /** Per connection: after this many server -> client bytes the server goes silent but the socket stays open (a command that hangs mid-conversation). */
  muteAfterServerBytes: number | null = null;
  accepted = 0;
  private readonly sockets = new Set<net.Socket>();
  private server: net.Server;
  port = 0;

  private constructor(private readonly targetPort: number) {
    this.server = net.createServer((client) => this.onClient(client));
  }

  static async start(targetPort: number): Promise<FaultProxy> {
    const p = new FaultProxy(targetPort);
    await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r));
    p.port = (p.server.address() as net.AddressInfo).port;
    return p;
  }

  private onClient(client: net.Socket) {
    this.accepted++;
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => undefined);
    if (this.mode === 'reset') { client.destroy(); return; }
    const upstream = net.connect(this.targetPort, '127.0.0.1');
    this.sockets.add(upstream);
    upstream.on('close', () => { this.sockets.delete(upstream); client.destroy(); });
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    let fromServer = 0;
    let muted = false;
    client.on('data', (d: Buffer) => { if (this.mode !== 'blackhole' && this.mode !== 'reset') upstream.write(d); });
    upstream.on('data', (d: Buffer) => {
      if (this.mode === 'blackhole' || this.mode === 'reset' || muted) return;
      if (this.muteAfterServerBytes !== null && fromServer + d.length > this.muteAfterServerBytes) {
        muted = true;
        const part = d.subarray(0, Math.max(0, this.muteAfterServerBytes - fromServer));
        if (part.length) client.write(part);
        return;
      }
      const send = () => {
        if (this.cutAfterServerBytes !== null && fromServer + d.length > this.cutAfterServerBytes) {
          client.write(d.subarray(0, Math.max(0, this.cutAfterServerBytes - fromServer)), () => client.destroy());
          return;
        }
        fromServer += d.length;
        client.write(d);
      };
      if (this.mode === 'delay' && this.delayMs > 0) setTimeout(send, this.delayMs); else send();
    });
  }

  /** Drops every live connection (the listener stays up). */
  dropAll() { for (const s of this.sockets) s.destroy(); this.sockets.clear(); }

  async stop() {
    this.dropAll();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** A port nothing listens on (connection refused) — found by binding and releasing. */
export async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}

/** A server that accepts connections and never answers (for "silent target" tests). */
export async function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((s) => { sockets.add(s); s.on('error', () => undefined); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as net.AddressInfo).port, close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => srv.close(() => r())); } };
}
