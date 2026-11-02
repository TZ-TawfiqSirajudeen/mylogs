# Runbook: release process (branches, commits, gates, tags)

How work reaches `main`. It is deliberately small: one branch per phase, one commit per feature, checks before every commit, and no history rewriting.

## Branches

* One branch per phase, named `phaseN-slug` (for example `phase1-4`, `phase5-db-collection`). Never commit directly to `main`.
* The first push of a branch is `git push --set-upstream origin <branch>`. Later pushes are plain `git push`.
* **Never** `--force` / `--force-with-lease` a shared branch, never amend or rebase commits that are already pushed, never delete a remote branch or push to `main` from a working branch. If history must be rewritten (for example to purge a leaked credential), that is a deliberate, announced operation by the repository owner, not part of a normal release.

## Commits

* One commit per feature (or per coherent fix or docs change), in Conventional Commit style: `feat(scope): ...`, `fix(scope): ...`, `test(...)`, `docs(...)`, `build(...)`, `ci(...)`, `chore(...)`.
* The body lists what changed and why, and says plainly what was **not** verified.
* Stage explicit paths (`git add <path>`); do not use `git add -A` or `git add .`. Check `git diff --cached --name-only` before committing.
* Do not commit work that belongs to someone else's unfinished change: if a file is also being edited for another feature, commit only your hunks or hold the file.

## Gates before every commit

1. **Secret scan of the staged diff.** `git diff --cached | grep -nEi 'AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|Bearer [A-Za-z0-9._-]{20,}|mongodb(\+srv)?://[^ <"/:]+:[^ @<"]+@'` must show only placeholders (`<user>`, `u:p`, `example.com` names, redaction-test fixtures). Also run `pnpm run scan:secrets`. A real credential means: unstage, do not commit, rotate it.
2. **Nothing generated or local is staged:** no `.env*` (only `.env.example`), `.dev-secrets/`, `.mongo-data/`, `node_modules/`, `dist/`, `coverage/`, `playwright-report/`, `test-results/`, `*.log`, key files, Collector binaries, or files over 5 MB.
3. **`pnpm typecheck`** is clean.
4. **Tests of every package the commit touches** pass: `pnpm --filter <pkg> test`, one package at a time (`pnpm test` runs them sequentially). Static checks for infra changes: `pnpm run test:infra`, `pnpm run check:containers`.
5. Syntax checks for anything that is not covered by the above (`node --check` for scripts, a YAML parse for workflows).

## Gates before merging to `main`

* A full `pnpm typecheck`, `pnpm test`, the four production builds and `pnpm run smoke:prod` pass.
* `pnpm e2e` (Playwright, whole stack) passes with the real OpenTelemetry Collector enabled (`OTELCOL_BIN`).
* CI is green on the pull request, with the exception of findings that are documented and owned (for example a known credential in history that is waiting for rotation). Do not weaken or allowlist a real finding to turn CI green.
* `docs/STATUS.md` states what is verified and what is not, with the commands and results.

## Pull request and tag

* One pull request per phase, branch to `main`, description summarising the commits and listing unverified items and open risks.
* After the full verification above, and only when the maintainer says so, tag the merge result `phaseN-complete` (annotated tag) and push the tag. Tags are never pushed as part of an ordinary commit/push.

## Secrets

* **Never commit `.env`**; it holds real credentials and is gitignored. Add new local-only files to `.gitignore` before creating them. Use `.env.example` with placeholders for documentation.
* A credential that reached a commit is compromised even if it is later removed: rotate it first ([credential-rotation.md](credential-rotation.md)), then decide separately whether to purge history.
