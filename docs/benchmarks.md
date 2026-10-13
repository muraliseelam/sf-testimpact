# Benchmarks

Every figure on this page was measured against a real public repository, and each links to
the artifact that produced it in [`measurements/`](measurements/). Figures that could not be
measured say so. The rule is in the [evidence audit](AUDIT.md): a claim stays only if a
committed artifact reproduces it.

These sections moved here unchanged from the README on 2026-10-13. Where a later change
affects how a figure reads, a dated note says so; the figures themselves are not edited.


Every number here came from a run against a real public repository. Nothing is extrapolated;
figures that could not be measured say so. Raw output and the scripts that produced it are
in [`docs/measurements/`](measurements/).

**Hardware:** Intel Core 5 120U, 12 logical CPUs, 8 GB RAM, Windows 11, Node 24.19.0.
Single-threaded — the worker pool in the design is not implemented.

**How timings were taken.** Each timed run is a **separate `node` process**, because that is
how the tool is invoked: `sf testimpact index` pays module load, ANTLR parser construction
and a cold JIT every time. Five runs per figure; the table gives the median and the observed
range. The filesystem cache is **warm** and is not dropped between runs — dropping the
Windows page cache needs privileges the harness does not assume.

**Your first run will be slower than this table**, and by more than a little. These figures
exclude `sf` CLI startup and assume a warm cache. A cold first `sf testimpact index` on NPSP,
measured during
[external user testing](USER-TESTING.md#c1-the-incremental-index-is-genuinely-faster),
took **73 s** against the 20.5 s below; the second run on the same tree took 12.9 s. Treat the
table as the steady-state cost, not the first-use cost. See
[the comparability note](#a-note-on-comparability-with-earlier-figures) before comparing
against any previously published number.

| Repo | License | Commit | Apex classes | Indexed files |
| --- | --- | --- | --- | --- |
| [trailheadapps/apex-recipes](https://github.com/trailheadapps/apex-recipes) | CC0-1.0 | `87c1c9b6` | 139 | 204 |
| [SalesforceFoundation/NPSP](https://github.com/SalesforceFoundation/NPSP) | BSD-3-Clause | `1e9e6190` | 1,035 | 2,470 |

Apex class counts are `.cls` files under each project's `sourcePaths`
([artifact](measurements/benchmark-repo-facts.txt)). NPSP was previously listed as
1,044, which is its repository-wide `.cls` count; 9 of those live outside `force-app` and are
never indexed, so the indexed figure is the one that matches the 2,470.

## Index and query cost

Raw: [apex-recipes](measurements/apex-recipes-timing.json),
[NPSP](measurements/npsp-timing.json), plus the
[index](measurements/apex-recipes-index.json) and
[NPSP index](measurements/npsp-index.json) artifacts for the graph shape.

| | apex-recipes | NPSP |
| --- | --- | --- |
| Full index, median of 5 | **1.42 s** (1.42–1.64) | **20.5 s** (19.8–21.6) |
| Incremental index, 1 class changed | **0.20 s** (0.20–0.22) | **1.85 s** (1.77–1.91) |
| Load graph from disk | 0.019 s | 0.29 s |
| `analyze`, mean per commit | 0.8 ms (30 commits) | 51 ms (1 commit) |
| Index on disk | `graph.json`, 359 KiB | `graph.json.gz`, **1.28 MiB** (8.25 MiB raw) |
| Nodes / edges / taints | 649 / 1,128 / 50 | 7,436 / 42,580 / 2,126 |
| Test classes found | 68 | 396 |
| Files that failed to parse | 0 | 0 |

**Against the design's targets:**

| Target | Result |
| --- | --- |
| Full index, 5,000 classes < 3 min | **Unverified.** Largest measured is 1,035 classes at 20.5 s. Not extrapolated. |
| Incremental index < 5 s | **Met** on both repos — 1.85 s on NPSP — under a warm cache. Cold-cache not measured. |
| `analyze` from a warm graph < 2 s | Met on both repos. |
| `graph.json` < 10 MB at 5,000 classes | Met at 1,035 classes: 1.28 MiB on disk, 8.25 MiB before compression. Unverified at 5,000. |

NPSP's serialised graph is 8.25 MiB, which crosses the 8 MB threshold at which the index is
gzipped, so NPSP is the case that exercises that path rather than a hypothetical one. The
compressed index is **6.5× smaller** than the JSON it encodes.

### A note on comparability with earlier figures

Earlier revisions of the README quoted different absolute timings. **Those numbers have been
deleted rather than restated: the artifacts that produced them were overwritten, so no
committed evidence supports them.**

What still holds, and matters when comparing against any figure from elsewhere, is the
measurement method, which is stated above: five fresh processes per figure, warm filesystem
cache. Timings taken in-process, or on a cold cache, are not comparable with these and can
differ by a large factor. Cold-cache behaviour has not been measured.

### The incremental miss: the earlier explanation was wrong

A previous version of the README blamed global re-resolution for the incremental index cost.
**Profiling refutes that**, and the conclusion survives re-measurement. On NPSP, one class
changed ([raw profile](measurements/npsp-incremental-profile.txt)):

| Stage | Time | Share |
| --- | --- | --- |
| read + sha256 every candidate file | **1,386 ms** | 56% |
| load the previous index | 342 ms | 14% |
| walk the source tree | 290 ms | 12% |
| serialise + write | 221 ms | 9% |
| **resolve, globally** | **129 ms** | **5%** |
| extract the one changed file | 91 ms | 4% |

Global resolution — the property the design deliberately paid for, and the thing previously
blamed — is **5%** of the cost, and the floor is I/O: an incremental index must read every
candidate file to prove it is unchanged.

The target is now met, but the reason is the measurement conditions described above, not a
change in this code. The remaining structural cost is still the file scan, and closing it
further needs the parallel file reading that is specified in the design and **not
implemented**. The alternative — trusting size and mtime instead of hashing — would be faster
still and is deliberately rejected: a same-size edit with a preserved mtime would silently
produce a stale fact, and a stale fact is a missing edge.

### The 4 parse failures were not parse failures

They were four `datasets/` and `scripts/` files
([list](measurements/npsp-unparseable-files.txt)): all four use the `.cls` extension,
all four sit outside `force-app`, and **none has a class wrapper** — they are anonymous Apex
scripts. Three also contain `%%%NAMESPACE%%%` template placeholders. With `sourcePaths` set
correctly the indexer never sees them, and NPSP now reports **0** unparseable files
([artifact](measurements/npsp-index.json)); the 4 comes from the root-walking run
([artifact](measurements/npsp-window.json)).

An earlier revision of this paragraph split them "two templates and two anonymous scripts",
which is wrong on both halves: all four lack a class wrapper, and three carry placeholders.

## Selection quality

30 commits touching `.cls`/`.trigger` from apex-recipes, ending at `87c1c9b6`. The index is
built at each commit, matching how the tool is really run (index your branch, diff against a
base). "Overall reduction" counts a fallback commit as selecting every test, because it does.

| Configuration | Fallback rate | Overall reduction | Tests selected |
| --- | --- | --- | --- |
| **Shipped defaults (`entryPointPolicy: full`)** | **100%** | **0%** | 1,903 / 1,903 |
| `entryPointPolicy: widen` | 46.7% | **26.2%** | 1,405 / 1,903 |
| `entryPointPolicy: strict` | 46.7% | **26.3%** | 1,403 / 1,903 |

Raw: [defaults](measurements/apex-recipes-window-defaults.json),
[widen](measurements/apex-recipes-window-widen.json),
[strict](measurements/apex-recipes-window-strict.json).

**Shipped defaults still deliver nothing.** The blocker is `entryPointPolicy: full`, which
fired on 16 of 30 commits: apex-recipes is dense with `@AuraEnabled`, `@InvocableMethod`,
`Queueable` and `Schedulable` classes, and `full` runs everything whenever an entry point is
impacted. That policy is the documented conservative default.

The honest summary: **the tool is only useful if you set `entryPointPolicy: widen`**, and
whether `full` should remain the default is a product decision, not a measurement.

### What the default does about that

The default is unchanged — it still falls back on every commit in this window, and the safety
argument for it is untouched. What changed is that it no longer leaves you to guess. When
`entryPointPolicy: full` is the **only** reason for the fallback, `analyze` computes what
`widen` would have selected **on your repository** and prints it with the fallback:

Verbatim, from the same apex-recipes commit as the quickstart
([artifact](measurements/quickstart-apex-recipes.txt)):

```
Running the full suite (RunLocalTests). See the FALLBACK lines above.

With `entryPointPolicy: widen` this change set would select 28 of 68 tests (58.82% skipped).
  That assumes nothing outside this repository calls: QueueableChainingRecipes, LDVRecipes,
  QueueableWithCalloutRecipes, AccountTrigger, CustomRestEndpointRecipes,
  InboundEmailHandlerRecipes
```

> **Note, 2026-10-13.** Since 1.3.1 the same commit selects 29 of 68 under `widen`, not 28
> ([transcript](measurements/quickstart-apex-recipes-1.3.1.txt)). `OrgShape_Tests` has two
> test methods annotated `@isTest(SeeAllData=true)`, and a test class whose *method* sees all
> data now always runs, as one with the class annotation always did. Every window on this
> page was measured before that change. On a re-run, a commit whose selection did not already
> include `OrgShape_Tests` would select it too, so the reduction figures would be slightly
> lower.

Measured on the same 30-commit window
([artifact](measurements/apex-recipes-counterfactual.json)):

| | |
| --- | --- |
| Commits where the default fell back | 30 / 30 |
| Counterfactual offered | **16** |
| Counterfactual withheld | 14 |
| Times the quoted number disagreed with a real `widen` run | **0** |
| Times it was withheld although `widen` would have helped | **0** |
| On the 16 where it was offered: tests the default runs | 1,016 |
| … tests `widen` would run | 518 (**49% fewer**) |

The 16 is not a coincidence: it is exactly the set of commits where `entry-point-policy-full`
was the sole fallback rule, which the selection-quality table above independently measures at
16 of 30. On the other 14 the offer is withheld because something else — an unmodelled file
type, a file missing from the index, a change to `sfdx-project.json` — would force a full run
regardless of the policy, and pointing a reader at a setting that cannot help them is worse
than saying nothing.

The fallback also now names **every** impacted entry point rather than the first, because the
decision a reader is being asked to make is whether anything outside the repository calls
them, and they cannot answer that for a list they cannot see.

### The LWC/Aura extractor was deleted, and that raised the fallback rate

An earlier revision of the README compared these figures against a previously published
pair. **Those comparison numbers have been deleted: no committed artifact produced them.**
The artifacts they were taken from were overwritten by a later re-run, so the comparison is
not reproducible and is not stated here. What survives is what an artifact still supports.

The deletion itself is recorded. The extractor matched
`(lwc|aura)/**.{js,html,cmp,app,evt}`, and **23** files in apex-recipes match that rule
([list](measurements/apex-recipes-lwc-aura-files.txt)). Those files are no longer
indexed, so a commit touching one is an unmodelled file type and forces a full run. In the
current 30-commit window `unmodelled-file-type` accounts for 8 of the 14 fallbacks under
`widen` ([artifact](measurements/apex-recipes-window-widen.json)).

> **Note, 2026-10-13.** Since 1.3.1 the LWC files among this window's
> `changed-file-not-in-index` fallbacks are reported as `unmodelled-file-type`: the check that
> tells the two apart used to list LWC extensions as modelled after the LWC extractor was
> deleted. Both rules force a full run, so the fallback count, fallback rate and reduction
> above are unchanged. Only the rule names would differ on a re-run.

**The provenance ablation could not have predicted this, and that is a methodological point
worth keeping.** Ablating a provenance class removes its *edges* while leaving its files
*modelled*; deleting an extractor removes both. So a measurement showing "regex edges cost
zero extra tests" says nothing about the fallback rate, which is where file modelling acts.
The magnitude of that effect is not quantified here, because measuring it would require
re-running the window against a build that still has the extractor.

Deleting it was still right, for a structural reason rather than a measured one. Its edges
ran UI → Apex while the query walks backwards, so a changed LWC file could never reach an
Apex test: the tool was answering "this LWC change affects no Apex test" from a model
incapable of answering anything else. A fallback is the honest answer to a question the
graph cannot address.

### What was fixed, ranked by measured cause

Diagnosis first — all 1,715 changed paths across the 30 commits, classified
([raw](measurements/apex-recipes-fallback-diagnosis.json), ladder:
[raw](measurements/apex-recipes-fix-ladder.txt)). This corrected an earlier claim in the
README that `.cls-meta.xml` was the dominant cause; by commits blocked, static resources were:

| Fix (cumulative) | Commits blocked by an unmodelled file | Marginal gain |
| --- | --- | --- |
| baseline | 27/30 | — |
| + files outside `sourcePaths` ignored | 27/30 | 0 |
| + `-meta.xml` companions resolved | 26/30 | 1 |
| **+ static resources modelled** | **12/30** | **14** |
| + DataWeave | 12/30 | 0 |

- **Static resources are now modelled**, not ignored. A `.resource-meta.xml` declares a
  bundle; files inside the bundle directory resolve to it. Apex reaches one through
  `Test.loadData('X')` or `setStaticResource('X')`, so the dependency is real and is
  extracted. In apex-recipes nothing references the documentation bundles, so changing them
  now selects nothing — a *measured* absence of dependency rather than a decision not to look.
- **`-meta.xml` companions resolve to their component.** Every `.cls` has one carrying
  apiVersion and status, and an apiVersion bump changes how the class executes. It therefore
  seeds the class and selects the same tests a body change would — stronger than ignoring it.
- **Files outside `sourcePaths` are no longer treated as unknown metadata.** CI workflows,
  repository docs and build scripts are not deployable and cannot change Apex behaviour.
- **DataWeave `.dwl` is deliberately still unmodelled.** Apex calls these scripts, so the
  dependency is real; falling back is the safe answer and modelling them showed zero marginal
  benefit on this window. Ignoring them would hide a real signal.

Remaining blockers at 12/30 commits, by occurrences across the window: `.js-meta.xml` (45),
`.js` (10), `.json` (7), `.html` (7), `.css` (3). The first three of those are the LWC files
discussed above.

## Correctness: measured once, not yet measurable

The headline metric — does selection ever miss a test that would have caught a regression —
has been **measured once**, on 2026-10-12, against a real org. The data does not support a
rate, and this section says what it does support.

Computing the metric requires per-commit Apex test results — the suite passing at `c^` and
failing at `c`. No public Salesforce repository publishes those, so the harness in this
repository generates them: `bench/execute.js` deploys each commit of a window to a scratch
org, runs the **full** suite, and appends per-test outcomes to a resumable store;
`bench/fn-report.js` scores the store under every `entryPointPolicy` and withholds the rate
below a 30-pair denominator. It ran on 30 apex-recipes commits — every first-parent commit
between `9802930d` and `87c1c9b6` that changes something under `force-app` — across two
scratch orgs, because the first exhausted its daily test limit after 21 full suites.

Artifacts: [the store](measurements/fn-observations.ndjson) (every outcome of every
run), [the scored report](measurements/false-negative-rate.json), and
[the transcript](measurements/fn-harness-run.txt). Method and findings:
[docs/CORRECTNESS-PLAN.md §8](CORRECTNESS-PLAN.md).

| | `full` (default) | `widen` | `strict` |
| --- | --- | --- | --- |
| Commits scored | 30 | 30 | 30 |
| Newly-failing (test, commit) pairs | 2 | 2 | 2 |
| False negatives | **0** | **0** | **0** |
| False-negative rate | not measurable | not measurable | not measurable |
| Fallback rate | 83.3% | 36.7% | 36.7% |
| Reduction | 16.8% | 39.4% | 39.5% |
| Commits excluded | 1 — the base commit's Prompt metadata predates a format the current API accepts | | |

**Two pairs is not a denominator**, so the rate is withheld rather than quoted as 0%. Both
pairs are at one commit, upstream's "doc: improved doc generation": two tests passed at the
previous commit, failed there, and passed again at the next commit, which is upstream's
"fix: related classes parsing". That is a real regression in a real history, and the harness
caught it. It says nothing about the graph: that commit also touched LWC files, which force
a full run under every policy, so every policy "selected" those tests by running everything.

**What the run does show.** Fallback and reduction on real outcomes rather than on a
replayed selection; zero flaky tests across 30 full suites of about 320 methods; one test
(`CustomMetadataRecipes_Tests.testBucketingContactAttendancePositive`) that fails at every
commit in a fresh scratch org and therefore counts nowhere; and that the measurement
machinery holds up against an org, after four environment problems the first run surfaced
and the plan now documents.

**What still stands between this and a rate** is a window with regressions in commits that
do not also trip a fallback. A survey of eight public Salesforce repositories' CI history
found **zero** runs containing a failing Apex *test* ([artifact](measurements/fn-window.json)),
and the one regression in this window came with an LWC change. In practice that means a
private repository's history, run with the commands in the plan.

A search for an existing public benchmark for Salesforce change-impact test selection turned
up nothing usable as a substitute. Building one, with generator-recorded ground truth, is
open work that this project has not done.

Until a window with enough regressions is measured, **treat every reduction figure above as a
claim about speed only. One measured window with zero misses is consistent with safety; it
is not evidence of it.**

## Ablation: what each part of the graph costs

Every edge records how it was derived and what relationship it represents, so the
contribution of each can be measured by removing it and re-running the selection.
20 apex-recipes commits, `entryPointPolicy: widen`, 908 tests selected at baseline, 8
fallbacks ([raw](measurements/apex-recipes-ablation.json)).

**By provenance — was parsing worth it?**

| Provenance | Edges across window | Extra tests it caused | False negatives prevented |
| --- | --- | --- | --- |
| `ast` (parsed Apex) | 18,046 | **297** | not measurable |
| `xml` (metadata) | 3,440 | 0 | not measurable |
| `widened` (hierarchy) | 0 in this window | 0 | not measurable |
| `regex` | — | — | **class no longer emitted** |

**By edge kind — which relationship does the work?** Provenance cannot answer this, because
every Apex-derived edge shares `ast`. Ablating by kind can:

| Edge kind | Edges across window | Extra tests it caused |
| --- | --- | --- |
| `refType` (a type naming another type) | 10,445 | **295** |
| `soqlRead` | 4,162 | 0 |
| `grants` | 2,800 | 0 |
| `describe` | 1,930 | 0 |
| `dml` | 1,022 | 0 |
| `memberOf` | 600 | 0 |
| `extends` | 220 | 0 |
| `implements` | 207 | 0 |
| `triggerOn` | 60 | 0 |
| `flowTouches` | 40 | 0 |

Almost the whole selection on this repository flows through plain type references: `refType`
alone accounts for 295 of the 297 tests that `ast` costs. Every other kind is redundant with
it *on this window*.

**Redundant is not useless, and a zero here is not a licence to delete.** These figures
measure only what a kind *costs*; the prevention side needs the historical test results that
do not exist. A kind that is redundant on 20 apex-recipes commits can be the only path to a
test on a repository shaped differently — `dml` and `soqlRead` reach SObjects and fields,
which apex-recipes barely changes, while NPSP's graph carries 42,580 edges against
apex-recipes' 1,128. The one class that *was* deleted, `regex`, was removed for a structural
reason — its edges pointed away from the direction the query walks — not because a benchmark
showed a zero.

`xml` measured zero cost here but is retained on the same reasoning: NPSP has 16,995 `xml`
edges, and the class carries the `memberOf` edges an object-level change needs.
