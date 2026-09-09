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
