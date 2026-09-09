# Design

## Context

Four-stage harness, of which only stage 3 is unbuilt:

```
commits ──▶ [1] replay ──▶ [2] select ──▶ [3] execute ──▶ [4] score ──▶ result
            git blobs      analyze        scratch org     falseNegatives
            (offline)      (offline)      (THIS CHANGE)   (offline)
```

Existing, tested, and not to be modified by this change:

| Stage | Component |
| --- | --- |
| 1 | `docs/measurements/measure.mjs` — reconstructs each tree from git blobs, no checkout |
| 2 | `src/query/analyze.ts` — selection under each `entryPointPolicy` |
| 4 | `src/bench/falseNegatives.ts` — the scorer, 27 tests |
| — | `src/bench/adapters.ts` — `sfJson`, `junitXml`, `sfHuman` outcome parsers |

## Goals / Non-goals

**Goals.** Produce per-commit, per-test outcomes for a real repository, resumably, and feed
them to the existing scorer.

**Non-goals.** Changing selection, changing defaults, or reporting a rate the data does not
support.

## Decisions

### Decision: Reuse `measure.mjs` replay rather than checking out commits

Stage 1 already reconstructs trees from git blobs without touching the working tree, and every
published figure in the repository came from it. Using a different replay for stage 3 would
mean the executed tree and the analyzed tree could diverge, which would silently corrupt the
metric.

**Alternative rejected:** `git checkout` per commit — mutates the working tree, cannot run
concurrently with anything else, and risks leaving the repository dirty on interruption.

### Decision: Persist after every commit, keyed by window identity

The store records the window (base SHA, head SHA, commit count) alongside outcomes. On
startup the harness compares the requested window to the stored one and refuses to proceed on
mismatch.

Appending outcomes from a different window into one store would produce a result that
corresponds to no actual experiment. That failure is silent and unrecoverable after the fact,
so it is made impossible rather than documented.

**Alternative rejected:** persisting only at the end — an interrupted 200-commit run loses
hours of org time.

### Decision: Adapter-based outcome ingestion, not a new parser

`sf apex test run --json` output is already parsed by `sfJsonAdapter`. Stage 3 invokes the
CLI and hands the output to the existing adapter.

**Alternative rejected:** parsing the human-readable format — `sfHumanAdapter` exists for
reading *historical CI logs*, where JSON was never captured. For runs we control, JSON is
authoritative and stable.

### Decision: Flakiness detected by re-running failures, not by repeating every commit

Re-running the whole suite N times per commit multiplies org time by N. Instead, only tests
that **failed** are re-run at the same commit; a test that passes on re-run is flaky.

This is cheaper and targets the only outcome that can produce a false positive in the
numerator. It does not detect a test that flakily *passes* — recorded as a known limitation.

## Risks

| Risk | Mitigation |
| --- | --- |
| The window yields too few failures to compute a rate | Choose a repository with a real failure history; report the null result honestly if not |
| Scratch org limits throttle a 200-commit run | Resumability; run in batches across days |
| Deploy failures cluster on particular commits and bias the window | Excluded commits are reported with reasons, so bias is visible |
| A flakily-passing test is scored as a false negative | Documented limitation; re-run strategy covers failures only |

## Open questions

- Which repository provides the window? `apex-recipes` is green by construction (measured
  100% pass rate), so it cannot supply a numerator. A repository with a real failure history
  is required, and identifying one is part of task 1.
