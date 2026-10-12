# First external user testing

`sf-testimpact@1.1.0`, installed and driven as three personas on 2026-09-09. The README had
said the tool has "no users, no installs, and no production deployments". The first two of
those are no longer true; the third still is.

All output below is pasted from the terminal. Nothing is reconstructed from what the
documentation says should appear — that is exactly how the fabricated quickstart block
recorded in [AUDIT.md](AUDIT.md) got in.

**`sf testimpact deploy` was not tested.** It requires a Salesforce org, and none is available
on this machine. It is untested, not working-as-far-as-we-know.

## What was installed

Two artifacts were compared, and they turned out to be one artifact:

```
$ npm pack
sf-testimpact-1.1.0.tgz   99225 bytes   76 files

$ npm view sf-testimpact@1.1.0 dist.shasum
1c6cd59c804d19e40a28debe0247e72b97b01422

$ (Get-FileHash -Algorithm SHA1 .\sf-testimpact-1.1.0.tgz).Hash
1c6cd59c804d19e40a28debe0247e72b97b01422
```

The locally packed tarball and the published package are **byte-identical**, so the
cross-check for behavioural differences between them is answered by construction: there can
be none. (The task description expected npm to be at 1.0.0; it is at 1.1.0, and 1.1.0 is what
`sf plugins install sf-testimpact` fetches.)

---

## Persona A — First-time user, following the README literally

### A1. The documented Windows install works

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\sf" | Out-Null
'["sf-testimpact"]' | Out-File -Encoding ascii "$env:LOCALAPPDATA\sf\unsignedPluginAllowList.json"
sf plugins install sf-testimpact
```

```
added 280 packages in 60s
$ sf plugins
sf-testimpact 1.1.0
```

Exit 0, non-interactive, no prompt. The allowlist path documented for Windows is correct.

### A2. Installing the packaged tarball does not work at all

The tarball is the artifact a user receives, and there is no documented way to install it.
Both obvious forms fail:

```
$ sf plugins install "C:\EB1A\repos\sf-testimpact\sf-testimpact-1.1.0.tgz"
 »   Error: Invalid npm package name.
exit=1

$ sf plugins install "file:C:/EB1A/repos/sf-testimpact/sf-testimpact-1.1.0.tgz"
(no output at all)
exit=13

$ sf plugins
NOT INSTALLED
```

The second is the worse of the two: exit 13, no message, nothing installed. 13 is the code
`sf` uses when the unsigned-plugin prompt is declined — the allowlist matches on the package
name `sf-testimpact`, not on a file path, so the prompt fires, finds no terminal, and cancels
silently.

### A3. The quickstart's first run reports a nonsense-looking result

Following the README's 60-second quickstart exactly, on a fresh clone of
`trailheadapps/apex-recipes` at `87c1c9b`:

```
$ sf testimpact index
Indexed 204 files: 204 parsed, 0 unchanged
649 nodes, 1128 edges, 50 taints
Wrote .sf-testimpact/graph.json

$ sf testimpact analyze --base main
Changed files: 0  (main...HEAD)

INFO      max-reduction-exceeded-warn: This selection skips 100.0% of tests (0 of 68 selected), above the configured maxReductionPercent of 95%.

Selected 0 of 68 tests (100.0% skipped)
```

A newcomer typing only what is on the page is on `main`, so `main...HEAD` is empty, and the
tool reports **"Selected 0 of 68 tests (100.0% skipped)"**. That reads like a headline result
— skip the entire suite — when it actually means "you gave me no changes". The quickstart's
comment says `# what would run for this branch?` but never says to be on a branch.

### A4. On an actual branch, it does what the README shows

```
$ git checkout -b my-change
$ (edit force-app/main/default/classes/Security Recipes/CanTheUser.cls)
$ git commit -am "tweak CanTheUser"

$ sf testimpact index
Indexed 204 files: 204 parsed, 0 unchanged
649 nodes, 1128 edges, 50 taints

$ sf testimpact analyze --base main
Changed files: 1  (main...HEAD)

FALLBACK  entry-point-policy-full: QueueableChainingRecipes is an entry point (queueable), so its callers may live outside this repository and the graph's inbound edges to it are incomplete. 5 other impacted entry point(s): LDVRecipes, QueueableWithCalloutRecipes, AccountTrigger, CustomRestEndpointRecipes, InboundEmailHandlerRecipes.
          hint: `entryPointPolicy: widen` selects only the tests that reach an entry point of the same kind. Faster, but it assumes no unindexed caller reaches these classes.
WIDEN     taint-domain-activated-apexType: Taint domain `apexType` activated because CanTheUser.PermissionCache is impacted. Classes with unresolvable references into that domain are selected too.

Running the full suite (RunLocalTests). See the FALLBACK lines above.

With `entryPointPolicy: widen` this change set would select 28 of 68 tests (58.82% skipped).
  That assumes nothing outside this repository calls: QueueableChainingRecipes, LDVRecipes, QueueableWithCalloutRecipes, AccountTrigger, CustomRestEndpointRecipes, InboundEmailHandlerRecipes
```

