# Getting started

This walk-through installs the plugin, builds an index, analyses one change, picks a policy,
and deploys with the selected tests. Every output block is from a real run against
[trailheadapps/apex-recipes](https://github.com/trailheadapps/apex-recipes) at commit
`2e2c1c3a`, a one-class change, retained in
[`quickstart-apex-recipes-1.3.1.txt`](measurements/quickstart-apex-recipes-1.3.1.txt).

## What you need

- **Salesforce CLI (`sf`) v2.** The plugin runs on the Node.js that `sf` uses, which must be
  22.13 or newer. `sf --version` prints it.
- **An sfdx project in a git repository**, with `sfdx-project.json` listing your package
  directories. The plugin indexes those directories; you can override them with
  [`sourcePaths`](configuration.md#sourcepaths).
- **The base branch in your local history.** The analysis diffs your branch against the
  branch you will merge into, so that branch has to exist locally. In CI that means a full
  clone; see [CI integration](ci.md#check-out-the-full-history).
- **For `deploy` only:** an org authenticated with `sf org login`.

`index` and `analyze` never contact an org. Only `deploy` does.

## 1. Install the plugin

The plugin is not signed by Salesforce, so `sf` asks you to confirm before installing it.
Answer `y`. In CI, where there is nobody to answer, the install exits with code 13 and prints
nothing, so add the plugin to the CLI's allowlist first. **The allowlist path differs by
platform**, and a file at the wrong path is simply not read.

```bash
# macOS / Linux
mkdir -p ~/.config/sf
echo '["sf-testimpact"]' > ~/.config/sf/unsignedPluginAllowList.json
sf plugins install sf-testimpact
```

```powershell
# Windows
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\sf" | Out-Null
'["sf-testimpact"]' | Out-File -Encoding ascii "$env:LOCALAPPDATA\sf\unsignedPluginAllowList.json"
sf plugins install sf-testimpact
```

Check it with `sf plugins`, which lists `sf-testimpact` and its version.

## 2. Build the index

Run this from the project root:

```
$ sf testimpact index
Indexing... done
Indexed 204 files: 204 parsed, 0 unchanged
647 nodes, 1126 edges, 50 taints
Wrote .sf-testimpact/graph.json
```

The index is a dependency graph of your Apex and metadata, written to `.sf-testimpact/`.
Add that directory to `.gitignore`; [CI integration](ci.md#cache-the-index) explains how to
cache it instead. Running `index` again re-parses only the files whose contents changed:

```
$ sf testimpact index
Indexing... done
Indexed 204 files: 0 parsed, 204 unchanged
647 nodes, 1126 edges, 50 taints
Wrote .sf-testimpact/graph.json
```

If a file cannot be parsed, `index` says so and names it. The file is then treated as
depending on everything, which makes it selected more often, never less.

## 3. Analyse a change

Check out your feature branch, then compare it with the branch you will merge into:

```bash
sf testimpact index
sf testimpact analyze --base main
```

Run `index` first on the branch, so that files your branch adds are in the index. The
comparison is `main...HEAD`, three dots: what your branch changed since it forked, not what
has also landed on `main` since.

With no configuration, the apex-recipes change produces this:

```
$ sf testimpact analyze --base 0238895a89f5a87e3c3242d266eb68974d096f80
Changed files: 1  (0238895a89f5a87e3c3242d266eb68974d096f80...HEAD)

FALLBACK  entry-point-policy-full: QueueableChainingRecipes is an entry point (queueable), so its callers may live outside this repository and the graph’s inbound edges to it are incomplete. 5 other impacted entry point(s): LDVRecipes, QueueableWithCalloutRecipes, AccountTrigger, CustomRestEndpointRecipes, InboundEmailHandlerRecipes.
          hint: `entryPointPolicy: widen` selects only the tests that reach an entry point of the same kind. Faster, but it assumes no unindexed caller reaches these classes.
WIDEN     taint-domain-activated-apexType: Taint domain `apexType` activated because PlatformEventPublishCallback is impacted. Classes with unresolvable references into that domain are selected too.

Running the full suite (RunLocalTests). See the FALLBACK lines above.

With `entryPointPolicy: widen` this change set would select 29 of 68 tests (57.35% skipped).
  That assumes nothing outside this repository calls: QueueableChainingRecipes, LDVRecipes, QueueableWithCalloutRecipes, AccountTrigger, CustomRestEndpointRecipes, InboundEmailHandlerRecipes
```

If you see `Changed files: 0` instead, you are on the base branch itself. There is nothing to
compare, and the tool says so rather than reporting a reduction.

## 4. Read the output

Each line that starts with a level is a **decision**, and each names the rule that made it.
[Rules and error codes](rules.md) lists every rule.

| Line | What it means here |
| --- | --- |
| `FALLBACK  entry-point-policy-full` | The change reaches `QueueableChainingRecipes`, which the platform can invoke from outside this repository. The graph cannot see those callers, so by default the tool runs everything rather than guess. Any `FALLBACK` line means the full suite runs. |
| `hint:` | What you could change, and what you would be trading away. |
| `WIDEN     taint-domain-activated-apexType` | The changed class can be reached by code that picks its class at runtime, such as `Type.forName`. Every class that does that is selected too. A `WIDEN` line means more tests, never fewer. |
| `Running the full suite (RunLocalTests)` | The outcome: a fallback fired. |
| `With entryPointPolicy: widen ...` | What the next step would buy you, measured on your code: 29 of 68 test classes instead of 68. It lists the classes whose outside callers you would be ruling out. |

## 5. Choose an entry-point policy

The shipped default, `entryPointPolicy: full`, falls back whenever a change reaches an entry
point: a trigger, a `@RestResource`, an `@AuraEnabled` method, a `Queueable`, a
`Schedulable`, and [the rest](how-it-works.md#entry-points). In a typical project, that is
most changes. On the first live measurement, over 30 apex-recipes commits with real test
outcomes, the policies did this ([details](benchmarks.md#correctness-measured-once-not-yet-measurable)):

| Policy | Commits that ran everything | Tests not run | Newly-failing tests missed |
| --- | --- | --- | --- |
| `full` (default) | 83.3% | 16.8% | 0 of 2 |
| `widen` | 36.7% | 39.4% | 0 of 2 |
| `strict` | 36.7% | 39.5% | 0 of 2 |

Both newly-failing tests were at one commit where every policy ran everything, so the zero in
the last column is not evidence of safety; [limitations](limitations.md) explains what is and
is not covered. An offline replay of a different 30-commit window measured less: there `full`
ran everything on every commit, and `widen` skipped 26.2% of tests
([details](benchmarks.md#selection-quality)).

The question that decides it is: **can anything outside this repository call these
classes?** Examples are Apex from another package or project in the same org, a Flow or
Process Builder that is not in the repository, an external REST client, or a scheduled job.

- If the repository is the complete source of the org's Apex, `widen` is a reasonable
  choice. It also selects the tests that reach every other entry point of the same kind, in
  case an outside caller reaches the same subsystem through one of them.
- If you cannot rule that out, keep `full`.
- `strict` trusts the graph completely and is the only policy that can miss a test for a
  reason the tool can see. Use it only if you have verified the invocation surface.

To opt in, create `.sf-testimpact.yml` in the project root:

```yaml
entryPointPolicy: widen
```

[Configuration](configuration.md) documents every other key.

## 6. Analyse again

```
$ sf testimpact analyze --base 0238895a89f5a87e3c3242d266eb68974d096f80
Changed files: 1  (0238895a89f5a87e3c3242d266eb68974d096f80...HEAD)

WIDEN     entry-point-policy-widen: QueueableChainingRecipes is an entry point (queueable). Widening to 3 other entry point(s) of the same kind (queueable, trigger, rest, global, email), because an unindexed caller may reach the same subsystem through one of them.
WIDEN     taint-domain-activated-apexType: Taint domain `apexType` activated because PlatformEventRecipesTrigger is impacted. Classes with unresolvable references into that domain are selected too.

Selected 29 of 68 tests (57.4% skipped)
  AccountServiceLayer_Tests
  AccountTriggerHandler_Tests
  ...
  OrderAppMenu_Tests
  OrgShape_Tests  [see-all-data]
  PSGAdvancedTestingRecipes
  ...
  TestFactory
```

The full list of 29 is in the [transcript](measurements/quickstart-apex-recipes-1.3.1.txt). A
test marked `[see-all-data]` or `[always-run]` was selected for that reason rather than
because the change reaches it; see [how it works](how-it-works.md#selection). Here,
`OrgShape_Tests` has two test methods annotated `@isTest(SeeAllData=true)`. They read org data
that is not in git, so the class runs whatever changes.

## 7. Deploy with the selected tests

Print the deploy command before you run it:

```
$ sf testimpact deploy --base 0238895a89f5a87e3c3242d266eb68974d096f80 --target-org my-sandbox --dry-run
Running 29 of 68 tests (RunSpecifiedTests).
sf project deploy start --test-level RunSpecifiedTests --tests AccountServiceLayer_Tests --tests AccountTriggerHandler_Tests [... 27 more --tests ...] --target-org my-sandbox
```

Drop `--dry-run` to run it. `deploy` runs the same analysis as `analyze`, so after a fallback
it deploys with `RunLocalTests`, and when no test is affected it deploys with `NoTestRun`.

**Deploy the change, not the whole project.** Under `RunSpecifiedTests`, Salesforce requires
every Apex class *in the deployment* to reach 75% coverage from the tests that run. The
selection covers the classes you changed exactly as `RunLocalTests` would. It says nothing
about unchanged classes that happen to be in the payload. So:

- With source tracking (scratch orgs, and sandboxes where tracking is on), the plain command
  above deploys only what changed.
- Without it, deploy a delta manifest, such as one built by sfdx-git-delta, and pass it
  through after `--`:

  ```bash
  sf testimpact deploy --base main --target-org prod -- --manifest delta/package/package.xml --wait 60
  ```

  Everything after `--` goes to `sf project deploy start` unchanged.

Before a production deployment, add `--verify-coverage`. It checks the coverage the org last
recorded for every changed class and refuses to deploy one below 75%. It also warns about
test classes that exist in the org but not in your repository, which the selection cannot
see. Details are in [commands](commands.md#deploy).

## Next

- [CI integration](ci.md) wires this into a pull-request pipeline.
- [How it works](how-it-works.md) explains why a test was or was not selected.
- [Limitations](limitations.md) is worth reading before you rely on the tool in production.
