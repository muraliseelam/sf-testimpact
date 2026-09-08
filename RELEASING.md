# Releasing

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/). Pushing
to the default branch runs `.github/workflows/release.yml`, which lints, builds, tests, and
then — only if all three pass — determines the next version from the commit messages,
publishes to npm, tags the commit, and writes `CHANGELOG.md`.

**Current state:** `v0.1.0` is published to npm and tagged on the commit it was built from.
That first publish was done by hand; every release from here goes through the workflow.

## One-time setup

1. **`NPM_TOKEN` repository secret.** Create an npm **automation** token (Access Tokens →
   Generate New Token → Automation) on an account with publish rights to `sf-testimpact`, and
   add it at Settings → Secrets and variables → Actions → New repository secret.
   An automation token is required: a "publish" token with 2FA prompts cannot run unattended.
2. **Nothing else.** `GITHUB_TOKEN` is provided by Actions automatically, and the workflow
   requests the `contents: write` permission it needs to push the tag and changelog commit.

## How the version is chosen

From the Conventional Commit prefixes since the last tag:

| Commits since last release | Next version |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| any commit with `!` or a `BREAKING CHANGE:` footer | major |
| only `docs:`, `chore:`, `test:`, `refactor:` | **no release** |

`v0.1.0` is tagged, so each run releases only the commits since that tag.

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

Only if the workflow is broken and a release cannot wait.

1. `npm run check` — lint, build and the full test suite must pass.
2. `npm pack --dry-run` — confirm the file list, as above.
3. Set the version: `npm version <patch|minor|major> -m "chore(release): %s"`.
4. Update `CHANGELOG.md` by hand, keeping the generated format.
5. `npm publish --access public` — requires `npm login` first.
6. `git push --follow-tags`.

A manual release will leave semantic-release's view of history consistent as long as the tag
is `vX.Y.Z` and is pushed.

## Release checklist

- [ ] `npm run check` passes.
- [ ] `npm pack --dry-run` shows `oclif.manifest.json` and no `lib/bench/`.
- [ ] `README.md` benchmark figures still match `docs/measurements/`.
- [ ] The limitations table reflects the code as shipped.
- [ ] `NPM_TOKEN` is set (automated path only).
- [ ] The `semantic-release` label exists (forks only — see above).
