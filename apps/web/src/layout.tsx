import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Badge, Button } from './ui';
import { useSelection, useSession } from './session';

interface NavItem { to: string; label: string; phase?: number }
const NAV: NavItem[] = [
  { to: '/', label: 'Overview' },
  { to: '/projects', label: 'Projects' },
  { to: '/services', label: 'Services' },
  { to: '/logs', label: 'Logs' },
  { to: '/traces', label: 'Traces' },
  { to: '/metrics', label: 'Metrics' },
  { to: '/dependencies', label: 'Dependencies', phase: 7 },
  { to: '/incidents', label: 'Incidents', phase: 6 },
  { to: '/alerts', label: 'Alerts', phase: 6 },
  { to: '/deployments', label: 'Deployments', phase: 6 },
  { to: '/sources', label: 'Data Sources' },
  { to: '/dashboards', label: 'Dashboards', phase: 7 },
  { to: '/audit', label: 'Audit Logs' },
  { to: '/settings', label: 'Settings' },
];

function ThemeToggle() {
  const toggle = () => {
    const dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('nx-theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  };
  return <Button variant="ghost" onClick={toggle} aria-label="Theme: toggle dark mode">Theme</Button>;
}

function Switcher() {
  const { projects, project, environment, select } = useSelection();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="project-switch">Project</label>
      <select id="project-switch" value={project?.id ?? ''} onChange={(e) => select(e.target.value || null, null)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900">
        <option value="">All projects</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <label className="sr-only" htmlFor="env-switch">Environment</label>
      <select id="env-switch" value={environment?.id ?? ''} disabled={!project} onChange={(e) => select(project!.id, e.target.value || null)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900">
        <option value="">All environments</option>
        {project?.environments.map((e) => <option key={e.id} value={e.id}>{e.name}{e.isProduction ? ' (production)' : ''}</option>)}
      </select>
    </div>
  );
}

export function Layout() {
  const { session, logout } = useSession();
  const { environment, project } = useSelection();
  const [open, setOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-slate-200 bg-white md:w-56 md:shrink-0 md:border-b-0 md:border-r dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-semibold tracking-tight">Nexus Observability</span>
          <button className="rounded border px-2 py-1 text-xs md:hidden" aria-expanded={open} onClick={() => setOpen(!open)}>Menu</button>
        </div>
        <nav aria-label="Primary" className={`${open ? 'block' : 'hidden'} px-2 pb-3 md:block`}>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={() => setOpen(false)}
              className={({ isActive }) => `flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm ${isActive ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
              {n.label}
              {n.phase && <span className="text-[10px] uppercase tracking-wide text-slate-600 dark:text-slate-400" title={`Not implemented yet — planned for phase ${n.phase}`}>P{n.phase}</span>}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
          <Switcher />
          <div className="flex items-center gap-2 text-sm">
            <span className="hidden sm:inline text-slate-600 dark:text-slate-400">{session.user.displayName} · <Badge tone="info">{session.orgRole}</Badge> · {session.org.name}</span>
            <ThemeToggle />
            <Button variant="ghost" onClick={() => { setSignOutError(null); logout().catch((e: unknown) => setSignOutError(e instanceof Error ? e.message : 'Sign out failed')); }}>Sign out</Button>
          </div>
        </header>
        {signOutError && <div role="alert" className="bg-red-100 px-4 py-1 text-sm text-red-800">Could not sign out: {signOutError}. Your session may still be active.</div>}
        {session.authMode === 'dev' && (
          <div className="bg-amber-100 px-4 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Development auth mode: passwordless demo sign-in is enabled. Not permitted in production.
          </div>
        )}
        {environment?.isProduction && (
          <div role="alert" className="bg-red-600 px-4 py-1.5 text-sm font-medium text-white">
            You are viewing PRODUCTION — {project?.name} / {environment.name}
          </div>
        )}
        <main className="flex-1 p-4 md:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
