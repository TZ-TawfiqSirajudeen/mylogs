# nexus-connect: connect any Node.js project to Nexus in one command

Give this folder (`nexus-connect.mjs` + `nexus-telemetry.template.mjs`) to a teammate. They need Node 18+ and a token.

## 1. Get a token (once)
Nexus → **Ingestion** → create a token for the project and environment. It looks like `nxi_...`. Treat it like a password.

## 2. Run the bot inside the project
```
node path/to/nexus-connect.mjs --token nxi_xxxxxxxx
```
Look first without changing anything: add `--dry-run`. Another folder: `--dir ../mychap`.
Other Nexus server: `--endpoint https://ingest.your-company.com`. Environment label: `--env production`.

It will:
1. find every service (`apps/*`, `services/*`, or the project itself),
2. install the OpenTelemetry packages (npm, pnpm or yarn, picked from the lockfile),
3. write `nexus-telemetry.mjs` at the project root,
4. add one import line at the top of each service's `server`/`index`/`main` file (originals saved in `.nexus-connect-backup/`),
5. write the endpoint and token to `.env.nexus` and add it to `.gitignore` (the token is never put in source).

## 3. Start the services and send some traffic
Each service prints `[nexus] telemetry on: service=<name>`. Open Services, Traces and Logs in Nexus (same project and environment as the token); data shows up within about 30 seconds.

**Logs from pino/express in ES-module projects** (`"type": "module"`) need one extra step. The bot prints the exact line at the end; it is:
```
PowerShell:  $env:NODE_OPTIONS = "--import=file:///C:/path/to/project/nexus-telemetry.mjs"
bash:        export NODE_OPTIONS="--import=file:///path/to/project/nexus-telemetry.mjs"
```
Set it in the terminal before starting the services. Traces, HTTP spans and metrics work without it.

## Undo
```
node path/to/nexus-connect.mjs --undo
```
Restores every changed file and deletes what the bot added. `NEXUS_DISABLED=1` in `.env.nexus` switches telemetry off without removing anything.

## Notes and limits
- Node.js backends only (Express, Fastify, Koa, Nest, plain http). Next.js and browser code are left alone on purpose.
- Needs Node 20.19+ or 22.12+ for projects that compile to CommonJS (the bootstrap is an ES module).
- Windows: a project folder path longer than about 200 characters can break the OpenTelemetry packages (Node cannot read package.json files past the 260-character limit). Use a shorter path.
- Docker: containers cannot reach `localhost` on the host. Use `--endpoint http://host.docker.internal:4318` and copy `nexus-telemetry.mjs` and `.env.nexus` into the image.
- Telemetry can never stop an app from starting: any setup error is printed as `[nexus] telemetry NOT started: ...` and the app runs normally.
- Verified against a real Express + pino project (traces, logs, auth header, undo). Not yet run on `mychap` itself, only dry-run.
