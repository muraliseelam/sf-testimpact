# Releasing

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/). Pushing
to the default branch runs `.github/workflows/release.yml`, which lints, builds, tests, and
then — only if all three pass — determines the next version from the commit messages,
publishes to npm, tags the commit, and writes `CHANGELOG.md`.

## Current state: the automated publish is broken until Trusted Publishing is switched on

**What happened.** The release run for 1.2.0 on 2026-09-09
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
secret is involved. The workflow side has been ready since before 1.2.0; the remaining step is
one setting on npmjs.com that only the package owner can make:

1. Open the `sf-testimpact` package on npmjs.com → **Settings** → **Trusted Publisher**.
2. Choose **GitHub Actions** and enter:
   - Organization or user: `muraliseelam`
   - Repository: `sf-testimpact`
   - Workflow filename: `release.yml`
   - Environment: leave blank
3. Save.

The next push of a `feat:` or `fix:` commit to `main` then releases through OIDC. Until that
setting exists, every such push produces a failed release run and an auto-filed issue
labelled `semantic-release`, which is noise rather than damage: nothing is published and the
next successful run releases everything accumulated since the last tag.

**Why the workflow does not need to change for the cutover.** `@semantic-release/npm` tries
OIDC first. Today it logs `OIDC token exchange with the npm registry failed: 404 - package not
found` — npm's way of saying no trusted publisher is configured — and falls back to the token,
which then fails on `EOTP`. Once the publisher is configured the exchange succeeds and the
token is never consulted. The workflow's preflight step reports which path is live on every
run, and warns rather than fails when the token is present but unusable, so a stale secret
cannot block an OIDC release.

**After the first OIDC release succeeds**, delete the `NPM_TOKEN` repository secret and remove
the `NPM_TOKEN` lines from `release.yml`. Not before: the preflight output on that run is the
evidence that OIDC worked.

## How the version is chosen

From the Conventional Commit prefixes since the last tag:

| Commits since last release | Next version |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| any commit with `!` or a `BREAKING CHANGE:` footer | major |
| only `docs:`, `chore:`, `ci:`, `test:`, `refactor:` | **no release** |

`v1.2.0` is the current tag, so the next run releases only the commits since it.

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
  file: it writes its own `.npmrc` from `NPM_TOKEN` or the exchanged OIDC token and passes it
  to every npm command it runs.
- The preflight step distinguishes the cases before semantic-release starts: no token means
  "relying on Trusted Publishing"; a token that `npm whoami` rejects is a warning, not a
  failure, for the reason above.

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
