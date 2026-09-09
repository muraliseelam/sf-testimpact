/**
 * Stage 4: stored observations to a reported result.
 *
 * The behaviour under test is mostly a refusal. The scorer will happily compute a percentage
 * over two newly-failing pairs, and that percentage would be arithmetic wearing the clothes
 * of a measurement. This module withholds it, reports the raw counts, and says why in the
 * artifact itself rather than leaving a reader to notice the denominator.
 *
 * `falseNegatives.ts` is not touched by this change and is not re-tested here.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_DENOMINATOR,
  buildFnReport,
  renderFnReport,
  reportFromStore,
  type PolicyObservations,
} from '../../src/bench/fnReport.js';
import {
  openStore,
  type AppendOnlyFileSystem,
  type WindowIdentity,
} from '../../src/bench/observationStore.js';
import type { CommitObservation } from '../../src/bench/falseNegatives.js';
import type { TestOutcome } from '../../src/bench/adapters.js';

const WINDOW: WindowIdentity = {
  repo: 'example/repo',
  baseSha: 'aaaa',
  headSha: 'bbbb',
  commitCount: 4,
};

const pass = (cls: string): TestOutcome => ({ className: cls, methodName: 't', outcome: 'Pass', durationMs: 1 });
const fail = (cls: string): TestOutcome => ({ className: cls, methodName: 't', outcome: 'Fail', durationMs: 1 });

/**
 * A window where `count` distinct tests each newly fail once, and none was selected.
 *
 * Every one of those is a false negative by definition, which makes the denominator
 * predictable and lets the threshold behaviour be tested from both sides.
 */
function windowWithNewFailures(count: number): CommitObservation[] {
  const names = Array.from({ length: count }, (_, i) => `T${i}`);
  return [
    { commit: 'c0', results: names.map(pass), selected: [], fellBack: false, totalTests: count, baselineOnly: true },
    { commit: 'c1', results: names.map(fail), selected: [], fellBack: false, totalTests: count },
  ];
}

const policy = (name: string, observations: CommitObservation[]): PolicyObservations => ({
  policy: name,
  observations,
});

describe('a denominator too small to support a rate', () => {
  const report = buildFnReport({
    window: WINDOW,
    perPolicy: [policy('widen', windowWithNewFailures(3))],
    excluded: [],
  });
  const result = report.perPolicy[0];

  it('withholds the percentage', () => {
    expect(result?.rateReportable).toBe(false);
    expect(result?.falseNegativeRatePercent).toBeNull();
  });

  it('uses null rather than 0, because they mean opposite things', () => {
    // 0 is "nothing was missed". null is "this data cannot say". Collapsing them turns an
    // absence of evidence into the strongest possible result.
    expect(result?.falseNegativeRatePercent).not.toBe(0);
  });

  it('still reports the raw counts it did observe', () => {
    expect(result?.newlyFailing).toBe(3);
    expect(result?.falseNegatives).toBe(3);
  });

  it('says why, in the artifact', () => {
    expect(result?.note).toContain('not measurable from this data');
    expect(result?.note).toContain('3 newly-failing');
    expect(result?.note).toContain(String(MIN_DENOMINATOR));
  });

  it('marks the whole report unmeasurable', () => {
    expect(report.measurable).toBe(false);
    expect(report.summary).toContain('not measurable from this data');
  });

  it('emits no percent sign anywhere in the rendered false-negative line', () => {
    const rendered = renderFnReport(report);
    const line = rendered.split('\n').find((l) => l.includes('false-negative rate')) ?? '';
    expect(line).toContain('not measurable from this data');
    expect(line).not.toMatch(/\d%/);
  });
});

describe('a sufficient denominator', () => {
  const report = buildFnReport({
    window: WINDOW,
    perPolicy: [policy('widen', windowWithNewFailures(MIN_DENOMINATOR))],
    excluded: [],
  });
  const result = report.perPolicy[0];

  it('reports the rate', () => {
    expect(result?.rateReportable).toBe(true);
    expect(result?.falseNegativeRatePercent).toBe(100);
    expect(result?.newlyFailing).toBe(MIN_DENOMINATOR);
  });

  it('carries no not-measurable note', () => {
    expect(result?.note).toBeUndefined();
  });

  it('reports fallback and reduction alongside, never the rate alone', () => {
    // A selector that always falls back scores a perfect zero and delivers nothing, so the
    // figures are only interpretable together.
    const rendered = renderFnReport(report);
    expect(rendered).toContain('fallback rate');
    expect(rendered).toContain('reduction');
    expect(rendered).toContain('flaky excluded');
  });

  it('lists which test at which commit was missed', () => {
    expect(result?.falseNegativeDetail).toHaveLength(MIN_DENOMINATOR);
    expect(result?.falseNegativeDetail[0]).toEqual({ commit: 'c1', test: 'T0.t' });
  });

  it('is exactly at the boundary, not above it', () => {
    // Pins the comparison as >=, so a one-pair change cannot silently flip the behaviour.
    const justUnder = buildFnReport({
      window: WINDOW,
      perPolicy: [policy('widen', windowWithNewFailures(MIN_DENOMINATOR - 1))],
      excluded: [],
    });
    expect(justUnder.perPolicy[0]?.rateReportable).toBe(false);
  });
});

