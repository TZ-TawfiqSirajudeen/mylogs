import type { NetworkPolicy } from './ssrf.js';

export interface NetworkEnv {
  NETWORK_ALLOW_LOOPBACK?: string | undefined;
  NETWORK_ALLOW_PRIVATE_CIDRS?: string | undefined;
  NETWORK_ALLOW_INSECURE_HTTP?: string | undefined;
}

const truthy = (v: string | undefined) => v === 'true';

/**
 * The one place the outbound-network policy is read from the environment (API and workers share it).
 * Production refuses loopback egress; private ranges are allowed only when an operator lists them explicitly.
 */
export function parseNetworkPolicy(env: NetworkEnv, production: boolean): NetworkPolicy {
  const cidrs = (env.NETWORK_ALLOW_PRIVATE_CIDRS ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  for (const c of cidrs) {
    if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(c)) throw new Error('Invalid configuration: NETWORK_ALLOW_PRIVATE_CIDRS');
  }
  const allowLoopback = truthy(env.NETWORK_ALLOW_LOOPBACK);
  if (production && allowLoopback) throw new Error('Refusing insecure production configuration: NETWORK_ALLOW_LOOPBACK is for development only');
  return { allowLoopback, allowPrivateCidrs: cidrs, allowInsecureHttp: truthy(env.NETWORK_ALLOW_INSECURE_HTTP) };
}
