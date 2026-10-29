import { EnvironmentCreate, type Project } from '@nexus/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router-dom';
import type { z } from 'zod';
import { api, ApiRequestError } from '../api';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Loading } from '../ui';

type Form = z.input<typeof EnvironmentCreate>;

export default function ProjectDetail() {
  const { projectId = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['project', projectId], queryFn: () => api<Project>('GET', `/api/v1/projects/${projectId}`), retry: false,
  });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['project', projectId] }); void qc.invalidateQueries({ queryKey: ['projects'] }); };
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Form>({ resolver: zodResolver(EnvironmentCreate) as never });
  const add = useMutation({
    mutationFn: (b: Form) => api('POST', `/api/v1/projects/${projectId}/environments`, b),
    onSuccess: () => { reset(); refresh(); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/v1/projects/${projectId}/environments/${id}`),
    onSuccess: refresh,
  });

  if (q.isPending) return <Loading />;
  if (q.isError) {
    return q.error instanceof ApiRequestError && q.error.status === 404
      ? <EmptyState title="Project not found" action={<Link className="text-indigo-600 underline" to="/projects">Back to projects</Link>}>It does not exist or you do not have access to it.</EmptyState>
      : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const p = q.data;
  const isAdmin = p.role === 'project_admin';
  return (
    <div className="space-y-4">
      <div>
        <Link to="/projects" className="text-sm text-indigo-600 hover:underline">← Projects</Link>
        <div className="mt-1 flex items-center gap-2"><h1 className="text-xl font-semibold">{p.name}</h1><Badge tone="info">{p.role}</Badge></div>
        <p className="text-sm text-slate-600 dark:text-slate-400">{p.description || 'No description'}{p.owningTeam && ` · Team: ${p.owningTeam}`}</p>
        <p className="mt-0.5 font-mono text-xs text-slate-500">{p.id}</p>
      </div>
      <Card title="Environments">
        {p.environments.length === 0 && <p className="text-sm text-slate-500">No environments {isAdmin ? 'yet — add one below.' : 'visible to you.'}</p>}
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {p.environments.map((e) => (
            <li key={e.id} className="flex items-center justify-between py-2">
              <span className="flex items-center gap-2 text-sm">{e.name}{e.isProduction && <Badge tone="danger">production</Badge>}<span className="font-mono text-xs text-slate-500">{e.slug}</span></span>
              {isAdmin && (
                <Button variant="danger" disabled={del.isPending} onClick={() => { if (confirm(`Delete environment "${e.name}"? Collected data for it will no longer be reachable.`)) del.mutate(e.id); }}>Delete</Button>
              )}
            </li>
          ))}
        </ul>
        {del.isError && <p role="alert" className="mt-2 text-sm text-red-600">{del.error.message}</p>}
        {isAdmin && (
          <form className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4 dark:border-slate-800" onSubmit={handleSubmit((b) => add.mutate(b))} noValidate>
            <Input label="New environment" {...register('name')} error={errors.name?.message} />
            <label className="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" {...register('isProduction')} /> Production</label>
            <Button type="submit" disabled={add.isPending}>Add</Button>
            {add.isError && <p role="alert" className="w-full text-sm text-red-600">{add.error.message}</p>}
          </form>
        )}
      </Card>
      <Card title="Data sources" actions={<Link to="/sources" className="text-sm text-indigo-600 hover:underline">Manage</Link>}>
        <p className="text-sm text-slate-600 dark:text-slate-400">Select this project in the header, then open <Link to="/sources" className="text-indigo-600 underline">Data Sources</Link> to connect and monitor sources.</p>
      </Card>
    </div>
  );
}
