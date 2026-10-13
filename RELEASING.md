# Releasing

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/). Pushing
to the default branch runs `.github/workflows/release.yml`, which lints, builds, tests, and
then — only if all three pass — determines the next version from the commit messages,
publishes to npm, tags the commit, and writes `CHANGELOG.md`.

## Current state: 1.3.0 is ready and waits on one npmjs.com setting

**Where things stand on 2026-10-13.** Every commit for 1.3.0 is on `main`. npm is at 1.2.0.
The workflow now refuses to start a release unless npm accepts this repository's OIDC token
(the "Verify the npm Trusted Publishing exchange" step), and that exchange currently answers
`404 OIDC token exchange error - package not found`: **npm has no Trusted Publisher entry
matching this workflow.** Linking a GitHub account to the npm account is not that entry.

**The one thing to do.** On npmjs.com, open the `sf-testimpact` package → **Settings** →
**Trusted Publisher** → **GitHub Actions**, and enter exactly what the token carries:

| Field | Value |
| --- | --- |
| Organization or user | `muraliseelam` |
| Repository | `sf-testimpact` |
| Workflow filename | `release.yml` |
| Environment | leave blank |

Those four values are printed by the verify step on every run as `repository_owner`,
`repository`, `workflow_ref` and `environment`, so a mismatch can be read off the log.

**Then check without releasing.** Run the Release workflow by hand with the `oidc_check`
box ticked (Actions → Release → Run workflow), or:

```powershell
gh workflow run Release -f oidc_check=true
```

The log ends with either `npm exchange: HTTP 200` and "Trusted Publishing works", or the
404 and the field list above. Nothing is released by a check run.

**Then release.** Run the workflow again without the box (or `gh workflow run Release`).
It recomputes 1.3.0 from the commits since `v1.2.0`, writes the changelog and version bump,
tags, publishes through OIDC with a provenance attestation, and creates the GitHub release.

**Why the guard exists.** semantic-release commits the version bump and pushes the tag
*before* it publishes, so a publish failure leaves a tagged, unpublished release behind, and
the newest tag is what it treats as the last release: the next run then finds nothing to do.
That happened to 1.2.0 on 2026-09-09 and twice to 1.3.0 on 2026-10-12, each time undone by
deleting the tag and reverting the release commit. With the exchange verified first, a
misconfiguration fails the job before anything is written.

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

**What fixes it.** npm Trusted Publishing: GitHub mints a short-lived OIDC token for the
workflow run, npm verifies it came from this repository and this workflow, and no long-lived
secret is involved. The workflow no longer reads `NPM_TOKEN` at all — the token could not
publish anyway — so the secret can be deleted whenever convenient.

Until the Trusted Publisher entry exists, a push of a `feat:` or `fix:` commit to `main`
produces a run that fails at the verify step, with nothing committed and nothing tagged.
Documentation and `chore:` commits produce a run that fails the same way, which is noise but
not damage. Once the entry exists, every such push releases.

## How the version is chosen

From the Conventional Commit prefixes since the last tag:

| Commits since last release | Next version |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| any commit with `!` or a `BREAKING CHANGE:` footer | major |
| only `docs:`, `chore:`, `ci:`, `test:`, `refactor:` | **no release** |

`v1.3.0` is the current tag (unpublished — see the top of this file), so a run releases only
the commits since it.

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

- [ ] Trusted Publisher configured on npmjs.com for `muraliseelam/sf-testimpact`,
      workflow `release.yml` (one-time; see the top of this file).
- [ ] `npm run check` passes.
- [ ] `npm pack --dry-run` shows `oclif.manifest.json` and no `lib/bench/`.
- [ ] `README.md` benchmark figures still match `docs/measurements/`.
- [ ] The limitations table reflects the code as shipped.
- [ ] The `semantic-release` label exists (forks only — see above).
