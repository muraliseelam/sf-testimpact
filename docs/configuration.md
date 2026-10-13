# Configuration

Configuration lives in `.sf-testimpact.yml` in the project root; `.sf-testimpact.yaml` is
also read if the `.yml` file does not exist. The file is optional, every key is optional,
and an empty file means "use the defaults".

**Unknown keys are rejected.** A typo in a safety setting, such as `maxReductionPct: 50`, must
not read as "no limit configured", so it stops the run with `CONFIG_INVALID` and lists the
valid keys. A value of the wrong type or outside its allowed values is rejected the same way.

**Changing this file makes the next analysis fall back.** It changes what is indexed and how,
so a change set that includes it runs the full suite (rule `project-config-changed`). Run
`sf testimpact index` after changing it, so the index reflects the new settings.

## Every key, with its default

```yaml
version: 1                    # optional; only 1 is accepted

sourcePaths: []               # default: packageDirectories from sfdx-project.json
alwaysRun: []
excludeFromImpact: []

maxReductionPercent: 95
onExceed: warn                # warn | fail | runAll

entryPointPolicy: full        # full | widen | strict

taint:
  onParseError: full          # full | widen
  dynamicApex: widen          # widen | full
  dynamicSoql: widen          # widen | full
  unmodelledFileType: full    # full | widen

fullTestLevel: RunLocalTests  # NoTestRun | RunSpecifiedTests | RunLocalTests | RunAllTestsInOrg
```

Each key is described below. The ones that trade safety for speed say exactly what they give
up.

## `version`

Optional. If present it must be `1`; any other value is rejected, so a file written for a
future format is not misread.

## `sourcePaths`

**List of paths, relative to the project root. Default: the `path` of every entry in
`packageDirectories` in `sfdx-project.json`.**

The directories to index. If this is empty and `sfdx-project.json` has no package
directories, `index` stops with `PROJECT_NOT_FOUND` rather than scan the whole repository.

> **Cover every directory that holds deployable metadata.** A changed file outside all
> source paths is treated as not being metadata at all, like a CI workflow or a README, and is
> ignored without a decision line. A source path that is too narrow therefore hides changes.

```yaml
sourcePaths:
  - force-app
  - unpackaged
```

## `alwaysRun`

**List of glob patterns. Default: none.**

Test classes to select on every run, matched against the test class's file path relative to
the project root. They appear in the output as `[always-run]`. Use this for tests that guard
something the graph cannot see, such as a security baseline or a smoke test.

```yaml
alwaysRun:
  - "**/SecurityBaselineTest.cls"
  - "**/*Smoke_Tests.cls"
```

