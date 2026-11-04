import type { IncidentDeployments } from '@nexus/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { StatusBadge } from '../deployments/DeploymentDrawer';
import { relativeToIncident, stamp } from '../deployments/model';

/**
 * Deployment entries for an incident's timeline (ADR-0011 #12): deployments of the incident's service, in its environment, from the 30 minutes before it opened.
 * Read-only and deliberately modest: a time coincidence, never a finding. Renders `<li>` elements, so it belongs inside the timeline `<ol>`;
 * it renders nothing while loading, on error (the timeline stands without it) and when there is nothing to show.
 */
export function IncidentDeploymentEvents({ projectId, incidentId, openedAt }: { projectId: string; incidentId: string; openedAt: string }) {
  const q = useQuery({
    queryKey: ['incident-deployments', projectId, incidentId], retry: false, staleTime: 30_000,
    queryFn: () => api<IncidentDeployments>('GET', `/api/v1/projects/${projectId}/incidents/${incidentId}/deployments`),
  });
  if (!q.data || q.data.items.length === 0) return null;
  return (
    <>
      {q.data.items.map((d) => (
        <li key={d.id} className="border-l-2 border-amber-500 pl-3" data-testid="timeline-deployment">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Deployment</span><StatusBadge s={d.status} />
            <span>{d.service} {d.version}</span>
            <time dateTime={d.startedAt} className="font-mono text-xs text-slate-600 dark:text-slate-400">{stamp(d.startedAt)}</time>
            <span className="text-xs text-slate-600 dark:text-slate-400">({relativeToIncident(d.startedAt, openedAt)} the incident opened)</span>
          </div>
          <p className="text-sm" data-testid="timeline-deployment-note">{q.data.note}{' '}
            <Link className="text-indigo-700 underline dark:text-indigo-300" to={`/deployments?p=${projectId}&id=${d.id}`}>Deployment details</Link></p>
        </li>
      ))}
    </>
  );
}
