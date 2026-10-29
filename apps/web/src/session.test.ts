import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { SessionInfo } from '@nexus/contracts';
import { expect, test } from 'vitest';
import { resetClientState } from './session';

const session = (email: string): SessionInfo => ({
  user: { id: crypto.randomUUID(), email, displayName: email },
  org: { id: crypto.randomUUID(), slug: 'acme', name: 'Acme' },
  orgRole: 'member', csrfToken: `csrf-${email}`, authMode: 'dev',
});

test('signing out notifies mounted observers (queryClient.clear() alone would not)', () => {
  const qc = new QueryClient();
  qc.setQueryData(['session'], session('a@x.test'));
  const seen: (SessionInfo | null | undefined)[] = [];
  const obs = new QueryObserver<SessionInfo | null>(qc, { queryKey: ['session'], queryFn: async () => null, staleTime: Infinity });
  const unsub = obs.subscribe((r) => seen.push(r.data));
  resetClientState(qc, null);
  expect(seen.at(-1)).toBeNull();
  unsub();
});

test('signing in as another user drops the previous user\'s cached data', () => {
  const qc = new QueryClient();
  qc.setQueryData(['audit'], { items: ['secret of user A'] });
  qc.setQueryData(['project', 'p1'], { name: 'A only' });
  qc.setQueryData(['projects'], [{ id: 'p1' }]);
  qc.setQueryData(['session'], session('a@x.test'));
  resetClientState(qc, session('b@x.test'));
  expect(qc.getQueryData(['audit'])).toBeUndefined();
  expect(qc.getQueryData(['project', 'p1'])).toBeUndefined();
  expect(qc.getQueryData(['projects'])).toBeUndefined();
  expect((qc.getQueryData(['session']) as SessionInfo).user.email).toBe('b@x.test');
});
