import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { canChangeOrgRole } from '../src/authz/policy.js';
import { harness, type Client, type Harness } from './helpers.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let h: Harness;
let owner: Client, admin: Client, engineer: Client, viewer: Client, auditor: Client, globex: Client;
const idOf = async (email: string) => (await h.db.c.users.findOne({ emailLower: email }))!._id;

beforeAll(async () => {
  mongo = await startTestMongo();
  h = await harness(mongo.uri);
  [owner, admin, engineer, viewer, auditor, globex] = await Promise.all([
    h.login('owner@acme.test'), h.login('admin@acme.test'), h.login('engineer@acme.test'),
    h.login('viewer@acme.test'), h.login('auditor@acme.test'), h.login('owner@globex.test'),
  ]);
}, 240_000);
afterAll(async () => { await h?.app.close(); await h?.db.close(); await mongo?.stop(); });

describe('canChangeOrgRole (pure policy)', () => {
  test('owners may do anything; admins only touch member/auditor accounts; everyone else nothing', () => {
    expect(canChangeOrgRole('owner', 'member', 'owner')).toBe(true);
    expect(canChangeOrgRole('owner', 'admin', null)).toBe(true);
    expect(canChangeOrgRole('admin', null, 'member')).toBe(true);
    expect(canChangeOrgRole('admin', 'member', 'auditor')).toBe(true);
    expect(canChangeOrgRole('admin', null, 'admin')).toBe(false);
    expect(canChangeOrgRole('admin', 'member', 'owner')).toBe(false);
    expect(canChangeOrgRole('admin', 'admin', 'member')).toBe(false);
    expect(canChangeOrgRole('admin', 'owner', null)).toBe(false);
    for (const actor of ['member', 'auditor'] as const) expect(canChangeOrgRole(actor, null, 'member')).toBe(false);
  });
});

