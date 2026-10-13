# Troubleshooting and FAQ

Each problem below was hit in testing, by a person or a pipeline. The fix comes first, then
the reason.

## Installing

### `sf plugins install sf-testimpact` exits 13 and installs nothing

Add the plugin to the CLI's unsigned-plugin allowlist before installing:

```bash
mkdir -p ~/.config/sf
echo '["sf-testimpact"]' > ~/.config/sf/unsignedPluginAllowList.json
```

On Windows the file is `%LOCALAPPDATA%\sf\unsignedPluginAllowList.json`. The plugin is not
signed by Salesforce, so `sf` asks for confirmation. With no terminal to answer, as in CI, it
cancels with exit code 13 and prints nothing.

If it still exits 13 with the allowlist in place, check the path. The two paths differ by
platform, and a file at the wrong one is not read, so the install behaves exactly as if there
were no allowlist.

### Installing from a packed `.tgz` does not work

Passing the tarball's path to `sf plugins install` fails with "Invalid npm package name", and
the `file:` form exits 13 silently: the allowlist matches the package name, not a file path.
Install a published version instead, for example `sf plugins install sf-testimpact@1.3.1`.
This is how `sf` handles tarballs, not something this plugin controls.

## Analysing

### `Changed files: 0`

You are on the base branch, so there is nothing to compare. Check out your feature branch,
or pass both refs: `--base main --head my-branch`. The tool says this is not a reduction,
because nothing was selected away.

### `GIT_FAILED: Could not diff main...HEAD`

