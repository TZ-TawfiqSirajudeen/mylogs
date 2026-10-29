import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

/**
 * Outbound-target validation (SSRF defence). Every connector must call `resolveSafeTarget` before opening a socket,
 * on every run — never trust a target that was validated at save time.
 */
export interface NetworkPolicy {
  /** Dev/test only. Allows 127.0.0.0/8 and ::1. Config refuses this in production. */
  allowLoopback: boolean;
  /** Explicitly approved private ranges (approved network paths). Cloud-metadata addresses stay denied regardless. */
  allowPrivateCidrs: string[];
  /** Allow plain http:// targets (HTTP connector). Default false. */
  allowInsecureHttp: boolean;
  /** Injectable for tests. Must return every address for the name. */
  resolver?: (host: string) => Promise<string[]>;
}

export const STRICT_POLICY: NetworkPolicy = { allowLoopback: false, allowPrivateCidrs: [], allowInsecureHttp: false };

export type TargetRejection = 'invalid_host' | 'dns_failure' | 'blocked_address' | 'blocked_port';

export class TargetRejectedError extends Error {
  constructor(readonly code: TargetRejection, message: string) {
    super(message);
    this.name = 'TargetRejectedError';
  }
}

// Addresses that must never be reachable, even through an allow-listed CIDR.
const HARD_DENY = new BlockList();
HARD_DENY.addAddress('169.254.169.254', 'ipv4'); // AWS/Azure/GCP/OpenStack IMDS
HARD_DENY.addAddress('169.254.170.2', 'ipv4'); // ECS task metadata
HARD_DENY.addAddress('100.100.100.200', 'ipv4'); // Alibaba
HARD_DENY.addAddress('168.63.129.16', 'ipv4'); // Azure wireserver
HARD_DENY.addAddress('fd00:ec2::254', 'ipv6'); // AWS IMDS over IPv6
HARD_DENY.addSubnet('169.254.0.0', 16, 'ipv4'); // all IPv4 link-local
HARD_DENY.addSubnet('fe80::', 10, 'ipv6');
HARD_DENY.addSubnet('0.0.0.0', 8, 'ipv4');
HARD_DENY.addAddress('::', 'ipv6');
HARD_DENY.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
HARD_DENY.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved + broadcast
HARD_DENY.addSubnet('ff00::', 8, 'ipv6');

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

// Non-global ranges: denied unless an approved CIDR covers the address.
const NON_PUBLIC = new BlockList();
for (const [a, p] of [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
] as const) NON_PUBLIC.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['fc00::', 7], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['2001::', 32], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
] as const) NON_PUBLIC.addSubnet(a, p, 'ipv6');

const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'kubernetes.default']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.cluster.local'];

// Mail, remote-access, directory, SMB, RPC and similar services: never a legitimate telemetry target.
const BLOCKED_PORTS = new Set([
  7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113,
  115, 117, 119, 123, 135, 137, 138, 139, 143, 161, 179, 389, 427, 445, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1723, 2049, 3306, 3389, 5432, 5900, 6000, 6666, 6667,
]);
// 3306/5432 are blocked for the generic HTTP path only; DB connectors pass their own explicit port allowance.

