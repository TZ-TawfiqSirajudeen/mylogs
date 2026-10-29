import { startStack, type Stack } from './support/stack.js';

let stack: (Stack & { logs: string[] }) | undefined;

export default async function globalSetup() {
  stack = await startStack();
  process.env.E2E_WEB_URL = stack.webUrl;
  process.env.E2E_DB_URL = stack.dbUrl;
  process.env.E2E_INGEST_URL = stack.ingestUrl;
  process.env.E2E_API_URL = stack.apiUrl;
  process.env.E2E_WORKER_URL = stack.workerUrl;
  process.env.E2E_MONGO_URI = stack.mongoUri;
  process.env.E2E_DB = stack.dbName;
  process.env.E2E_OIDC_WEB_URL = stack.oidc.webUrl;
  process.env.E2E_OIDC_API_URL = stack.oidc.apiUrl;
  process.env.E2E_IDP_URL = stack.oidc.idpUrl;
  process.env.E2E_IDP_SECRET = stack.oidc.clientSecret;
  process.env.E2E_TARGET_URL = stack.targetUrl;
  process.env.E2E_TARGET_TOKEN = stack.targetToken;
  return async () => {
    if (process.env.E2E_PRINT_LOGS) console.log(stack?.logs.join('\n'));
    await stack?.stop();
  };
}
