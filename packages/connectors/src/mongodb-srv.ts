import dns from 'node:dns/promises';

/**
 * Expands a `mongodb+srv://` seed name into the members it points to, the way MongoDB drivers do (SRV for the members, TXT for
 * `authSource` / `replicaSet`). Used only to help people fill in the connection form; the monitoring connector itself still
 * connects to each listed member and re-validates every address against the network policy on every run.
 *
 * Rules from the MongoDB "Initial DNS Seedlist Discovery" specification that protect against a poisoned or hostile answer:
 * the seed needs at least three labels; every SRV target must sit below the seed's parent domain; TXT records may only carry
 * `authSource` and `replicaSet`; the result is capped at the connector's maximum of 7 members.
 */
export interface SrvResolver {
  resolveSrv(name: string): Promise<{ name: string; port: number }[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

export interface SrvResolution {
  hosts: { host: string; port: number }[];
  authSource: string | null;
  replicaSet: string | null;
  /** True when the DNS answer listed more members than can be monitored in one connection. */
  truncated: boolean;
}

export class SrvError extends Error {}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
export const MAX_SRV_HOSTS = 7;

export async function resolveMongoSrv(seed: string, resolver: SrvResolver = dns, timeoutMs = 5_000): Promise<SrvResolution> {
  const host = seed.trim().toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 3 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1]!)) {
    throw new SrvError('Enter a DNS name with at least three parts, like cluster0.abcde.mongodb.net.');
  }
  const parent = labels.slice(1).join('.');
  const bounded = <T>(p: Promise<T>): Promise<T> => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new SrvError('The DNS lookup timed out.')), timeoutMs).unref())]);

  let records: { name: string; port: number }[];
  try { records = await bounded(resolver.resolveSrv(`_mongodb._tcp.${host}`)); } catch (e) {
    if (e instanceof SrvError) throw e;
    throw new SrvError('No MongoDB SRV record was found for that name. Check the spelling, or list the member hosts yourself.');
  }
  if (!records.length) throw new SrvError('The name has no MongoDB members.');

  const hosts: SrvResolution['hosts'] = [];
  for (const r of records) {
    const name = r.name.toLowerCase().replace(/\.$/, '');
    if (!name.endsWith(`.${parent}`) && name !== parent) throw new SrvError('The DNS answer points outside the cluster\'s own domain; refusing it.');
    if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) throw new SrvError('The DNS answer contains an invalid port.');
    if (!hosts.some((h) => h.host === name && h.port === r.port)) hosts.push({ host: name, port: r.port });
  }
  hosts.sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port);

  let authSource: string | null = null, replicaSet: string | null = null;
  try {
    const txt = (await bounded(resolver.resolveTxt(host))).map((parts) => parts.join(''));
    if (txt.length === 1) {
      for (const pair of txt[0]!.split('&')) {
        const [k, v = ''] = pair.split('=');
        if (k === 'authSource' && /^[A-Za-z0-9_.$-]{1,64}$/.test(v)) authSource = v;
        else if (k === 'replicaSet' && /^[A-Za-z0-9_.-]{1,128}$/.test(v)) replicaSet = v;
      }
    }
  } catch { /* TXT is optional */ }

  return { hosts: hosts.slice(0, MAX_SRV_HOSTS), authSource, replicaSet, truncated: hosts.length > MAX_SRV_HOSTS };
}