This matches the README's documented output, and the counterfactual gives a concrete number
to act on. **Verdict: would adopt**, once past A2 and A3.

---

## Persona B — CI engineer, fully headless

Every command below ran with stdin closed (`</dev/null`). **Nothing hung, and nothing
prompted.**

### B1. JSON is clean and parseable on stdout

```
$ sf testimpact index --json </dev/null 2>/dev/null | node -e "...JSON.parse..."
parsed OK. status=0 keys=status,result,warnings
result keys: path,files,extracted,reused,removed,nodes,edges,taints,unparseable

$ sf testimpact analyze --base main --json </dev/null 2>/dev/null > out.json
schemaVersion : 1
fellBack      : true
outcome       : full
testLevel     : RunLocalTests
counterfactual: {"wouldSelect":28,"total":68,"pct":58.82}
top-level keys: activatedTaintDomains,changedFiles,counterfactual,coverageGaps,decisions,
                fellBack,graph,outcome,range,reductionPercent,schemaVersion,selectedCount,
                testLevel,tests,toolVersion,totalTests
```

Progress output goes to stderr and does not pollute stdout. The key set matches what the
README's `analyze --json` table documents, including `counterfactual`.

### B2. Exit codes match the documented contract exactly

```
index                                                   exit=0
analyze, fallback, no flag                              exit=0
analyze --fail-on-fallback (fallback)                   exit=1
analyze, base = HEAD (no changes)                       exit=0
analyze, nonexistent base ref                           exit=1
analyze --json, fallback                                exit=0
analyze, not a git repo                                 exit=1
```

This is the README's table (`0` = ran, including a fallback; `1` = hard failure or
`--fail-on-fallback` on a fallback) with no deviation.

**Verdict: would adopt.** The one caveat is A2 — a CI pipeline that wants to pin a specific
build cannot install a tarball, only a published version.

---

## Persona C — Skeptical engineer, large repository

`SalesforceFoundation/NPSP` at `1e9e6190`, 2,470 indexed files.

### C1. The incremental index is genuinely faster

```
cold full index      exit=0 wall=72621ms   Indexed 2470 files: 2470 parsed, 0 unchanged
warm re-index (noop) exit=0 wall=12871ms   Indexed 2470 files: 0 parsed, 2470 unchanged
```

5.6× faster, and both produce the same graph (7,436 nodes / 42,580 edges / 2,126 taints) and
write `graph.json.gz`, so the gzip threshold behaves at real scale.

Worth noting for expectation-setting: these wall times include `sf` CLI startup and were taken
on a cold filesystem cache, where the README quotes **20.5 s** for a full index. The README
does say its figures are warm-cache fresh-process measurements, but a first-time user's first
index on this repository takes about **73 seconds**, not 20.

### C2. The fallback message is unusable on a large repository

This is the significant finding. On NPSP the entry-point fallback names **131** entry points
inline, in a single log line, and then repeats the whole list in the counterfactual:

```
FALLBACK  entry-point-policy-full: ADDR_Seasonal_SCHED is an entry point (batchable, schedulable), so its callers may live outside this repository and the graph's inbound edges to it are incomplete. 130 other impacted entry point(s): ADDR_Validator, BDI_DataImportService, BDI_DataImport_API, CONV_Account_Conversion_CTRL, CRLP_AccountSkew_AccSoftCredit_BATCH, CRLP_AccountSkew_BATCH, ... [125 more names] ... ADDR_Validator_REST.
...
With `entryPointPolicy: widen` this change set would select 342 of 396 tests (13.64% skipped).
  That assumes nothing outside this repository calls: ADDR_Seasonal_SCHED, ADDR_Validator, ... [129 more names] ... ADDR_Validator_REST
```

