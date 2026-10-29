import type { Project, SessionInfo } from '@nexus/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiRequestError, fetchSession, setCsrfToken } from './api';

/**
 * Drops every cached query except the session itself and publishes the new session value. `queryClient.clear()` alone
 * would NOT notify mounted observers, so the old user's UI would stay on screen.
 */
export function resetClientState(qc: ReturnType<typeof useQueryClient>, session: SessionInfo | null) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
  setCsrfToken(session?.csrfToken ?? null);
  qc.setQueryData(['session'], session);
}

const SessionCtx = createContext<{ session: SessionInfo; logout: () => Promise<void> } | null>(null);
export const useSession = () => {
  const v = useContext(SessionCtx);
  if (!v) throw new Error('useSession outside SessionGate');
  return v;
};

export function SessionGate({ children, login }: { children: ReactNode; login: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['session'], queryFn: fetchSession, staleTime: 60_000, retry: false });
  const logout = useCallback(async () => {
    let redirect: string | null = null;
    try {
      redirect = (await api<{ redirect: string | null }>('POST', '/api/v1/auth/logout'))?.redirect ?? null;
    } catch (e) {
      // 401 = already signed out server-side. Anything else means the server session may still be alive:
      // keep the UI as it is and surface the error instead of pretending we signed out.
      if (!(e instanceof ApiRequestError && e.status === 401)) throw e;
    }
    resetClientState(qc, null);
    // OIDC: also end the identity provider's session (RP-initiated logout), which returns the browser to the app.
    if (redirect) window.location.assign(redirect);
  }, [qc]);
  const value = useMemo(() => (q.data ? { session: q.data, logout } : null), [q.data, logout]);
  if (q.isPending) return <p role="status" className="p-6 text-sm">Loading…</p>;
  if (q.isError) return <p role="alert" className="p-6 text-sm text-red-600">Cannot reach the API. {q.error.message}</p>;
  if (!value) return <>{login}</>;
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

// ---- project / environment selection (ids only; non-sensitive per-viewer convenience) ----
const KEY = 'nx-selection';
interface Sel { projectId: string | null; environmentId: string | null }
const read = (): Sel => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '') as Sel; } catch { return { projectId: null, environmentId: null }; }
};

interface SelectionValue {
  projects: Project[];
  projectsStatus: 'pending' | 'error' | 'success';
  projectsError: unknown;
  refetchProjects(): void;
  project: Project | null;
  environment: Project['environments'][number] | null;
  select(projectId: string | null, environmentId?: string | null): void;
}
const SelCtx = createContext<SelectionValue | null>(null);
export const useSelection = () => {
  const v = useContext(SelCtx);
  if (!v) throw new Error('useSelection outside SelectionProvider');
  return v;
};

export function SelectionProvider({ children }: { children: ReactNode }) {
  const pq = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('GET', '/api/v1/projects') });
  const projects = pq.data ?? [];
  const [sel, setSel] = useState<Sel>(read);
  const project = projects.find((p) => p.id === sel.projectId) ?? null;
  const environment = project?.environments.find((e) => e.id === sel.environmentId) ?? null;
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(sel)); } catch { /* storage unavailable */ } }, [sel]);
  const select = useCallback((projectId: string | null, environmentId: string | null = null) => {
    setSel({ projectId, environmentId });
  }, []);
  const refetchProjects = useCallback(() => { void pq.refetch(); }, [pq]);
  const value = useMemo(
    () => ({ projects, projectsStatus: pq.status, projectsError: pq.error, refetchProjects, project, environment, select }),
    [projects, pq.status, pq.error, refetchProjects, project, environment, select],
  );
  return <SelCtx.Provider value={value}>{children}</SelCtx.Provider>;
}
