# Evidence audit

Every factual claim in `README.md` and `docs/DESIGN.md` was checked against a committed
artifact in [`docs/measurements/`](measurements/). Audited 2026-09-08 against
`sf-testimpact@1.0.0`.

The rule applied: a claim survives only if an artifact in this repository reproduces it. If
no artifact exists, the claim is **deleted** rather than softened. If an artifact exists but
disagrees, the prose is **corrected** to match the artifact.

## Summary

| Verdict | Count |
| --- | --- |
| verified | 52 |
| corrected | 8 |
| deleted | 7 |
| **total** | **67** |

Two claims were **fabricated** — describing work that was never done. Both are recorded
below. Three further claims were wrong but traceable to a real measurement that had been
misread or mis-scoped.

## Fabrications

| # | Claim | Location | Disposition |
| --- | --- | --- | --- |
| F1 | The `sfdb` benchmark: a named failure mode ("label-neutrality guard"), seeds 11/23/37, a `select-none` baseline, and an adapter "ready to run" | README, "Correctness: still unmeasured" | **Deleted.** No such benchmark was found. It was never in `package.json`, `package-lock.json` or `node_modules`, and produced no artifact. `bench/sfdb-adapter.mjs` deleted. |
| F2 | Quickstart console block: `Selected 4 of 68 tests (94.1% skipped)` listing `DispatcherTest`, `PricingServiceTest`, `LegacyDataTest`, `SecurityBaselineTest` | README, 60-second quickstart | **Replaced with a verbatim capture.** The block could not have come from any run: the first three tests are from `test/fixtures/sample-project/` (which has exactly 3 tests in total), `SecurityBaselineTest` exists only as a string inside unit-test source, and `68` is apex-recipes' test count from a different repository. |

F2's replacement is a real run against apex-recipes at commit `2e2c1c3a`, retained at
[`quickstart-apex-recipes.txt`](measurements/quickstart-apex-recipes.txt).

## Deleted for want of an artifact

These described a previous state of the project. The artifacts that produced them were
overwritten by later re-runs, so nothing in the repository reproduces them.

| Claim | Location | Note |
| --- | --- | --- |
| "previously reported 40% fallback and 29.6% reduction for `widen`" | README, selection quality | No artifact contains 40 or 29.6. |
| "the index held **227** files; it now holds 204" | README | No artifact contains 227. The retained BEFORE artifact records 221. |
| "12 of 30 commits fell back before, 14 do now" | README | The "12" shares the deleted source. |
| "Trading 3.4 points of reduction" | README | Arithmetic on the deleted 29.6. |
| "`widen` and `strict` previously reached their figures only with a hand-written `excludeFromImpact` list" | README | The BEFORE artifact records `excludeFromImpact: []`. |
| "quoted 2.50 s / 42.53 s ... and 7.05 s"; "11,871 ms previously"; "8.6× swing" | README, comparability note | No artifact contains these. The methodological point (fresh-process, warm-cache) is kept. |
| Old incremental profile: 11,871 / 1,253 / 441 / 212 / 208 / 5 ms and "1.5%"; "cut the total from 14.43 s to 5.98 s" | DESIGN §10 | Superseded by [`npsp-incremental-profile.txt`](measurements/npsp-incremental-profile.txt). |

## Corrected

| Claim | Was | Now | Source |
| --- | --- | --- | --- |
| NPSP Apex classes | 1,044 | **1,035** | [`benchmark-repo-facts.txt`](measurements/benchmark-repo-facts.txt). 1,044 is the repo-wide `.cls` count; 9 sit outside `force-app` and are never indexed. |
| The 4 NPSP parse failures | "two `%%%NAMESPACE%%%` templates and two anonymous-Apex scripts" | **all four** are anonymous Apex with no class wrapper; **three** carry placeholders | [`npsp-unparseable-files.txt`](measurements/npsp-unparseable-files.txt) |
| Dependency row | `jsforce` 3.10.25, "already a transitive dep of `@salesforce/core`" | `@jsforce/jsforce-node` 3.10.25, **not a declared dependency**, arrives via `@salesforce/core` as `^3.10.24` | [`dependency-downloads.txt`](measurements/dependency-downloads.txt). The version was real; the package name was not. Plain `jsforce` is absent from this tree entirely. |
| "`jsforce` behind a dynamic import" | — | `@salesforce/core` behind a dynamic import | `src/commands/testimpact/deploy.ts:185` |
| Re-resolution cost | 212 ms on a 43k-edge graph | **129 ms** on NPSP's 42,580-edge graph | [`npsp-incremental-profile.txt`](measurements/npsp-incremental-profile.txt) |
| Incremental target | "5.98 s meets the 8 s target, 0.98 s outside the 5 s one" | **1.85 s**, meeting the 5 s target under a warm cache; cold cache unmeasured | [`npsp-timing.json`](measurements/npsp-timing.json) |
| On-disk format rationale | "200k edges; naive JSON would be 30–40 MB" | Deleted the projection; states the measured maximum instead | [`npsp-index.json`](measurements/npsp-index.json) |
| DESIGN §13 layout | omitted `query/analyze.ts`, `types/version/paths/project.ts` | listed | `src/` |