Two lines of several thousand characters each. The useful content — the rule, the count, and
the counterfactual number — is buried. This is a regression introduced by the change that
made the fallback name *every* entry point instead of the first: an improvement at 6 names, a
wall of text at 131.

### C3. The counterfactual's advice is correct at this scale

```
counterfactual predicted:  342 of 396, reduction 13.64
actual `widen` run:        342 of 396, reduction 13.64
```

Exact. The advice can be trusted.

### C4. Everything deliberately broken failed cleanly

No stack traces, no silent wrong answers. Each error carried an actionable remedy.

```
malformed .sf-testimpact.yml   exit=1  Error (CONFIG_INVALID): Could not parse YAML:
                                       Implicit keys of flow sequence pairs need to be on a
                                       single line at line 1, column 20

unknown config key             exit=1  Error (CONFIG_INVALID): Unknown config key: `typoKey`.

corrupt index (graph.json.gz   exit=1  Error (GRAPH_CORRUPT): The index is not valid JSON.
overwritten with junk)                 Try this: Delete it and run `sf testimpact index`.

empty repo, no sfdx-project    exit=1  Error (PROJECT_NOT_FOUND): No source paths to index.
                                       Try this: Run this from an sfdx project with
                                       `packageDirectories` in sfdx-project.json, or set
                                       `sourcePaths` in .sf-testimpact.yml.

project with zero Apex         exit=0  Indexed 1 files. Selected 0 of 0 tests (0.0% skipped)

nonexistent --base ref         exit=1  Try this: Check that both refs exist here. In CI this
                                       usually means the clone is shallow...
```

**Verdict: would adopt with reservations.** The failure handling is better than most tools of
this kind. C2 would have to be fixed first — on a repository of this size the output is not
readable.

---

## Findings

| # | Finding | Severity | Fixed |
| --- | --- | --- | --- |
| C2 | Entry-point fallback prints all 131 entry points inline, twice, on NPSP | **High** — output unusable on large repos | **Fixed** — prose capped at 8 names; message 446 chars, all 131 still in `--json` |
| A2 | `sf plugins install <tarball>` fails; the `file:` form exits 13 silently and installs nothing | Medium — the packaged artifact cannot be installed, and one failure mode is silent | **Not fixed** — this is `sf plugins install` behaviour, not this plugin's. Recorded here so it is known. |
| A3 | Quickstart on a fresh clone reports "Selected 0 of 68 tests (100.0% skipped)" for an empty diff | Medium — misleading first impression | **Fixed** — an empty diff now says so explicitly and states it is not a reduction |
| C1 | README quotes a 20.5 s full index; a cold first run on NPSP takes ~73 s | Low — the README states its conditions, but the gap is large | **Fixed** — README now gives the cold first-run figure |
| — | `sf testimpact deploy` | Untested — needs an org | No |

Nothing in this session produced a false-negative measurement; no org was available and none
was attempted.

---

# Live org (2026-10-12)

The first time any org-touching path in this tool ran against a real org. Scratch org
`fn-run-2`, created from apex-recipes' own `config/project-scratch-def.json` on an
authenticated Dev Hub, holding the apex-recipes tree at `bea5690` after the false-negative
harness finished its window there ([docs/CORRECTNESS-PLAN.md §8.5](CORRECTNESS-PLAN.md)).
The plugin under test was the working tree, linked with `sf plugins link`, so each fix below
was re-run against the org before it was called fixed. Output is pasted from the terminal;
the linked-plugin warning lines and the deploy progress spinner are trimmed, nothing else is.

A one-line change was committed to `ListSortingRecipes.cls`, a class no entry point reaches,
on a branch off `bea5690`.

## D0. `index`, `analyze` and `deploy --dry-run` behave as the README says

