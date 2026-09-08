/**
 * Provenance ablation (DESIGN.md 11.2).
 *
 * Every edge records *how* it was derived — `ast`, `xml`, `regex` or `widened`. This module
 * re-runs the benchmark with one provenance class removed at a time and reports what that
 * class is actually worth:
 *
 *  - **false negatives prevented** — regressions the class caught that would otherwise have
 *    been missed. This is the only justification for keeping a heuristic.
 *  - **extra tests cost** — selections the class added. This is what it charges for that.
 *
 * A class that prevents nothing and costs something should be deleted, not defended. The
 * measurement exists so that decision is made from data rather than from intuition about
 * our own heuristics.
 *
 * Measurement only: nothing here changes how the tool selects tests.
 */

import { ImpactGraph } from '../graph/model.js';
import { type Provenance } from '../types.js';
import { runBenchmark, type BenchDeps, type BenchOptions } from './run.js';
import { type BenchmarkSummary } from './falseNegatives.js';

export const PROVENANCE_CLASSES: readonly Provenance[] = ['ast', 'xml', 'regex', 'widened'];

/** A copy of the graph with every edge of one provenance class removed. */
export function withoutProvenance(graph: ImpactGraph, provenance: Provenance): ImpactGraph {
  return new ImpactGraph({
    nodes: graph.nodes,
    edges: graph.edges.filter((e) => e.provenance !== provenance),
    taints: graph.taints,
    unresolved: graph.unresolved,
    files: graph.files,
    facts: graph.facts,
    project: graph.project,
    generator: graph.generator,
    createdAt: graph.createdAt,
  });
}

export interface AblationRow {
  readonly provenance: Provenance;
  /** Edges of this class present in the baseline graphs, summed across commits. */
  readonly edgesRemoved: number;
  /** False negatives with this class removed. */
  readonly falseNegativesWithout: number;
  /**
   * Regressions this class caught that would otherwise have been missed.
   *
   * `withoutClass - baseline`. Zero means the class prevented nothing on this data.
   */
  readonly falseNegativesPrevented: number;
  /** Tests selected with this class removed, summed across commits. */
  readonly selectedWithout: number;
  /**
   * Extra selections this class caused: `baseline - withoutClass`.
   *
   * Negative would mean removing the class *increased* selection, which can happen when a
   * removal changes which commits fall back.
   */
  readonly extraTestsCost: number;
  /** Commits that fell back with this class removed. */
  readonly fallbacksWithout: number;
}

export interface AblationResult {
  readonly baseline: BenchmarkSummary;
  readonly rows: readonly AblationRow[];
  /** Provenance classes with no edges at all in this data set. */
  readonly absentClasses: readonly Provenance[];
}

export interface AblationOptions extends BenchOptions {
  /** Restrict the ablation to these classes. Defaults to all four. */
  readonly classes?: readonly Provenance[];
}

/**
 * Run the benchmark once per provenance class, plus once as a baseline.
 *
 * `deps.indexAt` is wrapped rather than replaced, so each ablated run indexes exactly the
 * same trees as the baseline and only the edge set differs.
 */
export function runAblation(deps: BenchDeps, options: AblationOptions): AblationResult {
  const classes = options.classes ?? PROVENANCE_CLASSES;
  const baselineRun = runBenchmark(deps, options);

  // Count edges per class across the trees the baseline actually indexed, so `edgesRemoved`
  // describes this data set rather than one arbitrary commit.
  const edgeCounts = new Map<Provenance, number>();
  for (const observation of baselineRun.observations) {
    if (observation.baselineOnly === true) continue;
    const parent = deps.parentOf(observation.commit);
    if (parent === null) continue;
    for (const edge of deps.indexAt(parent).edges) {
      edgeCounts.set(edge.provenance, (edgeCounts.get(edge.provenance) ?? 0) + 1);
    }
  }

  const rows: AblationRow[] = [];
  const absentClasses: Provenance[] = [];

  for (const provenance of classes) {
    const edgesRemoved = edgeCounts.get(provenance) ?? 0;
    if (edgesRemoved === 0) absentClasses.push(provenance);

    const ablated = runBenchmark(
      { ...deps, indexAt: (commit) => withoutProvenance(deps.indexAt(commit), provenance) },
      options,
    );

    rows.push({
      provenance,
      edgesRemoved,
      falseNegativesWithout: ablated.summary.falseNegatives.length,
      falseNegativesPrevented:
        ablated.summary.falseNegatives.length - baselineRun.summary.falseNegatives.length,
      selectedWithout: ablated.summary.totalSelected,
      extraTestsCost: baselineRun.summary.totalSelected - ablated.summary.totalSelected,
      fallbacksWithout: ablated.summary.fallbacks,
    });
  }

  return { baseline: baselineRun.summary, rows, absentClasses };
}

export function renderAblation(result: AblationResult): string {
  const lines: string[] = [];
  lines.push('PROVENANCE ABLATION (DESIGN.md 11.2)');
  lines.push('='.repeat(78));
  lines.push('');
  lines.push(
    `Baseline: ${result.baseline.falseNegatives.length} false negative(s) of ` +
      `${result.baseline.newlyFailing} newly-failing, ${result.baseline.totalSelected} of ` +
      `${result.baseline.totalAvailable} tests selected, ${result.baseline.fallbacks} fallback(s).`,
  );
  lines.push('');
  lines.push('  class      edges   FN without   FN prevented   extra tests cost');
  lines.push('  ' + '-'.repeat(66));

  for (const row of result.rows) {
    lines.push(
      `  ${row.provenance.padEnd(10)} ${String(row.edgesRemoved).padStart(5)}   ` +
        `${String(row.falseNegativesWithout).padStart(10)}   ` +
        `${String(row.falseNegativesPrevented).padStart(12)}   ` +
        `${String(row.extraTestsCost).padStart(16)}`,
    );
  }

  if (result.absentClasses.length > 0) {
    lines.push('');
    lines.push(
      `NOTE: no edges of class ${result.absentClasses.join(', ')} exist in this data set, so ` +
        'their rows measure nothing.',
    );
  }
  return lines.join('\n');
}
