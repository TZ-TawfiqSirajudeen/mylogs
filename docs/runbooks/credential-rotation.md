# Runbook: rotate the exposed MongoDB Atlas credentials and purge them from git history

**For a human to perform.** Nothing in this runbook has been performed by the tooling that wrote it (no Atlas access, no history rewrite, no push).
Do the steps **in this order**: rotate first (it makes the leaked value useless), then clean the repository, then prove it with the scanner.

## 0. What is exposed, and why this is urgent

`node infra/scripts/scan-secrets.mjs` (offline, values never printed) found, in the **git history**:

| Where | Commit | Rule | Fingerprint |
|---|---|---|---|
| `docker-compose.yml:17` | `7629819` ("first commit") | MongoDB URI with embedded password (an Atlas `mongodb+srv://` string) | `3b612c75a7b5` |
| `apps/api/src/config.test.ts:7` | `7629819` | the same value | `3b612c75a7b5` |

The working-tree versions of both files no longer contain it (`node infra/scripts/scan-secrets.mjs --tree` passes), but **commit `7629819` is on
`origin/main`** (`git branch -r --contains 7629819`), so it is on the remote and in every clone and fork made since. Treat the password as compromised.

The scanner cannot read your gitignored root `.env` (by design) and the tooling never opened it. You mentioned **two** Atlas database users: one is in the
URI above; **the other is whichever user your local `.env` uses**. Rotate both. In Atlas: *Database Access* lists every user; the `username` in a connection
string is the first part after `mongodb+srv://`.

Also confirm `.env` and `.dev-secrets` never entered history (prints file names only, no content):
```bash
git log --all --diff-filter=A --name-only --format= -- '.env' '.env.*' '*.dev-secrets*' '*kek.json' | sort -u     # expect no output except .env.example
```

## 1. Rotate both Atlas database-user passwords (Atlas UI; do this first)

For **each** of the two users:

1. Atlas → your project → **Database Access** → the user → **Edit** → **Edit Password** → **Autogenerate Secure Password** (or paste one from your password manager) → **Copy**.
2. Store the new password in your password manager **before** clicking **Update User**.
3. **Update User**. Atlas applies it within about a minute; the old password stops working.
4. If the user has broad roles (for example `atlasAdmin` or "Read and write to any database"), replace them with the least-privilege roles in
   [mongodb-roles.md](mongodb-roles.md) in the same edit. If the exposed user was an admin user, create a dedicated platform user and retire the admin one instead.
5. If a password contains characters such as `@ : / ? # [ ] %`, **URL-encode** them inside the URI (`@` becomes `%40`), or choose a password without them.

Use the UI rather than `atlas dbusers update --password ...`: a command-line password lands in shell history.

Then, still in Atlas:
* **Project → Activity Feed / Database Access history** and **Cluster → Metrics / Real-time → connections**: look for logins or connections from addresses you do not recognise
  since the commit date. Atlas **Network Access**: remove `0.0.0.0/0` (allow from anywhere) if present and keep only your machines' addresses; a leaked password is much less useful behind an allow-list.
* If any unrecognised access is possible, treat the data in that cluster as disclosed and follow your incident process.

## 2. Update `.env` locally (and every other place the old URI lives)

