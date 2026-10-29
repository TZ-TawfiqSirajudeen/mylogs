import type { SessionInfo } from '@nexus/contracts';

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) {
    super(message);
  }
}

/** The CSRF token lives in memory only (never localStorage); it is re-fetched from /auth/session on reload. */
let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => { csrfToken = t; };
export const getCsrfToken = () => csrfToken;

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(path, {
    method, headers, credentials: 'same-origin', ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error;
    throw new ApiRequestError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.requestId);
  }
  return json as T;
}

export async function fetchSession(): Promise<SessionInfo | null> {
  try {
    const s = await api<SessionInfo>('GET', '/api/v1/auth/session');
    setCsrfToken(s.csrfToken);
    return s;
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 401) { setCsrfToken(null); return null; }
    throw e;
  }
}

/**
 * Consumes a server-sent-events response from a POST (EventSource cannot POST or send the CSRF header).
 * Calls `onEvent` per event; resolves when the stream ends; rejects on a non-2xx response. Abort via `signal`.
 */
export async function streamEvents(path: string, body: unknown, onEvent: (event: string, data: unknown) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin', signal, body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
  });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => null);
    throw new ApiRequestError(res.status, j?.error?.code ?? 'error', j?.error?.message ?? `Request failed (${res.status})`, j?.error?.requestId);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) { try { onEvent(event, JSON.parse(data)); } catch { /* ignore malformed frame */ } }
    }
  }
}

/** Downloads the response of a POST as a file (used for exports). */
export async function downloadPost(path: string, body: unknown, fallbackName: string): Promise<void> {
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
  });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new ApiRequestError(res.status, j?.error?.code ?? 'error', j?.error?.message ?? `Export failed (${res.status})`, j?.error?.requestId);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface AuthConfig { mode: 'dev' | 'oidc'; providerName: string | null; loginUrl: string | null; provisioning: 'invite-only' | 'jit' | null }
export const fetchAuthConfig = () => api<AuthConfig>('GET', '/api/v1/auth/config');