```
$ sf testimpact index
Indexed 204 files: 204 parsed, 0 unchanged
649 nodes, 1128 edges, 50 taints
Wrote .sf-testimpact/graph.json

$ sf testimpact analyze --base bea5690
Changed files: 1  (bea5690...HEAD)

FALLBACK  entry-point-policy-full: QueueableChainingRecipes is an entry point (queueable), so its callers may live outside this repository and the graph’s inbound edges to it are incomplete. 5 other impacted entry point(s): LDVRecipes, QueueableWithCalloutRecipes, AccountTrigger, CustomRestEndpointRecipes, InboundEmailHandlerRecipes.
          hint: `entryPointPolicy: widen` selects only the tests that reach an entry point of the same kind. Faster, but it assumes no unindexed caller reaches these classes.
WIDEN     taint-domain-activated-apexType: Taint domain `apexType` activated because ListSortingRecipes is impacted. Classes with unresolvable references into that domain are selected too.

Running the full suite (RunLocalTests). See the FALLBACK lines above.

With `entryPointPolicy: widen` this change set would select 29 of 68 tests (57.35% skipped).
  That assumes nothing outside this repository calls: QueueableChainingRecipes, LDVRecipes, QueueableWithCalloutRecipes, AccountTrigger, CustomRestEndpointRecipes, InboundEmailHandlerRecipes
exit=0

$ sf testimpact deploy --base bea5690 --dry-run
Running RunLocalTests: entry-point-policy-full (QueueableChainingRecipes).
sf project deploy start --test-level RunLocalTests
exit=0
```

One cosmetic thing: when stdout is not a terminal, `index` prints every spinner frame
(`Indexing... 1/204 files`, `2/204`, and so on) on one line. Not fixed; it is the CLI's
spinner, and `--json` output is unaffected.

## D1. `--verify-coverage` had never worked: the Tooling API refuses the query

```
$ sf testimpact deploy --base bea5690 --verify-coverage --target-org fn-run-2 --dry-run
Running RunLocalTests: entry-point-policy-full (QueueableChainingRecipes).
Error (1):
SELECT Name FROM ApexClass WHERE Body LIKE '%@isTest%' OR Body LIKE
                                 ^
ERROR at Row:1:Column:34
field 'Body' can not be filtered in a query call
exit=1
```

The org-only-test check selected `ApexClass` filtered on `Body`. The Tooling API returns
`Body` but will not filter on it, so every `--verify-coverage` since 0.1.0 failed here. The
earlier user testing could not have found it: it needed an org. **Fixed:** bodies are
fetched and the marker applied client-side, managed classes are left out (`RunLocalTests`
does not run them), and the result is paged with `queryMore`, refusing to return a
truncated list rather than under-reporting drift.

## D2. The test-class marker matched a comment

With D1 fixed:

```
$ sf testimpact deploy --base bea5690 --verify-coverage --target-org fn-run-2 --dry-run
Running RunLocalTests: entry-point-policy-full (QueueableChainingRecipes).
Checked coverage for 1 class(es) against the org.
Note: this is the org's coverage from its LAST test run, not a prediction of the run about to happen.
Warning: The org has 1 test class(es) that this repository does not, so they contribute coverage under RunLocalTests but not under RunSpecifiedTests: ConnectApiWrapper
sf project deploy start --test-level RunLocalTests --target-org fn-run-2
exit=0
```

The org and the repository are identical, so there is no org-only test. `ConnectApiWrapper`
is not a test; its doc comment says *"unless used in test methods marked
`@isTest(SeeAllData=true)`"*, and the unanchored marker matched it. **Fixed:** the marker is
anchored to the start of a line, and on apex-recipes it then finds exactly the 68 classes
the graph considers tests. After the fix, under `entryPointPolicy: widen`:

```
$ sf testimpact deploy --base bea5690 --verify-coverage --target-org fn-run-2 --dry-run
Running 29 of 68 tests (RunSpecifiedTests).
Checked coverage for 1 class(es) against the org.
Note: this is the org's coverage from its LAST test run, not a prediction of the run about to happen.
sf project deploy start --test-level RunSpecifiedTests --tests ... (29 tests) --target-org fn-run-2
exit=0
```

Worth knowing: the harness had run the suite without `--code-coverage`, so the org held no
aggregate coverage at first; one `sf apex run test --code-coverage` run populated it.

## D3. The documented flag passthrough did not work, twice over

The README said unrecognised flags pass through to `sf project deploy start`.

```
$ sf testimpact deploy --base bea5690 --target-org fn-run-2 --source-dir force-app
Error (2): Nonexistent flag: --source-dir
See more help with --help
exit=2
```

oclif rejects an undeclared flag whatever `strict` says; `strict = false` only admits extra
*arguments*. The `--` separator does reach the command, but the passthrough then kept only
tokens starting with `-`, dropping every flag value:

```
$ sf testimpact deploy --base bea5690 --target-org fn-run-2 --dry-run -- --source-dir force-app
Running 29 of 68 tests (RunSpecifiedTests).
sf project deploy start --test-level RunSpecifiedTests --tests AccountServiceLayer_Tests [... 27 more ...] --tests TestFactory --target-org fn-run-2 --source-dir
exit=0
```

