# Releasing

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/). Pushing
to the default branch runs `.github/workflows/release.yml`, which lints, builds, tests, and
then — only if all three pass — determines the next version from the commit messages,
publishes to npm, tags the commit, and writes `CHANGELOG.md`.

## Current state: releases publish through Trusted Publishing, with provenance

**1.3.0 was published on 2026-10-13 by the Release workflow**
([run 38337654488](https://github.com/muraliseelam/sf-testimpact/actions/runs/38337654488))
through npm Trusted Publishing: no token, an SLSA provenance attestation
(`https://slsa.dev/provenance/v1`), and verified registry signatures. It is the first release
since 0.1.0 to reach npm from the workflow. There is no `NPM_TOKEN` secret any more, and the
workflow does not read one.

**The Trusted Publisher entry**, as `npm trust list sf-testimpact` shows it:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Repository | `muraliseelam/sf-testimpact` |
| Workflow file | `release.yml` |
| Environment | none |
| Permissions | publish, stage publish |

**The permission is the part that is easy to get wrong.** An entry with the right
repository and workflow that grants only *stage publish* is answered by the token exchange
with exactly the same `404 OIDC token exchange error - package not found` as no entry at all.
That is what blocked the first two 1.3.0 attempts after an entry had been created on the
website. The entry was replaced from the command line, which needs the package owner to be
logged in (`npm login`) and approves each change with two-factor authentication in the
browser:

```powershell
npm trust list sf-testimpact
npm trust revoke sf-testimpact --id=<id from the list>
npm trust github sf-testimpact --file release.yml --repo muraliseelam/sf-testimpact --allow-publish --allow-stage-publish --yes
```

On Windows PowerShell with script execution disabled, call `npm.cmd` instead of `npm`.

**Check without releasing.** Run the Release workflow by hand with the `oidc_check` box ticked
(Actions → Release → Run workflow), or:

```powershell
gh workflow run Release -f oidc_check=true
```

The log prints the token's claims and the exchange's HTTP status. A working setup answers
**201**, and the step says "Trusted Publishing works". Nothing is released by a check run.

**Why the workflow verifies the exchange before releasing.** semantic-release commits the
version bump and pushes the tag *before* it publishes, so a publish failure leaves a tagged,
unpublished release behind, and the newest tag is what it treats as the last release: the
next run then finds nothing to do. That happened to 1.2.0 on 2026-09-09 and twice to 1.3.0 on
2026-10-12, each time undone by deleting the tag and reverting the release commit. The
"Verify the npm Trusted Publishing exchange" step now mints the same OIDC token, exchanges it,
and fails the job before semantic-release unless npm answers with a 2xx, so a broken setup
costs one failed run and leaves nothing behind.

**What happened the first time.** The release run for 1.2.0 on 2026-09-09
([run 34411638267](https://github.com/muraliseelam/sf-testimpact/actions/runs/34411638267))
built, tested and packed correctly, then failed at `npm publish`:

```
npm error code EOTP
npm error This operation requires a one-time password.
```

npm now requires a one-time password for publishes made with the kind of token `NPM_TOKEN`
holds (the same run printed npm's notice that *"tokens that bypass 2FA are being restricted
for account changes and direct publishing"*). A token that needs a one-time password cannot
publish from an unattended workflow, so **the `NPM_TOKEN` path can no longer release anything,
and no new token of that kind can fix it.**

1.2.0 was then published by hand from a workstation two minutes later, and the GitHub release
and tag were created. The published tarball is the same version and file list as the one CI
built, but it is a different build: its shasum differs from the one in the CI log and it
carries no provenance attestation, because it was not published from the workflow.

**What fixed it.** npm Trusted Publishing: GitHub mints a short-lived OIDC token for the
workflow run, npm verifies it came from this repository and this workflow, and no long-lived
secret is involved. The `NPM_TOKEN` repository secret was deleted on 2026-10-13 after 1.3.0
published without it. The npm token it held still exists on the npm account until it is
revoked there (npmjs.com → Access Tokens); nothing in this repository uses it.

If the Trusted Publisher entry is ever removed or loses the publish permission, a push of a
`feat:` or `fix:` commit to `main` produces a run that fails at the verify step, with nothing
committed and nothing tagged.

## How the version is chosen

From the Conventional Commit prefixes since the last tag:

| Commits since last release | Next version |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| any commit with `!` or a `BREAKING CHANGE:` footer | major |
| only `docs:`, `chore:`, `ci:`, `test:`, `refactor:` | **no release** |

`v1.3.0` is the current tag and the current npm version, so a run releases only the commits
since it.

## Release branch

`main` is the only release branch, and the only branch this workflow triggers on.

The repository briefly carried an identical `master` alongside it. That was a live hazard,
not untidiness: the workflow triggered on both, and its concurrency group was keyed on
`github.ref`, so a push landing on both branches produced two groups that did not serialise
and two semantic-release runs racing to publish the same version. `master` has been deleted
and the group is now a single repository-wide `release`.

## The `semantic-release` label is a prerequisite

When a release fails, `@semantic-release/github` opens an issue labelled `semantic-release`.
If that label does not exist in the repository, the API call fails:

```
422 Validation Failed: {"value":"semantic-release","resource":"Label","field":"name","code":"invalid"}
```

That error is reported *instead of* the real one, which hides why the release actually broke.
The label exists here now. **A fork must create it**, or its first failed release will report
this instead of its true cause:

```powershell
gh label create semantic-release --color d4c5f9 --description "Automated release failure reports"
```

## What the workflow does about npm authentication

- `permissions: id-token: write` on the release job, so `@semantic-release/npm` can request
  the GitHub OIDC token.
- npm is raised to `^11` before `npm ci`. The OIDC exchange needs npm >= 11.5.1, and an older
  npm fails it in a way that looks like a bad token. Given this project has already lost
  release runs to misdiagnosed token errors, that trap is removed explicitly.
- `actions/setup-node` is used **without `registry-url`**. With it, setup-node writes an
  `.npmrc` whose auth line reads `_authToken=${NODE_AUTH_TOKEN}`, and npm 11 substitutes an
  *unset* variable with the literal text `${NODE_AUTH_TOKEN}`, which it would then send to the
  registry as a bearer token on every request — including `npm ci`. setup-node v4 masked this
  by exporting a dummy value; v7 stopped doing so. `@semantic-release/npm` never needed that
  file: it writes its own `.npmrc` from the exchanged OIDC token and passes it to every npm
  command it runs.
- The verify step mints the same OIDC token `@semantic-release/npm` would, prints the claims
  the npmjs.com form has to match, exchanges it with the registry, and fails the job before
  semantic-release unless the registry answers 200. With `oidc_check=true` on a manual run it
  reports and stops without releasing.

## Verifying a release candidate locally

```powershell
npm run check; npm pack --dry-run
```

`npm pack` runs `prepack`, which wipes `lib/`, rebuilds, and generates `oclif.manifest.json`;
`postpack` removes the manifest again. Check the file list contains `oclif.manifest.json` and
does **not** contain `lib/bench/` or any `.map` files.

To see what semantic-release would do without publishing:

```powershell
npx semantic-release --dry-run --no-ci
```

## Manual release (fallback)

Only if the workflow is broken and a release cannot wait. This is how 1.2.0 shipped; a
manually published tarball has no provenance attestation, so it is a fallback, not a habit.

1. `npm run check` — lint, build and the full test suite must pass.
2. `npm pack --dry-run` — confirm the file list, as above.
3. Set the version: `npm version <patch|minor|major> -m "chore(release): %s"`.
4. Update `CHANGELOG.md` by hand, keeping the generated format.
5. `npm publish --access public` — requires `npm login` first.
6. `git push --follow-tags`.

A manual release will leave semantic-release's view of history consistent as long as the tag
is `vX.Y.Z` and is pushed.

## Release checklist

- [ ] `npm trust list sf-testimpact` shows the GitHub Actions entry for
      `muraliseelam/sf-testimpact`, workflow `release.yml`, with the **publish** permission
      (configured 2026-10-13; see the top of this file). `gh workflow run Release -f
      oidc_check=true` confirms it without releasing.
- [ ] `npm run check` passes.
- [ ] `npm pack --dry-run` shows `oclif.manifest.json` and no `lib/bench/`.
- [ ] `README.md` benchmark figures still match `docs/measurements/`.
- [ ] The limitations table reflects the code as shipped.
- [ ] The `semantic-release` label exists (forks only — see above).
