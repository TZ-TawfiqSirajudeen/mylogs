/** Run the mock identity provider for local development:  pnpm --filter @nexus/mock-idp start   (never use in production) */
import { startMockIdp } from './index.js';

const web = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const idp = await startMockIdp({
  port: Number(process.env.MOCK_IDP_PORT ?? 9000),
  clientId: process.env.OIDC_CLIENT_ID ?? 'nexus-local',
  clientSecret: process.env.OIDC_CLIENT_SECRET ?? 'local-dev-secret-change-me',
  redirectUris: [`${web}/api/v1/auth/oidc/callback`],
  postLogoutRedirectUris: [`${web}/`],
  // MOCK_IDP_USERS (JSON array of {sub,email,emailVerified,name,groups}) lets automated tests choose the directory.
  users: process.env.MOCK_IDP_USERS ? JSON.parse(process.env.MOCK_IDP_USERS) : [
    { sub: 'u-owner', email: 'owner@acme.test', emailVerified: true, name: 'Olivia Owner' },
    { sub: 'u-viewer', email: 'viewer@acme.test', emailVerified: true, name: 'Victor Viewer' },
    { sub: 'u-newhire', email: 'newhire@acme.test', emailVerified: true, name: 'Nia Newhire' },
  ],
});
console.log(`mock IdP ready: issuer ${idp.issuer}  (client ${process.env.OIDC_CLIENT_ID ?? 'nexus-local'})`);
