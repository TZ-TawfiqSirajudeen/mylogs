import { DevLoginBody, type SessionInfo } from '@nexus/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { api, fetchAuthConfig } from '../api';
import { resetClientState } from '../session';
import { Button, Card, Input } from '../ui';

type Form = z.infer<typeof DevLoginBody>;
const DEMO = [
  ['owner@acme.test', 'Org owner'], ['admin@acme.test', 'Org admin'], ['engineer@acme.test', 'Member'],
  ['viewer@acme.test', 'Member'], ['auditor@acme.test', 'Auditor'], ['owner@globex.test', 'Other tenant owner'],
] as const;

/** Generic, user-safe messages for the failure codes the API puts in `?auth_error=`. Details live in server logs only. */
const AUTH_ERRORS: Record<string, string> = {
  idp_denied: 'Sign-in was cancelled or denied by the identity provider.',
  not_authorized: 'Your account is not authorized to use this workspace. Ask an administrator to grant you access.',
  login_failed: 'Sign-in could not be completed. Please try again.',
  idp_unavailable: 'The identity provider is not reachable right now. Please try again shortly.',
};

/** Reads (once) and removes the `auth_error` query parameter so a refresh or a shared link does not replay the message. */
function useAuthError(): string | null {
  const [msg] = useState<string | null>(() => {
    const code = new URLSearchParams(window.location.search).get('auth_error');
    return code ? (AUTH_ERRORS[code] ?? AUTH_ERRORS.login_failed!) : null;
  });
  useEffect(() => {
    const u = new URL(window.location.href);
    if (u.searchParams.has('auth_error')) { u.searchParams.delete('auth_error'); window.history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`); }
  }, []);
  return msg;
}

function OidcLogin({ providerName, loginUrl }: { providerName: string; loginUrl: string }) {
  const error = useAuthError();
  // The deep link the user was heading to survives the round trip (the server only accepts same-origin relative paths).
  const returnTo = `${window.location.pathname}${window.location.search}`;
  const href = `${loginUrl}?${new URLSearchParams({ returnTo })}`;
  return (
    <div className="mx-auto mt-16 max-w-md space-y-4 px-4">
      <h1 className="text-2xl font-semibold tracking-tight">Nexus Observability</h1>
      <Card title="Sign in">
        {error && <p role="alert" data-testid="auth-error" className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <a href={href} data-testid="oidc-signin"
          className="inline-flex items-center rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300">
          Sign in with {providerName}
        </a>
        <p className="mt-3 text-xs text-slate-500">Access is limited to people your organization has authorized.</p>
      </Card>
    </div>
  );
}

export default function Login() {
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: fetchAuthConfig, retry: false });
  if (cfg.isPending) return <p role="status" className="p-6 text-sm">Loading…</p>;
  if (cfg.data?.mode === 'oidc' && cfg.data.loginUrl) return <OidcLogin providerName={cfg.data.providerName ?? 'single sign-on'} loginUrl={cfg.data.loginUrl} />;
  return <DevLogin />;
}

function DevLogin() {
  const qc = useQueryClient();
  const { register, handleSubmit, setValue, formState: { errors } } = useForm<Form>({ resolver: zodResolver(DevLoginBody) });
  const login = useMutation({
    mutationFn: (b: Form) => api<SessionInfo>('POST', '/api/v1/auth/dev-login', b),
    // Wipe everything cached for a previous user before the new session becomes visible.
    onSuccess: (s) => resetClientState(qc, s),
  });
  return (
    <div className="mx-auto mt-16 max-w-md space-y-4 px-4">
      <h1 className="text-2xl font-semibold tracking-tight">Nexus Observability</h1>
      <Card title="Sign in (development mode)">
        <form className="space-y-3" onSubmit={handleSubmit((b) => login.mutate(b))} noValidate>
          <Input label="Email" type="email" autoComplete="username" {...register('email')} error={errors.email?.message} />
          {login.isError && <p role="alert" className="text-sm text-red-600">{login.error.message}</p>}
          <Button type="submit" disabled={login.isPending}>{login.isPending ? 'Signing in…' : 'Sign in'}</Button>
        </form>
        <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
          <p className="mb-2 text-xs text-slate-500">Seeded DEMO users (run the API with <code className="font-mono">--seed</code>):</p>
          <div className="flex flex-wrap gap-1.5">
            {DEMO.map(([email, role]) => (
              <button key={email} type="button" onClick={() => setValue('email', email)}
                className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
                {email} <span className="text-slate-500">· {role}</span>
              </button>
            ))}
          </div>
        </div>
      </Card>
      <p className="text-xs text-slate-500">Development mode only. Set AUTH_MODE=oidc for single sign-on (see docs/auth-oidc.md); the dev sign-in endpoint does not exist in that mode.</p>
    </div>
  );
}
