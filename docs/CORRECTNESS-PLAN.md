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
| Stage 3 (execute against an org) | **Not built.** Requires credentials this project does not have. |

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