## Verified

Spot list; all checked against the named artifact.

| Claim | Artifact | Result |
| --- | --- | --- |
| Default falls back 100%, 0% reduction, 1,903/1,903, 30 commits | `apex-recipes-window-defaults.json` | exact |
| `widen` 46.7% / 26.2% / 1,405 | `apex-recipes-window-widen.json` | 46.666…% / 26.169…% / 1405 |
| `strict` 46.7% / 26.3% / 1,403 | `apex-recipes-window-strict.json` | 46.666…% / 26.274…% / 1403 |
| `entry-point-policy-full` fired on 16 of 30 | `apex-recipes-window-defaults.json` | exact |
| Full index 1.42 s (1.42–1.64) / 20.5 s (19.8–21.6) | `apex-recipes-timing.json`, `npsp-timing.json` | exact |
| Incremental 0.20 s (0.20–0.22) / 1.85 s (1.77–1.91) | same | exact |
| Load 0.019 s / 0.29 s | same | exact |
| `analyze` 0.8 ms (30 commits) / 51 ms (1 commit) | window + `npsp-index.json` | 0.7779 / 51.36 |
| Graph 359 KiB; 1.28 MiB gz, 8.25 MiB raw | index artifacts | 367,289 B; 1,339,163 / 8,654,591 B |
| Nodes/edges/taints 649/1,128/50 and 7,436/42,580/2,126 | index artifacts | exact |
| Test classes 68 / 396; 0 unparseable both | index artifacts | exact |
| Profile 1,386/342/290/221/129/91 ms and 56/14/12/9/5/4% | `npsp-incremental-profile.txt` | exact; shares recomputed |
| 1,715 changed paths across 30 commits | `apex-recipes-fallback-diagnosis.json` | exact |
| Fix ladder 27/27/26/12/12, marginal 0/1/14/0 | `apex-recipes-fix-ladder.txt` | exact |
| Blockers `.js-meta.xml` 45, `.js` 10, `.json` 7, `.html` 7, `.css` 3 | diagnosis + ladder | exact |
| Ablation: `ast` 18,046/297; `xml` 3,440/0; `widened` 0/0 | `apex-recipes-ablation.json` | exact |
| Ablation by kind: `refType` 10,445/295 and eight kinds at 0 | same | exact |
| Baseline 908 tests, 8 fallbacks, 20 commits, `widen` | same | exact |
| 23 lwc/aura files matching the deleted extractor's rule | `apex-recipes-lwc-aura-files.txt` | exact |
| 4 unparseable in the root-walking run | `npsp-window.json` | exact |
| Hardware: 12 CPUs, Intel Core 5 120U, 8 GB, Node 24.19.0 | timing artifacts | exact |
| Dependency weekly downloads: 51,713 / 824,438 / 57.8M / 176M / 435M | `dependency-downloads.txt` | exact, re-queried |
| Declared dependency versions | `package.json` | all six match |
| Every `src/` path named in DESIGN §13 | `src/` | all present |
| apex-recipes 139 Apex classes | `benchmark-repo-facts.txt` | exact |

## Kept deliberately

§5.5 ("REMOVED"), §12.1, and §14 decision 3 are honest records of things removed, not drift.
They are retained. §12.1 gained a caveat: the ablation artifact that supported its "measured
zero" was overwritten, and ablating a provenance class could not have measured the effect the
deletion had on the fallback rate. The structural argument it rests on is unaffected.

## Still unverified

- **False-negative rate.** Never measured. See [CORRECTNESS-PLAN.md](CORRECTNESS-PLAN.md).
- **Cold-cache timings.** Every timing here is warm-cache. Dropping the Windows page cache
  needs privileges the harness does not assume.
- **Any 5,000-class projection.** The design's targets are stated for 5,000 classes; the
  largest measured project is 1,035. Nothing is extrapolated.
- **What the LWC extractor cost in fallback rate.** Quantifying it needs a re-run against a
  build that still contains the extractor.
