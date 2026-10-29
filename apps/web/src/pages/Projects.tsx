import { ProjectCreate, type Project } from '@nexus/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import type { z } from 'zod';
import { api } from '../api';
import { useSession } from '../session';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Loading } from '../ui';

type Form = z.input<typeof ProjectCreate>;
const PRESETS = [
  { name: 'Development', isProduction: false }, { name: 'Testing', isProduction: false },
  { name: 'Staging', isProduction: false }, { name: 'Production', isProduction: true },
];

function CreateProject({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [envs, setEnvs] = useState<Set<string>>(new Set(['Development', 'Production']));
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({ resolver: zodResolver(ProjectCreate) as never });
  const create = useMutation({
    mutationFn: (b: Form) => api<Project>('POST', '/api/v1/projects', { ...b, environments: PRESETS.filter((p) => envs.has(p.name)) }),
    onSuccess: (p) => { void qc.invalidateQueries({ queryKey: ['projects'] }); onDone(); nav(`/projects/${p.id}`); },
  });
  return (
    <Card title="New project">
      <form className="grid gap-3 md:grid-cols-2" onSubmit={handleSubmit((b) => create.mutate(b))} noValidate>
        <Input label="Name" {...register('name')} error={errors.name?.message} />
        <Input label="Owning team" {...register('owningTeam')} error={errors.owningTeam?.message} />
        <div className="md:col-span-2"><Input label="Description" {...register('description')} error={errors.description?.message} /></div>
        <fieldset className="md:col-span-2">
          <legend className="text-sm font-medium">Environments</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {PRESETS.map((p) => (
              <label key={p.name} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={envs.has(p.name)} onChange={(e) => setEnvs((s) => { const n = new Set(s); e.target.checked ? n.add(p.name) : n.delete(p.name); return n; })} />
                {p.name}{p.isProduction && <Badge tone="danger">production</Badge>}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">Custom environments can be added after creation.</p>
        </fieldset>
        {create.isError && <p role="alert" className="text-sm text-red-600 md:col-span-2">{create.error.message}</p>}
        <div className="flex gap-2 md:col-span-2">
          <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create project'}</Button>
          <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

export default function Projects() {
  const { session } = useSession();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('GET', '/api/v1/projects') });
  const canCreate = session.orgRole === 'owner' || session.orgRole === 'admin';
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        {canCreate && !creating && <Button onClick={() => setCreating(true)}>New project</Button>}
      </div>
      {creating && <CreateProject onDone={() => setCreating(false)} />}
      {q.isPending && <Loading />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data?.length === 0 && (
        <EmptyState title="No projects">
          {canCreate ? 'Create your first project to start registering environments.' : 'You have not been granted access to any project. Ask a project admin.'}
        </EmptyState>
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {q.data?.map((p) => (
          <li key={p.id}>
            <Link to={`/projects/${p.id}`} className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-indigo-400 dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between"><h2 className="font-medium">{p.name}</h2><Badge tone="info">{p.role}</Badge></div>
              <p className="mt-1 line-clamp-2 text-sm text-slate-600 dark:text-slate-400">{p.description || 'No description'}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {p.environments.map((e) => <Badge key={e.id} tone={e.isProduction ? 'danger' : 'neutral'}>{e.name}</Badge>)}
                {p.environments.length === 0 && <span className="text-xs text-slate-500">No environments</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
