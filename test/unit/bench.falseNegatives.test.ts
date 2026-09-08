/**
 * The false-negative definition (DESIGN.md 11).
 *
 * These tests pin the definition itself, not just the arithmetic: each of the three ways
 * the naive definition goes wrong gets its own named case.
 */

import { describe, expect, it } from 'vitest';
import { findFlakyTests, summarise, type CommitObservation } from '../../src/bench/falseNegatives.js';
import { renderReport, toReportJson } from '../../src/bench/report.js';
import { type TestOutcome, type TestOutcomeStatus } from '../../src/bench/adapters.js';

const outcome = (
  className: string,
  status: TestOutcomeStatus,
  durationMs: number | null = 1000,
): TestOutcome => ({ className, methodName: 't', outcome: status, durationMs });

const at = (
  commit: string,
  results: TestOutcome[],
  selected: string[],
  fellBack = false,
  totalTests = 3,
): CommitObservation => ({ commit, results, selected, fellBack, totalTests });

describe('false negative = passed at c^, failed at c, not selected', () => {
  it('counts a test that newly failed and was not selected', () => {
    const summary = summarise([
      at('c1', [outcome('AlphaTest', 'Pass')], ['AlphaTest']),
      at('c2', [outcome('AlphaTest', 'Fail')], ['BetaTest']),
    ]);
    expect(summary.newlyFailing).toBe(1);
    expect(summary.falseNegatives).toEqual([
      { commit: 'c2', className: 'AlphaTest', methodName: 't' },
    ]);
    expect(summary.falseNegativeRatePercent).toBe(100);
  });

  it('does not count it when the test WAS selected', () => {
    const summary = summarise([
      at('c1', [outcome('AlphaTest', 'Pass')], ['AlphaTest']),
      at('c2', [outcome('AlphaTest', 'Fail')], ['AlphaTest']),
    ]);
    expect(summary.newlyFailing).toBe(1);
    expect(summary.falseNegatives).toEqual([]);
    expect(summary.falseNegativeRatePercent).toBe(0);
  });

  it('EXCLUDES a test that was already failing at c^', () => {
    // The naive definition counts this and blames the selector for a pre-existing break.
    const summary = summarise([
      at('c1', [outcome('AlphaTest', 'Fail')], []),
      at('c2', [outcome('AlphaTest', 'Fail')], []),
    ]);
    expect(summary.newlyFailing).toBe(0);
    expect(summary.falseNegatives).toEqual([]);
  });

  it('EXCLUDES a test that did not exist at c^', () => {
    // A brand-new failing test is not a regression the selector could have caught.
    const summary = summarise([
      at('c1', [], []),
      at('c2', [outcome('NewTest', 'Fail')], []),
    ]);
    expect(summary.newlyFailing).toBe(0);
  });

  it('EXCLUDES the first commit, which has no c^ to compare against', () => {
    const summary = summarise([at('c1', [outcome('AlphaTest', 'Fail')], [])]);
    expect(summary.newlyFailing).toBe(0);
  });

  it('never counts a false negative on a commit that fell back', () => {
    // A full run selects everything, so by construction it cannot miss a test.
    const summary = summarise([
      at('c1', [outcome('AlphaTest', 'Pass')], ['AlphaTest']),
      at('c2', [outcome('AlphaTest', 'Fail')], [], true),
    ]);
    expect(summary.newlyFailing).toBe(1);
    expect(summary.falseNegatives).toEqual([]);
  });

  it('is case-insensitive when matching selections to results', () => {
    const summary = summarise([
      at('c1', [outcome('AlphaTest', 'Pass')], []),
      at('c2', [outcome('AlphaTest', 'Fail')], ['alphatest']),
    ]);
    expect(summary.falseNegatives).toEqual([]);
  });

  it('reports a zero rate when there was nothing to catch', () => {
    const summary = summarise([at('c1', [], []), at('c2', [], [])]);
    expect(summary.newlyFailing).toBe(0);
    expect(summary.falseNegativeRatePercent).toBe(0);
  });
});

