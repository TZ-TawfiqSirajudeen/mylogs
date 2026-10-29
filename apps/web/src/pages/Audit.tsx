import type { z } from 'zod';
import type { AuditPage } from '@nexus/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, ApiRequestError } from '../api';
import { Button, EmptyState, ErrorState, Loading } from '../ui';

type Page = z.infer<typeof AuditPage>;

export default function Audit() {
  const q = useInfiniteQuery({
    queryKey: ['audit'],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api<Page>('GET', `/api/v1/audit?limit=50${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    retry: false,
  });
  if (q.isPending) return <Loading />;
  if (q.isError) {
    return q.error instanceof ApiRequestError && q.error.status === 403
      ? <EmptyState title="Not permitted">Audit history is available to organization owners, admins and auditors.</EmptyState>
      : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const items = q.data.pages.flatMap((p) => p.items);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Audit Logs</h1>
      {items.length === 0 ? <EmptyState title="No audit events yet" /> : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Audit events, newest first</caption>
            <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
              <tr><th className="px-3 py-2">Time (UTC)</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Target</th><th className="px-3 py-2">Actor</th><th className="px-3 py-2">Details</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{e.createdAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}</td>
                  <td className="px-3 py-2 font-medium">{e.action}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.targetType}{e.targetId ? `:${e.targetId.slice(0, 8)}` : ''}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.actorUserId?.slice(0, 8) ?? 'system'}</td>
                  <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-slate-500" title={JSON.stringify(e.metadata)}>{JSON.stringify(e.metadata)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && <Button variant="ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load older events'}</Button>}
    </div>
  );
}
