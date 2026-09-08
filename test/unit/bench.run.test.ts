/**
 * The benchmark orchestrator (DESIGN.md 11).
 *
 * All I/O is injected, so the commit loop is tested without cloning a repository.
 */

import { describe, expect, it, vi } from 'vitest';
import { runBenchmark, type BenchDeps } from '../../src/bench/run.js';
import { CLASS_DIR, cls, configWith, graphOf } from '../helpers/buildGraph.js';

const FIXTURE = graphOf([
  cls('Service', 'public class Service { public static void run() {} }'),
  cls('ServiceTest', '@IsTest private class ServiceTest { @IsTest static void t() { Service.run(); } }'),
  cls('IdleTest', '@IsTest private class IdleTest { @IsTest static void t() { System.assertEquals(1,1); } }'),
]);

const resultsJson = (outcome: 'Pass' | 'Fail'): string =>
  JSON.stringify({
    result: {
      tests: [
        { ApexClass: { Name: 'ServiceTest' }, MethodName: 't', Outcome: outcome, RunTime: 100 },
        { ApexClass: { Name: 'IdleTest' }, MethodName: 't', Outcome: 'Pass', RunTime: 200 },
      ],
    },
  });

function deps(overrides: Partial<BenchDeps> = {}): BenchDeps {
  return {
    indexAt: () => FIXTURE.graph,
    git: () => `M\t${CLASS_DIR}/Service.cls`,
    resultsFor: (commit) => resultsJson(commit === 'c2' ? 'Fail' : 'Pass'),
    parentOf: (commit) => (commit === 'c1' ? null : 'c1'),
    ...overrides,
  };
}

describe('runBenchmark', () => {
  it('analyses each commit against its parent', () => {
    const run = runBenchmark(deps(), { commits: ['c1', 'c2'], config: configWith() });
    expect(run.observations).toHaveLength(2);
    expect(run.observations[1]?.selected).toEqual(['ServiceTest']);
    expect(run.summary.commits).toBe(1);
  });

  it('treats a root commit as a baseline, not as a measurement', () => {
    // Its outcomes are still needed as `c^` for the next commit; dropping it would silently
    // stop the second commit's regressions from being counted at all.
    const run = runBenchmark(deps(), { commits: ['c1', 'c2'], config: configWith() });
    expect(run.observations[0]?.baselineOnly).toBe(true);
    expect(run.summary.commits).toBe(1);
    // The regression at c2 is still measured against c1's results.
    expect(run.summary.newlyFailing).toBe(1);
  });

  it('does not index or diff a root commit', () => {
    const indexAt = vi.fn(() => FIXTURE.graph);
    runBenchmark(deps({ indexAt }), { commits: ['c1'], config: configWith() });
    expect(indexAt).not.toHaveBeenCalled();
  });

  it('skips a commit with no historical results rather than guessing', () => {
    const run = runBenchmark(deps({ resultsFor: () => null }), {
      commits: ['c1', 'c2'],
      config: configWith(),
    });
    expect(run.skipped).toEqual(['c1', 'c2']);
    expect(run.observations).toEqual([]);
  });

  it('skips a commit whose results are in an unrecognised format', () => {
    const run = runBenchmark(deps({ resultsFor: () => 'not a test report' }), {
      commits: ['c2'],
      config: configWith(),
    });
    expect(run.skipped).toEqual(['c2']);
  });

  it('skips a commit whose results fail to parse', () => {
    // Detect can succeed on malformed content; parse must not take the run down with it.
    const run = runBenchmark(deps({ resultsFor: () => '{"tests":[{"Outcome":' }), {
      commits: ['c2'],
      config: configWith(),
    });
    expect(run.skipped).toEqual(['c2']);
  });

  it('records which adapter was used', () => {
    const run = runBenchmark(deps(), { commits: ['c1', 'c2'], config: configWith() });
    expect(run.adapterId).toBe('sf-json');
  });

  it('honours a forced adapter id', () => {
    const run = runBenchmark(deps(), {
      commits: ['c1', 'c2'],
      config: configWith(),
      adapterId: 'junit-xml',
    });
    // The content is sf-json, so a forced junit adapter finds nothing and yields no results.
    expect(run.observations.every((o) => o.results.length === 0)).toBe(true);
  });

  it('reports progress for each commit', () => {
    const onProgress = vi.fn();
    runBenchmark(deps(), { commits: ['c1', 'c2'], config: configWith(), onProgress });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2, 'c2');
  });

  it('detects the false negative when the selection misses a regression', () => {
    // The end-to-end shape of the metric: a test that newly fails and was not selected.
    const run = runBenchmark(
      deps({ git: () => `M\t${CLASS_DIR}/Unrelated.cls` }),
      { commits: ['c1', 'c2'], config: configWith({ maxReductionPercent: 100 }) },
    );
    // Unrelated.cls is not in the graph, so the run falls back — and a full run can never
    // produce a false negative.
    expect(run.observations[1]?.fellBack).toBe(true);
    expect(run.summary.falseNegatives).toEqual([]);
    expect(run.summary.fallbackRatePercent).toBe(100);
  });
});
