import type { Database, OrgRole } from '@nexus/database';

/**
 * DEMO DATA ONLY. Creates two organizations with differently-privileged users so role behaviour and tenant
 * isolation can be exercised locally. Contains no telemetry. Idempotent.
 */
export const DEMO_USERS: { email: string; name: string; org: string; role: OrgRole }[] = [
  { email: 'owner@acme.test', name: 'Olivia Owner', org: 'acme', role: 'owner' },
  { email: 'admin@acme.test', name: 'Adam Admin', org: 'acme', role: 'admin' },
  { email: 'engineer@acme.test', name: 'Erin Engineer', org: 'acme', role: 'member' },
  { email: 'viewer@acme.test', name: 'Victor Viewer', org: 'acme', role: 'member' },
  { email: 'auditor@acme.test', name: 'Aria Auditor', org: 'acme', role: 'auditor' },
  { email: 'owner@globex.test', name: 'Gina Globex', org: 'globex', role: 'owner' },
];

export async function seedDemo(db: Database): Promise<void> {
  const orgs = new Map<string, string>();
  for (const [slug, name] of [['acme', 'Acme Corp (demo)'], ['globex', 'Globex Inc (demo)']] as const) {
    const existing = await db.c.organizations.findOne({ slug });
    const id = existing?._id ?? crypto.randomUUID();
    if (!existing) await db.c.organizations.insertOne({ _id: id, slug, name, createdAt: new Date() });
    orgs.set(slug, id);
  }
  for (const u of DEMO_USERS) {
    const emailLower = u.email.toLowerCase();
    let user = await db.c.users.findOne({ emailLower });
    if (!user) {
      user = { _id: crypto.randomUUID(), email: u.email, emailLower, displayName: u.name, externalSubject: null, createdAt: new Date(), disabledAt: null };
      await db.c.users.insertOne(user);
    }
    const orgId = orgs.get(u.org)!;
    await db.c.orgMemberships.updateOne(
      { orgId, userId: user._id },
      { $set: { role: u.role }, $setOnInsert: { _id: crypto.randomUUID(), createdAt: new Date() } },
      { upsert: true },
    );
  }
}
