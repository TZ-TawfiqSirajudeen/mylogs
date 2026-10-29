import { test as base, expect, type Page } from '@playwright/test';

export const DEMO = {
  owner: 'owner@acme.test', admin: 'admin@acme.test', engineer: 'engineer@acme.test', viewer: 'viewer@acme.test',
  auditor: 'auditor@acme.test', globex: 'owner@globex.test',
} as const;

export interface Db {
  find(collection: string, filter?: object): Promise<any[]>;
  count(collection: string, filter?: object): Promise<number>;
  update(collection: string, filter: object, update: object): Promise<number>;
}

export const env = () => ({
  dbUrl: process.env.E2E_DB_URL!, ingest: process.env.E2E_INGEST_URL!,
  web: process.env.E2E_WEB_URL!, api: process.env.E2E_API_URL!, worker: process.env.E2E_WORKER_URL!, mongo: process.env.E2E_MONGO_URI!,
  db: process.env.E2E_DB!, target: process.env.E2E_TARGET_URL!, token: process.env.E2E_TARGET_TOKEN!,
});

export const test = base.extend<{ db: Db; setTarget: (mode: 'ok' | '503' | 'reject') => Promise<void>; responses: string[] }>({
  baseURL: async ({}, use) => { await use(process.env.E2E_WEB_URL); },
  db: async ({}, use) => {
    const op = async (body: object) => {
      const r = await fetch(`${env().dbUrl}/op`, { method: 'POST', body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`db helper: ${await r.text()}`);
      return r.json();
    };
    await use({
      find: (collection, filter = {}) => op({ op: 'find', collection, filter }),
      count: (collection, filter = {}) => op({ op: 'count', collection, filter }),
      update: (collection, filter, update) => op({ op: 'update', collection, filter, update }),
    });
  },
  setTarget: async ({}, use) => { await use(async (m) => { await fetch(`${env().target}/__mode?m=${m}`); }); },
  // Every response body the page received, so tests can prove secrets never reach the browser.
  responses: async ({ page }, use) => {
    const bodies: string[] = [];
    page.on('response', async (r) => {
      if (!r.url().includes('/api/')) return;
      try { bodies.push(await r.text()); } catch { /* redirects / aborted */ }
    });
    await use(bodies);
  },
});
export { expect };

export async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

export async function logout(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
}

export async function selectProject(page: Page, name: string) {
  await page.locator('#project-switch').selectOption({ label: name });
}

/** Creates a project via the API with the page's own session (fast setup for specs that are not about project creation). */
export async function apiAs(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const s = await (await fetch('/api/v1/auth/session')).json();
    const res = await fetch(path, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': s.csrfToken },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }, { method, path, body });
}
