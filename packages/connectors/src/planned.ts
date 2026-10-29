import type { AuthMethod, ConnectorDescriptor, Signal, SignalAvailability } from '@nexus/connector-sdk';

/**
 * Connectors that are NOT implemented. They appear in the capability matrix with status "planned" so users see the
 * roadmap, but they cannot be connected: the registry exposes no runnable connector for them.
 */
const sigs = (m: Partial<Record<Signal, SignalAvailability>>) =>
  (['logs', 'metrics', 'traces', 'events', 'inventory'] as const).map((signal) => ({ signal, availability: m[signal] ?? 'unsupported' }));

const auth = (id: string, label: string, description: string, recommended = true): AuthMethod => ({ id, label, recommended, description, secretFields: [] });

const planned = (d: Pick<ConnectorDescriptor, 'type' | 'displayName' | 'category'> & Partial<ConnectorDescriptor> & { phase: number }): ConnectorDescriptor => {
  const { phase, ...rest } = d;
  return {
    status: 'planned', collection: 'not_implemented', signals: [], deploymentTypes: [], authMethods: [], requiredPermissions: [],
    operations: [], configRequirements: [], limitations: [`Not implemented (planned for phase ${phase}). Cannot be connected yet.`], ...rest,
  };
};

export const PLANNED_CONNECTORS: ConnectorDescriptor[] = [
  planned({
    type: 'aws-cloudwatch', displayName: 'AWS CloudWatch (logs + metrics) and resource discovery', category: 'cloud', phase: 5,
    signals: sigs({ logs: 'planned', metrics: 'planned', inventory: 'planned' }), deploymentTypes: ['AWS accounts (cross-account role)'],
    authMethods: [auth('iam-role', 'Cross-account IAM role + external ID', 'Preferred: no long-lived keys.'), auth('access-key', 'Access key (discouraged)', 'Only when roles are impossible.', false)],
    requiredPermissions: [{ scope: 'AWS', permission: 'cloudwatch:GetMetricData, cloudwatch:ListMetrics, logs:FilterLogEvents, logs:DescribeLogGroups, tag:GetResources', why: 'Read-only monitoring' }],
  }),
  planned({
    type: 'azure-monitor', displayName: 'Azure Monitor and Application Insights', category: 'cloud', phase: 5,
    signals: sigs({ logs: 'planned', metrics: 'planned', traces: 'planned', inventory: 'planned' }), deploymentTypes: ['Azure subscriptions'],
    authMethods: [auth('managed-identity', 'Managed identity', 'Preferred.'), auth('service-principal', 'Application identity (client secret/certificate)', 'Scoped Monitoring Reader.', false)],
    requiredPermissions: [{ scope: 'Azure', permission: 'Monitoring Reader / Log Analytics Reader', why: 'Read-only monitoring' }],
  }),
  planned({
    type: 'gcp-logging', displayName: 'Google Cloud Logging and Monitoring', category: 'cloud', phase: 5,
    signals: sigs({ logs: 'planned', metrics: 'planned', inventory: 'planned' }), deploymentTypes: ['GCP projects'],
    authMethods: [auth('workload-identity', 'Workload identity federation', 'Preferred.')],
  }),
  planned({
    type: 'postgresql', displayName: 'PostgreSQL', category: 'database', phase: 5,
    signals: sigs({ metrics: 'planned', inventory: 'planned' }), deploymentTypes: ['self-managed', 'managed services'],
    authMethods: [auth('scram', 'Dedicated read-only role (pg_monitor)', 'Least privilege.')],
  }),
  planned({
    type: 'mysql', displayName: 'MySQL', category: 'database', phase: 5,
    signals: sigs({ metrics: 'planned', inventory: 'planned' }), deploymentTypes: ['self-managed', 'managed services'],
    authMethods: [auth('password', 'Dedicated monitoring user', 'PROCESS/REPLICATION CLIENT only.')],
  }),
  planned({
    type: 'docker', displayName: 'Docker containers', category: 'infrastructure', phase: 5,
    signals: sigs({ logs: 'planned', metrics: 'planned', inventory: 'planned', events: 'planned' }), deploymentTypes: ['hosts running the Nexus agent'],
    authMethods: [auth('agent', 'Customer-deployed agent (outbound connection)', 'No inbound access to hosts.')],
  }),
  planned({
    type: 'kubernetes', displayName: 'Kubernetes clusters', category: 'infrastructure', phase: 5,
    signals: sigs({ logs: 'planned', metrics: 'planned', inventory: 'planned', events: 'planned' }), deploymentTypes: ['clusters running the Nexus collector'],
    authMethods: [auth('service-account', 'Narrowly scoped service account', 'Read-only RBAC.')],
  }),
  planned({
    type: 'linux-host', displayName: 'Linux hosts', category: 'infrastructure', phase: 5,
    signals: sigs({ logs: 'planned', metrics: 'planned', inventory: 'planned' }), deploymentTypes: ['hosts running the Nexus agent'],
    authMethods: [auth('agent', 'Customer-deployed agent (outbound connection)', 'No remote shell execution.')],
  }),
  planned({
    type: 'windows-host', displayName: 'Windows hosts', category: 'infrastructure', phase: 5,
    signals: sigs({ logs: 'planned', metrics: 'planned', inventory: 'planned' }), deploymentTypes: ['hosts running the Nexus agent'],
    authMethods: [auth('agent', 'Customer-deployed agent (outbound connection)', 'No remote shell execution.')],
  }),
  planned({
    type: 'nginx-logs', displayName: 'Nginx access/error logs', category: 'application', phase: 3,
    signals: sigs({ logs: 'planned' }), deploymentTypes: ['via log-shipping agent'],
    authMethods: [auth('ingest-token', 'Authenticated ingestion token', 'Shipped through the collector.')],
  }),
  planned({
    type: 'syslog', displayName: 'Syslog / log shippers', category: 'application', phase: 3,
    signals: sigs({ logs: 'planned' }), deploymentTypes: ['via collector'],
    authMethods: [auth('ingest-token', 'Authenticated ingestion token', 'TLS syslog through the collector.')],
  }),
];