The base ref does not exist locally, or the clone is shallow and has no merge base. In CI,
clone with full history ([how](ci.md#check-out-the-full-history)). Locally, check the
branch name: a remote branch is `origin/main`, not `main`, unless you have a local `main`.

### Almost every change runs the full suite

Look at the `FALLBACK` lines; each names its rule. The usual one is
`entry-point-policy-full`, the conservative default. On the live apex-recipes window the
default ran everything on 25 of 30 commits, and `widen` on 11. If the output also says what
`entryPointPolicy: widen` would select, that number is
from your own code. [Getting started](getting-started.md#5-choose-an-entry-point-policy)
explains how to decide. The other common ones are unmodelled file types such as LWC and
layouts. [Rules](rules.md) covers each one and what to do.

### `changed-file-not-in-index`

Run `sf testimpact index` on your branch before `analyze`, so files the branch adds are in
the index. If the file was deleted on the branch, the fallback is intended: nothing records
what depended on a file that no longer exists, so everything runs.

### Every analysis falls back with `graph-stale-*` after an upgrade

Run `sf testimpact index`. The index was written by a different build of the plugin. Since
1.3.1, `index` detects that and re-parses every file; before that it needed `--force`.

### `CONFIG_INVALID: Unknown config key`

A key in `.sf-testimpact.yml` is misspelled. The message lists the valid keys. Unknown keys
are rejected on purpose: a typo in a safety setting must not silently turn it off.

### A test I expected is not selected

Check, in order:

1. Is the changed file inside your [source paths](configuration.md#sourcepaths)? Changes
   outside them are ignored.
2. Is it matched by [`excludeFromImpact`](configuration.md#excludefromimpact)?
3. Does the test reach the changed code through something the tool cannot see: a Flow, a
   managed package, a reflection helper of your own, or org data? See
   [limitations](limitations.md).
4. Is the sfdx project in a subdirectory of its git repository, and the plugin older than
   1.3.1? Those versions read git's paths from the repository root, missed every change, and
   selected only `SeeAllData` and `alwaysRun` tests. Upgrade.

If none of these explains it, it may be a missing edge, which is the most serious kind of bug
this tool can have. Please [report it](https://github.com/muraliseelam/sf-testimpact/issues)
with the two classes involved.

### The fallback line lists "and N more (full list in `--json`)"

The message stops after eight names so it stays readable on a large project.
`analyze --json` lists every one in `decisions[].subjects`, since 1.3.1.

## Deploying

### `Nonexistent flag: --source-dir` (or any other `sf project deploy start` flag)

Put flags meant for `sf project deploy start` after `--`:

```bash
sf testimpact deploy --base main --target-org my-org -- --manifest delta/package/package.xml
```

Flags before `--` must be `deploy`'s own; anything else is rejected with exit code 2.

### `CONFIG_INVALID: Unexpected argument`

Something that is not a flag came before `--`, such as `force-app` in
`sf testimpact deploy --base main force-app`. `deploy` takes no arguments. Put flags for
`sf project deploy start`, with their values, after `--`. Before 1.3.1 the argument was
forwarded to `sf project deploy start` instead of being reported.

### A flag repeated after `--` arrives as `--source-dir --source-dir A B`

Upgrade to 1.3.1. Earlier versions took the passthrough from the CLI framework's parsed
arguments, which it sorts by where each token first appears on the command line. A flag given
twice lost its pairing with its values, and a token also used before `--`, such as
`--dry-run`, moved to the front.

### Many classes fail "Test coverage of selected Apex Class is 0%"

The deployment contains classes you did not change, typically from `--source-dir force-app`.
Under `RunSpecifiedTests` every class in the deployment needs 75% coverage from the tests that
run, and the selection only answers for the classes that changed. Deploy only the change, with
a tracked deploy or a delta manifest; see [CI integration](ci.md#deploy-with-the-selected-tests).

### `COVERAGE_BLOCKED` from `--verify-coverage`

A changed class sits below 75% in the org's last recorded coverage, or has no coverage data.
Add tests for it. If the org simply has no coverage data yet, run its tests once with
coverage: `sf apex run test --target-org <org> --test-level RunLocalTests --code-coverage`.

### `--verify-coverage` warns about test classes "that this repository does not"

The org has test classes the repository does not. Under `RunLocalTests` they contribute
coverage; under `RunSpecifiedTests` they do not, so the selection's coverage guarantee does
not hold for that org. Either bring those tests into the repository, or deploy to that org with
`RunLocalTests`.

### A path with a space in it fails on Windows

Upgrade to 1.3.1. Earlier versions handed arguments to `sf` through a Windows shell without
quoting, so `classes/Collection Recipes/X.cls` arrived as two paths.

## FAQ

### Does `analyze` contact my org?

No. `index` and `analyze` read only your files and git history. `deploy` runs
`sf project deploy start`, and `--verify-coverage` queries the org's Tooling API; those are
the only parts that contact an org.

### Is it safe to skip the tests it does not select?

It is designed to be conservative, and it says why whenever it is: anything it cannot
analyse makes it select more tests or run them all. But "designed to be" is not "shown to
be". The one live measurement found no missed regression over 30 commits, and it had only two
regressions to find. [Limitations](limitations.md) lists every way selection can be wrong,
including two where it would be wrong without saying so: org-only tests, and dynamic dispatch
it does not recognise. Read that page before relying on the tool for production.

### Why does it run everything by default?

Because a tool that skips tests should earn that. Under the default
`entryPointPolicy: full`, a change that reaches any class the platform can invoke from
outside your repository runs the full suite. You opt in to `widen` once you have checked
that nothing outside the repository calls those classes, and `analyze` tells you what you
would gain, measured on your code.

### How is this different from Salesforce's `RunRelevantTests`?

`RunRelevantTests` is a test level in beta in recent Salesforce releases. Salesforce chooses
the tests at deploy time, from the deployment payload and its dependencies, and you can
annotate test classes to always run in certain conditions. `sf-testimpact` chooses before the
deploy, from your repository, and works with the long-established `RunSpecifiedTests`. Its
differences:

- It runs offline, so a pull request can show which tests a change affects without an org.
- Every decision is printed with the rule that made it, and is available as JSON for CI to
  branch on.
- When it cannot see something, it falls back to the full suite and says so.
- It can verify an org's coverage and look for org-only tests before deploying.

This page makes no claim about how the two compare in accuracy; nobody has measured that.

### Does a change to a Flow or permission set select tests?

No, and that is a known gap. Their edges point to the Apex they use, and the analysis walks
the other way, so nothing depends on them. See [limitations](limitations.md), items 8, 13
and 19.

### Does it run LWC Jest tests?

No. It selects Apex tests. LWC changes are not modelled, so they make the run fall back
unless you ignore them with `taint.unmodelledFileType: widen` or `excludeFromImpact`.

### Should I commit the index?

Usually not: it is a generated file every branch would conflict on. Cache it in CI instead
([how](ci.md#cache-the-index)). If you do commit it, below 8 MB it is plain JSON and diffs in
review. Above that it is gzipped.

### What if my project uses a namespace?

The namespace comes from `sfdx-project.json` and is used for every class the repository
declares. One namespace per project is supported. Classes from other namespaces, such as
managed packages, are recorded as external: a change to them cannot appear in your diff.

### Can I call it from code instead of the CLI?

Yes. The package exports the indexer, the analysis and the JSON report; see
[programmatic API](api.md).
