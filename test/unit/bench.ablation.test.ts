/**
 * Provenance ablation (DESIGN.md 11.2).
 *
 * The ablation is how a heuristic earns its place: a class that prevents no false negatives
 * and costs extra tests should be deleted. These tests check the measurement is sound,
 * including that it can report a class contributing nothing — the answer that matters most,
 * since it is the one that gets a heuristic removed.
 */

import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_CLASSES,
  renderAblation,
  runAblation,
  withoutProvenance,
} from '../../src/bench/ablation.js';
import { type BenchDeps } from '../../src/bench/run.js';
import { CLASS_DIR, cls, configWith, graphOf } from '../helpers/buildGraph.js';

/** Router reaches Impl only through IHandler, so the edge to Impl is `widened`. */
const FIXTURE = graphOf([
  cls('IHandler', 'public interface IHandler { void handle(); }'),
  cls('Impl', 'public class Impl implements IHandler { public void handle() {} }'),
  cls('Router', 'public class Router { public static void route(IHandler h) { h.handle(); } }'),
  cls('RouterTest', '@IsTest private class RouterTest { @IsTest static void m() { Router.route(null); } }'),
  cls('ImplTest', '@IsTest private class ImplTest { @IsTest static void m() { new Impl(); } }'),
]);

const results = (outcome: 'Pass' | 'Fail'): string =>
  JSON.stringify({
    result: {
      tests: [
        { ApexClass: { Name: 'RouterTest' }, MethodName: 'm', Outcome: outcome, RunTime: 100 },
        { ApexClass: { Name: 'ImplTest' }, MethodName: 'm', Outcome: 'Pass', RunTime: 100 },
      ],
    },
  });

const deps: BenchDeps = {
  indexAt: () => FIXTURE.graph,
  git: () => `M\t${CLASS_DIR}/Impl.cls`,
  resultsFor: (commit) => results(commit === 'c2' ? 'Fail' : 'Pass'),
  parentOf: (commit) => (commit === 'c1' ? null : 'c1'),
};

const options = { commits: ['c1', 'c2'], config: configWith({ entryPointPolicy: 'strict' as const }) };

describe('withoutProvenance', () => {
  it('removes every edge of one class and keeps the rest', () => {
    const widenedCount = FIXTURE.graph.edges.filter((e) => e.provenance === 'widened').length;
    expect(widenedCount).toBeGreaterThan(0);

    const ablated = withoutProvenance(FIXTURE.graph, 'widened');
    expect(ablated.edges.filter((e) => e.provenance === 'widened')).toEqual([]);
    expect(ablated.edges.length).toBe(FIXTURE.graph.edges.length - widenedCount);
  });

  it('leaves nodes, taints and files untouched', () => {
    const ablated = withoutProvenance(FIXTURE.graph, 'ast');
    expect(ablated.nodes).toEqual(FIXTURE.graph.nodes);
    expect(ablated.taints).toEqual(FIXTURE.graph.taints);
    expect(ablated.files).toEqual(FIXTURE.graph.files);
  });

  it('does not mutate the original graph', () => {
    const before = FIXTURE.graph.edges.length;
    withoutProvenance(FIXTURE.graph, 'ast');
    expect(FIXTURE.graph.edges.length).toBe(before);
  });

  it('rebuilds reverse adjacency for the reduced edge set', () => {
    // The CSR index is derived from edges, so an ablated graph must not reuse the original.
    const ablated = withoutProvenance(FIXTURE.graph, 'widened');
    const index = ablated.indexOf('apex:c.impl' as never);
    expect(index).toBeDefined();
    if (index !== undefined) {
      const dependents = [...ablated.dependentsOf(index)].map((i) => ablated.nodeAt(i)?.name);
      expect(dependents).not.toContain('Router');
    }
  });
});

describe('runAblation', () => {
  const result = runAblation(deps, options);

  it('reports one row per provenance class', () => {
    expect(result.rows.map((r) => r.provenance)).toEqual([...PROVENANCE_CLASSES]);
  });

  it('measures what hierarchy widening prevents on this fixture', () => {
    // RouterTest reaches Impl only through IHandler. Remove the widened edges and the
    // regression at c2 is missed.
    const widened = result.rows.find((r) => r.provenance === 'widened');
    expect(result.baseline.falseNegatives).toEqual([]);
    expect(widened?.falseNegativesWithout).toBe(1);
    expect(widened?.falseNegativesPrevented).toBe(1);
  });

  it('measures what that prevention costs in extra tests', () => {
    const widened = result.rows.find((r) => r.provenance === 'widened');
    expect(widened?.extraTestsCost).toBeGreaterThan(0);
  });

  it('reports zero for a class with no edges, and names it as absent', () => {
    // The most important answer the ablation can give: this class contributes nothing.
    // Distinguishing "measured zero" from "was never there" is what `absentClasses` is for.
    const regex = result.rows.find((r) => r.provenance === 'regex');
    expect(regex?.edgesRemoved).toBe(0);
    expect(regex?.falseNegativesPrevented).toBe(0);
    expect(regex?.extraTestsCost).toBe(0);
    expect(result.absentClasses).toContain('regex');
  });

  it('counts the edges available to ablate', () => {
    const ast = result.rows.find((r) => r.provenance === 'ast');
    expect(ast?.edgesRemoved).toBeGreaterThan(0);
  });

  it('can be restricted to a subset of classes', () => {
    const only = runAblation(deps, { ...options, classes: ['widened'] });
    expect(only.rows).toHaveLength(1);
    expect(only.rows[0]?.provenance).toBe('widened');
  });
});

describe('renderAblation', () => {
  const report = renderAblation(runAblation(deps, options));

  it('shows the baseline the rows are relative to', () => {
    expect(report).toContain('Baseline:');
    expect(report).toContain('newly-failing');
  });

  it('has a row per class with both the benefit and the cost', () => {
    expect(report).toContain('FN prevented');
    expect(report).toContain('extra tests cost');
    for (const provenance of PROVENANCE_CLASSES) expect(report).toContain(provenance);
  });

  it('warns when a class had no edges, so a zero is not mistaken for a measurement', () => {
    expect(report).toContain('measure nothing');
  });

  it('omits the warning when every class is present', () => {
    const full = renderAblation({
      baseline: runAblation(deps, { ...options, classes: [] }).baseline,
      rows: [],
      absentClasses: [],
    });
    expect(full).not.toContain('measure nothing');
  });
});
