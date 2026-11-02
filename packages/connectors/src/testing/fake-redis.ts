import net from 'node:net';

/**
 * A minimal RESP server for behaviours a real Redis 5 cannot show (ACL denials, which need Redis 6+; absurdly large replies).
 * It speaks only what ioredis needs (arrays of bulk strings in, raw RESP out), and it is explicitly a fake: tests that use it say so.
 */
export type FakeHandler = (args: string[]) => string | Uint8Array | null | 'close';

export async function fakeRedis(handler: FakeHandler): Promise<{ port: number; commands: string[][]; close: () => Promise<void> }> {
  const commands: string[][] = [];
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d as Uint8Array]);
      for (;;) {
        const parsed = parseCommand(buf);
        if (!parsed) return;
        buf = buf.subarray(parsed.used);
        commands.push(parsed.args);
        // what ioredis sends first, answered like Redis 5 does (RESP3 HELLO unknown; client bookkeeping accepted)
        const first = parsed.args[0]!.toLowerCase();
        const reply = first === 'hello' ? "-ERR unknown command 'hello', with args beginning with: '3', \r\n" : first === 'client' ? '+OK\r\n' : handler(parsed.args);
        if (reply === 'close') { sock.destroy(); return; }
        if (reply !== null) sock.write(reply);
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: (srv.address() as net.AddressInfo).port, commands,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => srv.close(() => r())); },
  };
}

function parseCommand(buf: Buffer): { args: string[]; used: number } | null {
  if (buf[0] !== 0x2a) { // inline command
    const i = buf.indexOf('\r\n');
    return i < 0 ? null : { args: buf.subarray(0, i).toString().split(' '), used: i + 2 };
  }
  let pos = buf.indexOf('\r\n');
  if (pos < 0) return null;
  const n = Number(buf.subarray(1, pos).toString());
  pos += 2;
  const args: string[] = [];
  for (let k = 0; k < n; k++) {
    const e = buf.indexOf('\r\n', pos);
    if (e < 0) return null;
    const len = Number(buf.subarray(pos + 1, e).toString());
    if (buf.length < e + 2 + len + 2) return null;
    args.push(buf.subarray(e + 2, e + 2 + len).toString());
    pos = e + 2 + len + 2;
  }
  return { args, used: pos };
}

export const bulk = (s: string) => `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
export const ok = '+OK\r\n';
export const pong = '+PONG\r\n';
export const err = (m: string) => `-${m}\r\n`;
