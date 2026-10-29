import { ConnectorRegistry } from '@nexus/connector-sdk';
import { httpHealthConnector } from './http-health.js';
import { mongodbConnector } from './mongodb.js';
import { PLANNED_CONNECTORS } from './planned.js';
import { PUSH_CONNECTORS } from './push.js';
import { redisConnector } from './redis.js';

/** The registry used by the API and the worker. Implemented connectors are runnable; the rest are roadmap entries. */
export function createDefaultRegistry(): ConnectorRegistry {
  const r = new ConnectorRegistry().register(httpHealthConnector).register(mongodbConnector).register(redisConnector);
  for (const d of PUSH_CONNECTORS) r.registerPush(d);
  for (const d of PLANNED_CONNECTORS) r.registerPlanned(d);
  return r;
}