1. Open the gitignored root `.env` **in an editor** (do not `echo >>` it, do not paste it into a terminal, chat or ticket) and replace the password in `MONGODB_URI`.
2. Anywhere else the old value could be: your platform secret manager, CI secrets, a deployed environment, shell profile / history, a password-manager note that still holds the old one, saved Compass / mongosh connections, other machines' `.env`.
3. Check it works without printing it: `pnpm dev:api`, then `curl -s http://localhost:4000/healthz` (and `/readyz` if enabled). The API logs "authentication failed" if the password is wrong.
4. Optional proof the old password is dead: from a private shell, try the **old** URI with `mongosh` (copy it from your own notes, not from this repo's history). Expected: `Authentication failed`. Never write the old value into a file in this repository.

## 3. Purge the secret from git history

Rotation made the leaked value useless; purging stops it being discovered and keeps scanners quiet. Plan a short freeze: nobody pushes during steps 3.2 to 3.6.

### 3.1 Prepare

* Back up your working copy including uncommitted work (this repository currently has a lot of it on branch `phase1-4`): copy the folder, excluding `node_modules`.
* Install `git-filter-repo` (`pip install git-filter-repo`; needs Git >= 2.36) or Java + BFG (<https://rtyley.github.io/bfg-repo-cleaner/>).
* Tell collaborators now (see 3.6) and, if branch protection is on, allow force-pushes to `main` temporarily (Settings → Branches).
* Work in a **fresh mirror clone**, not in your working copy:
  ```bash
  git clone --mirror https://github.com/TZ-TawfiqSirajudeen/mylogs.git mylogs-purge.git
  cd mylogs-purge.git
  ```

### 3.2 Rewrite (option A, recommended: git filter-repo)

`replacements.txt` holds the **old** password, so keep it **outside** any repository, make it with an editor, and delete it afterwards (`shred -u` / secure delete). One line, literal text:
```
<OLD PASSWORD>==>***REMOVED***
```
```bash
git filter-repo --replace-text ../replacements.txt
```
This rewrites every commit that contained the string, in every file, and so changes every commit hash from the first affected commit on. (`git filter-repo --sensitive-data-removal` is also available in recent versions and removes more traces: read `git filter-repo --help` for your version.)
To remove a whole file from history instead: `git filter-repo --invert-paths --path <file>`.

### 3.2 (option B: BFG)

BFG **protects the current `HEAD` commit by default**, and here the secret is in the tip of `main`. First commit a clean version of the two files to `main` (or use filter-repo, which has no such limit), then:
```bash
bfg --replace-text ../replacements.txt mylogs-purge.git
```

### 3.3 Expire the old objects in the mirror

```bash
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

### 3.4 Verify BEFORE pushing

```bash
git rev-list --all | wc -l                                      # still has your history
git cat-file -t 7629819                                         # "fatal: Not a valid object name" (hash changed)
git clone . ../verify-clone && cd ../verify-clone && git checkout main
node infra/scripts/scan-secrets.mjs --history                   # needs the script: see 6; expect PASS and fingerprint 3b612c75a7b5 gone
```
(The mirror/clone has no `infra/scripts/` until that file exists on the branch you check out; after the rewrite it is whatever your history contains. If it is absent, run the script from your working copy: `node <working-copy>/infra/scripts/scan-secrets.mjs` from inside the clone, which scans the clone's repository.)

### 3.5 Force-push

filter-repo removes the `origin` remote on purpose:
```bash
git remote add origin https://github.com/TZ-TawfiqSirajudeen/mylogs.git
git push --force --mirror origin        # rewrites ALL refs (branches and tags). Use --all / --tags separately if you only want some refs.
```
Implications: every commit hash changes; open pull requests and their review comments detach; protected-branch rules may block it until relaxed; releases or tags pointing at old commits must be recreated;
GitHub keeps pull-request refs (`refs/pull/*`) and **cached views** of the old commits reachable by their URLs even after the force-push.

### 3.6 GitHub-side cleanup, collaborators, your own working copy

1. **GitHub Support:** open a ticket (<https://support.github.com/contact>, "Remove sensitive data from a repository" / cached views and pull-request references), give the repository, the **old commit hash**
   (`7629819...`) and ask them to purge cached views and `refs/pull/*` references and to run garbage collection. This is the only way to remove what a force-push cannot (GitHub documents this in "Removing sensitive data from a repository").
2. **Secret-scanning alerts** (Settings → Code security): resolve any alert for this value as *Revoked* (it is, after step 1). Switch on **secret scanning** and **push protection** for the repository.
3. **Forks and clones:** anyone who cloned or forked before the rewrite still has the secret. Tell collaborators to **delete their clones and re-clone**; do **not** `git pull`/merge into old clones, which re-introduces the old history.
   Forks are separate repositories: ask their owners to delete them, or contact GitHub Support for forks you do not control.
4. **Your own working copy** (branch `phase1-4`, with uncommitted work). Do not delete it; move it onto the new history without touching the files:
   ```bash
   git fetch origin
   git reset --mixed origin/main        # branch pointer moves to the rewritten history; the working tree and your uncommitted changes stay as they are
   git reflog expire --expire=now --all && git gc --prune=now --aggressive
   git status                           # your edits show as modifications against the rewritten base
   ```
   If your branch had commits beyond `main`, rebase them instead: `git rebase --onto origin/main <old-main-hash> phase1-4` (old hash from your backup/`git reflog`).
5. Rotate again if there is any doubt that the **new** password ever touched a file or terminal that was shared.

## 4. Verify with the scanner (and keep verifying)

Run all of these in the **updated** working copy / a fresh clone; none prints a secret:
```bash
node infra/scripts/scan-secrets.mjs --tree          # working tree (tracked + untracked, honours .gitignore): expect PASS
node infra/scripts/scan-secrets.mjs --history       # every commit of every ref (git log -p --all): expect PASS; before this runbook it reported 2 findings with fingerprint 3b612c75a7b5
node infra/scripts/scan-secrets.mjs                 # both
pnpm run test:infra                                 # the scanner's own tests
```
Optional second opinion with gitleaks (needs Docker): `docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.21.2 git /repo --config /repo/.gitleaks.toml --log-opts=--all --redact --no-banner`.

The CI job **Secret scan (working tree + full history)** (`.github/workflows/ci.yml`) runs the offline scanner and gitleaks on every push and pull request. Until step 3 is finished it **fails on this history by design**.
A reviewed false positive is allow-listed by fingerprint in `infra/scripts/secret-scan-allowlist.json` (no values stored); a real credential is never allow-listed.
The scanner does not read your gitignored `.env`: for that file, rely on step 2 and on never committing it (`.gitignore` and `.dockerignore` exclude it; the CI image job plants a canary `.env` and fails if it reaches an image).

## 5. Prevent a repeat

* Optional local guard: `printf '#!/bin/sh\nnode infra/scripts/scan-secrets.mjs --tree || exit 1\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit` (a hook is local; CI is the enforcement).
* `docker-compose.yml` now defaults `MONGODB_URI` to the bundled `mongo` service; keep any hosted-cluster URI only in the gitignored `.env` or your secret manager.
* Production secrets come from the platform secret manager ([deployment.md](../deployment.md)); rotate the key-encryption key by [secrets-and-kek-rotation.md](secrets-and-kek-rotation.md).
* Record in your change log: rotation date, who, both usernames (not passwords), purge date, Support ticket number, and when collaborators confirmed re-cloning.