/** Unmaps `::ffff:a.b.c.d` so v4 rules apply. Returns the address to classify and its family. */
function normalize(ip: string): { ip: string; family: 'ipv4' | 'ipv6' } {
  const lower = ip.toLowerCase().split('%')[0]!; // drop zone id
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped) return { ip: mapped[1]!, family: 'ipv4' };
  // ::ffff:7f00:1 (hex form of a mapped address)
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return { ip: `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, family: 'ipv4' };
  }
  return { ip: lower, family: isIP(lower) === 6 ? 'ipv6' : 'ipv4' };
}

function approvedPrivate(policy: NetworkPolicy): BlockList {
  const list = new BlockList();
  for (const cidr of policy.allowPrivateCidrs) {
    const [addr, bits] = cidr.split('/');
    const fam = isIP(addr ?? '');
    if (!addr || !bits || !fam || !/^\d+$/.test(bits)) throw new Error(`Invalid CIDR in network policy: ${cidr}`);
    list.addSubnet(addr, Number(bits), fam === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

export type AddressClass = 'public' | 'loopback' | 'private' | 'denied';

export function classifyAddress(raw: string, policy: NetworkPolicy = STRICT_POLICY): { allowed: boolean; class: AddressClass } {
  const { ip, family } = normalize(raw);
  if (!isIP(ip)) return { allowed: false, class: 'denied' };
  if (HARD_DENY.check(ip, family)) return { allowed: false, class: 'denied' };
  if (LOOPBACK.check(ip, family)) return { allowed: policy.allowLoopback, class: 'loopback' };
  if (NON_PUBLIC.check(ip, family)) {
    return { allowed: policy.allowPrivateCidrs.length > 0 && approvedPrivate(policy).check(ip, family), class: 'private' };
  }
  return { allowed: true, class: 'public' };
}

export function isBlockedPort(port: number): boolean {
  return BLOCKED_PORTS.has(port);
}

export interface SafeTarget {
  host: string;
  port: number;
  /** Validated addresses; connect to one of these, not to the name. */
  addresses: string[];
}

export interface ResolveOptions {
  /** Ports a DB connector legitimately needs even though the generic list blocks them (e.g. 5432). */
  allowPorts?: number[];
}

const NUMERIC_SHORTHAND = /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*\.?$/i;

export async function resolveSafeTarget(
  rawHost: string, port: number, policy: NetworkPolicy = STRICT_POLICY, opts: ResolveOptions = {},
): Promise<SafeTarget> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TargetRejectedError('blocked_port', `Invalid port ${port}`);
  if (isBlockedPort(port) && !opts.allowPorts?.includes(port)) {
    throw new TargetRejectedError('blocked_port', `Port ${port} is not allowed as a connection target`);
  }
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '');
  if (!host || host.length > 253 || /[\s/@\\?#%]/.test(host.replace(/%.*$/, ''))) {
    throw new TargetRejectedError('invalid_host', 'Host is not a valid hostname or IP address');
  }

  const literal = isIP(host);
  if (!literal) {
    // inet_aton shorthand ("2130706433", "0x7f.1", "127.1") would be resolved by getaddrinfo as an IPv4 literal.
    if (NUMERIC_SHORTHAND.test(host)) throw new TargetRejectedError('invalid_host', 'Numeric host shorthand is not allowed; use a dotted-quad address or a DNS name');
    if (!/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/.test(host)) {
      throw new TargetRejectedError('invalid_host', 'Host is not a valid hostname');
    }
    const blockedName = BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s));
    if (blockedName && !isAllowedInternalName(host, policy)) {
      throw new TargetRejectedError('blocked_address', `Host "${host}" is reserved for internal use`);
    }
  }

  let addresses: string[];
  if (literal) addresses = [host];
  else {
    try {
      addresses = policy.resolver
        ? await policy.resolver(host)
        : (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new TargetRejectedError('dns_failure', `Could not resolve "${host}"`);
    }
    if (addresses.length === 0) throw new TargetRejectedError('dns_failure', `No addresses for "${host}"`);
  }

  // Every resolved address must be acceptable: a single internal record is enough to reject (mixed-answer rebinding).
  for (const a of addresses) {
    if (!classifyAddress(a, policy).allowed) {
      throw new TargetRejectedError('blocked_address', `"${host}" resolves to an address that is not permitted`);
    }
  }
  return { host, port, addresses };
}

// Internal DNS names (".internal", ".local", ...) are only allowed when the operator approved private CIDRs; the
// resolved addresses are still validated against those CIDRs afterwards. "localhost" is never allowed by name unless loopback is.
function isAllowedInternalName(host: string, policy: NetworkPolicy): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return policy.allowLoopback;
  if (host === 'metadata.google.internal' || host === 'metadata' || host === 'instance-data') return false;
  return policy.allowPrivateCidrs.length > 0;
}

/** `lookup` for net/tls/http that can only ever return the already-validated addresses (defeats DNS rebinding). */
export function pinnedLookup(addresses: string[]): LookupFunction {
  return ((_hostname: string, options: { all?: boolean; family?: number }, cb: (...a: unknown[]) => void) => {
    const pool = addresses.filter((a) => !options?.family || (options.family === 6) === (isIP(a) === 6));
    const list = pool.length ? pool : addresses;
    if (options?.all) cb(null, list.map((address) => ({ address, family: isIP(address) })));
    else cb(null, list[0], isIP(list[0]!));
  }) as unknown as LookupFunction;
}
