import type { DeploymentMarkers } from '@nexus/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { toChartMarkers, type ChartMarker } from '../../chart-markers';
import { useSelection } from '../../session';

/**
 * Deployment markers for a chart window (ADR-0011). Fetched on their own: if this call fails the chart is unchanged and the caller says
 * that markers are unavailable. The server scopes the answer to the environments the viewer may read.
 */
export function useDeploymentMarkers(projectId: string, from: string | undefined, to: string | undefined, opts: { service?: string | undefined; environmentId?: string | undefined } = {}) {
  const { project } = useSelection();
  const envName = (id: string) => project?.environments.find((e) => e.id === id)?.name ?? null;
  const q = useQuery({
    queryKey: ['deployment-markers', projectId, from, to, opts.service ?? '', opts.environmentId ?? ''], enabled: !!from && !!to, retry: false, staleTime: 30_000,
    queryFn: () => {
      const p = new URLSearchParams({ from: from!, to: to! });
      if (opts.service) p.set('service', opts.service);
      if (opts.environmentId) p.set('environmentId', opts.environmentId);
      return api<DeploymentMarkers>('GET', `/api/v1/projects/${projectId}/deployments/markers?${p}`);
    },
  });
  const convert = (environmentId?: string): ChartMarker[] => (q.data ? toChartMarkers(q.data.items, { envName, href: (m) => `/deployments?p=${projectId}&id=${m.id}`, ...(environmentId ? { environmentId } : {}) }) : []);
  return { markers: convert(), forEnvironment: convert, truncated: q.data?.truncated ?? false, failed: q.isError, loading: q.isPending && !!from };
}
