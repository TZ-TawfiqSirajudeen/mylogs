import type { OrgRole } from '@nexus/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiRequestError } from '../api';
import { useSession } from '../session';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Loading } from '../ui';

interface Member { userId: string; email: string; displayName: string; role: OrgRole; signedInBefore: boolean }
const ROLES: { value: OrgRole; label: string }[] = [
  { value: 'member', label: 'Member (needs project grants)' },
  { value: 'auditor', label: 'Auditor (read-only audit history)' },
  { value: 'admin', label: 'Admin' },
  { value: 'owner', label: 'Owner' },
];

export default function Settings() {
  const { session } = useSession();
  const qc = useQueryClient();
  const canManage = session.orgRole === 'owner' || session.orgRole === 'admin';
  const members = useQuery({ queryKey: ['org-members'], queryFn: () => api<Member[]>('GET', '/api/v1/org/members'), enabled: canManage, retry: false });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org-members'] });
  // Admins may only handle member/auditor accounts; the API enforces this too — the UI just does not offer what would be refused.
  const assignable = ROLES.filter((r) => session.orgRole === 'owner' || r.value === 'member' || r.value === 'auditor');
  const canTouch = (m: Member) => m.userId !== session.user.id && (session.orgRole === 'owner' || m.role === 'member' || m.role === 'auditor');

  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { setNotice(null); void refresh(); },
    onMutate: () => setInfo(null),
    onError: (e) => setNotice(e instanceof ApiRequestError ? e.message : 'Request failed'),
  });

  if (!canManage) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <EmptyState title="Not permitted">Organization settings are available to owners and admins.</EmptyState>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <Card title="Invite a member">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); run.mutate(async () => { await api('POST', '/api/v1/org/members', { email, role }); setEmail(''); }); }}>
          <div className="min-w-64 flex-1"><Input label="E-mail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></div>
          <div className="space-y-1">
            <label htmlFor="invite-role" className="block text-sm font-medium">Role</label>
            <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)} className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900">
              {assignable.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <Button type="submit" disabled={run.isPending}>Add member</Button>
        </form>
        <p className="mt-2 text-xs text-slate-500">With single sign-on, a person can sign in only after they are added here (or if your deployment enables domain-restricted auto-provisioning). Their first sign-in links their identity provider account.</p>
      </Card>
      {info && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{info}</p>}
      {notice && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{notice}</p>}
      <Card title="Members">
        {members.isPending ? <Loading /> : members.isError ? <ErrorState error={members.error} onRetry={() => void members.refetch()} /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Organization members</caption>
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800"><tr><th className="px-3 py-2">Member</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Status</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {members.data.map((m) => (
                  <tr key={m.userId} data-testid={`member-${m.email}`}>
                    <td className="px-3 py-2"><div className="font-medium">{m.displayName}</div><div className="text-xs text-slate-500">{m.email}</div></td>
                    <td className="px-3 py-2">
                      {canTouch(m) ? (
                        <>
                          <label className="sr-only" htmlFor={`role-${m.userId}`}>Role for {m.email}</label>
                          <select id={`role-${m.userId}`} value={m.role} disabled={run.isPending}
                            onChange={(e) => { const next = e.target.value; run.mutate(() => api('PATCH', `/api/v1/org/members/${m.userId}`, { role: next })); }}
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900">
                            {ROLES.filter((r) => assignable.some((a) => a.value === r.value) || r.value === m.role).map((r) => <option key={r.value} value={r.value}>{r.value}</option>)}
                          </select>
                        </>
                      ) : <Badge tone="info">{m.role}</Badge>}
                    </td>
                    <td className="px-3 py-2">{m.signedInBefore ? <Badge>Signed in</Badge> : <Badge tone="warn">Invited</Badge>}</td>
                    <td className="space-x-2 whitespace-nowrap px-3 py-2 text-right">
                      {canTouch(m) && (
                        <>
                          <Button variant="ghost" disabled={run.isPending} aria-label={`Sign out ${m.email} everywhere`}
                            onClick={() => run.mutate(async () => { const r = await api<{ revoked: number }>('POST', `/api/v1/org/members/${m.userId}/revoke-sessions`); setInfo(`Signed out ${r.revoked} session(s) for ${m.email}.`); })}>Sign out everywhere</Button>
                          <Button variant="danger" disabled={run.isPending} aria-label={`Remove ${m.email}`}
                            onClick={() => { if (window.confirm(`Remove ${m.email} from this organization? Their access ends immediately.`)) run.mutate(() => api('DELETE', `/api/v1/org/members/${m.userId}`)); }}>Remove</Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
