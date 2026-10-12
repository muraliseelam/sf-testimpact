# Measuring the false-negative rate

The tool's headline claim is that it selects the Apex tests a change can affect. Whether it
ever **misses** one has never been measured. This document specifies how it would be, and
records what was verified while writing it — including the findings that make the obvious
approach unworkable.

Nothing here is a result. No false-negative rate is reported anywhere in this repository.

## 1. The metric

Already defined and implemented in [`src/bench/falseNegatives.ts`](../src/bench/falseNegatives.ts):

> A **false negative** is a test that **passed at `c^`**, **failed at `c`**, and was **not in
> `selected(c)`**.

The denominator is the count of such newly-failing `(test, commit)` pairs — the failures a
perfect selector would have caught. Tests that were already failing at `c^` are excluded, as
are flaky tests, which are bucketed separately and folded into neither side.

The fallback rate must be reported alongside it. A selector that always runs everything
scores a perfect zero and delivers nothing, so the two numbers are only meaningful together.

## 2. The data required

Per commit `c` on a real repository:

1. The set of Apex tests that **passed at `c^`**.
2. The set that **failed at `c`**.
3. The change set `c^ → c`.
4. What the tool selects for that change set.

(3) and (4) are already available offline — `analyze` produces them from a git history with
no org involved. Only (1) and (2) need an execution record, and they are the entire problem.

## 3. Candidate sources, and what was actually checked

Each of these was verified against the live GitHub API on 2026-09-08. Retrieval commands are
given so the checks can be repeated.

### 3a. Public CI logs — verified to exist, verified to be insufficient

`trailheadapps/apex-recipes` really does run Apex tests in CI. `ci-pr.yml:192` runs:

```
sf apex test run -c -r human -d ./tests/apex -w 20
```

and the GitHub Actions log for run `30013068817` contains a full per-test table
(`TEST NAME / OUTCOME / MESSAGE / RUNTIME (MS)`) plus a summary reporting **331 tests, 100%
pass rate**. So the data shape is real and usable — an excerpt is committed as
[`test/fixtures/test-results/sf-apex-human.txt`](../test/fixtures/test-results/sf-apex-human.txt)
and a parser for it now exists (§5).

Three measured facts make it insufficient on its own:

| Check | Result |
| --- | --- |
| `scratch-org-test` job outcome across the 25 most recent **CI on PR** runs | **skipped 25 / 25** |
| Pass rate in the one retained run where it did execute | **100%** — zero failures |
| GitHub Actions log retention | 90 days by default, so history is a rolling window |

```bash
gh api repos/trailheadapps/apex-recipes/actions/runs/<id>/jobs \
  --jq '.jobs[] | select(.name=="scratch-org-test") | .conclusion'
```

The job needs org credentials, so it is skipped for Dependabot and fork PRs, which is nearly
all recent activity. And the runs that do execute are green, because maintainers keep the
default branch green — which is exactly the sampling problem: **the numerator of this metric
is built from failures, and public repositories are selected for not having any.**

This does not make CI logs useless. It makes them a source of *negative* evidence (test `t`
passed at `c^`) that must be paired with failures obtained another way.

### 3b. Running the suite ourselves — the only route to failures

Create a scratch org, and for each commit in a window: deploy, run the full suite, record
per-test outcomes. This is the only approach that produces the failures the metric needs,
because it does not depend on anyone having published a red build.

Requirements, none of which this project currently has:

- A Salesforce Dev Hub with scratch-org allocation. Free Developer Edition orgs qualify;
  daily scratch-org limits bound throughput.
- Wall-clock budget. The one retained apex-recipes run took roughly 25 minutes end to end for
  a single commit, with 331 tests and ~25 s of test setup. A 100-commit window is therefore
  measured in days, not hours, and must be resumable.
- Tolerance for commits that will not deploy at all. Any commit whose source fails to deploy
  yields no outcomes and must be recorded as excluded, not silently dropped.

### 3c. Synthetic ground truth — possible, and honest only if labelled

