import type { ConnectorDescriptor } from '@nexus/connector-sdk';

/**
 * Sources that PUSH telemetry to the platform. They are implemented (log ingestion works and is tested), but there is nothing to
 * "connect": a project admin creates an ingestion token (Data Sources -> Ingestion) and points a sender at it.
 */
const token = { id: 'ingest-token', label: 'Ingestion token (per environment)', recommended: true, description: 'Bearer token created in Data Sources → Ingestion. Shown once; only a hash is stored.', secretFields: [] };

export const PUSH_CONNECTORS: ConnectorDescriptor[] = [
  {
    type: 'otlp', displayName: 'OpenTelemetry (OTLP/HTTP) logs', category: 'application', status: 'implemented', mode: 'push', collection: 'implemented',
    signals: [
      { signal: 'logs', availability: 'supported', note: 'POST /v1/logs — protobuf or JSON, gzip/deflate/brotli. Verified with the OpenTelemetry JS SDK exporters.' },
      { signal: 'traces', availability: 'supported', note: 'POST /v1/traces — protobuf or JSON, gzip. Needs a token with the traces scope. Verified with the OpenTelemetry JS SDK exporters and a real Collector.' },
      { signal: 'metrics', availability: 'supported', note: 'POST /v1/metrics — gauge, sum and explicit-bucket histogram (exponential histograms and summaries are rejected and counted). Needs a token with the metrics scope.' },
      { signal: 'events', availability: 'unsupported' }, { signal: 'inventory', availability: 'unsupported' },
    ],
    deploymentTypes: ['any OpenTelemetry SDK', 'OpenTelemetry Collector (otlphttp exporter)'],
    authMethods: [token],
    requiredPermissions: [{ scope: 'platform', permission: 'Project admin to create the token', why: 'Tokens are bound to one environment and are the only credential senders need.' }],
    operations: ['POST /v1/logs', 'POST /v1/traces', 'POST /v1/metrics'],
    configRequirements: ['Ingestion service reachable from the sender (default port 4318)', 'OTEL_EXPORTER_OTLP_ENDPOINT + OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf + Authorization header'],
    limitations: [
      'Tokens created before traces and metrics existed carry the logs scope only: create a new token to send other signals', 'OTLP/gRPC is not supported (HTTP only); send gRPC to an OpenTelemetry Collector that exports with otlphttp', '4 MiB body, 5 000 records per request, 32 KiB per message',
      'Verified live with the OTel JS SDK and a real otelcol-contrib v0.164.0 (see docs/runbooks/collector.md); Docker images and a real identity provider are unverified',
    ],
  },
  {
    type: 'json-logs', displayName: 'Generic JSON / NDJSON logs', category: 'application', status: 'implemented', mode: 'push', collection: 'implemented',
    signals: [{ signal: 'logs', availability: 'supported', note: 'POST /v1/json-logs — array, wrapper object, single object or NDJSON; pino/winston/ECS field names recognised' },
      { signal: 'traces', availability: 'unsupported' }, { signal: 'metrics', availability: 'unsupported' }, { signal: 'events', availability: 'unsupported' }, { signal: 'inventory', availability: 'unsupported' }],
    deploymentTypes: ['any application or log shipper that can POST JSON'], authMethods: [token],
    requiredPermissions: [{ scope: 'platform', permission: 'Project admin to create the token', why: 'Same per-environment token as OTLP.' }],
    operations: ['POST /v1/json-logs'], configRequirements: ['A JSON body; one object per log record'],
    limitations: ['Field mapping is by convention: unknown field names are kept as attributes, not interpreted', 'Syslog and file shippers need a collector in front (planned connectors)'],
  },
];
