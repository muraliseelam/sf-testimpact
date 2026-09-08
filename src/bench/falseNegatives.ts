/**
 * The headline correctness metric (DESIGN.md 11).
 *
 * ## The definition, and why the obvious one is wrong
 *
 * The naive reading — "a test failed at `c` and we did not select it" — counts tests that
 * were already failing at `c^` and tests that are simply flaky. Both inflate the number
 * with failures the change set did not cause, which makes the metric useless in exactly the
 * situation it matters: a repository with a few long-broken tests.
 *
 * > A **false negative** is a test that **passed at `c^`**, **failed at `c`**, and was
 * > **not in `selected(c)`**.
 *
 * The denominator is the count of such newly-failing (test, commit) pairs — the failures a
 * perfect selector would have caught.
 *
 * ## Flaky tests
 *
 * A test that flips outcome more than `k` times across the commit window is classified
 * flaky and reported in its own bucket. It is **never** folded into either the numerator or
 * the denominator: counting it as a false negative blames the selector for nondeterminism,
 * and counting it as a success flatters the score. Hiding it entirely would do the same.
 *
 * ## Fallback rate
 *
 * Always reported alongside. A selector that always falls back to the full suite achieves a
 * perfect zero false-negative rate and delivers nothing, so the two numbers are only
 * meaningful together and this module returns them together.
 */

import { type TestOutcome, type TestOutcomeStatus } from './adapters.js';

/** One commit's worth of evidence. */
export interface CommitObservation {
  readonly commit: string;
  /** Test outcomes recorded at this commit. */
  readonly results: readonly TestOutcome[];
  /** Test class names our tool selected for this commit. */
  readonly selected: readonly string[];
  /** Whether the tool degraded to a full run here. */
  readonly fellBack: boolean;
  /** Total tests available, for the reduction figure. */
  readonly totalTests: number;
  /**
   * This commit contributes its results as a baseline only.
   *
   * A repository's first commit has no `c^`, so there is no selection to evaluate against
   * it — but its outcomes are still needed as the predecessor state for the *next* commit.
   * Dropping it entirely would silently stop the second commit's regressions from counting.
   * Such a commit contributes no fallback, no selection totals and no time saved.
   */
  readonly baselineOnly?: boolean;
}

export interface FalseNegative {
  readonly commit: string;
  readonly className: string;
  readonly methodName: string;
}

export interface FlakyTest {
  readonly className: string;
  readonly methodName: string;
  readonly flips: number;
}

export interface BenchmarkSummary {
  readonly commits: number;
  /** Commits that degraded to a full run. Read with `falseNegativeRate`, never alone. */
  readonly fallbacks: number;
  readonly fallbackRatePercent: number;

  /** Newly-failing (test, commit) pairs a perfect selector would have caught. */
  readonly newlyFailing: number;
  readonly falseNegatives: readonly FalseNegative[];
  /** `falseNegatives / newlyFailing`, or 0 when there was nothing to catch. */
  readonly falseNegativeRatePercent: number;

  /** Excluded from both numerator and denominator, and reported separately. */
  readonly flaky: readonly FlakyTest[];
  readonly flakyExcluded: number;

  readonly totalSelected: number;
  readonly totalAvailable: number;
  readonly reductionPercent: number;

  /**
   * Estimated minutes saved, or null when no adapter supplied timings.
   *
   * Null means "we do not know": the harness reports counts only rather than multiplying by
   * an invented average and presenting the product as a measurement.
   */
  readonly minutesSaved: number | null;
}

const testId = (t: { className: string; methodName: string }): string => `${t.className}.${t.methodName}`;

/**
 * Tests whose outcome flips more than `k` times across the window.
 *
 * Flips are counted over Pass/Fail only; skips are not evidence either way.
 */