**Fixed:** everything after `--` is passed through unchanged, in order, and the command's
help and the README now say so.

## D4. On Windows, a path with a space was split in two

```
$ sf testimpact deploy --base bea5690 --target-org fn-run-2 -- --source-dir "force-app/main/default/classes/Collection Recipes/ListSortingRecipes.cls"
Running 29 of 68 tests (RunSpecifiedTests).
Error (SfError): force-app/main/default/classes/Collection: File or folder not found
exit=1
```

`sf` is `sf.cmd` on Windows, which Node starts through a shell, and a shell joins the
arguments with spaces. apex-recipes keeps its classes in directories with spaces in their
names. **Fixed:** arguments are quoted for `cmd.exe` when the spawn goes through it.

## D5. Deploy the delta, not the directory: the platform enforces this, not the tool

With `-- --source-dir force-app` the payload was every class in the project, and
`RunSpecifiedTests` requires each class *in the payload* at 75% from the tests that ran:

```
 »   Warning: FormattedRecipeDisplayController - Test coverage of selected Apex Class is 0%, at least 75% test coverage is required
 »   Warning: ApiServiceRecipes - Test coverage of selected Apex Class is 0%, at least 75% test coverage is required
 [... 20 more ...]
 Status: Failed
exit=1
```

Not a defect. The coverage argument in the README is about the *changed* classes, and the
closure selects every test that reaches them; it never claimed anything about unchanged
classes that happen to be in the payload. A tracked deploy or a delta `--source-dir` keeps
the payload to the change set. Recorded because it is the mistake a first user would make.

A plain tracked deploy from this particular worktree failed for an unrelated reason: it
carried the pending deletions of a case-only field rename that the harness run had left in
source tracking (§8.3 of the correctness plan), and failed on those before any test ran.

## D6. The end-to-end deploy: selected tests ran, a real failure blocked it

The one changed class as the payload, 29 selected test classes, 162 methods:

```
$ sf testimpact deploy --base bea5690 --target-org fn-run-2 -- --source-dir "force-app/main/default/classes/Collection Recipes/ListSortingRecipes.cls"
Running 29 of 68 tests (RunSpecifiedTests).
 ─────────────── Deploying Metadata ───────────────
 ✔ Deploying Metadata
   ▸ Components: 1/1 (100%)
 ✘ Running Tests 1m 35.24s
   ▸ Successful: 161/162 (99%)
 Status: Failed
Test Failures [1]
• CustomMetadataRecipes_Tests.testBucketingContactAttendancePositive
  message: System.AssertException: Assertion Failed: Expected to find one matching bucketed picklist field for contact: Expected: 1, Actual: 0
  stacktrace:
    Class.CustomMetadataRecipes_Tests.testBucketingContactAttendancePositive: line 36, column 1
Test Results Summary
Passing: 161
Failing: 1
Total: 162
Time: 95146
exit=1
```

This is the contract working: the wrapper handed the platform the selected tests, the
platform ran them, one failed, the deploy was rejected, and the exit code says so. The
failing test is the same one that failed at all 30 commits of the harness window; it needs
org data a fresh scratch org does not have, and it is selected here because the change
activated the `apexType` taint domain. A user with that test passing in their org would have
seen a green deploy with 29 of 68 test classes.

## Findings

| # | Finding | Severity | Fixed |
| --- | --- | --- | --- |
| D1 | `--verify-coverage` always failed: `Body` cannot be filtered in a Tooling query | **High**: the only org path never worked | **Fixed**, with paging |
| D2 | Org-only-test marker matched a doc comment and reported a non-test | Medium: spurious drift warning | **Fixed**: line-anchored |
| D3 | Flag passthrough rejected by oclif; after `--`, values dropped | Medium: documented feature did not work | **Fixed**: `--` form, values kept |
| D4 | Windows: a path with a space split into two arguments | Medium: any space-containing path | **Fixed**: quoted for `cmd.exe` |
| D5 | Whole-directory payload fails per-class coverage | Guidance: deploy the delta | Documented |
| D0 | `index` spinner frames repeat when stdout is not a TTY | Low: cosmetic | Not fixed; the CLI's spinner |
| D6 | End-to-end deploy with selected tests | | Works; blocked by a genuine test failure |
