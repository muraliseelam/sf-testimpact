# sf-testimpact

[![npm](https://img.shields.io/npm/v/sf-testimpact)](https://www.npmjs.com/package/sf-testimpact)
[![CI](https://github.com/muraliseelam/sf-testimpact/actions/workflows/ci.yml/badge.svg)](https://github.com/muraliseelam/sf-testimpact/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Run only the Apex tests a change set can actually affect, instead of the whole suite.

## The problem

A Salesforce org with a few thousand Apex classes has a full `RunLocalTests` cycle measured
in hours. Every deployment pays it, even a one-line change to a single utility class. Teams
respond by batching changes into large, infrequent releases — the opposite of what CI is
for.

`sf-testimpact` builds a dependency graph of your Apex and metadata, resolves a git diff
into that graph, and computes which test classes could possibly be affected.

Because the output decides **whether tests get skipped**, this is a correctness tool, not a
performance tool. A false negative — a test that would have caught a regression but was not
selected — is a production defect the tool caused. Everything in it is built around one
rule:

> **Over-approximate freely, under-approximate never.** An extra edge costs test minutes. A
> missing edge costs an incident.

Anything unresolvable — dynamic Apex, dynamic SOQL, an unparseable file, an unmodelled
metadata type — widens the result or falls back to running everything, and says so out loud
with the rule that fired.

Salesforce now also offers a beta `RunRelevantTests` test level that chooses tests at deploy
time. [The FAQ](docs/troubleshooting.md#how-is-this-different-from-salesforces-runrelevanttests)
explains how this tool differs.

## Status

Published on npm, at 1.x. It has been installed and driven end to end by its maintainer, and
its org-touching parts — the false-negative harness, `deploy` and `deploy --verify-coverage`
— have run against live Salesforce scratch orgs
([live-org findings](docs/USER-TESTING.md#live-org-2026-10-12)). It has **no known production
deployments**.

Testing it against a live org, and then documenting it against its own code, found defects
that unit tests had not. `--verify-coverage` had never worked. Flag passthrough to
`sf project deploy start` was broken. Two documented safety settings did nothing. And a
project in a subdirectory of its git repository had every change ignored, so tests that
should have run were silently skipped. All are fixed in 1.3.0 and 1.3.1; the
[changelog](CHANGELOG.md) lists them.

The false-negative rate, the headline correctness metric, has been measured once and **the
data does not support quoting it**. Over 30 commits it found two newly-failing tests, both at
a commit where every policy ran the full suite anyway.
[Benchmarks](docs/benchmarks.md#correctness-measured-once-not-yet-measurable) has the
details, and [limitations](docs/limitations.md) lists every known way the selection can be
wrong.

**At shipped defaults the tool runs the full suite for most changes.** That is a deliberate
safety default, not a bug: it falls back whenever a change reaches a class the platform can
invoke from outside your repository. It delivers a reduction once you opt in to
`entryPointPolicy: widen`, and when it falls back it tells you what `widen` would have
selected on your code.

## Install

```bash
sf plugins install sf-testimpact
```

The plugin is not signed by Salesforce, so `sf` asks you to confirm:

```
sf-testimpact isn't signed by Salesforce. Only install the plugin if you trust
its creator. Do you want to continue the installation? (y/N)
```

In CI there is no terminal to answer, and the install exits **13** without installing. Add
the plugin to the allowlist first. **The allowlist path is platform-specific**, and a file at
the wrong path is not read:

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

## 60-second quickstart

```bash
cd your-sfdx-project
git checkout your-branch
sf testimpact index                       # build the graph (offline)
sf testimpact analyze --base main         # what would run for this branch?
```

Both blocks below are **verbatim output**, with the list of selected tests shortened, from
[trailheadapps/apex-recipes](https://github.com/trailheadapps/apex-recipes) at commit
`2e2c1c3a`, a one-class change. The full transcript is retained at
[`docs/measurements/quickstart-apex-recipes-1.3.1.txt`](docs/measurements/quickstart-apex-recipes-1.3.1.txt).

**On the shipped defaults:**

```
Changed files: 1  (0238895a89f5a87e3c3242d266eb68974d096f80...HEAD)

FALLBACK  entry-point-policy-full: QueueableChainingRecipes is an entry point (queueable), so its callers may live outside this repository and the graph’s inbound edges to it are incomplete. 5 other impacted entry point(s): LDVRecipes, QueueableWithCalloutRecipes, AccountTrigger, CustomRestEndpointRecipes, InboundEmailHandlerRecipes.
          hint: `entryPointPolicy: widen` selects only the tests that reach an entry point of the same kind. Faster, but it assumes no unindexed caller reaches these classes.
WIDEN     taint-domain-activated-apexType: Taint domain `apexType` activated because PlatformEventPublishCallback is impacted. Classes with unresolvable references into that domain are selected too.

Running the full suite (RunLocalTests). See the FALLBACK lines above.

With `entryPointPolicy: widen` this change set would select 29 of 68 tests (57.35% skipped).
  That assumes nothing outside this repository calls: QueueableChainingRecipes, LDVRecipes, QueueableWithCalloutRecipes, AccountTrigger, CustomRestEndpointRecipes, InboundEmailHandlerRecipes
```

That is the conservative default doing what it says, not a failure. It never selects tests
away until you tell it that callers outside the repository are not a concern.
[What `widen` gives up](docs/configuration.md#entrypointpolicy) is worth reading before you
set it. **After opting in:**

```yaml
# .sf-testimpact.yml
entryPointPolicy: widen
```

```
Changed files: 1  (0238895a89f5a87e3c3242d266eb68974d096f80...HEAD)

WIDEN     entry-point-policy-widen: QueueableChainingRecipes is an entry point (queueable). Widening to 3 other entry point(s) of the same kind (queueable, trigger, rest, global, email), because an unindexed caller may reach the same subsystem through one of them.
WIDEN     taint-domain-activated-apexType: Taint domain `apexType` activated because PlatformEventRecipesTrigger is impacted. Classes with unresolvable references into that domain are selected too.

Selected 29 of 68 tests (57.4% skipped)
  AccountServiceLayer_Tests
  AccountTriggerHandler_Tests
  AuraEnabledRecipes_Tests
  ... 25 more, listed in full in the artifact
  TestFactory
```

This is one commit, not a typical figure. [Measured so far](#measured-so-far) has the
distribution over 30 commits.

Then deploy with just those tests:

```bash
sf testimpact deploy --base main --target-org my-sandbox
```

[Getting started](docs/getting-started.md) walks through each step, including how to decide
on `widen` and how to deploy so the coverage rules work in your favour.

## What it guarantees, and what it does not

- **The selection is complete, not minimal.** Every test with any path to a changed class is
  selected. Under `RunSpecifiedTests`, each changed class is therefore covered exactly as it
  would be under `RunLocalTests`, and `deploy` checks that before deploying.
- **Anything it cannot see makes it select more, or run everything,** and the reason is
  printed with the rule that decided. Nothing degrades silently.
- **It is confidently wrong in two cases**, and these are worth knowing before you rely on
  it: test classes that exist in the org but not in the repository, and dynamic dispatch it
  does not recognise, such as a reflection helper of your own. `deploy --verify-coverage`
  checks the first against the org.
- **Changes to Flows, permission sets and translations select no tests.** The graph records
  what they use, not what uses them, so a change to one reaches no test.

[Limitations](docs/limitations.md) is the complete list, mitigated or not.

## Measured so far

| | apex-recipes | NPSP |
| --- | --- | --- |
| Apex classes indexed | 139 | 1,035 |
| Full index, warm cache, median of 5 | 1.42 s | 20.5 s |
| Incremental index, 1 class changed | 0.20 s | 1.85 s |
| `analyze` on a warm index | 0.8 ms | 51 ms |

A first index on a cold cache is slower: 73 s on NPSP, against the 20.5 s above.

Selection was measured on two different 30-commit windows of apex-recipes. The live window
ran the full suite at every commit in scratch orgs, so it has real test outcomes. The offline
window replays commits that change an Apex class or trigger. A fallback counts as running
every test.

| Policy | Ran everything, live | Tests skipped, live | Ran everything, offline | Tests skipped, offline |
| --- | --- | --- | --- | --- |
| `full` (default) | 83.3% | 16.8% | 100% | 0% |
| `widen` | 36.7% | 39.4% | 46.7% | 26.2% |
| `strict` | 36.7% | 39.5% | 46.7% | 26.3% |

Both windows predate 1.3.1, which always runs a test class with a `SeeAllData` test method.
On apex-recipes that adds `OrgShape_Tests` to any selection that lacked it.

The live window had two newly-failing tests, both at one commit whose LWC changes made every
policy run everything. That says nothing yet about missed tests, so no false-negative rate is
quoted. Until a window with enough regressions is measured, **treat every reduction figure as
a claim about speed only.** [Benchmarks](docs/benchmarks.md) has every figure, the method,
and the artifact behind each number.

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, index, analyse, choose a policy, deploy |
| [How it works](docs/how-it-works.md) | The graph, the backwards walk, taint, entry points, safety checks |
| [Configuration](docs/configuration.md) | Every key in `.sf-testimpact.yml`, and what each trades |
| [Commands](docs/commands.md) | Every flag, exit codes, and the `--json` contract |
| [Rules and error codes](docs/rules.md) | What each output line and error means, and what to do |
| [CI integration](docs/ci.md) | GitHub Actions and GitLab CI, with caching |
| [Troubleshooting and FAQ](docs/troubleshooting.md) | Problems seen in testing, and common questions |
| [Programmatic API](docs/api.md) | Using the package as a Node.js library |
| [Limitations](docs/limitations.md) | Every known way selection can miss a test |
| [Benchmarks](docs/benchmarks.md) | Every measured figure, with its artifact |
| [Design](docs/DESIGN.md) | The design of record |

The full map is in [`docs/`](docs/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The one rule: a change that makes the tool select
*fewer* tests needs an argument for why the removed tests could not have caught anything —
not just a benchmark showing the number went down.

## License

MIT — see [LICENSE](LICENSE).