Generate a repository with known dependencies, inject a change with a known blast radius, and
compare selection against the generator's record. This measures the tool against a model of
Salesforce rather than Salesforce, so it can demonstrate a *class* of miss but cannot produce
a number that transfers to real code. It would need to be reported as what it is.

An earlier revision of the README claimed an attempt against a named external benchmark. That
claim was fabricated and has been deleted; see [AUDIT.md](AUDIT.md). **No such benchmark was
found to exist**, and none is cited here.

## 4. Harness design

Four stages. Only the third needs an org.

```
  commits ──▶ [1] replay ──▶ [2] select ──▶ [3] execute ──▶ [4] score ──▶ rate + CI
              (git, offline)  (analyze,      (scratch org)   (offline)
                               offline)
```

1. **Replay.** Walk a commit window, reconstructing the tree at each commit from git blobs.
   Already implemented in `docs/measurements/measure.mjs`, which does exactly this without a
   checkout.
2. **Select.** Run `analyze` for `c^ → c` under each `entryPointPolicy`, recording the
   selected set, `fellBack`, and the total test count. Offline; already implemented.
3. **Execute.** Deploy and run the **full** suite at each commit, recording per-test outcomes.
   The full suite, not the selection — the metric needs to know what *would* have failed,
   including tests the tool chose to skip. This is the only stage requiring an org.
4. **Score.** Feed observations to `falseNegatives.ts`, which computes the rate, the flaky
   bucket and the fallback rate. Offline; already implemented and tested.

Stage 3 must persist each commit's outcomes as it goes, so a run interrupted after 40 commits
resumes rather than restarts.

## 5. What is built and tested offline now

| Component | State |
| --- | --- |
| Metric definition and scorer | `src/bench/falseNegatives.ts` — implemented, 27 tests |
| Commit replay from git blobs | `docs/measurements/measure.mjs` — implemented, used for every published figure |
| Selection under each policy | `src/query/analyze.ts` — implemented |
| `sf apex test run --json` ingestion | `sfJsonAdapter` — implemented |
| JUnit XML ingestion | `junitXmlAdapter` — implemented |
| **`sf apex test run -r human` ingestion** | **`sfHumanAdapter` — added for this plan**, 11 tests, fixture taken verbatim from a real apex-recipes CI log |
| Resumable per-commit store | `src/bench/observationStore.ts` — NDJSON, keyed by window identity, truncated tail tolerated; adversarial cases tested |
| Stage 3 (execute against an org) | **Built; never run against an org.** `src/bench/execute.ts` is the driver with every org-touching call injected; `src/bench/sfCli.ts` decides what `sf` process output means (a failing test run is a *completed* run, and reasons are redacted); `bench/execute.js` supplies the processes, a worktree and the store. The offline half has been exercised with `--dry-run` against apex-recipes ([artifact](measurements/fn-harness-dry-run.txt)). See §8. |
| Stage 4 report | `src/bench/fnReport.ts` withholds the rate below 30 newly-failing pairs and reports raw counts instead; `bench/fn-report.js` recomputes selections per policy from git blobs and writes the artifact |

The human-format adapter was the missing link for §3a: without it the only surviving record of
public CI outcomes is unparseable. Its tests cover pass, fail and skip rows, a failure message
containing spaces, a missing duration reported as `null` rather than `0`, and rejection of the
summary block — the last because a naive line parser invents a test class called `Outcome`.

## 6. What a defensible result looks like

**Sample size.** The metric's denominator is newly-failing `(test, commit)` pairs, not
commits, and most commits produce none. A window of ~200 commits on a repository with a real
failure history is the right order to aim for; the honest procedure is to report the
denominator actually obtained and refuse to quote a rate if it is small. Below roughly 30
newly-failing pairs the confidence interval is wider than any difference between policies,
and the correct output is the raw counts with no rate.

**Reported together, always:**

| Figure | Why it cannot be omitted |
| --- | --- |
| False-negative rate | The headline. |
| Denominator (newly-failing pairs) | A rate over 3 pairs is not a measurement. |
| Fallback rate | A selector that always falls back scores zero and is useless. |
| Reduction | The thing being traded for. |
| Flaky-test count | Excluded from both sides; hiding it flatters the result. |
| Commits excluded, and why | Deploy failures must not silently shrink the window. |
| Per-policy breakdown | `full`, `widen` and `strict` are different tools. |