describe('organization member management', () => {
  test('only owner and admin can list or change members', async () => {
    for (const c of [engineer, viewer, auditor]) {
      expect((await c.req('GET', '/api/v1/org/members')).status).toBe(403);
      expect((await c.req('POST', '/api/v1/org/members', { email: 'x@acme.test', role: 'member' })).status).toBe(403);
      expect((await c.req('PATCH', `/api/v1/org/members/${await idOf('viewer@acme.test')}`, { role: 'admin' })).status).toBe(403);
      expect((await c.req('DELETE', `/api/v1/org/members/${await idOf('viewer@acme.test')}`)).status).toBe(403);
    }
  });

  test('inviting creates an unbound account with the requested role and is audited', async () => {
    const res = await admin.req('POST', '/api/v1/org/members', { email: 'New.Person@Acme.test', role: 'auditor', displayName: 'New Person' });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ email: 'new.person@acme.test', role: 'auditor' });
    const u = (await h.db.c.users.findOne({ emailLower: 'new.person@acme.test' }))!;
    expect(u.externalSubject ?? null).toBeNull(); // not bound until that person signs in via the IdP
    expect(await h.db.c.auditEvents.countDocuments({ action: 'org.member_added', targetId: u._id })).toBe(1);
    const list = (await owner.req('GET', '/api/v1/org/members')).json as { email: string; signedInBefore: boolean }[];
    expect(list.find((m) => m.email === 'new.person@acme.test')?.signedInBefore).toBe(false);
    expect((await admin.req('POST', '/api/v1/org/members', { email: 'new.person@acme.test', role: 'member' })).status).toBe(409); // already a member
  });

  test('an admin cannot create admins or owners; an owner can', async () => {
    expect((await admin.req('POST', '/api/v1/org/members', { email: 'wannabe@acme.test', role: 'admin' })).status).toBe(403);
    expect((await admin.req('POST', '/api/v1/org/members', { email: 'wannabe@acme.test', role: 'owner' })).status).toBe(403);
    expect(await h.db.c.users.findOne({ emailLower: 'wannabe@acme.test' })).toBeNull();
    expect((await owner.req('POST', '/api/v1/org/members', { email: 'second.owner@acme.test', role: 'admin' })).status).toBe(201);
  });

  test('an admin cannot escalate anyone, nor modify or remove admins/owners', async () => {
    const viewerId = await idOf('viewer@acme.test');
    expect((await admin.req('PATCH', `/api/v1/org/members/${viewerId}`, { role: 'admin' })).status).toBe(403);
    expect((await admin.req('PATCH', `/api/v1/org/members/${viewerId}`, { role: 'owner' })).status).toBe(403);
    expect((await admin.req('PATCH', `/api/v1/org/members/${owner.userId}`, { role: 'member' })).status).toBe(403);
    expect((await admin.req('DELETE', `/api/v1/org/members/${owner.userId}`)).status).toBe(403);
    expect((await admin.req('POST', `/api/v1/org/members/${owner.userId}/revoke-sessions`)).status).toBe(403);
    expect((await admin.req('PATCH', `/api/v1/org/members/${viewerId}`, { role: 'auditor' })).status).toBe(204); // allowed lateral change
    expect((await admin.req('PATCH', `/api/v1/org/members/${viewerId}`, { role: 'member' })).status).toBe(204);
  });

  test('nobody can change their own role or remove themselves', async () => {
    expect((await owner.req('PATCH', `/api/v1/org/members/${owner.userId}`, { role: 'member' })).status).toBe(409);
    expect((await owner.req('DELETE', `/api/v1/org/members/${owner.userId}`)).status).toBe(409);
    expect((await admin.req('PATCH', `/api/v1/org/members/${admin.userId}`, { role: 'owner' })).status).toBe(409);
  });

  test('an organization always keeps an owner, even when two owners demote each other at the same moment', async () => {
    const acme = (await h.db.c.organizations.findOne({ slug: 'acme' }))!._id;
    const aId = (await owner.req('POST', '/api/v1/org/members', { email: 'race.a@acme.test', role: 'owner' })).json.userId as string;
    const bId = (await owner.req('POST', '/api/v1/org/members', { email: 'race.b@acme.test', role: 'owner' })).json.userId as string;
    // Leave exactly these two as owners.
    await h.db.c.orgMemberships.updateMany({ orgId: acme, userId: { $nin: [aId, bId] }, role: 'owner' }, { $set: { role: 'admin' } });
    const [a, b] = await Promise.all([h.login('race.a@acme.test'), h.login('race.b@acme.test')]);
    const results = await Promise.all([
      a.req('PATCH', `/api/v1/org/members/${bId}`, { role: 'member' }),
      b.req('PATCH', `/api/v1/org/members/${aId}`, { role: 'member' }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([204, 409]); // exactly one wins; the other is told the org must keep an owner
    expect(await h.db.c.orgMemberships.countDocuments({ orgId: acme, role: 'owner' })).toBe(1);
    // The survivor cannot be removed or demoted by anyone below owner, and cannot demote themselves.
    const survivor = results[0]!.status === 204 ? a : b;
    expect((await survivor.req('DELETE', `/api/v1/org/members/${survivor.userId}`)).status).toBe(409);
    // Restore the demo owner for the remaining tests.
    await h.db.c.orgMemberships.updateOne({ orgId: acme, userId: owner.userId }, { $set: { role: 'owner' } });
    await h.db.c.orgMemberships.deleteMany({ orgId: acme, userId: { $in: [aId, bId] } });
  });

  test('removing a member deletes their project grants and ends their sessions immediately', async () => {
    const proj = (await owner.req('POST', '/api/v1/projects', { name: 'Members test', environments: [{ name: 'Dev' }] })).json;
    expect((await owner.req('PUT', `/api/v1/projects/${proj.id}/members/${engineer.userId}`, { role: 'engineer' })).status).toBe(204);
    expect((await engineer.req('GET', `/api/v1/projects/${proj.id}`)).status).toBe(200);
    expect((await owner.req('DELETE', `/api/v1/org/members/${engineer.userId}`)).status).toBe(204);
    expect((await engineer.req('GET', '/api/v1/auth/session')).status).toBe(401);
    expect(await h.db.c.projectMemberships.countDocuments({ userId: engineer.userId })).toBe(0);
    expect(await h.db.c.auditEvents.countDocuments({ action: 'org.member_removed', targetId: engineer.userId })).toBe(1);
  });

  test('role changes revoke live sessions; revoke-sessions signs the person out everywhere', async () => {
    const a = await h.login('viewer@acme.test');
    const b = await h.login('viewer@acme.test');
    expect((await owner.req('POST', `/api/v1/org/members/${a.userId}/revoke-sessions`)).json).toEqual({ revoked: expect.any(Number) });
    expect((await a.req('GET', '/api/v1/auth/session')).status).toBe(401);
    expect((await b.req('GET', '/api/v1/auth/session')).status).toBe(401);
    const c = await h.login('viewer@acme.test');
    expect((await owner.req('PATCH', `/api/v1/org/members/${c.userId}`, { role: 'auditor' })).status).toBe(204);
    expect((await c.req('GET', '/api/v1/auth/session')).status).toBe(401);
  });

  test('another tenant\'s owner cannot see or change acme members', async () => {
    const acmeUser = await idOf('auditor@acme.test');
    expect((await globex.req('PATCH', `/api/v1/org/members/${acmeUser}`, { role: 'admin' })).status).toBe(404);
    expect((await globex.req('DELETE', `/api/v1/org/members/${acmeUser}`)).status).toBe(404);
    const list = (await globex.req('GET', '/api/v1/org/members')).json as { email: string }[];
    expect(list.map((m) => m.email)).toEqual(['owner@globex.test']);
  });

  test('state-changing member calls need the CSRF token and an allowed origin', async () => {
    const target = await idOf('auditor@acme.test');
    const noCsrf = await h.app.inject({ method: 'PATCH', url: `/api/v1/org/members/${target}`, headers: { cookie: owner.cookie, origin: h.cfg.webOrigin }, payload: { role: 'member' } });
    expect(noCsrf.statusCode).toBe(403);
    const evil = await h.app.inject({ method: 'DELETE', url: `/api/v1/org/members/${target}`, headers: { cookie: owner.cookie, origin: 'https://evil.example', 'x-csrf-token': owner.csrf } });
    expect(evil.statusCode).toBe(403);
  });
});
