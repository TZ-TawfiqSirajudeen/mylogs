import { Link } from 'react-router-dom';
import { useSelection } from '../session';
import { Badge, Card, EmptyState, ErrorState, Loading } from '../ui';

/**
 * Phase 1 overview. Every number here is derived from control-plane records (projects/environments).
 * Telemetry-derived tiles (requests, error rate, p95, …) are deliberately absent until ingestion exists —
 * showing zeros would be indistinguishable from "healthy".
 */
export default function Overview() {
  const { projects, projectsStatus, projectsError, refetchProjects } = useSelection();
  const envCount = projects.reduce((n, p) => n + p.environments.length, 0);
  const prodCount = projects.reduce((n, p) => n + p.environments.filter((e) => e.isProduction).length, 0);
  if (projectsStatus === 'pending') return <Loading />;
  if (projectsStatus === 'error') return <ErrorState error={projectsError} onRetry={refetchProjects} />;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Overview</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        {[['Projects', projects.length], ['Environments', envCount], ['Production environments', prodCount]].map(([k, v]) => (
          <Card key={k as string}><p className="text-sm text-slate-500">{k}</p><p className="text-3xl font-semibold tabular-nums">{v}</p></Card>
        ))}
      </div>
      <Card title="Telemetry">
        <EmptyState title="No data sources connected">
          Request rate, error rate, latency, service health and ingestion status appear here once a source is connected and
          sending telemetry. Nothing on this page is demo or estimated data.
          <span className="mt-2 block"><Badge tone="warn">Data sources: planned (phase 2)</Badge> <Badge tone="warn">Telemetry ingestion: planned (phase 3)</Badge></span>
        </EmptyState>
      </Card>
      {projects.length === 0 && (
        <EmptyState title="No projects yet" action={<Link className="text-indigo-600 underline" to="/projects">Go to Projects</Link>}>
          Create a project and its environments first. Org owners and admins can create projects; other members see projects they were granted.
        </EmptyState>
      )}
    </div>
  );
}