**A result that would justify the tool:** zero false negatives under `widen` across a
denominator large enough to matter, with the reduction figure alongside. **A result that
would condemn it:** any false negative under `full`, which claims to be conservative.

**The honest null result:** if a window yields too few failures to compute a rate, that is
the finding, and it is reported as "not measurable from this data" — not softened into a
number with a caveat.

## 7. Open risks

- **Flakiness dominating the signal.** Apex tests touching governor limits, async execution
  or org state flip without a code change. The scorer buckets them, but if the flaky set is
  large relative to the newly-failing set, the measurement says more about the org than the
  selector.
- **Scratch orgs are not production orgs.** The largest documented false-negative source is
  tests present in an org but absent from the repository (README limitation 14). A scratch
  org built from the repository has none by construction, so this design **cannot** measure
  the tool's biggest known hole. That limit must be stated with any result it produces.
- **A green window measures nothing.** If the chosen window has no newly-failing pairs, the
  run produces no denominator regardless of how long it took.

## 8. Running the harness

Everything below the org line is built and tested. **Nothing below has been run against an
org.** The commands are the ones the code expects; the first live run will be the first time
`sf` output meets `src/bench/sfCli.ts` outside a unit test, and anything that run reveals
belongs in this section.

### 8.1 What the operator supplies, and this repository does not

1. **A Dev Hub** authenticated to the `sf` CLI, with scratch-org allocation, and a scratch org
   created from the measured repository's own definition so its features match:

   ```bash
   sf org create scratch --definition-file config/project-scratch-def.json --alias fn-run --duration-days 30
   ```

   Credentials live only in the CLI's own store. `bench/execute.js` passes `--target-org
   <alias>` to `sf` and never reads, logs or writes a token; anything credential-shaped that
   arrives in a failure message is redacted before it reaches the store (`redactSecrets`,
   tested in `test/unit/bench.execute.test.ts` and `test/unit/bench.sfCli.test.ts`).

2. **A clone of the repository to measure**, and a second path for the worktree the harness
   checks out commit by commit. The harness never touches the clone's own working tree.

3. **A window.** `--base` and `--head`; the harness executes `base..head` first-parent, oldest
   first, with `base` itself run first as the baseline the first commit is scored against.
   The repository this project can reach, apex-recipes, is green by construction (§3a and
   [fn-window.json](measurements/fn-window.json)), so a run on it yields "not measurable from
   this data" with a denominator of zero. That is a legitimate recorded result and would be
   this project's first live-org run, but it is not a rate.

4. A built checkout of this repository: `npm ci && npm run build`. The `bench/` scripts import
   from `lib/`.

### 8.2 The commands

```bash
# 1. Prove the offline half on the window before spending org time. Prints the window, the
#    exact sf commands that would run, and the selection at every commit. Touches nothing.
node bench/execute.js --dry-run --repo ../apex-recipes --base <sha> --head <sha>

# 2. Execute. Resumable: re-run the same command to continue after an interruption or a
#    scratch-org limit. --max-commits bounds how many NEW commits one invocation records.
node bench/execute.js --repo ../apex-recipes --worktree ../apex-recipes-fn-worktree \
     --target-org fn-run --base <sha> --head <sha> --only-source-changes \
     --pre-deploy-dir force-app/main/default/dw --max-commits 20

