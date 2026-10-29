import { connectDatabase } from '@nexus/database';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { seedDemo } from './seed.js';

async function main() {
  const cfg = loadConfig();
  const db = await connectDatabase(cfg.mongoUri, cfg.mongoDb);
  if (process.argv.includes('--seed')) {
    if (cfg.env === 'production') throw new Error('Refusing to seed demo data in production');
    await seedDemo(db);
  }
  const app = await buildApp(cfg, db);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try { await app.close(); await db.close(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: cfg.port, host: cfg.host });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
