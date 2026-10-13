# Commands

| Command | What it does | Contacts an org |
| --- | --- | --- |
| [`sf testimpact index`](#sf-testimpact-index) | Builds or updates the dependency graph in `.sf-testimpact/` | No |
| [`sf testimpact analyze`](#sf-testimpact-analyze) | Reports which test classes a change set can affect | No |
| [`sf testimpact deploy`](#sf-testimpact-deploy) | Runs `sf project deploy start` with only those tests | Yes |

`sf testimpact` with no subcommand is the same command as `sf testimpact index`.

The sections below cover behaviour that is not visible in each command's flags: exit codes,
the `--json` contract, and what `deploy` decides. The flag reference at the end is generated
from the commands themselves.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command ran. **This includes a fallback to the full suite**, which is a valid answer, not an error. |
| `1` | A hard failure, such as an invalid config, a git ref that does not exist, a missing or corrupt index, or a coverage blocker. Also `analyze --fail-on-fallback` when a fallback fired, and `deploy` given an argument before `--`, which it reports as `CONFIG_INVALID`. |
| `2` | The command line itself was wrong: an unknown flag, or a required flag missing. |

`deploy` exits with the code of `sf project deploy start` when the deploy runs and fails.

Nothing turns a fallback into a non-zero exit except `--fail-on-fallback`. In particular
`onExceed: fail` means "discard the selection and run everything", not "fail the process".

These come from real runs ([transcript](measurements/docs-sample-project.txt)), where
`[exit N]` is the exit code the shell reported:

```
$ sf testimpact analyze --base main --fail-on-fallback
...
Running the full suite (RunLocalTests). See the FALLBACK lines above.
[exit 1]

$ sf testimpact analyze --base main --source-dir force-app
Error (2): Nonexistent flag: --source-dir
See more help with --help
[exit 2]
```

## JSON output

Every command accepts `--json`. Progress goes to stderr, so stdout holds only the JSON. `sf`
wraps the result in an envelope:

```json
{
  "status": 0,
  "result": { },
  "warnings": []
}
```

`status` is the exit code, so with `--fail-on-fallback` a fallback reports `"status": 1`.

On a hard error the envelope carries the error instead of a result. `code` is the stable
error code, and `actions` is the suggested fix. Every code is listed in
[rules and error codes](rules.md#error-codes).

```json
{
  "name": "TestImpactError",
  "message": "Could not diff no-such-branch...HEAD.",
  "exitCode": 1,
  "actions": [
    "Check that both refs exist here. In CI this usually means the clone is shallow: actions/checkout defaults to fetch-depth 1, which has neither the base branch nor a merge base. Set fetch-depth: 0, or fetch the base ref unshallowed."
  ],
  "code": "GIT_FAILED",
  "status": 1,
  "commandName": "TestImpactAnalyze"
}
```

The envelope also carries `context`, `warnings`, and for debugging `stack` and `cause`; those
are omitted above.

### `analyze --json`

The `result` is a public contract, versioned by `schemaVersion`. A breaking change bumps the
version; within a version, fields are only ever added. A consumer that finds a
`schemaVersion` it does not recognise should stop rather than guess.

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | number | Currently `1`. |
| `toolVersion` | string | The plugin version that wrote the index. |
| `outcome` | `"selected"` or `"full"` | `"full"` means a fallback fired and every test runs. |
| `fellBack` | boolean | `true` exactly when `outcome` is `"full"`. **Branch on this**, not on `tests.length`. |
| `testLevel` | string | `RunSpecifiedTests` when selected, even if `tests` is empty; the configured [`fullTestLevel`](configuration.md#fulltestlevel) on a fallback. With an empty selection, `deploy` uses `NoTestRun`; a script that deploys from this JSON should do the same. |
| `tests` | `{name, reason}[]` | The selected test classes. Empty on a fallback. `reason` is `impacted`, `see-all-data` or `always-run`. |
| `selectedCount` | number | `tests.length`. |
| `totalTests` | number | Test classes in the index. |
| `reductionPercent` | number | Share of test classes not selected, rounded to two places. `0` on a fallback. |
| `decisions` | `{level, rule, subject, subjects, message, hint}[]` | Every rule that fired, in order. `level` is `fallback`, `widen` or `info`. `subjects` lists every file or class the rule fired on; `subject` is the first. `hint` is a string or `null`. See [rules](rules.md). |
| `activatedTaintDomains` | string[] | The [taint domains](how-it-works.md#taint-code-the-graph-cannot-follow) that activated. |
| `coverageGaps` | string[] | Changed Apex classes that no test reaches. Under `RunSpecifiedTests` each will fail the 75% rule whatever is selected. |
| `counterfactual` | object or `null` | What `entryPointPolicy: widen` would have selected, present only when `entry-point-policy-full` was the only reason for the fallback. Fields: `policy`, `wouldSelect`, `totalTests`, `reductionPercent`, `assumesNoExternalCallerOf`. |
| `range` | `{base, head}` | The refs compared. |
| `changedFiles` | number | Files in the change set. |
| `graph` | `{nodes, edges, createdAt, indexedFiles}` | The index the analysis used. |

`decisions[].subjects` was added in 1.3.1. Before that, the full list of impacted entry points
appeared only in `counterfactual`, and only when it was offered.

A real `analyze --json` output, verbatim from the
[transcript](measurements/docs-sample-project.txt): the sample project with one class
changed and no configuration.

```json
{
  "status": 0,
  "result": {
    "schemaVersion": 1,
    "toolVersion": "1.3.0",
    "outcome": "full",
    "testLevel": "RunLocalTests",
    "tests": [],
    "selectedCount": 0,
    "totalTests": 3,
    "reductionPercent": 0,
    "decisions": [
      {
        "level": "fallback",
        "rule": "entry-point-policy-full",
        "subject": "AccountTrigger",
        "subjects": [
          "AccountTrigger"
        ],
        "message": "AccountTrigger is an entry point (trigger), so its callers may live outside this repository and the graph’s inbound edges to it are incomplete.",
        "hint": "`entryPointPolicy: widen` selects only the tests that reach an entry point of the same kind. Faster, but it assumes no unindexed caller reaches this class."
      },
      {
        "level": "widen",
        "rule": "taint-domain-activated-apexType",
        "subject": "PricingService",
        "subjects": [
          "PricingService"
        ],
        "message": "Taint domain `apexType` activated because PricingService is impacted. Classes with unresolvable references into that domain are selected too.",
        "hint": null
      }
    ],
    "counterfactual": {
      "policy": "widen",
      "wouldSelect": 3,
      "totalTests": 3,
      "reductionPercent": 0,
      "assumesNoExternalCallerOf": [
        "AccountTrigger"
      ]
    },
    "fellBack": true,
    "activatedTaintDomains": [
      "apexType"
    ],
    "coverageGaps": [],
    "range": {
      "base": "main",
      "head": "HEAD"
    },
    "changedFiles": 1,
    "graph": {
      "nodes": 18,
      "edges": 18,
      "createdAt": "2026-10-13T03:51:30.079Z",
      "indexedFiles": 10
    }
  },
  "warnings": []
}
```

It was captured from the build that became 1.3.1, before its version number was set, which
is why `toolVersion` reads `1.3.0`.

### `index --json`

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | Where the index was written: `graph.json`, or `graph.json.gz` above 8 MB. |
| `files` | number | Files in the index. |
| `extracted` | number | Files parsed this run. |
| `reused` | number | Unchanged files whose stored facts were reused. |
| `removed` | number | Files dropped because they no longer exist. |
| `nodes`, `edges`, `taints` | number | The size of the graph. |
| `unparseable` | string[] | Files that could not be parsed, which are treated as depending on everything. |
| `rebuiltBecause` | string or `null` | The staleness rule that made this run discard the stored index and re-parse every file, such as `graph-stale-extractor-identity` after an upgrade. Added in 1.3.1. |

## `deploy`

`deploy` runs the same analysis as `analyze`, then runs `sf project deploy start` from the
project root with a test level chosen from the outcome:

| Outcome | What `deploy` passes |
| --- | --- |
| A fallback fired | `--test-level` set to [`fullTestLevel`](configuration.md#fulltestlevel), `RunLocalTests` by default |
| Tests were selected | `--test-level RunSpecifiedTests`, with one `--tests` per selected class |
| Nothing was selected | `--test-level NoTestRun` |

It prints the reason first, for example `Running 29 of 68 tests (RunSpecifiedTests).` or
`Running RunLocalTests: entry-point-policy-full (QueueableChainingRecipes).`

**Passing flags to `sf project deploy start`.** Put them after `--`. They are passed through
unchanged and in the order written, including a flag given more than once:

```bash
sf testimpact deploy --base main --target-org prod -- --manifest delta/package/package.xml --wait 60
```

Before `--`, a flag `deploy` does not declare is rejected with exit code 2, and an argument
that is not a flag, such as a path, with `CONFIG_INVALID`. Pass `--target-org` before `--`:
`deploy` declares it, forwards it, and `--verify-coverage` needs it. Before 1.3.1, a flag
repeated after `--` lost its pairing with its values: two `--source-dir` flags reached `sf` as
`--source-dir --source-dir A B` ([transcript](measurements/fixes-1.3.1-before-after.txt)).

**Deploy the change, not the project.** Under `RunSpecifiedTests` every class *in the
deployment* needs 75% coverage from the tests that run. The selection covers the changed
classes exactly as `RunLocalTests` would, but says nothing about unchanged classes in the
payload. Use a tracked deploy, or a delta manifest, rather than `--source-dir force-app`; see
[CI integration](ci.md#deploy-with-the-selected-tests).

**A check before every deploy.** For each changed class, `deploy` confirms that every test
with a path to it was selected. The design guarantees this, so a failure means the graph
lost an edge. `deploy` then refuses with `GRAPH_CORRUPT` and asks you to report it, rather
than deploying on a broken claim.

**`--verify-coverage`** queries the target org through the Tooling API before deploying, and
needs `--target-org`.

- It reads `ApexCodeCoverageAggregate` for every changed class and trigger. It refuses to
  deploy, with `COVERAGE_BLOCKED`, if any sits below 75% or has no coverage data. That is the
  coverage from the org's **last** test run, not a prediction of the run about to happen.
  Run the org's tests with coverage first if it has none.
- It lists test classes that exist in the org but not in the repository. Under
  `RunLocalTests` they contribute coverage, and under `RunSpecifiedTests` they do not, so
  their presence means the selection's coverage argument does not hold for that org.
  [Limitations](limitations.md#coverage-under-runspecifiedtests) explains why.

**`--dry-run`** prints the `sf project deploy start` command instead of running it. It still
runs `--verify-coverage` if you pass it. To pass `sf`'s own `--dry-run`, which validates
without saving, put it after `--`.

## Flag reference

Generated by `npm run docs:commands` from the command definitions. CI fails if it is out of
date.

<!-- commands -->
* [`sf testimpact`](#sf-testimpact)
* [`sf testimpact analyze`](#sf-testimpact-analyze)
* [`sf testimpact deploy`](#sf-testimpact-deploy)
* [`sf testimpact index`](#sf-testimpact-index)

## `sf testimpact`

Build or update the test-impact index for this project.

```
USAGE
  $ sf testimpact [--json] [--flags-dir <value>] [--force] [--root-dir <value>]

FLAGS
  --force             Discard the existing index and re-parse every file.
  --root-dir=<value>  [default: .] Project directory. Defaults to the current directory.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Build or update the test-impact index for this project.

  Parses Apex and metadata into a dependency graph under .sf-testimpact/. Only files whose contents changed are
  re-parsed, so re-indexing is fast. Runs entirely locally: no org connection is opened.

ALIASES
  $ sf testimpact index

EXAMPLES
  $ sf testimpact index

  $ sf testimpact index --force

  $ sf testimpact index --json
```

## `sf testimpact analyze`

Report which Apex tests a change set can affect.

```
USAGE
  $ sf testimpact analyze --base <value> [--json] [--flags-dir <value>] [--head <value>] [--root-dir <value>]
    [--fail-on-fallback]

FLAGS
  --base=<value>      (required) Base git ref to compare from.
  --fail-on-fallback  Exit non-zero when the run degrades to a full test suite.
  --head=<value>      [default: HEAD] Head git ref to compare to.
  --root-dir=<value>  [default: .] Project directory.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Report which Apex tests a change set can affect.

  Resolves changed files to graph nodes, computes the reverse transitive closure, and reports the tests to run. Runs
  entirely locally: no org connection is opened. Any unresolvable or dynamic reference widens the result or falls back
  to a full run, and every such decision is printed with the rule that caused it.

EXAMPLES
  $ sf testimpact analyze --base main

  $ sf testimpact analyze --base main --head feature/x --json
```

## `sf testimpact deploy`

Deploy, running only the tests the change set can affect.

```
USAGE
  $ sf testimpact deploy --base <value> [--json] [--flags-dir <value>] [--head <value>] [--root-dir <value>]
    [--verify-coverage] [-o <value>] [--dry-run]

FLAGS
  -o, --target-org=<value>  Target org username or alias.
      --base=<value>        (required) Base git ref to compare from.
      --dry-run             Print the deploy command instead of running it.
      --head=<value>        [default: HEAD] Head git ref to compare to.
      --root-dir=<value>    [default: .] Project directory.
      --verify-coverage     Check per-class coverage against the target org before deploying.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Deploy, running only the tests the change set can affect.

  Wraps `sf project deploy start`, passing --test-level RunSpecifiedTests with the computed test list, or the configured
  full test level when anything forced a fallback.

  Selection cannot reduce per-class coverage: the reverse closure selects EVERY test that reaches a changed class, not a
  minimal subset, so each class is covered exactly as it would be under RunLocalTests. That argument assumes the graph
  knows every caller, which is false when the org holds Apex the repository does not — use --verify-coverage to check
  that against a real org.

  Flags for `sf project deploy start` itself (--source-dir, --ignore-conflicts, --wait, ...) go after a `--` separator
  and are passed through unchanged.

EXAMPLES
  $ sf testimpact deploy --base main

  $ sf testimpact deploy --base main --verify-coverage --target-org prod

  $ sf testimpact deploy --base main --target-org prod -- --manifest delta/package/package.xml --wait 60

FLAG DESCRIPTIONS
  --verify-coverage  Check per-class coverage against the target org before deploying.

    Queries ApexCodeCoverageAggregate via the Tooling API and refuses to deploy if any changed class sits under 75% in
    the org, and warns about test classes the org has that this repository does not. This is the only part of the
    command that queries the org itself; the deploy is run by `sf project deploy start`.
```

## `sf testimpact index`

Build or update the test-impact index for this project.

```
USAGE
  $ sf testimpact index [--json] [--flags-dir <value>] [--force] [--root-dir <value>]

FLAGS
  --force             Discard the existing index and re-parse every file.
  --root-dir=<value>  [default: .] Project directory. Defaults to the current directory.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Build or update the test-impact index for this project.

  Parses Apex and metadata into a dependency graph under .sf-testimpact/. Only files whose contents changed are
  re-parsed, so re-indexing is fast. Runs entirely locally: no org connection is opened.

ALIASES
  $ sf testimpact index

EXAMPLES
  $ sf testimpact index

  $ sf testimpact index --force

  $ sf testimpact index --json
```
<!-- commandsstop -->