# 3. Score. Offline. Recomputes the selection under full, widen and strict from git blobs,
#    scores the store, prints the report and writes the artifact task 5.3 names.
node bench/fn-report.js --repo ../apex-recipes --store docs/measurements/fn-observations.ndjson
```

The store defaults to `docs/measurements/fn-observations.ndjson` because it is the evidence
the report is computed from and belongs with the other artifacts. It carries commit SHAs,
test names, outcomes, durations and redacted exclusion reasons, and nothing else.

### 8.3 Decisions the entry point makes, and why

- **Deploys use source tracking by default.** `sf project deploy start` with no source flags
  on a source-tracked org deploys changed files *and removes deleted ones*; the `sf` help for
  `project delete source` says so directly. A plain `--source-dir` deploy would leave a test
  class deleted mid-window alive in the org, where `RunLocalTests` would keep running it and
  its failures would be scored against a selector that correctly never saw it.
  `--deploy-mode source-dir` exists for an org without tracking, and a result produced with it
  must be read knowing deletions were not propagated.
- **Some metadata must be deployed before the Apex that references it, and source tracking
  does not know that.** Found on the first live run: every commit from apex-recipes' Spring
  '24 release onwards failed to deploy with `Invalid type: DataWeaveScriptResource.<name>`,
  even though `sf project deploy preview` showed the 14 DataWeave resources in the same
  deploy as the Apex. The platform compiles the Apex against scripts that do not exist yet.
  Deploying `force-app/main/default/dw` on its own first and then the tracked change set
  succeeds, so `--pre-deploy-dir` does exactly that at every commit where the directory
  exists. apex-recipes' own CI does not hit this because it deploys to an empty org in one
  step.
- **A case-only rename stops a tracked deploy for good, so `--deploy-mode source-dir` has a
  second use.** Also found on the first live run: apex-recipes' Summer '24 release renamed
  three platform-event fields in case only (`accountId__c` to `AccountId__c`). Salesforce
  API names are case-insensitive, so the org has one field, but source tracking sees a
  delete of the old path and an add of the new one, and the delete fails with "This custom
  field is referenced elsewhere" at that commit and at every commit after it. Tracking cannot
  progress past such a commit. The remaining commits were run with `--deploy-mode
  source-dir`, which is exact for that range because `git diff --name-status` from the
  rename to the head shows no deletion of any Apex class or trigger — only the three case
  renames, a class moved between directories under the same name, and one member of a
  documentation static-resource bundle, which a source-directory deploy rebuilds from the
  tree anyway. Before using `source-dir` for a range, run that diff and make the same
  argument; if a test class is deleted in the range, the mode is not exact there.
- **`sf apex run test` can fail before enqueuing anything.** One commit's run ended with
  "An unknown exception occurred" and the org shows no test run for it. The driver now makes
  a second attempt before excluding a commit (`testRunAttempts`, default 2); the deploy is
  already done, so the retry costs only the suite's time.
- **An exclusion caused by the harness, not the commit, can be retried, and the retry is
  visible.** `--retry-excluded` removes the exclusion records from the store, keeps a copy of
  the store as it was under `bench/results/`, logs which commits it is re-running, and
  executes them again. It never touches a commit that has outcomes. A commit that fails again
  is recorded as excluded again, with the new reason.
- **A failing test run is a completed run.** `sf apex run test` exits non-zero when any test
  fails. Treating that as a broken run would exclude exactly the commits the metric is built
  from, so the exit status is not what decides: output carrying a `tests` array is a result,
  and output without one is an exclusion with the CLI's message as the reason.
- **Failures are re-run once, alone.** A test that fails and then passes at the same commit is
  recorded as flaky at that commit; the first run's `Fail` is kept as the observation. This
  catches a flaky failure, not a flaky pass (§7).
- **Commits that change nothing under the source paths are skipped, and that is exact.**
  `--only-source-changes` drops first-parent commits whose diff from their parent touches
  nothing under the project's source paths — dependency bumps, CI, docs. Such a commit
  deploys nothing, so the org state and every test outcome at it are those of the last
  source-changing commit, and the scorer's "previous observation" has exactly the same
  deployed source as `c^`. On apex-recipes this removes about three quarters of a window:
  the 30-commit window in §8.5 spans 204 first-parent commits. Without the flag every commit
  is executed, which is never wrong, only slower.

### 8.4 Budget

The one retained apex-recipes CI run took roughly 25 minutes for one commit (§3b). A
30-commit window is therefore around 12 hours of org time, a 200-commit window several days,
and Developer Edition Dev Hubs cap active scratch orgs in single digits. Run in batches with
`--max-commits`; the store makes every batch resumable and refuses to mix windows.
