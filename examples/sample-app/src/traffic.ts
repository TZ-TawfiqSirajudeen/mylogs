/** Sends a realistic mix of requests to the sample app:  pnpm --filter sample-app traffic [baseUrl] [count] */
const base = process.argv[2] ?? 'http://127.0.0.1:3100';
const count = Number(process.argv[3] ?? 40);
const plan: [string, string][] = [['GET', '/ok'], ['GET', '/orders/17'], ['GET', '/orders/404'], ['GET', '/orders/500'], ['POST', '/login'], ['GET', '/slow']];

let failed = 0;
for (let i = 0; i < count; i++) {
  const [method, path] = plan[i % plan.length]!;
  try {
    const r = await fetch(`${base}${path}`, { method, headers: { 'x-request-id': `traffic-${i}-${Date.now().toString(36)}` } });
    await r.text();
  } catch { failed++; }
}
console.log(`sent ${count} requests (${failed} connection failures)`);

export {};