describe('multiple policies', () => {
  it('reports each separately', () => {
    const report = buildFnReport({
      window: WINDOW,
      perPolicy: [
        policy('full', windowWithNewFailures(MIN_DENOMINATOR)),
        policy('widen', windowWithNewFailures(MIN_DENOMINATOR)),
      ],
      excluded: [],
    });
    expect(report.perPolicy.map((p) => p.policy)).toEqual(['full', 'widen']);
    expect(renderFnReport(report)).toContain('entryPointPolicy: full');
    expect(renderFnReport(report)).toContain('entryPointPolicy: widen');
  });

  it('is unmeasurable overall if any single policy is', () => {
    const report = buildFnReport({
      window: WINDOW,
      perPolicy: [
        policy('full', windowWithNewFailures(MIN_DENOMINATOR)),
        policy('widen', windowWithNewFailures(2)),
      ],
      excluded: [],
    });
    expect(report.measurable).toBe(false);
    expect(report.summary).toContain('widen: not measurable from this data');
  });

  it('reports nothing when no policy was scored', () => {
    const report = buildFnReport({ window: WINDOW, perPolicy: [], excluded: [] });
    expect(report.measurable).toBe(false);
    expect(report.summary).toContain('No policy was scored');
  });
});

describe('excluded commits', () => {
  it('are carried into the report and rendered', () => {
    const report = buildFnReport({
      window: WINDOW,
      perPolicy: [policy('widen', windowWithNewFailures(3))],
      excluded: [{ commit: 'c9', reason: 'deploy failed: Component Failures [2]' }],
    });
    expect(report.excludedCommits).toHaveLength(1);
    expect(report.summary).toContain('1 commit(s) were excluded');
    expect(renderFnReport(report)).toContain('deploy failed: Component Failures [2]');
  });
});

describe('reading straight from a store', () => {
  function memoryFs() {
    const files = new Map<string, string>();
    const fs: AppendOnlyFileSystem = {
      readFile: (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      appendFile: (p, c) => files.set(p, (files.get(p) ?? '') + c),
      exists: (p) => files.has(p),
      mkdirp: () => undefined,
    };
    return fs;
  }

  it('scores the same outcomes under several policies', () => {
    // The org runs are the expensive half and are done once; a policy is just a different
    // set of `selected` lists over the same outcomes.
    const { store } = openStore(memoryFs(), 'store.ndjson', WINDOW);
    store.append({ commit: 'c0', results: [pass('A'), pass('B')], selected: [], fellBack: false, totalTests: 2, baselineOnly: true });
    store.append({ commit: 'c1', results: [fail('A'), pass('B')], selected: [], fellBack: false, totalTests: 2 });

    const report = reportFromStore(
      store,
      new Map([
        ['widen', new Map([['c1', { selected: ['A'], fellBack: false, totalTests: 2 }]])],
        ['strict', new Map([['c1', { selected: ['B'], fellBack: false, totalTests: 2 }]])],
      ]),
    );

    const widen = report.perPolicy.find((p) => p.policy === 'widen');
    const strict = report.perPolicy.find((p) => p.policy === 'strict');
    // A failed at c1 and was newly failing under both. `widen` selected it; `strict` did not.
    expect(widen?.falseNegatives).toBe(0);
    expect(strict?.falseNegatives).toBe(1);
    expect(strict?.falseNegativeDetail[0]).toEqual({ commit: 'c1', test: 'A.t' });
  });

  it('carries the store window through to the report', () => {
    const { store } = openStore(memoryFs(), 'store.ndjson', WINDOW);
    expect(reportFromStore(store, new Map()).window).toEqual(WINDOW);
  });

  it('carries excluded commits through from the store', () => {
    const { store } = openStore(memoryFs(), 'store.ndjson', WINDOW);
    store.append({ commit: 'c1', results: [], selected: [], fellBack: false, totalTests: 0, excluded: 'deploy failed' });
    expect(reportFromStore(store, new Map()).excludedCommits).toEqual([
      { commit: 'c1', reason: 'deploy failed' },
    ]);
  });

  it('treats a commit with no recorded selection as baseline, not as selecting nothing', () => {
    // Substituting an empty selection would score the commit as "selected nothing" and
    // manufacture false negatives that no run of the tool ever produced.
    const { store } = openStore(memoryFs(), 'store.ndjson', WINDOW);
    store.append({ commit: 'c0', results: [pass('A')], selected: [], fellBack: false, totalTests: 1, baselineOnly: true });
    store.append({ commit: 'c1', results: [fail('A')], selected: [], fellBack: false, totalTests: 1 });

    const report = reportFromStore(store, new Map([['widen', new Map()]]));
    expect(report.perPolicy[0]?.falseNegatives).toBe(0);
    expect(report.perPolicy[0]?.newlyFailing).toBe(0);
  });

  it('honours a custom threshold', () => {
    const { store } = openStore(memoryFs(), 'store.ndjson', WINDOW);
    store.append({ commit: 'c0', results: [pass('A')], selected: [], fellBack: false, totalTests: 1, baselineOnly: true });
    store.append({ commit: 'c1', results: [fail('A')], selected: [], fellBack: false, totalTests: 1 });

    const selections = new Map([['widen', new Map([['c1', { selected: [], fellBack: false, totalTests: 1 }]])]]);
    expect(reportFromStore(store, selections, { minDenominator: 1 }).perPolicy[0]?.rateReportable).toBe(true);
    expect(reportFromStore(store, selections).perPolicy[0]?.rateReportable).toBe(false);
  });
});

describe('the rendered report', () => {
  it('names the window it describes', () => {
    const rendered = renderFnReport(
      buildFnReport({ window: WINDOW, perPolicy: [policy('widen', windowWithNewFailures(3))], excluded: [] }),
    );
    expect(rendered).toContain('example/repo aaaa..bbbb (4 commits)');
  });
});