Patterns are [picomatch](https://github.com/micromatch/picomatch) globs. They match forward
slashes, which is what git and the index use on every platform.

## `excludeFromImpact`

**List of glob patterns. Default: none.**

Changed files to ignore: a matching file contributes nothing to the analysis and cannot
force a fallback. It is matched against the changed file's path relative to the project
root, with forward slashes.

> **This is the one setting that can hide a real dependency.** It applies to any file,
> including Apex. Excluding a class means its changes select nothing. Use it only for files
> you are certain no test depends on.

```yaml
excludeFromImpact:
  - "**/*.md"
  - "force-app/main/default/layouts/**"
```

`sfdx-project.json` and `.sf-testimpact.yml` cannot be excluded; they are checked first.

## `maxReductionPercent`

**Number from 0 to 100. Default: 95.**

The circuit breaker. If a selection would skip more than this share of test classes,
[`onExceed`](#onexceed) decides what happens. It exists for the failure mode where a bug
collapses the graph and the tool reports "2 tests needed" for a 300-file change set. It is
not an optimiser and never adds tests to a selection.

An empty change set selects only `SeeAllData` and `alwaysRun` tests, so it usually exceeds
the limit. `analyze` reports an empty change set as such instead of as a reduction.

## `onExceed`

**`warn` | `fail` | `runAll`. Default: `warn`.**

| Value | Effect | Printed as |
| --- | --- | --- |
| `warn` | The selection stands. | `INFO max-reduction-exceeded-warn` |
| `fail` | The selection is discarded and the full suite runs. | `FALLBACK max-reduction-exceeded-fail` |
| `runAll` | The selection is discarded and the full suite runs. | `FALLBACK max-reduction-exceeded-run-all` |

`fail` and `runAll` have the same effect and differ only in the rule they print. Neither
changes the exit code. To make a fallback fail a CI job, pass `--fail-on-fallback` to
`analyze`.

## `entryPointPolicy`

**`full` | `widen` | `strict`. Default: `full`.**

What to do when a change reaches an [entry point](how-it-works.md#entry-points): a class the
platform or an outside caller can invoke without going through anything in your repository.

| Value | Effect | When to use it |
| --- | --- | --- |
| `full` | Run the full suite. | The safe default. On apex-recipes it fell back on 25 of 30 commits with real test outcomes. |
| `widen` | Also select the tests that reach every other entry point of the same kind. | The repository is the complete source of the org's Apex. |
| `strict` | Trust the graph. | You have verified that nothing outside the repository calls these classes. The only policy that can miss a test for a reason the tool can see. |

When `full` is the only reason for a fallback, `analyze` prints what `widen` would have
selected on your code, so you can judge the trade with your own numbers.
[Getting started](getting-started.md#5-choose-an-entry-point-policy) walks through the
decision.

## `taint.onParseError`

**`full` | `widen`. Default: `full`.**

What to do when a **changed** Apex file cannot be parsed.

| Value | Effect | Printed as |
| --- | --- | --- |
| `full` | Run the full suite: nothing is known about what the file references. | `FALLBACK changed-file-parse-failed` |
| `widen` | Treat the file as depending on every class, object and field, and continue. Still safe, and usually much faster. | `WIDEN changed-file-parse-failed-widened` |

An **unchanged** file that cannot be parsed is always treated as depending on everything,
whatever this setting says; `index` names every such file.

## `taint.dynamicApex`

**`widen` | `full`. Default: `widen`.**

What to do when a change activates the `apexType` taint domain and the project contains
dynamic Apex: `Type.forName`, `Type.newInstance`, `Callable.call`, `Database.executeBatch`,
`System.enqueueJob`, `System.schedule`, or a custom permission checked by a computed name.
[How it works](how-it-works.md#taint-code-the-graph-cannot-follow) explains the domains.

| Value | Effect | Printed as |
| --- | --- | --- |
| `widen` | Select the tests that reach every class holding such a construct. | `WIDEN taint-domain-activated-apexType` |
| `full` | Run the full suite instead. | `FALLBACK dynamic-apex-full`, naming the classes |

Any change to an Apex class activates `apexType`. Under `full`, a project with a single
`Type.forName` therefore falls back on almost every Apex change. Taint from a file that could
not be parsed does not count here; `taint.onParseError` governs that.

> Before 1.3.1 this key was accepted and documented but had no effect.

## `taint.dynamicSoql`

**`widen` | `full`. Default: `widen`.**

The same choice for the `sobjectAny` and `fieldAny` domains. A change to an object or field
activates them, and the constructs that taint them are dynamic SOQL (`Database.query`,
`Database.countQuery` and `Database.getQueryLocator` with or without binds), `Search.query`,
SOSL, `Schema.getGlobalDescribe`, and reading or writing an SObject field by name.

| Value | Effect | Printed as |
| --- | --- | --- |
| `widen` | Select the tests that reach every class holding such a construct. | `WIDEN taint-domain-activated-sobjectAny` / `-fieldAny` |
| `full` | Run the full suite instead. | `FALLBACK dynamic-soql-full`, once even when both domains activate |

> Before 1.3.1 this key was accepted and documented but had no effect.

## `taint.unmodelledFileType`

**`full` | `widen`. Default: `full`.**

What to do when a changed file is a type the tool does not model, such as a layout, an LWC
component, a DataWeave script or a named credential.

| Value | Effect | Printed as |
| --- | --- | --- |
| `full` | Run the full suite: the file's effect on tests is unknown. | `FALLBACK unmodelled-file-type` |
| `widen` | Do not analyse the file, and do not let it force a full run. | `INFO unmodelled-file-type-ignored`, naming the file |

> **`widen` here means "ignore".** Nothing in the graph depends on a type the tool does not
> model, so there is nothing to widen. Choose it only if changes to such files cannot break
> an Apex test in your project. To ignore only some unmodelled files, list them in
> [`excludeFromImpact`](#excludefromimpact) instead. Before 1.3.1, `widen` ignored the file
> without printing anything.

A modelled file that is missing from the index is a different case: it always falls back,
with `changed-file-not-in-index`, whatever this setting says.

## `fullTestLevel`

**`NoTestRun` | `RunSpecifiedTests` | `RunLocalTests` | `RunAllTestsInOrg`. Default:
`RunLocalTests`.**

The test level used whenever the run falls back. It is `analyze`'s `testLevel` and the
`--test-level` that `deploy` passes to `sf project deploy start`.

`RunAllTestsInOrg` also runs managed-package tests. `NoTestRun` makes every fallback deploy
without tests, which defeats the purpose of a fallback, and Salesforce allows it only for
non-production orgs. `RunSpecifiedTests` needs a list of tests, and a fallback has none. In
practice, choose `RunLocalTests` or `RunAllTestsInOrg`.

## Example configurations

**Conservative (the defaults).** No file needed. Most changes run the full suite, and every
reason is printed.

**The common choice for a project whose repository is the org's whole source:**

```yaml
entryPointPolicy: widen
alwaysRun:
  - "**/SecurityBaselineTest.cls"
```

**Tighter, for CI that should never silently ignore anything:**

```yaml
entryPointPolicy: widen
onExceed: runAll
taint:
  dynamicApex: full
```

With `onExceed: runAll`, a suspiciously large reduction runs everything. With
`dynamicApex: full`, any reach into dynamic Apex runs everything. Pair it with
`analyze --fail-on-fallback` if a fallback should stop the pipeline instead of running the
full suite.
