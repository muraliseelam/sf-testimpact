# Rules and error codes

Every line of `analyze` output that starts with `FALLBACK`, `WIDEN` or `INFO` is a
**decision**, and the word after it is the **rule** that made it. Rule identifiers are
stable, so they are safe to search for and to assert on in CI. With `--json`, each decision
is an entry in `decisions` with the same `level` and `rule`, plus every file or class it
fired on in `subjects` ([JSON contract](commands.md#analyze---json)).

| Level | Effect |
| --- | --- |
| `FALLBACK` | The full suite runs, at [`fullTestLevel`](configuration.md#fulltestlevel). One is enough. |
| `WIDEN` | More tests are selected than the direct dependencies alone would give. The selection stands. |
| `INFO` | Nothing changes. You are being told something you should know. |

[Error codes](#error-codes) are at the end.

## Fallback rules

### `entry-point-policy-full`

```
FALLBACK  entry-point-policy-full: QueueableChainingRecipes is an entry point (queueable), so its callers may live outside this repository and the graph’s inbound edges to it are incomplete. 5 other impacted entry point(s): ...
```

**When:** the change reaches an [entry point](how-it-works.md#entry-points), and
`entryPointPolicy` is `full`, the default. The message names up to eight entry points;
`subjects` in `--json` lists them all.

**What to do:** decide whether anything outside this repository can call the listed
classes. If nothing can, set `entryPointPolicy: widen`. When this is the only fallback,
`analyze` also prints what `widen` would select on your code. [Getting
started](getting-started.md#5-choose-an-entry-point-policy) walks through the decision.

### `unmodelled-file-type`

**When:** a changed file is a type the tool does not model, such as a layout, an LWC
component, a DataWeave script or a named credential. Its effect on tests is unknown.

**What to do:** if you are certain no Apex test depends on files like it, list them in
[`excludeFromImpact`](configuration.md#excludefromimpact). To stop every unmodelled type
forcing a full run, set [`taint.unmodelledFileType: widen`](configuration.md#taintunmodelledfiletype),
which ignores them instead.

### `changed-file-not-in-index`

**When:** a changed file is a type the tool models, but the index has no entry for it. There
are two causes:

- The index is older than the change. Run `index` on the branch before `analyze`.
- The file was deleted, or renamed away, on the branch. The index describes the branch,
  where the file no longer exists, so nothing records what depended on it.

**What to do:** run `sf testimpact index`. If the file was deleted, the fallback is the
intended answer: a full run is the only way to check that nothing depended on it.

### `changed-file-parse-failed`

**When:** a changed Apex file could not be parsed, so nothing is known about what it
references, and `taint.onParseError` is `full`, the default.

**What to do:** check whether the file is valid Apex. If it is, and uses syntax the parser
does not support yet, set [`taint.onParseError: widen`](configuration.md#taintonparseerror).
That treats the file as depending on everything, which is still safe and usually much
faster.

### `project-config-changed`

**When:** `sfdx-project.json`, `.sf-testimpact.yml` or `.sf-testimpact.yaml` is in the change
set. They decide what is indexed and how, so the existing index may not reflect them.

**What to do:** run `sf testimpact index`. Change sets that do not touch these files analyse
normally again.

### `graph-stale-format-version`, `graph-stale-parser-version`, `graph-stale-extractor-identity`

**When:** the index was written by a different build of the plugin: a different index
format, a different major version of the Apex parser, or an extractor that now extracts
differently. Usually this follows an upgrade of the plugin, or a CI cache restored from an
older build.

**What to do:** run `sf testimpact index`. It detects the stale index and re-parses every
file. Before 1.3.1 that needed `--force`.

### `dynamic-apex-full`, `dynamic-soql-full`

```
FALLBACK  dynamic-apex-full: Dispatcher uses Type.forName, so it may call any class, and this change activated the `apexType` taint domain through PricingService. `taint.dynamicApex: full` is set, so the full suite runs instead of the tests that reach the dynamic code.
```

**When:** [`taint.dynamicApex`](configuration.md#taintdynamicapex) or
[`taint.dynamicSoql`](configuration.md#taintdynamicsoql) is `full`, the change activated the
domain it governs, and the project holds a dynamic construct in that domain. `subjects` lists
every class holding one. Added in 1.3.1.

**What to do:** nothing; this is the setting doing what it says. Set it back to `widen` to
select the tests that reach those classes instead.

### `max-reduction-exceeded-fail`, `max-reduction-exceeded-run-all`

**When:** the selection would skip more than
[`maxReductionPercent`](configuration.md#maxreductionpercent) of test classes, and `onExceed`
is `fail` or `runAll`.

**What to do:** check whether the selection was plausible, by running once with
`onExceed: warn` to see it. A real change that touches very little can exceed the limit
legitimately, and then you can raise `maxReductionPercent`. A large change set that selects
almost nothing points to a bug, and is worth [reporting](https://github.com/muraliseelam/sf-testimpact/issues).

## Widen rules

### `taint-domain-activated-apexType`, `-sobjectAny`, `-fieldAny`, `-resourceAny`

```
WIDEN     taint-domain-activated-apexType: Taint domain `apexType` activated because PricingService is impacted. Classes with unresolvable references into that domain are selected too.
```

**When:** the walk reached a node whose kind activates a
[taint domain](how-it-works.md#taint-code-the-graph-cannot-follow), such as an Apex class for
`apexType` or an object or field for `sobjectAny` and `fieldAny`. Every class holding a
dynamic construct in that domain joins the impacted set. `subject` is the node that
activated it.

**What to do:** nothing. To run the full suite instead, set `taint.dynamicApex` or
`taint.dynamicSoql` to `full`.

### `entry-point-policy-widen`

**When:** the change reaches an entry point under `entryPointPolicy: widen`. Every other
entry point sharing one of its kinds was added to the walk, and the message says how many.

**What to do:** nothing. This is the trade `widen` makes.

### `changed-file-parse-failed-widened`

**When:** a changed Apex file could not be parsed, under `taint.onParseError: widen`. It is
treated as depending on every class, object and field.

**What to do:** nothing, though fixing the file restores a precise selection.

## Info rules

### `entry-point-policy-strict`

**When:** the change reaches an entry point under `entryPointPolicy: strict`. The graph is
trusted, and callers outside the repository are invisible to the selection. The line is
printed on every such run, so the choice stays visible.

### `max-reduction-exceeded-warn`

**When:** the selection skips more than `maxReductionPercent` of test classes under
`onExceed: warn`, the default. The selection stands.

### `unmodelled-file-type-ignored`

**When:** a changed file is a type the tool does not model, and
`taint.unmodelledFileType: widen` is set, so the file was not analysed and did not force a
full run. Added in 1.3.1; before that, the file was ignored without this line.

## Error codes

A hard error stops the command with exit code 1, prints the message and a suggested fix, and
under `--json` reports `code` and `actions` ([error envelope](commands.md#json-output)).

| Code | Raised when | What to do |
| --- | --- | --- |
| `CONFIG_INVALID` | `.sf-testimpact.yml` is not valid YAML, not a mapping, has an unknown key, a value of the wrong type or outside its allowed values, or a `version` other than 1. Also `deploy --verify-coverage` without `--target-org`, and `deploy` given an argument before `--`. | The message names the key and the allowed values. For an unknown key it lists the valid ones. For `deploy`, move the argument after `--`. |
| `CONFIG_UNREADABLE` | The config file exists but could not be read. | Check its permissions. |
| `PROJECT_NOT_FOUND` | `sfdx-project.json` is not valid JSON, or there are no source paths: no `packageDirectories` and no `sourcePaths`. | Run from the sfdx project root, fix the JSON, or set [`sourcePaths`](configuration.md#sourcepaths). |
| `GRAPH_STALE` | `analyze` or `deploy` found no index. | Run `sf testimpact index` first. |
| `GRAPH_CORRUPT` | The index is not valid JSON, or not a valid index. | Delete `.sf-testimpact/` and run `sf testimpact index`. |
| `GRAPH_CORRUPT` | `deploy` found a changed class covered by a test that was not selected, which the design rules out. | Report it as a bug. Run `sf testimpact index --force`, and deploy with `RunLocalTests` meanwhile. |
| `GIT_FAILED` | `git diff` failed: a ref does not exist locally, the clone is shallow, or the directory is not a git repository. | Check both refs exist. In CI, clone with full history; see [CI integration](ci.md#check-out-the-full-history). |
| `COVERAGE_BLOCKED` | `deploy --verify-coverage` found changed classes below 75% in the org, or with no coverage data. | Add tests for the named classes, or run the org's tests with coverage if it has none. Before 1.3.1 this was reported as `GRAPH_STALE`. |
| `EXTRACTOR_FAILED` | Reserved. This version never raises it. | — |

A wrong command line, such as an unknown flag or a missing required flag, is reported by the
CLI framework with exit code 2 and no `code` of this tool's.