describe('flaky tests go in their own bucket', () => {
  const flapping: CommitObservation[] = [
    at('c1', [outcome('FlakyTest', 'Pass')], []),
    at('c2', [outcome('FlakyTest', 'Fail')], []),
    at('c3', [outcome('FlakyTest', 'Pass')], []),
    at('c4', [outcome('FlakyTest', 'Fail')], []),
  ];

  it('identifies a test that flips more than k times', () => {
    expect(findFlakyTests(flapping, 2)).toEqual([
      { className: 'FlakyTest', methodName: 't', flips: 3 },
    ]);
  });

  it('does not classify a test that flips at most k times', () => {
    expect(findFlakyTests(flapping, 3)).toEqual([]);
  });

  it('EXCLUDES flaky outcomes from the numerator', () => {
    // Counting them blames the selector for nondeterminism it cannot predict.
    const summary = summarise(flapping, { maxFlips: 2 });
    expect(summary.falseNegatives).toEqual([]);
  });

  it('EXCLUDES flaky outcomes from the denominator too', () => {
    // Counting them as caught would flatter the score just as badly.
    const summary = summarise(flapping, { maxFlips: 2 });
    expect(summary.newlyFailing).toBe(0);
  });

  it('reports how many outcomes it excluded, rather than hiding them', () => {
    const summary = summarise(flapping, { maxFlips: 2 });
    expect(summary.flaky).toHaveLength(1);
    expect(summary.flakyExcluded).toBe(2);
  });

  it('ignores skips when counting flips', () => {
    const withSkips = [
      at('c1', [outcome('T', 'Pass')], []),
      at('c2', [outcome('T', 'Skip')], []),
      at('c3', [outcome('T', 'Pass')], []),
    ];
    expect(findFlakyTests(withSkips, 0)).toEqual([]);
  });

  it('still counts a genuinely regressing test as a false negative', () => {
    // The flaky filter must not swallow real regressions: a test that goes Pass -> Fail
    // once is not flaky.
    const summary = summarise(
      [
        at('c1', [outcome('SteadyTest', 'Pass'), outcome('FlakyTest', 'Pass')], []),
        at('c2', [outcome('SteadyTest', 'Fail'), outcome('FlakyTest', 'Fail')], []),
        at('c3', [outcome('SteadyTest', 'Fail'), outcome('FlakyTest', 'Pass')], []),
        at('c4', [outcome('SteadyTest', 'Fail'), outcome('FlakyTest', 'Fail')], []),
      ],
      { maxFlips: 2 },
    );
    expect(summary.falseNegatives.map((f) => f.className)).toEqual(['SteadyTest']);
  });
});

describe('fallback rate is always available alongside', () => {
  const observations = [
    at('c1', [outcome('A', 'Pass')], ['A'], false, 4),
    at('c2', [outcome('A', 'Pass')], [], true, 4),
    at('c3', [outcome('A', 'Pass')], ['A'], false, 4),
    at('c4', [outcome('A', 'Pass')], [], true, 4),
  ];

  it('computes the share of commits that ran everything', () => {
    const summary = summarise(observations);
    expect(summary.fallbacks).toBe(2);
    expect(summary.fallbackRatePercent).toBe(50);
  });

  it('counts a fallback commit as selecting every test, for the reduction figure', () => {
    // Otherwise a tool that always falls back would report a huge reduction it never made.
    const summary = summarise(observations);
    expect(summary.totalSelected).toBe(1 + 4 + 1 + 4);
    expect(summary.totalAvailable).toBe(16);
  });

  it('prints both rates adjacently in the report', () => {
    // A perfect false-negative rate achieved by always falling back is worthless, so the
    // two numbers must not be separable by a reader skimming the output.
    const report = renderReport(summarise(observations), 'repo');
    const fnLine = report.split('\n').findIndex((l) => l.includes('False-negative rate'));
    const fbLine = report.split('\n').findIndex((l) => l.includes('Fallback rate'));
    expect(fbLine).toBe(fnLine + 1);
  });
});

describe('minutes saved', () => {
  it('sums the durations of the tests actually skipped', () => {
    const summary = summarise([
      at('c1', [outcome('A', 'Pass', 60000), outcome('B', 'Pass', 120000)], ['A']),
    ]);
    expect(summary.minutesSaved).toBe(2);
  });

  it('is null when no result carried a timing, rather than an invented average', () => {
    // DESIGN.md 11: the harness reports counts only rather than multiplying by a made-up
    // number and presenting the product as measured.
    const summary = summarise([at('c1', [outcome('A', 'Pass', null)], ['A'])]);
    expect(summary.minutesSaved).toBeNull();
  });

  it('says so in the report when timings are absent', () => {
    const report = renderReport(summarise([at('c1', [outcome('A', 'Pass', null)], [])]), 'repo');
    expect(report).toContain('unknown');
    expect(report).toContain('counts only');
  });

  it('counts no saving on a commit that fell back', () => {
    const summary = summarise([at('c1', [outcome('A', 'Pass', 60000)], [], true)]);
    expect(summary.minutesSaved).toBeNull();
  });
});

describe('report rendering', () => {
  const summary = summarise([
    at('c1', [outcome('A', 'Pass')], ['A']),
    at('c2', [outcome('A', 'Fail')], []),
  ]);

  it('lists each false negative with its commit', () => {
    const report = renderReport(summary, 'acme/salesforce');
    expect(report).toContain('acme/salesforce');
    expect(report).toContain('A.t');
    expect(report).toContain('FALSE NEGATIVES');
  });

  it('warns when there were no newly-failing tests to measure against', () => {
    // A 0% rate over zero observations is not evidence, and the report must not let a
    // reader mistake it for one.
    const empty = renderReport(summarise([at('c1', [], []), at('c2', [], [])]), 'repo');
    expect(empty).toContain('not evidence');
  });

  it('emits a versioned machine-readable form', () => {
    const json = toReportJson(summary, 'repo');
    expect(json['schemaVersion']).toBe(1);
    expect(json).toHaveProperty('correctness');
    expect(json).toHaveProperty('selection');
    expect(json).toHaveProperty('excluded');
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});
