import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useSelection } from '../../session';
import { EmptyState } from '../../ui';

export const fieldClass = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900';
export const toLocalInput = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/**
 * A shared link names its project (`p`): adopt it once the project list is known. Access is still enforced by the server, so a link to a
 * project the viewer cannot read simply shows "not found" — it never reveals whether the project exists.
 */
export function ProjectGate({ title, urlProject, children }: { title: string; urlProject: string | null; children: (p: NonNullable<ReturnType<typeof useSelection>['project']>) => ReactNode }) {
  const { project, projects, projectsStatus, select } = useSelection();
  useEffect(() => {
    if (urlProject && project?.id !== urlProject && projects.some((x) => x.id === urlProject)) select(urlProject, null);
  }, [urlProject, project?.id, projects, select]);
  if (!project && urlProject && projectsStatus === 'success' && !projects.some((x) => x.id === urlProject)) {
    return <div className="space-y-3"><h1 className="text-xl font-semibold">{title}</h1><EmptyState title="Project not found">This link points to a project that does not exist or that you do not have access to.</EmptyState></div>;
  }
  if (!project) {
    return <div className="space-y-3"><h1 className="text-xl font-semibold">{title}</h1><EmptyState title="Select a project">{projects.length === 0 ? 'No projects yet.' : 'Choose a project in the header.'}</EmptyState></div>;
  }
  return <>{children(project)}</>;
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" aria-label={`Copy ${label}`} className="ml-1 rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export const WINDOWS = [
  { minutes: 15, label: 'Last 15 minutes' }, { minutes: 60, label: 'Last hour' }, { minutes: 360, label: 'Last 6 hours' }, { minutes: 1440, label: 'Last 24 hours' },
] as const;