export function findFlakyTests(
  observations: readonly CommitObservation[],
  maxFlips: number,
): readonly FlakyTest[] {
  const history = new Map<string, { className: string; methodName: string; states: TestOutcomeStatus[] }>();

  for (const observation of observations) {
    for (const result of observation.results) {
      if (result.outcome === 'Skip') continue;
      const id = testId(result);
      const entry = history.get(id);
      if (entry === undefined) {
        history.set(id, { className: result.className, methodName: result.methodName, states: [result.outcome] });
      } else {
        entry.states.push(result.outcome);
      }
    }
  }

  const flaky: FlakyTest[] = [];
  for (const entry of history.values()) {
    let flips = 0;
    for (let i = 1; i < entry.states.length; i++) {
      if (entry.states[i] !== entry.states[i - 1]) flips++;
    }
    if (flips > maxFlips) {
      flaky.push({ className: entry.className, methodName: entry.methodName, flips });
    }
  }
  return flaky.sort((a, b) => b.flips - a.flips);
}

export interface SummariseOptions {
  /** A test flipping more than this many times across the window is flaky. Default 2. */
  readonly maxFlips?: number;
}

/**
 * Compute the benchmark summary.
 *
 * Observations must be in commit order: `newlyFailing` is defined against the *previous*
 * observation, so an unordered list would silently measure something else.
 */
export function summarise(
  observations: readonly CommitObservation[],
  options: SummariseOptions = {},
): BenchmarkSummary {
  const maxFlips = options.maxFlips ?? 2;
  const flaky = findFlakyTests(observations, maxFlips);
  const flakyIds = new Set(flaky.map(testId));

  const falseNegatives: FalseNegative[] = [];
  let newlyFailing = 0;
  let flakyExcluded = 0;
  let fallbacks = 0;
  let totalSelected = 0;
  let totalAvailable = 0;
  let savedMs = 0;
  let sawAnyDuration = false;

  for (const [i, observation] of observations.entries()) {
    if (observation.baselineOnly === true) continue;

    if (observation.fellBack) fallbacks++;
    totalSelected += observation.fellBack ? observation.totalTests : observation.selected.length;
    totalAvailable += observation.totalTests;

    const selected = new Set(observation.selected.map((n) => n.toLowerCase()));

    // Time saved by the tests we skipped, using their own recorded durations. Accumulated
    // before the `c^` guard below: savings are a property of this commit alone, and the
    // first commit in a window saves time just like any other even though it has no
    // predecessor to measure regressions against.
    if (!observation.fellBack) {
      for (const result of observation.results) {
        if (result.durationMs === null) continue;
        sawAnyDuration = true;
        if (!selected.has(result.className.toLowerCase())) savedMs += result.durationMs;
      }
    }

    const previous = observations[i - 1];
    if (previous === undefined) continue; // No `c^` to compare against.

    const before = new Map(previous.results.map((r) => [testId(r), r.outcome]));

    for (const result of observation.results) {
      const id = testId(result);
      if (result.outcome !== 'Fail') continue;
      if (before.get(id) !== 'Pass') continue; // Not newly failing: pre-existing or new test.

      if (flakyIds.has(id)) {
        // Never counted either way: blaming the selector for nondeterminism is as wrong as
        // quietly crediting it with a catch it did not make.
        flakyExcluded++;
        continue;
      }

      newlyFailing++;
      // A full run selects everything, so it can never produce a false negative.
      if (!observation.fellBack && !selected.has(result.className.toLowerCase())) {
        falseNegatives.push({
          commit: observation.commit,
          className: result.className,
          methodName: result.methodName,
        });
      }
    }
  }

  // Baseline-only commits are evidence, not measurements, so they are not counted here.
  const commits = observations.filter((o) => o.baselineOnly !== true).length;
  return {
    commits,
    fallbacks,
    fallbackRatePercent: commits === 0 ? 0 : (fallbacks / commits) * 100,
    newlyFailing,
    falseNegatives,
    falseNegativeRatePercent: newlyFailing === 0 ? 0 : (falseNegatives.length / newlyFailing) * 100,
    flaky,
    flakyExcluded,
    totalSelected,
    totalAvailable,
    reductionPercent:
      totalAvailable === 0 ? 0 : ((totalAvailable - totalSelected) / totalAvailable) * 100,
    minutesSaved: sawAnyDuration ? savedMs / 60000 : null,
  };
}
